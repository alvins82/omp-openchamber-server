import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { subscribeOpenCodeEvents, type OpenCodeEvent } from "./sse";
import { createEventHandler } from "./prompt";
import type { OmpRpcEvent } from "./rpc";

const SES = "ses_testseq0000000000000000000000000";

function textDelta(text: string): OmpRpcEvent {
  return { type: "message_update",
    assistantMessageEvent: { type: "text_delta", text },
  } as unknown as OmpRpcEvent;
}
function thinkDelta(text: string): OmpRpcEvent {
  return { type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", text },
  } as unknown as OmpRpcEvent;
}
function toolEvent(type: string, payload: Record<string, unknown>): OmpRpcEvent {
  return { type, payload } as unknown as OmpRpcEvent;
}
function agentEnd(): OmpRpcEvent {
  return { type: "agent_end" } as unknown as OmpRpcEvent;
}

interface MsgInfo { id: string; role: string; finish?: string; }
interface Part {
  id: string;
  type: string;
  text?: string;
  tool?: string;
  messageID: string;
  sessionID: string;
  time?: { start: number; end?: number };
  state?: {
    status: string;
    input?: unknown;
    output?: string;
    error?: string;
    time?: { start: number; end?: number };
  };
}

let got: OpenCodeEvent[] = [];
let done = 0;
let unsub: (() => void) | null = null;

beforeEach(() => {
  got = [];
  done = 0;
  unsub = subscribeOpenCodeEvents((e) => got.push(e));
});
afterEach(() => {
  unsub?.();
  unsub = null;
});

const MODEL = {
  providerID: "p", modelID: "m", variant: "d"
};

function runTurn(events: OmpRpcEvent[]): number {
  const h = createEventHandler(SES, undefined as undefined, MODEL, () => { done++; });
  for (const e of events) h(e);
  return done;
}

function partOf(i: number): Part {
  return (got[i].properties as { part: Part }).part;
}

function infoOf(i: number): MsgInfo {
  return (got[i].properties as { info: MsgInfo }).info;
}

