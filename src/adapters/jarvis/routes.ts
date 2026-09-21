import type { ImageContent } from "../../providers/types";
import {
  JarvisAdapterError,
  JarvisHarness,
  JarvisNotFoundError,
  jarvisHarness,
} from "./harness";
import type {
  JarvisActionResultInput,
  JarvisActionUpdateInput,
  JarvisCancelInput,
  JarvisEvent,
  JarvisSessionCreateInput,
  JarvisToolDefinition,
  JarvisTurnStartInput,
} from "./types";

const PREFIX = "/internal/jarvis/v1";

function jsonResponse(
  data: unknown,
  status: number,
  cors: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(data, {
    status,
    headers: {
      ...cors,
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function errorResponse(error: unknown, cors: Record<string, string>): Response {
  const status = error instanceof JarvisAdapterError ? error.statusCode : 500;
  const code = error instanceof JarvisAdapterError ? error.code : "internal_error";
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: { code, message } }, status, cors);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    throw new JarvisAdapterError("request body must be valid JSON", 400, "invalid_json");
  }
  const body = record(value);
  if (Object.keys(body).length === 0 && value !== null && typeof value !== "object") {
    throw new JarvisAdapterError("request body must be a JSON object", 400, "invalid_body");
  }
  return body;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new JarvisAdapterError(`${field} must be a non-empty string`, 400, "invalid_body");
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new JarvisAdapterError(`${field} must be a non-empty string`, 400, "invalid_body");
  }
  return value.trim();
}

function parseModel(value: unknown): JarvisSessionCreateInput["model"] | undefined {
  if (value === undefined) return undefined;
  const model = record(value);
  if (typeof model.providerID !== "string" || typeof model.modelID !== "string") {
    throw new JarvisAdapterError("model.providerID and model.modelID are required", 400, "invalid_model");
  }
  return {
    providerID: model.providerID,
    modelID: model.modelID,
    ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
  };
}

function parseTools(value: unknown, field: string): JarvisToolDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new JarvisAdapterError(`${field} must be an array`, 400, "invalid_tools");
  return value.map((entry, index) => {
    const tool = record(entry);
    if (typeof tool.name !== "string" || typeof tool.description !== "string") {
      throw new JarvisAdapterError(`${field}[${index}] requires name and description`, 400, "invalid_tools");
    }
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw new JarvisAdapterError(`${field}[${index}].parameters must be an object`, 400, "invalid_tools");
    }
    if (tool.loadMode !== undefined && tool.loadMode !== "essential" && tool.loadMode !== "discoverable") {
      throw new JarvisAdapterError(`${field}[${index}].loadMode must be essential or discoverable`, 400, "invalid_tools");
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      ...(typeof tool.label === "string" ? { label: tool.label } : {}),
      ...(typeof tool.hidden === "boolean" ? { hidden: tool.hidden } : {}),
      ...(tool.loadMode !== undefined ? { loadMode: tool.loadMode } : {}),
      ...(typeof tool.requiresApproval === "boolean" ? { requiresApproval: tool.requiresApproval } : {}),
      ...(typeof tool.category === "string" ? { category: tool.category } : {}),
    };
  });
}

function parseImages(value: unknown): ImageContent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new JarvisAdapterError("images must be an array", 400, "invalid_images");
  return value.map((entry, index) => {
    const image = record(entry);
    if (image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
      throw new JarvisAdapterError(`images[${index}] must contain type=image, data, and mimeType`, 400, "invalid_images");
    }
    return { type: "image", data: image.data, mimeType: image.mimeType };
  });
}

function parseAfter(url: URL): number {
  const raw = url.searchParams.get("after");
  if (raw === null || raw === "") return 0;
  const after = Number(raw);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new JarvisAdapterError("after must be a non-negative integer", 400, "invalid_cursor");
  }
  return after;
}

function parseWaitMs(url: URL): number {
  const raw = url.searchParams.get("waitMs");
  if (raw === null || raw === "") return 30_000;
  const waitMs = Number(raw);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new JarvisAdapterError("waitMs must be non-negative", 400, "invalid_wait");
  return Math.min(Math.floor(waitMs), 300_000);
}

