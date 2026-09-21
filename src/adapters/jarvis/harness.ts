import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BackendCredentialInput, BackendCredentials, ImageContent, ModelRef } from "../../providers/types";
import { resolveBackendCredentials } from "../../providers/omp/credentials";
import { createOmpSession, readSessionIdSync, toOpenCodeSessionId } from "../../providers/omp/store";
import {
  OmpRpcConnection,
  type OmpRpcEvent,
  type OmpRpcTransport,
} from "../../providers/omp/rpc";
import type {
  JarvisActionResultInput,
  JarvisActionUpdateInput,
  JarvisCancelInput,
  JarvisEvent,
  JarvisEventType,
  JarvisPendingAction,
  JarvisProviderBinding,
  JarvisSessionCreateInput,
  JarvisSessionSnapshot,
  JarvisSessionStatus,
  JarvisToolDefinition,
  JarvisTurnStartInput,
} from "./types";

const DEFAULT_MAX_EVENTS = 5_000;
const MAX_JSON_VALUE_DEPTH = 8;

export class JarvisAdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 400, code = "jarvis_adapter_error") {
    super(message);
    this.name = "JarvisAdapterError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class JarvisNotFoundError extends JarvisAdapterError {
  constructor(message: string) {
    super(message, 404, "not_found");
  }
}

export class JarvisConflictError extends JarvisAdapterError {
  constructor(message: string) {
    super(message, 409, "conflict");
  }
}

export interface JarvisTransportContext {
  cwd: string;
  sessionPath: string;
  openCodeId: string;
  credential?: BackendCredentials;
}

export type JarvisTransportFactory = (context: JarvisTransportContext) => Promise<OmpRpcTransport>;

const defaultTransportFactory: JarvisTransportFactory = async (context) => {
  const connection = context.credential
    ? await OmpRpcConnection.spawn(context.cwd, 3, { credential: context.credential, noTools: true, disableExtensions: true })
    : await OmpRpcConnection.spawn(context.cwd, 3, { noTools: true, disableExtensions: true });
  try {
    await connection.switchSession(context.sessionPath);
    await connection.request("set_subagent_subscription", { level: "events" }).catch(() => {});
    return connection;
  } catch (error) {
    connection.kill();
    throw error;
  }
};

let transportFactory: JarvisTransportFactory = defaultTransportFactory;

/** Test seam for the Jarvis adapter; production uses the real OMP RPC child. */
export function setJarvisTransportFactory(factory: JarvisTransportFactory): void {
  transportFactory = factory;
}

export function resetJarvisTransportFactory(): void {
  transportFactory = defaultTransportFactory;
}

function stateFilePath(): string {
  const configured = process.env.OC_JARVIS_STATE_DIR?.trim();
  if (configured) return join(resolve(configured), "sessions.json");

  const stateHome = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(stateHome, "omp-sidecar", "jarvis", "sessions.json");
}

function maxEvents(): number {
  const value = Number(process.env.OC_JARVIS_MAX_EVENTS);
  return Number.isInteger(value) && value >= 100 && value <= 100_000 ? value : DEFAULT_MAX_EVENTS;
}

