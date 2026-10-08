// Adapted from lidge-jun/opencodex (MIT)
/**
 * Per-model Anthropic Messages contract: which wire shapes a Claude family accepts. Measured live
 * against api.anthropic.com by the reference implementation; unknown / non-Claude ids match nothing,
 * so a custom `base_url` (a proxy exposing other model names) gets the request untouched.
 */

type Version = readonly [major: number, minor: number];

/**
 * Families that moved to adaptive thinking: they 400 on `thinking.type: "enabled"`, while older
 * families (Haiku 4.5, Sonnet 4.x, Opus <= 4.6) 400 on `adaptive`. Opus 4.6 / Sonnet 4.6 accept both.
 */
const ADAPTIVE_THINKING_FROM: Record<string, Version> = {
  sonnet: [5, 0],
  opus: [4, 7],
  fable: [0, 0],
};

/** Families that 400 on any non-default `temperature`, `top_p` or `top_k`. */
const SAMPLING_REJECTED_FROM: Record<string, Version> = {
  sonnet: [5, 0],
  opus: [4, 7],
  fable: [0, 0],
};

interface ClaudeVersion {
  family: string;
  major: number;
  minor: number;
}

/**
 * Family/version of a Claude model id, tolerant of a routing prefix (`anthropic/claude-sonnet-5`).
 * Minor is 1-2 digits so date-pinned ids (`claude-opus-4-20250514`) parse as minor 0.
 */
export function claudeFamilyVersion(modelId: string): ClaudeVersion | undefined {
  const match = /(?:^|\/)claude-([a-z]+)-(\d+)(?:[.-](\d{1,2}))?(?!\d)/i.exec(modelId);
  if (!match) return undefined;
  return {
    family: match[1]!.toLowerCase(),
    major: Number(match[2]),
    minor: match[3] === undefined ? 0 : Number(match[3]),
  };
}

const atLeast = (v: ClaudeVersion, min: Version) =>
  v.major > min[0] || (v.major === min[0] && v.minor >= min[1]);

function meets(modelId: string, table: Record<string, Version>): boolean {
  const parsed = claudeFamilyVersion(modelId);
  const min = parsed && table[parsed.family];
  return Boolean(parsed && min && atLeast(parsed, min));
}

export const usesAdaptiveThinking = (modelId: string) => meets(modelId, ADAPTIVE_THINKING_FROM);

export const rejectsSamplingParameters = (modelId: string) =>
  meets(modelId, SAMPLING_REJECTED_FROM);

/** 4.5/4.6 families accept `temperature` or `top_p` alone but 400 when both are sent. */
export function rejectsCombinedSampling(modelId: string): boolean {
  const parsed = claudeFamilyVersion(modelId);
  if (!parsed || rejectsSamplingParameters(modelId)) return false;
  return ["opus", "sonnet", "haiku"].includes(parsed.family) && atLeast(parsed, [4, 5]);
}

/** Forced `tool_choice` (`any` / `tool`) 400s on Opus 5.5, Fable 5.1+ and Sonnet 5.5+. */
export function rejectsForcedToolChoice(modelId: string): boolean {
  const parsed = claudeFamilyVersion(modelId);
  if (parsed?.family === "opus") return parsed.major === 5 && parsed.minor === 5;
  if (parsed?.family === "fable") return atLeast(parsed, [5, 1]);
  return parsed?.family === "sonnet" && atLeast(parsed, [5, 5]);
}
