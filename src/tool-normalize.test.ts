import { describe, it, expect } from "bun:test";
import {
  splitGlobPath,
  parseOmpGroupedPaths,
  normalizeToolInput,
  normalizeToolOutput,
} from "./tool-normalize";

describe("tool-normalize", () => {
  describe("splitGlobPath", () => {
    it("splits glob pattern from absolute directory path", () => {
      const result = splitGlobPath("/Users/alvin/claude-cowork/hangar/**");
      expect(result).toEqual({
        path: "/Users/alvin/claude-cowork/hangar",
        pattern: "**",
      });
    });

    it("splits glob pattern with subdirectories and extensions", () => {
      const result = splitGlobPath("src/**/*.ts");
      expect(result).toEqual({
        path: "src",
        pattern: "**/*.ts",
      });
    });

    it("handles root-level glob patterns", () => {
      const result = splitGlobPath("*.json");
      expect(result).toEqual({
        path: ".",
        pattern: "*.json",
      });
    });

    it("returns null when no glob characters exist", () => {
      const result = splitGlobPath("/Users/alvin/claude-cowork/hangar");
      expect(result).toBeNull();
    });
  });

  describe("parseOmpGroupedPaths", () => {
    it("returns empty array for empty indicator messages", () => {
      expect(parseOmpGroupedPaths("No files found matching pattern")).toEqual([]);
      expect(parseOmpGroupedPaths("No matches found")).toEqual([]);
      expect(parseOmpGroupedPaths("")).toEqual([]);
    });

    it("parses OMP grouped path tree format into flat path list", () => {
      const ompOutput = `# src/\nindex.ts\napp.ts\n# src/utils/\nhelper.ts`;
      expect(parseOmpGroupedPaths(ompOutput)).toEqual([
        "src/index.ts",
        "src/app.ts",
        "src/utils/helper.ts",
      ]);
    });

    it("returns null for non-grouped plain text", () => {
      expect(parseOmpGroupedPaths("plain text without headers")).toBeNull();
    });
  });

  describe("normalizeToolInput", () => {
    it("normalizes glob input by splitting path and pattern, and stripping metadata", () => {
      const input = {
        path: "/Users/alvin/claude-cowork/hangar/**",
        l: "Finding existing files in hangar",
        description: "Finding existing files in hangar",
        intent: "Finding existing files in hangar",
      };
      const normalized = normalizeToolInput("glob", input);
      expect(normalized).toEqual({
        path: "/Users/alvin/claude-cowork/hangar",
        pattern: "**",
      });
    });

    it("preserves pattern if already provided in glob input", () => {
      const input = {
        path: "/repo/src",
        pattern: "*.ts",
        l: "Finding files",
      };
      const normalized = normalizeToolInput("glob", input);
      expect(normalized).toEqual({
        path: "/repo/src",
        pattern: "*.ts",
      });
    });

    it("cleans internal intent keys from general tools while retaining description", () => {
      const input = {
        filePath: "index.ts",
        i: "Read index",
      };
      const normalized = normalizeToolInput("read", input);
      expect(normalized).toEqual({
        filePath: "index.ts",
        description: "Read index",
      });
    });
  });

  describe("normalizeToolOutput", () => {
    it("converts 'No files found matching pattern' to empty string for glob", () => {
      expect(normalizeToolOutput("glob", "No files found matching pattern")).toBe("");
    });

    it("prefers details.files array when available", () => {
      const details = { files: ["src/index.ts", "package.json"] };
      expect(normalizeToolOutput("glob", "# raw tree", details)).toBe("src/index.ts\npackage.json");
    });

    it("parses OMP grouped path string when details are absent", () => {
      const ompOutput = `# src/\nindex.ts\n# src/utils/\nhelper.ts`;
      expect(normalizeToolOutput("glob", ompOutput)).toBe("src/index.ts\nsrc/utils/helper.ts");
    });

    it("passes through outputs for other tools", () => {
      expect(normalizeToolOutput("bash", "hello world")).toBe("hello world");
    });
  });
});
