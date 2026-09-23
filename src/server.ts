import { allBackends, backendById, backendForSession, defaultBackend, listProviders, listSessionsAcrossBackends, registerBackend, splitProviderPrefix } from "./providers/registry";
import { listAvailableCommands, listAvailableSkills } from "./adapters/openchamber/discovery";
import {
  createOpenCodeEventStream,
  createOpenChamberNotificationStream,
  attachOpenCodeEventWebSocket,
  emitSessionCreated,
  emitSessionUpdated,
  emitSessionDeleted,
  emitPermissionReplied,
  emitQuestionReplied,
  emitQuestionRejected,
  emitBrowserControlRequest,
  emitSessionCompacted,
  emitOpenCodeV2Event,
} from "./shared/sse";
import { BrowserControlBroker, BrowserControlError } from "./adapters/openchamber/browser-control";
import {
  listPendingPermissions,
  listPendingQuestions,
  getPendingPermission,
  getPendingQuestion,
  getPendingBlockingRequestsSnapshot,
  replyPermission,
  replyQuestion,
  rejectQuestion,
  getAutoAcceptPolicy,
  setSessionAutoAccept,
  toOpenCodePermissionRequest,
  toOpenCodeFormRequest,
  toQuestionAnswers,
} from "./adapters/openchamber/approvals";
import {
  promptSessionAsync,
  addSessionSyntheticContext,
  mimeFromPath,
  abortSession,
  compactSession,
  getSessionStatusMap,
  reconcileSessionStatuses,
  removeSessionState,
  shutdownAll,
} from "./adapters/openchamber/prompt";
import { page, toV2FileAttachment, toV2Message, toV2Session } from "./adapters/openchamber/v2";
import { extractTodosFromOmpDetails } from "./providers/omp/todo";
import { invalidateMessageCache } from "./providers/omp/messages";
import { getSidecarExtensionPaths, MissingWorkingDirectoryError, withOmpRpc } from "./providers/omp/rpc";
import { ensureOmpBinary, getOmpRuntimeInfo, probeOmpVersion, setExplicitOmpBinary } from "./providers/omp/binary";
import { startOmpUpdateChecker } from "./providers/omp/update-check";
import { parseCliArgs, printHelp, type SidecarCliOptions } from "./adapters/openchamber/cli";
import type { BackendCredentialInput, OpenCodeProvidersResponse } from "./providers/types";
import { CredentialInputError } from "./providers/omp/credentials";
import { logger, httpLogger } from "./shared/logger";
import { join, isAbsolute, basename, extname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { readdir, mkdir, stat, unlink, rename } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fakeBackend } from "./providers/fake/backend";
import { describeSmallModel, generateSmallModelText, resolveSmallModel, resolveProviderConnection, ensureLegacyOmpConfigMigrated } from "./adapters/openchamber/small-model";
import { handleGitRequest } from "./adapters/openchamber/git";
import { createMessageQueueRuntime, isQueueError } from "./adapters/openchamber/message-queue";
import { createProjectContextRuntime, handleProjectContextRequest } from "./adapters/openchamber/project-context";
import { createSessionKnowledgeRuntime, handleSessionKnowledgeRequest } from "./adapters/openchamber/session-knowledge";
import { handleJarvisRequest } from "./adapters/jarvis";

// Optional fake backend (test-only): OC_FAKE_BACKEND=1 enables multi-backend
// mode over the HTTP surface. Off by default so the omp-only path stays
// byte-identical.
if (process.env.OC_FAKE_BACKEND === "1") {
  registerBackend(fakeBackend);
}

const messageQueueRuntime = createMessageQueueRuntime();

function resolveFsPath(rawPath: string, effectiveDir = process.cwd()): string {
  const home = Bun.env.HOME || process.env.HOME || "/tmp";
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
  if (isAbsolute(trimmed)) return trimmed;
  return join(effectiveDir, trimmed);
}

// OpenChamber uses this bounded walk when a selected directory is not itself
// a Git repository. Keep the scan deliberately shallow and stop at repository
// boundaries: this is only for choosing a nested repo in the Git tab, not for
// indexing an entire filesystem.
const GIT_DIRS_MAX_DEPTH = 3;
const GIT_DIRS_MAX_DIRS = 100;
const GIT_DIRS_SKIP_NAMES = new Set(["node_modules", "dist", "build", ".venv", "target", ".next"]);

async function findGitDirectories(rootPath: string): Promise<string[]> {
  const repositories: string[] = [];
  let visited = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (visited >= GIT_DIRS_MAX_DIRS) return;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      // A protected nested directory should not make the whole picker fail.
      // The root is handled by the route's error mapping below.
      if (directory === rootPath) throw err;
      return;
    }
    visited += 1;

    let isRepository = false;
    const subdirectories: string[] = [];
    for (const entry of entries) {
      // A .git directory, worktree pointer file, or symlink all identify a
      // repository boundary. Do not descend into that repository.
      if (entry.name === ".git") {
        isRepository = true;
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (GIT_DIRS_SKIP_NAMES.has(entry.name)) continue;
      if (depth >= GIT_DIRS_MAX_DEPTH) continue;
      subdirectories.push(entry.name);
    }

    if (isRepository) {
      if (directory !== rootPath) repositories.push(directory);
      return;
    }

    subdirectories.sort();
    for (const name of subdirectories) {
      if (visited >= GIT_DIRS_MAX_DIRS) break;
      await walk(join(directory, name), depth + 1);
    }
  };

  await walk(rootPath, 0);
  return repositories;
}

function createProjectIdFromPath(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/g, "").trim();
  if (!normalized) return "";
  const data = new TextEncoder().encode(normalized);
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `path_${encoded}`;
}

