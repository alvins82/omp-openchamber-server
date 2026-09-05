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
| `listModels(cwd)` | → `OpenCodeProvidersResponse` | Provider/model catalog for the `/provider` surface. |
| `store` | `SessionStore` | Persistent session storage owned by this backend. |
| `createTurnConnection(cwd, sessionPath, openCodeId)` | → `BackendTurnConnection` | One live turn connection for a session. |
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
`abort()`, `kill()`, and optional `getInitialModel()`. Backends translate
their native streams into `NormalizedTurnEvent` (`src/providers/types.ts`):
`text_delta`, `reasoning_delta`, `tool`, `usage`, `model`, approvals/questions,
`subagent_*`, `todo`, `turn_end`. Ownership rules (from the type comments):

- The backend owns usage/model aggregation; a `usage` event is a full snapshot
  and MUST precede the terminal `turn_end`.
- Respond closures for approval/question requests are bound to the backend
  transport inside the backend; the SSE sink only decorates them.
- The sink finalizes the turn on every `turn_end`; a backend that ends without
  a definitive terminal event emits its own non-terminal `turn_end` after a
  grace timer.

## Registration & Selection

`src/providers/registry.ts`:

- `registerBackend(backend)` — idempotent on `id`. omp registers at startup;
  the fake backend registers only when `OC_FAKE_BACKEND=1` (env gate in
  `src/main.ts`).
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
  (checked in `src/prompt.ts` before the session lock is taken).

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
