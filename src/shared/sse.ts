import { randomUUID } from "node:crypto";
import type { BrowserControlRequest } from "./contracts";
import { toV2Session } from "../adapters/openchamber/v2";
import { backendForSession, isMultiBackend } from "../providers/registry";

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
  directory?: string;
  wire?: { type: string; data: Record<string, unknown>; created: number; id?: string };
  suppressWire?: boolean;
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
const failedTurns = new Set<string>();
const v2UserMessageIDs = new Set<string>();
const v2AssistantStepIDs = new Set<string>();
let eventCounter = 0;
const durableSequences = new Map<string, number>();
const durableEventVersions: Record<string, number> = {
  "session.created": 1,
  "session.agent.selected": 1,
  "session.model.selected": 1,
  "session.moved": 1,
  "session.revert.staged": 1,
  "session.revert.cleared": 1,
  "session.revert.committed": 1,
  "session.moved": 1,
  "session.renamed": 1,
  "session.permissions": 1,
  "session.viewed": 1,
  "session.deleted": 2,
  "session.forked": 2,
  "session.inbox.delivered": 1,
  "session.inbox.enqueued": 1,
  "session.inbox.cancelled": 1,
  "session.inbox.delivery.changed": 1,
  "session.execution.started": 1,
  "session.execution.succeeded": 1,
  "session.execution.failed": 1,
  "session.execution.interrupted": 1,
  "session.synthetic": 1,
  "session.skill.activated": 1,
  "session.shell.started": 1,
  "session.shell.ended": 1,
  "session.step.started": 1,
  "session.step.streamed": 1,
  "session.step.ended": 1,
  "session.step.failed": 1,
  "session.text.started": 1,
  "session.text.ended": 1,
  "session.reasoning.started": 1,
  "session.reasoning.ended": 1,
  "session.tool.input.started": 1,
  "session.tool.input.ended": 1,
  "session.tool.called": 1,
  "session.tool.success": 2,
  "session.tool.failed": 2,
  "session.retry.scheduled": 1,
  "session.compaction.started": 1,
  "session.compaction.ended": 1,
  "session.compaction.failed": 1,
  "session.revert.staged": 1,
  "session.revert.cleared": 1,
  "session.revert.committed": 1,
  "session.usage.recorded": 1,
  "session.message.content.updated": 1,
};

function nextEventId(): string {
  eventCounter += 1;
  return `evt_${eventCounter}`;
}

export function emitOpenCodeEvent(
  type: string,
  properties: Record<string, unknown> = {},
  directory?: string,
  options?: { suppressWire?: boolean },
): void {
  const event: OpenCodeEvent = { type, properties, directory };
  event.suppressWire = options?.suppressWire;
  const sessionID = typeof properties.sessionID === "string"
    ? properties.sessionID
    : typeof asRecord(properties.info).sessionID === "string"
      ? asRecord(properties.info).sessionID as string
      : undefined;
  if (type === "session.error" && sessionID) failedTurns.add(sessionID);
  if (type === "session.status") {
    const status = asRecord(properties.status).type;
    if (status === "busy" && sessionID) failedTurns.delete(sessionID);
    if (status === "idle") event.suppressWire = true;
  }
  if (type === "message.updated" && asRecord(properties.info).role === "user") event.suppressWire = true;
  if (type === "message.updated" && asRecord(properties.info).role === "assistant") {
    const info = asRecord(properties.info);
    if (typeof info.id === "string" && info.finish === undefined) {
      if (v2AssistantStepIDs.has(info.id)) event.suppressWire = true;
      else {
        v2AssistantStepIDs.add(info.id);
        if (v2AssistantStepIDs.size > 4096) v2AssistantStepIDs.delete(v2AssistantStepIDs.values().next().value!);
      }
    }
  }
  if (type === "message.part.updated") {
    const part = asRecord(properties.part);
    if (typeof part.messageID === "string" && v2UserMessageIDs.has(part.messageID)) event.suppressWire = true;
  }
  if (type === "message.part.updated" && asRecord(properties.part).type === "file") event.suppressWire = true;
  if (type === "session.idle" && sessionID) {
    const failed = failedTurns.delete(sessionID);
    const aborted = properties.aborted === true;
    event.wire = {
      type: failed ? "session.idle" : aborted ? "session.execution.interrupted" : "session.execution.succeeded",
      data: { sessionID, ...(aborted ? { reason: "user" } : {}) },
      created: Date.now(),
    };
  }
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore */
    }
  }
}

