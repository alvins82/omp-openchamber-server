# Contract diff: OpenChamber's OpenCode API expectations vs OMP (oh-my-pi 17.3.5)

Scope: Phase 0/1 implementation. Observed against:
- OMP 17.3.5 in `--mode rpc` (NDJSON on stdin/stdout), verified against oh-my-pi source (tag v17.3.5).
- `omp-openchamber-server` bridging OpenCode-style HTTP/SSE → OMP RPC.
- OpenChamber web UI as the consumer.

No OpenChamber source was modified. Server state carried patches (A–G documented below).

## 1. Transports & lifecycle

| Aspect | OpenCode (what OpenChamber expects) | OMP reality | Sidecar behavior |
|---|---|---|---|
| Server | long-lived, one per project dir | N/A (OMP is a CLI agent, not a server) | `Bun.serve` on :4096, single process |
| `GET /session` (list) | JSON array of session objects | sessions are per-cwd JSONL files under `~/.omp/agent/sessions/<cwd-slug>/` | **fs scan** (no OMP spawn); header = first 200 lines; `updated` = file mtime |
| `POST /session` (create) | creates session, returns it | sessions created by OMP itself | **stub** (`{id:"ro_…", directory, time}`) — create flow untestable |
| `GET /session/:id/message` | JSON messages | JSONL entries (type: message/user/assistant/… + custom entries) | **session-JSONL fast path** (`loadMessagesFromFile` reads the file directly, same mapper as the RPC path); `switch_session` + `get_messages` ephemeral RPC child is **fallback only** — the old spawn-resume-SIGTERM design caused the §4 `session_exit` pollution loop, now fixed in the scratch sidecar |
| `POST /session/:id/prompt_async` | returns ACK (`{}` or 202-ish), streams via events | OMP `prompt` RPC is synchronous-ish (response arrives; turn events stream) | spawns **persistent** OMP child per (session,cwd), returns `{queued:true}` immediately; busy-lock per session |
| `GET /session/status` | per-session activity map | n/a | sidecar-internal busy map only |
| `GET /config/providers` | providers+models catalog | `get_available_models` (252 models / 4 providers in this env) | **spawns ephemeral OMP child per fetch** (1–2 s each) |
| `GET /project`, `/path`, `/config`, … | various | n/a | stubs (`{}`, `{directory, worktree}` …) |
| `GET /event` (+`?directory=`) | SSE event stream | OMP streams turn events on stdout; no directory-scoped server events | one global SSE; **no** `?directory=` variant (404 → OpenChamber's directory WS bridge logs errors, see diff D) |
| permissions / questions / todo / lsp / mcp / skill / command / agent endpoints | rich | OMP has its own tool-approval & subagent model, not surfaced as these | all **empty stubs** (`[]` / `{}`) |

## 2. ID & shape mapping

- OMP session UUID (8-4-4-4-12) ↔ OpenCode `ses_…`: sidecar strips/inserts dashes (`sessions.ts`). Works for 32-hex ids.
- OMP message ids: OMP uses its own id scheme; sidecar synthesizes `msg_<ses>_<suffix>` and re-maps each load (ids are **not stable** across refetches — a consumer cannot key on message id across polls).
- Model ref: OpenCode `{providerID, modelID, variant}` ↔ OMP `{provider, modelId, variant}`; OMP's `get_state.model` uses `provider`/`id`/`variant`.
- OMP's own per-session `updated` semantics: file mtime (any entry append, including `session_exit` bookkeeping, bumps UI recency).

## 3. Event vocabulary — observed vs documented

- OMP `docs/rpc.md` documents a `message_update` framing that does **not** match 17.3.5 behavior: real frames are `message_update` **with a nested `assistantMessageEvent`** (`text_delta` / `thinking_delta` / `toolcall_start|delta|end`), plus top-level `tool_execution_start|update|end` and turn terminators `agent_end` / `prompt_result`.
- **No OpenCode-style individual `message` events**: OpenChamber expects per-message lifecycle (`message` → `message.part.*` deltas → `message.updated`); the sidecar synthesizes those from sub-events (`prompt.ts` `createEventHandler`). The synthesis is stateful and per-prompt; a page reload re-derives from JSONL instead.
- **No approval/permission frames** in any of the three P2 runs (even on hard provider errors). OMP's tool-approval surface (if any) is not reachable through this RPC shape as exercised.
- **Turn-end on provider auth failure (P11, 2026-08-23 - resolved)**: cleaner bedrock 403 (expired STS) on the current server build ends the turn `session.status` busy -> `session.idle` with **zero message frames**; the P2-era stuck busy-lock is **not reproducible** (next `prompt_async` accepted ~8 s after the failed turn). Flushed record = an **empty assistant message** - same signature as an aborted turn. Remaining gap: **no error is surfaced on the stream** - a stream-only client sees the turn vanish silently; the failure is visible only in the JSONL or in the RPC response `errorMessage` (OpenAI/llama.cpp paths). Success-path terminator in this vocabulary = `message.updated` with `finish:"stop"` + `session.idle` (no `agent_end`/`prompt_result` frame exists at all in OMP's OpenCode SSE).
- **Re-verified live in P10-LIVE (2026-08-23, raw bytes)**: one full turn over the server stream shows preamble `: ok`, a ~20 s `: heartbeat` comment line, then `id:`-numbered `event`/`data` frames in the OpenCode-style vocabulary: `message.updated` (created) → `message.part.updated` → `message.part.delta` ×N → `message.part.updated` (completed) → `message.updated` (completed) → `session.idle`. Identical on `/events?directory=…` and `/global/event`. These are the exact frame types OpenChamber's sync store consumes; the server synthesizes them from OMP's `message_update` sub-events (first bullet).

## 4. Lifecycle side effect — `session_exit` postmortem bookkeeping (the 20 s loop)

See `omp-protocol-notes.md` for the full source-traced chain. Contract-level impact:

- OMP writes a **persistent, append-only** `session_exit` custom entry into a session's JSONL whenever a process with that session as its live session is torn down abnormally (SIGINT/SIGTERM/SIGHUP/exceptions/unhandled; `reason` ∈ `"manual"|"sigint"|"sigterm"|"sighup"|"exit"|"uncaught_exception"|"unhandled_rejection"`, mapped to `kind` `"normal"|"signal"|"fatal"|"process_exit"` — `agent-session.ts:2020`).
- Any host that **resumes and then SIGTERM's** a session process (e.g. a spawn-ask-kill polling design, which the sidecar's message-read path does every ~20 s per viewed session) leaves one `session_exit` record per poll in that session's file, each chained to the previous. This is OMP-correct behavior with host-cause.
- Consequences for a consumer: session file grows on read-traffic; `mtime`/recency churn; the resumed session's latest-entry (branch head) advances through bookkeeping records; OMP's own resume replays through them.
- Read-only hosts should: read JSONLs directly, or keep one long-lived child per cwd, or avoid SIGTERM for read purposes.

## 5. Scratch sidecar diffs carried in this run (all outside openchamber; sidecar scratch only)

- **A** — `GET /project` returned `{}`, crashing OpenChamber `bootstrap.ts:78` (`.filter` on undefined). Sidecar now returns `{directory, worktree}`.
- **B** — `POST /session` left as **stub** (create unsupported; UI new-session path untestable).
- **C** — read paths verified live: session list + message load render past OMP sessions in the UI sidebar/transcript (fs-based listing; message load now JSONL fast path per §1/§4, verified end-to-end in the UI).
- **D** — `GET /event?directory=…` still 404 (sidecar only serves the global stream); OpenChamber's directory WS bridge logs the failure but the global stream keeps working. Open.
- **E** — **VERIFIED (P10-LIVE, 2026-08-23, raw-byte capture)**: a full turn over the live server stream delivers a `: ok` preamble, a ~20 s `: heartbeat` comment, then `id`-numbered event/data frames `message.updated` → `message.part.updated` → `message.part.delta` ×N → `message.part.updated` → `message.updated` → `session.idle` — the exact OpenCode-style vocabulary OpenChamber's sync store consumes (synthesized by the server from OMP's `message_update` sub-events; see §3). Identical on `/events?directory=...` and `/global/event`; no unknown types.
- **F** — **Concurrency/abort semantics (P10 + P10-LIVE, 2026-08-23)**: a concurrent `prompt_async` during a live long turn → **409 busy** (demonstrated at t+4 s of a ~2500-word turn; same lock as P4 — `p10-A`'s earlier "200 on the probe" only because that short turn had already finished by probe time). `POST /session/:id/abort` → **200 `"true"` for any existing session**, but it does **not** cancel in-flight model generation: the OMP child (rpc mode) flushes a (possibly empty) assistant record at abort, the provider stream runs to completion, and the finished output lands attached to the **latest** user message. No `session_exit` is appended on abort. Related: the child rewrites its session JSONL **non-monotonically** from in-memory state — line count is not a stable authority. Ledger status: A fixed, B intentional stub, C verified, D open, E verified, F documented limitation, G verified (P11).
- **G** - **Provider-failure turn termination (P11, 2026-08-23, resolved session, server-launched child)**: clean bedrock 403 (expired STS) on a fresh scratch session ends the turn busy -> idle with **zero message frames** and **no stuck lock** (follow-up prompt accepted ~8 s later - the P2-era "409 for everything after" is **not reproducible** on the current build). JSONL persists user + **empty assistant** record (same flush signature as an aborted turn). Success-path terminator = message.updated with finish:"stop", then session.idle. Remaining gap: **no error is surfaced on the stream** - a stream-only client sees the turn vanish silently; the error is visible only in the RPC errorMessage (OpenAI/llama.cpp paths) or as the empty assistant in the JSONL.

## 6. Provider layer state (environment, not contract)

Initial state: all four configured providers were non-functional. Final state: llama.cpp reconfigured as the key-gated vLLM server and is live (P2 + P4 pass through it).

| Provider | Default/model tested | Result |
|---|---|---|
| amazon-bedrock | `us.anthropic.claude-opus-4-8` (chatwoot default) | 403 "security token invalid" (expired STS) |
| bedrock-mantle | (5 models in catalog) | presumed same auth failure (untested per-model) |
| openai | `gpt-5-nano` | `insufficient_quota` (errorMessage surfaced in RPC response) |
| llama.cpp | Qwen3.8-27B | **LIVE** — `~/.omp/agent/models.yml` configured with `auth: apiKey` + `baseUrl: ...:8080/v1`; discovery rewrote it to `openai-completions` + `qwen-chat-template` (live catalog: 128K context / 32768 output, reasoning on, text-only); P2 + P4 pass |

Result: P2 (happy path) and P4 (multi-turn, 409 busy semantics, persistent-child reuse) now PASS through the server on `qwen3.8-27b` with full UI rendering. P8 (image input) is **N/A**: the vLLM container runs `--language-model-only` (text-only; text-only model; no image probe was run against it by design).

## 7. Open questions for a real integration

1. Is OMP's `switch_session` + immediate teardown acceptable for read paths, or should integration read JSONLs directly (recommended; OMP's own `sessions.ts`-shaped parsing is trivial since the server already does it for listing)? — **Resolved**: direct-JSONL read implemented (`loadMessagesFromFile`) and validated (see [`omp-protocol-notes.md`](./omp-protocol-notes.md)); RPC remains fallback only.
2. Does OMP emit a terminal event on provider auth failure that the server is dropping (check OMP `turn`/`prompt` result frames on 4xx)? — **Resolved**: provider failure handling tested in P11.
3. New-session creation: OMP has `new_session` RPC (verified working in P1, returns `{cancelled:false}` + `get_state` model echo) — a real `POST /session` in the sidecar should call it rather than stub.
4. Permission/approval & question surfacing: OMP's model (subagent/task/launch system, `launch/broker.ts`, `modes/acp`) doesn't map to OpenCode's `permission`/`question` resources under this RPC shape; needs a dedicated design if approvals must surface in the UI.
5. `?directory=`-scoped event stream: OMP is single-process-per-cwd with global stdout flow; a multi-directory OpenChamber workspace needs either one sidecar per cwd (or a router) — decide topology before wiring the directory WS bridge.


