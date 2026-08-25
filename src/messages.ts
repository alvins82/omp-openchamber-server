import { readFile } from "node:fs/promises";
import { withOmpRpc } from "./rpc";
import { getOmpSessionByOpenCodeId } from "./sessions";
import { sessionLogger } from "./logger";

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
    time: { created: number; completed?: number };
  };
  parts: Array<OpenCodeTextPart | OpenCodeToolPart>;
}

export interface OpenCodeTextPart {
  id: string;
  type: "text" | "reasoning";
  text: string;
  time?: { start: number; end?: number };
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

export type AgentMessageRole = "user" | "developer" | "assistant" | "custom" | "toolResult";

export interface AgentMessageContentBlock {
  type: "text" | "thinking" | "toolCall";
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  id?: string;
}

export interface AgentMessage {
  id?: string;
  role: AgentMessageRole;
  content?: AgentMessageContentBlock[] | string;
  provider?: string;
  model?: string;
  variant?: string;
  stopReason?: string;
  display?: boolean;
  attribution?: "user" | "assistant";
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
}

const TTL_MS = 5_000;

interface CacheEntry {
  messages: OpenCodeMessageRecord[];
  at: number;
}

const messageCache = new Map<string, CacheEntry>();
const inflightLoads = new Map<string, Promise<OpenCodeMessageRecord[]>>();

function cacheKey(openCodeId: string, cwd: string): string {
  return `${openCodeId}\0${cwd}`;
}

export function invalidateMessageCache(openCodeId: string, cwd: string): void {
  messageCache.delete(cacheKey(openCodeId, cwd));
}

function openCodeRoleFor(msg: AgentMessage): "user" | "assistant" | null {
  switch (msg.role) {
    case "user":
    case "developer":
      return "user";
    case "assistant":
    case "toolResult":
      return "assistant";
    case "custom": {
      if (msg.display === false) return null;
      if (msg.attribution === "user") return "user";
      return null;
    }
    default:
      return null;
  }
}

function normalizedContentBlocks(
  msg: AgentMessage,
): AgentMessageContentBlock[] {
  const { content } = msg;
  if (Array.isArray(content)) return content;
  if (typeof content === "string" && content.length > 0) return [{ type: "text", text: content }];
  return [];
}

function createToolPart(
  block: AgentMessageContentBlock,
  openCodeId: string,
  messageId: string,
  index: number,
  startTime: number,
): OpenCodeToolPart {
  const raw = block as unknown as Record<string, unknown>;
  const tool = typeof block.name === "string" && block.name.length > 0
    ? block.name
    : (typeof raw.tool === "string" && raw.tool.length > 0 ? (raw.tool as string) : "tool");
  const callID = typeof block.id === "string" && block.id.length > 0
    ? block.id
    : (typeof raw.toolCallId === "string" && raw.toolCallId.length > 0 ? (raw.toolCallId as string) : `call_${index}`);

  let input: Record<string, unknown> | undefined;
  if (typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)) {
    input = { ...(block.arguments as Record<string, unknown>) };
  } else if (typeof raw.args === "object" && raw.args !== null && !Array.isArray(raw.args)) {
    input = { ...(raw.args as Record<string, unknown>) };
  } else if (typeof block.arguments === "string") {
    try {
      const p = JSON.parse(block.arguments);
      if (typeof p === "object" && p !== null && !Array.isArray(p)) input = p as Record<string, unknown>;
    } catch {}
  }
  if (input && !input.description && (input.intent || input.i || raw.intent)) {
    input.description = (input.intent ?? input.i ?? raw.intent) as string;
  }

  return {
    id: `part_${openCodeId}_${messageId}_tool_${index}_${block.id ?? tool}`,
    type: "tool",
    callID,
    tool,
    state: {
      status: "pending",
      input,
      time: { start: startTime },
    },
    metadata: typeof block.id === "string" ? { toolCallId: block.id } : undefined,
    messageID: messageId,
    sessionID: openCodeId,
  };
}

