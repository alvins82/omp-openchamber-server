# openchamber-omp-proxy

Use [OpenChamber](https://github.com/OpenChamber/OpenChamber) as a UI for [oh-my-pi](https://github.com/can1357/oh-my-pi) coding sessions — without modifying either project.

## Usage

### Prerequisites

- `omp` on `PATH`
- `openchamber` on `PATH` (typically `~/.bun/bin/openchamber`)
- `bun install` in this repo

### Run

```bash
# Terminal 1 — start the proxy
bun run start
# → [proxy] listening on http://127.0.0.1:4096

# Terminal 2 — start OpenChamber pointing at the proxy
OPENCODE_HOST=http://127.0.0.1:4096 \
  OPENCODE_SKIP_START=true \
  openchamber serve --foreground --port 3000
```

Open `http://127.0.0.1:3000/`. Add a project directory matching one of your omp session roots; sessions appear in the sidebar.

### Verify

```bash
# Proxy health
curl http://127.0.0.1:4096/global/health
# → {"healthy":true,"status":"ok"}

# Session list
curl "http://127.0.0.1:4096/session?directory=<your-project-dir>"

# Run tests
bun run check
bun test
```

## Design

OpenChamber is built as a frontend for [OpenCode](https://github.com/OpenCode/OpenCode). oh-my-pi speaks its own RPC protocol. This proxy sits between them, impersonating the OpenCode HTTP API that OpenChamber expects while driving omp's RPC underneath.

```
OpenChamber ──(OpenCode HTTP API)──▶ proxy ──(omp RPC)──▶ oh-my-pi coding agent
```

The proxy translates three paths:

| OpenChamber call               | Backed by omp RPC               |
| ------------------------------ | ------------------------------- |
| `GET /session`                 | `~/.omp/agent/sessions` scan    |
| `GET /session/:id/message`     | `switch_session` + `get_messages` |
| `POST /session/:id/prompt_async` | `prompt` / `set_model` / streaming events |
| `GET /config/providers`        | `get_available_models`          |
| `POST /session/:id/abort`      | `abort`                         |

Key invariants:

- Zero changes to OpenChamber or oh-my-pi.
- Session IDs are deterministically encoded (`omp UUID` → `ses_<32hex>`), so URLs survive proxy restarts.
- Message records carry `parentID` and `finish: "stop"` so OpenChamber's turn grouping and sorted render work correctly.
- Tool calls (`read`, `bash`, `grep`, …) are mapped to real `type:"tool"` parts with `state.status/input/output/time`, not just text dumps.
- Live prompts stream via `message.part.delta / message.part.updated / session.status` SSE events that match OpenChamber's reducer contract.
