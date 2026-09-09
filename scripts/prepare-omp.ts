#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const repository = "can1357/oh-my-pi";
const scriptRoot = join(import.meta.dir, "..");
const outputDir = join(scriptRoot, "resources", "omp");
const cacheRoot = join(scriptRoot, ".cache", "omp");
const packagePath = join(scriptRoot, "package.json");
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

type OmpTarget = {
  id: string;
  asset: string;
  binary: string;
};

const targets: Record<string, OmpTarget> = {
  "darwin-arm64": { id: "darwin-arm64", asset: "omp-darwin-arm64", binary: "omp" },
  "darwin-x64": { id: "darwin-x64", asset: "omp-darwin-x64", binary: "omp" },
  "linux-arm64": { id: "linux-arm64", asset: "omp-linux-arm64", binary: "omp" },
  "linux-x64": { id: "linux-x64", asset: "omp-linux-x64", binary: "omp" },
  "linux-musl-arm64": { id: "linux-musl-arm64", asset: "omp-linux-musl-arm64", binary: "omp" },
  "linux-musl-x64": { id: "linux-musl-x64", asset: "omp-linux-musl-x64", binary: "omp" },
  "win32-x64": { id: "win32-x64", asset: "omp-windows-x64.exe", binary: "omp.exe" },
};

type PackageManifest = {
  ompVersion?: string;
};

function readConfiguredVersion(): string {
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as PackageManifest;
  const version = (Bun.env.OMP_VERSION || manifest.ompVersion || "").trim();
  if (!versionPattern.test(version)) {
    throw new Error(`Invalid OMP version: ${version || "(missing)"}`);
  }
  return version;
}

function resolveTarget(): OmpTarget {
  const requested = Bun.env.OMP_TARGET?.trim();
  if (requested) {
    const target = targets[requested];
    if (target) return target;
    throw new Error(`Unsupported OMP_TARGET: ${requested}`);
  }

  if (process.platform === "darwin") {
    if (process.arch !== "arm64" && process.arch !== "x64") {
      throw new Error(`Unsupported macOS architecture for OMP: ${process.arch}`);
    }
    return targets[`darwin-${process.arch}`];
  }

  if (process.platform === "linux") {
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
    if (!arch) throw new Error(`Unsupported Linux architecture for OMP: ${process.arch}`);
    const libc = Bun.env.OMP_LIBC === "musl" ? "-musl" : "";
    return targets[`linux${libc}-${arch}`];
  }

  if (process.platform === "win32") {
    if (process.arch !== "x64" && process.arch !== "arm64") {
      throw new Error(`Unsupported Windows architecture for OMP: ${process.arch}`);
    }
    return targets["win32-x64"];
  }

  throw new Error(`Unsupported platform for OMP: ${process.platform}`);
}

function readBinaryVersion(binaryPath: string): string | null {
  if (!existsSync(binaryPath)) return null;
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    windowsHide: true,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;
}

function ensureExecutable(filePath: string): void {
  if (process.platform !== "win32") chmodSync(filePath, 0o755);
}

function removeFile(filePath: string): void {
  if (existsSync(filePath)) unlinkSync(filePath);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

async function download(url: string, destination: string): Promise<void> {
  mkdirSync(join(destination, ".."), { recursive: true });
  console.log(`[sidecar] OMP download: connecting to release server`);
  const startedAt = Date.now();
  const waitingTimer = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    console.log(`[sidecar] OMP download: waiting for release server (${elapsedSeconds}s)`);
  }, 5_000);

  let response: Response;
  try {
    response = await fetch(url);
  } finally {
    clearInterval(waitingTimer);
  }
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  if (!response.body) throw new Error(`Failed to download ${url}: response has no body`);

  const tempPath = `${destination}.tmp-${process.pid}`;
  const totalBytesHeader = response.headers.get("content-length");
  const totalBytes = totalBytesHeader ? Number.parseInt(totalBytesHeader, 10) : 0;
  const reader = response.body.getReader();
  let fileDescriptor = -1;
  let receivedBytes = 0;
  let lastReportedPercent = -1;
  let lastReportedBytes = 0;

  const reportProgress = (force = false): void => {
    if (totalBytes > 0) {
      const percent = Math.min(100, Math.floor((receivedBytes / totalBytes) * 100));
      if (percent === lastReportedPercent) return;
      if (!force && percent % 5 !== 0) return;
      lastReportedPercent = percent;
      console.log(`[sidecar] OMP download: ${percent}% (${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)})`);
      return;
    }

    if (!force && receivedBytes - lastReportedBytes < 10 * 1024 * 1024) return;
    lastReportedBytes = receivedBytes;
    console.log(`[sidecar] OMP download: ${formatBytes(receivedBytes)}`);
  };

  try {
    fileDescriptor = openSync(tempPath, "w");
    console.log(
      `[sidecar] OMP download: receiving${totalBytes > 0 ? ` ${formatBytes(totalBytes)}` : ""}`,
    );
    reportProgress();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      let offset = 0;
      while (offset < value.byteLength) {
        offset += writeSync(fileDescriptor, value, offset, value.byteLength - offset);
      }
      receivedBytes += value.byteLength;
      reportProgress();
    }
    reportProgress(true);
    closeSync(fileDescriptor);
    fileDescriptor = -1;
    ensureExecutable(tempPath);
    renameSync(tempPath, destination);
  } catch (error) {
    if (fileDescriptor !== -1) closeSync(fileDescriptor);
    removeFile(tempPath);
    throw error;
  }
}

