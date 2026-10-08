/**
 * Inbound Anthropic Messages API (`POST /v1/messages`), so Claude Code and the Anthropic SDKs can point
 * at the router. The request is translated to canonical OpenAI chat completions, run through the same
 * pipeline as `/v1/chat/completions` (limits, routing, pool, accounting) and the OpenAI response is
 * translated back to Anthropic message JSON / SSE events.
 * https://platform.claude.com/docs/en/api/messages/create
 */
import type { Context } from "hono";
import * as z from "zod";
import { HttpError } from "../errors.ts";
import { isRecord, str } from "../providers/anthropic/json.ts";
import { effortFromBudget } from "../providers/anthropic/request.ts";
import { parseSse } from "../providers/chunks.ts";
import type { ChatBody, Pipeline } from "./chat.ts";
import { parseOpenAiUsage } from "./usage.ts";

const requestSchema = z.looseObject({
  model: z.string().min(1),
  max_tokens: z.number().int().min(1),
  messages: z.array(z.unknown()).min(1),
  stream: z.boolean().optional(),
});
type MessagesRequest = z.infer<typeof requestSchema>;

type Json = Record<string, unknown>;

const invalid = (message: string) => new HttpError(400, "invalid_request", message);

// --- Anthropic request -> canonical OpenAI request ---------------------------------------------

/** Anthropic `text` blocks -> OpenAI text parts (`cache_control` kept for providers that honour it). */
function textPart(block: Json): Json {
  const part: Json = { type: "text", text: str(block.text) };
  if (isRecord(block.cache_control)) part.cache_control = block.cache_control;
  return part;
}

function imagePart(block: Json): Json {
  const source = isRecord(block.source) ? block.source : {};
  let url: string;
  if (source.type === "base64")
    url = `data:${String(source.media_type)};base64,${String(source.data)}`;
  else if (source.type === "url" && typeof source.url === "string") url = source.url;
  else throw invalid("image source must be base64 or url.");
  const part: Json = { type: "image_url", image_url: { url } };
  if (isRecord(block.cache_control)) part.cache_control = block.cache_control;
  return part;
}

/** One plain text part is sent as a string; anything richer keeps its parts (images, cache_control). */
const collapse = (parts: Json[]): string | Json[] =>
  parts.length === 1 && parts[0]!.type === "text" && !parts[0]!.cache_control
    ? (parts[0]!.text as string)
    : parts;

function toolResultMessage(block: Json, images: Json[]): Json {
  const texts: string[] = [];
  if (typeof block.content === "string") texts.push(block.content);
  else {
    for (const inner of Array.isArray(block.content) ? block.content : []) {
      if (!isRecord(inner)) continue;
      if (inner.type === "text") texts.push(str(inner.text));
      else if (inner.type === "image") images.push(imagePart(inner));
      else throw invalid(`Unsupported tool_result content type "${String(inner.type)}".`);
    }
  }
  const message: Json = {
    role: "tool",
    tool_call_id: String(block.tool_use_id),
    content: texts.join("\n"),
  };
  if (isRecord(block.cache_control)) message.cache_control = block.cache_control;
  return message;
}

function userMessages(content: unknown): Json[] {
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content))
    throw invalid("message content must be a string or an array of blocks.");
  const out: Json[] = [];
  const parts: Json[] = [];
  const images: Json[] = []; // images inside tool results have no tool-role slot in OpenAI chat
  for (const block of content) {
    if (!isRecord(block)) throw invalid("content blocks must be objects.");
    if (block.type === "tool_result") out.push(toolResultMessage(block, images));
    else if (block.type === "text") parts.push(textPart(block));
    else if (block.type === "image") parts.push(imagePart(block));
    else throw invalid(`Unsupported user content block type "${String(block.type)}".`);
  }
  parts.unshift(...images);
  if (parts.length > 0) out.push({ role: "user", content: collapse(parts) });
  return out;
}

