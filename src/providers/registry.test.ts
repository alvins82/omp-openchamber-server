import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ompBackend } from "./omp/backend";
import { fakeBackend } from "./fake/backend";
import {
  allBackends,
  backendById,
  backendForSession,
  defaultBackend,
  encodeSessionId,
  isMultiBackend,
  listProviders,
  listSessionsAcrossBackends,
  nativeProviderID,
  registerBackend,
  resetBackends,
  splitProviderPrefix,
} from "./registry";

const ROOT = join(import.meta.dir, "..", "..");
const LEGACY = `ses_${"a".repeat(32)}`;

// Point omp RPC at the repo's mock omp so listProviders never spawns a real
// agent process in unit tests.
beforeAll(() => {
  process.env.OMP_BIN = join(ROOT, "test", "mock-omp.mjs");
});

afterAll(() => {
  delete process.env.OMP_BIN;
});

describe("registry single-backend mode (default)", () => {
  afterEach(() => resetBackends());

  test("default catalog is omp only", () => {
    expect(allBackends()).toEqual([ompBackend]);
    expect(defaultBackend()).toBe(ompBackend);
    expect(backendById("omp")).toBe(ompBackend);
    expect(backendById("fake")).toBeUndefined();
    expect(isMultiBackend()).toBe(false);
  });

  test("provider ids pass through unchanged (D13)", () => {
    expect(splitProviderPrefix("anthropic/claude-sonnet")).toEqual({ native: "anthropic/claude-sonnet" });
    expect(nativeProviderID("omp/claude")).toBe("omp/claude");
  });

  test("legacy omp session ids decode to the default backend (D2)", () => {
    expect(backendForSession(LEGACY)).toBe(ompBackend);
    // Unknown shapes fall back to the default backend.
    expect(backendForSession("ses_fake_x")).toBe(ompBackend);
    expect(backendForSession("weird")).toBe(ompBackend);
  });

  test("listProviders returns the omp catalog unchanged", async () => {
    const response = await listProviders("/tmp");
    expect(response).toEqual(await ompBackend.listModels("/tmp"));
  });
});

describe("registry multi-backend mode", () => {
  beforeEach(() => registerBackend(fakeBackend));
  afterEach(() => resetBackends());

  test("registerBackend is idempotent on backend id", () => {
    registerBackend(fakeBackend);
    expect(allBackends().length).toBe(2);
    expect(isMultiBackend()).toBe(true);
  });

  test("session-id codec round-trips through backendForSession (D2)", () => {
    const encoded = encodeSessionId("fake", "abc");
    expect(encoded).toBe("ses_fake_abc");
    expect(backendForSession(encoded)).toBe(fakeBackend);
    expect(backendForSession("ses_omp_xyz")).toBe(ompBackend);
    expect(backendForSession(LEGACY)).toBe(ompBackend);
    // Unrecognized backend prefix falls back to the default backend.
    expect(backendForSession("ses_nope_x")).toBe(ompBackend);
  });

  test("splitProviderPrefix strips known prefixes, keeps unknown as full id (D13)", () => {
    expect(splitProviderPrefix("fake/fake")).toEqual({ backendId: "fake", native: "fake" });
    expect(splitProviderPrefix("omp/anthropic/claude")).toEqual({ backendId: "omp", native: "anthropic/claude" });
    expect(splitProviderPrefix("acme/model")).toEqual({ native: "acme/model" });
    expect(nativeProviderID("fake/fake")).toBe("fake");
  });

  test("listProviders merges and namespaces provider ids and default (D1)", async () => {
    const response = await listProviders("/tmp");
    const ids = response.providers.map((provider) => provider.id);
    // Every native provider id is namespaced with its backend prefix (D13).
    expect(ids).toContain("fake/fake");
    expect(ids.every((id) => id.startsWith("omp/") || id.startsWith("fake/"))).toBe(true);
    // Default model comes from the first (default) backend, namespaced.
    expect(response.default.default.startsWith("omp/")).toBe(true);
    expect(response.providers.find((provider) => provider.id === "fake/fake")?.models.fake).toBeDefined();
  });

  test("listSessionsAcrossBackends merges stores", async () => {
    const fakeSession = await fakeBackend.store.create("/tmp/registry");
    const sessions = await listSessionsAcrossBackends("/tmp/registry");
    expect(sessions.map((session) => session.id)).toContain(fakeSession.id);
  });
});

describe("fake backend capabilities gate inputs (D4/D16)", () => {
  test("every fake capability is false so all gates fire", () => {
    const capabilities = fakeBackend.capabilities;
    expect(Object.values(capabilities).every((enabled) => enabled === false)).toBe(true);
    expect(Object.keys(capabilities).sort()).toEqual(
      [
        "thinkingLevels",
        "images",
        "approvals",
        "subagents",
        "todo",
        "titleGeneration",
        "skills",
        "compact",
        "shell",
      ].sort(),
    );
  });

  test("fake default model and catalog are self-consistent", async () => {
    expect(fakeBackend.defaultModel).toEqual({ providerID: "fake", modelID: "fake", variant: "default" });
    const catalog = await fakeBackend.listModels("/tmp");
    expect(catalog.default.default).toBe("fake");
    expect(catalog.providers[0]?.id).toBe("fake");
  });
});
