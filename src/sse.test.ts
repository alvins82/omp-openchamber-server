import { describe, expect, test } from "bun:test";
import {
  attachOpenCodeEventWebSocket,
  createOpenChamberNotificationStream,
  emitOpenCodeEvent,
} from "./sse";

class FakeSocket {
  frames: string[] = [];

  sendText(data: string): void {
    this.frames.push(data);
  }
}

describe("browser realtime adapters", () => {
  test("global WebSocket sends ready, connected, and live event frames", () => {
    const socket = new FakeSocket();
    const cleanup = attachOpenCodeEventWebSocket(socket, "/workspace");

    expect(JSON.parse(socket.frames[0])).toEqual({ type: "ready" });
    expect(JSON.parse(socket.frames[1])).toMatchObject({
      type: "event",
      directory: "/workspace",
      payload: { type: "server.connected", properties: {} },
    });

    emitOpenCodeEvent("session.status", {
      sessionID: "ses_child",
      status: { type: "busy" },
    }, "/workspace");
    expect(JSON.parse(socket.frames[2])).toMatchObject({
      type: "event",
      directory: "/workspace",
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_child", status: { type: "busy" } },
      },
    });

    cleanup();
    emitOpenCodeEvent("session.status", { sessionID: "ses_child", status: { type: "idle" } }, "/workspace");
    expect(socket.frames).toHaveLength(3);
  });

  test("notification SSE only forwards notification events", async () => {
    const stream = createOpenChamberNotificationStream();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const ready = await reader.read();
    expect(decoder.decode(ready.value)).toContain("openchamber:notification-stream-ready");

    emitOpenCodeEvent("session.status", { sessionID: "ses_child", status: { type: "idle" } });
    let notificationSeen = false;
    const notification = new Promise<string>((resolve) => {
      const read = async () => {
        const next = await reader.read();
        if (next.value) resolve(decoder.decode(next.value));
      };
      void read();
    });
    emitOpenCodeEvent("openchamber:notification", { title: "Done" });
    const body = await notification;
    notificationSeen = body.includes("openchamber:notification") && body.includes("Done");
    expect(notificationSeen).toBe(true);

    await reader.cancel();
  });
});
