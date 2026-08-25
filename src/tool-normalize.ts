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
 * Normalizes tool execution output to conform to OpenCode output expectations.
 * - For glob/find: returns "" for empty results and converts file arrays / OMP grouped paths to newline-delimited lists.
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

  return output;
}
