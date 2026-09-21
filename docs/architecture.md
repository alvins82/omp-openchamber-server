# Server Architecture

`omp-openchamber-server` is a lightweight proxy server written in TypeScript for [Bun](https://bun.sh). It translates [OpenChamber](https://github.com/OpenChamber/OpenChamber) OpenCode HTTP/SSE client requests into [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) stdio RPC commands without requiring modifications to either project.

## Source layout

The process entrypoint is intentionally separate from adapter code:

```text
src/main.ts                         stable process entrypoint
src/server.ts                       Bun HTTP/WebSocket composition
src/adapters/openchamber/           OpenCode/OpenChamber compatibility adapter
src/adapters/openchamber/extensions/  OpenChamber-facing OMP extensions
src/adapters/jarvis/                Jarvis internal session/turn adapter
src/providers/omp/                  OMP RPC, JSONL session, and model provider
src/providers/fake/                 deterministic test backend
src/shared/                         protocol types, event bus, logging, utilities
```

The two adapters share the OMP provider runtime but do not share route
contracts. OpenChamber-specific compatibility logic stays under its adapter;
provider and shared modules do not import the Jarvis adapter.

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenChamber Frontend                    │
│           (Web UI, Desktop App, VSCode Extension)           │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / SSE (/api/*)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   omp-openchamber-server                    │
│                                                             │
│  ┌─────────────────┐ ┌──────────────────┐ ┌──────────────┐  │
│  │   HTTP Router   │ │ Provider Registry│ │ SSE Producer │  │
│  │   (server.ts)   │ │    (registry)    │ │ shared/sse.ts │  │
│  └────────┬────────┘ └────────┬─────────┘ └──────▲───────┘  │
│           │                   │                  │          │
│  ┌────────▼────────┐ ┌────────▼─────────┐ ┌──────┴───────┐  │
│  │ Adapters         │ │ JSONL Fast-Path  │ │ Event Bridges│  │
│  │ OpenChamber/Jarvis│ │ providers/omp/*  │ │ prompt +     │  │
│  │ adapters/*       │ │                  │ │ adapters/*   │  │
│  └────────┬────────┘ └────────┬─────────┘ └──────────────┘  │
└───────────┼───────────────────┼─────────────────────────────┘
            │ stdio NDJSON      │ Direct FS Read
            ▼                   ▼
┌───────────────────────┐ ┌───────────────────────────────────┐
│   project-owned OMP   │ │         Session JSONL             │
│       CLI binary      │ │  (~/.omp/agent/sessions/*/*.jsonl) │
│ (omp --mode rpc ...)  │ │                                  │
└───────────────────────┘ └───────────────────────────────────┘
```

---

## Subsystems

### 1. Process Entry & HTTP Composition (`src/main.ts`, `src/server.ts`)
- `src/main.ts` is the stable process entrypoint used by package scripts and
  external launchers.
- `src/server.ts` composes the Bun HTTP/WebSocket server and mounts the
  OpenChamber and Jarvis adapters.
- Implements the OpenCode HTTP API surface expected by OpenChamber.
- Supports multi-directory workspaces via `?directory=<path>` query parameters.
- Dispatches requests for sessions, transcripts, prompts, provider configs, and real-time event streams.
- Manages clean shutdown on `SIGINT` and `SIGTERM` signals.

### 2. Session Management & Fast Path (`src/providers/omp/store.ts`, `src/providers/omp/messages.ts`)
- **Session Discovery**: Scans `~/.omp/agent/sessions/<cwd-slug>/` for session JSONL files without spawning OMP subprocesses.
- **Transcript Fast Path**: Reads session JSONL records directly from disk (`loadMessagesFromFile`), mapping entries into OpenCode `{info, parts}` structures.
- **Deterministic ID Translation**: Reversibly maps OMP UUIDs (`8-4-4-4-12`) to OpenCode format (`ses_<32hex>`).
- **Session Creation**: Pre-allocates session header JSONL files for immediate UI visibility and navigation.

### 3. OpenChamber context compatibility (`src/adapters/openchamber/project-context.ts`, `src/adapters/openchamber/session-knowledge.ts`)
- Owns notes, project todos, and plan markdown when the UI connects directly to the sidecar.
- Stores context under `$OPENCHAMBER_DATA_DIR/projects/<projectId>/context.json` and plan files under the matching `plans/` directory.
- Keeps pinned notes and plans in `metadata.openchamber` on the session JSONL record, so context survives a browser restart and follows the session.
- Returns knowledge text to the UI; the UI attaches it to outgoing prompts as a synthetic part.

### 4. Provider Registry (`src/providers/registry.ts`)

The adapter seam that lets the sidecar serve multiple agent backends behind one unchanged OpenCode HTTP/SSE surface. Full adapter contract: [providers.md](providers.md).
- **AgentBackend contract**: each backend supplies a stable `id`, a provider catalog, a `SessionStore` (create/list/get/transcript), and a turn-connection factory. Capabilities (`todo`, `summarize`, `shell`, ...) gate the corresponding HTTP routes.
- **Session-ID codec**: legacy `ses_<32hex>` ids remain the default omp backend; non-default backends encode as `ses_<backendId>_<native>`. Routing is derived from the id alone — no registry file, restart-safe.
- **Model-picker routing**: with a single backend registered, provider IDs pass through byte-identical. With 2+, provider IDs are namespaced `<backendId>/<nativeProviderID>` and a new session's backend is chosen from the requested prefix.
- **Registration**: backends register at startup via `registerBackend`; the bundled fake backend (`src/providers/fake/backend.ts`) is gated behind `OC_FAKE_BACKEND=1` for testing.

### 5. OMP RPC Process Manager (`src/providers/omp/rpc.ts`)
- Spawns and manages `omp --mode rpc` child processes communicating via newline-delimited JSON (NDJSON) over standard I/O.
- Ensures the project-owned `resources/omp` binary matches the `ompVersion` pin before the HTTP server starts, downloading that exact platform-specific release when it is missing or stale.
- Resolves `OMP_BIN` only as an explicit test/development override; otherwise it uses the staged project-owned binary and never searches PATH or common install directories.
- **Persistent Children**: Maintained per `(sessionID, directory)` pair for conversational prompt turns.
- **Ephemeral Children**: Spawned on-demand with automatic teardown for one-shot commands (e.g. `/config/providers`).
- **Caller-owned credentials**: When a prompt or `POST /config/providers` includes `credentials` or `credentialRef`, the sidecar creates a private temporary `PI_CODING_AGENT_DIR` containing only that child's generated `models.yml`; the normal no-auth path inherits the existing OMP environment unchanged.
- **Resilience & Gating**:
  - Gated on the first successful RPC response to a `get_state` probe rather than the `ready` frame, avoiding stalls caused by third-party LSP or MCP initialization.
  - Spawns children in detached process groups so parent termination cleanly tears down all descendant processes.
  - Overlays `mcp.enableProjectConfig: false` for the embedded instance to prevent project-level MCP deadlock.
  - Passes `PI_SKIP_VERSION_CHECK=1` to eliminate update check network delays.
  - Performs a non-blocking OMP release check after startup and every four hours; it reports newer releases but does not replace the running pinned binary. Bumping `ompVersion` in `package.json` is the explicit opt-in, and the next startup stages that exact version automatically.

### 6. Event Translation & SSE Stream (`src/adapters/openchamber/prompt.ts`, `src/shared/sse.ts`)
- Subscribes to OMP internal turn events (`message_update`, `tool_execution_*`, `turn_end`, `agent_end`).
- Synthesizes contract-compliant OpenCode SSE frames:
  - `message.updated` (creation / finalization)
  - `message.part.updated` & `message.part.delta` (live text, thinking/reasoning blocks, tool invocations)
  - `session.status` (`busy` / `idle`)
  - `server.connected` and periodic `server.heartbeat`
- Emits standard data-only SSE payloads compatible with OpenChamber's client pipeline (`resolveEventPayload`).

### 7. Jarvis adapter (`src/adapters/jarvis/*`)

Jarvisbot uses a separate internal adapter instead of the OpenChamber route
contract. It keeps Jarvis's `sessionId`, `turnId`, `attemptId`, workspace, and
capability policy as opaque caller-owned values while mapping each Jarvis
session to an OMP JSONL `sessionPath` and OpenCode-compatible provider id.

- `POST /internal/jarvis/v1/sessions` registers or reuses a provider binding.
- `POST /internal/jarvis/v1/sessions/:id/turns` starts an explicit turn.
- `GET /internal/jarvis/v1/sessions/:id/events` replays events as JSON or SSE.
- `POST /internal/jarvis/v1/sessions/:id/actions/:providerRequestId/result`
  and `/update` complete or update a pending OMP host-tool call.
- `POST /internal/jarvis/v1/sessions/:id/turns/:turnId` requests cancellation.
- `POST /internal/jarvis/v1/sessions/:id/reconcile` checks provider state after
  a sidecar restart and closes an abandoned active turn before reuse.

The adapter starts OMP with `--no-tools --no-extensions`, then registers only
the Jarvis-bound host tools using `set_host_tools`. OMP therefore supplies
model execution and transcript persistence, while Jarvis remains responsible
for capability authorization and executing the actual host action.
Reasoning/thinking deltas are intentionally omitted from the Jarvis public
event stream.

When `OC_JARVIS_TOKEN` is set, all internal routes require a matching Bearer
token (or `x-jarvis-token`). Bindings and their bounded event log are persisted
under `OC_JARVIS_STATE_DIR`, or the platform state directory when unset. Raw
credential payloads are never persisted; an opaque `credentialRef` may be
retained so the configured credential resolver can recreate a child.

### 8. Approvals & Custom Extensions (`src/adapters/openchamber/approvals.ts`, `src/adapters/openchamber/extensions/`)
- Surfaces interactive tool-call permissions and question requests to the OpenChamber frontend.
- Supports confirmation, rejection, and custom user write-ins.

### 9. Title Generation (`src/providers/omp/title.ts`)
- Generates descriptive session titles from the first turn using model output normalization.
- Injects titles directly into the fixed 256-byte session JSONL header slot matching OMP conventions.

---

## Core Invariants

1. **Zero Upstream Modifications**: Neither OpenChamber nor oh-my-pi source repositories are modified.
2. **Stable URLs**: Session IDs are deterministically mapped and survive proxy restarts.
3. **No Polling Overhead**: Fast-path transcript reads eliminate the process churn associated with polling active sessions.
4. **Clean Concurrency**: Session locks enforce `409 Conflict` on concurrent prompts to the same session while permitting parallel turns in separate sessions.
5. **Backend-Agnostic Surface**: The HTTP/SSE contract and session URL stability hold for every registered backend; routing is derived from session ids and model prefixes only.
