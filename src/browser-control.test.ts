import { describe, expect, it } from "bun:test";
import {
  BrowserControlBroker,
  BrowserControlError,
  normalizeBrowserUrlForOpen,
  type BrowserControlRequest,
} from "./browser-control";
import {
  emitBrowserControlRequest,
  createOpenCodeEventStream,
  formatOpenCodeEvent,
} from "./sse";

describe("BrowserControlBroker", () => {
  it("creates a request and broadcasts to listeners", async () => {
    let captured: BrowserControlRequest | null = null;
    const broker = new BrowserControlBroker({
      emitRequest: (req) => {
        captured = req;
        return 1;
      },
      createId: () => "test-req-1",
    });

    const promise = broker.request("browser.open", { url: "http://localhost:3000" });

    expect(captured).not.toBeNull();
    expect(captured!.requestId).toBe("test-req-1");
    expect(captured!.action).toBe("browser.open");
    expect(captured!.parameters).toEqual({ viewport: "desktop", url: "http://localhost:3000" });
    expect(broker.pendingCount).toBe(1);

    // Claim request
    expect(broker.claim("test-req-1")).toBe(true);
    // Duplicate claim rejected
    expect(broker.claim("test-req-1")).toBe(false);

    // Resolve
    const resolved = broker.resolve("test-req-1", {
      ok: true,
      data: { url: "http://localhost:3000", opened: true },
    });
    expect(resolved).toBe(true);

    const result = await promise;
    expect(result).toEqual({ url: "http://localhost:3000", opened: true });
    expect(broker.pendingCount).toBe(0);
  });

  it("fails fast with 503 when no clients are listening", async () => {
    const broker = new BrowserControlBroker({
      emitRequest: () => 0,
      createId: () => "test-req-empty",
    });

    try {
      await broker.request("browser.snapshot", {});
      expect.unreachable("Should have thrown 503");
    } catch (err: any) {
      expect(err).toBeInstanceOf(BrowserControlError);
      expect(err.status).toBe(503);
      expect(err.message).toContain("No OpenChamber client connected");
    }
  });

  it("rejects when the client reports an error", async () => {
    const broker = new BrowserControlBroker({
      emitRequest: () => 1,
      createId: () => "test-req-err",
    });

    const promise = broker.request("browser.click", { selector: "#button" });
    expect(broker.claim("test-req-err")).toBe(true);

    broker.resolve("test-req-err", {
      ok: false,
      error: "Element not found: #button",
    });

    try {
      await promise;
      expect.unreachable("Should have rejected");
    } catch (err: any) {
      expect(err).toBeInstanceOf(BrowserControlError);
      expect(err.status).toBe(400);
      expect(err.message).toBe("Element not found: #button");
    }
  });

  it("rejects on timeout if no response arrives", async () => {
    const broker = new BrowserControlBroker({
      emitRequest: () => 1,
      createId: () => "test-req-timeout",
    });

    const promise = broker.request("browser.snapshot", {}, { timeoutMs: 50 });

    try {
      await promise;
      expect.unreachable("Should have timed out");
    } catch (err: any) {
      expect(err).toBeInstanceOf(BrowserControlError);
      expect(err.status).toBe(504);
      expect(err.message).toContain("did not respond");
    }
  });

  it("handles abort signal cancellation", async () => {
    const controller = new AbortController();
    const broker = new BrowserControlBroker({
      emitRequest: () => 1,
      createId: () => "test-req-abort",
    });

    const promise = broker.request("browser.type", { selector: "input", value: "hello" }, { signal: controller.signal });
    controller.abort();

    try {
      await promise;
      expect.unreachable("Should have aborted");
    } catch (err: any) {
      expect(err).toBeInstanceOf(BrowserControlError);
      expect(err.status).toBe(499);
      expect(err.message).toBe("Browser action was cancelled");
    }
  });

  it("rejectAll clears pending requests with 503", async () => {
    const broker = new BrowserControlBroker({
      emitRequest: () => 1,
      createId: () => "test-req-shutdown",
    });

    const promise = broker.request("browser.open", { url: "http://example.com" });
    broker.rejectAll("Server shutting down");

    try {
      await promise;
      expect.unreachable("Should have rejected");
    } catch (err: any) {
      expect(err).toBeInstanceOf(BrowserControlError);
      expect(err.status).toBe(503);
      expect(err.message).toBe("Server shutting down");
    }
  });
});

