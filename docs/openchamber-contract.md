# OpenChamber OpenCode v2 Contract

This note records the OpenCode API and event shapes used by OpenChamber's
`@opencode/client` 2.0.14 dependency. The sidecar keeps OMP's session files and
turn execution behind an adapter and exposes these v2 wire shapes at its HTTP,
SSE, and WebSocket boundaries.

## HTTP

OpenChamber normally calls `/api/...`; its web proxy strips `/api` before
forwarding to the sidecar. Directory-scoped requests use the
`x-opencode-directory` header, which the sidecar also accepts through its
legacy directory query parameter.

Responses follow the v2 operation schemas:

- Single resources and mutations with a result use `{ data: ... }` where the
  generated operation declares a data envelope. The SDK unwraps this field.
- Session and message pages use `{ data: [...], cursor: { previous?, next? } }`.
- Project lists are arrays. `/config` returns config-entry arrays, and
  `/location` returns the location object directly.
- Mutations declared as `void` return HTTP 204.

Session resources include `projectID`, `cost`, `tokens`, `time`, and
`location: { directory }`. Message history is a flat union of v2 messages,
not the older `{ info, parts }` record. Important discriminators include
`type: "user" | "assistant" | "synthetic" | "compaction" | "shell"`.
Assistant content is an ordered array of text, reasoning, and tool items.

Prompts use top-level fields such as `id`, `text`, `files`, `agents`, `skills`,
`metadata`, and `delivery`. File inputs use `{ uri, name?, description?,
mention? }`; the sidecar converts them to the v2 file-attachment shape for
messages and inbox events. Synthetic context is queued for the next prompt.
Prompt and command calls return the accepted inbox user item.

The sidecar supports staged transcript reverts and session forks at a `before`
message boundary. OMP does not keep OpenCode's per-turn filesystem snapshots,
so `session.diff` reports the current tracked workspace diff rather than a
historical diff for a selected turn.

## Events

OpenChamber consumes OpenCode v2 event envelopes:

```json
{
  "id": "evt_123",
  "created": 1780000000000,
  "type": "session.text.delta",
  "durable": { "aggregateID": "ses_...", "seq": 1, "version": 1 },
  "location": { "directory": "/workspace" },
  "data": { "sessionID": "ses_...", "assistantMessageID": "msg_...", "ordinal": 0, "delta": "Hi" }
}
```

SSE sends the envelope as a `data:` JSON frame. The global event WebSocket
sends a `ready` frame followed by `event` frames whose `payload` is the same
envelope. Directory location and durable sequence fields are included when
the event schema defines them.

Turn events use `session.execution.started`, assistant step lifecycle events,
text/reasoning deltas, tool lifecycle events, and then
`session.execution.succeeded`, `.failed`, or `.interrupted`. User prompts are
reported as `session.inbox.enqueued`; shell calls emit
`session.shell.started` and `.ended`; title changes use `session.renamed`.
The sidecar translates its existing OMP events into this v2 vocabulary.

## Local source of truth

The v2 shapes above were checked against the `@opencode/client` package in the
OpenChamber source checkout. When OpenChamber updates that dependency, review
the generated types and the API methods in
`packages/ui/src/lib/opencode/client.ts` before changing this adapter.
