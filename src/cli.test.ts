import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { parseCliArgs } from "./cli";

const temporaryDirectories: string[] = [];

function executable(directory: string, name = "omp"): string {
  const filePath = join(directory, name);
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  chmodSync(filePath, 0o755);
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseCliArgs", () => {
  test("returns empty options with no args", () => {
    const opts = parseCliArgs([]);
    expect(opts).toEqual({
      binary: undefined,
      port: undefined,
      help: false,
    });
  });

  test("parses --binary <path>", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-test-"));
    temporaryDirectories.push(dir);
    const bin = executable(dir, "custom-omp");

    const opts = parseCliArgs(["--binary", bin]);
    expect(opts.binary).toBe(bin);
  });

  test("parses -b <path>", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-test-"));
    temporaryDirectories.push(dir);
    const bin = executable(dir, "custom-omp");

    const opts = parseCliArgs(["-b", bin]);
    expect(opts.binary).toBe(bin);
  });

  test("parses --omp-bin <path>", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-test-"));
    temporaryDirectories.push(dir);
    const bin = executable(dir, "custom-omp");

    const opts = parseCliArgs(["--omp-bin", bin]);
    expect(opts.binary).toBe(bin);
  });

  test("parses --omp-binary <path>", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-test-"));
    temporaryDirectories.push(dir);
    const bin = executable(dir, "custom-omp");

    const opts = parseCliArgs(["--omp-binary", bin]);
    expect(opts.binary).toBe(bin);
  });

  test("handles --binary=value syntax", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-test-"));
    temporaryDirectories.push(dir);
    const bin = executable(dir, "custom-omp");

    const opts = parseCliArgs([`--binary=${bin}`]);
    expect(opts.binary).toBe(bin);
  });

  test("strips leading '--' from bun/npm run start forwarding", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-test-"));
    temporaryDirectories.push(dir);
    const bin = executable(dir, "custom-omp");

    const opts = parseCliArgs(["--", "--binary", bin]);
    expect(opts.binary).toBe(bin);
  });

  test("parses --port and -p", () => {
    expect(parseCliArgs(["--port", "4099"]).port).toBe(4099);
    expect(parseCliArgs(["-p", "5000"]).port).toBe(5000);
  });

  test("rejects invalid port values", () => {
    expect(() => parseCliArgs(["--port", "not-a-number"])).toThrow("Invalid port");
    expect(() => parseCliArgs(["--port", "0"])).toThrow("Invalid port");
    expect(() => parseCliArgs(["--port", "70000"])).toThrow("Invalid port");
  });

  test("parses --help and -h", () => {
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(parseCliArgs(["-h"]).help).toBe(true);
  });

  test("throws when specified binary does not exist", () => {
    expect(() => parseCliArgs(["--binary", "/non/existent/path/to/omp"])).toThrow("Specified OMP binary does not exist");
  });
});
