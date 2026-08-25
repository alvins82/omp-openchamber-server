import { describe, it, expect } from "bun:test";
import { reduceToolPartState, type ToolPartState } from "./prompt";

describe("reduceToolPartState", () => {
  it("tool_execution_start sets status to running and captures input and time.start", () => {
    const state = reduceToolPartState(
      undefined,
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        name: "read",
        arguments: { path: "test.txt" },
      },
      1000,
    );

    expect(state.status).toBe("running");
    expect(state.input).toEqual({ path: "test.txt" });
    expect(state.time).toEqual({ start: 1000 });
  });

  it("tool_execution_update appends output while status remains running", () => {
    const current: ToolPartState = {
      status: "running",
      input: { path: "test.txt" },
      time: { start: 1000 },
    };

    const state = reduceToolPartState(
      current,
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        output: "line 1\nline 2",
      },
      2000,
    );

    expect(state.status).toBe("running");
    expect(state.output).toBe("line 1\nline 2");
    expect(state.time).toEqual({ start: 1000 });
  });

  it("tool_execution_end finalizes status to completed with output and time.end", () => {
    const current: ToolPartState = {
      status: "running",
      input: { path: "test.txt" },
      time: { start: 1000 },
    };

    const state = reduceToolPartState(
      current,
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        output: "final content",
      },
      2000,
    );

    expect(state.status).toBe("completed");
    expect(state.output).toBe("final content");
    expect(state.time).toEqual({ start: 1000, end: 2000 });
  });

  it("tool_execution_end with error marks status error and records error + time.end", () => {
    const current: ToolPartState = {
      status: "running",
      input: { path: "missing.txt" },
      time: { start: 1000 },
    };

    const state = reduceToolPartState(
      current,
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        isError: true,
        error: "file not found",
      },
      2000,
    );

    expect(state.status).toBe("error");
    expect(state.error).toBe("file not found");
    expect(state.time).toEqual({ start: 1000, end: 2000 });
  });

  it("toolcall_start initializes a pending tool part with input and time.start", () => {
    const state = reduceToolPartState(
      undefined,
      {
        type: "toolcall_start",
        id: "call-1",
        name: "read",
        arguments: { path: "test.txt" },
      },
      1000,
    );

    expect(state.status).toBe("pending");
    expect(state.input).toEqual({ path: "test.txt" });
    expect(state.time).toEqual({ start: 1000 });
  });

  it("extracts intent/i as description and parses nested toolCall arguments", () => {
    const state = reduceToolPartState(
      undefined,
      {
        type: "toolcall_end",
        toolCall: {
          id: "call-2",
          name: "read",
          arguments: { path: "README.md", i: "Reading README" },
        },
      },
      1000,
    );

    expect(state.input).toEqual({
      path: "README.md",
      description: "Reading README",
    });
  });

  it("handles custom tool_execution_start events from OMP RPC", () => {
    const state = reduceToolPartState(
      undefined,
      {
        customType: "tool_execution_start",
        data: {
          toolCallId: "chatcmpl-tool-123",
          toolName: "read",
          args: { path: "/path/to/dir" },
          intent: "Listing directory",
        },
      },
      1000,
    );

    expect(state.status).toBe("running");
    expect(state.input).toEqual({
      path: "/path/to/dir",
      description: "Listing directory",
    });
    expect(state.time).toEqual({ start: 1000 });
  });

  it("tool_execution_end with partial and contentIndex does not leak RPC envelope into input", () => {
    const current: ToolPartState = {
      status: "running",
      input: { task: "Unblock commit 2 task" },
      time: { start: 1000 },
    };

    const state = reduceToolPartState(
      current,
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "todo",
        contentIndex: 4,
        partial: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "User's response:\n1. Attribution...",
            },
          ],
        },
        result: [
          {
            type: "text",
            text: "Remaining items (2): - Commit 1: Rust + docs",
          },
        ],
      },
      2000,
    );

    expect(state.status).toBe("completed");
    expect(state.input).toEqual({ task: "Unblock commit 2 task" });
    expect(state.output).toBe("Remaining items (2): - Commit 1: Rust + docs");
    expect(state.time).toEqual({ start: 1000, end: 2000 });
  });

  it("unboxes array of content blocks into concatenated text output", () => {
    const current: ToolPartState = {
      status: "running",
      input: { command: "summary" },
      time: { start: 1000 },
    };

    const state = reduceToolPartState(
      current,
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        output: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
      2000,
    );

    expect(state.status).toBe("completed");
    expect(state.output).toBe("Part 1\nPart 2");
  });

  it("preserves structured OpenCode Todo item arrays as JSON for UI renderers", () => {
    const todos = [
      { id: "1", content: "Write tests", status: "in_progress", priority: "high" },
      { id: "2", content: "Submit PR", status: "pending", priority: "medium" },
    ];

    const current: ToolPartState = {
      status: "running",
      input: { action: "list" },
      time: { start: 1000 },
    };

    const state = reduceToolPartState(
      current,
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        result: todos,
      },
      2000,
    );

    expect(state.status).toBe("completed");
    expect(JSON.parse(state.output!)).toEqual(todos);
  });

  it("extracts error detail from content block array when isError is set", () => {
    const current: ToolPartState = {
      status: "running",
      input: { path: "invalid.json" },
      time: { start: 1000 },
    };

    const state = reduceToolPartState(
      current,
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        isError: true,
        result: [{ type: "text", text: "SyntaxError: Unexpected token" }],
      },
      2000,
    );

    expect(state.status).toBe("error");
    expect(state.error).toBe("SyntaxError: Unexpected token");
  });

  it("normalizes glob tool inputs by splitting path and pattern and removing metadata", () => {
    const state = reduceToolPartState(
      undefined,
      {
        type: "tool_execution_start",
        toolCallId: "call-glob-1",
        name: "glob",
        arguments: {
          path: "/Users/alvin/claude-cowork/hangar/**",
          l: "Finding existing files in hangar",
          description: "Finding existing files in hangar",
        },
      },
      1000,
      "glob",
    );

    expect(state.status).toBe("running");
    expect(state.input).toEqual({
      path: "/Users/alvin/claude-cowork/hangar",
      pattern: "**",
    });
  });

  it("normalizes glob tool 'No files found matching pattern' output to empty string", () => {
    const current: ToolPartState = {
      status: "running",
      input: { path: "/Users/alvin/claude-cowork/hangar", pattern: "**" },
      time: { start: 1000 },
    };

    const state = reduceToolPartState(
      current,
      {
        type: "tool_execution_end",
        toolCallId: "call-glob-1",
        output: "No files found matching pattern",
      },
      2000,
      "glob",
    );

    expect(state.status).toBe("completed");
    expect(state.output).toBe("");
  });
});


