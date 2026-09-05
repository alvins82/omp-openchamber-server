import { describe, expect, test } from "bun:test";
import imageBudgetExtension, {
  pruneContextImages,
  pruneProviderPayloadImages,
} from "../extensions/image_budget";
import { getSidecarExtensionPaths, embeddedOmpConfigOverlay } from "./providers/omp/rpc";
import { existsSync, readFileSync } from "node:fs";

const PNG_1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_2 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9QzwAEjDAGAwcAA5kBAQvAupMAAAAASUVORK5CYII=";
const PNG_3 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("Image Budget Extension", () => {
  describe("pruneContextImages", () => {
    test("does not modify messages with 0 or 1 image", () => {
      const messagesZero = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ];
      const res0 = pruneContextImages(messagesZero, 1);
      expect(res0.dropped).toBe(0);
      expect(res0.messages).toBe(messagesZero);

      const messagesOne = [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", data: PNG_1, mimeType: "image/png" },
          ],
        },
      ];
      const res1 = pruneContextImages(messagesOne, 1);
      expect(res1.dropped).toBe(0);
      expect(res1.messages).toBe(messagesOne);
    });

    test("prunes older images across multiple toolResult turns, keeping only the latest", () => {
      const messages = [
        { role: "user", content: [{ type: "text", text: "check render" }] },
        {
          role: "toolResult",
          toolCallId: "tc_1",
          toolName: "read",
          content: [
            { type: "text", text: "Read image file" },
            { type: "image", data: PNG_1, mimeType: "image/jpeg" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "Framing looks off, adjusting..." }] },
        {
          role: "toolResult",
          toolCallId: "tc_2",
          toolName: "read",
          content: [
            { type: "text", text: "Read second image" },
            { type: "image", data: PNG_2, mimeType: "image/jpeg" },
          ],
        },
      ];

      const { messages: pruned, dropped } = pruneContextImages(messages, 1);
      expect(dropped).toBe(1);

      // First image should be replaced with placeholder
      expect(pruned[1].content).toEqual([
        { type: "text", text: "Read image file" },
        { type: "text", text: "[image omitted: older capture]" },
      ]);

      // Second (latest) image should remain intact
      expect(pruned[3].content).toEqual([
        { type: "text", text: "Read second image" },
        { type: "image", data: PNG_2, mimeType: "image/jpeg" },
      ]);
    });

    test("prunes multiple older images when 3+ images exist across conversation", () => {
      const messages = [
        {
          role: "user",
          content: [{ type: "image", data: PNG_1, mimeType: "image/png" }],
        },
        {
          role: "toolResult",
          content: [{ type: "image", data: PNG_2, mimeType: "image/png" }],
        },
        {
          role: "toolResult",
          content: [{ type: "image", data: PNG_3, mimeType: "image/png" }],
        },
      ];

      const { messages: pruned, dropped } = pruneContextImages(messages, 1);
      expect(dropped).toBe(2);

      expect(pruned[0].content).toEqual([
        { type: "text", text: "[image omitted: older capture]" },
      ]);
      expect(pruned[1].content).toEqual([
        { type: "text", text: "[image omitted: older capture]" },
      ]);
      expect(pruned[2].content).toEqual([
        { type: "image", data: PNG_3, mimeType: "image/png" },
      ]);
    });

    test("handles fileMention image attachments", () => {
      const messages = [
        {
          role: "fileMention",
          files: [
            { path: "test.png", content: "", image: { type: "image", data: PNG_1, mimeType: "image/png" } },
          ],
        },
        {
          role: "toolResult",
          content: [
            { type: "image", data: PNG_2, mimeType: "image/png" },
          ],
        },
      ];

      const { messages: pruned, dropped } = pruneContextImages(messages, 1);
      expect(dropped).toBe(1);

      // File mention image cleared
      expect(pruned[0].files[0].image).toBeUndefined();
      expect(pruned[0].files[0].content).toBe("[image omitted: older capture]");

      // Tool result image kept
      expect(pruned[1].content[0].data).toBe(PNG_2);
    });
  });

  describe("pruneProviderPayloadImages", () => {
    test("preserves payload with single image_url", () => {
      const payload = {
        model: "qwen3.8-27b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
            ],
          },
        ],
      };

      const result = pruneProviderPayloadImages(payload, 1);
      expect(result).toEqual(payload);
    });

    test("prunes earlier image_url parts in OpenAI-style completion payload", () => {
      const payload = {
        model: "qwen3.8-27b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "image 1" },
              { type: "image_url", image_url: { url: "data:image/jpeg;base64,first" } },
            ],
          },
          {
            role: "assistant",
            content: "captured first",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "image 2" },
              { type: "image_url", image_url: { url: "data:image/jpeg;base64,second" } },
            ],
          },
        ],
      };

      const result = pruneProviderPayloadImages(payload, 1);

      // Message 0 should have image_url replaced by text
      expect(result.messages[0].content).toEqual([
        { type: "text", text: "image 1" },
        { type: "text", text: "[image omitted: older capture]" },
      ]);

      // Message 2 should retain its image_url
      expect(result.messages[2].content).toEqual([
        { type: "text", text: "image 2" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,second" } },
      ]);
    });
  });

  describe("imageBudgetExtension lifecycle hooks", () => {
    test("registers context and before_provider_request hooks", async () => {
      const handlers = new Map<string, Function>();
      const mockPi = {
        on: (event: string, handler: Function) => {
          handlers.set(event, handler);
        },
      };

      imageBudgetExtension(mockPi);

      expect(handlers.has("context")).toBe(true);
      expect(handlers.has("before_provider_request")).toBe(true);

      // Verify context handler
      const contextHandler = handlers.get("context")!;
      const contextResult = await contextHandler({
        messages: [
          { role: "user", content: [{ type: "image", data: PNG_1, mimeType: "image/png" }] },
          { role: "user", content: [{ type: "image", data: PNG_2, mimeType: "image/png" }] },
        ],
      });
      expect(contextResult?.messages).toBeDefined();
      expect(contextResult.messages[0].content[0].type).toBe("text");
      expect(contextResult.messages[1].content[0].type).toBe("image");

      // Verify before_provider_request handler
      const requestHandler = handlers.get("before_provider_request")!;
      const payloadResult = await requestHandler({
        payload: {
          messages: [
            { role: "user", content: [{ type: "image_url", image_url: { url: "data:1" } }] },
            { role: "user", content: [{ type: "image_url", image_url: { url: "data:2" } }] },
          ],
        },
      });
      expect(payloadResult.messages[0].content[0].type).toBe("text");
      expect(payloadResult.messages[1].content[0].type).toBe("image_url");
    });
  });

  describe("Extension discovery & config overlay", () => {
    test("getSidecarExtensionPaths includes image_budget.ts", () => {
      const paths = getSidecarExtensionPaths();
      const hasImageBudget = paths.some((p) => p.endsWith("image_budget.ts"));
      expect(hasImageBudget).toBe(true);
    });

    test("embeddedOmpConfigOverlay generates config with image_budget extension", () => {
      const configPath = embeddedOmpConfigOverlay();
      expect(existsSync(configPath)).toBe(true);
      const content = readFileSync(configPath, "utf8");
      expect(content).toContain("image_budget.ts");
    });
  });
});
