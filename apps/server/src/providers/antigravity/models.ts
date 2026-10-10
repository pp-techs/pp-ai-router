// Adapted from lidge-jun/opencodex (MIT)
import type { ModelInfo } from "../adapter.ts";
/**
 * Model-name mapping for Cloud Code Assist, ported from the reference's static tables. The live
 * `:fetchAvailableModels` discovery overlay is not ported: the router names upstream models
 * through aliases, so the static ladder is the whole story.
 */

const GEMINI_RETIRED_FLASH_TARGET_WIRE_ID = "gemini-3.7-flash-tiered";

/**
 * Retired Flash ids -> the reasoning tier they used to encode. Google takes the previous Flash model
 * offline as soon as its successor ships, so these route to 3.7 and keep the tier the user chose.
 */
const RETIRED_FLASH_TIERS: Record<string, string> = {
  "gemini-3.6-flash": "medium",
  "gemini-3.6-flash-low": "low",
  "gemini-3.6-flash-medium": "medium",
  "gemini-3.6-flash-high": "high",
  "gemini-3.5-flash-extra-low": "low",
  "gemini-3.5-flash-low": "medium",
  "gemini-3.5-flash-mid": "medium",
  "gemini-3.5-flash-high": "high",
  "gemini-3-flash-agent": "high",
};

/** Base ("picker") models. Every other id is a wire id or alias whose suffix already names the effort. */
const BASE_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.1-pro",
  "gemini-3.1-flash-image",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

/** Fixed model list shown in the admin UI and `/v1/models`: the base ("picker") models above, with their documented output ceiling. */
export const ANTIGRAVITY_MODELS: readonly ModelInfo[] = BASE_MODELS.map((id) => {
  const maxOutputTokens = maxOutputTokensForModel(id);
  return maxOutputTokens === undefined ? { id } : { id, maxOutputTokens };
});

const MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-pro-high": "gemini-pro-agent",
  "gemini-3.1-pro-preview": "gemini-pro-agent",
  "gemini-3.1-pro-low": "gemini-3.1-pro-low",
  "gemini-pro-agent": "gemini-pro-agent",
  ...Object.fromEntries(
    Object.keys(RETIRED_FLASH_TIERS).map((retired) => [
      retired,
      GEMINI_RETIRED_FLASH_TARGET_WIRE_ID,
    ]),
  ),
};

/** Gemini base models whose efforts ride on separate wire ids. */
const EFFORT_WIRE_MAP: Record<string, Record<string, string>> = {
  "gemini-3.8-flash": {
    low: "gemini-3.8-flash-low",
    medium: "gemini-3.8-flash-medium",
    high: "gemini-3.8-flash-high",
  },
  "gemini-3.1-pro": { low: "gemini-3.1-pro-low", high: "gemini-pro-agent" },
};

/**
 * Base models whose every effort maps to a wire id that already encodes the tier. Sending
 * `thinkingLevel` beside such a suffix would state the effort twice.
 */
const SUFFIX_TIER_MODELS = new Set(["gemini-3.8-flash"]);

const DEFAULT_EFFORT: Record<string, string> = {
  "gemini-3.8-flash": "medium",
  "gemini-3.1-pro": "high",
};

/** Gemini base models whose efforts ride on `thinkingLevel` against ONE wire id, with this default level. */
const THINKING_LEVEL_MODELS: Record<string, string> = { "gemini-3.7-flash": "medium" };

const PICKER_TO_WIRE: Record<string, string> = {
  "gemini-3.7-flash": GEMINI_RETIRED_FLASH_TARGET_WIRE_ID,
};

/** `minimal` is deliberately absent: Google documents it as an error for these generations. */
const THINKING_LEVELS: Record<string, true> = { low: true, medium: true, high: true };

/** Maps an OpenAI `reasoning_effort` to a Gemini `thinkingLevel` (`xhigh`/`max`/`ultra` clamp to `high`). */
export function thinkingLevelForEffort(effort: string): string | undefined {
  const e = effort.toLowerCase();
  if (e === "xhigh" || e === "max" || e === "ultra") return "high";
  return Object.hasOwn(THINKING_LEVELS, e) ? e : undefined;
}

