import { OmpRpcConnection, getCurrentModel, type OmpRpcEvent, type OmpRpcTransport } from "./rpc";
import { invalidateMessageCache, recordUserMessageId, mapOmpUsageToTokens, type TokenBreakdown } from "./messages";
import { promptLogger } from "./logger";
import { getOmpSessionByOpenCodeId, setOmpSessionTitle, toOpenCodeSessionId, readSessionHeader } from "./sessions";
import { isLowSignalTitleInput, normalizeGeneratedTitle } from "./title";
import {
  emitMessagePartDelta,
  emitMessagePartUpdated,
  emitMessageUpdated,
  emitSessionCreated,
  emitSessionUpdated,
  emitSessionIdle,
  emitSessionStatus,
  emitSessionError,
  emitTodoUpdated,
  emitPermissionAsked,
  emitQuestionAsked,
} from "./sse";
import {
  addPendingPermission,
  addPendingQuestion,
  clearSessionApprovals,
  type PermissionRequest,
  type QuestionRequest,
} from "./approvals";
import { normalizeToolInput, normalizeToolOutput } from "./tool-normalize";
import { isBlobRef, readBlobBufferSync } from "./blobs";
import { isTodoTool, extractTodosFromOmpDetails } from "./todo";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

interface OpenCodeTextPart {
  type: "text";
  text?: string;
}

type OpenCodePart = OpenCodeTextPart | { type: "file"; [key: string]: unknown };

interface PromptBody {
  parts?: OpenCodePart[];
  messageID?: string;
  model?: { providerID?: string; modelID?: string };
  variant?: string;
}

interface ModelRef {
  providerID: string;
  modelID: string;
  variant: string;
}

interface SessionState {
  conn: OmpRpcTransport;
  busy: boolean;
  openCodeId: string;
  cwd: string;
  sessionPath: string;
  unsubscribe: () => void;
  currentModel: ModelRef;
}

function sessionKey(openCodeId: string, cwd: string): string {
  return `${openCodeId}\0${cwd}`;
}

const sessionStates = new Map<string, SessionState>();
const sessionBusyLocks = new Set<string>();

export function removeSessionState(openCodeId: string, cwd: string): void {
  clearSessionApprovals(openCodeId);
  const key = sessionKey(openCodeId, cwd);
  const state = sessionStates.get(key);
  if (state) {
    state.unsubscribe();
    try {
      state.conn.kill();
    } catch {
      /* ignore */
    }
    sessionStates.delete(key);
  }
}

/** Creates (and switches) the OMP transport for a new persistent session. */
export type OmpConnectionFactory = (cwd: string, sessionPath: string) => Promise<OmpRpcTransport>;

const defaultConnectionFactory: OmpConnectionFactory = async (cwd, sessionPath) => {
  const conn = await OmpRpcConnection.spawn(cwd);
  await conn.switchSession(sessionPath);
  await conn.request("set_subagent_subscription", { level: "events" }).catch(() => {});
  return conn;
};

let connectionFactory: OmpConnectionFactory = defaultConnectionFactory;

/** Test seam: replace the transport factory (e.g. with a fake OMP). */
export function setConnectionFactory(factory: OmpConnectionFactory): void {
  connectionFactory = factory;
}

/** Restore the real OmpRpcConnection-based transport factory. */
export function resetConnectionFactory(): void {
  connectionFactory = defaultConnectionFactory;
}

async function acquireSessionLock(key: string): Promise<() => void> {
  while (sessionBusyLocks.has(key)) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
  sessionBusyLocks.add(key);
  return () => {
    sessionBusyLocks.delete(key);
  };
}

function isPromptBody(value: unknown): value is PromptBody {
  if (value == null || typeof value !== "object") return false;
  if ("parts" in value && !Array.isArray(value.parts)) return false;
  if ("messageID" in value && typeof value.messageID !== "string") return false;
  if ("model" in value && value.model !== null && typeof value.model === "object") {
    const model = value.model as Record<string, unknown>;
    if ("providerID" in model && typeof model.providerID !== "string") return false;
    if ("modelID" in model && typeof model.modelID !== "string") return false;
  }
  if ("variant" in value && typeof value.variant !== "string") return false;
  return true;
}

function isTextPart(value: unknown): value is OpenCodeTextPart {
  if (value == null || typeof value !== "object") return false;
  if (!("type" in value)) return false;
  const t = value.type;
  if (t !== "text") return false;
  if ("text" in value) {
    return typeof value.text === "string";
  }
  return true;
}

export interface ImageContent {
  type: "image";
  data: string; // base64 encoded image data
  mimeType: string;
}

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

export function mimeFromPath(pathOrUrl: string): string | undefined {
  const clean = pathOrUrl.split("?")[0].split("#")[0];
  const dot = clean.lastIndexOf(".");
  if (dot !== -1) {
    const ext = clean.slice(dot).toLowerCase();
    return IMAGE_EXT_TO_MIME[ext];
  }
  return undefined;
}

async function resolveImageFromUrl(
  url: string,
  explicitMime?: string,
  cwd?: string,
): Promise<ImageContent | undefined> {
  if (url.startsWith("data:")) {
    const commaIndex = url.indexOf(",");
    if (commaIndex === -1) return undefined;
    const meta = url.slice(5, commaIndex);
    const data = url.slice(commaIndex + 1);
    const mimeMatch = meta.match(/^([^;,]+)/);
    const mimeType = explicitMime || (mimeMatch ? mimeMatch[1] : undefined) || "image/png";
    return {
      type: "image",
      data,
      mimeType,
    };
  }

  if (isBlobRef(url)) {
    const buffer = readBlobBufferSync(url);
    if (buffer) {
      return {
        type: "image",
        data: buffer.toString("base64"),
        mimeType: explicitMime || "image/png",
      };
    }
  }

  let filePath = url;
  if (filePath.startsWith("file://")) {
    try {
      filePath = new URL(filePath).pathname;
    } catch {
      filePath = filePath.slice(7);
    }
  }

  if (cwd && !isAbsolute(filePath)) {
    filePath = resolve(cwd, filePath);
  }

  try {
    const buffer = await readFile(filePath);
    const mimeType = explicitMime || mimeFromPath(filePath) || "image/png";
    return {
      type: "image",
      data: buffer.toString("base64"),
      mimeType,
    };
  } catch (err) {
    promptLogger.warn({ err, url, filePath }, `[prompt] failed to read image from ${filePath}`);
    return undefined;
  }
}