function extractTextFromContent(content: AgentMessageContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return JSON.stringify(block);
      if (typeof block.text === "string") return block.text;
      if (typeof block.thinking === "string") return block.thinking;
      return JSON.stringify(block);
    })
    .join("\n");
}

function mergeToolResultIntoAssistant(
  msg: AgentMessage,
  record: OpenCodeMessageRecord,
  resultTime: number,
): boolean {
  const raw = msg as unknown as Record<string, unknown>;
  const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : (typeof raw.tool_call_id === "string" ? (raw.tool_call_id as string) : undefined);
  const toolName = typeof msg.toolName === "string" ? msg.toolName : (typeof raw.tool_name === "string" ? (raw.tool_name as string) : undefined);

  const toolParts = record.parts.filter(
    (part): part is OpenCodeToolPart => part.type === "tool",
  );
  if (toolParts.length === 0) return false;

  const target = toolParts.find((part) => {
    if (toolCallId && (part.metadata?.toolCallId === toolCallId || part.callID === toolCallId)) return true;
    if (toolName && part.tool === toolName && part.state.status === "pending") return true;
    return false;
  });
  if (!target) return false;

  if (target.tool === "tool" && toolName) {
    target.tool = toolName;
  }

  const content = extractTextFromContent(msg.content);
  const isError = msg.isError === true || raw.is_error === true;
  target.state.status = isError ? "error" : "completed";
  if (isError) {
    target.state.error = content;
  } else {
    target.state.output = content;
  }
  target.state.time.end = resultTime;
  return true;
}

function buildParts(
  msg: AgentMessage,
  openCodeId: string,
  messageId: string,
): Array<OpenCodeTextPart | OpenCodeToolPart> {
  const parts: Array<OpenCodeTextPart | OpenCodeToolPart> = [];
  let currentTextPart: { type: "text" | "reasoning"; text: string } | null = null;

  const flushText = () => {
    if (currentTextPart) {
      const msgTime = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
      parts.push({
        id: `part_${openCodeId}_${messageId}_${parts.length}`,
        type: currentTextPart.type,
        text: currentTextPart.text || "(empty)",
        time: { start: msgTime, end: msgTime },
        messageID: messageId,
        sessionID: openCodeId,
      });
      currentTextPart = null;
    }
  };

  for (const block of normalizedContentBlocks(msg)) {
    if (!block || typeof block !== "object") continue;
    const kind = block.type;
    if (kind === "text") {
      const text = typeof block.text === "string" ? block.text : JSON.stringify(block);
      if (currentTextPart && currentTextPart.type === "text") {
        if (currentTextPart.text) currentTextPart.text += "\n";
        currentTextPart.text += text;
      } else {
        flushText();
        currentTextPart = { type: "text", text };
      }
    } else if (kind === "thinking") {
      const text = typeof block.thinking === "string" ? block.thinking : JSON.stringify(block);
      if (currentTextPart && currentTextPart.type === "reasoning") {
        if (currentTextPart.text) currentTextPart.text += "\n";
        currentTextPart.text += text;
      } else {
        flushText();
        currentTextPart = { type: "reasoning", text };
      }
    } else if (kind === "toolCall") {
      flushText();
      const startTime = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
      parts.push(createToolPart(block, openCodeId, messageId, parts.length, startTime));
    } else {
      const text = JSON.stringify(block);
      if (currentTextPart && currentTextPart.type === "text") {
        if (currentTextPart.text) currentTextPart.text += "\n";
        currentTextPart.text += text;
      } else {
        flushText();
        currentTextPart = { type: "text", text };
      }
    }
  }

  flushText();

  if (parts.length === 0) {
    const msgTime = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
    parts.push({
      id: `part_${openCodeId}_${messageId}_0`,
      type: "text",
      text: "(empty)",
      time: { start: msgTime, end: msgTime },
      messageID: messageId,
      sessionID: openCodeId,
    });
  }

  return parts;
}

