import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const MAIN = join(ROOT, "src", "main.ts");
const MOCK_BUN = join(ROOT, "test", "mock-omp.mjs");
const PORT = Number(process.env.OC_INTEG_PORT ?? 4397);
const BASE = "http://127.0.0.1:" + PORT + "/";

const UUID_A = "123e4567-e89b-12d3-a456-426614174000";
const UUID_B = "00000000-1111-2222-3333-444455556666";
const SES_A = "ses_" + UUID_A.replace(/-/g, "");
const SES_B = "ses_" + UUID_B.replace(/-/g, "");
const DIR_A = "/Users/alvin/proj";
const DIR_B = "/elsewhere";

type MsgInfo = { role?: string; finish?: string; id?: string; sessionID?: string };

// Narrows a possibly-undefined value, asserting presence for the assertion that follows.
function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value!;
}

type SSEEvent = { type: string; properties: Record<string, unknown> };

const FAKE_HOME = mkdtempSync(join(tmpdir(), "oc-integ-"));
const SPAWN_LOG = join(FAKE_HOME, "spawn.log");
const FILE_A = join(FAKE_HOME, ".omp", "agent", "sessions", "-Users-alvin-proj", "a.jsonl");
const FILE_B = join(FAKE_HOME, ".omp", "agent", "sessions", "-elsewhere", "b.jsonl");

function spawnLogLines(): number {
  try {
    return readFileSync(SPAWN_LOG, "utf8").split("\n").filter(Boolean).length;
   } catch {
    return 0;
  }
}

function sessionLine(uuid: string, dir: string) {
  return JSON.stringify({ type: "session", id: uuid, cwd: dir, timestamp: "2026-08-22T00:00:00Z", version: "0.81" }) + "\n";
}

let sidecar: ReturnType<typeof Bun.spawn>;
let sidecarStdout = "";

async function waitForHealth(timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(BASE + "health");
      if (r.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error("sidecar did not become healthy in " + timeoutMs + "ms");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function parseSseChunk(buf: string): SSEEvent[] {
  const out: SSEEvent[] = [];
  const sep = buf.split("\n\n");
  if (sep.length < 2) return out;
  for (const frame of sep.slice(0, -1)) {
    let data = "";
    for (const l of frame.split("\n")) {
      if (l.startsWith("data:")) data += l.slice(5).trim();
    }
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      const payload = parsed.payload ?? parsed;
      if (payload && typeof payload.type === "string") {
        out.push({ type: payload.type, properties: payload.properties ?? {} });
      }
    } catch {
      // ignore
    }
  }
  return out;
}

/** Collect SSE frames until the predicate matches the last one, or timeout. */
async function collectSse(pred: (e: SSEEvent) => boolean, timeoutMs: number): Promise<SSEEvent[]> {
  const resp = await fetch(BASE + "events", { headers: { Accept: "text/event-stream" } });
  if (resp.status !== 200 || resp.body === null) throw new Error("events endpoint failed: " + resp.status);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: SSEEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (events.length > 0 && pred(events[events.length - 1])) break;
    if (Date.now() > deadline) break;
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    events.push(...parseSseChunk(buf));
    buf = buf.split(/\n\n/).pop() ?? "";
  }
  reader.cancel();
  return events;
}

function isIdle(e: SSEEvent): boolean {
  return e.type === "session.idle" && e.properties.sessionID === SES_A;
}

async function postPrompt(text: string) {
  return fetch(BASE + "session/" + SES_A + "/prompt_async", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }], model: { providerID: "sidevllm", modelID: "qwen" } }),
  });
}

beforeAll(async () => {
  mkdirSync(join(FAKE_HOME, ".omp", "agent", "sessions", "-Users-alvin-proj"), { recursive: true });
  mkdirSync(join(FAKE_HOME, ".omp", "agent", "sessions", "-elsewhere"), { recursive: true });
  writeFileSync(FILE_A, sessionLine(UUID_A, DIR_A));
  writeFileSync(FILE_B, sessionLine(UUID_B, DIR_B));

  sidecar = Bun.spawn(["bun", MAIN], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      OC_SIDECAR_PORT: String(PORT),
      OMP_BIN: MOCK_BUN,
      HOME: FAKE_HOME,
      MOCK_OMP_SPAWN_LOG: SPAWN_LOG,
    },
  });

  await waitForHealth(15000);
});

