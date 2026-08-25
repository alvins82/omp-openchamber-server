# OpenChamber 1.20.0 — OpenCode Protocol Usage

Captured 2026-08-24. Sources: OpenChamber UI (`packages/ui/src/lib/opencode/client.ts`,
`packages/ui/src/sync/event-pipeline.ts`, `packages/ui/src/sync/event-reducer.ts`),
OpenChamber Web Server (`packages/web/server/lib/opencode/proxy.js`), and `@opencode-ai/sdk` 1.18.21.

## 0. Topology

UI (web/electron/mobile/vscode) → OpenChamber **web server** (default :3000) → upstream "opencode"
(OpenChamber normally spawns `opencode serve`; in our setup the sidecar answers on :4096).

- UI base URL: `DEFAULT_BASE_URL = import.meta.env.VITE_OPENCODE_URL || "/api"` (client.ts:44).
- Web server proxy: `app.use('/api', ...)` with `pathRewrite: { '^/api': '' }` (proxy.js:883) strips the
  `/api` prefix and forwards everything else verbatim. UI `/api/session/{id}/abort` → upstream
  `/session/{id}/abort`.
- UI SDK client comes from `@opencode-ai/sdk/v2`; the UI uses the **legacy v1 namespaces** of that SDK
  for all core flows (`client.session.*` = Session2 → `/session*` routes). The only v2-namespace call
  sites are the optional permission create/get (client.ts:1203, 1244).
- Directory scoping: `getScopedSdkClient(directory)` / `getScopedApiClient(directory)` produce a client
  whose requests carry `?directory=...`. Nearly every call passes it when a directory is known.

## 1. Web-server-owned routes (not proxied; sidecar must not implement)

| Route (as the UI sees it) | Purpose |
|---|---|
| `/health` (no /api) | web-server liveness; first bootstrap call (bootstrap.ts) |
| `/api/opencode/health` | web server health-checks the upstream itself; UI `checkHealth()` (client.ts:1706) |
| `/api/opencode/directory` | switch working directory (client.ts:1745) |
| `/api/session-activity` | web-server in-memory activity (client.ts:1122) |
| `/api/openchamber/events`, `/api/openchamber/realtime-proxy/sse` | web-server hub re-broadcast; `openchamber:session-status` records normalized by the pipeline (event-pipeline.ts:95) |
| `/api/global/event/ws`, `/api/event/ws`, `/api/terminal/ws` | WS bridges over the upstream SSE (realtime-proxy) |
| `/api/notifications/*`, `/api/fs/*`, `/api/settings`, `/api/system/*`, `/api/github*`, `/api/agent-memory`, magic-prompts, client-auth, relay, scheduled-tasks | OpenChamber features with no opencode equivalent (client.ts:1745-1990) |

Special proxied routes with extra behavior (proxy.js):
- `GET /api/session` → `forwardSanitizedSessionListRequest` (sanitizer + Windows cross-dir merge; def 657, registered 859)
- `GET /api/experimental/session` → same sanitizer (registered 866)
- `GET /api/global/event`, `GET /api/event` → `forwardSseRequest` (def 458, registered 862-863)
- `POST /api/provider/:providerID/oauth/callback`, `POST /api/mcp/:name/auth/authenticate` → interactive OAuth passthrough (951, 955)

The web server is a **second consumer** of the same upstream API, directly (not via the proxy): the
event-stream hub reads upstream `/global/event` (global-hub.js:70) with stall detection
(`DEFAULT_UPSTREAM_STALL_TIMEOUT_MS` in upstream-reader.js), plus notification logic (last assistant
message fetch), session-activity tracking, and config/provider reads. Sidecar answers both consumers
with one contract.

## 2. opencode routes the UI actually calls

Route table reference: `sdk/node_modules/@opencode-ai/sdk/dist/v2/v2-routes.tsv` (188 entries,
SDK 1.18.21). `⟨dir⟩` = optional `?directory=` param. All rows below are `client.<ns>.<method>` in
client.ts.

