import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { ensureOmpBinary, getOmpRuntimeInfo, probeOmpVersion, resolveOmpBinary } from "./binary";

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

describe("resolveOmpBinary", () => {
  test("keeps OMP_BIN as the explicit override", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-binary-"));
    temporaryDirectories.push(directory);
    const explicit = executable(directory, "custom-omp");

    expect(resolveOmpBinary({ OMP_BIN: explicit })).toBe(explicit);
  });

  test("prefers the staged bundle over PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-binary-"));
    temporaryDirectories.push(directory);
    const bundledDirectory = join(directory, "bundled");
    const pathDirectory = join(directory, "path");
    mkdirSync(bundledDirectory, { recursive: true });
    mkdirSync(pathDirectory, { recursive: true });
    const bundled = executable(bundledDirectory);
    executable(pathDirectory);

    expect(resolveOmpBinary({ OMP_BUNDLED_DIR: bundledDirectory, PATH: pathDirectory })).toBe(bundled);
  });

  test("does not fall back to an installed OMP on PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-binary-"));
    temporaryDirectories.push(directory);
    executable(directory);

    expect(() => resolveOmpBinary({ OMP_BUNDLED_DIR: join(directory, "missing"), PATH: directory })).toThrow(
      "Project-owned OMP binary not found",
    );
  });

  test("ensures an already staged project-owned binary without consulting PATH", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-binary-"));
    temporaryDirectories.push(directory);
    const bundledDirectory = join(directory, "bundled");
    mkdirSync(bundledDirectory, { recursive: true });
    const bundled = executable(bundledDirectory);

    await expect(ensureOmpBinary({ OMP_BUNDLED_DIR: bundledDirectory, PATH: "/missing" })).resolves.toBe(bundled);
  });

  test("reports the version and source of an explicit OMP override", () => {
    const runtime = getOmpRuntimeInfo({ OMP_BIN: process.execPath });

    expect(runtime).toEqual({
      binary: process.execPath,
      version: null,
      source: "override",
    });
  });

  test("probes the version of an explicit OMP override", async () => {
    const version = await probeOmpVersion(process.execPath);

    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