interface RecordedUserMessage {
  text: string;
  clientMessageId: string;
  timestamp: number;
}

const recordedUserMessagesBySession = new Map<string, RecordedUserMessage[]>();

export function recordUserMessageId(openCodeId: string, promptTextOrMessageId: string, messageId?: string): void {
  const actualMessageId = messageId ?? promptTextOrMessageId;
  const promptText = messageId ? promptTextOrMessageId : "";
  const list = recordedUserMessagesBySession.get(openCodeId) ?? [];
  const filtered = list.filter((item) => item.clientMessageId !== actualMessageId);
  filtered.push({ text: promptText.trim(), clientMessageId: actualMessageId, timestamp: Date.now() });
  recordedUserMessagesBySession.set(openCodeId, filtered);
}

function extractUserMessageText(msg: AgentMessage): string {
  if (typeof msg.content === "string") return msg.content.trim();
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block && typeof block === "object" && typeof block.text === "string") {
        return block.text.trim();
      }
    }
  }
  return "";
}

export function mapRpcMessagesToOpenCodeRecords(
  messages: AgentMessage[],
  openCodeId: string,
): OpenCodeMessageRecord[] {
  const records: OpenCodeMessageRecord[] = [];
  let lastUserMessageId: string | undefined;
  let lastAssistantRecord: OpenCodeMessageRecord | undefined;
  let visibleIndex = 0;
  const recordedList = recordedUserMessagesBySession.get(openCodeId) ?? [];
  const userMessages = messages.filter((m) => openCodeRoleFor(m) === "user");
  const lastUserMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1] : undefined;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = openCodeRoleFor(msg);
    if (role === null) continue;

    const createdAt = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

    if (msg.role === "toolResult" && lastAssistantRecord) {
      if (mergeToolResultIntoAssistant(msg, lastAssistantRecord, createdAt)) {
        lastAssistantRecord.info.time.completed = createdAt;
        continue;
      }
    }

    let messageId: string;
    if (role === "user") {
      const msgText = extractUserMessageText(msg);
      const matched = (msgText && recordedList.find((r) => r.text === msgText))
        ?? (msg === lastUserMsg && recordedList.length > 0 ? recordedList[recordedList.length - 1] : undefined);
      if (matched) {
        messageId = matched.clientMessageId;
      } else if (typeof msg.id === "string" && msg.id.startsWith("msg_")) {
        messageId = msg.id;
      } else {
        messageId = `msg_${openCodeId}_${msg.id ?? visibleIndex}`;
      }
    } else {
      if (typeof msg.id === "string" && msg.id.startsWith("msg_")) {
        messageId = msg.id;
      } else {
        messageId = `msg_${openCodeId}_${msg.id ?? visibleIndex}`;
      }
    }

    visibleIndex++;
    const parts = buildParts(msg, openCodeId, messageId);

    const baseInfo: OpenCodeMessageRecord["info"] = {
      id: messageId,
      role,
      sessionID: openCodeId,
      agent: "omp",
      model: { providerID: "omp", modelID: "omp", variant: "default" },
      time: { created: createdAt, completed: createdAt },
    };

    if (role === "assistant") {
      const providerID = msg.provider ?? "omp";
      const modelID = msg.model ?? "omp";
      const variant = msg.variant ?? "default";
      const record: OpenCodeMessageRecord = {
        info: {
          ...baseInfo,
          parentID: lastUserMessageId,
          finish: "stop",
          mode: "primary",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          model: { id: modelID, providerID, modelID, variant },
          providerID,
          modelID,
          variant,
        },
        parts,
      };
      records.push(record);
      lastAssistantRecord = record;
    } else {
      records.push({ info: baseInfo, parts });
      lastUserMessageId = messageId;
      lastAssistantRecord = undefined;
    }
  }

  return records;
}

function extractMessagesFromRpcResponse(raw: unknown): unknown {
  if (raw != null && typeof raw === "object" && "messages" in raw) {
    const candidate = (raw as Record<string, unknown>).messages;
    if (Array.isArray(candidate)) return candidate;
  }
  return raw;
}

