import { readdir, stat, mkdir, unlink, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  isLowSignalTitleInput,
  overlayTitleSlotContent,
  parseTitleSlotLine,
  serializeTitleSlot,
} from "./title";
import {
  deleteIndexedTitle,
  lookupIndexedTitle,
  recordIndexedTitle,
  searchMatchingSessionIds,
} from "./title-db";
import { emitSessionUpdated } from "./sse";

function ompSessionsRoot(): string {
  return join(Bun.env.HOME!, ".omp", "agent", "sessions");
}
function homePrefix(): string {
  return Bun.env.HOME! + "/";
}

interface ModelRef {
  id: string;
  providerID: string;
  modelID: string;
  variant: string;
}

export interface OpenCodeSession {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  path: string;
  title?: string;
  agent: string;
  model: ModelRef;
  version: string;
  time: { created: number; updated: number; archived?: number };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  metadata?: Record<string, unknown>;
}

interface SessionHeader {
  id: string;
  cwd: string;
  title?: string;
  timestamp: string;
  version?: string;
  firstUserPrompt?: string;
  metadata?: Record<string, unknown>;
  archived?: number;
}

export function encodeCwd(cwd: string): string {
  let encoded = cwd;
  if (encoded.startsWith(homePrefix())) {
    encoded = "/" + encoded.slice(homePrefix().length);
  }
  return encoded.replace(/\//g, "-");
}

/** Convert an internal omp UUID into the external OpenCode session id. */
export function toOpenCodeSessionId(ompId: string): string {
  if (ompId.startsWith("ses_")) return ompId;
  const compact = ompId.replace(/-/g, "").toLowerCase();
  return `ses_${compact}`;
}

/** Convert an external OpenCode session id back into the internal omp UUID. */
export function fromOpenCodeSessionId(openCodeId: string): string {
  if (!openCodeId.startsWith("ses_")) return openCodeId;
  const raw = openCodeId.slice(4).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(raw)) return openCodeId;
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20, 32),
  ].join("-");
}

export async function readSessionHeader(
  filePath: string,
): Promise<SessionHeader | null> {
  try {
    const text = await Bun.file(filePath).text();
    const lines = text.split("\n");
    const maxHeaderLines = Math.min(lines.length, 200);
    let header: SessionHeader | null = null;
    let latestTitle: string | undefined;
    let firstUserPrompt: string | undefined;
    let latestMetadata: Record<string, unknown> | undefined;
    let latestArchived: number | undefined;

    for (let i = 0; i < maxHeaderLines; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session" && typeof entry.id === "string" && typeof entry.cwd === "string") {
          header = {
            id: entry.id,
            cwd: entry.cwd,
            title: typeof entry.title === "string" && entry.title.trim().length > 0 ? entry.title.trim() : undefined,
            timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
            version:
              typeof entry.version === "string"
                ? entry.version
                : typeof entry.version === "number"
                  ? String(entry.version)
                  : undefined,
            metadata: entry.metadata && typeof entry.metadata === "object" ? entry.metadata : undefined,
          };
          if (header.metadata) {
            latestMetadata = { ...(latestMetadata || {}), ...header.metadata };
          }
          break;
        }
      } catch { /* skip malformed JSON */ }
    }

    if (!header) return null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (
          (entry.type === "title" || entry.type === "title_change") &&
          typeof entry.title === "string" &&
          entry.title.trim().length > 0
        ) {
          latestTitle = entry.title.trim();
        } else if (entry.type === "metadata" && entry.metadata && typeof entry.metadata === "object") {
          latestMetadata = { ...(latestMetadata || {}), ...entry.metadata };
        } else if (entry.type === "archive") {
          latestArchived = typeof entry.archived === "number" ? entry.archived : (entry.archived ? Date.now() : 0);
        } else if (!firstUserPrompt && entry.type === "message" && entry.message?.role === "user") {
          const content = entry.message.content;
          let promptText = "";
          if (typeof content === "string") {
            promptText = content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && typeof block.text === "string") {
                promptText = block.text;
                break;
              }
            }
          }
          if (promptText && !isLowSignalTitleInput(promptText)) {
            firstUserPrompt = promptText.trim();
          }
        }
      } catch { /* skip malformed JSON */ }
    }

    if (latestTitle !== undefined) {
      header.title = latestTitle;
    } else if (!header.title) {
      const indexed = lookupIndexedTitle(header.id);
      if (indexed) header.title = indexed;
    }
    if (firstUserPrompt !== undefined) header.firstUserPrompt = firstUserPrompt;
    if (latestMetadata !== undefined) header.metadata = latestMetadata;
    if (latestArchived !== undefined) header.archived = latestArchived;
    return header;
  } catch { /* file unreadable */ }
  return null;
}

