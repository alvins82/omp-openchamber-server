import { createHash } from "node:crypto";
import type { BackendCredentialInput, BackendCredentials } from "../types";

export interface CredentialResolverContext {
  cwd: string;
  openCodeId?: string;
  providerID?: string;
  modelID?: string;
}

export type CredentialResolver = (
  credentialRef: string,
  context: CredentialResolverContext,
) => Promise<BackendCredentials | null>;

/** Errors caused by the opt-in credential path, mapped to an HTTP status. */
export class CredentialInputError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "CredentialInputError";
    this.statusCode = statusCode;
  }
}

let credentialResolver: CredentialResolver | undefined;

/** Install a process-local resolver for embedded/test hosts. */
export function setCredentialResolver(resolver: CredentialResolver | undefined): void {
  credentialResolver = resolver;
}

export function resetCredentialResolver(): void {
  credentialResolver = undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CredentialInputError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new CredentialInputError("credentials.headers must be an object");
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key.trim() || typeof raw !== "string") {
      throw new CredentialInputError("credentials.headers must contain string values");
    }
    headers[key] = raw;
  }
  return headers;
}

function normalizeRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new CredentialInputError(`credentials.${field} must be an object`);
  return structuredClone(value);
}

function normalizeModels(value: unknown): Array<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new CredentialInputError("credentials.models must be an array");
  return value.map((model, index) => {
    if (!isRecord(model)) throw new CredentialInputError(`credentials.models[${index}] must be an object`);
    nonEmptyString(model.id, `credentials.models[${index}].id`);
    return structuredClone(model);
  });
}

/** Validate and clone a caller-supplied provider configuration. */
export function normalizeBackendCredentials(
  value: unknown,
  providerID?: string,
): BackendCredentials {
  if (!isRecord(value)) throw new CredentialInputError("credentials must be an object");

  const resolvedProviderID = nonEmptyString(value.providerID, "credentials.providerID") ?? providerID;
  if (!resolvedProviderID) {
    throw new CredentialInputError("credentials.providerID is required when no model provider is selected");
  }

  const auth = value.auth;
  if (auth !== undefined && auth !== "apiKey" && auth !== "none" && auth !== "oauth") {
    throw new CredentialInputError("credentials.auth must be apiKey, none, or oauth");
  }

  const authHeader = value.authHeader;
  if (authHeader !== undefined && typeof authHeader !== "boolean") {
    throw new CredentialInputError("credentials.authHeader must be a boolean");
  }

  const disableStrictTools = value.disableStrictTools;
  if (disableStrictTools !== undefined && typeof disableStrictTools !== "boolean") {
    throw new CredentialInputError("credentials.disableStrictTools must be a boolean");
  }

  const guardrailTrace = value.guardrailTrace;
  if (
    guardrailTrace !== undefined &&
    guardrailTrace !== "enabled" &&
    guardrailTrace !== "disabled" &&
    guardrailTrace !== "enabled_full"
  ) {
    throw new CredentialInputError(
      "credentials.guardrailTrace must be enabled, disabled, or enabled_full",
    );
  }

  const transport = value.transport;
  if (transport !== undefined && transport !== "pi-native") {
    throw new CredentialInputError("credentials.transport must be pi-native");
  }

  const normalized: BackendCredentials = {
    providerID: resolvedProviderID,
    apiKey: nonEmptyString(value.apiKey, "credentials.apiKey"),
    baseUrl: nonEmptyString(value.baseUrl ?? value.baseURL, "credentials.baseUrl"),
    api: nonEmptyString(value.api, "credentials.api"),
    auth,
    authHeader,
    headers: normalizeHeaders(value.headers),
    compat: normalizeRecord(value.compat, "compat"),
    remoteCompaction: normalizeRecord(value.remoteCompaction, "remoteCompaction"),
    discovery: normalizeRecord(value.discovery, "discovery"),
    modelOverrides: normalizeRecord(value.modelOverrides, "modelOverrides") as Record<string, Record<string, unknown>> | undefined,
    disableStrictTools,
    guardrailIdentifier: nonEmptyString(value.guardrailIdentifier, "credentials.guardrailIdentifier"),
    guardrailVersion: nonEmptyString(value.guardrailVersion, "credentials.guardrailVersion"),
    guardrailTrace,
    transport,
    models: normalizeModels(value.models),
  };
  if (
    normalized.apiKey === undefined &&
    normalized.baseUrl === undefined &&
    normalized.api === undefined &&
    normalized.auth === undefined &&
    normalized.authHeader === undefined &&
    normalized.headers === undefined &&
    normalized.compat === undefined &&
    normalized.remoteCompaction === undefined &&
    normalized.discovery === undefined &&
    normalized.modelOverrides === undefined &&
    normalized.disableStrictTools === undefined &&
    normalized.guardrailIdentifier === undefined &&
    normalized.guardrailVersion === undefined &&
    normalized.guardrailTrace === undefined &&
    normalized.transport === undefined &&
    normalized.models === undefined
  ) {
    throw new CredentialInputError(
      "credentials must include provider configuration such as apiKey, baseUrl, headers, auth, api, or models",
    );
  }
  return normalized;
}

