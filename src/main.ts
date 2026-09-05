import { allBackends, backendById, backendForSession, defaultBackend, listProviders, listSessionsAcrossBackends, registerBackend, splitProviderPrefix } from "./providers/registry";
import { listAvailableCommands, listAvailableSkills } from "./discovery";
import {
  createOpenCodeEventStream,
  emitSessionCreated,
  emitSessionUpdated,
  emitSessionDeleted,
  emitPermissionReplied,
  emitQuestionReplied,
  emitQuestionRejected,
  emitBrowserControlRequest,
} from "./sse";
import { BrowserControlBroker, BrowserControlError } from "./browser-control";
import {
  listPendingPermissions,
  listPendingQuestions,
  getPendingPermission,
  getPendingQuestion,
  replyPermission,
  replyQuestion,
  rejectQuestion,
  getAutoAcceptPolicy,
  setSessionAutoAccept,
} from "./approvals";
import {
  promptSessionAsync,
  abortSession,
  getSessionStatusMap,
  removeSessionState,
  shutdownAll,
} from "./prompt";
import { extractTodosFromOmpDetails } from "./providers/omp/todo";
import { getSidecarExtensionPaths, withOmpRpc } from "./providers/omp/rpc";
import type { OpenCodeProvidersResponse } from "./providers/types";
import { logger, httpLogger } from "./logger";
import { join, isAbsolute, basename, extname } from "node:path";
import { homedir } from "node:os";
import { readdir, mkdir, stat, unlink, rename } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { fakeBackend } from "./providers/fake/backend";
import { describeSmallModel, generateSmallModelText, resolveSmallModel, resolveProviderConnection, ensureLegacyOmpConfigMigrated } from "./small-model";

// Optional fake backend (test-only): OC_FAKE_BACKEND=1 enables multi-backend
// mode over the HTTP surface. Off by default so the omp-only path stays
// byte-identical.
if (process.env.OC_FAKE_BACKEND === "1") {
  registerBackend(fakeBackend);
}

