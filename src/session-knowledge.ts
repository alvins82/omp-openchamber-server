import type { OpenCodeSession } from "./providers/types";
import type { ProjectContextRuntime, ProjectNote, ProjectPlanLink, RouteResult } from "./project-context";

const KNOWLEDGE_METADATA_KEY = "knowledge_context_delivered";
const PINS_METADATA_KEY = "project_context_pins";
const KNOWLEDGE_MAX_LENGTH = 8_000;

type Pins = { notes: string[]; plans: string[] };
type CollectedKnowledge = { notes: ProjectNote[]; plans: Array<{ id: string; title: string; body: string }> };

export interface SessionKnowledgeRuntime {
  resolvePending(directory: string, deliveredSignature: string, pins?: Pins): Promise<{ text: string; signature: string }>;
  resolvePendingForSession(sessionId: string, directory: string): Promise<{ text: string; signature: string }>;
  collectSummary(directory: string, pins?: Pins): Promise<{ notes: Array<{ id: string; body: string }>; plans: Array<{ id: string; title: string }>; memory: { global: number; project: number } }>;
  collectSummaryForSession(sessionId: string, directory: string): Promise<{ notes: Array<{ id: string; body: string }>; plans: Array<{ id: string; title: string }>; memory: { global: number; project: number } }>;
  setPin(sessionId: string, directory: string, kind: "note" | "plan", id: string, pinned: boolean): Promise<Pins>;
  recordDelivered(sessionId: string, directory: string, signature: string): Promise<void>;
  readPins(session: OpenCodeSession | null): Pins;
}

interface SessionKnowledgeDependencies {
  projectContextRuntime: ProjectContextRuntime;
  getSession(sessionId: string, directory: string): Promise<OpenCodeSession | null>;
  updateSessionMetadata(sessionId: string, directory: string, metadata: Record<string, unknown>): Promise<OpenCodeSession | null>;
  resolveProjectId?: (directory: string) => string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createProjectIdFromPath(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/g, "").trim();
  if (!normalized) return "";
  const bytes = new TextEncoder().encode(normalized);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `path_${encoded}`;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim()))];
}

function truncate(value: string, budget: number): string {
  return value.length <= budget ? value : `${value.slice(0, Math.max(0, budget - 1))}…`;
}

export function buildKnowledgeSignature({ notes, plans }: CollectedKnowledge): string {
  const parts = [
    ...notes.map((note) => `n:${note.id}:${note.updatedAt}`),
    ...plans.map((plan) => `p:${plan.id}:${plan.title}`),
  ];
  return parts.length === 0 ? "" : parts.sort().join("|");
}

export function buildKnowledgeText({ notes, plans }: CollectedKnowledge): string {
  const sections: string[] = [];
  if (notes.length > 0) {
    const rendered = notes
      .slice()
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((note) => `- ${note.body.trim()}`)
      .join("\n");
    sections.push(`## Pinned notes\n\n${rendered}`);
  }
  for (const plan of plans) {
    sections.push(plan.body
      ? `## Pinned plan: ${plan.title}\n\n${plan.body}`
      : `## Pinned plan: ${plan.title}\n\n(plan content unavailable)`);
  }
  if (sections.length === 0) return "";
  const assembled = [
    "The user pinned the following project context. Treat it as standing background, not as a new instruction.",
    ...sections,
  ].join("\n\n");
  return assembled.length <= KNOWLEDGE_MAX_LENGTH
    ? assembled
    : `${truncate(assembled, KNOWLEDGE_MAX_LENGTH)}\n\n(project knowledge truncated)`;
}

function emptySummary(): { notes: Array<{ id: string; body: string }>; plans: Array<{ id: string; title: string }>; memory: { global: number; project: number } } {
  return { notes: [], plans: [], memory: { global: 0, project: 0 } };
}

