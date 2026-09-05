/**
 * Backend-agnostic contracts for the provider abstraction.
 *
 * Layering rules (see docs/providers.md):
 *  - `src/providers/types.ts` (this file) is a leaf: it imports only shared
 *    src-level protocol modules (approvals) and is imported by every backend.
 *  - Backend implementations live under `src/providers/<backendId>/` and may
 *    import shared src modules, but must never import `main.ts`/`prompt.ts`.
 *  - `prompt.ts` consumes backends only through `AgentBackend` /
 *    `BackendTurnConnection` / `SessionStore` / `NormalizedTurnEvent`.
 */
import type { QuestionInfo } from "../approvals";

// ---------------------------------------------------------------------------
// Model catalog protocol (OpenCode /provider surface)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Model reference / usage
// ---------------------------------------------------------------------------

export interface ModelRef {
  providerID: string;
  modelID: string;
  variant: string;
}

/** Model ref as persisted in session records (adds the display id). */
export interface SessionModelRef extends ModelRef {
  id: string;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

// ---------------------------------------------------------------------------
// Prompt body image content
// ---------------------------------------------------------------------------

export interface ImageContent {
  type: "image";
  data: string; // base64 encoded image data
  mimeType: string;
}

export interface TurnPromptInput {
  message: string;
  images?: ImageContent[];
}

// ---------------------------------------------------------------------------
// Tool part state (SSE assembly)
// ---------------------------------------------------------------------------

export interface ToolPartState {
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  time?: { start: number; end?: number };
}

// ---------------------------------------------------------------------------
// Todo protocol
// ---------------------------------------------------------------------------

export interface OpenCodeTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: string;
}

// ---------------------------------------------------------------------------
// Session / transcript records
// ---------------------------------------------------------------------------

export interface OpenCodeSession {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  path: string;
  title?: string;
  parentID?: string;
  agent: string;
  model: SessionModelRef;
  version: string;
  time: { created: number; updated: number; archived?: number };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  metadata?: Record<string, unknown>;
}

export interface OpenCodeTextPart {
  id: string;
  type: "text" | "reasoning";
  text: string;
  time?: { start: number; end?: number };
  messageID: string;
  sessionID: string;
}

export interface OpenCodeFilePart {
  id: string;
  type: "file";
  mime?: string;
  filename?: string;
  url: string;
  messageID: string;
  sessionID: string;
}

export interface OpenCodeToolPart {
  id: string;
  type: "tool";
  callID: string;
  tool: string;
  state: {
    status: "pending" | "running" | "completed" | "error";
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    time: { start: number; end?: number };
  };
  metadata?: { toolCallId?: string };
  messageID: string;
  sessionID: string;
}

export type OpenCodePart = OpenCodeTextPart | OpenCodeToolPart | OpenCodeFilePart;

export interface OpenCodeMessageRecord {
  info: {
    id: string;
    role: string;
    sessionID: string;
    parentID?: string;
    agent: string;
    model: { id?: string; providerID: string; modelID: string; variant: string };
    providerID?: string;
    modelID?: string;
    variant?: string;
    mode?: string;
    path?: { cwd: string; root: string };
    cost?: number;
    tokens?: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    finish?: string;
    error?: unknown;
    time: { created: number; completed?: number };
  };
  parts: Array<OpenCodeTextPart | OpenCodeToolPart | OpenCodeFilePart>;
}

// ---------------------------------------------------------------------------
// Normalized turn events
//
// Backends translate their native event streams into this vocabulary; the SSE
// assembly layer in prompt.ts consumes it and keeps part-id generation, delta
// emission, heartbeats, and error formatting in one place.
//
// Contract notes:
//  - The backend OWNS usage/model aggregation: a `usage` event is a full
//    snapshot (tokens replace-if-positive happens backend-side) and MUST be
//    emitted before the terminal `turn_end`. The sink stores snapshots as-is.
//  - Respond closures for approval/question requests are bound to the
//    backend transport INSIDE the backend; the sink only decorates them with
//    SSE bookkeeping.
//  - A non-terminal `turn_end` (backend ended without a definitive terminal
//    event) is emitted by the backend after its own grace timer; the sink
//    finalizes on every `turn_end`.
// ---------------------------------------------------------------------------

