# Phase-0 report — external OMP (oh-my-pi 17.3.5) sidecar vs OpenChamber

Date: 2026-08-22/23. Scope: verify what an OpenChamber client actually receives when the
OpenCode-API surface is served by an OMP-based sidecar, using only scratch state outside
`/Users/alvin/claude-cowork/openchamber`. Companion docs: `contract-diff.md` (API-level
diffs A-F) and `omp-protocol-notes.md` (OMPP/OMP process & file-level protocol notes).

## Bottom line

OpenChamber works against the sidecar for: project bootstrap, session listing, message
transcripts (fast path), single- and multi-turn live prompts over a real model (vLLM
qwen3.8-27b), and the live event stream (OpenCode-style SSE vocabulary). Gaps that matter
for a real integration: no `POST /session` create, no directory-scoped event endpoint
(404), abort is not a true cancellation, and OMP's session files are rewritten (not
strictly appended) with `session_exit` postmortem records churned by short-lived
resume-then-kill polling.

## Test matrix

| Probe | Question | Verdict | Evidence |
|---|---|---|---|
| P1 | Can OpenChamber boot against OMP and read one session? | PASS (after sidecar diff A) | `raw/out-session-via-openchamber.json`, `raw/p1-*.jsonl` |
| P2 | Does a live turn through the real UI work end-to-end on a live provider? | PASS (vLLM qwen3.8-27b; earlier bedrock/openai attempts failed at the provider layer, not the sidecar) | `raw/p2-*.jsonl` (3 runs), `logs/p2-console.log` |
| P4 | Multi-turn on one live session; busy semantics; child reuse | PASS: 3 turns back-to-back, `409 session busy` on the in-flight probe, one persistent OMP child reused for all turns | `raw/p4-result.json` |
| P8 | Image input | N/A - the only live model in this env is text-only (vLLM `--language-model-only`); not a sidecar gap | `omp-protocol-notes.md` P8 |
| P9 | When does OMP materialize a session file; what lands at teardown? | File appears only after first completed turn; SIGTERM appends exactly one `session_exit`; no-turn kill appends nothing | `raw/p10-materialize-*.jsonl` (2 captures), `omp-protocol-notes.md` P9 |
| P10-A | Concurrent turns across two cwds/sessions | Two persistent per-cwd children run side by side; both prompts accepted; 6 s busy-probe saw 200 only because short turns had already finished (lock exists, window is turn-duration-bound) | `raw/p10-concurrent-result.json` |
| P10-LIVE | Deterministic long turn: fire / in-flight probe / abort / follow-up | `200 queued` -> probe `409 session busy` -> abort `200 "true"` -> follow-up `200 queued`; aborted essay's vLLM stream ran to completion and landed attached to the latest user message (~75 s later); no `session_exit` appended on abort | `raw/p10-live-result.json`, `logs/p10-live-run*.log`, session jsonl forensics in `omp-protocol-notes.md` P9/P10 |
| SSE (Diff E) | What does the client's event stream actually emit? | Raw capture verified: `: ok`, 20 s `: heartbeat`, `message.updated` / `message.part.updated` / `message.part.delta` / `message.updated` / `session.idle` per turn, identical on `/events?directory=` and `/global/event` | `raw/sse-capture-2026-08-23T01-38.txt`, `logs/sse-capt3.log` |
| P11 | Provider-failure turn termination: does the lock stick? does the error surface? | RESOLVED (2026-08-23): bedrock 403 (expired STS) ends the turn busy -> idle with zero message frames and the lock released - follow-up prompt accepted ~8 s later, so the P2-era "409 for everything after" is not reproducible on the current build. JSONL persists user + empty assistant (same flush signature as an aborted turn). The one residual gap: **no error is surfaced on the stream** at all (frames are synthesized only from OMP `message_update` sub-events, which the 403 path never emits); mitigation = sidecar turn handler emits an error marker from the RPC `errorMessage` | `raw/sse-capture-failturn.txt`, `raw/p11-setup2-2026-08-23T05-38-45-242Z.jsonl`, probe-cwd3 session JSONL (14 records) |