describe("SSE browser control emission", () => {
  it("formats openchamber:browser-control-request data-only frame", () => {
    const formatted = formatOpenCodeEvent("openchamber:browser-control-request", {
      requestId: "req-123",
      action: "browser.open",
      parameters: { url: "http://localhost:3000" },
    });

    expect(formatted.startsWith("data: ")).toBe(true);
    expect(formatted.endsWith("\n\n")).toBe(true);
    const parsed = JSON.parse(formatted.slice(6).trim());
    expect(parsed.type).toBe("openchamber:browser-control-request");
    expect(parsed.properties.requestId).toBe("req-123");
    expect(parsed.properties.action).toBe("browser.open");
    expect(parsed.properties.parameters.url).toBe("http://localhost:3000");
  });

  it("delivers browser control request event to active SSE stream", async () => {
    const stream = createOpenCodeEventStream(process.cwd(), { browserCapable: true, isOpenChamber: true });
    const reader = stream.getReader();

    // Read initial openchamber:event-stream-ready frame
    const first = await reader.read();
    expect(first.done).toBe(false);
    const firstText = new TextDecoder().decode(first.value);
    expect(firstText).toContain("openchamber:event-stream-ready");

    // Emit browser control request
    const delivered = emitBrowserControlRequest({
      requestId: "req-live-1",
      action: "browser.snapshot",
      parameters: {},
    });
    expect(delivered).toBeGreaterThanOrEqual(1);

    // Read next event from stream
    const second = await reader.read();
    expect(second.done).toBe(false);
    const secondText = new TextDecoder().decode(second.value);
    expect(secondText).toContain("openchamber:browser-control-request");
    expect(secondText).toContain("req-live-1");

    await reader.cancel();
  });
});

