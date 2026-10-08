// Adapted from lidge-jun/opencodex (MIT)
import {
  chunk,
  makeUsage,
  newChunkMeta,
  parseSse,
  usageChunk,
  type ChunkMeta,
  type FinishReason,
  type OpenAIChunk,
  type OpenAIUsage,
} from "../chunks.ts";
import { isRecord } from "./json.ts";
import { clearReplay, observeReplay } from "./replay.ts";

const CONTENT_FILTER_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
]);

/**
 * Google reports `promptTokenCount` INCLUDING the cached part and `candidatesTokenCount` EXCLUDING the
 * thinking tokens (`thoughtsTokenCount`), with `toolUsePromptTokenCount` on the input side. OpenAI
 * semantics: prompt includes cached, completion includes reasoning.
 */
function usageFromGemini(usage: Record<string, unknown>): OpenAIUsage {
  const n = (key: string): number => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const reasoning = n("thoughtsTokenCount");
  return makeUsage({
    prompt: n("promptTokenCount") + n("toolUsePromptTokenCount"),
    completion: n("candidatesTokenCount") + reasoning,
    cached: n("cachedContentTokenCount"),
    reasoning,
  });
}

/** Stateful Cloud Code Assist frame -> OpenAI chunk translator, shared by the SSE and the buffered path. */
export class GeminiMapper {
  readonly #meta: ChunkMeta;
  readonly #wireModelId: string;
  readonly #sessionId: string;
  readonly #restoreToolName: (name: string) => string;
  #started = false;
  #sawFrame = false;
  #sawTerminal = false;
  #toolCalls = 0;
  #finishReason: string | undefined;
  #usage: OpenAIUsage | undefined;
  #carriedSignature: string | undefined;

  constructor(opts: {
    model: string;
    wireModelId: string;
    sessionId: string;
    restoreToolName: (name: string) => string;
  }) {
    this.#meta = newChunkMeta(opts.model);
    this.#wireModelId = opts.wireModelId;
    this.#sessionId = opts.sessionId;
    this.#restoreToolName = opts.restoreToolName;
  }

