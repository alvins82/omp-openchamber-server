import { describe, expect, it } from "bun:test";
import {
  extractTitleFromModelOutput,
  isLowSignalTitleInput,
  normalizeGeneratedTitle,
  overlayTitleSlotContent,
  parseTitleSlotLine,
  reconcileTitleCasing,
  serializeTitleSlot,
  SESSION_TITLE_SLOT_BYTES,
} from "./title";

describe("title utilities (OMP parity)", () => {
  describe("isLowSignalTitleInput", () => {
    it("identifies greetings as low signal", () => {
      expect(isLowSignalTitleInput("hi")).toBe(true);
      expect(isLowSignalTitleInput("hello")).toBe(true);
      expect(isLowSignalTitleInput("hey there")).toBe(true);
      expect(isLowSignalTitleInput("yo")).toBe(true);
      expect(isLowSignalTitleInput("good morning")).toBe(true);
    });

    it("identifies acknowledgments and fillers as low signal", () => {
      expect(isLowSignalTitleInput("thanks")).toBe(true);
      expect(isLowSignalTitleInput("ok")).toBe(true);
      expect(isLowSignalTitleInput("sure")).toBe(true);
      expect(isLowSignalTitleInput("cool")).toBe(true);
      expect(isLowSignalTitleInput("123")).toBe(true);
      expect(isLowSignalTitleInput("???")).toBe(true);
    });

    it("identifies substantive task prompts as high signal", () => {
      expect(isLowSignalTitleInput("Fix the login button on mobile")).toBe(false);
      expect(isLowSignalTitleInput("why does quuxdb segfault on startup?")).toBe(false);
      expect(isLowSignalTitleInput("Inspect sidecar directory")).toBe(false);
      expect(isLowSignalTitleInput("add unit test for title generator")).toBe(false);
    });
  });

  describe("normalizeGeneratedTitle & extractTitleFromModelOutput", () => {
    it("extracts and normalizes title wrapped in <title>...</title>", () => {
      expect(
        extractTitleFromModelOutput("<title>Fix login button on mobile</title>", "Fix login button on mobile"),
      ).toBe("Fix login button on mobile");
    });

    it("returns null for <title/> or empty/none responses", () => {
      expect(extractTitleFromModelOutput("<title/>")).toBeNull();
      expect(extractTitleFromModelOutput("<title></title>")).toBeNull();
      expect(extractTitleFromModelOutput("none")).toBeNull();
    });

    it("reconciles acronym and distinctive casing from source", () => {
      expect(
        reconcileTitleCasing("Inspect Api routes and Json schemas", "Inspect API routes and JSON schemas"),
      ).toBe("Inspect API routes and JSON schemas");
      expect(
        reconcileTitleCasing("Update tinyvmm bindings for ios", "Update TinyVMM bindings for iOS"),
      ).toBe("Update TinyVMM bindings for iOS");
    });
  });

  describe("256-byte title slot serialization and overlay", () => {
    it("serializes to exactly 256 UTF-8 bytes with newline", () => {
      const slot = serializeTitleSlot({
        title: "Fix login button on mobile",
        source: "auto",
        updatedAt: "2026-08-25T00:00:00.000Z",
      });
      expect(Buffer.byteLength(slot, "utf-8")).toBe(SESSION_TITLE_SLOT_BYTES);
      expect(slot.endsWith("\n")).toBe(true);

      const parsed = parseTitleSlotLine(slot.trim());
      expect(parsed).toBeDefined();
      expect(parsed?.title).toBe("Fix login button on mobile");
      expect(parsed?.source).toBe("auto");
      expect(parsed?.updatedAt).toBe("2026-08-25T00:00:00.000Z");
    });

    it("overlays existing title slot in session content", () => {
      const initialSlot = serializeTitleSlot({
        title: "",
        updatedAt: "2026-08-25T00:00:00.000Z",
      });
      const sessionBody = initialSlot + '{"type":"session","id":"ses1","cwd":"/dir"}\n';

      const updated = overlayTitleSlotContent(sessionBody, {
        title: "New Title",
        source: "user",
        updatedAt: "2026-08-25T01:00:00.000Z",
      });

      const firstLine = updated.split("\n")[0];
      const parsed = parseTitleSlotLine(firstLine);
      expect(parsed?.title).toBe("New Title");
      expect(parsed?.source).toBe("user");
      expect(updated).toContain('{"type":"session","id":"ses1","cwd":"/dir"}');
    });
  });
});
