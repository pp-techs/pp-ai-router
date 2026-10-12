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

interface ImageSize {
  width: number;
  height: number;
}

function jpegSize(b: Buffer): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    // Standalone markers (TEM, RSTn) carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    // SOF0-SOF15 carry the frame size, except DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: b.readUInt16BE(o + 5), width: b.readUInt16BE(o + 7) };
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = b.readUInt16BE(o + 2);
    if (len < 2) return null;
    o += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer): ImageSize | null {
  if (
    b.length < 30 ||
    b.toString("latin1", 0, 4) !== "RIFF" ||
    b.toString("latin1", 8, 12) !== "WEBP"
  )
    return null;
  switch (b.toString("latin1", 12, 16)) {
    case "VP8X":
      return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    case "VP8 ":
      return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a
        ? { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
        : null;
    case "VP8L": {
      if (b[20] !== 0x2f) return null;
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/** Pixel size from the header of a base64 PNG, JPEG, GIF or WebP; null for anything else. */
function sniffImageSize(base64: string): ImageSize | null {
  // 48 KB of decoded header is enough even for a JPEG whose frame header sits behind large EXIF segments.
  const b = Buffer.from(base64.slice(0, 65_536), "base64");
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47)
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString("latin1", 0, 3) === "GIF")
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  return jpegSize(b) ?? webpSize(b);
}

/** About one token per 750 pixels when the size can be read, else a guess from the encoded size. */
function estimateImageTokens(base64: string): number {
  const size = sniffImageSize(base64);
  if (size) return Math.max(MIN_IMAGE_TOKENS, Math.ceil((size.width * size.height) / 750));
  return Math.max(MIN_IMAGE_TOKENS, Math.ceil(Math.floor((base64.length * 3) / 4) / 512));
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
      for (const image of user.images ?? []) imageTokens += estimateImageTokens(image.source.bytes);
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
