import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPromptImages,
  mimeFromPath,
  promptSessionAsync,
  setConnectionFactory,
  resetConnectionFactory,
  removeSessionState,
} from "./prompt";
import {
  loadMessagesFromFile,
  clearRecordedUserMessagesMemoryCache,
  type OpenCodeFilePart,
  type OpenCodeTextPart,
} from "./messages";
import { subscribeOpenCodeEvents, type OpenCodeEvent } from "./sse";
import type { OmpRpcTransport, OmpRpcEvent } from "./rpc";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_DATA_URL = `data:image/png;base64,${PNG_1X1_BASE64}`;
const JPEG_DATA_URL = `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=`;

describe("mimeFromPath", () => {
  test("extracts image MIME types from extensions", () => {
    expect(mimeFromPath("test.png")).toBe("image/png");
    expect(mimeFromPath("path/to/photo.jpg")).toBe("image/jpeg");
    expect(mimeFromPath("/var/tmp/image.jpeg?v=1")).toBe("image/jpeg");
    expect(mimeFromPath("file:///c/pic.gif#ref")).toBe("image/gif");
    expect(mimeFromPath("graphic.webp")).toBe("image/webp");
    expect(mimeFromPath("doc.pdf")).toBeUndefined();
    expect(mimeFromPath("file.txt")).toBeUndefined();
  });
});

describe("extractPromptImages", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "img-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("extracts image from data URL in file part", async () => {
    const images = await extractPromptImages({
      parts: [
        { type: "text", text: "What is this?" },
        { type: "file", mime: "image/png", url: PNG_DATA_URL, filename: "screenshot.png" },
      ],
    });

    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      type: "image",
      data: PNG_1X1_BASE64,
      mimeType: "image/png",
    });
  });

  test("extracts image from data URL in image part", async () => {
    const images = await extractPromptImages({
      parts: [
        { type: "image", url: JPEG_DATA_URL },
      ],
    });

    expect(images).toHaveLength(1);
    expect(images[0].type).toBe("image");
    expect(images[0].mimeType).toBe("image/jpeg");
    expect(images[0].data).toBe(JPEG_DATA_URL.slice(JPEG_DATA_URL.indexOf(",") + 1));
  });

  test("extracts image from direct base64 data property", async () => {
    const images = await extractPromptImages({
      parts: [
        { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
      ],
    });

    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      type: "image",
      data: PNG_1X1_BASE64,
      mimeType: "image/png",
    });
  });

  test("extracts image from local file path", async () => {
    const imgPath = join(tmpDir, "local_test.png");
    const rawBuffer = Buffer.from(PNG_1X1_BASE64, "base64");
    writeFileSync(imgPath, rawBuffer);

    const images = await extractPromptImages({
      parts: [
        { type: "file", mime: "image/png", url: `file://${imgPath}`, filename: "local_test.png" },
      ],
    });

    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      type: "image",
      data: PNG_1X1_BASE64,
      mimeType: "image/png",
    });
  });

  test("ignores non-image file parts", async () => {
    const images = await extractPromptImages({
      parts: [
        { type: "text", text: "Look at this code" },
        { type: "file", mime: "text/plain", url: "main.ts", filename: "main.ts" },
      ],
    });

    expect(images).toHaveLength(0);
  });

  test("extracts multiple image parts preserving order", async () => {
    const images = await extractPromptImages({
      parts: [
        { type: "file", mime: "image/png", url: PNG_DATA_URL, filename: "img1.png" },
        { type: "text", text: "compare these" },
        { type: "file", mime: "image/jpeg", url: JPEG_DATA_URL, filename: "img2.jpg" },
      ],
    });

    expect(images).toHaveLength(2);
    expect(images[0].mimeType).toBe("image/png");
    expect(images[1].mimeType).toBe("image/jpeg");
  });
});

