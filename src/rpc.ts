import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The embedded RPC instance must start deterministically. Project-level MCP
// servers discovered from the target cwd (e.g. a flaky LSP server) otherwise
// gate OMP's `ready` frame and can stall startup for minutes; the sidecar
// exposes no MCP surface of its own (/mcp returns []), so they are pure
// overhead for the embedded instance.
export function embeddedOmpConfigOverlay(): string {
  const dir = join(tmpdir(), "oc-omp-embedded");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.yml");
  const extensionsDir = join(import.meta.dir, "..", "extensions");
  const extensionPaths: string[] = [];
  if (existsSync(extensionsDir)) {
    const extFiles = ["question.ts", "openchamber_web.ts"];
    for (const f of extFiles) {
      const p = join(extensionsDir, f);
      if (existsSync(p)) extensionPaths.push(p);
    }
  }
  const extensionsYaml =
    extensionPaths.length > 0
      ? `\nextensions:\n${extensionPaths.map((p) => `  - ${JSON.stringify(p)}`).join("\n")}\n`
      : "";
  writeFileSync(
    file,
    `mcp:
  enableProjectConfig: false
edit:
  autoRepair:
    enabled: true
browser:
  enabled: false
  relay: false${extensionsYaml}`,
  );
  return file;
}

function withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface OmpRpcEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Minimal surface of the OMP child process that OmpRpcConnection needs. The
 * real `Subprocess` satisfies this; unit tests can supply a fake to drive the
 * NDJSON transport deterministically in-process (no real process spawned).
 */
export interface OmpRpcChild {
  readonly pid: number;
  readonly stdin: { write(data: unknown): void } | number | null | undefined;
  kill(): void | boolean;
}

