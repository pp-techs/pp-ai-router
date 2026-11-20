import type { UsageSummaryRow } from "../api/types.ts";

export interface Totals {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  unpriced_requests: number;
  failed_requests: number;
  /** Request-weighted mean of the groups' average latency. */
  avg_latency_ms: number;
}

export function totalsOf(rows: UsageSummaryRow[]): Totals {
  const t: Totals = {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0,
    unpriced_requests: 0,
    failed_requests: 0,
    avg_latency_ms: 0,
  };
  let latency = 0;
  for (const r of rows) {
    t.requests += r.requests;
    t.input_tokens += r.input_tokens;
    t.output_tokens += r.output_tokens;
    t.cached_tokens += r.cached_tokens;
    t.reasoning_tokens += r.reasoning_tokens;
    t.cost_usd += r.cost_usd;
    t.unpriced_requests += r.unpriced_requests;
    t.failed_requests += r.failed_requests;
    latency += r.avg_latency_ms * r.requests;
  }
  t.avg_latency_ms = t.requests > 0 ? Math.round(latency / t.requests) : 0;
  return t;
}

/** `part / whole` as a 0–1 fraction, or null when there is nothing to divide by. */
export const ratio = (part: number, whole: number): number | null =>
  whole > 0 ? part / whole : null;

/** Share of input tokens served from the provider's prompt cache. */
export const cacheHitRate = (t: Pick<Totals, "cached_tokens" | "input_tokens">) =>
  ratio(t.cached_tokens, t.input_tokens);

export const errorRate = (t: Pick<Totals, "failed_requests" | "requests">) =>
  ratio(t.failed_requests, t.requests);

/** Mean cost of a request, or null with no traffic. */
export const costPerRequest = (t: Pick<Totals, "cost_usd" | "requests">) =>
  ratio(t.cost_usd, t.requests);

/** Cost per million tokens (input + output), or null with no tokens. */
export function costPer1mTokens(t: Pick<Totals, "cost_usd" | "input_tokens" | "output_tokens">) {
  const tokens = t.input_tokens + t.output_tokens;
  return tokens > 0 ? (t.cost_usd / tokens) * 1_000_000 : null;
}

/** Relative change versus the previous period; null when there is no baseline to compare with. */
export const changeFrom = (current: number, previous: number): number | null =>
  previous > 0 ? (current - previous) / previous : null;

export const formatPercent = (fraction: number | null, digits = 1): string =>
  fraction === null ? "—" : `${(fraction * 100).toFixed(digits)}%`;

export const formatChange = (change: number | null): string | null =>
  change === null ? null : `${change >= 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(0)}%`;

/** Linear projection of `cost` over a full 30 days from a window of `windowMs`. */
export const projectMonthly = (cost: number, windowMs: number): number =>
  windowMs > 0 ? (cost / windowMs) * 30 * 86_400_000 : 0;
