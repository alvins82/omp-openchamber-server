import { describe, test, expect } from "bun:test";

describe("logger level filtering", () => {
  test("only ERROR and DEBUG messages are logged by default", async () => {
    const proc = Bun.spawn([
      "bun",
      "-e",
      `
      import { logger, httpLogger, promptLogger } from "./src/logger";
      logger.info("info_msg_suppressed");
      logger.warn("warn_msg_suppressed");
      httpLogger.info("http_info_suppressed");
      promptLogger.warn("prompt_warn_suppressed");
      logger.debug("debug_msg_emitted");
      logger.error("error_msg_emitted");
      httpLogger.debug("http_debug_emitted");
      httpLogger.error("http_error_emitted");
      `,
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = stdout + stderr;

    expect(output).not.toContain("info_msg_suppressed");
    expect(output).not.toContain("warn_msg_suppressed");
    expect(output).not.toContain("http_info_suppressed");
    expect(output).not.toContain("prompt_warn_suppressed");

    expect(output).toContain("debug_msg_emitted");
    expect(output).toContain("error_msg_emitted");
    expect(output).toContain("http_debug_emitted");
    expect(output).toContain("http_error_emitted");
  });
});
