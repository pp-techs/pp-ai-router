import type { ModelPrice, PriceTier } from "./types.ts";

export const LITELLM_SOURCE = "litellm";
export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const TIER_KEY =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/;

const TIER_FIELD: Record<string, "input" | "output" | "cacheRead" | "cacheWrite"> = {
  input_cost_per_token: "input",
  output_cost_per_token: "output",
  cache_read_input_token_cost: "cacheRead",
  cache_creation_input_token_cost: "cacheWrite",
};

const isCost = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Parses LiteLLM's `model_prices_and_context_window.json`. Keys are model ids (sometimes
 * `provider/model`). Entries without a per-token input price (images, search, ...) are skipped.
 * `_above_Nk_tokens` keys become tiers; batch/priority/flex variants are ignored.
 */
export function parseLiteLLM(json: unknown): ModelPrice[] {
  if (typeof json !== "object" || json === null) throw new Error("litellm: expected an object");
  const prices: ModelPrice[] = [];

  for (const [model, raw] of Object.entries(json)) {
    if (model === "sample_spec" || typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (!isCost(e.input_cost_per_token)) continue;

    const tiers = new Map<number, PriceTier>();
    for (const [key, value] of Object.entries(e)) {
      const m = TIER_KEY.exec(key);
      if (!m || !isCost(value)) continue;
      const aboveTokens = Number(m[2]) * 1000;
      const tier = tiers.get(aboveTokens) ?? { aboveTokens };
      tier[TIER_FIELD[m[1]!]!] = value;
      tiers.set(aboveTokens, tier);
    }

    const price: ModelPrice = {
      model,
      source: LITELLM_SOURCE,
      input: e.input_cost_per_token,
      output: isCost(e.output_cost_per_token) ? e.output_cost_per_token : 0,
      tiers: [...tiers.values()].sort((a, b) => a.aboveTokens - b.aboveTokens),
    };
    if (isCost(e.cache_read_input_token_cost)) price.cacheRead = e.cache_read_input_token_cost;
    if (isCost(e.cache_creation_input_token_cost))
      price.cacheWrite = e.cache_creation_input_token_cost;
    if (isCost(e.output_cost_per_reasoning_token))
      price.reasoning = e.output_cost_per_reasoning_token;
    prices.push(price);
  }
  return prices;
}
