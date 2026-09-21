import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendCredentials } from "../types";

export interface OmpCredentialRuntime {
  /** Isolated OMP agent directory containing the generated models.yml. */
  agentDir: string;
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

/**
 * Materialize caller-owned credentials into an ephemeral OMP agent directory.
 *
 * OMP's RPC protocol selects models but does not accept a credential payload.
 * Its supported configuration surface is therefore used only for credentialed
 * children. The directory is unique per child and removed when the child dies;
 * the sidecar never writes this config into the user's ~/.omp directory.
 */
export async function createOmpCredentialRuntime(
  credentials: BackendCredentials,
): Promise<OmpCredentialRuntime> {
  if (!credentials.providerID) throw new Error("credential runtime requires providerID");
  const agentDir = await mkdtemp(join(tmpdir(), "oc-omp-credential-"));
  await chmod(agentDir, 0o700).catch(() => {});

  const { providerID, ...providerConfig } = credentials;
  const modelsPath = join(agentDir, "models.yml");
  const content = `${JSON.stringify({ providers: { [providerID]: providerConfig } }, null, 2)}\n`;

  try {
    await writeFile(modelsPath, content, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await rm(agentDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let cleaned = false;
  return {
    agentDir,
    env: { PI_CODING_AGENT_DIR: agentDir },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await rm(agentDir, { recursive: true, force: true });
    },
  };
}
