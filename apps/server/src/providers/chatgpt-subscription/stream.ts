// Adapted from can1357/oh-my-pi (MIT): packages/ai providers/openai-codex-responses.ts (#handleStreamEvent,
// #handleOutputItemDone, #handleResponseCompleted), providers/openai-shared.ts (mapOpenAIResponsesStopReason,
// populateResponsesUsageFromResponse); the SSE plumbing and the chat-completions chunks are
// lidge-jun/opencodex (MIT): src/adapters/openai-responses/*, src/bridge/sse.ts.
/**
 * Codex Responses SSE -> OpenAI chat-completions chunks. Text, refusals, reasoning summaries and function
 * calls are translated as they stream; usage and the finish reason come from the terminal event.
 */
import {
  chunk,
  makeUsage,
  newChunkMeta,
  parseSse,
  usageChunk,
  type FinishReason,
  type OpenAIChunk,
} from "../chunks.ts";
import { isRecord, str } from "../anthropic/json.ts";
import { streamFailure } from "./errors.ts";

/** One function call being streamed: its chat-completions `index` and the argument text sent so far. */
interface Call {
  index: number;
  sent: string;
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * The finish reason of a terminal event, by the response `status` (omp `mapOpenAIResponsesStopReason`):
 * `completed` stops (or hands over to the tool calls), `incomplete` is `length` unless the cap cut the
 * answer after every call was complete, in which case the calls are promoted like omp does. A filtered
 * answer keeps its own reason, which chat completions has and omp's agent does not.
 */
function finishReason(
  response: Record<string, unknown>,
  toolCalls: number,
  unfinishedCalls: number,
): FinishReason {
  const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
  if (details.reason === "content_filter") return "content_filter";
  if (response.status === "incomplete") {
    return details.reason === "max_output_tokens" && toolCalls > 0 && unfinishedCalls === 0
      ? "tool_calls"
      : "length";
  }
  return toolCalls > 0 ? "tool_calls" : "stop";
}

/** `response.output_item.done` of a message: its text parts, for a stream that sent no text deltas. */
function messageText(item: Record<string, unknown>): string {
  return (Array.isArray(item.content) ? item.content : [])
    .map((part) =>
      isRecord(part) ? (part.type === "refusal" ? str(part.refusal) : str(part.text)) : "",
    )
    .join("");
}

/** `response.output_item.done` of a reasoning item: its summary parts joined like streamed ones. */
function summaryText(item: Record<string, unknown>): string {
  return (Array.isArray(item.summary) ? item.summary : [])
    .map((part) => (isRecord(part) ? str(part.text) : ""))
    .filter(Boolean)
    .join("\n\n");
}

export async function* codexChunks(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<OpenAIChunk> {
  const meta = newChunkMeta(model);
  const byItem = new Map<string, Call>();
  const byIndex = new Map<number, Call>();
  const streamedText = new Set<string>();
  const streamedSummary = new Set<string>();
  let toolCalls = 0;
  let unfinishedCalls = 0;
  let reasoned = false;
  let partBreak = false;

  const callFor = (itemId: unknown, outputIndex: unknown): Call | undefined =>
    (typeof itemId === "string" ? byItem.get(itemId) : undefined) ??
    (typeof outputIndex === "number" ? byIndex.get(outputIndex) : undefined);

  function* startCall(item: Record<string, unknown>, outputIndex: unknown): Generator<OpenAIChunk> {
    const call: Call = { index: toolCalls++, sent: "" };
    unfinishedCalls++;
    if (typeof item.id === "string") byItem.set(item.id, call);
    if (typeof outputIndex === "number") byIndex.set(outputIndex, call);
    yield chunk(meta, {
      tool_calls: [
        {
          index: call.index,
          id: str(item.call_id) || str(item.id),
          type: "function",
          function: { name: str(item.name), arguments: "" },
        },
      ],
    });
  }

  /** Sends the part of `full` the stream has not delivered yet (a `.done` event or item carries it whole). */
  function* flushArguments(call: Call, full: unknown): Generator<OpenAIChunk> {
    if (typeof full !== "string" || full.length <= call.sent.length || !full.startsWith(call.sent))
      return;
    const rest = full.slice(call.sent.length);
    call.sent = full;
    yield chunk(meta, { tool_calls: [{ index: call.index, function: { arguments: rest } }] });
  }

  yield chunk(meta, { role: "assistant", content: "" });

  for await (const sse of parseSse(body)) {
    if (sse.data === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(sse.data);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const type = str(event.type, sse.event ?? "");
    const item = isRecord(event.item) ? event.item : {};

    switch (type) {
      case "response.output_item.added":
        if (item.type === "function_call") yield* startCall(item, event.output_index);
        break;

      case "response.output_text.delta":
      case "response.refusal.delta":
        if (typeof event.delta === "string" && event.delta) {
          if (typeof event.item_id === "string") streamedText.add(event.item_id);
          yield chunk(meta, { content: event.delta });
        }
        break;

      case "response.reasoning_summary_part.added":
        partBreak = reasoned;
        break;

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (typeof event.delta === "string" && event.delta) {
          if (typeof event.item_id === "string") streamedSummary.add(event.item_id);
          yield chunk(meta, { reasoning_content: (partBreak ? "\n\n" : "") + event.delta });
          reasoned = true;
          partBreak = false;
        }
        break;

      case "response.function_call_arguments.delta": {
        const call = callFor(event.item_id, event.output_index);
        if (call && typeof event.delta === "string" && event.delta) {
          call.sent += event.delta;
          yield chunk(meta, {
            tool_calls: [{ index: call.index, function: { arguments: event.delta } }],
          });
        }
        break;
      }

      case "response.function_call_arguments.done": {
        const call = callFor(event.item_id, event.output_index);
        if (call) yield* flushArguments(call, event.arguments);
        break;
      }

      case "response.output_item.done":
        if (item.type === "function_call") {
          let call = callFor(item.id, event.output_index);
          if (!call) {
            yield* startCall(item, event.output_index);
            call = callFor(item.id, event.output_index);
          }
          if (call) {
            yield* flushArguments(call, item.arguments);
            // A tool without parameters streams no arguments at all; OpenAI clients expect valid JSON.
            if (call.sent === "") yield* flushArguments(call, "{}");
            unfinishedCalls = Math.max(0, unfinishedCalls - 1);
          }
        } else if (item.type === "message" && !streamedText.has(str(item.id))) {
          const text = messageText(item);
          if (text) yield chunk(meta, { content: text });
        } else if (item.type === "reasoning" && !streamedSummary.has(str(item.id))) {
          const text = summaryText(item);
          if (text) {
            yield chunk(meta, { reasoning_content: (reasoned ? "\n\n" : "") + text });
            reasoned = true;
          }
        }
        break;

      case "response.completed":
      case "response.done":
      case "response.incomplete": {
        const response = isRecord(event.response) ? event.response : {};
        // A terminal event can carry a response that failed or was cancelled (omp stop reason `error`).
        if (response.status === "failed" || response.status === "cancelled")
          throw streamFailure(event);
        yield chunk(meta, {}, finishReason(response, toolCalls, unfinishedCalls));
        const usage = isRecord(response.usage) ? response.usage : undefined;
        if (usage) {
          const input = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
          const output = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
          yield usageChunk(
            meta,
            makeUsage({
              prompt: count(usage.input_tokens),
              completion: count(usage.output_tokens),
              cached: count(input.cached_tokens) || count(usage.prompt_cache_hit_tokens),
              cacheWrite: count(input.cache_write_tokens),
              reasoning: count(output.reasoning_tokens),
            }),
          );
        }
        return;
      }

      case "error":
      case "response.failed":
        throw streamFailure(event);

      default:
        // created, in_progress, content_part.*, codex.rate_limits, response.metadata, ...
        break;
    }
  }
  throw new Error("Codex stream ended before terminal completion event");
}
