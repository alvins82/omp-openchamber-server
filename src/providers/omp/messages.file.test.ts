/**
 * Tier A1 — unit tests for the session-file message fast path
 * (`loadMessagesFromFile`), the mechanism that serves `GET /session/:id/message`
 * without spawning an OMP child (the no-churn fix from the Phase 0
 * postmortems). Fixtures use the exact on-disk shapes captured from real
 * `~/.omp/agent/sessions` files.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadMessagesFromFile, clearRecordedUserMessagesMemoryCache } from "./messages";
import type { OpenCodeTextPart } from "../types";

const SID = "01234567-89ab-cdef-0123-456789abcdef";
const TMP = mkdtempSync(join(tmpdir(), "msgfile-test-"));
const TEST_DB = join(TMP, "history.db");

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
  beforeEach(() => {
    clearRecordedUserMessagesMemoryCache();
  });

  it("returns null when the file does not exist", async () => {
    expect(await loadMessagesFromFile(join(TMP, "does-not-exist.jsonl"), SID, TEST_DB)).toBeNull();
  });

  it("returns null for an empty or blank file", async () => {
    expect(await loadMessagesFromFile(fileFor("empty.jsonl", []), SID, TEST_DB)).toBeNull();
    writeFileSync(join(TMP, "blank.jsonl"), "\n\n");
    expect(await loadMessagesFromFile(join(TMP, "blank.jsonl"), SID, TEST_DB)).toBeNull();
  });

  it("returns null when the file holds only non-message entries", async () => {
    const path = fileFor("meta-only.jsonl", [
      { type: "session", id: SID, title: "t" },
      { type: "title", title: "t" },
      { type: "model_change", modelID: "qwen", providerID: "sidevllm" },
      { type: "thinking_level_change", level: "default" },
      { type: "session_exit", status: 143, timestamp: "2026-08-23T00:00:00.000Z" },
    ]);
    expect(await loadMessagesFromFile(path, SID, TEST_DB)).toBeNull();
  });
  it("maps user and assistant messages in file order", async () => {
    const path = fileFor("basic.jsonl", [
      { type: "session", id: SID, title: "t" },
      userMsg("m1", "hello", 1755927600000),
      asstMsg("m2", [{ type: "text", text: "hi there" }], 1755927605000),
    ]);
    const out = await loadMessagesFromFile(path, SID, TEST_DB);
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
    const out = await loadMessagesFromFile(path, SID, TEST_DB);
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
    const out = await loadMessagesFromFile(path, SID, TEST_DB);
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
    const out = await loadMessagesFromFile(path, SID, TEST_DB);
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
    const out = await loadMessagesFromFile(path, SID, TEST_DB);
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
    const out = await loadMessagesFromFile(path, SID, TEST_DB);
    expect(out).toHaveLength(1);
    expect(out![0].info.id).toBe("msg_" + SID + "_m8");
  });

  it("empty assistant content yields an (empty) text part", async () => {
    const path = fileFor("failturn" + ".js" + "nl", [
      userMsg("m10", "do it"),
      asstMsg("m11", []),
    ]);
    const out = await loadMessagesFromFile(path, SID, TEST_DB);
    expect(out).toHaveLength(2);
    expect(out![1].info.finish).toBe("stop");
    expect(out![1].parts).toHaveLength(1);
    const p1 = out![1].parts[0] as { type: string; text?: string };
    expect(p1.type).toBe("text");
    expect(p1.text).toBe("(empty)");
  });

  it("provider error assistant turn yields a visible error text part and info.error", async () => {
    const path = fileFor("provider_error.jsonl", [
      userMsg("u_err", "build hangar"),
      {
        type: "message",
        id: "a_err",
        parentId: "u_err",
        timestamp: "2026-08-26T22:32:08.382Z",
        message: {
          role: "assistant",
          content: [],
          provider: "vllm",
          model: "qwen3.8-27b",
          stopReason: "error",
          errorMessage: "400 At most 1 image(s) may be provided in one prompt.",
          errorStatus: 400,
          timestamp: 1755927608000,
        },
      },
    ]);
    const out = await loadMessagesFromFile(path, SID, TEST_DB);
    expect(out).toHaveLength(2);
    expect(out![1].info.finish).toBe("error");
    expect((out![1].info.error as { message: string })?.message).toBe("400 At most 1 image(s) may be provided in one prompt.");
    expect(out![1].parts).toHaveLength(1);
    const part = out![1].parts[0] as { type: string; text?: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("400 At most 1 image(s) may be provided in one prompt.");
  });

  it("ignores message-type entries without an inner message", async () => {
    const path = fileFor("orphan" + ".js" + "nl", [
      { type: "message", id: "orphan" },
    ]);
    expect(await loadMessagesFromFile(path, SID, TEST_DB)).toBeNull();
  });

  it("preserves historical user message IDs and only maps matching/latest prompt ID", async () => {
    const { recordUserMessageId } = await import("./messages");
    const multiSid = "01234567-89ab-cdef-0123-multiturn0001";
    recordUserMessageId(multiSid, "Am i in live view?", "msg_optimistic_live_view", TEST_DB);

    const path = fileFor("multiturn.jsonl", [
      userMsg("u1", "hi", 1755927600000),
      asstMsg("a1", [{ type: "text", text: "Hey" }], 1755927602000),
      userMsg("u2", "whats the go", 1755927610000),
      asstMsg("a2", [{ type: "text", text: "Working on it" }], 1755927615000),
      userMsg("u3", "Am i in live view?", 1755927620000),
      asstMsg("a3", [{ type: "text", text: "Yes, you are." }], 1755927625000),
    ]);

    const out = await loadMessagesFromFile(path, multiSid, TEST_DB);
    expect(out).toHaveLength(6);
    expect(out![0].info.id).toBe("msg_" + multiSid + "_u1");
    expect(out![0].info.role).toBe("user");
    expect(out![2].info.id).toBe("msg_" + multiSid + "_u2");
    expect(out![2].info.role).toBe("user");
    expect(out![4].info.id).toBe("msg_optimistic_live_view");
    expect(out![4].info.role).toBe("user");
  });

  it("persists client message IDs across complete in-memory cache clear (proxy restart simulation)", async () => {
    const {
      recordUserMessageId,
      clearRecordedUserMessagesMemoryCache,
    } = await import("./messages");
    const testDbPath = join(TMP, "test-history.db");
    const restartSid = "sess-restart-test-uuid";

    // Client sends "Go" with clientMessageId msg_019_go
    recordUserMessageId(restartSid, "Go", "msg_019_go", testDbPath);

    // Simulate proxy process shutdown & restart -> memory cache is wiped clean!
    clearRecordedUserMessagesMemoryCache();

    // Session JSONL on disk written by OMP with internal ID '32f41a56'
    const path = fileFor("restart-session.jsonl", [
      userMsg("32f41a56", "Go", 1787641974135),
      asstMsg("338e55b2", [{ type: "text", text: "Turn output here" }], 1787641975000),
    ]);

    // Reconnecting client calls loadMessagesFromFile
    const out = await loadMessagesFromFile(path, restartSid, testDbPath);
    expect(out).toHaveLength(2);

    // User message ID MUST be msg_019_go (the original client ID), NOT a fallback duplicate!
    expect(out![0].info.id).toBe("msg_019_go");
    expect(out![0].info.role).toBe("user");

    // Assistant message parentID MUST point to msg_019_go
    expect(out![1].info.parentID).toBe("msg_019_go");
    expect(out![1].info.role).toBe("assistant");
  });

  it("normalizes glob tool input and empty result when loading from file", async () => {
    const globSid = "sess-glob-test-uuid";
    const path = fileFor("glob-session.jsonl", [
      userMsg("u1", "Find files", 1755927600000),
      asstMsg("a1", [
        {
          type: "toolCall",
          id: "call_glob_1",
          name: "glob",
          arguments: {
            path: "/Users/alvin/claude-cowork/hangar/**",
            l: "Finding existing files in hangar",
            description: "Finding existing files in hangar",
          },
        },
      ], 1755927605000),
      {
        type: "message",
        id: "r1",
        timestamp: "2026-08-23T00:00:06.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call_glob_1",
          toolName: "glob",
          content: "No files found matching pattern",
          timestamp: 1755927606000,
        },
      },
    ]);

    const out = await loadMessagesFromFile(path, globSid, TEST_DB);
    expect(out).toHaveLength(2);
    const toolPart = out![1].parts[0] as { type: string; tool: string; state: { input: Record<string, unknown>; output: string; status: string } };
    expect(toolPart.type).toBe("tool");
    expect(toolPart.tool).toBe("glob");
    expect(toolPart.state.status).toBe("completed");
    expect(toolPart.state.input).toEqual({
      path: "/Users/alvin/claude-cowork/hangar",
      pattern: "**",
    });
    expect(toolPart.state.output).toBe("");
  });

  it("extracts token breakdown and cost from assistant messages with usage data", async () => {
    const tokenSid = "sess-tokens-test-uuid";
    const path = fileFor("tokens-session.jsonl", [
      userMsg("u1", "Please inspect code", 1755927600000),
      {
        type: "message",
        id: "a1",
        timestamp: "2026-08-23T00:00:05.000Z",
        message: {
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "Code looks good" }],
          provider: "llama.cpp",
          model: "Qwen3.8-27B",
          usage: {
            input: 19158,
            output: 262,
            cacheRead: 2500,
            cacheWrite: 100,
            reasoning: 50,
            totalTokens: 21970,
            cost: { input: 0.01, output: 0.02, total: 0.03 },
          },
          stopReason: "stop",
          timestamp: 1755927605000,
        },
      },
    ]);

    const out = await loadMessagesFromFile(path, tokenSid, TEST_DB);
    expect(out).toHaveLength(2);
    const asstInfo = out![1].info;
    expect(asstInfo.tokens).toEqual({
      input: 19158,
      output: 262,
      reasoning: 50,
      cache: {
        read: 2500,
        write: 100,
      },
    });
    expect(asstInfo.cost).toBe(0.03);

    // Verify OpenChamber context usage calculation
    const contextTokens = asstInfo.tokens!.input + asstInfo.tokens!.output + asstInfo.tokens!.reasoning + asstInfo.tokens!.cache.read + asstInfo.tokens!.cache.write;
    expect(contextTokens).toBe(22070);
    const contextLimit = 32768;
    const percent = (contextTokens / contextLimit) * 100;
    expect(percent).toBeCloseTo(67.35, 1);

    // Verify OpenChamber goal token accounting snapshot (input + cache.read + output)
    const goalSnapshotTokens = asstInfo.tokens!.input + asstInfo.tokens!.cache.read + asstInfo.tokens!.output;
    expect(goalSnapshotTokens).toBe(21920);
  });

  it("extracts token breakdown from vLLM assistant messages with prompt_tokens_details", async () => {
    const vllmSid = "sess-vllm-tokens-test-uuid";
    const path = fileFor("vllm-tokens-session.jsonl", [
      userMsg("u1", "Explain prefix caching", 1755927600000),
      {
        type: "message",
        id: "a1",
        timestamp: "2026-08-23T00:00:05.000Z",
        message: {
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "Prefix caching reuses KV states across turns." }],
          provider: "vllm",
          model: "qwen3.8-27b",
          usage: {
            prompt_tokens: 3026,
            completion_tokens: 10,
            prompt_tokens_details: {
              cached_tokens: 1920,
              created_cache_tokens: 0,
              multimodal_tokens: null,
            },
          },
          stopReason: "stop",
          timestamp: 1755927605000,
        },
      },
    ]);

    const out = await loadMessagesFromFile(path, vllmSid, TEST_DB);
    expect(out).toHaveLength(2);
    const asstInfo = out![1].info;
    expect(asstInfo.tokens).toEqual({
      input: 1106, // 3026 - 1920 - 0
      output: 10,
      reasoning: 0,
      cache: {
        read: 1920,
        write: 0,
      },
    });
  });

  it("collates multi-step assistant turns into a single assistant message with ordered parts", async () => {
    const multiStepSid = "sess-multistep-test-uuid";
    const path = fileFor("multistep-session.jsonl", [
      userMsg("u1", "Run autonomous audit", 1755927600000),
      {
        type: "message",
        id: "a1",
        timestamp: "2026-08-23T00:00:05.000Z",
        message: {
          id: "a1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Step 1: Check files" },
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
          ],
          provider: "llama.cpp",
          model: "Qwen3.8-27B",
          usage: { input: 1000, output: 50, reasoning: 30, cacheRead: 500, cacheWrite: 0 },
          stopReason: "toolUse",
          timestamp: 1755927605000,
        },
      },
      {
        type: "message",
        id: "tr1",
        timestamp: "2026-08-23T00:00:06.000Z",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          content: "file1.txt\nfile2.txt",
          timestamp: 1755927606000,
        },
      },
      {
        type: "message",
        id: "a2",
        timestamp: "2026-08-23T00:00:10.000Z",
        message: {
          id: "a2",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Step 2: Summarize" },
            { type: "text", text: "Audit complete. 2 files found." },
          ],
          provider: "llama.cpp",
          model: "Qwen3.8-27B",
          usage: { input: 1200, output: 80, reasoning: 40, cacheRead: 1000, cacheWrite: 0 },
          stopReason: "stop",
          timestamp: 1755927610000,
        },
      },
    ]);

    const out = await loadMessagesFromFile(path, multiStepSid, TEST_DB);
    expect(out).toHaveLength(2);

    // User message
    expect(out![0].info.role).toBe("user");

    // Unified Assistant Turn
    expect(out![1].info.role).toBe("assistant");
    expect(out![1].info.finish).toBe("stop");
    expect(out![1].info.tokens).toEqual({
      input: 1200,
      output: 80,
      reasoning: 40,
      cache: { read: 1000, write: 0 },
    });
    expect(out![1].parts).toHaveLength(4);
    expect(out![1].parts[0].type).toBe("reasoning");
    expect((out![1].parts[0] as any).text).toBe("Step 1: Check files");
    expect(out![1].parts[1].type).toBe("tool");
    expect((out![1].parts[1] as any).tool).toBe("bash");
    expect((out![1].parts[1] as any).state.status).toBe("completed");
    expect((out![1].parts[1] as any).state.output).toBe("file1.txt\nfile2.txt");
    expect(out![1].parts[2].type).toBe("reasoning");
    expect((out![1].parts[2] as any).text).toBe("Step 2: Summarize");
    expect(out![1].parts[3].type).toBe("text");
    expect((out![1].parts[3] as any).text).toBe("Audit complete. 2 files found.");
  });

  it("handles multi-turn conversations where each turn contains multiple assistant steps and tool calls", async () => {
    const multiTurnSid = "sess-multiturn-collation-uuid";
    const path = fileFor("multiturn-collation.jsonl", [
      // Turn 1: User prompt 1
      userMsg("u1", "Step 1 goal", 1755927600000),
      {
        type: "message",
        id: "a1_1",
        timestamp: "2026-08-23T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Checking directory" },
            { type: "toolCall", id: "call_read_1", name: "read", arguments: { path: "package.json" } },
          ],
          stopReason: "toolUse",
          usage: { input: 500, output: 20 },
          timestamp: 1755927601000,
        },
      },
      {
        type: "message",
        id: "tr1_1",
        timestamp: "2026-08-23T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call_read_1",
          toolName: "read",
          content: '{"name": "app"}',
          timestamp: 1755927602000,
        },
      },
      {
        type: "message",
        id: "a1_2",
        timestamp: "2026-08-23T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Found package.json for app." },
          ],
          stopReason: "stop",
          usage: { input: 600, output: 30 },
          cost: 0.005,
          timestamp: 1755927603000,
        },
      },
      // Turn 2: User prompt 2
      userMsg("u2", "Step 2 goal", 1755927610000),
      {
        type: "message",
        id: "a2_1",
        timestamp: "2026-08-23T00:00:11.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_write_1", name: "write", arguments: { path: "src/index.ts", content: "console.log(1);" } },
          ],
          stopReason: "toolUse",
          usage: { input: 800, output: 40 },
          timestamp: 1755927611000,
        },
      },
      {
        type: "message",
        id: "tr2_1",
        timestamp: "2026-08-23T00:00:12.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call_write_1",
          toolName: "write",
          content: "Successfully wrote 19 bytes to src/index.ts",
          timestamp: 1755927612000,
        },
      },
      {
        type: "message",
        id: "a2_2",
        timestamp: "2026-08-23T00:00:13.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Created index.ts." },
          ],
          stopReason: "stop",
          usage: { input: 950, output: 25 },
          cost: 0.008,
          timestamp: 1755927613000,
        },
      },
    ]);

    const out = await loadMessagesFromFile(path, multiTurnSid, TEST_DB);
    expect(out).toHaveLength(4);

    // Turn 1
    expect(out![0].info.role).toBe("user");
    expect(out![0].info.id).toBe("msg_" + multiTurnSid + "_u1");

    expect(out![1].info.role).toBe("assistant");
    expect(out![1].info.parentID).toBe(out![0].info.id);
    expect(out![1].info.finish).toBe("stop");
    expect(out![1].info.tokens?.input).toBe(600);
    expect(out![1].info.tokens?.output).toBe(30);
    expect(out![1].info.cost).toBe(0.005);
    expect(out![1].parts).toHaveLength(3);
    expect(out![1].parts[0].type).toBe("reasoning");
    expect(out![1].parts[1].type).toBe("tool");
    expect((out![1].parts[1] as any).state.status).toBe("completed");
    expect(out![1].parts[2].type).toBe("text");

    // Turn 2
    expect(out![2].info.role).toBe("user");
    expect(out![2].info.id).toBe("msg_" + multiTurnSid + "_u2");

    expect(out![3].info.role).toBe("assistant");
    expect(out![3].info.parentID).toBe(out![2].info.id);
    expect(out![3].info.finish).toBe("stop");
    expect(out![3].info.tokens?.input).toBe(950);
    expect(out![3].info.tokens?.output).toBe(25);
    expect(out![3].info.cost).toBe(0.008);
    expect(out![3].parts).toHaveLength(2);
    expect(out![3].parts[0].type).toBe("tool");
    expect((out![3].parts[0] as any).state.status).toBe("completed");
    expect(out![3].parts[1].type).toBe("text");
  });

  it("collates goal-mode continuations and hidden custom messages under the user turn", async () => {
    const goalSid = "sess-goal-mode-continuation-uuid";
    const path = fileFor("goal-mode-continuation.jsonl", [
      userMsg("u1", "Build entire application in goal mode", 1755927600000),
      {
        type: "message",
        id: "a1",
        timestamp: "2026-08-23T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Round 1: scaffold project" },
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm init -y" } },
          ],
          stopReason: "toolUse",
          usage: { input: 1000, output: 50 },
          timestamp: 1755927602000,
        },
      },
      {
        type: "message",
        id: "tr1",
        timestamp: "2026-08-23T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          content: "Wrote to package.json",
          timestamp: 1755927603000,
        },
      },
      // Hidden goal continuation message from OMP goal runner
      {
        type: "message",
        id: "gc1",
        timestamp: "2026-08-23T00:00:04.000Z",
        message: {
          role: "custom",
          customType: "goal-continuation",
          display: false,
          content: "Objective: Build entire application. Continue towards the objective.",
          timestamp: 1755927604000,
        },
      },
      {
        type: "message",
        id: "a2",
        timestamp: "2026-08-23T00:00:06.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Round 2: write source code" },
            { type: "toolCall", id: "c2", name: "write", arguments: { path: "main.js", content: "..." } },
          ],
          stopReason: "toolUse",
          usage: { input: 1500, output: 80 },
          timestamp: 1755927606000,
        },
      },
      {
        type: "message",
        id: "tr2",
        timestamp: "2026-08-23T00:00:07.000Z",
        message: {
          role: "toolResult",
          toolCallId: "c2",
          toolName: "write",
          content: "Wrote 20 bytes",
          timestamp: 1755927607000,
        },
      },
      // Goal completed final turn
      {
        type: "message",
        id: "a3",
        timestamp: "2026-08-23T00:00:09.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Goal complete: application built and verified." },
          ],
          stopReason: "stop",
          usage: { input: 2000, output: 40 },
          cost: 0.015,
          timestamp: 1755927609000,
        },
      },
    ]);

    const out = await loadMessagesFromFile(path, goalSid, TEST_DB);
    expect(out).toHaveLength(2);

    expect(out![0].info.role).toBe("user");
    expect(out![0].parts[0]).toMatchObject({ type: "text", text: "Build entire application in goal mode" });

    // Single unified assistant message containing all 3 rounds of the goal run
    expect(out![1].info.role).toBe("assistant");
    expect(out![1].info.finish).toBe("stop");
    expect(out![1].info.tokens?.input).toBe(2000);
    expect(out![1].info.tokens?.output).toBe(40);
    expect(out![1].info.cost).toBe(0.015);

    expect(out![1].parts).toHaveLength(5);
    expect(out![1].parts[0].type).toBe("reasoning");
    expect(out![1].parts[1].type).toBe("tool");
    expect((out![1].parts[1] as any).tool).toBe("bash");
    expect((out![1].parts[1] as any).state.status).toBe("completed");
    expect(out![1].parts[2].type).toBe("reasoning");
    expect(out![1].parts[3].type).toBe("tool");
    expect((out![1].parts[3] as any).tool).toBe("write");
    expect((out![1].parts[3] as any).state.status).toBe("completed");
    expect(out![1].parts[4].type).toBe("text");
    expect((out![1].parts[4] as any).text).toBe("Goal complete: application built and verified.");
  });
});