## Protocol findings (new vs OpenChamber's OpenCode assumptions)

1. **`session_exit` postmortem loop**: any host that resumes a session and SIGTERM's the
   OMP child (the sidecar's old spawn-ask-kill message-reader did this every ~20 s)
   appends one chained `session_exit` record per poll - 147 records accumulated on the
   07-15 chatwoot file. Fixed in this run by the direct-JSONL fast path; the 147
   historical records remain in the user's file (harmless, left as-is).
2. **Session files are rewritten (non-monotonic), not strictly appended**: OMP children rewrite the whole
   JSONL from in-memory state; observed shrink 15 14 (probe) and 204 203 (chatwoot, exit
   count unchanged). Consumers must not treat line count as an authority - diff by record
   id/timestamp.
3. **Abort is best-effort**: the OMP 17.3.5 RPC has no turn-cancellation primitive the
   sidecar can use; abort releases the busy lock and flushes whatever the child holds,
   but the in-flight provider stream completes and re-lands under the newest prompt. A
   real integration must treat abort as "UI turn ended, output may still arrive" or add
   cancellation at the vLLM/HTTP boundary.
4. **Per-session busy lock**: concurrent `prompt_async` on a live turn returns
   `409 {"error":"session busy"}`; the lock window equals turn duration (proven by the
   P4 409 and the P10-LIVE 409 at t+4 s of a long turn).
5. **`GET /session/:id/message` is empty for directory-discovered sessions** until the
   sidecar itself observes turns for them - the JSONL file is the ground truth.

## Sidecar diff ledger (scratch sidecar only; OpenChamber repo untouched)

A fixed (`GET /project` shape) - B intentional stub (`POST /session`) - C verified (read
paths) - D open (`GET /event?directory=` 404; global stream compensates) - E verified
(SSE vocabulary, P10-LIVE raw capture) - F documented limitation (abort semantics) - G resolved (P11: provider-failure termination; residual gap = error not surfaced on stream, mitigation in sidecar turn handler).

## Environment state at close

- OMP sidecar (bun, pid 15148) running and healthy on 127.0.0.1:4096; OpenChamber UI on
  :3100 running against it; no OMP children at rest (spawned on demand).
- User data untouched: `/Users/alvin/claude-cowork/openchamber` zero writes; chatwoot
  session `2026-07-15T13-31-49-153Z...` left in place at 203 records / 147 exit records.
- Probe state removed: `probe-cwd2/` and `probe-cwd3/` with their session dirs deleted (P11 captures kept in notes/raw); vLLM key never echoed
  or stored in notes (redacted in the two materialize captures; 32+-char token sweep
  clean).

## Open questions for a real integration

1. Directory-scoped event endpoint (diff D): topology decision - one sidecar per cwd vs
   a router.
2. Real `POST /session` on top of OMP's `new_session` RPC (currently a stub).
3. Approval/permission surfacing: OMP's tool-approval surface does not map onto
   OpenCode's `permission`/`question` resources over this RPC shape.
4. **RESOLVED (P11, 2026-08-23)** - provider-failure turn termination: clean bedrock-403 capture shows the turn ends (busy -> idle) and the busy lock released - the P2-era stale-lock symptom is not reproducible on the current build.
   Residual integration gap: **no error surfaces on the event stream** - the sidecar synthesizes frames only from OMP `message_update` sub-events, which the 403 path never emits, so a stream-only client sees the turn vanish silently. Mitigation: sidecar turn handler emits an error marker (message.updated finish:"error") from the non-OK RPC `errorMessage` / empty-assistant flush; then OpenChamber's sync store can render an error row/toast. See `omp-protocol-notes.md` P11.