### Session lifecycle (Session2 = v1 routes)
| UI method | Route | Body/params | Expected response |
|---|---|---|---|
| listSessions | `GET /session` ⟨dir⟩ | — | `Session[]` |
| createSession | `POST /session` ⟨dir⟩ | `{parentID?, title?, metadata?}` | `Session` (201) |
| getSession | `GET /session/{id}` ⟨dir⟩ | — | `Session` |
| updateSession | `PATCH /session/{id}` ⟨dir⟩ | `{title?, metadata?}` | `Session` |
| deleteSession | `DELETE /session/{id}` ⟨dir⟩ | — | `true` (7 call sites: sidebar, archive, worktree cleanup…) |
| getSessionStatus | `GET /session/status` ⟨dir⟩ | — | `Record<sessionID, SessionStatus>`; **idle sessions omitted** = idle; a fetch failure must return `null`, not `{}` (client.ts:1081-1101) |
| forkSession | `POST /session/{id}/fork` ⟨dir⟩ | `{messageID?}` | `Session` (new id) |
| revertSession | `POST /session/{id}/revert` ⟨dir⟩ | `{messageID, partID?}` | `Session` |
| unrevertSession | `POST /session/{id}/unrevert` ⟨dir⟩ | — | `Session` |
| summarizeSession | `POST /session/{id}/summarize` ⟨dir⟩ | `{providerID, modelID}` | `true` |
| abortSession | `POST /session/{id}/abort` ⟨dir⟩ | — | `true` |
| sendCommand | `POST /session/{id}/command` ⟨dir⟩ | `{command, arguments, model:"prov/model", agent?, variant?, parts?, messageID}` | `{info: Message, parts: Part[]}` |
| shellSession | `POST /session/{id}/shell` ⟨dir⟩ | `{messageID, agent, model, command}` | `{info: Message, parts: Part[]}` |
| getSessionTodos | `GET /session/{id}/todo` ⟨dir⟩ | — | `Todo[]` |
| (session.messages) | `GET /session/{id}/message` ⟨dir⟩ | — | `{info: Message, parts: Part[]}[]` — on-demand load + reconnect resync |
| (session.prompt) | `POST /session/{id}/message` | `{parts, model, agent?, variant?, messageID?, system?, tools?, temperature?, ...}` | `{info: Message, parts: Part[]}` — legacy sync prompt, kept as fallback |
| sendMessage | `POST /session/{id}/prompt_async` ⟨dir⟩ | same fields as prompt | success → caller proceeds; transport failure marked "outcome unknown", never retried (client.ts:898-957) |

Session2 routes in the SDK the UI does **not** call: `children`, `diff`, `init`, `share`/`unshare`
(no call site found; share is web-server-side), `message` (single GET), `deleteMessage`.

### Status / metadata
| UI method | Route | Expected response |
|---|---|---|
| getSystemInfo | `GET /path` ⟨dir⟩ | `{home, state, config, worktree, directory}` — 5 fields, all present in real 1.17.11 |
| probeDirectory | `GET /path` ⟨dir⟩ | 200 = directory available |
| project.current | `GET /project/current` ⟨dir⟩ | `Project` |
| project.list | `GET /project` | `Project[]` (array) |
| vcs.get | `GET /vcs` ⟨dir⟩ | `VcsStatus` object: `{branch, default_branch, ...}` |
| mcp.status | `GET /mcp` ⟨dir⟩ | `Record<name, McpStatus>` object (`{}` when none) |
| lsp.status | `GET /lsp` ⟨dir⟩ | object/`[]` (real server: `[]` when none) |
| listAgents | `GET /agent` ⟨dir⟩, fallback `runtimeFetch('/api/agent')` (client.ts:1562) | `Agent[]`: `{name, description, mode, native, permission[], ...}` |
| listSkillsWithDetails | `GET /skill` ⟨dir⟩ | `Skill[]`: `{name, description, location, content}` |
| listCommands / listCommandsWithDetails / getCommandDetails | `GET /command` ⟨dir⟩ | `Command[]`: `{name, description, source, template, agent?, model?}` |
| listToolIds | `GET /experimental/tool/ids` ⟨dir⟩ | `string[]` (UI filters out `"invalid"`) |
| getConfig | `GET /config` (scoped when dir) | `Config`: `{$schema?, model?, agent?, provider?, permission?, lsp?, ...}` |
| updateConfig / updateConfigPartial | `PATCH /config` (global, no dir) | `Config` |
| getProviders / getProvidersForConfig | `GET /config/providers` ⟨dir⟩ | `{providers: Provider[], default: {providerID, modelID}}` |
| auth.set (custom provider forms) | `PUT /auth/{providerID}` | — |
| checkHealth | web-server `/api/opencode/health` | `{healthy: boolean}` |

### Files
| UI method | Route |
|---|---|
| readFile | `GET /file/content?path=...&directory=...` |
| listFiles | `GET /file?path=...&directory=...` |
| searchFiles | `GET /find/file?query=...&limit=...&dirs=...&type=...` (scoped client) |
| (web-server, not opencode) listLocalDirectory / getHome / createDirectory / cloneRepository | `/api/fs/list`, `/api/fs/home`, `/api/fs/mkdir`, `/api/fs/clone` (client.ts:1745-1990) |

