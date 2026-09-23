import type { OpenCodeMessageRecord, OpenCodeSession, OpenCodePart } from "../../providers/types";
import { backendForSession, isMultiBackend } from "../../providers/registry";

export interface V2Location {
  directory: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const withoutUndefined = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

export function toV2FileAttachment(file: {
  uri: string;
  mime?: string;
  name?: string;
  description?: string;
  mention?: { start: number; end: number; text: string };
}) {
  const inline = file.uri.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
  const isBase64 = /^data:[^,]*;base64,/i.test(file.uri);
  let data = "";
  if (inline) {
    if (isBase64) data = inline[2] ?? "";
    else {
      try {
        data = Buffer.from(decodeURIComponent(inline[2] ?? ""), "utf8").toString("base64");
      } catch {
        data = Buffer.from(inline[2] ?? "", "utf8").toString("base64");
      }
    }
  }
  return {
    data,
    mime: inline?.[1] || file.mime || "application/octet-stream",
    source: inline ? { type: "inline" as const } : { type: "uri" as const, uri: file.uri },
    ...(file.name ? { name: file.name } : {}),
    ...(file.description ? { description: file.description } : {}),
    ...(file.mention ? { mention: file.mention } : {}),
  };
}

export function toV2Session(session: OpenCodeSession) {
  const providerID = session.model.providerID;
  const v2ProviderID = isMultiBackend() ? `${backendForSession(session.id).id}/${providerID}` : providerID;
  return withoutUndefined({
    id: session.id,
    parentID: session.parentID,
    projectID: session.projectID || "global",
    agent: session.agent,
    model: session.model ? {
      id: session.model.modelID || session.model.id,
      providerID: v2ProviderID,
      variant: session.model.variant,
    } : undefined,
    cost: session.cost,
    tokens: session.tokens,
    outcome: (session as OpenCodeSession & { outcome?: string }).outcome,
    time: {
      created: session.time.created,
      updated: session.time.updated,
      idle: (session.time as typeof session.time & { idle?: number }).idle,
      archived: session.time.archived,
      viewed: (session.time as typeof session.time & { viewed?: number }).viewed,
    },
    title: session.title,
    location: { directory: session.directory || process.cwd() },
    subpath: (session as OpenCodeSession & { subpath?: string }).subpath,
    metadata: session.metadata,
    permissions: (session as OpenCodeSession & { permissions?: unknown[] }).permissions,
    revert: (session as OpenCodeSession & { revert?: unknown }).revert,
    fork: (session as OpenCodeSession & { fork?: unknown }).fork,
  });
}

function fileAttachment(part: Extract<OpenCodePart, { type: "file" }>) {
  return toV2FileAttachment({ uri: part.url, mime: part.mime, name: part.filename });
}

function v2Finish(finish: unknown): { finish?: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown"; rawFinish?: string } {
  if (typeof finish !== "string") return {};
  if (["stop", "length", "tool-calls", "content-filter", "error", "unknown"].includes(finish)) {
    return { finish: finish as "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown" };
  }
  if (finish === "toolUse" || finish === "tool_call" || finish === "tool_calls") return { finish: "tool-calls", rawFinish: finish };
  if (["end_turn", "completed", "complete"].includes(finish)) return { finish: "stop", rawFinish: finish };
  return { finish: "unknown", rawFinish: finish };
}

function v2Error(error: unknown) {
  if (!error) return undefined;
  const value = record(error);
  return {
    type: typeof value.type === "string" ? value.type : typeof value.name === "string" ? value.name : "Error",
    message: typeof value.message === "string" ? value.message : String(error),
    ...(typeof value.status === "number" ? { status: value.status } : {}),
  };
}

function v2ToolContent(part: Extract<OpenCodePart, { type: "tool" }>) {
  const state = part.state;
  const input = state.input ?? {};
  const time = state.time ?? { start: Date.now() };
  if (state.status === "completed") {
    return {
      type: "tool" as const,
      id: part.callID,
      name: part.tool,
      executed: true,
      state: {
        status: "completed" as const,
        input,
        content: [{ type: "text" as const, text: state.output ?? "" }],
        metadata: {},
      },
      time: { created: time.start, ran: time.start, completed: time.end ?? time.start },
    };
  }
  if (state.status === "error") {
    return {
      type: "tool" as const,
      id: part.callID,
      name: part.tool,
      executed: true,
      state: {
        status: "error" as const,
        input,
        error: { type: "Error", message: state.error ?? state.output ?? "tool failed" },
        ...(state.output ? { content: [{ type: "text" as const, text: state.output }] } : {}),
        metadata: {},
      },
      time: { created: time.start, ran: time.start, completed: time.end ?? time.start },
    };
  }
  if (state.status === "running") {
    return {
      type: "tool" as const,
      id: part.callID,
      name: part.tool,
      executed: true,
      state: { status: "running" as const, input, metadata: {} },
      time: { created: time.start, ran: time.start },
    };
  }
  return {
    type: "tool" as const,
    id: part.callID,
    name: part.tool,
    executed: false,
    state: { status: "streaming" as const, input: JSON.stringify(input) },
    time: { created: time.start },
  };
}

function v2Part(part: OpenCodePart) {
  if (part.type === "file") return undefined;
  if (part.type === "tool") return v2ToolContent(part);
  if (part.type === "reasoning") {
    return {
      type: "reasoning" as const,
      text: part.text,
      time: { created: part.time?.start ?? Date.now(), completed: part.time?.end },
    };
  }
  return { type: "text" as const, text: part.text };
}

export function toV2Message(message: OpenCodeMessageRecord) {
  const info = message.info;
  const parts = message.parts ?? [];
  const time = info.time?.created ?? Date.now();
  const base = {
    id: info.id,
    time: { created: time },
    metadata: info.metadata,
  };

  if (info.role === "user") {
    const text = parts.filter((part): part is Extract<OpenCodePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text).join("\n");
    const files = parts.filter((part): part is Extract<OpenCodePart, { type: "file" }> => part.type === "file")
      .map(fileAttachment);
    return withoutUndefined({ type: "user", ...base, text, files: files.length ? files : undefined });
  }

  if (info.role === "synthetic") {
    const text = parts.filter((part): part is Extract<OpenCodePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text).join("\n");
    return withoutUndefined({ type: "synthetic", ...base, text, description: info.summary ? "Context" : undefined });
  }

  const model = record(info.model);
  const sessionID = info.sessionID;
  const modelProviderID = typeof model.providerID === "string" ? model.providerID : "omp";
  const v2ProviderID = isMultiBackend() ? `${backendForSession(sessionID).id}/${modelProviderID}` : modelProviderID;
  if (info.summary === true || info.mode === "compaction") {
    const summary = parts.filter((part): part is Extract<OpenCodePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text).join("\n");
    return withoutUndefined({
      type: "compaction",
      ...base,
      status: "completed" as const,
      reason: "auto" as const,
      summary: summary || "Conversation history compacted",
      recent: "",
      model: {
        id: typeof model.modelID === "string" ? model.modelID : (typeof model.id === "string" ? model.id : "omp"),
        providerID: v2ProviderID,
        ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
      },
      cost: info.cost,
      tokens: info.tokens,
    });
  }
  const content = parts.map(v2Part).filter((part) => part !== undefined);
  const normalizedFinish = v2Finish(info.finish);
  return withoutUndefined({
    type: "assistant",
    ...base,
    agent: info.agent || "omp",
    model: {
      id: typeof model.modelID === "string" ? model.modelID : (typeof model.id === "string" ? model.id : "omp"),
      providerID: v2ProviderID,
      variant: typeof model.variant === "string" ? model.variant : "default",
    },
    content,
    time: { created: time, completed: info.time?.completed },
    ...normalizedFinish,
    error: v2Error(info.error),
    cost: info.cost,
    tokens: info.tokens,
    summary: info.summary,
    retry: undefined,
  });
}

export function page<T>(items: T[], limit: number, cursor: string | null, order: "asc" | "desc" = "desc") {
  const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
  const ordered = order === "asc" ? items : [...items].reverse();
  const data = ordered.slice(offset, offset + limit);
  const nextOffset = offset + data.length;
  return {
    data,
    cursor: {
      ...(offset > 0 ? { previous: String(Math.max(0, offset - limit)) } : {}),
      ...(nextOffset < ordered.length ? { next: String(nextOffset) } : {}),
    },
  };
}
