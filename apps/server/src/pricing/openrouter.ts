import type { ModelPrice, PriceTier } from "./types.ts";

export const OPENROUTER_SOURCE = "openrouter";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

/** OpenRouter prices are decimal strings in USD per token; dynamic models report negative values. */
function cost(v: unknown): number | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function parseOpenRouter(json: unknown): ModelPrice[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("openrouter: expected { data: [...] }");
  const prices: ModelPrice[] = [];

  for (const item of data) {
    const id = (item as { id?: unknown }).id;
    const p = (item as { pricing?: Record<string, unknown> }).pricing;
    if (typeof id !== "string" || !p) continue;
    const input = cost(p.prompt);
    const output = cost(p.completion);
    if (input === undefined || output === undefined) continue;

    const tiers: PriceTier[] = [];
    if (Array.isArray(p.overrides)) {
      for (const o of p.overrides as Record<string, unknown>[]) {
        const min = Number(o.min_prompt_tokens);
        if (!Number.isFinite(min) || min < 1) continue;
        // min_prompt_tokens is inclusive; our tiers apply when promptTokens > aboveTokens.
        const tier: PriceTier = { aboveTokens: min - 1 };
        const tInput = cost(o.prompt);
        const tOutput = cost(o.completion);
        const tRead = cost(o.input_cache_read);
        const tWrite = cost(o.input_cache_write);
        if (tInput !== undefined) tier.input = tInput;
        if (tOutput !== undefined) tier.output = tOutput;
        if (tRead !== undefined) tier.cacheRead = tRead;
        if (tWrite !== undefined) tier.cacheWrite = tWrite;
        tiers.push(tier);
      }
      tiers.sort((a, b) => a.aboveTokens - b.aboveTokens);
    }

    const price: ModelPrice = { model: id, source: OPENROUTER_SOURCE, input, output, tiers };
    const cacheRead = cost(p.input_cache_read);
    const cacheWrite = cost(p.input_cache_write);
    const reasoning = cost(p.internal_reasoning);
    if (cacheRead !== undefined) price.cacheRead = cacheRead;
    if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
    if (reasoning !== undefined && reasoning > 0) price.reasoning = reasoning;
    prices.push(price);
  }
  return prices;
}
