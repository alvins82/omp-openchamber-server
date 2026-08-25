# @opencode-ai/sdk 1.18.21 — The Contract OpenChamber UI Is Typed Against

Captured 2026-08-24. Reference: `@opencode-ai/sdk` 1.18.21.
Version context: **SDK 1.18.21** (types) vs **opencode 1.17.11** (live binary) vs **OMP 17.3.5** (server backend). The SDK's v1-era type file is already a revision or two
behind the live server in places (see §6).

## 1. Packaging

- The UI imports `@opencode-ai/sdk/v2`. That subpath (`dist/v2/`) exports its own
  `createOpencodeClient()` (`dist/v2/client.d.ts`) returning an `OpencodeClient`
  (`dist/v2/gen/sdk.gen.d.ts:2241`) with 24 top-level namespaces plus a `v2` sub-namespace:
  `auth, app, experimental, global, event, config (Config2), tool, worktree, find, file, instance,
  path, vcs, command, lsp, formatter, mcp, project, pty, question, permission, provider, session
  (Session2), part, sync, tui` + `v2: {session (Session3), permission (Permission2), question
  (Question2), model, provider, fs, ...}`.
- So one client object carries **two API generations**: the v1-style namespaces (no `/api` prefix)
  and the v2 sub-namespace (`/api/*` prefix). The 1.20.0 UI uses the v1 namespaces for everything
  except optional v2 permission calls.
- Three type files:
  - `dist/gen/types.gen.d.ts` — 3383 lines, v1 generation.
  - `dist/v2/gen/types.gen.d.ts` — 11653 lines, v2 generation (superset-ish: contains both old and
    new event families).
  - `dist/v2/v2-routes.tsv` — 188-entry method table extracted from `dist/v2/gen/sdk.gen.d.ts`
    (scratch artifact, safe to regenerate with a small script over the class `url` constants).
- SSE handling lives in `dist/gen/core/serverSentEvents.gen.js` (`createSseClient`, shared by both
  generations).

## 2. The 188-route table (grouped)

`?` in the method column = SSE stream endpoint. "UI" = called by OpenChamber 1.20.0 UI.

### v1 generation (Session2 family) — what the UI actually consumes
| Method | Route | UI |
|---|---|---|
| GET | `/session` | list |
| POST | `/session` | create |
| GET | `/session/status` | yes |
| GET / PATCH / DELETE | `/session/{id}` | yes / yes / yes |
| GET | `/session/{id}/children` | no |
| GET | `/session/{id}/todo` | yes |
| GET | `/session/{id}/diff` | no |
| GET | `/session/{id}/message` | yes |
| POST | `/session/{id}/message` | legacy sync prompt |
| GET / DELETE | `/session/{id}/message/{messageID}` | no |
| PATCH / DELETE | `/session/{id}/message/{messageID}/part/{partID}` | no |
| POST | `/session/{id}/prompt_async` | **main send path** |
| POST | `/session/{id}/command` | yes |
| POST | `/session/{id}/shell` | yes |
| POST | `/session/{id}/fork` | yes |
| POST | `/session/{id}/abort` | yes |
| POST | `/session/{id}/init` | no |
| POST / DELETE | `/session/{id}/share` (DELETE = unshare) | no call site found |
| POST | `/session/{id}/summarize` | yes |
| POST | `/session/{id}/permissions/{permissionID}` | no (respond) |

