# OpenChamber Client Contract

This document specifies the OpenCode HTTP/SSE API contract expected by OpenChamber (version 1.20.0+), including wire shapes, event pipelines, and reducer expectations.

---

## 1. Network Topology & Routing

OpenChamber connects to the server either directly or via its internal web proxy:

```
UI Client ──(HTTP/SSE with /api prefix)──▶ Web Server Proxy ──(Prefix Stripped)──▶ omp-openchamber-server
```

- **Prefix Stripping**: The web server proxy forwards `/api/session/...` to `/session/...`.
- **Directory Scoping**: Requests carry a `?directory=<absolute-path>` query parameter to identify the workspace.

---

## 2. Server-Sent Events (SSE) Contract

OpenChamber processes SSE streams through its client `resolveEventPayload` gate.

### Frame Encoding
Frames must be `data:`-only JSON envelopes:
```text
data: {"payload":{"id":"<eventId>","type":"<eventType>","properties":{...}}}
```
Or top-level typed objects:
```text
data: {"type":"<eventType>","properties":{...}}
```

### Event Lifecycle

1. **Connection**: The stream begins with a `server.connected` event:
   ```json
   { "type": "server.connected", "properties": {} }
   ```
2. **Heartbeat**: To prevent stream timeouts without dropping connections, the server emits periodic heartbeat events:
   ```json
   { "type": "server.heartbeat", "properties": {} }
   ```
3. **Turn Streaming**:
   - `session.status` (`busy`): Signals the session is processing.
   - `message.updated`: Creates the assistant message shell.
   - `message.part.updated`: Initializes a content part (text, reasoning, tool).
   - `message.part.delta`: Emits incremental streaming tokens.
   - `message.part.updated`: Finalizes the part with full content and completion timestamps.
   - `message.updated`: Finalizes the message (`finish: "stop"`).
   - `session.status` (`idle`): Signals turn completion and releases UI locks.

---

## 3. Message & Part Data Structures

### Message Envelope
Messages are represented as `{info, parts}` objects:
```typescript
interface MessageRecord {
  info: {
    id: string;             // msg_<sessionID>_<seq>
    role: "user" | "assistant";
    sessionID: string;      // ses_<32hex>
    parentID?: string;      // Preceding message ID
    finish?: "stop" | "error";
    agent: "omp";
    model: {
      providerID: string;
      modelID: string;
      variant?: string;
    };
    time: {
      created: number;
      completed?: number;
    };
  };
  parts: MessagePart[];
}
```

### Supported Part Types

1. **Text Part (`type: "text"`)**:
   ```json
   {
     "id": "part_ses_123_0_0",
     "sessionID": "ses_123",
     "messageID": "msg_123_0",
     "type": "text",
     "text": "Generated response content"
   }
   ```

2. **Reasoning Part (`type: "reasoning"`)**:
   ```json
   {
     "id": "part_ses_123_0_1",
     "sessionID": "ses_123",
     "messageID": "msg_123_0",
     "type": "reasoning",
     "text": "Internal reasoning tokens"
   }
   ```

3. **Tool Invocation Part (`type: "tool"`)**:
   ```json
   {
     "id": "part_ses_123_0_2",
     "sessionID": "ses_123",
     "messageID": "msg_123_0",
     "type": "tool",
     "callID": "call_abc123",
     "tool": "read",
     "state": {
       "status": "completed",
       "input": { "path": "src/main.ts" },
       "output": "file content...",
       "time": { "start": 1756000000000, "end": 1756000001000 }
     }
   }
   ```
