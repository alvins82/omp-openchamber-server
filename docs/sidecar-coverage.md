# omp-openchamber-server — API Route Coverage Audit

> [!NOTE]
> This document details the baseline audit of the OpenCode HTTP API vs OMP RPC backend. Core gaps identified in this audit (SSE envelope, session creation, bootstrap shapes, lifecycle, part shapes) have since been resolved in `src/` and covered by the 172-test suite. See [`gap-map.md`](./gap-map.md) and [`contract-diff.md`](./contract-diff.md).

## 1. Architecture

- Bun HTTP server, default `:4096` (`OC_SIDECAR_PORT` overrides; `main.ts`). Single `fetch`
  handler with route dispatch.
- OMP 17.3.5 driven over **NDJSON stdio RPC**, one persistent child per (session, cwd)
  (`prompt.ts`, `rpc.ts`). `withOmpRpc` spawns an ephemeral child for one-shot RPC calls
  (e.g. `/config/providers`).
- Session discovery: scans `~/.omp/agent/sessions/<encoded-cwd>/*.jsonl`, reads the first 200
  lines for a `type:"session"` header (`sessions.ts`); OMP UUID → `ses_<32hex>` id mapping
  is a reversible transform (`sessions.ts`).
- Message loading: **JSONL file fast path first**, RPC fallback; cache with
  inflight dedupe (`messages.ts`).
- Graceful shutdown: SIGTERM/SIGINT kills every OMP child (`main.ts`) — a live turn would
  otherwise keep writing the session file ([`omp-protocol-notes.md`](./omp-protocol-notes.md)).
- The OpenChamber web server (port 3000) proxies `/api/*` here with the prefix stripped, so the proxy server sees bare `/session...`
  paths and answers for both the UI (via proxy) and direct server-side consumers.

## 2. Route-by-route audit (vs real opencode 1.17.11, probed 2026-08-24)

Legend: OK = wire-compatible · WRONG = served but shape/semantics off · MISSING = 404.

