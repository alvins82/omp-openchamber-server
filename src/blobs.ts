import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BLOB_PREFIX = "blob:sha256:";
export const BLOB_HASH_RE = /^[a-f0-9]{64}$/i;

/**
 * Returns the directory where OMP stores content-addressed binary blobs.
 */
export function getBlobsDir(customDir?: string): string {
  if (customDir) return customDir;
  if (process.env.PI_CODING_AGENT_DIR) {
    return join(process.env.PI_CODING_AGENT_DIR, "blobs");
  }
  if (process.env.XDG_DATA_HOME) {
    return join(process.env.XDG_DATA_HOME, "omp", "agent", "blobs");
  }
  return join(Bun.env.HOME || "", ".omp", "agent", "blobs");
}

/**
 * Checks whether a given string is a blob reference (e.g. "blob:sha256:abcd...").
 */
export function isBlobRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(BLOB_PREFIX);
}

/**
 * Extracts the 64-char lowercase SHA-256 hash from a blob reference.
 */
export function parseBlobHash(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(BLOB_PREFIX)) return null;
  const hash = value.slice(BLOB_PREFIX.length).trim().toLowerCase();
  return BLOB_HASH_RE.test(hash) ? hash : null;
}

/**
 * Synchronously reads the binary Buffer corresponding to a blob hash or ref.
 */
export function readBlobBufferSync(hashOrRef: string, customBlobsDir?: string): Buffer | null {
  const hash = hashOrRef.startsWith(BLOB_PREFIX)
    ? parseBlobHash(hashOrRef)
    : BLOB_HASH_RE.test(hashOrRef.trim())
      ? hashOrRef.trim().toLowerCase()
      : null;

  if (!hash) return null;

  const blobsDir = getBlobsDir(customBlobsDir);
  const directPath = join(blobsDir, hash);
  if (existsSync(directPath)) {
    try {
      return readFileSync(directPath);
    } catch {
      return null;
    }
  }

  // Check known image extensions if raw file was saved with a suffix
  const commonExtensions = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp"];
  for (const ext of commonExtensions) {
    const extPath = join(blobsDir, `${hash}${ext}`);
    if (existsSync(extPath)) {
      try {
        return readFileSync(extPath);
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Resolves a data URL, base64 payload, or blob ref into a valid data URL.
 */
export function resolveImageDataUrl(data: string, mime: string = "image/png", customBlobsDir?: string): string {
  if (!data) return "";
  if (data.startsWith("data:")) return data;

  if (isBlobRef(data)) {
    const buffer = readBlobBufferSync(data, customBlobsDir);
    if (buffer) {
      // If the blob stored a UTF-8 data URL string:
      if (buffer.subarray(0, 5).toString("utf8") === "data:") {
        return buffer.toString("utf8");
      }
      return `data:${mime};base64,${buffer.toString("base64")}`;
    }
    return "";
  }

  return `data:${mime};base64,${data}`;
}

/**
 * Resolves a blob ref or raw base64 string into base64 data.
 */
export function resolveImageBase64(data: string, customBlobsDir?: string): string | null {
  if (!data) return null;
  if (isBlobRef(data)) {
    const buffer = readBlobBufferSync(data, customBlobsDir);
    if (buffer) {
      if (buffer.subarray(0, 5).toString("utf8") === "data:") {
        const text = buffer.toString("utf8");
        const commaIdx = text.indexOf(",");
        return commaIdx >= 0 ? text.slice(commaIdx + 1) : text;
      }
      return buffer.toString("base64");
    }
    return null;
  }

  if (data.startsWith("data:")) {
    const commaIdx = data.indexOf(",");
    return commaIdx >= 0 ? data.slice(commaIdx + 1) : data;
  }

  return data;
}
