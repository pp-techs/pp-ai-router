// Adapted from can1357/oh-my-pi (MIT): packages/ai providers/openai-codex/request-transformer.ts,
// providers/openai-codex-responses.ts (buildTransformedCodexRequestBody, convertMessages,
// convertOpenAICodexResponsesTools, normalizeCodexToolChoice), providers/openai-shared.ts
// (normalizeOpenAIPromptCacheKey, convertResponses* helpers), utils/schema/normalize.ts
// (sanitizeSchemaForOpenAIResponses) and lidge-jun/opencodex (MIT) for the chat-completions side
// (response_format, message roles), which omp's agent context has no counterpart for.
/**
 * Canonical OpenAI chat-completions request -> Codex Responses request body (`POST {base}/codex/responses`).
 */
import { createHash } from "node:crypto";
import { isRecord, str } from "../anthropic/json.ts";
import { sanitizeToolSchema } from "./schema.ts";

type Json = Record<string, unknown>;

/** Thrown for input the Codex backend cannot represent; the adapter turns it into a 400 the client can read. */
export class CodexRequestError extends Error {}

/**
 * The backend refuses a request without `instructions`. omp always has a system prompt; a chat-completions
 * client may not, so this stands in then.
 */
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

/** Placeholder output for a tool call whose result never landed in the input (omp `CODEX_INTERRUPTED_TOOL_OUTPUT`). */
const INTERRUPTED_TOOL_OUTPUT =
  "[No tool output recorded: the tool call was interrupted before it produced a result.]";
const ORPHAN_OUTPUT_LIMIT = 16_000;

/** `String.prototype.toWellFormed`: lone surrogates become U+FFFD (the server's TS lib predates it). */
const wellFormed = (text: string) =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");

/** A short stable base-36 digest; omp uses `Bun.hash(...).toString(36)`, and the value is opaque on the wire. */
const hash36 = (text: string) =>
  createHash("sha256").update(text).digest().readBigUInt64BE(0).toString(36);

/**
 * A prompt-cache identity at the wire limit: at most 64 well-formed characters, else a hash of them
 * (omp `normalizeOpenAIPromptCacheKey`).
 */
export function normalizePromptCacheKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const text = wellFormed(value);
  return text.length <= 64 ? text : `pc_${hash36(text)}`;
}

/**
 * A Responses `call_id`: at most 64 characters of `[A-Za-z0-9_-]` (omp `sanitizeCodexCallId`). A composite id
 * (`call|item`) keeps its call half, and a lossy rewrite gets a hash suffix; the same rewrite hits a call
 * and its result.
 */
export function sanitizeCallId(rawCallId: string): string {
  if (!rawCallId) return `call_${hash36("empty")}`;
  const sep = rawCallId.search(/[\n|]/);
  const base = sep > 0 ? rawCallId.slice(0, sep) : sep === 0 ? rawCallId.slice(1) : rawCallId;
  const sanitized = base.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+$/, "");
  if (sanitized.length > 0 && sanitized.length <= 64 && sanitized === base) return sanitized;
  const hash = hash36(base || rawCallId);
  const effectiveBase = sanitized.length > 0 ? sanitized : "call";
  const prefixLen = Math.max(0, 63 - hash.length);
  return `${effectiveBase.slice(0, prefixLen)}_${hash}`.slice(0, 64);
}

const IMAGE_DETAILS: readonly string[] = ["auto", "low", "high"];

/** Content string / parts -> `input_text`/`input_image` parts (user) or `output_text` parts (assistant). Text first, then images, blank text dropped. */
function contentParts(content: unknown, role: "user" | "assistant"): Json[] {
  if (content === null || content === undefined) return [];
  const textType = role === "user" ? "input_text" : "output_text";
  const textPart = (text: string): Json =>
    role === "user" ? { type: textType, text } : { type: textType, text, annotations: [] };
  if (typeof content === "string") return content.trim() ? [textPart(wellFormed(content))] : [];
  if (!Array.isArray(content))
    throw new CodexRequestError("Message content must be a string or an array of parts.");
  const texts: Json[] = [];
  const images: Json[] = [];
  for (const part of content) {
    if (!isRecord(part)) throw new CodexRequestError("Content parts must be objects.");
    if (part.type === "text") {
      if (typeof part.text === "string" && part.text.trim())
        texts.push(textPart(wellFormed(part.text)));
    } else if (part.type === "image_url") {
      if (role !== "user") throw new CodexRequestError("Only user messages may contain images.");
      const image = isRecord(part.image_url) ? part.image_url : { url: part.image_url };
      const url = typeof image.url === "string" ? image.url : "";
      if (!/^(?:https?:\/\/|data:image\/)/i.test(url)) {
        throw new CodexRequestError("image_url must be an http(s) URL or a base64 data URL.");
      }
      images.push({
        type: "input_image",
        detail:
          typeof image.detail === "string" && IMAGE_DETAILS.includes(image.detail)
            ? image.detail
            : "auto",
        image_url: url,
      });
    } else if (part.type === "refusal") {
      continue;
    } else {
      throw new CodexRequestError(`Unsupported content part type "${str(part.type)}".`);
    }
  }
  return [...texts, ...images];
}