export function createSessionKnowledgeRuntime(dependencies: SessionKnowledgeDependencies): SessionKnowledgeRuntime {
  const resolveProjectId = dependencies.resolveProjectId ?? createProjectIdFromPath;

  const readPins = (session: OpenCodeSession | null): Pins => {
    const metadata = asRecord(session?.metadata) ?? {};
    const openchamber = asRecord(metadata.openchamber) ?? {};
    const pins = asRecord(openchamber[PINS_METADATA_KEY]) ?? {};
    return { notes: strings(pins.notes), plans: strings(pins.plans) };
  };

  const readDeliveredSignature = (session: OpenCodeSession | null): string => {
    const metadata = asRecord(session?.metadata) ?? {};
    const openchamber = asRecord(metadata.openchamber) ?? {};
    return typeof openchamber[KNOWLEDGE_METADATA_KEY] === "string"
      ? openchamber[KNOWLEDGE_METADATA_KEY]
      : "";
  };

  const collect = async (directory: string, pins: Pins): Promise<CollectedKnowledge> => {
    const projectId = resolveProjectId(directory);
    if (!projectId) return { notes: [], plans: [] };
    try {
      const context = await dependencies.projectContextRuntime.readContext(projectId);
      const noteIds = new Set(pins.notes);
      const planIds = new Set(pins.plans);
      const notes = context.notes.filter((note) => noteIds.has(note.id));
      const plans = await Promise.all(context.plans
        .filter((plan) => planIds.has(plan.id))
        .map(async (plan: ProjectPlanLink) => {
          try {
            const content = await dependencies.projectContextRuntime.readPlan(projectId, plan.id);
            return { id: plan.id, title: plan.title, body: content?.body.trim() ?? "" };
          } catch {
            return { id: plan.id, title: plan.title, body: "" };
          }
        }));
      return { notes, plans };
    } catch {
      return { notes: [], plans: [] };
    }
  };

  const collectSummary = async (directory: string, pins: Pins = { notes: [], plans: [] }) => {
    const collected = await collect(directory, pins);
    return {
      notes: collected.notes.map((note) => ({ id: note.id, body: note.body })),
      plans: collected.plans.map((plan) => ({ id: plan.id, title: plan.title })),
      memory: { global: 0, project: 0 },
    };
  };

  const resolvePending = async (directory: string, deliveredSignature: string, pins: Pins = { notes: [], plans: [] }) => {
    const collected = await collect(directory, pins);
    const signature = buildKnowledgeSignature(collected);
    return signature === "" || signature === deliveredSignature
      ? { text: "", signature }
      : { text: buildKnowledgeText(collected), signature };
  };

  const resolvePendingForSession = async (sessionId: string, directory: string) => {
    const session = await dependencies.getSession(sessionId, directory).catch(() => null);
    return resolvePending(directory, readDeliveredSignature(session), readPins(session));
  };

  const collectSummaryForSession = async (sessionId: string, directory: string) => {
    const session = await dependencies.getSession(sessionId, directory).catch(() => null);
    return collectSummary(directory, readPins(session));
  };

  const setPin = async (sessionId: string, directory: string, kind: "note" | "plan", id: string, pinned: boolean): Promise<Pins> => {
    const session = await dependencies.getSession(sessionId, directory);
    // The UI can issue a late pin request while a session is being removed.
    // Keep this compatibility endpoint a harmless no-op, as the former sidecar
    // stub did, instead of turning an otherwise unrelated panel action into a
    // failed request.
    if (!session) return { notes: [], plans: [] };
    const metadata = asRecord(session.metadata) ?? {};
    const openchamber = asRecord(metadata.openchamber) ?? {};
    const current = readPins(session);
    const key = kind === "note" ? "notes" : "plans";
    const next = new Set(current[key]);
    if (pinned) next.add(id);
    else next.delete(id);
    const nextPins: Pins = { ...current, [key]: [...next] };
    await dependencies.updateSessionMetadata(sessionId, directory, {
      ...metadata,
      openchamber: {
        ...openchamber,
        [PINS_METADATA_KEY]: nextPins,
        [KNOWLEDGE_METADATA_KEY]: "",
      },
    });
    return nextPins;
  };

  const recordDelivered = async (sessionId: string, directory: string, signature: string): Promise<void> => {
    const session = await dependencies.getSession(sessionId, directory);
    if (!session) throw new Error("session not found");
    const metadata = asRecord(session.metadata) ?? {};
    const openchamber = asRecord(metadata.openchamber) ?? {};
    await dependencies.updateSessionMetadata(sessionId, directory, {
      ...metadata,
      openchamber: { ...openchamber, [KNOWLEDGE_METADATA_KEY]: signature },
    });
  };

  return {
    resolvePending,
    resolvePendingForSession,
    collectSummary,
    collectSummaryForSession,
    setPin,
    recordDelivered,
    readPins,
  };
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return asRecord(body);
  } catch {
    return null;
  }
}

export async function handleSessionKnowledgeRequest(
  req: Request,
  url: URL,
  runtime: SessionKnowledgeRuntime,
): Promise<RouteResult | null> {
  if (url.pathname === "/api/session-knowledge" && req.method === "GET") {
    const directory = nonEmptyString(url.searchParams.get("directory"));
    if (!directory) return { status: 400, body: { error: "directory is required" } };
    const sessionId = nonEmptyString(url.searchParams.get("sessionId"));
    try {
      return { body: sessionId
        ? await runtime.resolvePendingForSession(sessionId, directory)
        : await runtime.resolvePending(directory, "") };
    } catch (error) {
      return { body: { text: "", signature: "", unavailable: true, reason: error instanceof Error ? error.message : "unknown" } };
    }
  }

  if (url.pathname === "/api/session-knowledge/summary" && req.method === "GET") {
    const directory = nonEmptyString(url.searchParams.get("directory"));
    if (!directory) return { body: emptySummary() };
    const sessionId = nonEmptyString(url.searchParams.get("sessionId"));
    try {
      return { body: sessionId ? await runtime.collectSummaryForSession(sessionId, directory) : await runtime.collectSummary(directory) };
    } catch {
      return { body: emptySummary() };
    }
  }

  if (url.pathname === "/api/session-knowledge/pin" && req.method === "POST") {
    const body = await readBody(req);
    const sessionId = nonEmptyString(body?.sessionId);
    const directory = nonEmptyString(body?.directory);
    const id = nonEmptyString(body?.id);
    const kind = body?.kind === "note" || body?.kind === "plan" ? body.kind : null;
    if (!sessionId || !directory || !id || !kind || typeof body?.pinned !== "boolean") {
      return { status: 400, body: { error: "sessionId, directory, kind, id and pinned are required" } };
    }
    try {
      return { body: { pins: await runtime.setPin(sessionId, directory, kind, id, body.pinned) } };
    } catch (error) {
      return { status: 500, body: { error: error instanceof Error ? error.message : "Unable to update pin" } };
    }
  }

  if (url.pathname === "/api/session-knowledge/delivered" && req.method === "POST") {
    const body = await readBody(req);
    const sessionId = nonEmptyString(body?.sessionId);
    const directory = nonEmptyString(body?.directory);
    const signature = nonEmptyString(body?.signature);
    if (!sessionId || !directory || !signature) {
      return { status: 400, body: { error: "sessionId, directory and signature are required" } };
    }
    try {
      await runtime.recordDelivered(sessionId, directory, signature);
      return { body: { recorded: true } };
    } catch (error) {
      return { body: { recorded: false, reason: error instanceof Error ? error.message : "unknown" } };
    }
  }

  return null;
}