export async function extractPromptImages(body: PromptBody, cwd?: string): Promise<ImageContent[]> {
  if (!Array.isArray(body.parts)) return [];
  const images: ImageContent[] = [];

  for (const part of body.parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const type = p.type;

    if (type === "image") {
      const mimeType =
        (typeof p.mimeType === "string" ? p.mimeType : undefined) ||
        (typeof p.mime === "string" ? p.mime : undefined);
      if (typeof p.data === "string" && p.data.length > 0) {
        if (isBlobRef(p.data)) {
          const buffer = readBlobBufferSync(p.data);
          if (buffer) {
            images.push({
              type: "image",
              data: buffer.toString("base64"),
              mimeType: mimeType || "image/png",
            });
          }
        } else {
          const rawData = p.data.replace(/^data:[^;,]+;base64,/, "");
          images.push({
            type: "image",
            data: rawData,
            mimeType: mimeType || "image/png",
          });
        }
      } else if (typeof p.url === "string" && p.url.length > 0) {
        const img = await resolveImageFromUrl(p.url, mimeType, cwd);
        if (img) images.push(img);
      }
    } else if (type === "file") {
      const mime =
        (typeof p.mime === "string" ? p.mime : undefined) ||
        (typeof p.mimeType === "string" ? p.mimeType : undefined);
      const url = typeof p.url === "string" ? p.url : "";
      const filename = typeof p.filename === "string" ? p.filename : "";
      const inferredMime = mime || mimeFromPath(filename) || mimeFromPath(url);

      const isImage =
        (inferredMime && inferredMime.startsWith("image/")) ||
        url.startsWith("data:image/") ||
        isBlobRef(url) ||
        (inferredMime !== undefined && inferredMime in IMAGE_EXT_TO_MIME);

      if (isImage) {
        if (typeof p.data === "string" && p.data.length > 0) {
          if (isBlobRef(p.data)) {
            const buffer = readBlobBufferSync(p.data);
            if (buffer) {
              images.push({
                type: "image",
                data: buffer.toString("base64"),
                mimeType: inferredMime || "image/png",
              });
            }
          } else {
            const rawData = p.data.replace(/^data:[^;,]+;base64,/, "");
            images.push({
              type: "image",
              data: rawData,
              mimeType: inferredMime || "image/png",
            });
          }
        } else if (url) {
          const img = await resolveImageFromUrl(url, inferredMime, cwd);
          if (img) images.push(img);
        }
      }
    }
  }

  return images;
}

function extractPromptText(body: PromptBody): string {
  if (!Array.isArray(body.parts)) return "";
  const texts: string[] = [];
  for (const part of body.parts) {
    if (isTextPart(part) && part.text) {
      texts.push(part.text);
    }
  }
  return texts.join("\n\n");
}

function makeMessageId(openCodeId: string, suffix?: string): string {
  return `msg_${openCodeId}_${suffix ?? randomUUID().replace(/-/g, "")}`;
}

function makePartId(openCodeId: string, messageID: string, index: number): string {
  return `part_${openCodeId}_${messageID}_${index}`;
}

function defaultModelRef(overrides?: Partial<ModelRef>): ModelRef {
  return {
    providerID: "omp",
    modelID: "omp",
    variant: "default",
    ...overrides,
  };
}

function emitAssistantInfo(
  openCodeId: string,
  messageID: string,
  parentID: string | undefined,
  model: ModelRef,
  finish?: "stop" | "error" | string,
  cwd?: string,
  createdTime?: number,
  tokens?: TokenBreakdown,
  cost?: number,
  error?: unknown,
): void {
  const dir = cwd || process.cwd();
  const created = createdTime ?? Date.now();
  emitMessageUpdated({
    info: {
      id: messageID,
      role: "assistant",
      sessionID: openCodeId,
      parentID,
      agent: "omp",
      mode: "primary",
      cost: cost ?? 0,
      path: { cwd: dir, root: dir },
      tokens: tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      model: {
        id: model.modelID,
        providerID: model.providerID,
        modelID: model.modelID,
        variant: model.variant,
      },
      providerID: model.providerID,
      modelID: model.modelID,
      variant: model.variant,
      finish,
      error,
      time: { created, completed: finish ? Date.now() : undefined },
    },
  }, dir);
}

function emitAssistantPart(
  openCodeId: string,
  messageID: string,
  partID: string,
  partType: "text" | "reasoning",
  text: string,
  directory?: string,
  startTime?: number,
  endTime?: number,
): void {
  emitMessagePartUpdated(
    openCodeId,
    {
      id: partID,
      type: partType,
      text,
      time: { start: startTime ?? Date.now(), end: endTime },
      messageID,
      sessionID: openCodeId,
    },
    directory,
  );
}

export interface ToolPartState {
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  time?: { start: number; end?: number };
}

function isRpcEventFrame(obj: Record<string, unknown>): boolean {
  if (typeof obj.type === "string" && (
    obj.type.startsWith("tool_execution_") ||
    obj.type.startsWith("toolcall_") ||
    obj.type === "message_update" ||
    obj.type === "message_start" ||
    obj.type === "message_end" ||
    obj.type === "agent_start" ||
    obj.type === "agent_end" ||
    obj.type === "turn_start" ||
    obj.type === "turn_end" ||
    obj.type === "custom"
  )) return true;
  if (typeof obj.customType === "string") return true;
  if ("partial" in obj || "contentIndex" in obj) return true;
  return false;
}

