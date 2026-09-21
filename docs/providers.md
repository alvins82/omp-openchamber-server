# Providers — Multi-Backend Adapter Layer

The sidecar serves one unchanged OpenCode HTTP/SSE surface on top of a swappable
agent-backend layer (`src/providers/`). The first backend is **omp**
(oh-my-pi over stdio RPC); additional backends register through the same
adapter contract. The bundled **fake** backend (`src/providers/fake/backend.ts`)
is a test double that exercises the full path without spawning a real agent.

## Adapter Contract

Defined in `src/providers/types.ts`.

### `AgentBackend` — one agent backend

| Member | Kind | Notes |
| --- | --- | --- |
| `id` | string | Stable; also the session-id prefix for non-legacy sessions (`fake`, `omp`). |
| `label` | string | Display name. |
| `capabilities` | `BackendCapabilities` | Feature matrix; gates backend-specific routes (below). |
| `defaultModel` | `ModelRef` | Used when the client omits `model`. |
| `listModels(cwd, auth?)` | → `OpenCodeProvidersResponse` | Provider/model catalog for the `/provider` surface; `auth` is opt-in caller-owned credentials. |
| `store` | `SessionStore` | Persistent session storage owned by this backend. |
| `createTurnConnection(cwd, sessionPath, openCodeId, auth?)` | → `BackendTurnConnection` | One live turn connection for a session; `auth` is opt-in caller-owned credentials. |
| `shutdownAll()` | void | Tear down all transport processes on sidecar shutdown. |

### `SessionStore` — session persistence

`create`, `get`, `list`, `delete`, `update`, `setTitle`, `children`,
`transcript` are required. `transcript(openCodeId, cwd)` receives the **cwd
explicitly** — backends must not assume a global working directory, because the
sidecar serves multi-directory workspaces via `?directory=`. Optional hooks:
`beforeTurn` (cache invalidation before dispatching a turn),
`recordUserMessage` (persist the user prompt even when the backend never
emits it back), `getTodos`.

### `BackendTurnConnection` — one live turn

`onEvent(sink)`, `prompt(input)`, `setModel(providerID, modelID)`,
`abort()`, `kill()`, and optional `getInitialModel()` and
`getSubagentStatuses()`. The latter returns the backend's current live
subagent snapshot so `/session/status` can recover when a lifecycle event was
missed. Backends translate
their native streams into `NormalizedTurnEvent` (`src/providers/types.ts`):
`text_delta`, `reasoning_delta`, `tool`, `usage`, `model`, approvals/questions,
`subagent_*`, `todo`, `telemetry`, `turn_end`. Ownership rules (from the type comments):

- The backend owns usage/model aggregation; a `usage` event is a full snapshot
  and MUST precede the terminal `turn_end`.
- Respond closures for approval/question requests are bound to the backend
  transport inside the backend; the SSE sink only decorates them.
- The sink finalizes the turn on every `turn_end`; a backend that ends without
  a definitive terminal event emits its own non-terminal `turn_end` after a
  grace timer.
- `telemetry` is an optional aggregate over completed raw model requests in the
  current visible turn. It is kept separate from the latest `usage` snapshot
  because the latter drives context-window display.

## Registration & Selection

`src/providers/registry.ts`:

- `registerBackend(backend)` — idempotent on `id`. omp registers at startup;
  the fake backend registers only when `OC_FAKE_BACKEND=1` (env gate in
  `src/server.ts`).
- Registration order matters: `defaultBackend()` is `backends[0]` (omp).
- `resetBackends()` restores the default catalog; test-only.
- `listProviders` / `listSessionsAcrossBackends` merge catalogs and session
  listings across all registered backends.

### Session-ID codec (D2)

- Legacy `ses_<32hex>` ids are always routed to the default backend — omp
  sessions created before this layer keep stable URLs.
- Non-default backends encode `ses_<backendId>_<nativeId>`.
- `backendForSession(openCodeId)` parses the id alone; no registry file, so
  session URLs survive restarts (invariant 2).

### Model-picker routing (D1)

- **Single backend**: provider IDs pass through byte-identical — zero behavior
  change versus the pre-abstraction sidecar.
- **2+ backends** (`isMultiBackend()`): provider IDs are namespaced
  `<backendId>/<nativeProviderID>` (e.g. `fake/fake`, `omp/deepseek`).
  `splitProviderPrefix` strips the prefix once; `nativeProviderID` gives the
  bare id for backend calls (D13). Unknown prefixes are not an error.
- A new session's backend is chosen from the prefix of
  `body.model.providerID` on `POST /session`; absent/unknown → default.
- A session is bound to its backend for its lifetime: prompting with a
  namespaced model that belongs to a different backend returns
  `400 — model provider does not belong to this session's backend`
  (checked in `src/adapters/openchamber/prompt.ts` before the session lock is taken).

## Capability Gating

`BackendCapabilities` is consulted by the HTTP routes:

| Capability | Route | When `false` |
| --- | --- | --- |
| `todo` | `GET /session/:id/todo` | `200` with `[]` |
| `compact` | `POST /session/:id/summarize` | `501` "summarize not supported by backend" |
| `shell` | `POST /session/:id/shell` | `400` "shell not supported by backend" |
| `titleGeneration` | auto-titling after first turn | skipped |

