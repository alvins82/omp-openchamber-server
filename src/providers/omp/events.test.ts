/**
 * Implementation tests for the OMP event normalizer (providers/omp/events.ts).
 *
 * Each test wires a scripted OmpRpcTransport into createOmpEventNormalizer,
 * feeds raw RPC frames, and asserts on the NormalizedTurnEvent stream (and on
 * extension_ui response frames captured via transport.sendFrame).
 */
import { describe, expect, jest, test } from "bun:test";
import type { ModelRef, NormalizedTurnEvent } from "../types";
import type { OmpRpcEvent, OmpRpcTransport } from "./rpc";
import {
  DEFAULT_NON_TERMINAL_GRACE_MS,
  OMP_DEFAULT_MODEL,
  createOmpEventNormalizer,
  isRpcEventFrame,
  reduceToolPartState,
  type OmpEventNormalizer,
} from "./events";
import { toOpenCodeSessionId } from "./store";

class ScriptedTransport implements OmpRpcTransport {
  #handler: ((event: OmpRpcEvent) => void) | undefined;
  state: unknown = {};
  sentFrames: Record<string, unknown>[] = [];

  request(_method: string, _params?: unknown): Promise<unknown> {
    return Promise.resolve(this.state);
  }

  switchSession(): Promise<unknown> {
    return Promise.resolve();
  }

  onEvent(handler: (event: OmpRpcEvent) => void): () => void {
    this.#handler = handler;
    return () => {
      this.#handler = undefined;
    };
  }

  sendFrame(frame: unknown): void {
    this.sentFrames.push(frame as Record<string, unknown>);
  }

  kill(): void {}

  feed(event: OmpRpcEvent): void {
    this.#handler?.(event);
  }
}

interface Harness {
  transport: ScriptedTransport;
  normalizer: OmpEventNormalizer;
  events: NormalizedTurnEvent[];
  feed(event: OmpRpcEvent): void;
}

const SES = "ses_omp_test0000000000000000000000000000000000000000000000000000";

function createHarness(opts?: { initialModel?: ModelRef }): Harness {
  const transport = new ScriptedTransport();
  const normalizer = createOmpEventNormalizer({
    transport,
    openCodeId: SES,
    cwd: "/tmp/omp-events-test",
    nonTerminalGraceMs: 10,
    ...(opts?.initialModel ? { initialModel: opts.initialModel } : {}),
  });
  const events: NormalizedTurnEvent[] = [];
  normalizer.subscribe((event) => events.push(event));
  return {
    transport,
    normalizer,
    events,
    feed: (event: OmpRpcEvent) => transport.feed(event),
  };
}

function kinds(events: NormalizedTurnEvent[]): string[] {
  return events.map((e) => e.kind);
}

const USAGE_A = { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } };

describe("isRpcEventFrame", () => {
  test("recognizes raw turn/tool/message frames", () => {
    expect(isRpcEventFrame({ type: "message_update" })).toBe(true);
    expect(isRpcEventFrame({ type: "agent_end" })).toBe(true);
    expect(isRpcEventFrame({ type: "custom", customType: "tool_execution_start" })).toBe(true);
    expect(isRpcEventFrame({ type: "extension_ui_request", id: "x" })).toBe(false);
    expect(isRpcEventFrame({})).toBe(false);
  });
});

describe("usage aggregation", () => {
  test("emits usage snapshot when tokens or cost change", () => {
    const h = createHarness();
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", text: "hi" },
      usage: { input: 10, output: 5, cache_read: 2 },
      cost: 0.01,
    } as unknown as OmpRpcEvent);

    const usage = h.events.filter((e) => e.kind === "usage");
    expect(usage.length).toBe(1);
    if (usage[0].kind !== "usage") return;
    expect(usage[0].tokens).toEqual(USAGE_A);
    expect(usage[0].cost).toBeCloseTo(0.01, 10);
  });

  test("all-zero token usage does not replace tokens but positive cost accumulates", () => {
    const h = createHarness();
    h.feed({ type: "agent_start", usage: { input: 10, output: 5, cache_read: 2 }, cost: 0.01 } as unknown as OmpRpcEvent);
    h.feed({ type: "agent_start", usage: { input: 0, output: 0 }, cost: 0.02 } as unknown as OmpRpcEvent);

    const usage = h.events.filter((e) => e.kind === "usage");
    expect(usage.length).toBe(2);
    if (usage[0].kind !== "usage" || usage[1].kind !== "usage") return;
    expect(usage[1].tokens).toEqual(USAGE_A); // gated: zeros never overwrite
    expect(usage[1].cost).toBeCloseTo(0.03, 10); // accumulates when > 0
  });

  test("positive usage replaces the whole token snapshot", () => {
    const h = createHarness();
    h.feed({ type: "agent_start", usage: { input: 10, output: 5 } } as unknown as OmpRpcEvent);
    h.feed({ type: "agent_start", usage: { input: 20 } } as unknown as OmpRpcEvent);

    const usage = h.events.filter((e) => e.kind === "usage");
    expect(usage.length).toBe(2);
    if (usage[1].kind !== "usage") return;
    expect(usage[1].tokens.input).toBe(20);
    expect(usage[1].tokens.output).toBe(0); // wholesale replacement, not merge
  });
});

