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

  it("coalesces multi-step assistant turns with subagent tasks and aligns message IDs with streaming", async () => {
    const { recordUserMessageId } = await import("./messages");
    const parent = await createOmpSession(TEST_DIR, { title: "Subagent Test" });
    const userMessageId = "msg_client_subagent_prompt";

    // 1. Record client user message mapping
    recordUserMessageId(parent.id, "Run generic subagent", userMessageId);

    // 2. Simulate multi-step OMP transcript written to parent session file
    const u1 = {
      type: "message",
      id: "u1_omp",
      message: { role: "user", content: "Run generic subagent", timestamp: 1000 },
    };
    const asst1 = {
      type: "message",
      id: "a1_omp",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I will spawn the SiteAudit subagent." },
          { type: "toolCall", id: "call_task_1", name: "task", arguments: { name: "SiteAudit" } },
        ],
        stopReason: "toolUse",
        timestamp: 2000,
      },
    };
    const toolRes1 = {
      type: "message",
      id: "tr1_omp",
      message: {
        role: "toolResult",
        toolCallId: "call_task_1",
        toolName: "task",
        content: "Spawned agent SiteAudit. completed: subagent yielded successfully.",
        timestamp: 3000,
      },
    };
    const asst2 = {
      type: "message",
      id: "a2_omp",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Subagent finished, writing summary." },
          { type: "text", text: "Subagent test passed." },
        ],
        stopReason: "stop",
        timestamp: 4000,
      },
    };

    await Bun.write(
      parent.path,
      `${JSON.stringify({ type: "session", id: parent.id.replace(/^ses_/, ""), timestamp: new Date().toISOString(), cwd: TEST_DIR })}\n` +
      `${JSON.stringify(u1)}\n${JSON.stringify(asst1)}\n${JSON.stringify(toolRes1)}\n${JSON.stringify(asst2)}\n`,
    );

    // 3. Load messages and verify coalescence and matching ID
    const messages = await loadSessionMessages(parent.id, TEST_DIR);
    expect(messages).toHaveLength(2);

    expect(messages[0].info.id).toBe(userMessageId);
    expect(messages[0].info.role).toBe("user");

    const asstRecord = messages[1];
    expect(asstRecord.info.id).toBe(`msg_${parent.id}_asst_${userMessageId}`);
    expect(asstRecord.info.role).toBe("assistant");
    expect(asstRecord.info.parentID).toBe(userMessageId);
    expect(asstRecord.info.finish).toBe("stop");

    // All parts across both assistant turns are unified in order
    expect(asstRecord.parts).toHaveLength(4);
    expect(asstRecord.parts[0].type).toBe("reasoning");
    expect((asstRecord.parts[0] as any).text).toBe("I will spawn the SiteAudit subagent.");
    expect(asstRecord.parts[1].type).toBe("tool");
    expect((asstRecord.parts[1] as any).tool).toBe("task");
    expect((asstRecord.parts[1] as any).state.status).toBe("completed");
    expect((asstRecord.parts[1] as any).state.output).toBe("Spawned agent SiteAudit. completed: subagent yielded successfully.");
    expect(asstRecord.parts[2].type).toBe("reasoning");
    expect((asstRecord.parts[2] as any).text).toBe("Subagent finished, writing summary.");
    expect(asstRecord.parts[3].type).toBe("text");
    expect((asstRecord.parts[3] as any).text).toBe("Subagent test passed.");
  });
});
