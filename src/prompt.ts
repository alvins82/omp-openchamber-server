import { OmpRpcConnection, getCurrentModel, type OmpRpcEvent } from "./rpc";
import { invalidateMessageCache } from "./messages";
import {
  emitMessagePartDelta,
  emitMessagePartUpdated,
  emitMessageUpdated,
  emitSessionIdle,
  emitSessionStatus,
} from "./sse";
import { randomUUID } from "node:crypto";

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
  conn: OmpRpcConnection;
  busy: boolean;
  openCodeId: string;
  cwd: string;
  sessionPath: string;
  unsubscribe: () => void;
  currentModel: ModelRef;
}

const sessionStates = new Map<string, SessionState>();
const sessionBusyLocks = new Set<string>();

function sessionKey(openCodeId: string, cwd: string): string {
  return `${openCodeId}\0${cwd}`;
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
  finish?: "stop",
): void {
  emitMessageUpdated({
    info: {
      id: messageID,
      role: "assistant",
      sessionID: openCodeId,
      parentID,
      agent: "omp",
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
        variant: model.variant,
      },
      providerID: model.providerID,
      modelID: model.modelID,
      variant: model.variant,
      finish,
      time: { created: Date.now(), completed: finish ? Date.now() : undefined },
    },
  });
}

function emitAssistantPart(
  openCodeId: string,
  messageID: string,
  partID: string,
  partType: "text" | "reasoning",
  text: string,
): void {
  emitMessagePartUpdated(openCodeId, {
    id: partID,
    type: partType,
    text,
    messageID,
    sessionID: openCodeId,
  });
}

export interface ToolPartState {
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  time?: { start: number; end?: number };
}

