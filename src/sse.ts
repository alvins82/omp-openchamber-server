import { randomUUID } from "node:crypto";
import type { BrowserControlRequest } from "./browser-control";

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
  directory?: string;
}

type Listener = (event: OpenCodeEvent) => void;

interface SseClient {
  id: string;
  directory?: string;
  browserCapable: boolean;
  isOpenChamber: boolean;
  enqueue: (chunk: string) => void;
}

export interface OpenCodeEventWebSocket {
  sendText(data: string): unknown;
}

const listeners = new Set<Listener>();
const activeClients = new Set<SseClient>();
let eventCounter = 0;

function nextEventId(): string {
  eventCounter += 1;
  return `evt_${eventCounter}`;
}

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
  if (type.startsWith("openchamber:")) {
    return `data: ${JSON.stringify({ type, properties })}\n\n`;
  }
  const evtId = id ?? `evt_${randomUUID().replace(/-/g, "")}`;
  const payload = {
    id: evtId,
    type,
    properties,
  };
  const body = directory ? { directory, project: "global", payload } : { payload };
  return `data: ${JSON.stringify(body)}\n\n`;
}

export function emitBrowserControlRequest(request: BrowserControlRequest): number {
  const eventText = `data: ${JSON.stringify({
    type: "openchamber:browser-control-request",
    properties: {
      requestId: request.requestId,
      action: request.action,
      directory: request.directory,
      parameters: {
        ...request.parameters,
        ...(request.directory ? { directory: request.directory } : {}),
      },
    },
  })}\n\n`;

  const needsBrowserView = request.action !== "browser.open";
  let delivered = 0;

  for (const client of activeClients) {
    if (needsBrowserView && !client.browserCapable) {
      continue;
    }
    try {
      client.enqueue(eventText);
      delivered += 1;
    } catch {
      /* ignore */
    }
  }

  return delivered;
}

export function getActiveSseClientCount(): number {
  return activeClients.size;
}

export function createOpenCodeEventStream(
  defaultDirectory?: string,
  options?: { browserCapable?: boolean; isOpenChamber?: boolean },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const controllerRef: { current?: ReadableStreamDefaultController<Uint8Array> } = {};
  const clientId = `client_${randomUUID()}`;
  const browserCapable = options?.browserCapable ?? true;
  const isOpenChamber = options?.isOpenChamber ?? false;

  const client: SseClient = {
    id: clientId,
    directory: defaultDirectory,
    browserCapable,
    isOpenChamber,
    enqueue: (chunk: string) => {
      const c = controllerRef.current;
      if (c) {
        try {
          c.enqueue(encoder.encode(chunk));
        } catch {
          /* stream may be closed */
        }
      }
    },
  };

  const unsubscribe = subscribeOpenCodeEvents((event) => {
    const c = controllerRef.current;
    if (!c) return;
    const id = nextEventId();
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
      if (isOpenChamber) {
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "openchamber:heartbeat", properties: {} })}\n\n`));
      } else {
        c.enqueue(encoder.encode(formatOpenCodeEvent("server.heartbeat", {})));
      }
    } catch {
      /* closed */
    }
  }, 15_000);

  return new ReadableStream({
    start(c) {
      controllerRef.current = c;
      activeClients.add(client);
      if (isOpenChamber) {
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "openchamber:event-stream-ready", properties: {} })}\n\n`));
      } else {
        // Send initial server.connected event to trigger UI store initialization / refresh
        c.enqueue(encoder.encode(formatOpenCodeEvent("server.connected", {})));
      }
    },
    cancel() {
      clearInterval(heartbeat);
      activeClients.delete(client);
      unsubscribe();
      controllerRef.current = undefined;
    },
  });
}

/**
 * Attach the browser-facing global-event WebSocket protocol to a socket.
 *
 * The OpenChamber client expects a `ready` frame followed by JSON `event`
 * frames. OMP itself remains SSE-backed; this is only a transport adapter for
 * the browser connection.
 */
export function attachOpenCodeEventWebSocket(
  socket: OpenCodeEventWebSocket,
  defaultDirectory?: string,
): () => void {
  let closed = false;
  const send = (frame: Record<string, unknown>): boolean => {
    if (closed) return false;
    try {
      socket.sendText(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  };

  const sendEvent = (event: OpenCodeEvent): void => {
    const eventId = nextEventId();
    const directory = event.directory ?? defaultDirectory ?? "global";
    send({
      type: "event",
      eventId,
      directory,
      payload: {
        id: eventId,
        type: event.type,
        properties: event.properties,
      },
    });
  };

  const unsubscribe = subscribeOpenCodeEvents(sendEvent);
  const heartbeat = setInterval(() => {
    sendEvent({ type: "server.heartbeat", properties: {}, directory: defaultDirectory });
  }, 15_000);

  send({ type: "ready" });
  sendEvent({ type: "server.connected", properties: {}, directory: defaultDirectory });

  return () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
}

/** Notification-only SSE stream used by the web runtime's optional notifier. */
export function createOpenChamberNotificationStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const controllerRef: { current?: ReadableStreamDefaultController<Uint8Array> } = {};
  let closed = false;

  const write = (payload: Record<string, unknown>): void => {
    const controller = controllerRef.current;
    if (!controller || closed) return;
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    } catch {
      // The browser may close the stream between the check and enqueue.
    }
  };

  const unsubscribe = subscribeOpenCodeEvents((event) => {
    if (event.type === "openchamber:notification") {
      write({ type: event.type, properties: event.properties });
    }
  });

  const heartbeat = setInterval(() => {
    const controller = controllerRef.current;
    if (!controller || closed) return;
    try {
      controller.enqueue(encoder.encode(":heartbeat\n\n"));
    } catch {
      // The browser may close the stream between the check and enqueue.
    }
  }, 20_000);

  return new ReadableStream({
    start(controller) {
      controllerRef.current = controller;
      write({ type: "openchamber:notification-stream-ready", properties: {} });
    },
    cancel() {
      closed = true;
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

export function emitSessionCompactionStarted(sessionID: string, directory?: string): void {
  emitOpenCodeEvent("session.next.compaction.started", { sessionID }, directory);
}

export function emitSessionCompacted(sessionID: string, directory?: string): void {
  emitOpenCodeEvent("session.compacted", { sessionID }, directory);
  emitOpenCodeEvent("session.next.compaction.ended", { sessionID }, directory);
}
