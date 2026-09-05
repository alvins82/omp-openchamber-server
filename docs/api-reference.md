# API Reference

`omp-openchamber-server` exposes an OpenCode-compatible HTTP and Server-Sent Events (SSE) API on port `4096` (configurable via `OC_SIDECAR_PORT`).

---

## Health & System

### `GET /health` · `GET /global/health`
Returns proxy health status.

**Response `200 OK`**:
```json
{
  "healthy": true,
  "status": "ok"
}
```

### `GET /path`
Returns resolved path information for the given directory.

- **Query Parameters**: `directory` (string, optional)
- **Response `200 OK`**:
```json
{
  "home": "/Users/username",
  "state": "/Users/username/.omp",
  "config": "/Users/username/.omp",
  "worktree": "/path/to/project",
  "directory": "/path/to/project"
}
```

### `GET /project`
Returns active project workspace metadata.

- **Query Parameters**: `directory` (string, optional)
- **Response `200 OK`**:
```json
{
  "id": "proj_default",
  "worktree": "/path/to/project",
  "directory": "/path/to/project",
  "time": {
    "created": 1756000000000,
    "updated": 1756000000000
  }
}
```

---

## Sessions

### `GET /session` · `GET /experimental/session`
Lists sessions available in the specified directory or across all roots.

- **Query Parameters**:
  - `directory` (string, optional): Filter by workspace directory.
  - `roots` (boolean, optional): Return all sessions across all workspaces.
- **Response `200 OK`**:
```json
[
  {
    "id": "ses_019f65f9fa217000892db00212c6d038",
    "title": "Build authentication flow",
    "directory": "/path/to/project",
    "path": {
      "root": "/path/to/project",
      "cwd": "/path/to/project"
    },
    "cost": 0,
    "tokens": {
      "input": 0,
      "output": 0,
      "reasoning": 0,
      "cache": { "read": 0, "write": 0 }
    },
    "time": {
      "created": 1756000000000,
      "updated": 1756001000000
    }
  }
]
```

### `POST /session`
Creates a new session in the specified directory.

- **Request Body**:
```json
{
  "directory": "/path/to/project",
  "title": "Optional session title"
}
```
- **Response `201 Created`**: Returns the newly created `Session` object.

### `GET /session/:id`
Retrieves metadata for a specific session.

- **Response `200 OK`**: Returns the `Session` object.
- **Response `404 Not Found`**: If session does not exist.

### `PATCH /session/:id`
Updates session metadata (e.g. title).

- **Request Body**:
```json
{
  "title": "New Session Title"
}
```
- **Response `200 OK`**: Returns the updated `Session` object.

### `DELETE /session/:id`
Deletes the session and its transcript JSONL file.

- **Response `200 OK`**: `true`

### `GET /session/status`
Returns the execution status (`busy` / `idle`) for all active sessions.

- **Response `200 OK`**:
```json
{
  "ses_019f65f9fa217000892db00212c6d038": {
    "type": "busy"
  }
}
```

---

## Messages & Prompts

### `GET /session/:id/message`
Fetches all messages for a session via direct JSONL read (fast path).

- **Response `200 OK`**:
```json
[
  {
    "info": {
      "id": "msg_ses_123_0",
      "role": "user",
      "sessionID": "ses_019f65f9fa217000892db00212c6d038",
      "agent": "omp",
      "model": {
        "providerID": "llama.cpp",
        "modelID": "qwen3.8-27b",
        "variant": "default"
      },
      "time": {
        "created": 1756000000000,
        "completed": 1756000000000
      }
    },
    "parts": [
      {
        "id": "part_ses_123_0_0",
        "sessionID": "ses_019f65f9fa217000892db00212c6d038",
        "messageID": "msg_ses_123_0",
        "type": "text",
        "text": "Please summarize the codebase"
      }
    ]
  }
]
```

### `POST /session/:id/prompt_async`
Enqueues a turn prompt to the OMP child process.

- **Request Body**:
```json
{
  "parts": [
    {
      "type": "text",
      "text": "Write a unit test for main.ts"
    }
  ],
  "model": {
    "providerID": "llama.cpp",
    "modelID": "qwen3.8-27b"
  }
}
```
- **Response `200 OK`**: `{"queued": true}`
- **Response `409 Conflict`**: `{"error": "session busy"}` (if a turn is already executing on this session).

### `POST /session/:id/abort`
Interrupts active model generation on the session child process.

- **Response `200 OK`**: `true`

---

## Model Providers & Configuration

### `GET /config/providers`
Queries the OMP model catalog and formats it for OpenChamber.

- **Response `200 OK`**:
```json
{
  "providers": [
    {
      "id": "llama.cpp",
      "name": "llama.cpp",
      "models": {
        "qwen3.8-27b": {
          "id": "qwen3.8-27b",
          "providerID": "llama.cpp",
          "name": "Qwen 3.8 27B",
          "capabilities": { "temperature": true, "reasoning": true },
          "limit": { "context": 131072, "output": 32768 }
        }
      }
    }
  ],
  "default": {
    "providerID": "llama.cpp",
    "modelID": "qwen3.8-27b"
  }
}
```

### `GET /config` · `GET /global/config`
Returns current configuration objects.

---

## Real-Time Events (SSE)

### `GET /events` · `GET /global/event` · `GET /event`
Opens an SSE stream emitting real-time turn deltas and status updates.

- **Envelope Format**: Data-only frames with top-level `type` or nested `payload`:
```text
data: {"type":"server.connected","properties":{}}

data: {"payload":{"id":"evt_01","type":"session.status","properties":{"sessionID":"ses_123","status":{"type":"busy"}}}}

data: {"payload":{"id":"evt_02","type":"message.part.delta","properties":{"sessionID":"ses_123","messageID":"msg_123_1","partID":"part_123_1_0","delta":"Hello"}}}

data: {"payload":{"id":"evt_03","type":"session.status","properties":{"sessionID":"ses_123","status":{"type":"idle"}}}}
```

---

## Approvals & Stubs

| Endpoint | Method | Behavior |
|---|---|---|
| `/permission` | `GET` | Returns pending tool permission requests. |
| `/permission/:id/reply` | `POST` | Confirms or rejects tool permission requests. |
| `/question` | `GET` | Returns pending interactive user questions. |
| `/question/:id/reply` | `POST` | Submits answers to interactive questions. |
| `/agent` | `GET` | Returns available agent personas (`[]` default). |
| `/command` | `GET` | Returns available slash commands. |
| `/skill` | `GET` | Returns registered agent skills. |
| `/mcp` | `GET` | Returns MCP server status map (`{}`). |
| `/api/small-model` | `GET` | Reports resolved small model and callable providers allow-list for OpenChamber. |
| `/api/small-model/generate` | `POST` | Executes one-shot text generation with the resolved small model (for live turn progress summaries, commit messages, etc.). |