describe("model sync", () => {
  test("adopts provider/model announcements and dedupes repeats", () => {
    const h = createHarness();
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", text: "x" },
      message: { provider: "vllm", model: "qwen3" },
    } as unknown as OmpRpcEvent);
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", text: "y" },
      message: { provider: "vllm", model: "qwen3" },
    } as unknown as OmpRpcEvent);

    const models = h.events.filter((e) => e.kind === "model");
    expect(models.length).toBe(1);
    if (models[0].kind !== "model") return;
    expect(models[0].model).toEqual({ providerID: "vllm", modelID: "qwen3", variant: "default" });
  });
});

describe("terminal turn_end", () => {
  test("agent_end finalizes immediately with no error", () => {
    const h = createHarness();
    h.feed({ type: "agent_end", stopReason: "end_turn" } as unknown as OmpRpcEvent);
    expect(kinds(h.events)).toEqual(["turn_end"]);
    if (h.events[0].kind !== "turn_end") return;
    expect(h.events[0].error).toBeUndefined();
    expect(h.events[0].stopReason).toBe("end_turn");
  });

  test("prompt_result without agent invocation finalizes immediately", () => {
    const h = createHarness();
    h.feed({ type: "prompt_result", agentInvoked: false } as unknown as OmpRpcEvent);
    expect(kinds(h.events)).toEqual(["turn_end"]);
  });

  test("provider error surfaces as turn_end error", () => {
    const h = createHarness();
    h.feed({
      type: "agent_end",
      stopReason: "error",
      errorMessage: "boom",
    } as unknown as OmpRpcEvent);
    expect(kinds(h.events)).toEqual(["turn_end"]);
    if (h.events[0].kind !== "turn_end") return;
    expect(h.events[0].error).toBe("boom");
    expect(h.events[0].stopReason).toBe("error");
  });
});

