import { accessSync, chmodSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

type Environment = Record<string, string | undefined>;

export type OmpRuntimeSource = "override" | "bundled" | "unavailable";
export type OmpRuntimeInfo = {
  binary: string | null;
  version: string | null;
  source: OmpRuntimeSource;
};

const bundledBinaryName = process.platform === "win32" ? "omp.exe" : "omp";
const versionProbeTimeoutMs = 1_000;

let explicitOmpBinaryOverride: string | null = null;

export function setExplicitOmpBinary(binaryPath: string | null): void {
  if (binaryPath) {
    const validated = validateOmpBinary(binaryPath);
    explicitOmpBinaryOverride = validated;
    process.env.OMP_BIN = validated;
    Bun.env.OMP_BIN = validated;
  } else {
    explicitOmpBinaryOverride = null;
    delete process.env.OMP_BIN;
    delete Bun.env.OMP_BIN;
  }
}

export function getExplicitOmpBinary(): string | null {
  return explicitOmpBinaryOverride;
}

export function validateOmpBinary(binaryPath: string): string {
  const trimmed = binaryPath.trim();
  if (!trimmed) {
    throw new Error("OMP binary path cannot be empty.");
  }
  const resolved = resolvePath(process.cwd(), trimmed);
  if (!existsSync(resolved)) {
    throw new Error(`Specified OMP binary does not exist: ${resolved}`);
  }
  const s = statSync(resolved);
  if (!s.isFile()) {
    throw new Error(`Specified OMP binary is not a file: ${resolved}`);
  }
  if (!isExecutable(resolved)) {
    if (process.platform !== "win32") {
      try {
        chmodSync(resolved, 0o755);
      } catch {
        // ignore
      }
    }
    if (!isExecutable(resolved)) {
      throw new Error(`Specified OMP binary is not executable: ${resolved}`);
    }
  }
  return resolved;
}

function isExecutable(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((value): value is string => Boolean(value && value.trim())))];
}

function bundledCandidates(env: Environment): string[] {
  const executableDir = dirname(process.execPath);
  const configured = uniquePaths([
    env.OMP_BUNDLED_PATH,
    env.OMP_BUNDLED_DIR ? join(env.OMP_BUNDLED_DIR, bundledBinaryName) : undefined,
  ]);
  if (configured.length > 0) return configured;

  return uniquePaths([
    join(import.meta.dir, "..", "..", "..", "resources", "omp", bundledBinaryName),
    join(executableDir, "resources", "omp", bundledBinaryName),
    process.platform === "darwin"
      ? join(executableDir, "..", "Resources", "omp", bundledBinaryName)
      : undefined,
  ]);
}

function currentEnvironment(): Environment {
  return {
    ...Bun.env,
    ...process.env,
    ...(explicitOmpBinaryOverride ? { OMP_BIN: explicitOmpBinaryOverride } : {}),
  };
}

function sourceForBinary(binaryPath: string, env: Environment): OmpRuntimeSource {
  if (env.OMP_BIN?.trim()) return "override";

  const resolvedBinary = resolvePath(binaryPath);
  const isBundled = bundledCandidates(env).some((candidate) => resolvePath(candidate) === resolvedBinary);
  return isBundled ? "bundled" : "override";
}

function readBundledVersion(binaryPath: string, env: Environment): string | null {
  const bundledBinary = bundledCandidates(env).find((candidate) => resolvePath(candidate) === resolvePath(binaryPath));
  if (!bundledBinary) return null;

  try {
    return readFileSync(join(dirname(bundledBinary), "omp.json"), "utf8").match(/"version"\s*:\s*"([^"]+)"/)?.[1] || null;
  } catch {
    return null;
  }
}

function readConfiguredVersion(env: Environment): string | null {
  const explicit = env.OMP_VERSION?.trim();
  if (explicit) return explicit;

  try {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "..", "package.json"), "utf8"),
    ) as { ompVersion?: unknown };
    return typeof manifest.ompVersion === "string" && manifest.ompVersion.trim()
      ? manifest.ompVersion.trim()
      : null;
  } catch {
    return null;
  }
}