function validateWorkspacePath(cwd: string): string {
  if (!isAbsolute(cwd)) throw new JarvisAdapterError("cwd must be an absolute path");
  const resolved = resolve(cwd);
  const configuredRoot = process.env.OC_JARVIS_ALLOWED_ROOT?.trim();
  if (configuredRoot) {
    const root = resolve(configuredRoot);
    const outside = relative(root, resolved);
    if (outside === ".." || outside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(outside)) {
      throw new JarvisAdapterError("cwd is outside OC_JARVIS_ALLOWED_ROOT", 403, "workspace_not_allowed");
    }
  }
  if (!existsSync(resolved)) throw new JarvisAdapterError(`cwd does not exist: ${resolved}`, 400, "workspace_not_found");
  return resolved;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new JarvisAdapterError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeModel(value: Partial<ModelRef> & { providerID: string; modelID: string } | undefined): ModelRef | undefined {
  if (!value) return undefined;
  return {
    providerID: nonEmptyString(value.providerID, "model.providerID"),
    modelID: nonEmptyString(value.modelID, "model.modelID"),
    variant: typeof value.variant === "string" && value.variant.trim().length > 0 ? value.variant.trim() : "default",
  };
}

function normalizeTools(value: JarvisToolDefinition[] | undefined): JarvisToolDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new JarvisAdapterError("tools must be an array");
  return value.map((tool, index) => {
    if (!tool || typeof tool !== "object") throw new JarvisAdapterError(`tools[${index}] must be an object`);
    const name = nonEmptyString(tool.name, `tools[${index}].name`);
    const description = nonEmptyString(tool.description, `tools[${index}].description`);
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw new JarvisAdapterError(`tools[${index}].parameters must be an object`);
    }
    return {
      name,
      description,
      parameters: structuredClone(tool.parameters),
      ...(tool.label !== undefined ? { label: nonEmptyString(tool.label, `tools[${index}].label`) } : {}),
      ...(tool.hidden !== undefined ? { hidden: Boolean(tool.hidden) } : {}),
      ...(tool.loadMode !== undefined ? { loadMode: tool.loadMode } : {}),
      ...(tool.requiresApproval !== undefined ? { requiresApproval: Boolean(tool.requiresApproval) } : {}),
      ...(tool.category !== undefined ? { category: nonEmptyString(tool.category, `tools[${index}].category`) } : {}),
    } satisfies JarvisToolDefinition;
  });
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function redactForPersistence(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_VALUE_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((entry) => redactForPersistence(entry, depth + 1));
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:api[-_]?key|authorization|cookie|password|secret|token)/i.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = redactForPersistence(child, depth + 1);
    }
  }
  return result;
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isAgentToolResult(value: unknown): value is { content: unknown[]; details?: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Array.isArray((value as Record<string, unknown>).content);
}

function toAgentToolResult(value: unknown, details?: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  if (isAgentToolResult(value)) {
    return {
      content: cloneJson(value.content) as Array<{ type: "text"; text: string }>,
      details: value.details ?? details ?? {},
    };
  }
  return {
    content: [{ type: "text", text: stringifyToolValue(value) }],
    details: details ?? {},
  };
}

function rawRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function providerErrorOf(event: OmpRpcEvent): string | undefined {
  const candidates = [event.errorMessage, event.error, event.reason, event.stopReason];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (candidate && typeof candidate === "object" && typeof (candidate as Record<string, unknown>).message === "string") {
      return (candidate as Record<string, unknown>).message as string;
    }
  }
  return undefined;
}

function isAbortReason(value: unknown): boolean {
  return typeof value === "string" && /abort|cancel|interrupt/i.test(value);
}

function isFailureReason(event: OmpRpcEvent): boolean {
  return event.isError === true
    || event.error !== undefined
    || event.errorMessage !== undefined
    || event.stopReason === "error"
    || event.stopReason === "failed";
}

interface PersistedActiveTurn {
  turnId: string;
  attemptId: string;
  workerLeaseEpoch?: number;
  startedAt: string;
}

interface PersistedJarvisSession {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  provider: JarvisProviderBinding;
  status: JarvisSessionStatus;
  model?: ModelRef;
  tools: JarvisToolDefinition[];
  credentialRef?: string;
  activeTurn?: PersistedActiveTurn;
  recoveryRequired?: boolean;
  sequence: number;
  events: JarvisEvent[];
  updatedAt: string;
}

function readPersistedSessions(): PersistedJarvisSession[] {
  const path = stateFilePath();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PersistedJarvisSession => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Record<string, unknown>;
      return typeof value.sessionId === "string"
        && typeof value.workspaceId === "string"
        && typeof value.cwd === "string"
        && typeof value.provider === "object"
        && Array.isArray(value.events);
    });
  } catch {
    return [];
  }
}

function writePersistedSessions(sessions: Iterable<PersistedJarvisSession>): void {
  const path = stateFilePath();
  const directory = join(path, "..");
  try {
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify([...sessions], null, 2) + "\n");
    renameSync(temporaryPath, path);
  } catch {
    // A durable event log is helpful, but a read-only state directory must not
    // prevent the in-memory adapter from serving the current request.
  }
}

type EventListener = (event: JarvisEvent) => void;
type EventIds = { turnId?: string; attemptId?: string };

class JarvisEventLog {
  #sessionId: string;
  #events: JarvisEvent[];
  #sequence: number;
  #listeners = new Set<EventListener>();

