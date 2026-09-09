import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { backendForSession } from "./providers/registry";
import { promptSessionAsync, getSessionStatusMap } from "./prompt";
import { emitOpenCodeEvent, subscribeOpenCodeEvents } from "./sse";

const MAX_SESSIONS = 50;
const MAX_ITEMS_PER_SESSION = 20;
const CONTENT_CHAR_LIMIT = 200_000;
const RETRY_DELAY_MS = 2_000;
const HOLD_DEFAULT_TTL_MS = 5 * 60 * 1000;
const HOLD_MAX_TTL_MS = 10 * 60 * 1000;

type QueueSendConfig = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

type QueueAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  source: "local" | "server" | "vscode";
  serverPath?: string;
  dataUrl?: string;
};

type QueueContextPart = {
  kind: "context" | "instruction" | "synthetic";
  text: string;
  metadata?: Record<string, unknown>;
  instructions?: string;
};

type QueueItem = {
  id: string;
  createdAt: number;
  content: string;
  text: string;
  agentMention?: string;
  attachments: QueueAttachment[];
  context: QueueContextPart[];
  sendConfig: QueueSendConfig;
};

type QueueEntry = {
  directory: string;
  items: QueueItem[];
};

type PublicQueueItem = Omit<QueueItem, "attachments" | "context"> & {
  attachments: Array<Omit<QueueAttachment, "dataUrl">>;
};

type QueueSession = {
  sessionId: string;
  directory: string;
  items: PublicQueueItem[];
  sendingId: string | null;
};

type QueueSnapshot = {
  revision: number;
  sessions: QueueSession[];
};

type QueueSessionResponse = {
  revision: number;
  session: QueueSession;
};

type QueueTakeResponse = QueueSessionResponse & { item: QueueItem };
type QueueTakeAllResponse = QueueSessionResponse & { items: QueueItem[] };

class QueueError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "QueueError";
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function parseSendConfig(value: unknown): QueueSendConfig {
  const raw = asRecord(value);
  const providerID = asNonEmptyString(raw?.providerID);
  const modelID = asNonEmptyString(raw?.modelID);
  if (!providerID || !modelID) throw new QueueError("item sendConfig with providerID and modelID is required", 400);

  const sendConfig: QueueSendConfig = { providerID, modelID };
  const agent = asNonEmptyString(raw?.agent);
  const variant = asNonEmptyString(raw?.variant);
  if (agent) sendConfig.agent = agent;
  if (variant) sendConfig.variant = variant;
  return sendConfig;
}

function parseAttachment(value: unknown, index: number): QueueAttachment {
  const raw = asRecord(value);
  const filename = asNonEmptyString(raw?.filename);
  const mimeType = asNonEmptyString(raw?.mimeType);
  if (!filename || !mimeType) throw new QueueError(`invalid attachment at index ${index}`, 400);

  const source = raw?.source === "server" || raw?.source === "vscode" ? raw.source : "local";
  const attachment: QueueAttachment = {
    id: asNonEmptyString(raw?.id) || `attachment-${Date.now()}-${index}`,
    filename,
    mimeType,
    size: typeof raw?.size === "number" && Number.isFinite(raw.size) && raw.size >= 0 ? Math.floor(raw.size) : 0,
    source,
  };
  const serverPath = asNonEmptyString(raw?.serverPath);
  const dataUrl = typeof raw?.dataUrl === "string" ? raw.dataUrl : "";
  if (serverPath) attachment.serverPath = serverPath;
  if (dataUrl) attachment.dataUrl = dataUrl;
  return attachment;
}

function parseContextPart(value: unknown, index: number): QueueContextPart {
  const raw = asRecord(value);
  const kind = raw?.kind;
  if (kind !== "context" && kind !== "instruction" && kind !== "synthetic") {
    throw new QueueError(`invalid context part at index ${index}`, 400);
  }

  const text = typeof raw?.text === "string" ? raw.text : "";
  const part: QueueContextPart = { kind, text };
  if (kind === "context") {
    const metadata = asRecord(raw?.metadata);
    if (!metadata) throw new QueueError(`invalid context metadata at index ${index}`, 400);
    part.metadata = metadata;
    const instructions = asNonEmptyString(raw?.instructions);
    if (instructions) part.instructions = instructions;
  }
  return part;
}