/**
 * Resolves the router's upstream model + optional reasoning effort to the CCA wire model and the
 * `thinkingLevel` to send, in the reference's precedence order:
 * 0. retired Flash id -> 3.7 target + its tier; 1. suffix wire id / alias -> as is, no thinking level;
 * 1b. 3.7-style single wire id -> thinking level; 2/3. mapped Gemini base -> effort wire id;
 * 4. Claude with effort -> thinking level; 5. anything else -> identity.
 */
export function resolveWireModel(
  modelId: string,
  effort?: string,
): { wireModelId: string; thinkingLevel?: string } {
  const level = effort ? thinkingLevelForEffort(effort) : undefined;
  const aliased = Object.hasOwn(MODEL_ALIASES, modelId) ? MODEL_ALIASES[modelId]! : modelId;

  if (Object.hasOwn(RETIRED_FLASH_TIERS, modelId)) {
    return {
      wireModelId: GEMINI_RETIRED_FLASH_TARGET_WIRE_ID,
      thinkingLevel: level ?? RETIRED_FLASH_TIERS[modelId]!,
    };
  }
  if (!BASE_MODELS.includes(modelId)) return { wireModelId: aliased };

  if (Object.hasOwn(THINKING_LEVEL_MODELS, modelId)) {
    return {
      wireModelId: PICKER_TO_WIRE[modelId] ?? modelId,
      thinkingLevel: level ?? THINKING_LEVEL_MODELS[modelId]!,
    };
  }

  const effortMap = EFFORT_WIRE_MAP[modelId];
  if (effortMap) {
    const requested = SUFFIX_TIER_MODELS.has(modelId) && effort ? (level ?? effort) : effort;
    if (requested && Object.hasOwn(effortMap, requested)) {
      const wireModelId = effortMap[requested]!;
      return SUFFIX_TIER_MODELS.has(modelId)
        ? { wireModelId }
        : { wireModelId, thinkingLevel: requested };
    }
    return { wireModelId: effortMap[DEFAULT_EFFORT[modelId]!]! };
  }

  if (modelId.startsWith("claude-") && level) return { wireModelId: modelId, thinkingLevel: level };
  return { wireModelId: aliased };
}

/** Flash generations whose backend rejects the Claude-Agent identity paragraph with a misleading 429. */
const CLAUDE_SDK_PARAGRAPH_REJECTORS = new Set(["gemini-3.7-flash", "gemini-3.8-flash"]);

/** Judged on the routed wire id AND the selector: a retired id and a collapsed base reach the same generation. */
export function rejectsClaudeSdkParagraph(modelId: string, wireModelId: string): boolean {
  return [wireModelId, modelId].some((id) =>
    CLAUDE_SDK_PARAGRAPH_REJECTORS.has(
      id.replace(/-tiered$/, "").replace(/^(gemini-3\.8-flash)-(low|medium|high)$/, "$1"),
    ),
  );
}

/** Image-output models: constrained to `responseModalities`, never given a thinkingConfig. */
export const IMAGE_CAPABLE_MODELS = new Set([
  "gemini-3.1-flash-image",
  "gemini-2.0-flash-preview-image-generation",
  "gemini-3-pro-image-preview",
]);

/** Documented output ceiling, or undefined for ids we cannot vouch for (the upstream stays the authority). */
function maxOutputTokensForModel(modelId: string): number | undefined {
  const lower = modelId.toLowerCase().trim();
  if (lower.startsWith("gemini")) return /(^|[-.])pro([-.]|$)/.test(lower) ? 65535 : 65536;
  if (lower.startsWith("claude")) return 64000;
  if (lower.startsWith("gpt-oss")) return 32768;
  return undefined;
}

export function clampMaxOutputTokens(modelId: string, requested?: number): number | undefined {
  if (requested === undefined || requested <= 0) return undefined;
  const max = maxOutputTokensForModel(modelId);
  return max === undefined ? requested : Math.min(requested, max);
}
