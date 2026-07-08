import { listOmpSessions, getOmpSessionByOpenCodeId } from "./sessions";
import { loadSessionMessages } from "./messages";
import { createOpenCodeEventStream } from "./sse";
import { promptSessionAsync, abortSession, getSessionStatusMap } from "./prompt";
import {
  withOmpRpc,
  getCurrentModel,
  mapRpcModelsToOpenCodeProviders,
  type OmpRpcModel,
} from "./rpc";

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function normalizeModelsResponse(value: unknown): OmpRpcModel[] {
  if (Array.isArray(value)) return value as OmpRpcModel[];
  if (value != null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.models)) return obj.models as OmpRpcModel[];
    if (Array.isArray(obj.data)) return obj.data as OmpRpcModel[];
    if (Array.isArray(obj.result)) return obj.result as OmpRpcModel[];
  }
  return [];
}

const server = Bun.serve({
  port: 4096,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const dir = url.searchParams.get("directory") ?? undefined;

    console.log(`[req] ${req.method} ${path}${url.search}`);

    // Health
    if (path === "/health" || path === "/global/health") {
      return Response.json({ healthy: true, status: "ok" });
    }

    // SSE
    if (path === "/events" || path === "/global/event") {
      return new Response(createOpenCodeEventStream(), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Session list
    if (path === "/session" && req.method === "GET") {
      try {
        const sessions = await listOmpSessions(dir);
        return Response.json(sessions);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "list failed", 500);
      }
    }

    if (path === "/session" && req.method === "POST") {
      return Response.json(
        { id: `ro_${Date.now()}`, directory: dir, time: { created: Date.now(), updated: Date.now() } },
        { status: 201 },
      );
    }

    // Experimental session list
    if (path === "/experimental/session" && req.method === "GET") {
      try {
        const roots = url.searchParams.get("roots") === "true";
        const limit = url.searchParams.get("limit");
        // When roots=true or no directory, return all sessions
        if (roots || !dir) {
          const sessions = await listOmpSessions(null, {
            all: true,
            limit: limit != null ? parseInt(limit, 10) : undefined,
          });
          return Response.json(sessions);
        }
        const all = url.searchParams.get("all") === "true";
        const sessions = await listOmpSessions(dir, {
          all,
          limit: limit != null ? parseInt(limit, 10) : undefined,
        });
        return Response.json(sessions);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "list failed", 500);
      }
    }

    // Session status
    if (path === "/session/status" && req.method === "GET") {
      return Response.json(getSessionStatusMap());
    }

    // Single session
    const sMatch = path.match(/^\/session\/([^/]+)$/);
    if (sMatch && req.method === "GET") {
      try {
        const session = await getOmpSessionByOpenCodeId(sMatch[1], dir);
        if (!session) return jsonError("session not found", 404);
        return Response.json(session);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "lookup failed", 500);
      }
    }

    // Session messages
    const msgMatch = path.match(/^\/session\/([^/]+)\/message$/);
    if (msgMatch && req.method === "GET") {
      try {
        const session = await getOmpSessionByOpenCodeId(msgMatch[1], dir);
        if (!session) return jsonError("session not found", 404);
        const messages = await loadSessionMessages(msgMatch[1], session.directory);
        return Response.json(messages);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "load failed", 500);
      }
    }

    // Prompt async
    const promptAsyncMatch = path.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (promptAsyncMatch && req.method === "POST") {
      try {
        const openCodeId = promptAsyncMatch[1];
        const body = await readJson(req);
        const session = await getOmpSessionByOpenCodeId(openCodeId, dir);
        if (!session) return jsonError("session not found", 404);
        const result = await promptSessionAsync(openCodeId, session.directory, session.path, body);
        if (result.queued) return Response.json({ queued: true });
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
        const session = await getOmpSessionByOpenCodeId(openCodeId, dir);
        if (!session) return jsonError("session not found", 404);
        const result = await promptSessionAsync(openCodeId, session.directory, session.path, body);
        if (result.queued) return Response.json({ queued: true });
        return jsonError(result.error ?? "prompt failed", result.status ?? 400);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "prompt failed", 500);
      }
    }

    // Abort
    const abortMatch = path.match(/^\/session\/([^/]+)\/abort$/);
    if (abortMatch && req.method === "POST") {
      try {
        const session = await getOmpSessionByOpenCodeId(abortMatch[1], dir);
        const ok = session ? await abortSession(abortMatch[1], session.directory) : false;
        return Response.json(ok);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "abort failed", 500);
      }
    }

    // Providers
    if (path === "/config/providers" && req.method === "GET") {
      try {
        const cwd = dir ?? process.cwd();
        const response = await withOmpRpc(cwd, async (conn) => {
          const rawModels = await conn.request("get_available_models");
          const models = normalizeModelsResponse(rawModels);
          const currentModel = await getCurrentModel(conn);
          return mapRpcModelsToOpenCodeProviders(models, currentModel?.providerID);
        });
        return Response.json(response);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "providers failed", 500);
      }
    }

    // Agent stub
    if (path === "/agent" && req.method === "GET") return Response.json([]);

    if (path === "/config" || path === "/global/config") return Response.json({});
    if ((path === "/project" || path === "/project/current") && req.method === "GET")
      return Response.json({ directory: dir, worktree: dir });
    if (path === "/path" && req.method === "GET") return Response.json({ directory: dir, worktree: dir, state: "ok" });
    if (path === "/command" && req.method === "GET") return Response.json([]);
    if (path === "/skill" && req.method === "GET") return Response.json([]);
    if (path === "/mcp" && req.method === "GET") return Response.json([]);
    if (path === "/lsp" && req.method === "GET") return Response.json([]);
    if (path === "/vcs" && req.method === "GET") return Response.json([]);
    if (path === "/question" && req.method === "GET") return Response.json([]);
    if (path === "/permission" && req.method === "GET") return Response.json([]);

    return jsonError("not implemented", 404);
  },
});

console.log(`[proxy] listening on http://127.0.0.1:${server.port}`);
