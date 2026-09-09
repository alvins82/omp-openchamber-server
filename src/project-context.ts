import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const PROJECT_CONTEXT_VERSION = 2;
const PROJECT_NOTE_BODY_MAX_LENGTH = 3_000;
const PROJECT_NOTE_MAX_ITEMS = 200;
const PROJECT_TODO_TEXT_MAX_LENGTH = 120;
const PROJECT_TODO_MAX_ITEMS = 500;
const PROJECT_PLAN_TITLE_MAX_LENGTH = 160;
const PROJECT_PLAN_BODY_MAX_LENGTH = 200_000;
const PROJECT_PLAN_MAX_ITEMS = 500;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const PLAN_FILE_PATTERN = /^[a-zA-Z0-9._-]+\.md$/;
const SHARED_PLAN_ID_PREFIX = "shared:";

export type ProjectNoteSource = "manual" | "selection" | "agent";

export interface ProjectNote {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  source: ProjectNoteSource;
  pinned: boolean;
  origin?: { sessionId: string; messageId?: string };
}

export interface ProjectTodo {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

export interface ProjectPlanLink {
  id: string;
  file: string;
  title: string;
  createdAt: number;
  pinned: boolean;
  source?: "personal" | "shared";
}

export interface ProjectContext {
  version: number;
  notes: ProjectNote[];
  todos: ProjectTodo[];
  plans: ProjectPlanLink[];
  sharedPlansDir: string | null;
}

interface StoredPlanLink extends Omit<ProjectPlanLink, "source"> {
  shared?: boolean;
}

interface StoredContext {
  version: number;
  notes: ProjectNote[];
  todos: ProjectTodo[];
  plans: StoredPlanLink[];
}

interface ReadJsonResult {
  missing: boolean;
  value: Record<string, unknown> | null;
}

interface ProjectContextDependencies {
  projectsDirPath: string;
  resolveSharedPlansDir?: (projectId: string) => Promise<string | null>;
  createId?: () => string;
}

export interface ProjectContextRuntime {
  readContext(projectId: string): Promise<ProjectContext>;
  saveTodos(projectId: string, todos: unknown): Promise<ProjectContext>;
  createNote(projectId: string, value: { body?: unknown; source?: unknown; origin?: unknown }): Promise<{ note: ProjectNote; context: ProjectContext }>;
  updateNote(projectId: string, noteId: string, patch: { body?: unknown; pinned?: unknown }): Promise<{ note: ProjectNote; context: ProjectContext } | null>;
  deleteNote(projectId: string, noteId: string): Promise<{ deleted: boolean; context: ProjectContext }>;
  readPlan(projectId: string, planId: string): Promise<ProjectPlanContent | null>;
  updatePlan(projectId: string, planId: string, value: { raw?: unknown }): Promise<ProjectPlanMutation | null>;
  createPlan(projectId: string, value: { title?: unknown; body?: unknown }): Promise<{ plan: ProjectPlanLink; context: ProjectContext }>;
  setPlanPinned(projectId: string, planId: string, pinned: boolean): Promise<ProjectPlanMutation | null>;
  deletePlan(projectId: string, planId: string): Promise<{ deleted: boolean; context: ProjectContext }>;
  sharePlan(projectId: string, planId: string): Promise<ProjectPlanMutation | null>;
  unsharePlan(projectId: string, planId: string): Promise<ProjectPlanMutation | null>;
  contextPathFor(projectId: string): string;
  plansDirFor(projectId: string): string;
}

export interface ProjectPlanContent extends ProjectPlanLink {
  body: string;
  raw: string;
}

export interface ProjectPlanMutation {
  plan: ProjectPlanLink;
  context: ProjectContext;
  title?: string;
  body?: string;
  raw?: string;
}

export interface RouteResult {
  status?: number;
  body: unknown;
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

function clampLength(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isValidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("required")
    || message.includes("unsupported characters")
    || message.includes("at most")
    || message.includes("shared plans folder");
}

function sanitizeNoteOrigin(value: unknown): { sessionId: string; messageId?: string } | null {
  const record = asRecord(value);
  if (!record) return null;
  const sessionId = nonEmptyString(record.sessionId);
  const messageId = nonEmptyString(record.messageId);
  if (!sessionId) return null;
  return messageId ? { sessionId, messageId } : { sessionId };
}

function sanitizeNotes(value: unknown, now: number): ProjectNote[] {
  if (typeof value === "string") {
    const body = clampLength(value, PROJECT_NOTE_BODY_MAX_LENGTH).trim();
    return body
      ? [{ id: `note_legacy_${now}`, body, createdAt: now, updatedAt: now, source: "manual", pinned: false }]
      : [];
  }
  if (!Array.isArray(value)) return [];

  const result: ProjectNote[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (result.length >= PROJECT_NOTE_MAX_ITEMS) break;
    const record = asRecord(item);
    if (!record) continue;
    const id = nonEmptyString(record.id);
    const body = clampLength(record.body, PROJECT_NOTE_BODY_MAX_LENGTH).trim();
    if (!id || !body || seen.has(id)) continue;
    seen.add(id);
    const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) && record.createdAt >= 0
      ? record.createdAt
      : now;
    const origin = sanitizeNoteOrigin(record.origin);
    result.push({
      id,
      body,
      createdAt,
      updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) && record.updatedAt >= 0
        ? record.updatedAt
        : createdAt,
      source: record.source === "selection" || record.source === "agent" ? record.source : "manual",
      pinned: record.pinned === true,
      ...(origin ? { origin } : {}),
    });
  }
  return result.sort((left, right) => right.createdAt - left.createdAt);
}