### v1 generation (app/metadata family)
| Method | Route | UI |
|---|---|---|
| GET | `/agent` | yes (with `/api/agent` runtimeFetch fallback) |
| GET | `/skill` | yes |
| GET | `/command` | yes |
| GET | `/config` · PATCH `/config` | yes / yes (global, no dir) |
| GET | `/config/providers` | yes |
| GET / DELETE / PUT | `/auth/{providerID}` | PUT yes (custom provider forms) |
| GET | `/path` | yes (getSystemInfo) |
| GET | `/project` · GET `/project/current` | yes / yes |
| POST | `/project/git/init` · PATCH `/project/{id}` · GET `/project/{id}/directories` | no |
| GET | `/vcs` | yes |
| GET | `/vcs/status` · `/vcs/diff` · `/vcs/diff/raw` · POST `/vcs/apply` | no |
| GET | `/mcp` | yes (mcp.status) |
| POST | `/mcp` · `/mcp/{name}/connect` · `/mcp/{name}/disconnect` · `/mcp/{name}/auth*` | no (web server proxies the auth ones) |
| GET | `/lsp` | yes (lsp.status) |
| GET | `/formatter` | no |
| GET | `/provider` · `/provider/auth` | no (used by web server config surface?) |
| POST | `/provider/{id}/oauth/authorize` · `/provider/{id}/oauth/callback` | no direct UI (web-server proxy) |
| GET | `/file` · `/file/content` · `/file/status` | list / yes / no |
| GET | `/find` (text) · `/find/file` · `/find/symbol` | no / yes / no |
| GET / POST / PUT / DELETE | `/pty`, `/pty/{id}`, `/pty/shells`, `/pty/{id}/connect*` | no |
| GET | `/question` · POST `/question/{id}/reply` · POST `/question/{id}/reject` | yes / yes / yes |
| GET | `/permission` · POST `/permission/{id}/reply` | yes / yes |
| GET | `/event` (SSE) | no (web server has its own `/api/event` alias) |
| GET | `/global/event` (SSE) | **yes (primary transport)** |
| GET | `/global/config` · PATCH `/global/config` | yes (global.config) / no |
| GET | `/global/health` | web server health probe |
| POST | `/global/dispose` · `/global/upgrade` | no |
| GET / POST | `/log` | no |
| GET | `/experimental/session` | yes (sanitized list variant) |
| POST | `/experimental/session/{id}/background` | no |
| GET | `/experimental/capabilities` · `/experimental/console*` · `/experimental/resource` · `/experimental/workspace*` · `/experimental/project/{id}/copy*` | no |
| GET | `/experimental/tool` · `/experimental/tool/ids` | no / yes |
| GET / POST / DELETE | `/experimental/worktree*` | no |
| POST | `/instance/dispose` | no |

### v2 generation (`/api/*`) — not used by UI except optional permission
| Method | Route | Notes |
|---|---|---|
| GET/POST | `/api/session` (Session3: list/create) | v2 session API |
| GET | `/api/session/active` | |
| GET | `/api/session/{id}` | |
| POST | `/api/session/{id}/agent` · `/api/session/{id}/model` | agent/model switch |
| POST | `/api/session/{id}/prompt` · `/api/session/{id}/wait` · `/api/session/{id}/compact` · `/api/session/{id}/interrupt` | v2 turn API |
| GET | `/api/session/{id}/context` · `/api/session/{id}/history` | |
| SSE | `/api/session/{id}/event` | v2 per-session stream |
| GET | `/api/session/{id}/message` · `/api/session/{id}/message/{messageID}` | |
| POST | `/api/session/{id}/revert/stage` · `.../revert/clear` · `.../revert/commit` | staged revert (new) |
| GET/POST | `/api/session/{id}/permission` | **optional UI call** (create; null-tolerant) |
| GET | `/api/session/{id}/permission/{requestID}` | **optional UI call** (404 = resolved) |
| POST | `/api/session/{id}/permission/{requestID}/reply` | |
| GET/POST/DELETE | `/api/session/{id}/question...` | |
| GET | `/api/agent` · `/api/command` · `/api/skill` · `/api/model` · `/api/provider*` | v2 catalog routes (agent fallback target) |
| GET | `/api/health` · `/api/location` | |
| GET | `/api/event` (SSE) | web-server `/api/event` alias lands here when proxied |
| GET | `/api/pty*` | |
| GET/POST | `/api/fs/read/*` · `/api/fs/list` · `/api/fs/find` | |
| GET/POST/DELETE | `/api/permission/request` · `/api/permission/saved*` | v2 permission store |
| GET/POST | `/api/question/request` | |
| GET | `/api/reference` | |
| POST | `/sync/start` · `/sync/replay` · `/sync/steal` · `/sync/history` | **CRDT resync protocol** (see §5) |
| TUI family | `/tui/*` (12 routes) | terminal-only |

