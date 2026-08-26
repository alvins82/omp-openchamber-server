import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createOmpSession,
  getOmpSessionByOpenCodeId,
  listOmpChildSessions,
  listOmpSessions,
  toOpenCodeSessionId,
  encodeCwd,
} from "./sessions";
import { loadSessionMessages } from "./messages";
import { createEventHandler, setSubagentStatus, getSessionStatusMap } from "./prompt";
import { subscribeOpenCodeEvents, type OpenCodeEvent } from "./sse";

const TEST_DIR = "/tmp/omp-test-subagents-" + Math.random().toString(36).slice(2);
const ENCODED_DIR = encodeCwd(TEST_DIR);
const SESSIONS_DIR = join(Bun.env.HOME!, ".omp", "agent", "sessions", ENCODED_DIR);

describe("Subagents & Child Sessions Integration", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await rm(SESSIONS_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("discovers subagent child sessions stored in artifact folders", async () => {
    // 1. Create a parent session
    const parent = await createOmpSession(TEST_DIR, { title: "Parent Task" });
    const parentUuid = parent.id.replace(/^ses_/, "");

    // 2. Create subagent artifact directory and child jsonl file
    const artifactDir = parent.path.replace(/\.jsonl$/, "");
    await mkdir(artifactDir, { recursive: true });

    const childUuid = "019ef37d-f6e3-7006-88ad-5025bade750d";
    const childFile = join(artifactDir, "ResearchWorker.jsonl");

    const childHeader = {
      type: "session",
      version: 3,
      id: childUuid,
      timestamp: new Date().toISOString(),
      cwd: TEST_DIR,
      title: "Research Worker",
      agent: "task",
    };
    const childMsg = {
      type: "message",
      id: "m1",
      message: {
        role: "user",
        content: [{ type: "text", text: "Perform background code research" }],
      },
    };
    const childAsst = {
      type: "message",
      id: "m2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here are the research findings." }],
      },
    };

    await Bun.write(
      childFile,
      `${JSON.stringify(childHeader)}\n${JSON.stringify(childMsg)}\n${JSON.stringify(childAsst)}\n`,
    );

    // 3. Verify listOmpSessions discovers both parent and child
    const all = await listOmpSessions(TEST_DIR);
    expect(all.length).toBe(2);

    const childSession = all.find((s) => s.id === toOpenCodeSessionId(childUuid));
    expect(childSession).toBeDefined();
    expect(childSession?.parentID).toBe(parent.id);
    expect(childSession?.agent).toBe("task");

    // 4. Verify listOmpChildSessions returns only the child
    const children = await listOmpChildSessions(parent.id, TEST_DIR);
    expect(children.length).toBe(1);
    expect(children[0].id).toBe(toOpenCodeSessionId(childUuid));
    expect(children[0].parentID).toBe(parent.id);

    // 5. Verify getOmpSessionByOpenCodeId finds the subagent
    const fetchedChild = await getOmpSessionByOpenCodeId(toOpenCodeSessionId(childUuid), TEST_DIR);
    expect(fetchedChild).not.toBeNull();
    expect(fetchedChild?.id).toBe(toOpenCodeSessionId(childUuid));

    // 6. Verify loadSessionMessages parses the child transcript
    const messages = await loadSessionMessages(toOpenCodeSessionId(childUuid), TEST_DIR);
    expect(messages.length).toBe(2);
    expect(messages[0].info.role).toBe("user");
    expect(messages[1].info.role).toBe("assistant");
  });

  it("handles subagent lifecycle events and translates to OpenCode SSE events", () => {
    const events: OpenCodeEvent[] = [];
    const unsub = subscribeOpenCodeEvents((e) => events.push(e));

    const handler = createEventHandler(
      "ses_parent123",
      "msg_u1",
      { providerID: "omp", modelID: "omp", variant: "default" },
      () => {},
      undefined,
      TEST_DIR,
    );

    // 1. Subagent started
    handler({
      type: "subagent_lifecycle",
      payload: {
        id: "sub-worker-1",
        status: "started",
        agent: "task",
        description: "Security Auditor",
        sessionFile: "/tmp/sub-worker-1.jsonl",
      },
    });

    const createdEvt = events.find((e) => e.type === "session.created");
    expect(createdEvt).toBeDefined();
    const createdSession = (createdEvt?.properties?.info || createdEvt?.properties?.session) as any;
    expect(createdSession.parentID).toBe("ses_parent123");
    expect(createdSession.title).toBe("Security Auditor");

    expect(getSessionStatusMap()["ses_subworker1"]).toEqual({ type: "busy" });

    // 2. Subagent completed
    handler({
      type: "subagent_lifecycle",
      payload: {
        id: "sub-worker-1",
        status: "completed",
        agent: "task",
      },
    });

    const statusIdleEvts = events.filter((e) => e.type === "session.status");
    expect(statusIdleEvts.length).toBeGreaterThan(0);
    expect(getSessionStatusMap()["ses_subworker1"]).toBeUndefined();

    unsub();
  });
});
