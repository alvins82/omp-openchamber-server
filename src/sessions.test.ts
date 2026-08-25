import { expect, test, it, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  toOpenCodeSessionId,
  fromOpenCodeSessionId,
  encodeCwd,
  readSessionHeader,
  listOmpSessions,
  getOmpSessionByOpenCodeId,
  createOmpSession,
  deleteOmpSession,
  updateOmpSession,
} from "./sessions";

const UUID_A = "123e4567-e89b-12d3-a456-426614174000";
const UUID_B = "00000000-1111-2222-3333-444455556666";
const HEXA = "123e4567e89b12d3a456426614174000";
const HEXB = "00000000111122223333444455556666";
const DIR_A = "/Users/alvin/proj";
const DIR_B = "/elsewhere";
const REAL_HOME = process.env.HOME ?? "";
const FAKE_HOME = mkdtempSync(join(tmpdir(), "oc-sess-"));
const SROOT = join(FAKE_HOME, ".omp", "agent", "sessions");

const lineA = [
  JSON.stringify({ type: "session", id: UUID_A, cwd: DIR_A, timestamp: "2026-08-22T00:00:00Z", version: "0.81" }),
  JSON.stringify({ type: "title_change", title: "Alpha" }),
  JSON.stringify({ type: "message", message: { role: "assistant", content: "hello" } }),
].join("\n") + "\n";

const lineB =
  JSON.stringify({ type: "session", id: UUID_B, cwd: DIR_B, timestamp: 1787355600000, version: 2 }) + "\n";

const badBody =
  JSON.stringify({ type: "message", message: { role: "user", content: "orphan" } }) + "\n";

beforeAll(() => {
  process.env.HOME = FAKE_HOME;
  Bun.env.HOME = FAKE_HOME;
  mkdirSync(join(SROOT, "-Users-alvin-proj"), { recursive: true });
  mkdirSync(join(SROOT, "-elsewhere"), { recursive: true });
  writeFileSync(join(SROOT, "-Users-alvin-proj", "a.jsonl"), lineA);
  writeFileSync(join(SROOT, "-Users-alvin-proj", "bad.jsonl"), badBody);
  writeFileSync(join(SROOT, "-Users-alvin-proj", "ignore.txt"), "not jsonl\n");
  writeFileSync(join(SROOT, "-elsewhere", "b.jsonl"), lineB);
});

