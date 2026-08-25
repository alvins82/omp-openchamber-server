import { describe, it, expect, beforeEach } from "bun:test";
import {
  addPendingPermission,
  addPendingQuestion,
  listPendingPermissions,
  listPendingQuestions,
  getPendingPermission,
  getPendingQuestion,
  replyPermission,
  replyQuestion,
  rejectQuestion,
  clearSessionApprovals,
  resetApprovals,
  type PermissionRequest,
  type QuestionRequest,
} from "./approvals";
import { createEventHandler } from "./prompt";
import { subscribeOpenCodeEvents, type OpenCodeEvent } from "./sse";
import type { OmpRpcEvent } from "./rpc";

describe("Approval & Question Bridge (Tier 1)", () => {
  beforeEach(() => {
    resetApprovals();
  });

  describe("approvals.ts unit operations", () => {
    it("registers and lists pending permissions with directory filtering", () => {
      let resolvedPayload: any = null;
      const permA: PermissionRequest = {
        id: "perm_1",
        sessionID: "ses_1",
        permission: "execute",
        patterns: [],
        metadata: { cmd: "ls" },
        always: [],
        directory: "/dir/a",
      };
      const permB: PermissionRequest = {
        id: "perm_2",
        sessionID: "ses_2",
        permission: "write",
        patterns: ["*.txt"],
        metadata: {},
        always: [],
        directory: "/dir/b",
      };

      addPendingPermission(permA, (res) => {
        resolvedPayload = res;
      });
      addPendingPermission(permB, () => {});

      expect(listPendingPermissions()).toHaveLength(2);
      expect(listPendingPermissions("/dir/a")).toHaveLength(1);
      expect(listPendingPermissions("/dir/a")[0].id).toBe("perm_1");
      expect(listPendingPermissions("/dir/b")).toHaveLength(1);
      expect(listPendingPermissions("/dir/b")[0].id).toBe("perm_2");

      expect(getPendingPermission("perm_1")?.permission).toBe("execute");

      // Reply once -> confirmed true
      const ok = replyPermission("perm_1", "once");
      expect(ok).toBe(true);
      expect(resolvedPayload).toEqual({ confirmed: true });
      expect(listPendingPermissions("/dir/a")).toHaveLength(0);
    });

    it("handles reject permission -> confirmed false, cancelled true", () => {
      let resolvedPayload: any = null;
      const perm: PermissionRequest = {
        id: "perm_reject",
        sessionID: "ses_1",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      };
      addPendingPermission(perm, (res) => {
        resolvedPayload = res;
      });

      const ok = replyPermission("perm_reject", "reject");
      expect(ok).toBe(true);
      expect(resolvedPayload).toEqual({ confirmed: false, cancelled: true });
      expect(listPendingPermissions()).toHaveLength(0);
    });

    it("registers, lists, and answers pending questions", () => {
      let resolvedPayload: any = null;
      const q: QuestionRequest = {
        id: "q_1",
        sessionID: "ses_1",
        questions: [
          {
            question: "Which model?",
            header: "Model selection",
            options: [{ label: "Claude" }, { label: "GPT-4" }],
          },
        ],
        directory: "/dir/a",
      };

      addPendingQuestion(q, (res) => {
        resolvedPayload = res;
      });

      expect(listPendingQuestions("/dir/a")).toHaveLength(1);
      expect(getPendingQuestion("q_1")?.questions[0].header).toBe("Model selection");

      const ok = replyQuestion("q_1", [["Claude"]]);
      expect(ok).toBe(true);
      expect(resolvedPayload).toEqual({ value: "Claude" });
      expect(listPendingQuestions()).toHaveLength(0);
    });

    it("handles reject question -> cancelled true", () => {
      let resolvedPayload: any = null;
      const q: QuestionRequest = {
        id: "q_2",
        sessionID: "ses_1",
        questions: [{ question: "Enter key", header: "Key", options: [], custom: true }],
      };
      addPendingQuestion(q, (res) => {
        resolvedPayload = res;
      });

      const ok = rejectQuestion("q_2");
      expect(ok).toBe(true);
      expect(resolvedPayload).toEqual({ cancelled: true });
      expect(listPendingQuestions()).toHaveLength(0);
    });

    it("clearSessionApprovals cancels all pending requests for that session", () => {
      let permCancelled = false;
      let qCancelled = false;

      addPendingPermission(
        { id: "p1", sessionID: "ses_to_clear", permission: "p", patterns: [], metadata: {}, always: [] },
        (res) => {
          permCancelled = !!res.cancelled;
        },
      );
      addPendingQuestion(
        { id: "q1", sessionID: "ses_to_clear", questions: [] },
        (res) => {
          qCancelled = !!res.cancelled;
        },
      );

      clearSessionApprovals("ses_to_clear");
      expect(permCancelled).toBe(true);
      expect(qCancelled).toBe(true);
      expect(listPendingPermissions()).toHaveLength(0);
      expect(listPendingQuestions()).toHaveLength(0);
    });
  });

  describe("extension_ui_request integration with createEventHandler", () => {
    it("bridges confirm UI request to permission.asked event and sends extension_ui_response", () => {
      const sentFrames: any[] = [];
      const fakeConn = {
        request: async () => {},
        onEvent: () => () => {},
        switchSession: async () => {},
        kill: () => {},
        sendFrame: (frame: any) => sentFrames.push(frame),
      };

      const events: OpenCodeEvent[] = [];
      const unsub = subscribeOpenCodeEvents((e) => events.push(e));

      const handler = createEventHandler(
        "ses_event_test",
        undefined,
        { providerID: "omp", modelID: "omp", variant: "default" },
        () => {},
        fakeConn as any,
        "/workspace",
      );

      // OMP child sends extension_ui_request
      handler({
        type: "extension_ui_request",
        id: "req_confirm_1",
        method: "confirm",
        title: "Allow file write",
        message: "Can I write to index.ts?",
      } as unknown as OmpRpcEvent);

      expect(events.some((e) => e.type === "permission.asked")).toBe(true);
      const permEvent = events.find((e) => e.type === "permission.asked")!;
      expect(permEvent.properties).toMatchObject({
        id: "req_confirm_1",
        sessionID: "ses_event_test",
        permission: "Allow file write",
      });

      // User replies
      replyPermission("req_confirm_1", "once");

      expect(sentFrames).toHaveLength(1);
      expect(sentFrames[0]).toEqual({
        type: "extension_ui_response",
        id: "req_confirm_1",
        confirmed: true,
      });

      unsub();
    });

    it("bridges select UI request to question.asked event and sends extension_ui_response", () => {
      const sentFrames: any[] = [];
      const fakeConn = {
        request: async () => {},
        onEvent: () => () => {},
        switchSession: async () => {},
        kill: () => {},
        sendFrame: (frame: any) => sentFrames.push(frame),
      };

      const events: OpenCodeEvent[] = [];
      const unsub = subscribeOpenCodeEvents((e) => events.push(e));

      const handler = createEventHandler(
        "ses_event_test2",
        undefined,
        { providerID: "omp", modelID: "omp", variant: "default" },
        () => {},
        fakeConn as any,
        "/workspace",
      );

      handler({
        type: "extension_ui_request",
        id: "req_select_1",
        method: "select",
        title: "Pick environment",
        message: "Choose your target environment",
        options: ["staging", "production"],
      } as unknown as OmpRpcEvent);

      expect(events.some((e) => e.type === "question.asked")).toBe(true);
      const qEvent = events.find((e) => e.type === "question.asked")!;
      expect(qEvent.properties).toMatchObject({
        id: "req_select_1",
        sessionID: "ses_event_test2",
      });

      // User replies with choice
      replyQuestion("req_select_1", [["staging"]]);

      expect(sentFrames).toHaveLength(1);
      expect(sentFrames[0]).toEqual({
        type: "extension_ui_response",
        id: "req_select_1",
        value: "staging",
      });

      unsub();
    });

    it("auto-resolves permission requests when session auto-accept is active", () => {
      let resolved: any = null;
      const { setSessionAutoAccept, getAutoAcceptPolicy } = require("./approvals");

      setSessionAutoAccept("ses_auto_1", true);
      expect(getAutoAcceptPolicy().sessions["ses_auto_1"]).toBe(true);

      const perm: PermissionRequest = {
        id: "perm_auto_1",
        sessionID: "ses_auto_1",
        permission: "execute",
        patterns: [],
        metadata: { cmd: "echo hello" },
        always: [],
        directory: "/dir/auto",
      };

      addPendingPermission(perm, (res) => {
        resolved = res;
      });

      expect(resolved).toEqual({ confirmed: true });
      expect(getPendingPermission("perm_auto_1")).toBeUndefined();

      setSessionAutoAccept("ses_auto_1", false);
      expect(getAutoAcceptPolicy().sessions["ses_auto_1"]).toBe(false);
    });

    it("retroactively flushes existing pending permissions when auto-accept is enabled", () => {
      let resolved: any = null;
      const { setSessionAutoAccept } = require("./approvals");

      const perm: PermissionRequest = {
        id: "perm_retro_1",
        sessionID: "ses_retro_1",
        permission: "write",
        patterns: ["*.json"],
        metadata: {},
        always: [],
      };

      addPendingPermission(perm, (res) => {
        resolved = res;
      });

      expect(getPendingPermission("perm_retro_1")).toBeDefined();
      expect(resolved).toBeNull();

      setSessionAutoAccept("ses_retro_1", true);

      expect(resolved).toEqual({ confirmed: true });
      expect(getPendingPermission("perm_retro_1")).toBeUndefined();
    });
  });

  describe("bundled question extension", () => {
    it("registers the question tool with TypeBox schema and executes ctx.ui.select", async () => {
      const questionExtension = require("../extensions/question").default;
      let registeredTool: any = null;

      const mockPi = {
        typebox: {
          Type: {
            Object: (props: any) => ({ type: "object", properties: props }),
            String: (opts: any) => ({ type: "string", ...opts }),
            Array: (item: any, opts: any) => ({ type: "array", items: item, ...opts }),
            Optional: (inner: any) => ({ optional: true, ...inner }),
            Boolean: (opts: any) => ({ type: "boolean", ...opts }),
          },
        },
        registerTool: (tool: any) => {
          registeredTool = tool;
        },
      };

      questionExtension(mockPi);

      expect(registeredTool).not.toBeNull();
      expect(registeredTool.name).toBe("question");
      expect(registeredTool.loadMode).toBe("essential");
      expect(registeredTool.approval).toBe("read");

      // Test execution with mock ctx.ui
      let promptedTitle = "";
      let promptedOptions: string[] = [];
      const mockCtx = {
        ui: {
          select: async (title: string, options: string[]) => {
            promptedTitle = title;
            promptedOptions = options;
            return options[0];
          },
        },
      };

      const result = await registeredTool.execute(
        "call_q1",
        {
          questions: [
            {
              header: "Env",
              question: "Choose target?",
              options: [
                { label: "Staging", description: "Test env" },
                { label: "Prod", description: "Live" },
              ],
            },
          ],
        },
        null,
        null,
        mockCtx,
      );

      expect(promptedTitle).toBe("Env: Choose target?");
      expect(promptedOptions).toEqual(["Staging - Test env", "Prod - Live"]);
      expect(result.content[0].text).toBe("Staging - Test env");
    });
  });
});