function assistantMessage(content: unknown): Json {
  if (typeof content === "string") return { role: "assistant", content };
  if (!Array.isArray(content))
    throw invalid("message content must be a string or an array of blocks.");
  const parts: Json[] = [];
  const toolCalls: Json[] = [];
  const thinkingBlocks: Json[] = [];
  let reasoning = "";
  for (const block of content) {
    if (!isRecord(block)) throw invalid("content blocks must be objects.");
    switch (block.type) {
      case "text":
        parts.push(textPart(block));
        break;
      case "tool_use":
        toolCalls.push({
          id: String(block.id),
          type: "function",
          function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) },
        });
        break;
      case "thinking":
        reasoning += str(block.thinking);
        // Without a signature (reasoning text from a non-Anthropic model) there is nothing Anthropic could verify.
        if (typeof block.signature === "string" && block.signature) {
          thinkingBlocks.push({
            type: "thinking",
            thinking: block.thinking,
            signature: block.signature,
          });
        }
        break;
      case "redacted_thinking":
        thinkingBlocks.push({ type: "redacted_thinking", data: block.data });
        break;
      default:
        throw invalid(`Unsupported assistant content block type "${String(block.type)}".`);
    }
  }
  const message: Json = { role: "assistant", content: parts.length > 0 ? collapse(parts) : null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning_content = reasoning;
  if (thinkingBlocks.length > 0) message.thinking_blocks = thinkingBlocks;
  return message;
}

function toTools(tools: unknown[]): Json[] {
  return tools.map((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string")
      throw invalid("tools entries need a name.");
    if (tool.type !== undefined && tool.type !== "custom") {
      throw invalid(`Server tool type "${str(tool.type)}" is not supported by this router.`);
    }
    const out: Json = {
      type: "function",
      function: {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    };
    if (isRecord(tool.cache_control)) out.cache_control = tool.cache_control;
    return out;
  });
}

function toChatRequest(a: MessagesRequest): ChatBody {
  const messages: Json[] = [];
  if (typeof a.system === "string" && a.system) {
    messages.push({ role: "system", content: a.system });
  } else if (Array.isArray(a.system)) {
    const parts = a.system
      .filter(isRecord)
      .map(textPart)
      .filter((p) => p.text !== "");
    if (parts.length > 0) messages.push({ role: "system", content: collapse(parts) });
  }
  for (const message of a.messages) {
    if (!isRecord(message)) throw invalid("messages entries must be objects.");
    if (message.role === "user") messages.push(...userMessages(message.content));
    else if (message.role === "assistant") messages.push(assistantMessage(message.content));
    else throw invalid(`Unsupported message role "${String(message.role)}".`);
  }

  const out: ChatBody = { model: a.model, messages, max_tokens: a.max_tokens };
  if (a.stream !== undefined) out.stream = a.stream;
  for (const field of ["temperature", "top_p", "top_k"]) {
    if (typeof a[field] === "number") out[field] = a[field];
  }
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length > 0) out.stop = a.stop_sequences;
  if (isRecord(a.metadata) && typeof a.metadata.user_id === "string") out.user = a.metadata.user_id;

  if (Array.isArray(a.tools) && a.tools.length > 0) {
    out.tools = toTools(a.tools);
    const choice = isRecord(a.tool_choice) ? a.tool_choice : undefined;
    if (choice?.type === "auto") out.tool_choice = "auto";
    else if (choice?.type === "any") out.tool_choice = "required";
    else if (choice?.type === "none") out.tool_choice = "none";
    else if (choice?.type === "tool" && typeof choice.name === "string") {
      out.tool_choice = { type: "function", function: { name: choice.name } };
    }
    if (choice?.disable_parallel_tool_use === true) out.parallel_tool_calls = false;
  }

  // Extended thinking: forwarded as-is for Anthropic upstreams, and as an OpenAI effort for the rest.
  const thinking = isRecord(a.thinking) ? a.thinking : undefined;
  const effort = isRecord(a.output_config) ? a.output_config.effort : undefined;
  if (thinking) out.thinking = thinking;
  if (typeof effort === "string") out.reasoning_effort = effort;
  else if (typeof thinking?.budget_tokens === "number" && thinking.type === "enabled") {
    out.reasoning_effort = effortFromBudget(thinking.budget_tokens);
  }
  return out;
}

// --- Canonical OpenAI response -> Anthropic response -------------------------------------------

const STOP_REASONS: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};
const stopReason = (finish: unknown) =>
  (typeof finish === "string" && STOP_REASONS[finish]) || "end_turn";

const messageId = () => `msg_${crypto.randomUUID().replaceAll("-", "")}`;

/** Anthropic's `input_tokens` excludes cache reads/writes; OpenAI's `prompt_tokens` includes them. */
function anthropicUsage(raw: unknown): Json {
  const usage = parseOpenAiUsage(raw);
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: Math.max(0, usage.promptTokens - usage.cachedTokens - usage.cacheWriteTokens),
    output_tokens: usage.completionTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
    cache_read_input_tokens: usage.cachedTokens,
  };
}