/** Emit a v2 wire event while keeping the legacy internal event bus intact. */
export function emitOpenCodeV2Event(
  type: string,
  data: Record<string, unknown>,
  directory?: string,
  id?: string,
): void {
  if (type === "session.inbox.enqueued" && typeof data.inboxID === "string") {
    v2UserMessageIDs.add(data.inboxID);
    if (v2UserMessageIDs.size > 4096) v2UserMessageIDs.delete(v2UserMessageIDs.values().next().value!);
  }
  const event: OpenCodeEvent = {
    type,
    properties: data,
    directory,
    wire: { type, data, created: Date.now(), id },
  };
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
  return formatWireEvent({ type, properties, directory }, evtId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function v2Envelope(
  event: OpenCodeEvent,
  id: string,
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const aggregateID = typeof data.sessionID === "string" ? data.sessionID : undefined;
  const durableVersion = durableEventVersions[type];
  const durable = aggregateID && durableVersion
    ? { aggregateID, seq: (durableSequences.get(aggregateID) ?? 0) + 1, version: durableVersion }
    : undefined;
  if (durable && aggregateID) durableSequences.set(aggregateID, durable.seq);
  return {
    id,
    type,
    created: event.wire?.created ?? Date.now(),
    ...(event.directory ? { location: { directory: event.directory } } : {}),
    ...(durable ? { durable } : {}),
    data,
  };
}

function messageOrdinal(partID: unknown): number {
  if (typeof partID !== "string") return 0;
  const match = partID.match(/_(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function v2ProviderID(sessionID: string | undefined, providerID: unknown): string {
  const native = typeof providerID === "string" ? providerID : "omp";
  return sessionID && isMultiBackend() ? `${backendForSession(sessionID).id}/${native}` : native;
}

function toV2WireEvent(event: OpenCodeEvent, id: string): Record<string, unknown> {
  if (event.wire) return v2Envelope(event, event.wire.id ?? id, event.wire.type, event.wire.data);
  const p = event.properties;
  const info = asRecord(p.info);
  const sessionID = typeof p.sessionID === "string" ? p.sessionID :
    (typeof info.sessionID === "string" ? info.sessionID : undefined);
  const location = event.directory ? { directory: event.directory } : undefined;
  const eventWithLocation = (type: string, data: Record<string, unknown>) => v2Envelope(event, id, type, data);

  switch (event.type) {
    case "server.connected":
    case "server.heartbeat":
      return eventWithLocation(event.type, {});
    case "session.created": {
      const session = toV2Session(info as never);
      return eventWithLocation("session.created", {
        projectID: session.projectID,
        sessionID: session.id,
        location: session.location ?? location ?? { directory: event.directory ?? process.cwd() },
        slug: info.slug ?? session.id,
        version: info.version ?? "1",
        parentID: session.parentID,
        agent: session.agent,
        model: session.model,
        title: session.title,
        metadata: session.metadata,
        permissions: session.permissions,
        subpath: session.subpath,
      });
    }
    case "session.deleted":
      return eventWithLocation("session.deleted", { sessionID: asRecord(p.info).id ?? sessionID });
    case "session.updated":
      if (typeof info.title === "string") {
        return eventWithLocation("session.renamed", { sessionID: info.id ?? sessionID, title: info.title });
      }
      if (info.model && typeof info.model === "object") {
        const model = asRecord(info.model);
        return eventWithLocation("session.model.selected", {
          sessionID: info.id ?? sessionID,
          model: {
            id: model.modelID ?? model.id,
            providerID: v2ProviderID(sessionID, model.providerID),
            variant: model.variant,
          },
        });
      }
      return eventWithLocation("session.usage.updated", {
        sessionID: info.id ?? sessionID,
        cost: info.cost ?? 0,
        tokens: info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });
    case "session.status": {
      const status = asRecord(p.status);
      return status.type === "busy"
        ? eventWithLocation("session.execution.started", { sessionID })
        : eventWithLocation("session.status", { sessionID, status: { type: "idle" } });
    }
    case "session.idle":
      return eventWithLocation("session.idle", { sessionID });
    case "session.error": {
      const rawError = asRecord(p.error);
      const error = typeof p.error === "string" ? { type: "Error", message: p.error } : {
        type: typeof rawError.name === "string" ? rawError.name : "Error",
        message: typeof rawError.message === "string" ? rawError.message : "The agent turn failed",
      };
      return eventWithLocation("session.execution.failed", { sessionID, error });
    }
    case "message.updated": {
      const role = info.role;
      if (role === "user") return eventWithLocation("session.inbox.enqueued", {
        sessionID,
        inboxID: info.id,
        item: { type: "user", payload: { text: "", files: [] }, delivery: "queue" },
      });
      if (role === "synthetic") return eventWithLocation("session.synthetic", {
        sessionID,
        text: info.text ?? "",
        description: info.description,
      });
      if (role === "assistant") {
        const model = asRecord(info.model);
        const assistantMessageID = info.id;
        if (info.finish === "error") {
          const rawError = asRecord(info.error);
          return eventWithLocation("session.step.failed", {
            sessionID,
            assistantMessageID,
            error: typeof info.error === "string"
              ? { type: "Error", message: info.error }
              : {
                  type: typeof rawError.name === "string" ? rawError.name : "Error",
                  message: typeof rawError.message === "string" ? rawError.message : "The assistant step failed",
                },
          });
      }
      if (info.finish !== undefined) {
        const finish = typeof info.finish === "string" && ["stop", "length", "tool-calls", "content-filter", "error", "unknown"].includes(info.finish)
          ? info.finish
          : info.finish === "toolUse" || info.finish === "tool_call" || info.finish === "tool_calls"
            ? "tool-calls"
            : info.finish === "end_turn" || info.finish === "completed" ? "stop" : "unknown";
        return eventWithLocation("session.step.ended", {
            sessionID,
            assistantMessageID,
            finish,
            ...(finish === "unknown" && typeof info.finish === "string" ? { rawFinish: info.finish } : {}),
            cost: typeof info.cost === "number" ? info.cost : 0,
            tokens: info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          });
        }
        return eventWithLocation("session.step.started", {
          sessionID,
          assistantMessageID,
          agent: info.agent ?? "omp",
          started: asRecord(info.time).created ?? Date.now(),
          model: {
            id: model.modelID ?? model.id ?? "omp",
            providerID: v2ProviderID(sessionID, model.providerID),
            variant: model.variant ?? "default",
          },
        });
      }
      return eventWithLocation(event.type, p);
    }
    case "message.part.updated": {
      const part = asRecord(p.part);
      const type = part.type;
      const common = {
        sessionID: part.sessionID ?? sessionID,
        assistantMessageID: part.messageID,
      };
      if (type === "text" || type === "reasoning") {
        const ordinal = messageOrdinal(part.id);
        const base = { ...common, ordinal };
        const prefix = type === "reasoning" ? "session.reasoning" : "session.text";
        if (asRecord(part.time).end !== undefined) {
          return eventWithLocation(`${prefix}.ended`, { ...base, text: part.text ?? "" });
        }
        // A legacy part snapshot begins with the first token already included.
        return eventWithLocation(`${prefix}.started`, base);
      }
      if (type === "tool") {
        const state = asRecord(part.state);
        const callID = part.callID ?? part.id;
        const tool = typeof part.tool === "string" ? part.tool : "tool";
        if (state.status === "completed") return eventWithLocation("session.tool.success", {
          ...common, id: callID, content: [{ type: "text", text: state.output ?? "" }], metadata: {}, executed: true,
        });
        if (state.status === "error") {
          const error = asRecord(state.error);
          return eventWithLocation("session.tool.failed", {
            ...common,
            id: callID,
            error: {
              type: typeof error.name === "string" ? error.name : "Error",
              message: typeof state.error === "string"
                ? state.error
                : typeof error.message === "string"
                  ? error.message
                  : typeof state.output === "string" ? state.output : "tool failed",
            },
            metadata: {},
            executed: true,
          });
        }
        if (state.status === "running") return eventWithLocation("session.tool.called", {
          ...common, id: callID, name: tool, input: state.input ?? {}, executed: true,
        });
        return eventWithLocation("session.tool.input.started", { ...common, id: callID, name: tool });
      }
      return eventWithLocation(event.type, p);
    }
    case "message.part.delta": {
      const partID = p.partID;
      const type = p.field === "raw"
        ? "session.tool.input.delta"
        : p.field === "reasoning" ? "session.reasoning.delta" : "session.text.delta";
      return eventWithLocation(type, {
        sessionID,
        assistantMessageID: p.messageID,
        ...(type === "session.tool.input.delta" ? { id: partID } : { ordinal: messageOrdinal(partID) }),
        delta: p.delta ?? "",
      });
    }
    case "permission.asked": {
      const request = p;
      return eventWithLocation("permission.asked", {
        id: request.id,
        sessionID: request.sessionID,
        action: request.action ?? request.permission,
        resources: request.resources ?? request.patterns ?? [],
        save: request.save ?? request.always ?? [],
        metadata: request.metadata ?? {},
        source: request.source,
        message: request.message,
      });
    }
    case "permission.replied":
      return eventWithLocation("permission.replied", {
        sessionID,
        requestID: p.requestID ?? p.permissionID,
        reply: p.reply ?? p.response ?? "once",
      });
    case "form.created":
      return eventWithLocation("form.created", { form: p.form });
    case "question.replied":
      return eventWithLocation("form.replied", {
        sessionID,
        id: p.questionID,
        answer: Array.isArray(p.answers)
          ? Object.fromEntries(p.answers.map((answer, index) => [`question_${index + 1}`, answer]))
          : {},
      });
    case "question.rejected":
      return eventWithLocation("form.cancelled", { sessionID, id: p.questionID });
    case "form.settled":
      return eventWithLocation("form.replied", { sessionID, id: p.formID, answer: {} });
    case "session.next.compaction.started":
    case "session.compaction.started":
      return eventWithLocation("session.compaction.started", { sessionID, reason: "manual", recent: "" });
    case "session.compacted":
    case "session.next.compaction.ended":
      return eventWithLocation("session.compaction.ended", { sessionID, reason: "manual", text: "", recent: "" });
    default:
      return eventWithLocation(event.type, p);
  }
}

function toV2WireEvents(event: OpenCodeEvent, id: string): Record<string, unknown>[] {
  const supported = new Set([
    "server.connected", "server.heartbeat", "session.created", "session.deleted", "session.renamed",
    "session.agent.selected", "session.model.selected", "session.moved", "session.usage.updated", "session.status", "session.idle",
    "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
    "session.step.started", "session.step.streamed", "session.step.ended", "session.step.failed",
    "session.shell.started", "session.shell.ended",
    "session.revert.staged", "session.revert.cleared", "session.revert.committed",
    "session.inbox.enqueued", "session.synthetic", "session.text.started", "session.text.delta", "session.text.ended",
    "session.reasoning.started", "session.reasoning.delta", "session.reasoning.ended", "session.tool.input.started",
    "session.tool.input.delta", "session.tool.input.ended", "session.tool.called", "session.tool.success",
    "session.tool.failed", "session.compaction.started", "session.compaction.ended", "permission.asked",
    "permission.replied", "form.created", "form.replied", "form.cancelled",
  ]);
  if (event.suppressWire) return [];
  if (event.type === "form.settled" || event.type === "session.next.compaction.ended") return [];
  if (event.type === "message.part.updated") {
    const part = asRecord(event.properties.part);
    const partType = part.type;
    const time = asRecord(part.time);
    if ((partType === "text" || partType === "reasoning") && time.end === undefined) {
      const ordinal = messageOrdinal(part.id);
      const common = {
        sessionID: part.sessionID ?? event.properties.sessionID,
        assistantMessageID: part.messageID,
        ordinal,
      };
      const prefix = partType === "reasoning" ? "session.reasoning" : "session.text";
      const start = v2Envelope(event, id, `${prefix}.started`, common);
      const text = typeof part.text === "string" ? part.text : "";
      return text
        ? [start, v2Envelope(event, `${id}_delta`, `${prefix}.delta`, { ...common, delta: text })]
        : [start];
    }
  }
  const payload = toV2WireEvent(event, id);
  return typeof payload.type === "string" && supported.has(payload.type) ? [payload] : [];
}

function formatWireEvent(event: OpenCodeEvent, id: string): string {
  return toV2WireEvents(event, id).map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
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
    const payload = event.type.startsWith("openchamber:")
      ? formatOpenCodeEvent(event.type, event.properties, dir, id)
      : formatWireEvent({ ...event, directory: dir }, id);
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
    if (event.type.startsWith("openchamber:")) {
      send({ type: "event", eventId, directory, payload: { type: event.type, properties: event.properties } });
      return;
    }
    for (const [index, payload] of toV2WireEvents({ ...event, directory }, eventId).entries()) {
      send({ type: "event", eventId: index === 0 ? eventId : `${eventId}_${index}`, directory, payload });
    }
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
  emitOpenCodeEvent("session.updated", { info: session }, directory, { suppressWire: true });
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
  field: "text" | "reasoning" | "raw" = "text",
): void {
  emitOpenCodeEvent(
    "message.part.delta",
    { sessionID, messageID, partID, field, delta },
    directory,
  );
}

export function emitSessionIdle(sessionID: string, directory?: string, aborted = false): void {
  emitOpenCodeEvent("session.idle", { sessionID, ...(aborted ? { aborted: true } : {}) }, directory);
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

export function emitFormCreated(form: Record<string, unknown>, directory?: string): void {
  emitOpenCodeEvent("form.created", { form }, directory);
}

export function emitFormSettled(sessionID: string, formID: string, directory?: string): void {
  emitOpenCodeEvent("form.settled", { sessionID, formID }, directory);
}

export function emitSessionCompactionStarted(sessionID: string, directory?: string): void {
  emitOpenCodeEvent("session.next.compaction.started", { sessionID }, directory);
}

export function emitSessionCompacted(sessionID: string, directory?: string): void {
  emitOpenCodeEvent("session.compacted", { sessionID }, directory);
  emitOpenCodeEvent("session.next.compaction.ended", { sessionID }, directory);
}
