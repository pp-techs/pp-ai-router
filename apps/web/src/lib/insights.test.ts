import { describe, expect, it } from "vite-plus/test";
import type { UsageSummaryRow } from "../api/types.ts";
import {
  cacheHitRate,
  changeFrom,
  costPer1mTokens,
  errorRate,
  formatChange,
  formatPercent,
  projectMonthly,
  totalsOf,
} from "./insights.ts";

const row = (over: Partial<UsageSummaryRow>): UsageSummaryRow => ({
  group: "g",
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  unpriced_requests: 0,
  cached_tokens: 0,
  reasoning_tokens: 0,
  failed_requests: 0,
  avg_latency_ms: 0,
  max_latency_ms: 0,
  ...over,
});

describe("totalsOf", () => {
  it("sums counts and weights latency by request count", () => {
    const t = totalsOf([
      row({ requests: 1, avg_latency_ms: 100, failed_requests: 1, cost_usd: 1 }),
      row({ requests: 3, avg_latency_ms: 200, cached_tokens: 5, input_tokens: 10, cost_usd: 2 }),
    ]);
    expect(t.requests).toBe(4);
    expect(t.avg_latency_ms).toBe(175);
    expect(t.cost_usd).toBe(3);
    expect(errorRate(t)).toBe(0.25);
    expect(cacheHitRate(t)).toBe(0.5);
  });

  it("is all zero and ratio-free for no rows", () => {
    const t = totalsOf([]);
    expect(t.avg_latency_ms).toBe(0);
    expect(errorRate(t)).toBeNull();
    expect(costPer1mTokens(t)).toBeNull();
  });
});

describe("period comparison", () => {
  it("computes and formats change, hiding it without a baseline", () => {
    expect(changeFrom(150, 100)).toBe(0.5);
    expect(formatChange(changeFrom(50, 100))).toBe("−50%");
    expect(formatChange(changeFrom(10, 100))).toBe("−90%");
    expect(formatChange(changeFrom(5, 0))).toBeNull();
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(0.1234)).toBe("12.3%");
  });

  it("projects a 30 day run rate", () => {
    expect(projectMonthly(1, 86_400_000)).toBe(30);
    expect(projectMonthly(1, 0)).toBe(0);
  });
});