function projectPathFromId(projectId: string): string | null {
  if (!projectId.startsWith("path_")) return null;
  const encoded = projectId.slice("path_".length);
  if (!encoded) return null;

  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function emptyProjectSetup(projectPath: string) {
  return {
    trust: { hash: null, trusted: true },
    setupWorktree: [],
    setupWorktreeWait: false,
    projectActions: [],
    projectActionsPrimaryId: null,
    draftStarters: [],
    shared: {
      status: "missing",
      path: join(projectPath, ".openchamber", "project.json"),
      setupWorktree: [],
      setupWorktreeWait: null,
      projectActions: [],
      draftStarters: [],
      plansDir: null,
    },
    personal: {
      setupWorktree: [],
      setupWorktreeWait: null,
      setupWorktreeMode: "append",
      projectActions: [],
      projectActionsPrimaryId: null,
      draftStarters: [],
      hiddenSharedActionIds: [],
      sharedTrust: null,
    },
  };
}

const providerCache = new Map<string, { data: OpenCodeProvidersResponse; expiresAt: number }>();
const providerInFlight = new Map<string, Promise<OpenCodeProvidersResponse>>();
let globalProviderCache: { data: OpenCodeProvidersResponse; expiresAt: number } | null = null;

export const browserControlBroker = new BrowserControlBroker({
  emitRequest: emitBrowserControlRequest,
});

async function fetchProvidersForDirectory(cwd: string): Promise<OpenCodeProvidersResponse> {
  const cached = providerCache.get(cwd) ?? globalProviderCache;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const existing = providerInFlight.get(cwd);
  if (existing) return existing;

  const request = listProviders(cwd)
    .then((response) => {
      const entry = { data: response, expiresAt: Date.now() + 120_000 };
      providerCache.set(cwd, entry);
      globalProviderCache = entry;
      return response;
    })
    .finally(() => {
      if (providerInFlight.get(cwd) === request) providerInFlight.delete(cwd);
    });
  providerInFlight.set(cwd, request);
  return request;
}

function resolveOpenCodeDirectoryHeader(req: Request): string | undefined {
  const header = req.headers.get("x-opencode-directory");
  if (!header) return undefined;
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

/**
 * Resolves the owning backend + session for a session-scoped route. Falls
 * back to a directory-less store lookup to survive cwd key differences.
 */
async function resolveSessionRoute(openCodeId: string, dir: string | undefined) {
  const backend = backendForSession(openCodeId);
  const session = (await backend.store.get(openCodeId, dir)) || (await backend.store.get(openCodeId));
  return { backend, session };
}

const openChamberDataDir = Bun.env.OPENCHAMBER_DATA_DIR
  || process.env.OPENCHAMBER_DATA_DIR
  || join(homedir(), ".config", "openchamber");

const projectContextRuntime = createProjectContextRuntime({
  projectsDirPath: join(openChamberDataDir, "projects"),
});

const sessionKnowledgeRuntime = createSessionKnowledgeRuntime({
  projectContextRuntime,
  getSession: async (sessionId, directory) => (await resolveSessionRoute(sessionId, directory)).session,
  updateSessionMetadata: async (sessionId, directory, metadata) => {
    const { backend } = await resolveSessionRoute(sessionId, directory);
    return backend.store.update(sessionId, { metadata }, directory);
  },
});

function getOpenChamberSettingsFile(): string {
  const dataDir = Bun.env.OPENCHAMBER_DATA_DIR
    || process.env.OPENCHAMBER_DATA_DIR
    || join(homedir(), ".config", "openchamber");
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "settings.json");
}

function readOmpConfig(effectiveDir = process.cwd()): Record<string, unknown> {
  const home = Bun.env.HOME || process.env.HOME || "/tmp";
  let base: Record<string, unknown> = {
    model: "omp",
    agent: "omp",
    projects: [
      {
        id: "global",
        path: effectiveDir,
        label: "Project",
      },
    ],
    activeProjectId: "global",
    homeDirectory: home,
  };
  try {
    const file = getOpenChamberSettingsFile();
    ensureLegacyOmpConfigMigrated(file);
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") base = { ...base, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return base;
}

function writeOmpConfig(updates: Record<string, unknown>): Record<string, unknown> {
  const current = readOmpConfig();
  const merged = { ...current, ...updates };
  try {
    const file = getOpenChamberSettingsFile();
    writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  } catch (err) {
    logger.error({ err }, "failed to write settings");
  }
  return merged;
}

const COMPATIBILITY = {
  apiVersion: 1,
  minClientApiVersion: 1,
  capabilities: [
    "api.health.v1",
    "api.runtime-url.v1",
    "api.raw-file.v1",
    "realtime.sse.v1",
    "realtime.websocket.global-events.v1",
    "terminal.websocket.v1",
  ],
};

const startTime = Date.now();

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (origin) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, x-opencode-directory, accept, *",
    };
  }
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-opencode-directory, accept, *",
  };
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toV2ModelInfo(
  value: OpenCodeProvidersResponse["providers"][number]["models"][string],
  providerID: string,
) {
  const model = asRecord(value) ?? {};
  const limit = asRecord(model.limit) ?? {};
  const modalities = asRecord(model.modalities) ?? {};
  const capabilities = asRecord(model.capabilities) ?? {};
  const input = Array.isArray(capabilities.input)
    ? capabilities.input.filter((entry): entry is string => typeof entry === "string")
    : Array.isArray(modalities.input)
      ? modalities.input.filter((entry): entry is string => typeof entry === "string")
      : ["text"];
  const output = Array.isArray(capabilities.output)
    ? capabilities.output.filter((entry): entry is string => typeof entry === "string")
    : Array.isArray(modalities.output)
      ? modalities.output.filter((entry): entry is string => typeof entry === "string")
      : ["text"];
  const rawVariants = asRecord(model.variants);
  const variants = Array.isArray(model.variants)
    ? model.variants
    : Object.entries(rawVariants ?? {}).map(([id, settings]) => ({
        id,
        ...(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
      }));
  const rawCost = Array.isArray(model.cost) ? model.cost : [asRecord(model.cost) ?? {}];
  const cost = rawCost.map((entry) => {
    const item = asRecord(entry) ?? {};
    const cache = asRecord(item.cache) ?? {};
    return {
      ...(asRecord(item.tier) ? { tier: item.tier } : {}),
      input: numberOr(item.input),
      output: numberOr(item.output),
      cache: { read: numberOr(cache.read), write: numberOr(cache.write) },
    };
  });
  const modelID = typeof model.modelID === "string" ? model.modelID : typeof model.id === "string" ? model.id : "omp";
  return {
    id: typeof model.id === "string" ? model.id : modelID,
    modelID,
    providerID,
    ...(typeof model.canonical === "string" ? { canonical: model.canonical } : {}),
    name: typeof model.name === "string" ? model.name : modelID,
    capabilities: {
      tools: typeof capabilities.tools === "boolean" ? capabilities.tools : model.tool_call !== false,
      input,
      output,
    },
    variants,
    time: { released: numberOr(asRecord(model.time)?.released) },
    cost,
    status: "active" as const,
    enabled: model.disabled !== true,
    limit: { context: numberOr(limit.context), output: numberOr(limit.output) },
  };
}

function toV2Agent() {
  return {
    id: "omp",
    name: "OMP",
    description: "OMP coding agent",
    mode: "primary" as const,
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
  };
}

function toV2ConfigEntries(directory: string): Array<{ type: "document"; path: string; info: Record<string, unknown> }> {
  const config = readOmpConfig(directory);
  const rawModel = config.model;
  let model: Record<string, unknown> | string | undefined;
  if (rawModel && typeof rawModel === "object" && !Array.isArray(rawModel)) {
    const value = rawModel as Record<string, unknown>;
    const providerID = typeof value.providerID === "string" ? value.providerID : "omp";
    const modelID = typeof value.model === "string" ? value.model : typeof value.modelID === "string" ? value.modelID : "omp";
    model = { providerID, model: modelID, ...(typeof value.variant === "string" ? { variant: value.variant } : {}) };
  } else if (typeof rawModel === "string") {
    const slash = rawModel.indexOf("/");
    model = slash > 0
      ? { providerID: rawModel.slice(0, slash), model: rawModel.slice(slash + 1) }
      : { providerID: "omp", model: rawModel };
  }
  const defaultAgent = typeof config.default_agent === "string"
    ? config.default_agent
    : typeof config.agent === "string" ? config.agent : "omp";
  return [{
    type: "document",
    path: "omp-sidecar",
    info: { default_agent: defaultAgent, ...(model !== undefined ? { model } : {}) },
  }];
}


// OC_SIDECAR_PORT overrides the default 4096 so the route-level test suite can
// run a second instance without colliding with the live sidecar.
interface SidecarWebSocketData {
  directory?: string;
}

const webSocketCleanups = new WeakMap<object, () => void>();

let cliOptions: SidecarCliOptions;
try {
  cliOptions = parseCliArgs();
} catch (err: any) {
  console.error(`[sidecar] Error: ${err?.message || err}`);
  process.exit(1);
}

if (cliOptions.help) {
  printHelp();
  process.exit(0);
}

if (cliOptions.binary) {
  setExplicitOmpBinary(cliOptions.binary);
}

if (cliOptions.port !== undefined) {
  process.env.OC_SIDECAR_PORT = String(cliOptions.port);
}

await ensureOmpBinary();

const server = Bun.serve<SidecarWebSocketData>({
  port: Number(process.env.OC_SIDECAR_PORT ?? 4096),
  idleTimeout: 0,
  websocket: {
    open(ws) {
      webSocketCleanups.set(ws, attachOpenCodeEventWebSocket(ws, ws.data.directory));
    },
    message() {
      // The global event stream is server-to-client only.
    },
    close(ws) {
      const cleanup = webSocketCleanups.get(ws);
      cleanup?.();
      webSocketCleanups.delete(ws);
    },
  },
  async fetch(req, requestServer) {
    const reqStart = performance.now();
    const cors = getCorsHeaders(req);
    let responseBody: unknown = undefined;

    const json = (data: unknown, init?: ResponseInit): Response => {
      responseBody = data;
      return Response.json(data, {
        ...init,
        headers: {
          ...cors,
          ...(init?.headers ?? {}),
        },
      });
    };

    const jsonError = (message: string, status: number): Response => {
      return json({ error: message }, { status });
    };
    const noContent = (): Response => new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const path = url.pathname;
    const dir = url.searchParams.get("directory") ?? resolveOpenCodeDirectoryHeader(req);
    const effectiveDir = dir ?? process.cwd();

    if (path === "/api/global/event/ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const upgraded = requestServer.upgrade(req, { data: { directory: dir } });
      if (upgraded) return;
      return jsonError("websocket upgrade failed", 400);
    }

    const dispatch = async (): Promise<Response> => {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: cors,
        });
      }

      // Jarvisbot integration is deliberately mounted as a separate adapter.
      // It shares the OMP provider runtime but does not alter the OpenCode /
      // OpenChamber-compatible routes below.
      const jarvisRoute = await handleJarvisRequest(req, url, { cors });
      if (jarvisRoute) return jarvisRoute;

      const projectContextRoute = await handleProjectContextRequest(req, url, projectContextRuntime);
      if (projectContextRoute) {
        return json(
          projectContextRoute.body,
          projectContextRoute.status === undefined ? undefined : { status: projectContextRoute.status },
        );
      }

      const sessionKnowledgeRoute = await handleSessionKnowledgeRequest(req, url, sessionKnowledgeRuntime);
      if (sessionKnowledgeRoute) {
        return json(
          sessionKnowledgeRoute.body,
          sessionKnowledgeRoute.status === undefined ? undefined : { status: sessionKnowledgeRoute.status },
        );
      }

      // Health
      if (
        path === "/health" ||
        path === "/global/health" ||
        path === "/api/health" ||
        path === "/api/opencode/health"
      ) {
        return json({
          healthy: true,
          status: "ok",
          compatibility: COMPATIBILITY,
        });
      }

      // OpenCode 2.0.8+ uses /api/info as its readiness probe. Keep the
      // response shape compatible while identifying the OMP runtime behind
      // this sidecar.
      if (path === "/api/info" && req.method === "GET") {
        return json({
          version: getOmpRuntimeInfo().version ?? "unknown",
          pid: process.pid,
          urls: [url.origin],
          paths: { tmp: tmpdir() },
        });
      }

      // OpenChamber Desktop / Web version probe
      if (path === "/api/version") {
        return json({
          status: "ok",
          openchamberVersion: "1.20.0",
          runtime: "omp-sidecar",
          startedAt: startTime,
          compatibility: COMPATIBILITY,
        });
      }

      // OpenChamber guest catalog compatibility. The OMP sidecar does not
      // own OpenChamber guest packages, but the UI expects a successful empty
      // catalog rather than a missing route.
      if (path === "/api/guests" && req.method === "GET") {
        return json({ guests: [] });
      }

      // OpenChamber's cross-project status seed is distinct from OpenCode's
      // /session/status route below. Expose the host snapshot shape while
      // preserving the existing OpenCode-compatible endpoint unchanged.
      if (path === "/api/sessions/status" && req.method === "GET") {
        await reconcileSessionStatuses();
        const now = Date.now();
        const sessions = Object.fromEntries(
          Object.entries(getSessionStatusMap()).map(([sessionId, status]) => [sessionId, {
            status: status.type,
            lastUpdateAt: now,
          }]),
        );
        const pending = Object.fromEntries(
          Object.entries(getPendingBlockingRequestsSnapshot()).map(([sessionID, requests]) => [sessionID, {
            permissions: requests.permissions.map(toOpenCodePermissionRequest),
            forms: requests.questions.map(toOpenCodeFormRequest),
          }]),
        );
        return json({
          sessions,
          pending,
          serverTime: now,
        });
      }

      // OpenChamber auth session probe
      if (path === "/auth/session" || path === "/api/auth/session") {
        return json({
          authenticated: true,
          scope: "local",
        });
      }

      // OpenChamber passkey status
      if (path === "/auth/passkey/status" || path === "/api/auth/passkey/status") {
        return json({
          enabled: false,
          hasPasskeys: false,
          passkeyCount: 0,
          rpID: null,
        });
      }

      // OpenChamber url-token & client token auth
      if (path === "/auth/url-token" || path === "/api/auth/url-token") {
        return json({
          token: "omp-local-url-token",
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        });
      }

      if (path === "/api/client-auth/clients") {
        return json({ token: "omp-local-token" });
      }

      // OpenChamber project setup is optional for the OMP sidecar. Return the
      // contract's empty setup so the UI can continue creating sessions while
      // making it explicit that this adapter does not own project settings.
      const projectConfigMatch = path.match(/^\/api\/projects\/([^/]+)\/config(\/shared)?$/);
      if (projectConfigMatch) {
        const projectPath = projectPathFromId(decodeURIComponent(projectConfigMatch[1]));
        if (!projectPath) return jsonError("invalid project id", 400);
        if (req.method === "GET") return json(emptyProjectSetup(projectPath));
        return jsonError("project config writes are not supported by the OMP sidecar", 501);
      }

      // Browser Control Claim
      if ((path === "/api/browser-control/claim" || path === "/browser-control/claim") && req.method === "POST") {
        const body = (await readJson(req)) as { requestId?: string } | undefined;
        const requestId = body?.requestId?.trim() || "";
        if (!requestId) return jsonError("requestId is required", 400);
        return json({ granted: browserControlBroker.claim(requestId) });
      }

      // Browser Control Result
      if ((path === "/api/browser-control/result" || path === "/browser-control/result") && req.method === "POST") {
        const body = (await readJson(req)) as { requestId?: string; ok?: boolean; data?: unknown; error?: string } | undefined;
        const requestId = body?.requestId?.trim() || "";
        if (!requestId) return jsonError("requestId is required", 400);
        const matched = browserControlBroker.resolve(requestId, {
          ok: body?.ok === true,
          data: body?.data,
          error: body?.error,
        });
        return json({ matched });
      }

      // Internal Browser Control Request (used by openchamber_web extension)
      if (path === "/internal/browser-control/request" && req.method === "POST") {
        const body = (await readJson(req)) as { action?: string; parameters?: Record<string, unknown>; timeoutMs?: number; directory?: string } | undefined;
        const action = body?.action?.trim() || "";
        if (!action) return jsonError("action is required", 400);
        try {
          const sidecarPort = Number(process.env.OC_SIDECAR_PORT ?? 4096);
          const targetDir = body?.directory?.trim() || effectiveDir;
          const data = await browserControlBroker.request(action, body?.parameters ?? {}, {
            timeoutMs: body?.timeoutMs,
            baseDir: targetDir,
            port: sidecarPort,
          });

          // Handle screenshot capture persistence and validation
          if ((action === "browser.capture" || action === "capture") && data && typeof data === "object") {
            let captureData = data as { base64?: string; mime?: string; width?: number; height?: number; [key: string]: unknown };

            // If the panel is newly opened or mid-animation, give the UI transition 800ms to paint and retry once
            if (!captureData.base64 || captureData.width === 0 || captureData.height === 0) {
              await new Promise((resolve) => setTimeout(resolve, 800));
              try {
                const retryResult = await browserControlBroker.request(action, body?.parameters ?? {}, {
                  timeoutMs: body?.timeoutMs,
                  baseDir: targetDir,
                  port: sidecarPort,
                });
                if (retryResult && typeof retryResult === "object") {
                  captureData = retryResult as typeof captureData;
                }
              } catch {
                /* continue to check */
              }
            }

            if (!captureData.base64 || captureData.width === 0 || captureData.height === 0) {
              throw new BrowserControlError(
                "The in-app browser view is currently hidden or not rendered (captured 0x0 pixels). Please ensure the OpenChamber browser panel is open and visible on screen.",
                400,
              );
            }
            try {
              const screenshotsDir = join(targetDir, ".openchamber", "screenshots");
              await mkdir(screenshotsDir, { recursive: true });
              const rawLabel = typeof body?.parameters?.label === "string" ? body.parameters.label.trim() : "capture";
              const cleanLabel = rawLabel.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "capture";
              const ext = captureData.mime?.includes("png") ? "png" : "jpg";
              const filename = `screenshot-${Date.now()}-${cleanLabel}.${ext}`;
              const filepath = join(screenshotsDir, filename);
              const buffer = Buffer.from(captureData.base64, "base64");
              writeFileSync(filepath, buffer);
              const enhancedData = {
                ...captureData,
                path: filepath,
                hint: `Screenshot saved to ${filepath}. Write ![](${filepath}) in your response to display it.`,
              };
              return json({ ok: true, data: enhancedData });
            } catch (err: any) {
              if (err instanceof BrowserControlError) throw err;
              logger.warn(`Failed to save screenshot to disk: ${err?.message || err}`);
            }
          }

          return json({ ok: true, data });
        } catch (err) {
          const status = err instanceof BrowserControlError ? err.status : 500;
          return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status });
        }
      }

      // Directory Explorer (OpenChamber Add Project Dialog)
      if ((path === "/fs/list" || path === "/api/fs/list") && req.method === "GET") {
        const rawPath = url.searchParams.get("path")?.trim() || "";
        const targetDir = resolveFsPath(rawPath, effectiveDir);
        try {
          const dirents = await readdir(targetDir, { withFileTypes: true });
          const entries = dirents.map((d) => ({
            name: d.name,
            path: join(targetDir, d.name),
            isDirectory: d.isDirectory(),
            isFile: d.isFile(),
            isSymbolicLink: d.isSymbolicLink(),
          }));
          return json({
            path: targetDir,
            entries,
          });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "fs list failed", 400);
        }
      }

      // Nested Git repository discovery used by the OpenChamber Git picker.
      if ((path === "/fs/git-dirs" || path === "/api/fs/git-dirs") && req.method === "GET") {
        const rawPath = url.searchParams.get("path")?.trim() || "";
        if (!rawPath) return jsonError("Path is required", 400);

        const targetDir = resolveFsPath(rawPath, effectiveDir);
        try {
          const s = await stat(targetDir);
          if (!s.isDirectory()) {
            return json({ error: "Specified path is not a directory", reason: "not-directory" }, { status: 400 });
          }

          const repositories = await findGitDirectories(targetDir);
          return json({
            path: targetDir,
            repositories: repositories.map((repositoryPath) => ({
              path: repositoryPath,
              name: basename(repositoryPath),
            })),
          });
        } catch (err: any) {
          if (err && err.code === "ENOENT") {
            return json({ error: "Directory not found", reason: "not-found" }, { status: 404 });
          }
          if (err && (err.code === "EACCES" || err.code === "EPERM")) {
            return jsonError("Access to directory denied", 403);
          }
          return jsonError(err instanceof Error ? err.message : "Failed to find git directories", 500);
        }
      }

      // Filesystem mkdir
      if ((path === "/fs/mkdir" || path === "/api/fs/mkdir") && req.method === "POST") {
        const body = (await readJson(req)) as { path?: string } | undefined;
        const target = body?.path?.trim();
        if (!target) return jsonError("Path is required", 400);
        const resolved = resolveFsPath(target, effectiveDir);
        try {
          await mkdir(resolved, { recursive: true });
          return json({ success: true, path: resolved });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "mkdir failed", 500);
        }
      }

      // OpenCode directory switch / create
      if ((path === "/opencode/directory" || path === "/api/opencode/directory") && req.method === "POST") {
        const body = (await readJson(req)) as { path?: string; create?: boolean } | undefined;
        const target = body?.path?.trim();
        if (!target) return jsonError("Path is required", 400);

        const resolved = resolveFsPath(target, effectiveDir);
        if (body?.create === true) {
          try {
            await mkdir(resolved, { recursive: true });
          } catch (err) {
            return jsonError(err instanceof Error ? err.message : "Failed to create directory", 500);
          }
        }

        try {
          const s = await stat(resolved);
          if (!s.isDirectory()) {
            return jsonError("Specified path is not a directory", 400);
          }
        } catch {
          return jsonError("Directory does not exist", 400);
        }

        const currentSettings = readOmpConfig(effectiveDir);
        const existingProjects = Array.isArray(currentSettings.projects)
          ? [...(currentSettings.projects as Array<Record<string, unknown>>)]
          : [];

        const projectId = createProjectIdFromPath(resolved);
        const existingIndex = existingProjects.findIndex(
          (p) => p && typeof p === "object" && p.path === resolved
        );

        if (existingIndex >= 0) {
          existingProjects[existingIndex] = {
            ...existingProjects[existingIndex],
            lastOpenedAt: Date.now(),
          };
        } else {
          const label = basename(resolved) || resolved;
          existingProjects.push({
            id: projectId,
            path: resolved,
            label,
            addedAt: Date.now(),
            lastOpenedAt: Date.now(),
          });
        }

        const updatedSettings = writeOmpConfig({
          projects: existingProjects,
          activeProjectId: projectId,
          lastDirectory: resolved,
        });

        return json({
          success: true,
          restarted: false,
          path: resolved,
          settings: updatedSettings,
        });
      }

      // Filesystem read
      if ((path === "/fs/read" || path === "/api/fs/read") && req.method === "GET") {
        const rawPath = url.searchParams.get("path")?.trim() || "";
        const optional = url.searchParams.get("optional") === "true";
        if (!rawPath) return jsonError("Path is required", 400);
        const resolved = resolveFsPath(rawPath, effectiveDir);
        try {
          const s = await stat(resolved);
          if (!s.isFile()) {
            return jsonError("Specified path is not a file", 400);
          }
          const content = await Bun.file(resolved).text();
          return new Response(content, {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "text/plain; charset=utf-8",
            },
          });
        } catch (err: any) {
          if (err && (err.code === "ENOENT" || String(err).includes("ENOENT"))) {
            if (optional) {
              return new Response("", {
                status: 200,
                headers: {
                  ...cors,
                  "Content-Type": "text/plain; charset=utf-8",
                },
              });
            }
            return jsonError("File not found", 404);
          }
          return jsonError(err instanceof Error ? err.message : "read failed", 500);
        }
      }

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ts": "text/plain; charset=utf-8",
};

      // Filesystem raw
      if ((path === "/fs/raw" || path === "/api/fs/raw") && req.method === "GET") {
        const rawPath = url.searchParams.get("path")?.trim() || "";
        const optional = url.searchParams.get("optional") === "true";
        const download = url.searchParams.get("download") === "true";
        if (!rawPath) return jsonError("Path is required", 400);
        const resolved = resolveFsPath(rawPath, effectiveDir);
        try {
          const s = await stat(resolved);
          if (!s.isFile()) {
            return jsonError("Specified path is not a file", 400);
          }
          const ext = extname(resolved).toLowerCase();
          const mimeType = MIME_TYPES[ext] || "application/octet-stream";
          const headers: Record<string, string> = {
            ...cors,
            "Content-Type": mimeType,
            "Cache-Control": "no-store",
          };
          if (download) {
            const fileName = basename(resolved);
            const asciiOnly = fileName.replace(/[^\x00-\x7F]/g, "") || "file";
            const encoded = encodeURIComponent(fileName);
            headers["Content-Disposition"] = `attachment; filename="${asciiOnly}"; filename*=UTF-8''${encoded}`;
          }
          const file = Bun.file(resolved);
          return new Response(file, {
            status: 200,
            headers,
          });
        } catch (err: any) {
          if (err && (err.code === "ENOENT" || String(err).includes("ENOENT"))) {
            if (optional) {
              return new Response("", {
                status: 200,
                headers: {
                  ...cors,
                  "Content-Type": "application/octet-stream",
                },
              });
            }
            return jsonError("File not found", 404);
          }
          return jsonError(err instanceof Error ? err.message : "raw read failed", 500);
        }
      }

      // Filesystem serve (used by OpenChamber HTML preview / iframe)
      if ((path.startsWith("/api/fs/serve/") || path.startsWith("/fs/serve/")) && req.method === "GET") {
        const prefix = path.startsWith("/api/fs/serve/") ? "/api/fs/serve/" : "/fs/serve/";
        const rawSubpath = path.slice(prefix.length);
        if (!rawSubpath) return jsonError("Path is required", 400);
        const decodedPath = decodeURIComponent(rawSubpath);
        const candidatePath = decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`;
        const resolved = existsSync(candidatePath) ? candidatePath : resolveFsPath(decodedPath, effectiveDir);
        try {
          const s = await stat(resolved);
          if (!s.isFile()) {
            return jsonError("Specified path is not a file", 400);
          }
          const ext = extname(resolved).toLowerCase();
          const mimeType = MIME_TYPES[ext] || "application/octet-stream";
          const headers: Record<string, string> = {
            ...cors,
            "Content-Type": mimeType,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          };
          const file = Bun.file(resolved);
          return new Response(file, {
            status: 200,
            headers,
          });
        } catch (err: any) {
          if (err && (err.code === "ENOENT" || String(err).includes("ENOENT"))) {
            return jsonError("File not found", 404);
          }
          return jsonError(err instanceof Error ? err.message : "serve failed", 500);
        }
      }

      // Filesystem clone
      if ((path === "/fs/clone" || path === "/api/fs/clone") && req.method === "POST") {
        const body = (await readJson(req)) as { remoteUrl?: string; destinationPath?: string } | undefined;
        const remoteUrl = body?.remoteUrl?.trim();
        const destinationPath = body?.destinationPath?.trim();
        if (!remoteUrl) return jsonError("Repository URL is required", 400);
        if (!destinationPath) return jsonError("Destination path is required", 400);
        const resolved = resolveFsPath(destinationPath, effectiveDir);
        try {
          const proc = Bun.spawn(["git", "clone", "--", remoteUrl, resolved], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const exitCode = await proc.exited;
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          if (exitCode !== 0) {
            return jsonError(stderr.trim() || stdout.trim() || `git clone failed with code ${exitCode}`, 500);
          }
          return json({ success: true, path: resolved });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "git clone failed", 500);
        }
      }

      // Filesystem reveal
      if ((path === "/fs/reveal" || path === "/api/fs/reveal") && req.method === "POST") {
        const body = (await readJson(req)) as { path?: string } | undefined;
        const target = body?.path?.trim();
        if (!target) return jsonError("Path is required", 400);
        const resolved = resolveFsPath(target, effectiveDir);
        try {
          if (process.platform === "darwin") {
            Bun.spawn(["open", "-R", resolved]);
          } else if (process.platform === "win32") {
            Bun.spawn(["explorer.exe", `/select,${resolved}`]);
          } else {
            Bun.spawn(["xdg-open", resolved]);
          }
          return json({ success: true, path: resolved });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "reveal failed", 500);
        }
      }

      // Filesystem stat
      if ((path === "/fs/stat" || path === "/api/fs/stat") && req.method === "GET") {
        const target = url.searchParams.get("path")?.trim();
        if (!target) return jsonError("Path is required", 400);
        const resolved = resolveFsPath(target, effectiveDir);
        try {
          const s = await stat(resolved);
          return json({
            exists: true,
            isDirectory: s.isDirectory(),
            isFile: s.isFile(),
            size: s.size,
            mtime: s.mtimeMs,
            path: resolved,
          });
        } catch {
          return json({ exists: false, isDirectory: false, isFile: false, size: 0, mtime: 0, path: resolved });
        }
      }

      // Filesystem write
      if ((path === "/fs/write" || path === "/api/fs/write") && req.method === "POST") {
        const body = (await readJson(req)) as { path?: string; content?: string } | undefined;
        const target = body?.path?.trim();
        if (!target) return jsonError("Path is required", 400);
        const resolved = resolveFsPath(target, effectiveDir);
        try {
          await Bun.write(resolved, body?.content ?? "");
          return json({ success: true, path: resolved });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "write failed", 500);
        }
      }

      // Filesystem delete
      if ((path === "/fs/delete" || path === "/api/fs/delete") && req.method === "POST") {
        const body = (await readJson(req)) as { path?: string } | undefined;
        const target = body?.path?.trim();
        if (!target) return jsonError("Path is required", 400);
        const resolved = resolveFsPath(target, effectiveDir);
        try {
          await unlink(resolved);
          return json({ success: true });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "delete failed", 500);
        }
      }

      // Filesystem rename
      if ((path === "/fs/rename" || path === "/api/fs/rename") && req.method === "POST") {
        const body = (await readJson(req)) as { oldPath?: string; newPath?: string } | undefined;
        const oldTarget = body?.oldPath?.trim();
        const newTarget = body?.newPath?.trim();
        if (!oldTarget || !newTarget) return jsonError("oldPath and newPath are required", 400);
        const resolvedOld = resolveFsPath(oldTarget, effectiveDir);
        const resolvedNew = resolveFsPath(newTarget, effectiveDir);
        try {
          await rename(resolvedOld, resolvedNew);
          return json({ success: true });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "rename failed", 500);
        }
      }

      // Home directory endpoint
      if (path === "/api/fs/home" || path === "/fs/home") {
        const home = Bun.env.HOME || process.env.HOME || "/tmp";
        return json({ home });
      }

      // Permission auto-accept policy
      if (path === "/api/permission-auto-accept" || path === "/permission-auto-accept") {
        return json(getAutoAcceptPolicy());
      }

      const autoAcceptMatch = path.match(/^\/(?:api\/)?permission-auto-accept\/sessions\/([^/]+)$/);
      if (autoAcceptMatch) {
        const sessionId = decodeURIComponent(autoAcceptMatch[1]);
        if (req.method === "PUT" || req.method === "POST") {
          const body = (await readJson(req)) as { enabled?: boolean } | undefined;
          const enabled = body?.enabled ?? true;
          return json(setSessionAutoAccept(sessionId, enabled));
        }
        return json(getAutoAcceptPolicy());
      }

      const gitResponse = await handleGitRequest(req, url, effectiveDir);
      if (gitResponse) {
        return json(gitResponse.data, {
          status: gitResponse.status,
          headers: gitResponse.headers,
        });
      }

      // Command metadata
      if (path.startsWith("/api/config/commands/")) {
        const cmdName = decodeURIComponent(path.slice("/api/config/commands/".length));
        return json({
          name: cmdName,
          sources: { md: { exists: false }, json: { exists: false } },
          scope: null,
          isBuiltIn: true,
        });
      }

      // System URL probe (for dev server preview detection)
      if (path === "/api/system/probe-url" && req.method === "POST") {
        const body = (await readJson(req)) as { url?: string } | undefined;
        const target = body?.url;
        if (!target) return json({ ok: false, error: "Invalid URL" }, { status: 400 });
        try {
          const resp = await fetch(target, { method: "GET", signal: AbortSignal.timeout(1500) });
          return json({ ok: resp.status >= 200 && resp.status < 600, status: resp.status });
        } catch (err) {
          return json({ ok: false, error: err instanceof Error ? err.message : "Probe failed" });
        }
      }

      // OpenChamber settings and metadata routes
      if (path === "/api/config/settings") {
        if (req.method === "PUT" || req.method === "PATCH" || req.method === "POST") {
          const updates = (await readJson(req)) as Record<string, unknown> | undefined;
          const updated = writeOmpConfig(updates && typeof updates === "object" ? updates : {});
          return json(updated);
        }
        return json(readOmpConfig(effectiveDir));
      }

      if (path === "/api/fs/home") {
        return json({ path: Bun.env.HOME || process.env.HOME || "/tmp" });
      }

      if (path === "/api/config/themes") {
        return json([]);
      }

      if (path === "/api/github/auth/status") {
        return json({ authenticated: false });
      }

      // Linear is not owned by the sidecar. Return the same neutral status
      // shape as OpenChamber's server uses when no workspace is connected so
      // the UI can hide the integration without treating it as a server error.
      if (path === "/api/linear/auth/status" && req.method === "GET") {
        return json({ connected: false });
      }

      if (path === "/api/session-folders") {
        return json([]);
      }

      if (path === "/api/openchamber/update-check") {
        return json({ hasUpdate: false });
      }

      if (path === "/api/openchamber/models-metadata") {
        try {
          const resp = await fetch("https://models.dev/api.json", {
            signal: AbortSignal.timeout(3000),
          });
          if (resp.ok) {
            const data = await resp.json();
            return json(data);
          }
        } catch {
          // ignore
        }
        return json({});
      }

      if (path === "/api/opencode/upgrade-status") {
        return json({
          available: false,
          currentVersion: "1.20.0",
          latestVersion: "1.20.0",
          upgrade: {
            supported: false,
            manager: null,
            reason: "external",
          },
        });
      }

      if (path === "/api/push/visibility") {
        return json({});
      }

      if (path.startsWith("/api/config/snippets")) {
        return json([]);
      }

      if (path.startsWith("/api/config/skills")) {
        return json([]);
      }

      if (path.startsWith("/api/config/mcp")) {
        return json({});
      }

      if (path.startsWith("/api/config/plugins")) {
        return json([]);
      }

      // Normalize /api/ prefix for all OpenCode core routes
      const p = path.startsWith("/api/") ? "/" + path.slice(5) : path;

      // SSE
      if (
        p === "/event" ||
        p === "/events" ||
        p === "/global/event" ||
        p === "/openchamber/events"
      ) {
        const isBrowserParam = url.searchParams.get("browser") === "1";
        const isOpenChamberStream = p === "/openchamber/events";
        return new Response(createOpenCodeEventStream(dir, { browserCapable: isBrowserParam, isOpenChamber: isOpenChamberStream }), {
          headers: {
            ...cors,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      const queueError = (error: unknown, fallback: string): Response => (
        isQueueError(error)
          ? jsonError(error.message, error.status)
          : jsonError(error instanceof Error ? error.message : fallback, 500)
      );

      if (p === "/message-queue" && req.method === "GET") {
        try {
          await messageQueueRuntime.load();
          return json(messageQueueRuntime.snapshot());
        } catch (error) {
          return queueError(error, "failed to load message queue");
        }
      }

      const queueItemsMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/items$/);
      if (queueItemsMatch && req.method === "POST") {
        try {
          const body = asRecord(await readJson(req));
          return json(await messageQueueRuntime.enqueue(
            decodeURIComponent(queueItemsMatch[1]),
            body?.directory,
            body?.item,
          ));
        } catch (error) {
          return queueError(error, "failed to queue message");
        }
      }

      const queueTakeAllMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/take$/);
      if (queueTakeAllMatch && req.method === "POST") {
        try {
          return json(await messageQueueRuntime.takeAll(decodeURIComponent(queueTakeAllMatch[1])));
        } catch (error) {
          return queueError(error, "failed to take queued messages");
        }
      }

      const queueOrderMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/order$/);
      if (queueOrderMatch && req.method === "PUT") {
        try {
          const body = asRecord(await readJson(req));
          return json(await messageQueueRuntime.reorder(
            decodeURIComponent(queueOrderMatch[1]),
            body?.itemIds,
          ));
        } catch (error) {
          return queueError(error, "failed to reorder queue");
        }
      }

      const queueHoldMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/hold$/);
      if (queueHoldMatch && req.method === "PUT") {
        try {
          const body = asRecord(await readJson(req));
          await messageQueueRuntime.load();
          return json(messageQueueRuntime.setHold(
            decodeURIComponent(queueHoldMatch[1]),
            body?.held,
            body?.ttlMs,
          ));
        } catch (error) {
          return queueError(error, "failed to update queue hold");
        }
      }

      const queueSessionMatch = p.match(/^\/message-queue\/sessions\/([^/]+)$/);
      if (queueSessionMatch && req.method === "DELETE") {
        try {
          return json(await messageQueueRuntime.clear(decodeURIComponent(queueSessionMatch[1])));
        } catch (error) {
          return queueError(error, "failed to clear queue");
        }
      }

      const queueItemActionMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/items\/([^/]+)\/(take)$/);
      if (queueItemActionMatch && req.method === "POST") {
        try {
          return json(await messageQueueRuntime.take(
            decodeURIComponent(queueItemActionMatch[1]),
            decodeURIComponent(queueItemActionMatch[2]),
          ));
        } catch (error) {
          return queueError(error, "failed to take queued message");
        }
      }

      const queueItemDeleteMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/items\/([^/]+)$/);
      if (queueItemDeleteMatch && req.method === "DELETE") {
        try {
          return json(await messageQueueRuntime.remove(
            decodeURIComponent(queueItemDeleteMatch[1]),
            decodeURIComponent(queueItemDeleteMatch[2]),
          ));
        } catch (error) {
          return queueError(error, "failed to remove queued message");
        }
      }

      if (p === "/notifications/stream" && req.method === "GET") {
        return new Response(createOpenChamberNotificationStream(), {
          headers: {
            ...cors,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      // Create session (POST /session)
      if (p === "/session" && req.method === "POST") {
        try {
          const body = asRecord(await readJson(req)) ?? {};
          const location = asRecord(body.location);
          const model = asRecord(body.model);
          const sessionDirectory = typeof location?.directory === "string" ? location.directory : dir;
          // D1: a namespaced model prefix selects the backend for the new
          // session; absent or unknown prefix falls through to the default.
          const requestedProvider = typeof model?.providerID === "string" ? model.providerID : "";
          const prefix = splitProviderPrefix(requestedProvider);
          const backend = (prefix.backendId ? backendById(prefix.backendId) : undefined) ?? defaultBackend();
          const modelID = typeof model?.id === "string" ? model.id : typeof model?.modelID === "string" ? model.modelID : undefined;
          const session = await backend.store.create(sessionDirectory, {
            id: typeof body.id === "string" ? body.id : undefined,
            title: typeof body.title === "string" ? body.title : undefined,
            parentID: typeof body.parentID === "string" ? body.parentID : undefined,
            agent: typeof body.agent === "string" ? body.agent : undefined,
            model: modelID && requestedProvider ? {
              providerID: prefix.native,
              modelID,
              variant: typeof model?.variant === "string" ? model.variant : "default",
            } : undefined,
            metadata: asRecord(body.metadata) ?? undefined,
          });
          emitSessionCreated(session as unknown as Record<string, unknown>, session.directory);
          return json({ data: toV2Session(session) });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "create failed", 500);
        }
      }

      // Experimental session list
      if (p === "/experimental/session" && req.method === "GET") {
        try {
          const roots = url.searchParams.get("roots") === "true";
          const archivedParam = url.searchParams.get("archived");
          const archived = archivedParam === "true" ? true : archivedParam === "false" ? false : undefined;
          const limit = url.searchParams.get("limit");
          const search = url.searchParams.get("search") || url.searchParams.get("query") || url.searchParams.get("q") || undefined;
          const all = roots || url.searchParams.get("all") === "true" || !dir;
          const sessions = await listSessionsAcrossBackends(all ? null : dir, {
            all,
            archived,
            limit: limit != null ? parseInt(limit, 10) : undefined,
            search,
          });
          return json(sessions);
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "list failed", 500);
        }
      }

      // Session list (GET /session)
      if (p === "/session" && req.method === "GET") {
        try {
          const roots = url.searchParams.get("roots") === "true";
          const archivedParam = url.searchParams.get("archived");
          const archived = archivedParam === "true" ? true : archivedParam === "false" ? false : undefined;
          const limit = url.searchParams.get("limit");
          const search = url.searchParams.get("search") || url.searchParams.get("query") || url.searchParams.get("q") || undefined;
          const all = roots || url.searchParams.get("all") === "true" || !dir;
          const sessions = await listSessionsAcrossBackends(all ? null : dir, {
            all,
            archived,
            search,
          });
          const parentID = url.searchParams.get("parentID");
          const filtered = parentID === null
            ? sessions
            : sessions.filter((session) => session.parentID === (parentID === "null" ? undefined : parentID));
          const ordered = [...filtered].sort((a, b) => a.time.updated - b.time.updated);
          const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
          const requestedLimit = limit == null ? 100 : Number.parseInt(limit, 10);
          const pageLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 100;
          const currentPage = page(ordered.map(toV2Session), pageLimit, url.searchParams.get("cursor"), order);
          return json({ data: currentPage.data, cursor: currentPage.cursor });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "list failed", 500);
        }
      }

      // Session status
      if (p === "/session/status" && req.method === "GET") {
        await reconcileSessionStatuses(dir);
        return json(getSessionStatusMap(dir));
      }

      // OpenCode v2 reports the global set of sessions with an active agent
      // loop and uses "running" as its status value.
      if (p === "/session/active" && req.method === "GET") {
        await reconcileSessionStatuses();
        const statuses = getSessionStatusMap();
        return json(Object.fromEntries(Object.keys(statuses).map((sessionID) => [sessionID, { type: "running" }])));
      }

      const sessionMoveMatch = p.match(/^\/session\/([^/]+)\/move$/);
      if (sessionMoveMatch && req.method === "POST") {
        try {
          const sessionID = decodeURIComponent(sessionMoveMatch[1]!);
          const { backend, session } = await resolveSessionRoute(sessionID, dir);
          if (!session) return jsonError("session not found", 404);
          const body = asRecord(await readJson(req));
          if (typeof body?.directory !== "string" || !body.directory.trim()) return jsonError("directory required", 400);
          const moved = await backend.store.move(sessionID, body.directory, session.directory);
          if (!moved) return jsonError("session move failed", 500);
          emitOpenCodeV2Event("session.moved", {
            sessionID,
            projectID: moved.projectID,
            location: { directory: moved.directory },
          }, moved.directory);
          return noContent();
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "session move failed", 500);
        }
      }

      const syntheticMatch = p.match(/^\/session\/([^/]+)\/synthetic$/);
      if (syntheticMatch && req.method === "POST") {
        try {
          const sessionID = decodeURIComponent(syntheticMatch[1]!);
          const { session } = await resolveSessionRoute(sessionID, dir);
          if (!session) return jsonError("session not found", 404);
          const body = asRecord(await readJson(req));
          if (typeof body?.text !== "string") return jsonError("text required", 400);
          const item = addSessionSyntheticContext(sessionID, session.directory, {
            id: typeof body.id === "string" ? body.id : undefined,
            text: body.text,
            description: typeof body.description === "string" ? body.description : undefined,
            metadata: asRecord(body.metadata) ?? undefined,
          });
          return json({ data: item });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "synthetic message failed", 500);
        }
      }

      const sessionModelMatch = p.match(/^\/session\/([^/]+)\/model$/);
      if (sessionModelMatch && req.method === "POST") {
        try {
          const sessionID = decodeURIComponent(sessionModelMatch[1]!);
          const { backend, session } = await resolveSessionRoute(sessionID, dir);
          if (!session) return jsonError("session not found", 404);
          const body = asRecord(await readJson(req));
          const model = asRecord(body?.model);
          const providerID = typeof model?.providerID === "string" ? model.providerID : "";
          const modelID = typeof model?.id === "string" ? model.id : "";
          if (!providerID || !modelID) return jsonError("model providerID and id are required", 400);
          const prefix = splitProviderPrefix(providerID);
          if (prefix.backendId && backendById(prefix.backendId) !== backend) {
            return jsonError("model provider does not belong to this session's backend", 400);
          }
          const modelRef = {
            providerID: prefix.native,
            modelID,
            variant: typeof model?.variant === "string" ? model.variant : "default",
          };
          const updated = await backend.store.update(sessionID, { model: modelRef }, session.directory);
          if (!updated) return jsonError("session not found", 404);
          emitOpenCodeV2Event("session.model.selected", {
            sessionID,
            model: { id: modelID, providerID, variant: modelRef.variant },
          }, session.directory);
          return noContent();
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "model switch failed", 500);
        }
      }

      const sessionAgentMatch = p.match(/^\/session\/([^/]+)\/agent$/);
      if (sessionAgentMatch && req.method === "POST") {
        try {
          const sessionID = decodeURIComponent(sessionAgentMatch[1]!);
          const { backend, session } = await resolveSessionRoute(sessionID, dir);
          if (!session) return jsonError("session not found", 404);
          const body = asRecord(await readJson(req));
          if (typeof body?.agent !== "string" || !body.agent) return jsonError("agent required", 400);
          const previous = session.agent;
          const updated = await backend.store.update(sessionID, { agent: body.agent }, session.directory);
          if (!updated) return jsonError("session not found", 404);
          emitOpenCodeV2Event("session.agent.selected", { sessionID, agent: body.agent, previous }, session.directory);
          return noContent();
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "agent switch failed", 500);
        }
      }

      const sessionFormListMatch = p.match(/^\/session\/([^/]+)\/form$/);
      if (sessionFormListMatch && req.method === "GET") {
        const sessionID = decodeURIComponent(sessionFormListMatch[1]!);
        const forms = listPendingQuestions(dir).filter((request) => request.sessionID === sessionID).map(toOpenCodeFormRequest);
        return json({ data: forms });
      }

      const sessionFormMatch = p.match(/^\/session\/([^/]+)\/form\/([^/]+)$/);
      if (sessionFormMatch && req.method === "GET") {
        const sessionID = decodeURIComponent(sessionFormMatch[1]!);
        const formID = decodeURIComponent(sessionFormMatch[2]!);
        const pending = getPendingQuestion(formID);
        if (!pending || pending.sessionID !== sessionID) return jsonError("form not found", 404);
        return json({ data: { ...toOpenCodeFormRequest(pending), state: { status: "pending" } } });
      }

      if (sessionFormMatch && req.method === "DELETE") {
        const sessionID = decodeURIComponent(sessionFormMatch[1]!);
        const formID = decodeURIComponent(sessionFormMatch[2]!);
        const pending = getPendingQuestion(formID);
        if (!pending || pending.sessionID !== sessionID) return jsonError("form not found", 404);
        return rejectQuestion(formID) ? noContent() : jsonError("form not found", 404);
      }

      // Adapt OpenCode's typed form actions to the sidecar's pending question
      // requests. The pending question id is the form id on the wire.
      const formReplyMatch = p.match(/^\/session\/([^/]+)\/form\/([^/]+)\/reply$/);
      if (formReplyMatch && req.method === "POST") {
        const [, sessionID, formID] = formReplyMatch;
        const pending = getPendingQuestion(formID!);
        if (!pending || pending.sessionID !== sessionID) return jsonError("form not found", 404);
        const body = asRecord(await readJson(req));
        const answer = asRecord(body?.answer);
        if (!answer) return jsonError("answer required", 400);
        const ok = replyQuestion(formID!, toQuestionAnswers(pending, answer));
        return ok ? noContent() : jsonError("form not found", 404);
      }

      const formCancelMatch = p.match(/^\/session\/([^/]+)\/form\/([^/]+)\/cancel$/);
      if (formCancelMatch && req.method === "POST") {
        const [, sessionID, formID] = formCancelMatch;
        const pending = getPendingQuestion(formID!);
        if (!pending || pending.sessionID !== sessionID) return jsonError("form not found", 404);
        const ok = rejectQuestion(formID!);
        return ok ? noContent() : jsonError("form not found", 404);
      }

      // Single session routes: /session/:id
      const sMatch = p.match(/^\/session\/([^/]+)$/);
      if (sMatch) {
        const openCodeId = sMatch[1];
        if (req.method === "GET") {
          try {
            const { session } = await resolveSessionRoute(openCodeId, dir);
            if (!session) return jsonError("session not found", 404);
            return json({ data: toV2Session(session) });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "lookup failed", 500);
        }
      }

      if (req.method === "DELETE") {
        try {
          const { backend, session } = await resolveSessionRoute(openCodeId, dir);
          if (!session) return jsonError("session not found", 404);
          const ok = await backend.store.delete(openCodeId, dir);
          removeSessionState(openCodeId, session.directory);
          emitSessionDeleted(openCodeId);
          return ok ? noContent() : jsonError("session not found", 404);
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "delete failed", 500);
        }
      }

      if (req.method === "PATCH") {
        try {
          const body = (await readJson(req)) as {
            title?: string;
            metadata?: Record<string, unknown>;
            time?: { archived?: number | null };
          } | undefined;
          const { backend } = await resolveSessionRoute(openCodeId, dir);
          const updated = await backend.store.update(
            openCodeId,
            { title: body?.title, metadata: body?.metadata, time: body?.time },
            dir,
          );
          if (!updated) return jsonError("session not found", 404);
          return noContent();
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "update failed", 500);
        }
      }
    }

    // Goal objective endpoints
    const goalObjMatch = p.match(/^\/(?:api\/)?goals\/objective\/([^/]+)$/);
    if (goalObjMatch) {
      const sessionId = decodeURIComponent(goalObjMatch[1]);
      const home = Bun.env.HOME || process.env.HOME || "/tmp";
      const ocDataDir = Bun.env.OPENCHAMBER_DATA_DIR || process.env.OPENCHAMBER_DATA_DIR;
      const ocGoalsDir = ocDataDir ? join(ocDataDir, "goals") : join(home, ".config", "openchamber", "goals");
      const ompGoalsDir = join(home, ".omp", "goals");

      const ocGoalPath = join(ocGoalsDir, `${sessionId}.md`);
      const ompGoalPath = join(ompGoalsDir, `${sessionId}.txt`);

      if (req.method === "PUT") {
        try {
          await mkdir(ocGoalsDir, { recursive: true });
          await mkdir(ompGoalsDir, { recursive: true });
          const body = (await readJson(req)) as { content?: string } | undefined;
          const text = body?.content ?? "";
          await Bun.write(ocGoalPath, text);
          await Bun.write(ompGoalPath, text);
          return json({ ok: true });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "failed to write objective", 500);
        }
      }

      if (req.method === "GET") {
        try {
          const ocFile = Bun.file(ocGoalPath);
          if (await ocFile.exists()) {
            const content = await ocFile.text();
            return json({ content });
          }
          const ompFile = Bun.file(ompGoalPath);
          if (await ompFile.exists()) {
            const content = await ompFile.text();
            return json({ content });
          }
          return jsonError("objective not found", 404);
        } catch {
          return jsonError("objective not found", 404);
        }
      }

      if (req.method === "DELETE") {
        try {
          await unlink(ocGoalPath).catch(() => {});
          await unlink(ompGoalPath).catch(() => {});
        } catch {
          // ignore
        }
        return json({ ok: true });
      }
    }

    // Session todos
    const todoMatch = p.match(/^\/session\/([^/]+)\/todo$/);
    if (todoMatch && req.method === "GET") {
      try {
        const { backend, session } = await resolveSessionRoute(todoMatch[1], dir);
        if (!session) return jsonError("session not found", 404);
        if (!backend.capabilities.todo) return json([]);
        const todos = await withOmpRpc(session.directory, async (conn) => {
          const raw = (await conn.request("get_state", {})) as Record<string, unknown>;
          return extractTodosFromOmpDetails({ todoPhases: raw?.todoPhases }) ?? [];
        }).catch(() => []);
        return json(todos);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "todo failed", 500);
      }
    }

    // Session children (subagents)
    const childrenMatch = p.match(/^\/session\/([^/]+)\/children$/);
    if (childrenMatch && req.method === "GET") {
      try {
        const children = await backendForSession(childrenMatch[1]).store.children(childrenMatch[1], dir);
        return json(children);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "children failed", 500);
      }
    }

    // Session fork
    const forkMatch = p.match(/^\/session\/([^/]+)\/fork$/);
    if (forkMatch && req.method === "POST") {
      try {
        const { backend, session } = await resolveSessionRoute(forkMatch[1], dir);
        if (!session) return jsonError("session not found", 404);
        const body = asRecord(await readJson(req));
        const before = typeof body?.before === "string" ? body.before : undefined;
        const forked = await backend.store.fork(forkMatch[1]!, session.directory, before);
        if (!forked) return jsonError(before ? "fork boundary not found" : "session fork failed", before ? 404 : 500);
        emitSessionCreated(forked as unknown as Record<string, unknown>, forked.directory);
        return json({ data: toV2Session(forked) });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "fork failed", 500);
      }
    }

    const revertStageMatch = p.match(/^\/session\/([^/]+)\/revert\/stage$/);
    if (revertStageMatch && req.method === "POST") {
      try {
        const sessionID = decodeURIComponent(revertStageMatch[1]!);
        const { backend, session } = await resolveSessionRoute(sessionID, dir);
        if (!session) return jsonError("session not found", 404);
        const body = asRecord(await readJson(req));
        if (typeof body?.messageID !== "string") return jsonError("messageID required", 400);
        const revert = { messageID: body.messageID };
        const updated = await backend.store.update(sessionID, { revert }, session.directory);
        if (!updated) return jsonError("session not found", 404);
        emitOpenCodeV2Event("session.revert.staged", { sessionID, revert }, session.directory);
        return json({ data: revert });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "revert stage failed", 500);
      }
    }

    const revertClearMatch = p.match(/^\/session\/([^/]+)\/revert$/);
    if (revertClearMatch && req.method === "DELETE") {
      try {
        const sessionID = decodeURIComponent(revertClearMatch[1]!);
        const { backend, session } = await resolveSessionRoute(sessionID, dir);
        if (!session) return jsonError("session not found", 404);
        const updated = await backend.store.update(sessionID, { revert: null }, session.directory);
        if (!updated) return jsonError("session not found", 404);
        emitOpenCodeV2Event("session.revert.cleared", { sessionID }, session.directory);
        return noContent();
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "revert clear failed", 500);
      }
    }

    const revertCommitMatch = p.match(/^\/session\/([^/]+)\/revert\/commit$/);
    if (revertCommitMatch && req.method === "POST") {
      try {
        const sessionID = decodeURIComponent(revertCommitMatch[1]!);
        const { backend, session } = await resolveSessionRoute(sessionID, dir);
        if (!session) return jsonError("session not found", 404);
        const target = session.revert?.messageID;
        if (!target) return jsonError("no staged revert", 409);
        const committed = await backend.store.commitRevert(sessionID, target, session.directory);
        if (!committed) return jsonError("revert boundary not found", 404);
        emitOpenCodeV2Event("session.revert.committed", { sessionID, to: target }, session.directory);
        const updated = await backend.store.get(sessionID, session.directory);
        if (updated) {
          emitOpenCodeV2Event("session.usage.updated", {
            sessionID,
            cost: updated.cost,
            tokens: updated.tokens,
          }, session.directory);
        }
        return noContent();
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "revert commit failed", 500);
      }
    }

    // Session summarize / compact
    const compactMatch = p.match(/^(?:\/api)?\/session\/([^/]+)\/(?:summarize|compact)$/);
    if (compactMatch && req.method === "POST") {
      try {
        const { backend, session } = await resolveSessionRoute(compactMatch[1], dir);
        if (!session) return jsonError("session not found", 404);
        if (!backend.capabilities.compact) return jsonError("summarize not supported by backend", 501);
        let usedPersistentConnection = false;
        try {
          usedPersistentConnection = await compactSession(session.id, session.directory);
        } catch {
          // Preserve the legacy best-effort compact behavior when the current
          // persistent child rejects the RPC; do not fall back to ambient auth.
          usedPersistentConnection = true;
        }
        if (!usedPersistentConnection) {
          await withOmpRpc(session.directory, async (conn) => {
            await conn.request("compact", {});
          }).catch(() => {});
        }
        invalidateMessageCache(session.id, session.directory);
        emitSessionCompacted(session.id, session.directory);
        const body = asRecord(await readJson(req));
        const message = {
          id: typeof body?.id === "string" ? body.id : randomUUID(),
          sessionID: session.id,
          time: { created: Date.now() },
          type: "compaction",
          payload: {},
          delivery: body?.delivery === "steer" ? "steer" : "queue",
        };
        return json({ data: message });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "summarize failed", 500);
      }
    }

    // Session revert & unrevert
    const revertMatch = p.match(/^\/session\/([^/]+)\/(revert|unrevert)$/);
    if (revertMatch && req.method === "POST") {
      try {
        const { session } = await resolveSessionRoute(revertMatch[1], dir);
        if (!session) return jsonError("session not found", 404);
        return json(session);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "revert failed", 500);
      }
    }

    // Session command
    const cmdMatch = p.match(/^\/session\/([^/]+)\/command$/);
    if (cmdMatch && req.method === "POST") {
      try {
        const openCodeId = cmdMatch[1];
        const body = asRecord(await readJson(req));
        const { session } = await resolveSessionRoute(openCodeId, dir);
        if (!session) return jsonError("session not found", 404);
        const command = typeof body?.name === "string" ? body.name : typeof body?.command === "string" ? body.command : "";
        const argumentsText = typeof body?.text === "string" ? body.text : typeof body?.arguments === "string" ? body.arguments : "";
        const commandText = `/${command}${argumentsText ? ` ${argumentsText}` : ""}`.trim();
        const result = await promptSessionAsync(openCodeId, session.directory, session.path, {
          id: typeof body?.id === "string" ? body.id : undefined,
          text: commandText,
          files: Array.isArray(body?.files) ? body.files : undefined,
          agents: Array.isArray(body?.agents) ? body.agents : undefined,
          skills: Array.isArray(body?.skills) ? body.skills : undefined,
          delivery: body?.delivery === "steer" ? "steer" : body?.delivery === "queue" ? "queue" : undefined,
        });
        if (result.queued) return noContent();
        return jsonError(result.error ?? "command failed", result.status ?? 400);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "command failed", 500);
      }
    }

    // Session shell
    const shellMatch = p.match(/^\/session\/([^/]+)\/shell$/);
    if (shellMatch && req.method === "POST") {
      try {
        const openCodeId = shellMatch[1];
        const { backend, session } = await resolveSessionRoute(openCodeId, dir);
        if (!session) return jsonError("session not found", 404);
        if (!backend.capabilities.shell) return jsonError("shell not supported by backend", 400);
        const body = asRecord(await readJson(req));
        const command = typeof body?.command === "string" ? body.command : "";
        const shellID = typeof body?.id === "string" && body.id ? body.id : randomUUID();
        const started = Date.now();
        const shell = {
          id: shellID,
          status: "running" as const,
          command,
          cwd: session.directory,
          shell: "bash",
          file: "/bin/bash",
          metadata: {},
          time: { started },
        };
        emitOpenCodeV2Event("session.shell.started", { sessionID: openCodeId, shell }, session.directory);
        let rawOutput: unknown;
        try {
          rawOutput = await withOmpRpc(session.directory, async (conn) => conn.request("bash", { command }));
        } catch (err) {
          rawOutput = String(err);
        }
        const outputRecord = asRecord(rawOutput);
        const outputText = typeof rawOutput === "string"
          ? rawOutput
          : typeof outputRecord.output === "string"
            ? outputRecord.output
            : rawOutput == null ? "" : JSON.stringify(rawOutput);
        const exit = typeof outputRecord.exitCode === "number"
          ? outputRecord.exitCode
          : typeof outputRecord.exit === "number" ? outputRecord.exit : undefined;
        const completed = Date.now();
        const endedShell = {
          ...shell,
          status: "exited" as const,
          ...(exit !== undefined ? { exit } : {}),
          time: { started, completed },
        };
        emitOpenCodeV2Event("session.shell.ended", {
          sessionID: openCodeId,
          shell: endedShell,
          output: { output: outputText, cursor: outputText.length, size: outputText.length, truncated: false },
        }, session.directory);
        logger.debug({ sessionID: openCodeId, output: outputText.slice(0, 200) }, "shell command completed");
        return noContent();
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "shell failed", 500);
      }
    }

    // Session messages
    const msgMatch = p.match(/^\/session\/([^/]+)\/message$/);
    if (msgMatch && req.method === "GET") {
      try {
        const { backend, session } = await resolveSessionRoute(msgMatch[1], dir);
        if (!session) return jsonError("session not found", 404);
        const messages = await backend.store.transcript(msgMatch[1], session.directory);
        if (messages == null) return jsonError("load failed", 500);
        const ordered = [...messages]
          .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))
          .map(toV2Message);
        const requestedLimit = url.searchParams.get("limit");
        const parsedLimit = requestedLimit == null ? 100 : Number.parseInt(requestedLimit, 10);
        const pageLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 500)) : 100;
        const order = !url.searchParams.get("cursor") && url.searchParams.get("order") === "asc" ? "asc" : "desc";
        const currentPage = page(ordered, pageLimit, url.searchParams.get("cursor"), order);
        return json({ data: currentPage.data, cursor: currentPage.cursor });
      } catch (err) {
        if (err instanceof MissingWorkingDirectoryError) {
          return json({ error: err.message, reason: err.reason, cwd: err.cwd }, { status: err.statusCode });
        }
        return jsonError(err instanceof Error ? err.message : "load failed", 500);
      }
    }

    const messageGetMatch = p.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
    if (messageGetMatch && req.method === "GET") {
      try {
        const sessionID = decodeURIComponent(messageGetMatch[1]!);
        const messageID = decodeURIComponent(messageGetMatch[2]!);
        const { backend, session } = await resolveSessionRoute(sessionID, dir);
        if (!session) return jsonError("session not found", 404);
        const messages = await backend.store.transcript(sessionID, session.directory);
        const message = messages?.find((entry) => entry.info.id === messageID);
        if (!message) return jsonError("message not found", 404);
        return json({ data: toV2Message(message) });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "message lookup failed", 500);
      }
    }

    const sessionContextMatch = p.match(/^\/session\/([^/]+)\/context$/);
    if (sessionContextMatch && req.method === "GET") {
      try {
        const sessionID = decodeURIComponent(sessionContextMatch[1]!);
        const { backend, session } = await resolveSessionRoute(sessionID, dir);
        if (!session) return jsonError("session not found", 404);
        const messages = await backend.store.transcript(sessionID, session.directory);
        if (messages == null) return jsonError("load failed", 500);
        return json({ data: messages.map(toV2Message) });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "context lookup failed", 500);
      }
    }

    const sessionDiffMatch = p.match(/^\/session\/([^/]+)\/diff$/);
    if (sessionDiffMatch && req.method === "GET") {
      const sessionID = decodeURIComponent(sessionDiffMatch[1]!);
      const { session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const rawContext = Number.parseInt(url.searchParams.get("context") ?? "3", 10);
      const context = Number.isFinite(rawContext) ? Math.max(0, Math.min(20, rawContext)) : 3;
      try {
        const proc = Bun.spawn(["git", "-C", session.directory, "diff", "--no-ext-diff", "--no-color", `--unified=${context}`, "HEAD", "--"], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const patch = await new Response(proc.stdout).text();
        await proc.exited;
        const diffs = patch.split(/^diff --git /m).slice(1).map((chunk) => {
          const fullPatch = `diff --git ${chunk}`;
          const header = fullPatch.slice(0, fullPatch.indexOf("\n"));
          const headerMatch = header.match(/^diff --git a\/(.+) b\/(.+)$/);
          const deleted = fullPatch.includes("deleted file mode ");
          const added = fullPatch.includes("new file mode ");
          const file = headerMatch?.[2] ?? headerMatch?.[1] ?? header.replace(/^diff --git /, "");
          return {
            file,
            patch: fullPatch,
            additions: fullPatch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++" )).length,
            deletions: fullPatch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---" )).length,
            status: added ? "added" as const : deleted ? "deleted" as const : "modified" as const,
          };
        });
        return json({ data: diffs });
      } catch {
        return json({ data: [] });
      }
    }

    const sessionGenerateMatch = p.match(/^\/session\/([^/]+)\/generate$/);
    if (sessionGenerateMatch && req.method === "POST") {
      try {
        const sessionID = decodeURIComponent(sessionGenerateMatch[1]!);
        const { backend, session } = await resolveSessionRoute(sessionID, dir);
        if (!session) return jsonError("session not found", 404);
        const body = asRecord(await readJson(req));
        if (typeof body?.prompt !== "string" || !body.prompt.trim()) return jsonError("prompt required", 400);
        const messages = await backend.store.transcript(sessionID, session.directory);
        const history = (messages ?? []).slice(-20).map((message) => {
          const role = message.info.role === "user" ? "User" : message.info.role === "assistant" ? "Assistant" : "";
          if (!role) return "";
          const content = (message.parts ?? []).filter((part) => part.type === "text" || part.type === "reasoning")
            .map((part) => part.text).join("\n").trim();
          return content ? `${role}: ${content}` : "";
        }).filter(Boolean).join("\n\n").slice(-48_000);
        const prompt = [history ? `Conversation context:\n${history}` : "", body.prompt].filter(Boolean).join("\n\n");
        let generated;
        try {
          generated = await generateSmallModelText({
            prompt,
            maxOutputTokens: 1200,
            preferredProviderID: session.model.providerID,
            preferredModelID: session.model.modelID,
            directory: session.directory,
          });
        } catch {
          generated = await generateSmallModelText({ prompt, maxOutputTokens: 1200, directory: session.directory });
        }
        return json({ data: { text: generated.text } });
      } catch (err) {
        const status = typeof (err as { statusCode?: unknown })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 500;
        return jsonError(err instanceof Error ? err.message : "session generation failed", status);
      }
    }

    if (p === "/generate/text" && req.method === "POST") {
      try {
        const body = asRecord(await readJson(req));
        if (typeof body?.prompt !== "string" || !body.prompt.trim()) return jsonError("prompt required", 400);
        const model = asRecord(body.model);
        const selection = splitProviderPrefix(typeof model?.providerID === "string" ? model.providerID : "");
        const generated = await generateSmallModelText({
          prompt: body.prompt,
          directory: dir ?? process.cwd(),
          preferredProviderID: selection.native || undefined,
          preferredModelID: typeof model?.id === "string" ? model.id : undefined,
        });
        return json({ data: { text: generated.text } });
      } catch (err) {
        const status = typeof (err as { statusCode?: unknown })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 500;
        return jsonError(err instanceof Error ? err.message : "text generation failed", status);
      }
    }

    const promptMatch = p.match(/^\/session\/([^/]+)\/prompt$/);
    if (promptMatch && req.method === "POST") {
      try {
        const sessionID = decodeURIComponent(promptMatch[1]!);
        const body = await readJson(req);
        const input = asRecord(body);
        const { session } = await resolveSessionRoute(sessionID, dir);
        if (!session) return jsonError("session not found", 404);
        const result = await promptSessionAsync(sessionID, session.directory, session.path, body);
        if (!result.queued) return jsonError(result.error ?? "prompt failed", result.status ?? 400);
        const files = Array.isArray(input?.files) ? input.files.flatMap((entry) => {
          const file = asRecord(entry);
          if (typeof file?.uri !== "string") return [];
          return [toV2FileAttachment({
            uri: file.uri,
            mime: mimeFromPath(typeof file.name === "string" ? file.name : file.uri) ?? undefined,
            ...(typeof file.name === "string" ? { name: file.name } : {}),
            ...(typeof file.description === "string" ? { description: file.description } : {}),
            ...(asRecord(file.mention) ? { mention: file.mention as { start: number; end: number; text: string } } : {}),
          })];
        }) : [];
        const delivery = input?.delivery === "steer" ? "steer" : "queue";
        const message = {
          id: result.messageID ?? (typeof input?.id === "string" ? input.id : randomUUID()),
          sessionID,
          time: { created: Date.now() },
          type: "user",
          payload: {
            text: typeof input?.text === "string" ? input.text : "",
            ...(files.length ? { files } : {}),
            ...(Array.isArray(input?.agents) ? { agents: input.agents } : {}),
            ...(Array.isArray(input?.skills) ? { skills: input.skills } : {}),
            ...(asRecord(input?.metadata) ? { metadata: input.metadata } : {}),
          },
          delivery,
        };
        return json({ data: message });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "prompt failed", 500);
      }
    }

    // Prompt async
    const promptAsyncMatch = p.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (promptAsyncMatch && req.method === "POST") {
      try {
        const openCodeId = promptAsyncMatch[1];
        const body = await readJson(req);
        const { session } = await resolveSessionRoute(openCodeId, dir);
        if (!session) return jsonError("session not found", 404);
        const result = await promptSessionAsync(openCodeId, session.directory, session.path, body);
        if (result.queued) return json({ queued: true });
        return jsonError(result.error ?? "prompt failed", result.status ?? 400);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "prompt failed", 500);
      }
    }

    // Legacy prompt via POST /session/:id/message
    if (msgMatch && req.method === "POST") {
      try {
        const openCodeId = msgMatch[1];
        const body = await readJson(req);
        const { session } = await resolveSessionRoute(openCodeId, dir);
        if (!session) return jsonError("session not found", 404);
        const result = await promptSessionAsync(openCodeId, session.directory, session.path, body);
        if (result.queued) return json({ queued: true });
        return jsonError(result.error ?? "prompt failed", result.status ?? 400);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "prompt failed", 500);
      }
    }

    const interruptMatch = p.match(/^\/session\/([^/]+)\/interrupt$/);
    if (interruptMatch && req.method === "POST") {
      try {
        const sessionID = decodeURIComponent(interruptMatch[1]!);
        const { session } = await resolveSessionRoute(sessionID, dir);
        const interrupted = session ? await abortSession(sessionID, session.directory) : false;
        return json({ interrupted });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "interrupt failed", 500);
      }
    }

    // Legacy abort route
    const abortMatch = p.match(/^\/session\/([^/]+)\/abort$/);
    if (abortMatch && req.method === "POST") {
      try {
        const { session } = await resolveSessionRoute(abortMatch[1], dir);
        const ok = session ? await abortSession(abortMatch[1], session.directory) : false;
        return json(ok);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "abort failed", 500);
      }
    }

    // Provider list / auth / sources
    if (p === "/provider/auth" && req.method === "GET") {
      return json({});
    }

    if (p.startsWith("/provider/") && p.endsWith("/source") && req.method === "GET") {
      return json({
        auth: { exists: true, path: null },
        user: { exists: false, path: null },
        project: { exists: false, path: null },
      });
    }

    if (p === "/provider" && req.method === "GET") {
      try {
        const cwd = dir ?? process.cwd();
        const providersData = await fetchProvidersForDirectory(cwd);
        const providers = providersData.providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          activation: "enabled" as const,
          package: "omp",
        }));
        return json({ location: { directory: cwd }, data: providers });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "provider list failed", 500);
      }
    }

    const providerMatch = p.match(/^\/provider\/([^/]+)$/);
    if (providerMatch && req.method === "GET") {
      try {
        const cwd = dir ?? process.cwd();
        const providerID = decodeURIComponent(providerMatch[1]!);
        const providersData = await fetchProvidersForDirectory(cwd);
        const provider = providersData.providers.find((entry) => entry.id === providerID);
        if (!provider) return jsonError("provider not found", 404);
        return json({
          location: { directory: cwd },
          data: { id: provider.id, name: provider.name, activation: "enabled", package: "omp" },
        });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "provider lookup failed", 500);
      }
    }

    if (p === "/providers" && req.method === "GET") {
      try {
        const cwd = dir ?? process.cwd();
        const providersData = await fetchProvidersForDirectory(cwd);
        return json({
          all: providersData.providers.map((provider) => ({ id: provider.id, name: provider.name })),
          default: providersData.default,
          connected: providersData.providers.map((provider) => provider.id),
          providers: providersData.providers,
        });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "provider list failed", 500);
      }
    }

    // Providers
    if (p === "/config/providers" && req.method === "GET") {
      try {
        const cwd = dir ?? process.cwd();
        const response = await fetchProvidersForDirectory(cwd);
        return json(response);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "providers failed", 500);
      }
    }

    // Opt-in caller-owned provider catalog. The legacy GET above continues to
    // use OMP's normal host-local configuration. A POST is intentionally
    // separate so credentials can never silently alter that behavior.
    if (p === "/config/providers" && req.method === "POST") {
      try {
        const body = asRecord(await readJson(req));
        const hasCredentials = body?.credentials !== undefined;
        const hasCredentialRef = body?.credentialRef !== undefined;
        if (hasCredentials === hasCredentialRef) {
          return jsonError("provide exactly one of credentials or credentialRef", 400);
        }

        const model = asRecord(body?.model);
        const requestedProviderID = typeof model?.providerID === "string" ? model.providerID : undefined;
        const requestedModelID = typeof model?.modelID === "string" ? model.modelID : undefined;
        const providerSelection = requestedProviderID ? splitProviderPrefix(requestedProviderID) : undefined;
        const selectedBackend = providerSelection?.backendId
          ? backendById(providerSelection.backendId)
          : defaultBackend();
        if (!selectedBackend) return jsonError("unknown model backend", 400);

        const auth: BackendCredentialInput = hasCredentials
          ? {
              credentials: body?.credentials as BackendCredentialInput["credentials"],
              selectedProviderID: providerSelection?.native,
              selectedModelID: requestedModelID,
            }
          : {
              credentialRef: body?.credentialRef as string,
              selectedProviderID: providerSelection?.native,
              selectedModelID: requestedModelID,
            };
        const response = await selectedBackend.listModels(dir ?? process.cwd(), auth);
        return json(response);
      } catch (err) {
        if (err instanceof CredentialInputError) return jsonError(err.message, err.statusCode);
        return jsonError(err instanceof Error ? err.message : "providers failed", 500);
      }
    }

    // OpenCode v2 exposes a flat model list alongside the provider catalog.
    // The sidecar's existing catalog is grouped by provider; keep the wire
    // model shape and normalize provider ids for multi-backend mode.
    if (p === "/model" && req.method === "GET") {
      try {
        const providersData = await fetchProvidersForDirectory(dir ?? process.cwd());
        const models = providersData.providers.flatMap((provider) =>
          Object.values(provider.models).map((model) => toV2ModelInfo(model, provider.id)),
        );
        return json({ location: { directory: dir ?? process.cwd() }, data: models });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "model list failed", 500);
      }
    }

    // listModels orders the current provider and model first, so the model at
    // the head of the configured default provider is the active default.
    if (p === "/model/default" && req.method === "GET") {
      try {
        const providersData = await fetchProvidersForDirectory(dir ?? process.cwd());
        const provider = providersData.providers.find((entry) => entry.id === providersData.default.default);
        if (!provider) return json({ location: { directory: dir ?? process.cwd() }, data: null });
        const model = Object.values(provider.models)[0];
        return json({
          location: { directory: dir ?? process.cwd() },
          data: model ? toV2ModelInfo(model, provider.id) : null,
        });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "default model lookup failed", 500);
      }
    }

    // File content / file listing / find file
    if (p === "/file/content" && req.method === "GET") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return jsonError("path parameter required", 400);
      try {
        const fullPath = isAbsolute(filePath) ? filePath : join(effectiveDir, filePath);
        const file = Bun.file(fullPath);
        if (!(await file.exists())) return jsonError("file not found", 404);
        const content = await file.text();
        return json({ content, path: filePath });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "file read failed", 500);
      }
    }

    if (p === "/file" && req.method === "GET") {
      const relPath = url.searchParams.get("path") ?? "";
      try {
        const targetDir = isAbsolute(relPath) ? relPath : join(effectiveDir, relPath);
        const entries = await readdir(targetDir, { withFileTypes: true });
        const list = entries.map((e) => ({
          type: e.isDirectory() ? "directory" : "file",
          path: join(relPath, e.name).replace(/\\/g, "/"),
        }));
        return json({ location: { directory: effectiveDir }, data: list });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "readdir failed", 500);
      }
    }

    if (p === "/find/file" && req.method === "GET") {
      const query = url.searchParams.get("query") ?? "";
      const requestedType = url.searchParams.get("type");
      const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 50;
      try {
        const entries = await readdir(effectiveDir, { recursive: true, withFileTypes: true });
        const matches = entries
          .map((entry) => {
            const raw = entry as typeof entry & { parentPath?: string; path?: string };
            const parent = raw.parentPath ?? raw.path ?? effectiveDir;
            const absolutePath = join(parent, entry.name);
            const path = absolutePath.startsWith(`${effectiveDir}/`)
              ? absolutePath.slice(effectiveDir.length + 1)
              : entry.name;
            return { path: path.replace(/\\/g, "/"), type: entry.isDirectory() ? "directory" as const : "file" as const };
          })
          .filter((entry) => (!requestedType || entry.type === requestedType) &&
            (!query || entry.path.toLowerCase().includes(query.toLowerCase())))
          .slice(0, limit);
        return json({ location: { directory: effectiveDir }, data: matches });
      } catch {
        return json({ location: { directory: effectiveDir }, data: [] });
      }
    }

    // Agent catalog
    if (p === "/agent" && req.method === "GET") {
      return json({ location: { directory: dir ?? process.cwd() }, data: [toV2Agent()] });
    }

    // Config
    if ((p === "/config" || p === "/global/config") && req.method === "GET") {
      return p === "/config"
        ? json(toV2ConfigEntries(effectiveDir))
        : json(readOmpConfig(effectiveDir));
    }

    if (
      (p === "/config" || p === "/global/config") &&
      (req.method === "PATCH" || req.method === "POST" || req.method === "PUT")
    ) {
      const updates = (await readJson(req)) as Record<string, unknown> | undefined;
      const updated = writeOmpConfig(updates && typeof updates === "object" ? updates : {});
      return json(updated);
    }

    // Project
    if ((p === "/project" || p === "/api/projects" || p === "/api/project") && req.method === "GET") {
      return json([
        {
          id: "global",
          canonical: effectiveDir,
          name: basename(effectiveDir),
          time: { created: Date.now(), updated: Date.now() },
          sandboxes: [],
        },
      ]);
    }

    if ((p === "/project/current" || p === "/api/project/current") && req.method === "GET") {
      return json({
        id: "global",
        worktree: effectiveDir,
        path: effectiveDir,
        directory: effectiveDir,
        label: "Project",
        time: { created: Date.now(), updated: Date.now() },
      });
    }

    if (p === "/location" && req.method === "GET") {
      return json({
        directory: effectiveDir,
        project: {
          id: "global",
          directory: effectiveDir,
          canonical: effectiveDir,
        },
      });
    }

    // Path
    if (p === "/path" && req.method === "GET") {
      const home = Bun.env.HOME || "";
      return json({
        home,
        state: effectiveDir,
        config: effectiveDir,
        worktree: effectiveDir,
        directory: effectiveDir,
      });
    }

    // Commands
    if (p === "/command" && req.method === "GET") {
      const cmds = await listAvailableCommands(dir);
      return json({
        location: { directory: effectiveDir },
        data: cmds.map(({ name, description }) => ({ name, ...(description ? { description } : {}) })),
      });
    }

    // Skill
    if (p === "/skill" && req.method === "GET") {
      const skills = await listAvailableSkills(dir);
      const data = await Promise.all(skills.map(async (skill) => ({
        id: skill.name,
        name: skill.name,
        description: skill.description,
        path: skill.path,
        content: await Bun.file(skill.path).text().catch(() => ""),
      })));
      return json({ location: { directory: effectiveDir }, data });
    }

    // MCP
    if (p === "/mcp" && req.method === "GET") {
      return json({ location: { directory: effectiveDir }, data: [] });
    }

    // LSP
    if (p === "/lsp" && req.method === "GET") return json([]);

    // VCS
    if (p === "/vcs" && req.method === "GET") {
      return json({ location: { directory: dir ?? process.cwd() }, data: { branch: { current: "main", default: "main" } } });
    }

    // Questions & Permissions
    if (p === "/form" && req.method === "GET") {
      return json({ location: { directory: dir ?? process.cwd() }, data: listPendingQuestions(dir).map(toOpenCodeFormRequest) });
    }

    if (p === "/permission/request" && req.method === "GET") {
      return json({ location: { directory: dir ?? process.cwd() }, data: listPendingPermissions(dir).map(toOpenCodePermissionRequest) });
    }

    const sessionPermissionMatch = p.match(/^\/session\/([^/]+)\/permission(?:\/([^/]+)(?:\/reply)?)?$/);
    if (sessionPermissionMatch) {
      const sessionID = decodeURIComponent(sessionPermissionMatch[1]!);
      const requestID = sessionPermissionMatch[2] ? decodeURIComponent(sessionPermissionMatch[2]) : undefined;
      const isReply = p.endsWith("/reply");
      const { session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);

      if (!requestID && req.method === "GET") {
        return json({ data: listPendingPermissions(session.directory)
          .filter((request) => request.sessionID === sessionID)
          .map(toOpenCodePermissionRequest) });
      }
      if (!requestID && req.method === "POST") {
        const body = asRecord(await readJson(req));
        if (typeof body?.action !== "string" || !Array.isArray(body.resources)) return jsonError("action and resources are required", 400);
        const id = typeof body.id === "string" ? body.id : randomUUID();
        return json({ data: { id, effect: "ask" } });
      }
      if (requestID && req.method === "GET" && !isReply) {
        const request = getPendingPermission(requestID);
        if (!request || request.sessionID !== sessionID) return jsonError("permission not found", 404);
        return json({ data: toOpenCodePermissionRequest(request) });
      }
      if (requestID && req.method === "POST" && isReply) {
        const body = asRecord(await readJson(req));
        const decision = body?.decision === "always" || body?.decision === "reject" ? body.decision : "once";
        const request = getPendingPermission(requestID);
        if (!request || request.sessionID !== sessionID) return jsonError("permission not found", 404);
        const ok = replyPermission(requestID, decision);
        if (!ok) return jsonError("permission not found", 404);
        emitPermissionReplied(sessionID, requestID, decision, session.directory);
        return noContent();
      }
    }

    if (p === "/permission" && req.method === "GET") {
      return json(listPendingPermissions(dir));
    }

    const permReplyMatch = p.match(/^\/permission\/([^/]+)\/reply$/);
    if (permReplyMatch && req.method === "POST") {
      const id = permReplyMatch[1];
      const body = (await readJson(req)) as { reply?: "once" | "always" | "reject"; decision?: "once" | "always" | "reject"; message?: string } | undefined;
      const reply = body?.decision ?? body?.reply ?? "once";
      const perm = getPendingPermission(id);
      const ok = replyPermission(id, reply);
      if (ok && perm) {
        emitPermissionReplied(perm.sessionID, id, reply, perm.directory);
      }
      return json(ok);
    }

    if (p === "/question" && req.method === "GET") {
      return json(listPendingQuestions(dir));
    }

    const qReplyMatch = p.match(/^\/question\/([^/]+)\/reply$/);
    if (qReplyMatch && req.method === "POST") {
      const id = qReplyMatch[1];
      const body = (await readJson(req)) as { answers?: string[][] } | undefined;
      const q = getPendingQuestion(id);
      const ok = replyQuestion(id, body?.answers ?? []);
      if (ok && q) {
        emitQuestionReplied(q.sessionID, id, body?.answers ?? [], q.directory);
      }
      return json(ok);
    }

    const qRejectMatch = p.match(/^\/question\/([^/]+)\/reject$/);
    if (qRejectMatch && req.method === "POST") {
      const id = qRejectMatch[1];
      const q = getPendingQuestion(id);
      const ok = rejectQuestion(id);
      if (ok && q) {
        emitQuestionRejected(q.sessionID, id, q.directory);
      }
      return json(ok);
    }

    // Message sent acknowledgement (push notifications / activity tracking)
    const msgSentMatch = p.match(/^\/(?:api\/)?sessions\/([^/]+)\/message-sent$/);
    if (msgSentMatch && req.method === "POST") {
      const sessionId = msgSentMatch[1];
      return json({ success: true, sessionId, messageSent: true });
    }

    // Notification auto-accept
    if ((p === "/api/notifications/auto-accept" || p === "/notifications/auto-accept") && req.method === "POST") {
      return json({ success: true });
    }

    // System info (About dialog)
    if (path === "/api/system/info" || path === "/system/info") {
      return json({
        version: "1.20.0",
        platform: process.platform,
        arch: process.arch,
        runtime: "omp-sidecar",
        node: process.version,
        bun: Bun.version,
      });
    }

    // Behavior AGENTS.md editor
    if (path === "/api/behavior/agents-md" || path === "/behavior/agents-md") {
      const checkDir = url.searchParams.get("directory") || effectiveDir;
      const agentsMdPath = join(checkDir, "AGENTS.md");
      const exists = existsSync(agentsMdPath);
      if (req.method === "GET") {
        let content = "";
        if (exists) {
          try {
            content = readFileSync(agentsMdPath, "utf8");
          } catch {
            // ignore
          }
        }
        return json({ exists, content, path: agentsMdPath });
      }
      if (req.method === "POST" || req.method === "PUT") {
        const body = (await readJson(req)) as { content?: string } | undefined;
        try {
          writeFileSync(agentsMdPath, body?.content ?? "");
          return json({ exists: true, content: body?.content ?? "", path: agentsMdPath });
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : "write failed", 500);
        }
      }
    }

    // Config reload
    if (path === "/api/config/reload" || path === "/config/reload") {
      providerCache.clear();
      globalProviderCache = null;
      return json({ success: true });
    }

    // Project icons
    if (path.startsWith("/api/projects/") && path.includes("/icon")) {
      return json({ icon: null, discovered: null });
    }

    // Magic prompts
    if (path === "/api/magic-prompts" || path.startsWith("/api/magic-prompts/")) {
      if (req.method === "GET") return json([]);
      return json({ success: true });
    }

    // Scheduled tasks & cron loops
    if (path.includes("/scheduled-tasks")) {
      if (path.endsWith("/status")) return json({ running: false, tasks: [] });
      if (req.method === "GET") return json([]);
      return json({ success: true });
    }

    // Small model: OpenChamber's override picker filters the provider catalog
    // (served at /config/providers) by this allow-list, so the IDs must be the
    // same OpenCode-mapped IDs.
    if (path === "/api/small-model") {
      if (req.method !== "GET") return jsonError("method not allowed", 405);
      try {
        const providersData = await fetchProvidersForDirectory(effectiveDir);
        const seen: Record<string, true> = {};
        const authenticatedProviders: string[] = [];
        for (const pr of providersData.providers) {
          if (seen[pr.id]) continue;
          seen[pr.id] = true;
          authenticatedProviders.push(pr.id);
        }
        const preferredProviderID = url.searchParams.get("providerID") ?? undefined;
        const preferredModelID = url.searchParams.get("modelID") ?? undefined;
        const resolved = await describeSmallModel({
          directory: effectiveDir,
          preferredProviderID,
          preferredModelID,
        });
        return json({
          available: Boolean(resolved && resolved.hasLogin),
          model: resolved,
          authenticatedProviders,
        });
      } catch (err) {
        logger.warn(
          `[sidecar] small-model providers unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return json({ available: false, model: null, authenticatedProviders: [] });
      }
    }
    if (path === "/api/small-model/generate") {
      if (req.method !== "POST") return jsonError("method not allowed", 405);
      const body = (await readJson(req)) as Record<string, unknown> | undefined;
      const {
        prompt,
        system,
        maxOutputTokens,
        model,
        directory,
        preferredProviderID,
        preferredModelID,
      } = body || {};

      try {
        const result = await generateSmallModelText({
          prompt: typeof prompt === "string" ? prompt : "",
          system: typeof system === "string" ? system : undefined,
          maxOutputTokens: typeof maxOutputTokens === "number" ? maxOutputTokens : undefined,
          model: typeof model === "string" ? model : undefined,
          directory: typeof directory === "string" ? directory : effectiveDir,
          preferredProviderID: typeof preferredProviderID === "string" ? preferredProviderID : undefined,
          preferredModelID: typeof preferredModelID === "string" ? preferredModelID : undefined,
        });
        return json(result);
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode || 500;
        const msg = err instanceof Error ? err.message : "Small model generation failed";
        if (statusCode >= 500) {
          logger.error({ err, path }, `[small-model] generation failed: ${msg}`);
        }
        return jsonError(msg, statusCode);
      }
    }

    // Agent memory
    if (path.startsWith("/api/agent-memory")) {
      if (req.method === "GET") return json({ memories: [], total: 0 });
      return json({ success: true });
    }

    // Walkthrough generator
    if (path.startsWith("/api/walkthrough")) {
      if (path.endsWith("/progress")) return json({ progress: 100, status: "idle" });
      return json({ walkthrough: null });
    }

    // Dictation & Speech
    if (path.startsWith("/api/dictation") || path.startsWith("/api/tts")) {
      return json({ available: false, voices: [], models: [] });
    }

    // Dev servers & preview detection
    if (path.startsWith("/api/dev-servers")) {
      return json({ servers: [] });
    }

    // Tunnels (Cloudflare / ngrok)
    if (path.startsWith("/api/openchamber/tunnel")) {
      return json({ active: false, providers: [], status: "stopped" });
    }

    // Terminal shells & lifecycle
    if (path.startsWith("/api/terminal")) {
      if (path === "/api/terminal/shells") {
        return json({ shells: ["/bin/zsh", "/bin/bash"], defaultShell: Bun.env.SHELL || "/bin/zsh" });
      }
      if (path === "/api/terminal/sessions") {
        return json({ sessions: [] });
      }
      if (path === "/api/terminal/touch") {
        return json({ touched: 0 });
      }
      return json({ sessionId: "term_1", success: true });
    }

    // Markdown image grants
    if (p === "/markdown-image-grants" || path === "/api/markdown-image-grants") {
      return json([]);
    }

    // OpenChamber themes & snippets & catalog
    if ((p === "/config/themes" || p === "/api/config/themes") && req.method === "GET") {
      return json({ themes: [], currentTheme: "dark" });
    }

    if (
      (p === "/config/snippets" || p.startsWith("/config/snippets/") || p === "/api/config/snippets" || p.startsWith("/api/config/snippets/")) &&
      req.method === "GET"
    ) {
      return json([]);
    }

    if ((p.startsWith("/config/skills/catalog") || p.startsWith("/api/config/skills/catalog")) && req.method === "GET") {
      return json({ skills: [] });
    }

    if ((p.startsWith("/config/mcp") || p.startsWith("/api/config/mcp")) && req.method === "GET") {
      return json({});
    }

    if ((p.startsWith("/quota/") || p.startsWith("/api/quota/")) && req.method === "GET") {
      const providerId = p.replace(/^\/(?:api\/)?quota\//, "");
      // Quota reporting is owned by the OpenChamber web server. The sidecar
      // does not have the provider-specific credentials/API integrations, but
      // it still needs to return the ProviderResult shape so the usage panel
      // can render an unavailable provider instead of failing schema parsing.
      return json({
        providerId,
        providerName: providerId,
        ok: false,
        configured: false,
        usage: null,
        error: "Quota reporting is unavailable through the OMP sidecar",
        fetchedAt: Date.now(),
      });
    }

    if ((p === "/github/auth/status" || p === "/api/github/auth/status") && req.method === "GET") {
      return json({ authenticated: false });
    }

    if ((p === "/session-folders" || p === "/api/session-folders") && req.method === "GET") {
      return json([]);
    }

    return jsonError("not implemented", 404);
  };

    const res = await dispatch();
    const durationMs = Math.round(performance.now() - reqStart);
    let resPreview: unknown = responseBody;
    if (resPreview === undefined && res.status === 204) {
      resPreview = "[no content]";
    } else if (resPreview === undefined) {
      resPreview = "[streaming]";
    }
    const resStr = typeof resPreview === "string" ? resPreview : JSON.stringify(resPreview);
    const truncatedRes = resStr.length > 300 ? resStr.slice(0, 300) + "..." : resStr;

    const logData = {
      method: req.method,
      path,
      status: res.status,
      durationMs,
      search: url.search || undefined,
      response: truncatedRes,
    };
    const logMsg = `${req.method} ${path}${url.search || ""} -> ${res.status} (${durationMs}ms) response=${truncatedRes}`;

    if (res.status < 200 || res.status >= 400) {
      httpLogger.error(logData, logMsg);
    } else if (res.status < 300) {
      httpLogger.trace(logData, logMsg);
    } else {
      httpLogger.info(logData, logMsg);
    }
    return res;
  },
});

