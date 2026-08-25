# OMP 17.3.5 (oh-my-pi) — what the sidecar's backend can actually do

Captured 2026-08-24 from `omp-src/` (the vendored OMP checkout). Canonical wire contract:
`docs/rpc.md` (875 lines). Dispatcher: `packages/coding-agent/src/modes/rpc/rpc-mode.ts`.
Frame code: `rpc-frame.ts`, `rpc-messages.ts`, `rpc-types.ts`.

## 1. Transport

- OMP runs as a child process speaking **NDJSON over stdio** (one JSON object per line).
- Protocol versioning: the client sends `negotiate_protocol` (rpc-mode.ts:980); v2 adds
  `rpc_chunk` framing (rpc-frame.ts:103) for large payloads instead of unbounded line length.
  The sidecar currently operates on the plain line protocol (v1-compatible).
- Every outbound frame category (docs/rpc.md:71-85): `ready`; `response` (command ack);
  `AgentSessionEvent` objects; `extension_ui_request`; `host_tool_call` / `host_tool_cancel`;
  `host_uri_request` / `host_uri_cancel`; `extension_error`; `available_commands_update`;
  `prompt_result`; `subagent_lifecycle` / `subagent_progress` / `subagent_event` (gated by
  `set_subagent_subscription`); side channels `command_output`, `session_info_update`,
  `config_update`.
- Inbound: `RpcCommand` (any command, optional `id`), `extension_ui_response`,
  `host_tool_update` / `host_tool_result`, `host_uri_result`.

## 2. Command reference (dispatcher cases, rpc-mode.ts:980-1400)

| Group | Commands | Notes |
|---|---|---|
| Protocol | `negotiate_protocol` | v2 chunked framing |
| Prompting | `prompt` (images, `streamingBehavior`: steer/followUp) · `steer` · `follow_up` · `abort` · `abort_and_prompt` | `prompt` acks **immediately**; completion comes via events or a later same-id error; `data.agentInvoked` tells you whether an agent turn ran (docs/rpc.md:209-231) |
| Session | `new_session` (with `parentSession` = **fork**) · `switch_session` · `branch` (entryId) · `set_session_name` · `handoff` | TUI also offers /fork, /share (E2E link), /export, /resume, /dump |
| State | `get_state` | big payload, see §3 |
| Todos | `set_todos` | phases → tasks (docs/rpc.md:362) |
| Host tools | `set_host_tools` · `set_host_uri_schemes` | host-executed custom tools (docs/rpc.md:625-681) |
| Subagents | `get_subagents` · `get_subagent_messages` · `set_subagent_subscription` | transcripts: `<session>/<AgentId>.jsonl`, recursive (session/messages.ts:422) |
| Model | `set_model` · `cycle_model` · `get_available_models` | `model_changed` events |
| Thinking | `set_thinking_level` · `cycle_thinking_level` | `thinking_level_changed` events |
| Queue modes | `set_steering_mode` (`all`\|`one-at-a-time`) · `set_follow_up_mode` · `set_interrupt_mode` (`immediate`\|`wait`) | |
| Compaction | `compact` · `set_auto_compaction` · `auto_retry` · `abort_retry` | `auto_compaction_start/end`, `retry_*` events |
| Bash | `bash` · `abort_bash` | direct shell execution |
| Introspection | `get_session_stats` · `get_messages` · `get_messages_page` (paginated) · `get_branch_messages` · `get_last_assistant_text` · `export_html` | |
| Login | `get_login_providers` · `login` | `open_url` extension-UI flow |

## 3. `get_state` payload (docs/rpc.md:233-295)

```
{ model: {provider, id}, thinkingLevel: "off|minimal|low|medium|high|xhigh|max",
  isStreaming, isCompacting, steeringMode, followUpMode, interruptMode,
  sessionFile, sessionId, sessionName,
  fastModeEnabled, fastModeActive, tokensPerSecond,
  autoCompactionEnabled, messageCount, queuedMessageCount,
  todoPhases: [{id, name, tasks: [{id, content, status}]}],
  systemPrompt: string[], dumpTools: [{name, description, parameters}],
  contextUsage: {tokens, contextWindow, percent} }
```

## 4. Event stream (docs/rpc.md:471-517)

`agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`,
`message_end`, `tool_execution_start/update/end`, `auto_compaction_start/end`,
`auto_retry_start/end`, `retry_fallback_applied/succeeded`, `model_changed`,
`thinking_level_changed`, `ttsr_triggered`, `todo_reminder`, `todo_auto_clear`,
`irc_message`, `notice`, `goal_updated`.

- `message_update` carries streaming deltas inside `assistantMessageEvent`
  (text_delta / thinking_delta / toolcall_*).
- **`agent_end` carries `isTerminal?`** (docs/rpc.md:503-511): `false` means maintenance or
  async delivery scheduled more work and the session resumes. "Treat as run completion only
  when `isTerminal !== false`." **The sidecar treats every `agent_end` as terminal**
  (prompt.ts) — wrong for the non-terminal case; a turn can settle, then resume.
