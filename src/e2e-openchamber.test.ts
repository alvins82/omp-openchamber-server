import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const MAIN = join(ROOT, "src", "main.ts");
const MOCK_BUN = join(ROOT, "test", "mock-omp.mjs");
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}/`;
const FAKE_HOME = mkdtempSync(join(tmpdir(), "oc-e2e-"));
const SPAWN_LOG = join(FAKE_HOME, "spawn.log");
const testDir = process.cwd();

let sidecar: ReturnType<typeof Bun.spawn>;

async function waitForHealth(timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(BASE + "health");
      if (r.status === 200) return;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error("sidecar did not become healthy in " + timeoutMs + "ms");
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  mkdirSync(join(FAKE_HOME, ".omp", "agent", "sessions"), { recursive: true });

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
  } catch {}
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("OpenChamber End-to-End Compatibility & Model Picker Verification", () => {
  test("Sidecar responds to all OpenChamber startup probes correctly", async () => {
    const probes = [
      { path: "health", method: "GET", expectedStatus: 200 },
      { path: `config?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: `config/providers?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: `api/config/providers?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: `provider?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: `providers?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: "provider/auth", method: "GET", expectedStatus: 200 },
      { path: "provider/amazon-bedrock/source", method: "GET", expectedStatus: 200 },
      { path: `agent?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: `command?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: `project?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: `project/current?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: `path?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: `session?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: `session/status?directory=${encodeURIComponent(testDir)}`, method: "GET", expectedStatus: 200 },
      { path: "api/openchamber/models-metadata", method: "GET", expectedStatus: 200 },
      { path: "api/openchamber/update-check", method: "GET", expectedStatus: 200 },
      { path: "api/config/settings", method: "GET", expectedStatus: 200 },
      { path: "api/opencode/upgrade-status", method: "GET", expectedStatus: 200 },
    ];

    for (const probe of probes) {
      const res = await fetch(BASE + probe.path, { method: probe.method });
      expect(res.status).toBe(probe.expectedStatus);
      const json = await res.json();
      expect(json).toBeDefined();
    }
  });

  test("Project response satisfies OpenChamber resolveConfigDirectory", async () => {
    const res = await fetch(BASE + `project/current?directory=${encodeURIComponent(testDir)}`);
    expect(res.status).toBe(200);
    const data = await res.json() as { path?: string; worktree?: string; id?: string };
    
    // OpenChamber checks normalizeConfigPath(project.path)
    expect(data.path).toBeDefined();
    expect(data.path).toBe(testDir);
    expect(data.worktree).toBe(testDir);
  });

  test("OpenChamber useConfigStore.loadProviders transformations produce non-empty model list", async () => {
    const res = await fetch(BASE + `config/providers?directory=${encodeURIComponent(testDir)}`);
    expect(res.status).toBe(200);
    const apiResult = await res.json() as {
      providers: Array<{ id: string; name: string; models: Record<string, { id: string; name: string; variants?: Record<string, unknown> }> }>;
      default?: Record<string, string>;
    };

    expect(Array.isArray(apiResult.providers)).toBe(true);
    expect(apiResult.providers.length).toBeGreaterThan(0);

    // Exact OpenChamber useConfigStore mapping:
    const processedProviders = apiResult.providers.map((provider) => {
      const modelRecord = provider.models ?? {};
      const models = Object.keys(modelRecord).map((modelId) => modelRecord[modelId]);
      return {
        ...provider,
        models,
      };
    });

    expect(processedProviders.length).toBeGreaterThan(0);
    const firstProvider = processedProviders[0];
    expect(firstProvider.models.length).toBeGreaterThan(0);

    // First model must have id, name, and variants
    const firstModel = firstProvider.models[0];
    expect(firstModel.id).toBeDefined();
    expect(firstModel.name).toBeDefined();
    expect(firstModel.variants).toBeDefined();
    expect(Object.keys(firstModel.variants!)).toContain("xhigh");

    // Exact OpenChamber ModelPickerList filtering logic:
    const hiddenModels: Array<{ providerID: string; modelID: string }> = [];
    const searchQuery = "";

    const filteredProviders = processedProviders
      .map((provider) => {
        const models = Array.isArray(provider.models) ? provider.models : [];
        const filteredModels = models.filter((model) => {
          const modelID = typeof model.id === "string" ? model.id : "";
          if (!modelID) return false;
          if (hiddenModels.some((h) => h.providerID === provider.id && h.modelID === modelID)) return false;
          const query = searchQuery.trim().toLowerCase();
          if (!query) return true;
          return model.name.toLowerCase().includes(query) || provider.name.toLowerCase().includes(query);
        });
        return { ...provider, models: filteredModels };
      })
      .filter((provider) => provider.models.length > 0);

    expect(filteredProviders.length).toBeGreaterThan(0);

    // Exact OpenChamber flatModelList calculation:
    const flatModelList: Array<{ providerID: string; modelID: string; name: string }> = [];
    filteredProviders.forEach((provider) => {
      provider.models.forEach((model) => {
        flatModelList.push({ providerID: provider.id, modelID: model.id, name: model.name });
      });
    });

    const hasResults = flatModelList.length > 0;
    expect(hasResults).toBe(true);
    expect(flatModelList.length).toBeGreaterThanOrEqual(1);
  });

  test("User prompt optimistic message ID is preserved without duplication", async () => {
    const sesResp = await fetch(`${BASE}session?directory=${encodeURIComponent(testDir)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Test Session" }),
    });
    const session = (await sesResp.json()) as { id: string };
    const sessionId = session.id;

    // Simulate OpenChamber optimistic message sending with client-generated messageID
    const clientMessageId = "msg_01J_optimistic_client_id_test";
    const promptResp = await fetch(`${BASE}session/${sessionId}/prompt_async?directory=${encodeURIComponent(testDir)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageID: clientMessageId,
        parts: [{ type: "text", text: "Hello from client test" }],
      }),
    });
    expect(promptResp.status).toBe(200);

    // Wait a brief tick for prompt to be processed
    await new Promise((r) => setTimeout(r, 100));

    // Verify GET /session/:id/message returns the user message with the EXACT clientMessageId
    const msgsResp = await fetch(`${BASE}session/${sessionId}/message?directory=${encodeURIComponent(testDir)}`);
    const messages = (await msgsResp.json()) as Array<{ info: { id: string; role: string } }>;
    const userMsg = messages.find((m) => m.info.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.info.id).toBe(clientMessageId);
  });

  test("OpenChamber auxiliary /api endpoints respond with 200", async () => {
    // message-sent
    const msgSentResp = await fetch(`${BASE}api/sessions/ses_test123/message-sent`, { method: "POST" });
    expect(msgSentResp.status).toBe(200);
    const msgSentJson = await msgSentResp.json();
    expect(msgSentJson.success).toBe(true);
    expect(msgSentJson.messageSent).toBe(true);

    // session-knowledge
    const skResp = await fetch(`${BASE}api/session-knowledge?directory=${encodeURIComponent(testDir)}&sessionId=ses_test123`);
    expect(skResp.status).toBe(200);
    const skJson = await skResp.json();
    expect(skJson.text).toBeDefined();

    // session-knowledge/summary
    const skSummaryResp = await fetch(`${BASE}api/session-knowledge/summary?directory=${encodeURIComponent(testDir)}&sessionId=ses_test123`);
    expect(skSummaryResp.status).toBe(200);
    const skSummaryJson = await skSummaryResp.json();
    expect(Array.isArray(skSummaryJson.notes)).toBe(true);

    // session-knowledge/delivered
    const deliveredResp = await fetch(`${BASE}api/session-knowledge/delivered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_test123", directory: testDir, signature: "sig123" }),
    });
    expect(deliveredResp.status).toBe(200);

    // session-knowledge/pin
    const pinResp = await fetch(`${BASE}api/session-knowledge/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_test123", directory: testDir, id: "n1", kind: "note", pinned: true }),
    });
    expect(pinResp.status).toBe(200);
  });
});