function logStartupBanner(port?: number): void {
  const effectivePort = port ?? 4096;
  const backendList = allBackends()
    .map((b) => `${b.id}${b.id === defaultBackend().id ? " (default)" : ""}`)
    .join(", ");
  const extPaths = getSidecarExtensionPaths();
  const extensions = extPaths.length > 0 ? extPaths.map((p) => basename(p)).join(", ") : "none";
  const ompRuntime = getOmpRuntimeInfo();
  const smallModel = resolveSmallModel();
  let smallModelInfo = "none configured";
  if (smallModel) {
    const conn = resolveProviderConnection(smallModel.providerID);
    const authStatus = conn?.apiKey ? "authenticated" : conn?.baseURL ? "endpoint ready" : "no credentials found";
    smallModelInfo = `${smallModel.providerID}/${smallModel.modelID} (source: ${smallModel.source}, endpoint: ${conn?.baseURL || "unknown"}, status: ${authStatus})`;
  }

  logger.info(`[sidecar] 🚀 OMP Sidecar started successfully`);
  logger.info(`[sidecar] Listening on http://127.0.0.1:${effectivePort}`);
  logger.info(`[sidecar] Configuration:`);
  logger.info(`  • Working directory : ${process.cwd()}`);
  logger.info(`  • Active adapters   : ${backendList}`);
  logger.info(`  • OMP version       : ${ompRuntime.version ?? "unknown"} (${ompRuntime.source})`);
  if (ompRuntime.binary) {
    logger.info(`  • OMP binary        : ${ompRuntime.binary}`);
  }
  logger.info(`  • Small model       : ${smallModelInfo}`);
  logger.info(`  • Extensions        : ${extensions}`);
  logger.info(`  • Browser control   : ready`);

  if (ompRuntime.binary && !ompRuntime.version) {
    void probeOmpVersion(ompRuntime.binary).then((version) => {
      if (version) logger.info(`[sidecar] OMP version detected: ${version} (${ompRuntime.source})`);
    });
  }
}

