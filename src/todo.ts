export interface OpenCodeTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: string;
}

export function isTodoTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const t = toolName.toLowerCase().trim();
  return t === "todo" || t === "todowrite" || t === "todoread" || t === "todos";
}

export function normalizeOmpTodoStatus(status: string | undefined): "pending" | "in_progress" | "completed" | "cancelled" {
  if (!status) return "pending";
  const s = status.toLowerCase().trim();
  if (s === "in_progress" || s === "inprogress" || s === "running" || s === "active") return "in_progress";
  if (s === "completed" || s === "complete" || s === "done") return "completed";
  if (s === "abandoned" || s === "cancelled" || s === "canceled" || s === "dropped") return "cancelled";
  if (s === "blocked" || s === "pending" || s === "todo" || s === "open") return "pending";
  return "pending";
}

export function extractTodosFromOmpDetails(
  details: unknown,
  fallbackResult?: unknown,
): OpenCodeTodo[] | undefined {
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    const rawPhases = d.phases ?? d.todoPhases;
    if (Array.isArray(rawPhases)) {
      const todos: OpenCodeTodo[] = [];
      for (let pIdx = 0; pIdx < rawPhases.length; pIdx++) {
        const phase = rawPhases[pIdx];
        if (!phase || typeof phase !== "object") continue;
        const tasks = (phase as { tasks?: unknown[] }).tasks;
        if (!Array.isArray(tasks)) continue;
        for (let tIdx = 0; tIdx < tasks.length; tIdx++) {
          const task = tasks[tIdx];
          if (!task || typeof task !== "object") continue;
          const t = task as Record<string, unknown>;
          const content = typeof t.content === "string" ? t.content : (typeof t.text === "string" ? t.text : "");
          const id = typeof t.id === "string" && t.id.length > 0 ? t.id : `todo_${pIdx}_${tIdx}`;
          const status = normalizeOmpTodoStatus(typeof t.status === "string" ? t.status : undefined);
          const priority = typeof t.priority === "string" && t.priority.length > 0 ? t.priority : "normal";
          todos.push({ id, content, status, priority });
        }
      }
      return todos;
    }

    // Direct tasks array in details
    if (Array.isArray(d.tasks)) {
      const todos: OpenCodeTodo[] = [];
      for (let i = 0; i < d.tasks.length; i++) {
        const task = d.tasks[i];
        if (!task || typeof task !== "object") continue;
        const t = task as Record<string, unknown>;
        const content = typeof t.content === "string" ? t.content : (typeof t.text === "string" ? t.text : "");
        const id = typeof t.id === "string" && t.id.length > 0 ? t.id : `todo_${i}`;
        const status = normalizeOmpTodoStatus(typeof t.status === "string" ? t.status : undefined);
        const priority = typeof t.priority === "string" && t.priority.length > 0 ? t.priority : "normal";
        todos.push({ id, content, status, priority });
      }
      return todos;
    }
  }

  // Check if fallbackResult is directly an array of todos
  if (Array.isArray(fallbackResult)) {
    const todos: OpenCodeTodo[] = [];
    for (let i = 0; i < fallbackResult.length; i++) {
      const item = fallbackResult[i];
      if (item && typeof item === "object") {
        const t = item as Record<string, unknown>;
        // Disregard raw content blocks (e.g. Anthropic/OMP text/image blocks)
        if (t.type === "text" || t.type === "image" || t.type === "thinking") {
          continue;
        }
        if (typeof t.content === "string" || (typeof t.text === "string" && (typeof t.status === "string" || typeof t.priority === "string"))) {
          const content = typeof t.content === "string" ? t.content : (typeof t.text === "string" ? t.text : "");
          const id = typeof t.id === "string" && t.id.length > 0 ? t.id : `todo_${i}`;
          const status = normalizeOmpTodoStatus(typeof t.status === "string" ? t.status : undefined);
          const priority = typeof t.priority === "string" && t.priority.length > 0 ? t.priority : "normal";
          todos.push({ id, content, status, priority });
        }
      }
    }
    if (todos.length > 0) return todos;
  }

  return undefined;
}