function resolverUrl(): string | undefined {
  const value = process.env.OC_CREDENTIAL_RESOLVER_URL?.trim();
  return value || undefined;
}

function resolverToken(): string | undefined {
  const value = process.env.OC_CREDENTIAL_RESOLVER_TOKEN?.trim();
  return value || undefined;
}

async function resolveOverHttp(
  credentialRef: string,
  context: CredentialResolverContext,
): Promise<BackendCredentials | null> {
  const url = resolverUrl();
  if (!url) {
    throw new CredentialInputError(
      "credentialRef was supplied, but no credential resolver is configured; set OC_CREDENTIAL_RESOLVER_URL or install a resolver",
      424,
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const token = resolverToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        credentialRef,
        providerID: context.providerID,
        modelID: context.modelID,
        cwd: context.cwd,
        openCodeId: context.openCodeId,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new CredentialInputError(
      `credential resolver request failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  if (!response.ok) {
    await response.text().catch(() => "");
    throw new CredentialInputError(
      `credential resolver returned ${response.status}`,
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CredentialInputError("credential resolver returned invalid JSON", 502);
  }

  if (!isRecord(payload)) throw new CredentialInputError("credential resolver returned an invalid response", 502);
  const rawCredentials = "credentials" in payload
    ? payload.credentials
    : "credential" in payload
      ? payload.credential
      : payload;
  if (rawCredentials === null) return null;
  return normalizeBackendCredentials(rawCredentials, context.providerID);
}

async function resolveCredentialRef(
  credentialRef: string,
  context: CredentialResolverContext,
): Promise<BackendCredentials | null> {
  if (!credentialResolver) return resolveOverHttp(credentialRef, context);
  try {
    return await credentialResolver(credentialRef, context);
  } catch (error) {
    if (error instanceof CredentialInputError) throw error;
    throw new CredentialInputError(
      `credential resolver failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }
}

/**
 * Resolve the opt-in request envelope into the provider config OMP needs.
 * `undefined` is intentionally a no-op: callers without credentials retain
 * the sidecar's existing OMP-owned auth behavior.
 */
export async function resolveBackendCredentials(
  input: BackendCredentialInput | undefined,
  context: CredentialResolverContext,
): Promise<BackendCredentials | undefined> {
  if (!input) return undefined;

  const resolutionContext: CredentialResolverContext = {
    ...context,
    providerID: context.providerID ?? input.selectedProviderID,
    modelID: context.modelID ?? input.selectedModelID,
  };

  const hasCredentials = input.credentials !== undefined;
  const hasCredentialRef = input.credentialRef !== undefined;
  if (hasCredentials === hasCredentialRef) {
    throw new CredentialInputError("provide exactly one of credentials or credentialRef");
  }

  if (hasCredentials) {
    const resolved = normalizeBackendCredentials(input.credentials, resolutionContext.providerID);
    if (resolutionContext.providerID && resolved.providerID !== resolutionContext.providerID) {
      throw new CredentialInputError(
        `credentials.providerID "${resolved.providerID}" does not match selected model provider "${resolutionContext.providerID}"`,
      );
    }
    return resolved;
  }

  const ref = nonEmptyString(input.credentialRef, "credentialRef")!;
  const resolved = await resolveCredentialRef(ref, resolutionContext);
  if (!resolved) throw new CredentialInputError("credentialRef did not resolve to credentials", 401);
  const normalized = normalizeBackendCredentials(resolved, resolutionContext.providerID);
  if (resolutionContext.providerID && normalized.providerID !== resolutionContext.providerID) {
    throw new CredentialInputError(
      `resolved credentials.providerID "${normalized.providerID}" does not match selected model provider "${resolutionContext.providerID}"`,
    );
  }
  return normalized;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

/** A non-secret identity used to decide whether a persistent child can reuse auth. */
export function credentialInputFingerprint(input: BackendCredentialInput): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue({
      credentials: input.credentials,
      credentialRef: input.credentialRef,
      // A credential without providerID is inferred from this model context;
      // changing providers must therefore replace the child config.
      selectedProviderID: input.selectedProviderID,
    })))
    .digest("hex");
}