describe("non-terminal grace window", () => {
  test("finalizes after the grace window when no frame arrives", () => {
    jest.useFakeTimers();
    try {
      const h = createHarness();
      h.feed({ type: "agent_end", isTerminal: false, stopReason: "toolUse" } as unknown as OmpRpcEvent);
      expect(kinds(h.events)).toEqual([]); // held open
      jest.advanceTimersByTime(20); // harness grace is 10ms
      expect(kinds(h.events)).toEqual(["turn_end"]);
      if (h.events[0].kind !== "turn_end") return;
      expect(h.events[0].stopReason).toBe("toolUse");
      expect(h.events[0].error).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test("an intervening frame cancels the pending finalization", () => {
    jest.useFakeTimers();
    try {
      const h = createHarness();
      h.feed({ type: "agent_end", isTerminal: false } as unknown as OmpRpcEvent);
      h.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", text: "more" } } as unknown as OmpRpcEvent);
      jest.advanceTimersByTime(20);
      expect(kinds(h.events)).toEqual(["text_delta"]); // timer cleared, turn still open
      h.feed({ type: "agent_end" } as unknown as OmpRpcEvent);
      expect(kinds(h.events)).toEqual(["text_delta", "turn_end"]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("extension_ui respond closures", () => {
  test("confirm request emits permission_request and forwards response", () => {
    const h = createHarness();
    h.feed({
      type: "extension_ui_request",
      id: "perm1",
      method: "confirm",
      title: "Bash",
      message: "run ls?",
    } as unknown as OmpRpcEvent);

    expect(kinds(h.events)).toEqual(["permission_request"]);
    const req = h.events[0];
    if (req.kind !== "permission_request") return;
    expect(req.id).toBe("perm1");
    expect(req.permission).toBe("Bash");
    expect(req.metadata.message).toBe("run ls?");

    req.respond({ confirmed: true });
    expect(h.transport.sentFrames).toEqual([
      { type: "extension_ui_response", id: "perm1", confirmed: true },
    ]);

    req.respond({ cancelled: true });
    expect(h.transport.sentFrames[1]).toEqual({
      type: "extension_ui_response",
      id: "perm1",
      cancelled: true,
    });
  });

  test("select request emits question_request with mapped options", () => {
    const h = createHarness();
    h.feed({
      type: "extension_ui_request",
      id: "q1",
      method: "select",
      title: "Pick",
      message: "Which one?",
      options: ["a", "b"],
    } as unknown as OmpRpcEvent);

    expect(kinds(h.events)).toEqual(["question_request"]);
    const req = h.events[0];
    if (req.kind !== "question_request") return;
    expect(req.id).toBe("q1");
    expect(req.questions[0]).toEqual({
      question: "Which one?",
      header: "Pick",
      options: [
        { label: "a", description: "" },
        { label: "b", description: "" },
      ],
      multiple: false,
      custom: false,
    });

    req.respond({ value: "a" });
    expect(h.transport.sentFrames).toEqual([
      { type: "extension_ui_response", id: "q1", value: "a" },
    ]);
  });
});

describe("tool execution reduction", () => {
  test("custom tool_execution frames drive tool state transitions", () => {
    const h = createHarness();
    h.feed({
      type: "custom",
      customType: "tool_execution_start",
      data: { toolCallId: "c1", tool: "bash", arguments: { command: "ls" } },
    } as unknown as OmpRpcEvent);
    h.feed({
      type: "custom",
      customType: "tool_execution_end",
      data: { toolCallId: "c1", output: "file.txt" },
    } as unknown as OmpRpcEvent);

    const tools = h.events.filter((e) => e.kind === "tool");
    expect(tools.length).toBe(2);
    if (tools[0].kind !== "tool" || tools[1].kind !== "tool") return;
    expect(tools[0].callID).toBe("c1");
    expect(tools[0].tool).toBe("bash");
    expect(tools[0].state.status).toBe("running");
    expect(tools[1].state.status).toBe("completed");
    expect(tools[1].state.output).toBe("file.txt");
  });

  test("tool_execution_end with error yields error state", () => {
    const h = createHarness();
    h.feed({
      type: "tool_execution_start",
      payload: { toolCallId: "c2", tool: "bash" },
    } as unknown as OmpRpcEvent);
    h.feed({
      type: "tool_execution_end",
      payload: { toolCallId: "c2", error: "exit 1" },
    } as unknown as OmpRpcEvent);

    const tools = h.events.filter((e) => e.kind === "tool");
    expect(tools.length).toBe(2);
    if (tools[1].kind !== "tool") return;
    expect(tools[1].state.status).toBe("error");
  });
});

describe("todo extraction", () => {
  const TODO_DETAILS = {
    phases: [{ tasks: [{ id: "t1", content: "Step one", status: "completed", priority: "high" }] }],
  };

  test("tool_execution_end with todo details emits todo event", () => {
    const h = createHarness();
    h.feed({
      type: "tool_execution_end",
      payload: { toolCallId: "c3", tool: "todo", details: TODO_DETAILS },
    } as unknown as OmpRpcEvent);

    expect(h.events.some((e) => e.kind === "todo")).toBe(true);
    const todo = h.events.find((e) => e.kind === "todo");
    if (todo?.kind !== "todo") return;
    expect(todo.todos).toEqual([
      { id: "t1", content: "Step one", status: "completed", priority: "high" },
    ]);
  });

  test("falls back to transport get_state when details are missing", async () => {
    const h = createHarness();
    h.transport.state = {
      todoPhases: [{ tasks: [{ content: "Fallback task", status: "pending" }] }],
    };
    h.feed({
      type: "tool_execution_end",
      payload: { toolCallId: "c4", tool: "todowrite" },
    } as unknown as OmpRpcEvent);
    // The get_state fallback resolves through promise microtasks; flush them.
    await Promise.resolve();
    await Promise.resolve();

    const todo = h.events.find((e) => e.kind === "todo");
    expect(todo).toBeDefined();
    if (todo?.kind !== "todo") return;
    expect(todo.todos).toEqual([
      { id: "todo_0_0", content: "Fallback task", status: "pending", priority: "normal" },
    ]);
  });
});

describe("subagent mapping", () => {
  test("lifecycle started/ended map to subagent events", () => {
    const h = createHarness();
    h.feed({
      type: "subagent_lifecycle",
      payload: { id: "child-1", status: "started", agent: "explore", description: "Scout the repo" },
    } as unknown as OmpRpcEvent);
    h.feed({
      type: "subagent_lifecycle",
      payload: { id: "child-1", status: "completed" },
    } as unknown as OmpRpcEvent);

    expect(kinds(h.events)).toEqual(["subagent_started", "subagent_ended"]);
    const started = h.events[0];
    if (started.kind !== "subagent_started") return;
    expect(started.childId).toBe(toOpenCodeSessionId("child-1"));
    expect(started.agent).toBe("explore");
    expect(started.description).toBe("Scout the repo");
  });

  test("progress frames map to busy/idle status", () => {
    const h = createHarness();
    h.feed({
      type: "subagent_progress",
      payload: { progress: { id: "child-2", status: "running" } },
    } as unknown as OmpRpcEvent);
    h.feed({
      type: "subagent_progress",
      payload: { progress: { id: "child-2", status: "completed" } },
    } as unknown as OmpRpcEvent);

    expect(kinds(h.events)).toEqual(["subagent_status", "subagent_status"]);
    if (h.events[0].kind !== "subagent_status" || h.events[1].kind !== "subagent_status") return;
    expect(h.events[0].status).toBe("busy");
    expect(h.events[1].status).toBe("idle");
  });
});

describe("delta passthrough", () => {
  test("text_delta and thinking_delta map 1:1", () => {
    const h = createHarness();
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", text: "hello" },
    } as unknown as OmpRpcEvent);
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", text: "hmm" },
    } as unknown as OmpRpcEvent);

    expect(kinds(h.events)).toEqual(["text_delta", "reasoning_delta"]);
    if (h.events[0].kind !== "text_delta" || h.events[1].kind !== "reasoning_delta") return;
    expect(h.events[0].text).toBe("hello");
    expect(h.events[1].text).toBe("hmm");
  });
});

describe("subscribe lifecycle", () => {
  test("events between turns are dropped until a sink is reinstalled", () => {
    const h = createHarness();
    h.normalizer.subscribe(() => {})(); // replace, then detach the original sink
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", text: "orphan" },
    } as unknown as OmpRpcEvent);
    expect(h.events).toEqual([]);
  });

  test("model mirror survives resubscribe; usage resets per turn", () => {
    const h = createHarness();
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", text: "x" },
      message: { provider: "vllm", model: "qwen3" },
      usage: { input: 7, output: 3 },
    } as unknown as OmpRpcEvent);
    h.normalizer.subscribe(() => {})(); // per-turn reset

    const seen: NormalizedTurnEvent[] = [];
    h.normalizer.subscribe((e) => seen.push(e));
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", text: "y" },
      message: { provider: "vllm", model: "qwen3" }, // unchanged → no model event
    } as unknown as OmpRpcEvent);
    h.feed({ type: "agent_end" } as unknown as OmpRpcEvent);

    expect(kinds(seen)).toEqual(["text_delta", "turn_end"]); // no model event
  });
});

describe("constants", () => {
  test("exported defaults", () => {
    expect(DEFAULT_NON_TERMINAL_GRACE_MS).toBe(1500);
    expect(OMP_DEFAULT_MODEL).toEqual({ providerID: "omp", modelID: "omp", variant: "default" });
  });
});

describe("reduceToolPartState", () => {
  test("pending -> running -> completed transitions", () => {
    const start = reduceToolPartState(undefined, { type: "tool_execution_start" }, 1, "bash");
    expect(start.status).toBe("running");
    expect(start.time?.start).toBe(1);

    const end = reduceToolPartState(start, { type: "tool_execution_end", output: "ok" }, 2, "bash");
    expect(end.status).toBe("completed");
    expect(end.time?.end).toBe(2);
    expect(end.output).toBe("ok");
  });

  test("terminal states ignore late updates", () => {
    const done = reduceToolPartState(undefined, { type: "tool_execution_end" }, 1, "bash");
    const after = reduceToolPartState(done, { type: "tool_execution_update", output: "late" }, 2, "bash");
    expect(after.status).toBe("completed");
    expect(after.output).toBeUndefined();
  });
});