afterAll(async () => {
  try {
    sidecar.kill();
    await sidecar.exited;
  } catch {
    // already gone
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
});


describe("sidecar HTTP contract (Tier B, mock OMP)", () => {
  let spawnCount = 0;
  spawnCount = spawnLogLines();

  test("health and stub routes answer with the opencode contract shapes", async () => {
    const h = await (await fetch(BASE + "health")).json();
    expect(h).toMatchObject({ healthy: true, status: "ok" });
    expect(h.compatibility).toBeDefined();

    const version = await (await fetch(BASE + "api/version")).json();
    expect(version).toMatchObject({ status: "ok", openchamberVersion: "1.20.0" });
    expect(version.compatibility?.capabilities).toContain("api.runtime-url.v1");

    const authSession = await (await fetch(BASE + "auth/session")).json();
    expect(authSession).toEqual({ authenticated: true, scope: "local" });

    expect(await (await fetch(BASE + "config")).json()).toMatchObject({ model: "omp", agent: "omp" });
    const agents = await (await fetch(BASE + "agent")).json();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("omp");
    expect(agents[0].mode).toBe("primary");

    expect(await (await fetch(BASE + "mcp")).json()).toEqual({});
    expect(await (await fetch(BASE + "vcs")).json()).toEqual({ branch: "main", default_branch: "main" });
    expect(await (await fetch(BASE + "command")).json()).toBeArray();

    const pathInfo = await (await fetch(BASE + "path?directory=" + encodeURIComponent(DIR_A))).json();
    expect(pathInfo).toMatchObject({
      home: expect.any(String),
      state: DIR_A,
      config: DIR_A,
      worktree: DIR_A,
      directory: DIR_A,
    });

    const projectList = await (await fetch(BASE + "project?directory=" + encodeURIComponent(DIR_A))).json();
    expect(projectList).toBeArray();
    expect(projectList[0]).toMatchObject({ id: "global", worktree: DIR_A });

    const currentProject = await (await fetch(BASE + "project/current?directory=" + encodeURIComponent(DIR_A))).json();
    expect(currentProject).toMatchObject({ id: "global", worktree: DIR_A });
  });

  test("GET /session lists only the requested directory, and nothing without one", async () => {
    expect(await (await fetch(BASE + "session")).json()).toEqual([]);
    const a = await (await fetch(BASE + "session?directory=" + encodeURIComponent(DIR_A))).json();
    expect(a).toHaveLength(1);
    expect(a[0].id).toBe(SES_A);
    expect(a[0].directory).toBe(DIR_A);
    const b = await (await fetch(BASE + "session?directory=" + encodeURIComponent(DIR_B))).json();
    expect(b[0].id).toBe(SES_B);
  });

  test("GET /experimental/session?roots=true lists every project; limit bounds it", async () => {
    const all = await (await fetch(BASE + "experimental/session?roots=true")).json();
    expect(all).toHaveLength(2);
    expect(all.map((s: { id: string }) => s.id).sort()).toEqual([SES_A, SES_B].sort());
    const one = await (await fetch(BASE + "experimental/session?roots=true&limit=1")).json();
    expect(one).toHaveLength(1);
  });

  test("GET /session/:id resolves 200 for known ids and 404 for unknown", async () => {
    const ok = await fetch(BASE + "session/" + SES_A);
    expect(ok.status).toBe(200);
    expect((await ok.json()).directory).toBe(DIR_A);
    const miss = await fetch(BASE + "session/" + "ses_" + "f".repeat(32));
    expect(miss.status).toBe(404);
    expect((await miss.json()).error).toBe("session not found");
  });

  test("POST /session creates a persistent session (201) discoverable immediately", async () => {
    const r = await fetch(BASE + "session?directory=" + encodeURIComponent(DIR_A), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Brand New Session" }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(String(j.id).startsWith("ses_")).toBe(true);
    expect(j.directory).toBe(DIR_A);
    expect(j.title).toBe("Brand New Session");
    expect(j.projectID).toBe("global");
    expect(j.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

    // Verify it is immediately accessible via GET /session/:id
    const fetchCreated = await fetch(BASE + "session/" + j.id);
    expect(fetchCreated.status).toBe(200);
    const fetchedJson = await fetchCreated.json();
    expect(fetchedJson.id).toBe(j.id);
    expect(fetchedJson.title).toBe("Brand New Session");

    // Test PATCH /session/:id
    const patchRes = await fetch(BASE + "session/" + j.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed Session" }),
    });
    expect(patchRes.status).toBe(200);
    const patchedJson = await patchRes.json();
    expect(patchedJson.title).toBe("Renamed Session");

    // Test DELETE /session/:id
    const delRes = await fetch(BASE + "session/" + j.id, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toBe(true);

    // Verify it is now 404
    const fetchDeleted = await fetch(BASE + "session/" + j.id);
    expect(fetchDeleted.status).toBe(404);
  });

  test("GET /config/providers maps rpc models and caches the response", async () => {
    const before = spawnLogLines();
    const j = await (await fetch(BASE + "config/providers?directory=" + encodeURIComponent(DIR_A))).json();
    const arr: Array<{ id: string; models: Record<string, { limit?: { context?: number; output?: number } }> }> =
      Array.isArray(j) ? j : j.providers ?? [];
    const vllm = arr.find((p) => p.id === "sidevllm");
    const bed = arr.find((p) => p.id === "bedrock");
    expect(vllm).toBeDefined();
    expect(vllm?.models.qwen.limit).toEqual({ context: 32768, output: 4096 });
    expect(bed?.models["claude-sonnet-4-6"]).toBeDefined();
    expect(spawnLogLines()).toBe(before + 1);

    // Second call should hit the in-memory cache without spawning a new OMP child
    const j2 = await (await fetch(BASE + "config/providers?directory=" + encodeURIComponent(DIR_A))).json();
    expect(j2).toBeDefined();
    expect(spawnLogLines()).toBe(before + 1);
  });

  test("PATCH /config and GET /config persist and return configuration", async () => {
    const patchRes = await fetch(BASE + "config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customSetting: "testValue", model: "custom-model" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.customSetting).toBe("testValue");
    expect(patched.model).toBe("custom-model");

    const getRes = await fetch(BASE + "config");
    expect(getRes.status).toBe(200);
    const got = await getRes.json();
    expect(got.customSetting).toBe("testValue");
    expect(got.model).toBe("custom-model");
  });

  test("GET /permission and GET /question return arrays and reject unknown IDs", async () => {
    const perms = await (await fetch(BASE + "permission")).json();
    expect(perms).toBeArray();

    const questions = await (await fetch(BASE + "question")).json();
    expect(questions).toBeArray();

    const replyPerm = await fetch(BASE + "permission/nonexistent/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "once" }),
    });
    expect(replyPerm.status).toBe(200);
    expect(await replyPerm.json()).toBe(false);

    const replyQ = await fetch(BASE + "question/nonexistent/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: [["ans"]] }),
    });
    expect(replyQ.status).toBe(200);
    expect(await replyQ.json()).toBe(false);

    const rejectQ = await fetch(BASE + "question/nonexistent/reject", { method: "POST" });
    expect(rejectQ.status).toBe(200);
    expect(await rejectQ.json()).toBe(false);
  });

  test("session fork, todo, command, and file endpoints work as expected", async () => {
    // Fork
    const forkRes = await fetch(BASE + "session/" + SES_A + "/fork", { method: "POST" });
    expect(forkRes.status).toBe(201);
    const forked = await forkRes.json();
    expect(String(forked.id).startsWith("ses_")).toBe(true);
    expect(forked.title).toContain("Fork of");

    // Clean up forked session
    await fetch(BASE + "session/" + forked.id, { method: "DELETE" });

    // Todo
    const todoRes = await fetch(BASE + "session/" + SES_A + "/todo");
    expect(todoRes.status).toBe(200);
    expect(await todoRes.json()).toBeArray();

    // Command
    const cmdRes = await fetch(BASE + "session/" + SES_A + "/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "help" }),
    });
    expect(cmdRes.status).toBe(200);

    // Shell
    const shellRes = await fetch(BASE + "session/" + SES_A + "/shell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo hello" }),
    });
    expect(shellRes.status).toBe(200);
    const shellJson = await shellRes.json();
    expect(shellJson.info).toBeDefined();
    expect(shellJson.parts).toBeArray();

    // File content
    const fileRes = await fetch(BASE + "file/content?path=" + encodeURIComponent(FILE_A));
    expect(fileRes.status).toBe(200);
    const fileJson = await fileRes.json();
    expect(fileJson.content).toContain("session");
  });

  test("PATCH /session/:id archives and restores session", async () => {
    // Archive
    const archRes = await fetch(BASE + "session/" + SES_A, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time: { archived: 1787612345 } }),
    });
    expect(archRes.status).toBe(200);
    const archJson = await archRes.json();
    expect(archJson.time.archived).toBe(1787612345);

    // Active session list should exclude SES_A
    const activeList = await (await fetch(BASE + "session?directory=" + encodeURIComponent(DIR_A))).json();
    expect(activeList.map((s: any) => s.id)).not.toContain(SES_A);

    const expActive = await (await fetch(BASE + "experimental/session?archived=false&roots=true")).json();
    expect(expActive.map((s: any) => s.id)).not.toContain(SES_A);

    // Inclusive session list should include SES_A
    const expInclusive = await (await fetch(BASE + "experimental/session?archived=true&roots=true")).json();
    expect(expInclusive.map((s: any) => s.id)).toContain(SES_A);

    // Unarchive
    const unarchRes = await fetch(BASE + "session/" + SES_A, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time: { archived: 0 } }),
    });
    expect(unarchRes.status).toBe(200);
    const unarchJson = await unarchRes.json();
    expect(unarchJson.time.archived).toBe(0);

    // Active session list should include SES_A again
    const restoredList = await (await fetch(BASE + "session?directory=" + encodeURIComponent(DIR_A))).json();
    expect(restoredList.map((s: any) => s.id)).toContain(SES_A);
  });

  test("GET & PUT /api/permission-auto-accept toggles session policy", async () => {
    const getRes = await fetch(BASE + "api/permission-auto-accept");
    expect(getRes.status).toBe(200);
    const policy = await getRes.json();
    expect(policy).toHaveProperty("sessions");

    const putRes = await fetch(BASE + "api/permission-auto-accept/sessions/" + SES_A, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(putRes.status).toBe(200);
    const putJson = await putRes.json();
    expect(putJson.sessions[SES_A]).toBe(true);

    // Toggle off
    const putOff = await fetch(BASE + "api/permission-auto-accept/sessions/" + SES_A, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(putOff.status).toBe(200);
    const offJson = await putOff.json();
    expect(offJson.sessions[SES_A]).toBe(false);
  });

  test("PUT, GET, DELETE /api/goals/objective/:id manages session goals", async () => {
    const putGoal = await fetch(BASE + "api/goals/objective/" + SES_A, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Ship comprehensive tests" }),
    });
    expect(putGoal.status).toBe(200);

    const getGoal = await fetch(BASE + "api/goals/objective/" + SES_A);
    expect(getGoal.status).toBe(200);
    expect((await getGoal.json()).content).toBe("Ship comprehensive tests");

    const delGoal = await fetch(BASE + "api/goals/objective/" + SES_A, { method: "DELETE" });
    expect(delGoal.status).toBe(200);
  });

  test("Filesystem endpoints (/api/fs/*) support mkdir, stat, write, rename, and delete", async () => {
    const testDir = join(FAKE_HOME, "fs-test");
    const testFile = join(testDir, "hello.txt");
    const renamedFile = join(testDir, "hello-renamed.txt");

    // mkdir
    const mkdirRes = await fetch(BASE + "api/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: testDir }),
    });
    expect(mkdirRes.status).toBe(200);

    // write
    const writeRes = await fetch(BASE + "api/fs/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: testFile, content: "Hello World" }),
    });
    expect(writeRes.status).toBe(200);

    // stat
    const statRes = await fetch(BASE + "api/fs/stat?path=" + encodeURIComponent(testFile));
    expect(statRes.status).toBe(200);
    const statJson = await statRes.json();
    expect(statJson.exists).toBe(true);
    expect(statJson.isFile).toBe(true);

    // rename
    const renameRes = await fetch(BASE + "api/fs/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: testFile, newPath: renamedFile }),
    });
    expect(renameRes.status).toBe(200);

    // delete
    const delRes = await fetch(BASE + "api/fs/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: renamedFile }),
    });
    expect(delRes.status).toBe(200);
  });

  test("GET /session/status is empty before any prompt", async () => {
    const before = spawnLogLines();
    expect(await (await fetch(BASE + "session/status")).json()).toEqual({});
    expect(spawnLogLines()).toBe(before);
  });
});