## 3. v1 type shapes (gen/types.gen.d.ts) — what a v1-route reimplementation must emit

All shapes below verbatim from the installed SDK. Required (no `?`) fields are the ones a reimplementation
cannot omit without breaking TypeScript consumers.

```ts
// :465
Session = {
  id: string; projectID: string; directory: string; parentID?: string;
  summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  share?: { url: string }; title: string; version: string;
  time: { created: number; updated: number; compacting?: number };
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string };
}
// :39
UserMessage = {
  id: string; sessionID: string; role: "user"; time: { created: number };
  summary?: { title?: string; body?: string; diffs: FileDiff[] };
  agent: string; model: { providerID: string; modelID: string };
  system?: string; tools?: Record<string, boolean>;
}
// :98
AssistantMessage = {
  id: string; sessionID: string; role: "assistant";
  time: { created: number; completed?: number };
  error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError;
  parentID: string; modelID: string; providerID: string; mode: string;
  path: { cwd: string; root: string }; summary?: boolean; cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  finish?: string;
}
// :32
FileDiff = { file: string; before: string; after: string; additions: number; deletions: number };
// parts (:142, :158, :201, :263, :275, :282, :300, :307, :315, :327, :338, :345)
TextPart      = { id, sessionID, messageID, type: "text", text, synthetic?, ignored?, time?: {start, end?}, metadata? }
ReasoningPart = { id, sessionID, messageID, type: "reasoning", text, metadata?, time: {start, end?} }
FilePart      = { id, sessionID, messageID, type: "file", mime, filename?, url, source? }
ToolPart      = { id, sessionID, messageID, type: "tool", callID: string, tool: string, state: ToolState, metadata? }
ToolState     = { status: "pending", input, raw }
              | { status: "running", input, title?, metadata?, time: { start } }
              | { status: "completed", input, output: string, title: string, metadata, time: { start, end, compacted? }, attachments? }
              | { status: "error", input, error: string, metadata?, time: { start, end } }
StepStartPart = { id, sessionID, messageID, type: "step-start", snapshot? }
StepFinishPart= { id, sessionID, messageID, type: "step-finish", reason, snapshot?, cost, tokens: {...} }
PatchPart     = { id, sessionID, messageID, type: "patch", hash, files: string[] }
AgentPart     = { id, sessionID, messageID, type: "agent", name, source? }
// :369
Permission = { id, type, pattern?: string | string[], sessionID, messageID, callID?, title, metadata, time: { created } }
// :396
SessionStatus = { type: "idle" } | { type: "retry", attempt: number, message: string, next: number } | { type: "busy" }
// :431
Todo = { content: string; status: string; priority: string; id: string }
// :607
Project = { id, worktree, vcsDir?, vcs?: "git", time: { created, initialized? } }
// :1222
Path = { state: string; config: string; worktree: string; directory: string }
// :1270
Command = { name, description?, agent?, model?, template: string, subtask? }
// :1335
Provider = { id, name, source: "env"|"config"|"custom"|"api", env: string[], key?, options, models: Record<id, Model> }
// :1399
Agent = { name, description?, mode: "subagent"|"primary"|"all", builtIn, topP?, temperature?, color?,
          permission: { edit, bash: Record<string, ...>, webfetch?, doom_loop?, external_directory? },
          model?, prompt?, tools: Record<string, boolean>, options, maxSteps? }
// :1446
McpStatus = {status:"connected"} | {status:"disabled"} | {status:"failed",error} | {status:"needs_auth"} | {status:"needs_client_registration",error}
// :1461
LspStatus = { id, name, root, status: "connected" | "error" }
// :602
Event (v1) = 32-member union: server.instance.disposed, installation.updated, installation.update-available,
  lsp.client.diagnostics, lsp.updated, message.updated, message.removed, message.part.updated, message.part.removed,
  permission.updated, permission.replied, session.status, session.idle, session.compacted, file.edited,
  todo.updated, command.executed, session.created, session.updated, session.deleted, session.diff, session.error,
  file.watcher.updated, vcs.branch.updated, tui.prompt.append, tui.command.execute, tui.toast.show,
  pty.created, pty.updated, pty.exited, pty.deleted, server.connected
// :603
GlobalEvent (v1) = { directory: string; payload: Event }
```

