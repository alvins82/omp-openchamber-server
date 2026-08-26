import { afterEach, describe, expect, test } from "bun:test";
import {
  abortSession,
  getSessionStatusMap,
  isSessionBusy,
  promptSessionAsync,
  resetConnectionFactory,
  shutdownAll,
  setConnectionFactory,
} from "./prompt";
import { subscribeOpenCodeEvents, type OpenCodeEvent } from "./sse";
import type { OmpRpcEvent, OmpRpcTransport } from "./rpc";

/**
 * Fake OMP transport for orchestration tests. Records every RPC and lets the
 * test drive the in-flight `prompt` request and event stream by hand, so the
 * full promptSessionAsync lifecycle (lock, 409, busy→idle, abort, shutdown)
 * is exercised in-process without a real OMP child.
 */
class FakeTransport implements OmpRpcTransport {
  requests: { method: string; params?: unknown }[] = [];
  switchSessionCalls: string[] = [];
  kills = 0;
  abortError: Error | undefined;

  #handler: ((e: OmpRpcEvent) => void) | undefined;
  #prompts: Array<{ resolve: (v?: unknown) => void; reject: (e: Error) => void }> = [];

  async switchSession(sessionPath: string): Promise<void> {
    this.switchSessionCalls.push(sessionPath);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    switch (method) {
      case "get_state":
        return Promise.resolve({ model: { provider: "vllm", id: "qwen3.8-27b", variant: "default" } });
      case "abort":
        return this.abortError ? Promise.reject(this.abortError) : Promise.resolve();
      case "prompt": {
        const s = Promise.withResolvers<unknown>();
        this.#prompts.push(s);
        return s.promise;
      }
      default:
        return Promise.resolve();
    }
  }

  onEvent(handler: (e: OmpRpcEvent) => void): () => void {
    this.#handler = handler;
    return () => {
      this.#handler = undefined;
    };
  }

  kill(): void {
    this.kills += 1;
    // Mimic OmpRpcConnection.kill(): every in-flight request fails.
    for (const p of this.#prompts) p.reject(new Error("RPC killed"));
  }

  fire(event: OmpRpcEvent): void {
    this.#handler?.(event);
  }

  promptSettler(): { resolve: (v?: unknown) => void; reject: (e: Error) => void } | undefined {
    return this.#prompts.at(-1);
  }

  requestCount(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }
}

const created: FakeTransport[] = [];
let seq = 0;

afterEach(() => {
  shutdownAll();
  resetConnectionFactory();
});

function installFakeFactory() {
  setConnectionFactory(async (_cwd, sessionPath) => {
    const t = new FakeTransport();
    created.push(t);
    await t.switchSession(sessionPath);
    return t;
  });
}

function newSession() {
  seq += 1;
  const openCodeId = `sess_${seq}`;
  return {
    openCodeId,
    cwd: `/tmp/fake-cwd-${seq}`,
    sessionPath: `/sessions/sess_${seq}`,
  };
}

function lastTransport(): FakeTransport {
  const t = created.at(-1);
  expect(t).toBeDefined();
  return t!;
}

function captureEvents() {
  // The production envelope keeps `properties` opaque; tests access the
  // known fields through a narrower view.
  const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
  const stop = subscribeOpenCodeEvents((e: OpenCodeEvent) =>
    events.push({ type: e.type, properties: e.properties as Record<string, unknown> }),
  );
  return { events, stop };
}

const info = (e: { properties: Record<string, unknown> }) =>
  e.properties.info as {
    role?: string;
    model?: { id?: string; providerID?: string; modelID?: string; variant?: string };
    finish?: string;
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
    cost?: number;
    time?: { created: number; completed?: number };
  };
const part = (e: { properties: Record<string, unknown> }) =>
  e.properties.part as { type?: string; text?: string; sessionID?: string };

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function waitFor(cond: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await tick();
  }
}