function eventsFor(events: SSEEvent[], type: string, ses: string) {
  return events.filter((e) => e.type === type && (e.properties.sessionID ?? (e.properties.info as MsgInfo | undefined)?.sessionID) === ses);
}

type PartView = {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  state?: { status?: string; output?: string };
}

function lastPart(events: SSEEvent[], ses: string, partType: string): PartView | undefined {
  let from = -1;
  let base: PartView | undefined;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== "message.part.updated") continue;
    const p = events[i].properties.part as PartView | undefined;
    if (!p || p.type !== partType) continue;
    if ((events[i].properties.sessionID ?? (events[i].properties.info as MsgInfo | undefined)?.sessionID) !== ses) continue;
    base = { ...(p as PartView) };
    from = i;
  }
  if (!base) return undefined;
  for (let i = from + 1; i < events.length; i++) {
    const d = events[i].type === "message.part.delta" ? events[i].properties : undefined;
    if (!d || d.partID !== base.id || d.field !== "text") continue;
    base.text = String(base.text ?? "") + String(d.delta);
  }
  return base;
}

describe("sidecar turn flows (Tier B, mock OMP)", () => {
  test("normal prompt streams the golden contract sequence and ends idle", async () => {
    const stream = collectSse(isIdle, 6000);
    await new Promise((r) => setTimeout(r, 60));
    const r = await postPrompt("hello world");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ queued: true });
    const events = await stream;

    const status = eventsFor(events, "session.status", SES_A);
    expect(status.length).toBeGreaterThanOrEqual(1);
    expect(status[0].properties.status).toEqual({ type: "busy" });
    expect(events[events.length - 1].type).toBe("session.idle");

    const info = eventsFor(events, "message.updated", SES_A)
      .map((e) => e.properties.info as MsgInfo | undefined)
      .filter((i): i is MsgInfo => !!i);
    expect(info.length).toBeGreaterThanOrEqual(1);
    expect(info[info.length - 1].finish).toBe("stop");

    const text = defined(lastPart(events, SES_A, "text"));
    expect(text.text).toBe("Hello");
    const tool = defined(lastPart(events, SES_A, "tool"));
    expect(tool.tool).toBe("bash");
    expect(tool.state?.status).toBe("completed");
    expect(tool.state?.output).toBe("a.txt");

    const vocab = new Set([
      "server.connected",
      "server.heartbeat",
      "session.status",
      "session.idle",
      "message.updated",
      "message.part.updated",
      "message.part.delta",
    ]);
    for (const e of events) expect(vocab.has(e.type)).toBe(true);
  });

  test("provider failure (P11) completes the turn with no assistant text and no file churn", async () => {
    const before = readFileSync(FILE_A, "utf8");
    const stream = collectSse(isIdle, 6000);
await new Promise((r) => setTimeout(r, 60));
    const r = await postPrompt("please MOCKFAIL now");
    expect(await r.json()).toEqual({ queued: true });
    const events = await stream;

    const info = eventsFor(events, "message.updated", SES_A).map((e) => e.properties.info as MsgInfo | undefined).filter((i): i is MsgInfo => !!i);
    expect(info.length).toBe(0);
    expect(eventsFor(events, "message.part.updated", SES_A)).toHaveLength(0);
    expect(eventsFor(events, "session.status", SES_A)[0].properties.status).toEqual({ type: "busy" });
    expect(events[events.length - 1].type).toBe("session.idle");
    expect(readFileSync(FILE_A, "utf8")).toBe(before);
  });

  test("rpc transport errors surface as a visible assistant error message", async () => {
    const stream = collectSse(isIdle, 6000);
await new Promise((r) => setTimeout(r, 60));
    const r = await postPrompt("please MOCKRPCERR now");
    expect(await r.json()).toEqual({ queued: true });
    const events = await stream;

    const text = defined(lastPart(events, SES_A, "text"));
    expect(String(text.text ?? "")).toContain("Prompt failed:");
    expect(String(text.text ?? "")).toContain("403 Forbidden (mock provider)");
    const info = eventsFor(events, "message.updated", SES_A).map((e) => e.properties.info as MsgInfo);
    expect(info[info.length - 1].finish).toBe("stop");
    expect(events[events.length - 1].type).toBe("session.idle");
  });


  test("concurrent prompt on a busy session returns 409 session busy", async () => {
    const stream = collectSse(isIdle, 6000);
    await new Promise((r) => setTimeout(r, 60));
    const first = await postPrompt("please MOCKLONG now");
    expect(await first.json()).toEqual({ queued: true });

    const second = await postPrompt("second prompt while busy");
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("session busy");

    const busyMap = await (await fetch(BASE + "session/status")).json();
    expect(busyMap[SES_A]).toEqual({ type: "busy" });

    await stream;
    expect(await (await fetch(BASE + "session/status")).json()).toEqual({});

    const thirdStream = collectSse(isIdle, 6000,);
    await new Promise((r) => setTimeout(r, 60));
    const third = await postPrompt("please MOCKLONG again");
    expect(await third.json()).toEqual({ queued: true });
    await thirdStream;
  });

  test("abort during a live turn releases the session immediately", async () => {
    const stream = collectSse(isIdle, 6000);
    await new Promise((r) => setTimeout(r, 60));
    const r = await postPrompt("please MOCKLONG for abort");
    expect(await r.json()).toEqual({ queued: true });
    const ok = await (
      await fetch(BASE + "session/" + SES_A + "/abort", { method: "POST" })
    ).json();
    expect(ok).toBe(true);

    await stream;
    expect(await (await fetch(BASE + "session/status")).json()).toEqual({});
  });

  test("GET /session/:id/message falls back to rpc get_messages when the file cannot answer", async () => {
    const before = spawnLogLines();
    const r = await fetch(BASE + "session/" + SES_A + "/message");
    expect(r.status).toBe(200);
    const msgs = await r.json();
    expect(msgs).toHaveLength(2);
    const ids = msgs.map((m: { info: { id: string } }) => m.info.id);
    // OMP passes message ids through the host session: msg_<sessionID>_<providerID>.
    expect(ids).toContain("msg_" + SES_A + "_mock_m1");
    expect(ids).toContain("msg_" + SES_A + "_mock_m2");
    expect(spawnLogLines()).toBe(before + 1);
  });

  test("SIGTERM propagates to the omp child, which postmortes the session file, and exits 0", async () => {
    sidecar.kill();
    const code = await sidecar.exited;
    expect(code).toBe(0);
    const last = readFileSync(FILE_A, "utf8").trim().split("\n").pop() ?? "";
    expect(last).not.toBe("");
    expect(JSON.parse(last).customType).toBe("session_exit");
  });
});








