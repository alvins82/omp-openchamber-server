import { logger } from "../../logger";
import { getOmpRuntimeInfo } from "./binary";

const ompRepository = "can1357/oh-my-pi";
const latestReleaseUrl = `https://api.github.com/repos/${ompRepository}/releases/latest`;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const updateCheckTimeoutMs = 5_000;

/** How often the sidecar checks for a newer OMP release. */
export const OMP_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

export type OmpUpdateCheckResult = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
};

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function releaseVersion(value: unknown): string | null {
  if (!isRecord(value) || typeof value.tag_name !== "string") return null;
  const version = value.tag_name.trim().replace(/^v/, "");
  return versionPattern.test(version) ? version : null;
}

/**
 * Check the latest stable OMP GitHub release without changing the staged
 * binary. The fetch implementation is injectable so this remains easy to
 * exercise without making network requests in unit tests.
 */
export async function checkForOmpUpdate(
  currentVersion: string,
  fetchImpl: FetchImpl = fetch,
): Promise<OmpUpdateCheckResult> {
  const normalizedCurrentVersion = currentVersion.trim();
  if (!versionPattern.test(normalizedCurrentVersion)) {
    throw new Error(`Invalid current OMP version: ${currentVersion || "(missing)"}`);
  }

  const response = await fetchImpl(latestReleaseUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "omp-openchamber-server",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(updateCheckTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`OMP release check failed: ${response.status} ${response.statusText}`);
  }

  const latestVersion = releaseVersion(await response.json());
  if (!latestVersion) {
    throw new Error("OMP release check returned no valid stable version");
  }

  return {
    currentVersion: normalizedCurrentVersion,
    latestVersion,
    updateAvailable: Bun.semver.order(latestVersion, normalizedCurrentVersion) > 0,
  };
}

/**
 * Start the non-blocking OMP update checker. Returns a cleanup function for
 * the sidecar shutdown path.
 */
export function startOmpUpdateChecker(): () => void {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let lastReportedVersion: string | undefined;

  const check = async (): Promise<void> => {
    if (stopped) return;

    const runtime = getOmpRuntimeInfo();
    if (runtime.source !== "bundled" || !runtime.version) {
      logger.debug("[sidecar] OMP update check skipped: bundled version is unavailable");
      return;
    }

    try {
      const result = await checkForOmpUpdate(runtime.version);
      if (!result.updateAvailable) {
        lastReportedVersion = undefined;
        logger.debug(`[sidecar] OMP is up to date (${result.currentVersion})`);
        return;
      }

      // Do not repeat the same warning every four hours while the user has
      // not yet staged the newer release.
      if (lastReportedVersion === result.latestVersion) return;
      lastReportedVersion = result.latestVersion;
      logger.warn(
        `[sidecar] OMP update available: ${result.currentVersion} → ${result.latestVersion}. `
        + "Bump sidecar/package.json ompVersion and restart the sidecar to stage it.",
      );
    } catch (error) {
      logger.debug({ err: error }, "[sidecar] OMP update check failed");
    }
  };

  const scheduleCheck = (): void => {
    if (stopped || inFlight) return;
    inFlight = check().finally(() => {
      inFlight = undefined;
    });
  };

  // Defer the first network request until after the server has completed its
  // synchronous startup work.
  const initialTimer = setTimeout(scheduleCheck, 0);
  const interval = setInterval(scheduleCheck, OMP_UPDATE_CHECK_INTERVAL_MS);

  return () => {
    stopped = true;
    clearTimeout(initialTimer);
    clearInterval(interval);
  };
}