function parseToolInput(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

function formatToolOutput(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getToolError(obj: Record<string, unknown>): string | undefined {
  const value = obj.error ?? obj.errorMessage ?? obj.error_message;
  if (typeof value === "string" && value.length > 0) return value;
  if (obj.isError === true || obj.error === true) {
    const detail = obj.output ?? obj.content ?? obj.result ?? "tool error";
    return typeof detail === "string" ? detail : "tool error";
  }
  return undefined;
}

export function reduceToolPartState(
  current: ToolPartState | undefined,
  event: Record<string, unknown>,
  now = Date.now(),
): ToolPartState {
  const state: ToolPartState = current ? { ...current } : { status: "pending" };
  if (state.time) state.time = { ...state.time };
  const type = event.type as string;

  if (type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end") {
    const input = parseToolInput(event.arguments ?? event.input);
    if (input) state.input = input;
    if (type !== "toolcall_delta" && !state.time) {
      state.time = { start: now };
    }
  } else if (type === "tool_execution_start") {
    state.status = "running";
    if (!state.time) state.time = { start: now };
    const input = parseToolInput(event.arguments ?? event.input);
    if (input) state.input = input;
  } else if (type === "tool_execution_update") {
    if (state.status !== "completed" && state.status !== "error") {
      state.status = "running";
    }
    const output = formatToolOutput(event.output ?? event.content ?? event.result ?? event.data);
    if (output != null) {
      if (state.output && !output.startsWith(state.output)) {
        state.output = state.output + "\n" + output;
      } else {
        state.output = output;
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
    const output = formatToolOutput(event.output ?? event.content ?? event.result ?? event.data);
    if (output != null) state.output = output;
    if (!state.time) state.time = { start: now };
    state.time.end = now;
  }

  return state;
}

function createEventHandler(
  openCodeId: string,
  parentMessageID: string | undefined,
  model: ModelRef,
  onComplete: () => void,
) {
  let assistantMessageID: string | undefined;
  let currentPartType: "text" | "reasoning" | undefined;
  let partIndex = 0;
  let hasStarted = false;

  const toolParts = new Map<string, { tool: string; state: ToolPartState }>();

  const ensureStarted = () => {
    if (hasStarted) return;
    hasStarted = true;
    assistantMessageID = makeMessageId(openCodeId, `assistant_${Date.now()}`);
    emitAssistantInfo(openCodeId, assistantMessageID, parentMessageID, model);
  };

  const getToolCallId = (obj: Record<string, unknown>): string | undefined => {
    const value = obj.toolCallId ?? obj.tool_call_id ?? obj.callId ?? obj.id ?? obj.toolCallID;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  const getToolName = (obj: Record<string, unknown>): string => {
    const value = obj.name ?? obj.tool ?? obj.toolName ?? obj.tool_name ?? obj.function;
    return typeof value === "string" && value.length > 0 ? value : "tool";
  };

  const emitToolPart = (toolCallId: string, tool: string, state: ToolPartState) => {
    ensureStarted();
    const mid = assistantMessageID!;
    const entry = toolParts.get(toolCallId);
    if (entry) {
      entry.tool = tool;
      entry.state = state;
    } else {
      toolParts.set(toolCallId, { tool, state });
    }
    emitMessagePartUpdated(openCodeId, {
      id: toolCallId,
      type: "tool",
      tool,
      state,
      messageID: mid,
      sessionID: openCodeId,
    });
  };

  return (event: OmpRpcEvent) => {
    const type = event.type;
    if (typeof type !== "string") return;

    if (type === "agent_end" || (type === "prompt_result" && event.agentInvoked === false)) {
      if (assistantMessageID) {
        emitAssistantInfo(openCodeId, assistantMessageID, parentMessageID, model, "stop");
      }
      onComplete();
      return;
    }

    if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
      const payload = typeof event.payload === "object" && event.payload != null
        ? { type: event.type, ...(event.payload as Record<string, unknown>) }
        : event;
      const toolCallId = getToolCallId(payload) ?? `tool_${randomUUID().replace(/-/g, "")}`;
      const tool = getToolName(payload);
      const existing = toolParts.get(toolCallId);
      const state = reduceToolPartState(existing?.state, payload, Date.now());
      emitToolPart(toolCallId, tool, state);
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
        partIndex++;
        currentPartType = partType;
        emitAssistantPart(openCodeId, mid, makePartId(openCodeId, mid, partIndex), partType, deltaText);
      } else if (deltaText) {
        emitMessagePartDelta(openCodeId, mid, makePartId(openCodeId, mid, partIndex), deltaText);
      }
      return;
    }

    if (typeof eventType === "string" && eventType.startsWith("toolcall_")) {
      ensureStarted();
      const toolCallId = getToolCallId(assistantMessageEvent) ?? `tool_${randomUUID().replace(/-/g, "")}`;
      const tool = getToolName(assistantMessageEvent);
      const existing = toolParts.get(toolCallId);
      const state = reduceToolPartState(existing?.state, assistantMessageEvent, Date.now());
      emitToolPart(toolCallId, tool, state);
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

  const conn = await OmpRpcConnection.spawn(cwd);
  await conn.switchSession(sessionPath);

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
  if (!promptText) {
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
    emitSessionStatus(openCodeId, { type: "busy" });

    const parentMessageID = body.messageID;
    const modelRef = body.model?.providerID && body.model?.modelID
      ? {
          providerID: body.model.providerID,
          modelID: body.model.modelID,
          variant: body.variant ?? "default",
        }
      : undefined;

    (async () => {
      try {
        state.currentModel = modelRef ? defaultModelRef(modelRef) : state.currentModel;

        if (modelRef) {
          try {
            await state.conn.request("set_model", {
              provider: modelRef.providerID,
              modelId: modelRef.modelID,
            });
          } catch (err) {
            console.error(`[prompt] ${openCodeId} set_model failed:`, err);
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
          createEventHandler(openCodeId, parentMessageID, state.currentModel, complete),
        );

        await state.conn.request("prompt", { message: promptText });
        await completion;
      } catch (err) {
        const messageID = makeMessageId(openCodeId, `error_${Date.now()}`);
        const errorModel = state.currentModel;
        emitAssistantInfo(openCodeId, messageID, parentMessageID, errorModel, "stop");
        emitAssistantPart(openCodeId, messageID, makePartId(openCodeId, messageID, 0), "text", `Prompt failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`[prompt] ${openCodeId} failed:`, err);
      } finally {
        state.unsubscribe();
        state.busy = false;
        emitSessionIdle(openCodeId);
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
      console.error(`[abort] ${openCodeId} RPC abort failed:`, err);
      state.conn.kill();
      sessionStates.delete(key);
    }
    state.unsubscribe();
    state.busy = false;
    emitSessionIdle(openCodeId);
    return true;
  } finally {
    release();
  }
}

export function isSessionBusy(openCodeId: string, cwd: string): boolean {
  return sessionStates.get(sessionKey(openCodeId, cwd))?.busy ?? false;
}

export function getSessionStatusMap(): Record<string, { type: string }> {
  const result: Record<string, { type: string }> = {};
  for (const state of sessionStates.values()) {
    if (state.busy) result[state.openCodeId] = { type: "busy" };
  }
  return result;
}