function resolveFsPath(rawPath: string, effectiveDir = process.cwd()): string {
  const home = Bun.env.HOME || process.env.HOME || "/tmp";
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
  if (isAbsolute(trimmed)) return trimmed;
  return join(effectiveDir, trimmed);
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

const providerCache = new Map<string, { data: OpenCodeProvidersResponse; expiresAt: number }>();
let globalProviderCache: { data: OpenCodeProvidersResponse; expiresAt: number } | null = null;

export const browserControlBroker = new BrowserControlBroker({
  emitRequest: emitBrowserControlRequest,
});

async function fetchProvidersForDirectory(cwd: string): Promise<OpenCodeProvidersResponse> {
  const cached = providerCache.get(cwd) ?? globalProviderCache;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const response = await listProviders(cwd);
  const entry = { data: response, expiresAt: Date.now() + 120_000 };
  providerCache.set(cwd, entry);
  globalProviderCache = entry;
  return response;
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


// OC_SIDECAR_PORT overrides the default 4096 so the route-level test suite can
// run a second instance without colliding with the live sidecar.
const server = Bun.serve({
  port: Number(process.env.OC_SIDECAR_PORT ?? 4096),
  idleTimeout: 0,
  async fetch(req) {
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

    const url = new URL(req.url);
    const path = url.pathname;
    const dir = url.searchParams.get("directory") ?? undefined;
    const effectiveDir = dir ?? process.cwd();

    const dispatch = async (): Promise<Response> => {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: cors,
        });
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

      // Git UI endpoints
      if (path === "/api/git/check") {
        const checkDir = url.searchParams.get("directory") || effectiveDir;
        const isRepo = existsSync(join(checkDir, ".git"));
        return json({ isGitRepository: isRepo });
      }

      if (path === "/api/git/global-identity" || path === "/api/git/current-identity") {
        return json({ name: null, email: null });
      }

      if (path === "/api/git/has-local-identity") {
        return json({ hasLocalIdentity: false });
      }

      if (path === "/api/git/status") {
        const checkDir = url.searchParams.get("directory") || effectiveDir;
        const isRepo = existsSync(join(checkDir, ".git"));
        if (!isRepo) {
          return json({
            isGitRepository: false,
            files: [],
            branch: null,
            ahead: 0,
            behind: 0,
          });
        }
        return json({
          isGitRepository: true,
          files: [],
          branch: "main",
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: [],
        });
      }

      if (path === "/api/git/identities" || path === "/api/git/discover-credentials") {
        return json([]);
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

      // Create session (POST /session)
      if (p === "/session" && req.method === "POST") {
        try {
          const body = (await readJson(req)) as
            | { title?: string; parentID?: string; model?: { providerID?: string } }
            | undefined;
          // D1: a namespaced model prefix selects the backend for the new
          // session; absent or unknown prefix falls through to the default.
          const prefix = splitProviderPrefix(body?.model?.providerID ?? "");
          const backend = (prefix.backendId ? backendById(prefix.backendId) : undefined) ?? defaultBackend();
          const session = await backend.store.create(dir, body);
          emitSessionCreated(session as unknown as Record<string, unknown>, session.directory);
          return json(session, { status: 201 });
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
          const all = roots || url.searchParams.get("all") === "true";
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

      // Session status
      if (p === "/session/status" && req.method === "GET") {
        return json(getSessionStatusMap());
      }

      // Single session routes: /session/:id
      const sMatch = p.match(/^\/session\/([^/]+)$/);
      if (sMatch) {
        const openCodeId = sMatch[1];
        if (req.method === "GET") {
          try {
            const { session } = await resolveSessionRoute(openCodeId, dir);
            if (!session) return jsonError("session not found", 404);
            return json(session);
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
          return json(ok);
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
          return json(updated);
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
        const forked = await backend.store.create(session.directory, {
          parentID: forkMatch[1],
          title: `Fork of ${session.title ?? session.id}`,
        });
        emitSessionCreated(forked as unknown as Record<string, unknown>, forked.directory);
        return json(forked, { status: 201 });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "fork failed", 500);
      }
    }

    // Session summarize
    const summarizeMatch = p.match(/^\/session\/([^/]+)\/summarize$/);
    if (summarizeMatch && req.method === "POST") {
      try {
        const { backend, session } = await resolveSessionRoute(summarizeMatch[1], dir);
        if (!session) return jsonError("session not found", 404);
        if (!backend.capabilities.compact) return jsonError("summarize not supported by backend", 501);
        await withOmpRpc(session.directory, async (conn) => {
          await conn.request("compact", {});
        }).catch(() => {});
        return json(true);
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
        const body = (await readJson(req)) as { command?: string; arguments?: string } | undefined;
        const { session } = await resolveSessionRoute(openCodeId, dir);
        if (!session) return jsonError("session not found", 404);
        const commandText = `/${body?.command ?? ""}${body?.arguments ? ` ${body.arguments}` : ""}`.trim();
        const result = await promptSessionAsync(openCodeId, session.directory, session.path, {
          parts: [{ type: "text", text: commandText }],
        });
        if (result.queued) return json({ queued: true });
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
        const body = (await readJson(req)) as { command?: string } | undefined;
        const output = await withOmpRpc(session.directory, async (conn) => {
          return await conn.request("bash", { command: body?.command ?? "" });
        }).catch((err) => String(err));
        return json({
          info: { id: `msg_${openCodeId}_shell_${Date.now()}`, role: "assistant", sessionID: openCodeId },
          parts: [{ id: `part_${openCodeId}_0`, type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
        });
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
        return json(messages);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "load failed", 500);
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

    // Abort
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

    if ((p === "/provider" || p === "/providers") && req.method === "GET") {
      try {
        const cwd = dir ?? process.cwd();
        const providersData = await fetchProvidersForDirectory(cwd);
        const all = providersData.providers.map((pr) => ({ id: pr.id, name: pr.name }));
        const connected = providersData.providers.map((pr) => pr.id);
        return json({
          all,
          default: providersData.default,
          connected,
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
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
          path: join(relPath, e.name),
        }));
        return json(list);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "readdir failed", 500);
      }
    }

    if (p === "/find/file" && req.method === "GET") {
      const query = url.searchParams.get("query") ?? "";
      try {
        const entries = await readdir(effectiveDir, { recursive: true, withFileTypes: true });
        const matches = entries
          .filter((e) => !e.isDirectory() && (!query || e.name.toLowerCase().includes(query.toLowerCase())))
          .slice(0, 50)
          .map((e) => e.name);
        return json(matches);
      } catch {
        return json([]);
      }
    }

    // Agent catalog
    if (p === "/agent" && req.method === "GET") {
      return json([
        {
          name: "omp",
          description: "OMP coding agent",
          mode: "primary",
          builtIn: true,
          tools: {},
        },
      ]);
    }

    // Config
    if ((p === "/config" || p === "/global/config") && req.method === "GET") {
      return json(readOmpConfig());
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
          worktree: effectiveDir,
          path: effectiveDir,
          directory: effectiveDir,
          label: "Project",
          time: { created: Date.now(), updated: Date.now() },
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
      return json(cmds);
    }

    // Skill
    if (p === "/skill" && req.method === "GET") {
      const skills = await listAvailableSkills(dir);
      return json(skills);
    }

    // MCP
    if (p === "/mcp" && req.method === "GET") return json({});

    // LSP
    if (p === "/lsp" && req.method === "GET") return json([]);

    // VCS
    if (p === "/vcs" && req.method === "GET") {
      return json({ branch: "main", default_branch: "main" });
    }

    // Questions & Permissions
    if (p === "/permission" && req.method === "GET") {
      return json(listPendingPermissions(dir));
    }

    const permReplyMatch = p.match(/^\/permission\/([^/]+)\/reply$/);
    if (permReplyMatch && req.method === "POST") {
      const id = permReplyMatch[1];
      const body = (await readJson(req)) as { reply?: "once" | "always" | "reject"; message?: string } | undefined;
      const reply = body?.reply ?? "once";
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

    // Session knowledge & project context
    if ((p === "/api/session-knowledge" || p === "/session-knowledge") && req.method === "GET") {
      return json({ text: "", signature: "", unavailable: false, notes: [], plans: [] });
    }

    if ((p === "/api/session-knowledge/summary" || p === "/session-knowledge/summary") && req.method === "GET") {
      return json({ notes: [], plans: [], memory: { global: 0, project: 0 } });
    }

    if ((p === "/api/session-knowledge/pin" || p === "/session-knowledge/pin") && req.method === "POST") {
      return json({ pins: [] });
    }

    if ((p === "/api/session-knowledge/delivered" || p === "/session-knowledge/delivered") && req.method === "POST") {
      return json({ recorded: true });
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
      return json({ providerId, limit: null, used: 0 });
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
  logger.info(`  • Small model       : ${smallModelInfo}`);
  logger.info(`  • Extensions        : ${extensions}`);
  logger.info(`  • Browser control   : ready`);
}

logStartupBanner(server.port);

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

// Restore terminal raw mode on process exit to avoid leaving user shell in corrupted state
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

// Interactive terminal keypress detection for instant Ctrl+C, Ctrl+Z, Ctrl+D, Ctrl+\ termination
try {
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }
    process.stdin.on("keypress", (_str, key) => {
      if (key && key.ctrl && (key.name === "c" || key.name === "d")) {
        handleShutdownSignal("SIGINT");
      } else if (key && key.ctrl && key.name === "z") {
        handleShutdownSignal("SIGTSTP");
      } else if (key && key.ctrl && key.name === "\\") {
        handleShutdownSignal("SIGQUIT");
      }
    });
  }
  process.stdin.resume();
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



