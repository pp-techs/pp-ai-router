import { describe, expect, it } from "vite-plus/test";
import type { UsageBucket } from "../api/types.ts";
import { emptyBucket, fillBuckets } from "./timeline.ts";

const HOUR = 3_600_000;
const bucket = (ts: number, requests: number): UsageBucket => ({ ...emptyBucket(ts), requests });

describe("fillBuckets", () => {
  it("zero-fills idle buckets between the window start and now", () => {
    const rows = [bucket(2 * HOUR, 3), bucket(4 * HOUR, 1)];
    const out = fillBuckets(rows, 1 * HOUR + 5, 5 * HOUR + 10, HOUR);
    expect(out.map((b) => [b.ts / HOUR, b.requests])).toEqual([
      [1, 0],
      [2, 3],
      [3, 0],
      [4, 1],
      [5, 0],
    ]);
  });

  it("starts all-time charts at the first bucket with data, and is empty without any", () => {
    const out = fillBuckets([bucket(7 * HOUR, 2)], null, 8 * HOUR, HOUR);
    expect(out.map((b) => b.ts / HOUR)).toEqual([7, 8]);
    expect(fillBuckets([], null, 8 * HOUR, HOUR)).toEqual([]);
  });

  it("keeps the window's idle buckets even when there is no traffic at all", () => {
    expect(fillBuckets([], 2 * HOUR, 4 * HOUR, HOUR)).toHaveLength(3);
  });
});
