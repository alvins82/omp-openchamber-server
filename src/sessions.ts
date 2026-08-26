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
  deletePersistedMessageIds,
  lookupIndexedTitle,
  recordIndexedTitle,
  searchMatchingSessionIds,
} from "./title-db";
import { emitSessionUpdated } from "./sse";
import { mapOmpUsageToTokens, type TokenBreakdown } from "./messages";

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
  parentID?: string;
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
  parentSession?: string;
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
  tokens?: TokenBreakdown;
  cost?: number;
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
            parentSession:
              typeof entry.parentSession === "string"
                ? entry.parentSession
                : typeof entry.parentID === "string"
                  ? entry.parentID
                  : typeof entry.parentId === "string"
                    ? entry.parentId
                    : undefined,
            agent: typeof entry.agent === "string" ? entry.agent : (typeof entry.mode === "string" ? entry.mode : undefined),
          };
          if (header.metadata) {
            latestMetadata = { ...(latestMetadata || {}), ...header.metadata };
          }
          break;
        }
      } catch { /* skip malformed JSON */ }
    }

    if (!header) return null;

    let latestTokens: TokenBreakdown | undefined;
    let latestCost: number | undefined;
    let latestModel: { providerID: string; modelID: string; variant?: string } | undefined;

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
        } else if (entry.type === "model_change") {
          const rawModel = typeof entry.model === "string" ? entry.model : (typeof entry.modelID === "string" ? entry.modelID : "");
          const slash = rawModel.indexOf("/");
          if (slash !== -1) {
            latestModel = {
              providerID: rawModel.slice(0, slash),
              modelID: rawModel.slice(slash + 1),
              variant: typeof entry.role === "string" ? entry.role : "default",
            };
          } else if (rawModel) {
            latestModel = {
              providerID: typeof entry.providerID === "string" ? entry.providerID : (typeof entry.provider === "string" ? entry.provider : "omp"),
              modelID: rawModel,
              variant: typeof entry.role === "string" ? entry.role : "default",
            };
          }
        } else if (entry.type === "message" && entry.message?.role === "assistant") {
          const raw = entry.message;
          if (typeof raw?.provider === "string" && typeof raw?.model === "string") {
            latestModel = {
              providerID: raw.provider,
              modelID: raw.model,
              variant: typeof raw.variant === "string" ? raw.variant : "default",
            };
          }
          if (raw?.usage || raw?.cost) {
            const mapped = mapOmpUsageToTokens(raw.usage, raw.cost);
            if (mapped.tokens.input > 0 || mapped.tokens.output > 0 || mapped.tokens.cache.read > 0 || mapped.tokens.cache.write > 0) {
              latestTokens = mapped.tokens;
            }
            if (mapped.cost > 0) {
              latestCost = (latestCost ?? 0) + mapped.cost;
            }
          }
        } else if (!firstUserPrompt && entry.type === "session_init" && typeof entry.task === "string") {
          const clean = entry.task.replace(/\s+/g, " ").trim();
          if (clean && !isLowSignalTitleInput(clean)) {
            firstUserPrompt = clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
          }
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
    if (latestModel !== undefined) header.model = latestModel;
    if (latestTokens !== undefined) header.tokens = latestTokens;
    if (latestCost !== undefined) header.cost = latestCost;
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
    ...(header.parentSession ? { parentID: toOpenCodeSessionId(header.parentSession) } : {}),
    agent: header.agent || "omp",
    model: header.model
      ? {
          id: header.model.modelID,
          providerID: header.model.providerID,
          modelID: header.model.modelID,
          variant: header.model.variant || "default",
        }
      : { id: "omp", providerID: "omp", modelID: "omp", variant: "default" },
    version: header.version || "0.0.0",
    time: {
      created,
      updated,
      ...(header.archived !== undefined ? { archived: header.archived } : {}),
    },
    cost: header.cost ?? 0,
    tokens: header.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
    deletePersistedMessageIds(openCodeId);
    deletePersistedMessageIds(fromOpenCodeSessionId(openCodeId));
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
    let dirents: { name: string; isFile(): boolean; isDirectory(): boolean }[];
    try {
      dirents = (await readdir(dirPath, { withFileTypes: true })) as unknown as {
        name: string;
        isFile(): boolean;
        isDirectory(): boolean;
      }[];
    } catch { continue; }

    for (const ent of dirents) {
      if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        const filePath = join(dirPath, ent.name);
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
      } else if (ent.isDirectory()) {
        const subDirPath = join(dirPath, ent.name);
        const parentUuidMatch = ent.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        const parentOmpUuid = parentUuidMatch ? parentUuidMatch[1] : undefined;

        let subFiles: string[];
        try {
          subFiles = await readdir(subDirPath);
        } catch {
          continue;
        }

        for (const subFile of subFiles) {
          if (!subFile.endsWith(".jsonl")) continue;
          const subFilePath = join(subDirPath, subFile);
          const subHeader = await readSessionHeader(subFilePath);
          if (!subHeader) continue;
          if (!subHeader.parentSession && parentOmpUuid) {
            subHeader.parentSession = parentOmpUuid;
          }
          if (!subHeader.title) {
            subHeader.title = subFile.slice(0, -6);
          }
          if (!all && subHeader.cwd !== directory) continue;
          if (archived !== true && !!subHeader.archived) continue;

          if (searchLower) {
            const titleMatch = subHeader.title?.toLowerCase().includes(searchLower);
            const promptMatch = subHeader.firstUserPrompt?.toLowerCase().includes(searchLower);
            const idMatch = subHeader.id.toLowerCase().includes(searchLower);
            const cwdMatch = subHeader.cwd.toLowerCase().includes(searchLower);
            const ftsMatch = matchingOmpIds?.has(subHeader.id);
            if (!titleMatch && !promptMatch && !idMatch && !cwdMatch && !ftsMatch) {
              continue;
            }
          }

          sessions.push(await buildOpenCodeSession(subHeader, subFilePath));
          if (limit !== undefined && sessions.length >= limit) break;
        }
      }
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
    let dirents: { name: string; isFile(): boolean; isDirectory(): boolean }[];
    try {
      dirents = (await readdir(dirPath, { withFileTypes: true })) as unknown as {
        name: string;
        isFile(): boolean;
        isDirectory(): boolean;
      }[];
    } catch { continue; }

    for (const ent of dirents) {
      if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        const filePath = join(dirPath, ent.name);
        const header = await readSessionHeader(filePath);
        if (!header) continue;
        if (header.id === ompId || toOpenCodeSessionId(header.id) === openCodeId) {
          if (directory && header.cwd !== directory) continue;
          return buildOpenCodeSession(header, filePath);
        }
      } else if (ent.isDirectory()) {
        const subDirPath = join(dirPath, ent.name);
        const parentUuidMatch = ent.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        const parentOmpUuid = parentUuidMatch ? parentUuidMatch[1] : undefined;

        let subFiles: string[];
        try {
          subFiles = await readdir(subDirPath);
        } catch {
          continue;
        }

        for (const subFile of subFiles) {
          if (!subFile.endsWith(".jsonl")) continue;
          const subFilePath = join(subDirPath, subFile);
          const subHeader = await readSessionHeader(subFilePath);
          if (!subHeader) continue;
          if (subHeader.id === ompId || toOpenCodeSessionId(subHeader.id) === openCodeId) {
            if (!subHeader.parentSession && parentOmpUuid) {
              subHeader.parentSession = parentOmpUuid;
            }
            if (!subHeader.title) {
              subHeader.title = subFile.slice(0, -6);
            }
            if (directory && subHeader.cwd !== directory) continue;
            return buildOpenCodeSession(subHeader, subFilePath);
          }
        }
      }
    }
  }

  return null;
}

export async function listOmpChildSessions(
  parentOpenCodeId: string,
  directory?: string | null,
): Promise<OpenCodeSession[]> {
  const allSessions = await listOmpSessions(directory, { all: !directory });
  return allSessions.filter((s) => s.parentID === parentOpenCodeId);
}
