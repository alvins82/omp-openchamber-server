/**
 * Fake agent backend: a fully in-memory, scripted AgentBackend used to prove
 * the multi-provider machinery (registry namespacing, session-id codec,
 * capability gating, normalized turn events) without a real agent process.
 *
 * Session ids follow the D2 codec `ses_fake_<native>`; the template is
 * deliberately inlined here instead of importing `encodeSessionId` from the
 * registry, which would create a registry -> fake -> registry cycle.
 *
 * Registered in two ways:
 *  - sidecar: OC_FAKE_BACKEND=1 (see main.ts) for HTTP-surface tests
 *  - unit tests: registry.registerBackend(fakeBackend) + resetBackends()
 */
import type {
  AgentBackend,
  BackendCapabilities,
  BackendTurnConnection,
  ModelRef,
  NormalizedTurnEvent,
  OpenCodeMessageRecord,
  OpenCodeProvidersResponse,
  OpenCodeSession,
  SessionUpdateInput,
  TurnPromptInput,
} from "../types";

const FAKE_VERSION = "1.0.0-fake";

export const fakeModel: ModelRef = {
  providerID: "fake",
  modelID: "fake",
  variant: "default",
};

/** D16: every capability false so every main.ts gate is exercised. */
const fakeCapabilities: BackendCapabilities = {
  thinkingLevels: false,
  images: false,
  approvals: false,
  subagents: false,
  todo: false,
  titleGeneration: false,
  skills: false,
  compact: false,
  shell: false,
};

interface FakeSession {
  session: OpenCodeSession;
  messages: OpenCodeMessageRecord[];
}

const sessions = new Map<string, FakeSession>();
let turnCounter = 0;

