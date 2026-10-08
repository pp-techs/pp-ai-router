// Adapted from lidge-jun/opencodex (MIT)
import type { KiroHistoryEntry } from "./request.ts";

/**
 * Kiro's stream carries token counts only on some models/versions (`metadataEvent.tokenUsage`).
 * When it does not, these heuristics fill in. They are calibrated against recorded Kiro traffic
 * (latin text/code ~2.8 chars per token, CJK ~1.5) and err high, which fails safe for limits.
 */
const LATIN_CHARS_PER_TOKEN = 2.8;
const CJK_CHARS_PER_TOKEN = 1.5;
/** What the wire charges beyond the text estimate: JSON framing and escaping, measured as 1.2x on latin text. */
const LATIN_WIRE_EXPANSION = 1.2;
/** Per conversation entry: keys (`userInputMessage`, `content`, `modelId`, `origin`) and role framing. */
const ENTRY_FRAMING_TOKENS = 27;
const MIN_IMAGE_TOKENS = 256;

/** Hangul, Han and kana ranges. */
function countCjk(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0x1100 && c <= 0x11ff) ||
      (c >= 0x3130 && c <= 0x318f) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x3040 && c <= 0x30ff)
    )
      cjk++;
  }
  return cjk;
}

/** Tokens in generated text (output side). */
export function estimateOutputTokens(text: string): number {
  if (!text) return 0;
  const cjk = countCjk(text);
  return Math.max(
    1,
    Math.ceil((text.length - cjk) / LATIN_CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN),
  );
}

/** Tokens in text sent to Kiro: the wire expansion applies to the latin part only. */
function estimateWireTokens(text: string): number {
  if (!text) return 0;
  const cjk = countCjk(text);
  if (cjk === 0) return Math.ceil(estimateOutputTokens(text) * LATIN_WIRE_EXPANSION);
  const latin = text.length - cjk;
  const latinTokens = latin > 0 ? Math.max(1, Math.ceil(latin / LATIN_CHARS_PER_TOKEN)) : 0;
  const cjkTokens = Math.max(1, Math.ceil(cjk / CJK_CHARS_PER_TOKEN));
  return Math.ceil(latinTokens * LATIN_WIRE_EXPANSION + cjkTokens);
}

/** Prompt tokens of a built `GenerateAssistantResponse` payload: all history, tools, results and images. */
export function estimateInputTokens(
  history: readonly KiroHistoryEntry[],
  current: KiroHistoryEntry,
): number {
  const entries = [...history, current];
  const parts: string[] = [];
  let imageTokens = 0;
  for (const entry of entries) {
    const user = entry.userInputMessage;
    if (user) {
      if (user.content) parts.push(user.content);
      for (const image of user.images ?? []) {
        imageTokens += Math.max(
          MIN_IMAGE_TOKENS,
          Math.ceil(Math.floor((image.source.bytes.length * 3) / 4) / 512),
        );
      }
      const context = user.userInputMessageContext;
      if (context?.tools?.length) parts.push(JSON.stringify(context.tools));
      if (context?.toolResults?.length) parts.push(JSON.stringify(context.toolResults));
    }
    const assistant = entry.assistantResponseMessage;
    if (assistant) {
      if (assistant.content) parts.push(assistant.content);
      if (assistant.toolUses?.length) parts.push(JSON.stringify(assistant.toolUses));
    }
  }
  return estimateWireTokens(parts.join("\n")) + imageTokens + entries.length * ENTRY_FRAMING_TOKENS;
}
