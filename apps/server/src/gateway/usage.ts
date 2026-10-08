import type { Usage } from "../pricing/types.ts";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Reads an OpenAI-style `usage` object. Cache/reasoning counts come from `*_tokens_details`;
 * `prompt_cache_hit_tokens` (DeepSeek) is accepted as a cached-token fallback.
 */
export function parseOpenAiUsage(raw: unknown): Usage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.prompt_tokens !== "number" && typeof u.completion_tokens !== "number") return null;
  const prompt = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completion = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    cachedTokens: num(prompt.cached_tokens) || num(u.prompt_cache_hit_tokens),
    cacheWriteTokens: num(prompt.cache_write_tokens),
    reasoningTokens: num(completion.reasoning_tokens),
  };
}

export type StreamEnd = "ok" | "aborted" | "error";

/**
 * Passes SSE bytes through untouched while watching for the `usage` chunk. `onFinish` fires exactly
 * once: after the last byte (`ok`), when the client cancels (`aborted`) or when upstream errors.
 */
export function tapStream(
  body: ReadableStream<Uint8Array>,
  onFinish: (result: { usage: Usage | null; end: StreamEnd }) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let usage: Usage | null = null;
  let finished = false;

  const finish = (end: StreamEnd) => {
    if (finished) return;
    finished = true;
    onFinish({ usage, end });
  };

  const scan = (text: string) => {
    pending += text;
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trimEnd();
      pending = pending.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]" || !data.includes('"usage"')) continue;
      try {
        const parsed = parseOpenAiUsage((JSON.parse(data) as { usage?: unknown }).usage);
        if (parsed) usage = parsed;
      } catch {
        // A malformed chunk must never break the passthrough.
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          scan(decoder.decode());
          finish("ok");
          controller.close();
          return;
        }
        scan(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (error) {
        finish("error");
        controller.error(error);
      }
    },
    cancel(reason) {
      finish("aborted");
      return reader.cancel(reason);
    },
  });
}