function toolInput(args: unknown): Json {
  if (typeof args !== "string" || args.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toMessage(raw: unknown, model: string): Json {
  const completion = isRecord(raw) ? raw : {};
  const choice =
    Array.isArray(completion.choices) && isRecord(completion.choices[0])
      ? completion.choices[0]
      : {};
  const message = isRecord(choice.message) ? choice.message : {};

  const content: Json[] = [];
  const signed = Array.isArray(message.thinking_blocks)
    ? message.thinking_blocks.filter(isRecord)
    : [];
  if (signed.length > 0) content.push(...signed);
  else if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    content.push({ type: "thinking", thinking: message.reasoning_content, signature: "" });
  }
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    content.push({
      type: "tool_use",
      id: String(call.id),
      name: String(call.function.name),
      input: toolInput(call.function.arguments),
    });
  }
  return {
    id: messageId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: anthropicUsage(completion.usage),
  };
}

const encoder = new TextEncoder();
const frame = (type: string, data: Json) =>
  encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

interface OpenBlock {
  kind: "text" | "thinking" | "tool";
  index: number;
  toolId: string;
  toolIndex: number;
  hasArgs: boolean;
}

/**
 * OpenAI SSE -> Anthropic SSE. Blocks are opened lazily from the shape of each delta (reasoning text,
 * text, tool call) and closed when another kind starts. OpenAI sends usage after the finish chunk, so
 * `message_delta` (which carries the cumulative usage) is held back until the stream ends.
 */