Event property shapes (all `properties` objects, verbatim): `message.updated: {info: Message}`;
`message.part.updated: {part: Part, delta?: string}` (the delta rides alongside the snapshot!);
`message.part.removed: {sessionID, messageID, partID}`; `session.created/updated/deleted: {info:
Session}`; `session.diff: {sessionID, diff: FileDiff[]}`; `session.error: {sessionID?, error?}`;
`session.status: {sessionID, status}`; `session.idle: {sessionID}`; `todo.updated: {sessionID,
todos: Todo[]}`; `permission.updated: Permission` (the whole object is properties);
`permission.replied: {sessionID, permissionID, response}`; `vcs.branch.updated: {branch?}`;
`file.edited: {file}`.

## 4. v2 type shapes (v2/gen/types.gen.d.ts) — what the live 1.17.11 actually emits

```ts
// :4
Event (v2) = 89-member union: the v1 core 24 (message.*, session.created/updated/deleted/status/idle/
  error/diff, todo.updated, lsp.updated, project.updated, vcs.branch.updated, permission.asked,
  permission.replied, question.asked/replied/rejected, server.connected, global.disposed, server.instance.disposed)
  + session.next.* (28: agent.switched, model.switched, moved, prompted, prompt.admitted, context.updated,
  synthetic, shell.started/ended, step.started/ended/failed, text.started/delta/ended, reasoning.started/
  delta/ended, tool.input.started/delta/ended, tool.called/progress/success/failed, tool.success,
  retried, compaction.started/delta/ended, revert.staged/cleared/committed)
  + permission.v2.asked/replied, question.v2.asked/replied/rejected, session.compacted, file.edited,
  file.watcher.updated, installation.* (2), tui.* (4), pty.* (4), mcp.toolsChanged, mcp.browser.open.failed,
  command.executed, models.devRefreshed, reference.updated, integration.* (2), catalog.updated, plugin.added,
  worktree.* (2), workspace.* (3)
// :553
GlobalEvent (v2) = { directory: string; project?: string; workspace?: string;
                     payload: { id: string; type: <event-type string>; properties: ... } }
// :2015
QuestionRequest = { id, sessionID, questions: QuestionInfo[], tool?: { messageID, callID } }
QuestionInfo    = { question, header, options: {label, description}[], multiple?, custom? }
// :2029
PermissionRequest = { id, sessionID, permission, patterns: string[], metadata, always: string[],
                      tool?: { messageID, callID } }
// :64
Session (v2) = v1 Session + slug: string, workspaceID?, path?, cost?, tokens?, agent?,
               model?: { id, providerID, variant? }, metadata?
// :2247
SessionDurableEvent = 28-member union of session.next.* (the resync-able subset)
// :2623 etc.
SyncEvent* = { id, type: "<name>.<version>" (e.g. "session.created.1"), seq: number,
               aggregateID: string, data: ... }   // the "sync" mirror frames
```

Note the generation mix in the live stream: 1.17.11 emits `permission.asked` / `question.asked` (v2
naming) for the interactive channels, not v1's `permission.updated`, while session/message events are
the same in both generations. The UI reducer matches on strings, so the sidecar must pick **v2-style
type names** for permission/question events.

## 5. The sync (resync) protocol