## Tier C result (2026-08-24) - live integration suite GREEN (5/5)

`bun run test:live` → `src/integration.live.test.ts` passes end-to-end against real OMP 17.3.5 + vLLM qwen3.8-27b (5 tests / 55 expects, ~30 s of turn time + 20 s probe). Default `bun test` unchanged: 91 pass / 5 skip / 0 fail (Tier C auto-skips without `LIVE=1`).

Tests verified live: (1) a real OMP `new_session` appears in `GET /session` with the stable `ses_<32hex>` id and correct `directory`/`time.created`; (2) `GET /config/providers` exposes the live llama.cpp catalog with the discovered limits (128K context / 32768 output); (3) one real turn streams the exact OpenCode success vocabulary in order (`message.updated` → `message.part.updated` → `message.part.delta`+ → `session.idle`) with the correct model ref and `finish:"stop"`; (4) `GET /session/:id/message` persists the `{info, parts}` records with `parentID` chaining and part `messageID` back-references; (5) concurrent `prompt_async` while busy → 409, `abort` → 200 `true`, lock released, follow-up prompt accepted.

### Root cause of the startup wedge (diagnosis)

Hung embedded-OMP instances (zero stdout for >20 s, no `ready`) were **not** a bun/sh/network issue: the per-pid OMP debug logs show an 11-minute gap between `MCP prompt commands refreshed mcp:semgrep` and `MCP tool load failed mcp:typescript_lsp: Connection to MCP server "typescript_lsp" timed out after 30000ms`. A flaky project/user-scope MCP server (`typescript_lsp`, a node LSP; consistent with the hung processes' `node`/`node_repl` children) intermittently deadlocks during startup, and OMP does not emit `ready` until MCP startup resolves. Healthy runs load it in ~1 s.

### Resilience measures (all in `src/rpc.ts`, embedded instance only)

1. **Pre-ready readiness gate** (the decisive one): OMP processes stdin frames in order *before* emitting `ready` (verified: `new_session` sent at t+0 gets its response at ~1.3 s). `spawn()` therefore gates on the first real RPC response to a `get_state` probe (30 s, up to 3 attempts, kill+respawn) instead of the `ready` frame — a subsystem that withholds `ready` can no longer wedge the proxy.
2. **Per-run `--config` overlay** with `mcp.enableProjectConfig: false`: the sidecar's own `/mcp` returns `[]`, so project MCP servers are pure overhead for the embedded instance; disabling them removes the wedge source entirely. The user's global OMP config is untouched. (Note: an earlier variant of the overlay did not take effect for user-scope servers stored in `agent.db` — the `get_state` probe makes that moot, and the overlay still removes the project-scope ones.)
3. **Process-group lifecycle**: the child is spawned `detached` (own group); on failure or shutdown the whole group is SIGTERMed, so MCP/LSP grandchildren never outlive the sidecar.
4. **`PI_SKIP_VERSION_CHECK=1`** removes the startup update-check network call.

Test-side fixes made along the way (contract-shape bugs in the live test, not the sidecar): `toMatch` given a string is a substring match — use a `RegExp`; message records are `{info, parts}` (role/finish/parentID live under `info`); `/session/status` values are `{type:"busy"}` objects; a single-chunk reply can carry zero `message.part.delta` events (the first chunk lands in the `part.updated` text), so part text must be accumulated consumer-style.

## Tier A2 finding (2026-08-22 evening) - tool name clobber (FIXED in sidecar)
Contract.sequence golden-event tests (synthetic tool events, name only on the start payload) drove createEventHandler and exposed a real sidecar bug in src/prompt.ts.
- getToolName fell back to the literal default name when an event payload carried no name; emitToolPart unconditionally overwrote the stored name, so update and end payloads (the common OMP shape) corrupted the part in every subsequent message-part-updated frame.
- Fix (sidecar source, verified by Tier A2 suite + full test run + tsc): getToolName returns string-or-undefined; emitToolPart only upgrades the stored name when a real name is present and always emits the stored entry name.
- Also pinned by the suite: toolcall input-streaming events start parts in the pending state; execution status only comes from execution events; unchanged tool states emit no duplicate frames.