class MockPromptTransport implements OmpRpcTransport {
  public requests: Array<{ method: string; params: unknown }> = [];
  private listeners = new Set<(ev: OmpRpcEvent) => void>();

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "prompt") {
      setTimeout(() => {
        for (const l of this.listeners) {
          l({ type: "agent_start" } as OmpRpcEvent);
          l({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "I see the image" },
          } as OmpRpcEvent);
          l({ type: "agent_end", isTerminal: true } as OmpRpcEvent);
        }
      }, 5);
      return { agentInvoked: true };
    }
    return {};
  }

  onEvent(listener: (ev: OmpRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  kill(): void {}
  switchSession(): Promise<void> {
    return Promise.resolve();
  }
}

describe("promptSessionAsync with image attachments", () => {
  let mockTransport: MockPromptTransport;
  const testSessionId = "ses_imgtest0001";
  const testCwd = "/tmp/test-img-cwd";
  const testSessionPath = "/tmp/test-img-cwd/session.jsonl";

  beforeEach(() => {
    clearRecordedUserMessagesMemoryCache();
    mockTransport = new MockPromptTransport();
    setConnectionFactory(async () => mockTransport);
  });

  afterEach(() => {
    removeSessionState(testSessionId, testCwd);
    resetConnectionFactory();
  });

  test("passes image attachments to OMP RPC prompt request", async () => {
    const events: OpenCodeEvent[] = [];
    const unsubscribe = subscribeOpenCodeEvents((e) => events.push(e));

    const result = await promptSessionAsync(testSessionId, testCwd, testSessionPath, {
      messageID: "msg_user_img_1",
      parts: [
        { type: "text", text: "What is this a screenshot of?" },
        { type: "file", mime: "image/png", url: PNG_DATA_URL, filename: "screenshot.png" },
      ],
    });

    expect(result.queued).toBe(true);

    // Wait for mock response turn to finish
    await new Promise((r) => setTimeout(r, 50));
    unsubscribe();

    // Verify OMP RPC prompt command received both message and images
    const promptReq = mockTransport.requests.find((r) => r.method === "prompt");
    expect(promptReq).toBeDefined();
    const promptPayload = promptReq!.params as { message: string; images?: Array<{ type: string; data: string; mimeType: string }> };
    expect(promptPayload.message).toBe("What is this a screenshot of?");
    expect(promptPayload.images).toBeDefined();
    expect(promptPayload.images).toHaveLength(1);
    expect(promptPayload.images![0]).toEqual({
      type: "image",
      data: PNG_1X1_BASE64,
      mimeType: "image/png",
    });

    // Verify SSE emitted both text part and file part for the user message,
    // with file parts emitted first to prevent OpenChamber from duplicating optimistic file parts
    const partEvents = events.filter((e) => e.type === "message.part.updated");
    expect(partEvents.length).toBeGreaterThanOrEqual(2);

    const userParts = partEvents
      .map((e) => e.properties.part as { type: string; text?: string; url?: string; mime?: string })
      .filter((p) => p.type === "text" || p.type === "file");

    const fileIndex = userParts.findIndex((p) => p.type === "file" && p.mime === "image/png" && p.url === PNG_DATA_URL);
    const textIndex = userParts.findIndex((p) => p.type === "text" && p.text === "What is this a screenshot of?");
    expect(fileIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(fileIndex).toBeLessThan(textIndex);
  });

  test("supports image-only prompt without text parts", async () => {
    const result = await promptSessionAsync(testSessionId, testCwd, testSessionPath, {
      messageID: "msg_user_img_only",
      parts: [
        { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
      ],
    });

    expect(result.queued).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    const promptReq = mockTransport.requests.find((r) => r.method === "prompt");
    expect(promptReq).toBeDefined();
    const promptPayload = promptReq!.params as { message: string; images?: Array<{ type: string; data: string; mimeType: string }> };
    expect(promptPayload.message).toBe("");
    expect(promptPayload.images).toHaveLength(1);
    expect(promptPayload.images![0].data).toBe(PNG_1X1_BASE64);
  });
});

describe("loadMessagesFromFile with image blocks", () => {
  let tmpDir: string;
  const sid = "ses_imageloadtest";
  const testDb = join(tmpdir(), "img-history.db");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "msg-img-test-"));
    clearRecordedUserMessagesMemoryCache();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("maps user message with text and image content blocks to text and file parts", async () => {
    const jsonlPath = join(tmpDir, "session.jsonl");
    const lines = [
      { type: "session", id: sid, title: "Test Session" },
      {
        type: "message",
        id: "msg_1",
        timestamp: "2026-08-26T06:07:34.606Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "What is this a screenshot of?" },
            { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
          ],
          timestamp: 1787724454494,
        },
      },
      {
        type: "message",
        id: "msg_2",
        timestamp: "2026-08-26T06:07:39.185Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "This is a tennis racket icon." }],
          provider: "vllm",
          model: "qwen3.8-27b",
          stopReason: "stop",
          timestamp: 1787724459185,
        },
      },
    ];
    writeFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const records = await loadMessagesFromFile(jsonlPath, sid, testDb);
    expect(records).not.toBeNull();
    expect(records).toHaveLength(2);

    const userRecord = records![0];
    expect(userRecord.info.role).toBe("user");
    expect(userRecord.parts).toHaveLength(2);

    const textPart = userRecord.parts[0] as OpenCodeTextPart;
    expect(textPart.type).toBe("text");
    expect(textPart.text).toBe("What is this a screenshot of?");

    const filePart = userRecord.parts[1] as OpenCodeFilePart;
    expect(filePart.type).toBe("file");
    expect(filePart.mime).toBe("image/png");
    expect(filePart.url).toBe(`data:image/png;base64,${PNG_1X1_BASE64}`);
  });

  test("resolves blob:sha256 externalized image reference from disk to valid data URL", async () => {
    // Write a mock blob file to ~/.omp/agent/blobs or tmpDir
    const rawBuffer = Buffer.from(PNG_1X1_BASE64, "base64");
    const hash = new Bun.SHA256().update(rawBuffer).digest("hex");
    const blobsDir = join(tmpDir, "blobs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(blobsDir, { recursive: true });
    writeFileSync(join(blobsDir, hash), rawBuffer);

    process.env.PI_CODING_AGENT_DIR = tmpDir;

    const jsonlPath = join(tmpDir, "blob_session.jsonl");
    const lines = [
      { type: "session", id: sid, title: "Blob Test Session" },
      {
        type: "message",
        id: "msg_1",
        timestamp: "2026-08-26T06:07:34.606Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Check this externalized blob" },
            { type: "image", data: `blob:sha256:${hash}`, mimeType: "image/webp" },
          ],
          timestamp: 1787724454494,
        },
      },
    ];
    writeFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    try {
      const records = await loadMessagesFromFile(jsonlPath, sid, testDb);
      expect(records).not.toBeNull();
      expect(records).toHaveLength(1);

      const userRecord = records![0];
      expect(userRecord.parts).toHaveLength(2);

      const filePart = userRecord.parts[1] as OpenCodeFilePart;
      expect(filePart.type).toBe("file");
      expect(filePart.mime).toBe("image/webp");
      expect(filePart.url).toBe(`data:image/webp;base64,${PNG_1X1_BASE64}`);
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });
});
