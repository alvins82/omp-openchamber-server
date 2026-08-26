/**
 * Normalizes tool inputs and outputs from OMP (Oh My Pi) shapes
 * to native OpenCode server contract shapes.
 */

/**
 * Splits a glob path pattern (e.g. "/path/to/dir/**" or "src/*.ts")
 * into base directory and glob pattern.
 */
export function splitGlobPath(pathStr: string): { path: string; pattern: string } | null {
  const globMatch = pathStr.search(/[*?\[{]/);
  if (globMatch === -1) {
    return null;
  }
  const prefix = pathStr.slice(0, globMatch);
  const lastSlash = prefix.lastIndexOf("/");
  if (lastSlash === -1) {
    return {
      path: ".",
      pattern: pathStr,
    };
  }
  const basePath = prefix.slice(0, lastSlash) || (pathStr.startsWith("/") ? "/" : ".");
  const pattern = pathStr.slice(lastSlash + 1);
  return {
    path: basePath,
    pattern: pattern || "**/*",
  };
}

/**
 * Parses OMP's grouped paths output format (# dir/\nfile1\nfile2)
 * into a flat array of relative path strings.
 */
export function parseOmpGroupedPaths(text: string): string[] | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (
    !trimmed ||
    trimmed === "No files found matching pattern" ||
    trimmed === "No matches found"
  ) {
    return [];
  }
  const lines = trimmed.split("\n");
  const hasHeaders = lines.some((l) => l.startsWith("#"));
  if (!hasHeaders) {
    return null;
  }
  const paths: string[] = [];
  let currentDir = "";
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith("#")) {
      currentDir = l.replace(/^#+\s*/, "").trim();
      if (currentDir && !currentDir.endsWith("/")) currentDir += "/";
    } else {
      paths.push(currentDir + l);
    }
  }
  return paths;
}

/**
 * Normalizes tool call arguments to conform to OpenCode schemas.
 * - For glob/find: splits path into { path, pattern } and removes intent/description fields.
 * - For grep/search: removes internal intent fields.
 * - For general tools: cleans up internal wrapper keys (i, intent, l, _) while preserving description.
 */
export function normalizeToolInput(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const normalized: Record<string, unknown> = { ...input };
  const tool = (toolName ?? "").toLowerCase();

  if (tool === "glob" || tool === "find") {
    if (typeof normalized.path === "string" && !normalized.pattern) {
      const split = splitGlobPath(normalized.path);
      if (split) {
        normalized.path = split.path;
        normalized.pattern = split.pattern;
      }
    }
    delete normalized.i;
    delete normalized.intent;
    delete normalized.l;
    delete normalized._;
    delete normalized.description;
    return normalized;
  }

  if (tool === "grep" || tool === "search" || tool === "ripgrep") {
    delete normalized.i;
    delete normalized.intent;
    delete normalized.l;
    delete normalized._;
    delete normalized.description;
    return normalized;
  }

  if (tool === "hub" || tool === "job") {
    if (normalized.ids && Array.isArray(normalized.ids)) {
      if (normalized.ids.length === 1) {
        normalized.subagent = normalized.ids[0];
        delete normalized.ids;
      }
    }
    if (normalized.op === "wait" || normalized.op === "poll") {
      delete normalized.op;
    }
    delete normalized.timeoutMs;
    delete normalized.timeout;
  }

  // General tools: promote intent/i/l to description if needed, then strip raw intent keys
  if (normalized.i || normalized.intent || normalized.l) {
    if (!normalized.description && (normalized.intent || normalized.i || normalized.l)) {
      normalized.description = (normalized.intent ?? normalized.i ?? normalized.l) as string;
    }
    delete normalized.i;
    delete normalized.intent;
    delete normalized.l;
    delete normalized._;
  }

  return normalized;
}

/**
 * Strips model-facing <task-result> XML wrapper markup from subagent job outputs
 * to present clean JSON or plain text in the OpenChamber UI.
 */
export function stripTaskResultEnvelope(text: string): string {
  if (!text.includes("<task-result")) return text;
  let stripped = text.replace(
    /<task-result(?:\s[^>]*)?>[\s\S]*?<(?:output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/(?:output|preview)>[\s\S]*?<\/task-result>/g,
    (_, body) => body.trim(),
  );
  if (stripped.includes("<task-result")) {
    stripped = stripped
      .replace(/<task-result(?:\s[^>]*)?>/g, "")
      .replace(/<\/task-result>/g, "")
      .replace(/<meta\s+[^>]*\/>/g, "")
      .replace(/<\/?(?:output|preview)(?:\s[^>]*)?>/g, "");
  }
  return stripped.trim();
}

/**
 * Cleans boilerplate markdown and follow-up hints from hub/job delivery text.
 */
export function cleanHubOutput(text: string): string {
  let cleaned = stripTaskResultEnvelope(text);

  // Strip follow-up boilerplate like "SmokeTest is now idle — message it via..."
  cleaned = cleaned.replace(/\n\n[a-zA-Z0-9_-]+\s+(?:is now idle|was stopped|was aborted)[^\n]*/g, "");

  // If a single completed task is wrapped in ## Completed (...) ### Name [task] — completed \nLabel: ... \n```\nBODY\n```
  const singleJobMatch = /^## Completed \(\d+\)\s*\n+###\s+([^\n]+)\s+—\s+completed(?:\s*\n+Label:[^\n]*)?\s*\n+```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(cleaned.trim());
  if (singleJobMatch) {
    return singleJobMatch[2].trim();
  }

  // Strip top-level fences if wrapping single output
  cleaned = cleaned.replace(/^```[a-z]*\n([\s\S]*?)\n```$/g, "$1").trim();

  return cleaned;
}

/**
 * Normalizes tool execution output to conform to OpenCode output expectations.
 * - For glob/find: returns "" for empty results and converts file arrays / OMP grouped paths to newline-delimited lists.
 * - For tools containing <task-result> or hub outputs: unwraps inner output body.
 */
export function normalizeToolOutput(
  toolName: string | undefined,
  output: string | undefined,
  details?: unknown,
): string | undefined {
  if (output === undefined) return undefined;
  const tool = (toolName ?? "").toLowerCase();

  if (tool === "glob" || tool === "find") {
    if (details && typeof details === "object") {
      const files = (details as { files?: unknown[] }).files;
      if (Array.isArray(files)) {
        return files.map((f) => String(f)).join("\n");
      }
    }
    const trimmed = output.trim();
    if (
      trimmed === "No files found matching pattern" ||
      trimmed === "No matches found" ||
      trimmed === ""
    ) {
      return "";
    }
    const parsedPaths = parseOmpGroupedPaths(output);
    if (parsedPaths !== null) {
      return parsedPaths.join("\n");
    }
  }

  if (tool === "hub" || tool === "job") {
    return cleanHubOutput(output);
  }

  if (output.includes("<task-result")) {
    return stripTaskResultEnvelope(output);
  }

  return output;
}
