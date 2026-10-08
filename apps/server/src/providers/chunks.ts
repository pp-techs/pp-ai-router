/**
 * Shared plumbing for adapters that speak a non-OpenAI wire format. An adapter turns its upstream
 * stream into `OpenAIChunk`s; `respond()` then serves them as SSE or aggregates them into one
 * `chat.completion` JSON, so adapters never hand-roll either envelope.
 */

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface ChunkDelta {
  role?: "assistant";
  content?: string | null;
  /** Extended thinking text (the de-facto `reasoning_content` extension used by DeepSeek/OpenRouter-style APIs). */
  reasoning_content?: string;
  tool_calls?: ToolCallDelta[];
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface OpenAIChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: { index: number; delta: ChunkDelta; finish_reason: FinishReason | null }[];
  usage?: OpenAIUsage | null;
}

export interface ChunkMeta {
  id: string;
  model: string;
  created: number;
}

export function newChunkMeta(model: string): ChunkMeta {
  return { id: `chatcmpl-${crypto.randomUUID()}`, model, created: Math.floor(Date.now() / 1000) };
}

export function chunk(
  meta: ChunkMeta,
  delta: ChunkDelta,
  finish: FinishReason | null = null,
  usage?: OpenAIUsage,
): OpenAIChunk {
  const out: OpenAIChunk = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) out.usage = usage;
  return out;
}

/** Usage-only chunk (empty `choices`), as OpenAI sends when `stream_options.include_usage` is set. */
export function usageChunk(meta: ChunkMeta, usage: OpenAIUsage): OpenAIChunk {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [],
    usage,
  };
}

export function makeUsage(input: {
  prompt: number;
  completion: number;
  cached?: number;
  cacheWrite?: number;
  reasoning?: number;
}): OpenAIUsage {
  const usage: OpenAIUsage = {
    prompt_tokens: input.prompt,
    completion_tokens: input.completion,
    total_tokens: input.prompt + input.completion,
  };
  if (input.cached || input.cacheWrite) {
    usage.prompt_tokens_details = {
      ...(input.cached ? { cached_tokens: input.cached } : {}),
      ...(input.cacheWrite ? { cache_write_tokens: input.cacheWrite } : {}),
    };
  }
  if (input.reasoning) usage.completion_tokens_details = { reasoning_tokens: input.reasoning };
  return usage;
}

const encoder = new TextEncoder();

export const encodeSse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** SSE response from chunks. A mid-stream failure becomes an `error` event so clients see why it stopped. */
export function sseResponse(chunks: AsyncIterable<OpenAIChunk>, init: ResponseInit = {}): Response {
  async function* frames(): AsyncGenerator<Uint8Array> {
    try {
      for await (const c of chunks) yield encoder.encode(encodeSse(c));
    } catch (error) {
      yield encoder.encode(
        encodeSse({
          error: {
            message: (error as Error).message,
            type: "upstream_error",
            code: "upstream_error",
          },
        }),
      );
    }
    yield encoder.encode("data: [DONE]\n\n");
  }
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/event-stream");
  return new Response(ReadableStream.from(frames()), { ...init, headers });
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: 0;
    message: {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason: FinishReason;
  }[];
  usage?: OpenAIUsage;
}

/** Folds a chunk stream into one non-streaming completion. Throws if the stream throws. */
export async function aggregateChunks(chunks: AsyncIterable<OpenAIChunk>): Promise<ChatCompletion> {
  let id = "";
  let model = "";
  let created = 0;
  let content = "";
  let reasoning = "";
  let finish: FinishReason = "stop";
  let usage: OpenAIUsage | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const c of chunks) {
    id ||= c.id;
    model ||= c.model;
    created ||= c.created;
    if (c.usage) usage = c.usage;
    for (const choice of c.choices) {
      if (choice.delta.content) content += choice.delta.content;
      if (choice.delta.reasoning_content) reasoning += choice.delta.reasoning_content;
      for (const t of choice.delta.tool_calls ?? []) {
        const call = calls.get(t.index) ?? { id: "", name: "", arguments: "" };
        if (t.id) call.id = t.id;
        if (t.function?.name) call.name += t.function.name;
        if (t.function?.arguments) call.arguments += t.function.arguments;
        calls.set(t.index, call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }

  const message: ChatCompletion["choices"][number]["message"] = {
    role: "assistant",
    content: content || null,
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.size > 0) {
    message.tool_calls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      }));
  }
  const out: ChatCompletion = {
    id: id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
  };
  if (usage) out.usage = usage;
  return out;
}

/**
 * Serves an adapter's chunk stream in the shape the client asked for. For non-streaming requests the
 * upstream is fully consumed first, so an upstream failure surfaces as a thrown error (-> retry/failover)
 * instead of a half-written response.
 */
export async function respond(
  chunks: AsyncIterable<OpenAIChunk>,
  stream: boolean,
): Promise<Response> {
  if (stream) return sseResponse(chunks);
  return Response.json(await aggregateChunks(chunks));
}

export interface SseEvent {
  event: string | undefined;
  data: string;
}

/** Incremental Server-Sent-Events reader (handles CRLF, multi-line data, comments, and a missing final blank line). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const flush = (): SseEvent | null => {
    if (data.length === 0) {
      event = undefined;
      return null;
    }
    const out = { event, data: data.join("\n") };
    event = undefined;
    data = [];
    return out;
  };
  const consume = function* (line: string): Generator<SseEvent> {
    if (line === "") {
      const e = flush();
      if (e) yield e;
    } else if (line.startsWith(":")) {
      // comment / keep-alive
    } else {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  };

  for await (const part of body) {
    buffer += decoder.decode(part, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      yield* consume(line);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield* consume(buffer.replace(/\r$/, ""));
  const last = flush();
  if (last) yield last;
}
