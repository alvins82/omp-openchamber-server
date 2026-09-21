import type { BackendCredentialInput, ImageContent, ModelRef } from "../../providers/types";

/**
 * The small, durable contract between Jarvisbot and this sidecar.
 *
 * Jarvis owns the authoritative session/turn/run ids. The sidecar only owns
 * the provider binding (OMP session path) and translates host-tool frames.
 */
export interface JarvisToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
  loadMode?: "essential" | "discoverable";
  /** Jarvis policy metadata; OMP never executes the tool itself. */
  requiresApproval?: boolean;
  category?: string;
}

export interface JarvisSessionCreateInput {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  /** Existing OMP JSONL session path, when the caller already has one. */
  sessionPath?: string;
  /** Explicit alias for callers that want to name the provider boundary. */
  providerSessionPath?: string;
  model?: Partial<ModelRef> & { providerID: string; modelID: string };
  tools?: JarvisToolDefinition[];
  credentialRef?: string;
  /** Raw credentials are accepted for local/trusted callers but never persisted. */
  credentials?: BackendCredentialInput["credentials"];
}

export interface JarvisTurnStartInput {
  turnId: string;
  attemptId: string;
  prompt: string;
  images?: ImageContent[];
  model?: Partial<ModelRef> & { providerID: string; modelID: string };
  tools?: JarvisToolDefinition[];
  /** Alias used by Jarvisbot's run contract. */
  boundCapabilities?: JarvisToolDefinition[];
  workerLeaseEpoch?: number;
  idempotencyKey?: string;
}

export interface JarvisCancelInput {
  turnId?: string;
  attemptId?: string;
  reason?: string;
}

export interface JarvisActionResultInput {
  turnId?: string;
  attemptId?: string;
  callId?: string;
  success: boolean;
  result?: unknown;
  error?: string;
  details?: unknown;
}

export interface JarvisActionUpdateInput {
  turnId?: string;
  attemptId?: string;
  callId?: string;
  partialResult: unknown;
}

export type JarvisSessionStatus =
  | "registered"
  | "starting"
  | "idle"
  | "running"
  | "waiting_tool"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "recovery_required";

export type JarvisEventType =
  | "session.registered"
  | "session.connected"
  | "session.reconnected"
  | "session.disconnected"
  | "session.error"
  | "turn.accepted"
  | "turn.started"
  | "text_delta"
  | "tool_call_proposed"
  | "tool_call_update"
  | "tool_call_cancelled"
  | "tool_result_submitted"
  | "turn.cancel_requested"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled";

export interface JarvisEvent {
  eventId: string;
  sequence: number;
  sessionId: string;
  turnId?: string;
  attemptId?: string;
  type: JarvisEventType;
  /** All events emitted by this adapter are safe for the Jarvis event stream. */
  visibility: "public";
  data: Record<string, unknown>;
  createdAt: string;
}

export interface JarvisPendingAction {
  providerRequestId: string;
  providerToolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  turnId?: string;
  attemptId?: string;
}

export interface JarvisProviderBinding {
  backend: "omp";
  openCodeId: string;
  sessionPath: string;
}

export interface JarvisSessionSnapshot {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  status: JarvisSessionStatus;
  provider: JarvisProviderBinding;
  model?: ModelRef;
  activeTurn?: {
    turnId: string;
    attemptId: string;
    workerLeaseEpoch?: number;
    startedAt: string;
  };
  pendingActions: JarvisPendingAction[];
  lastSequence: number;
  connected: boolean;
  recoveryRequired: boolean;
}
