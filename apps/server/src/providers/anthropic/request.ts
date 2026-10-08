// Adapted from lidge-jun/opencodex (MIT)
/**
 * Canonical OpenAI chat-completions request -> Anthropic Messages request body.
 * https://platform.claude.com/docs/en/api/messages/create
 */
import { isRecord, str } from "./json.ts";
import {
  rejectsCombinedSampling,
  rejectsForcedToolChoice,
  rejectsSamplingParameters,
  usesAdaptiveThinking,
} from "./model-contract.ts";

type Json = Record<string, unknown>;
type Block = Record<string, unknown>;
interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}

/** Thrown for input Anthropic cannot represent; the adapter turns it into a 400 the client can read. */
export class InvalidRequestError extends Error {}

/** Anthropic requires `max_tokens`; every current model accepts at least this much output. */
const DEFAULT_MAX_TOKENS = 8192;
/** Visible-answer room added above a thinking budget when `max_tokens` is not given. */
const ANSWER_HEADROOM = 8192;
const MIN_THINKING_BUDGET = 1024;
const MIN_ANSWER_ROOM = 1024;

/** `reasoning_effort` -> `thinking.budget_tokens` on models that still use manual budgets. */
const EFFORT_BUDGET: Record<string, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32000,
};
const ADAPTIVE_EFFORTS: Record<string, true> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

/** Inverse of `EFFORT_BUDGET`: the `output_config.effort` closest to a manual budget. */
export function effortFromBudget(budget: number): string {
  if (budget <= 4096) return "low";
  if (budget <= 10000) return "medium";
  if (budget <= 20000) return "high";
  if (budget <= 28000) return "xhigh";
  return "max";
}

/** Anthropic tool ids must match `^[a-zA-Z0-9_-]+$`; the same rewrite is applied to calls and results. */
const toolId = (id: unknown) =>
  (typeof id === "string" ? id : "").replace(/[^a-zA-Z0-9_-]/g, "_") || "toolu_unknown";

function imageBlock(url: string): Block {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data)
    return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  throw new InvalidRequestError("image_url must be an http(s) URL or a base64 data URL.");
}

/** Content string / parts -> Anthropic blocks. `cache_control` on a part rides along unchanged. */
function contentBlocks(content: unknown): Block[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content))
    throw new InvalidRequestError("Message content must be a string or an array of parts.");
  const blocks: Block[] = [];
  for (const part of content) {
    if (!isRecord(part)) throw new InvalidRequestError("Content parts must be objects.");
    let block: Block;
    if (part.type === "text") {
      if (typeof part.text !== "string" || part.text === "") continue; // Anthropic rejects empty text blocks
      block = { type: "text", text: part.text };
    } else if (part.type === "image_url") {
      const url = isRecord(part.image_url) ? part.image_url.url : part.image_url;
      block = imageBlock(typeof url === "string" ? url : "");
    } else if (part.type === "refusal") {
      continue;
    } else {
      throw new InvalidRequestError(`Unsupported content part type "${String(part.type)}".`);
    }
    if (isRecord(part.cache_control)) block.cache_control = part.cache_control;
    blocks.push(block);
  }
  return blocks;
}

/** A message-level `cache_control` (LiteLLM/OpenRouter style) lands on the message's last block. */
function withMessageCache(message: Json, blocks: Block[]): Block[] {
  const last = blocks.at(-1);
  if (last && isRecord(message.cache_control)) last.cache_control = message.cache_control;
  return blocks;
}