/** Fire agent_end, resolve the in-flight prompt, wait until the session is idle again. */
async function completePrompt(t: FakeTransport, openCodeId: string, cwd: string): Promise<void> {
  t.fire({ type: "agent_end" });
  t.promptSettler()?.resolve();
  await waitFor(() => !isSessionBusy(openCodeId, cwd), 1000);
}

describe("promptSessionAsync orchestration", () => {
  test("rejects invalid bodies with 400 without creating a transport", async () => {
    installFakeFactory();
    const before = created.length;

    const a = await promptSessionAsync("x", "/c", "/s", null);
    expect(a).toEqual({ queued: false, error: "invalid body", status: 400 });

    const b = await promptSessionAsync("y", "/c", "/s", { parts: "not an array" });
    expect(b.status).toBe(400);

    const c = await promptSessionAsync("z", "/c", "/s", { messageID: 42, parts: [{ type: "text", text: "hi" }] });
    expect(c.status).toBe(400);

    expect(created.length).toBe(before);
  });

  test("rejects bodies with no usable text parts with 400", async () => {
    installFakeFactory();
    const before = created.length;

    const a = await promptSessionAsync("a", "/c", "/s", { parts: [] });
    expect(a).toEqual({ queued: false, error: "no text parts", status: 400 });

    const b = await promptSessionAsync("b", "/c", "/s", { parts: [{ type: "text" }, { type: "file", url: "x" }] });
    expect(b.status).toBe(400);

    expect(created.length).toBe(before);
  });

  test("happy path: queued, set_model + prompt, busy→idle, full event stream", async () => {
    installFakeFactory();
    const { openCodeId, cwd, sessionPath } = newSession();
    const { events, stop } = captureEvents();

    const res = await promptSessionAsync(openCodeId, cwd, sessionPath, {
      parts: [{ type: "text", text: "hello" }],
      model: { providerID: "vllm", modelID: "qwen" },
      variant: "thinking",
    });
    expect(res).toEqual({ queued: true });

    const t = lastTransport();
    expect(t.switchSessionCalls).toEqual([sessionPath]);
    expect(isSessionBusy(openCodeId, cwd)).toBe(true);
    expect(getSessionStatusMap()[openCodeId]).toEqual({ type: "busy" });

    await waitFor(() => t.requestCount("prompt") === 1);
    const reqs = t.requests.map((r) => r.method);
    expect(reqs).toEqual(["get_state", "set_model", "prompt"]);
    expect(t.requests[1].params).toEqual({ provider: "vllm", modelId: "qwen" });
    expect(t.requests[2].params).toEqual({ message: "hello" });

    t.fire({ type: "message_update", assistantMessageEvent: { type: "text_delta", text: "Hello from OMP" } });
    t.fire({ type: "message_update", assistantMessageEvent: { type: "text_delta", text: " there" } });
    await completePrompt(t, openCodeId, cwd);
    stop();

    const status = events.filter((e) => e.type === "session.status");
    expect(status).toHaveLength(2);
    expect(status[0].properties).toEqual({ sessionID: openCodeId, status: { type: "busy" } });
    expect(status[1].properties).toEqual({ sessionID: openCodeId, status: { type: "idle" } });

    const updated = events.filter((e) => e.type === "message.updated");
    expect(updated).toHaveLength(2);
    expect(info(updated[0]).model).toEqual({ id: "qwen", providerID: "vllm", modelID: "qwen", variant: "thinking" });
    expect(info(updated[0]).finish).toBeUndefined();
    expect(info(updated[1]).finish).toBe("stop");
    expect(info(updated[1]).time?.completed).toBeTypeOf("number");

    const parts = events.filter((e) => e.type === "message.part.updated");
    expect(parts).toHaveLength(1);
    expect(part(parts[0])).toMatchObject({ type: "text", text: "Hello from OMP", sessionID: openCodeId });

    const deltas = events.filter((e) => e.type === "message.part.delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].properties.delta).toBe(" there");

    expect(events.filter((e) => e.type === "session.idle")).toHaveLength(1);
    expect(t.kills).toBe(0);
  });

  test("second prompt on a busy session returns 409 and reuses the transport", async () => {
    installFakeFactory();
    const { openCodeId, cwd, sessionPath } = newSession();

    const first = await promptSessionAsync(openCodeId, cwd, sessionPath, { parts: [{ type: "text", text: "one" }] });
    expect(first.queued).toBe(true);
    const t = lastTransport();
    const before = created.length;

    const second = await promptSessionAsync(openCodeId, cwd, sessionPath, { parts: [{ type: "text", text: "two" }] });
    expect(second).toEqual({ queued: false, error: "session busy", status: 409 });
    expect(created.length).toBe(before);
    expect(t.requestCount("prompt")).toBe(1);

    await completePrompt(t, openCodeId, cwd);
    expect(isSessionBusy(openCodeId, cwd)).toBe(false);
  });

  test("prompt RPC failure emits an error part and returns the session to idle", async () => {
    installFakeFactory();
    const { openCodeId, cwd, sessionPath } = newSession();
    const { events, stop } = captureEvents();

    const res = await promptSessionAsync(openCodeId, cwd, sessionPath, { parts: [{ type: "text", text: "go" }] });
    expect(res.queued).toBe(true);
    const t = lastTransport();
    await waitFor(() => t.requestCount("prompt") === 1);

    t.promptSettler()?.reject(new Error("model down"));
    await waitFor(() => !isSessionBusy(openCodeId, cwd), 1000);
    stop();

    expect(t.kills).toBe(0);
    const parts = events.filter((e) => e.type === "message.part.updated");
    expect(parts).toHaveLength(1);
    expect(part(parts[0]).text).toBe("Prompt failed: model down");
    expect(events.filter((e) => e.type === "session.error")).toHaveLength(1);
    expect(events.filter((e) => e.type === "session.idle")).toHaveLength(1);
  });

  test("abort sends the RPC, clears busy, and keeps the session for reuse", async () => {
    installFakeFactory();
    const { openCodeId, cwd, sessionPath } = newSession();

    const res = await promptSessionAsync(openCodeId, cwd, sessionPath, { parts: [{ type: "text", text: "go" }] });
    expect(res.queued).toBe(true);
    const t = lastTransport();
    const before = created.length;

    const ok = await abortSession(openCodeId, cwd);
    expect(ok).toBe(true);
    expect(t.requestCount("abort")).toBe(1);
    expect(isSessionBusy(openCodeId, cwd)).toBe(false);
    expect(t.kills).toBe(0);

    // The session is still alive: a new prompt reuses the same transport.
    const again = await promptSessionAsync(openCodeId, cwd, sessionPath, { parts: [{ type: "text", text: "again" }] });
    expect(again.queued).toBe(true);
    expect(created.length).toBe(before);

    // Unknown session abort is a no-op.
    expect(await abortSession("never-seen", cwd)).toBe(false);

    await completePrompt(t, openCodeId, cwd);
  });

  test("failed abort RPC kills the child and drops the session", async () => {
    installFakeFactory();
    const { openCodeId, cwd, sessionPath } = newSession();

    const res = await promptSessionAsync(openCodeId, cwd, sessionPath, { parts: [{ type: "text", text: "go" }] });
    expect(res.queued).toBe(true);
    const t = lastTransport();
    const before = created.length;
    t.abortError = new Error("abort down");

    const ok = await abortSession(openCodeId, cwd);
    expect(ok).toBe(true);
    expect(t.kills).toBe(1);
    expect(isSessionBusy(openCodeId, cwd)).toBe(false);

    // The dead session is replaced: the next prompt spawns a fresh transport.
    const again = await promptSessionAsync(openCodeId, cwd, sessionPath, { parts: [{ type: "text", text: "again" }] });
    expect(again.queued).toBe(true);
    expect(created.length).toBe(before + 1);

    await completePrompt(created.at(-1)!, openCodeId, cwd);
  });

  test("sequential prompts reuse the same transport and report the RPC model", async () => {
    installFakeFactory();
    const { openCodeId, cwd, sessionPath } = newSession();
    const { events, stop } = captureEvents();

    const first = await promptSessionAsync(openCodeId, cwd, sessionPath, { parts: [{ type: "text", text: "one" }] });
    expect(first.queued).toBe(true);
    const t = lastTransport();
    const before = created.length;
    await waitFor(() => t.requestCount("prompt") === 1);
    await completePrompt(t, openCodeId, cwd);

    const second = await promptSessionAsync(openCodeId, cwd, sessionPath, { parts: [{ type: "text", text: "two" }] });
    expect(second.queued).toBe(true);
    expect(created.length).toBe(before);
    await waitFor(() => t.requestCount("prompt") === 2);
    await completePrompt(t, openCodeId, cwd);
    stop();

    // No model in the body: the assistant info carries the model from get_state.
    const updated = events.filter((e) => e.type === "message.updated");
    for (const e of updated) {
      expect(info(e).model).toEqual({
        id: "qwen3.8-27b",
        providerID: "vllm",
        modelID: "qwen3.8-27b",
        variant: "default",
      });
    }
    expect(t.kills).toBe(0);
  });

  test("shutdownAll kills every transport and empties the status map", async () => {
    installFakeFactory();
    const a = newSession();
    const b = newSession();

    const ra = await promptSessionAsync(a.openCodeId, a.cwd, a.sessionPath, { parts: [{ type: "text", text: "a" }] });
    const rb = await promptSessionAsync(b.openCodeId, b.cwd, b.sessionPath, { parts: [{ type: "text", text: "b" }] });
    expect(ra.queued).toBe(true);
    expect(rb.queued).toBe(true);
    expect(Object.keys(getSessionStatusMap())).toHaveLength(2);

    shutdownAll();

    expect(created.at(-2)!.kills).toBe(1);
    expect(created.at(-1)!.kills).toBe(1);
    expect(getSessionStatusMap()).toEqual({});
    expect(isSessionBusy(a.openCodeId, a.cwd)).toBe(false);
    expect(isSessionBusy(b.openCodeId, b.cwd)).toBe(false);
  });

  test("delivers token breakdown and cost when completion event carries usage", async () => {
    installFakeFactory();
    const { openCodeId, cwd, sessionPath } = newSession();
    const { events, stop } = captureEvents();

    const res = await promptSessionAsync(openCodeId, cwd, sessionPath, {
      messageID: "msg_user_token_prompt",
      parts: [{ type: "text", text: "count tokens" }],
    });
    expect(res.queued).toBe(true);

    const t = lastTransport();
    await waitFor(() => t.requestCount("prompt") === 1);

    t.fire({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", text: "Answer with tokens" },
    });

    t.fire({
      type: "agent_end",
      usage: {
        input: 5400,
        output: 120,
        cacheRead: 800,
        cacheWrite: 0,
        reasoning: 25,
        cost: { total: 0.015 },
      },
    });
    t.promptSettler()?.resolve();

    await waitFor(() => !isSessionBusy(openCodeId, cwd), 1000);
    stop();

    const finalizedEvents = events.filter((e) => e.type === "message.updated" && info(e).role === "assistant" && info(e).finish === "stop");
    expect(finalizedEvents.length).toBeGreaterThan(0);
    const lastAsst = info(finalizedEvents.at(-1)!);
    expect(lastAsst.tokens).toEqual({
      input: 5400,
      output: 120,
      reasoning: 25,
      cache: {
        read: 800,
        write: 0,
      },
    });
    expect(lastAsst.cost).toBe(0.015);
  });
});