function parseQueueItem(value: unknown): QueueItem {
  const raw = asRecord(value);
  if (!raw) throw new QueueError("item is required", 400);

  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (content.length > CONTENT_CHAR_LIMIT) throw new QueueError("item content is too long", 400);
  const text = raw.text === undefined ? content : (typeof raw.text === "string" ? raw.text : "");
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.map((attachment, index) => parseAttachment(attachment, index))
    : [];
  const context = Array.isArray(raw.context)
    ? raw.context.map((part, index) => parseContextPart(part, index))
    : [];
  if (!text.trim() && attachments.length === 0 && context.length === 0) {
    throw new QueueError("item needs text, attachments, or context", 400);
  }

  const item: QueueItem = {
    id: asNonEmptyString(raw.id) || `queued-${Date.now()}-${randomUUID().slice(0, 8)}`,
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    content,
    text,
    attachments,
    context,
    sendConfig: parseSendConfig(raw.sendConfig),
  };
  const agentMention = asNonEmptyString(raw.agentMention);
  if (agentMention) item.agentMention = agentMention;
  return item;
}

function parseStoredItem(value: unknown): QueueItem | null {
  try {
    return parseQueueItem(value);
  } catch {
    return null;
  }
}

function publicItem(item: QueueItem): PublicQueueItem {
  return {
    id: item.id,
    createdAt: item.createdAt,
    content: item.content,
    text: item.text,
    ...(item.agentMention ? { agentMention: item.agentMention } : {}),
    attachments: item.attachments.map(({ dataUrl: _dataUrl, ...attachment }) => attachment),
    sendConfig: { ...item.sendConfig },
  };
}

function publicSession(sessionId: string, entry: QueueEntry, sendingId: string | null): QueueSession {
  return {
    sessionId,
    directory: entry.directory,
    items: entry.items.map(publicItem),
    sendingId,
  };
}

function queueDataDirectory(): string {
  return process.env.OPENCHAMBER_DATA_DIR
    || Bun.env.OPENCHAMBER_DATA_DIR
    || join(Bun.env.HOME || process.env.HOME || "/tmp", ".config", "openchamber");
}

function queuePromptParts(item: QueueItem): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  const contextText = item.context.flatMap((part) => (
    [part.instructions, part.text].filter((value): value is string => Boolean(value && value.trim()))
  ));
  const text = [item.text, ...contextText].filter((value) => value.trim()).join("\n\n");
  if (text) parts.push({ type: "text", text });

  for (const attachment of item.attachments) {
    const url = attachment.dataUrl || attachment.serverPath;
    if (!url) continue;
    parts.push({
      type: "file",
      id: attachment.id,
      filename: attachment.filename,
      mime: attachment.mimeType,
      url,
    });
  }
  return parts;
}

export interface MessageQueueRuntime {
  load(): Promise<void>;
  snapshot(): QueueSnapshot;
  enqueue(sessionId: string, directory: unknown, item: unknown): Promise<QueueSessionResponse & { itemId: string }>;
  remove(sessionId: string, itemId: string): Promise<QueueSessionResponse>;
  take(sessionId: string, itemId: string): Promise<QueueTakeResponse>;
  takeAll(sessionId: string): Promise<QueueTakeAllResponse>;
  reorder(sessionId: string, itemIds: unknown): Promise<QueueSessionResponse>;
  clear(sessionId: string): Promise<QueueSessionResponse>;
  setHold(sessionId: string, held: unknown, ttlMs: unknown): QueueSessionResponse;
  start(): void;
  stop(): void;
  flush(): Promise<void>;
}

