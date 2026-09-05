/**
 * Multi-backend HTTP surface test: spawns the real sidecar with
 * OC_FAKE_BACKEND=1 and proves D1 routing, D2 session-id codec, D4
 * capability gating, and a full scripted turn over the live HTTP/SSE
 * surface — no omp agent involved.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const ROOT = join(import.meta.dir, "..", "..", "..");
const MAIN = join(ROOT, "src", "main.ts");
const MOCK_OMP = join(ROOT, "test", "mock-omp.mjs");
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}/`;

let sidecar: Bun.Subprocess<"ignore", "pipe", "inherit">;
let home: string;

// ts-no-test-timers exception: the sidecar is a spawned OS process, so
// readiness cannot be driven by fake timers — poll /health with real sleeps.
async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE + "health");
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(100);
  }
  throw new Error("sidecar did not become healthy");
}

interface SSEEvent {
  type: string;
  properties: Record<string, unknown>;
}

function parseSseChunk(buf: string): SSEEvent[] {
  const out: SSEEvent[] = [];
  for (const frame of buf.split("\n\n").slice(0, -1)) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as {
        payload?: { type?: string; properties?: Record<string, unknown> };
        type?: string;
        properties?: Record<string, unknown>;
      };
      const payload = parsed.payload ?? parsed;
      if (typeof payload.type === "string") {
        out.push({ type: payload.type, properties: payload.properties ?? {} });
      }
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * Collect SSE frames until the predicate matches the last one, or timeout.
 * ts-no-test-timers exception: frames come from a spawned sidecar process, so
 * arrival cannot be driven by fake timers — race each read against a short
 * real sleep so the deadline check stays reachable even with no traffic.
 */
async function collectSse(pred: (event: SSEEvent) => boolean, timeoutMs: number): Promise<SSEEvent[]> {
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
    const result = await Promise.race([reader.read(), Bun.sleep(100).then(() => null)]);
    if (result) {
      buf += dec.decode(result.value, { stream: true });
      events.push(...parseSseChunk(buf));
      buf = buf.split("\n\n").pop() ?? "";
    }
  }
  reader.cancel();
  return events;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "fake-backend-http-"));
  sidecar = Bun.spawn(["bun", MAIN], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      OC_SIDECAR_PORT: String(PORT),
      OC_FAKE_BACKEND: "1",
      OMP_BIN: MOCK_OMP,
      HOME: home,
    },
  });
  // Drain stdout so the sidecar never blocks on a full pipe.
  void (async () => {
    const reader = sidecar.stdout.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  })();
  await waitForHealth();
});

afterAll(async () => {
  sidecar?.kill();
  await sidecar?.exited;
});

describe("multi-backend HTTP surface (OC_FAKE_BACKEND=1)", () => {
  let fakeId: string;
  let ompId: string;

  test("provider catalog is namespaced across backends (D1/D13)", async () => {
    const res = await fetch(BASE + "provider");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: { id: string }[]; default: { default: string } };
    const ids = body.providers.map((provider) => provider.id);
    expect(ids).toContain("fake/fake");
    expect(ids.every((id) => id.startsWith("omp/") || id.startsWith("fake/"))).toBe(true);
    expect(body.default.default.startsWith("omp/")).toBe(true);
  });

  test("POST /session routes by model prefix; default stays legacy (D1/D2)", async () => {
    const fakeRes = await postJson("/session", {
      title: "fake session",
      model: { providerID: "fake/fake", modelID: "fake", variant: "default" },
    });
    expect(fakeRes.status).toBe(201);
    const fakeSession = (await fakeRes.json()) as { id: string };
    expect(fakeSession.id).toMatch(/^ses_fake_/);
    fakeId = fakeSession.id;

    const ompRes = await postJson("/session", { title: "omp session" });
    expect(ompRes.status).toBe(201);
    const ompSession = (await ompRes.json()) as { id: string };
    expect(ompSession.id).toMatch(/^ses_[0-9a-f]{32}$/);
    ompId = ompSession.id;

    // The fake store lists in-memory; the mock omp binary does not persist
    // POST-created sessions to disk, so only the fake session is assertable here.
    const list = (await (await fetch(BASE + "session")).json()) as { id: string }[];
    expect(list.map((session) => session.id)).toContain(fakeId);
  });

  test("capability gates fire for the fake backend (D4/D16)", async () => {
    // todo gate: capabilities.todo false -> []
    const todos = await fetch(BASE + `session/${fakeId}/todo`);
    expect(todos.status).toBe(200);
    expect(await todos.json()).toEqual([]);

    // summarize gate: capabilities.compact false -> 501
    const summarize = await postJson(`session/${fakeId}/summarize`, {});
    expect(summarize.status).toBe(501);

    // shell gate: capabilities.shell false -> 400
    const shell = await postJson(`session/${fakeId}/shell`, { command: "echo hi" });
    expect(shell.status).toBe(400);
  });

  test("prompting a fake session streams a scripted turn and persists the transcript", async () => {
    const events = collectSse(
      (event) => event.type === "session.idle" && event.properties.sessionID === fakeId,
      8000,
    );
    const res = await postJson(`session/${fakeId}/message`, {
      parts: [{ type: "text", text: "hi fake" }],
      model: { providerID: "fake/fake", modelID: "fake", variant: "default" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true });

    const frames = await events;
    const typeList = frames.map((event) => event.type);
    expect(typeList).toContain("session.status");
    expect(typeList).toContain("message.part.updated");
    expect(typeList.at(-1)).toBe("session.idle");

    // Assistant text arrives on the SSE surface via message.part.updated.
    let text = "";
    for (const event of frames) {
      if (event.type === "message.part.updated") {
        const part = event.properties.part as { type?: string; text?: string } | undefined;
        if (part?.type === "text") text = String(part.text ?? "");
      }
    }
    expect(text).toBe("fake: hi fake");

    const transcript = (await (await fetch(BASE + `session/${fakeId}/message`)).json()) as {
      info: { role: string; sessionID: string };
      parts: { type: string; text?: string }[];
    }[];
    const assistant = transcript.filter((record) => record.info.role === "assistant");
    expect(assistant.length).toBeGreaterThanOrEqual(1);
    expect(assistant.at(-1)?.info.sessionID).toBe(fakeId);
    expect(assistant.at(-1)?.parts[0]?.text).toBe("fake: hi fake");
  }, 15000);

  test("prompting with another backend's model prefix is rejected (D1)", async () => {
    const res = await postJson(`session/${ompId}/message`, {
      parts: [{ type: "text", text: "cross backend" }],
      model: { providerID: "fake/fake", modelID: "fake", variant: "default" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect((body as { error?: string }).error).toContain("does not belong");
  });
});
