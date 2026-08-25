# Gap map - server vs OpenChamber 1.20.0 OpenCode API usage

Date: 2026-08-24. Scope: remaining gaps between the proxy server (`omp-openchamber-server`:
OpenCode HTTP API over OMP 17.3.5 on :4096) and the real opencode server API surface that
OpenChamber 1.20.0 actually consumes. Companion docs: [`oc-usage.md`](./oc-usage.md) (what the
1.20.0 UI calls, route by route), [`sdk-contract.md`](./sdk-contract.md) (SDK 1.18.21 types and the
188-route table), [`omp-capabilities.md`](./omp-capabilities.md) (OMP 17.3.5 RPC surface),
[`sidecar-coverage.md`](./sidecar-coverage.md) (sidecar audit, route by route). Predecessors:
[`phase0-report.md`](./phase0-report.md) (live probes), [`contract-diff.md`](./contract-diff.md), [`omp-protocol-notes.md`](./omp-protocol-notes.md).

## Bottom line

1. The 1.20.0 UI is a v1-generation route consumer through SDK 1.18.21 (24 namespaces; v2 only
   for the optional permission create/get). The sidecar picked the right generation. The gaps
   are route coverage and payload shapes, not protocol generation.
2. There is one functional break (G1): the SSE envelope. The UI's payload gate drops every
   sidecar frame, and the sidecar's comment heartbeat keeps the stream alive forever, so the
   reconnect-driven resync that would mask the loss never fires. The UI updates over HTTP only
   (bootstrap list, message fetch, POST responses) plus the web-server hub re-broadcast.
3. Two bootstrap-shape gaps (G2-G3) make new-session and directory bootstrap visibly wrong:
   a stub `POST /session` that returns an id no route accepts, and `/path` + `/project`
   served with the wrong shapes.
4. The rest (G4-G8, P1) is per-feature degradation: 12 routes the UI actually calls that 404,
   message/session object shapes, `agent_end.isTerminal`, and the config write path. OMP
   genuinely has no MCP/LSP/VCS/PTY/share/config API/permission-question protocol; those need
   honest empty stubs or 501s, and `/permission` returning `[]` is correct under the default
   (yolo) approval mode, not a stub.

## Version triad

| Layer | Version | Note |
|---|---|---|
| UI | OpenChamber 1.20.0 (clone b638305, 08-24) | typed against SDK v2 types, calls v1 routes |
| SDK | @opencode-ai/sdk 1.18.21 | 188 routes (`dist/v2/v2-routes.tsv`); v1 `Event` union 32 members, v2 89 |
| Wire ground truth | opencode 1.17.11 (`/tmp/oc-probe`) | newest behavior; where SDK types are stale the live server wins (e.g. `home` in `Path`) |
| Sidecar backend | OMP 17.3.5 | NDJSON stdio RPC; no MCP/LSP/VCS/PTY/share/permission-question protocol |

## G1 (P0): SSE envelope drops every UI event, silently

- Sidecar emits `id: <n>\nevent: <type>\ndata: <properties-only JSON>\n\n`
  (sidecar/src/sse.ts:33).
- The SDK SSE client yields only the parsed `data`; `id:`/`event:` lines are tracked but never
  included in the yielded value (gen/core/serverSentEvents.gen.js:46-93).
- UI gate: `resolveEventPayload` requires a top-level `type` string or a `payload` member with
  a `type` string, else null and the event is dropped
  (packages/ui/src/sync/event-pipeline.ts:191-206, applied at 584-587). A bare-properties
  object has neither. Result: `session.status`, `message.part.delta`, `session.created`,
  permission/question events, all of it, is dropped.
- Nothing times out to hide the loss: the `: heartbeat` comment (sse.ts:37-41) is not yielded
  but it does reach the SDK `onSseEvent` callback (serverSentEvents.gen.js:85-93), which the
  UI uses to reset its 30s timer (event-pipeline.ts:561-562, constant at :29) and the
  sync-context watchdog (sync-context.tsx:2255-2261). The stream never times out,
  `onReconnect` (sync-context.tsx:2280-2297) never fires, and the store stays stale until
  navigation, a POST response, or manual refresh.
- Real server (08-24 capture, /tmp/oc-probe/sse-global.log): `data:`-only frames. Global
  events are `{"payload":{"id":"evt_<ulid>","type":...,"properties":{...}}}`; `server.connected`
  on open; `server.heartbeat` ~15s; scoped events add `directory`/`project`; every mutating
  event is mirrored by a `type:"sync"` frame (the resync protocol; the UI ignores it).
- Partial compensation today: the web server's own hub parser accepts bare-properties frames
  (packages/web/server/lib/event-stream/protocol.js:14-68), and its normalized
  `openchamber:session-status` records do reach the UI pipeline (event-pipeline.ts:95). So
  status indicators can update even though everything else from the stream is dead.
