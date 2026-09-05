# Server Architecture

`omp-openchamber-server` is a lightweight proxy server written in TypeScript for [Bun](https://bun.sh). It translates [OpenChamber](https://github.com/OpenChamber/OpenChamber) OpenCode HTTP/SSE client requests into [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) stdio RPC commands without requiring modifications to either project.

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
│  │   (main.ts)     │ │    (registry)    │ │   (sse.ts)   │  │
│  └────────┬────────┘ └────────┬─────────┘ └──────▲───────┘  │
│           │                   │                  │          │
│  ┌────────▼────────┐ ┌────────▼─────────┐ ┌──────┴───────┐  │
│  │ Backend Adapters│ │ JSONL Fast-Path  │ │ Event Bridge │  │
│  │ providers/omp/* │ │ providers/omp/*  │ │  (prompt.ts) │  │
│  └────────┬────────┘ └────────┬─────────┘ └──────────────┘  │
└───────────┼───────────────────┼─────────────────────────────┘
            │ stdio NDJSON      │ Direct FS Read
            ▼                   ▼
┌───────────────────────┐ ┌───────────────────────────────────┐
│     oh-my-pi CLI      │ │         Session JSONL             │
│ (omp --mode rpc ...)  │ │  (~/.omp/agent/sessions/*/*.jsonl) │
└───────────────────────┘ └───────────────────────────────────┘
```

---

## Subsystems

### 1. HTTP Server & Routing (`src/main.ts`)
- Implements the OpenCode HTTP API surface expected by OpenChamber.
- Supports multi-directory workspaces via `?directory=<path>` query parameters.
- Dispatches requests for sessions, transcripts, prompts, provider configs, and real-time event streams.
- Manages clean shutdown on `SIGINT` and `SIGTERM` signals.

### 2. Session Management & Fast Path (`src/providers/omp/store.ts`, `src/providers/omp/messages.ts`)
- **Session Discovery**: Scans `~/.omp/agent/sessions/<cwd-slug>/` for session JSONL files without spawning OMP subprocesses.
- **Transcript Fast Path**: Reads session JSONL records directly from disk (`loadMessagesFromFile`), mapping entries into OpenCode `{info, parts}` structures.
- **Deterministic ID Translation**: Reversibly maps OMP UUIDs (`8-4-4-4-12`) to OpenCode format (`ses_<32hex>`).
- **Session Creation**: Pre-allocates session header JSONL files for immediate UI visibility and navigation.

### 3. Provider Registry (`src/providers/registry.ts`)

The adapter seam that lets the sidecar serve multiple agent backends behind one unchanged OpenCode HTTP/SSE surface. Full adapter contract: [providers.md](providers.md).
- **AgentBackend contract**: each backend supplies a stable `id`, a provider catalog, a `SessionStore` (create/list/get/transcript), and a turn-connection factory. Capabilities (`todo`, `summarize`, `shell`, ...) gate the corresponding HTTP routes.
- **Session-ID codec**: legacy `ses_<32hex>` ids remain the default omp backend; non-default backends encode as `ses_<backendId>_<native>`. Routing is derived from the id alone — no registry file, restart-safe.
- **Model-picker routing**: with a single backend registered, provider IDs pass through byte-identical. With 2+, provider IDs are namespaced `<backendId>/<nativeProviderID>` and a new session's backend is chosen from the requested prefix.
- **Registration**: backends register at startup via `registerBackend`; the bundled fake backend (`src/providers/fake/backend.ts`) is gated behind `OC_FAKE_BACKEND=1` for testing.

### 4. OMP RPC Process Manager (`src/providers/omp/rpc.ts`)
- Spawns and manages `omp --mode rpc` child processes communicating via newline-delimited JSON (NDJSON) over standard I/O.
- **Persistent Children**: Maintained per `(sessionID, directory)` pair for conversational prompt turns.
- **Ephemeral Children**: Spawned on-demand with automatic teardown for one-shot commands (e.g. `/config/providers`).
- **Resilience & Gating**:
  - Gated on the first successful RPC response to a `get_state` probe rather than the `ready` frame, avoiding stalls caused by third-party LSP or MCP initialization.
  - Spawns children in detached process groups so parent termination cleanly tears down all descendant processes.
  - Overlays `mcp.enableProjectConfig: false` for the embedded instance to prevent project-level MCP deadlock.
  - Passes `PI_SKIP_VERSION_CHECK=1` to eliminate update check network delays.

### 5. Event Translation & SSE Stream (`src/prompt.ts`, `src/sse.ts`)
- Subscribes to OMP internal turn events (`message_update`, `tool_execution_*`, `turn_end`, `agent_end`).
- Synthesizes contract-compliant OpenCode SSE frames:
  - `message.updated` (creation / finalization)
  - `message.part.updated` & `message.part.delta` (live text, thinking/reasoning blocks, tool invocations)
  - `session.status` (`busy` / `idle`)
  - `server.connected` and periodic `server.heartbeat`
- Emits standard data-only SSE payloads compatible with OpenChamber's client pipeline (`resolveEventPayload`).

### 6. Approvals & Custom Extensions (`src/approvals.ts`, `extensions/`)
- Surfaces interactive tool-call permissions and question requests to the OpenChamber frontend.
- Supports confirmation, rejection, and custom user write-ins.

### 7. Title Generation (`src/title.ts`)
- Generates descriptive session titles from the first turn using model output normalization.
- Injects titles directly into the fixed 256-byte session JSONL header slot matching OMP conventions.

---

## Core Invariants

1. **Zero Upstream Modifications**: Neither OpenChamber nor oh-my-pi source repositories are modified.
2. **Stable URLs**: Session IDs are deterministically mapped and survive proxy restarts.
3. **No Polling Overhead**: Fast-path transcript reads eliminate the process churn associated with polling active sessions.
4. **Clean Concurrency**: Session locks enforce `409 Conflict` on concurrent prompts to the same session while permitting parallel turns in separate sessions.
5. **Backend-Agnostic Surface**: The HTTP/SSE contract and session URL stability hold for every registered backend; routing is derived from session ids and model prefixes only.
