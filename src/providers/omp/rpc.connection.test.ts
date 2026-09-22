import { describe, expect, test } from "bun:test";
import { OmpRpcConnection, type OmpRpcChild, type OmpRpcEvent } from "./rpc";

/**
 * In-process fake of the OMP child process. `OmpRpcConnection.fromChild`
 * accepts anything structurally matching OmpRpcChild, so the NDJSON transport
 * (framing, correlation, timeouts, death) is exercised deterministically
 * without spawning a real process.
 */
function makeChild(opts: { stdin?: OmpRpcChild["stdin"]; pid?: number } = {}): {
  child: OmpRpcChild;
  written: string[];
  kills: () => number;
} {
  const written: string[] = [];
  let kills = 0;
  const child: OmpRpcChild = {
    pid: opts.pid ?? 0,
    stdin:
      opts.stdin !== undefined
        ? opts.stdin
        : {
            write(data: unknown) {
              written.push(new TextDecoder().decode(data as Uint8Array));
            },
          },
    kill() {
      kills += 1;
    },
  };
  return { child, written, kills: () => kills };
}

/** Controllable stdout stream: push whole frames, raw chunk fragments, or terminate. */
function makeStdout(): {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  send: (frame: object) => void;
  push: (text: string) => void;
  close: () => void;
  error: (err: Error) => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const reader = stream.getReader();
  return {
    reader,
    send: (frame) => controller.enqueue(enc.encode(JSON.stringify(frame) + "\n")),
    push: (text) => controller.enqueue(enc.encode(text)),
    close: () => controller.close(),
    error: (err) => controller.error(err),
  };
}

