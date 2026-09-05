import { beforeEach, describe, expect, test } from "bun:test";
import {
  fakeBackend,
  fakeModel,
  resetFakeBackend,
  setFakeTurnScript,
} from "./backend";
import type { NormalizedTurnEvent } from "../types";

const DIR = "/tmp/fake-unit";

describe("fake backend store", () => {
  beforeEach(() => resetFakeBackend());

  test("create/get round-trips a ses_fake_ session", async () => {
    const session = await fakeBackend.store.create(DIR, { title: "hello" });
    expect(session.id).toMatch(/^ses_fake_[0-9a-f-]{36}$/);
    expect(session.slug).toStartWith("fake-");
    expect(session.projectID).toBe("fake");
    expect(session.directory).toBe(DIR);
    expect(session.title).toBe("hello");
    expect(session.agent).toBe("omp");
    expect(session.model).toEqual({
      id: "fake/fake",
      providerID: "fake",
      modelID: "fake",
      variant: "default",
    });
    expect(session.version).toBe("1.0.0-fake");
    expect(session.cost).toBe(0);
    expect(session.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

    const fetched = await fakeBackend.store.get(session.id);
    expect(fetched?.id).toBe(session.id);
    expect(await fakeBackend.store.get("ses_fake_unknown")).toBeNull();
  });

  test("list filters by directory, archived, search, limit", async () => {
    const a = await fakeBackend.store.create("/tmp/a", { title: "Alpha" });
    const b = await fakeBackend.store.create("/tmp/b", { title: "Beta" });
    await fakeBackend.store.create("/tmp/a", { title: "Archived alpha" });
    const archived = (await fakeBackend.store.list("/tmp/a"))[1]!;
    await fakeBackend.store.update(archived.id, { time: { archived: 123 } });

    expect((await fakeBackend.store.list("/tmp/a")).map((s) => s.id)).toEqual([a.id]);
    expect((await fakeBackend.store.list("/tmp/b")).map((s) => s.id)).toEqual([b.id]);
    expect((await fakeBackend.store.list("/tmp/a", { all: true })).length).toBe(2);
    expect((await fakeBackend.store.list("/tmp/a", { archived: true })).length).toBe(2);
    expect((await fakeBackend.store.list("/tmp/a", { all: true, archived: true })).length).toBe(3);
    expect((await fakeBackend.store.list(undefined, { all: true, search: "beta" })).map((s) => s.id)).toEqual([b.id]);
    expect((await fakeBackend.store.list(undefined, { all: true, limit: 1 })).length).toBe(1);
  });

  test("update merges title/metadata and toggles archived", async () => {
    const session = await fakeBackend.store.create(DIR);
    const updated = await fakeBackend.store.update(session.id, {
      metadata: { a: 1 },
      time: { archived: 456 },
    });
    expect(updated?.metadata).toEqual({ a: 1 });
    expect(updated?.time.archived).toBe(456);

    const unarchived = await fakeBackend.store.update(session.id, {
      metadata: { b: 2 },
      time: { archived: null },
    });
    expect(unarchived?.metadata).toEqual({ a: 1, b: 2 });
    expect(unarchived?.time.archived).toBeUndefined();
    expect(await fakeBackend.store.update("ses_fake_unknown", { title: "x" })).toBeNull();
  });

  test("setTitle updates title and children filter by parentID", async () => {
    const parent = await fakeBackend.store.create(DIR);
    const child = await fakeBackend.store.create(DIR, { parentID: parent.id });
    await fakeBackend.store.create(DIR);
    await fakeBackend.store.setTitle(parent.id, "renamed", "user", DIR);

    expect((await fakeBackend.store.get(parent.id))?.title).toBe("renamed");
    expect((await fakeBackend.store.children(parent.id)).map((s) => s.id)).toEqual([child.id]);
  });

  test("transcript returns null for unknown, [] for fresh, records user messages", async () => {
    const session = await fakeBackend.store.create(DIR);
    expect(await fakeBackend.store.transcript("ses_fake_unknown", DIR)).toBeNull();
    expect(await fakeBackend.store.transcript(session.id, DIR)).toEqual([]);

    fakeBackend.store.recordUserMessage?.(session.id, "hi", "msg_1");
    const transcript = await fakeBackend.store.transcript(session.id, DIR);
    expect(transcript?.length).toBe(1);
    expect(transcript?.[0]?.info).toMatchObject({ id: "msg_1", role: "user", sessionID: session.id });
    expect(transcript?.[0]?.parts[0]).toMatchObject({ type: "text", text: "hi" });
  });

  test("delete removes the session", async () => {
    const session = await fakeBackend.store.create(DIR);
    expect(await fakeBackend.store.delete(session.id)).toBe(true);
    expect(await fakeBackend.store.delete(session.id)).toBe(false);
    expect(await fakeBackend.store.get(session.id)).toBeNull();
  });
});

describe("fake backend turn connection", () => {
  beforeEach(() => resetFakeBackend());

  test("prompt replays scripted events in order ending with turn_end", async () => {
    const session = await fakeBackend.store.create(DIR);
    const conn = await fakeBackend.createTurnConnection(DIR, session.path, session.id);
    const events: NormalizedTurnEvent[] = [];
    const unsubscribe = conn.onEvent((event) => events.push(event));

    await conn.prompt({ message: "hello world" });

    expect(events.map((event) => event.kind)).toEqual(["text_delta", "usage", "model", "turn_end"]);
    expect(events[0]).toEqual({ kind: "text_delta", text: "fake: hello world" });
    expect(events[1]).toMatchObject({ kind: "usage", cost: 0 });
    expect(events[2]).toEqual({ kind: "model", model: fakeModel });
    expect(events[3]).toMatchObject({ kind: "turn_end" });

    // The turn is persisted into the transcript.
    const transcript = await fakeBackend.store.transcript(session.id, DIR);
    expect(transcript?.at(-1)?.parts[0]).toMatchObject({ type: "text", text: "fake: hello world" });

    unsubscribe();
    events.length = 0;
    await conn.prompt({ message: "second" });
    expect(events).toEqual([]);
  });

  test("setFakeTurnScript drives arbitrary event sequences", async () => {
    const session = await fakeBackend.store.create(DIR);
    const conn = await fakeBackend.createTurnConnection(DIR, session.path, session.id);
    const events: NormalizedTurnEvent[] = [];
    conn.onEvent((event) => events.push(event));

    setFakeTurnScript(() => [
      { kind: "reasoning_delta", text: "thinking" },
      { kind: "text_delta", text: "done" },
      { kind: "turn_end", stopReason: "end_turn" },
    ]);
    await conn.prompt({ message: "go" });

    expect(events.map((event) => event.kind)).toEqual(["reasoning_delta", "text_delta", "turn_end"]);
    expect(events[2]).toEqual({ kind: "turn_end", stopReason: "end_turn" });
  });

  test("setModel / getInitialModel / abort", async () => {
    const session = await fakeBackend.store.create(DIR);
    const conn = await fakeBackend.createTurnConnection(DIR, session.path, session.id);
    expect(await conn.getInitialModel?.()).toEqual(fakeModel);
    await conn.setModel("other", "m1");
    expect(await conn.getInitialModel?.()).toEqual({ ...fakeModel, providerID: "other", modelID: "m1" });
    expect(await conn.abort()).toEqual({ aborted: true });
  });

  test("resetFakeBackend clears sessions, script, and counters", async () => {
    await fakeBackend.store.create(DIR, { title: "doomed" });
    setFakeTurnScript(() => [{ kind: "turn_end" }]);
    resetFakeBackend();

    expect(await fakeBackend.store.list(DIR)).toEqual([]);
    const session = await fakeBackend.store.create(DIR);
    const conn = await fakeBackend.createTurnConnection(DIR, session.path, session.id);
    const events: NormalizedTurnEvent[] = [];
    conn.onEvent((event) => events.push(event));
    await conn.prompt({ message: "again" });
    expect(events.map((event) => event.kind)).toEqual(["text_delta", "usage", "model", "turn_end"]);
  });
});
