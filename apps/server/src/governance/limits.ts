import type { StatementSync } from "node:sqlite";
import { all, one, transaction, type Db } from "../db/database.ts";

export const METRICS = [
  "usd",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "requests",
] as const;
export type Metric = (typeof METRICS)[number];
export type LimitMode = "fixed" | "rolling";

export interface Limit {
  id: string;
  keyId: string;
  metric: Metric;
  /** null = lifetime total. */
  windowSec: number | null;
  mode: LimitMode;
  max: number;
}

export interface UsageDelta {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LimitStatus {
  limit: Limit;
  used: number;
  /** Epoch ms when a fixed window resets; null for rolling/total windows. */
  resetsAt: number | null;
}

const UNITS: Record<string, number> = { m: 60, h: 3600, d: 86_400, w: 604_800 };

/** "30m" | "1h" | "1d" | "7d" | "2w" | "total" -> seconds (null = total). Throws on anything else. */
export function parseWindow(text: string): number | null {
  if (text === "total") return null;
  const m = /^(\d+)([mhdw])$/.exec(text);
  if (!m) throw new Error(`invalid window "${text}" (use e.g. 30m, 1h, 1d, 7d, total)`);
  const seconds = Number(m[1]) * UNITS[m[2]!]!;
  if (seconds < 60) throw new Error("window must be at least 1 minute");
  // Hour buckets serve windows over a day, so those must align to whole hours.
  if (seconds > 86_400 && seconds % 3600 !== 0)
    throw new Error("windows over 1 day must be whole hours");
  return seconds;
}

export function formatWindow(sec: number | null): string {
  if (sec === null) return "total";
  for (const [unit, size] of [
    ["w", 604_800],
    ["d", 86_400],
    ["h", 3600],
    ["m", 60],
  ] as const) {
    if (sec % size === 0) return `${sec / size}${unit}`;
  }
  return `${sec}s`;
}

/** Minute buckets keep short windows exact; hour buckets keep long windows cheap to sum. */
const granularityFor = (windowSec: number | null): 60 | 3600 =>
  windowSec !== null && windowSec <= 86_400 ? 60 : 3600;

interface SumRow {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

function pick(row: SumRow, metric: Metric): number {
  switch (metric) {
    case "usd":
      return row.cost_usd;
    case "requests":
      return row.requests;
    case "input_tokens":
      return row.input_tokens;
    case "output_tokens":
      return row.output_tokens;
    case "total_tokens":
      return row.input_tokens + row.output_tokens;
  }
}

/**
 * Per-key usage accounting backed by SQLite buckets. All calls are synchronous, so a check followed
 * by a record cannot interleave with another request's check on the same process. Concurrent
 * in-flight requests can still overshoot a limit by their own cost (the cost is only known at the end).
 */
export class UsageMeter {
  readonly #db: Db;
  readonly #sum: StatementSync;
  readonly #upsert: StatementSync;

  constructor(db: Db) {
    this.#db = db;
    this.#sum = db.prepare(
      `SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM usage_buckets WHERE key_id = ? AND granularity = ? AND bucket_start >= ?`,
    );
    this.#upsert = db.prepare(
      `INSERT INTO usage_buckets (key_id, granularity, bucket_start, requests, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_id, granularity, bucket_start) DO UPDATE SET
         requests = requests + excluded.requests, input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens, cost_usd = cost_usd + excluded.cost_usd`,
    );
  }

  record(keyId: string, delta: UsageDelta, nowMs: number): void {
    const nowSec = Math.floor(nowMs / 1000);
    const write = () => {
      for (const g of [60, 3600]) {
        this.#upsert.run(
          keyId,
          g,
          Math.floor(nowSec / g) * g,
          delta.requests,
          delta.inputTokens,
          delta.outputTokens,
          delta.costUsd,
        );
      }
    };
    // `record` may run inside the caller's transaction (accounting) or alone.
    if (this.#db.isTransaction) write();
    else transaction(this.#db, write);
  }

  status(limit: Limit, nowMs: number): LimitStatus {
    const nowSec = Math.floor(nowMs / 1000);
    const g = granularityFor(limit.windowSec);
    let from = 0;
    let resetsAt: number | null = null;
    if (limit.windowSec !== null) {
      if (limit.mode === "fixed") {
        from = Math.floor(nowSec / limit.windowSec) * limit.windowSec;
        resetsAt = (from + limit.windowSec) * 1000;
      } else {
        // Include the partially-aged oldest bucket: errs towards blocking, never towards overspending.
        from = Math.floor((nowSec - limit.windowSec) / g) * g;
      }
    }
    const row = one<SumRow>(this.#sum, limit.keyId, g, from) ?? {
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
    return { limit, used: pick(row, limit.metric), resetsAt };
  }

  /** First exhausted limit, or null when the key may proceed. */
  firstExceeded(limits: readonly Limit[], nowMs: number): LimitStatus | null {
    for (const limit of limits) {
      const s = this.status(limit, nowMs);
      if (s.used >= limit.max) return s;
    }
    return null;
  }
}

interface LimitRow {
  id: string;
  key_id: string;
  metric: Metric;
  window_sec: number | null;
  mode: LimitMode;
  max_value: number;
}

export const toLimit = (r: LimitRow): Limit => ({
  id: r.id,
  keyId: r.key_id,
  metric: r.metric,
  windowSec: r.window_sec,
  mode: r.mode,
  max: r.max_value,
});

export function listLimits(db: Db, keyId: string): Limit[] {
  return all<LimitRow>(
    db.prepare("SELECT * FROM limits WHERE key_id = ? ORDER BY created_at, id"),
    keyId,
  ).map(toLimit);
}
