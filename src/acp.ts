import type { Subprocess } from "bun";

type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } }
  | { jsonrpc: "2.0"; method: string; params: unknown };
export class AcpConnection {
  #proc: Subprocess;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #nextId = 1;
  #pending = new Map<number, (msg: Record<string, unknown>) => void>();
  #notify: Array<(method: string, params: unknown) => void> = [];
  #buffer = "";

  private constructor(proc: Subprocess, reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#proc = proc;
    this.#reader = reader;
    this.#pump();
  }

  static async spawn(cwd: string): Promise<AcpConnection> {
    const omp = (await Bun.$`which omp`.quiet()).text().trim();
    const proc = Bun.spawn([omp, "--mode", "acp", "--cwd", cwd, "--no-title", "--no-pty"], {
      stdin: "pipe", stdout: "pipe", stderr: "inherit",
      env: { ...Bun.env, PI_NO_TITLE: "1" },
    });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    return new AcpConnection(proc, reader);
  }

  #pump() {
    const decoder = new TextDecoder();
    (async () => {
      for (;;) {
        const { done, value } = await this.#reader.read();
        if (done) break;
        this.#buffer += decoder.decode(value, { stream: true });
        this.#drain();
      }
    })().catch(() => {});
  }

  #drain() {
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.jsonrpc !== "2.0") continue;

      if ("method" in msg && !("id" in msg)) {
        for (const cb of this.#notify) cb(msg.method, msg.params);
      } else if ("id" in msg && typeof msg.id === "number") {
        const resolve = this.#pending.get(msg.id);
        if (resolve) { this.#pending.delete(msg.id); resolve(msg); }
      }
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const stdin = this.#proc.stdin;
    if (stdin == null || typeof stdin === "number") {
      return Promise.reject(new Error("ACP stdin not available"));
    }
    stdin.write(new TextEncoder().encode(payload));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (msg) => {
        if (msg.error) reject(new Error(`ACP ${method}: ${(msg.error as { message: string }).message}`));
        else resolve(msg.result);
      });
      setTimeout(() => { if (this.#pending.has(id)) { this.#pending.delete(id); reject(new Error(`ACP ${method} timeout`)); } }, 30_000);
    });
  }

  onNotification(cb: (method: string, params: unknown) => void) { this.#notify.push(cb); return () => { const i = this.#notify.indexOf(cb); if (i >= 0) this.#notify.splice(i, 1); }; }
  kill() { this.#proc.kill(); }
  get process() { return this.#proc; }
}