function toolInput(args: unknown): Json {
  if (isRecord(args)) return args;
  if (typeof args !== "string" || args.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Thinking blocks the client echoed back (`thinking_blocks`, LiteLLM-style) must keep their signature to be replayable. */
function replayedThinking(message: Json): Block[] {
  const blocks: Block[] = [];
  for (const t of Array.isArray(message.thinking_blocks) ? message.thinking_blocks : []) {
    if (!isRecord(t)) continue;
    if (t.type === "redacted_thinking" && typeof t.data === "string") {
      blocks.push({ type: "redacted_thinking", data: t.data });
    } else if (t.type === "thinking" && typeof t.signature === "string" && t.signature) {
      blocks.push({ type: "thinking", thinking: str(t.thinking), signature: t.signature });
    }
  }
  return blocks;
}

function assistantBlocks(message: Json): Block[] {
  const blocks = [...replayedThinking(message), ...contentBlocks(message.content)];
  withMessageCache(message, blocks);
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const fn = isRecord(call) && isRecord(call.function) ? call.function : null;
    if (!isRecord(call) || !fn || typeof fn.name !== "string") {
      throw new InvalidRequestError("tool_calls entries need a function with a name.");
    }
    blocks.push({
      type: "tool_use",
      id: toolId(call.id),
      name: fn.name,
      input: toolInput(fn.arguments),
    });
  }
  return blocks;
}

function toolResultBlock(message: Json): Block {
  const block: Block = { type: "tool_result", tool_use_id: toolId(message.tool_call_id) };
  const blocks = contentBlocks(message.content);
  if (typeof message.content === "string") {
    if (message.content) block.content = message.content;
  } else if (blocks.length > 0) {
    block.content = blocks;
  }
  if (isRecord(message.cache_control)) block.cache_control = message.cache_control;
  return block;
}

const toolUseIds = (m: AnthropicMessage) =>
  m.content.filter((b) => b.type === "tool_use").map((b) => b.id as string);

/**
 * Anthropic 400s on a `tool_result` without a matching `tool_use` right before it, and on a `tool_use`
 * with no result right after it. OpenAI-style histories (aborted tool runs, edited transcripts) break
 * both rules, so orphan results become plain text and missing results become explicit error results.
 */
function repairToolPairs(messages: AnthropicMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "user") {
      const previous = messages[i - 1];
      const open = new Set(previous?.role === "assistant" ? toolUseIds(previous) : []);
      const content = message.content.flatMap((b): Block[] => {
        if (b.type !== "tool_result" || open.has(b.tool_use_id as string)) return [b];
        const inner =
          typeof b.content === "string"
            ? [{ type: "text", text: b.content }]
            : ((b.content as Block[]) ?? []);
        return [
          { type: "text", text: `[result of unknown tool call ${String(b.tool_use_id)}]` },
          ...inner,
        ];
      });
      // tool_result blocks must lead the turn.
      message.content = [
        ...content.filter((b) => b.type === "tool_result"),
        ...content.filter((b) => b.type !== "tool_result"),
      ];
      continue;
    }
    const ids = toolUseIds(message);
    const next = messages[i + 1];
    if (ids.length === 0 || !next) continue;
    const answered = new Set(
      next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id as string),
    );
    const missing: Block[] = ids
      .filter((id) => !answered.has(id))
      .map((id) => ({
        type: "tool_result",
        tool_use_id: id,
        content: "[missing tool result for this tool call]",
        is_error: true,
      }));
    next.content.unshift(...missing);
  }
}

/** Anthropic rejects `input_schema` roots that lack `type: "object"` or use oneOf/anyOf/allOf. */
function inputSchema(schema: unknown): Json {
  const obj = isRecord(schema) ? schema : {};
  const properties: Json = isRecord(obj.properties) ? { ...obj.properties } : {};
  const required = new Set(
    Array.isArray(obj.required) ? obj.required.filter((r) => typeof r === "string") : [],
  );
  const out: Json = {};
  let composed = false;
  for (const [key, value] of Object.entries(obj)) {
    if (key === "oneOf" || key === "anyOf" || key === "allOf") {
      composed = true;
      for (const variant of Array.isArray(value) ? value : []) {
        if (!isRecord(variant)) continue;
        if (isRecord(variant.properties)) Object.assign(properties, variant.properties);
        if (key === "allOf" && Array.isArray(variant.required)) {
          for (const r of variant.required) if (typeof r === "string") required.add(r);
        }
      }
    } else if (key !== "type" && key !== "properties" && key !== "required") {
      out[key] = value;
    }
  }
  out.type = "object";
  out.properties = properties;
  if (required.size > 0) out.required = [...required];
  else if (!composed && Array.isArray(obj.required)) out.required = obj.required;
  return out;
}

