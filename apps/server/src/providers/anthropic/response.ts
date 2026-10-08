// Adapted from lidge-jun/opencodex (MIT)
/**
 * Anthropic Messages response / SSE events -> OpenAI chunks.
 * https://platform.claude.com/docs/en/build-with-claude/streaming
 */
import {
  chunk,
  makeUsage,
  newChunkMeta,
  parseSse,
  usageChunk,
  type ChunkDelta,
  type ChunkMeta,
  type FinishReason,
  type OpenAIChunk,
  type OpenAIUsage,
} from "../chunks.ts";
import { isRecord, str } from "./json.ts";

/**
 * Extended thinking block with the signature Anthropic needs to accept it back on the next turn
 * (required for tool loops). OpenAI chat has no slot for it, so it travels as the `thinking_blocks`
 * extension (same shape LiteLLM uses); clients that ignore it lose nothing.
 */
export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface AnthropicDelta extends ChunkDelta {
  thinking_blocks?: ThinkingBlock[];
}

const STOP_REASONS: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

const finishReason = (stop: unknown): FinishReason =>
  (typeof stop === "string" && STOP_REASONS[stop]) || "stop";

/** Anthropic reports the four counters separately; OpenAI's `prompt_tokens` includes cache reads and writes. */
interface UsageCounters {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function mergeUsage(into: UsageCounters, raw: unknown): void {
  if (!isRecord(raw)) return;
  const take = (v: unknown, current: number) => (typeof v === "number" && v >= 0 ? v : current);
  into.input = take(raw.input_tokens, into.input);
  into.output = take(raw.output_tokens, into.output);
  into.cacheRead = take(raw.cache_read_input_tokens, into.cacheRead);
  into.cacheWrite = take(raw.cache_creation_input_tokens, into.cacheWrite);
}

const toOpenAiUsage = (u: UsageCounters): OpenAIUsage =>
  makeUsage({
    prompt: u.input + u.cacheRead + u.cacheWrite,
    completion: u.output,
    cached: u.cacheRead,
    cacheWrite: u.cacheWrite,
  });

const emptyUsage = (): UsageCounters => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function* finish(meta: ChunkMeta, stop: unknown, usage: UsageCounters): Generator<OpenAIChunk> {
  yield chunk(meta, {}, finishReason(stop));
  yield usageChunk(meta, toOpenAiUsage(usage));
}

/** SSE events of a streaming `/v1/messages` call -> OpenAI chunks (usage in the last chunk). */
export async function* streamChunks(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
): AsyncGenerator<OpenAIChunk> {
  let meta = newChunkMeta(fallbackModel);
  const usage = emptyUsage();
  let stop: unknown = null;
  let done = false;
  let toolCount = 0;
  /** Anthropic block index -> accumulating state of the block that is open. */
  const blocks = new Map<
    number,
    { type: string; thinking: string; signature: string; data: string; tool: number; args: boolean }
  >();

  for await (const event of parseSse(body)) {
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (!isRecord(data)) continue;

    switch (data.type) {
      case "message_start": {
        const message = isRecord(data.message) ? data.message : {};
        if (typeof message.model === "string") meta = { ...meta, model: message.model };
        mergeUsage(usage, message.usage);
        yield chunk(meta, { role: "assistant", content: "" });
        break;
      }
      case "content_block_start": {
        const index = Number(data.index);
        const block = isRecord(data.content_block) ? data.content_block : {};
        const state = {
          type: String(block.type),
          thinking: "",
          signature: "",
          data: typeof block.data === "string" ? block.data : "",
          tool: -1,
          args: false,
        };
        blocks.set(index, state);
        if (block.type === "tool_use") {
          state.tool = toolCount++;
          yield chunk(meta, {
            tool_calls: [
              {
                index: state.tool,
                id: String(block.id),
                type: "function",
                function: { name: String(block.name), arguments: "" },
              },
            ],
          });
        } else if (block.type === "text" && typeof block.text === "string" && block.text) {
          yield chunk(meta, { content: block.text });
        }
        break;
      }
      case "content_block_delta": {
        const state = blocks.get(Number(data.index));
        const delta = isRecord(data.delta) ? data.delta : {};
        if (!state) break;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          yield chunk(meta, { content: delta.text });
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          state.thinking += delta.thinking;
          if (delta.thinking) yield chunk(meta, { reasoning_content: delta.thinking });
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          state.signature += delta.signature;
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          if (delta.partial_json) {
            state.args = true;
            yield chunk(meta, {
              tool_calls: [{ index: state.tool, function: { arguments: delta.partial_json } }],
            });
          }
        }
        break;
      }
      case "content_block_stop": {
        const index = Number(data.index);
        const state = blocks.get(index);
        blocks.delete(index);
        if (!state) break;
        if (state.type === "tool_use" && !state.args) {
          // A tool without parameters streams no input at all; OpenAI clients expect valid JSON.
          yield chunk(meta, { tool_calls: [{ index: state.tool, function: { arguments: "{}" } }] });
        } else if (state.type === "thinking" && state.signature) {
          const block: ThinkingBlock = {
            type: "thinking",
            thinking: state.thinking,
            signature: state.signature,
          };
          yield chunk(meta, { thinking_blocks: [block] } as AnthropicDelta);
        } else if (state.type === "redacted_thinking" && state.data) {
          const block: ThinkingBlock = { type: "redacted_thinking", data: state.data };
          yield chunk(meta, { thinking_blocks: [block] } as AnthropicDelta);
        }
        break;
      }
      case "message_delta": {
        if (isRecord(data.delta) && data.delta.stop_reason) stop = data.delta.stop_reason;
        mergeUsage(usage, data.usage);
        break;
      }
      case "message_stop":
        done = true;
        break;
      case "error": {
        const error = isRecord(data.error) ? data.error : {};
        throw new Error(
          `Anthropic ${str(error.type, "error")}: ${str(error.message, "stream error")}`,
        );
      }
    }
    if (done) break;
  }
  if (!done) throw new Error("Anthropic stream ended before message_stop");
  yield* finish(meta, stop, usage);
}

/** A complete (non-streaming) Message -> the same chunk sequence a stream would have produced. */
export function* messageChunks(
  message: Record<string, unknown>,
  fallbackModel: string,
): Generator<OpenAIChunk> {
  const meta = newChunkMeta(typeof message.model === "string" ? message.model : fallbackModel);
  const usage = emptyUsage();
  mergeUsage(usage, message.usage);
  yield chunk(meta, { role: "assistant", content: "" });

  let tool = 0;
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      yield chunk(meta, { content: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      if (block.thinking) yield chunk(meta, { reasoning_content: block.thinking });
      if (typeof block.signature === "string" && block.signature) {
        const thinking: ThinkingBlock = {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };
        yield chunk(meta, { thinking_blocks: [thinking] } as AnthropicDelta);
      }
    } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
      yield chunk(meta, {
        thinking_blocks: [{ type: "redacted_thinking", data: block.data }],
      } as AnthropicDelta);
    } else if (block.type === "tool_use") {
      yield chunk(meta, {
        tool_calls: [
          {
            index: tool++,
            id: String(block.id),
            type: "function",
            function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) },
          },
        ],
      });
    }
  }
  yield* finish(meta, message.stop_reason, usage);
}