- Phase-0 reconciliation: the phase-0 OpenChamber UI checkout is
  1.18.4 and has the identical `resolveEventPayload` gate, so P2 ("live turn through the real
  UI works") is not a contradiction. Phase-0 verified the wire bytes and turn completion
  (JSONL), not SSE rendering in the UI; the turn's content reached the UI via HTTP fetches
  after the turn.
- Fix: sse.ts emits `data:`-only frames matching the real server, sends `server.connected` on
  connect (the UI does a full refresh on it, event-reducer.ts:191-199), and replaces the
  comment heartbeat with `server.heartbeat` data events. contract.test.ts:85-106 pins the
  current wrong format and :124 uses the invalid status `"processing"`; both must change with
  the fix.

## G2 (P0): POST /session is a stub that returns an unusable id

- main.ts:73-78 returns `{id:"ro_<ts>", directory, time}` with 201 and creates nothing. The id
  matches no OMP session: `GET /session/{id}` 404s, `prompt_async` 404s, and the id never
  appears in `GET /session` (OMP materializes the session JSONL only after the first
  completed turn, phase0-report P9). A new session from the UI is dead on arrival.
- Fix options: (a) pre-create a header-only JSONL at create time so the id is real and
  listed; (b) keep a sidecar alias table mapping the returned id to the OMP session that
  materializes later, rewriting at first turn. Either way emit `session.created` when the
  session becomes real (G1 fix) so the UI list updates.

## G3 (P0): bootstrap shapes - /path and /project

- `/path` returns `{directory, worktree, state:"ok"}` (main.ts:199). The real server returns
  `{home, state, config, worktree, directory}` with `state`/`config`/`worktree`/`home` all
  path strings (SDK v2 `Path`; live 1.17.11 includes `home`, which the SDK v1 type lacks).
  UI `getSystemInfo`/`probeDirectory` parse these (oc-usage.md section 2).
- `/project` returns a single object `{directory, worktree}` (main.ts:197-198). The real
  server returns an array of `Project {id, worktree, vcs?, time{created, updated?}}`;
  `/project/current` returns one object.
- Both are cheap: the data is local (cwd, `$HOME`, `~/.omp`, git).

## G4 (P1): routes the UI calls that the sidecar 404s

All 404 today (main.ts:208). The UI call sites are in oc-usage.md section 2.

| Route | OMP source or mapping |
|---|---|
| `DELETE /session/{id}` | 7 UI call sites (sidebar delete, archive, worktree cleanup). No delete RPC in 17.3.5 (omp-capabilities.md command table); deleting the JSONL is the honest equivalent |
| `PATCH /session/{id}` | rename: OMP `set_session_name` |
| `GET /session/{id}/todo` | `get_state.todoPhases` (data exists) |
| `POST /session/{id}/command` | slash commands: OMP `prompt` with the command template |
| `POST /session/{id}/shell` | OMP `bash` |
| `POST /session/{id}/fork` | OMP `new_session{parentSession}` (fork) / `branch` |
| `POST /session/{id}/revert`, `/unrevert`, `/summarize` | revert = `branch` + file state; unrevert = restore; summarize = `compact` |
| `GET /file`, `/file/content`, `/find/file` | plain filesystem; UI file browsing/search go through the proxy (oc-usage.md Files) |

`share`/`unshare` have no OMP equivalent: an honest 501 is fine (the UI treats share as a
web-server feature).

## G5 (P1): message and session object shapes

Session (sessions.ts:113-142):
- `projectID: ""` instead of a stable id (real server uses `"global"`); the UI routes by it.
- `slug` is the raw `ses_` id (real: wordy slug); `version` is the OMP header version.
- `tokens` lacks `reasoning` and `cache{read,write}`; `model` uses `modelID` where the v2
  type the UI types against wants `id`.

Message (messages.ts):
- Assistant info lacks `mode`, `path:{cwd,root}`, `cost`, `tokens` (required by v1
  `AssistantMessage`; the UI cost display stays zero) (prompt.ts:141).
- `ToolPart` puts the OMP tool-call id under `metadata.toolCallId` instead of the required
  top-level `callID` (messages.ts:136); the UI's permission `tool:{messageID,callID}`
  cross-reference expects `callID`.
- Message ids are position-derived when OMP gives no stable id
  (`msg_${sesId}_${idx}`, messages.ts:283): a refetch after a new message shifts earlier ids,
  and the reducer keys by message id, so resync can drop or replace entries.
- Turn end: `agent_end` is treated as terminal even when `isTerminal === false`
  (docs/rpc.md:503-511); a non-terminal settle falsely marks the session idle mid-run until
  the next event.
- The error path emits assistant info + error text part + idle, but no `session.error` event
  (the real server emits it; phase0-report P11).

## G6 (P1, conditional): permission/question bridge

- OMP's only interactive channel is the extension-UI sub-protocol
  (`extension_ui_request` select/confirm/input, docs/rpc.md:583-624). Approval mode is
  `always-ask` | `write` | `yolo`, default `yolo` (tools/approval.ts:14,
  settings-schema.ts:3677-3681).
- So `/permission` -> `[]` (main.ts:206) is correct under the default config, not a stub. It
  becomes a real gap only if the user sets `always-ask`/`write`: the sidecar must then map
  `extension_ui_request` to `PermissionRequest`/`QuestionRequest` (GET list, POST
  reply/reject) or the UI's approval surface does not work.
- The optional v2 `POST/GET /api/session/{id}/permission` 404 is the documented pre-v1.17.12
  fallback (client.ts:1203, 1244, 1268): the UI treats 404 as "resolved". Harmless in 1.20.0,
  but note the sidecar's generic 404 cannot distinguish "unimplemented" from "resolved" on
  that route.

## G7 (P1): config and provider surface

- `/config` and `/global/config` return `{}` (main.ts:196) where the UI expects the full
  `Config` (constructible from OMP settings + `get_state`).
- `PATCH /config` 404s: the UI's settings editing surface no-ops with errors. There is no
  OMP write-path RPC; a real integration needs a decision (map to the OMP settings file, or
  501).
- `/config/providers` works but spawns an ephemeral OMP child per call (1-2s latency,
  main.ts:178-191); a shared idle child would fix it. `PUT /auth/{providerID}` (custom
  provider forms) 404s; low priority.

## G8 (P1): stub-typed routes

- `/mcp` returns `[]` but the type is `Record<name, McpStatus>` (should be `{}`)
  (main.ts:202).
- `/vcs` returns `[]` but the type is `{branch, default_branch, ...}` (main.ts:204; cheap
  from `git` when the cwd is a repo).
- `/agent` returns `[]` although OMP has built-in agent data (main.ts:194).
- `/command` returns `[]` although the real list is available from
  `get_available_commands` / `available_commands_update` (main.ts:200). This is a real-data
  gap, not a stub.
- `/skill` returns `[]`; OMP 17.3.5 has no listing RPC (reading the skill files directly is
  the only path) (main.ts:201).

## P2: no work needed (recorded for completeness)

- `/api/*` v2 routes: the UI calls only the optional v2 permission create/get; 404 is the
  documented fallback (client.ts:1268).
- `session.next.*` (~30 types), `permission.v2.*`, `question.v2.*`, `session.compacted`,
  `file.edited`, `pty.*`, `tui.*`, `installation.*`, `worktree.*`, `workspace.*`: the real
  1.17.11 emits them; the 1.20.0 UI reducer does not (event-reducer.ts:241 switch, 22 case
  clauses, plus 3 global types = 24 handled). Do not emit.
- `/sync/*` (CRDT resync): the UI uses reconnect + HTTP resync, not the sync protocol.
- Last-Event-ID: the real server sends no `id:` lines either, so resumption is a no-op even
  against the real server (oc-usage.md section 4). The sidecar's `id:` counter is harmless.
- `/lsp` returning `[]` matches the real server's empty case.

## What OMP genuinely lacks (stub, do not implement)

MCP, LSP, file watcher, VCS API, PTY, multi-project registry, share server, provider OAuth,
question protocol, config GET/PUT API, `session.next.*` protocol, `/sync/*`. Sidecar answers:
honest `[]` / `{}` / 501 per G8 and the route audit in sidecar-coverage.md. The only
interactive surface OMP has is the extension-UI sub-protocol (G6).

## Live verification (open)

1. In a running 1.20.0 UI against the sidecar: send a prompt and confirm the assistant text
   does not stream in live (it appears only after re-selecting the session or refreshing).
   Code reading is deterministic; this is the runtime check for G1 in the 1.20.0 build.
2. Observe which live channel reaches the UI today: the web-server hub
   `openchamber:session-status` (status indicators) vs the dropped `session.status` (busy
   state in the session view).
3. The UI new-session button: confirm the 404 on `GET /session/ro_<ts>` (G2).

## Recommended fix order

1. sse.ts envelope + `server.connected` + `server.heartbeat` (one file; update
   contract.test.ts:85-106 and :124 in the same commit).
2. `POST /session` (G2) + `session.created` emission.
3. Bootstrap shapes: `/path`, `/project` (G3); stub types: `/mcp`, `/vcs`, `/agent`,
   `/command` (G8).
4. Session routes: `DELETE` / `PATCH` / `todo` / `command` / `shell` / `fork` (G4).
5. Message shape pass: `callID`, `mode`, `path`, `cost`/`tokens`, stable ids,
   `session.error`, `agent_end.isTerminal` (G5).
6. Conditional: extension-UI to permission/question bridge (G6), config read/write (G7).
