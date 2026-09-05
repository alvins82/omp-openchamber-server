/**
 * OMP event normalizer.
 *
 * Translates the raw OMP RPC event stream (OmpRpcEvent frames) into the
 * backend-agnostic NormalizedTurnEvent vocabulary consumed by the SSE
 * assembly layer in prompt.ts. This module owns everything backend-specific:
 * usage probing + aggregation, model sync, session-header re-reads, the
 * non-terminal grace timer, approval/question respond closures, tool-state
 * reduction, todo extraction, and subagent lifecycle mapping.
 */
import { randomUUID } from "node:crypto";
import type { ModelRef, NormalizedTurnEvent, ToolPartState, TokenBreakdown } from "../types";
import { mapOmpUsageToTokens } from "./messages";
import { readSessionHeader, toOpenCodeSessionId } from "./store";
import { extractTodosFromOmpDetails, isTodoTool } from "./todo";
import type { OmpRpcEvent, OmpRpcTransport } from "./rpc";
import { normalizeToolInput, normalizeToolOutput } from "../../tool-normalize";
import { promptLogger } from "../../logger";

// ---------------------------------------------------------------------------
// Raw-frame tool helpers (moved verbatim from prompt.ts)
// ---------------------------------------------------------------------------

export function isRpcEventFrame(obj: Record<string, unknown>): boolean {
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

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export interface OmpEventNormalizerContext {
  transport: OmpRpcTransport;
  /** External OpenCode session id (used for provider-error log fields). */
  openCodeId: string;
  cwd: string;
  /** Session file path; enables the session-header usage re-read policy. */
  sessionPath?: string;
  /** Model the connection starts with; defaults to the omp builtin. */
  initialModel?: ModelRef;
  /** Grace window before a non-terminal agent end is finalized (tests shorten this). */
  nonTerminalGraceMs?: number;
}

export interface OmpEventNormalizer {
  /** Raw-frame entry point (wired to transport.onEvent once at creation). */
  handleFrame(event: OmpRpcEvent): void;
  /** Installs a per-turn sink; returns its unsubscribe function. */
  subscribe(next: (event: NormalizedTurnEvent) => void): () => void;
}

export const OMP_DEFAULT_MODEL: ModelRef = { providerID: "omp", modelID: "omp", variant: "default" };

export const DEFAULT_NON_TERMINAL_GRACE_MS = 1500;

/** Extracts the raw provider error message from a raw RPC frame. */
function rawErrorOf(event: OmpRpcEvent): string | undefined {
  return typeof event.errorMessage === "string"
    ? event.errorMessage
    : (typeof event.error === "string" ? event.error : undefined);
}

export function createOmpEventNormalizer(ctx: OmpEventNormalizerContext): OmpEventNormalizer {
  const { transport, openCodeId, sessionPath } = ctx;
  const nonTerminalGraceMs = ctx.nonTerminalGraceMs ?? DEFAULT_NON_TERMINAL_GRACE_MS;

  // Connection-level model mirror: survives resubscribes (per-turn state resets).
  const model: ModelRef = ctx.initialModel ? { ...ctx.initialModel } : { ...OMP_DEFAULT_MODEL };

  let sink: ((event: NormalizedTurnEvent) => void) | undefined;
  let latestTokens: TokenBreakdown = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let latestCost = 0;
  const toolParts = new Map<string, { tool: string; state: ToolPartState }>();
  let nonTerminalTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = (event: NormalizedTurnEvent) => sink?.(event);

  const clearTimer = () => {
    if (nonTerminalTimer) {
      clearTimeout(nonTerminalTimer);
      nonTerminalTimer = undefined;
    }
  };

  const fetchTodosFallback = () => {
    transport.request("get_state", {}).then((raw) => {
      const statePhases = (raw as Record<string, unknown>)?.todoPhases;
      const fetchedTodos = extractTodosFromOmpDetails({ phases: statePhases });
      if (fetchedTodos) {
        emit({ kind: "todo", todos: fetchedTodos });
      }
    }).catch(() => {});
  };

  const handleFrame = (event: OmpRpcEvent) => {
    const type = event.type;
    if (typeof type !== "string") return;

    // 1. Usage probe: fold the raw usage/cost payload into running snapshots.
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

    // 2. Model sync: adopt provider/model announcements from message-ish frames.
    const rawMsg = (event.message || event.data || event.assistantMessageEvent) as Record<string, unknown> | undefined;
    let modelChanged = false;
    if (rawMsg && typeof rawMsg.provider === "string" && typeof rawMsg.model === "string") {
      if (model.providerID !== rawMsg.provider || model.modelID !== rawMsg.model) {
        model.providerID = rawMsg.provider;
        model.modelID = rawMsg.model;
        if (typeof rawMsg.variant === "string") model.variant = rawMsg.variant;
        modelChanged = true;
      }
    }

    // 3. Header re-read policy: on turn-ish completion frames, reconcile
    // usage/cost/model against the persisted session header (best effort).
    if ((type === "tool_execution_end" || type === "turn_end" || type === "message_end") && sessionPath) {
      void (async () => {
        try {
          const header = await readSessionHeader(sessionPath!);
          if (header?.tokens && (header.tokens.input > 0 || header.tokens.output > 0)) {
            latestTokens = header.tokens;
            if (header.cost !== undefined) latestCost = header.cost;
            let headerModelChanged = false;
            if (header.model && (!model.providerID || model.providerID === "omp")) {
              if (model.providerID !== header.model.providerID || model.modelID !== header.model.modelID) {
                model.providerID = header.model.providerID;
                model.modelID = header.model.modelID;
                headerModelChanged = true;
              }
            }
            emit({ kind: "usage", tokens: latestTokens, cost: latestCost });
            if (headerModelChanged) emit({ kind: "model", model: { ...model } });
          }
        } catch { /* best effort */ }
      })();
    }

    // 4. Snapshots must reach the sink before the terminal turn_end.
    if (usageUpdated) emit({ kind: "usage", tokens: latestTokens, cost: latestCost });
    if (modelChanged) emit({ kind: "model", model: { ...model } });

    // 5. Terminal turn: agent ended definitively (or no agent was invoked).
    if (
      (type === "agent_end" && (event.isTerminal === undefined || event.isTerminal === true)) ||
      (type === "prompt_result" && event.agentInvoked === false)
    ) {
      clearTimer();
      const isError = event.stopReason === "error" || Boolean(event.errorMessage) || (typeof event.error === "string" && event.error.length > 0);
      const rawError = rawErrorOf(event);
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
      }
      emit({
        kind: "turn_end",
        error: rawError,
        stopReason: typeof event.stopReason === "string" ? event.stopReason : undefined,
      });
      return;
    }

    // 6. Non-terminal agent end: log provider errors, then finalize after a
    // grace window unless another frame arrives first.
    if (type === "agent_end" && event.isTerminal === false) {
      clearTimer();
      const isError = event.stopReason === "error" || Boolean(event.errorMessage) || (typeof event.error === "string" && event.error.length > 0);
      const rawError = rawErrorOf(event);
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
      const stopReason = typeof event.stopReason === "string" ? event.stopReason : undefined;
      nonTerminalTimer = setTimeout(() => {
        nonTerminalTimer = undefined;
        emit({ kind: "turn_end", error: rawError, stopReason });
      }, nonTerminalGraceMs);
      return;
    }

    // 7. Any other frame cancels a pending non-terminal finalization.
    clearTimer();

    // 8. Approval / question requests: respond closures are bound to the
    // transport here; the SSE layer only decorates them with bookkeeping.
    if (type === "extension_ui_request") {
      const reqId = String(event.id ?? randomUUID());
      const method = String(event.method ?? "confirm");
      const title = String(event.title ?? "");
      const message = String(event.message ?? "");

      if (method === "confirm") {
        emit({
          kind: "permission_request",
          id: reqId,
          permission: title || "execute",
          metadata: { message, title, ...event },
          respond: (res) => {
            transport.sendFrame?.({
              type: "extension_ui_response",
              id: reqId,
              ...(res.cancelled ? { cancelled: true } : { confirmed: res.confirmed ?? true }),
            });
          },
        });
      } else if (method === "select" || method === "input") {
        const rawOptions = (event.options ?? []) as Array<string | { label?: string; value?: string; description?: string }>;
        const options = rawOptions.map((opt) =>
          typeof opt === "string"
            ? { label: opt, description: "" }
            : { label: opt.label ?? opt.value ?? "", description: opt.description ?? "" }
        );
        emit({
          kind: "question_request",
          id: reqId,
          questions: [
            {
              question: message || title || "Input requested",
              header: title || "Prompt",
              options,
              multiple: false,
              custom: method === "input",
            },
          ],
          respond: (res) => {
            transport.sendFrame?.({
              type: "extension_ui_response",
              id: reqId,
              value: res.value ?? "",
              ...(res.cancelled ? { cancelled: true } : {}),
            });
          },
        });
      }
      return;
    }

    // 9. Custom-framed tool execution events.
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
        toolParts.set(toolCallId, { tool: resolvedTool ?? "tool", state });
        emit({ kind: "tool", callID: toolCallId, tool: resolvedTool, state });
        return;
      }
    }

    // 10. Subagent lifecycle + progress.
    if (type === "subagent_lifecycle") {
      const payload = (event.payload || {}) as Record<string, unknown>;
      const subagentId = String(payload.id ?? "");
      if (subagentId) {
        const childId = toOpenCodeSessionId(subagentId);
        const status = String(payload.status ?? "");
        const agentName = String(payload.agent ?? "task");
        if (status === "started") {
          const description = typeof payload.description === "string" && payload.description.trim().length > 0
            ? payload.description.trim()
            : `Subagent (${agentName})`;
          emit({
            kind: "subagent_started",
            childId,
            agent: agentName,
            description,
            sessionFile: typeof payload.sessionFile === "string" ? payload.sessionFile : undefined,
          });
        } else {
          emit({ kind: "subagent_ended", childId });
        }
      }
      return;
    }

    if (type === "subagent_progress") {
      const payload = (event.payload || {}) as Record<string, unknown>;
      const progress = (payload.progress || {}) as Record<string, unknown>;
      const subagentId = String(progress.id ?? payload.id ?? "");
      if (subagentId) {
        const childId = toOpenCodeSessionId(subagentId);
        const status = String(progress.status ?? "");
        if (status === "running" || status === "busy") {
          emit({ kind: "subagent_status", childId, status: "busy" });
        } else if (status === "completed" || status === "error" || status === "aborted") {
          emit({ kind: "subagent_status", childId, status: "idle" });
        }
      }
      return;
    }

    // 11. Native tool execution events (+ todo extraction on completion).
    if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
      const payload = typeof event.payload === "object" && event.payload != null
        ? { type: event.type, ...(event.payload as Record<string, unknown>) }
        : event;
      const toolCallId = getToolCallId(payload) ?? `tool_${randomUUID().replace(/-/g, "")}`;
      const tool = getToolName(payload);
      const existing = toolParts.get(toolCallId);
      const resolvedTool = tool ?? existing?.tool;
      const state = reduceToolPartState(existing?.state, payload, Date.now(), resolvedTool);
      toolParts.set(toolCallId, { tool: resolvedTool ?? "tool", state });
      emit({ kind: "tool", callID: toolCallId, tool: resolvedTool, state });

      if (isTodoTool(resolvedTool) && (state.status === "completed" || type === "tool_execution_end")) {
        const rawDetails = payload.details ?? (typeof payload.data === "object" && payload.data != null ? (payload.data as Record<string, unknown>).details : undefined) ?? event.details;
        const todos = extractTodosFromOmpDetails(rawDetails, payload.result ?? payload.output);
        if (todos) {
          emit({ kind: "todo", todos });
        } else {
          fetchTodosFallback();
        }
      }
      return;
    }

    // 12. Assistant message updates: text/thinking deltas and toolcall events.
    if (type !== "message_update") return;

    const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") return;

    const eventType = assistantMessageEvent.type as string | undefined;
    const rawText = assistantMessageEvent.text ?? assistantMessageEvent.delta ?? assistantMessageEvent.content;
    const deltaText = typeof rawText === "string" ? rawText : "";

    if (eventType === "text_delta" || eventType === "thinking_delta") {
      emit(eventType === "thinking_delta"
        ? { kind: "reasoning_delta", text: deltaText }
        : { kind: "text_delta", text: deltaText });
      return;
    }

    if (
      typeof eventType === "string" &&
      (eventType.startsWith("toolcall_") || eventType === "toolCall" || eventType === "tool_call")
    ) {
      const toolCallId = getToolCallId(assistantMessageEvent) ?? `tool_${randomUUID().replace(/-/g, "")}`;
      const tool = getToolName(assistantMessageEvent);
      const existing = toolParts.get(toolCallId);
      const resolvedTool = tool ?? existing?.tool;
      const state = reduceToolPartState(existing?.state, assistantMessageEvent, Date.now(), resolvedTool);
      toolParts.set(toolCallId, { tool: resolvedTool ?? "tool", state });
      emit({ kind: "tool", callID: toolCallId, tool: resolvedTool, state });

      if (isTodoTool(resolvedTool) && (state.status === "completed" || eventType === "toolcall_end" || eventType === "tool_execution_end")) {
        const rawDetails = assistantMessageEvent.details ?? (typeof assistantMessageEvent.data === "object" && assistantMessageEvent.data != null ? (assistantMessageEvent.data as Record<string, unknown>).details : undefined);
        const todos = extractTodosFromOmpDetails(rawDetails, assistantMessageEvent.result ?? assistantMessageEvent.output);
        if (todos) {
          emit({ kind: "todo", todos });
        } else {
          fetchTodosFallback();
        }
      }
      return;
    }
  };

  // The raw-frame handler stays attached to the transport for the connection's
  // lifetime; per-turn sinks are swapped via subscribe() and events between
  // turns are dropped until a new sink is installed.
  const detach = transport.onEvent(handleFrame);
  void detach;

  return {
    handleFrame,
    /**
     * Installs a per-turn sink. Resets per-turn aggregation state (usage,
     * tool continuity, pending grace timer); the model mirror persists.
     */
    subscribe(next: (event: NormalizedTurnEvent) => void): () => void {
      sink = next;
      latestTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
      latestCost = 0;
      toolParts.clear();
      clearTimer();
      return () => {
        if (sink === next) sink = undefined;
        clearTimer();
      };
    },
  };
}
