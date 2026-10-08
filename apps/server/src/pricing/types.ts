/** Overrides applied when the prompt is longer than `aboveTokens`. Unset fields keep the base price. */
export interface PriceTier {
  aboveTokens: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** All prices are USD per single token. */
export interface ModelPrice {
  model: string;
  source: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  /** Ascending by `aboveTokens`. */
  tiers: PriceTier[];
}

/** Provider-reported usage, normalised to OpenAI semantics: prompt includes cached, completion includes reasoning. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export const ZERO_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};