function sanitizeTodos(value: unknown, now: number): ProjectTodo[] {
  if (!Array.isArray(value)) return [];
  const result: ProjectTodo[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (result.length >= PROJECT_TODO_MAX_ITEMS) break;
    const record = asRecord(item);
    if (!record) continue;
    const id = nonEmptyString(record.id);
    const text = clampLength(nonEmptyString(record.text) ?? "", PROJECT_TODO_TEXT_MAX_LENGTH);
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      text,
      completed: record.completed === true,
      createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) && record.createdAt >= 0
        ? record.createdAt
        : now,
    });
  }
  return result;
}

function sanitizePlanTitle(value: unknown): string {
  return clampLength(nonEmptyString(value) ?? "", PROJECT_PLAN_TITLE_MAX_LENGTH);
}

export function parsePlanMarkdown(raw: string): { title: string; body: string } {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const heading = normalized.match(/^\s*#\s+(.+?)\s*(?:\n+|$)/);
  if (heading) {
    return {
      title: sanitizePlanTitle(heading[1]) || "Plan",
      body: normalized.slice(heading[0].length).replace(/^\n+/, ""),
    };
  }
  const firstLine = normalized.split("\n").map((line) => line.trim()).find(Boolean) ?? "Plan";
  return { title: sanitizePlanTitle(firstLine.replace(/^#+\s*/, "")) || "Plan", body: normalized.trim() };
}

function formatPlanMarkdown(title: string, body: string): string {
  const normalizedTitle = sanitizePlanTitle(title) || "Plan";
  const normalizedBody = body.trim();
  return normalizedBody ? `# ${normalizedTitle}\n\n${normalizedBody}` : `# ${normalizedTitle}\n`;
}

function slugifyPlanTitle(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[`*_#>[\](){}.!?,:;"']/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "plan";
}

function sanitizePlanLinks(value: unknown, now: number): StoredPlanLink[] {
  if (!Array.isArray(value)) return [];
  const result: StoredPlanLink[] = [];
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  for (const item of value) {
    if (result.length >= PROJECT_PLAN_MAX_ITEMS) break;
    const record = asRecord(item);
    if (!record) continue;
    const id = nonEmptyString(record.id);
    const file = nonEmptyString(record.file) ?? nonEmptyString(record.path);
    if (!id || !file || !PLAN_FILE_PATTERN.test(file)) continue;
    const shared = record.shared === true;
    const fileKey = `${shared ? "shared" : "personal"}/${file}`;
    if (seenIds.has(id) || seenFiles.has(fileKey)) continue;
    seenIds.add(id);
    seenFiles.add(fileKey);
    const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) && record.createdAt >= 0
      ? record.createdAt
      : now;
    result.push({
      id,
      file,
      title: sanitizePlanTitle(record.title) || "Plan",
      createdAt,
      pinned: record.pinned === true,
      ...(shared ? { shared: true } : {}),
    });
  }
  return result.sort((left, right) => right.createdAt - left.createdAt);
}

function emptyStoredContext(): StoredContext {
  return { version: PROJECT_CONTEXT_VERSION, notes: [], todos: [], plans: [] };
}

function publicPlan(plan: StoredPlanLink): ProjectPlanLink {
  const { shared, ...link } = plan;
  return { ...link, source: shared ? "shared" : "personal" };
}

export function projectPathFromId(projectId: string): string | null {
  if (!projectId.startsWith("path_")) return null;
  const encoded = projectId.slice("path_".length);
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes).trim() || null;
  } catch {
    return null;
  }
}

function ensureSafeProjectId(projectId: string): string {
  const value = nonEmptyString(projectId);
  if (!value) throw new Error("projectId is required");
  if (!PROJECT_ID_PATTERN.test(value)) throw new Error("projectId contains unsupported characters");
  return value;
}

export function createProjectContextRuntime(dependencies: ProjectContextDependencies): ProjectContextRuntime {
  const { projectsDirPath } = dependencies;
  const sharedPlansDirFor = dependencies.resolveSharedPlansDir ?? (async (projectId: string) => {
    const projectPath = projectPathFromId(projectId);
    return projectPath ? join(projectPath, ".openchamber", "plans") : null;
  });
  const idFactory = dependencies.createId ?? randomUUID;
  const writeLocks = new Map<string, Promise<void>>();

  const storageDirFor = (projectId: string): string => join(projectsDirPath, ensureSafeProjectId(projectId));
  const contextPathFor = (projectId: string): string => join(storageDirFor(projectId), "context.json");
  const plansDirFor = (projectId: string): string => join(storageDirFor(projectId), "plans");
  const legacyConfigPathFor = (projectId: string): string => join(projectsDirPath, `${ensureSafeProjectId(projectId)}.json`);

  const readJson = async (filePath: string): Promise<ReadJsonResult> => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { missing: true, value: null };
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return { missing: false, value: asRecord(parsed) };
    } catch {
      return { missing: false, value: null };
    }
  };

  const writeJsonAtomic = async (filePath: string, value: unknown): Promise<void> => {
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const writeTextAtomic = async (filePath: string, value: string): Promise<void> => {
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(temporaryPath, value, "utf8");
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const withWriteLock = async <T>(projectId: string, mutate: () => Promise<T>): Promise<T> => {
    const key = ensureSafeProjectId(projectId);
    const previous = writeLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.finally(() => next);
    writeLocks.set(key, chained);
    await previous;
    try {
      return await mutate();
    } finally {
      release();
      if (writeLocks.get(key) === chained) writeLocks.delete(key);
    }
  };

  const migrateLegacyConfig = async (projectId: string, now: number): Promise<StoredContext | null> => {
    const legacy = await readJson(legacyConfigPathFor(projectId));
    if (!legacy.value) return null;
    const hasLegacyContext = legacy.value.projectNotes !== undefined
      || legacy.value.projectTodos !== undefined
      || legacy.value.projectPlanFiles !== undefined;
    if (!hasLegacyContext) return null;

    const plansDir = plansDirFor(projectId);
    const links: StoredPlanLink[] = [];
    const rawLinks = Array.isArray(legacy.value.projectPlanFiles) ? legacy.value.projectPlanFiles : [];
    for (const item of rawLinks) {
      const record = asRecord(item);
      const id = nonEmptyString(record?.id);
      const absolutePath = nonEmptyString(record?.path);
      if (!id || !absolutePath) continue;
      const file = basename(absolutePath);
      if (!PLAN_FILE_PATTERN.test(file)) continue;
      const targetPath = join(plansDir, file);
      let raw: string;
      try {
        raw = await readFile(targetPath, "utf8");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        try {
          raw = await readFile(absolutePath, "utf8");
        } catch (recoverError) {
          if (errorCode(recoverError) === "ENOENT") continue;
          throw recoverError;
        }
        await writeTextAtomic(targetPath, raw);
      }
      links.push({ id, file, title: parsePlanMarkdown(raw).title, createdAt: typeof record?.createdAt === "number" ? record.createdAt : now, pinned: false });
    }

    const migrated: StoredContext = {
      version: PROJECT_CONTEXT_VERSION,
      notes: sanitizeNotes(legacy.value.projectNotes, now),
      todos: sanitizeTodos(legacy.value.projectTodos, now),
      plans: sanitizePlanLinks(links, now),
    };
    await writeJsonAtomic(contextPathFor(projectId), migrated);
    const remaining = { ...legacy.value };
    delete remaining.projectNotes;
    delete remaining.projectTodos;
    delete remaining.projectPlanFiles;
    await writeJsonAtomic(legacyConfigPathFor(projectId), remaining);
    return migrated;
  };

  const readStoredContext = async (projectId: string): Promise<StoredContext> => {
    const now = Date.now();
    const stored = await readJson(contextPathFor(projectId));
    if (!stored.missing && !stored.value) throw new Error("Stored project context is malformed");
    if (stored.missing) {
      const migrated = await migrateLegacyConfig(projectId, now);
      if (migrated) return migrated;
      return emptyStoredContext();
    }
    return {
      version: PROJECT_CONTEXT_VERSION,
      notes: sanitizeNotes(stored.value?.notes, now),
      todos: sanitizeTodos(stored.value?.todos, now),
      plans: sanitizePlanLinks(stored.value?.plans, now),
    };
  };

  const sharedPlanFileOf = (planId: string): string | null => {
    if (!planId.startsWith(SHARED_PLAN_ID_PREFIX)) return null;
    const file = planId.slice(SHARED_PLAN_ID_PREFIX.length);
    return PLAN_FILE_PATTERN.test(file) ? file : null;
  };

  const listSharedPlans = async (projectId: string, claimedFiles: Set<string>): Promise<{ dir: string | null; plans: ProjectPlanLink[] }> => {
    const dir = await sharedPlansDirFor(projectId);
    if (!dir) return { dir: null, plans: [] };
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { dir, plans: [] };
      throw error;
    }
    const plans: ProjectPlanLink[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !PLAN_FILE_PATTERN.test(entry.name) || claimedFiles.has(entry.name)) continue;
      const filePath = join(dir, entry.name);
      const [raw, fileStat] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
      plans.push({
        id: `${SHARED_PLAN_ID_PREFIX}${entry.name}`,
        file: entry.name,
        title: parsePlanMarkdown(raw).title,
        createdAt: Math.round(fileStat.mtimeMs),
        pinned: false,
        source: "shared",
      });
    }
    plans.sort((left, right) => right.createdAt - left.createdAt);
    return { dir, plans };
  };

  const readContext = async (projectId: string): Promise<ProjectContext> => {
    const stored = await readStoredContext(projectId);
    const claimed = new Set(stored.plans.filter((plan) => plan.shared).map((plan) => plan.file));
    const shared = await listSharedPlans(projectId, claimed);
    const own = stored.plans
      .filter((plan) => !plan.shared || shared.dir)
      .map(publicPlan);
    return {
      version: PROJECT_CONTEXT_VERSION,
      notes: stored.notes,
      todos: stored.todos,
      plans: [...own, ...shared.plans],
      sharedPlansDir: shared.dir,
    };
  };

  const folderOfLink = async (projectId: string, link: StoredPlanLink): Promise<string | null> => (
    link.shared ? sharedPlansDirFor(projectId) : plansDirFor(projectId)
  );

  const writeContext = async (projectId: string, context: StoredContext): Promise<void> => {
    await writeJsonAtomic(contextPathFor(projectId), {
      version: PROJECT_CONTEXT_VERSION,
      notes: context.notes,
      todos: context.todos,
      plans: context.plans,
    });
  };

  const saveTodos = (projectId: string, todos: unknown): Promise<ProjectContext> => withWriteLock(projectId, async () => {
    const current = await readStoredContext(projectId);
    const next = { ...current, todos: sanitizeTodos(todos, Date.now()) };
    await writeContext(projectId, next);
    return readContext(projectId);
  });

  const createNote = (projectId: string, value: { body?: unknown; source?: unknown; origin?: unknown }): Promise<{ note: ProjectNote; context: ProjectContext }> => withWriteLock(projectId, async () => {
    const body = clampLength(value.body, PROJECT_NOTE_BODY_MAX_LENGTH).trim();
    if (!body) throw new Error("body is required");
    const current = await readStoredContext(projectId);
    if (current.notes.length >= PROJECT_NOTE_MAX_ITEMS) throw new Error(`A project can hold at most ${PROJECT_NOTE_MAX_ITEMS} notes`);
    const now = Date.now();
    const origin = sanitizeNoteOrigin(value.origin);
    const note: ProjectNote = {
      id: idFactory(),
      body,
      createdAt: now,
      updatedAt: now,
      source: value.source === "selection" || value.source === "agent" ? value.source : "manual",
      pinned: false,
      ...(origin ? { origin } : {}),
    };
    const next = { ...current, notes: [note, ...current.notes] };
    await writeContext(projectId, next);
    return { note, context: await readContext(projectId) };
  });

  const updateNote = (projectId: string, noteId: string, patch: { body?: unknown; pinned?: unknown }): Promise<{ note: ProjectNote; context: ProjectContext } | null> => withWriteLock(projectId, async () => {
    const id = nonEmptyString(noteId);
    if (!id) throw new Error("noteId is required");
    const hasBody = typeof patch.body === "string";
    const hasPinned = typeof patch.pinned === "boolean";
    if (!hasBody && !hasPinned) throw new Error("body or pinned is required");
    const body = hasBody ? clampLength(patch.body, PROJECT_NOTE_BODY_MAX_LENGTH).trim() : "";
    if (hasBody && !body) throw new Error("body is required");
    const current = await readStoredContext(projectId);
    const existing = current.notes.find((note) => note.id === id);
    if (!existing) return null;
    const note: ProjectNote = {
      ...existing,
      ...(hasBody ? { body, updatedAt: Date.now() } : {}),
      ...(hasPinned ? { pinned: patch.pinned === true } : {}),
    };
    const next = { ...current, notes: current.notes.map((entry) => entry.id === id ? note : entry) };
    await writeContext(projectId, next);
    return { note, context: await readContext(projectId) };
  });

  const deleteNote = (projectId: string, noteId: string): Promise<{ deleted: boolean; context: ProjectContext }> => withWriteLock(projectId, async () => {
    const id = nonEmptyString(noteId);
    if (!id) throw new Error("noteId is required");
    const current = await readStoredContext(projectId);
    if (!current.notes.some((note) => note.id === id)) return { deleted: false, context: await readContext(projectId) };
    const next = { ...current, notes: current.notes.filter((note) => note.id !== id) };
    await writeContext(projectId, next);
    return { deleted: true, context: await readContext(projectId) };
  });

  const readPlan = async (projectId: string, planId: string): Promise<ProjectPlanContent | null> => {
    const id = nonEmptyString(planId);
    if (!id) throw new Error("planId is required");
    const sharedFile = sharedPlanFileOf(id);
    if (sharedFile) {
      const dir = await sharedPlansDirFor(projectId);
      if (!dir) return null;
      let raw: string;
      try {
        raw = await readFile(join(dir, sharedFile), "utf8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
      const parsed = parsePlanMarkdown(raw);
      return { id, file: sharedFile, createdAt: 0, title: parsed.title, body: parsed.body, raw, pinned: false, source: "shared" };
    }
    const context = await readStoredContext(projectId);
    const link = context.plans.find((entry) => entry.id === id);
    if (!link) return null;
    const folder = await folderOfLink(projectId, link);
    if (!folder) return null;
    let raw: string;
    try {
      raw = await readFile(join(folder, link.file), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    const parsed = parsePlanMarkdown(raw);
    return { ...publicPlan(link), body: parsed.body, raw, title: parsed.title };
  };

  const updatePlan = (projectId: string, planId: string, value: { raw?: unknown }): Promise<ProjectPlanMutation | null> => withWriteLock(projectId, async () => {
    const id = nonEmptyString(planId);
    if (!id) throw new Error("planId is required");
    if (typeof value.raw !== "string") throw new Error("raw is required");
    const raw = clampLength(value.raw, PROJECT_PLAN_BODY_MAX_LENGTH);
    const sharedFile = sharedPlanFileOf(id);
    if (sharedFile) {
      const dir = await sharedPlansDirFor(projectId);
      if (!dir || !(await access(join(dir, sharedFile)).then(() => true, () => false))) return null;
      await writeTextAtomic(join(dir, sharedFile), raw);
      const parsed = parsePlanMarkdown(raw);
      const context = await readContext(projectId);
      const plan = context.plans.find((entry) => entry.id === id) ?? {
        id,
        file: sharedFile,
        title: parsed.title,
        createdAt: Date.now(),
        pinned: false,
        source: "shared" as const,
      };
      return { plan, context, title: parsed.title, body: parsed.body, raw };
    }

    const current = await readStoredContext(projectId);
    const link = current.plans.find((entry) => entry.id === id);
    if (!link) return null;
    const folder = await folderOfLink(projectId, link);
    if (!folder) return null;
    const filePath = join(folder, link.file);
    if (!(await access(filePath).then(() => true, () => false))) return null;
    await writeTextAtomic(filePath, raw);
    const parsed = parsePlanMarkdown(raw);
    const nextLink = { ...link, title: parsed.title };
    await writeContext(projectId, { ...current, plans: current.plans.map((entry) => entry.id === id ? nextLink : entry) });
    return { plan: publicPlan(nextLink), context: await readContext(projectId), title: parsed.title, body: parsed.body, raw };
  });

  const createPlan = (projectId: string, value: { title?: unknown; body?: unknown }): Promise<{ plan: ProjectPlanLink; context: ProjectContext }> => withWriteLock(projectId, async () => {
    const current = await readStoredContext(projectId);
    const title = sanitizePlanTitle(value.title) || "Plan";
    const body = clampLength(value.body, PROJECT_PLAN_BODY_MAX_LENGTH);
    const createdAt = Date.now();
    const plansDir = plansDirFor(projectId);
    await mkdir(plansDir, { recursive: true });
    const baseName = `${createdAt}-${slugifyPlanTitle(title)}`;
    let file = `${baseName}.md`;
    let attempt = 1;
    while (current.plans.some((entry) => !entry.shared && entry.file === file) || await access(join(plansDir, file)).then(() => true, () => false)) {
      file = `${baseName}-${attempt}.md`;
      attempt += 1;
    }
    await writeTextAtomic(join(plansDir, file), formatPlanMarkdown(title, body));
    const link: StoredPlanLink = { id: idFactory(), file, title, createdAt, pinned: false };
    await writeContext(projectId, { ...current, plans: [link, ...current.plans] });
    return { plan: publicPlan(link), context: await readContext(projectId) };
  });

  const setPlanPinned = (projectId: string, planId: string, pinned: boolean): Promise<ProjectPlanMutation | null> => withWriteLock(projectId, async () => {
    const id = nonEmptyString(planId);
    if (!id) throw new Error("planId is required");
    const current = await readStoredContext(projectId);
    const existing = current.plans.find((entry) => entry.id === id);
    if (!existing) return null;
    const plan = { ...existing, pinned };
    await writeContext(projectId, { ...current, plans: current.plans.map((entry) => entry.id === id ? plan : entry) });
    return { plan: publicPlan(plan), context: await readContext(projectId) };
  });

  const deletePlan = (projectId: string, planId: string): Promise<{ deleted: boolean; context: ProjectContext }> => withWriteLock(projectId, async () => {
    const id = nonEmptyString(planId);
    if (!id) throw new Error("planId is required");
    const sharedFile = sharedPlanFileOf(id);
    if (sharedFile) {
      const dir = await sharedPlansDirFor(projectId);
      const filePath = dir ? join(dir, sharedFile) : null;
      if (!filePath || !(await access(filePath).then(() => true, () => false))) return { deleted: false, context: await readContext(projectId) };
      await rm(filePath, { force: true });
      return { deleted: true, context: await readContext(projectId) };
    }
    const current = await readStoredContext(projectId);
    const link = current.plans.find((entry) => entry.id === id);
    if (!link) return { deleted: false, context: await readContext(projectId) };
    await writeContext(projectId, { ...current, plans: current.plans.filter((entry) => entry.id !== id) });
    const folder = await folderOfLink(projectId, link);
    if (folder) await rm(join(folder, link.file), { force: true });
    return { deleted: true, context: await readContext(projectId) };
  });

  const freeFileNameIn = async (dir: string, wanted: string, taken = new Set<string>()): Promise<string> => {
    const base = wanted.replace(/\.md$/, "");
    let file = wanted;
    let attempt = 1;
    while (taken.has(file) || await access(join(dir, file)).then(() => true, () => false)) {
      file = `${base}-${attempt}.md`;
      attempt += 1;
    }
    return file;
  };

  const moveFile = async (from: string, to: string): Promise<void> => {
    try {
      await rename(from, to);
    } catch (error) {
      if (errorCode(error) !== "EXDEV") throw error;
      await copyFile(from, to);
      await rm(from, { force: true });
    }
  };

  const sharePlan = (projectId: string, planId: string): Promise<ProjectPlanMutation | null> => withWriteLock(projectId, async () => {
    const id = nonEmptyString(planId);
    if (!id) throw new Error("planId is required");
    const dir = await sharedPlansDirFor(projectId);
    if (!dir) throw new Error("shared plans folder is required");
    const current = await readStoredContext(projectId);
    const link = current.plans.find((entry) => entry.id === id);
    if (!link || link.shared) return null;
    const from = join(plansDirFor(projectId), link.file);
    if (!(await access(from).then(() => true, () => false))) return null;
    await mkdir(dir, { recursive: true });
    const file = await freeFileNameIn(dir, link.file);
    await moveFile(from, join(dir, file));
    const moved = { ...link, file, shared: true };
    await writeContext(projectId, { ...current, plans: current.plans.map((entry) => entry.id === id ? moved : entry) });
    const context = await readContext(projectId);
    return { plan: context.plans.find((entry) => entry.id === id) ?? publicPlan(moved), context };
  });

  const unsharePlan = (projectId: string, planId: string): Promise<ProjectPlanMutation | null> => withWriteLock(projectId, async () => {
    const id = nonEmptyString(planId);
    if (!id) throw new Error("planId is required");
    const dir = await sharedPlansDirFor(projectId);
    if (!dir) return null;
    const current = await readStoredContext(projectId);
    const ownLink = current.plans.find((entry) => entry.id === id && entry.shared);
    const sharedFile = ownLink?.file ?? sharedPlanFileOf(id);
    if (!sharedFile) return null;
    const from = join(dir, sharedFile);
    let raw: string;
    try {
      raw = await readFile(from, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    const plansDir = plansDirFor(projectId);
    await mkdir(plansDir, { recursive: true });
    const taken = new Set(current.plans.filter((entry) => !entry.shared).map((entry) => entry.file));
    const file = await freeFileNameIn(plansDir, sharedFile, taken);
    await moveFile(from, join(plansDir, file));
    const parsed = parsePlanMarkdown(raw);
    const link: StoredPlanLink = ownLink
      ? { ...ownLink, file, title: parsed.title, shared: false }
      : { id: idFactory(), file, title: parsed.title, createdAt: Date.now(), pinned: false };
    const plans = ownLink ? current.plans.map((entry) => entry.id === id ? link : entry) : [link, ...current.plans];
    await writeContext(projectId, { ...current, plans });
    return { plan: publicPlan(link), context: await readContext(projectId) };
  });

  return {
    readContext,
    saveTodos,
    createNote,
    updateNote,
    deleteNote,
    readPlan,
    updatePlan,
    createPlan,
    setPlanPinned,
    deletePlan,
    sharePlan,
    unsharePlan,
    contextPathFor,
    plansDirFor,
  };
}

function decodePathSegments(pathname: string, prefix: string): string[] | null {
  if (!pathname.startsWith(prefix)) return null;
  try {
    return pathname.slice(prefix.length).split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await req.json());
  } catch {
    return null;
  }
}

function result(body: unknown, status?: number): RouteResult {
  return status === undefined ? { body } : { status, body };
}

export async function handleProjectContextRequest(
  req: Request,
  url: URL,
  runtime: ProjectContextRuntime,
): Promise<RouteResult | null> {
  const segments = decodePathSegments(url.pathname, "/api/project-context/");
  if (segments === null) return null;
  const projectId = segments[0];
  if (!projectId) return result({ error: "projectId is required" }, 400);

  try {
    if (segments.length === 1 && req.method === "GET") return result(await runtime.readContext(projectId));

    if (segments[1] === "todos" && segments.length === 2 && req.method === "PUT") {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.todos)) return result({ error: "todos must be an array of todo items" }, 400);
      const valid = body.todos.every((todo) => {
        const record = asRecord(todo);
        return Boolean(record)
          && typeof record?.id === "string"
          && typeof record?.text === "string"
          && (record?.completed === undefined || typeof record.completed === "boolean")
          && (record?.createdAt === undefined || (typeof record.createdAt === "number" && Number.isFinite(record.createdAt)));
      });
      if (!valid) return result({ error: "todos must be an array of todo items" }, 400);
      return result(await runtime.saveTodos(projectId, body.todos));
    }

    if (segments[1] === "notes" && segments.length === 2 && req.method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body.body !== "string") return result({ error: "body must be a string" }, 400);
      if (body.source !== undefined && body.source !== "manual" && body.source !== "selection" && body.source !== "agent") {
        return result({ error: "source must be manual, selection, or agent" }, 400);
      }
      if (body.origin !== undefined && !asRecord(body.origin)) return result({ error: "origin must be an object" }, 400);
      return result({ ...(await runtime.createNote(projectId, body)), }, 201);
    }

    if (segments[1] === "notes" && segments.length === 3 && req.method === "PATCH") {
      const body = await readBody(req);
      if (!body || (body.body !== undefined && typeof body.body !== "string") || (body.pinned !== undefined && typeof body.pinned !== "boolean")) {
        return result({ error: "body or pinned is required" }, 400);
      }
      const updated = await runtime.updateNote(projectId, segments[2], body);
      return updated ? result(updated) : result({ error: "Note not found" }, 404);
    }

    if (segments[1] === "notes" && segments.length === 3 && req.method === "DELETE") {
      const deleted = await runtime.deleteNote(projectId, segments[2]);
      return deleted.deleted ? result(deleted.context) : result({ error: "Note not found" }, 404);
    }

    if (segments[1] === "plans" && segments.length === 2 && req.method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body.body !== "string") return result({ error: "body must be a string" }, 400);
      if (body.title !== undefined && typeof body.title !== "string") return result({ error: "title must be a string" }, 400);
      return result(await runtime.createPlan(projectId, body), 201);
    }

    if (segments[1] === "plans" && segments.length === 3 && req.method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body.pinned !== "boolean") return result({ error: "pinned must be a boolean" }, 400);
      const updated = await runtime.setPlanPinned(projectId, segments[2], body.pinned);
      return updated ? result(updated) : result({ error: "Plan not found" }, 404);
    }

    if (segments[1] === "plans" && segments.length === 3 && req.method === "GET") {
      const plan = await runtime.readPlan(projectId, segments[2]);
      return plan ? result(plan) : result({ error: "Plan not found" }, 404);
    }

    if (segments[1] === "plans" && segments.length === 3 && req.method === "PUT") {
      const body = await readBody(req);
      if (!body || typeof body.raw !== "string") return result({ error: "raw must be a string" }, 400);
      const updated = await runtime.updatePlan(projectId, segments[2], body);
      return updated ? result(updated) : result({ error: "Plan not found" }, 404);
    }

    if (segments[1] === "plans" && segments.length === 3 && req.method === "DELETE") {
      const deleted = await runtime.deletePlan(projectId, segments[2]);
      return deleted.deleted ? result(deleted.context) : result({ error: "Plan not found" }, 404);
    }

    if (segments[1] === "plans" && segments.length === 4 && req.method === "POST" && (segments[3] === "share" || segments[3] === "unshare")) {
      const moved = segments[3] === "share"
        ? await runtime.sharePlan(projectId, segments[2])
        : await runtime.unsharePlan(projectId, segments[2]);
      return moved ? result(moved) : result({ error: "Plan not found" }, 404);
    }

    return result({ error: "not implemented" }, 404);
  } catch (error) {
    return result({ error: error instanceof Error ? error.message : "project context failed" }, isValidationError(error) ? 400 : 500);
  }
}
