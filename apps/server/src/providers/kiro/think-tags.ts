// Adapted from lidge-jun/opencodex (MIT)

export interface ThinkPart {
  kind: "text" | "reasoning";
  text: string;
}

const OPEN_TAGS = ["<thinking>", "<think>", "<reasoning>"];
const MAX_OPEN_TAG = Math.max(...OPEN_TAGS.map((t) => t.length));
const MAX_CLOSE_TAG = MAX_OPEN_TAG + 1;

/** Moves a cut back one unit rather than splitting a surrogate pair into U+FFFD. */
function surrogateSafeCut(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return Math.max(0, Math.min(cut, text.length));
  const unit = text.charCodeAt(cut - 1);
  return unit >= 0xd800 && unit <= 0xdbff ? cut - 1 : cut;
}

/**
 * Splits a leading `<thinking>`/`<think>`/`<reasoning>` block out of visible content. Kiro models
 * driven by emulated thinking (see `injectThinkingTags`) emit one such block before the answer; it
 * becomes `reasoning_content` and the rest streams verbatim. Tags split across chunks are held back.
 */
export class ThinkTagParser {
  #state: "pre" | "thinking" | "streaming" = "pre";
  #preWhitespace = "";
  #preBuffer = "";
  #thinkingBuffer = "";
  #closeTag = "";

  feed(text: string): ThinkPart[] {
    if (!text) return [];
    if (this.#state === "streaming") return [{ kind: "text", text }];
    if (this.#state === "thinking") {
      const input = this.#thinkingBuffer + text;
      this.#thinkingBuffer = "";
      return this.#drainThinking(input, 0);
    }

    let input = text;
    if (this.#preBuffer) {
      input = this.#preBuffer + text;
      this.#preBuffer = "";
    } else {
      input = text.trimStart();
      this.#preWhitespace += text.slice(0, text.length - input.length);
      if (!input) return [];
    }
    const openTag = OPEN_TAGS.find((tag) => input.startsWith(tag));
    if (openTag) {
      // Whitespace before the tag belongs to the thinking block's framing, not the answer.
      this.#preWhitespace = "";
      this.#state = "thinking";
      this.#closeTag = `</${openTag.slice(1)}`;
      return this.#drainThinking(input, openTag.length);
    }
    if (
      input.length <= MAX_OPEN_TAG &&
      OPEN_TAGS.some((tag) => tag.startsWith(input) && input.length < tag.length)
    ) {
      this.#preBuffer = input;
      return [];
    }
    this.#state = "streaming";
    const out = this.#preWhitespace + input;
    this.#preWhitespace = "";
    return [{ kind: "text", text: out }];
  }

  /** Releases anything held back (end of stream, or before a tool call). */
  flush(): ThinkPart[] {
    if (this.#state === "thinking") {
      const out = this.#thinkingBuffer;
      this.#thinkingBuffer = "";
      this.#state = "streaming";
      return out ? [{ kind: "reasoning", text: out }] : [];
    }
    if (this.#preWhitespace || this.#preBuffer) {
      const out = this.#preWhitespace + this.#preBuffer;
      this.#preWhitespace = "";
      this.#preBuffer = "";
      this.#state = "streaming";
      return [{ kind: "text", text: out }];
    }
    return [];
  }

  #drainThinking(input: string, start: number): ThinkPart[] {
    const parts: ThinkPart[] = [];
    const close = input.indexOf(this.#closeTag, start);
    if (close >= 0) {
      if (close > start) parts.push({ kind: "reasoning", text: input.slice(start, close) });
      const after = input.slice(close + this.#closeTag.length).trimStart();
      this.#state = "streaming";
      if (after) parts.push({ kind: "text", text: after });
      return parts;
    }
    // Keep only what could still be the start of the close tag.
    const cut = Math.max(start, surrogateSafeCut(input, input.length - MAX_CLOSE_TAG));
    if (cut > start) parts.push({ kind: "reasoning", text: input.slice(start, cut) });
    this.#thinkingBuffer = input.slice(cut);
    return parts;
  }
}
