// Adapted from lidge-jun/opencodex (MIT)
import {
  chunk,
  makeUsage,
  newChunkMeta,
  usageChunk,
  type FinishReason,
  type OpenAIChunk,
  type OpenAIUsage,
} from "../chunks.ts";
import { describeKiroFailure } from "./errors.ts";
import { decodeEventStream } from "./eventstream.ts";
import {
  isCompleteToolInput,
  parseKiroEvent,
  truncationMessage,
  type KiroTokenUsage,
} from "./events.ts";
import { ThinkTagParser, type ThinkPart } from "./think-tags.ts";
import { estimateOutputTokens } from "./usage.ts";

export interface KiroStreamContext {
  /** Model name echoed in every chunk. */
  model: string;
  /** Kiro tool name -> client tool name. */
  nameMap: ReadonlyMap<string, string>;
  /** Prompt estimate used when the stream reports no token counts. */
  estimatedInputTokens: number;
}

interface OpenTool {
  id: string;
  name: string;
  input: string[];
}

function finishReason(stopReason: string | undefined, sawTool: boolean): FinishReason {
  if (sawTool) return "tool_calls";
  switch (stopReason?.trim().toUpperCase()) {
    case "MAX_TOKENS":
      return "length";
    case "CONTENT_FILTERED":
    case "GUARDRAIL_INTERVENED":
      return "content_filter";
    default:
      return "stop";
  }
}

function toOpenAiUsage(usage: KiroTokenUsage): OpenAIUsage {
  return makeUsage({
    prompt: usage.inputTokens,
    completion: usage.outputTokens,
    ...(usage.cacheRead !== undefined ? { cached: usage.cacheRead } : {}),
    ...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
  });
}

/**
 * Maps a `GenerateAssistantResponse` event stream to OpenAI chunks: text, reasoning (native
 * `reasoningContentEvent` and inline `<thinking>` blocks), tool calls (emitted whole once Kiro marks
 * them stopped, so incomplete input is never forwarded), then the finish reason and a usage chunk.
 * Anything Kiro reports as a failure, and any protocol violation, throws: `respond()` turns that
 * into an SSE error event or, for non-streaming requests, a failed upstream attempt.
 */
export async function* kiroChunks(
  body: ReadableStream<Uint8Array>,
  ctx: KiroStreamContext,
): AsyncGenerator<OpenAIChunk> {
  const meta = newChunkMeta(ctx.model);
  const think = new ThinkTagParser();
  const output: string[] = [];
  let open: OpenTool | null = null;
  let toolCalls = 0;
  let sawOutput = false;
  let usage: KiroTokenUsage | undefined;
  let stopReason: string | undefined;

  const emitText = (parts: ThinkPart[]): OpenAIChunk[] =>
    parts.map(({ kind, text }) => {
      output.push(text);
      if (text.trim()) sawOutput = true;
      return kind === "reasoning"
        ? chunk(meta, { reasoning_content: text })
        : chunk(meta, { content: text });
    });

  const finishTool = (tool: OpenTool): OpenAIChunk => {
    const input = tool.input.join("");
    if (!isCompleteToolInput(input))
      throw new Error(truncationMessage("incomplete tool input JSON"));
    sawOutput = true;
    return chunk(meta, {
      tool_calls: [
        {
          index: toolCalls++,
          id: tool.id,
          type: "function",
          function: {
            name: ctx.nameMap.get(tool.name) ?? tool.name,
            arguments: input.trim() ? input : "{}",
          },
        },
      ],
    });
  };

  yield chunk(meta, { role: "assistant", content: "" });

  for await (const msg of decodeEventStream(body)) {
    const messageType = msg.headers[":message-type"];
    if (messageType === "exception" || messageType === "error") {
      const failure = describeKiroFailure(
        undefined,
        msg.headers[":exception-type"] ?? msg.headers[":error-type"],
        new TextDecoder().decode(msg.payload),
      );
      throw new Error(failure.message);
    }
    if (messageType !== "event")
      throw new Error(
        `Kiro response protocol error: unsupported Smithy message type ${JSON.stringify(messageType ?? "missing")}`,
      );
    const eventType = msg.headers[":event-type"];
    if (!eventType) throw new Error("Kiro response protocol error: event is missing :event-type");

    const ev = parseKiroEvent(eventType, msg.payload);
    if (!ev) continue;
    switch (ev.type) {
      case "metadata":
        usage = ev.usage ?? usage;
        stopReason = ev.stopReason ?? stopReason;
        break;
      case "content":
        if (open) throw new Error(truncationMessage("content arrived before tool stop"));
        if (ev.data) yield* emitText(think.feed(ev.data));
        break;
      case "reasoning":
        yield* emitText(think.flush());
        if (ev.data) yield* emitText([{ kind: "reasoning", text: ev.data }]);
        break;
      case "tool": {
        yield* emitText(think.flush());
        if (!open) {
          if (ev.stop === true)
            throw new Error(
              "Kiro response protocol error: tool stop received without an open tool call",
            );
          if (!ev.toolUseId || !ev.name)
            throw new Error(
              "Kiro response protocol error: new tool event is missing toolUseId or name",
            );
          open = { id: ev.toolUseId, name: ev.name, input: [] };
        } else if (
          (ev.toolUseId && ev.toolUseId !== open.id) ||
          (ev.name && ev.name !== open.name)
        ) {
          throw new Error(truncationMessage("tool input changed identity before stop"));
        }
        if (ev.input !== undefined) {
          open.input.push(ev.input);
          output.push(ev.input);
        }
        if (ev.stop === true) {
          const done: OpenTool = open;
          open = null;
          yield finishTool(done);
        }
        break;
      }
      case "invalid_state":
        throw new Error(
          describeKiroFailure(undefined, undefined, ev.message ?? "Kiro entered an invalid state")
            .message,
        );
      case "error":
        throw new Error(
          describeKiroFailure(
            undefined,
            undefined,
            JSON.stringify({
              reason: ev.reason ?? "",
              message: ev.message ?? "Kiro request failed",
            }),
          ).message,
        );
      case "truncation":
        throw new Error(truncationMessage(ev.reason));
    }
  }

  yield* emitText(think.flush());
  if (open) {
    const tool: OpenTool = open;
    if (!isCompleteToolInput(tool.input.join("")))
      throw new Error(truncationMessage("stream ended before tool stop"));
    yield finishTool(tool);
  }

  if (stopReason?.trim().toUpperCase() === "MODEL_CONTEXT_WINDOW_EXCEEDED")
    throw new Error("Kiro stopped because the model context window was exhausted");
  if (!sawOutput) throw new Error("Kiro returned a successful but empty response stream");

  yield chunk(meta, {}, finishReason(stopReason, toolCalls > 0));
  yield usageChunk(
    meta,
    usage
      ? toOpenAiUsage(usage)
      : makeUsage({
          prompt: ctx.estimatedInputTokens,
          completion: estimateOutputTokens(output.join("")),
        }),
  );
}