logStartupBanner(server.port);
messageQueueRuntime.start();
const stopOmpUpdateChecker = startOmpUpdateChecker();

// Keepalive interval so Bun's event loop wakes up frequently to process POSIX signals
// (SIGINT/SIGTERM) immediately even when Bun.serve has no pending I/O.
const signalKeepalive = setInterval(() => {}, 100);

// Graceful shutdown: SIGTERM/SIGINT/SIGTSTP tears down every OMP child instead of
// leaving them orphaned.
let shuttingDown = false;
function handleShutdownSignal(signal: string) {
  if (shuttingDown) {
    process.exit(0);
  }
  shuttingDown = true;
  clearInterval(signalKeepalive);
  stopOmpUpdateChecker();
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    if (typeof process.stdin.unref === "function") {
      process.stdin.unref();
    }
  } catch {
    // ignore
  }
  try {
    process.stderr.write(`\n[proxy] ${signal} received, shutting down...\n`);
  } catch {
    // ignore
  }
  try {
    logger.info({ signal }, `[proxy] ${signal} received, shutting down`);
    if (typeof (logger as any).flush === "function") {
      (logger as any).flush();
    }
  } catch {
    // ignore
  }
  try {
    browserControlBroker.rejectAll("Server shutting down");
    messageQueueRuntime.stop();
    shutdownAll();
  } catch {
    // ignore
  }
  try {
    server.stop(true);
  } catch {
    // ignore
  }
  process.exit(0);
}