export function createMessageQueueRuntime(): MessageQueueRuntime {
  const dataDir = queueDataDirectory();
  const filePath = join(dataDir, "message-queue.json");
  const queues = new Map<string, QueueEntry>();
  const sending = new Map<string, string>();
  const holds = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let revision = 0;
  let loaded = false;
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let writePromise = Promise.resolve();

  const sessionEntry = (sessionId: string, directory?: string): QueueEntry => {
    const existing = queues.get(sessionId);
    if (existing) return existing;
    const created = { directory: directory ?? "", items: [] };
    queues.set(sessionId, created);
    return created;
  };

  const response = (sessionId: string, directory?: string): QueueSessionResponse => ({
    revision,
    session: publicSession(sessionId, sessionEntry(sessionId, directory), sending.get(sessionId) ?? null),
  });

  const broadcast = (sessionId: string): void => {
    const entry = queues.get(sessionId);
    if (!entry) return;
    emitOpenCodeEvent(
      "openchamber:message-queue.updated",
      { revision, session: publicSession(sessionId, entry, sending.get(sessionId) ?? null) },
      entry.directory || undefined,
    );
  };

  const persist = (): Promise<void> => {
    const serialized = JSON.stringify({
      version: 1,
      revision,
      sessions: Object.fromEntries(queues),
    }, null, 2) + "\n";
    writePromise = writePromise
      .catch(() => {})
      .then(async () => {
        await mkdir(dataDir, { recursive: true });
        const tempPath = `${filePath}.tmp`;
        await writeFile(tempPath, serialized, "utf8");
        await rename(tempPath, filePath);
      });
    return writePromise;
  };

  const bump = (sessionId: string): void => {
    revision += 1;
    broadcast(sessionId);
    void persist();
  };

  const load = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      revision = typeof parsed.revision === "number" && Number.isFinite(parsed.revision) ? parsed.revision : 0;
      const sessions = asRecord(parsed.sessions);
      if (sessions) {
        for (const [sessionId, raw] of Object.entries(sessions).slice(0, MAX_SESSIONS)) {
          const entry = asRecord(raw);
          const directory = asNonEmptyString(entry?.directory);
          const items = Array.isArray(entry?.items)
            ? entry.items.map(parseStoredItem).filter((item): item is QueueItem => item !== null).slice(0, MAX_ITEMS_PER_SESSION)
            : [];
          if (sessionId && directory && items.length > 0) queues.set(sessionId, { directory, items });
        }
      }
    } catch (error) {
      const code = asRecord(error)?.code;
      if (code !== "ENOENT") {
        const backup = `${filePath}.corrupt-${Date.now()}`;
        await rename(filePath, backup).catch(() => {});
        console.warn(`[message-queue] failed to load queue file; moved it to ${backup}`);
      }
      revision = 0;
    }
  };

  const snapshot = (): QueueSnapshot => ({
    revision,
    sessions: [...queues.entries()].map(([sessionId, entry]) => publicSession(sessionId, entry, sending.get(sessionId) ?? null)),
  });

  const clearTimer = (sessionId: string): void => {
    const timer = timers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(sessionId);
  };

  const scheduleDispatch = (sessionId: string, delay = 0): void => {
    clearTimer(sessionId);
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      void dispatch(sessionId);
    }, delay);
    timers.set(sessionId, timer);
  };

  const dispatch = async (sessionId: string): Promise<void> => {
    if (stopped || sending.has(sessionId)) return;
    const entry = queues.get(sessionId);
    if (!entry || entry.items.length === 0) return;
    const heldUntil = holds.get(sessionId) ?? 0;
    if (heldUntil > Date.now()) {
      scheduleDispatch(sessionId, heldUntil - Date.now());
      return;
    }
    holds.delete(sessionId);

    const status = getSessionStatusMap(entry.directory)[sessionId]?.type;
    if (status === "busy" || status === "retry") {
      scheduleDispatch(sessionId, RETRY_DELAY_MS);
      return;
    }

    const session = await backendForSession(sessionId).store.get(sessionId, entry.directory);
    if (!session) return;

    const item = entry.items[0];
    sending.set(sessionId, item.id);
    bump(sessionId);
    const body = {
      messageID: item.id,
      parts: queuePromptParts(item),
      model: {
        providerID: item.sendConfig.providerID,
        modelID: item.sendConfig.modelID,
      },
      variant: item.sendConfig.variant ?? "default",
    };

    try {
      const result = await promptSessionAsync(sessionId, entry.directory, session.path, body);
      if (!result.queued) {
        sending.delete(sessionId);
        bump(sessionId);
        scheduleDispatch(sessionId, RETRY_DELAY_MS);
        return;
      }
      entry.items.shift();
      sending.delete(sessionId);
      bump(sessionId);
    } catch {
      sending.delete(sessionId);
      bump(sessionId);
      scheduleDispatch(sessionId, RETRY_DELAY_MS);
    }
  };

  const processEvent = (event: { type: string; properties: Record<string, unknown> }): void => {
    if (event.type === "session.status") {
      const sessionId = typeof event.properties.sessionID === "string" ? event.properties.sessionID : "";
      const status = asRecord(event.properties.status)?.type;
      if (sessionId && status === "idle") scheduleDispatch(sessionId, 250);
      return;
    }
    if (event.type === "message.updated") {
      const info = asRecord(event.properties.info);
      const sessionId = typeof info?.sessionID === "string" ? info.sessionID : "";
      const completed = asRecord(info?.time)?.completed;
      if (sessionId && typeof completed === "number") scheduleDispatch(sessionId, 250);
      return;
    }
    if (event.type === "session.deleted") {
      const info = asRecord(event.properties.info);
      const sessionId = typeof info?.id === "string" ? info.id : "";
      if (sessionId && queues.has(sessionId)) {
        queues.delete(sessionId);
        revision += 1;
        void persist();
      }
    }
  };

  const enqueue = async (sessionId: string, directoryValue: unknown, rawItem: unknown): Promise<QueueSessionResponse & { itemId: string }> => {
    await load();
    const directory = asNonEmptyString(directoryValue);
    if (!directory) throw new QueueError("directory is required", 400);
    const item = parseQueueItem(rawItem);
    const entry = sessionEntry(sessionId, directory);
    entry.directory = directory;
    if (entry.items.length >= MAX_ITEMS_PER_SESSION) entry.items.splice(0, entry.items.length - MAX_ITEMS_PER_SESSION + 1);
    entry.items.push(item);
    while (queues.size > MAX_SESSIONS) {
      const oldest = queues.keys().next().value as string | undefined;
      if (!oldest || oldest === sessionId) break;
      queues.delete(oldest);
    }
    bump(sessionId);
    scheduleDispatch(sessionId);
    return { ...response(sessionId), itemId: item.id };
  };

  const remove = async (sessionId: string, itemId: string): Promise<QueueSessionResponse> => {
    await load();
    if (sending.get(sessionId) === itemId) throw new QueueError("queued message is already being sent", 409);
    const entry = queues.get(sessionId);
    if (!entry) throw new QueueError("queued session not found", 404);
    const index = entry.items.findIndex((item) => item.id === itemId);
    if (index < 0) throw new QueueError("queued message not found", 404);
    entry.items.splice(index, 1);
    bump(sessionId);
    return response(sessionId, entry.directory);
  };

  const take = async (sessionId: string, itemId: string): Promise<QueueTakeResponse> => {
    await load();
    if (sending.get(sessionId) === itemId) throw new QueueError("queued message is already being sent", 409);
    const entry = queues.get(sessionId);
    if (!entry) throw new QueueError("queued session not found", 404);
    const index = entry.items.findIndex((item) => item.id === itemId);
    if (index < 0) throw new QueueError("queued message not found", 404);
    const [item] = entry.items.splice(index, 1);
    const directory = entry.directory;
    bump(sessionId);
    return { ...response(sessionId, directory), item };
  };

  const takeAll = async (sessionId: string): Promise<QueueTakeAllResponse> => {
    await load();
    const entry = queues.get(sessionId);
    if (!entry) return { ...response(sessionId), items: [] };
    const sendingId = sending.get(sessionId);
    const items = entry.items.filter((item) => item.id !== sendingId);
    entry.items = entry.items.filter((item) => item.id === sendingId);
    const directory = entry.directory;
    bump(sessionId);
    return { ...response(sessionId, directory), items };
  };

  const reorder = async (sessionId: string, rawItemIds: unknown): Promise<QueueSessionResponse> => {
    await load();
    if (!Array.isArray(rawItemIds) || rawItemIds.some((id) => typeof id !== "string")) {
      throw new QueueError("itemIds must be an array", 400);
    }
    const entry = queues.get(sessionId);
    if (!entry) throw new QueueError("queued session not found", 404);
    const current = new Set(entry.items.map((item) => item.id));
    const requested = new Set(rawItemIds);
    if (current.size !== requested.size || [...current].some((id) => !requested.has(id))) {
      throw new QueueError("itemIds must be a complete permutation", 400);
    }
    const byId = new Map(entry.items.map((item) => [item.id, item]));
    entry.items = rawItemIds.map((id) => byId.get(id as string)!).filter(Boolean);
    bump(sessionId);
    return response(sessionId, entry.directory);
  };

  const clear = async (sessionId: string): Promise<QueueSessionResponse> => {
    await load();
    const entry = queues.get(sessionId);
    if (!entry) return response(sessionId);
    const sendingId = sending.get(sessionId);
    entry.items = entry.items.filter((item) => item.id === sendingId);
    const directory = entry.directory;
    bump(sessionId);
    return response(sessionId, directory);
  };

  const setHold = (sessionId: string, heldValue: unknown, ttlValue: unknown): QueueSessionResponse => {
    const held = heldValue === true;
    if (held) {
      const ttl = typeof ttlValue === "number" && Number.isFinite(ttlValue)
        ? Math.min(Math.max(ttlValue, 1_000), HOLD_MAX_TTL_MS)
        : HOLD_DEFAULT_TTL_MS;
      holds.set(sessionId, Date.now() + ttl);
    } else {
      holds.delete(sessionId);
      scheduleDispatch(sessionId);
    }
    bump(sessionId);
    return response(sessionId);
  };

  return {
    load,
    snapshot,
    enqueue,
    remove,
    take,
    takeAll,
    reorder,
    clear,
    setHold,
    start() {
      if (unsubscribe) return;
      stopped = false;
      unsubscribe = subscribeOpenCodeEvents(processEvent);
      void load().then(() => {
        for (const sessionId of queues.keys()) scheduleDispatch(sessionId);
      });
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = undefined;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    flush() {
      return writePromise;
    },
  };
}

export function isQueueError(error: unknown): error is QueueError {
  return error instanceof QueueError;
}