/** Text of a system/developer/tool message; parts other than text are not representable there. */
function plainText(content: unknown, what: string): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return wellFormed(content);
  if (!Array.isArray(content))
    throw new CodexRequestError(`${what} must be a string or text parts.`);
  return wellFormed(
    content
      .map((part) => {
        if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
          throw new CodexRequestError(`${what} may only contain text.`);
        }
        return part.text;
      })
      .join("\n"),
  );
}

function toolArguments(args: unknown): string {
  if (typeof args === "string") return args.trim() === "" ? "{}" : args;
  return isRecord(args) ? JSON.stringify(args) : "{}";
}

/**
 * The Responses API rejects a function result without its call and a call without its result (omp
 * `repairToolCallPairs`). An orphan result is folded into an assistant note and a call without a result
 * gets a placeholder result right after it.
 */
function repairToolPairs(input: Json[]): Json[] {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const item of input) {
    if (item.type === "function_call") calls.add(str(item.call_id));
    else if (item.type === "function_call_output") results.add(str(item.call_id));
  }
  const repaired: Json[] = [];
  for (const item of input) {
    const id = str(item.call_id);
    if (item.type === "function_call_output" && !calls.has(id)) {
      let text = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
      if (text.length > ORPHAN_OUTPUT_LIMIT)
        text = `${text.slice(0, ORPHAN_OUTPUT_LIMIT)}\n...[truncated]`;
      repaired.push({
        type: "message",
        role: "assistant",
        content: `[Previous tool result; call_id=${id}]: ${text}`,
      });
    } else {
      repaired.push(item);
      if (item.type === "function_call" && !results.has(id)) {
        repaired.push({
          type: "function_call_output",
          call_id: id,
          output: INTERRUPTED_TOOL_OUTPUT,
        });
      }
    }
  }
  return repaired;
}

