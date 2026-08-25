# OMP (oh-my-pi 17.3.5) RPC protocol notes — Phase 0 prototype

Environment: local `omp` = `/opt/homebrew/bin/omp` (oh-my-pi 17.3.5, Bun/TS, repo `can1357/oh-my-pi`).
Sidecar: ftiasch `openchamber-omp-proxy` clone at `~/omp-prototype/sidecar` (scratch, no commits to openchamber repo).
Source clone for forensics: `~/omp-prototype/omp-src` (shallow, tag `v17.3.5`, matches installed version).

## Process model

Three OMP invocation shapes observed:

| Shape | Spawns | Lifespan | Where |
|---|---|---|---|
| `omp --mode rpc --cwd <dir> --no-title --no-pty` (persistent) | 1 per active prompt session | lives until sidecar kills it | sidecar `prompt.ts:366` `getOrCreateSessionState` |
| `omp --mode rpc ...` (ephemeral, message fetch) | 1 per `GET /session/:id/message` cache-miss | ~1–2 s, SIGTERM on completion | sidecar `messages.ts:338` via `rpc.ts:213 withOmpRpc` |
| `omp --mode rpc ...` (ephemeral, providers) | 1 per `GET /config/providers` | ~1–2 s, SIGTERM on completion | sidecar `main.ts:179` via `withOmpRpc` |

Ephemeral children are short-lived enough that `ps`/`lsof` snapshots almost never catch them;
only the persistent prompt child (pid 66603 in this run) shows up in `lsof` holding session files.

## Session file layout

- Dir: `~/.omp/agent/sessions/<cwd-slug>/` e.g. `-claude-cowork-chatwoot/`
- File: `<ISO-8601-ish-timestamp>_<uuidv7-with-dashes>.jsonl`
- OMP session UUID (8-4-4-4-12 groups) maps to OpenCode-style ids: strip dashes, prefix `ses_` (and inverse). Sidecar implements both in `sessions.ts` `toOpenCodeSessionId`/`fromOpenCodeSessionId`; the 2026-07-15 chatwoot session is the one the UI surfaced (see below).
- Entries: one JSON object per line. `parentId` links each new entry to the chain head, so the file is an append-only linked list of a branch.

## Event vocabulary actually emitted (vs. the stale `docs/rpc.md`)

- Turn streaming: **`message_update`** with `assistantMessageEvent` subtypes (`text_delta`, `thinking_delta`, `toolcall_*`). NOT a standalone `message_update`-per-chunk shape; the subevent carries the payload.
- Turn completion: `agent_end` and/or `prompt_result` (sidecar treats `prompt_result` with `agentInvoked:false` as completion too).
- Session-change responses: `{cancelled: boolean}` — no state echo. `get_state` returns the full model/state object.
- Provider auth failure mid-turn (e.g. Bedrock 403 "security token invalid"): the turn ends in error, but in the tested case no `agent_end`/`prompt_result` reached the sidecar listener → sidecar `state.busy` never cleared → every subsequent `prompt_async` returns 409 "session busy" (sidecar `prompt.ts:409`). UI is stuck pending forever (no toast, no assistant row).

## THE 20-second `session_exit` loop — root cause (fully source-traced)

Symptom: the 39-day-old session file `2026-07-15T13-31-49-153Z_019f65f9-fa21-7000-892d-b00212c6d038.jsonl`
(OpenChamber id = `ses_` + dashes-stripped file UUID `019f65f9-fa21-7000-892d-b00212c6d03`…; see `fromOpenCodeSessionId`) accumulated
**81 `session_exit` records** at ~20 s cadence between 22:36Z and 23:05Z on 2026-08-22, e.g.:

```json
{"type":"custom","customType":"session_exit","data":{"reason":"sigterm","kind":"signal","recordedAt":"2026-08-22T23:04:44.575Z"},"id":"ca56e482","parentId":"5a386062",...}
```

Causal chain (every step verified in source):