function parseToolInput(value: unknown, descriptionHint?: string): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  let parsed: Record<string, unknown> | undefined;

  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const hint = obj.intent ?? obj.i ?? (typeof obj.data === "object" && obj.data != null ? (obj.data as Record<string, unknown>).intent ?? (obj.data as Record<string, unknown>).i : undefined);
    if (typeof hint === "string" && hint.length > 0) {
      descriptionHint = hint;
    }

    if (obj.toolCall && typeof obj.toolCall === "object") {
      const tc = obj.toolCall as Record<string, unknown>;
      const inner = parseToolInput(tc.arguments ?? tc.args ?? tc.input, descriptionHint);
      if (inner) return inner;
    }
    if (obj.data && typeof obj.data === "object") {
      const d = obj.data as Record<string, unknown>;
      const inner = parseToolInput(d.args ?? d.arguments ?? d.input ?? d.parameters, descriptionHint);
      if (inner) return inner;
    }
    if (obj.args || obj.arguments || obj.input || obj.parameters || obj.params) {
      const innerObj = obj.args ?? obj.arguments ?? obj.input ?? obj.parameters ?? obj.params;
      const inner = parseToolInput(innerObj, descriptionHint);
      if (inner) return inner;
    }

    if (isRpcEventFrame(obj)) {
      return undefined;
    }

    parsed = { ...obj };
  } else if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      if (p != null && typeof p === "object" && !Array.isArray(p)) {
        if (!isRpcEventFrame(p as Record<string, unknown>)) {
          parsed = p as Record<string, unknown>;
        }
      }
    } catch { /* ignore */ }
  }

  if (parsed) {
    if (!parsed.description && (parsed.intent || parsed.i || descriptionHint)) {
      parsed.description = (parsed.intent ?? parsed.i ?? descriptionHint) as string;
    }
  }
  return parsed;
}

