import type { QuestionInfo, QuestionOption } from "../../shared/contracts";

export type { QuestionInfo, QuestionOption } from "../../shared/contracts";

export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
  directory?: string;
}

export function toOpenCodePermissionRequest(request: PermissionRequest) {
  return {
    id: request.id,
    sessionID: request.sessionID,
    action: request.permission,
    resources: request.patterns,
    save: request.always,
    metadata: request.metadata,
    ...(request.tool ? {
      source: { type: "tool" as const, messageID: request.tool.messageID, id: request.tool.callID },
    } : {}),
    ...(typeof request.metadata.message === "string" ? { message: request.metadata.message } : {}),
  };
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
  directory?: string;
}

/**
 * Adapts the sidecar's legacy question request to OpenCode's typed form wire
 * shape. Field keys are stable for the lifetime of the request so a reply can
 * be mapped back to the original question order.
 */
export function toOpenCodeFormRequest(request: QuestionRequest) {
  return {
    id: request.id,
    sessionID: request.sessionID,
    title: request.questions[0]?.header || "Input needed",
    fields: request.questions.map((question, index) => ({
      key: `question_${index + 1}`,
      title: question.question,
      type: question.multiple ? "multiselect" : "string",
      required: true,
      custom: question.custom ?? false,
      options: question.options.map((option) => ({
        value: option.label,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    })),
  };
}

/** Converts a typed form answer into the legacy question tool's ordered values. */
export function toQuestionAnswers(
  request: QuestionRequest,
  answer: Record<string, unknown>,
): string[][] {
  return request.questions.map((_, index) => {
    const value = answer[`question_${index + 1}`];
    if (Array.isArray(value)) return value.map((entry) => String(entry));
    if (typeof value === "string") return value.length > 0 ? [value] : [];
    if (typeof value === "number" || typeof value === "boolean") return [String(value)];
    return [];
  });
}

interface PendingPermissionEntry {
  req: PermissionRequest;
  resolve: (response: { confirmed?: boolean; cancelled?: boolean }) => void;
}

interface PendingQuestionEntry {
  req: QuestionRequest;
  resolve: (response: { value?: string; cancelled?: boolean }) => void;
}

export interface PendingBlockingRequestsSnapshotEntry {
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
}

const pendingPermissions = new Map<string, PendingPermissionEntry>();
const pendingQuestions = new Map<string, PendingQuestionEntry>();
const autoAcceptSessions = new Map<string, boolean>();
let autoAcceptRevision = 0;

export function getAutoAcceptPolicy(): { sessions: Record<string, boolean>; revision: number } {
  return {
    sessions: Object.fromEntries(autoAcceptSessions.entries()),
    revision: autoAcceptRevision,
  };
}

export function setSessionAutoAccept(sessionId: string, enabled: boolean): { sessions: Record<string, boolean>; revision: number } {
  autoAcceptSessions.set(sessionId, enabled);
  autoAcceptRevision++;
  if (enabled) {
    // Auto-resolve any currently pending permissions for this session
    for (const [id, entry] of pendingPermissions) {
      if (entry.req.sessionID === sessionId) {
        pendingPermissions.delete(id);
        entry.resolve({ confirmed: true });
      }
    }
  }
  return getAutoAcceptPolicy();
}

export function addPendingPermission(
  req: PermissionRequest,
  resolve: (response: { confirmed?: boolean; cancelled?: boolean }) => void,
): void {
  if (autoAcceptSessions.get(req.sessionID) === true) {
    resolve({ confirmed: true });
    return;
  }
  pendingPermissions.set(req.id, { req, resolve });
}

export function addPendingQuestion(
  req: QuestionRequest,
  resolve: (response: { value?: string; cancelled?: boolean }) => void,
): void {
  pendingQuestions.set(req.id, { req, resolve });
}

export function listPendingPermissions(directory?: string | null): PermissionRequest[] {
  const result: PermissionRequest[] = [];
  for (const entry of pendingPermissions.values()) {
    if (!directory || entry.req.directory === directory) {
      result.push(entry.req);
    }
  }
  return result;
}

export function listPendingQuestions(directory?: string | null): QuestionRequest[] {
  const result: QuestionRequest[] = [];
  for (const entry of pendingQuestions.values()) {
    if (!directory || entry.req.directory === directory) {
      result.push(entry.req);
    }
  }
  return result;
}

/**
 * Returns the pending blocking requests in the shape used by OpenChamber's
 * cross-project session-status snapshot. The snapshot is keyed by session so
 * a client that has not initialized that session's directory can still show
 * its permission or question request.
 */
export function getPendingBlockingRequestsSnapshot(): Record<string, PendingBlockingRequestsSnapshotEntry> {
  const result: Record<string, PendingBlockingRequestsSnapshotEntry> = {};

  const entryFor = (sessionID: string): PendingBlockingRequestsSnapshotEntry => {
    const existing = result[sessionID];
    if (existing) return existing;
    const created: PendingBlockingRequestsSnapshotEntry = { permissions: [], questions: [] };
    result[sessionID] = created;
    return created;
  };

  for (const request of listPendingPermissions()) {
    entryFor(request.sessionID).permissions.push(request);
  }
  for (const request of listPendingQuestions()) {
    entryFor(request.sessionID).questions.push(request);
  }

  return result;
}

export function getPendingPermission(id: string): PermissionRequest | undefined {
  return pendingPermissions.get(id)?.req;
}

export function getPendingQuestion(id: string): QuestionRequest | undefined {
  return pendingQuestions.get(id)?.req;
}

export function replyPermission(
  id: string,
  reply: "once" | "always" | "reject",
): boolean {
  const entry = pendingPermissions.get(id);
  if (!entry) return false;
  pendingPermissions.delete(id);

  if (reply === "reject") {
    entry.resolve({ confirmed: false, cancelled: true });
  } else {
    entry.resolve({ confirmed: true });
  }
  return true;
}

export function replyQuestion(id: string, answers: string[][]): boolean {
  const entry = pendingQuestions.get(id);
  if (!entry) return false;
  pendingQuestions.delete(id);

  const flatAnswer = answers.map((a) => a.join(", ")).join("; ");
  entry.resolve({ value: flatAnswer });
  return true;
}

export function rejectQuestion(id: string): boolean {
  const entry = pendingQuestions.get(id);
  if (!entry) return false;
  pendingQuestions.delete(id);

  entry.resolve({ cancelled: true });
  return true;
}

export function clearSessionApprovals(sessionID: string): void {
  for (const [id, entry] of pendingPermissions) {
    if (entry.req.sessionID === sessionID) {
      entry.resolve({ cancelled: true });
      pendingPermissions.delete(id);
    }
  }
  for (const [id, entry] of pendingQuestions) {
    if (entry.req.sessionID === sessionID) {
      entry.resolve({ cancelled: true });
      pendingQuestions.delete(id);
    }
  }
}

export function resetApprovals(): void {
  for (const entry of pendingPermissions.values()) {
    entry.resolve({ cancelled: true });
  }
  for (const entry of pendingQuestions.values()) {
    entry.resolve({ cancelled: true });
  }
  pendingPermissions.clear();
  pendingQuestions.clear();
}
