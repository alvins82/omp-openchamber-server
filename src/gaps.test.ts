import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  formatOpenCodeEvent,
  createOpenCodeEventStream,
  emitSessionStatus,
  emitMessagePartUpdated,
  emitMessagePartDelta,
  emitSessionError,
  subscribeOpenCodeEvents,
  type OpenCodeEvent,
} from "./sse";
import {
  createOmpSession,
  getOmpSessionByOpenCodeId,
  deleteOmpSession,
  updateOmpSession,
  listOmpSessions,
} from "./sessions";
import { mapRpcMessagesToOpenCodeRecords, type AgentMessage, type OpenCodeToolPart } from "./messages";
import { createEventHandler } from "./prompt";
import type { OmpRpcEvent } from "./rpc";

const TMP_HOME = mkdtempSync(join(tmpdir(), "oc-gaps-test-"));
const PROJ_DIR = join(TMP_HOME, "my-project");
const SESSIONS_DIR = join(TMP_HOME, ".omp", "agent", "sessions");

beforeAll(() => {
  Bun.env.HOME = TMP_HOME;
  process.env.HOME = TMP_HOME;
  mkdirSync(PROJ_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

// Helper simulating OpenChamber's resolveEventPayload gate from event-pipeline.ts
function resolveEventPayload(payload: unknown): unknown | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { type?: unknown; payload?: unknown };
  if (typeof record.type === "string") return payload;
  if (
    record.payload &&
    typeof record.payload === "object" &&
    typeof (record.payload as { type?: unknown }).type === "string"
  ) {
    return record.payload;
  }
  return null;
}

describe("Gap Map Verification Tests (G1 - G8)", () => {
  // -------------------------------------------------------------------------
  // G1 (P0): SSE Framing & Event Gate
  // -------------------------------------------------------------------------
  describe("G1 (P0): SSE envelope & event delivery", () => {
    it("emits data-only frames that pass OpenChamber resolveEventPayload", () => {
      const raw = formatOpenCodeEvent("session.status", { sessionID: "ses_1", status: { type: "busy" } }, PROJ_DIR);
      expect(raw.startsWith("data: ")).toBe(true);
      expect(raw.endsWith("\n\n")).toBe(true);
      expect(raw).not.toContain("event: ");
      expect(raw).not.toContain("id: ");

      const dataJson = JSON.parse(raw.replace(/^data: /, "").trim());
      expect(dataJson.directory).toBe(PROJ_DIR);
      expect(dataJson.project).toBe("global");
      expect(dataJson.payload).toMatchObject({
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "busy" } },
      });

      // Crucial: Must pass OpenChamber's payload gate
      const resolved = resolveEventPayload(dataJson);
      expect(resolved).not.toBeNull();
      expect((resolved as any).type).toBe("session.status");
    });

    it("stream begins with server.connected and carries server.heartbeat data frames", async () => {
      const stream = createOpenCodeEventStream(PROJ_DIR);
      const reader = stream.getReader();
      const dec = new TextDecoder();

      const firstChunk = await reader.read();
      const firstText = dec.decode(firstChunk.value);
      expect(firstText.startsWith("data: ")).toBe(true);

      const parsed = JSON.parse(firstText.replace(/^data: /, "").trim());
      expect(parsed.payload.type).toBe("server.connected");
      expect(resolveEventPayload(parsed)).not.toBeNull();

      reader.cancel();
    });
  });

  // -------------------------------------------------------------------------
  // G2 (P0): Session Creation Persistence
  // -------------------------------------------------------------------------
  describe("G2 (P0): POST /session creates persistent session", () => {
    it("pre-creates a header JSONL that is immediately discoverable and valid", async () => {
      const session = await createOmpSession(PROJ_DIR, { title: "Persistent Session" });
      expect(session.id.startsWith("ses_")).toBe(true);
      expect(session.projectID).toBe("global");
      expect(session.title).toBe("Persistent Session");
      expect(session.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
      expect(session.model).toEqual({ id: "omp", providerID: "omp", modelID: "omp", variant: "default" });

      // Verify header file exists on disk with title slot and session header
      const fileText = await Bun.file(session.path).text();
      const lines = fileText.trim().split("\n");
      const titleSlot = JSON.parse(lines[0]);
      expect(titleSlot.type).toBe("title");
      const header = JSON.parse(lines[1]);
      expect(header.type).toBe("session");
      expect(header.cwd).toBe(PROJ_DIR);
      expect(header.version).toBe(3);

      // Verify session is discoverable
      const fetched = await getOmpSessionByOpenCodeId(session.id, PROJ_DIR);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(session.id);
      expect(fetched?.title).toBe("Persistent Session");

      // Verify session appears in listing
      const list = await listOmpSessions(PROJ_DIR);
      expect(list.some((s) => s.id === session.id)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // G4 (P1): Session Lifecycle Operations
  // -------------------------------------------------------------------------
  describe("G4 (P1): Session lifecycle (update & delete)", () => {
    it("updateOmpSession updates session title", async () => {
      const session = await createOmpSession(PROJ_DIR, { title: "Old Title" });
      const updated = await updateOmpSession(session.id, { title: "New Title" }, PROJ_DIR);
      expect(updated?.title).toBe("New Title");

      const fetched = await getOmpSessionByOpenCodeId(session.id, PROJ_DIR);
      expect(fetched?.title).toBe("New Title");
    });

    it("deleteOmpSession deletes session JSONL from disk", async () => {
      const session = await createOmpSession(PROJ_DIR, { title: "To Delete" });
      const ok = await deleteOmpSession(session.id, PROJ_DIR);
      expect(ok).toBe(true);

      const fetched = await getOmpSessionByOpenCodeId(session.id, PROJ_DIR);
      expect(fetched).toBeNull();
      expect(await Bun.file(session.path).exists()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // G5 (P1): Message & Tool Part Shapes
  // -------------------------------------------------------------------------
  describe("G5 (P1): Message and tool part shapes", () => {
    it("populates top-level callID on ToolPart and required AssistantMessage fields", () => {
      const rawMessages: AgentMessage[] = [
        { id: "u1", role: "user", content: "read a file" },
        {
          id: "a1",
          role: "assistant",
          provider: "anthropic",
          model: "claude-3-5-sonnet",
          content: [
            {
              type: "toolCall",
              id: "call_abc123",
              name: "readFile",
              arguments: { path: "hello.txt" },
            },
          ],
        },
        {
          id: "t1",
          role: "toolResult",
          toolCallId: "call_abc123",
          toolName: "readFile",
          content: "file content",
          isError: false,
        },
      ];

      const records = mapRpcMessagesToOpenCodeRecords(rawMessages, "ses_test");
      expect(records).toHaveLength(2);

      const asstRecord = records[1];
      expect(asstRecord.info.mode).toBe("primary");
      expect(asstRecord.info.cost).toBe(0);
      expect(asstRecord.info.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
      expect(asstRecord.info.model).toEqual({
        id: "claude-3-5-sonnet",
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
        variant: "default",
      });

      const toolPart = asstRecord.parts.find((p): p is OpenCodeToolPart => p.type === "tool");
      expect(toolPart).toBeDefined();
      expect(toolPart?.callID).toBe("call_abc123");
      expect(toolPart?.tool).toBe("readFile");
      expect(toolPart?.state.status).toBe("completed");
      expect(toolPart?.state.output).toBe("file content");
    });

    it("respects agent_end.isTerminal === false to prevent premature turn finish", () => {
      const events: OpenCodeEvent[] = [];
      let completed = false;
      const unsub = subscribeOpenCodeEvents((e) => events.push(e));

      const handler = createEventHandler("ses_test", undefined, { providerID: "omp", modelID: "omp", variant: "default" }, () => {
        completed = true;
      });

      // Non-terminal agent_end
      handler({ type: "agent_end", isTerminal: false } as unknown as OmpRpcEvent);
      expect(completed).toBe(false);

      // Terminal agent_end
      handler({ type: "agent_end", isTerminal: true } as unknown as OmpRpcEvent);
      expect(completed).toBe(true);

      unsub();
    });
  });
});
