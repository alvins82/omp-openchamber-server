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
      i: "Reading README",
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
});

