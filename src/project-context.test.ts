import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createProjectContextRuntime,
  handleProjectContextRequest,
  parsePlanMarkdown,
} from "./project-context";

let projectsDir: string;

beforeEach(async () => {
  projectsDir = await mkdtemp(join(tmpdir(), "omp-project-context-"));
});

afterEach(async () => {
  await rm(projectsDir, { recursive: true, force: true });
});

function runtime() {
  let id = 0;
  return createProjectContextRuntime({
    projectsDirPath: projectsDir,
    createId: () => `id-${++id}`,
    resolveSharedPlansDir: async () => null,
  });
}

describe("project context storage", () => {
  test("missing context is an authoritative empty result", async () => {
    const context = await runtime().readContext("path_dGVzdA");
    expect(context).toMatchObject({ version: 2, notes: [], todos: [], plans: [], sharedPlansDir: null });
  });

  test("notes, todos, and plans round-trip without clobbering one another", async () => {
    const contextRuntime = runtime();
    const note = await contextRuntime.createNote("path_dGVzdA", { body: "Remember this", source: "selection" });
    await contextRuntime.saveTodos("path_dGVzdA", [{ id: "todo-1", text: "Do this", completed: false }]);
    const plan = await contextRuntime.createPlan("path_dGVzdA", { title: "A plan", body: "First step" });

    const context = await contextRuntime.readContext("path_dGVzdA");
    expect(context.notes).toHaveLength(1);
    expect(context.notes[0]).toMatchObject({ id: note.note.id, body: "Remember this", source: "selection" });
    expect(context.todos).toMatchObject([{ id: "todo-1", text: "Do this", completed: false }]);
    expect(context.plans).toMatchObject([{ id: plan.plan.id, title: "A plan", source: "personal" }]);

    const loadedPlan = await contextRuntime.readPlan("path_dGVzdA", plan.plan.id);
    expect(loadedPlan).toMatchObject({ title: "A plan", body: "First step", raw: "# A plan\n\nFirst step" });
  });

  test("serializes concurrent field writes", async () => {
    const contextRuntime = runtime();
    await Promise.all([
      contextRuntime.saveTodos("path_dGVzdA", [{ id: "todo-1", text: "one" }]),
      contextRuntime.createNote("path_dGVzdA", { body: "note" }),
      contextRuntime.createPlan("path_dGVzdA", { title: "plan", body: "body" }),
    ]);

    const context = await contextRuntime.readContext("path_dGVzdA");
    expect(context.notes).toHaveLength(1);
    expect(context.todos).toHaveLength(1);
    expect(context.plans).toHaveLength(1);
  });

  test("malformed stored JSON is a failure, not empty context", async () => {
    await mkdir(join(projectsDir, "path_dGVzdA"), { recursive: true });
    await writeFile(join(projectsDir, "path_dGVzdA", "context.json"), "{broken", "utf8");
    await expect(runtime().readContext("path_dGVzdA")).rejects.toThrow("malformed");
  });

  test("rejects traversal project IDs", async () => {
    await expect(runtime().readContext("../escape")).rejects.toThrow("unsupported characters");
  });

  test("migrates legacy context keys after writing the new file", async () => {
    await mkdir(join(projectsDir, "path_dGVzdA", "plans"), { recursive: true });
    await writeFile(join(projectsDir, "path_dGVzdA", "plans", "old.md"), "# Old\n\nbody", "utf8");
    await writeFile(join(projectsDir, "path_dGVzdA.json"), JSON.stringify({
      projectNotes: "legacy note",
      projectTodos: [{ id: "todo-1", text: "legacy todo" }],
      projectPlanFiles: [{ id: "plan-1", path: join(projectsDir, "path_dGVzdA", "plans", "old.md"), createdAt: 1 }],
      setupWorktree: ["keep"],
    }), "utf8");

    const context = await runtime().readContext("path_dGVzdA");
    expect(context.notes[0].body).toBe("legacy note");
    expect(context.todos[0].text).toBe("legacy todo");
    expect(context.plans[0]).toMatchObject({ id: "plan-1", file: "old.md", title: "Old" });
    expect(JSON.parse(await readFile(join(projectsDir, "path_dGVzdA.json"), "utf8"))).toEqual({ setupWorktree: ["keep"] });
  });
});

describe("project context HTTP handler", () => {
  test("serves the GET and note write contract", async () => {
    const contextRuntime = runtime();
    const base = "http://sidecar.test/api/project-context/path_dGVzdA";
    const empty = await handleProjectContextRequest(new Request(base), new URL(base), contextRuntime);
    expect(empty?.status).toBeUndefined();
    expect(empty?.body).toMatchObject({ notes: [], todos: [], plans: [] });

    const noteUrl = new URL(`${base}/notes`);
    const created = await handleProjectContextRequest(new Request(noteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "hello", source: "agent", origin: { sessionId: "ses_1" } }),
    }), noteUrl, contextRuntime);
    expect(created?.status).toBe(201);
    expect(created?.body).toMatchObject({ note: { body: "hello", source: "agent" } });
  });
});

describe("plan markdown", () => {
  test("keeps the heading separate from the body", () => {
    expect(parsePlanMarkdown("# Title\n\nBody")).toEqual({ title: "Title", body: "Body" });
    expect(parsePlanMarkdown("plain body")).toEqual({ title: "plain body", body: "plain body" });
  });
});
