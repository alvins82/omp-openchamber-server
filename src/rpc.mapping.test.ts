import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  embeddedOmpConfigOverlay,
  getCurrentModel,
  mapRpcModelsToOpenCodeProviders,
  type OmpRpcModel,
} from "./rpc";

describe("mapRpcModelsToOpenCodeProviders", () => {
  test("groups models by provider in first-seen order", () => {
    const models: OmpRpcModel[] = [
      { provider: "vllm", id: "a", name: "A" },
      { provider: "openai", id: "b", name: "B" },
      { provider: "vllm", id: "c", name: "C" },
    ];
    const res = mapRpcModelsToOpenCodeProviders(models);
    expect(res.providers.map((p) => p.id)).toEqual(["vllm", "openai"]);
    expect(res.providers[0].models).toHaveProperty("a");
    expect(res.providers[0].models).toHaveProperty("c");
    expect(res.providers[1].models).toHaveProperty("b");
  });

  test("maps contextWindow/maxTokens onto limit and transforms capabilities and modalities", () => {
    const models: OmpRpcModel[] = [
      {
        provider: "vllm",
        id: "qwen",
        name: "Qwen",
        contextWindow: 32768,
        maxTokens: 4096,
        reasoning: true,
        supportsToolCall: true,
        supportsAttachment: false,
        input: ["text", "image"],
      },
    ];
    const res = mapRpcModelsToOpenCodeProviders(models);
    const m = res.providers[0].models.qwen;
    expect(m).toEqual({
      id: "qwen",
      name: "Qwen",
      providerID: "vllm",
      limit: { context: 32768, output: 4096 },
      reasoning: true,
      tool_call: true,
      attachment: false,
      capabilities: {
        input: {
          text: true,
          image: true,
          audio: false,
          video: false,
          pdf: false,
        },
        toolcall: true,
        attachment: false,
        reasoning: true,
      },
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      variants: {
        none: {},
        low: {},
        medium: {},
        high: {},
        xhigh: {},
      },
    });
  });

  test("infers attachment and modalities for vision-capable models", () => {
    const models: OmpRpcModel[] = [
      {
        provider: "llama.cpp",
        id: "qwen3.8-27b",
        name: "Qwen3.8-27B",
        input: ["text", "image"],
      },
    ];
    const res = mapRpcModelsToOpenCodeProviders(models);
    const m = res.providers[0].models["qwen3.8-27b"];
    expect(m.attachment).toBe(true);
    expect(m.modalities).toEqual({
      input: ["text", "image"],
      output: ["text"],
    });
    expect(m.capabilities?.input).toEqual({
      text: true,
      image: true,
      audio: false,
      video: false,
      pdf: false,
    });
  });

  test("omits limit and capabilities when the source has none", () => {
    const models: OmpRpcModel[] = [{ provider: "vllm", id: "small", name: "Small" }];
    const res = mapRpcModelsToOpenCodeProviders(models);
    const m = res.providers[0].models.small;
    expect(m.limit).toBeUndefined();
    expect(m.capabilities).toBeUndefined();
    expect(m.tool_call).toBeUndefined();
    expect(m.reasoning).toBe(true);
  });

  test("picks the current provider as default, falling back to the first", () => {
    const models: OmpRpcModel[] = [
      { provider: "p1", id: "a", name: "A" },
      { provider: "p2", id: "b", name: "B" },
    ];
    expect(mapRpcModelsToOpenCodeProviders(models, "p2").default.default).toBe("p2");
    expect(mapRpcModelsToOpenCodeProviders(models).default.default).toBe("p1");
    expect(mapRpcModelsToOpenCodeProviders(models, "missing").default.default).toBe("p1");
  });

  test("returns empty providers and an empty default for no models", () => {
    const res = mapRpcModelsToOpenCodeProviders([], "whatever");
    expect(res.providers).toEqual([]);
    expect(res.default.default).toBe("");
  });
});

describe("getCurrentModel", () => {
  // Minimal fake of the transport surface getCurrentModel needs:
  // `request("get_state")` resolves with a canned state.
  const fake = (state: unknown) => ({
    request: (_method: string, _params?: unknown) => Promise.resolve(state),
  });

  test("extracts provider, model and variant from get_state", async () => {
    const state = { model: { provider: "vllm", id: "qwen3.8-27b", variant: "thinking" } };
    await expect(getCurrentModel(fake(state))).resolves.toEqual({
      providerID: "vllm",
      modelID: "qwen3.8-27b",
      variant: "thinking",
    });
  });

  test("returns undefined when state is not an object", async () => {
    await expect(getCurrentModel(fake(null))).resolves.toBeUndefined();
    await expect(getCurrentModel(fake("nope"))).resolves.toBeUndefined();
  });

  test("returns undefined when model is absent or not an object", async () => {
    await expect(getCurrentModel(fake({}))).resolves.toBeUndefined();
    await expect(getCurrentModel(fake({ model: "x" }))).resolves.toBeUndefined();
    await expect(getCurrentModel(fake({ model: null }))).resolves.toBeUndefined();
  });

  test("leaves out non-string fields instead of leaking them", async () => {
    const state = { model: { provider: 42, id: "m", variant: { deep: true } } };
    await expect(getCurrentModel(fake(state))).resolves.toEqual({
      modelID: "m",
    });
  });
});

describe("embeddedOmpConfigOverlay", () => {
  test("returns a stable config.yml path in tmpdir that disables project MCP", () => {
    const a = embeddedOmpConfigOverlay();
    const b = embeddedOmpConfigOverlay();
    expect(a).toBe(b);
    expect(a.endsWith(join("oc-omp-embedded", "config.yml"))).toBe(true);
    const content = readFileSync(a, "utf8");
    expect(content).toContain("enableProjectConfig: false");
    expect(content).toContain("enabled: false");
  });
});