function formatToolOutput(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    if (value.length === 0) return "";

    const isContentBlockArray = value.every(
      (item) =>
        item != null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (("type" in item && (item.type === "text" || item.type === "thinking" || item.type === "tool_result" || item.type === "image")) ||
         ("text" in item && typeof (item as Record<string, unknown>).text === "string" && !("status" in item && "content" in item)))
    );

    if (isContentBlockArray) {
      return value
        .map((block) => {
          if (!block || typeof block !== "object") return String(block);
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") return b.text;
          if (typeof b.thinking === "string") return b.thinking;
          if (typeof b.content === "string") return b.content;
          if (typeof b.output === "string") return b.output;
          return JSON.stringify(block);
        })
        .join("\n");
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (obj.data && typeof obj.data === "object") {
      const d = obj.data as Record<string, unknown>;
      return formatToolOutput(d.result ?? d.output ?? d.partialResult ?? d.partial_result ?? d.content);
    }
    if ("result" in obj || "partialResult" in obj || "partial_result" in obj || "output" in obj || "content" in obj) {
      const inner = obj.result ?? obj.partialResult ?? obj.partial_result ?? obj.output ?? obj.content;
      return formatToolOutput(inner);
    }
    if (obj.type === "text" && typeof obj.text === "string") {
      return obj.text;
    }
    if (typeof obj.text === "string" && Object.keys(obj).length === 1) {
      return obj.text;
    }
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getToolError(obj: Record<string, unknown>): string | undefined {
  const d = (typeof obj.data === "object" && obj.data != null ? obj.data : obj) as Record<string, unknown>;
  const value = d.error ?? d.errorMessage ?? d.error_message ?? obj.error ?? obj.errorMessage ?? obj.error_message;
  if (typeof value === "string" && value.length > 0) return value;
  if (d.isError === true || d.is_error === true || d.error === true || obj.isError === true || obj.is_error === true || obj.error === true) {
    const detail = d.output ?? d.content ?? d.result ?? obj.output ?? obj.content ?? obj.result ?? "tool error";
    if (typeof detail === "string") return detail;
    const formatted = formatToolOutput(detail);
    return formatted ?? "tool error";
  }
  return undefined;
}

function getToolCallId(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.toolCall === "object" && obj.toolCall != null) {
    const id = getToolCallId(obj.toolCall as Record<string, unknown>);
    if (id) return id;
  }
  if (typeof obj.data === "object" && obj.data != null) {
    const id = getToolCallId(obj.data as Record<string, unknown>);
    if (id) return id;
  }
  if (
    typeof obj.partial === "object" &&
    obj.partial != null &&
    Array.isArray((obj.partial as { content?: unknown[] }).content)
  ) {
    const content = (obj.partial as { content: unknown[] }).content;
    const idx = typeof obj.contentIndex === "number" ? obj.contentIndex : 0;
    const block = content[idx];
    if (block && typeof block === "object") {
      const id = getToolCallId(block as Record<string, unknown>);
      if (id) return id;
    }
  }
  const value = obj.toolCallId ?? obj.tool_call_id ?? obj.callId ?? obj.call_id ?? obj.id ?? obj.toolCallID;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getToolName(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.toolCall === "object" && obj.toolCall != null) {
    const name = getToolName(obj.toolCall as Record<string, unknown>);
    if (name) return name;
  }
  if (typeof obj.data === "object" && obj.data != null) {
    const name = getToolName(obj.data as Record<string, unknown>);
    if (name) return name;
  }
  if (
    typeof obj.partial === "object" &&
    obj.partial != null &&
    Array.isArray((obj.partial as { content?: unknown[] }).content)
  ) {
    const content = (obj.partial as { content: unknown[] }).content;
    const idx = typeof obj.contentIndex === "number" ? obj.contentIndex : 0;
    const block = content[idx];
    if (block && typeof block === "object") {
      const name = getToolName(block as Record<string, unknown>);
      if (name) return name;
    }
  }
  const value = obj.name ?? obj.tool ?? obj.toolName ?? obj.tool_name ?? obj.function;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function reduceToolPartState(
  current: ToolPartState | undefined,
  event: Record<string, unknown>,
  now = Date.now(),
  toolName?: string,
): ToolPartState {
  const state: ToolPartState = current ? { ...current } : { status: "pending" };
  if (state.time) state.time = { ...state.time };
  const type = ((event.type ?? event.customType) as string) || "";
  const resolvedToolName = toolName ?? getToolName(event);

  const intentHint =
    (typeof event.intent === "string" && event.intent.length > 0 ? event.intent : undefined) ??
    (typeof event.i === "string" && event.i.length > 0 ? event.i : undefined) ??
    (typeof event.data === "object" && event.data != null
      ? (typeof (event.data as Record<string, unknown>).intent === "string" ? (event.data as Record<string, unknown>).intent as string : undefined) ??
        (typeof (event.data as Record<string, unknown>).i === "string" ? (event.data as Record<string, unknown>).i as string : undefined)
      : undefined) ??
    (typeof event.toolCall === "object" && event.toolCall != null
      ? (typeof (event.toolCall as Record<string, unknown>).intent === "string" ? (event.toolCall as Record<string, unknown>).intent as string : undefined) ??
        (typeof (event.toolCall as Record<string, unknown>).i === "string" ? (event.toolCall as Record<string, unknown>).i as string : undefined)
      : undefined);

  const rawInput =
    event.arguments ??
    event.args ??
    event.input ??
    event.parameters ??
    (typeof event.toolCall === "object" && event.toolCall != null
      ? (event.toolCall as Record<string, unknown>).arguments ??
        (event.toolCall as Record<string, unknown>).args ??
        (event.toolCall as Record<string, unknown>).input ??
        (event.toolCall as Record<string, unknown>).parameters
      : undefined) ??
    (typeof event.data === "object" && event.data != null
      ? (event.data as Record<string, unknown>).args ??
        (event.data as Record<string, unknown>).arguments ??
        (event.data as Record<string, unknown>).input ??
        (event.data as Record<string, unknown>).parameters
      : undefined);

  const input = rawInput != null ? parseToolInput(rawInput, intentHint) : undefined;
  if (input && Object.keys(input).length > 0) {
    const normalizedInput = normalizeToolInput(resolvedToolName, input);
    state.input = { ...state.input, ...normalizedInput };
  }

  const rawDetails =
    event.details ??
    (typeof event.data === "object" && event.data != null
      ? (event.data as Record<string, unknown>).details
      : undefined);

  if (
    type === "toolcall_start" ||
    type === "toolcall_delta" ||
    type === "toolcall_end" ||
    type === "toolCall" ||
    type === "tool_call"
  ) {
    if (type !== "toolcall_delta" && !state.time) {
      state.time = { start: now };
    }
  } else if (type === "tool_execution_start") {
    state.status = "running";
    if (!state.time) state.time = { start: now };
  } else if (type === "tool_execution_update") {
    if (state.status === "completed" || state.status === "error") {
      return state;
    }
    state.status = "running";
    const output = formatToolOutput(event.output ?? event.content ?? event.result ?? event.partialResult ?? event.partial_result ?? (typeof event.data === "object" && event.data != null ? event.data : undefined));
    if (output != null) {
      const normalizedOutput = normalizeToolOutput(resolvedToolName, output, rawDetails);
      if (
        (resolvedToolName === "bash" || resolvedToolName === "terminal" || resolvedToolName === "exec") &&
        state.output &&
        normalizedOutput &&
        !normalizedOutput.startsWith(state.output)
      ) {
        state.output = state.output + "\n" + normalizedOutput;
      } else {
        state.output = normalizedOutput;
      }
    }
  } else if (type === "tool_execution_end") {
    const error = getToolError(event);
    if (error) {
      state.status = "error";
      state.error = error;
    } else {
      state.status = "completed";
    }
    const output = formatToolOutput(event.output ?? event.content ?? event.result ?? (typeof event.data === "object" && event.data != null ? event.data : undefined));
    if (output != null) {
      state.output = normalizeToolOutput(resolvedToolName, output, rawDetails);
    }
    if (!state.time) state.time = { start: now };
    state.time.end = now;
  }

  return state;
}

export function createEventHandler(
  openCodeId: string,
  parentMessageID: string | undefined,
  model: ModelRef,
  onComplete: () => void,
  conn?: OmpRpcTransport,
  cwd?: string,
  sessionPath?: string,
) {
  let assistantMessageID: string | undefined;
  let assistantStartTime: number | undefined;
  let currentPartType: "text" | "reasoning" | undefined;
  let activePartId: string | undefined;
  let activePartStartTime: number | undefined;
  let activePartText = "";
  let partIndex = 0;
  let hasStarted = false;

  const toolParts = new Map<string, { tool: string; state: ToolPartState }>();

  const ensureStarted = () => {
    if (hasStarted) return;
    hasStarted = true;
    assistantStartTime = Date.now();
    assistantMessageID = makeMessageId(
      openCodeId,
      parentMessageID ? `asst_${parentMessageID}` : `assistant_${assistantStartTime}`,
    );
    emitAssistantInfo(openCodeId, assistantMessageID, parentMessageID, model, undefined, cwd, assistantStartTime);
  };

  const finalizeCurrentPart = () => {
    if (!currentPartType || !activePartId || !assistantMessageID) return;
    if (currentPartType === "reasoning") {
      const now = Date.now();
      emitAssistantPart(
        openCodeId,
        assistantMessageID,
        activePartId,
        "reasoning",
        activePartText,
        cwd,
        activePartStartTime ?? now,
        now,
      );
    }
    currentPartType = undefined;
    activePartId = undefined;
    activePartStartTime = undefined;
    activePartText = "";
  };

  const emitToolPart = (toolCallId: string, tool: string|undefined, state: ToolPartState) => {
    ensureStarted();
    if (!toolParts.has(toolCallId)) {
      finalizeCurrentPart();
    }
    const mid = assistantMessageID!;
    const entry = toolParts.get(toolCallId);
    const validTool = tool && tool !== "tool" ? tool : undefined;
    if (entry) {
      if (validTool) entry.tool = validTool;
      entry.state = state;
    } else {
      toolParts.set(toolCallId, { tool: validTool ?? "tool", state });
    }
    const entryRef = toolParts.get(toolCallId);
    const effectiveTool = entryRef && entryRef.tool !== "tool" ? entryRef.tool : (validTool ?? "tool");
    if (state.input) {
      state.input = normalizeToolInput(effectiveTool, state.input);
    }
    if (state.output !== undefined) {
      state.output = normalizeToolOutput(effectiveTool, state.output);
    }
    emitMessagePartUpdated(openCodeId, {
      id: toolCallId,
      type: "tool",
      callID: toolCallId,
      tool: effectiveTool,
      state,
      messageID: mid,
      sessionID: openCodeId,
    }, cwd);
  };

  let nonTerminalTimer: ReturnType<typeof setTimeout> | undefined;
  let latestTokens: TokenBreakdown = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let latestCost = 0;

  return (event: OmpRpcEvent) => {
    const type = event.type;
    if (typeof type !== "string") return;

    const rawUsage = event.usage ??
      (typeof event.data === "object" && event.data !== null ? (event.data as Record<string, unknown>).usage : undefined) ??
      (typeof event.message === "object" && event.message !== null ? (event.message as Record<string, unknown>).usage : undefined) ??
      (typeof event.assistantMessageEvent === "object" && event.assistantMessageEvent !== null ? (event.assistantMessageEvent as Record<string, unknown>).usage : undefined) ??
      (typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>).usage : undefined);

    let usageUpdated = false;
    if (rawUsage) {
      const mapped = mapOmpUsageToTokens(rawUsage, event.cost);
      if (mapped.tokens.input > 0 || mapped.tokens.output > 0 || mapped.tokens.cache.read > 0 || mapped.tokens.cache.write > 0) {
        latestTokens = mapped.tokens;
        usageUpdated = true;
      }
      if (mapped.cost > 0) {
        latestCost = (latestCost || 0) + mapped.cost;
        usageUpdated = true;
      }
    }

    const rawMsg = (event.message || event.data || event.assistantMessageEvent) as Record<string, unknown> | undefined;
    if (rawMsg && typeof rawMsg.provider === "string" && typeof rawMsg.model === "string") {
      if (model.providerID !== rawMsg.provider || model.modelID !== rawMsg.model) {
        model.providerID = rawMsg.provider;
        model.modelID = rawMsg.model;
        if (typeof rawMsg.variant === "string") model.variant = rawMsg.variant;
        usageUpdated = true;
      }
    }

    if (type === "tool_execution_end" || type === "turn_end" || type === "message_end") {
      if (sessionPath) {
        (async () => {
          try {
            const header = await readSessionHeader(sessionPath);
            if (header?.tokens && (header.tokens.input > 0 || header.tokens.output > 0)) {
              latestTokens = header.tokens;
              if (header.cost !== undefined) latestCost = header.cost;
              if (header.model && (!model.providerID || model.providerID === "omp")) {
                model.providerID = header.model.providerID;
                model.modelID = header.model.modelID;
              }
              if (assistantMessageID) {
                emitAssistantInfo(
                  openCodeId,
                  assistantMessageID,
                  parentMessageID,
                  model,
                  undefined,
                  cwd,
                  assistantStartTime,
                  latestTokens,
                  latestCost,
                );
              }
            }
          } catch { /* best effort */ }
        })();
      }
    }

    if (usageUpdated && assistantMessageID) {
      emitAssistantInfo(
        openCodeId,
        assistantMessageID,
        parentMessageID,
        model,
        undefined,
        cwd,
        assistantStartTime,
        latestTokens,
        latestCost,
      );
    }

    const handleTurnEnd = () => {
      const isError = event.stopReason === "error" || Boolean(event.errorMessage) || (typeof event.error === "string" && event.error.length > 0);
      const rawError = typeof event.errorMessage === "string" ? event.errorMessage : (typeof event.error === "string" ? event.error : undefined);

      if (isError) {
        promptLogger.error(
          {
            sessionID: openCodeId,
            provider: (event.provider as string) || model.providerID,
            model: (event.model as string) || model.modelID,
            stopReason: event.stopReason,
            errorStatus: event.errorStatus,
            errorId: event.errorId,
            errorMessage: rawError,
          },
          "[prompt] agent turn ended with provider error",
        );

        if (!hasStarted) {
          ensureStarted();
        }

        if (assistantMessageID && partIndex === 0 && !activePartText && toolParts.size === 0) {
          const errText = rawError ? `⚠️ **Provider Error**: ${rawError}` : "⚠️ **Provider Error**: Turn ended with error.";
          emitAssistantPart(
            openCodeId,
            assistantMessageID,
            makePartId(openCodeId, assistantMessageID, 0),
            "text",
            errText,
            cwd,
            assistantStartTime,
            Date.now(),
          );
        }

        if (assistantMessageID) {
          emitAssistantInfo(
            openCodeId,
            assistantMessageID,
            parentMessageID,
            model,
            "error",
            cwd,
            assistantStartTime,
            latestTokens,
            latestCost,
            rawError ? { message: rawError } : { message: "Turn ended with error" },
          );
        }

        emitSessionError(openCodeId, { message: rawError || "Turn ended with error" }, cwd);
      } else {
        if (assistantMessageID) {
          emitAssistantInfo(openCodeId, assistantMessageID, parentMessageID, model, "stop", cwd, assistantStartTime, latestTokens, latestCost);
        }
      }
    };

    if (
      (type === "agent_end" && (event.isTerminal === undefined || event.isTerminal === true)) ||
      (type === "prompt_result" && event.agentInvoked === false)
    ) {
      if (nonTerminalTimer) clearTimeout(nonTerminalTimer);
      finalizeCurrentPart();
      handleTurnEnd();
      onComplete();
      return;
    }

    if (type === "agent_end" && event.isTerminal === false) {
      if (nonTerminalTimer) clearTimeout(nonTerminalTimer);
      const isError = event.stopReason === "error" || Boolean(event.errorMessage) || (typeof event.error === "string" && event.error.length > 0);
      const rawError = typeof event.errorMessage === "string" ? event.errorMessage : (typeof event.error === "string" ? event.error : undefined);
      if (isError) {
        promptLogger.error(
          {
            sessionID: openCodeId,
            provider: (event.provider as string) || model.providerID,
            model: (event.model as string) || model.modelID,
            stopReason: event.stopReason,
            errorStatus: event.errorStatus,
            errorId: event.errorId,
            errorMessage: rawError,
          },
          "[prompt] non-terminal agent turn ended with provider error",
        );
      }
      nonTerminalTimer = setTimeout(() => {
        finalizeCurrentPart();
        handleTurnEnd();
        onComplete();
      }, 1500);
      return;
    }

    if (nonTerminalTimer) {
      clearTimeout(nonTerminalTimer);
      nonTerminalTimer = undefined;
    }

    if (type === "extension_ui_request") {
      finalizeCurrentPart();
      const reqId = String(event.id ?? randomUUID());
      const method = String(event.method ?? "confirm");
      const title = String(event.title ?? "");
      const message = String(event.message ?? "");

      if (method === "confirm") {
        const permReq: PermissionRequest = {
          id: reqId,
          sessionID: openCodeId,
          permission: title || "execute",
          patterns: [],
          metadata: { message, title, ...event },
          always: [],
          tool: assistantMessageID ? { messageID: assistantMessageID, callID: reqId } : undefined,
          directory: cwd,
        };
        addPendingPermission(permReq, (res) => {
          conn?.sendFrame?.({
            type: "extension_ui_response",
            id: reqId,
            ...(res.cancelled ? { cancelled: true } : { confirmed: res.confirmed ?? true }),
          });
        });
        emitPermissionAsked(permReq as unknown as Record<string, unknown>, cwd);
      } else if (method === "select" || method === "input") {
        const rawOptions = (event.options ?? []) as Array<string | { label?: string; value?: string; description?: string }>;
        const options = rawOptions.map((opt) =>
          typeof opt === "string"
            ? { label: opt, description: "" }
            : { label: opt.label ?? opt.value ?? "", description: opt.description ?? "" }
        );
        const qReq: QuestionRequest = {
          id: reqId,
          sessionID: openCodeId,
          questions: [
            {
              question: message || title || "Input requested",
              header: title || "Prompt",
              options,
              multiple: false,
              custom: method === "input",
            },
          ],
          tool: assistantMessageID ? { messageID: assistantMessageID, callID: reqId } : undefined,
          directory: cwd,
        };
        addPendingQuestion(qReq, (res) => {
          conn?.sendFrame?.({
            type: "extension_ui_response",
            id: reqId,
            value: res.value ?? "",
            ...(res.cancelled ? { cancelled: true } : {}),
          });
        });
        emitQuestionAsked(qReq as unknown as Record<string, unknown>, cwd);
      }
      return;
    }

    if (type === "custom") {
      const customType = typeof event.customType === "string" ? event.customType : "";
      if (
        customType === "tool_execution_start" ||
        customType === "tool_execution_update" ||
        customType === "tool_execution_end"
      ) {
        const payload = ((typeof event.data === "object" && event.data != null ? event.data : event) as Record<string, unknown>);
        const toolCallId = getToolCallId(payload) ?? getToolCallId(event) ?? `tool_${randomUUID().replace(/-/g, "")}`;
        const tool = getToolName(payload) ?? getToolName(event);
        const existing = toolParts.get(toolCallId);
        const resolvedTool = tool ?? existing?.tool;
        const state = reduceToolPartState(existing?.state, { type: customType, ...payload }, Date.now(), resolvedTool);
        emitToolPart(toolCallId, resolvedTool, state);
        return;
      }
    }

    if (type === "subagent_lifecycle") {
      const payload = (event.payload || {}) as Record<string, unknown>;
      const subagentId = String(payload.id ?? "");
      if (subagentId) {
        const childOpenCodeId = toOpenCodeSessionId(subagentId);
        const status = String(payload.status ?? "");
        const agentName = String(payload.agent ?? "task");
        const description = typeof payload.description === "string" && payload.description.trim().length > 0
          ? payload.description.trim()
          : `Subagent (${agentName})`;

        if (status === "started") {
          setSubagentStatus(childOpenCodeId, { type: "busy" });
          emitSessionCreated({
            id: childOpenCodeId,
            slug: childOpenCodeId,
            projectID: "global",
            directory: cwd,
            path: typeof payload.sessionFile === "string" ? payload.sessionFile : "",
            title: description,
            parentID: openCodeId,
            agent: agentName,
            model: { id: "omp", providerID: "omp", modelID: "omp", variant: "default" },
            version: "0.0.0",
            time: { created: Date.now(), updated: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }, cwd);
          emitSessionStatus(childOpenCodeId, { type: "busy" }, cwd);
        } else {
          setSubagentStatus(childOpenCodeId, undefined);
          emitSessionStatus(childOpenCodeId, { type: "idle" }, cwd);
          emitSessionUpdated({
            id: childOpenCodeId,
            parentID: openCodeId,
            time: { updated: Date.now() },
          }, cwd);
        }
      }
      return;
    }

    if (type === "subagent_progress") {
      const payload = (event.payload || {}) as Record<string, unknown>;
      const progress = (payload.progress || {}) as Record<string, unknown>;
      const subagentId = String(progress.id ?? payload.id ?? "");
      if (subagentId) {
        const childOpenCodeId = toOpenCodeSessionId(subagentId);
        const status = String(progress.status ?? "");
        if (status === "running" || status === "busy") {
          setSubagentStatus(childOpenCodeId, { type: "busy" });
          emitSessionStatus(childOpenCodeId, { type: "busy" }, cwd);
        } else if (status === "completed" || status === "error" || status === "aborted") {
          setSubagentStatus(childOpenCodeId, undefined);
          emitSessionStatus(childOpenCodeId, { type: "idle" }, cwd);
        }
      }
      return;
    }

    if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
      const payload = typeof event.payload === "object" && event.payload != null
        ? { type: event.type, ...(event.payload as Record<string, unknown>) }
        : event;
      const toolCallId = getToolCallId(payload) ?? `tool_${randomUUID().replace(/-/g, "")}`;
      const tool = getToolName(payload);
      const existing = toolParts.get(toolCallId);
      const resolvedTool = tool ?? existing?.tool;
      const state = reduceToolPartState(existing?.state, payload, Date.now(), resolvedTool);
      emitToolPart(toolCallId, resolvedTool, state);

      if (isTodoTool(resolvedTool) && (state.status === "completed" || type === "tool_execution_end")) {
        const rawDetails = payload.details ?? (typeof payload.data === "object" && payload.data != null ? (payload.data as Record<string, unknown>).details : undefined) ?? event.details;
        const todos = extractTodosFromOmpDetails(rawDetails, payload.result ?? payload.output);
        if (todos) {
          emitTodoUpdated(openCodeId, todos, cwd);
        } else if (conn) {
          conn.request("get_state", {}).then((raw) => {
            const statePhases = (raw as Record<string, unknown>)?.todoPhases;
            const fetchedTodos = extractTodosFromOmpDetails({ phases: statePhases });
            if (fetchedTodos) {
              emitTodoUpdated(openCodeId, fetchedTodos, cwd);
            }
          }).catch(() => {});
        }
      }
      return;
    }

    if (type !== "message_update") return;

    const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") return;

    const eventType = assistantMessageEvent.type as string | undefined;
    const rawText = assistantMessageEvent.text ?? assistantMessageEvent.delta ?? assistantMessageEvent.content;
    const deltaText = typeof rawText === "string" ? rawText : "";

    if (eventType === "text_delta" || eventType === "thinking_delta") {
      ensureStarted();
      const mid = assistantMessageID!;
      const partType = eventType === "thinking_delta" ? "reasoning" : "text";
      if (currentPartType !== partType) {
        finalizeCurrentPart();
        partIndex++;
        currentPartType = partType;
        activePartId = makePartId(openCodeId, mid, partIndex);
        activePartStartTime = Date.now();
        activePartText = deltaText;
        emitAssistantPart(openCodeId, mid, activePartId, partType, deltaText, cwd, activePartStartTime);
      } else {
        if (deltaText) {
          activePartText += deltaText;
          emitMessagePartDelta(openCodeId, mid, activePartId ?? makePartId(openCodeId, mid, partIndex), deltaText, cwd);
        }
      }
      return;
    }

    if (
      typeof eventType === "string" &&
      (eventType.startsWith("toolcall_") || eventType === "toolCall" || eventType === "tool_call")
    ) {
      ensureStarted();
      const toolCallId = getToolCallId(assistantMessageEvent) ?? `tool_${randomUUID().replace(/-/g, "")}`;
      const tool = getToolName(assistantMessageEvent);
      const existing = toolParts.get(toolCallId);
      const resolvedTool = tool ?? existing?.tool;
      const state = reduceToolPartState(existing?.state, assistantMessageEvent, Date.now(), resolvedTool);
      emitToolPart(toolCallId, resolvedTool, state);

      if (isTodoTool(resolvedTool) && (state.status === "completed" || eventType === "toolcall_end" || eventType === "tool_execution_end")) {
        const rawDetails = assistantMessageEvent.details ?? (typeof assistantMessageEvent.data === "object" && assistantMessageEvent.data != null ? (assistantMessageEvent.data as Record<string, unknown>).details : undefined);
        const todos = extractTodosFromOmpDetails(rawDetails, assistantMessageEvent.result ?? assistantMessageEvent.output);
        if (todos) {
          emitTodoUpdated(openCodeId, todos, cwd);
        } else if (conn) {
          conn.request("get_state", {}).then((raw) => {
            const statePhases = (raw as Record<string, unknown>)?.todoPhases;
            const fetchedTodos = extractTodosFromOmpDetails({ phases: statePhases });
            if (fetchedTodos) {
              emitTodoUpdated(openCodeId, fetchedTodos, cwd);
            }
          }).catch(() => {});
        }
      }
      return;
    }
  };
}

async function getOrCreateSessionState(
  openCodeId: string,
  cwd: string,
  sessionPath: string,
): Promise<SessionState> {
  const key = sessionKey(openCodeId, cwd);
  const existing = sessionStates.get(key);
  if (existing) return existing;

  const conn = await connectionFactory(cwd, sessionPath);

  const modelFromRpc = await getCurrentModel(conn).catch(() => undefined);

  const state: SessionState = {
    conn,
    busy: false,
    openCodeId,
    cwd,
    sessionPath,
    unsubscribe: () => {},
    currentModel: defaultModelRef({
      providerID: modelFromRpc?.providerID ?? "omp",
      modelID: modelFromRpc?.modelID ?? "omp",
      variant: modelFromRpc?.variant ?? "default",
    }),
  };

  sessionStates.set(key, state);
  return state;
}
export async function promptSessionAsync(
  openCodeId: string,
  cwd: string,
  sessionPath: string,
  body: unknown,
): Promise<{ queued: boolean; error?: string; status?: number }> {
  if (!isPromptBody(body)) {
    return { queued: false, error: "invalid body", status: 400 };
  }

  const promptText = extractPromptText(body);
  const images = await extractPromptImages(body, cwd);
  if (!promptText && images.length === 0) {
    return { queued: false, error: "no text parts", status: 400 };
  }

  const key = sessionKey(openCodeId, cwd);
  const release = await acquireSessionLock(key);

  try {
    const state = await getOrCreateSessionState(openCodeId, cwd, sessionPath);

    if (state.busy) {
      return { queued: false, error: "session busy", status: 409 };
    }

    state.busy = true;
    invalidateMessageCache(openCodeId, cwd);
    emitSessionStatus(openCodeId, { type: "busy" }, cwd);

    const parentMessageID = body.messageID;
    const modelRef = body.model?.providerID && body.model?.modelID
      ? {
          providerID: body.model.providerID,
          modelID: body.model.modelID,
          variant: body.variant ?? "default",
        }
      : undefined;

    if (modelRef) {
      state.currentModel = defaultModelRef(modelRef);
    }

    if (parentMessageID) {
      recordUserMessageId(openCodeId, promptText, parentMessageID);
      const userMsgTime = Date.now() - 1;
      emitMessageUpdated(
        {
          info: {
            id: parentMessageID,
            sessionID: openCodeId,
            role: "user",
            agent: "omp",
            model: {
              id: state.currentModel.modelID,
              providerID: state.currentModel.providerID,
              modelID: state.currentModel.modelID,
              variant: state.currentModel.variant,
            },
            time: { created: userMsgTime, completed: userMsgTime },
          },
        },
        cwd,
      );

      let textPartIndex: number | undefined;
      let nextPartIndex = 0;
      if (promptText) {
        textPartIndex = nextPartIndex++;
      }

      // Emit file/image parts before text parts so OpenChamber's event-reducer
      // replaces optimistic file parts in place (it gates optimistic part replacement
      // on the first part lacking sessionID). Emitting text first assigns sessionID
      // to part 0, causing subsequent file parts to be appended as duplicates.
      if (Array.isArray(body.parts)) {
        for (const part of body.parts) {
          if (part && typeof part === "object" && "type" in part && (part.type === "file" || part.type === "image")) {
            const p = part as Record<string, unknown>;
            const mime = (typeof p.mime === "string" ? p.mime : undefined) ||
                         (typeof p.mimeType === "string" ? p.mimeType : undefined) ||
                         "image/png";
            const url = typeof p.url === "string"
              ? p.url
              : (typeof p.data === "string" ? `data:${mime};base64,${p.data}` : "");
            emitMessagePartUpdated(
              openCodeId,
              {
                id: (typeof p.id === "string" ? p.id : undefined) || `part_${openCodeId}_${parentMessageID}_${nextPartIndex++}`,
                type: "file",
                mime,
                url,
                ...(p.filename ? { filename: p.filename } : {}),
                messageID: parentMessageID,
                sessionID: openCodeId,
              },
              cwd,
            );
          }
        }
      }

      if (promptText && textPartIndex !== undefined) {
        emitMessagePartUpdated(
          openCodeId,
          {
            id: `part_${openCodeId}_${parentMessageID}_${textPartIndex}`,
            type: "text",
            text: promptText,
            messageID: parentMessageID,
            sessionID: openCodeId,
          },
          cwd,
        );
      }
    }

    (async () => {
      try {
        if (modelRef) {
          try {
            await state.conn.request("set_model", {
              provider: modelRef.providerID,
              modelId: modelRef.modelID,
            });
          } catch (err) {
            promptLogger.error({ err, sessionID: openCodeId }, `[prompt] ${openCodeId} set_model failed`);
          }
        }

        const { promise: completion, resolve: markComplete } = Promise.withResolvers<void>();

        let completed = false;
        const complete = () => {
          if (completed) return;
          completed = true;
          markComplete();
        };

        state.unsubscribe();
        state.unsubscribe = state.conn.onEvent(
          createEventHandler(openCodeId, parentMessageID, state.currentModel, complete, state.conn, cwd, state.sessionPath),
        );

        const promptPayload: { message: string; images?: ImageContent[] } = {
          message: promptText,
        };
        if (images.length > 0) {
          promptPayload.images = images;
        }

        await state.conn.request("prompt", promptPayload);
        await completion;

        if (promptText && !isLowSignalTitleInput(promptText)) {
          (async () => {
            try {
              const session = await getOmpSessionByOpenCodeId(openCodeId, cwd);
              if (session && (!session.title || session.title.startsWith("Session "))) {
                const titleCandidate = normalizeGeneratedTitle(promptText, promptText);
                if (titleCandidate) {
                  await setOmpSessionTitle(openCodeId, titleCandidate, "auto", cwd);
                }
              }
            } catch {
              // best effort background title generation
            }
          })();
        }
      } catch (err) {
        const messageID = makeMessageId(openCodeId, `error_${Date.now()}`);
        const errorModel = state.currentModel;
        emitSessionError(openCodeId, err, cwd);
        emitAssistantInfo(openCodeId, messageID, parentMessageID, errorModel, "stop", cwd);
        emitAssistantPart(openCodeId, messageID, makePartId(openCodeId, messageID, 0), "text", `Prompt failed: ${err instanceof Error ? err.message : String(err)}`);
        promptLogger.error({ err, sessionID: openCodeId }, `[prompt] ${openCodeId} failed`);
      } finally {
        state.unsubscribe();
        state.busy = false;
        emitSessionStatus(openCodeId, { type: "idle" }, cwd);
        emitSessionIdle(openCodeId, cwd);
      }
    })();

    return { queued: true };
  } finally {
    release();
  }
}

export async function abortSession(openCodeId: string, cwd: string): Promise<boolean> {
  const key = sessionKey(openCodeId, cwd);
  const release = await acquireSessionLock(key);
  try {
    const state = sessionStates.get(key);
    if (!state) return false;

    try {
      await state.conn.request("abort", {});
    } catch (err) {
      promptLogger.error({ err, sessionID: openCodeId }, `[abort] ${openCodeId} RPC abort failed`);
      state.conn.kill();
      sessionStates.delete(key);
    }
    state.unsubscribe();
    state.busy = false;
    emitSessionStatus(openCodeId, { type: "idle" }, cwd);
    emitSessionIdle(openCodeId, cwd);
    return true;
  } finally {
    release();
  }
}

export function isSessionBusy(openCodeId: string, cwd: string): boolean {
  return sessionStates.get(sessionKey(openCodeId, cwd))?.busy ?? false;
}

const subagentStatusMap = new Map<string, { type: string }>();

export function setSubagentStatus(childOpenCodeId: string, status?: { type: string }): void {
  if (!status) {
    subagentStatusMap.delete(childOpenCodeId);
  } else {
    subagentStatusMap.set(childOpenCodeId, status);
  }
}

export function getSessionStatusMap(): Record<string, { type: string }> {
  const result: Record<string, { type: string }> = {};
  for (const state of sessionStates.values()) {
    if (state.busy) result[state.openCodeId] = { type: "busy" };
  }
  for (const [id, status] of subagentStatusMap) {
    result[id] = status;
  }
  return result;
}

/** Kill every persistent OMP child and ephemeral RPC process; used on process shutdown. */
export function shutdownAll(): void {
  for (const [key, state] of sessionStates) {
    try {
      state.unsubscribe();
      state.busy = false;
      state.conn.kill();
    } catch {
      /* ignore */
    }
    sessionStates.delete(key);
  }
  sessionBusyLocks.clear();
  OmpRpcConnection.killAll();
}
