# omp-openchamber-server

Use [OpenChamber](https://github.com/OpenChamber/OpenChamber) as a UI for [oh-my-pi](https://github.com/can1357/oh-my-pi) coding sessions — without modifying either project.

## Quick Start

### 1. Prerequisites

- [`omp`](https://github.com/can1357/oh-my-pi) on `PATH`
- [OpenChamber](https://github.com/OpenChamber/OpenChamber) installed or running
- [Bun](https://bun.sh) runtime

### 2. Start the Proxy Server

```bash
bun install
bun run start
# → [proxy] listening on http://127.0.0.1:4096
```

### 3. Connect to OpenChamber

![How to add OMP Server to OpenChamber](./assets/openchamber-add-server.gif)

#### Option A: Via OpenChamber UI (Recommended)

1. **Open Remote Instances**:
   - Go to **Settings** → **Remote Instances** (or click the instance menu in the top-right corner and choose **+ Add instance**).
2. **Add Server**:
   - Click **+ Add server** and configure:
     - **Label (optional)**: `OMP Server`
     - **URL**: `http://127.0.0.1:4096`
     - **Connection token**: *(leave blank for local servers)*
     - Click **Add server**.
3. **Switch & Select Instance**:
   - Click the server instance switcher in the **top-right corner** of OpenChamber (e.g. `OMP Server` or `Local`).
   - Select **OMP Server** (`● Connected`) and star it as default.
   - All your oh-my-pi sessions will appear in the sidebar, and your prompts will be driven by `omp`!

#### Option B: Via CLI Environment Variables

```bash
OPENCODE_HOST=http://127.0.0.1:4096 \
  OPENCODE_SKIP_START=true \
  openchamber serve --foreground --port 3000
```
Open `http://127.0.0.1:3000/` in your browser.

## Development & Testing

```bash
# Type-check
bun run check

# Run unit and contract test suite
bun test

# Optional: Run live end-to-end suite against real omp binary & active model
bun run test:live
```

## Documentation

Full architectural specifications, API schemas, and protocol references are in [`docs/`](./docs):

- [`architecture.md`](./docs/architecture.md) — Subsystem architecture, process management, JSONL fast path, and core invariants.
- [`api-reference.md`](./docs/api-reference.md) — Complete OpenCode HTTP and SSE endpoint reference with request/response schemas.
- [`providers.md`](./docs/providers.md) — Multi-backend adapter contract: `AgentBackend`/`SessionStore` interfaces, session-id codec, model-picker routing, and capability gating.
- [`omp-protocol.md`](./docs/omp-protocol.md) — oh-my-pi stdio NDJSON RPC protocol, commands, turn events, and disk schemas.
- [`openchamber-contract.md`](./docs/openchamber-contract.md) — OpenChamber SSE stream lifecycle, message/part schemas, and UI reducer contracts.

The sidecar's backend layer is pluggable (`src/providers/`): omp is the
default backend, and additional agent backends plug in through the
`AgentBackend` adapter contract without changing the OpenCode HTTP/SSE
surface. A fake backend ships for tests — set `OC_FAKE_BACKEND=1` to register
it (see [`docs/providers.md`](./docs/providers.md)).
