import { describe, test, expect } from "bun:test";

describe("logger formatting and level filtering", () => {
  test("INFO, WARN, and ERROR messages are logged by default with pino-pretty formatting", async () => {
    const proc = Bun.spawn([
      "bun",
      "-e",
      `
      import { logger, httpLogger, promptLogger } from "./src/logger";
      logger.info("info_msg_emitted");
      logger.warn("warn_msg_emitted");
      httpLogger.info("http_info_emitted");
      promptLogger.warn("prompt_warn_emitted");
      logger.debug("debug_msg_suppressed");
      logger.error("error_msg_emitted");
      httpLogger.debug("http_debug_suppressed");
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

    expect(output).toContain("info_msg_emitted");
    expect(output).toContain("warn_msg_emitted");
    expect(output).toContain("http_info_emitted");
    expect(output).toContain("prompt_warn_emitted");
    expect(output).toContain("error_msg_emitted");
    expect(output).toContain("http_error_emitted");

    // debug messages are suppressed under default 'info' level
    expect(output).not.toContain("debug_msg_suppressed");
    expect(output).not.toContain("http_debug_suppressed");

    // pino-pretty formatting includes level tags
    expect(output).toContain("INFO");
    expect(output).toContain("WARN");
    expect(output).toContain("ERROR");
  });

  test("DEBUG messages are emitted when LOG_LEVEL=debug", async () => {
    const proc = Bun.spawn([
      "bun",
      "-e",
      `
      import { logger, httpLogger } from "./src/logger";
      logger.debug("debug_msg_allowed");
      httpLogger.debug("http_debug_allowed");
      `,
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LOG_LEVEL: "debug" },
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = stdout + stderr;

    expect(output).toContain("debug_msg_allowed");
    expect(output).toContain("http_debug_allowed");
    expect(output).toContain("DEBUG");
  });
});