`POST /sync/history`, `POST /sync/start`, `POST /sync/replay`, `POST /sync/steal` (v2 client `sync`
namespace). Every mutating event is mirrored in-band as a `type: "sync"` frame carrying
`syncEvent: {id, type: "<name>.<version>", seq, aggregateID, data}`. This is a CRDT-ish
last-writer resync: a client that missed events can ask for the aggregate since a seq. The 1.20.0 UI
does **not** call these (it re-fetches REST on reconnect instead), so for the sidecar they are dead
weight — emitting the sync mirror frames is optional but cheap, and omitting them is safe.

## 6. SSE client behavior (gen/core/serverSentEvents.gen.js)

- Per frame: collect `data:` lines (46-50), join with `\n`, `JSON.parse` it (fall back to raw string
  on parse failure, 67-74); optional `responseValidator` / `responseTransformer` hooks; **yield the
  parsed `data` value** (92).
- `id:` and `event:` lines are parsed but never included in the yielded value. The UI pipeline reads
  `event.id` off the SDK's wrapper only to set `lastEventId` for `Last-Event-ID` on reconnect
  (event-pipeline.ts:560, 664).
- Consequence: the **entire** event identity must live inside the `data` JSON. The UI's
  `resolveEventPayload` (event-pipeline.ts:191) requires `payload.type` (top-level or under a
  `payload` member). A `data:` that is just `properties` is dropped.
- Real 1.17.11 sends no `id:` lines on `/global/event`, so `Last-Event-ID` is a no-op even against
  the real server. A sidecar that *does* send `id:` lines is harmless (SDK records, UI resends;
  server ignores).

## 7. Error and result handling

- Non-2xx responses: the SDK resolves (not rejects) with `{ error: <parsed error body>,
  response: <Response> }`; transport-level failures resolve with `{ error: Error }` (no response).
  The UI's client.ts relies on `result.error`, `result.response?.status`, `result.data`
  (client.ts:912-932) and on distinguishing "network failure" (return `null` from
  `getSessionStatusForDirectory`) from "200 with `{}`" (client.ts:1081-1101).
- Error bodies (v1 types :617-97): `BadRequestError {name:"BadRequest", data:{message, kind?}}`,
  `NotFoundError {name:"NotFoundError", data:{message}}`, plus `ProviderAuthError`,
  `UnknownError`, `MessageOutputLengthError`, `MessageAbortedError`,
  `ApiError {name:"APIError", data:{message, statusCode?, isRetryable, ...}}`.
- The web server's sanitizer (proxy.js:657) rewrites session-list responses; errors pass through
  unmodified, so the sidecar's 404 body `{message: "not implemented"}` currently shows up verbatim
  in the UI's error surfaces for missing routes (caught and logged in most flows).

## 8. SDK-type vs live-1.17.11 skews (affects what "correct" means)

| Field | v1 SDK type | live 1.17.11 | v2 SDK type |
|---|---|---|---|
| `/path` | `{state, config, worktree, directory}` (no `home`) | `{home, state, config, worktree, directory}` | same as live (adds home) |
| `/project` | `Project {id, worktree, vcsDir?, vcs?, time{created, initialized?}}` | array of `{id, worktree, vcs, time{created, updated}, sandboxes[]}` | Project (newer) |
| `/config/providers` | `{providers: Provider[]}` | `{providers: Provider[], default: {providerID, modelID}}` | same + `default` |
| permission events | `permission.updated` | `permission.asked` / `permission.replied` (v2 names) | both families |
| `session.next.*` | absent | emitted | present (28 types) |
| `sync` mirror frames | absent | emitted | present (`*.1` versioned) |

The UI types are the **v2** types (it imports `@opencode-ai/sdk/v2` and uses its `Event`/`Session`
etc.), so "type-correct" for the UI = the v2 shapes, and the live server already conforms to them.
The sidecar must therefore target the v2 shapes for everything the UI renders, and it must emit
v2-named event types on the stream.
