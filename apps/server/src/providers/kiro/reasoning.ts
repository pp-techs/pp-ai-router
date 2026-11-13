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
  // Preemptive (see the reference's kiro-models.ts): GPT-6.1 Terra mirrors GPT-6.1 Sol.
  "gpt-6.1-terra": "reasoning",
  // Claude models whose `output_config.effort` was accepted by a live probe (2026-11-07) at every ladder
  // rung except `xhigh` on the 4.6 pair. Haiku 4.5, Opus 4.5 and Sonnet 4.5 reject the field (HTTP 400).
  // A per-id allowlist, not a `claude-*` rule: no other Claude id was measured.
  "claude-opus-5": "output_config",
  "claude-opus-5.5": "output_config",
  "claude-opus-4.8": "output_config",
  "claude-opus-4.7": "output_config",
  "claude-opus-4.6": "output_config",
  "claude-sonnet-5.5": "output_config",
  "claude-sonnet-5": "output_config",
  "claude-sonnet-4.6": "output_config",
  "claude-haiku-5.5": "output_config",
};

export const NATIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Luna and Terra have evidence for these rungs only; their `xhigh` keeps the emulated path. */
const LUNA_TERRA_NATIVE_EFFORTS = ["low", "medium", "high", "max"];

/** Kiro rejects a native `xhigh` for these two (HTTP 400); it stays emulated. */
const NO_NATIVE_XHIGH_MODELS = ["claude-opus-4.6", "claude-sonnet-4.6"];

/**
 * Models that used the emulated block for every effort before native effort was verified. `minimal`,
 * the one value outside the native ladder a caller sends on its own, keeps that block for them instead
 * of becoming an error; models outside this list still reject it.
 */
const EMULATED_MINIMAL_MODELS = [
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-haiku-5.5",
];

/** True when `minimal` keeps the emulated thinking block for this model instead of failing the request. */
export function emulatesMinimalEffort(modelId: string, effort?: string): boolean {
  return effort === "minimal" && EMULATED_MINIMAL_MODELS.includes(modelId);
}

export function nativeEffortField(
  modelId: string,
  effort?: string,
): "reasoning" | "output_config" | undefined {
  if (NO_NATIVE_XHIGH_MODELS.includes(modelId) && effort === "xhigh") return undefined;
  if (emulatesMinimalEffort(modelId, effort)) return undefined;
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
