import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolvedSmallModel {
  providerID: string;
  modelID: string;
  source: "request" | "settings" | "config" | "preferred" | "default";
  hasLogin: boolean;
  inputCharBudget: number;
  contextTokens: number;
  contextKnown: boolean;
  outputTokens: number | null;
  structuredOutput: boolean | null;
  outputTokenLimit: number | null;
}

export interface SmallModelConnection {
  providerID: string;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  protocol: "openai" | "anthropic";
}

const DEFAULT_CONTEXT_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 4_000;

// Provider ID aliases: syv-vllm <-> vllm
const PROVIDER_ALIASES: Record<string, string[]> = {
  "syv-vllm": ["vllm", "syv-vllm"],
  vllm: ["syv-vllm", "vllm"],
};

export function getProviderCandidates(providerID: string): string[] {
  return PROVIDER_ALIASES[providerID] || [providerID];
}

export function parseModelRef(ref?: string | null): { providerID: string; modelID: string } | null {
  if (!ref || typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash).trim(),
    modelID: trimmed.slice(slash + 1).trim(),
  };
}

let legacyOmpConfigMigrated = false;

/** Migrates legacy ~/.omp/config.json into OpenChamber settings.json if needed. */
export function ensureLegacyOmpConfigMigrated(settingsFile: string): void {
  if (legacyOmpConfigMigrated) return;
  legacyOmpConfigMigrated = true;
  try {
    const legacyFile = join(homedir(), ".omp", "config.json");
    if (!existsSync(legacyFile)) return;

    const legacyRaw = readFileSync(legacyFile, "utf8");
    const legacy = JSON.parse(legacyRaw);
    if (!legacy || typeof legacy !== "object") return;

    let target: Record<string, unknown> = {};
    if (existsSync(settingsFile)) {
      try {
        target = JSON.parse(readFileSync(settingsFile, "utf8")) || {};
      } catch {
        target = {};
      }
    }

    let changed = false;
    for (const [k, v] of Object.entries(legacy)) {
      if (v !== undefined && v !== null) {
        if (
          target[k] === undefined ||
          (k === "smallModelOverride" && legacy.smallModelOverride) ||
          (k === "smallModelUseDefault" && legacy.smallModelUseDefault !== undefined)
        ) {
          if (target[k] !== v) {
            target[k] = v;
            changed = true;
          }
        }
      }
    }

    if (changed) {
      writeFileSync(settingsFile, JSON.stringify(target, null, 2) + "\n");
    }
  } catch {
    // ignore
  }
}

/** Reads OpenChamber settings.json to check for user smallModelOverride. */
export function readOpenChamberSettingsSmallModel(): { providerID: string; modelID: string } | null {
  try {
    const dataDir = Bun.env.OPENCHAMBER_DATA_DIR || process.env.OPENCHAMBER_DATA_DIR || join(homedir(), ".config", "openchamber");
    const settingsFile = join(dataDir, "settings.json");
    ensureLegacyOmpConfigMigrated(settingsFile);
    if (!existsSync(settingsFile)) return null;

    const raw = readFileSync(settingsFile, "utf8");
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== "object") return null;
    if (settings.smallModelUseDefault !== false) return null;
    if (typeof settings.smallModelOverride === "string" && settings.smallModelOverride.trim()) {
      return parseModelRef(settings.smallModelOverride.trim());
    }
  } catch {
    // ignore
  }
  return null;
}