afterAll(() => {
  process.env.HOME = REAL_HOME;
  Bun.env.HOME = REAL_HOME;
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("session id mapping (Tier A3, pure)", () => {
  test("toOpenCodeSessionId compacts a UUID into ses_<32hex>", () => {
    expect(toOpenCodeSessionId(UUID_A)).toBe("ses_" + HEXA);
    expect(toOpenCodeSessionId(UUID_B)).toBe("ses_" + HEXB);
  });

  it("toOpenCodeSessionId passes ses_ ids through and lowercases others", () => {
    expect(toOpenCodeSessionId("ses_" + HEXA)).toBe("ses_" + HEXA);
    expect(toOpenCodeSessionId("ABCDEF")).toBe("ses_abcdef");
  });

  it("fromOpenCodeSessionId restores dashed UUIDs", () => {
    expect(fromOpenCodeSessionId("ses_" + HEXA)).toBe(UUID_A);
    expect(fromOpenCodeSessionId("ses_" + HEXB)).toBe(UUID_B);
  });

  it("fromOpenCodeSessionId passes through non-32-hex and non-ses ids", () => {
    expect(fromOpenCodeSessionId("ses_" + "a".repeat(31))).toBe("ses_" + "a".repeat(31));
    expect(fromOpenCodeSessionId("ses_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe("ses_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(fromOpenCodeSessionId("plain-id")).toBe("plain-id");
  });

  it("round-trips ids in both directions", () => {
    expect(fromOpenCodeSessionId(toOpenCodeSessionId(UUID_A))).toBe(UUID_A);
    expect(toOpenCodeSessionId(fromOpenCodeSessionId("ses_" + HEXA))).toBe("ses_" + HEXA);
  });

  it("encodeCwd encodes slashes to dashes and home-relative paths to root-relative", () => {
    expect(encodeCwd(DIR_A)).toBe("-Users-alvin-proj");
    expect(encodeCwd(join(FAKE_HOME, "proj"))).toBe("-proj");
  });
});

describe("readSessionHeader (Tier A3, fake HOME)", () => {
  it("parses the header line and later title changes win", async () => {
    const h = await readSessionHeader(join(SROOT, "-Users-alvin-proj", "a.jsonl"));
    expect(h).not.toBeNull();
    expect(h?.id).toBe(UUID_A);
    expect(h?.cwd).toBe(DIR_A);
    expect(h?.timestamp).toBe("2026-08-22T00:00:00Z");
    expect(h?.version).toBe("0.81");
    expect(h?.title).toBe("Alpha");
  });

  it("coerces numeric versions and leaves title undefined when no title change", async () => {
    const h = await readSessionHeader(join(SROOT, "-elsewhere", "b.jsonl"));
    expect(h?.id).toBe(UUID_B);
    expect(h?.version).toBe("2");
    expect(h?.title).toBeUndefined();
  });

  it("returns null for files without a session line and for missing files", async () => {
    expect(await readSessionHeader(join(SROOT, "-Users-alvin-proj", "bad.jsonl"))).toBeNull();
    expect(await readSessionHeader(join(SROOT, "nope.jsonl"))).toBeNull();
  });

  it("returns null for a session line beyond the 200-line scan window", async () => {
    const junkLine = JSON.stringify({ type: "message", message: { role: "user", parts: [] } });
    const body = Array.from({ length: 200 }, () => junkLine).join("\n") + "\n";
    const withSession = body + JSON.stringify({ type: "session", id: UUID_A, cwd: DIR_A, timestamp: "2026-08-22T00:00:00Z" }) + "\n";
    const f = join(SROOT, "-Users-alvin-proj", "late.jsonl");
    writeFileSync(f, withSession);
    try {
      expect(await readSessionHeader(f)).toBeNull();
    } finally {
      rmSync(f, { force: true });
    }
  });
});

describe("listOmpSessions (Tier A3, fake HOME)", () => {
  it("returns nothing without a directory or the all flag", async () => {
    expect(await listOmpSessions()).toEqual([]);
    expect(await listOmpSessions(null)).toEqual([]);
  });

  it("filters by the requested directory and maps fields", async () => {
    const all = await listOmpSessions(DIR_A);
    expect(all).toHaveLength(1);
    const s = all[0];
    expect(s.id).toBe("ses_" + HEXA);
    expect(s.slug).toBe(s.id);
    expect(s.directory).toBe(DIR_A);
    expect(s.path).toBe(join(SROOT, "-Users-alvin-proj", "a.jsonl"));
    expect(s.projectID).toBe("global");
    expect(s.model).toEqual({ id: "omp", providerID: "omp", modelID: "omp", variant: "default" });
    expect(s.title).toBe("Alpha");
    expect(s.version).toBe("0.81");
    expect(s.time.created).toBe(Date.parse("2026-08-22T00:00:00Z"));
    expect(s.cost).toBe(0);
    expect(s.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  });

  it("with all lists every project and skips headerless and non-jsonl files", async () => {
    const all = await listOmpSessions(null, { all: true });
    expect(all).toHaveLength(2);
    const ids = all.map((s) => s.id).sort();
    expect(ids).toEqual(["ses_" + HEXA, "ses_" + HEXB].sort());
    expect(all.some((s) => s.path.includes("bad.jsonl"))).toBe(false);
    expect(all.some((s) => s.path.endsWith(".txt"))).toBe(false);
  });

  it("honors the limit option", async () => {
    expect(await listOmpSessions(null, { all: true, limit: 1 })).toHaveLength(1);
    expect(await listOmpSessions(null, { all: true, limit: 2 })).toHaveLength(2);
    expect(await listOmpSessions(null, { all: true, limit: 99 })).toHaveLength(2);
  });

  it("filters sessions by archived option", async () => {
    await updateOmpSession("ses_" + HEXA, { time: { archived: Date.now() } });
    try {
      const active = await listOmpSessions(null, { all: true, archived: false });
      expect(active.map((s) => s.id)).toEqual(["ses_" + HEXB]);

      // archived: true in OpenCode protocol is inclusive of all sessions
      const allInclusive = await listOmpSessions(null, { all: true, archived: true });
      expect(allInclusive.map((s) => s.id).sort()).toEqual(["ses_" + HEXA, "ses_" + HEXB].sort());
    } finally {
      await updateOmpSession("ses_" + HEXA, { time: { archived: 0 } });
    }
  });

  it("filters sessions by search query (title / prompt / id / cwd)", async () => {
    const matchedAlpha = await listOmpSessions(null, { all: true, search: "Alpha" });
    expect(matchedAlpha.map((s) => s.id)).toEqual(["ses_" + HEXA]);

    const matchedCwd = await listOmpSessions(null, { all: true, search: "elsewhere" });
    expect(matchedCwd.map((s) => s.id)).toEqual(["ses_" + HEXB]);

    const nonMatch = await listOmpSessions(null, { all: true, search: "nonexistentquery123" });
    expect(nonMatch).toHaveLength(0);
  });
});

describe("getOmpSessionByOpenCodeId (Tier A3, fake HOME)", () => {
  it("resolves a mapped openCode id to its session", async () => {
    const s = await getOmpSessionByOpenCodeId("ses_" + HEXA);
    expect(s).not.toBeNull();
    expect(s?.directory).toBe(DIR_A);
    expect(s?.id).toBe("ses_" + HEXA);
  });

  it("resolves the second session without a directory filter", async () => {
    const s = await getOmpSessionByOpenCodeId("ses_" + HEXB);
    expect(s?.directory).toBe(DIR_B);
    expect(s?.version).toBe("2");
  });

  it("returns null for an unknown id", async () => {
    const unknown = "ses_" + "f".repeat(32);
    expect(await getOmpSessionByOpenCodeId(unknown)).toBeNull();
  });

  it("returns null when the directory filter does not match the session cwd", async () => {
    expect(await getOmpSessionByOpenCodeId("ses_" + HEXA, DIR_B)).toBeNull();
    const ok = await getOmpSessionByOpenCodeId("ses_" + HEXA, DIR_A);
    expect(ok?.id).toBe("ses_" + HEXA);
  });
});

describe("create, update, and delete OMP sessions", () => {
  it("creates a session file and reads it back", async () => {
    const created = await createOmpSession(DIR_A, { title: "Custom Title" });
    expect(created.id.startsWith("ses_")).toBe(true);
    expect(created.directory).toBe(DIR_A);
    expect(created.title).toBe("Custom Title");

    const found = await getOmpSessionByOpenCodeId(created.id, DIR_A);
    expect(found).not.toBeNull();
    expect(found?.title).toBe("Custom Title");

    // Update session title via setOmpSessionTitle
    const updated = await updateOmpSession(created.id, { title: "Updated Title" }, DIR_A);
    expect(updated?.title).toBe("Updated Title");

    const foundUpdated = await getOmpSessionByOpenCodeId(created.id, DIR_A);
    expect(foundUpdated?.title).toBe("Updated Title");

    // Delete session
    const deleted = await deleteOmpSession(created.id, DIR_A);
    expect(deleted).toBe(true);

    const foundAfterDelete = await getOmpSessionByOpenCodeId(created.id, DIR_A);
    expect(foundAfterDelete).toBeNull();
  });

  it("falls back to first user prompt when no explicit title is set", async () => {
    const sessionFile = join(SROOT, "-Users-alvin-proj", "fallback-prompt.jsonl");
    const content = [
      JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-08-25T00:00:00.000Z", pad: " ".repeat(180) }),
      JSON.stringify({ type: "session", id: "55555555-4444-3333-2222-11110000aaaa", cwd: DIR_A, timestamp: "2026-08-25T00:00:00.000Z", version: 3 }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Inspect authentication flows in sidecar" } }),
    ].join("\n") + "\n";

    writeFileSync(sessionFile, content);
    try {
      const header = await readSessionHeader(sessionFile);
      expect(header).not.toBeNull();
      expect(header?.firstUserPrompt).toBe("Inspect authentication flows in sidecar");

      const session = await getOmpSessionByOpenCodeId("ses_5555555544443333222211110000aaaa", DIR_A);
      expect(session?.title).toBe("Inspect authentication flows in sidecar");
    } finally {
      rmSync(sessionFile, { force: true });
    }
  });

  it("preserves and updates session metadata", async () => {
    const created = await createOmpSession(DIR_A, { title: "Goal Test Session" });
    const goalMetadata = {
      openchamber: {
        goal: {
          id: "g1",
          objective: "Implement goal support",
          status: "in_progress",
          tokenBudget: 50000,
        },
      },
    };

    const updated = await updateOmpSession(created.id, { metadata: goalMetadata }, DIR_A);
    expect(updated?.metadata).toEqual(goalMetadata);

    const fetched = await getOmpSessionByOpenCodeId(created.id, DIR_A);
    expect(fetched?.metadata).toEqual(goalMetadata);

    await deleteOmpSession(created.id, DIR_A);
  });

  it("archives and unarchives a session with time.archived", async () => {
    const created = await createOmpSession(DIR_A, { title: "Archive Test Session" });
    expect(created.time.archived).toBeUndefined();

    const archiveTime = 1787612345;
    const archived = await updateOmpSession(created.id, { time: { archived: archiveTime } }, DIR_A);
    expect(archived?.time.archived).toBe(archiveTime);

    const fetchedArchived = await getOmpSessionByOpenCodeId(created.id, DIR_A);
    expect(fetchedArchived?.time.archived).toBe(archiveTime);

    // Unarchive
    const unarchived = await updateOmpSession(created.id, { time: { archived: 0 } }, DIR_A);
    expect(unarchived?.time.archived).toBe(0);

    const fetchedUnarchived = await getOmpSessionByOpenCodeId(created.id, DIR_A);
    expect(fetchedUnarchived?.time.archived).toBe(0);

    await deleteOmpSession(created.id, DIR_A);
  });
});





