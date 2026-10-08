import type { UsageBucket } from "../api/types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type RangeKey = "1h" | "24h" | "7d" | "30d" | "all";

/** `ms: null` is all time; `bucketMs` is the chart resolution that keeps each range at roughly 24–60 points. */
export const RANGES: Record<RangeKey, { label: string; ms: number | null; bucketMs: number }> = {
  "1h": { label: "Last hour", ms: HOUR, bucketMs: MINUTE },
  "24h": { label: "Last 24 hours", ms: DAY, bucketMs: HOUR },
  "7d": { label: "Last 7 days", ms: 7 * DAY, bucketMs: 6 * HOUR },
  "30d": { label: "Last 30 days", ms: 30 * DAY, bucketMs: DAY },
  all: { label: "All time", ms: null, bucketMs: DAY },
};

export const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];

export const emptyBucket = (ts: number): UsageBucket => ({
  ts,
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
});

/**
 * The server returns only buckets that saw traffic, so a chart of it would join the dots across idle
 * stretches. This returns one bucket per `bucketMs` from the bucket holding `since` (or, for all time,
 * the first bucket with data) through the bucket holding `until`, zero-filled where nothing happened.
 */
export function fillBuckets(
  rows: UsageBucket[],
  since: number | null,
  until: number,
  bucketMs: number,
): UsageBucket[] {
  const first = since === null ? rows[0]?.ts : Math.floor(since / bucketMs) * bucketMs;
  if (first === undefined) return [];
  const byTs = new Map(rows.map((r) => [r.ts, r]));
  const filled: UsageBucket[] = [];
  for (let ts = first; ts <= until; ts += bucketMs) filled.push(byTs.get(ts) ?? emptyBucket(ts));
  return filled;
}