/** Reads OMP config.yml to check for modelRoles.smol. */
export function readOmpConfigSmallModel(): { providerID: string; modelID: string } | null {
  try {
    const ompConfigYml = join(homedir(), ".omp", "agent", "config.yml");
    if (existsSync(ompConfigYml)) {
      const raw = readFileSync(ompConfigYml, "utf8");
      const parsed = Bun.YAML.parse(raw) as Record<string, unknown> | null;
      const smol = (parsed?.modelRoles as Record<string, unknown> | undefined)?.smol;
      if (typeof smol === "string" && smol.trim()) {
        const ref = parseModelRef(smol.trim());
        if (ref) return ref;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/** Reads OpenCode opencode.json or config.json for small_model. */
export function readOpenCodeConfigSmallModel(directory?: string): { providerID: string; modelID: string } | null {
  const candidatePaths: string[] = [];
  if (directory) {
    candidatePaths.push(join(directory, ".opencode", "opencode.json"));
    candidatePaths.push(join(directory, ".opencode", "config.json"));
    candidatePaths.push(join(directory, "opencode.json"));
  }
  candidatePaths.push(join(homedir(), ".config", "opencode", "opencode.json"));
  candidatePaths.push(join(homedir(), ".config", "opencode", "config.json"));

  for (const file of candidatePaths) {
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed?.small_model === "string" && parsed.small_model.trim()) {
          const ref = parseModelRef(parsed.small_model.trim());
          if (ref) return ref;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/** Resolves connection details (baseURL, apiKey, protocol) for a provider. */
export function resolveProviderConnection(providerID: string, directory?: string): SmallModelConnection | null {
  const candidates = getProviderCandidates(providerID);

  // 1. Check ~/.omp/agent/models.yml
  try {
    const modelsYmlPath = join(homedir(), ".omp", "agent", "models.yml");
    if (existsSync(modelsYmlPath)) {
      const raw = readFileSync(modelsYmlPath, "utf8");
      const parsed = Bun.YAML.parse(raw) as { providers?: Record<string, Record<string, unknown>> } | null;
      const providers = parsed?.providers || {};
      for (const cand of candidates) {
        const p = providers[cand];
        if (p) {
          const rawUrl = (p.baseUrl || p.baseURL || p.url) as string | undefined;
          if (rawUrl && typeof rawUrl === "string") {
            const apiKey = (p.apiKey || p.key) as string | undefined;
            return {
              providerID,
              baseURL: rawUrl.trim(),
              apiKey: typeof apiKey === "string" ? apiKey.trim() : undefined,
              protocol: cand === "anthropic" ? "anthropic" : "openai",
            };
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 2. Check OpenCode config files (opencode.json / config.json)
  const opencodeConfigPaths: string[] = [];
  if (directory) {
    opencodeConfigPaths.push(join(directory, ".opencode", "opencode.json"));
    opencodeConfigPaths.push(join(directory, ".opencode", "config.json"));
    opencodeConfigPaths.push(join(directory, "opencode.json"));
  }
  opencodeConfigPaths.push(join(homedir(), ".config", "opencode", "opencode.json"));
  opencodeConfigPaths.push(join(homedir(), ".config", "opencode", "config.json"));

  for (const file of opencodeConfigPaths) {
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        const providers = parsed?.provider || {};
        for (const cand of candidates) {
          const p = providers[cand];
          if (p?.options) {
            const rawUrl = p.options.baseURL || p.options.baseUrl || p.options.url;
            if (rawUrl && typeof rawUrl === "string") {
              const rawKey = p.options.apiKey || p.options.key;
              const headers = p.options.headers && typeof p.options.headers === "object"
                ? (p.options.headers as Record<string, string>)
                : undefined;
              return {
                providerID,
                baseURL: rawUrl.trim(),
                apiKey: typeof rawKey === "string" ? rawKey.trim() : undefined,
                headers,
                protocol: cand === "anthropic" ? "anthropic" : "openai",
              };
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Check ~/.local/share/opencode/auth.json
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    if (existsSync(authPath)) {
      const raw = readFileSync(authPath, "utf8");
      const auth = JSON.parse(raw);
      for (const cand of candidates) {
        const entry = auth[cand];
        if (entry) {
          const key = entry.key || entry.token || entry.access;
          if (typeof key === "string" && key.trim()) {
            let defaultBaseUrl = "https://api.openai.com/v1";
            let protocol: "openai" | "anthropic" = "openai";
            if (cand === "anthropic") {
              defaultBaseUrl = "https://api.anthropic.com";
              protocol = "anthropic";
            } else if (cand === "deepseek") {
              defaultBaseUrl = "https://api.deepseek.com/v1";
            } else if (cand === "zai") {
              defaultBaseUrl = "https://open.bigmodel.cn/api/paas/v4";
            }
            return {
              providerID,
              baseURL: defaultBaseUrl,
              apiKey: key.trim(),
              protocol,
            };
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 4. Standard environment variables for well-known providers
  if (providerID === "openai" && process.env.OPENAI_API_KEY) {
    return {
      providerID,
      baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      protocol: "openai",
    };
  }
  if (providerID === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return {
      providerID,
      baseURL: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      apiKey: process.env.ANTHROPIC_API_KEY,
      protocol: "anthropic",
    };
  }
  if (providerID === "deepseek" && process.env.DEEPSEEK_API_KEY) {
    return {
      providerID,
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
      apiKey: process.env.DEEPSEEK_API_KEY,
      protocol: "openai",
    };
  }

  return null;
}

/** Resolves which model to use according to the priority order. */
export function resolveSmallModel(options?: {
  model?: string;
  preferredProviderID?: string;
  preferredModelID?: string;
  directory?: string;
}): { providerID: string; modelID: string; source: ResolvedSmallModel["source"] } | null {
  // 1. Explicit request model
  const explicit = parseModelRef(options?.model);
  if (explicit) {
    return { ...explicit, source: "request" };
  }

  // 2. OpenChamber settings override
  const settingsOverride = readOpenChamberSettingsSmallModel();
  if (settingsOverride) {
    return { ...settingsOverride, source: "settings" };
  }

  // 3. OMP small role
  const ompSmol = readOmpConfigSmallModel();
  if (ompSmol) {
    return { ...ompSmol, source: "config" };
  }

  // 4. OpenCode config
  const opencodeSmol = readOpenCodeConfigSmallModel(options?.directory);
  if (opencodeSmol) {
    return { ...opencodeSmol, source: "config" };
  }

  // 5. Preferred provider/model from request
  if (options?.preferredProviderID && options?.preferredModelID) {
    const conn = resolveProviderConnection(options.preferredProviderID, options.directory);
    if (conn) {
      return {
        providerID: options.preferredProviderID,
        modelID: options.preferredModelID,
        source: "preferred",
      };
    }
  }

  return null;
}

/** Describes the resolved small model for GET /api/small-model. */
export async function describeSmallModel(options?: {
  model?: string;
  preferredProviderID?: string;
  preferredModelID?: string;
  directory?: string;
}): Promise<ResolvedSmallModel | null> {
  const resolved = resolveSmallModel(options);
  if (!resolved) return null;

  const conn = resolveProviderConnection(resolved.providerID, options?.directory);
  const hasLogin = Boolean(conn);

  const contextTokens = DEFAULT_CONTEXT_TOKENS;
  const inputCharBudget = (contextTokens - OUTPUT_RESERVE_TOKENS) * 4;

  return {
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: resolved.source,
    hasLogin,
    inputCharBudget,
    contextTokens,
    contextKnown: false,
    outputTokens: 400,
    structuredOutput: null,
    outputTokenLimit: null,
  };
}

/** Direct chat completion call to OpenAI-compatible provider. */
async function callOpenaiCompatible(
  conn: SmallModelConnection,
  modelID: string,
  prompt: string,
  system?: string,
  maxOutputTokens = 400,
  signal?: AbortSignal,
): Promise<string> {
  const baseURL = conn.baseURL.replace(/\/+$/, "");
  const url = `${baseURL}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(conn.headers || {}),
  };
  if (conn.apiKey) {
    headers["Authorization"] = `Bearer ${conn.apiKey}`;
  }

  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: prompt },
  ];

  // Disable thinking where applicable (e.g. GLM / Zai models)
  const lowerModel = modelID.toLowerCase();
  const supportsThinkingToggle =
    conn.providerID.includes("zai") ||
    conn.providerID.includes("zhipu") ||
    lowerModel.includes("glm");
  const extraBody = supportsThinkingToggle ? { thinking: { type: "disabled" } } : {};

  const body = {
    model: modelID,
    messages,
    max_tokens: maxOutputTokens,
    temperature: 0.2,
    ...extraBody,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Small model request to ${conn.providerID} failed with ${response.status}: ${errorText.slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ text?: string }>;
        reasoning?: string;
        reasoning_content?: string;
      };
    }>;
  };

  const message = payload?.choices?.[0]?.message;
  let text = "";
  if (typeof message?.content === "string") {
    text = message.content;
  } else if (Array.isArray(message?.content)) {
    text = message.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  }

  // If content is empty but reasoning is present
  if (!text.trim() && (typeof message?.reasoning === "string" || typeof message?.reasoning_content === "string")) {
    text = message.reasoning || message.reasoning_content || "";
  }

  const result = text.trim();
  if (!result) {
    throw new Error(`Small model provider "${conn.providerID}" returned empty text output`);
  }
  return result;
}

/** Direct chat completion call to Anthropic provider. */
async function callAnthropic(
  conn: SmallModelConnection,
  modelID: string,
  prompt: string,
  system?: string,
  maxOutputTokens = 400,
  signal?: AbortSignal,
): Promise<string> {
  const baseURL = conn.baseURL.replace(/\/+$/, "");
  const url = `${baseURL}/v1/messages`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(conn.headers || {}),
  };
  if (conn.apiKey) {
    headers["x-api-key"] = conn.apiKey;
  }

  const body = {
    model: modelID,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxOutputTokens,
    temperature: 0.2,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Small model request to Anthropic failed with ${response.status}: ${errorText.slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };

  const text = (payload?.content || [])
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text)
    .join("");

  const result = text.trim();
  if (!result) {
    throw new Error(`Anthropic returned empty text output`);
  }
  return result;
}

/** Generates text from the small model. */
export async function generateSmallModelText(params: {
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  model?: string;
  directory?: string;
  preferredProviderID?: string;
  preferredModelID?: string;
  signal?: AbortSignal;
}): Promise<{ text: string; providerID: string; modelID: string; source: string }> {
  if (typeof params.prompt !== "string" || !params.prompt.trim()) {
    const err = new Error("prompt is required");
    (err as unknown as { statusCode: number }).statusCode = 400;
    throw err;
  }

  const resolved = resolveSmallModel({
    model: params.model,
    preferredProviderID: params.preferredProviderID,
    preferredModelID: params.preferredModelID,
    directory: params.directory,
  });

  if (!resolved) {
    const err = new Error("No small model is available");
    (err as unknown as { statusCode: number }).statusCode = 404;
    throw err;
  }

  const conn = resolveProviderConnection(resolved.providerID, params.directory);
  if (!conn) {
    const err = new Error(`No credentials or endpoint found for provider "${resolved.providerID}"`);
    (err as unknown as { statusCode: number }).statusCode = 401;
    throw err;
  }

  const tokens = Number(params.maxOutputTokens) > 0 ? Number(params.maxOutputTokens) : 400;

  let text = "";
  if (conn.protocol === "anthropic") {
    text = await callAnthropic(conn, resolved.modelID, params.prompt, params.system, tokens, params.signal);
  } else {
    text = await callOpenaiCompatible(conn, resolved.modelID, params.prompt, params.system, tokens, params.signal);
  }

  return {
    text,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: resolved.source,
  };
}
