import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openTitleIndex,
  closeTitleIndex,
  recordIndexedTitle,
  lookupIndexedTitle,
  deleteIndexedTitle,
  listIndexedTitles,
  searchHistoryPrompts,
  searchMatchingSessionIds,
} from "./title-db";
import {
  createOmpSession,
  deleteOmpSession,
  setOmpSessionTitle,
  readSessionHeader,
  fromOpenCodeSessionId,
} from "./sessions";

const TEST_DIR = mkdtempSync(join(tmpdir(), "oc-title-db-test-"));
const TEST_DB = join(TEST_DIR, "history.db");

describe("title-db (OMP v18 history.db session_titles)", () => {
  beforeAll(() => {
    closeTitleIndex();
  });

  afterAll(() => {
    closeTitleIndex();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("records and looks up session titles in SQLite", () => {
    recordIndexedTitle("sess-uuid-1", "First Session Title", TEST_DB);
    expect(lookupIndexedTitle("sess-uuid-1", TEST_DB)).toBe("First Session Title");

    // Upsert replaces title
    recordIndexedTitle("sess-uuid-1", "Renamed Session Title", TEST_DB);
    expect(lookupIndexedTitle("sess-uuid-1", TEST_DB)).toBe("Renamed Session Title");
  });

  test("lists all indexed titles", () => {
    recordIndexedTitle("sess-uuid-2", "Second Session", TEST_DB);
    recordIndexedTitle("sess-uuid-3", "Third Session", TEST_DB);

    const all = listIndexedTitles(TEST_DB);
    expect(all.get("sess-uuid-1")).toBe("Renamed Session Title");
    expect(all.get("sess-uuid-2")).toBe("Second Session");
    expect(all.get("sess-uuid-3")).toBe("Third Session");
  });

  test("deletes indexed titles", () => {
    deleteIndexedTitle("sess-uuid-2", TEST_DB);
    expect(lookupIndexedTitle("sess-uuid-2", TEST_DB)).toBeUndefined();
    expect(listIndexedTitles(TEST_DB).has("sess-uuid-2")).toBe(false);
  });

  test("lookup on non-existent session returns undefined", () => {
    expect(lookupIndexedTitle("non-existent-session-id", TEST_DB)).toBeUndefined();
  });

  test("sessions.ts integration writes and deletes indexed titles in history.db", async () => {
    const origHome = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "oc-sess-home-"));
    process.env.HOME = fakeHome;
    Bun.env.HOME = fakeHome;
    closeTitleIndex();

    try {
      const created = await createOmpSession("/some/dir", { title: "Indexed Integration Title" });
      const ompId = fromOpenCodeSessionId(created.id);

      // Verify it was indexed
      expect(lookupIndexedTitle(ompId)).toBe("Indexed Integration Title");

      // Verify readSessionHeader uses indexed title even if JSONL lacks explicit title_change
      const header = await readSessionHeader(created.path);
      expect(header?.title).toBe("Indexed Integration Title");

      // Rename session
      await setOmpSessionTitle(created.id, "Updated Indexed Title", "user", "/some/dir");
      expect(lookupIndexedTitle(ompId)).toBe("Updated Indexed Title");

      // Delete session
      await deleteOmpSession(created.id, "/some/dir");
      expect(lookupIndexedTitle(ompId)).toBeUndefined();
    } finally {
      process.env.HOME = origHome;
      Bun.env.HOME = origHome;
      closeTitleIndex();
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("searchHistoryPrompts and searchMatchingSessionIds query titles and FTS", () => {
    const handle = openTitleIndex(TEST_DB);
    expect(handle).toBeDefined();

    // Create history and history_fts table for test
    handle!.db.run(`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt TEXT UNIQUE,
        created_at INTEGER,
        cwd TEXT,
        session_id TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(prompt, content='history', content_rowid='id');
      INSERT INTO history (prompt, created_at, cwd, session_id) VALUES
        ('Refactor authentication provider', 1787600000, '/proj/a', 'sess-uuid-auth'),
        ('Fix memory leak in websocket server', 1787600100, '/proj/b', 'sess-uuid-leak');
      INSERT INTO history_fts(rowid, prompt) VALUES
        (1, 'Refactor authentication provider'),
        (2, 'Fix memory leak in websocket server');
    `);

    // Search by prompt text
    const res = searchHistoryPrompts("authentication", 10, TEST_DB);
    expect(res.length).toBe(1);
    expect(res[0].sessionId).toBe("sess-uuid-auth");

    // Search matching session ids (by prompt and by title)
    recordIndexedTitle("sess-uuid-title-match", "Special Authentication Flow", TEST_DB);

    const ids = searchMatchingSessionIds("authentication", 10, TEST_DB);
    expect(ids.has("sess-uuid-auth")).toBe(true);
    expect(ids.has("sess-uuid-title-match")).toBe(true);
  });
});