function toTools(tools: unknown): Block[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => {
    const fn =
      isRecord(tool) && tool.type === "function" && isRecord(tool.function) ? tool.function : null;
    if (!isRecord(tool) || !fn || typeof fn.name !== "string") {
      throw new InvalidRequestError(
        `Unsupported tool type "${isRecord(tool) ? String(tool.type) : typeof tool}".`,
      );
    }
    const out: Block = { name: fn.name, input_schema: inputSchema(fn.parameters) };
    if (typeof fn.description === "string" && fn.description) out.description = fn.description;
    if (isRecord(tool.cache_control)) out.cache_control = tool.cache_control;
    return out;
  });
}

function toToolChoice(body: Json, model: string): Json | undefined {
  const choice = body.tool_choice;
  let out: Json | undefined;
  if (choice === "none") return { type: "none" };
  if (choice === "auto") out = { type: "auto" };
  else if (choice === "required") out = { type: "any" };
  else if (
    isRecord(choice) &&
    isRecord(choice.function) &&
    typeof choice.function.name === "string"
  ) {
    out = { type: "tool", name: choice.function.name };
  }
  if (out && rejectsForcedToolChoice(model) && out.type !== "auto") out = { type: "auto" };
  if (body.parallel_tool_calls === false)
    out = { ...(out ?? { type: "auto" }), disable_parallel_tool_use: true };
  return out;
}

interface ThinkingPlan {
  thinking?: Json;
  /** `output_config.effort`, adaptive-thinking models only. */
  effort?: string;
  maxTokens: number;
}

/**
 * `thinking` (Anthropic-shaped, as `/v1/messages` clients send it) and `reasoning_effort` (OpenAI) both
 * select extended thinking. Adaptive-thinking models take an effort, older ones a token budget that must
 * stay below `max_tokens`.
 */
function planThinking(body: Json, model: string, requestedMax: number | undefined): ThinkingPlan {
  const maxTokens = requestedMax ?? DEFAULT_MAX_TOKENS;
  const explicit = isRecord(body.thinking) ? body.thinking : undefined;
  const type = explicit?.type;
  if (type === "disabled" || type === "between_tools") return { thinking: { type }, maxTokens };

  const effortIn = typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
  if (type !== "enabled" && type !== "adaptive" && (!effortIn || effortIn === "none"))
    return { maxTokens };

  const budget = typeof explicit?.budget_tokens === "number" ? explicit.budget_tokens : undefined;
  const display = typeof explicit?.display === "string" ? explicit.display : undefined;

  if (usesAdaptiveThinking(model)) {
    const asked = effortIn ?? (budget === undefined ? "medium" : effortFromBudget(budget));
    const effort =
      asked === "minimal" ? "low" : Object.hasOwn(ADAPTIVE_EFFORTS, asked) ? asked : "medium";
    return {
      thinking: { type: "adaptive", display: display ?? "summarized" },
      effort,
      maxTokens:
        requestedMax ?? Math.max(DEFAULT_MAX_TOKENS, EFFORT_BUDGET[effort]! + ANSWER_HEADROOM),
    };
  }

  const wanted =
    budget ??
    (effortIn !== undefined && Object.hasOwn(EFFORT_BUDGET, effortIn)
      ? EFFORT_BUDGET[effortIn]!
      : 8192);
  const room = requestedMax ?? Math.max(DEFAULT_MAX_TOKENS, wanted + ANSWER_HEADROOM);
  if (budget !== undefined) {
    return {
      thinking: { type: "enabled", budget_tokens: budget, ...(display ? { display } : {}) },
      maxTokens: room,
    };
  }
  // A budget derived from an effort must leave room for the answer; if there is none, skip thinking.
  const derived = Math.min(wanted, room - MIN_ANSWER_ROOM);
  if (derived < MIN_THINKING_BUDGET) return { maxTokens: room };
  return { thinking: { type: "enabled", budget_tokens: derived }, maxTokens: room };
}