export type SubagentStatus = "busy" | "idle";

export type NormalizedTurnEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "reasoning_delta"; text: string }
  | { kind: "tool"; callID: string; tool?: string; state: ToolPartState }
  | { kind: "usage"; tokens: TokenBreakdown; cost: number }
  | { kind: "model"; model: ModelRef }
  | {
      kind: "permission_request";
      id: string;
      permission: string;
      metadata: Record<string, unknown>;
      respond: (response: { confirmed?: boolean; cancelled?: boolean }) => void;
    }
  | {
      kind: "question_request";
      id: string;
      questions: QuestionInfo[];
      metadata?: Record<string, unknown>;
      respond: (response: { value?: string; cancelled?: boolean }) => void;
    }
  | {
      kind: "subagent_started";
      childId: string;
      agent?: string;
      description?: string;
      sessionFile?: string;
    }
  | { kind: "subagent_ended"; childId: string }
  | { kind: "subagent_status"; childId: string; status: SubagentStatus }
  | { kind: "todo"; todos: OpenCodeTodo[] }
  | { kind: "turn_end"; error?: string; stopReason?: string };

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/**
 * Feature matrix consulted by the sidecar to gate backend-specific routes.
 * `compact` and `shell` gate OpenCode routes that are backed by omp-RPC
 * methods (`summarize`, `bash`); a backend without them returns 501/400.
 */
export interface BackendCapabilities {
  thinkingLevels: boolean;
  images: boolean;
  approvals: boolean;
  subagents: boolean;
  todo: boolean;
  titleGeneration: boolean;
  skills: boolean;
  compact: boolean;
  shell: boolean;
}

/** Per-session live connection to one backend turn. */
export interface BackendTurnConnection {
  onEvent(sink: (event: NormalizedTurnEvent) => void): () => void;
  prompt(input: TurnPromptInput): Promise<unknown>;
  setModel(providerID: string, modelID: string): Promise<unknown>;
  /** Model currently configured on the backend session, if discoverable. */
  getInitialModel?(): Promise<ModelRef | undefined>;
  abort(): Promise<unknown>;
  kill(): void;
}

export interface SessionUpdateInput {
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { created?: number; updated?: number; archived?: number | null };
}

/** Persistent session storage owned by a backend. */
export interface SessionStore {
  create(
    directory: string | null | undefined,
    init?: { title?: string; parentID?: string },
  ): Promise<OpenCodeSession>;
  get(openCodeId: string, directory?: string | null): Promise<OpenCodeSession | null>;
  list(
    directory?: string | null,
    options?: { all?: boolean; limit?: number; archived?: boolean; search?: string },
  ): Promise<OpenCodeSession[]>;
  delete(openCodeId: string, directory?: string | null): Promise<boolean>;
  update(
    openCodeId: string,
    updates: SessionUpdateInput,
    directory?: string | null,
  ): Promise<OpenCodeSession | null>;
  setTitle(openCodeId: string, title: string, source: "auto" | "user", cwd: string): Promise<void>;
  children(parentOpenCodeId: string, directory?: string | null): Promise<OpenCodeSession[]>;
  transcript(openCodeId: string, cwd: string): Promise<OpenCodeMessageRecord[] | null>;
  /** Called before dispatching a turn (cache invalidation hooks). */
  beforeTurn?(openCodeId: string, cwd: string): void;
  recordUserMessage?(openCodeId: string, text: string, messageId?: string): void;
  getTodos?(openCodeId: string, cwd: string): Promise<OpenCodeTodo[] | undefined>;
}

/** One agent backend (omp, fake, later Claude Code / Codex). */
export interface AgentBackend {
  /** Stable backend id; also the session-id prefix for non-legacy sessions. */
  id: string;
  label: string;
  capabilities: BackendCapabilities;
  defaultModel: ModelRef;
  listModels(cwd: string): Promise<OpenCodeProvidersResponse>;
  store: SessionStore;
  createTurnConnection(
    cwd: string,
    sessionPath: string,
    openCodeId: string,
  ): Promise<BackendTurnConnection>;
  shutdownAll(): void;
}
