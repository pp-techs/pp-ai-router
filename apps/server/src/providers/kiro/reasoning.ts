// Adapted from lidge-jun/opencodex (MIT)

/**
 * Kiro model id the way the runtime wants it: `kiro/` and `kiro-` prefixes, date suffixes and
 * effort suffixes are dropped, `4-5` becomes `4.5`, and `claude-4.5-sonnet` becomes `claude-sonnet-4.5`.
 * `auto` stays `auto`.
 */
export function normalizeKiroModelId(id: string): string {
  let model = id.trim().toLowerCase();
  model = model.replace(/^kiro\//, "").replace(/^kiro-/, "");
  if (model === "auto") return "auto";
  model = model.replace(/-\d{8}$/, "");
  model = model.replace(/-(low|medium|high|xhigh|max)$/, "");
  model = model.replace(/(\d+)-(\d+)/g, "$1.$2");
  model = model.replace(/^claude-([\d.]+)-(sonnet|opus|haiku)$/, "claude-$2-$1");
  return model;
}

/**
 * Models with a verified native effort field; each family names it differently
 * (`reasoning.effort` vs the Claude-specific `output_config.effort`). Every other model gets
 * emulated thinking via `<thinking_mode>` instructions.
 */
const NATIVE_EFFORT_FIELDS: Record<string, "reasoning" | "output_config"> = {
  "gpt-5.6-sol": "reasoning",
  "gpt-5.6-terra": "reasoning",
  "gpt-5.6-luna": "reasoning",
  "gpt-6-sol": "reasoning",
  "gpt-6-luna": "reasoning",
  "gpt-6.1-sol": "reasoning",
  "claude-opus-5": "output_config",
  "claude-opus-5.5": "output_config",
};

export const NATIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Luna and Terra have evidence for these rungs only; their `xhigh` keeps the emulated path. */
const LUNA_TERRA_NATIVE_EFFORTS = ["low", "medium", "high", "max"];

export function nativeEffortField(
  modelId: string,
  effort?: string,
): "reasoning" | "output_config" | undefined {
  if (
    (modelId === "gpt-5.6-luna" || modelId === "gpt-5.6-terra") &&
    effort !== undefined &&
    !LUNA_TERRA_NATIVE_EFFORTS.includes(effort)
  )
    return undefined;
  return Object.hasOwn(NATIVE_EFFORT_FIELDS, modelId) ? NATIVE_EFFORT_FIELDS[modelId] : undefined;
}

const THINKING_SHARE: Record<string, number> = {
  minimal: 0.1,
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.9,
  max: 0.95,
};

/** Thinking-token budget for the emulated mode: a share of the output cap (4096 when the client set none). */
function thinkingBudget(
  effort: string | undefined,
  maxTokens: number | undefined,
): number | undefined {
  if (!effort || !Object.hasOwn(THINKING_SHARE, effort)) return undefined;
  return Math.max(1, Math.floor((maxTokens || 4096) * THINKING_SHARE[effort]!));
}

/** Prefixes the user turn with thinking instructions for models without a native effort field. */
export function injectThinkingTags(
  content: string,
  modelId: string,
  effort: string | undefined,
  maxTokens: number | undefined,
): string {
  if (nativeEffortField(modelId, effort)) return content;
  const budget = thinkingBudget(effort, maxTokens);
  if (!budget) return content;
  const instruction = [
    "Think in English for better reasoning quality.",
    "Be thorough and systematic, consider edge cases, challenge assumptions, and verify reasoning before answering.",
    "After thinking, respond in the user's language.",
  ].join("\n");
  return [
    "<thinking_mode>enabled</thinking_mode>",
    `<max_thinking_length>${budget}</max_thinking_length>`,
    `<thinking_instruction>${instruction}</thinking_instruction>`,
    "",
    content,
  ].join("\n");
}