function toTools(tools: unknown): Json[] | undefined {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) throw new CodexRequestError("tools must be an array.");
  const out: Json[] = [];
  for (const tool of tools) {
    const fn =
      isRecord(tool) && tool.type === "function" && isRecord(tool.function) ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || fn.name === "") {
      throw new CodexRequestError("Only function tools with a name are supported.");
    }
    out.push({
      type: "function",
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: sanitizeToolSchema(
        isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      ),
      // Like omp: `strict` is only on the wire when the tool said so.
      ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** A named function the request does not offer is dropped, like omp's `normalizeCodexToolChoice`. */
function toToolChoice(choice: unknown, tools: Json[]): unknown {
  if (choice === undefined || choice === null) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (isRecord(choice) && choice.type === "function" && isRecord(choice.function)) {
    const name = str(choice.function.name);
    return tools.some((tool) => tool.name === name) ? { type: "function", name } : undefined;
  }
  throw new CodexRequestError("tool_choice must be auto, none, required or a named function.");
}

/**
 * The effort ladder of the Codex models omp lists (all of them: low..max). `minimal` is not a rung of
 * theirs and is clamped to the nearest one; `none` switches reasoning off.
 */
const EFFORTS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const SUMMARIES: readonly string[] = ["auto", "concise", "detailed"];

/**
 * omp sends `reasoning` only for a request that names an effort (or switches reasoning off), as
 * `{effort, summary}` with the summary defaulting to `auto`: the backend only produces summaries (what the
 * client sees as `reasoning_content`) when asked. `reasoning.summary: null` opts out of them. Without an
 * effort the backend's default applies and no summary is requested.
 */
function toReasoning(body: Json): Json | undefined {
  const reasoning = isRecord(body.reasoning) ? body.reasoning : {};
  const requested = body.reasoning_effort ?? reasoning.effort;
  if (requested === undefined || requested === null) return undefined;
  if (typeof requested !== "string" || !EFFORTS.includes(requested)) {
    throw new CodexRequestError(`reasoning_effort must be one of ${EFFORTS.join(", ")}.`);
  }
  if (requested === "none") return { effort: "none" };
  const summary = reasoning.summary;
  if (typeof summary === "string" && !SUMMARIES.includes(summary)) {
    throw new CodexRequestError(`reasoning.summary must be one of ${SUMMARIES.join(", ")}.`);
  }
  const effort = requested === "minimal" ? "low" : requested;
  return summary === null ? { effort } : { effort, summary: summary ?? "auto" };
}

/** `response_format` and `verbosity` -> the Responses `text` object. */
function toText(body: Json): Json | undefined {
  const text: Json = {};
  if (["low", "medium", "high"].includes(body.verbosity as string)) text.verbosity = body.verbosity;
  const format = body.response_format;
  if (isRecord(format) && format.type === "json_object") {
    text.format = { type: "json_object" };
  } else if (isRecord(format) && format.type === "json_schema") {
    const spec = isRecord(format.json_schema) ? format.json_schema : {};
    if (!isRecord(spec.schema)) {
      throw new CodexRequestError(
        "response_format.json_schema.schema is required for type json_schema.",
      );
    }
    text.format = {
      type: "json_schema",
      name: typeof spec.name === "string" && spec.name ? spec.name : "response",
      schema: spec.schema,
      strict: spec.strict === true,
    };
  }
  return Object.keys(text).length > 0 ? text : undefined;
}

export function toCodexRequest(body: Json): Json {
  if (!Array.isArray(body.messages)) throw new CodexRequestError("messages must be an array.");

  // omp's `systemPrompt` list: the first is the `instructions`, the others developer messages in front of the conversation.
  const systemPrompts: string[] = [];
  let input: Json[] = [];
  // omp's user items carry no `type`.
  const userMessage = (content: Json[]) => {
    if (content.length > 0) input.push({ role: "user", content });
  };

  for (const m of body.messages) {
    if (!isRecord(m)) throw new CodexRequestError("messages entries must be objects.");
    switch (m.role) {
      case "system":
      case "developer": {
        const text = plainText(m.content, "System messages");
        if (text.trim()) systemPrompts.push(text);
        break;
      }
      case "user":
        userMessage(contentParts(m.content, "user"));
        break;
      case "assistant": {
        // One message item per text part, then the calls: the order of the blocks omp replays.
        for (const part of contentParts(m.content, "assistant")) {
          input.push({
            type: "message",
            role: "assistant",
            content: [part],
            status: "completed",
          });
        }
        for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
          const fn = isRecord(call) && isRecord(call.function) ? call.function : null;
          if (!isRecord(call) || !fn || typeof fn.name !== "string") {
            throw new CodexRequestError("tool_calls entries need a function with a name.");
          }
          input.push({
            type: "function_call",
            call_id: sanitizeCallId(str(call.id)),
            name: fn.name,
            arguments: toolArguments(fn.arguments),
          });
        }
        break;
      }
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: sanitizeCallId(str(m.tool_call_id)),
          output: plainText(m.content, "Tool messages"),
        });
        break;
      default:
        throw new CodexRequestError(`Unsupported message role "${str(m.role)}".`);
    }
  }

  input = repairToolPairs(input);
  const developerMessages = systemPrompts.slice(1);
  if (developerMessages.length > 0) {
    input = [
      ...developerMessages.map((text) => ({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text }],
      })),
      ...input,
    ];
  }

  // The backend wants something to answer: a conversation made only of system prompts asks the last one.
  const finalInstruction = developerMessages.findLast((text) => text.trim()) ?? systemPrompts[0];
  if (!input.some((item) => item.role !== "developer")) {
    if (finalInstruction === undefined)
      throw new CodexRequestError("messages must contain at least one non-empty message.");
    input.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: finalInstruction }],
    });
  }

  const model = String(body.model);
  const promptCacheKey = normalizePromptCacheKey(body.prompt_cache_key);
  const out: Json = {
    model,
    input,
    stream: true,
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    instructions: systemPrompts[0] ?? DEFAULT_INSTRUCTIONS,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  const tools = toTools(body.tools);
  if (tools) {
    out.tools = tools;
    const choice = toToolChoice(body.tool_choice, tools);
    if (choice !== undefined) out.tool_choice = choice;
    // omp leaves it to the backend (parallel by default); a client that forbids it is obeyed.
    if (body.parallel_tool_calls === false) out.parallel_tool_calls = false;
  }
  const reasoning = toReasoning(body);
  if (reasoning) out.reasoning = reasoning;
  const text = toText(body);
  if (text) out.text = text;
  // `max_tokens`, `temperature`, `top_p`, `stop` and the penalties are not forwarded: the backend answers
  // each of them with 400 "Unsupported parameter" (omp drops them too), and `service_tier` (fast mode) is not ported.
  return out;
}
