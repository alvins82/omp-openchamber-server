import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { handleJarvisRequest } from "./routes";
import {
  JarvisHarness,
  resetJarvisTransportFactory,
  setJarvisTransportFactory,
} from "./harness";
import type { OmpRpcEvent, OmpRpcTransport } from "../../providers/omp/rpc";

class FakeTransport implements OmpRpcTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly frames: unknown[] = [];
  #listeners = new Set<(event: OmpRpcEvent) => void>();

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "get_state") return { isStreaming: false, isCompacting: false, queuedMessageCount: 0 };
    if (method === "prompt") return { agentInvoked: true };
    return {};
  }

  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  switchSession(): Promise<unknown> {
    return Promise.resolve({});
  }

  sendFrame(frame: unknown): void {
    this.frames.push(frame);
  }

  kill(): void {}

  emit(event: OmpRpcEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function makeHarness(): { harness: JarvisHarness; transport: FakeTransport; stateDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "jarvis-adapter-test-"));
  process.env.OC_JARVIS_STATE_DIR = stateDir;
  const transport = new FakeTransport();
  setJarvisTransportFactory(async () => transport);
  return { harness: new JarvisHarness(), transport, stateDir };
}

function providerSessionPath(stateDir: string): string {
  const path = join(stateDir, `provider-${randomUUID()}.jsonl`);
  writeFileSync(path, JSON.stringify({
    type: "session",
    id: randomUUID(),
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
    version: 3,
  }) + "\n");
  return path;
}

afterEach(() => {
  resetJarvisTransportFactory();
  delete process.env.OC_JARVIS_STATE_DIR;
  delete process.env.OC_JARVIS_TOKEN;
});

describe("Jarvis OMP adapter", () => {
  test("binds Jarvis ids, registers tools, bridges host calls, and emits public events", async () => {
    const { harness, transport, stateDir } = makeHarness();
    try {
      const binding = await harness.createSession({
        sessionId: "asess_test_1",
        workspaceId: "ws_test_1",
        cwd: process.cwd(),
        sessionPath: providerSessionPath(stateDir),
        tools: [{
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
          requiresApproval: true,
        }],
      });

      const started = await binding.startTurn({
        turnId: "turn_test_1",
        attemptId: "att_test_1",
        prompt: "Inspect the repository",
        workerLeaseEpoch: 7,
      });
      expect(started.accepted).toBe(true);
      expect(transport.requests.map((request) => request.method)).toEqual([
        "set_host_tools",
        "prompt",
      ]);

      transport.emit({
        type: "host_tool_call",
        id: "rpc_action_1",
        toolCallId: "tool_call_1",
        toolName: "read_file",
        arguments: { path: "README.md" },
      });
      expect(binding.snapshot().status).toBe("waiting_tool");
      expect(binding.snapshot().pendingActions[0]).toMatchObject({
        providerRequestId: "rpc_action_1",
        providerToolCallId: "tool_call_1",
        toolName: "read_file",
      });

      await binding.submitActionResult("rpc_action_1", {
        turnId: "turn_test_1",
        attemptId: "att_test_1",
        success: true,
        result: { text: "contents" },
      });
      expect(transport.frames).toEqual([{
        type: "host_tool_result",
        id: "rpc_action_1",
        result: {
          content: [{ type: "text", text: JSON.stringify({ text: "contents" }) }],
          details: {},
        },
        isError: false,
      }]);

      transport.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Done" },
      });
      transport.emit({ type: "agent_end", isTerminal: true });
      const snapshot = binding.snapshot();
      expect(snapshot.status).toBe("completed");
      expect(snapshot.activeTurn).toBeUndefined();
      expect(binding.events.at(-1)?.data).toEqual({ outputText: "Done" });
      expect(binding.events.map((event) => event.type)).toEqual([
        "session.registered",
        "session.connected",
        "turn.accepted",
        "turn.started",
        "tool_call_proposed",
        "tool_result_submitted",
        "text_delta",
        "turn_completed",
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("exposes authenticated JSON event replay and action routes", async () => {
    const { harness, transport, stateDir } = makeHarness();
    process.env.OC_JARVIS_TOKEN = "test-token";
    const base = "http://127.0.0.1/internal/jarvis/v1";
    const auth = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
    try {
      const create = await handleJarvisRequest(
        new Request(`${base}/sessions`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            sessionId: "asess_test_2",
            workspaceId: "ws_test_2",
            cwd: process.cwd(),
            sessionPath: providerSessionPath(stateDir),
          }),
        }),
        new URL(`${base}/sessions`),
        { harness },
      );
      expect(create?.status).toBe(201);

      const start = await handleJarvisRequest(
        new Request(`${base}/sessions/asess_test_2/turns`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ turnId: "turn_test_2", attemptId: "att_test_2", prompt: "Run a tool" }),
        }),
        new URL(`${base}/sessions/asess_test_2/turns`),
        { harness },
      );
      expect(start?.status).toBe(202);

      transport.emit({
        type: "host_tool_call",
        id: "rpc_action_2",
        toolCallId: "tool_call_2",
        toolName: "read_file",
        arguments: { path: "package.json" },
      });

      const replay = await handleJarvisRequest(
        new Request(`${base}/sessions/asess_test_2/events?stream=0&after=0`, { headers: auth }),
        new URL(`${base}/sessions/asess_test_2/events?stream=0&after=0`),
        { harness },
      );
      expect(replay?.status).toBe(200);
      const replayBody = await replay!.json() as { events: Array<{ type: string }>; nextSequence: number };
      expect(replayBody.events.map((event) => event.type)).toContain("tool_call_proposed");
      expect(replayBody.nextSequence).toBeGreaterThan(0);

      const result = await handleJarvisRequest(
        new Request(`${base}/sessions/asess_test_2/actions/rpc_action_2/result`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ turnId: "turn_test_2", attemptId: "att_test_2", success: false, error: "denied" }),
        }),
        new URL(`${base}/sessions/asess_test_2/actions/rpc_action_2/result`),
        { harness },
      );
      expect(result?.status).toBe(200);
      expect(transport.frames[0]).toMatchObject({ type: "host_tool_result", id: "rpc_action_2", isError: true });

      const unauthorized = await handleJarvisRequest(
        new Request(`${base}/sessions`, { method: "GET" }),
        new URL(`${base}/sessions`),
        { harness },
      );
      expect(unauthorized?.status).toBe(401);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
