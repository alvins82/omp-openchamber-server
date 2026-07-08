import type { Subprocess } from "bun";

export interface OmpRpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface OmpRpcModel {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: unknown;
  reasoning?: unknown;
  supportsToolCall?: boolean;
  supportsAttachment?: boolean;
  [key: string]: unknown;
}

export interface OpenCodeModel {
  id: string;
  name: string;
  providerID: string;
  limit?: { context?: number; output?: number };
  reasoning?: unknown;
  tool_call?: boolean;
  attachment?: boolean;
  capabilities?: { input?: unknown };
  [key: string]: unknown;
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  models: Record<string, OpenCodeModel>;
}

export interface OpenCodeProvidersResponse {
  providers: OpenCodeProvider[];
  default: { default: string };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
};

export class OmpRpcConnection {
  #proc: Subprocess;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #pending = new Map<string, PendingRequest>();
  #nextId = 1;
  #listeners = new Set<(event: OmpRpcEvent) => void>();
  #buffer = "";
  #ready: { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void };
  #dead = false;

  private constructor(proc: Subprocess, reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#proc = proc;
    this.#reader = reader;
    this.#ready = Promise.withResolvers<void>();
    this.#pump();
  }

  static async spawn(cwd: string): Promise<OmpRpcConnection> {
    const omp = (await Bun.$`which omp`.quiet()).text().trim();
    const proc = Bun.spawn([omp, "--mode", "rpc", "--cwd", cwd, "--no-title", "--no-pty"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...Bun.env, PI_NO_TITLE: "1" },
    });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const conn = new OmpRpcConnection(proc, reader);
    await conn.ensureReady();
    return conn;
  }

  #pump() {
    const decoder = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await this.#reader.read();
          if (done) break;
          this.#buffer += decoder.decode(value, { stream: true });
          this.#drain();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#fail(new Error(`RPC stdout read error: ${message}`));
      } finally {
        this.#dead = true;
        this.#fail(new Error("RPC process closed"));
      }
    })();
  }

  #drain() {
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      this.#handleFrame(frame);
    }
  }

  #handleFrame(frame: Record<string, unknown>) {
    if (frame.type === "ready") {
      this.#ready.resolve();
      return;
    }
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      if (frame.success === false) {
        let message = "unknown error";
        const err = frame.error;
        if (typeof err === "object" && err !== null && "message" in err && typeof err.message === "string") {
          message = err.message;
        } else if (err !== undefined) {
          message = String(err);
        }
        pending.reject(new Error(`RPC ${pending.method}: ${message}`));
      } else {
        pending.resolve(frame.data);
      }
      return;
    }
    if (typeof frame.type === "string") {
      const event = frame as OmpRpcEvent;
      for (const listener of this.#listeners) {
        try {
          listener(event);
        } catch {
          // ignore listener errors
        }
      }
    }
  }

  #fail(err: Error) {
    this.#ready.reject(err);
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(err);
    }
  }

  ensureReady(): Promise<void> {
    return this.#ready.promise;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#dead) {
      return Promise.reject(new Error(`RPC ${method}: connection dead`));
    }
    const id = `rpc_${this.#nextId++}`;
    const body: Record<string, unknown> = { id, type: method };
    if (typeof params === "object" && params !== null && !Array.isArray(params)) {
      Object.assign(body, params);
    }
    const payload = JSON.stringify(body) + "\n";
    const stdin = this.#proc.stdin;
    if (stdin == null || typeof stdin === "number") {
      return Promise.reject(new Error(`RPC ${method}: stdin not available`));
    }
    stdin.write(new TextEncoder().encode(payload));
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#pending.set(id, { resolve, reject, method });
    setTimeout(() => {
      if (this.#pending.has(id)) {
        this.#pending.delete(id);
        reject(new Error(`RPC ${method} timeout`));
      }
    }, 30_000);
    return promise;
  }

  onEvent(handler: (event: OmpRpcEvent) => void): () => void {
    this.#listeners.add(handler);
    return () => {
      this.#listeners.delete(handler);
    };
  }

  switchSession(sessionPath: string): Promise<unknown> {
    return this.request("switch_session", { sessionPath });
  }

  kill() {
    this.#dead = true;
    this.#fail(new Error("RPC killed"));
    try {
      this.#proc.kill();
    } catch {
      // ignore
    }
  }
}

export async function withOmpRpc<T>(cwd: string, fn: (conn: OmpRpcConnection) => Promise<T>): Promise<T> {
  const conn = await OmpRpcConnection.spawn(cwd);
  try {
    return await fn(conn);
  } finally {
    conn.kill();
  }
}

export function mapRpcModelsToOpenCodeProviders(
  models: OmpRpcModel[],
  currentProviderID?: string,
): OpenCodeProvidersResponse {
  const providersById = new Map<string, OpenCodeProvider>();
  for (const model of models) {
    let provider = providersById.get(model.provider);
    if (!provider) {
      provider = { id: model.provider, name: model.provider, models: {} };
      providersById.set(model.provider, provider);
    }
    const entry: OpenCodeModel = {
      id: model.id,
      name: model.name,
      providerID: model.provider,
      limit: undefined,
      reasoning: model.reasoning,
      tool_call: model.supportsToolCall,
      attachment: model.supportsAttachment,
      capabilities: model.input !== undefined ? { input: model.input } : undefined,
    };
    if (model.contextWindow !== undefined || model.maxTokens !== undefined) {
      const l: OpenCodeModel["limit"] = {};
      if (model.contextWindow !== undefined) l.context = model.contextWindow;
      if (model.maxTokens !== undefined) l.output = model.maxTokens;
      entry.limit = l;
    }
    provider.models[model.id] = entry;
  }
  const providers = Array.from(providersById.values());
  const defaultProvider = providers.find((p) => p.id === currentProviderID) ?? providers[0];
  return {
    providers,
    default: { default: defaultProvider?.id ?? "" },
  };
}

export async function getCurrentModel(conn: OmpRpcConnection): Promise<{ providerID?: string; modelID?: string; variant?: string } | undefined> {
  const state = await conn.request("get_state");
  if (!state || typeof state !== "object") return undefined;
  if (!("model" in state)) return undefined;
  const model = state.model;
  if (!model || typeof model !== "object") return undefined;
  return {
    providerID: "provider" in model && typeof model.provider === "string" ? model.provider : undefined,
    modelID: "id" in model && typeof model.id === "string" ? model.id : undefined,
    variant: "variant" in model && typeof model.variant === "string" ? model.variant : undefined,
  };
}
