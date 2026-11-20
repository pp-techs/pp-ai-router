import { describe, expect, it } from "vite-plus/test";
import type { GroupedUsageBucket, UsageSummaryRow } from "../api/types.ts";
import { OTHER, stackBuckets, topGroups } from "./breakdown.ts";

const HOUR = 3_600_000;
const row = (group: string, cost_usd: number, requests = 1): UsageSummaryRow => ({
  group,
  requests,
  input_tokens: 10,
  output_tokens: 5,
  cost_usd,
  unpriced_requests: 0,
  cached_tokens: 0,
  reasoning_tokens: 0,
  failed_requests: 0,
  avg_latency_ms: 0,
  max_latency_ms: 0,
});
const bucket = (ts: number, group: string, cost_usd: number): GroupedUsageBucket => ({
  ts,
  group,
  requests: 1,
  failed_requests: 0,
  input_tokens: 10,
  output_tokens: 5,
  cost_usd,
});

describe("topGroups", () => {
  it("ranks by the metric and truncates", () => {
    const rows = [row("a", 1, 9), row("b", 3, 1), row("c", 2, 5)];
    expect(topGroups(rows, "cost", 2)).toEqual(["b", "c"]);
    expect(topGroups(rows, "requests", 2)).toEqual(["a", "c"]);
  });
});

describe("stackBuckets", () => {
  it("zero-fills idle buckets and folds unlisted groups into other", () => {
    const rows = [bucket(HOUR, "a", 1), bucket(HOUR, "z", 4), bucket(3 * HOUR, "a", 2)];
    const out = stackBuckets(rows, ["a"], "cost", 0, 3 * HOUR + 1, HOUR);
    expect(out.map((b) => [b.ts / HOUR, b.a, b[OTHER]])).toEqual([
      [0, 0, 0],
      [1, 1, 4],
      [2, 0, 0],
      [3, 2, 0],
    ]);
  });

  it("is empty for all-time with no data", () => {
    expect(stackBuckets([], [], "cost", null, 1000, HOUR)).toEqual([]);
  });
});