// Leave the terminal in normal line mode on process exit in case shutdown began
// while another code path had changed its mode.
process.on("exit", () => {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  } catch {
    // ignore
  }
});

process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
process.on("SIGTSTP", () => handleShutdownSignal("SIGTSTP"));
process.on("SIGHUP", () => handleShutdownSignal("SIGHUP"));
process.on("SIGQUIT", () => handleShutdownSignal("SIGQUIT"));
process.on("SIGBREAK", () => handleShutdownSignal("SIGBREAK"));

// Keep stdin in normal terminal mode so input is echoed and Enter advances the
// console. The terminal turns Ctrl+C, Ctrl+Z, and Ctrl+\ into signals handled
// above; the byte checks also cover control characters from non-TTY stdin.
try {
  process.stdin.resume();
  if (process.stdin.isTTY) {
    // In normal terminal mode Ctrl+D is delivered as EOF instead of a byte.
    process.stdin.on("end", () => handleShutdownSignal("EOF"));
  }
  process.stdin.on("data", (chunk) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (s.includes("\u0003") || s.includes("\u0004")) {
      handleShutdownSignal("SIGINT");
    } else if (s.includes("\u001a")) {
      handleShutdownSignal("SIGTSTP");
    } else if (s.includes("\u001c")) {
      handleShutdownSignal("SIGQUIT");
    }
  });
} catch {
  // ignore
}
