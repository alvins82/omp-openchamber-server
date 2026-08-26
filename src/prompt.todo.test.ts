import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { subscribeOpenCodeEvents, type OpenCodeEvent } from "./sse";
import { createEventHandler } from "./prompt";
import { isTodoTool, normalizeOmpTodoStatus, extractTodosFromOmpDetails } from "./todo";
import type { OmpRpcEvent } from "./rpc";

const SES_ID = "ses_todo_test_session_12345";
const CWD = "/tmp/test-repo";
const MODEL = { providerID: "omp", modelID: "default", variant: "default" };

describe("todo parsing and normalization utilities", () => {
  it("correctly identifies todo tools", () => {
    expect(isTodoTool("todo")).toBe(true);
    expect(isTodoTool("TODO")).toBe(true);
    expect(isTodoTool("todowrite")).toBe(true);
    expect(isTodoTool("todoread")).toBe(true);
    expect(isTodoTool("todos")).toBe(true);
    expect(isTodoTool("bash")).toBe(false);
    expect(isTodoTool("read")).toBe(false);
    expect(isTodoTool(undefined)).toBe(false);
  });

  it("normalizes OMP task statuses to OpenCode status vocabulary", () => {
    expect(normalizeOmpTodoStatus("in_progress")).toBe("in_progress");
    expect(normalizeOmpTodoStatus("inprogress")).toBe("in_progress");
    expect(normalizeOmpTodoStatus("running")).toBe("in_progress");
    expect(normalizeOmpTodoStatus("active")).toBe("in_progress");

    expect(normalizeOmpTodoStatus("completed")).toBe("completed");
    expect(normalizeOmpTodoStatus("complete")).toBe("completed");
    expect(normalizeOmpTodoStatus("done")).toBe("completed");

    expect(normalizeOmpTodoStatus("abandoned")).toBe("cancelled");
    expect(normalizeOmpTodoStatus("cancelled")).toBe("cancelled");
    expect(normalizeOmpTodoStatus("canceled")).toBe("cancelled");
    expect(normalizeOmpTodoStatus("dropped")).toBe("cancelled");

    expect(normalizeOmpTodoStatus("pending")).toBe("pending");
    expect(normalizeOmpTodoStatus("blocked")).toBe("pending");
    expect(normalizeOmpTodoStatus("todo")).toBe("pending");
    expect(normalizeOmpTodoStatus(undefined)).toBe("pending");
  });

  it("extracts and flattens tasks from details.phases", () => {
    const rawDetails = {
      op: "init",
      phases: [
        {
          name: "Build",
          tasks: [
            { id: "task-1", content: "Write Three.js scene", status: "in_progress" },
            { id: "task-2", content: "Syntax check", status: "pending" },
          ],
        },
        {
          name: "Verify",
          tasks: [
            { content: "Smoke test in browser", status: "blocked", priority: "high" },
            { content: "Drop deprecated code", status: "abandoned" },
          ],
        },
      ],
    };

    const todos = extractTodosFromOmpDetails(rawDetails);
    expect(todos).toBeDefined();
    expect(todos).toHaveLength(4);

    expect(todos![0]).toEqual({
      id: "task-1",
      content: "Write Three.js scene",
      status: "in_progress",
      priority: "normal",
    });
    expect(todos![1]).toEqual({
      id: "task-2",
      content: "Syntax check",
      status: "pending",
      priority: "normal",
    });
    expect(todos![2]).toEqual({
      id: "todo_1_0",
      content: "Smoke test in browser",
      status: "pending",
      priority: "high",
    });
    expect(todos![3]).toEqual({
      id: "todo_1_1",
      content: "Drop deprecated code",
      status: "cancelled",
      priority: "normal",
    });
  });

  it("extracts tasks from direct array result", () => {
    const rawResult = [
      { id: "t1", content: "Step 1", status: "completed" },
      { id: "t2", content: "Step 2", status: "in_progress" },
    ];
    const todos = extractTodosFromOmpDetails(undefined, rawResult);
    expect(todos).toBeDefined();
    expect(todos).toHaveLength(2);
    expect(todos![0].status).toBe("completed");
    expect(todos![1].status).toBe("in_progress");
  });
});

describe("todo.updated SSE event emission during live turns", () => {
  let events: OpenCodeEvent[] = [];
  let unsub: (() => void) | null = null;

  beforeEach(() => {
    events = [];
    unsub = subscribeOpenCodeEvents((e) => events.push(e));
  });

  afterEach(() => {
    unsub?.();
    unsub = null;
  });

  it("emits todo.updated when todo tool execution ends with phases details", () => {
    const handler = createEventHandler(
      SES_ID,
      undefined,
      MODEL,
      () => {},
      undefined,
      CWD,
    );

    const phases = [
      {
        name: "Build",
        tasks: [
          { id: "task_1", content: "Write HTML", status: "in_progress" },
          { id: "task_2", content: "Check JS", status: "pending" },
        ],
      },
    ];

    // Tool execution start
    handler({
      type: "tool_execution_start",
      payload: {
        toolCallId: "call_todo_1",
        tool: "todo",
      },
    } as unknown as OmpRpcEvent);

    // Tool execution end with phases details
    handler({
      type: "tool_execution_end",
      payload: {
        toolCallId: "call_todo_1",
        tool: "todo",
        details: { phases },
      },
    } as unknown as OmpRpcEvent);

    const todoEvents = events.filter((e) => e.type === "todo.updated");
    expect(todoEvents).toHaveLength(1);
    expect(todoEvents[0].directory).toBe(CWD);

    const props = todoEvents[0].properties as { sessionID: string; todos: any[] };
    expect(props.sessionID).toBe(SES_ID);
    expect(props.todos).toHaveLength(2);
    expect(props.todos[0]).toEqual({
      id: "task_1",
      content: "Write HTML",
      status: "in_progress",
      priority: "normal",
    });
    expect(props.todos[1]).toEqual({
      id: "task_2",
      content: "Check JS",
      status: "pending",
      priority: "normal",
    });
  });

  it("emits todo.updated when nested message_update toolcall completes", () => {
    const handler = createEventHandler(
      SES_ID,
      undefined,
      MODEL,
      () => {},
      undefined,
      CWD,
    );

    const phases = [
      {
        name: "Verify",
        tasks: [
          { id: "task_3", content: "Browser smoke test", status: "completed" },
        ],
      },
    ];

    handler({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCallId: "call_todo_2",
        tool: "todo",
        details: { phases },
      },
    } as unknown as OmpRpcEvent);

    const todoEvents = events.filter((e) => e.type === "todo.updated");
    expect(todoEvents).toHaveLength(1);
    const props = todoEvents[0].properties as { sessionID: string; todos: any[] };
    expect(props.sessionID).toBe(SES_ID);
    expect(props.todos[0].status).toBe("completed");
  });

  it("does not emit todo.updated for non-todo tools like bash or read", () => {
    const handler = createEventHandler(
      SES_ID,
      undefined,
      MODEL,
      () => {},
      undefined,
      CWD,
    );

    handler({
      type: "tool_execution_start",
      payload: {
        toolCallId: "call_bash_1",
        tool: "bash",
      },
    } as unknown as OmpRpcEvent);

    handler({
      type: "tool_execution_end",
      payload: {
        toolCallId: "call_bash_1",
        tool: "bash",
        output: "done",
      },
    } as unknown as OmpRpcEvent);

    const todoEvents = events.filter((e) => e.type === "todo.updated");
    expect(todoEvents).toHaveLength(0);
  });
});
