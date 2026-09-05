import { describe, expect, test } from "bun:test";
import {
  parseModelRef,
  getProviderCandidates,
  resolveSmallModel,
  describeSmallModel,
  generateSmallModelText,
} from "./small-model";

describe("Small Model Resolver & Generation", () => {
  test("parseModelRef parses provider and model correctly", () => {
    expect(parseModelRef("syv-vllm/qwen3.8-27b")).toEqual({
      providerID: "syv-vllm",
      modelID: "qwen3.8-27b",
    });
    expect(parseModelRef("openai/gpt-4o-mini")).toEqual({
      providerID: "openai",
      modelID: "gpt-4o-mini",
    });
    expect(parseModelRef("invalid")).toBeNull();
    expect(parseModelRef("")).toBeNull();
    expect(parseModelRef(null)).toBeNull();
    expect(parseModelRef(undefined)).toBeNull();
  });

  test("getProviderCandidates maps provider aliases", () => {
    expect(getProviderCandidates("syv-vllm")).toContain("vllm");
    expect(getProviderCandidates("vllm")).toContain("syv-vllm");
    expect(getProviderCandidates("openai")).toEqual(["openai"]);
  });

  test("resolveSmallModel respects explicit request model", () => {
    const resolved = resolveSmallModel({ model: "openai/custom-small" });
    expect(resolved).toEqual({
      providerID: "openai",
      modelID: "custom-small",
      source: "request",
    });
  });

  test("describeSmallModel returns expected contract shape", async () => {
    const desc = await describeSmallModel({ model: "vllm/qwen3.8-27b" });
    expect(desc).not.toBeNull();
    expect(desc?.providerID).toBe("vllm");
    expect(desc?.modelID).toBe("qwen3.8-27b");
    expect(desc?.source).toBe("request");
    expect(typeof desc?.hasLogin).toBe("boolean");
    expect(typeof desc?.inputCharBudget).toBe("number");
    expect(typeof desc?.contextTokens).toBe("number");
    expect(desc?.outputTokens).toBe(400);
  });

  test("generateSmallModelText rejects empty or whitespace-only prompt", async () => {
    expect(generateSmallModelText({ prompt: "" })).rejects.toThrow("prompt is required");
    expect(generateSmallModelText({ prompt: "   " })).rejects.toThrow("prompt is required");
  });

  test("generateSmallModelText successfully calls an OpenAI-compatible mock server", async () => {
    let receivedAuth = "";
    let receivedBody: unknown = null;

    const mockServer = Bun.serve({
      port: 0,
      async fetch(req) {
        receivedAuth = req.headers.get("authorization") || "";
        receivedBody = await req.json();
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Investigating build failure in CI.",
              },
            },
          ],
        });
      },
    });

    try {
      const origEnv = process.env.OPENAI_API_KEY;
      const origBase = process.env.OPENAI_BASE_URL;
      process.env.OPENAI_API_KEY = "test-mock-key";
      process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mockServer.port}/v1`;

      const result = await generateSmallModelText({
        model: "openai/mock-model",
        prompt: "What is happening now?",
        system: "You are a progress reporter.",
      });

      expect(result.text).toBe("Investigating build failure in CI.");
      expect(result.providerID).toBe("openai");
      expect(result.modelID).toBe("mock-model");
      expect(result.source).toBe("request");
      expect(receivedAuth).toBe("Bearer test-mock-key");
      expect((receivedBody as { model?: string })?.model).toBe("mock-model");

      if (origEnv) process.env.OPENAI_API_KEY = origEnv;
      else delete process.env.OPENAI_API_KEY;
      if (origBase) process.env.OPENAI_BASE_URL = origBase;
      else delete process.env.OPENAI_BASE_URL;
    } finally {
      mockServer.stop(true);
    }
  });

  test("generateSmallModelText extracts reasoning when content is empty", async () => {
    const mockServer = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                reasoning_content: "Refactoring test structure.",
              },
            },
          ],
        });
      },
    });

    try {
      const origEnv = process.env.OPENAI_API_KEY;
      const origBase = process.env.OPENAI_BASE_URL;
      process.env.OPENAI_API_KEY = "test-mock-key";
      process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mockServer.port}/v1`;

      const result = await generateSmallModelText({
        model: "openai/reasoning-model",
        prompt: "Summarize status",
      });

      expect(result.text).toBe("Refactoring test structure.");

      if (origEnv) process.env.OPENAI_API_KEY = origEnv;
      else delete process.env.OPENAI_API_KEY;
      if (origBase) process.env.OPENAI_BASE_URL = origBase;
      else delete process.env.OPENAI_BASE_URL;
    } finally {
      mockServer.stop(true);
    }
  });

  test("resolveSmallModel does not return hardcoded fallback models", () => {
    // When non-existent directory and preferred options are given that don't match any provider
    const resolved = resolveSmallModel({
      directory: "/nonexistent/test/directory",
      preferredProviderID: "nonexistent-provider",
      preferredModelID: "nonexistent-model",
    });
    // Should return null (or whatever user config actually matched), never a hardcoded default
    if (resolved) {
      expect(resolved.source).not.toBe("default" as any);
    }
  });
});
