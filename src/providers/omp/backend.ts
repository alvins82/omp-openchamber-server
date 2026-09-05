/**
 * OMP backend turn connection.
 *
 * Wraps a raw OmpRpcTransport and exposes the backend-agnostic
 * BackendTurnConnection surface. Event frames flowing out of the transport
 * pass through the omp normalizer (events.ts) before reaching the sink.
 */
import type {
  AgentBackend,
  BackendCapabilities,
  BackendTurnConnection,
  ModelRef,
  OpenCodeProvidersResponse,
  SessionStore,
  TurnPromptInput,
} from "../types";
import {
  OmpRpcConnection,
  getCurrentModel,
  mapRpcModelsToOpenCodeProviders,
  normalizeModelsResponse,
  withOmpRpc,
  type OmpRpcTransport,
} from "./rpc";
import { createOmpEventNormalizer, OMP_DEFAULT_MODEL } from "./events";
import { invalidateMessageCache, loadSessionMessages, recordUserMessageId } from "./messages";
import {
  createOmpSession,
  deleteOmpSession,
  getOmpSessionByOpenCodeId,
  listOmpChildSessions,
  listOmpSessions,
  setOmpSessionTitle,
  updateOmpSession,
} from "./store";

export interface OmpTurnContext {
  /** External OpenCode session id. */
  openCodeId: string;
  cwd: string;
  /** Session file path; enables header re-reads + respawn semantics. */
  sessionPath?: string;
  /** Model the connection starts with; defaults to the omp builtin. */
  initialModel?: ModelRef;
  /** Grace window for non-terminal agent ends (tests shorten this). */
  nonTerminalGraceMs?: number;
}

export type OmpTransportFactory = (cwd: string, sessionPath: string) => Promise<OmpRpcTransport>;

const defaultOmpTransportFactory: OmpTransportFactory = async (cwd, sessionPath) => {
  const conn = await OmpRpcConnection.spawn(cwd);
  await conn.switchSession(sessionPath);
  await conn.request("set_subagent_subscription", { level: "events" }).catch(() => {});
  return conn;
};

let ompTransportFactory: OmpTransportFactory = defaultOmpTransportFactory;

/** Test seam: replaces how turn connections obtain their raw transport. */
export function setOmpTransportFactory(factory: OmpTransportFactory): void {
  ompTransportFactory = factory;
}

export function resetOmpTransportFactory(): void {
  ompTransportFactory = defaultOmpTransportFactory;
}

/**
 * Builds a turn connection over an existing transport. The normalizer owns
 * all backend-specific event translation; the returned object is exactly the
 * BackendTurnConnection contract.
 */
export function createOmpTurnConnection(transport: OmpRpcTransport, ctx: OmpTurnContext): BackendTurnConnection {
  const normalizer = createOmpEventNormalizer({
    transport,
    openCodeId: ctx.openCodeId,
    cwd: ctx.cwd,
    sessionPath: ctx.sessionPath,
    initialModel: ctx.initialModel,
    nonTerminalGraceMs: ctx.nonTerminalGraceMs,
  });
  return {
    onEvent(sink) {
      return normalizer.subscribe(sink);
    },
    prompt(input: TurnPromptInput) {
      return transport.request("prompt", input);
    },
    setModel(providerID: string, modelID: string) {
      return transport.request("set_model", { provider: providerID, modelId: modelID });
    },
    async getInitialModel() {
      try {
        const m = await getCurrentModel(transport);
        return (m && m.providerID && m.modelID
          ? { providerID: m.providerID, modelID: m.modelID, variant: m.variant ?? "default" }
          : undefined);
      } catch {
        return undefined;
      }
    },
    abort() {
      return transport.request("abort", {});
    },
    kill() {
      transport.kill();
    },
  };
}

/** omp supports every capability the sidecar surfaces. */
const ompCapabilities: BackendCapabilities = {
  thinkingLevels: true,
  images: true,
  approvals: true,
  subagents: true,
  todo: true,
  titleGeneration: true,
  skills: true,
  compact: true,
  shell: true,
};

/**
 * SessionStore facade over the omp on-disk store. Hooks (beforeTurn,
 * recordUserMessage) wire the message cache + user-message ledger so
 * prompt.ts stays backend-agnostic.
 */
const ompStore: SessionStore = {
  async create(directory, init) {
    return createOmpSession(directory, init);
  },
  async get(openCodeId, directory) {
    return getOmpSessionByOpenCodeId(openCodeId, directory);
  },
  async list(directory, options) {
    return listOmpSessions(directory, options);
  },
  async delete(openCodeId, directory) {
    return deleteOmpSession(openCodeId, directory);
  },
  async update(openCodeId, updates, directory) {
    return updateOmpSession(
      openCodeId,
      {
        title: updates.title,
        metadata: updates.metadata,
        time: updates.time?.archived !== undefined
          ? { archived: updates.time.archived }
          : undefined,
      },
      directory,
    );
  },
  async setTitle(openCodeId, title, source, cwd) {
    await setOmpSessionTitle(openCodeId, title, source, cwd);
  },
  async children(parentOpenCodeId, directory) {
    return listOmpChildSessions(parentOpenCodeId, directory);
  },
  async transcript(openCodeId, cwd) {
    return loadSessionMessages(openCodeId, cwd).catch(() => null);
  },
  beforeTurn(openCodeId, cwd) {
    invalidateMessageCache(openCodeId, cwd);
  },
  recordUserMessage(openCodeId, text, messageId) {
    recordUserMessageId(openCodeId, text, messageId);
  },
};

/** The omp backend: disk-backed sessions, RPC transport, full capabilities. */
export const ompBackend: AgentBackend = {
  id: "omp",
  label: "omp",
  capabilities: ompCapabilities,
  defaultModel: OMP_DEFAULT_MODEL,
  store: ompStore,
  async listModels(cwd): Promise<OpenCodeProvidersResponse> {
    return withOmpRpc(cwd, async (conn) => {
      const rawModels = await conn.request("get_available_models");
      const models = normalizeModelsResponse(rawModels);
      const currentModel = await getCurrentModel(conn);
      return mapRpcModelsToOpenCodeProviders(models, currentModel?.providerID, currentModel?.modelID);
    });
  },
  async createTurnConnection(cwd, sessionPath, openCodeId) {
    const transport = await ompTransportFactory(cwd, sessionPath);
    return createOmpTurnConnection(transport, { openCodeId, cwd, sessionPath });
  },
  shutdownAll() {
    OmpRpcConnection.killAll();
  },
};