1. OpenChamber UI (chatwoot session view) polls `GET /session/<id>/message` roughly every 20 s (83 requests in the window; 5 s TTL message cache + inflight dedup in sidecar `messages.ts:73/360` explains the occasional 40 s gap).
2. Cache miss → `loadFromRpc` (`messages.ts:331`): `withOmpRpc(cwd, ...)` — **spawns a fresh ephemeral `omp --mode rpc` child** (`rpc.ts:69`), awaits `ready`.
3. The callback calls `switch_session <07-15 jsonl path>` (`messages.ts:339`). OMP handles it in `rpc-mode.ts:481`: `session.switchSession(sessionPath)` — this **resumes the 39-day-old session as the live session** of the new process (replays the branch to the latest entry; that latest entry becomes `parentId` for whatever is appended next — visible in the record chain).
4. `get_messages` returns; the callback finishes.
5. `withOmpRpc` finally-block: `conn.kill()` → `Subprocess.kill()` → **SIGTERM** (Bun default; `rpc.ts:202-210`).
6. OMP child: `postmortem.ts:327` `process.on("SIGTERM", ...)` → `runCleanup(Reason.SIGTERM)` (`postmortem.ts:20` `Reason.SIGTERM = "sigterm"`) → session-teardown (`session-teardown.ts`: postmortem handler calls the shared `beginDispose`/`disposeSession` with the recorded reason) → `AgentSession.#recordSessionExit("sigterm")` (`agent-session.ts:2020`):
   - `#exitRecorded` is per-instance, so a **fresh** process instance always re-records;
   - the guard (no record if no pending tool calls AND no assistant messages in the branch) does not skip, because the 07-15 file has assistant messages;
   - `kind` mapping: anything not dispose/manual/uncaught/unhandled/EXIT → `"signal"` (`agent-session.ts:2030-2037`);
   - appends `{customType:"session_exit", data:{reason:"sigterm", kind:"signal", recordedAt}}` and `flushSync()` (`agent-session.ts:2045-2046`).
7. `exitProcess(143)` (`postmortem.ts:329`). Next UI poll starts again at step 2.

Conclusions:

