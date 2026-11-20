import type { GroupedUsageBucket, UsageSummaryRow } from "../api/types.ts";

export type BreakdownMetric = "cost" | "requests" | "tokens";

export const OTHER = "__other__";
/** How many groups get their own colour; the rest fold into "Other". */
export const TOP_GROUPS = 6;

export const metricOf = (
  row: Pick<UsageSummaryRow, "requests" | "input_tokens" | "output_tokens" | "cost_usd">,
  metric: BreakdownMetric,
): number =>
  metric === "cost"
    ? row.cost_usd
    : metric === "requests"
      ? row.requests
      : row.input_tokens + row.output_tokens;

/** The groups with the largest `metric`, biggest first. */
export function topGroups(rows: UsageSummaryRow[], metric: BreakdownMetric, n = TOP_GROUPS) {
  return [...rows]
    .sort((a, b) => metricOf(b, metric) - metricOf(a, metric))
    .slice(0, n)
    .map((r) => r.group);
}

export type StackedBucket = { ts: number } & Record<string, number>;

/**
 * Pivots per-group buckets into one row per `bucketMs` (zero-filled from `since` through `until`),
 * with a column per top group and everything else summed into `OTHER`.
 */
export function stackBuckets(
  rows: GroupedUsageBucket[],
  groups: string[],
  metric: BreakdownMetric,
  since: number | null,
  until: number,
  bucketMs: number,
): StackedBucket[] {
  const first = since === null ? rows[0]?.ts : Math.floor(since / bucketMs) * bucketMs;
  if (first === undefined) return [];
  const known = new Set(groups);
  const byTs = new Map<number, StackedBucket>();
  for (let ts = first; ts <= until; ts += bucketMs) {
    byTs.set(ts, { ts, ...Object.fromEntries([...groups, OTHER].map((g) => [g, 0])) });
  }
  for (const row of rows) {
    const bucket = byTs.get(row.ts);
    if (!bucket) continue;
    const column = known.has(row.group) ? row.group : OTHER;
    bucket[column] = (bucket[column] ?? 0) + metricOf(row, metric);
  }
  return [...byTs.values()];
}
