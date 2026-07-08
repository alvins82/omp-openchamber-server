import { randomUUID } from "node:crypto";

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

type Listener = (event: OpenCodeEvent) => void;

let listeners = new Set<Listener>();
let eventCounter = 0;

export function emitOpenCodeEvent(type: string, properties: Record<string, unknown> = {}): void {
  const event: OpenCodeEvent = { type, properties };
  for (const listener of listeners) {
    try { listener(event); } catch { /* ignore */ }
  }
}

export function subscribeOpenCodeEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function createOpenCodeEventStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const controllerRef: { current?: ReadableStreamDefaultController<Uint8Array> } = {};

  const unsubscribe = subscribeOpenCodeEvents((event) => {
    const c = controllerRef.current;
    if (!c) return;
    const id = String(++eventCounter);
    const payload = `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.properties)}\n\n`;
    try { c.enqueue(encoder.encode(payload)); } catch { /* stream may be closed */ }
  });

  const heartbeat = setInterval(() => {
    const c = controllerRef.current;
    if (!c) return;
    try { c.enqueue(encoder.encode(": heartbeat\n\n")); } catch { /* closed */ }
  }, 20_000);

  return new ReadableStream({
    start(c) {
      controllerRef.current = c;
      c.enqueue(encoder.encode(": ok\n\n"));
    },
    cancel() {
      clearInterval(heartbeat);
      unsubscribe();
      controllerRef.current = undefined;
    },
  });
}

export function formatOpenCodeEvent(type: string, properties: Record<string, unknown>): string {
  return `id: ${randomUUID()}\nevent: ${type}\ndata: ${JSON.stringify(properties)}\n\n`;
}

export function emitSessionUpdated(session: Record<string, unknown>): void {
  emitOpenCodeEvent("session.updated", { info: session });
}

export function emitSessionStatus(sessionID: string, status: { type: string }): void {
  emitOpenCodeEvent("session.status", { sessionID, status });
}

export function emitMessageUpdated(properties: Record<string, unknown>): void {
  emitOpenCodeEvent("message.updated", properties);
}

export function emitMessagePartUpdated(sessionID: string, part: Record<string, unknown>): void {
  emitOpenCodeEvent("message.part.updated", { sessionID, part });
}

export function emitMessagePartDelta(sessionID: string, messageID: string, partID: string, delta: string): void {
  emitOpenCodeEvent("message.part.delta", { sessionID, messageID, partID, field: "text", delta });
}

export function emitSessionIdle(sessionID: string): void {
  emitOpenCodeEvent("session.idle", { sessionID });
}