- The records are **synthetic bookkeeping artifacts of the sidecar's spawn-ask-SIGTERM pattern**, not a real crash, OMP bug, or provider issue. OMP's postmortem is behaving correctly for "session was resumed and process was SIGTERM'd"; the sidecar's message-read design is what triggers it.
- It **pollutes the target session file**: every poll appends a chain entry to the 39-day-old session. Repeated polling = unbounded growth of `session_exit` records in the resumed file. (81 lines added in ~30 min for one viewed session.)
- The same pattern applies to `GET /config/providers` (`main.ts:179`) but that path does not `switch_session`, so it does not target an existing session file (the spawned child's "current session" handling was not observed to write foreign files in this run).
- It also masks forensics: only the persistent prompt child (pid 66603, spawned for the "probe" prompt at 22:33Z) keeps the file open continuously, which is why `lsof` appeared to show "one mysterious writer" while `ps` showed no OMP children.

Fix options for the sidecar (not applied — scratch prototype, noted for diff B-era fixes):

1. **Read session JSONLs directly from disk** for the message-read path (same machine, trivial parse) — no OMP spawn for reads.
2. **One long-lived OMP RPC child per cwd** reused across message fetches; only SIGTERM on true shutdown → at most one `session_exit` per shutdown instead of per poll.
3. (Blunt) `kill("SIGKILL")` on ephemeral children: postmortem handlers never run → no record written. Works, but loses any legitimate postmortem bookkeeping and is generally bad manners.

Recommended: (1) for reads; (2) if RPC-based reads are wanted.

## Other live observations (this run)

- `POST /session` (create) is a **stub** returning `{id:"ro_...", directory, time}` — sessions cannot be created through the sidecar; new-session flow untested.
- `GET /experimental/session?roots=true` lists all OMP sessions across dirs (works; powers the UI sidebar; this is how the 07-15 chatwoot session surfaced in the UI).
- `GET /config/providers` → real OMP data: 4 providers / 252 models (Bedrock, Bedrock Mantle, OpenAI, llama.cpp) mapped to OpenCode shape.
- Stuck-pending UI state (no toast on provider 403) is a consequence of the missing `agent_end` on auth failure + 409 busy lock described above; OpenChamber itself received nothing on the event stream for that turn.
- `GET /session/status` reflects sidecar-internal busy map only (`prompt.ts:503`) — no OMP round-trip.
- Session **listing/lookup** (`sessions.ts`) is pure filesystem: `readSessionHeader` parses only the first 200 lines for a `type:"session"` entry (+ latest `title`/`title_change`). `time.updated` = file **mtime**, so every `session_exit` append from the polling loop above also refreshes the session's "recently updated" stamp in the UI list — another visible symptom of the contamination.
- OMP session header fields observed: `id` (uuid), `cwd`, `title`, `timestamp`, `version`. `encodeCwd`: `$HOME` stripped, `/`→`-`.

## Raw captures

`notes/raw/`:
- `p1-2026-08-22T21-29-18-214Z.jsonl` — P1 handshake + new_session + get_state.
- `p2-*Bedrock*.jsonl` — P2 run 1: Bedrock 403 security-token-invalid (errorId in payload).
- `p2-*llama.cpp*.jsonl` — P2 run 2: llama.cpp 401 (stale `auth: none` in `~/.omp/agent/models.yml`; server now key-gated).
- `p2-*openai*.jsonl` — P2 run 3: OpenAI `insufficient_quota` (full errorMessage surfaced in RPC response).
- `out-api-providers.json` — full P7 providers payload (252 models; source for llama.cpp Qwen3.8-27B model ids).

## vLLM run, loop fix, and final validation (2026-08-22/23)

### Provider: vLLM as the live llama.cpp model

- Server: Docker container `qwen38-27b-rtx3090-single-1` (jarvis, 100.77.106.117 / 192.168.1.20, RTX 3090) running vLLM 0.27.1 with dflash2 speculative decoding and the qwen3 reasoning parser; it serves Qwen3.8-27B under the name `qwen3.8-27b`, 128K context, text-only (language-model-only flag), and the API is key-gated (`/v1/models` returned 401 without the key, 200 with).
- Key: stored in `~/omp-prototype/vllm.key` (chmod 600), referenced from `~/.omp/agent/models.yml` via apiKey auth so the key itself never lands in the YAML.

### OMP config + discovery behavior (models.yml / models.db)

- Final llama.cpp block in models.yml: baseUrl with the /v1 suffix (discovery queries the models path beneath it), api openai-responses, auth apiKey, discovery type llama.cpp.
- OMP discovery of a Qwen3 model on llama.cpp rewrites the local entry to openai-completions with reasoning enabled and 128K context; the fresh qwen3.8-27b entry replaced the stale Qwen3.6-27B names in the models.db catalog.
- Gotcha: a models refresh whose provider fetch fails silently keeps the stale entry, which is why the earlier base URL without the /v1 suffix kept a dead entry around until the YAML was fixed and refresh re-ran.

### P2 final run (happy path through the sidecar) — PASS

- `POST /session/<07-15-ses>/prompt_async` with `model: llama.cpp/qwen3.8-27b`, text "Reply with exactly these two words: P2-SIDECAR-OK" → 200 queued; the turn finished in well under a second; the follow-up message fetch returned 17 records whose last entry is the new assistant record: a thinking block (qwen3 reasoning-parser output) plus the text block "P2-SIDECAR-OK". The sidecar maps both to OpenCode parts and the UI renders the reply with the qwen3.8-27b / omp model chip.
- No extra `session_exit` records around this turn; the file grew only by the legitimate user + assistant records.

### The 20 s loop — fix applied and validated (fast path)

- Fix (option 1 from the section above, applied to scratch sidecar `src/messages.ts`): `loadSessionMessages` now first tries `loadMessagesFromFile`, a direct read of the session JSONL in which every entry is mapped by the shared OMP-to-OpenCode message mapper; the ephemeral switch_session + get_messages RPC remains as a fallback for missing or unreadable files. The 5 s TTL cache and in-flight dedup are unchanged, so the read pattern is identical; only the cache-miss backing changed from "spawn OMP, resume, SIGTERM" to "read a file".
- Validation (script `verify-fastpath.ts`, result in `raw/verify-fastpath.json`): with the UI actively polling the same session (sidecar log shows repeated message cache-miss lines, TTL forcing real reloads), the file gained zero `session_exit` records over several minutes and no ephemeral OMP RPC child appeared in ps during the window. Pre-fix, the same traffic pattern had added one record every 20 s. The loop is dead. The 147 historical records (112 pre-existing plus 35 written during this session's pre-fix window) remain but no longer grow; the 07-15 file is otherwise untouched.
- In-progress-turn behavior is unchanged by design: the assistant record appears in the JSONL only when the model completes the turn, and live deltas still stream from the persistent prompt child, so typing-indicator behavior is identical to the RPC path.

### P4 (multi-turn / busy semantics / persistent-child reuse) — PASS

- Harness `p4-steer.mjs`, result in `raw/p4-result.json`, all against the same 07-15 session:
  - turn1 "P4-TURN1" → 200 queued, new assistant record with exact text P4-TURN1, finish stop.
  - an immediate concurrent probe prompt while turn1 was live returned 409 "session busy" (sidecar per-session busy lock in prompt.ts); the probe never ran and does not appear in the transcript.
  - after turn1 completed, re-sent "P4-TURN2" → 200, assistant record with the correct parent chain (same live session, multi-turn continuity).
  - "P4-FREE" after completion → 200, assistant record (busy lock released on turn end; session steerable again).
- Persistent-child reuse evidence: ps during and after the run showed exactly one OMP RPC child (rpc mode, cwd chatwoot, no-title, no-pty; ppid is the sidecar's bun process), alive across all three turns — the sidecar reused the per-session persistent child instead of spawning per turn; that one process appended every turn's records.
- UI: P4-TURN1, P4-TURN2, P4-FREE rendered as successive qwen3.8-27b / omp assistant rows in order — a live multi-turn conversation over OMP inside OpenChamber.
- Interpretation: OMP 17.3.5's RPC exposes no mid-turn steer or interrupt that the sidecar can use; concurrency is guarded by the 409 busy lock, and a "steer" is practically another prompt queued on the same live session (turn N+1 starts after turn N's prompt_result). True interruption maps to OMP abort, which the sidecar wires at the abort endpoint but which was outside P4's scope.

### P8 (image input) — N/A, documented, not run

- The only live model in this env (qwen3.8-27b via vLLM) was launched text-only (language-model-only; the container has no image encoder). Sending an image part would produce a provider-side error, not a protocol finding, so no image prompt was fired. N/A for this provider, not a sidecar gap.

### Known cosmetic/robustness notes (non-blocking; for a real integration)

- Old 07-16 tool rows render huge durations in the UI (for example 3319924.3 s) because those historical records carry corrupt or zero completion-time values, so elapsed becomes now minus July 16. Fresh turns (P2, P4) show correct sub-second timings. Pre-existing data quality, not sidecar behavior.
- OpenChamber logs a non-fatal bootstrap console error (filter is not a function) on page load — the directory-scoped event request of diff D (404) feeding the bootstrap path. Everything still renders; tied to the same open question as diff D.
- The config/providers endpoint still spawns an ephemeral OMP child per fetch (1-2 s), but it does not switch_session, so it never polluted a session file — the churn came exclusively from the message-read path, now fixed.

### Cleanup performed

- Deleted the three probe-leaked session files in the chatwoot sessions dir (created 2026-08-22 during the permission-probe and one-pixel image probes; identified by their probe text before deletion). The directory now contains only the user's original 07-15 session file and its directory.
- Decision left to the user: the 07-15 file's 147 synthetic session_exit records (112 pre-existing + 35 from this session's pre-fix window) are harmless postmortem bookkeeping that OMP resumes through cleanly; default recommendation is to leave the file as-is.

### P9/P10 (materialize, concurrency, abort, SSE re-verification) — 2026-08-23 (phase-0 closeout)


- **P9 materialize** (`p10-materialize.mjs` against a fresh `probe-cwd2`): one turn fired → child wrote the session JSONL only after the turn **completed** (0 records mid-turn, 13 at rest); a subsequent **SIGTERM of the child appended exactly one `session_exit`** (reason sigterm, kind signal, chained to the last assistant record) and nothing else; killing a child that never completed a turn appends **no** file at all. The sidecar discovers the materialized file later via its directory session list.
- **P10 concurrency** (`p10-concurrent.mjs`, two cwds / two sessions fired ~1 s apart): both accepted (`200` + queue ack); two **persistent per-cwd rpc children** alive simultaneously under the sidecar (ppid = sidecar bun pid; `--mode rpc --cwd … --no-title --no-pty`); by a 6 s probe both short turns had already **completed**, so the probe re-sent normally (200, no busy) — the 409 window is turn-duration-bound; abort → `200 "true"`; post-abort prompt → `200` queued. SSE capture during this short run was empty (harness race: `r.text()` only resolves on stream close, which never happens on a live stream).
- **P10-LIVE** (`p10-live.mjs`, deterministic long turn, ~2500-word essay): fire → `200 queued`; **t+4 s concurrent prompt → `409 {"error":"session busy"}`** (the per-session busy lock, finally demonstrated on a genuinely live turn — P4's 409 and P10's 200 both explained); **t+8 s abort → `200 "true"`**, and the follow-up at t+10 s → `200 queued` (lock released). File forensics: the aborted turn materialized an **empty assistant record at abort time**, but the vLLM stream kept running and the **completed ~16.4 KB essay was appended ~75 s later, attached to the latest user message** (the two-word follow-up). **No `session_exit`** was appended (abort ≠ process teardown).
- **Abort semantics (integration implication)**: the OMP 17.3.5 RPC has no turn-cancellation primitive the sidecar can use; its `abort` is a session-level best-effort stop that (a) releases the busy lock and (b) flushes whatever the child holds, while the in-flight provider stream runs to completion and re-lands under the newest prompt. A real integration must treat abort as "UI turn ended, output may still arrive" or add cancellation at the vLLM/HTTP boundary.
- **Non-monotonic session files**: OMP children rewrite their session JSONL **from in-memory state** (full-file rewrite, not strict append) — observed shrink 15→14 records in probe-cwd2 and 204→203 in the 07-15 chatwoot file with the 147 `session_exit` count unchanged. Content is preserved; **line count is not a stable authority** — diff by record id/timestamp instead.
- **SSE re-verification (Diff E)**: raw 25 s capture through one full turn (`notes/raw/sse-capture-2026-08-23T01-38.txt`): `: ok` preamble, 20 s `: heartbeat`, then `id`-numbered frames `message.updated`, `message.part.updated`, `message.part.delta` (×N), `message.part.updated`, `message.updated`, `session.idle`; **identical on `/events?directory=…` and `/global/event`**. OpenCode-style vocabulary confirmed as what OpenChamber consumes; synthesized by the sidecar from OMP's `message_update` assistantMessageEvent sub-events.
- **Secret hygiene**: the two P9 raw captures contained the real vLLM Authorization header → replaced **in place** with a `[REDACTED]` marker in `notes/raw/p10-materialize-*.jsonl` (pre-edit sha256 recorded). A full sweep of notes/, logs/, and the sidecar dir for 32+ char tokens found no further key material (only UUIDs, provider response ids, base64 image blobs, model strings).
- Cleanup performed for P9/P10: probe-cwd2 child killed, `probe-cwd2/` and its session dir under `~/.omp/agent/sessions/` deleted; sidecar and chatwoot child left running; `notes/raw/sse-capture-2026-08-23T01-38.txt` and `logs/sse-capt3.log` kept as the raw evidence.

### P11 (provider-failure turn termination — closes the P2 stale-lock finding) — 2026-08-23

- Setup: fresh scratch cwd (probe-cwd3). A direct-child `new_session` **alone does not materialize** the session file (the first p11-setup run left an empty dir; `GET /session?directory=` returned nothing). Materialized instead with one completed vLLM turn (`p11-setup2.mjs`, raw capture `notes/raw/p11-setup2-2026-08-23T05-38-45-242Z.jsonl`, 255K); the session then appears in the sidecar's directory listing.
- Probe (`failturn-capt.mjs`, 30 s pre-fire `/events?directory=` capture, raw `notes/raw/sse-capture-failturn.txt`): fire `amazon-bedrock/us.anthropic.claude-opus-4-8` "Say hi" → 200 queued; +8 s fire `llama.cpp/qwen3.8-27b` "LOCK-PROBE hi" → **200 queued (not 409)** — the failed bedrock turn (expired STS → 403) **ended and released the busy lock**.
- Stream: the failed turn delivered `session.status` busy → `session.idle` with **zero message frames** — no `agent_end`, no `prompt_result`, and no error frame (OpenCode-style SSE has no error event on this path). The follow-up qwen turn delivered the normal chain, ending `message.updated` with `finish:"stop"` → `session.idle`.
- Session JSONL (14 records, child still alive, no `session_exit`): `user "Say hi"` + **empty assistant record** persisted — the same flush signature as an aborted turn (P10-LIVE). The qwen reply's reasoning treated the setup turn as the previous one; the failed prompt left no assistant content anywhere.
- Verdict: the P2-era "stale busy lock / 409 for everything after" symptom is **not reproducible** on the current sidecar build (OMP 17.3.5, 2026-08-23 tree). The one residual contract gap on provider failure is **no error surfaced on the stream**: the sidecar synthesizes frames only from OMP `message_update` sub-events, which the 403 path never emits, so a stream-only client sees the turn vanish silently. Mitigation (integration phase): have the sidecar's turn handler emit an error marker (e.g. a `message.updated` with finish:"error" from a non-OK RPC `errorMessage` or the empty-assistant flush) so OpenChamber's sync store can render an error row/toast.
- Cleanup: after the run no OMP child remained in the process table (the probe child went away on its own); `probe-cwd3/` and its session dir were deleted; chatwoot file and sidecar untouched (203/147).
