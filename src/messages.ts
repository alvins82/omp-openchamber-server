import { readFile } from "node:fs/promises";
import { withOmpRpc } from "./rpc";
import { getOmpSessionByOpenCodeId } from "./sessions";
import { sessionLogger } from "./logger";
import {
  bindPersistedOmpMessageId,
  listPersistedMessageIds,
  recordPersistedMessageId,
} from "./title-db";
import { normalizeToolInput, normalizeToolOutput } from "./tool-normalize";
import { resolveImageDataUrl, isBlobRef } from "./blobs";

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

export interface OpenCodeFilePart {
  id: string;
  type: "file";
  mime?: string;
  filename?: string;
  url: string;
  messageID: string;
  sessionID: string;
}

export type OpenCodePart = OpenCodeTextPart | OpenCodeToolPart | OpenCodeFilePart;

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

export interface TokenBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

export interface UsageMappingResult {
  tokens: TokenBreakdown;
  cost: number;
}

export function mapOmpUsageToTokens(rawUsage: unknown, rawCost?: unknown): UsageMappingResult {
  const fallbackTokens: TokenBreakdown = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };

  if (!rawUsage || typeof rawUsage !== "object") {
    let cost = 0;
    if (typeof rawCost === "number" && Number.isFinite(rawCost)) {
      cost = Math.max(0, rawCost);
    }
    return { tokens: fallbackTokens, cost };
  }

  const u = rawUsage as Record<string, unknown>;

  const input = typeof u.input === "number" && Number.isFinite(u.input)
    ? Math.max(0, u.input)
    : (typeof u.prompt_tokens === "number" && Number.isFinite(u.prompt_tokens)
      ? Math.max(0, u.prompt_tokens)
      : (typeof u.inputTokens === "number" && Number.isFinite(u.inputTokens) ? Math.max(0, u.inputTokens) : 0));

  const output = typeof u.output === "number" && Number.isFinite(u.output)
    ? Math.max(0, u.output)
    : (typeof u.completion_tokens === "number" && Number.isFinite(u.completion_tokens)
      ? Math.max(0, u.completion_tokens)
      : (typeof u.outputTokens === "number" && Number.isFinite(u.outputTokens) ? Math.max(0, u.outputTokens) : 0));

  const reasoning = typeof u.reasoning === "number" && Number.isFinite(u.reasoning)
    ? Math.max(0, u.reasoning)
    : (typeof u.reasoning_tokens === "number" && Number.isFinite(u.reasoning_tokens)
      ? Math.max(0, u.reasoning_tokens)
      : (typeof u.reasoningTokens === "number" && Number.isFinite(u.reasoningTokens) ? Math.max(0, u.reasoningTokens) : 0));

  const cacheRead = typeof u.cacheRead === "number" && Number.isFinite(u.cacheRead)
    ? Math.max(0, u.cacheRead)
    : (typeof u.cache_read === "number" && Number.isFinite(u.cache_read)
      ? Math.max(0, u.cache_read)
      : (typeof u.cache_read_input_tokens === "number" && Number.isFinite(u.cache_read_input_tokens)
        ? Math.max(0, u.cache_read_input_tokens)
        : (typeof u.prompt_cache_hit_tokens === "number" && Number.isFinite(u.prompt_cache_hit_tokens)
          ? Math.max(0, u.prompt_cache_hit_tokens)
          : 0)));

  const cacheWrite = typeof u.cacheWrite === "number" && Number.isFinite(u.cacheWrite)
    ? Math.max(0, u.cacheWrite)
    : (typeof u.cache_write === "number" && Number.isFinite(u.cache_write)
      ? Math.max(0, u.cache_write)
      : (typeof u.cache_creation_input_tokens === "number" && Number.isFinite(u.cache_creation_input_tokens)
        ? Math.max(0, u.cache_creation_input_tokens)
        : (typeof u.prompt_cache_miss_tokens === "number" && Number.isFinite(u.prompt_cache_miss_tokens)
          ? Math.max(0, u.prompt_cache_miss_tokens)
          : 0)));

  let cost = 0;
  if (typeof rawCost === "number" && Number.isFinite(rawCost)) {
    cost = Math.max(0, rawCost);
  } else if (typeof u.cost === "number" && Number.isFinite(u.cost)) {
    cost = Math.max(0, u.cost);
  } else if (u.cost && typeof u.cost === "object") {
    const c = u.cost as Record<string, unknown>;
    if (typeof c.total === "number" && Number.isFinite(c.total)) {
      cost = Math.max(0, c.total);
    }
  }

  return {
    tokens: {
      input,
      output,
      reasoning,
      cache: {
        read: cacheRead,
        write: cacheWrite,
      },
    },
    cost,
  };
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
  errorMessage?: string;
  errorStatus?: number;
  errorId?: string | number;
  error?: unknown;
  display?: boolean;
  attribution?: "user" | "assistant";
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  usage?: unknown;
  cost?: unknown;
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
  if (input) {
    input = normalizeToolInput(tool, input);
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
    target.state.output = normalizeToolOutput(target.tool, content, msg.details ?? raw.details);
  }
  target.state.time.end = resultTime;
  return true;
}

