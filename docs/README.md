# Documentation

This directory contains technical specifications and reference documentation for **`omp-openchamber-server`** — the OpenCode HTTP/SSE proxy server bridging [OpenChamber](https://github.com/OpenChamber/OpenChamber) to [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`).

---

## Guides & References

| Document | Description |
|---|---|
| [`architecture.md`](./architecture.md) | **Server Architecture** — High-level design, subsystems, process management, JSONL fast path, and core invariants. |
| [`api-reference.md`](./api-reference.md) | **API Reference** — Complete OpenCode HTTP and SSE endpoint reference with request/response schemas. |
| [`omp-protocol.md`](./omp-protocol.md) | **oh-my-pi RPC Protocol** — Stdio NDJSON protocol, commands, turn events, disk schema, and process lifecycle. |
| [`openchamber-contract.md`](./openchamber-contract.md) | **OpenChamber Client Contract** — SSE event stream contract, message/part data structures, and UI reducer requirements. |