async function buildOpenCodeSession(
  header: SessionHeader,
  filePath: string,
): Promise<OpenCodeSession> {
  const openCodeId = toOpenCodeSessionId(header.id);
  const compactId = header.id.replace(/-/g, "");
  const first8 = compactId.slice(0, 8);
  const created = Date.parse(header.timestamp) || Date.now();
  let updated = created;

  try {
    const s = await stat(filePath);
    if (s.mtimeMs) updated = Math.floor(s.mtimeMs);
  } catch { /* keep created as fallback */ }

  let title = header.title;
  if (!title && header.firstUserPrompt) {
    const clean = header.firstUserPrompt.replace(/\s+/g, " ").trim();
    title = clean.length > 50 ? `${clean.slice(0, 47)}...` : clean;
  }
  if (!title) {
    title = `Session ${first8}`;
  }

  return {
    id: openCodeId,
    slug: openCodeId,
    projectID: "global",
    directory: header.cwd,
    path: filePath,
    title,
    agent: "omp",
    model: { id: "omp", providerID: "omp", modelID: "omp", variant: "default" },
    version: header.version || "0.0.0",
    time: {
      created,
      updated,
      ...(header.archived !== undefined ? { archived: header.archived } : {}),
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    metadata: header.metadata,
  };
}

export async function createOmpSession(
  directory?: string | null,
  options?: { title?: string; parentID?: string },
): Promise<OpenCodeSession> {
  const cwd = directory || process.cwd();
  const uuid = randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const fileName = `${fileTimestamp}_${uuid}.jsonl`;

  const encoded = encodeCwd(cwd);
  const dirPath = join(ompSessionsRoot(), encoded);
  await mkdir(dirPath, { recursive: true });

  const filePath = join(dirPath, fileName);
  const titleSlot = serializeTitleSlot({
    title: options?.title ?? "",
    source: options?.title ? "user" : undefined,
    updatedAt: timestamp,
  });
  const headerRecord = {
    type: "session",
    id: uuid,
    timestamp,
    cwd,
    title: options?.title,
    provider: "omp",
    modelId: "omp",
    thinkingLevel: "off",
    version: 3,
    parentSession: options?.parentID ? fromOpenCodeSessionId(options.parentID) : undefined,
  };

  await Bun.write(filePath, titleSlot + JSON.stringify(headerRecord) + "\n");
  if (options?.title) {
    recordIndexedTitle(uuid, options.title);
  }
  return buildOpenCodeSession(
    {
      id: uuid,
      cwd,
      title: options?.title,
      timestamp,
      version: "3",
    },
    filePath,
  );
}

export async function deleteOmpSession(
  openCodeId: string,
  directory?: string | null,
): Promise<boolean> {
  const session = (await getOmpSessionByOpenCodeId(openCodeId, directory)) || (await getOmpSessionByOpenCodeId(openCodeId));
  if (!session) return false;
  try {
    deleteIndexedTitle(fromOpenCodeSessionId(openCodeId));
    await unlink(session.path);
    return true;
  } catch {
    return false;
  }
}

export async function setOmpSessionTitle(
  openCodeId: string,
  newTitle: string,
  source: "auto" | "user" = "auto",
  directory?: string | null,
): Promise<OpenCodeSession | null> {
  const session = (await getOmpSessionByOpenCodeId(openCodeId, directory)) || (await getOmpSessionByOpenCodeId(openCodeId));
  if (!session) return null;

  try {
    const existing = await Bun.file(session.path).text();
    const cleanTitle = newTitle.replace(/\r?\n/g, " ").trim();
    const updatedContent = overlayTitleSlotContent(existing, {
      title: cleanTitle,
      source,
      updatedAt: new Date().toISOString(),
    });
    await Bun.write(session.path, updatedContent);
    recordIndexedTitle(fromOpenCodeSessionId(openCodeId), cleanTitle);

    session.title = cleanTitle;
    session.time.updated = Date.now();
    emitSessionUpdated(session as unknown as Record<string, unknown>);
    return session;
  } catch {
    return null;
  }
}

export async function updateOmpSession(
  openCodeId: string,
  updates: {
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { archived?: number | null };
  },
  directory?: string | null,
): Promise<OpenCodeSession | null> {
  let session = (await getOmpSessionByOpenCodeId(openCodeId, directory)) || (await getOmpSessionByOpenCodeId(openCodeId));
  if (!session) return null;

  if (updates.title !== undefined && updates.title !== session.title) {
    session = (await setOmpSessionTitle(openCodeId, updates.title, "user", session.directory)) || session;
  }

  if (updates.metadata !== undefined && typeof updates.metadata === "object") {
    try {
      const timestamp = new Date().toISOString();
      const metadataEntry = JSON.stringify({
        type: "metadata",
        metadata: updates.metadata,
        timestamp,
      }) + "\n";
      await appendFile(session.path, metadataEntry);
      session.metadata = { ...(session.metadata || {}), ...updates.metadata };
      session.time.updated = Date.now();
      emitSessionUpdated(session as unknown as Record<string, unknown>);
    } catch {
      // ignore
    }
  }

  if (updates.time?.archived !== undefined) {
    try {
      const timestamp = new Date().toISOString();
      const archivedVal = updates.time.archived ?? 0;
      const archiveEntry = JSON.stringify({
        type: "archive",
        archived: archivedVal,
        timestamp,
      }) + "\n";
      await appendFile(session.path, archiveEntry);
      session.time = { ...session.time, archived: archivedVal };
      session.time.updated = Date.now();
      emitSessionUpdated(session as unknown as Record<string, unknown>);
    } catch {
      // ignore
    }
  }

  return session;
}

export async function listOmpSessions(
  directory?: string | null,
  options?: { all?: boolean; limit?: number; archived?: boolean; search?: string },
): Promise<OpenCodeSession[]> {
  const all = options?.all ?? false;
  const limit = options?.limit;
  const archived = options?.archived;
  const search = options?.search?.trim();
  const searchLower = search ? search.toLowerCase() : undefined;
  const matchingOmpIds = search ? searchMatchingSessionIds(search) : undefined;
  const sessions: OpenCodeSession[] = [];

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = (await readdir(ompSessionsRoot(), { withFileTypes: true })) as unknown as {
      name: string;
      isDirectory(): boolean;
    }[];
  } catch { return sessions; }

  let dirs = entries.filter((e) => e.isDirectory());
  if (!all && directory) {
    const encoded = encodeCwd(directory);
    dirs = dirs.filter(
      (e) => e.name === encoded || e.name.startsWith(`${encoded}.`),
    );
  } else if (!all) {
    return sessions;
  }

  for (const dir of dirs) {
    const dirPath = join(ompSessionsRoot(), dir.name);
    let files: string[];
    try { files = await readdir(dirPath); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, file);
      const header = await readSessionHeader(filePath);
      if (!header) continue;
      if (!all && header.cwd !== directory) continue;
      if (archived !== true && !!header.archived) continue;

      if (searchLower) {
        const titleMatch = header.title?.toLowerCase().includes(searchLower);
        const promptMatch = header.firstUserPrompt?.toLowerCase().includes(searchLower);
        const idMatch = header.id.toLowerCase().includes(searchLower);
        const cwdMatch = header.cwd.toLowerCase().includes(searchLower);
        const ftsMatch = matchingOmpIds?.has(header.id);
        if (!titleMatch && !promptMatch && !idMatch && !cwdMatch && !ftsMatch) {
          continue;
        }
      }

      sessions.push(await buildOpenCodeSession(header, filePath));
      if (limit !== undefined && sessions.length >= limit) break;
    }
    if (limit !== undefined && sessions.length >= limit) break;
  }

  return sessions;
}

export async function getOmpSessionByOpenCodeId(
  openCodeId: string,
  directory?: string | null,
): Promise<OpenCodeSession | null> {
  const ompId = fromOpenCodeSessionId(openCodeId);

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = (await readdir(ompSessionsRoot(), { withFileTypes: true })) as unknown as {
      name: string;
      isDirectory(): boolean;
    }[];
  } catch { return null; }

  let dirs = entries.filter((e) => e.isDirectory());
  if (directory) {
    const encoded = encodeCwd(directory);
    dirs = dirs.filter(
      (e) => e.name === encoded || e.name.startsWith(`${encoded}.`),
    );
  }

  for (const dir of dirs) {
    const dirPath = join(ompSessionsRoot(), dir.name);
    let files: string[];
    try { files = await readdir(dirPath); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, file);
      const header = await readSessionHeader(filePath);
      if (!header) continue;
      if (header.id === ompId) {
        if (directory && header.cwd !== directory) continue;
        return buildOpenCodeSession(header, filePath);
      }
    }
  }

  return null;
}