describe("Browser control broker integration", () => {
  it("claims, resolves, and completes internal browser control request", async () => {
    const broker = new BrowserControlBroker({
      emitRequest: (req) => emitBrowserControlRequest(req),
      createId: () => "req-integ-1",
    });

    // Connect a mock SSE listener so broker has active listeners
    const stream = createOpenCodeEventStream(process.cwd(), { browserCapable: true, isOpenChamber: true });
    const reader = stream.getReader();

    // Consume the initial stream ready event
    await reader.read();

    // Start an internal request
    const requestPromise = broker.request(
      "browser.open",
      { url: "http://127.0.0.1:3000" },
      { timeoutMs: 5000 },
    );

    // Read the emitted SSE frame
    const frame = await reader.read();
    expect(frame.done).toBe(false);
    const frameText = new TextDecoder().decode(frame.value);
    expect(frameText).toContain("openchamber:browser-control-request");
    expect(frameText).toContain("req-integ-1");

    expect(broker.pendingCount).toBe(1);

    // Invalid claims rejected
    expect(broker.claim("test-nonexistent")).toBe(false);
    expect(broker.resolve("test-nonexistent", { ok: true })).toBe(false);

    // Valid claim and resolve
    expect(broker.claim("req-integ-1")).toBe(true);
    expect(
      broker.resolve("req-integ-1", {
        ok: true,
        data: { url: "http://127.0.0.1:3000", opened: true },
      }),
    ).toBe(true);

    const result = await requestPromise;
    expect(result).toEqual({ url: "http://127.0.0.1:3000", opened: true });

    await reader.cancel();
  });

  it("translates local file and file:// URLs to authenticated /api/fs/serve endpoint", async () => {
    let captured: BrowserControlRequest | null = null;
    const broker = new BrowserControlBroker({
      emitRequest: (req) => {
        captured = req;
        return 1;
      },
      createId: () => "req-file-1",
    });

    const promise = broker.request(
      "browser.open",
      { url: "file:///Users/alvin/claude-cowork/hangar5/index.html" },
      { baseDir: "/Users/alvin/claude-cowork/hangar5", port: 4096 },
    );

    expect(captured).not.toBeNull();
    expect(captured!.action).toBe("browser.open");
    expect(captured!.parameters.url).toBe(
      "http://127.0.0.1:4096/api/fs/serve/Users/alvin/claude-cowork/hangar5/index.html?oc_url_token=omp-local-url-token",
    );

    broker.resolve("req-file-1", {
      ok: true,
      data: { url: captured!.parameters.url, opened: true },
    });

    const res = await promise;
    expect(res).toEqual({
      url: "http://127.0.0.1:4096/api/fs/serve/Users/alvin/claude-cowork/hangar5/index.html?oc_url_token=omp-local-url-token",
      opened: true,
    });
  });

  it("translates relative HTML filenames using baseDir", async () => {
    let captured: BrowserControlRequest | null = null;
    const broker = new BrowserControlBroker({
      emitRequest: (req) => {
        captured = req;
        return 1;
      },
      createId: () => "req-file-2",
    });

    const promise = broker.request(
      "browser.open",
      { url: "index.html" },
      { baseDir: "/Users/test/my-project", port: 4096 },
    );

    expect(captured).not.toBeNull();
    expect(captured!.parameters.url).toBe(
      "http://127.0.0.1:4096/api/fs/serve/Users/test/my-project/index.html?oc_url_token=omp-local-url-token",
    );

    broker.resolve("req-file-2", { ok: true });
    await promise;
  });

  it("passes target directory in broker request and forwards to SSE event properties", async () => {
    let captured: BrowserControlRequest | null = null;
    const broker = new BrowserControlBroker({
      emitRequest: (req) => {
        captured = req;
        return emitBrowserControlRequest(req);
      },
      createId: () => "req-dir-1",
    });

    const stream = createOpenCodeEventStream("/Users/alvin/claude-cowork/hangar13", { browserCapable: true, isOpenChamber: true });
    const reader = stream.getReader();
    await reader.read(); // stream ready

    const promise = broker.request(
      "browser.open",
      { url: "http://localhost:3000" },
      { baseDir: "/Users/alvin/claude-cowork/hangar13" },
    );

    expect(captured).not.toBeNull();
    expect(captured!.directory).toBe("/Users/alvin/claude-cowork/hangar13");

    const frame = await reader.read();
    expect(frame.done).toBe(false);
    const frameText = new TextDecoder().decode(frame.value);
    const parsed = JSON.parse(frameText.replace(/^data:\s*/, "").trim());
    expect(parsed.properties.directory).toBe("/Users/alvin/claude-cowork/hangar13");
    expect(parsed.properties.parameters.directory).toBe("/Users/alvin/claude-cowork/hangar13");

    broker.resolve("req-dir-1", { ok: true, data: { opened: true } });
    await promise;
    await reader.cancel();
  });
});

describe("normalizeBrowserUrlForOpen", () => {
  it("leaves standard web and loopback URLs untouched", () => {
    expect(normalizeBrowserUrlForOpen("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeBrowserUrlForOpen("https://example.com/demo")).toBe("https://example.com/demo");
    expect(normalizeBrowserUrlForOpen("http://127.0.0.1:8377/index.html")).toBe("http://127.0.0.1:8377/index.html");
    expect(normalizeBrowserUrlForOpen("about:blank")).toBe("about:blank");
  });

  it("converts file:// URIs to /api/fs/serve URL", () => {
    const converted = normalizeBrowserUrlForOpen(
      "file:///Users/alvin/claude-cowork/hangar5/index.html",
      "/Users/alvin/claude-cowork/hangar5",
      4096,
    );
    expect(converted).toBe(
      "http://127.0.0.1:4096/api/fs/serve/Users/alvin/claude-cowork/hangar5/index.html?oc_url_token=omp-local-url-token",
    );
  });

  it("converts relative paths to /api/fs/serve URL using baseDir", () => {
    const converted = normalizeBrowserUrlForOpen("index.html", "/Users/alvin/workspace", 4096);
    expect(converted).toBe(
      "http://127.0.0.1:4096/api/fs/serve/Users/alvin/workspace/index.html?oc_url_token=omp-local-url-token",
    );
  });

  it("converts absolute filesystem paths to /api/fs/serve URL", () => {
    const converted = normalizeBrowserUrlForOpen("/tmp/preview.html", "/any/dir", 8080);
    expect(converted).toBe(
      "http://127.0.0.1:8080/api/fs/serve/tmp/preview.html?oc_url_token=omp-local-url-token",
    );
  });
});