function open(
  s: ReturnType<typeof makeStdout>,
  opts: { child?: OmpRpcChild; requestTimeoutMs?: number } = {},
): OmpRpcConnection {
  return OmpRpcConnection.fromChild(opts.child ?? makeChild().child, s.reader, {
    requestTimeoutMs: opts.requestTimeoutMs,
  });
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("OmpRpcConnection (in-process transport)", () => {
  test("correlates request and response by id and resolves with data", async () => {
    const s = makeStdout();
    const { child, written } = makeChild();
    const conn = open(s, { child });

    const p = conn.request("get_state");
    // The request frame is written synchronously before the promise is returned.
    expect(written).toHaveLength(1);
    const body = JSON.parse(written[0]);
    expect(body).toEqual({ id: "rpc_1", type: "get_state" });

    s.send({ id: "rpc_1", type: "response", success: true, data: { ok: 42 } });
    await expect(p).resolves.toEqual({ ok: 42 });

    // Ids increment per request; an explicit null data value is preserved,
    // while a missing data field resolves to undefined.
    const q = conn.request("get_state");
    expect(JSON.parse(written[1]).id).toBe("rpc_2");
    s.send({ id: "rpc_2", type: "response", success: true, data: null });
    await expect(q).resolves.toBeNull();
    const r = conn.request("get_state");
    s.send({ id: "rpc_3", type: "response", success: true });
    await expect(r).resolves.toBeUndefined();
  });

  test("merges object params into the request frame but not arrays", () => {
    const s = makeStdout();
    const { child, written } = makeChild();
    const conn = open(s, { child });

    conn.request("set_model", { providerID: "vllm", modelID: "qwen" });
    expect(JSON.parse(written[0])).toEqual({
      id: "rpc_1",
      type: "set_model",
      providerID: "vllm",
      modelID: "qwen",
    });

    conn.request("list_sessions", ["a", "b"]);
    expect(JSON.parse(written[1])).toEqual({ id: "rpc_2", type: "list_sessions" });
  });

  test("switchSession sends switch_session with sessionPath", async () => {
    const s = makeStdout();
    const { child, written } = makeChild();
    const conn = open(s, { child });

    const p = conn.switchSession("/sessions/abc");
    expect(JSON.parse(written[0])).toEqual({
      id: "rpc_1",
      type: "switch_session",
      sessionPath: "/sessions/abc",
    });
    s.send({ id: "rpc_1", type: "response", success: true });
    await expect(p).resolves.toBeUndefined();
  });

  test("rejects with the server error message when success is false", async () => {
    const s = makeStdout();
    const conn = open(s);

    const p = conn.request("prompt");
    s.send({ id: "rpc_1", type: "response", success: false, error: { message: "boom" } });
    await expect(p).rejects.toThrow("RPC prompt: boom");

    const p2 = conn.request("prompt");
    s.send({ id: "rpc_2", type: "response", success: false, error: "plain string" });
    await expect(p2).rejects.toThrow("RPC prompt: plain string");

    const p3 = conn.request("prompt");
    s.send({ id: "rpc_3", type: "response", success: false });
    await expect(p3).rejects.toThrow("RPC prompt: unknown error");
  });

  test("ignores responses for unknown or already-consumed ids", async () => {
    const s = makeStdout();
    const conn = open(s);
    const events: OmpRpcEvent[] = [];
    conn.onEvent((e) => events.push(e));

    // No pending request: the id is unknown → dropped, never treated as an event.
    s.send({ id: "rpc_999", type: "response", success: true, data: 1 });
    await settle();
    expect(events).toHaveLength(0);

    // A response for an id that already settled is dropped the same way.
    const p = conn.request("get_state");
    s.send({ id: "rpc_1", type: "response", success: true, data: "first" });
    await expect(p).resolves.toBe("first");
    s.send({ id: "rpc_1", type: "response", success: true, data: "late" });
    await settle();
    expect(events).toHaveLength(0);

    // Non-string id on a response frame: dropped, and never treated as an event.
    s.push(JSON.stringify({ type: "response", id: 42, success: true }) + "\n");
    await settle();
    expect(events).toHaveLength(0);
  });

  test("delivers event frames to listeners and supports unsubscribe", async () => {
    const s = makeStdout();
    const conn = open(s);
    const a: OmpRpcEvent[] = [];
    const b: OmpRpcEvent[] = [];
    const unsubA = conn.onEvent((e) => a.push(e));
    conn.onEvent((e) => b.push(e));

    s.send({ type: "session_update", sessionId: "s1", part: { text: "hi" } });
    await settle();
    expect(a).toEqual([{ type: "session_update", sessionId: "s1", part: { text: "hi" } }]);
    expect(b).toEqual(a);

    unsubA();
    s.send({ type: "session_update", sessionId: "s1", part: { text: "again" } });
    await settle();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  test("swallows listener exceptions without breaking other listeners", async () => {
    const s = makeStdout();
    const conn = open(s);
    const got: OmpRpcEvent[] = [];
    conn.onEvent(() => {
      throw new Error("listener exploded");
    });
    conn.onEvent((e) => got.push(e));

    s.send({ type: "some_event", n: 1 });
    await settle();
    expect(got).toEqual([{ type: "some_event", n: 1 }]);
  });

  test("resolves ensureReady on the ready frame and stays idempotent", async () => {
    const s = makeStdout();
    const conn = open(s);
    const first = conn.ensureReady();
    const second = conn.ensureReady();
    expect(first).toBe(second);

    s.send({ type: "ready" });
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  test("reaps pending requests as 'RPC process closed' when stdout ends", async () => {
    const s = makeStdout();
    const conn = open(s);
    const p = conn.request("get_state");
    s.close();
    await expect(p).rejects.toThrow("RPC process closed");
    // The connection is now dead: new requests reject immediately without writing.
    await expect(conn.request("get_state")).rejects.toThrow("RPC get_state: connection dead");
  });

  test("reaps pending requests with the read error message when stdout errors", async () => {
    const s = makeStdout();
    const conn = open(s);
    const p = conn.request("get_state");
    s.error(new Error("io broken"));
    await expect(p).rejects.toThrow("RPC stdout read error: io broken");
    await expect(conn.request("get_state")).rejects.toThrow("connection dead");
  });

  test("reassembles frames split across chunks", async () => {
    const s = makeStdout();
    const { child } = makeChild();
    const conn = open(s, { child });

    const p = conn.request("get_state");
    const full = JSON.stringify({ id: "rpc_1", type: "response", success: true, data: "ok" });
    s.push(full.slice(0, 9));
    await settle();
    s.push(full.slice(9, 20));
    await settle();
    s.push(full.slice(20) + "\n");
    await expect(p).resolves.toBe("ok");
  });

  test("skips invalid JSON lines without losing the next frame", async () => {
    const s = makeStdout();
    const conn = open(s);
    const p = conn.request("get_state");
    s.push("this is not json\n");
    s.send({ id: "rpc_1", type: "response", success: true, data: "fine" });
    await expect(p).resolves.toBe("fine");
  });

  test("rejects with 'stdin not available' when the child has no writable stdin", async () => {
    const s = makeStdout();
    const nullStdin = open(s, { child: makeChild({ stdin: null }).child });
    await expect(nullStdin.request("get_state")).rejects.toThrow("stdin not available");

    const fdStdin = open(makeStdout(), { child: makeChild({ stdin: 7 }).child });
    await expect(fdStdin.request("get_state")).rejects.toThrow("stdin not available");
  });

  test("times out hung requests with the configured timeout and stays usable", async () => {
    const s = makeStdout();
    const conn = open(s, { requestTimeoutMs: 25 });
    const p = conn.request("get_state");
    await expect(p).rejects.toThrow("RPC get_state timeout");

    // A late response for the timed-out id is ignored, not a crash.
    s.send({ id: "rpc_1", type: "response", success: true, data: "late" });
    await settle();

    // The connection is still alive for subsequent requests.
    const p2 = conn.request("get_state");
    s.send({ id: "rpc_2", type: "response", success: true, data: "alive" });
    await expect(p2).resolves.toBe("alive");
  });

  test("kill() fails pending requests, is idempotent, and kills the child", async () => {
    const s = makeStdout();
    const { child, kills } = makeChild();
    const conn = open(s, { child });
    const p = conn.request("get_state");
    conn.kill();
    await expect(p).rejects.toThrow("RPC killed");
    expect(kills()).toBe(1);
    conn.kill();
    expect(kills()).toBe(2);
    await expect(conn.request("get_state")).rejects.toThrow("connection dead");
  });
});