function metadataPath(): string {
  return join(outputDir, "omp.json");
}

function readMetadata(filePath: string): { version?: string; target?: string } | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as { version?: string; target?: string };
  } catch {
    return null;
  }
}

function stageMatches(binaryPath: string, version: string, target: OmpTarget, metadataFile?: string): boolean {
  if (readBinaryVersion(binaryPath) !== version) return false;
  const metadata = metadataFile ? readMetadata(metadataFile) : null;
  return !metadata || (metadata.version === version && metadata.target === target.id);
}

function verify(binaryPath: string, version: string, target: OmpTarget): void {
  if (!stageMatches(binaryPath, version, target, metadataPath())) {
    throw new Error(`Staged OMP binary is missing or does not match ${version} (${target.id}): ${binaryPath}`);
  }
  console.log(`[sidecar] verified bundled OMP ${version} (${target.id}): ${binaryPath}`);
}

export async function prepareOmp(options: { verify?: boolean } = {}): Promise<string> {
  const version = readConfiguredVersion();
  const target = resolveTarget();
  const outputBinary = join(outputDir, target.binary);

  if (options.verify) {
    verify(outputBinary, version, target);
    return outputBinary;
  }

  if (stageMatches(outputBinary, version, target)) {
    console.log(`[sidecar] bundled OMP already prepared: ${outputBinary} (${version})`);
    return outputBinary;
  }

  const cacheDir = join(cacheRoot, version, target.id);
  const cachedBinary = join(cacheDir, target.asset);
  const cachedMetadata = join(cacheDir, "omp.json");
  const url = `https://github.com/${repository}/releases/download/v${version}/${target.asset}`;
  if (!stageMatches(cachedBinary, version, target, cachedMetadata)) {
    console.log(`[sidecar] downloading OMP ${version}: ${target.asset}`);
    await download(url, cachedBinary);
    if (readBinaryVersion(cachedBinary) !== version) {
      throw new Error(`Downloaded OMP binary does not report version ${version}: ${cachedBinary}`);
    }
    writeFileSync(cachedMetadata, `${JSON.stringify({ version, target: target.id, asset: target.asset }, null, 2)}\n`);
  } else {
    console.log(`[sidecar] using cached OMP binary: ${cachedBinary}`);
  }

  mkdirSync(outputDir, { recursive: true });
  removeFile(join(outputDir, "omp"));
  removeFile(join(outputDir, "omp.exe"));
  removeFile(metadataPath());

  const tempOutput = `${outputBinary}.tmp-${process.pid}`;
  try {
    copyFileSync(cachedBinary, tempOutput);
    ensureExecutable(tempOutput);
    renameSync(tempOutput, outputBinary);
    writeFileSync(metadataPath(), `${JSON.stringify({ version, target: target.id, asset: target.asset }, null, 2)}\n`);
  } catch (error) {
    removeFile(tempOutput);
    throw error;
  }

  verify(outputBinary, version, target);
  return outputBinary;
}

if (import.meta.main) await prepareOmp({ verify: process.argv.includes("--verify") });
