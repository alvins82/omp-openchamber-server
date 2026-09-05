/**
 * Tier C — live OMP integration tests (gated).
 *
 * Drives the sidecar against the real `omp` binary (no mocks), covering the
 * full OpenCode-contract surface end to end:
 *   1. a real `new_session` in a scratch project dir appears in GET /session
 *      with a stable `ses_<32hex>` id and the right directory;
 *   2. GET /config/providers exposes the live llama.cpp/qwen3.8-27b catalog
 *      entry with contract limits;
 *   3. one real prompt turn streams the exact OpenCode success vocabulary
 *      (message.updated -> message.part.updated -> message.part.delta+ ->
 *      message.part.updated -> message.updated finish:"stop" -> session.idle)
 *      with contract-shaped ids and no unknown event types;
 *   4. after the turn, GET /session/:id/message returns the persisted
 *      user + assistant records (parentID chain, finish:"stop");
 *   5. a concurrent prompt_async is rejected 409 while busy; abort acks and
 *      the lock is released once the flushed turn completes (no stuck lock).
 *
 * Default `bun test` auto-skips this file (zero cost, no network).
 * Force with `bun run test:live` (requires `omp` on PATH and a reachable
 * provider; a few minutes wall time).
 *
 * Readiness semantics (verified against real OMP): the RPC loop processes
 * stdin frames in order before emitting the `ready` frame, but `ready`
 * itself can be withheld by flaky subsystems (MCP servers, update checks).
 * The probe therefore sends `new_session` immediately after spawn and treats
 * its response — not the `ready` frame — as the readiness proof, mirroring
 * what the sidecar's OmpRpcConnection.spawn does.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { embeddedOmpConfigOverlay } from "./providers/omp/rpc";

const LIVE = process.env.OC_LIVE === "1";
const lt = (name: string, fn: () => Promise<void>, timeout?: number) =>
  LIVE ? test(name, fn, timeout) : test.skip(name, fn);

const ROOT = join(import.meta.dir, "..");
const OMP_HOME = join(Bun.env.HOME!, ".omp", "agent");
// Live vLLM serving qwen3.8-27b (see notes/contract-diff.md §6).
const VLLM_URL = process.env.OC_LIVE_VLLM ?? "http://100.77.106.117:8080/v1/models";
const LLM = { providerID: "llama.cpp", modelID: "qwen3.8-27b" };

interface LiveEnv {
  tmpDir: string;
  ompBin: string;
  ompUuid: string;
  openCodeId: string;
  sessionPath: string;
  sidecar: Subprocess;
  baseUrl: string;
  vllmOk: boolean;
}
let env: LiveEnv | undefined;

type SSEEvent = { type: string; properties: Record<string, unknown> };

function parseSseChunk(buf: string): { events: SSEEvent[]; tail: string } {
  const events: SSEEvent[] = [];
  const sep = buf.split("\n\n");
  if (sep.length < 2) return { events, tail: buf };
  const tail = sep.pop() ?? "";
  for (const frame of sep) {
    let type: string | undefined;
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      const payload = (parsed && typeof parsed === "object" && "payload" in parsed)
        ? (parsed as { payload: Record<string, unknown> }).payload
        : parsed;
      const eventType = type || (payload && typeof payload.type === "string" ? payload.type : undefined);
      const properties = (payload && typeof payload === "object" && "properties" in payload && typeof payload.properties === "object")
        ? (payload.properties as Record<string, unknown>)
        : (typeof payload === "object" ? payload : {});
      if (eventType) {
        events.push({ type: eventType, properties });
      }
    } catch {
      continue;
    }
  }
  return { events, tail };
}

function collectSse(pred: (e: SSEEvent) => boolean, timeoutMs: number): Promise<SSEEvent[]> {
  return new Promise(async (resolve, reject) => {
    const res = await fetch(`${env!.baseUrl}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) {
      reject(new Error(`SSE connect failed: ${res.status}`));
      return;
    }
    const events: SSEEvent[] = [];
    let matched = 0;
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { events: evs, tail } = parseSseChunk(buf);
        buf = tail;
        for (const e of evs) {
          events.push(e);
          if (pred(e)) {
            matched++;
            if (matched >= 1) {
              resolve(events);
              return;
            }
          }
        }
      }
      resolve(events);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function allJsonl(root: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(root)) return out;
  for (const dir of readdirSync(root)) {
    const sub = join(root, dir);
    if (!statSync(sub).isDirectory()) continue;
    for (const f of readdirSync(sub)) {
      if (f.endsWith(".jsonl")) out.add(join(sub, f));
    }
  }
  return out;
}

async function jget(path: string): Promise<unknown> {
  const r = await fetch(`${env!.baseUrl}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

async function post(path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${env!.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(250);
  }
}

async function runProbe(ompBin: string, tmpDir: string): Promise<{ sessionPath: string; ompUuid: string }> {
  const before = allJsonl(join(OMP_HOME, "sessions"));
  const start = Date.now();
  let lastChunkAt = start;
  const log = (m: string): void => console.log(`[live-setup] +${Date.now() - start}ms ${m}`);
  // Same embedded-instance overlay as the sidecar: no project MCP servers, so
  // a flaky one (e.g. typescript_lsp) cannot gate the `ready` frame.
  const probe = Bun.spawn(
    [ompBin, "--mode", "rpc", "--cwd", tmpDir, "--no-title", "--no-pty", "--config", embeddedOmpConfigOverlay()],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      env: { ...Bun.env, PI_NO_TITLE: "1", PI_SKIP_VERSION_CHECK: "1" },
    },
  );
  let errBuf = "";
  const errReader = (probe.stderr as ReadableStream<Uint8Array>).getReader();
  const errDecoder = new TextDecoder();
  const errPump = (async (): Promise<void> => {
    for (;;) {
      const r = await errReader.read();
      if (r.done) break;
      errBuf += errDecoder.decode(r.value, { stream: true });
    }
  })().catch(() => {});
  const fail = (msg: string): Error => new Error(`${msg}; omp-stderr=${errBuf.slice(-300)}`);
  const send = (o: Record<string, unknown>): void => {
    probe.stdin.write(new TextEncoder().encode(JSON.stringify(o) + "\n"));
  };
  const reader = (probe.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let respBuf = "";
  let stage = 1;
  let turnStart = 0;
  let pendingRead: Promise<{ done: boolean; value: Uint8Array | null }> | null = null;
  const readChunk = (): Promise<{ done: boolean; value: Uint8Array | null }> => {
    if (!pendingRead) {
      pendingRead = reader.read().then((r) => {
        pendingRead = null;
        return { done: r.done, value: r.value ?? null };
      });
    }
    return Promise.race([
      pendingRead,
      new Promise<{ done: boolean; value: Uint8Array | null }>((res) => setTimeout(() => res({ done: false, value: null }), 10_000)),
    ]);
  };
  const withTimeout = (p: Promise<string>, ms: number): Promise<string> =>
    Promise.race([p, new Promise<string>((res) => setTimeout(() => res("<timeout>"), ms))]);
  const diagDump = async (): Promise<string> => {
    const parts: string[] = [];
    parts.push(await withTimeout(
      Bun.$`ps -o pid,ppid,stat,wchan -p ${probe.pid} 2>/dev/null`.quiet().text().catch(() => "<gone>"),
      5000,
    ));
    parts.push(await withTimeout(
      Bun.$`pgrep -P ${probe.pid} 2>/dev/null | while read -r c; do printf 'child %s [%s] ' "$c" "$(ps -o stat=,wchan= -p $c 2>/dev/null | tr -d \\n)"; ps -o command= -p $c 2>/dev/null | cut -c1-160; done`.quiet().text().catch(() => "<n/a>"),
      5000,
    ));
    parts.push(await withTimeout(
      Bun.$`ps -M -o tid,stat,wchan -p ${probe.pid} 2>/dev/null | head -12`.quiet().text().catch(() => "<n/a>"),
      5000,
    ));
    parts.push(await withTimeout(
      Bun.$`nettop -P ${probe.pid} -L 2 2>/dev/null | rtk grep -m6 "TCP"`.quiet().text().catch(() => "<n/a>"),
      8000,
    ));
    parts.push(await withTimeout(
      Bun.$`lsof -p ${probe.pid} 2>/dev/null`.quiet().then((r) => {
        const t = r.text().trim();
        writeFileSync("/tmp/oc-omp-lsof.txt", t);
        return `lsof=${t.split("\n").length} lines`;
      }).catch(() => "lsof=<n/a>"),
      6000,
    ));
    return parts.join(" | ");
  };
  // Pre-ready send: OMP processes stdin frames in order before emitting
  // `ready` (verified); its response is the readiness proof, so a flaky
  // subsystem that withholds `ready` cannot stall the probe.
  send({ id: "ls1", type: "new_session" });
  log("new_session sent before any frame (pre-ready)");
  let probeError: Error | undefined;
  try {
    for (;;) {
      if (Date.now() - start > 45_000) throw fail(`omp probe timed out at stage ${stage}; tail=${respBuf.slice(-300)}`);
      if (stage < 3 && Date.now() - lastChunkAt > 20_000) throw fail(`OMP silent for 20s at stage ${stage}; tail=${respBuf.slice(-300)}`);
      if (stage === 3 && turnStart > 0 && Date.now() - turnStart > 30_000) {
        log("turn did not end within 30s of prompt; proceeding");
        stage = 4;
        break;
      }
      const chunk = await readChunk();
      if (chunk.done) throw fail(`omp probe child closed at stage ${stage}; tail=${respBuf.slice(-300)}`);
      if (chunk.value === null) continue;
      lastChunkAt = Date.now();
      respBuf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = respBuf.indexOf("\n")) !== -1) {
        const line = respBuf.slice(0, nl).trim();
        respBuf = respBuf.slice(nl + 1);
        if (!line) continue;
        let frame: { type?: string; id?: string; success?: boolean; error?: unknown };
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (stage === 1 && frame.type === "response" && frame.id === "ls1") {
          if (frame.success === false) throw fail(`new_session failed: ${JSON.stringify(frame.error)}`);
          send({ id: "ls2", type: "set_model", provider: LLM.providerID, modelId: LLM.modelID });
          stage = 2;
          log("new_session ok; set_model sent");
        } else if (stage === 2 && frame.type === "response" && frame.id === "ls2") {
          if (frame.success === false) throw fail(`set_model failed: ${JSON.stringify(frame.error)}`);
          send({ id: "ls3", type: "prompt", message: "Say hi" });
          stage = 3;
          turnStart = Date.now();
          log("set_model ok; prompt sent");
        } else if (stage === 3 && (frame.type === "agent_end" || frame.type === "prompt_result")) {
          log("turn end seen");
          stage = 4;
          break;
        }
      }
      if (stage === 4) break;
    }
  } catch (e) {
    probeError = e as Error;
  }
  const dump = probeError ? await diagDump() : "";
  try {
    process.kill(-probe.pid, "SIGTERM");
  } catch {
    try {
      probe.kill();
    } catch {
      // already gone
    }
  }
  if (probeError) {
    probeError.message += dump ? " " + dump : "";
    throw probeError;
  }
  await sleep(500);
  await errPump;
  const after = allJsonl(join(OMP_HOME, "sessions"));
  const fresh = [...after].filter((p) => !before.has(p)).sort();
  if (fresh.length === 0) throw new Error(`no new session JSONL appeared after the fixture prompt; omp-stderr=${errBuf.slice(-200)}`);
  const sessionPath = fresh[fresh.length - 1];
  const head = readFileSync(sessionPath, "utf8").split("\n").slice(0, 8);
  const sessionRec = head
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as { type?: string; id?: string };
      } catch {
        return undefined;
      }
    })
    .find((r) => r?.type === "session");
  if (!sessionRec?.id) throw new Error("no session record in " + sessionPath);
  log(`session file=${basename(sessionPath)} ompUuid=${sessionRec.id}`);
  return { sessionPath, ompUuid: sessionRec.id };
}

beforeAll(async () => {
  if (!LIVE) return;
  const which = await Bun.$`which omp`.quiet();
  const ompBin = (await which.text()).trim();
  if (!ompBin) throw new Error("test:live requires the `omp` binary on PATH");

  let vllmOk = false;
  try {
    const r = await fetch(VLLM_URL, { signal: AbortSignal.timeout(4000) });
    vllmOk = r.status < 500;
  } catch {
    vllmOk = false;
  }

  let tmpDir = "";
  let sessionPath = "";
  let ompUuid = "";
  {
    const deadline = Date.now() + 75_000;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const dir = mkdtempSync(join(Bun.env.HOME!, "oc-live-"));
      writeFileSync(join(dir, "README.md"), "# live scratch project\n");
      try {
        ({ sessionPath, ompUuid } = await runProbe(ompBin, dir));
        tmpDir = dir;
        break;
      } catch (e) {
        console.log(`[live-setup] probe attempt ${attempt} failed: ${(e as Error).message.slice(0, 1600)}`);
        if (attempt >= 3 || Date.now() > deadline) break;
      }
    }
    if (!sessionPath) throw new Error("omp session-creation probe failed after 3 attempts");
  }

  const openCodeId = `ses_${ompUuid.replace(/-/g, "").toLowerCase()}`;
  const port = await new Promise<number>((resolve, reject) => {
    try {
      const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
      resolve(s.port ?? 0);
      s.stop(true);
    } catch (e) {
      reject(e);
    }
  });
  const sidecar = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: ROOT,
    env: { ...Bun.env, OC_SIDECAR_PORT: String(port), PI_NO_TITLE: "1" },
    stdout: "ignore",
    stderr: "inherit",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      try {
        const r = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch {
        return false;
      }
    },
    15_000,
  );

  env = { tmpDir, ompBin, ompUuid, openCodeId, sessionPath, sidecar, baseUrl, vllmOk };
}, 150_000);

afterAll(async () => {
  if (!env) return;
  try {
    env.sidecar.kill();
    await waitFor(
      () => {
        try {
          env!.sidecar.exitCode;
          return env!.sidecar.exitCode !== undefined;
        } catch {
          return true;
        }
      },
      10_000,
    );
  } catch {
    // sidecar already dead
  }
  try {
    rmSync(env.sessionPath, { force: true });
  } catch {
    // keep on failure for postmortem
  }
  try {
    rmSync(env.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  env = undefined;
}, 30_000);

lt("live: a real OMP new_session appears in GET /session with a stable OpenCode id", async () => {
  const list = (await jget(`/session?directory=${encodeURIComponent(env!.tmpDir)}`)) as Array<{
    id: string;
    directory: string;
    time?: { created?: number };
  }>;
  expect(Array.isArray(list)).toBe(true);
  const target = list.find((s) => s.id === env!.openCodeId);
  expect(target).toBeDefined();
  expect(env!.openCodeId).toMatch(/^ses_[0-9a-f]{32}$/);
  expect(target!.directory).toBe(env!.tmpDir);
  expect(target!.time?.created ?? 0).toBeGreaterThan(0);
}, 30_000);

lt("live: GET /config/providers exposes the live model catalog entry with contract limits", async () => {
  const p = (await jget("/config/providers")) as {
    providers: Array<{ id: string; name: string; models: Record<string, { limit?: { context?: number; output?: number } }> }>;
    default: { default: string };
  };
  expect(p.providers.length).toBeGreaterThanOrEqual(1);
  expect(p.default.default).toBeTruthy();
  const llama = p.providers.find((x) => x.id === LLM.providerID);
  expect(llama).toBeDefined();
  const qwen = llama!.models[LLM.modelID];
  expect(qwen).toBeDefined();
  expect(qwen!.limit?.output ?? 0).toBeGreaterThanOrEqual(32000);
  expect(qwen!.limit?.context ?? 0).toBeGreaterThanOrEqual(100_000);
}, 40_000);

lt("live: one real turn streams the exact OpenCode success vocabulary and ends idle", async () => {
  const idle = collectSse((e) => e.type === "session.idle", 150_000);
  await sleep(80);
  const r = await post(`/session/${env!.openCodeId}/prompt_async`, {
    parts: [{ type: "text", text: "Reply with exactly: PONG" }],
    model: LLM,
  });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ queued: true });
  const events = await idle;

  const allowed = new Set([
    "server.connected",
    "server.heartbeat",
    "session.created",
    "session.updated",
    "message.created",
    "message.updated",
    "message.part.updated",
    "message.part.delta",
    "session.status",
    "session.idle",
  ]);
  for (const e of events) {
    expect(allowed.has(e.type)).toBe(true);
  }

  expect(events.length).toBeGreaterThanOrEqual(3);
  expect(events[events.length - 1].type).toBe("session.idle");

  const created = events.find((e) => e.type === "message.updated" && !e.properties.info)
    ?? events.find((e) => e.type === "message.updated");
  const infoSeq = events
    .filter((e) => e.type === "message.updated")
    .map((e) => (e.properties.info ?? {}) as { id?: string; finish?: string; role?: string; model?: { providerID?: string; modelID?: string } })
    .filter((i) => !!i.id);
  expect(infoSeq.length).toBeGreaterThanOrEqual(2);
  const first = infoSeq[0];
  expect(first).toBeDefined();
  expect(first.id).toMatch(new RegExp(`^msg_${env!.openCodeId}`));
  expect(first.model?.providerID).toBe(LLM.providerID);
  expect(first.model?.modelID).toBe(LLM.modelID);
  expect(infoSeq[infoSeq.length - 1].finish).toBe("stop");

  const partTypes = events
    .filter((e) => e.type === "message.part.updated")
    .map((e) => ((e.properties.part ?? {}) as { type?: string }).type);
  expect(partTypes).toContain("text");
  const firstPartIdx = events.findIndex((e) => e.type === "message.part.updated");
  const firstDeltaIdx = events.findIndex((e) => e.type === "message.part.delta");
  expect(firstPartIdx).toBeGreaterThanOrEqual(0);
  expect(firstDeltaIdx).toBeGreaterThan(firstPartIdx);

  // Accumulate part text exactly as a consumer (OpenChamber's reducer) does:
  // the first message.part.updated carries the first chunk; deltas append.
  // A short reply may arrive as a single chunk, yielding zero deltas for that
  // part, so the accumulation must start from the part's initial text.
  const partText = new Map<string, { type?: string; text: string }>();
  for (const e of events) {
    if (e.type === "message.part.updated") {
      const p = (e.properties.part ?? {}) as { id?: string; type?: string; text?: string };
      if (p.id) partText.set(p.id, { type: p.type, text: p.text ?? "" });
    } else if (e.type === "message.part.delta") {
      const pr = e.properties as { partID?: string; field?: string; delta?: string };
      if (pr.partID && pr.field !== "thinking") {
        const entry = partText.get(pr.partID) ?? { type: "text", text: "" };
        entry.text += String(pr.delta ?? "");
        partText.set(pr.partID, entry);
      }
    }
  }
  const textPart = [...partText.values()].find((v) => v.type === "text");
  expect(textPart).toBeDefined();
  expect(textPart!.text).toContain("PONG");
}, 180_000);

lt("live: after the turn, GET /session/:id/message persists the user + assistant records", async () => {
  const msgs = (await jget(`/session/${env!.openCodeId}/message`)) as Array<{
    info: {
      id: string;
      role: string;
      finish?: string;
      parentID?: string;
      time?: { created?: number };
    };
    parts?: Array<{ type?: string; text?: string; messageID?: string }>;
  }>;
  expect(Array.isArray(msgs)).toBe(true);
  expect(msgs.length).toBeGreaterThanOrEqual(2);
  const user = msgs[msgs.length - 2];
  const assistant = msgs[msgs.length - 1];
  expect(user.info.role).toBe("user");
  expect(assistant.info.role).toBe("assistant");
  expect(assistant.info.finish).toBe("stop");
  expect(assistant.info.parentID).toBe(user.info.id);
  expect(user.parts?.some((x) => (x.text ?? "").includes("PONG"))).toBe(true);
  const textPart = assistant.parts?.find((x) => x.type === "text" && (x.text ?? "").includes("PONG"));
  expect(textPart).toBeDefined();
  expect(textPart!.messageID).toBe(assistant.info.id);
}, 60_000);

lt("live: concurrent prompt_async is 409 while busy; abort acks and the lock releases", async () => {
  const idle = collectSse((e) => e.type === "session.idle", 200_000);
  await sleep(80);
  const essay = "Write a roughly 400-word essay about the history of lighthouses. Do not stop early.";
  const r1 = await post(`/session/${env!.openCodeId}/prompt_async`, { parts: [{ type: "text", text: essay }], model: LLM });
  expect(r1.status).toBe(200);
  expect(r1.json).toEqual({ queued: true });

  await waitFor(
    async () => {
      const status = (await jget("/session/status")) as Record<string, { type?: string }>;
      return status[env!.openCodeId]?.type === "busy";
    },
    15_000,
  );

  const r2 = await post(`/session/${env!.openCodeId}/prompt_async`, { parts: [{ type: "text", text: "stop" }], model: LLM });
  expect(r2.status).toBe(409);

  const ab = await post(`/session/${env!.openCodeId}/abort`);
  expect(ab.status).toBe(200);
  expect(ab.json).toBe(true);

  await idle;

  const r3 = await post(`/session/${env!.openCodeId}/prompt_async`, {
    parts: [{ type: "text", text: "Reply with exactly: OK" }],
    model: LLM,
  });
  expect(r3.status).toBe(200);
  expect(r3.json).toEqual({ queued: true });

  await waitFor(
    async () => {
      const status = (await jget("/session/status")) as Record<string, { type?: string }>;
      return status[env!.openCodeId]?.type !== "busy";
    },
    120_000,
  );
}, 240_000);
