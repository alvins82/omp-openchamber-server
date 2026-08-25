import { describe, it, expect, afterEach } from "bun:test";
import type { OpenCodeEvent } from "./sse";
import { toOpenCodeSessionId, fromOpenCodeSessionId } from "./sessions";
import {
  formatOpenCodeEvent,
  createOpenCodeEventStream,
  emitOpenCodeEvent,
  emitSessionStatus,
  emitMessagePartDelta,
  emitMessagePartUpdated,
  emitMessageUpdated,
  emitSessionUpdated,
  emitSessionIdle,
  subscribeOpenCodeEvents,
} from "./sse";
import {
  mapRpcMessagesToOpenCodeRecords,
  type AgentMessage,
  type OpenCodeToolPart,
  type OpenCodeTextPart,
} from "./messages";
import {
  mapRpcModelsToOpenCodeProviders,
  type OmpRpcModel,
  type OpenCodeProvider,
  type OpenCodeModel,
} from "./rpc";

// ---------------------------------------------------------------------------
// Session ID round-trip: toOpenCodeSessionId / fromOpenCodeSessionId
// ---------------------------------------------------------------------------

describe("session ID round-trip", () => {
  it("round-trips a standard UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(fromOpenCodeSessionId(toOpenCodeSessionId(uuid))).toBe(uuid);
  });

  it("toOpenCodeSessionId strips dashes and prepends ses_", () => {
    expect(toOpenCodeSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "ses_550e8400e29b41d4a716446655440000",
    );
  });

  it("toOpenCodeSessionId passes through already-prefixed id", () => {
    expect(toOpenCodeSessionId("ses_abc")).toBe("ses_abc");
  });

  it("fromOpenCodeSessionId extracts UUID with dashes", () => {
    expect(
      fromOpenCodeSessionId("ses_550e8400e29b41d4a716446655440000"),
    ).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("fromOpenCodeSessionId passes through non-ses_ input", () => {
    expect(fromOpenCodeSessionId("plain-id")).toBe("plain-id");
  });

  it("fromOpenCodeSessionId passes through invalid hex chars", () => {
    expect(
      fromOpenCodeSessionId("ses_nothex123456789012345678901234567"),
    ).toBe("ses_nothex123456789012345678901234567");
  });

  it("fromOpenCodeSessionId passes through wrong-length hex", () => {
    expect(
      fromOpenCodeSessionId("ses_550e8400e29b41d4a71644665544"),
    ).toBe("ses_550e8400e29b41d4a71644665544");
  });

  it("handles uppercase UUID via lowercasing", () => {
    const uuid = "550E8400-E29B-41D4-A716-446655440000";
    const encoded = toOpenCodeSessionId(uuid);
    expect(encoded).toBe("ses_550e8400e29b41d4a716446655440000");
    expect(fromOpenCodeSessionId(encoded)).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });
});

// ---------------------------------------------------------------------------
// SSE text formatting: formatOpenCodeEvent
// ---------------------------------------------------------------------------

describe("formatOpenCodeEvent", () => {
  it("produces data-only line with double-newline terminator", () => {
    const raw = formatOpenCodeEvent("test.event", { key: "val" });
    expect(raw).toMatch(/^data: /);
    expect(raw.endsWith("\n\n")).toBe(true);
  });

  it("serializes payload with id, type, and properties as valid JSON", () => {
    const raw = formatOpenCodeEvent("e", { num: 42, str: "hello" });
    const match = raw.match(/^data: (.+)\n\n$/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]);
    expect(parsed.payload).toMatchObject({
      type: "e",
      properties: { num: 42, str: "hello" },
    });
    expect(parsed.payload.id).toMatch(/^evt_[0-9a-f]+$/i);
  });

  it("includes directory and project when directory is provided", () => {
    const raw = formatOpenCodeEvent("e", {}, "/test/dir");
    const parsed = JSON.parse(raw.slice(6));
    expect(parsed.directory).toBe("/test/dir");
    expect(parsed.project).toBe("global");
    expect(parsed.payload.type).toBe("e");
  });
});

// ---------------------------------------------------------------------------
// SSE event shapes: each emit function dispatches the correct type + properties
// ---------------------------------------------------------------------------

