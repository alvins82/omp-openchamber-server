import { randomUUID } from "node:crypto";

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
  directory?: string;
}

type Listener = (event: OpenCodeEvent) => void;

let listeners = new Set<Listener>();
let eventCounter = 0;

export function emitOpenCodeEvent(
  type: string,
  properties: Record<string, unknown> = {},
  directory?: string,
): void {
  const event: OpenCodeEvent = { type, properties, directory };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore */
    }
  }
}

export function subscribeOpenCodeEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function formatOpenCodeEvent(
  type: string,
  properties: Record<string, unknown> = {},
  directory?: string,
  id?: string,
): string {
  const evtId = id ?? `evt_${randomUUID().replace(/-/g, "")}`;
  const payload = {
    id: evtId,
    type,
    properties,
  };
  const body = directory ? { directory, project: "global", payload } : { payload };
  return `data: ${JSON.stringify(body)}\n\n`;
}

export function createOpenCodeEventStream(defaultDirectory?: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const controllerRef: { current?: ReadableStreamDefaultController<Uint8Array> } = {};

  const unsubscribe = subscribeOpenCodeEvents((event) => {
    const c = controllerRef.current;
    if (!c) return;
    const id = `evt_${String(++eventCounter)}`;
    const dir = event.directory ?? defaultDirectory;
    const payload = formatOpenCodeEvent(event.type, event.properties, dir, id);
    try {
      c.enqueue(encoder.encode(payload));
    } catch {
      /* stream may be closed */
    }
  });

  const heartbeat = setInterval(() => {
    const c = controllerRef.current;
    if (!c) return;
    try {
      c.enqueue(encoder.encode(formatOpenCodeEvent("server.heartbeat", {})));
    } catch {
      /* closed */
    }
  }, 15_000);

  return new ReadableStream({
    start(c) {
      controllerRef.current = c;
      // Send initial server.connected event to trigger UI store initialization / refresh
      c.enqueue(encoder.encode(formatOpenCodeEvent("server.connected", {})));
    },
    cancel() {
      clearInterval(heartbeat);
      unsubscribe();
      controllerRef.current = undefined;
    },
  });
}

export function emitSessionCreated(session: Record<string, unknown>, directory?: string): void {
  emitOpenCodeEvent("session.created", { info: session }, directory);
}

export function emitSessionUpdated(session: Record<string, unknown>, directory?: string): void {
  emitOpenCodeEvent("session.updated", { info: session }, directory);
}

export function emitSessionDeleted(sessionID: string, directory?: string): void {
  emitOpenCodeEvent("session.deleted", { info: { id: sessionID } }, directory);
}

export function emitSessionStatus(
  sessionID: string,
  status: { type: string },
  directory?: string,
): void {
  emitOpenCodeEvent("session.status", { sessionID, status }, directory);
}

export function emitSessionError(
  sessionID: string,
  error?: unknown,
  directory?: string,
): void {
  emitOpenCodeEvent(
    "session.error",
    {
      sessionID,
      error: error instanceof Error ? { message: error.message, name: error.name } : error,
    },
    directory,
  );
}

export function emitMessageUpdated(
  properties: Record<string, unknown>,
  directory?: string,
): void {
  emitOpenCodeEvent("message.updated", properties, directory);
}

export function emitMessagePartUpdated(
  sessionID: string,
  part: Record<string, unknown>,
  directory?: string,
): void {
  emitOpenCodeEvent("message.part.updated", { sessionID, part }, directory);
}

export function emitMessagePartDelta(
  sessionID: string,
  messageID: string,
  partID: string,
  delta: string,
  directory?: string,
): void {
  emitOpenCodeEvent(
    "message.part.delta",
    { sessionID, messageID, partID, field: "text", delta },
    directory,
  );
}

export function emitSessionIdle(sessionID: string, directory?: string): void {
  emitOpenCodeEvent("session.idle", { sessionID }, directory);
}

export function emitTodoUpdated(sessionID: string, todos: unknown[], directory?: string): void {
  emitOpenCodeEvent("todo.updated", { sessionID, todos }, directory);
}

export function emitPermissionAsked(req: Record<string, unknown>, directory?: string): void {
  emitOpenCodeEvent("permission.asked", req, directory);
}

export function emitPermissionReplied(
  sessionID: string,
  permissionID: string,
  response: string,
  directory?: string,
): void {
  emitOpenCodeEvent("permission.replied", { sessionID, permissionID, response }, directory);
}

export function emitQuestionAsked(req: Record<string, unknown>, directory?: string): void {
  emitOpenCodeEvent("question.asked", req, directory);
}

export function emitQuestionReplied(
  sessionID: string,
  questionID: string,
  answers: string[][],
  directory?: string,
): void {
  emitOpenCodeEvent("question.replied", { sessionID, questionID, answers }, directory);
}

export function emitQuestionRejected(
  sessionID: string,
  questionID: string,
  directory?: string,
): void {
  emitOpenCodeEvent("question.rejected", { sessionID, questionID }, directory);
}