| Route (method) | Sidecar today | Real 1.17.11 | Verdict |
|---|---|---|---|
| `/health`, `/global/health` (GET) | `{healthy:true, status:"ok"}` | `{healthy:true, version:"1.17.11"}` (global) | PARTIAL: missing `version`; real `/health` returns the **web app HTML** (it is not a JSON route on the real server) |
| `/events`, `/global/event` (SSE GET) | `id:`+`event:`+bare-properties `data:` (sse.ts:33); `: heartbeat` comment every 20s (sse.ts:37-41) | `data:`-only frames: global `{payload:{id,type,properties}}`; scoped `{directory,project,payload}`; sync mirror frames; `server.heartbeat` data events | **WRONG (P0)**: UI `resolveEventPayload` drops every frame (no top-level `type`, no `payload` member; event-pipeline.ts:191-206, applied at 584-587) and there is no `server.connected` on stream open. The comment heartbeat never yields, but it still reaches the SDK `onSseEvent` callback (serverSentEvents.gen.js:85-93), which resets the UI 30s timer (event-pipeline.ts:561-562) and the sync-context watchdog (sync-context.tsx:2255-2261): the stream never times out, never reconnects, and the reconnect-driven resync (sync-context.tsx:2280-2297) never fires, so the UI store stays stale until navigation, a POST response, or manual refresh. The loss is silent, not churn |
| `/session` (GET) | real: scans JSONL, filters by `?directory=` (sessions.ts:144-189) | `Session[]` | PARTIAL: see §3 (missing fields, `projectID:""`) |
| `/session` (POST) | **stub**: `{id:"ro_<ts>", directory, time}`, 201 (main.ts:73-78) | real `Session` (`ses_` id, created by the server) | **WRONG (P0)**: id does not match any OMP session; `GET /session/{id}` on it 404s; `prompt_async` 404s. A new session in the UI is dead on arrival |
| `/experimental/session` (GET) | all/roots/limit variants (main.ts:81-102) | same shape as `/session` | PARTIAL (same session-shape issues) |
| `/session/status` (GET) | in-memory map from live children (main.ts:105-107, prompt.ts) | `Record<sessionID, SessionStatus>`, idle omitted | OK in shape; only reflects sessions with a live child |
| `/session/{id}` (GET) | header-driven (sessions.ts:191-230) | `Session` | PARTIAL (§3) |
| `/session/{id}` (PATCH) | — | `Session` (title/metadata update) | MISSING |
| `/session/{id}` (DELETE) | — | `true` | MISSING (UI calls it from 7 places; deleting a sidebar entry 404s) |
| `/session/{id}/message` (GET) | JSONL fast path / RPC fallback (messages.ts:412+) | `{info,parts}[]` | PARTIAL (§4) |
| `/session/{id}/message` (POST) | same as prompt_async (main.ts:151-163) | sync prompt returning `{info,parts}` | PARTIAL: returns `{queued:true}` instead of the completed message; UI treats it as a send (works, but the sync contract is unmet) |
| `/session/{id}/prompt_async` (POST) | real turn via OMP child (main.ts:135-148, prompt.ts) | `{queued:true}`-style ack | PARTIAL: works for the UI send path; errors return 400/409 |
| `/session/{id}/abort` (POST) | RPC `abort` to the child (main.ts:166-175) | true cancel (`true`) | PARTIAL: OMP `abort` interrupts the current turn but is **not** a hard kill; a running tool may finish; no guarantee the process state fully settles |
| `/session/{id}/todo` (GET) | — | `Todo[]` | MISSING (UI todo panel 404s; OMP `get_state.todoPhases` has the data) |
| `/session/{id}/command` (POST) | — | `{info,parts}` | MISSING (slash commands via OMP `prompt` do work, but the route is absent) |
| `/session/{id}/shell` (POST) | — | `{info,parts}` | MISSING (OMP `bash` has the mechanism) |
| `/session/{id}/fork` (POST) | — | new `Session` | MISSING (OMP `new_session{parentSession}` / `branch` can do it) |
| `/session/{id}/revert`, `/unrevert`, `/summarize`, `/share`, `/init`, `/children`, `/diff` | — | various | MISSING (revert ≈ `branch` + file state; summarize ≈ `compact`; share has no OMP RPC equivalent → honest 501) |
| `/session/{id}/message/{messageID}` (GET/DELETE), `.../part/{partID}` (PATCH/DELETE) | — | message/part CRUD | MISSING (UI does not call these in 1.20.0, so low priority) |
| `/permission` (GET) | `[]` (main.ts:206) | `PermissionRequest[]` | OK **for the default config** (OMP yolo = no permission prompts); WRONG if the user sets `always-ask`/`write` — there is no extension-UI bridge yet |
| `/permission/{id}/reply` (POST) | — | `true` | MISSING (same caveat) |
| `/question` (GET) | `[]` (main.ts:205) | `QuestionRequest[]` | OK in practice (OMP emits no question requests) |
| `/question/{id}/reply`, `/reject` (POST) | — | `true` | MISSING |
| `/config` (GET/PATCH) | `{}` (main.ts:196) | full `Config` | WRONG: empty object where the UI expects `{$schema?, model?, agent?, provider?, permission?, ...}`. Constructible from OMP settings + `get_state` |
| `/global/config` (GET/PATCH) | `{}` (main.ts:196) | global config object | WRONG (same) |
| `/config/providers` (GET) | ephemeral OMP child → `get_available_models` + `get_state` model (main.ts:178-191) | `{providers:[...], default:{providerID,modelID}}` | PARTIAL: correct top shape; spawns a 1-2s child per call; model objects lack the full `capabilities`/`cost`/`limit` fields the UI's model picker uses where available |
| `/agent` (GET) | `[]` stub (main.ts:194) | `Agent[]` `{name,description,mode,builtIn,permission,tools,...}` | WRONG as stub but data exists in OMP (built-in agents); UI renders an empty picker |
| `/command` (GET) | `[]` stub (main.ts:200) | `Command[]` `{name,description,template,...}` | WRONG: OMP `get_available_commands` / `available_commands_update` has the real list |
| `/skill` (GET) | `[]` stub (main.ts:201) | `Skill[]` `{name,description,location,content}` | PARTIAL: OMP has skills; RPC has no listing command in 17.3.5 → read the skill files directly if wanted |
| `/mcp` (GET) | `[]` (main.ts:202) | `{}` object | **WRONG TYPE**: array where an object is expected; UI `mcp.status` map handling may misbehave; should be `{}` |
| `/lsp` (GET) | `[]` (main.ts:203) | `[]` | OK (empty case matches) |
| `/vcs` (GET) | `[]` (main.ts:204) | `{branch, default_branch, ...}` object | **WRONG TYPE**: array where an object is expected; trivially fixable from `git` if the cwd is a repo |
| `/path` (GET) | `{directory, worktree, state:"ok"}` (main.ts:199) | `{home, state, config, worktree, directory}` with `state`/`config`/`worktree`/`home` all **paths** | **WRONG (P0)**: `state:"ok"` is a status string where a path is expected; `home`/`config` missing. UI getSystemInfo parses these |
| `/project`, `/project/current` (GET) | single object `{directory, worktree}` (main.ts:197-198) | **array** of `Project` (`/project`) / one `Project` (`/project/current`): `{id, worktree, vcs, time:{created,updated}}` | **WRONG (P0)**: `/project` must be an array; `id`/`time` missing |
| `/file`, `/file/content`, `/file/status` (GET) | — | file listing/content (web-server has its own `/api/fs/*`, so UI file browsing partially bypasses these) | MISSING (medium: UI `readFile`/`listFiles`/`searchFiles` go through the proxy, so these matter when a scoped client is used) |
| `/find`, `/find/file`, `/find/symbol` (GET) | — | search | MISSING (`searchFiles` uses `/find/file` via scoped client) |
| `/pty*` | — | PTY API | MISSING (UI does not call; web terminal uses the web server's own WS) |
| `/auth/{providerID}` (PUT/DELETE) | — | auth store | MISSING (custom-provider forms; low priority) |
| `/provider*`, `/vcs/*` extras, `/formatter`, `/instance/dispose`, `/log`, `/tui/*`, `/sync/*`, `/global/dispose`, `/global/upgrade` | — | various | MISSING (none called by the 1.20.0 UI) |
| `/api/*` (v2 generation: `/api/session*`, `/api/event`, `/api/health`, …) | — | v2 API | MISSING — mostly fine (UI only calls `/api/session/{id}/permission{,/{requestID}}` optionally; 404 is the documented "pre-v1.17.12" fallback and the UI treats it as resolved) |
| anything else | 404 `{error:"not implemented"}` | — | expected |

## 3. Session object (sessions.ts:113-142)

Current: `{id: ses_<32hex>, slug: <same ses_ id>, projectID: "", directory: <cwd>, path:
<jsonl path>, title: <header title | "Session <first8>" >, agent: "omp", model: {providerID:
"omp", modelID: "omp", variant: "default"}, version: <header | "0.0.0">, time: {created,
updated}, cost: 0, tokens: {input: 0, output: 0}}`.

vs the shapes:
- v1 `Session` (SDK gen/types.gen.d.ts:465): `projectID` is required ("" is legal but the UI
  routes by it; real server uses a project id or "global"); no `slug`, `path`, `agent`, `model`,
  `cost`, `tokens` in the v1 type (extras are harmless).
- v2 `Session` (v2/gen/types.gen.d.ts:64, what the UI types against): wants `slug`, `cost?`,
  `tokens?` **with reasoning + cache subfields**, `model?: {id, providerID, variant?}` (the
  sidecar nests under `model.providerID/modelID` instead of `id`), `time.{created,updated}`,
  `parentID?`.
- Real 1.17.11 (live capture): `{id: ses_<ulid>, slug: <wordy slug>, projectID: "global",
  directory, path, cost: 0, tokens: {input, output, reasoning, cache:{read,write}}, title:
  "New session - <ISO>", version: "1.17.11", time: {created, updated}}`.

Verdict: close, but `tokens` lacks `reasoning`/`cache`, `model` uses the wrong key (`modelID`
vs `id`), `projectID` is "" instead of a stable id, `slug` is the raw ses_ id, `version` is the
OMP header version, and there is **no `session.created` event** when a new session appears
(OMP only writes the JSONL after the first completed turn, and the sidecar never emits
`session.created` at all — the UI only learns of new sessions via list re-fetch).

## 4. Message mapping (messages.ts)

Record shape: `{info: {id: msg_<ses>_<ompMsgId|idx>, role, sessionID, agent: "omp", model:
{providerID, modelID, variant}, providerID?, modelID?, variant?, finish?: "stop", time:
{created, completed?}}, parts: [...]}`.

vs the contracts (gen/types.gen.d.ts:39-127, v2 types:64):
- v1 `AssistantMessage` requires `mode`, `path: {cwd, root}`, `cost`, `tokens{input,output,
  reasoning, cache{read,write}}` — **none present** (the sidecar has no flat `mode` at all).
  The UI's reducer and message rendering tolerate the absence (fields are read defensively),
  but `tokens`/`cost` being absent means the UI's cost display is always zero and the type
  contract is violated.
- v1 `UserMessage` requires `agent` + `model{providerID, modelID}` — the sidecar puts `agent`
  but the user message's `model` is derived, not from the request.
- `ToolPart`: sidecar puts the OMP tool call id under `metadata.toolCallId` (messages.ts:136)
  instead of the required top-level `callID` (types.gen.d.ts:268) — and the UI's permission
  `tool: {messageID, callID}` cross-reference (and any tool-part keying) expects `callID`.
- **Message ids are not stable across refetches**: `msg_${openCodeId}_${msg.id ?? visibleIndex}`
  (messages.ts:283) — when the RPC fallback yields no stable OMP message id, the id is derived
  from position, so a refetch after a new message changes earlier ids. UI reducers key by
  message id, so this can cause dropped/replaced entries on resync.
- Event ordering during a turn (prompt.ts): `session.status` busy (436) → per text chunk:
  `message.part.updated` (full accumulated snapshot, 169/310) **then** `message.part.delta`
  (362) → tool parts re-emitted as `message.part.updated` on every state change →
  `emitAssistantInfo` for the new assistant message (141) → `session.idle` at turn end
  (487/513). The part-before-delta order is correct for the UI reducer's invariant. The
  `agent_end` → `session.idle` mapping treats **every** `agent_end` as terminal
  (prompt.ts) even when `isTerminal === false` (docs/rpc.md:503-511) — a non-terminal settle
  will falsely mark the session idle mid-run until the next event arrives.
- The error path (P11) emits assistant info + a "Prompt failed: ..." text part, then idle —
  good; it does not emit a `session.error` event (real server does).

## 5. SSE stream (sse.ts) — the P0

- Wire format today (sse.ts:33): `id: <counter>\nevent: <type>\ndata: <JSON of properties
  only>\n\n`.
- The SDK SSE client (gen/core/serverSentEvents.gen.js:46-92) yields the parsed `data` JSON and
  ignores `id:`/`event:` lines. The UI's `resolveEventPayload` (event-pipeline.ts:191) requires
  a top-level `type` string or a `payload` member with a `type` string. **Sidecar frames have
  neither → every event is dropped.** Live rendering in the UI does not work at all today.
- No `server.connected` on connect, no `server.heartbeat` data events. The `: heartbeat`
  comments never yield, but they do reach the SDK `onSseEvent` callback
  (serverSentEvents.gen.js:85-93), which the UI uses to reset its 30s timer
  (event-pipeline.ts:561-562) and the sync-context watchdog (sync-context.tsx:2255-2261).
  Consequence: the stream stays connected indefinitely, so no heartbeat timeout, no reconnect,
  and no `onReconnect` resync (sync-context.tsx:2280-2297). Combined with the frame drop the UI
  store only refreshes via non-stream channels (bootstrap/list fetches, session navigation, POST
  responses, web-server hub re-broadcast). The web server's own hub parser accepts bare
  properties frames (packages/web/server/lib/event-stream/protocol.js:14-68), so its
  `openchamber:session-status` re-broadcast (event-pipeline.ts:95) partially compensates for the
  status indicator only.
- No `directory`/`project` envelope on scoped events (the UI uses `directory` for routing
  multi-directory state).
- No `session.created` events at all.
- The sidecar's own tests pin the wrong format: contract.test.ts:85-106 assert
  `id: <uuid v4>\nevent: <type>\ndata: <properties>` — these encode the bug and must change
  with the fix.
- Contract-correct minimum frame: `data: {"type":"<name>","properties":{...}}` (top-level
  `type` satisfies resolveEventPayload). Real-server-faithful frame: `data:
  {"directory":"<cwd>","project":"<pid>","payload":{"id":"evt_<ulid>","type":"<name>","properties":{...}}}`
  for scoped events and `data: {"payload":{...}}` for global ones.

## 6. Test inventory (user-written, all passing as of 2026-08-24)

| File | Lines | Covers |
|---|---|---|
| contract.test.ts | 567 | id mapping, **SSE wire format (wrong, pins the P0 bug)**, per-emit event shapes, stream forwarding, route response shapes |
| contract.sequence.test.ts | 221 | event ordering invariants (part before delta, etc.) |
| integration.test.ts | 371 | route-level behavior against a mocked OMP |
| integration.live.test.ts | 604 | live OMP child end-to-end |
| messages.file.test.ts | 184 | JSONL → OpenCode record mapping |
| prompt.orchestration.test.ts | 364 | turn lifecycle, status transitions |
| prompt.tool-part.test.ts | 105 | tool part state machine |
| rpc.connection.test.ts | 296 | child spawn/lifecycle/reconnect |
| rpc.mapping.test.ts | 123 | OMP → OpenCode payload mapping |
| sessions.test.ts | 192 | header parsing, id mapping, listing filters |

Known test/contract mismatches to fix alongside the code: (1) contract.test.ts:85-106 SSE
format; (2) contract.test.ts:124 uses `status:{type:"processing"}` which is not a valid
`SessionStatus` ("idle" | "busy" | "retry").

## 7. Behavioral gaps not visible in the route table

- POST /session never creates anything on disk; OMP sessions only exist after the first turn
  completes (JSONL materialization) — so the sidecar cannot return a usable `ses_` id until
  either (a) it pre-creates a header-only JSONL, or (b) it defers the real id until the first
  turn and keeps an alias table.
- `/config/providers` spawns an ephemeral child per call (1-2s latency); a shared idle child
  would fix it.
- `abort` is OMP's soft abort (current turn interrupted, tools may run to completion); the
  UI expects true cancellation semantics.
- Message ids are position-derived when OMP gives no stable id (see §4).
- `agent_end.isTerminal === false` is ignored (see §4).
- One OMP child per (session, cwd): switching cwd for the same OMP session spawns a second
  child that cannot see the first's in-memory state (known; mitigated by the JSONL fast path).
- No write path for config (PATCH /config 404s) — the UI's settings editing surface will
  no-op with errors.
