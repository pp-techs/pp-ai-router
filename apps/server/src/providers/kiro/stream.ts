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
import { KIRO_STRUCTURED_OUTPUT_TOOL_NAME } from "./tools.ts";
import {
  isKiroStructuredCleanStop,
  KIRO_STRUCTURED_EMPTY_FAILURE,
  KIRO_STRUCTURED_TEXT_FAILURE,
  parseKiroStructuredText,
  parseKiroStructuredToolInput,
  type KiroStructuredOutputSpec,
} from "./structured-output.ts";
import { estimateOutputTokens } from "./usage.ts";

export interface KiroStreamContext {
  /** Model name echoed in every chunk. */
  model: string;
  /** Kiro tool name -> client tool name. */
  nameMap: ReadonlyMap<string, string>;
  /** Prompt estimate used when the stream reports no token counts. */
  estimatedInputTokens: number;
  /** Present on a structured-output turn: the private tool's input is relayed as the answer. */
  structured?: KiroStructuredOutputSpec;
}

interface OpenTool {
  id: string;
  name: string;
  input: string[];
}

/**
 * Kiro's safety-filter stops. For Claude models CONTENT_FILTERED is the model's own classifier, a
 * deterministic verdict on this exact context, so it is a refusal, never a retryable failure.
 */
function isContentFilterStop(stopReason: string | undefined): boolean {
  const normalized = stopReason?.trim().toUpperCase();
  return normalized === "CONTENT_FILTERED" || normalized === "GUARDRAIL_INTERVENED";
}

function finishReason(stopReason: string | undefined, sawTool: boolean): FinishReason {
  if (sawTool) return "tool_calls";
  if (isContentFilterStop(stopReason)) return "content_filter";
  return stopReason?.trim().toUpperCase() === "MAX_TOKENS" ? "length" : "stop";
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
  const structured = ctx.structured;
  /**
   * Assistant text held on a structured-output turn. The caller asked for JSON, so text is
   * commentary until the private tool's validated input (or a clean-stop text answer) settles the
   * turn; it is emitted once a real tool call proves the turn continues, and withheld otherwise.
   */
  const prose: string[] = [];
  /** The validated JSON answer from the private structured-output tool. */
  let structuredJson: string | undefined;

  const takeProse = (): string => {
    const text = prose.join("");
    prose.length = 0;
    return text;
  };

  const proseChunks = (): OpenAIChunk[] => {
    const text = takeProse();
    if (!text) return [];
    sawOutput = true;
    return [chunk(meta, { content: text })];
  };

  const emitText = (parts: ThinkPart[]): OpenAIChunk[] =>
    parts
      .map(({ kind, text }) => {
        output.push(text);
        if (kind === "text" && structured) {
          // The validated answer is terminal: text after it is not part of the turn's output.
          if (structuredJson !== undefined) return undefined;
          if (toolCalls === 0) {
            prose.push(text);
            return undefined;
          }
        }
        if (text.trim()) sawOutput = true;
        return kind === "reasoning"
          ? chunk(meta, { reasoning_content: text })
          : chunk(meta, { content: text });
      })
      .filter((c): c is OpenAIChunk => c !== undefined);

  /**
   * Close one tool call. The private structured-output tool is terminal: its input is validated and
   * relayed as the answer instead of a tool call. Every other call is emitted whole, as before.
   */
  const finishTool = (tool: OpenTool): OpenAIChunk | undefined => {
    const input = tool.input.join("");
    if (tool.name === KIRO_STRUCTURED_OUTPUT_TOOL_NAME) {
      if (!structured)
        throw new Error(
          "Kiro response protocol error: it called the reserved structured-output tool this turn did not advertise",
        );
      if (structuredJson !== undefined)
        throw new Error("Kiro returned more than one private structured-output tool call");
      const parsed = parseKiroStructuredToolInput(structured, input);
      if ("error" in parsed) throw new Error(parsed.error);
      structuredJson = parsed.json;
      prose.length = 0;
      return undefined;
    }
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
          // A real tool call proves the turn continues, so held text becomes ordinary commentary;
          // the private structured-output call supersedes it instead.
          if (done.name !== KIRO_STRUCTURED_OUTPUT_TOOL_NAME) yield* proseChunks();
          const finished = finishTool(done);
          if (finished) yield finished;
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
    // A structured call left open at end of stream goes through validation like a closed one; every
    // other open call keeps the truncation guard.
    if (tool.name !== KIRO_STRUCTURED_OUTPUT_TOOL_NAME && !isCompleteToolInput(tool.input.join("")))
      throw new Error(truncationMessage("stream ended before tool stop"));
    const finished = finishTool(tool);
    if (finished) yield finished;
  }

  if (stopReason?.trim().toUpperCase() === "MODEL_CONTEXT_WINDOW_EXCEEDED")
    throw new Error("Kiro stopped because the model context window was exhausted");

  if (structured) {
    if (structuredJson !== undefined) {
      prose.length = 0;
      sawOutput = true;
      yield chunk(meta, { content: structuredJson });
    } else if (toolCalls === 0) {
      // A clean stop with text that already IS the requested JSON has answered; the schema is
      // checked exactly as it would be on a tool call.
      if (isKiroStructuredCleanStop(stopReason?.trim().toUpperCase())) {
        const text = takeProse();
        const json = parseKiroStructuredText(structured, text);
        if (json === undefined)
          throw new Error(
            text.trim() ? KIRO_STRUCTURED_TEXT_FAILURE : KIRO_STRUCTURED_EMPTY_FAILURE,
          );
        sawOutput = true;
        yield chunk(meta, { content: json });
      } else {
        // A stop that ended the inference (MAX_TOKENS, a filter, an exhausted context window) is
        // never mistaken for an answer, even when its prefix parses: the stop keeps its own
        // terminal and the held prose is withheld from a structured-output caller.
        if (prose.length > 0) sawOutput = true;
        prose.length = 0;
      }
    } else {
      // A real tool call already flushed the commentary around it.
      prose.length = 0;
    }
  }

  // A tool-less turn Kiro refuses arrives with no content at all. It ends as a `content_filter` stop
  // rather than the empty-stream failure, which would be retried (or failed over) only to be refused
  // again. A stream with no content and no filter stop is still an empty-stream failure.
  if (!sawOutput && !isContentFilterStop(stopReason))
    throw new Error("Kiro returned a successful but empty response stream");

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
