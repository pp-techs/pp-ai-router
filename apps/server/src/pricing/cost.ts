import type { ModelPrice, Usage } from "./types.ts";

/** USD cost of one request. Cache and reasoning tokens are billed at their own rate when the price has one. */
export function computeCost(price: ModelPrice, usage: Usage): number {
  let { input, output, cacheRead, cacheWrite } = price;
  for (const tier of price.tiers) {
    if (usage.promptTokens <= tier.aboveTokens) break;
    input = tier.input ?? input;
    output = tier.output ?? output;
    cacheRead = tier.cacheRead ?? cacheRead;
    cacheWrite = tier.cacheWrite ?? cacheWrite;
  }

  const cached = Math.min(usage.cachedTokens, usage.promptTokens);
  const cacheWritten = Math.min(usage.cacheWriteTokens, usage.promptTokens - cached);
  const fresh = usage.promptTokens - cached - cacheWritten;

  const reasoning =
    price.reasoning === undefined ? 0 : Math.min(usage.reasoningTokens, usage.completionTokens);
  const plainOutput = usage.completionTokens - reasoning;

  return (
    fresh * input +
    cached * (cacheRead ?? input) +
    cacheWritten * (cacheWrite ?? input) +
    plainOutput * output +
    reasoning * (price.reasoning ?? output)
  );
}