// Fast path: read the omp session JSONL directly from disk.
//
// The previous implementation (loadFromRpc) spawned a transient
// `omp --mode rpc` child per fetch, which resumed the session and was
// SIGTERM'd afterwards. OMP's teardown bookkeeping appends a
// `{"type":"custom","customType":"session_exit"}` record to the session
// JSONL on that SIGTERM, so repeated UI polling rewrote user session
// files with synthetic records every ~20s. Reading the file directly
// yields the same message records without touching the session.
//
// Record shapes (omp v17.3.5 session file format):
//   {"type":"message","id","parentId","timestamp":"<iso>","message":{"role","content":[...],
//    "api","provider","model","usage","stopReason","timestamp":<ms>,
//    "toolCallId","toolName","isError"}}
// The inner `message` object matches the AgentMessage shape returned by
// the `get_messages` RPC, so it flows through the same mapper. Truncated
// trailing lines (concurrent mid-write) are skipped, never fatal.
export async function loadMessagesFromFile(
  sessionPath: string,
  openCodeId: string,
): Promise<OpenCodeMessageRecord[] | null> {
  let text: string;
  try {
    text = await readFile(sessionPath, "utf8");
  } catch {
    return null;
  }

  const messages: AgentMessage[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;

    const raw = entry.message;
    if (raw == null || typeof raw !== "object") continue;

    const message = raw as Record<string, unknown>;
    let id = typeof message.id === "string" ? message.id : undefined;
    if (id === undefined && typeof entry.id === "string") id = entry.id;

    let timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
    if (timestamp === undefined && typeof entry.timestamp === "string") {
      const parsed = Date.parse(entry.timestamp);
      if (!Number.isNaN(parsed)) timestamp = parsed;
    }

    messages.push({ ...message, id, timestamp } as unknown as AgentMessage);
  }

  if (messages.length === 0) return null;
  return mapRpcMessagesToOpenCodeRecords(messages, openCodeId);
}

async function loadFromRpc(openCodeId: string, cwd: string): Promise<OpenCodeMessageRecord[]> {
  const session = await getOmpSessionByOpenCodeId(openCodeId, cwd);
  if (!session) {
    sessionLogger.error({ sessionID: openCodeId, cwd }, `no session found for ${openCodeId} in ${cwd}`);
    return [];
  }

  return withOmpRpc(cwd, async (conn) => {
    await conn.switchSession(session.path);
    const raw = await conn.request("get_messages");
    const messages = extractMessagesFromRpcResponse(raw);
    if (!Array.isArray(messages)) {
      throw new Error(`RPC get_messages returned unexpected ${typeof messages}`);
    }
    return mapRpcMessagesToOpenCodeRecords(messages as AgentMessage[], openCodeId);
  });
}

export async function loadSessionMessages(
  openCodeId: string,
  cwd: string,
): Promise<OpenCodeMessageRecord[]> {
  const key = cacheKey(openCodeId, cwd);
  const now = Date.now();
  const cached = messageCache.get(key);
  if (cached && now - cached.at < TTL_MS) {
    return cached.messages;
  }

  const inflight = inflightLoads.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const session = await getOmpSessionByOpenCodeId(openCodeId, cwd);
    if (!session) {
      throw new Error(`no session found for ${openCodeId} in ${cwd}`);
    }
    const fromFile = await loadMessagesFromFile(session.path, openCodeId);
    if (fromFile) return fromFile;
    return loadFromRpc(openCodeId, cwd);
  })().catch((err) => {
    throw new Error(`Failed to load messages for ${openCodeId}: ${err instanceof Error ? err.message : String(err)}`);
  });
  inflightLoads.set(key, promise);

  try {
    const messages = await promise;
    messageCache.set(key, { messages, at: Date.now() });
    return messages;
  } finally {
    inflightLoads.delete(key);
  }
}
