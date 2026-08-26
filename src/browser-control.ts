/**
 * Request/response broker between the agent's openchamber_web tool and OpenChamber's in-app browser.
 *
 * The browser lives in OpenChamber's renderer (Electron <webview> or iframe), not on the server.
 * The broker publishes requests over the OpenChamber SSE stream, coordinates client claiming,
 * and delivers the result back to the agent tool.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

export interface BrowserControlRequest {
  requestId: string;
  action: string;
  parameters: Record<string, unknown>;
}

export interface BrowserControlOutcome {
  ok: boolean;
  data?: unknown;
  error?: string;
  message?: string;
  status?: number;
}

export class BrowserControlError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BrowserControlError";
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * Normalizes browser open targets. If the input is a local file URL or filesystem
 * path (relative or absolute), translates it into OpenChamber's authenticated
 * internal asset endpoint (/api/fs/serve/...) so the in-app browser can render
 * local HTML files directly without requiring an external HTTP server.
 */
export function normalizeBrowserUrlForOpen(
  inputUrl: string,
  baseDir = process.cwd(),
  port = Number(process.env.OC_SIDECAR_PORT ?? 4096),
): string {
  const trimmed = inputUrl.trim();
  if (!trimmed) return trimmed;

  // Preserve HTTP/HTTPS URLs and about:blank
  if (/^https?:\/\//i.test(trimmed) || trimmed.toLowerCase() === "about:blank") {
    return trimmed;
  }

  let localPath: string;
  if (trimmed.startsWith("file://")) {
    try {
      const parsed = new URL(trimmed);
      localPath = decodeURIComponent(parsed.pathname);
    } catch {
      localPath = trimmed.replace(/^file:\/\//i, "");
    }
  } else {
    localPath = trimmed;
  }

  const home = process.env.HOME || "/tmp";
  let resolved: string;
  if (!localPath || localPath === "~") {
    resolved = home;
  } else if (localPath.startsWith("~/")) {
    resolved = join(home, localPath.slice(2));
  } else if (isAbsolute(localPath)) {
    resolved = localPath;
  } else {
    resolved = join(baseDir, localPath);
  }

  const encodedPath = resolved
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const normalizedPath = encodedPath.startsWith("/") ? encodedPath : `/${encodedPath}`;

  return `http://127.0.0.1:${port}/api/fs/serve${normalizedPath}?oc_url_token=omp-local-url-token`;
}

interface PendingEntry {
  finish: (outcome: BrowserControlOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
}

export interface BrowserControlBrokerOptions {
  emitRequest: (request: BrowserControlRequest) => number;
  createId?: () => string;
}

export class BrowserControlBroker {
  private readonly emitRequest: (request: BrowserControlRequest) => number;
  private readonly createId: () => string;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(options: BrowserControlBrokerOptions) {
    if (typeof options.emitRequest !== "function") {
      throw new TypeError("emitRequest function is required");
    }
    this.emitRequest = options.emitRequest;
    this.createId = options.createId ?? (() => `browser-${randomUUID()}`);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private settle(requestId: string, outcome: BrowserControlOutcome): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.finish(outcome);
    return true;
  }

  request(
    action: string,
    parameters: Record<string, unknown> = {},
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      baseDir?: string;
      port?: number;
    } = {},
  ): Promise<unknown> {
    const requestId = this.createId();
    const boundedTimeout = Math.min(
      Math.max(1_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );

    let normalizedParams = parameters;
    if (
      (action === "browser.open" || action === "open") &&
      typeof parameters.url === "string"
    ) {
      normalizedParams = {
        ...parameters,
        url: normalizeBrowserUrlForOpen(
          parameters.url,
          options.baseDir,
          options.port,
        ),
      };
    }

    const listenerCount = this.emitRequest({
      requestId,
      action,
      parameters: normalizedParams,
    });
    if (listenerCount === 0) {
      return Promise.reject(
        new BrowserControlError(
          "No OpenChamber client connected here can control a page. Reading and " +
            "interacting with a page works when OpenChamber runs as its desktop " +
            "application with an active browser panel. Nothing was changed.",
          503,
        ),
      );
    }

    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const onAbort = signal
        ? () =>
            this.settle(requestId, {
              ok: false,
              message: "Browser action was cancelled",
              status: 499,
            })
        : null;

      if (signal) {
        if (signal.aborted) {
          reject(new BrowserControlError("Browser action was cancelled", 499));
          return;
        }
        signal.addEventListener("abort", onAbort!, { once: true });
      }

      const finish = (outcome: BrowserControlOutcome) => {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        if (outcome.ok) {
          resolve(outcome.data ?? null);
        } else {
          reject(
            new BrowserControlError(
              outcome.message || outcome.error || "Browser action failed",
              outcome.status || 400,
            ),
          );
        }
      };

      const timer = setTimeout(() => {
        this.settle(requestId, {
          ok: false,
          message: `The in-app browser did not respond within ${Math.round(boundedTimeout / 1000)}s`,
          status: 504,
        });
      }, boundedTimeout);

      this.pending.set(requestId, { finish, timer, claimed: false });
    });
  }

  claim(requestId: string): boolean {
    if (typeof requestId !== "string" || !requestId.trim()) return false;
    const cleanId = requestId.trim();
    const entry = this.pending.get(cleanId);
    if (!entry || entry.claimed) return false;
    entry.claimed = true;
    return true;
  }

  resolve(requestId: string, result: { ok: boolean; data?: unknown; error?: string }): boolean {
    if (typeof requestId !== "string" || !requestId.trim()) return false;
    const cleanId = requestId.trim();
    if (result && result.ok === true) {
      return this.settle(cleanId, { ok: true, data: result.data ?? null });
    }
    return this.settle(cleanId, {
      ok: false,
      message: typeof result?.error === "string" && result.error ? result.error : "Browser action failed",
      status: 400,
    });
  }

  rejectAll(message: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, { ok: false, message, status: 503 });
    }
  }
}
