#!/usr/bin/env bun
// Mock `omp --mode rpc` child for the sidecar route-level test suite.
//
// Speaks the same NDJSON RPC protocol as real OMP 17.3.5:
//   stdin : {id, type, ...params}\n
//   stdout: {"type":"ready"} first, then {"id","type":"response","success",
//            "data"|"error"} responses and typed event frames
//            (message_update / agent_end / tool_execution_*).
//
// The turn scenario is chosen from the prompt message text:
//   contains "MOCKFAIL"   -> provider failure: respond success, NO events
//                             (mirrors OMP 17.3.5 bedrock-403: the turn ends
//                             via the completion path alone, the stream sees
//                             busy -> idle with zero message frames; P11)
//   contains "MOCKRPCERR" -> respond success:false with an error object
//                             (transport-level RPC failure path)
//   contains "MOCKLONG"   -> emit one text delta, respond, then complete
//                             after a delay (busy window for 409/abort tests)
//   otherwise             -> normal turn: text deltas, one tool execution
//                             sequence, then agent_end
//
// Fidelity notes from phase 0:
//   - On SIGTERM (what OmpRpcConnection.kill() sends) the mock appends a
//     synthetic {"type":"custom","customType":"session_exit"} record to the
//     last switch_session'd file, mirroring OMP's postmortem write. This is
//     the exact churn the messages.ts file fast-path eliminates, so route
//     tests catch any regression that re-spawns a child for reads.
//   - Every spawn appends one line to $MOCK_OMP_SPAWN_LOG so tests can
//     assert whether (and how often) a child was spawned.
//
// Set MOCK_OMP_CHURN=0 to disable session_exit appends.

import { appendFileSync } from "node:fs";

function argValue(flag) {
  const argv = process.argv.slice(1);
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const cwd = argValue("--cwd") ?? process.cwd();

if (process.env.MOCK_OMP_SPAWN_LOG) {
  try {
    appendFileSync(
      process.env.MOCK_OMP_SPAWN_LOG,
      `${new Date().toISOString()} cwd=${cwd} pid=${process.pid}\n`,
    );
  } catch {
    // logging must never break the mock
  }
}

const writeLine = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};

writeLine({ type: "ready" });

let currentSessionPath = undefined;
let inTurn = false;
let longTimer = undefined;
let dead = false;

function respond(id, data) {
  if (dead) return;
  writeLine({ id, type: "response", success: true, data });
}

function respondError(id, message) {
  if (dead) return;
  writeLine({ id, type: "response", success: false, error: { message } });
}

function textDelta(messageId, text) {
  writeLine({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", messageId, text },
  });
}

function runNormalTurn(id, message) {
  const messageId = "mock_msg_" + Date.now();
  writeLine({ type: "agent_start", session: "mock" });
  textDelta(messageId, "Hel");
  textDelta(messageId, "lo");
  writeLine({ type: "tool_execution_start", payload: { toolCallId: "mock_call_1", name: "bash", arguments: { command: "ls" } } });
  writeLine({ type: "tool_execution_update", payload: { toolCallId: "mock_call_1", output: "a.txt" } });
  writeLine({ type: "tool_execution_end", payload: { toolCallId: "mock_call_1", output: "a.txt" } });
  respond(id, {});
  writeLine({ type: "agent_end", session: "mock" });
  inTurn = false;
}

function runLongTurn(id) {
  const messageId = "mock_msg_" + Date.now();
  textDelta(messageId, "working");
  respond(id, {});
  longTimer = setTimeout(() => {
    if (dead) return;
    writeLine({ type: "agent_end", session: "mock" });
    inTurn = false;
  }, 1200);
}

function handleFrame(frame) {
  const { id, type } = frame;
  switch (type) {
    case "switch_session":
      currentSessionPath = typeof frame.sessionPath === "string" ? frame.sessionPath : undefined;
      respond(id, {});
      break;
    case "get_state":
      respond(id, { model: { provider: "sidevllm", id: "qwen", variant: "default" } });
      break;
    case "get_available_models":
      respond(id, [
        {
          provider: "sidevllm",
          id: "qwen",
          name: "Qwen (local)",
          contextWindow: 32768,
          maxTokens: 4096,
          supportsToolCall: true,
          supportsAttachment: false,
        },
        {
          provider: "bedrock",
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6 (bedrock)",
          contextWindow: 200000,
          maxTokens: 8192,
          supportsToolCall: true,
          supportsAttachment: false,
        },
      ]);
      break;
    case "set_model":
      respond(id, {});
      break;
    case "get_messages":
      respond(id, [
        { id: "mock_m1", role: "user", content: "seeded via rpc", timestamp: 1755930000000 },
        {
          id: "mock_m2",
          role: "assistant",
          content: [{ type: "text", text: "from-rpc" }],
          provider: "sidevllm",
          model: "qwen",
          stopReason: "stop",
          timestamp: 1755930005000,
        },
      ]);
      break;
    case "prompt": {
      const message = typeof frame.message === "string" ? frame.message : "";
      inTurn = true;
      if (message.includes("MOCKFAIL")) {
        // Silent provider failure: no events at all; the response alone lets
        // the caller proceed, the turn completes on the completion path.
        respond(id, { agentInvoked: false });
        writeLine({ type: "prompt_result", agentInvoked: false });
        inTurn = false;
      } else if (message.includes("MOCKRPCERR")) {
        respondError(id, "403 Forbidden (mock provider)");
        inTurn = false;
      } else if (message.includes("MOCKLONG")) {
        runLongTurn(id);
      } else {
        runNormalTurn(id, message);
      }
      break;
    }
    case "abort":
      respond(id, {});
      if (inTurn) {
        if (longTimer) clearTimeout(longTimer);
        writeLine({ type: "agent_end", session: "mock" });
        inTurn = false;
      }
      break;
    default:
      respond(id, {});
      break;
  }
}

function onTerm() {
  dead = true;
  if (longTimer) clearTimeout(longTimer);
  // Postmortem write, mirroring OMP's SIGTERM behavior (phase 0 finding).
  if (process.env.MOCK_OMP_CHURN !== "0" && currentSessionPath) {
    try {
      appendFileSync(
        currentSessionPath,
        `${JSON.stringify({ type: "custom", customType: "session_exit", provider: "sidevllm", model: "qwen" })}\n`,
      );
    } catch {
      // file may have been deleted between switch and kill
    }
  }
  process.exit(0);
}

process.on("SIGTERM", onTerm);
process.on("SIGHUP", onTerm);

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    handleFrame(frame);
  }
});
process.stdin.on("end", () => process.exit(0));
