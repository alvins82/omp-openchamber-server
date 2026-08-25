export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

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

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
  directory?: string;
}

interface PendingPermissionEntry {
  req: PermissionRequest;
  resolve: (response: { confirmed?: boolean; cancelled?: boolean }) => void;
}

interface PendingQuestionEntry {
  req: QuestionRequest;
  resolve: (response: { value?: string; cancelled?: boolean }) => void;
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