### Permissions / questions (blocking UI flows)
UI types: `PermissionRequest = {id, sessionID, permission, patterns: string[], metadata, always: string[], tool? {messageID, callID}}` (ui/src/types/permission.ts);
`QuestionRequest = {id, sessionID, questions: [{question, header, options: [{label, description}], multiple?}], tool?}`.

| UI method | Route | Notes |
|---|---|---|
| listPendingPermissions | `GET /permission` (unscoped + per-directory) | `PermissionRequest[]` |
| replyToPermission | `POST /permission/{id}/reply` ⟨dir⟩ | `{reply: 'once' \| 'always' \| 'reject', message?}` → `true` |
| createPermission (optional) | `POST /api/session/{id}/permission` (client.ts:1203) | v2 route; **any failure incl. 404 → null → UI does not act** (pre-v1.17.12 fallback, comment at client.ts:1268) |
| fetchPermission (optional) | `GET /api/session/{id}/permission/{requestID}` (client.ts:1244) | 200 → pending; **404 → "resolved"**; other → unknown. A sidecar 404 "not implemented" is indistinguishable from resolved: auto-accept silently drops the request. Degrades, does not break. |
| listPendingQuestions | `GET /question` (unscoped + per-dir) | `QuestionRequest[]` |
| replyToQuestion | `POST /question/{id}/reply` ⟨dir⟩ | `{answers: string[][]}` → `true` |
| rejectQuestion | `POST /question/{id}/reject` ⟨dir⟩ | — → `true` |

## 3. Event consumption (SSE primary, WS fallback)

- **Primary: SSE via `client.global.event()` = `GET /global/event`**. Reconnect passes
  `Last-Event-ID` header (event-pipeline.ts:560); the SDK records `lastEventId` only when an SSE frame
  carries an `id:` line (gen/core/serverSentEvents.gen.js:63-92). Heartbeat timeout
  (event-pipeline.ts:544-548, `DEFAULT_HEARTBEAT_TIMEOUT_MS`), exponential reconnect.
- **Fallback: WebSocket** `…/global/event/ws?lastEventId=…` (event-pipeline.ts:208-232) —
  web-server-owned bridge, not an opencode route.
- SDK SSE client parses each `data:` line as JSON (or raw string) and yields it; the `event:` line is
  ignored (serverSentEvents.gen.js:46-92).
- Pipeline dispatch: `resolveEventPayload(payload)` (event-pipeline.ts:191) accepts a payload with a
  top-level `type` string or a `payload` member carrying one; anything else → **null, event dropped**.
- The UI dispatches on the v2 SDK `Event` union (89 members, v2/gen/types.gen.d.ts:4).
  `reduceGlobalEvent` (event-reducer.ts:191-199) handles `global.disposed`, `server.connected` (→ full
  refresh) and `project.updated`. The directory-event switch (event-reducer.ts:241, 22 case clauses)
  handles: `server.instance.disposed`, `session.created`, `session.updated`, `session.deleted`,
  `session.diff`, `session.status`, `session.idle`, `session.error`, `message.updated`,
  `message.removed`, `message.part.updated`, `message.part.removed`, `message.part.delta`,
  `todo.updated`, `vcs.branch.updated`, `permission.asked`, `permission.replied`, `question.asked`,
  `question.replied`, `question.rejected`, `lsp.updated`.
  Total handled: **24 types**. Not handled (emitted by real 1.17.11, ignored by the 1.20.0 UI): all
  `session.next.*` (~30), `permission.v2.*`, `question.v2.*`, `session.compacted`, `file.edited`,
  `file.watcher.updated`, `installation.*`, `tui.*`, `pty.*`, `command.executed`, `mcp.toolsChanged`,
  `models.devRefreshed`, `reference.updated`, `integration.*`, `catalog.updated`, `plugin.added`,
  `worktree.*`, `workspace.*`.