/** Anything able to carry one OMP RPC session: the real connection, or a fake. */
export interface OmpRpcTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  onEvent(handler: (event: OmpRpcEvent) => void): () => void;
  switchSession(sessionPath: string): Promise<unknown>;
  kill(): void;
  sendFrame?(frame: unknown): void;
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
  capabilities?: {
    input?: unknown;
    output?: unknown;
    toolcall?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    temperature?: boolean;
    [key: string]: unknown;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  variants?: Record<string, unknown>;
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
  #proc: OmpRpcChild;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #detached: boolean;
  #requestTimeoutMs: number;
  #pending = new Map<string, PendingRequest>();
  #nextId = 1;
  #listeners = new Set<(event: OmpRpcEvent) => void>();
  #buffer = "";
  #ready: { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void };
  #dead = false;

  static readonly #activeConnections = new Set<OmpRpcConnection>();

  static killAll(): void {
    for (const conn of OmpRpcConnection.#activeConnections) {
      try {
        conn.kill();
      } catch {
        /* ignore */
      }
    }
    OmpRpcConnection.#activeConnections.clear();
  }

  private constructor(
    proc: OmpRpcChild,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    detached: boolean,
    requestTimeoutMs: number = OmpRpcConnection.REQUEST_TIMEOUT_MS,
  ) {
    this.#proc = proc;
    this.#reader = reader;
    this.#detached = detached;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#ready = Promise.withResolvers<void>();
    // `ready` may never arrive (flaky subsystems can withhold it); a later
    // rejection of the already-abandoned promise must not crash the process.
    this.#ready.promise.catch(() => {});
    OmpRpcConnection.#activeConnections.add(this);
    this.#pump();
  }

  static readonly READY_TIMEOUT_MS = 30_000;
  static readonly REQUEST_TIMEOUT_MS = 30_000;

  /**
   * Build a connection over a caller-provided child and stdout reader,
   * bypassing process spawn. Lets unit tests drive the NDJSON transport
   * (framing, request/response correlation, timeouts, death) deterministically
   * in-process without a real OMP child.
   */
  static fromChild(
    child: OmpRpcChild,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    opts: { detached?: boolean; requestTimeoutMs?: number } = {},
  ): OmpRpcConnection {
    return new OmpRpcConnection(
      child,
      reader,
      opts.detached ?? false,
      opts.requestTimeoutMs ?? OmpRpcConnection.REQUEST_TIMEOUT_MS,
    );
  }

  static async spawn(cwd: string, maxAttempts = 3): Promise<OmpRpcConnection> {
    // OMP_BIN (absolute path) overrides `which omp`; used by the test suite to
    // point the sidecar at a mock OMP child speaking the same NDJSON RPC.
    const envBin = Bun.env.OMP_BIN;
    const omp =
      envBin !== undefined && envBin !== ""
        ? envBin
        : (await Bun.$`which omp`.quiet()).text().trim();
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // detached: the child leads its own process group so kill() can take
      // down MCP/LSP grandchildren instead of orphaning them.
      const extensionsDir = join(import.meta.dir, "..", "extensions");
      const extArgs: string[] = [];
      if (existsSync(extensionsDir)) {
        for (const f of ["question.ts", "openchamber_web.ts"]) {
          const p = join(extensionsDir, f);
          if (existsSync(p)) {
            extArgs.push("--extension", p);
          }
        }
      }
      const proc = Bun.spawn(
        [omp, "--mode", "rpc", "--cwd", cwd, "--no-title", "--no-pty", "--config", embeddedOmpConfigOverlay(), ...extArgs],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
          detached: true,
          env: { ...Bun.env, PI_NO_TITLE: "1", PI_SKIP_VERSION_CHECK: "1" },
        },
      );
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const conn = new OmpRpcConnection(proc, reader, true);
      try {
        // Readiness is proven by the first real RPC response, not the
        // `ready` frame: OMP processes pre-`ready` frames in order, but
        // `ready` itself can be withheld by flaky subsystems (MCP servers,
        // update checks). Whichever arrives first proves the loop is live.
        const probe = conn.request("get_state");
        probe.catch(() => {});
        const probeSettled = new Promise<void>((resolve) => {
          probe.then(
            () => resolve(),
            () => resolve(),
          );
        });
        await withTimeout(
          Promise.race([probeSettled, conn.ensureReady()]),
          OmpRpcConnection.READY_TIMEOUT_MS,
          `OMP not responsive after ${OmpRpcConnection.READY_TIMEOUT_MS / 1000}s (attempt ${attempt}/${maxAttempts})`,
        );
        await conn.request("set_subagent_subscription", { level: "events" }).catch(() => {});
        return conn;
      } catch (err) {
        lastError = err;
        conn.kill();
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`OMP spawn failed: ${String(lastError)}`);
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
    if (frame.type === "response") {
      if (typeof frame.id === "string") {
        const pending = this.#pending.get(frame.id);
        if (pending) {
          this.#pending.delete(frame.id);
          if (frame.success === false) {
            let message = "unknown error";
            const err = frame.error;
            if (
              typeof err === "object" &&
              err !== null &&
              "message" in err &&
              typeof err.message === "string"
            ) {
              message = err.message;
            } else if (err !== undefined) {
              message = String(err);
            }
            pending.reject(new Error(`RPC ${pending.method}: ${message}`));
          } else {
            pending.resolve(frame.data);
          }
        }
      }
      // Response frames (even malformed ones with a non-string id) never
      // surface as events.
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      if (timer !== undefined) clearTimeout(timer);
      settle();
    };
    timer = setTimeout(() => {
      if (this.#pending.has(id)) {
        this.#pending.delete(id);
        finish(() => reject(new Error(`RPC ${method} timeout`)));
      }
    }, this.#requestTimeoutMs);
    this.#pending.set(id, {
      resolve: (value) => finish(() => resolve(value)),
      reject: (err) => finish(() => reject(err)),
      method,
    });
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

  sendFrame(frame: unknown): void {
    if (this.#dead) return;
    const payload = JSON.stringify(frame) + "\n";
    const stdin = this.#proc.stdin;
    if (stdin == null || typeof stdin === "number") return;
    stdin.write(new TextEncoder().encode(payload));
  }

  kill() {
    OmpRpcConnection.#activeConnections.delete(this);
    this.#dead = true;
    this.#fail(new Error("RPC killed"));
    const pid = this.#proc.pid;
    if (this.#detached && pid > 0) {
      try {
        // Whole process group: MCP/LSP grandchild processes die with OMP
        // instead of being orphaned (orphans have been observed holding
        // shared state that wedges later startups).
        process.kill(-pid, "SIGTERM");
        return;
      } catch {
        // group already gone; fall through
      }
    }
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

const defaultThinkingVariants: Record<string, unknown> = {
  none: {},
  low: {},
  medium: {},
  high: {},
  xhigh: {},
};

export function parseModelInputCapabilities(input: unknown): {
  capabilitiesInput: unknown;
  modalitiesInput?: string[];
} {
  if (input === undefined) {
    return {
      capabilitiesInput: undefined,
      modalitiesInput: undefined,
    };
  }

  if (Array.isArray(input)) {
    const modalities = input
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.toLowerCase());
    const hasText = modalities.includes("text") || modalities.length === 0;
    const hasImage = modalities.includes("image");
    const hasAudio = modalities.includes("audio");
    const hasVideo = modalities.includes("video");
    const hasPdf = modalities.includes("pdf");

    return {
      capabilitiesInput: {
        text: hasText,
        image: hasImage,
        audio: hasAudio,
        video: hasVideo,
        pdf: hasPdf,
      },
      modalitiesInput: modalities.length > 0 ? modalities : ["text"],
    };
  }

  if (typeof input === "object" && input !== null) {
    const obj = input as Record<string, unknown>;
    const modalities = Object.entries(obj)
      .filter(([_, v]) => Boolean(v))
      .map(([k]) => k.toLowerCase());
    return {
      capabilitiesInput: {
        text: Boolean(obj.text),
        image: Boolean(obj.image),
        audio: Boolean(obj.audio),
        video: Boolean(obj.video),
        pdf: Boolean(obj.pdf),
        ...obj,
      },
      modalitiesInput: modalities.length > 0 ? modalities : ["text"],
    };
  }

  return {
    capabilitiesInput: input,
    modalitiesInput: undefined,
  };
}

export function mapRpcModelsToOpenCodeProviders(
  modelsInput: OmpRpcModel[] | { models?: OmpRpcModel[] } | unknown,
  currentProviderID?: string,
  currentModelID?: string,
): OpenCodeProvidersResponse {
  let models: OmpRpcModel[] = [];
  if (Array.isArray(modelsInput)) {
    models = modelsInput as OmpRpcModel[];
  } else if (
    modelsInput &&
    typeof modelsInput === "object" &&
    Array.isArray((modelsInput as { models?: unknown }).models)
  ) {
    models = (modelsInput as { models: OmpRpcModel[] }).models;
  }

  const providersById = new Map<string, OpenCodeProvider>();
  for (const model of models) {
    let provider = providersById.get(model.provider);
    if (!provider) {
      provider = { id: model.provider, name: model.provider, models: {} };
      providersById.set(model.provider, provider);
    }
    let variants: Record<string, unknown> = { ...defaultThinkingVariants };
    if (model.variants && typeof model.variants === "object") {
      if (Array.isArray(model.variants)) {
        variants = Object.fromEntries(model.variants.map((v) => [String(v), {}]));
      } else {
        variants = { ...(model.variants as Record<string, unknown>) };
      }
    }
    const thinking = model.thinking as { efforts?: string[] } | undefined;
    if (Array.isArray(thinking?.efforts)) {
      for (const effort of thinking.efforts) {
        variants[String(effort)] = {};
      }
    }
    const { capabilitiesInput, modalitiesInput } = parseModelInputCapabilities(model.input);
    const supportsAttachment =
      model.supportsAttachment ??
      (modalitiesInput ? modalitiesInput.includes("image") || modalitiesInput.includes("pdf") : undefined);

    const entry: OpenCodeModel = {
      id: model.id,
      name: model.name,
      providerID: model.provider,
      limit: undefined,
      reasoning: model.reasoning ?? true,
      tool_call: model.supportsToolCall,
      attachment: supportsAttachment,
      capabilities:
        capabilitiesInput !== undefined
          ? {
              input: capabilitiesInput,
              ...(typeof model.supportsToolCall === "boolean" ? { toolcall: model.supportsToolCall } : {}),
              ...(typeof supportsAttachment === "boolean" ? { attachment: supportsAttachment } : {}),
              ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
            }
          : undefined,
      modalities: modalitiesInput ? { input: modalitiesInput, output: ["text"] } : undefined,
      variants,
    };
    if (model.contextWindow !== undefined || model.maxTokens !== undefined) {
      const l: OpenCodeModel["limit"] = {};
      if (model.contextWindow !== undefined) l.context = model.contextWindow;
      if (model.maxTokens !== undefined) l.output = model.maxTokens;
      entry.limit = l;
    }
    provider.models[model.id] = entry;
  }

  // Ensure currentModelID is mapped if it has a region/custom prefix
  if (currentProviderID && currentModelID) {
    const provider = providersById.get(currentProviderID);
    if (provider && !provider.models[currentModelID]) {
      const stripped = currentModelID.replace(/^(us|eu|ap|jp|global)\./, "");
      const matched =
        provider.models[stripped] ??
        Object.values(provider.models).find(
          (m) => m.id.endsWith(stripped) || stripped.endsWith(m.id),
        );
      if (matched) {
        provider.models[currentModelID] = { ...matched, id: currentModelID };
      } else {
        provider.models[currentModelID] = {
          id: currentModelID,
          name: currentModelID,
          providerID: currentProviderID,
          reasoning: true,
          variants: { ...defaultThinkingVariants },
        };
      }
    }
  }

  const providers = Array.from(providersById.values());
  const defaultIdx = providers.findIndex((p) => p.id === currentProviderID);
  if (defaultIdx > 0) {
    const [def] = providers.splice(defaultIdx, 1);
    providers.unshift(def);
  }
  if (currentModelID && providers[0]?.models[currentModelID]) {
    const curModel = providers[0].models[currentModelID];
    delete providers[0].models[currentModelID];
    providers[0].models = { [currentModelID]: curModel, ...providers[0].models };
  }
  const defaultProvider = providers[0];
  return {
    providers,
    default: { default: defaultProvider?.id ?? "" },
  };
}

export async function getCurrentModel(
  conn: Pick<OmpRpcTransport, "request">,
): Promise<{ providerID?: string; modelID?: string; variant?: string } | undefined> {
  const state = (await conn.request("get_state")) as Record<string, unknown> | undefined;
  if (!state || typeof state !== "object") return undefined;
  if (!("model" in state)) return undefined;
  const model = state.model;
  if (!model || typeof model !== "object") return undefined;
  const providerID =
    "provider" in model && typeof model.provider === "string" ? model.provider : undefined;
  const modelID = "id" in model && typeof model.id === "string" ? model.id : undefined;
  const variant =
    typeof state.thinkingLevel === "string"
      ? state.thinkingLevel
      : "variant" in model && typeof model.variant === "string"
        ? model.variant
        : undefined;
  return {
    providerID,
    modelID,
    variant,
  };
}