/** Zeroed token snapshot for fake turns. */
function emptyTokens(): OpenCodeSession["tokens"] {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

function userMessageRecord(openCodeId: string, text: string, messageId?: string): OpenCodeMessageRecord {
  const id = messageId ?? `msg_fake_u${++turnCounter}`;
  return {
    info: {
      id,
      role: "user",
      sessionID: openCodeId,
      agent: "omp",
      model: { providerID: fakeModel.providerID, modelID: fakeModel.modelID, variant: fakeModel.variant },
      time: { created: Date.now() },
    },
    parts: [{ id: `prt_${id}`, type: "text", text, messageID: id, sessionID: openCodeId }],
  };
}

function assistantMessageRecord(openCodeId: string, text: string): OpenCodeMessageRecord {
  const id = `msg_fake_a${++turnCounter}`;
  return {
    info: {
      id,
      role: "assistant",
      sessionID: openCodeId,
      agent: "omp",
      model: { providerID: fakeModel.providerID, modelID: fakeModel.modelID, variant: fakeModel.variant },
      cost: 0,
      tokens: emptyTokens(),
      time: { created: Date.now(), completed: Date.now() },
    },
    parts: [{ id: `prt_${id}`, type: "text", text, messageID: id, sessionID: openCodeId }],
  };
}

const fakeStore = {
  async create(directory?: string, init?: { title?: string; parentID?: string }): Promise<OpenCodeSession> {
    const native = crypto.randomUUID();
    const openCodeId = `ses_fake_${native}`;
    const now = Date.now();
    const session: OpenCodeSession = {
      id: openCodeId,
      slug: `fake-${native.slice(0, 8)}`,
      projectID: "fake",
      directory: directory ?? "",
      path: `/tmp/fake-sessions/${native}`,
      title: init?.title,
      parentID: init?.parentID,
      agent: "omp",
      model: {
        id: `${fakeModel.providerID}/${fakeModel.modelID}`,
        providerID: fakeModel.providerID,
        modelID: fakeModel.modelID,
        variant: fakeModel.variant,
      },
      version: FAKE_VERSION,
      time: { created: now, updated: now },
      cost: 0,
      tokens: emptyTokens(),
    };
    sessions.set(openCodeId, { session, messages: [] });
    return session;
  },
  async get(openCodeId: string): Promise<OpenCodeSession | null> {
    return sessions.get(openCodeId)?.session ?? null;
  },

  async list(
    directory?: string,
    options?: { all?: boolean; limit?: number; archived?: boolean; search?: string },
  ): Promise<OpenCodeSession[]> {
    let list = [...sessions.values()].map((entry) => entry.session);
    if (!options?.all) list = list.filter((session) => directory === undefined || session.directory === directory);
    if (!options?.archived) list = list.filter((session) => session.time.archived === undefined);
    if (options?.search) {
      const needle = options.search.toLowerCase();
      list = list.filter((session) => (session.title ?? session.slug).toLowerCase().includes(needle));
    }
    if (options?.limit !== undefined) list = list.slice(0, options.limit);
    return list;
  },

  async delete(openCodeId: string): Promise<boolean> {
    return sessions.delete(openCodeId);
  },

  async update(openCodeId: string, updates: SessionUpdateInput): Promise<OpenCodeSession | null> {
    const entry = sessions.get(openCodeId);
    if (!entry) return null;
    if (updates.title !== undefined) entry.session.title = updates.title;
    if (updates.metadata !== undefined) {
      entry.session.metadata = { ...entry.session.metadata, ...updates.metadata };
    }
    if (updates.time?.created !== undefined) entry.session.time.created = updates.time.created;
    if (updates.time?.updated !== undefined) entry.session.time.updated = updates.time.updated;
    if (updates.time?.archived !== undefined) {
      if (updates.time.archived === null) delete entry.session.time.archived;
      else entry.session.time.archived = updates.time.archived;
    }
    entry.session.time.updated = Date.now();
    return entry.session;
  },

  async setTitle(openCodeId: string, title: string, _source: "auto" | "user"): Promise<void> {
    const entry = sessions.get(openCodeId);
    if (!entry) return;
    entry.session.title = title;
    entry.session.time.updated = Date.now();
  },

  async children(parentOpenCodeId: string): Promise<OpenCodeSession[]> {
    return [...sessions.values()]
      .map((entry) => entry.session)
      .filter((session) => session.parentID === parentOpenCodeId);
  },

  async transcript(openCodeId: string): Promise<OpenCodeMessageRecord[] | null> {
    const entry = sessions.get(openCodeId);
    return entry ? entry.messages.map((record) => structuredClone(record)) : null;
  },

  recordUserMessage(openCodeId: string, text: string, messageId?: string): void {
    sessions.get(openCodeId)?.messages.push(userMessageRecord(openCodeId, text, messageId));
  },
};

/**
 * Scripted turn source. Tests install a custom script via `setFakeTurnScript`;
 * without one, the default script replays a text delta, usage, model, turn_end.
 */
export type FakeTurnScript = (input: TurnPromptInput) => NormalizedTurnEvent[];
let turnScript: FakeTurnScript | undefined;

export function setFakeTurnScript(script: FakeTurnScript | undefined): void {
  turnScript = script;
}

function defaultTurnScript(input: TurnPromptInput): NormalizedTurnEvent[] {
  return [
    { kind: "text_delta", text: `fake: ${input.message}` },
    { kind: "usage", tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
    { kind: "model", model: fakeModel },
    { kind: "turn_end" },
  ];
}

class FakeTurnConnection implements BackendTurnConnection {
  #sink: ((event: NormalizedTurnEvent) => void) | undefined;
  #model = fakeModel;

  constructor(readonly openCodeId: string) {}

  onEvent(sink: (event: NormalizedTurnEvent) => void): () => void {
    this.#sink = sink;
    return () => {
      this.#sink = undefined;
    };
  }

  async prompt(input: TurnPromptInput): Promise<unknown> {
    const events = (turnScript ?? defaultTurnScript)(input);
    for (const event of events) this.#sink?.(event);
    const text = events
      .filter((event): event is Extract<NormalizedTurnEvent, { kind: "text_delta" }> => event.kind === "text_delta")
      .map((event) => event.text)
      .join("");
    sessions.get(this.openCodeId)?.messages.push(assistantMessageRecord(this.openCodeId, text));
    return { ok: true };
  }

  async setModel(providerID: string, modelID: string): Promise<unknown> {
    this.#model = { ...fakeModel, providerID, modelID };
    return { ok: true };
  }

  async getInitialModel(): Promise<ModelRef | undefined> {
    return this.#model;
  }

  async abort(): Promise<unknown> {
    return { aborted: true };
  }

  kill(): void {}
}

const fakeProvidersResponse: OpenCodeProvidersResponse = {
  providers: [
    {
      id: "fake",
      name: "Fake",
      models: {
        fake: { id: "fake", name: "Fake Model", providerID: "fake", tool_call: true },
      },
    },
  ],
  default: { default: "fake" },
};

export const fakeBackend: AgentBackend = {
  id: "fake",
  label: "fake",
  capabilities: fakeCapabilities,
  defaultModel: fakeModel,
  listModels: async () => structuredClone(fakeProvidersResponse),
  store: fakeStore,
  createTurnConnection: async (_cwd: string, _sessionPath: string, openCodeId: string) =>
    new FakeTurnConnection(openCodeId),
  shutdownAll() {
    resetFakeBackend();
  },
};

/** Clears every fake session, the scripted turn source, and the counter. */
export function resetFakeBackend(): void {
  sessions.clear();
  turnScript = undefined;
  turnCounter = 0;
}