- **Reducer invariants a reimplementation must respect** (event-reducer.ts):
  - `message.part.delta` requires the part to already exist in draft state (created by an earlier
    `message.part.updated`); otherwise it is dropped with a materialization reason `orphan-delta` /
    `missing-delta-part` (event-reducer.ts:478-515, reasons at 160-171). Sidecar must emit part
    `updated` **before** the first `delta`.
  - `message.part.delta` properties: `{sessionID, messageID, partID, field, delta}` (`field: "text"`).
  - `session.status` properties: `{sessionID, status: SessionStatus}` where
    `SessionStatus = {type: 'idle'} | {type: 'busy'} | {type: 'retry', attempt, message, next?}`.
  - `session.diff` properties: `{sessionID, diff: FileDiff[]}`.
  - The pipeline coalesces consecutive deltas of the same part (event-pipeline.ts:~520); a
    full-snapshot `message.part.updated` between deltas resets the merge window. Both orders safe.
  - Reconnect fires `onReconnect` → UI resync: `GET /session`, `GET /session/status` per dir,
    `GET /session/{id}/message`. These three GET routes are the recovery path, so they must be correct.

## 4. Wire format of `/global/event` (verified against real `opencode serve` 1.17.11, 2026-08-24)

Frames are **`data:`-only** — no `id:` line, no `event:` line, blank-line separated:

```
data: {"payload":{"id":"evt_031b0e040001HKM18A6jcqlqzR","type":"server.connected","properties":{}}}

data: {"directory":"/private/tmp/oc-probe","project":"global","payload":{"id":"evt_031b0e433001FRmh3DB5JstIhd","type":"session.created","properties":{"sessionID":"ses_…","info":{…Session…}}}}

data: {"directory":"…","project":"…","payload":{"type":"sync","syncEvent":{"id":"evt_…","type":"session.created.1","seq":0,"aggregateID":"ses_…","data":{…}},"id":"evt_…"}}
```

- Global events (server.connected, server.heartbeat, global.disposed) have no `directory`/`project`
  keys. Directory-scoped events carry `directory` (absolute) + `project` (projectID).
- Every mutating event is **doubled**: the normal event plus a `type:"sync"` frame whose
  `syncEvent.type` is the versioned name (`session.created.1`, `message.part.updated.1`, …) with `seq`
  and `aggregateID` — the resync protocol behind `POST /sync/start|replay|steal` and
  `POST /sync/history`.
- Keepalive is `server.heartbeat` events (~15 s) in the data stream, not SSE comments.
- Event ids are `evt_<ulid>`. Real 1.17.11 does not send `id:` lines on `/global/event`, so
  `Last-Event-ID` resumption is a no-op even against the real server.
- Observed census in one real turn: `server.connected`, `server.heartbeat` ×3, `session.created` (+`.1`),
  `session.next.agent.switched`, `session.next.model.switched`, `session.status` ×4 (busy),
  `message.updated` ×6 (+`.1`), `message.part.updated` ×8 (+`.1`), `message.part.delta` ×8,
  `session.updated` ×4 (+`.1`), `session.diff` ×2 (+`.1`), `session.idle` (+`.1`).
- Implication for the sidecar (current sse.ts emits `id:` + `event:` + bare-properties `data:`): the
  UI's resolveEventPayload sees a `data` JSON with neither a top-level `type` nor a `payload` member and
  **drops every sidecar event**. Live streaming in the UI is broken at the protocol level today, and
  the sidecar's own contract tests assert the wrong wire format.

## 5. Bootstrap / lifecycle sequence

1. bootstrap.ts: web-server `GET /health` (short timeout).
2. Event pipeline starts: SSE `GET /api/global/event` (WS fallback on failure).
3. On connect / visibility restore / reconnect: `GET /session` (+ `GET /session/status` per dir + web
   server `/api/session-activity`), then per visible session `GET /session/{id}/message`.
4. User send: `POST /session/{id}/prompt_async`. The UI then renders live state **from the event
   stream only** (plus re-fetch on idle/reconnect). No polling during a turn.
5. Blocking requests: `GET /permission` / `GET /question` (unscoped + per-dir) on resync; replies via
   the POST routes. Auto-accept (vscode mode) additionally calls the optional v2 `fetchPermission`
   (404 = resolved) to drop stale entries.

## 6. Consequences for the sidecar (headline)

1. The UI is a **v1-route consumer**: 1.20.0 does not use `/api/session*` v2 routes for core flows.
   Only the optional v2 permission create/get are v2. "Sidecar speaks v1" is the right generation;
   the gaps are route coverage and shapes, not protocol generation.
2. Every call may carry `?directory=`. The sidecar must accept (and mostly ignore) it on all routes.
3. SSE envelope mismatch (real: `{directory, project, payload{…}}` data-only frames; sidecar:
   `id:`+`event:`+bare properties) ⇒ UI currently drops **every** sidecar event.
4. `session.created` must be emitted when a turn materializes a session (OMP creates the JSONL after
   the first completed turn) so the UI list updates.
