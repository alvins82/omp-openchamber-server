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

### `GET /api/projects/:projectId/config`
Returns an empty OpenChamber project setup for a path-based project ID. The
OMP sidecar does not own OpenChamber project settings, so worktree setup
commands and project actions are not configured through this endpoint.

**Response `200 OK`** includes:

```json
{
  "trust": { "hash": null, "trusted": true },
  "setupWorktree": [],
  "setupWorktreeWait": false,
  "projectActions": [],
  "draftStarters": [],
  "shared": { "status": "missing" },
  "personal": { "setupWorktreeMode": "append" }
}
```

`PUT /api/projects/:projectId/config` and the `/shared` variant return
`501 Not Implemented` because the sidecar does not persist those settings.

## OpenChamber project context

The sidecar implements the OpenChamber-owned project context API so the UI can
connect directly to it. A project ID is the path-derived value
`path_<base64url(project path)>`.

### `GET /api/project-context/:projectId`

Returns the project's notes, todos, plans, and shared-plans directory. A
project with no saved context returns `200` with empty arrays.

The following routes use the same project ID:

- `PUT /todos` with `{ "todos": [...] }`
- `POST /notes` with `{ "body": "...", "source": "manual|selection|agent" }`
- `PATCH /notes/:noteId` with `{ "body": "..." }` and/or `{ "pinned": true }`
- `DELETE /notes/:noteId`
- `POST /plans` with `{ "title": "...", "body": "..." }`
- `PATCH /plans/:planId` with `{ "pinned": true }`
- `GET` and `PUT /plans/:planId` (`PUT` accepts `{ "raw": "..." }`)
- `DELETE /plans/:planId`
- `POST /plans/:planId/share` and `/unshare`

Context metadata is stored under
`$OPENCHAMBER_DATA_DIR/projects/:projectId/context.json`, with plan markdown in
the adjacent `plans/` directory. If `OPENCHAMBER_DATA_DIR` is unset, the
default is `~/.config/openchamber`. Writes use per-project serialization and
atomic replacement. The first read migrates legacy context keys from the
sibling `:projectId.json` file.

### Session knowledge

The sidecar also supports the UI's pinned-context lifecycle:

- `GET /api/session-knowledge?directory=:path&sessionId=:id`
- `GET /api/session-knowledge/summary?directory=:path&sessionId=:id`
- `POST /api/session-knowledge/pin`
- `POST /api/session-knowledge/delivered`

Pin state and delivery signatures are merged into the OpenCode session's
`metadata.openchamber` object. The sidecar does not inject text into OMP
prompts; the UI attaches the returned knowledge block as a synthetic prompt
part, matching the normal OpenChamber server path.

## Git

Git routes use the local `git` executable and accept the repository directory
through the `directory` query parameter. The sidecar supports the read and
write operations used by OpenChamber's Git view, including repository status,
branches, diffs, commits, remotes, pull/push/fetch, stashes, merge/rebase
conflict handling, identities, and worktrees.

### Repository state

`GET /api/git/check` returns `{ "isGitRepository": boolean }`.

`GET /api/git/status` returns the current branch, upstream, ahead/behind
counts, changed files, diff statistics, and in-progress merge or rebase
metadata. `GET /api/git/primary-root` and `GET /api/git/toplevel` return
`{ "root": "/path/to/repository" }`; the former resolves a linked worktree to
the primary repository.

`GET /api/git/branches` returns:

```json
{
  "all": ["main", "feature", "remotes/origin/main"],
  "current": "feature",
  "branches": {
    "feature": {
      "current": true,
      "name": "feature",
      "commit": "0123456789abcdef",
      "label": "feature",
      "tracking": "origin/feature",
      "ahead": 1,
      "behind": 0
    }
  },
  "defaultBranches": { "origin": "main" }
}
```

### Files, history, and worktrees

The following endpoints are available with the same request shapes as the
OpenChamber Git client:

- `GET /api/git/diff`, `/range-diff`, `/range-files`, `/file-diff`
- `GET /api/git/log`, `/commit-files`, `/commit-file-diff`
- `POST /api/git/stage`, `/unstage`, `/revert`, `/apply-hunk`, `/commit`
- `GET /api/git/worktrees`
- `POST /api/git/worktrees`, `/worktrees/validate`, `/worktrees/preview`,
  `/validate-directory`, `/canonicalize-worktree-state`
- `GET /api/git/worktrees/bootstrap-status` and `GET /api/git/worktree-type`
- `DELETE /api/git/worktrees`

Worktree creation returns `{ head, name, branch, path, bootstrapStatus }` and
places managed worktrees under
`$XDG_DATA_HOME/opencode/worktree/<project-id>` (or
`~/.local/share/opencode/worktree/<project-id>` by default). Worktree removal
refuses to remove the primary repository.

### Remotes, history mutations, and identities

`POST /api/git/pull`, `/push`, `/fetch`, `/rebase`, `/merge`,
`/rebase/continue`, and `/merge/continue` run the corresponding local Git
operation. Abort routes, checkout, cherry-pick, revert, reset, branch
creation/deletion/rename, remote management, stash operations, and
`GET /api/git/conflict-details` are also supported.

Git identity profiles are stored in the user's OpenChamber configuration:

- `GET/POST /api/git/identities`
- `PUT/DELETE /api/git/identities/:id`
- `GET /api/git/global-identity`, `/current-identity`,
  `/has-local-identity`, `/discover-credentials`
- `POST /api/git/set-identity`

Credentials are never returned; discovery reports only credential host and
username.

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