`thinkingLevels`, `images`, `approvals`, `subagents`, and `skills` are declared
in the matrix but not yet consulted by any route; they exist so backends can
declare intent without a contract change later.

## Caller-owned credentials (opt-in)

The sidecar can run one OMP child with credentials supplied by its caller. This
is intended for a host application that owns provider configuration, such as a
settings UI or a credential broker. It does not change OMP's normal behavior
unless the request contains exactly one of `credentials` or `credentialRef`.

Prompt requests can include either envelope:

```json
{
  "parts": [{ "type": "text", "text": "List the files" }],
  "model": { "providerID": "openai", "modelID": "gpt-5" },
  "credentials": {
    "apiKey": "...",
    "baseUrl": "https://api.example.com/v1",
    "headers": { "X-Tenant": "tenant-a" }
  }
}
```

or:

```json
{
  "parts": [{ "type": "text", "text": "List the files" }],
  "model": { "providerID": "openai", "modelID": "gpt-5" },
  "credentialRef": "vault://team-a/openai"
}
```

`providerID` is optional inside `credentials` when a selected model provides
it. If it is present, it must match the selected model's native OMP provider
ID. The envelope follows OMP's provider section and supports `providerID`,
`apiKey`, `baseUrl`, `api`, `auth`, `authHeader`, `headers`, `compat`,
`discovery`, `remoteCompaction`, `modelOverrides`, `disableStrictTools`,
Bedrock guardrail fields, `transport`, and optional OMP `models` definitions.

`credentialRef` is opaque to OMP. Install a process-local resolver with
`setCredentialResolver`, or configure an HTTP resolver with
`OC_CREDENTIAL_RESOLVER_URL` and optional `OC_CREDENTIAL_RESOLVER_TOKEN`. The
HTTP resolver receives `{ credentialRef, providerID, modelID, cwd,
openCodeId }` and returns either the credential object directly or under a
`credentials`/`credential` property.

The same reference reuses the session's persistent credentialed child. To
force a refreshed credential, send a new reference value or start a new
session; a changed direct credential payload also replaces the child.

`POST /config/providers` accepts the same credential envelope plus an optional
`model` object and returns the catalog discovered by an isolated OMP child.
This lets a settings UI discover models without changing the legacy
`GET /config/providers` behavior.

Raw credentials are not written to session records or sent in OMP prompt RPC
frames. For a credentialed child, the sidecar creates a private temporary
`PI_CODING_AGENT_DIR` with a generated `models.yml`, then removes it when the
child exits. Cleanup is best effort if the host process is terminated abruptly;
the resolver mode is preferred when the sidecar should not receive long-lived
secrets at all.

## Fake Backend (`src/providers/fake/backend.ts`)

- In-memory `SessionStore`; session ids `ses_fake_<uuid>`; never touches disk.
- All nine capabilities are `false` — used by tests to assert every gate.
- Turns are scripted: `setFakeTurnScript(...)` overrides the default script,
  which streams a `text_delta` of `fake: <last message text>` and ends with
  `usage` → `model` → `turn_end`.
- Registered only under `OC_FAKE_BACKEND=1`, so production behavior is
  byte-identical when the flag is absent.
- Tests: `src/providers/fake/backend.test.ts` (in-process) and
  `src/providers/fake/backend.http.test.ts` (spawns the real sidecar on port
  4399 and drives catalog, routing, gates, SSE turn, and the D1 mismatch rule
  over HTTP).

## Jarvis adapter (`src/adapters/jarvis/*`)

The Jarvis integration is intentionally not another OpenCode backend. It is a
separate internal adapter mounted by `src/server.ts` at
`/internal/jarvis/v1/*`. The adapter reuses `providers/omp/rpc.ts` and the OMP
session store, but does not change the public OpenChamber/OpenCode routes.

### Session and turn ownership

Jarvisbot owns the durable `sessionId`, `turnId`, `attemptId`, lease fences,
run authorization, and capability execution. The sidecar owns only:

| Sidecar value | Purpose |
| --- | --- |
| `provider.openCodeId` | OMP's deterministic external session id. |
| `provider.sessionPath` | OMP's append-only JSONL transcript path. |
| `sequence` | Monotonic cursor for adapter events. |
| `providerRequestId` | OMP host-tool request id required to submit a result. |

The provider mapping is returned from session creation and is also persisted
in the sidecar state file, so a worker can reconnect or reconcile after a
sidecar restart. A session with an abandoned active turn is marked
`recovery_required` until `/reconcile` observes that OMP is idle.

### Host-tool boundary

Every Jarvis `tools` or `boundCapabilities` definition is converted to an OMP
`set_host_tools` definition. Jarvis capability fields such as
`requiresApproval` and `category` remain sidecar metadata; OMP never uses them
to authorize execution. OMP is started with `--no-tools --no-extensions`, so only these
explicitly registered host tools are callable. On `host_tool_call`, the
adapter emits `tool_call_proposed`; Jarvis executes the capability and posts a
`host_tool_result` or `host_tool_update` back through the action route.

The adapter never forwards OMP thinking deltas as public Jarvis events. Text
deltas, host-tool lifecycle, cancellation, terminal completion, and provider
failure are represented as replayable events with the caller's turn/attempt
ids.