- `message_end` = one assistant message completed; `agent_end` = whole agent run (all turns).

## 5. Interactive channels

### Extension UI (the ONLY interactive surface, docs/rpc.md:583-624)
Outbound `extension_ui_request` methods: `select`, `confirm`, `input`, `editor`, `cancel`,
`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, `open_url`.
Inbound `extension_ui_response`: `{id, value}` / `{id, confirmed}` / `{id, cancelled, timedOut?}`.
Timeouts resolve to a default. This is where tool approval prompts, login URLs, and extension
dialogs come from — **the source of material for opencode's `permission.asked` /
`question.asked` if the sidecar ever bridges approvals**.

### Approvals (tools/approval.ts:14, settings-schema.ts:3677-3681)
`tools.approvalMode: "always-ask" | "write" | "yolo"` — **default `yolo`** (auto-approves every
tier); per-tool overrides via `tools.approval.<name>`. In yolo mode no approval UI ever fires.
So in the common configuration OMP has no permission flow at all, and opencode's permission API
can legitimately return empty lists.

## 6. Session storage

- Sessions are **JSONL files** (one line per message/event); the session store lists `*.jsonl`
  under the session root (session/claude-session-store.ts:136, codex-session-store.ts:198).
- `session_index.jsonl` tracks known sessions.
- Forked clones are named `<agentId>.jsonl`; advisor turns persist as
  `<session>/__advisor[.<slug>].jsonl` (session/session-advisors.ts:881).
- Orphaned writes create `<basename>.jsonl.<snowflake>.bak` backups (session/session-listing.ts:521).
- Session names: `set_session_name` (auto title generation is disabled in RPC mode,
  docs/rpc.md:597-600).
- OMP is **single-project**: one session root, no multi-project registry, no worktrees, no
  share server, no E2E encryption link exposed through RPC.

## 7. Feature gaps vs the opencode API (OMP has no mechanism for these)

| opencode capability | OMP equivalent |
|---|---|
| MCP servers (`/mcp`, auth, connect/disconnect) | none |
| LSP (`/lsp`, diagnostics events) | none (extension system could, but not in 17.3.5 defaults) |
| File watcher (`file.watcher.updated`) | none |
| VCS integration (`/vcs`, branch events, diff/apply) | none (git used internally for snapshots, not exposed) |
| PTYs (`/pty*`) | none (`bash`/`abort_bash` is a different thing) |
| Multi-project registry (`/project`) | none — one cwd per child process; the sidecar fabricates per-cwd children |
| Session sharing (`/session/{id}/share` → public URL) | none via RPC (TUI /share has an E2E link but not exposed over RPC) |
| Provider catalog + OAuth (`/config/providers`, `/auth/{providerID}`, `/provider`) | none — models come from OMP's own provider list (`get_available_models`), login is OMP's own (`login`) |
| Questions API (`/question`) | nearest thing is extension UI `select`/`input`; not a first-class request type |
| Config surface (`/config`) | nearest is OMP settings + `config_update` events; no GET/PUT config API |
| Commands/agents/skills as catalog (`/command`, `/agent`, `/skill`) | partial: `available_commands_update` + `get_available_commands` (slash commands), built-in agents, skills exist in OMP but the RPC does not list them as a catalog |
| `session.next.*` durable streaming protocol | none — OMP's event stream is a live delta stream, not versioned durable events |
| `/sync/*` CRDT resync | none — `get_messages_page` pagination is the only replay mechanism |
| TUI control (`/tui/*`) | n/a (OMP *is* a TUI; its RPC mode has no inbound TUI control) |
| Workspaces/worktrees (`/experimental/workspace`, `/experimental/worktree`) | none |

## 8. Consequences for the sidecar

- Everything the sidecar can serve with real data: sessions (list/create/fork/name/messages/
  pagination), messages (full CRUD semantics via JSONL + RPC), todos, model/thinking/fast mode,
  compaction, bash, stats, export, subagent transcripts, login, available commands, context
  usage, abort/steer/follow-up, session info updates.
- Everything it must serve as a faithful empty/stub: `/mcp` (`{}`), `/lsp` (`[]`), `/vcs`
  (`{branch, default_branch}` from git if a repo is present, else empty object), `/question`
  (`[]` unless extension-UI bridging is added), `/permission` (`[]` in yolo mode, which is the
  default — so `[]` is the **correct** answer for the default configuration, not a stub),
  `/command` (available via `available_commands_update` — real data, not a stub), `/agent` and
  `/skill` (OMP does have built-in agents and skills; listing them as a catalog is a small
  mapping), `/config` and `/config/providers` (constructible from `get_state` +
  `get_available_models` + OMP settings), `/path` (pure filesystem work — no OMP needed),
  `/project` (fabricated from the session root: exactly one project, git if present).
- The one genuinely missing interactive surface: **extension-UI → opencode permission/question
  bridging** (P1 in the gap map). Everything else is mapping work over real OMP state.
