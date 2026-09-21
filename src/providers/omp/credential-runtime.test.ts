import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createOmpCredentialRuntime } from "./credential-runtime";

const runtimes: Array<{ cleanup(): Promise<void> }> = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cleanup();
});

describe("ephemeral OMP credential runtime", () => {
  test("writes provider config outside the user's OMP directory and cleans it up", async () => {
    const runtime = await createOmpCredentialRuntime({
      providerID: "vllm",
      apiKey: "secret-do-not-log",
      baseUrl: "http://127.0.0.1:8080/v1",
      headers: { "X-Test": "one" },
    });
    runtimes.push(runtime);

    const modelsPath = join(runtime.agentDir, "models.yml");
    expect(runtime.env).toEqual({ PI_CODING_AGENT_DIR: runtime.agentDir });
    expect(existsSync(modelsPath)).toBe(true);
    expect(JSON.parse(readFileSync(modelsPath, "utf8"))).toEqual({
      providers: {
        vllm: {
          apiKey: "secret-do-not-log",
          baseUrl: "http://127.0.0.1:8080/v1",
          headers: { "X-Test": "one" },
        },
      },
    });

    await runtime.cleanup();
    expect(existsSync(runtime.agentDir)).toBe(false);
  });
});