describe("SSE event shapes", () => {
  const received: OpenCodeEvent[] = [];
  let unsub: (() => void) | null = null;

  afterEach(() => {
    received.length = 0;
    unsub?.();
    unsub = null;
  });

  it("emitSessionStatus -> session.status with {sessionID, status:{type}}", () => {
    unsub = subscribeOpenCodeEvents((e) => received.push(e));
    emitSessionStatus("ses_id", { type: "busy" });
    expect(received[0].type).toBe("session.status");
    expect(received[0].properties).toMatchObject({
      sessionID: "ses_id",
      status: { type: "busy" },
    });
  });

  it("emitMessagePartDelta -> message.part.delta with field:text and delta", () => {
    unsub = subscribeOpenCodeEvents((e) => received.push(e));
    emitMessagePartDelta("ses_id", "msg1", "part2", "Hello");
    expect(received[0].type).toBe("message.part.delta");
    expect(received[0].properties).toMatchObject({
      sessionID: "ses_id",
      messageID: "msg1",
      partID: "part2",
      field: "text",
      delta: "Hello",
    });
  });

  it("emitMessagePartUpdated -> message.part.updated with reasoning part shape", () => {
    unsub = subscribeOpenCodeEvents((e) => received.push(e));
    emitMessagePartUpdated("ses_id", {
      id: "part_reasoning",
      type: "reasoning",
      text: "thinking",
      messageID: "msg1",
      sessionID: "ses_id",
    });
    expect(received[0].type).toBe("message.part.updated");
    expect(received[0].properties).toMatchObject({
      sessionID: "ses_id",
      part: {
        id: "part_reasoning",
        type: "reasoning",
        text: "thinking",
        messageID: "msg1",
        sessionID: "ses_id",
      },
    });
  });

  it("emitSessionUpdated -> session.updated with {info: session}", () => {
    unsub = subscribeOpenCodeEvents((e) => received.push(e));
    const session = { id: "ses_id", title: "Test" };
    emitSessionUpdated(session);
    expect(received[0].type).toBe("session.updated");
    expect(received[0].properties).toEqual({ info: session });
  });

  it("emitMessageUpdated -> message.updated with properties directly", () => {
    unsub = subscribeOpenCodeEvents((e) => received.push(e));
    const props = { messageID: "msg1", status: "done" };
    emitMessageUpdated(props);
    expect(received[0].type).toBe("message.updated");
    expect(received[0].properties).toEqual(props);
  });

  it("emitSessionIdle -> session.idle with {sessionID}", () => {
    unsub = subscribeOpenCodeEvents((e) => received.push(e));
    emitSessionIdle("ses_id");
    expect(received[0].type).toBe("session.idle");
    expect(received[0].properties).toEqual({ sessionID: "ses_id" });
  });

  it("multiple listeners each receive every event", () => {
    const a: OpenCodeEvent[] = [];
    const b: OpenCodeEvent[] = [];
    const u1 = subscribeOpenCodeEvents((e) => a.push(e));
    const u2 = subscribeOpenCodeEvents((e) => b.push(e));
    emitOpenCodeEvent("test", { n: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    u1();
    u2();
  });
});

// ---------------------------------------------------------------------------
// SSE stream end-to-end: createOpenCodeEventStream → emit → SSE text
// ---------------------------------------------------------------------------

describe("createOpenCodeEventStream", () => {
  it("forwards emitted events as formatted SSE text", async () => {
    const stream = createOpenCodeEventStream("/workspace");
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // Initial server.connected event
    const init = await reader.read();
    const initPayload = decoder.decode(init.value);
    expect(initPayload).toMatch(/^data: /);
    const parsedInit = JSON.parse(initPayload.slice(6));
    expect(parsedInit.payload.type).toBe("server.connected");

    // Emit via the same path the proxy uses
    emitSessionStatus("ses_test", { type: "busy" });

    const event = await reader.read();
    const payload = decoder.decode(event.value);
    expect(payload).toMatch(/^data: /);
    const parsed = JSON.parse(payload.slice(6));

    expect(parsed.payload.type).toBe("session.status");
    expect(parsed.payload.properties).toEqual({
      sessionID: "ses_test",
      status: { type: "busy" },
    });
    expect(parsed.directory).toBe("/workspace");

    reader.cancel();
  });
});

// ---------------------------------------------------------------------------
// RPC message mapping: AgentMessage[] -> OpenCodeMessageRecord[]
// ---------------------------------------------------------------------------

function isToolPart(part: unknown): part is OpenCodeToolPart {
  if (part == null || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  if (p.type !== "tool") return false;
  if (typeof p.tool !== "string") return false;
  if (typeof p.messageID !== "string") return false;
  if (typeof p.sessionID !== "string") return false;
  if (p.state == null || typeof p.state !== "object") return false;
  const s = p.state as Record<string, unknown>;
  if (
    s.status !== "pending" &&
    s.status !== "running" &&
    s.status !== "completed" &&
    s.status !== "error"
  ) {
    return false;
  }
  return true;
}

describe("mapRpcMessagesToOpenCodeRecords", () => {
  it("renders toolCall + matching toolResult as a completed tool part", () => {
    const raw = [
      { id: "u1", role: "user", content: [{ type: "text", text: "read it" }] },
      {
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "readFile",
            arguments: { path: "test.txt" },
          },
        ],
      },
      {
        id: "t1",
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "readFile",
        content: [{ type: "text", text: "hello world" }],
        isError: false,
      },
    ] as unknown as AgentMessage[]; // confirmed raw RPC shape; cast through unknown until AgentMessage type includes these fields

    const records = mapRpcMessagesToOpenCodeRecords(raw, "ses_123");

    const toolParts = records
      .flatMap((r) => r.parts)
      .filter(isToolPart);
    expect(toolParts).toHaveLength(1);

    const part = toolParts[0]!;
    expect(part.type).toBe("tool");
    expect(part.callID).toBe("call-1");
    expect(part.tool).toBe("readFile");
    expect(part.state.status).toBe("completed");
    expect(part.state.input).toEqual({ path: "test.txt" });
    expect(part.state.output).toBe("hello world");
    expect(part.state.time).toMatchObject({
      start: expect.any(Number),
      end: expect.any(Number),
    });
  });

  it("marks a tool part as error when the matching toolResult has isError", () => {
    const raw = [
      { id: "u1", role: "user", content: [{ type: "text", text: "run it" }] },
      {
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-2",
            name: "bash",
            arguments: { command: "false" },
          },
        ],
      },
      {
        id: "t1",
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "bash",
        content: [{ type: "text", text: "exit status 1" }],
        isError: true,
      },
    ] as unknown as AgentMessage[]; // confirmed raw RPC shape; cast through unknown until AgentMessage type includes these fields

    const records = mapRpcMessagesToOpenCodeRecords(raw, "ses_123");

    const toolParts = records.flatMap((r) => r.parts).filter(isToolPart);
    expect(toolParts).toHaveLength(1);

    const part = toolParts[0]!;
    expect(part.state.status).toBe("error");
    expect(part.state.error).toBe("exit status 1");
    expect(part.state).toHaveProperty("time.end");
  });

  it("falls back to a text pseudo-block when a toolResult has no matching toolCall", () => {
    const raw = [
      { id: "u1", role: "user", content: [{ type: "text", text: "hello" }] },
      {
        id: "t1",
        role: "toolResult",
        toolCallId: "orphan-call",
        toolName: "readFile",
        content: [{ type: "text", text: "unexpected result" }],
        isError: false,
      },
    ] as unknown as AgentMessage[]; // confirmed raw RPC shape; cast through unknown until AgentMessage type includes these fields

    const records = mapRpcMessagesToOpenCodeRecords(raw, "ses_123");

    const toolParts = records.flatMap((r) => r.parts).filter(isToolPart);
    expect(toolParts).toHaveLength(0);

    const textParts = records
      .flatMap((r) => r.parts)
      .filter((p): p is OpenCodeTextPart => p.type === "text");
    expect(textParts.length).toBeGreaterThan(0);
    expect(
      textParts.some((p) => p.text.includes("unexpected result")),
    ).toBe(true);
  });

  it("links assistant messages to the previous user message with parentID", () => {
    const messages: AgentMessage[] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "hello" }] },
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        provider: "openai",
        model: "gpt-4",
        stopReason: "stop",
      },
    ];
    const records = mapRpcMessagesToOpenCodeRecords(messages, "ses_123");

    expect(records).toHaveLength(2);
    expect(records[0].info.role).toBe("user");
    expect(records[1].info.role).toBe("assistant");
    expect(records[1].info.parentID).toBe(records[0].info.id);
  });

  it("finalizes assistant messages with finish:stop and provider/model fields", () => {
    const messages: AgentMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        provider: "anthropic",
        model: "claude-3",
        variant: "default",
        stopReason: "stop",
      },
    ];
    const records = mapRpcMessagesToOpenCodeRecords(messages, "ses_123");

    expect(records[0].info.finish).toBe("stop");
    expect(records[0].info.providerID).toBe("anthropic");
    expect(records[0].info.modelID).toBe("claude-3");
    expect(records[0].info.variant).toBe("default");
    expect(records[0].info.mode).toBe("primary");
    expect(records[0].info.cost).toBe(0);
    expect(records[0].info.tokens).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    expect(records[0].info.model).toEqual({
      id: "claude-3",
      providerID: "anthropic",
      modelID: "claude-3",
      variant: "default",
    });
  });

  it("maps text blocks to text parts and thinking blocks to reasoning parts", () => {
    const messages: AgentMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "let me think" },
        ],
        provider: "openai",
        model: "gpt-4",
      },
    ];
    const records = mapRpcMessagesToOpenCodeRecords(messages, "ses_123");

    expect(records[0].parts[0].type).toBe("text");
    expect((records[0].parts[0] as OpenCodeTextPart).text).toBe("answer");
    expect(records[0].parts[1].type).toBe("reasoning");
    expect((records[0].parts[1] as OpenCodeTextPart).text).toBe("let me think");
  });

  it("maps custom role with user attribution to user", () => {
    const messages: AgentMessage[] = [
      {
        id: "c1",
        role: "custom",
        content: [{ type: "text", text: "context" }],
        display: true,
        attribution: "user",
      },
    ];
    const records = mapRpcMessagesToOpenCodeRecords(messages, "ses_123");

    expect(records[0].info.role).toBe("user");
  });

  it("skips custom messages with display:false", () => {
    const messages: AgentMessage[] = [
      {
        id: "c1",
        role: "custom",
        content: [{ type: "text", text: "hidden" }],
        display: false,
        attribution: "user",
      },
    ];
    const records = mapRpcMessagesToOpenCodeRecords(messages, "ses_123");

    expect(records).toHaveLength(0);
  });

  it("maps developer and toolResult roles correctly", () => {
    const messages: AgentMessage[] = [
      { id: "d1", role: "developer", content: [{ type: "text", text: "system" }] },
      { id: "u1", role: "user", content: [{ type: "text", text: "hello" }] },
      { id: "t1", role: "toolResult", content: [{ type: "text", text: "result" }] },
    ];
    const records = mapRpcMessagesToOpenCodeRecords(messages, "ses_123");

    expect(records[0].info.role).toBe("user");
    expect(records[1].info.role).toBe("user");
    expect(records[2].info.role).toBe("assistant");
    expect(records[2].info.parentID).toBe(records[1].info.id);
  });

  it("maps a standalone toolCall block to a real tool part", () => {
    const messages: AgentMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-standalone",
            name: "readFile",
            arguments: { path: "test.txt" },
          },
        ],
        provider: "openai",
        model: "gpt-4",
      },
    ];
    const records = mapRpcMessagesToOpenCodeRecords(messages, "ses_123");

    expect(records[0].info.role).toBe("assistant");
    const toolParts = records[0].parts.filter(isToolPart);
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]!.tool).toBe("readFile");
    expect(toolParts[0]!.state.input).toEqual({ path: "test.txt" });
  });
});