function pathParts(pathname: string): string[] | null {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return null;
  const suffix = pathname.slice(PREFIX.length).replace(/^\//, "");
  if (!suffix) return [];
  try {
    return suffix.split("/").map((part) => decodeURIComponent(part));
  } catch {
    throw new JarvisAdapterError("malformed URL path", 400, "invalid_path");
  }
}

function authorized(req: Request): boolean {
  const expected = process.env.OC_JARVIS_TOKEN?.trim();
  if (!expected) return true;
  const authorization = req.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  return bearer === expected || req.headers.get("x-jarvis-token") === expected;
}

function eventFrame(event: JarvisEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function eventStream(
  req: Request,
  binding: ReturnType<JarvisHarness["get"]>,
  after: number,
  waitMs: number,
  cors: Record<string, string>,
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    req.signal.removeEventListener("abort", close);
    try {
      controller?.close();
    } catch {
      // The client may have cancelled the stream concurrently.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      const enqueue = (event: Parameters<typeof eventFrame>[0]) => {
        if (closed) return;
        try {
          controller?.enqueue(encoder.encode(eventFrame(event)));
        } catch {
          close();
        }
      };
      try {
        controller.enqueue(encoder.encode(": jarvis-events\n\n"));
        for (const event of binding.eventLogAfter(after)) enqueue(event);
        unsubscribe = binding.subscribe(enqueue);
        req.signal.addEventListener("abort", close, { once: true });
        if (waitMs > 0) timer = setTimeout(close, waitMs);
        if (req.signal.aborted) close();
      } catch {
        close();
      }
    },
    cancel: close,
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Jarvis-only HTTP adapter. Returning null is intentional: main.ts can leave
 * every existing OpenCode/OpenChamber route untouched.
 */
export async function handleJarvisRequest(
  req: Request,
  url: URL,
  options: { harness?: JarvisHarness; cors?: Record<string, string> } = {},
): Promise<Response | null> {
  const parts = pathParts(url.pathname);
  if (parts === null) return null;
  const harness = options.harness ?? jarvisHarness;
  const cors = options.cors ?? {};

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!authorized(req)) return jsonResponse({ error: { code: "unauthorized", message: "Jarvis adapter authorization required" } }, 401, cors);

  try {
    if (parts.length === 1 && parts[0] === "health" && req.method === "GET") {
      return jsonResponse({ adapter: "jarvis", backend: "omp", version: 1, sessions: harness.list().length }, 200, cors);
    }

    if (parts.length === 1 && parts[0] === "sessions" && req.method === "GET") {
      return jsonResponse({ sessions: harness.list() }, 200, cors);
    }

    if (parts.length === 1 && parts[0] === "sessions" && req.method === "POST") {
      const body = await readBody(req);
      const credentialRef = optionalString(body, "credentialRef");
      if (credentialRef && body.credentials !== undefined) {
        throw new JarvisAdapterError("provide exactly one of credentials or credentialRef", 400, "invalid_credentials");
      }
      const binding = await harness.createSession({
        sessionId: requiredString(body, "sessionId"),
        workspaceId: requiredString(body, "workspaceId"),
        cwd: requiredString(body, "cwd"),
        ...(typeof body.sessionPath === "string" ? { sessionPath: body.sessionPath } : {}),
        ...(typeof body.providerSessionPath === "string" ? { providerSessionPath: body.providerSessionPath } : {}),
        ...(body.model !== undefined ? { model: parseModel(body.model)! } : {}),
        ...(body.tools !== undefined ? { tools: parseTools(body.tools, "tools")! } : {}),
        ...(credentialRef ? { credentialRef } : {}),
        ...(body.credentials !== undefined ? { credentials: body.credentials as JarvisSessionCreateInput["credentials"] } : {}),
      });
      return jsonResponse({ session: binding.snapshot() }, 201, cors);
    }

    if (parts.length < 2 || parts[0] !== "sessions") {
      return jsonResponse({ error: { code: "not_found", message: "Jarvis route not found" } }, 404, cors);
    }

    const sessionId = parts[1];
    const binding = harness.get(sessionId);

    if (parts.length === 2 && req.method === "GET") return jsonResponse({ session: binding.snapshot() }, 200, cors);
    if (parts.length === 2 && req.method === "DELETE") {
      harness.deleteSession(sessionId);
      return jsonResponse({ deleted: true, sessionId }, 200, cors);
    }

    if (parts.length === 3 && parts[2] === "events" && req.method === "GET") {
      const after = parseAfter(url);
      const wantsSse = req.headers.get("accept")?.includes("text/event-stream") === true || url.searchParams.get("stream") === "1";
      if (wantsSse) return eventStream(req, binding, after, parseWaitMs(url), cors);
      const events = binding.eventLogAfter(after);
      return jsonResponse({ sessionId, events, nextSequence: binding.snapshot().lastSequence }, 200, cors);
    }

    if (parts.length === 3 && parts[2] === "reconcile" && (req.method === "POST" || req.method === "GET")) {
      const result = await binding.reconcile();
      return jsonResponse(result, 200, cors);
    }

    if (parts.length === 3 && parts[2] === "turns" && req.method === "POST") {
      const body = await readBody(req);
      const result = await binding.startTurn({
        turnId: requiredString(body, "turnId"),
        attemptId: requiredString(body, "attemptId"),
        prompt: requiredString(body, "prompt"),
        ...(body.images !== undefined ? { images: parseImages(body.images) } : {}),
        ...(body.model !== undefined ? { model: parseModel(body.model)! } : {}),
        ...(body.tools !== undefined ? { tools: parseTools(body.tools, "tools")! } : {}),
        ...(body.boundCapabilities !== undefined ? { boundCapabilities: parseTools(body.boundCapabilities, "boundCapabilities")! } : {}),
        ...(typeof body.workerLeaseEpoch === "number" ? { workerLeaseEpoch: body.workerLeaseEpoch } : {}),
        ...(typeof body.idempotencyKey === "string" ? { idempotencyKey: body.idempotencyKey } : {}),
      });
      return jsonResponse(result, result.idempotent ? 200 : 202, cors);
    }

    if (parts.length === 4 && parts[2] === "turns" && parts[3] && req.method === "POST") {
      const body = await readBody(req);
      const result: JarvisCancelInput = {
        turnId: parts[3],
        ...(typeof body.attemptId === "string" ? { attemptId: body.attemptId } : {}),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      };
      return jsonResponse({ session: await binding.cancelTurn(result) }, 202, cors);
    }

    if (parts.length === 4 && parts[2] === "actions" && parts[3] && req.method === "POST") {
      const actionPath = url.pathname.endsWith("/update") ? "update" : "result";
      // The route is parsed below using the explicit suffix forms. This branch
      // is kept unreachable for malformed paths and returns a useful 404.
      return jsonResponse({ error: { code: "not_found", message: `action ${actionPath} route not found` } }, 404, cors);
    }

    if (parts.length === 5 && parts[2] === "actions" && parts[3] && parts[4] === "result" && req.method === "POST") {
      const body = await readBody(req);
      if (typeof body.success !== "boolean") throw new JarvisAdapterError("success must be a boolean", 400, "invalid_body");
      const result: JarvisActionResultInput = {
        success: body.success === true,
        ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
        ...(typeof body.attemptId === "string" ? { attemptId: body.attemptId } : {}),
        ...(typeof body.callId === "string" ? { callId: body.callId } : {}),
        ...(body.result !== undefined ? { result: body.result } : {}),
        ...(typeof body.error === "string" ? { error: body.error } : {}),
        ...(body.details !== undefined ? { details: body.details } : {}),
      };
      return jsonResponse({ session: await binding.submitActionResult(parts[3], result) }, 200, cors);
    }

    if (parts.length === 5 && parts[2] === "actions" && parts[3] && parts[4] === "update" && req.method === "POST") {
      const body = await readBody(req);
      if (body.partialResult === undefined) throw new JarvisAdapterError("partialResult is required", 400, "invalid_body");
      const result: JarvisActionUpdateInput = {
        partialResult: body.partialResult,
        ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
        ...(typeof body.attemptId === "string" ? { attemptId: body.attemptId } : {}),
        ...(typeof body.callId === "string" ? { callId: body.callId } : {}),
      };
      return jsonResponse({ session: await binding.submitActionUpdate(parts[3], result) }, 200, cors);
    }

    return jsonResponse({ error: { code: "not_found", message: "Jarvis route not found" } }, 404, cors);
  } catch (error) {
    if (error instanceof JarvisNotFoundError && parts.length >= 2 && parts[0] === "sessions") {
      return errorResponse(error, cors);
    }
    return errorResponse(error, cors);
  }
}
