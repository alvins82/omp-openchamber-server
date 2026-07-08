import { withOmpRpc } from "./rpc";
import { getOmpSessionByOpenCodeId } from "./sessions";

export interface OpenCodeMessageRecord {
  info: {
    id: string;
    role: string;
    sessionID: string;
    parentID?: string;
    agent: string;
    model: { providerID: string; modelID: string; variant: string };
    providerID?: string;
    modelID?: string;
    variant?: string;
    finish?: string;
    time: { created: number; completed?: number };
  };
  parts: Array<OpenCodeTextPart | OpenCodeToolPart>;
}

export interface OpenCodeTextPart {
  id: string;
  type: "text" | "reasoning";
  text: string;
  messageID: string;
  sessionID: string;
}

export interface OpenCodeToolPart {
  id: string;
  type: "tool";
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
  const tool = typeof block.name === "string" && block.name.length > 0 ? block.name : "tool";
  return {
    id: `part_${openCodeId}_${messageId}_tool_${index}_${block.id ?? tool}`,
    type: "tool",
    tool,
    state: {
      status: "pending",
      input: typeof block.arguments === "object" && block.arguments !== null ? block.arguments : undefined,
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
  const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
  const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;

  const toolParts = record.parts.filter(
    (part): part is OpenCodeToolPart => part.type === "tool",
  );
  if (toolParts.length === 0) return false;

  const target = toolParts.find((part) => {
    if (toolCallId && part.metadata?.toolCallId === toolCallId) return true;
    if (toolName && part.tool === toolName && part.state.status === "pending") return true;
    return false;
  });
  if (!target) return false;

  const content = extractTextFromContent(msg.content);
  const isError = msg.isError === true;
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
      parts.push({
        id: `part_${openCodeId}_${messageId}_${parts.length}`,
        type: currentTextPart.type,
        text: currentTextPart.text || "(empty)",
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
    parts.push({
      id: `part_${openCodeId}_${messageId}_0`,
      type: "text",
      text: "(empty)",
      messageID: messageId,
      sessionID: openCodeId,
    });
  }

  return parts;
}

export function mapRpcMessagesToOpenCodeRecords(
  messages: AgentMessage[],
  openCodeId: string,
): OpenCodeMessageRecord[] {
  const records: OpenCodeMessageRecord[] = [];
  let lastUserMessageId: string | undefined;
  let lastAssistantRecord: OpenCodeMessageRecord | undefined;
  let visibleIndex = 0;

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

    const messageId = `msg_${openCodeId}_${msg.id ?? visibleIndex}`;
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
          model: { providerID, modelID, variant },
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

async function loadFromRpc(openCodeId: string, cwd: string): Promise<OpenCodeMessageRecord[]> {
  const session = await getOmpSessionByOpenCodeId(openCodeId, cwd);
  if (!session) {
    console.error(`[messages] no session found for ${openCodeId} in ${cwd}`);
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

  const promise = loadFromRpc(openCodeId, cwd).catch((err) => {
    throw new Error(
      `Failed to load messages for ${openCodeId}: ${err instanceof Error ? err.message : String(err)}`,
    );
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
