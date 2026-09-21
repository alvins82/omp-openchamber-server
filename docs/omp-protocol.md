# oh-my-pi (omp) RPC Protocol Reference

This document outlines the standard I/O RPC protocol spoken by `oh-my-pi` (`omp`) and how `omp-openchamber-server` interacts with it.

---

## 1. Process Invocation & Transport

OMP is invoked as a subprocess in RPC mode:
```bash
omp --mode rpc --cwd <directory> --no-title --no-pty
```

- **Transport**: Newline-delimited JSON (NDJSON) over standard `stdin` / `stdout`.
- **Command Framing**: The host writes JSON commands to `stdin` ending with `\n`.
- **Response / Event Framing**: OMP writes responses and asynchronous events to `stdout` ending with `\n`.

### Subprocess Lifecycle & Resilience
- **Process Groups**: The subprocess is launched detached in its own process group (`setpgid`). On termination, the entire process tree (including any spawned language servers or tools) is sent `SIGTERM`.
- **Readiness Probing**: Rather than waiting for the optional `ready` frame (which can be delayed by project LSP or update checks), the server sends a `get_state` probe immediately and marks the process ready upon the first valid response frame.
- **Environment Overlays**:
  - `PI_SKIP_VERSION_CHECK=1`: Disables startup network update checks.
  - `--config {"mcp":{"enableProjectConfig":false}}`: Prevents third-party project MCP server hangs on embedded helper instances.

The sidecar separately checks the latest stable OMP release after startup and every four hours. This check only reports availability; updating remains a deliberate pin change so active OMP sessions are not replaced underneath the server. After `ompVersion` is bumped in `package.json`, the next sidecar startup automatically stages that exact version.

---

## 2. Core RPC Commands

Commands sent to OMP `stdin` take the shape `{"type": "<command>", "id": "<correlationId>", ...}`.

| Command | Arguments | Description |
|---|---|---|
| `get_state` | `{}` | Returns full agent state, current model, thinking level, and tool definitions. |
| `get_available_models` | `{}` | Returns the configured provider catalog and available models. |
| `prompt` | `{"prompt": string, "streamingBehavior": "steer"\|"followUp"}` | Enqueues a turn prompt. Returns acknowledgment immediately; streaming chunks arrive as events. |
| `set_model` | `{"provider": string, "model": string}` | Switches the active model. |
| `set_thinking_level` | `{"level": "off"\|"low"\|"medium"\|"high"}` | Configures model reasoning intensity. |
| `switch_session` | `{"sessionPath": string}` | Switches the active session to the given JSONL transcript path. |
| `new_session` | `{"parentSession"?: string}` | Starts a new session or forks from a parent session. |
| `abort` | `{}` | Requests immediate interruption of active turn generation. |

The Jarvis adapter starts its OMP child with `--no-tools --no-extensions`.
These are separate spawn options used only by `src/adapters/jarvis`; the
existing OpenChamber adapter keeps OMP's normal native tools and extensions.

### Host tools (Jarvis adapter)

The RPC protocol supports a bidirectional host-tool bridge:

| Frame | Direction | Purpose |
|---|---|---|
| `set_host_tools` | sidecar → OMP | Replaces the explicit tool definitions visible to the OMP session. |
| `host_tool_call` | OMP → sidecar | Requests Jarvis to execute a capability; includes `id`, `toolCallId`, `toolName`, and `arguments`. |
| `host_tool_update` | sidecar → OMP | Streams a partial `AgentToolResult` while a capability is running. |
| `host_tool_result` | sidecar → OMP | Completes the request using the original provider request `id`. |
| `host_tool_cancel` | OMP → sidecar | Notifies the host that a pending call was cancelled. |

The sidecar does not execute a host tool. It records the pending provider
request, publishes a Jarvis `tool_call_proposed` event, and waits for Jarvisbot
to authorize and execute the capability.

---

## 3. Event Vocabulary

During turn execution, OMP emits event frames on `stdout`:

### Streaming Turns (`message_update`)
Turn text and reasoning are delivered inside nested `assistantMessageEvent` payloads:
- `text_start` / `text_delta` / `text_end`: Incremental output text chunks.
- `thinking_start` / `thinking_delta` / `thinking_end`: Extended reasoning / thinking blocks.
- `toolcall_start` / `toolcall_delta` / `toolcall_end`: In-flight tool invocation parameters.

### Tool Execution
- `tool_execution_start`: Emitted when a tool begins execution (`{toolCallId, name, input}`).
- `tool_execution_update`: Periodic progress updates during long-running tool calls.
- `tool_execution_end`: Emitted when execution concludes (`{toolCallId, output, isError}`).

### Turn Lifecycle
- `agent_start`: Agent turn initiated.
- `agent_end`: Turn execution finished (`{isTerminal: boolean, messages: [...]}`).
- `prompt_result`: Final result frame echoing `agentInvoked` status.

---

## 4. Session Disk Schema

OMP stores session transcripts under:
```
~/.omp/agent/sessions/<cwd-slug>/<timestamp>_<uuidv7>.jsonl
```

- **Path Slug**: The working directory path converted to a slug (e.g. `/Users/dev/my-project` → `-Users-dev-my-project`).
- **File Format**: Append-only (or state-rewritten) JSON Lines.
- **Header Line**: The first line contains a `type: "session"` metadata object:
  ```json
  {"type":"session","id":"019f65f9-fa21-7000-892d-b00212c6d038","cwd":"/path/to/project","timestamp":"2026-08-24T12:00:00.000Z","version":1}
  ```
- **Entry Lines**: Each subsequent line contains a turn entry (`message`, `user`, `assistant`, `custom`) chained via `parentId`.
- **Title Slot**: A fixed 256-byte header slot is maintained for session title updates.
