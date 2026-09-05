/**
 * Image Budget Extension for OMP
 *
 * Enforces a strict limit of at most 1 active image across conversation history
 * and outbound provider payloads. Prevents vision backends (like vLLM) with
 * single-image constraints from rejecting multi-turn image requests with HTTP 400.
 *
 * Older images are replaced with a concise text placeholder so the model
 * retains semantic context of prior captures without violating provider limits.
 */

const IMAGE_OMISSION_PLACEHOLDER = "[image omitted: older capture]";

export function pruneContextImages(messages: any[], maxImages = 1): { messages: any[]; dropped: number } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, dropped: 0 };
  }

  // Locate all image parts
  type ImageLocation =
    | { type: "messageContent"; messageIndex: number; partIndex: number }
    | { type: "fileMention"; messageIndex: number; fileIndex: number };

  const locations: ImageLocation[] = [];

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const msg = messages[mIdx];
    if (!msg || typeof msg !== "object") continue;

    if (Array.isArray(msg.content)) {
      for (let pIdx = 0; pIdx < msg.content.length; pIdx++) {
        const part = msg.content[pIdx];
        if (part && typeof part === "object" && part.type === "image") {
          locations.push({ type: "messageContent", messageIndex: mIdx, partIndex: pIdx });
        }
      }
    }

    if (msg.role === "fileMention" && Array.isArray(msg.files)) {
      for (let fIdx = 0; fIdx < msg.files.length; fIdx++) {
        const file = msg.files[fIdx];
        if (file && typeof file === "object" && file.image) {
          locations.push({ type: "fileMention", messageIndex: mIdx, fileIndex: fIdx });
        }
      }
    }
  }

  if (locations.length <= maxImages) {
    return { messages, dropped: 0 };
  }

  // Keep the latest `maxImages` (at the end of `locations`), drop the rest
  const dropLocations = new Set(locations.slice(0, locations.length - maxImages));
  const clonedMessages = messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const clonedMsg = { ...msg };

    if (Array.isArray(clonedMsg.content)) {
      clonedMsg.content = [...clonedMsg.content];
    }
    if (clonedMsg.role === "fileMention" && Array.isArray(clonedMsg.files)) {
      clonedMsg.files = clonedMsg.files.map((f: any) => ({ ...f }));
    }
    return clonedMsg;
  });

  let dropped = 0;

  for (const loc of dropLocations) {
    dropped++;
    const targetMsg = clonedMessages[loc.messageIndex];
    if (!targetMsg) continue;

    if (loc.type === "messageContent" && Array.isArray(targetMsg.content)) {
      const part = targetMsg.content[loc.partIndex];
      if (part && part.type === "image") {
        targetMsg.content[loc.partIndex] = {
          type: "text",
          text: IMAGE_OMISSION_PLACEHOLDER,
        };
      }
    } else if (loc.type === "fileMention" && Array.isArray(targetMsg.files)) {
      const targetFile = targetMsg.files[loc.fileIndex];
      if (targetFile) {
        targetFile.image = undefined;
        targetFile.content = targetFile.content || IMAGE_OMISSION_PLACEHOLDER;
      }
    }
  }

  // Collapse consecutive identical omission placeholders in content
  for (const msg of clonedMessages) {
    if (Array.isArray(msg.content)) {
      const cleaned: any[] = [];
      for (const part of msg.content) {
        const prev = cleaned[cleaned.length - 1];
        if (
          part.type === "text" &&
          part.text === IMAGE_OMISSION_PLACEHOLDER &&
          prev?.type === "text" &&
          prev?.text === IMAGE_OMISSION_PLACEHOLDER
        ) {
          continue;
        }
        cleaned.push(part);
      }
      msg.content = cleaned;
    }
  }

  return { messages: clonedMessages, dropped };
}

export function pruneProviderPayloadImages(payload: any, maxImages = 1): any {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) {
    return payload;
  }

  type PayloadImageLocation = { messageIndex: number; partIndex: number };
  const locations: PayloadImageLocation[] = [];

  for (let mIdx = 0; mIdx < payload.messages.length; mIdx++) {
    const msg = payload.messages[mIdx];
    if (!msg || typeof msg !== "object" || !Array.isArray(msg.content)) continue;

    for (let pIdx = 0; pIdx < msg.content.length; pIdx++) {
      const part = msg.content[pIdx];
      if (part && typeof part === "object") {
        if (part.type === "image_url" || part.type === "image") {
          locations.push({ messageIndex: mIdx, partIndex: pIdx });
        }
      }
    }
  }

  if (locations.length <= maxImages) {
    return payload;
  }

  const dropLocations = new Set(locations.slice(0, locations.length - maxImages));
  const clonedMessages = payload.messages.map((msg: any) => {
    if (!msg || typeof msg !== "object" || !Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: [...msg.content],
    };
  });

  for (const loc of dropLocations) {
    const targetMsg = clonedMessages[loc.messageIndex];
    if (targetMsg && Array.isArray(targetMsg.content)) {
      targetMsg.content[loc.partIndex] = {
        type: "text",
        text: IMAGE_OMISSION_PLACEHOLDER,
      };
    }
  }

  // Collapse consecutive identical omission placeholders
  for (const msg of clonedMessages) {
    if (Array.isArray(msg.content)) {
      const cleaned: any[] = [];
      for (const part of msg.content) {
        const prev = cleaned[cleaned.length - 1];
        if (
          part.type === "text" &&
          part.text === IMAGE_OMISSION_PLACEHOLDER &&
          prev?.type === "text" &&
          prev?.text === IMAGE_OMISSION_PLACEHOLDER
        ) {
          continue;
        }
        cleaned.push(part);
      }
      msg.content = cleaned;
    }
  }

  return {
    ...payload,
    messages: clonedMessages,
  };
}

export default function imageBudgetExtension(pi: any) {
  // Context-level transform: prune older images from agent messages before compaction/conversion
  pi.on("context", async (event: any) => {
    if (!event || !Array.isArray(event.messages)) return undefined;
    const { messages, dropped } = pruneContextImages(event.messages, 1);
    if (dropped > 0) {
      return { messages };
    }
    return undefined;
  });

  // Request-level transform: safety barrier right before the provider HTTP call
  pi.on("before_provider_request", async (event: any) => {
    if (!event || !event.payload) return undefined;
    return pruneProviderPayloadImages(event.payload, 1);
  });
}