// ---------------------------------------------------------------------------
// Providers mapping: RPC flat models -> OpenChamber /config/providers shape
// ---------------------------------------------------------------------------

describe("mapRpcModelsToOpenCodeProviders", () => {
  it("groups flat RPC models by provider and returns models as a record keyed by id", () => {
    const models: OmpRpcModel[] = [
      { provider: "openai", id: "gpt-4", name: "GPT-4", contextWindow: 8192 },
      { provider: "openai", id: "gpt-3.5", name: "GPT-3.5", contextWindow: 4096 },
      { provider: "anthropic", id: "claude-3", name: "Claude 3", contextWindow: 200000 },
    ];
    const result = mapRpcModelsToOpenCodeProviders(models);

    expect(result.providers).toHaveLength(2);
    const openai = result.providers.find((p: OpenCodeProvider) => p.id === "openai")!;
    expect(openai).toMatchObject({ id: "openai", name: "openai" });
    expect(Object.keys(openai.models)).toEqual(["gpt-4", "gpt-3.5"]);
    expect(openai.models["gpt-4"]).toMatchObject({
      id: "gpt-4",
      name: "GPT-4",
      providerID: "openai",
      limit: { context: 8192 },
    });
  });

  it("preserves optional input/reasoning fields on OpenCode models", () => {
    const models: OmpRpcModel[] = [
      { provider: "openai", id: "gpt-4", name: "GPT-4", input: 10, reasoning: 20 },
    ];
    const result = mapRpcModelsToOpenCodeProviders(models);
    const model = result.providers[0].models["gpt-4"] as OpenCodeModel;

    expect(model).toMatchObject({ id: "gpt-4", name: "GPT-4", capabilities: { input: 10 }, reasoning: 20 });
  });

  it("default selects the provider matching currentProviderID", () => {
    const models: OmpRpcModel[] = [
      { provider: "openai", id: "gpt-4", name: "GPT-4" },
      { provider: "anthropic", id: "claude-3", name: "Claude 3" },
    ];
    const result = mapRpcModelsToOpenCodeProviders(models, "anthropic");

    expect(result.default).toEqual({ default: "anthropic" });
  });

  it("default falls back to the first provider when no currentProviderID", () => {
    const models: OmpRpcModel[] = [
      { provider: "openai", id: "gpt-4", name: "GPT-4" },
      { provider: "anthropic", id: "claude-3", name: "Claude 3" },
    ];
    const result = mapRpcModelsToOpenCodeProviders(models);

    expect(result.default).toEqual({ default: "openai" });
  });

  it("returns empty providers and empty default when input is empty", () => {
    const result = mapRpcModelsToOpenCodeProviders([]);

    expect(result.providers).toEqual([]);
    expect(result.default).toEqual({ default: "" });
  });
});
