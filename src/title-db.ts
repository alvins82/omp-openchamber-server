import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

const TITLE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS session_titles (
	session_id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
`;

interface TitleIndexHandle {
  dbPath: string;
  db: Database;
  upsert: Statement;
  select: Statement;
  deleteStmt: Statement;
  selectAll: Statement;
}

let handle: TitleIndexHandle | undefined;
let failedPath: string | undefined;

export function getDefaultHistoryDbPath(): string {
  const home = Bun.env.HOME || process.env.HOME || "";
  return path.join(home, ".omp", "agent", "history.db");
}

export function closeTitleIndex(): void {
  if (!handle) return;
  try {
    handle.upsert.finalize();
    handle.select.finalize();
    handle.deleteStmt.finalize();
    handle.selectAll.finalize();
    handle.db.close();
  } catch {
    /* ignore close errors */
  }
  handle = undefined;
  failedPath = undefined;
}

export function openTitleIndex(overrideDbPath?: string): TitleIndexHandle | undefined {
  const dbPath = overrideDbPath || getDefaultHistoryDbPath();
  if (handle?.dbPath === dbPath) return handle;
  if (failedPath === dbPath && !overrideDbPath) return undefined;

  closeTitleIndex();
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.run("PRAGMA busy_timeout = 1000");
    db.run("PRAGMA journal_mode = WAL;\nPRAGMA synchronous = NORMAL;");
    db.run(TITLE_TABLE_DDL);

    handle = {
      dbPath,
      db,
      upsert: db.prepare(`
        INSERT INTO session_titles (session_id, title, updated_at)
        VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER))
        ON CONFLICT(session_id) DO UPDATE SET
          title = excluded.title,
          updated_at = excluded.updated_at
      `),
      select: db.prepare("SELECT title FROM session_titles WHERE session_id = ?"),
      deleteStmt: db.prepare("DELETE FROM session_titles WHERE session_id = ?"),
      selectAll: db.prepare("SELECT session_id, title FROM session_titles"),
    };
    failedPath = undefined;
    return handle;
  } catch (error) {
    failedPath = dbPath;
    return undefined;
  }
}

/**
 * Record or replace the indexed title for an OMP session ID.
 * Best-effort: errors are swallowed.
 */
export function recordIndexedTitle(sessionId: string, title: string, dbPath?: string): void {
  if (!sessionId || !title.trim()) return;
  const index = openTitleIndex(dbPath);
  if (!index) return;
  try {
    index.upsert.run(sessionId, title.trim());
  } catch {
    /* best-effort */
  }
}

/**
 * Look up the indexed title for an OMP session ID.
 */
export function lookupIndexedTitle(sessionId: string, dbPath?: string): string | undefined {
  if (!sessionId) return undefined;
  const index = openTitleIndex(dbPath);
  if (!index) return undefined;
  try {
    const row = index.select.get(sessionId) as { title: string } | null;
    return row?.title?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Delete the indexed title entry for a session ID.
 */
export function deleteIndexedTitle(sessionId: string, dbPath?: string): void {
  if (!sessionId) return;
  const index = openTitleIndex(dbPath);
  if (!index) return;
  try {
    index.deleteStmt.run(sessionId);
  } catch {
    /* best-effort */
  }
}

/**
 * Returns a map of all indexed session titles.
 */
export function listIndexedTitles(dbPath?: string): Map<string, string> {
  const map = new Map<string, string>();
  const index = openTitleIndex(dbPath);
  if (!index) return map;
  try {
    const rows = index.selectAll.all() as Array<{ session_id: string; title: string }>;
    for (const r of rows) {
      if (r.session_id && r.title) {
        map.set(r.session_id, r.title);
      }
    }
  } catch {
    /* best-effort */
  }
  return map;
}

export interface HistorySearchResult {
  sessionId?: string;
  prompt: string;
  createdAt: number;
  cwd?: string;
}

/**
 * Search prompt history using FTS5 match or LIKE fallback.
 */
export function searchHistoryPrompts(
  query: string,
  limit: number = 50,
  dbPath?: string,
): HistorySearchResult[] {
  if (!query || !query.trim()) return [];
  const index = openTitleIndex(dbPath);
  if (!index) return [];

  const clean = query.trim();
  try {
    const hasFts = index.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_fts'").get();
    if (hasFts) {
      const ftsQuery = clean
        .replace(/["*]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .map((tok) => `"${tok}"*`)
        .join(" ");

      if (ftsQuery) {
        const rows = index.db
          .prepare(
            `SELECT h.prompt, h.created_at, h.cwd, h.session_id
             FROM history_fts f
             JOIN history h ON h.id = f.rowid
             WHERE history_fts MATCH ?
             ORDER BY h.created_at DESC
             LIMIT ?`
          )
          .all(ftsQuery, limit) as Array<{ prompt: string; created_at: number; cwd?: string; session_id?: string }>;

        return rows.map((r) => ({
          prompt: r.prompt,
          createdAt: r.created_at,
          cwd: r.cwd,
          sessionId: r.session_id,
        }));
      }
    }

    const hasHistory = index.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history'").get();
    if (hasHistory) {
      const rows = index.db
        .prepare(
          `SELECT prompt, created_at, cwd, session_id
           FROM history
           WHERE prompt LIKE ?
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .all(`%${clean}%`, limit) as Array<{ prompt: string; created_at: number; cwd?: string; session_id?: string }>;

      return rows.map((r) => ({
        prompt: r.prompt,
        createdAt: r.created_at,
        cwd: r.cwd,
        sessionId: r.session_id,
      }));
    }
  } catch {
    /* best-effort */
  }
  return [];
}

/**
 * Return set of OMP session IDs matching query via title or prompt history.
 */
export function searchMatchingSessionIds(
  query: string,
  limit: number = 50,
  dbPath?: string,
): Set<string> {
  const result = new Set<string>();
  if (!query || !query.trim()) return result;
  const clean = query.trim().toLowerCase();

  const index = openTitleIndex(dbPath);
  if (index) {
    try {
      const titleRows = index.db
        .prepare("SELECT session_id FROM session_titles WHERE LOWER(title) LIKE ? LIMIT ?")
        .all(`%${clean}%`, limit) as Array<{ session_id: string }>;
      for (const r of titleRows) {
        if (r.session_id) result.add(r.session_id);
      }
    } catch {
      /* best-effort */
    }
  }

  const promptMatches = searchHistoryPrompts(query, limit, dbPath);
  for (const m of promptMatches) {
    if (m.sessionId) result.add(m.sessionId);
  }

  return result;
}