/**
 * Manual-budget thinking requires the final assistant turn to start with a thinking block. History that
 * came through the OpenAI format has none (signatures are not part of it), so thinking is dropped for that
 * request instead of failing it. Adaptive thinking has no such requirement.
 */
function thinkingBreaksReplay(messages: AnthropicMessage[]): boolean {
  const last = messages.findLast((m) => m.role === "assistant");
  if (!last || toolUseIds(last).length === 0) return false;
  const first = last.content[0]?.type;
  return first !== "thinking" && first !== "redacted_thinking";
}

export function toAnthropicRequest(body: Json, stream: boolean): Json {
  const model = String(body.model);
  if (!Array.isArray(body.messages)) throw new InvalidRequestError("messages must be an array.");

  const system: Block[] = [];
  const messages: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage["role"], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const message of body.messages) {
    if (!isRecord(message)) throw new InvalidRequestError("messages entries must be objects.");
    switch (message.role) {
      case "system":
      case "developer": {
        const blocks = withMessageCache(message, contentBlocks(message.content));
        if (blocks.some((b) => b.type !== "text"))
          throw new InvalidRequestError("System messages may only contain text.");
        system.push(...blocks);
        break;
      }
      case "user":
        push("user", withMessageCache(message, contentBlocks(message.content)));
        break;
      case "assistant":
        push("assistant", assistantBlocks(message));
        break;
      case "tool":
        push("user", [toolResultBlock(message)]);
        break;
      default:
        throw new InvalidRequestError(`Unsupported message role "${String(message.role)}".`);
    }
  }
  repairToolPairs(messages);

  const requestedMax = [body.max_tokens, body.max_completion_tokens].find(
    (n): n is number => typeof n === "number" && n > 0,
  );
  const plan = planThinking(body, model, requestedMax);
  const thinkingOn = plan.thinking?.type === "enabled" || plan.thinking?.type === "adaptive";
  const dropThinking = plan.thinking?.type === "enabled" && thinkingBreaksReplay(messages);

  const out: Json = { model, max_tokens: plan.maxTokens, messages };
  if (system.length > 0) {
    out.system = system.some((b) => b.cache_control)
      ? system
      : system.map((b) => b.text as string).join("\n\n");
  }
  const tools = toTools(body.tools);
  if (tools) {
    out.tools = tools;
    const toolChoice = toToolChoice(body, model);
    if (toolChoice) out.tool_choice = toolChoice;
  }
  if (plan.thinking && !dropThinking) {
    out.thinking = plan.thinking;
    if (plan.effort) out.output_config = { effort: plan.effort };
  }

  const stop = (Array.isArray(body.stop) ? body.stop : [body.stop]).filter(
    (s): s is string => typeof s === "string" && s !== "",
  );
  if (stop.length > 0) out.stop_sequences = stop;

  // Thinking (and the newest families outright) reject non-default sampling parameters.
  if ((!thinkingOn || dropThinking) && !rejectsSamplingParameters(model)) {
    if (typeof body.temperature === "number")
      out.temperature = Math.min(1, Math.max(0, body.temperature));
    if (
      typeof body.top_p === "number" &&
      !(out.temperature !== undefined && rejectsCombinedSampling(model))
    ) {
      out.top_p = Math.min(1, Math.max(0, body.top_p));
    }
    if (typeof body.top_k === "number" && Number.isInteger(body.top_k) && body.top_k >= 0)
      out.top_k = body.top_k;
  }
  if (typeof body.user === "string" && body.user)
    out.metadata = { user_id: body.user.slice(0, 512) };
  if (stream) out.stream = true;
  return out;
}