  /** Frames that are not JSON objects are padding and skipped; a malformed claimed structure throws. */
  push(frame: unknown): OpenAIChunk[] {
    if (!isRecord(frame)) return [];
    this.#sawFrame = true;

    if (frame.error) {
      const message =
        isRecord(frame.error) && typeof frame.error.message === "string"
          ? frame.error.message
          : "upstream error";
      // Replayed signatures that upstream rejects must not be sent again.
      if (/invalid_argument|invalid argument|signature/i.test(message)) {
        clearReplay(this.#wireModelId, this.#sessionId);
      }
      throw new Error(message);
    }

    const root = frame.response;
    if (!isRecord(root)) throw new Error("Antigravity response missing response wrapper");

    // usageMetadata is independent of candidates: read it first so a usage-only final frame is kept.
    if (isRecord(root.usageMetadata)) {
      this.#usage = usageFromGemini(root.usageMetadata);
      this.#sawTerminal = true;
    }
    if (isRecord(root.promptFeedback) && typeof root.promptFeedback.blockReason === "string") {
      throw new Error(`Antigravity blocked the prompt (${root.promptFeedback.blockReason})`);
    }

    const candidates = root.candidates;
    if (candidates === undefined || candidates === null) return [];
    if (!Array.isArray(candidates))
      throw new Error("Antigravity response contained invalid candidates");
    if (candidates.length === 0) return [];
    const candidate: unknown = candidates[0];
    if (!isRecord(candidate))
      throw new Error("Antigravity response contained an invalid candidate");

    if (typeof candidate.finishReason === "string" && candidate.finishReason) {
      this.#finishReason = candidate.finishReason;
      this.#sawTerminal = true;
    }

    const content = candidate.content;
    if (content === undefined || content === null) return [];
    if (!isRecord(content)) {
      if (Array.isArray(content) && content.length === 0) return [];
      throw new Error("Antigravity response contained invalid content");
    }
    if (content.parts === undefined || content.parts === null) return [];
    if (!Array.isArray(content.parts))
      throw new Error("Antigravity response contained invalid content parts");
    const parts: unknown[] = content.parts;
    for (const part of parts) {
      if (!isRecord(part))
        throw new Error("Antigravity response contained an invalid content part");
      if (part.functionCall === undefined || part.functionCall === null) continue;
      if (
        !isRecord(part.functionCall) ||
        typeof part.functionCall.name !== "string" ||
        !part.functionCall.name.trim()
      ) {
        throw new Error(
          "Antigravity response contained an invalid function call — cannot dispatch",
        );
      }
    }

    this.#carriedSignature = observeReplay(
      this.#wireModelId,
      this.#sessionId,
      parts,
      this.#carriedSignature,
    );

    const out: OpenAIChunk[] = [];
    const emit = (delta: Parameters<typeof chunk>[1]) => {
      if (!this.#started) {
        this.#started = true;
        out.push(chunk(this.#meta, { role: "assistant", content: "" }));
      }
      out.push(chunk(this.#meta, delta));
    };
    for (const part of parts as Record<string, unknown>[]) {
      if (typeof part.text === "string" && part.text.length > 0) {
        emit(part.thought === true ? { reasoning_content: part.text } : { content: part.text });
      }
      const inline = part.inlineData;
      if (isRecord(inline) && typeof inline.data === "string") {
        const mime = typeof inline.mimeType === "string" ? inline.mimeType : "image/png";
        emit({ content: `\n![image](data:${mime};base64,${inline.data})\n` });
      }
      if (isRecord(part.functionCall)) {
        const call = part.functionCall as { name: string; args?: unknown };
        emit({
          tool_calls: [
            {
              index: this.#toolCalls++,
              id: `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
              type: "function",
              function: {
                name: this.#restoreToolName(call.name),
                arguments: JSON.stringify(call.args ?? {}),
              },
            },
          ],
        });
      }
    }
    return out;
  }

  /** Terminal chunks, or a throw when the turn was cut off or never completed. */
  finish(): OpenAIChunk[] {
    const reason = this.#finishReason;
    // A turn cut off mid tool call (or a dropped malformed call) must fail closed, not look complete.
    if (reason === "MALFORMED_FUNCTION_CALL" || (reason === "MAX_TOKENS" && this.#toolCalls > 0)) {
      throw new Error(
        `Antigravity response truncated upstream before the turn completed (${reason.slice(0, 160)})`,
      );
    }
    if (!this.#sawFrame || !this.#sawTerminal) {
      throw new Error("upstream stream ended without a terminal signal — possible truncation");
    }
    const finish: FinishReason =
      reason === "MAX_TOKENS"
        ? "length"
        : CONTENT_FILTER_REASONS.has(reason ?? "")
          ? "content_filter"
          : this.#toolCalls > 0
            ? "tool_calls"
            : "stop";
    const out: OpenAIChunk[] = [];
    if (!this.#started) out.push(chunk(this.#meta, { role: "assistant", content: "" }));
    out.push(chunk(this.#meta, {}, finish));
    if (this.#usage) out.push(usageChunk(this.#meta, this.#usage));
    return out;
  }
}

/** Streaming path: decodes SSE (frames may be split across network chunks) and maps each frame. */
export async function* chunksFromSse(
  body: ReadableStream<Uint8Array>,
  mapper: GeminiMapper,
): AsyncGenerator<OpenAIChunk> {
  for await (const event of parseSse(body)) {
    const data = event.data.trim();
    if (!data) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      throw new Error("malformed upstream SSE data frame");
    }
    yield* mapper.push(frame);
  }
  yield* mapper.finish();
}

/** Buffered path: the whole `generateContent` JSON is one frame. */
export async function* chunksFromJson(
  res: Response,
  mapper: GeminiMapper,
): AsyncGenerator<OpenAIChunk> {
  let frame: unknown;
  try {
    frame = await res.json();
  } catch {
    throw new Error("Antigravity response was not valid JSON");
  }
  yield* mapper.push(frame);
  yield* mapper.finish();
}
