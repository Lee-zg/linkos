import type { MessageBlock } from "@linkos/protocol";

export interface ChatDraft {
  body: string;
  blocks: MessageBlock[];
  clientMsgId?: string;
}

export function readChatDraft(raw: string | null): ChatDraft {
  const empty = { body: "", blocks: [] };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return empty;
    const blocks = Array.isArray(value.blocks)
      ? value.blocks
          .filter(
            (block: MessageBlock) =>
              block &&
              ["file.reference", "code.snippet"].includes(block.type) &&
              block.value &&
              typeof block.value === "object",
          )
          .slice(0, 16)
      : [];
    return {
      body: typeof value.body === "string" ? value.body.slice(0, 65536) : "",
      blocks,
      clientMsgId:
        typeof value.clientMsgId === "string" ? value.clientMsgId : undefined,
    };
  } catch {
    return { body: raw.slice(0, 65536), blocks: [] };
  }
}
