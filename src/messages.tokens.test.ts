import { describe, expect, it } from "bun:test";
import { mapOmpUsageToTokens } from "./messages";

describe("mapOmpUsageToTokens", () => {
  it("maps vLLM cold turn with prompt_tokens_details (created_cache_tokens)", () => {
    const rawUsage = {
      prompt_tokens: 3026,
      completion_tokens: 10,
      prompt_tokens_details: {
        cached_tokens: 0,
        created_cache_tokens: 1920,
        multimodal_tokens: null,
      },
    };

    const { tokens, cost } = mapOmpUsageToTokens(rawUsage);
    expect(tokens).toEqual({
      input: 1106, // 3026 - 0 - 1920
      output: 10,
      reasoning: 0,
      cache: {
        read: 0,
        write: 1920,
      },
    });
    expect(cost).toBe(0);
  });

  it("maps vLLM warm turn with prompt_tokens_details (cached_tokens)", () => {
    const rawUsage = {
      prompt_tokens: 3026,
      completion_tokens: 10,
      prompt_tokens_details: {
        cached_tokens: 1920,
        created_cache_tokens: 0,
        multimodal_tokens: null,
      },
    };

    const { tokens, cost } = mapOmpUsageToTokens(rawUsage);
    expect(tokens).toEqual({
      input: 1106, // 3026 - 1920 - 0
      output: 10,
      reasoning: 0,
      cache: {
        read: 1920,
        write: 0,
      },
    });
    expect(cost).toBe(0);
  });

  it("maps top-level created_cache_tokens and cached_tokens", () => {
    const rawUsage = {
      prompt_tokens: 2500,
      completion_tokens: 150,
      cached_tokens: 1000,
      created_cache_tokens: 500,
    };

    const { tokens } = mapOmpUsageToTokens(rawUsage);
    expect(tokens).toEqual({
      input: 1000, // 2500 - 1000 - 500
      output: 150,
      reasoning: 0,
      cache: {
        read: 1000,
        write: 500,
      },
    });
  });

  it("maps OpenRouter cache_write_tokens and cached_tokens", () => {
    const rawUsage = {
      prompt_tokens: 6000,
      completion_tokens: 250,
      prompt_tokens_details: {
        cached_tokens: 200,
        cache_write_tokens: 5000,
      },
    };

    const { tokens } = mapOmpUsageToTokens(rawUsage);
    expect(tokens).toEqual({
      input: 800, // 6000 - 200 - 5000
      output: 250,
      reasoning: 0,
      cache: {
        read: 200,
        write: 5000,
      },
    });
  });

  it("maps Anthropic cache_creation_input_tokens and cache_read_input_tokens", () => {
    const rawUsage = {
      input_tokens: 500,
      output_tokens: 100,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 2000,
    };

    const { tokens } = mapOmpUsageToTokens(rawUsage);
    expect(tokens).toEqual({
      input: 500,
      output: 100,
      reasoning: 0,
      cache: {
        read: 3000,
        write: 2000,
      },
    });
  });

  it("maps DeepSeek prompt_cache_hit_tokens and prompt_cache_miss_tokens", () => {
    const rawUsage = {
      prompt_tokens: 150,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 100,
      prompt_cache_miss_tokens: 50,
    };

    const { tokens } = mapOmpUsageToTokens(rawUsage);
    expect(tokens).toEqual({
      input: 0, // 150 - 100 - 50
      output: 200,
      reasoning: 0,
      cache: {
        read: 100,
        write: 50,
      },
    });
  });

  it("extracts reasoning tokens from completion_tokens_details", () => {
    const rawUsage = {
      input: 500,
      output: 300,
      completion_tokens_details: {
        reasoning_tokens: 120,
      },
      cacheRead: 200,
      cacheWrite: 0,
    };

    const { tokens } = mapOmpUsageToTokens(rawUsage);
    expect(tokens).toEqual({
      input: 500,
      output: 300,
      reasoning: 120,
      cache: {
        read: 200,
        write: 0,
      },
    });
  });

  it("prefers explicit input over prompt_tokens calculation", () => {
    const rawUsage = {
      input: 1106,
      prompt_tokens: 3026,
      output: 10,
      cacheRead: 1920,
      cacheWrite: 0,
    };

    const { tokens } = mapOmpUsageToTokens(rawUsage);
    expect(tokens.input).toBe(1106);
    expect(tokens.cache.read).toBe(1920);
  });

  it("returns fallback zeros on null or undefined rawUsage", () => {
    expect(mapOmpUsageToTokens(null)).toEqual({
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    });
    expect(mapOmpUsageToTokens(undefined, 0.05)).toEqual({
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.05,
    });
  });
});
