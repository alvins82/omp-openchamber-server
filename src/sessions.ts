import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const OMP_SESSIONS_ROOT = join(Bun.env.HOME!, ".omp", "agent", "sessions");
const HOME_PREFIX = Bun.env.HOME! + "/";

interface ModelRef {
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
  time: { created: number; updated: number };
  cost: number;
  tokens: { input: number; output: number };
}

interface SessionHeader {
  id: string;
  cwd: string;
  title?: string;
  timestamp: string;
  version?: string;
}

export function encodeCwd(cwd: string): string {
  let encoded = cwd;
  if (encoded.startsWith(HOME_PREFIX)) {
    encoded = "/" + encoded.slice(HOME_PREFIX.length);
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
    const maxLines = Math.min(lines.length, 200);
    let header: SessionHeader | null = null;
    let latestTitle: string | undefined;

    for (let i = 0; i < maxLines; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session" && typeof entry.id === "string" && typeof entry.cwd === "string") {
          header = {
            id: entry.id,
            cwd: entry.cwd,
            title: typeof entry.title === "string" ? entry.title : undefined,
            timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
            version:
              typeof entry.version === "string"
                ? entry.version
                : typeof entry.version === "number"
                  ? String(entry.version)
                  : undefined,
          };
        } else if (
          (entry.type === "title" || entry.type === "title_change") &&
          typeof entry.title === "string"
        ) {
          latestTitle = entry.title;
        }
      } catch { /* skip malformed JSON */ }
    }

    if (!header) return null;
    if (latestTitle !== undefined) header.title = latestTitle;
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

  return {
    id: openCodeId,
    slug: openCodeId,
    projectID: "",
    directory: header.cwd,
    path: filePath,
    title: header.title || `Session ${first8}`,
    agent: "omp",
    model: { providerID: "omp", modelID: "omp", variant: "default" },
    version: header.version || "0.0.0",
    time: { created, updated },
    cost: 0,
    tokens: { input: 0, output: 0 },
  };
}

export async function listOmpSessions(
  directory?: string | null,
  options?: { all?: boolean; limit?: number },
): Promise<OpenCodeSession[]> {
  const all = options?.all ?? false;
  const limit = options?.limit;
  const sessions: OpenCodeSession[] = [];

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = (await readdir(OMP_SESSIONS_ROOT, { withFileTypes: true })) as unknown as {
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
    const dirPath = join(OMP_SESSIONS_ROOT, dir.name);
    let files: string[];
    try { files = await readdir(dirPath); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, file);
      const header = await readSessionHeader(filePath);
      if (!header) continue;
      if (!all && header.cwd !== directory) continue;

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
    entries = (await readdir(OMP_SESSIONS_ROOT, { withFileTypes: true })) as unknown as {
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
    const dirPath = join(OMP_SESSIONS_ROOT, dir.name);
    let files: string[];
    try { files = await readdir(dirPath); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, file);
      const header = await readSessionHeader(filePath);
      if (!header) continue;
      if (header.id !== ompId) continue;
      if (directory && header.cwd !== directory) continue;
      return buildOpenCodeSession(header, filePath);
    }
  }

  return null;
}