  constructor(sessionId: string, events: JarvisEvent[], sequence: number) {
    this.#sessionId = sessionId;
    this.#events = events.slice(-maxEvents());
    this.#sequence = Math.max(sequence, this.#events.at(-1)?.sequence ?? 0);
  }

  get sequence(): number {
    return this.#sequence;
  }

  get events(): JarvisEvent[] {
    return this.#events;
  }

  append(
    type: JarvisEventType,
    ids: { turnId?: string; attemptId?: string },
    data: Record<string, unknown>,
  ): JarvisEvent {
    const sequence = ++this.#sequence;
    const event: JarvisEvent = {
      eventId: `evt_${this.#sessionId}_${sequence}`,
      sequence,
      sessionId: this.#sessionId,
      ...(ids.turnId ? { turnId: ids.turnId } : {}),
      ...(ids.attemptId ? { attemptId: ids.attemptId } : {}),
      type,
      visibility: "public",
      data: cloneJson(data),
      createdAt: new Date().toISOString(),
    };
    this.#events.push(event);
    if (this.#events.length > maxEvents()) this.#events.splice(0, this.#events.length - maxEvents());
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected SSE client must not break the OMP event bridge.
      }
    }
    return event;
  }

  after(sequence: number): JarvisEvent[] {
    return this.#events.filter((event) => event.sequence > sequence);
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export class JarvisSessionBinding {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly provider: JarvisProviderBinding;

  #status: JarvisSessionStatus;
  #model?: ModelRef;
  #tools: JarvisToolDefinition[];
  #credentialInput?: BackendCredentialInput;
  #credentialRef?: string;
  #activeTurn?: PersistedActiveTurn;
  #recoveryRequired: boolean;
  #pendingActions = new Map<string, JarvisPendingAction>();
  #transport?: OmpRpcTransport;
  #unsubscribe?: () => void;
  #connectPromise?: Promise<OmpRpcTransport>;
  #cancelRequested = false;
  #lastTurnError?: string;
  #outputText = "";
  #eventLog: JarvisEventLog;
  #persist: () => void;

  constructor(
    persisted: PersistedJarvisSession,
    persist: () => void,
    credentialInput?: BackendCredentialInput,
  ) {
    this.sessionId = persisted.sessionId;
    this.workspaceId = persisted.workspaceId;
    this.cwd = persisted.cwd;
    this.provider = persisted.provider;
    this.#status = persisted.status;
    this.#model = persisted.model;
    this.#tools = normalizeTools(persisted.tools);
    this.#credentialRef = persisted.credentialRef;
    this.#credentialInput = credentialInput ?? (persisted.credentialRef
      ? { credentialRef: persisted.credentialRef, selectedProviderID: persisted.model?.providerID, selectedModelID: persisted.model?.modelID }
      : undefined);
    this.#activeTurn = persisted.activeTurn;
    this.#recoveryRequired = persisted.recoveryRequired === true || persisted.activeTurn !== undefined;
    if (this.#recoveryRequired && this.#activeTurn) this.#status = "recovery_required";
    this.#eventLog = new JarvisEventLog(this.sessionId, persisted.events, persisted.sequence);
    this.#persist = persist;
  }

  get events(): JarvisEvent[] {
    return this.#eventLog.events;
  }

  eventLogAfter(sequence: number): JarvisEvent[] {
    return this.#eventLog.after(sequence);
  }

  subscribe(listener: EventListener): () => void {
    return this.#eventLog.subscribe(listener);
  }

  appendEvent(type: JarvisEventType, data: Record<string, unknown>, ids: EventIds = this.#activeTurn ?? {}): JarvisEvent {
    const event = this.#eventLog.append(type, ids ?? {}, data);
    this.#persist();
    return event;
  }

  private persisted(): PersistedJarvisSession {
    return {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      cwd: this.cwd,
      provider: this.provider,
      status: this.#status,
      ...(this.#model ? { model: this.#model } : {}),
      tools: this.#tools,
      ...(this.#credentialRef ? { credentialRef: this.#credentialRef } : {}),
      ...(this.#activeTurn ? { activeTurn: this.#activeTurn } : {}),
      ...(this.#recoveryRequired ? { recoveryRequired: true } : {}),
      sequence: this.#eventLog.sequence,
      events: this.events.map((event) => ({
        ...event,
        data: redactForPersistence(event.data) as Record<string, unknown>,
      })),
      updatedAt: new Date().toISOString(),
    };
  }

  toPersisted(): PersistedJarvisSession {
    return this.persisted();
  }

  private async resolveCredential(): Promise<BackendCredentials | undefined> {
    return resolveBackendCredentials(this.#credentialInput, {
      cwd: this.cwd,
      openCodeId: this.provider.openCodeId,
      providerID: this.#model?.providerID,
      modelID: this.#model?.modelID,
    });
  }

  async ensureConnected(): Promise<OmpRpcTransport> {
    if (this.#transport) return this.#transport;
    if (this.#connectPromise) return this.#connectPromise;

    this.#status = this.#activeTurn ? "recovery_required" : "starting";
    this.#persist();
    this.#connectPromise = (async () => {
      const credential = await this.resolveCredential();
      const transport = await transportFactory({
        cwd: this.cwd,
        sessionPath: this.provider.sessionPath,
        openCodeId: this.provider.openCodeId,
        credential,
      });
      try {
        this.#transport = transport;
        this.#unsubscribe = transport.onEvent((event) => this.handleFrame(event));
        await this.installTools(this.#tools, transport);
        if (this.#status === "starting") this.#status = "idle";
        const hasConnectedEvent = this.events.some((event) => event.type === "session.connected" || event.type === "session.reconnected");
        this.appendEvent(hasConnectedEvent ? "session.reconnected" : "session.connected", {
          backend: "omp",
          openCodeId: this.provider.openCodeId,
        }, {});
        return transport;
      } catch (error) {
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
        transport.kill();
        throw error;
      }
    })();

    try {
      return await this.#connectPromise;
    } catch (error) {
      this.#transport = undefined;
      this.#status = this.#activeTurn ? "recovery_required" : "failed";
      this.appendEvent("session.error", { message: error instanceof Error ? error.message : String(error) }, {});
      throw error;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  private async installTools(tools: JarvisToolDefinition[], transport = this.#transport): Promise<void> {
    if (!transport) throw new JarvisAdapterError("OMP transport is not connected", 503, "provider_unavailable");
    await transport.request("set_host_tools", {
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.label ? { label: tool.label } : {}),
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.hidden !== undefined ? { hidden: tool.hidden } : {}),
        ...(tool.loadMode ? { loadMode: tool.loadMode } : {}),
      })),
    });
  }

  private activeIds(input: { turnId?: string; attemptId?: string }): { turnId?: string; attemptId?: string } {
    if (!this.#activeTurn) return {};
    if (input.turnId && input.turnId !== this.#activeTurn.turnId) {
      throw new JarvisConflictError(`turn ${input.turnId} is not active for session ${this.sessionId}`);
    }
    if (input.attemptId && input.attemptId !== this.#activeTurn.attemptId) {
      throw new JarvisConflictError(`attempt ${input.attemptId} is not active for session ${this.sessionId}`);
    }
    return this.#activeTurn;
  }

  async startTurn(input: JarvisTurnStartInput): Promise<{ accepted: true; idempotent: boolean; snapshot: JarvisSessionSnapshot }> {
    const turnId = nonEmptyString(input.turnId, "turnId");
    const attemptId = nonEmptyString(input.attemptId, "attemptId");
    if (this.#activeTurn) {
      if (this.#activeTurn.turnId === turnId && this.#activeTurn.attemptId === attemptId) {
        return { accepted: true, idempotent: true, snapshot: this.snapshot() };
      }
      throw new JarvisConflictError(`session ${this.sessionId} already has an active turn`);
    }
    if (this.#recoveryRequired) {
      throw new JarvisConflictError(`session ${this.sessionId} requires reconciliation before a new turn`);
    }
    const prompt = nonEmptyString(input.prompt, "prompt");
    const model = normalizeModel(input.model);
    const tools = input.tools ?? input.boundCapabilities;
    if (tools !== undefined) this.#tools = normalizeTools(tools);
    if (model) this.#model = model;

    const transport = await this.ensureConnected();
    if (tools !== undefined) await this.installTools(this.#tools, transport);
    if (model) await transport.request("set_model", { provider: model.providerID, modelId: model.modelID });

    this.#activeTurn = {
      turnId,
      attemptId,
      ...(input.workerLeaseEpoch !== undefined ? { workerLeaseEpoch: input.workerLeaseEpoch } : {}),
      startedAt: new Date().toISOString(),
    };
    this.#status = "running";
    this.#cancelRequested = false;
    this.#lastTurnError = undefined;
    this.#outputText = "";
    this.#persist();
    this.appendEvent("turn.accepted", { promptAccepted: true, idempotencyKey: input.idempotencyKey }, this.#activeTurn);

    try {
      await transport.request("prompt", {
        message: prompt,
        ...(input.images ? { images: input.images } : {}),
        streamingBehavior: "steer",
      });
      this.appendEvent("turn.started", { provider: "omp" }, this.#activeTurn);
      return { accepted: true, idempotent: false, snapshot: this.snapshot() };
    } catch (error) {
      this.finishTurn("failed", error instanceof Error ? error.message : String(error));
      throw new JarvisAdapterError(
        `OMP rejected turn: ${error instanceof Error ? error.message : String(error)}`,
        502,
        "provider_rejected_turn",
      );
    }
  }

  async submitActionResult(providerRequestId: string, input: JarvisActionResultInput): Promise<JarvisSessionSnapshot> {
    const action = this.#pendingActions.get(providerRequestId);
    if (!action) throw new JarvisNotFoundError(`pending provider action ${providerRequestId} was not found`);
    this.activeIds(input);
    const transport = await this.ensureConnected();
    if (!transport.sendFrame) throw new JarvisAdapterError("OMP transport cannot submit host-tool results", 503, "provider_unavailable");

    const result = input.success
      ? toAgentToolResult(input.result, input.details)
      : toAgentToolResult(input.error ?? "Jarvis capability execution failed", input.details);
    transport.sendFrame({
      type: "host_tool_result",
      id: providerRequestId,
      result,
      isError: !input.success,
    });
    this.#pendingActions.delete(providerRequestId);
    if (this.#activeTurn && this.#pendingActions.size === 0 && this.#status === "waiting_tool") this.#status = "running";
    this.appendEvent("tool_result_submitted", {
      providerRequestId,
      providerToolCallId: action.providerToolCallId,
      toolName: action.toolName,
      success: input.success,
      ...(input.error ? { error: input.error } : {}),
    }, this.#activeTurn ?? action);
    return this.snapshot();
  }

  async submitActionUpdate(providerRequestId: string, input: JarvisActionUpdateInput): Promise<JarvisSessionSnapshot> {
    const action = this.#pendingActions.get(providerRequestId);
    if (!action) throw new JarvisNotFoundError(`pending provider action ${providerRequestId} was not found`);
    this.activeIds(input);
    const transport = await this.ensureConnected();
    if (!transport.sendFrame) throw new JarvisAdapterError("OMP transport cannot submit host-tool updates", 503, "provider_unavailable");
    transport.sendFrame({
      type: "host_tool_update",
      id: providerRequestId,
      partialResult: toAgentToolResult(input.partialResult),
    });
    this.appendEvent("tool_call_update", {
      providerRequestId,
      providerToolCallId: action.providerToolCallId,
      toolName: action.toolName,
      partialResult: input.partialResult,
    }, this.#activeTurn ?? action);
    return this.snapshot();
  }

  async cancelTurn(input: JarvisCancelInput): Promise<JarvisSessionSnapshot> {
    if (!this.#activeTurn) return this.snapshot();
    this.activeIds(input);
    const transport = await this.ensureConnected();
    await transport.request("abort", {});
    this.#cancelRequested = true;
    this.#status = "cancelling";
    this.appendEvent("turn.cancel_requested", { reason: input.reason ?? "cancelled_by_caller" }, this.#activeTurn);
    return this.snapshot();
  }

  async reconcile(): Promise<{ snapshot: JarvisSessionSnapshot; providerState?: unknown }> {
    const transport = await this.ensureConnected();
    let providerState: unknown;
    try {
      providerState = await transport.request("get_state");
    } catch (error) {
      throw new JarvisAdapterError(
        `unable to reconcile OMP session: ${error instanceof Error ? error.message : String(error)}`,
        502,
        "provider_reconcile_failed",
      );
    }

    if (this.#recoveryRequired && this.#activeTurn) {
      const state = rawRecord(providerState);
      const providerBusy = state.isStreaming === true
        || state.isCompacting === true
        || (typeof state.queuedMessageCount === "number" && state.queuedMessageCount > 0);
      if (!providerBusy) {
        const recovered = this.#activeTurn;
        this.#activeTurn = undefined;
        this.#recoveryRequired = false;
        this.#status = "idle";
        this.#pendingActions.clear();
        this.appendEvent("turn_failed", {
          error: "sidecar_restart_requires_recovery",
          recovered: true,
        }, recovered);
      }
    }
    return { snapshot: this.snapshot(), providerState };
  }

  private finishTurn(status: "completed" | "failed" | "cancelled", error?: string): void {
    const active = this.#activeTurn;
    if (!active) return;
    this.#lastTurnError = error;
    this.#pendingActions.clear();
    this.#activeTurn = undefined;
    this.#cancelRequested = false;
    this.#status = status;
    this.#recoveryRequired = false;
    if (status === "completed") {
      this.appendEvent("turn_completed", { outputText: this.#outputText }, active);
    } else if (status === "cancelled") {
      this.appendEvent("turn_cancelled", { reason: error ?? "cancelled" }, active);
    } else {
      this.appendEvent("turn_failed", { error: error ?? "provider_error" }, active);
    }
  }

  private handleFrame(event: OmpRpcEvent): void {
    const active = this.#activeTurn;
    if (event.type === "host_tool_call") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const providerRequestId = typeof event.id === "string" ? event.id : "";
      const toolName = typeof event.toolName === "string" ? event.toolName : "";
      const args = rawRecord(event.arguments);
      if (!providerRequestId || !toolCallId || !toolName) return;
      const action: JarvisPendingAction = {
        providerRequestId,
        providerToolCallId: toolCallId,
        toolName,
        arguments: cloneJson(args),
        ...(active?.turnId ? { turnId: active.turnId } : {}),
        ...(active?.attemptId ? { attemptId: active.attemptId } : {}),
      };
      this.#pendingActions.set(providerRequestId, action);
      this.#status = "waiting_tool";
      this.appendEvent("tool_call_proposed", {
        providerRequestId,
        providerToolCallId: toolCallId,
        callId: toolCallId,
        toolName,
        name: toolName,
        arguments: args,
        args,
      }, active ?? action);
      return;
    }

    if (event.type === "host_tool_cancel") {
      const targetId = typeof event.targetId === "string" ? event.targetId : "";
      const action = this.#pendingActions.get(targetId);
      if (action) {
        this.#pendingActions.delete(targetId);
        if (this.#status === "waiting_tool") this.#status = "running";
        this.appendEvent("tool_call_cancelled", {
          providerRequestId: targetId,
          providerToolCallId: action.providerToolCallId,
          toolName: action.toolName,
        }, active ?? action);
      }
      return;
    }

    if (!active) return;

    if (event.type === "message_update") {
      const assistant = rawRecord(event.assistantMessageEvent);
      const eventType = assistant.type;
      const text = assistant.text ?? assistant.delta ?? assistant.content;
      if ((eventType === "text_delta" || eventType === "text") && typeof text === "string" && text.length > 0) {
        this.#outputText += text;
        this.appendEvent("text_delta", { delta: text }, active);
      }
      // Thinking deltas are deliberately not forwarded into the Jarvis public
      // event contract. They are provider-internal reasoning, not runtime data.
      return;
    }

    if (event.type === "turn_end") {
      this.#lastTurnError = providerErrorOf(event);
      return;
    }

    if (event.type === "prompt_result" && event.agentInvoked === false) {
      this.finishTurn(this.#cancelRequested ? "cancelled" : isFailureReason(event) ? "failed" : "completed", providerErrorOf(event));
      return;
    }

    if (event.type === "agent_end" && event.isTerminal !== false) {
      const reason = providerErrorOf(event) ?? this.#lastTurnError;
      const cancelled = this.#cancelRequested || isAbortReason(event.stopReason);
      this.finishTurn(cancelled ? "cancelled" : isFailureReason(event) || reason ? "failed" : "completed", reason);
    }
  }

  snapshot(): JarvisSessionSnapshot {
    return {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      cwd: this.cwd,
      status: this.#status,
      provider: this.provider,
      ...(this.#model ? { model: this.#model } : {}),
      ...(this.#activeTurn ? { activeTurn: this.#activeTurn } : {}),
      pendingActions: [...this.#pendingActions.values()].map((action) => cloneJson(action)),
      lastSequence: this.#eventLog.sequence,
      connected: this.#transport !== undefined,
      recoveryRequired: this.#recoveryRequired,
    };
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#transport?.kill();
    this.#transport = undefined;
  }
}

export class JarvisHarness {
  #bindings = new Map<string, JarvisSessionBinding>();

  constructor() {
    for (const persisted of readPersistedSessions()) {
      try {
        const binding = new JarvisSessionBinding(persisted, () => this.persist(), persisted.credentialRef
          ? { credentialRef: persisted.credentialRef, selectedProviderID: persisted.model?.providerID, selectedModelID: persisted.model?.modelID }
          : undefined);
        this.#bindings.set(binding.sessionId, binding);
      } catch {
        // Ignore one corrupt record while keeping healthy sessions available.
      }
    }
  }

  private persist(): void {
    writePersistedSessions([...this.#bindings.values()].map((binding) => binding.toPersisted()));
  }

  get(sessionId: string): JarvisSessionBinding {
    const binding = this.#bindings.get(sessionId);
    if (!binding) throw new JarvisNotFoundError(`Jarvis session ${sessionId} was not found`);
    return binding;
  }

  async createSession(input: JarvisSessionCreateInput): Promise<JarvisSessionBinding> {
    const sessionId = nonEmptyString(input.sessionId, "sessionId");
    const workspaceId = nonEmptyString(input.workspaceId, "workspaceId");
    const cwd = validateWorkspacePath(nonEmptyString(input.cwd, "cwd"));
    const existing = this.#bindings.get(sessionId);
    if (existing) {
      const current = existing.snapshot();
      if (current.workspaceId !== workspaceId || current.cwd !== cwd) {
        throw new JarvisConflictError(`Jarvis session ${sessionId} is already bound to another workspace`);
      }
      return existing;
    }

    let provider: JarvisProviderBinding;
    const suppliedSessionPath = input.providerSessionPath ?? input.sessionPath;
    if (suppliedSessionPath !== undefined) {
      const sessionPath = nonEmptyString(suppliedSessionPath, "sessionPath");
      if (!isAbsolute(sessionPath) || !existsSync(sessionPath)) {
        throw new JarvisAdapterError("sessionPath must be an existing absolute path", 400, "provider_session_not_found");
      }
      const nativeId = readSessionIdSync(sessionPath);
      if (!nativeId) throw new JarvisAdapterError("sessionPath does not contain an OMP session header", 400, "invalid_provider_session");
      provider = { backend: "omp", openCodeId: toOpenCodeSessionId(nativeId), sessionPath };
    } else {
      const session = await createOmpSession(cwd);
      provider = { backend: "omp", openCodeId: session.id, sessionPath: session.path };
    }

    const model = normalizeModel(input.model);
    const tools = normalizeTools(input.tools);
    const credentialInput: BackendCredentialInput | undefined = input.credentialRef
      ? { credentialRef: nonEmptyString(input.credentialRef, "credentialRef"), selectedProviderID: model?.providerID, selectedModelID: model?.modelID }
      : input.credentials
        ? { credentials: input.credentials, selectedProviderID: model?.providerID, selectedModelID: model?.modelID }
        : undefined;
    const persisted: PersistedJarvisSession = {
      sessionId,
      workspaceId,
      cwd,
      provider,
      status: "registered",
      ...(model ? { model } : {}),
      tools,
      ...(input.credentialRef ? { credentialRef: nonEmptyString(input.credentialRef, "credentialRef") } : {}),
      sequence: 0,
      events: [],
      updatedAt: new Date().toISOString(),
    };
    const binding = new JarvisSessionBinding(persisted, () => this.persist(), credentialInput);
    this.#bindings.set(sessionId, binding);
    this.persist();
    binding.appendEvent("session.registered", {
      backend: "omp",
      openCodeId: provider.openCodeId,
      sessionPath: provider.sessionPath,
    }, {});
    return binding;
  }

  deleteSession(sessionId: string): void {
    const binding = this.get(sessionId);
    binding.close();
    this.#bindings.delete(sessionId);
    this.persist();
  }

  list(): JarvisSessionSnapshot[] {
    return [...this.#bindings.values()].map((binding) => binding.snapshot());
  }

  close(): void {
    for (const binding of this.#bindings.values()) binding.close();
  }
}

export const jarvisHarness = new JarvisHarness();
