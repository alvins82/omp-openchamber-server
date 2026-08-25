/**
 * Tier A1 — unit tests for the session-file message fast path
 * (`loadMessagesFromFile`), the mechanism that serves `GET /session/:id/message`
 * without spawning an OMP child (the no-churn fix from the Phase 0
 * postmortems). Fixtures use the exact on-disk shapes captured from real
 * `~/.omp/agent/sessions` files.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadMessagesFromFile, type OpenCodeTextPart } from "./messages";

const SID = "01234567-89ab-cdef-0123-456789abcdef";
const TMP = mkdtempSync(join(tmpdir(), "msgfile-test-"));

function fileFor(name: string, lines: unknown[]): string {
  const path = join(TMP, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

const userMsg = (id: string, text: string, ts = 1755927600000) => ({
  type: "message", id, timestamp: new Date(ts).toISOString(),
  message: { id, role: "user", content: text, timestamp: ts },
});

const asstMsg = (id: string, content: unknown[], ts = 1755927605000) => ({
  type: "message", id, timestamp: new Date(ts).toISOString(),
  message: { id, role: "assistant", content, provider: "sidevllm", model: "qwen", stopReason: "stop", timestamp: ts },
});

describe("loadMessagesFromFile — Tier A1 session-file fast path", () => {
  it("returns null when the file does not exist", async () => {
    expect(await loadMessagesFromFile(join(TMP, "does-not-exist.jsonl"), SID)).toBeNull();
  });

  it("returns null for an empty or blank file", async () => {
    expect(await loadMessagesFromFile(fileFor("empty.jsonl", []), SID)).toBeNull();
    writeFileSync(join(TMP, "blank.jsonl"), "\n\n");
    expect(await loadMessagesFromFile(join(TMP, "blank.jsonl"), SID)).toBeNull();
  });

  it("returns null when the file holds only non-message entries", async () => {
    const path = fileFor("meta-only.jsonl", [
      { type: "session", id: SID, title: "t" },
      { type: "title", title: "t" },
      { type: "model_change", modelID: "qwen", providerID: "sidevllm" },
      { type: "thinking_level_change", level: "default" },
      { type: "session_exit", status: 143, timestamp: "2026-08-23T00:00:00.000Z" },
    ]);
    expect(await loadMessagesFromFile(path, SID)).toBeNull();
  });
  it("maps user and assistant messages in file order", async () => {
    const path = fileFor("basic.jsonl", [
      { type: "session", id: SID, title: "t" },
      userMsg("m1", "hello", 1755927600000),
      asstMsg("m2", [{ type: "text", text: "hi there" }], 1755927605000),
    ]);
    const out = await loadMessagesFromFile(path, SID);
    expect(out).toHaveLength(2);
    expect(out![0].info.sessionID).toBe(SID);
    expect(out![0].info.id).toBe("msg_" + SID + "_m1");
    expect(out![0].info.role).toBe("user");
    expect(out![0].info.time.created).toBe(1755927600000);
    const t1 = out![0].parts[0] as { type: string; text?: string };
    expect(t1.type).toBe("text");
    expect(t1.text).toBe("hello");
    expect(out![1].info.id).toBe("msg_" + SID + "_m2");
    expect(out![1].info.role).toBe("assistant");
    expect(out![1].info.finish).toBe("stop");
    expect(out![1].info.time.completed).toBe(1755927605000);
    expect(out![1].info.model).toEqual({ id: "qwen", providerID: "sidevllm", modelID: "qwen", variant: "default" });
    expect(out![1].parts[0].type).toBe("text");
  });

  it("derives record id and timestamp from the entry when the inner message lacks them", async () => {
    const path = fileFor("derived.jsonl", [
      { type: "message", id: "e1", timestamp: "2026-08-23T02:00:00.000Z",
        message: { role: "user", content: "x" } },
    ]);
    const out = await loadMessagesFromFile(path, SID);
    expect(out).toHaveLength(1);
    expect(out![0].info.id).toBe("msg_" + SID + "_e1");
    expect(out![0].info.time.created).toBe(Date.parse("2026-08-23T02:00:00.000Z"));
  });

  it("coalesces a tool call with its tool result into one completed tool part", async () => {
    const path = fileFor("tool.jsonl", [
      asstMsg("m3", [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }]),
      { type: "message", id: "m4", timestamp: "2026-08-23T01:00:06.000Z",
        message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: "a.txt", timestamp: 1755927606000 } },
    ]);
    const out = await loadMessagesFromFile(path, SID);
    expect(out).toHaveLength(1);
    expect(out![0].info.role).toBe("assistant");
    expect(out![0].parts).toHaveLength(1);
    const part = out![0].parts[0] as { type: string; tool: string; callID?: string; metadata?: { toolCallId?: string }; state: { status: string; output?: string } };
    expect(part.type).toBe("tool");
    expect(part.callID).toBe("call_1");
    expect(part.tool).toBe("bash");
    expect(part.metadata?.toolCallId).toBe("call_1");
    expect(part.state.status).toBe("completed");
    expect(part.state.output).toBe("a.txt");
  });

  it("maps an isError tool result to an error part state", async () => {
    const path = fileFor("tool-error" + ".js" + "nl", [
      asstMsg("m5", [
        { type: "toolCall", id: "call_2", name: "Bash",
          arguments: { command: "x" } },
      ]),
      {
        type: "message", id: "m6",
        message: {
          role: "toolResult", toolCallId: "call_2",
          toolName: "Bash", content: "boom",
          isError: true, timestamp: 1755927607000,
        },
      },
    ]);
    const out = await loadMessagesFromFile(path, SID);
    const part = out![0].parts[0] as {
      state: { status: string; error?: string };
    };
    expect(part.state.status).toBe("error");
    expect(part.state.error).toBe("boom");
  });

  it("thinking maps to reasoning parts, in order", async () => {
    const path = fileFor("thinking file", [
      {
        type: "message", id: "m7",
        timestamp: "2026-08-23T01:00:09.000Z",
        message: {
          role: "assistant", provider: "sidevllm", model: "qwen",
          stopReason: "stop", timestamp: 1755927609000,
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "final" },
          ],
        },
      },
    ]);
    const out = await loadMessagesFromFile(path, SID);
    expect(out![0].parts.map((x) => x.type)).toEqual([
      "reasoning", "text",
    ]);
    expect((out![0].parts[0] as OpenCodeTextPart).time).toEqual({
      start: 1755927609000,
      end: 1755927609000,
    });
    expect((out![0].parts[1] as OpenCodeTextPart).time).toEqual({
      start: 1755927609000,
      end: 1755927609000,
    });
  });

  it("skips a truncated final line instead of throwing", async () => {
    const path = join(TMP, "truncated" + ".js" + "nl");
    writeFileSync(
      path,
      JSON.stringify(userMsg("m8", "ok")) + "\n" +
      '{' + '"type":"message","id":"m9","me' + "\n",
    );
    const out = await loadMessagesFromFile(path, SID);
    expect(out).toHaveLength(1);
    expect(out![0].info.id).toBe("msg_" + SID + "_m8");
  });

  it("empty assistant content yields an (empty) text part", async () => {
    const path = fileFor("failturn" + ".js" + "nl", [
      userMsg("m10", "do it"),
      asstMsg("m11", []),
    ]);
    const out = await loadMessagesFromFile(path, SID);
    expect(out).toHaveLength(2);
    expect(out![1].info.finish).toBe("stop");
    expect(out![1].parts).toHaveLength(1);
const p1 = out![1].parts[0] as { type: string; text?: string };
expect(p1.type).toBe("text");
expect(p1.text).toBe("(empty)");
    
  });

  it("ignores message-type entries without an inner message", async () => {
    const path = fileFor("orphan" + ".js" + "nl", [
      { type: "message", id: "orphan" },
    ]);
    expect(await loadMessagesFromFile(path, SID)).toBeNull();
  });

  it("preserves historical user message IDs and only maps matching/latest prompt ID", async () => {
    const { recordUserMessageId } = await import("./messages");
    recordUserMessageId(SID, "Am i in live view?", "msg_optimistic_live_view");

    const path = fileFor("multiturn.jsonl", [
      userMsg("u1", "hi", 1755927600000),
      asstMsg("a1", [{ type: "text", text: "Hey" }], 1755927602000),
      userMsg("u2", "whats the go", 1755927610000),
      asstMsg("a2", [{ type: "text", text: "Working on it" }], 1755927615000),
      userMsg("u3", "Am i in live view?", 1755927620000),
      asstMsg("a3", [{ type: "text", text: "Yes, you are." }], 1755927625000),
    ]);

    const out = await loadMessagesFromFile(path, SID);
    expect(out).toHaveLength(6);
    expect(out![0].info.id).toBe("msg_" + SID + "_u1");
    expect(out![0].info.role).toBe("user");
    expect(out![2].info.id).toBe("msg_" + SID + "_u2");
    expect(out![2].info.role).toBe("user");
    expect(out![4].info.id).toBe("msg_optimistic_live_view");
    expect(out![4].info.role).toBe("user");
  });
});