function buildParts(
  msg: AgentMessage,
  openCodeId: string,
  messageId: string,
  startIndex = 0,
): OpenCodePart[] {
  const parts: OpenCodePart[] = [];
  let currentTextPart: { type: "text" | "reasoning"; text: string } | null = null;

  const flushText = () => {
    if (currentTextPart) {
      const msgTime = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
      parts.push({
        id: `part_${openCodeId}_${messageId}_${startIndex + parts.length}`,
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
    const raw = block as Record<string, unknown>;
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
      parts.push(createToolPart(block, openCodeId, messageId, startIndex + parts.length, startTime));
    } else if (kind === "image") {
      flushText();
      const mime =
        (typeof block.mimeType === "string" ? block.mimeType : undefined) ||
        (typeof block.mime === "string" ? block.mime : undefined) ||
        (typeof raw.mimeType === "string" ? (raw.mimeType as string) : undefined) ||
        (typeof raw.mime === "string" ? (raw.mime as string) : undefined) ||
        "image/png";
      const rawData =
        (typeof block.data === "string" ? block.data : undefined) ||
        (typeof raw.data === "string" ? (raw.data as string) : "");
      const rawUrl =
        (typeof block.url === "string" ? block.url : undefined) ||
        (typeof raw.url === "string" ? (raw.url as string) : undefined) ||
        "";

      let url = "";
      if (rawData) {
        url = resolveImageDataUrl(rawData, mime);
      } else if (rawUrl) {
        url = resolveImageDataUrl(rawUrl, mime);
      }

      parts.push({
        id: `part_${openCodeId}_${messageId}_${startIndex + parts.length}`,
        type: "file",
        mime,
        url,
        messageID: messageId,
        sessionID: openCodeId,
      });
    } else if (kind === "file") {
      flushText();
      const mime =
        (typeof block.mime === "string" ? block.mime : undefined) ||
        (typeof block.mimeType === "string" ? block.mimeType : undefined) ||
        (typeof raw.mime === "string" ? (raw.mime as string) : undefined) ||
        (typeof raw.mimeType === "string" ? (raw.mimeType as string) : undefined) ||
        "application/octet-stream";
      const rawUrl =
        (typeof block.url === "string" ? block.url : undefined) ||
        (typeof raw.url === "string" ? (raw.url as string) : "");
      const rawData =
        (typeof block.data === "string" ? block.data : undefined) ||
        (typeof raw.data === "string" ? (raw.data as string) : "");
      const filename =
        (typeof block.filename === "string" ? block.filename : undefined) ||
        (typeof raw.filename === "string" ? (raw.filename as string) : undefined);

      let url = rawUrl;
      if (rawData) {
        url = resolveImageDataUrl(rawData, mime);
      } else if (rawUrl) {
        url = resolveImageDataUrl(rawUrl, mime);
      }

      parts.push({
        id:
          (typeof block.id === "string" ? block.id : undefined) ||
          `part_${openCodeId}_${messageId}_${startIndex + parts.length}`,
        type: "file",
        mime,
        url,
        ...(filename ? { filename } : {}),
        messageID: messageId,
        sessionID: openCodeId,
      });
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

  if (parts.length === 0 && startIndex === 0) {
    const msgTime = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
    const rawError = typeof msg.errorMessage === "string" ? msg.errorMessage : (typeof msg.error === "string" ? msg.error : undefined);
    const text = (msg.stopReason === "error" || rawError)
      ? (rawError ? `⚠️ **Provider Error**: ${rawError}` : "⚠️ **Provider Error**: Turn ended with error.")
      : "(empty)";
    parts.push({
      id: `part_${openCodeId}_${messageId}_0`,
      type: "text",
      text,
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
  ompMessageId?: string;
}

const recordedUserMessagesBySession = new Map<string, RecordedUserMessage[]>();

export function clearRecordedUserMessagesMemoryCache(openCodeId?: string): void {
  if (openCodeId) {
    recordedUserMessagesBySession.delete(openCodeId);
  } else {
    recordedUserMessagesBySession.clear();
  }
}

export function recordUserMessageId(
  openCodeId: string,
  promptTextOrMessageId: string,
  messageId?: string,
  dbPath?: string,
): void {
  const actualMessageId = messageId ?? promptTextOrMessageId;
  const promptText = messageId ? promptTextOrMessageId : "";
  const now = Date.now();
  const list = recordedUserMessagesBySession.get(openCodeId) ?? [];
  const filtered = list.filter((item) => item.clientMessageId !== actualMessageId);
  filtered.push({ text: promptText.trim(), clientMessageId: actualMessageId, timestamp: now });
  recordedUserMessagesBySession.set(openCodeId, filtered);

  recordPersistedMessageId(openCodeId, actualMessageId, promptText.trim(), now, undefined, dbPath);
}

function getRecordedUserMessages(openCodeId: string, dbPath?: string): RecordedUserMessage[] {
  const inMemory = recordedUserMessagesBySession.get(openCodeId);
  if (inMemory && inMemory.length > 0) {
    return inMemory;
  }

  const persisted = listPersistedMessageIds(openCodeId, dbPath);
  if (persisted.length > 0) {
    const list: RecordedUserMessage[] = persisted.map((p) => ({
      text: p.promptText,
      clientMessageId: p.clientMessageId,
      timestamp: p.createdAt,
      ompMessageId: p.ompMessageId,
    }));
    recordedUserMessagesBySession.set(openCodeId, list);
    return list;
  }

  return [];
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
  dbPath?: string,
): OpenCodeMessageRecord[] {
  const records: OpenCodeMessageRecord[] = [];
  let lastUserMessageId: string | undefined;
  let lastUserMatched = false;
  let lastAssistantRecord: OpenCodeMessageRecord | undefined;
  let visibleIndex = 0;
  const recordedList = getRecordedUserMessages(openCodeId, dbPath);
  const matchedRecordedIndices = new Set<number>();
  let userMessageIndex = 0;
  let asstStepIndex = 0;

  const userMessages = messages.filter((m) => openCodeRoleFor(m) === "user");

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
      asstStepIndex = 0;
      const msgText = extractUserMessageText(msg);
      let matchedIndex = -1;

      // 1. Direct OMP message ID match if already bound
      if (typeof msg.id === "string" && msg.id.length > 0) {
        matchedIndex = recordedList.findIndex(
          (r, idx) => !matchedRecordedIndices.has(idx) && r.ompMessageId === msg.id,
        );
      }

      // 2. Exact prompt text match
      if (matchedIndex === -1 && msgText) {
        if (
          userMessageIndex < recordedList.length &&
          !matchedRecordedIndices.has(userMessageIndex) &&
          recordedList[userMessageIndex].text === msgText
        ) {
          matchedIndex = userMessageIndex;
        } else {
          matchedIndex = recordedList.findIndex(
            (r, idx) => !matchedRecordedIndices.has(idx) && r.text === msgText,
          );
        }
      }

      // 3. Positional match when session user message count matches or candidate text is empty
      if (
        matchedIndex === -1 &&
        userMessageIndex < recordedList.length &&
        !matchedRecordedIndices.has(userMessageIndex) &&
        (!recordedList[userMessageIndex].text || recordedList.length === userMessages.length)
      ) {
        matchedIndex = userMessageIndex;
      }

      if (matchedIndex !== -1) {
        matchedRecordedIndices.add(matchedIndex);
        const match = recordedList[matchedIndex];
        messageId = match.clientMessageId;
        lastUserMatched = true;

        // If not yet bound to omp_message_id, bind it now in SQLite & memory
        if (typeof msg.id === "string" && msg.id.length > 0 && match.ompMessageId !== msg.id) {
          match.ompMessageId = msg.id;
          bindPersistedOmpMessageId(openCodeId, match.clientMessageId, msg.id, dbPath);
        }
      } else if (typeof msg.id === "string" && msg.id.startsWith("msg_")) {
        messageId = msg.id;
        lastUserMatched = false;
      } else {
        messageId = `msg_${openCodeId}_${msg.id ?? visibleIndex}`;
        lastUserMatched = false;
      }

      userMessageIndex++;
      visibleIndex++;
      const parts = buildParts(msg, openCodeId, messageId);
      const baseInfo: OpenCodeMessageRecord["info"] = {
        id: messageId,
        role: "user",
        sessionID: openCodeId,
        agent: "omp",
        model: { providerID: "omp", modelID: "omp", variant: "default" },
        time: { created: createdAt, completed: createdAt },
      };
      records.push({ info: baseInfo, parts });
      lastUserMessageId = messageId;
      lastAssistantRecord = undefined;
    } else {
      const providerID = msg.provider ?? "omp";
      const modelID = msg.model ?? "omp";
      const variant = msg.variant ?? "default";
      const { tokens, cost } = mapOmpUsageToTokens(msg.usage, msg.cost);

      let finish: string | undefined;
      if (msg.stopReason === "toolUse") {
        finish = "tool-calls";
      } else if (msg.stopReason) {
        finish = msg.stopReason;
      }

      const rawError = typeof msg.errorMessage === "string" ? msg.errorMessage : (typeof msg.error === "string" ? msg.error : undefined);
      const errorObj = rawError ? { message: rawError } : (msg.stopReason === "error" ? { message: "Turn ended with error" } : undefined);

      if (lastAssistantRecord) {
        const parts = buildParts(msg, openCodeId, lastAssistantRecord.info.id, lastAssistantRecord.parts.length);
        lastAssistantRecord.parts.push(...parts);
        lastAssistantRecord.info.time.completed = createdAt;
        if (finish) {
          lastAssistantRecord.info.finish = finish;
        } else if (lastAssistantRecord.parts.some((p) => p.type === "tool" && (p.state.status === "pending" || p.state.status === "running"))) {
          lastAssistantRecord.info.finish = "tool-calls";
        } else {
          lastAssistantRecord.info.finish = "stop";
        }
        if (errorObj) {
          lastAssistantRecord.info.error = errorObj;
        }
        if (tokens.input > 0 || tokens.output > 0 || tokens.cache.read > 0 || tokens.cache.write > 0) {
          lastAssistantRecord.info.tokens = tokens;
        }
        if (cost > 0) {
          lastAssistantRecord.info.cost = (lastAssistantRecord.info.cost || 0) + cost;
        }
        if (msg.provider && msg.provider !== "omp") {
          lastAssistantRecord.info.providerID = msg.provider;
          lastAssistantRecord.info.model.providerID = msg.provider;
        }
        if (msg.model && msg.model !== "omp") {
          lastAssistantRecord.info.modelID = msg.model;
          lastAssistantRecord.info.model.modelID = msg.model;
          lastAssistantRecord.info.model.id = msg.model;
        }
        if (msg.variant) {
          lastAssistantRecord.info.variant = msg.variant;
          lastAssistantRecord.info.model.variant = msg.variant;
        }
      } else {
        if (typeof msg.id === "string" && msg.id.startsWith("msg_")) {
          messageId = msg.id;
        } else if (lastUserMatched && lastUserMessageId) {
          messageId = `msg_${openCodeId}_asst_${lastUserMessageId}`;
        } else if (typeof msg.id === "string" && msg.id.length > 0) {
          messageId = `msg_${openCodeId}_${msg.id}`;
        } else {
          messageId = `msg_${openCodeId}_${visibleIndex}`;
        }

        visibleIndex++;
        const parts = buildParts(msg, openCodeId, messageId, 0);

        if (!finish) {
          finish = parts.some((p) => p.type === "tool") ? "tool-calls" : "stop";
        }

        const record: OpenCodeMessageRecord = {
          info: {
            id: messageId,
            role: "assistant",
            sessionID: openCodeId,
            parentID: lastUserMessageId,
            agent: "omp",
            model: { id: modelID, providerID, modelID, variant },
            providerID,
            modelID,
            variant,
            finish,
            error: errorObj,
            mode: "primary",
            cost,
            tokens,
            time: { created: createdAt, completed: createdAt },
          },
          parts,
        };
        records.push(record);
        lastAssistantRecord = record;
      }
      asstStepIndex++;
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
  dbPath?: string,
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
  return mapRpcMessagesToOpenCodeRecords(messages, openCodeId, dbPath);
}

async function loadFromRpc(openCodeId: string, cwd: string, dbPath?: string): Promise<OpenCodeMessageRecord[]> {
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
    return mapRpcMessagesToOpenCodeRecords(messages as AgentMessage[], openCodeId, dbPath);
  });
}

export async function loadSessionMessages(
  openCodeId: string,
  cwd: string,
  dbPath?: string,
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
    const fromFile = await loadMessagesFromFile(session.path, openCodeId, dbPath);
    if (fromFile) return fromFile;
    return loadFromRpc(openCodeId, cwd, dbPath);
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