function hasExplicitBundleLocation(env: Environment): boolean {
  return Boolean(env.OMP_BUNDLED_PATH?.trim() || env.OMP_BUNDLED_DIR?.trim());
}

function bundledNeedsPreparation(binaryPath: string, env: Environment): boolean {
  // Explicit bundle locations are used by tests and local development. Leave
  // their lifecycle under the caller's control rather than rewriting them
  // from the sidecar source tree.
  if (hasExplicitBundleLocation(env)) return false;

  const configuredVersion = readConfiguredVersion(env);
  return configuredVersion !== null && readBundledVersion(binaryPath, env) !== configuredVersion;
}

function readProcessOutput(stream: Bun.Subprocess["stdout"]): Promise<string> {
  if (stream === undefined || typeof stream === "number") return Promise.resolve("");
  return new Response(stream).text();
}

/**
 * Resolve the OMP executable used by the sidecar.
 *
 * The sidecar only uses the project-owned staged binary. OMP_BIN remains an
 * explicit override for tests and local development; it is never inferred
 * from PATH or from a system-wide installation.
 */
export function resolveOmpBinary(env: Environment = currentEnvironment()): string {
  const explicit = env.OMP_BIN?.trim();
  if (explicit) return explicit;

  const bundled = bundledCandidates(env).find(isExecutable);
  if (bundled) return bundled;

  throw new Error(
    "Project-owned OMP binary not found. Start the sidecar again to let it download automatically, or run `bun run prepare:omp` manually.",
  );
}

let ensurePromise: Promise<string> | undefined;

/**
 * Ensure the project-owned OMP release is staged before the sidecar serves
 * requests. Startup validates the staged binary against the configured
 * package pin and prepares that exact release when the pin has changed or the
 * binary is missing.
 */
export function ensureOmpBinary(env: Environment = currentEnvironment()): Promise<string> {
  const explicit = env.OMP_BIN?.trim();
  if (explicit) return Promise.resolve(explicit);

  const bundled = bundledCandidates(env).find(isExecutable);
  if (bundled && !bundledNeedsPreparation(bundled, env)) return Promise.resolve(bundled);

  ensurePromise ??= (async () => {
    try {
      const { prepareOmp } = await import("../../../scripts/prepare-omp");
      await prepareOmp();
      return resolveOmpBinary(env);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Project-owned OMP binary is unavailable. Automatic download failed: ${detail}. Run \`bun run prepare:omp\` and retry.`,
      );
    }
  })();

  return ensurePromise;
}

/**
 * Return the version known for the same OMP executable the sidecar will spawn.
 *
 * Bundled binaries carry metadata written by prepare:omp. Explicit overrides
 * can be probed asynchronously with probeOmpVersion so startup stays responsive.
 */
export function getOmpRuntimeInfo(env: Environment = currentEnvironment()): OmpRuntimeInfo {
  try {
    const binary = resolveOmpBinary(env);
    const source = sourceForBinary(binary, env);
    return {
      binary,
      version: source === "bundled" ? readBundledVersion(binary, env) : null,
      source,
    };
  } catch {
    return { binary: null, version: null, source: "unavailable" };
  }
}

/**
 * Probe an OMP executable without blocking the sidecar's startup path.
 */
export async function probeOmpVersion(binaryPath: string): Promise<string | null> {
  let child: Bun.Subprocess | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    child = Bun.spawn([binaryPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });

    const output = await Promise.race([
      Promise.all([
        readProcessOutput(child.stdout),
        readProcessOutput(child.stderr),
        child.exited,
      ]).then(([stdout, stderr]) => `${stdout}\n${stderr}`),
      new Promise<string | null>((resolve) => {
        timeout = setTimeout(() => resolve(null), versionProbeTimeoutMs);
      }),
    ]);

    if (output === null) {
      child.kill();
      await child.exited;
      return null;
    }

    return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;
  } catch {
    child?.kill();
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
