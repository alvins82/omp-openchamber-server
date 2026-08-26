import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isBlobRef,
  parseBlobHash,
  readBlobBufferSync,
  resolveImageDataUrl,
  resolveImageBase64,
} from "./blobs";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("blobs utility", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "blobs-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("isBlobRef identifies valid and invalid blob prefixes", () => {
    expect(isBlobRef("blob:sha256:ec2d5b608244ecb6c5ad82e4aa063c097ab4af1e900ffe557796e6f54439c566")).toBe(true);
    expect(isBlobRef("blob:sha256:123")).toBe(true);
    expect(isBlobRef("data:image/png;base64,abcd")).toBe(false);
    expect(isBlobRef("/path/to/file.png")).toBe(false);
    expect(isBlobRef(null)).toBe(false);
    expect(isBlobRef(undefined)).toBe(false);
  });

  test("parseBlobHash extracts lowercase 64-char sha256 hash", () => {
    const validHash = "ec2d5b608244ecb6c5ad82e4aa063c097ab4af1e900ffe557796e6f54439c566";
    expect(parseBlobHash(`blob:sha256:${validHash}`)).toBe(validHash);
    expect(parseBlobHash(`blob:sha256:${validHash.toUpperCase()}`)).toBe(validHash);
    expect(parseBlobHash("blob:sha256:short")).toBeNull();
    expect(parseBlobHash("invalid")).toBeNull();
  });

  test("readBlobBufferSync and resolveImageDataUrl resolve image blob from disk", () => {
    const rawBuffer = Buffer.from(PNG_1X1_BASE64, "base64");
    const hash = new Bun.SHA256().update(rawBuffer).digest("hex");
    writeFileSync(join(tmpDir, hash), rawBuffer);

    const blobRef = `blob:sha256:${hash}`;
    const buf = readBlobBufferSync(blobRef, tmpDir);
    expect(buf).not.toBeNull();
    expect(buf!.toString("base64")).toBe(PNG_1X1_BASE64);

    const dataUrl = resolveImageDataUrl(blobRef, "image/webp", tmpDir);
    expect(dataUrl).toBe(`data:image/webp;base64,${PNG_1X1_BASE64}`);

    const base64 = resolveImageBase64(blobRef, tmpDir);
    expect(base64).toBe(PNG_1X1_BASE64);
  });

  test("resolveImageDataUrl preserves existing data URLs and base64 strings", () => {
    expect(resolveImageDataUrl(`data:image/png;base64,${PNG_1X1_BASE64}`, "image/jpeg")).toBe(
      `data:image/png;base64,${PNG_1X1_BASE64}`,
    );
    expect(resolveImageDataUrl(PNG_1X1_BASE64, "image/png")).toBe(
      `data:image/png;base64,${PNG_1X1_BASE64}`,
    );
  });
});
