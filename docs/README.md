# Architecture & Protocol Documentation

This directory contains technical specifications, protocol forensics, and design documents for **`omp-openchamber-server`** — an OpenCode HTTP/SSE proxy server bridging [OpenChamber](https://github.com/OpenChamber/OpenChamber) frontend clients to the [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) RPC backend.

---

## Document Index

### 1. Protocol Specifications & Architecture

| Document | Description |
|---|---|
| [`omp-protocol-notes.md`](./omp-protocol-notes.md) | **OMP RPC Protocol Deep Dive** — Process model (persistent vs ephemeral children), NDJSON stdio framing, session JSONL disk layout, sub-event vocabulary, and session teardown postmortem forensics. |
| [`omp-capabilities.md`](./omp-capabilities.md) | **OMP Capability Inventory** — Complete reference of oh-my-pi RPC commands, state payload structures, thinking levels, tool invocation models, and event channels. |
| [`sdk-contract.md`](./sdk-contract.md) | **OpenCode SDK Contract** — `@opencode-ai/sdk` data types, v1 vs v2 namespace differences, event union types, and the 188-route API surface. |

---

### 2. Gap Analysis & Contract Alignment

| Document | Description |
|---|---|
| [`contract-diff.md`](./contract-diff.md) | **Contract Diff & Behavior Matrix** — Detailed comparison of OpenCode API expectations vs OMP RPC capabilities, ID transformations, turn streaming synthesis, and live test results. |
| [`gap-map.md`](./gap-map.md) | **Gap Map (G1–G8)** — Prioritized breakdown of protocol gaps (SSE envelope gate, session creation, bootstrap shapes, lifecycle, part schemas) and their solutions. |
| [`sidecar-coverage.md`](./sidecar-coverage.md) | **Route-by-Route API Audit** — Comprehensive audit of all OpenCode endpoints against real server behavior, documenting supported, stubbed, and unsupported routes. |
| [`oc-usage.md`](./oc-usage.md) | **OpenChamber Frontend Analysis** — Breakdown of how OpenChamber 1.20.0 interacts with the OpenCode API, including proxying rules, sync stores, event pipelines, and UI reducers. |

---

### 3. Historical Reports & Probes

| Document | Description |
|---|---|
| [`phase0-report.md`](./phase0-report.md) | **Phase 0 Prototype Report** — Validation matrix of initial live probes (P1–P11), concurrency tests, abort semantics, and provider failures. |

---

## Key Invariants

1. **Zero modifications to upstream OpenChamber or oh-my-pi**: The server acts as a pure translation sidecar.
2. **Stable Deterministic IDs**: Bi-directional mapping between OMP UUIDs (`8-4-4-4-12`) and OpenCode format (`ses_<32hex>`).
3. **Session-JSONL Fast Path**: Reads disk transcripts directly to avoid spawning ephemeral child processes during read polling.
4. **SSE Event Stream Synthesis**: Re-encapsulates OMP internal sub-events into contract-compliant OpenCode SSE stream frames (`message.updated`, `message.part.updated`, `message.part.delta`, `session.idle`).
5. **Process Tree Lifecycle**: Hardened subprocess lifecycle running in detached process groups with pre-ready health gating to eliminate startup deadlocks.
