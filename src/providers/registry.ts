/**
 * Backend registry: the catalog of enabled agent backends plus the id codecs
 * that route OpenCode session ids and provider ids to their owning backend.
 *
 * Routing rules (approved design D1/D2/D13):
 *  - Session ids: the default backend keeps its native id shape (legacy omp
 *    ids are `ses_<32hex>`); sessions owned by a non-default backend are
 *    `ses_<backendId>_<native>`. A session's backend is fixed for its life.
 *  - Provider ids: with a single enabled backend, provider ids pass through
 *    unchanged (byte-identical omp-only surface). With two or more, provider
 *    ids are namespaced `<backendId>/<nativeProviderID>`; the prefix selects
 *    the backend for new sessions and is stripped before a native call.
 */
import { ompBackend } from "./omp/backend";
import type { AgentBackend, OpenCodeProvidersResponse, OpenCodeSession } from "./types";

let backends: AgentBackend[] = [ompBackend];

/** All enabled backends, in registration order (default first). */
export function allBackends(): AgentBackend[] {
  return backends;
}

export function defaultBackend(): AgentBackend {
  return backends[0]!;
}

export function backendById(id: string): AgentBackend | undefined {
  return backends.find((backend) => backend.id === id);
}

/**
 * Registers an additional backend (idempotent on backend id). Used to enable
 * the fake backend via OC_FAKE_BACKEND=1 and by multi-provider tests.
 */
export function registerBackend(backend: AgentBackend): void {
  if (backends.some((existing) => existing.id === backend.id)) return;
  backends = [...backends, backend];
}

/** Restores the default catalog (omp only); used by tests after registration. */
export function resetBackends(): void {
  backends = [ompBackend];
}

/** True once more than one backend is enabled (namespacing mode). */
export function isMultiBackend(): boolean {
  return backends.length > 1;
}

const LEGACY_SESSION_ID = /^ses_[0-9a-f]{32}$/;

/**
 * Resolves the backend that owns a session id (D2). Legacy omp ids decode to
 * the default backend; `ses_<backendId>_...` decodes via the registry; an
 * unrecognized shape falls back to the default backend.
 */
export function backendForSession(openCodeId: string): AgentBackend {
  if (LEGACY_SESSION_ID.test(openCodeId)) return defaultBackend();
  if (openCodeId.startsWith("ses_")) {
    const sep = openCodeId.indexOf("_", 4);
    if (sep > 4) {
      const backend = backendById(openCodeId.slice(4, sep));
      if (backend) return backend;
    }
  }
  return defaultBackend();
}

/** Encodes a session id for a non-default backend (D2). */
export function encodeSessionId(backendId: string, nativeId: string): string {
  return `ses_${backendId}_${nativeId}`;
}

/**
 * Splits a namespaced provider id into its backend prefix and native id
 * (D13). Passthrough while a single backend is enabled; with multiple, an
 * unknown prefix keeps the FULL provider id as native (default backend).
 */
export function splitProviderPrefix(providerID: string): { backendId?: string; native: string } {
  if (!isMultiBackend()) return { native: providerID };
  const sep = providerID.indexOf("/");
  if (sep <= 0) return { native: providerID };
  const backend = backendById(providerID.slice(0, sep));
  return backend ? { backendId: backend.id, native: providerID.slice(sep + 1) } : { native: providerID };
}

/** Native provider id for setModel / conn calls: strips any backend prefix (D13). */
export function nativeProviderID(providerID: string): string {
  return splitProviderPrefix(providerID).native;
}

/**
 * Merged provider catalog for /provider routes. Single-backend mode returns
 * the backend's response unchanged; multi-backend mode namespaces every
 * provider id and default with `<backendId>/`.
 */
export async function listProviders(cwd: string): Promise<OpenCodeProvidersResponse> {
  if (!isMultiBackend()) return defaultBackend().listModels(cwd);
  const responses = await Promise.all(
    backends.map(async (backend) => ({ backend, response: await backend.listModels(cwd) })),
  );
  const providers = responses.flatMap(({ backend, response }) =>
    response.providers.map((provider) => ({ ...provider, id: `${backend.id}/${provider.id}` })),
  );
  return {
    providers,
    default: {
      default: `${defaultBackend().id}/${responses[0]!.response.default.default}`,
    },
  };
}

/** Merged session list across backends, default backend first. */
export async function listSessionsAcrossBackends(
  directory?: string | null,
  options?: { all?: boolean; limit?: number; archived?: boolean; search?: string },
): Promise<OpenCodeSession[]> {
  if (!isMultiBackend()) return defaultBackend().store.list(directory, options);
  const lists = await Promise.all(backends.map((backend) => backend.store.list(directory, options)));
  return lists.flat();
}