describe("golden turn sequence (event handler -> SSE)", () => {
  it("standard text turn emits info, part updated, delta, finalized info", () => {
    runTurn([textDelta("Hel"), textDelta("lo"), agentEnd()]);
    expect(got).toHaveLength(4);
    expect(got[0].type).toBe("message.updated");
    const info = infoOf(0);
    expect(info.role).toBe("assistant");
    expect(info.finish).toBeUndefined();
    const prefix = "msg_" + SES + "_assistant_";
    expect(info.id.startsWith(prefix)).toBe(true);
    expect(partOf(1).messageID).toBe(info.id);
    expect(got[1].type).toBe("message.part.updated");
    const p1 = partOf(1);
    expect(p1.type).toBe("text");
    expect(p1.text).toBe("Hel");
    expect(p1.sessionID).toBe(SES);
    expect(p1.id).toBe("part_" + SES + "_" + info.id + "_1");
    expect(got[2].type).toBe("message.part.delta");
    const d = got[2].properties as { partID: string;
      delta: string; field: string; messageID: string };
    expect(d.partID).toBe(p1.id);
    expect(d.messageID).toBe(info.id);
    expect(d.field).toBe("text");
    expect(d.delta).toBe("lo");
    expect(got[3].type).toBe("message.updated");
    expect(infoOf(3).id).toBe(info.id);
    expect(infoOf(3).finish).toBe("stop");
    expect(done).toBe(1);
  });

  it("thinking then text splits into ordered reasoning and text parts and finalizes reasoning with time.end", () => {
    runTurn([thinkDelta("why"), textDelta("because"), agentEnd()]);
    expect(got).toHaveLength(5);
    expect(got.map((e) => e.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.part.updated",
      "message.part.updated",
      "message.updated",
    ]);
    const p1Start = partOf(1);
    const p1End = partOf(2);
    const p2 = partOf(3);
    expect(p1Start.type).toBe("reasoning");
    expect(p1Start.text).toBe("why");
    expect(p1Start.time?.start).toBeTypeOf("number");
    expect(p1Start.time?.end).toBeUndefined();

    expect(p1End.type).toBe("reasoning");
    expect(p1End.text).toBe("why");
    expect(p1End.time?.start).toBeTypeOf("number");
    expect(p1End.time?.end).toBeTypeOf("number");

    expect(p2.type).toBe("text");
    expect(p2.text).toBe("because");
    const mid = infoOf(0).id;
    expect(p1Start.id).toBe("part_" + SES + "_" + mid + "_1");
    expect(p1End.id).toBe("part_" + SES + "_" + mid + "_1");
    expect(p2.id).toBe("part_" + SES + "_" + mid + "_2");
    expect(done).toBe(1);
  });

  it("reasoning followed by tool execution finalizes reasoning with time.end", () => {
    runTurn([
      thinkDelta("planning bash command"),
      toolEvent("tool_execution_start", { toolCallId: "c1", tool: "bash", arguments: "{}" }),
      toolEvent("tool_execution_end", { toolCallId: "c1", output: "ok" }),
      thinkDelta("reviewing output"),
      textDelta("done!"),
      agentEnd(),
    ]);
    const reasoningParts = got
      .filter((e) => e.type === "message.part.updated")
      .map((e) => (e.properties as { part: Part }).part)
      .filter((p) => p.type === "reasoning");

    expect(reasoningParts.length).toBe(4); // 2 starts, 2 completions
    const block1End = reasoningParts[1];
    const block2End = reasoningParts[3];
    expect(block1End.text).toBe("planning bash command");
    expect(block1End.time?.end).toBeTypeOf("number");
    expect(block2End.text).toBe("reviewing output");
    expect(block2End.time?.end).toBeTypeOf("number");
    expect(done).toBe(1);
  });

  it("background tool_execution_update events do not fragment an in-flight reasoning stream", () => {
    runTurn([
      toolEvent("tool_execution_start", { toolCallId: "bg1", tool: "task", arguments: "{}" }),
      thinkDelta("Thinking step 1... "),
      toolEvent("tool_execution_update", { toolCallId: "bg1", output: "Running agent..." }),
      thinkDelta("Thinking step 2... "),
      toolEvent("tool_execution_update", { toolCallId: "bg1", output: "Running agent (evaluating)..." }),
      thinkDelta("Thinking step 3."),
      agentEnd(),
    ]);

    const reasoningStartParts = got
      .filter((e) => e.type === "message.part.updated")
      .map((e) => (e.properties as { part: Part }).part)
      .filter((p) => p.type === "reasoning" && p.time?.end === undefined);

    // Exactly 1 reasoning part was started, not 3!
    expect(reasoningStartParts.length).toBe(1);

    const deltas = got.filter((e) => e.type === "message.part.delta");
    expect(deltas.length).toBe(2);

    const finalizedReasoning = got
      .filter((e) => e.type === "message.part.updated")
      .map((e) => (e.properties as { part: Part }).part)
      .filter((p) => p.type === "reasoning" && p.time?.end !== undefined);

    expect(finalizedReasoning.length).toBe(1);
    expect(finalizedReasoning[0].text).toBe("Thinking step 1... Thinking step 2... Thinking step 3.");
    expect(done).toBe(1);
  });

  it("tool execution events reduce into one running then completed part", () => {
    runTurn([
      toolEvent("tool_execution_start",
        { toolCallId: "c1", tool: "bash", arguments: "{\"a\":1}" }),
      toolEvent("tool_execution_update",
        { toolCallId: "c1", output: "line1" }),
      toolEvent("tool_execution_end",
        { toolCallId: "c1", output: "line1\nline2" }),
      agentEnd(),
    ]);
    expect(got).toHaveLength(5);
    expect(got[0].type).toBe("message.updated");
    const mid = infoOf(0).id;
    for (const i of [1, 2, 3]) {
      expect(got[i].type).toBe("message.part.updated");
      expect(partOf(i).id).toBe("c1");
      expect(partOf(i).tool).toBe("bash");
      expect(partOf(i).messageID).toBe(mid);
    }
    expect(partOf(1).state?.status).toBe("running");
    expect(partOf(1).state?.input).toEqual({ a: 1 });
    expect(partOf(2).state?.status).toBe("running");
    expect(partOf(2).state?.output).toBe("line1");
    expect(partOf(3).state?.status).toBe("completed");
    expect(partOf(3).state?.output).toBe("line1\nline2");
    expect(got[4].type).toBe("message.updated");
    expect(infoOf(4).id).toBe(mid);
    expect(infoOf(4).finish).toBe("stop");
    expect(done).toBe(1);
  });

  it("tool execution end with isError maps to an error part state", () => {
    runTurn([
      toolEvent("tool_execution_start",
        { toolCallId: "c2", tool: "Bash" }),
      toolEvent("tool_execution_end",
        { toolCallId: "c2", isError: true, output: "boom" }),
      agentEnd(),
    ]);
    expect(got).toHaveLength(4);
    expect(partOf(1).state?.status).toBe("running");
    expect(partOf(2).state?.status).toBe("error");
    expect(partOf(2).state?.error).toBe("boom");
    expect(partOf(2).state?.output).toBe("boom");
    expect(infoOf(3).finish).toBe("stop");
    expect(done).toBe(1);
  });

  it("tool execution with partial stream metadata and block array output isolates input and unboxes text", () => {
    runTurn([
      toolEvent("tool_execution_start", {
        toolCallId: "c3",
        tool: "todo",
        arguments: { task: "Unblock commit 2 task" },
      }),
      toolEvent("tool_execution_end", {
        toolCallId: "c3",
        tool: "todo",
        contentIndex: 4,
        partial: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal thought" }],
        },
        result: [{ type: "text", text: "Remaining items (2): - Commit 1: Rust + docs" }],
      }),
      agentEnd(),
    ]);

    expect(got).toHaveLength(4);
    expect(partOf(1).state?.status).toBe("running");
    expect(partOf(1).state?.input).toEqual({ task: "Unblock commit 2 task" });

    expect(partOf(2).state?.status).toBe("completed");
    expect(partOf(2).state?.input).toEqual({ task: "Unblock commit 2 task" });
    expect(partOf(2).state?.output).toBe("Remaining items (2): - Commit 1: Rust + docs");
    expect(infoOf(3).finish).toBe("stop");
    expect(done).toBe(1);
  });

  it("P11 failturn: agent_end with no assistant output emits nothing", () => {
    expect(runTurn([agentEnd()])).toBe(1);
    expect(got).toHaveLength(0);
  });

  it("prompt_result with agentInvoked false also completes silently", () => {
    const ev = { type: "prompt_result", agentInvoked: false } as unknown as OmpRpcEvent;
    expect(runTurn([ev])).toBe(1);
    expect(got).toHaveLength(0);
  });

  it("ignores unknown event types without completing the turn", () => {
    const unknowns = [
      { type: "agent_start" },
      { type: "session_switched" },
    ] as unknown as OmpRpcEvent[];
    expect(runTurn(unknowns)).toBe(0);
    expect(got).toHaveLength(0);
  });

  it("handles toolcall events nested inside message_update", () => {
    const tc = { type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        name: "Bash",
        toolCallId: "cc",
        arguments: "{\"x\":2}",
      } } as unknown as OmpRpcEvent;
    runTurn([tc, agentEnd()]);
    expect(got).toHaveLength(3);
    const p = partOf(1);
    expect(p.type).toBe("tool");
    expect(p.tool).toBe("Bash");
    expect(p.id).toBe("cc");
    expect(p.state?.status).toBe("pending");
    expect(p.state?.input).toEqual({ x: 2 });
    expect(infoOf(2).finish).toBe("stop");
    expect(done).toBe(1);
  });

  it("only emits contract-approved event types for turn traffic", () => {
    runTurn([
      { type: "agent_start" } as unknown as OmpRpcEvent,
      toolEvent("tool_execution_start",
        { toolCallId: "c3", tool: "Bash" }),
      thinkDelta("hmm"),
      textDelta("ok"),
      agentEnd(),
    ]);
    const allowed = new Set([
      "message.updated",
      "message.part.updated",
      "message.part.delta",
    ]);
    for (const e of got) {
      expect(allowed.has(e.type)).toBe(true);
    }
    expect(got.length).toBeGreaterThan(0);
  });

  it("agent_end with isTerminal: false does not complete the turn", () => {
    const nonTerminalEnd = { type: "agent_end", isTerminal: false } as unknown as OmpRpcEvent;
    runTurn([textDelta("still working..."), nonTerminalEnd]);
    expect(done).toBe(0);
    // Info and part updated were emitted, but no final info with finish:stop
    expect(got.some((e) => e.type === "message.updated" && (e.properties as any).info?.finish === "stop")).toBe(false);

    // Later real terminal end completes the turn
    runTurn([agentEnd()]);
    expect(done).toBe(1);
  });

  it("tool parts emitted during streaming include top-level callID", () => {
    runTurn([
      toolEvent("tool_execution_start", { toolCallId: "call_abc", tool: "readFile" }),
      agentEnd(),
    ]);
    const toolPart = (got.find((e) => e.type === "message.part.updated")?.properties as any)?.part;
    expect(toolPart).toBeDefined();
    expect(toolPart.callID).toBe("call_abc");
  });
});
