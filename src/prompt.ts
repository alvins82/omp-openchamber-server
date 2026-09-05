import { allBackends, backendById, backendForSession, nativeProviderID, splitProviderPrefix } from "./providers/registry";
import type { ImageContent, ModelRef, ToolPartState, TokenBreakdown, BackendTurnConnection, NormalizedTurnEvent } from "./providers/types";
import { promptLogger } from "./logger";
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
  emitPermissionReplied,
  emitQuestionReplied,
  emitQuestionRejected,
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
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

interface OpenCodeTextPart {
  type: "text";
  text?: string;
}

type OpenCodePart = OpenCodeTextPart | { type: "file" | "image" | string; [key: string]: unknown } | Record<string, unknown>;

interface PromptBody {
  parts?: OpenCodePart[];
  messageID?: string;
  model?: { providerID?: string; modelID?: string };
  variant?: string;
}

interface SessionState {
  conn: BackendTurnConnection;
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
          const rawData = String(p.data).replace(/^data:[^;,]+;base64,/, "");
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
            const rawData = String(p.data).replace(/^data:[^;,]+;base64,/, "");
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


/**
 * Assembly-only SSE sink: consumes backend-normalized turn events and emits
 * the OpenCode SSE surface. All backend/transport specifics live in the
 * provider adapters (see src/providers/).
 */
export function createEventHandler(
  openCodeId: string,
  parentMessageID: string | undefined,
  model: ModelRef,
  onComplete: () => void,
  cwd?: string,
): (event: NormalizedTurnEvent) => void {
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

  let latestTokens: TokenBreakdown = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let latestCost = 0;

  const emitUsageInfo = () => {
    if (!assistantMessageID) return;
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
  };

  return (event: NormalizedTurnEvent) => {
    switch (event.kind) {
      case "usage": {
        latestTokens = event.tokens;
        latestCost = event.cost;
        emitUsageInfo();
        return;
      }
      case "model": {
        model.providerID = event.model.providerID;
        model.modelID = event.model.modelID;
        model.variant = event.model.variant;
        emitUsageInfo();
        return;
      }
      case "text_delta":
      case "reasoning_delta": {
        ensureStarted();
        const mid = assistantMessageID!;
        const partType: "text" | "reasoning" = event.kind === "reasoning_delta" ? "reasoning" : "text";
        const deltaText = event.text;
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
      case "tool": {
        emitToolPart(event.callID, event.tool, event.state);
        return;
      }
      case "todo": {
        emitTodoUpdated(openCodeId, event.todos, cwd);
        return;
      }
      case "subagent_started": {
        const childOpenCodeId = event.childId;
        setSubagentStatus(childOpenCodeId, { type: "busy" });
        emitSessionCreated({
          id: childOpenCodeId,
          slug: childOpenCodeId,
          projectID: "global",
          directory: cwd,
          path: event.sessionFile ?? "",
          title: event.description ?? `Subagent (${event.agent ?? "task"})`,
          parentID: openCodeId,
          agent: event.agent ?? "task",
          model: { id: model.modelID, providerID: model.providerID, modelID: model.modelID, variant: model.variant },
          version: "0.0.0",
          time: { created: Date.now(), updated: Date.now() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }, cwd);
        emitSessionStatus(childOpenCodeId, { type: "busy" }, cwd);
        return;
      }
      case "subagent_ended": {
        setSubagentStatus(event.childId, undefined);
        emitSessionStatus(event.childId, { type: "idle" }, cwd);
        emitSessionUpdated({
          id: event.childId,
          parentID: openCodeId,
          time: { updated: Date.now() },
        }, cwd);
        return;
      }
      case "subagent_status": {
        if (event.status === "busy") {
          setSubagentStatus(event.childId, { type: "busy" });
          emitSessionStatus(event.childId, { type: "busy" }, cwd);
        } else {
          setSubagentStatus(event.childId, undefined);
          emitSessionStatus(event.childId, { type: "idle" }, cwd);
        }
        return;
      }
      case "permission_request": {
        finalizeCurrentPart();
        const permReq: PermissionRequest = {
          id: event.id,
          sessionID: openCodeId,
          permission: event.permission,
          patterns: [],
          metadata: event.metadata,
          always: [],
          tool: assistantMessageID ? { messageID: assistantMessageID, callID: event.id } : undefined,
          directory: cwd,
        };
        addPendingPermission(permReq, (res) => {
          emitPermissionReplied(permReq.sessionID, permReq.id, res.cancelled ? "reject" : "once", cwd);
          event.respond(res);
        });
        emitPermissionAsked(permReq as unknown as Record<string, unknown>, cwd);
        return;
      }
      case "question_request": {
        finalizeCurrentPart();
        const qReq: QuestionRequest = {
          id: event.id,
          sessionID: openCodeId,
          questions: event.questions,
          tool: assistantMessageID ? { messageID: assistantMessageID, callID: event.id } : undefined,
          directory: cwd,
        };
        addPendingQuestion(qReq, (res) => {
          if (res.cancelled) {
            emitQuestionRejected(qReq.sessionID, qReq.id, cwd);
          } else {
            emitQuestionReplied(qReq.sessionID, qReq.id, [[res.value ?? ""]], cwd);
          }
          event.respond(res);
        });
        emitQuestionAsked(qReq as unknown as Record<string, unknown>, cwd);
        return;
      }
      case "turn_end": {
        finalizeCurrentPart();
        const isError = event.stopReason === "error" || Boolean(event.error) || (typeof event.error === "string" && event.error.length > 0);
        const rawError = event.error;
        if (isError) {
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
        onComplete();
        return;
      }
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

  const conn = await backendForSession(openCodeId).createTurnConnection(cwd, sessionPath, openCodeId);

  const modelFromRpc = await conn.getInitialModel?.();

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
  // D1: a namespaced model prefix must match the backend that owns this
  // session; a session is bound to its backend for its lifetime.
  const requestedPrefix = splitProviderPrefix(body.model?.providerID ?? "").backendId;
  if (requestedPrefix && backendById(requestedPrefix) !== backendForSession(openCodeId)) {
    return { queued: false, status: 400, error: "model provider does not belong to this session's backend" };
  }

  const key = sessionKey(openCodeId, cwd);
  const release = await acquireSessionLock(key);

  try {
    const state = await getOrCreateSessionState(openCodeId, cwd, sessionPath);

    if (state.busy) {
      return { queued: false, error: "session busy", status: 409 };
    }

    state.busy = true;
    backendForSession(openCodeId).store.beforeTurn?.(openCodeId, cwd);
    emitSessionStatus(openCodeId, { type: "busy" }, cwd);

    const parentMessageID = body.messageID;
    const modelRef = body.model?.providerID && body.model?.modelID
      ? {
          providerID: nativeProviderID(body.model.providerID),
          modelID: body.model.modelID,
          variant: body.variant ?? "default",
        }
      : undefined;

    if (modelRef) {
      state.currentModel = defaultModelRef(modelRef);
    }

    if (parentMessageID) {
      backendForSession(openCodeId).store.recordUserMessage?.(openCodeId, promptText, parentMessageID);
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
            await state.conn.setModel(nativeProviderID(modelRef.providerID), modelRef.modelID);
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
          createEventHandler(openCodeId, parentMessageID, state.currentModel, complete, cwd),
        );

        const promptPayload: { message: string; images?: ImageContent[] } = {
          message: promptText,
        };
        if (images.length > 0) {
          promptPayload.images = images;
        }

        await state.conn.prompt(promptPayload);
        await completion;

        if (promptText && !isLowSignalTitleInput(promptText)) {
          (async () => {
            try {
              const backend = backendForSession(openCodeId);
              const session = await backend.store.get(openCodeId, cwd);
              if (session && (!session.title || session.title.startsWith("Session "))) {
                if (backend.capabilities.titleGeneration) {
                  const titleCandidate = normalizeGeneratedTitle(promptText, promptText);
                  if (titleCandidate) {
                    await backend.store.setTitle(openCodeId, titleCandidate, "auto", cwd);
                  }
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
      await state.conn.abort();
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
  for (const backend of allBackends()) {
    try {
      backend.shutdownAll();
    } catch {
      /* ignore */
    }
  }
}