async function* anthropicEvents(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<Uint8Array> {
  const frames: Uint8Array[] = [];
  const emit = (type: string, data: Json) => frames.push(frame(type, data));
  const state = {
    open: null as OpenBlock | null,
    next: 0,
    stop: "end_turn",
    usage: undefined as unknown,
  };

  const close = () => {
    const open = state.open;
    if (!open) return;
    if (open.kind === "tool" && !open.hasArgs) {
      emit("content_block_delta", {
        index: open.index,
        delta: { type: "input_json_delta", partial_json: "{}" },
      });
    }
    emit("content_block_stop", { index: open.index });
    state.open = null;
  };
  const start = (kind: OpenBlock["kind"], block: Json, tool?: { id: string; index: number }) => {
    close();
    const open: OpenBlock = {
      kind,
      index: state.next++,
      toolId: tool?.id ?? "",
      toolIndex: tool?.index ?? -1,
      hasArgs: false,
    };
    state.open = open;
    emit("content_block_start", { index: open.index, content_block: block });
    return open;
  };
  const delta = (open: OpenBlock, data: Json) =>
    emit("content_block_delta", { index: open.index, delta: data });

  emit("message_start", {
    message: {
      id: messageId(),
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  yield* frames.splice(0);

  for await (const event of parseSse(body)) {
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (!isRecord(data)) continue;
    if (isRecord(data.error)) {
      close();
      const message =
        typeof data.error.message === "string" ? data.error.message : "Upstream stream error.";
      emit("error", { error: { type: "api_error", message } });
      yield* frames.splice(0);
      return;
    }
    if (data.usage) state.usage = data.usage;

    const choice =
      Array.isArray(data.choices) && isRecord(data.choices[0]) ? data.choices[0] : undefined;
    if (!choice) continue;
    const d = isRecord(choice.delta) ? choice.delta : {};

    if (typeof d.reasoning_content === "string" && d.reasoning_content) {
      const open =
        state.open?.kind === "thinking"
          ? state.open
          : start("thinking", { type: "thinking", thinking: "", signature: "" });
      delta(open, { type: "thinking_delta", thinking: d.reasoning_content });
    }
    for (const block of Array.isArray(d.thinking_blocks) ? d.thinking_blocks : []) {
      if (!isRecord(block)) continue;
      if (block.type === "redacted_thinking" && typeof block.data === "string") {
        start("thinking", { type: "redacted_thinking", data: block.data });
        close();
      } else if (
        block.type === "thinking" &&
        typeof block.signature === "string" &&
        block.signature
      ) {
        const open =
          state.open?.kind === "thinking"
            ? state.open
            : start("thinking", { type: "thinking", thinking: "", signature: "" });
        delta(open, { type: "signature_delta", signature: block.signature });
        close();
      }
    }
    if (typeof d.content === "string" && d.content) {
      const open =
        state.open?.kind === "text" ? state.open : start("text", { type: "text", text: "" });
      delta(open, { type: "text_delta", text: d.content });
    }
    for (const call of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      if (!isRecord(call)) continue;
      const fn = isRecord(call.function) ? call.function : {};
      const index = typeof call.index === "number" ? call.index : 0;
      const id = typeof call.id === "string" ? call.id : "";
      const cur = state.open;
      const open =
        cur?.kind === "tool" && (id ? id === cur.toolId : index === cur.toolIndex)
          ? cur
          : start(
              "tool",
              {
                type: "tool_use",
                id: id || `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
                name: typeof fn.name === "string" ? fn.name : "",
                input: {},
              },
              { id, index },
            );
      if (typeof fn.arguments === "string" && fn.arguments) {
        open.hasArgs = true;
        delta(open, { type: "input_json_delta", partial_json: fn.arguments });
      }
    }
    if (choice.finish_reason) {
      close();
      state.stop = stopReason(choice.finish_reason);
    }
    yield* frames.splice(0);
  }

  close();
  emit("message_delta", {
    delta: { stop_reason: state.stop, stop_sequence: null },
    usage: anthropicUsage(state.usage),
  });
  emit("message_stop", {});
  yield* frames.splice(0);
}

// --- Errors ------------------------------------------------------------------------------------

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  503: "overloaded_error",
  504: "timeout_error",
};
const errorType = (status: number) =>
  ERROR_TYPES[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");

const envelope = (status: number, message: string, headers?: Record<string, string>) =>
  Response.json(
    { type: "error", error: { type: errorType(status), message } },
    { status, headers },
  );

/** Gateway failures (auth, limits, routing, exhausted credentials) in Anthropic's error envelope. */
function errorResponse(error: unknown, pipeline: Pipeline): Response {
  if (!(error instanceof HttpError)) {
    pipeline.log.error("unhandled error", { error: String(error), path: "/v1/messages" });
    return envelope(500, "Internal server error.");
  }
  const headers: Record<string, string> = {};
  const retryAfter = error.extra?.retry_after;
  if (typeof retryAfter === "number") headers["retry-after"] = String(retryAfter);
  const upstream = error.extra?.upstream_status;
  const detail =
    typeof error.extra?.upstream_message === "string" ? error.extra.upstream_message : "";
  const message =
    upstream === undefined
      ? error.message
      : `${error.message} (upstream ${Number(upstream)}: ${detail})`;
  return envelope(error.status, message, headers);
}

/** A non-2xx the pipeline passed through from upstream (a 4xx that is the caller's fault). */
async function upstreamError(res: Response): Promise<Response> {
  const headers: Record<string, string> = {};
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) headers["retry-after"] = retryAfter;
  const text = (await res.text().catch(() => "")).slice(0, 2000);
  let message = text || `Upstream returned HTTP ${res.status}.`;
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && body.type === "error" && isRecord(body.error)) {
      return Response.json(body, { status: res.status, headers });
    }
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
      message = body.error.message;
    }
  } catch {
    // Not JSON: the raw text is the message.
  }
  return envelope(res.status, message, headers);
}

/** `POST /v1/messages`: auth -> Anthropic request -> shared pipeline -> Anthropic response. */
export function createMessagesHandler(pipeline: Pipeline) {
  return async function messages(c: Context): Promise<Response> {
    try {
      const startedAt = pipeline.now();
      const key = pipeline.authenticate(c, startedAt);
      const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw invalid(z.prettifyError(parsed.error));
      const request = toChatRequest(parsed.data);

      const res = await pipeline.run(c, key, request, startedAt);
      if (!res.ok) return await upstreamError(res);

      const headers = new Headers();
      for (const name of ["x-router-provider", "x-request-id"]) {
        const value = res.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (request.stream === true && res.body) {
        headers.set("content-type", "text/event-stream");
        headers.set("cache-control", "no-cache");
        headers.set("x-accel-buffering", "no");
        return new Response(ReadableStream.from(anthropicEvents(res.body, request.model)), {
          headers,
        });
      }
      let completion: unknown;
      try {
        completion = await res.json();
      } catch {
        throw new HttpError(502, "upstream_error", "Upstream returned an invalid response.");
      }
      return Response.json(toMessage(completion, request.model), { headers });
    } catch (error) {
      return errorResponse(error, pipeline);
    }
  };
}
