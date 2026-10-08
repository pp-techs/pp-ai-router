import { all, type Db } from "../db/database.ts";

const BUCKET_MS = 60_000;

/** Per-credential token counts over a sliding window, kept in per-minute buckets. Feeds `least_used`. */
export class RecentUsage {
  readonly #windowMs: number;
  readonly #buckets = new Map<string, Map<number, number>>();

  constructor(windowMs = 3_600_000) {
    this.#windowMs = windowMs;
  }

  add(credentialId: string, tokens: number, nowMs: number): void {
    if (tokens <= 0) return;
    const buckets = this.#buckets.get(credentialId) ?? new Map<number, number>();
    const start = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
    buckets.set(start, (buckets.get(start) ?? 0) + tokens);
    this.#buckets.set(credentialId, buckets);
    this.#prune(buckets, nowMs);
  }

  sum(credentialId: string, nowMs: number): number {
    const buckets = this.#buckets.get(credentialId);
    if (!buckets) return 0;
    this.#prune(buckets, nowMs);
    let total = 0;
    for (const v of buckets.values()) total += v;
    return total;
  }

  /** Rebuilds from the ledger so a restart does not reset balancing. */
  load(db: Db, nowMs: number): void {
    const since = nowMs - this.#windowMs;
    const rows = all<{ credential_id: string; minute: number; tokens: number }>(
      db.prepare(
        `SELECT credential_id, ts / 60000 * 60000 AS minute, SUM(input_tokens + output_tokens) AS tokens
           FROM usage_events WHERE ts >= ? GROUP BY credential_id, minute`,
      ),
      since,
    );
    for (const r of rows) this.add(r.credential_id, r.tokens, r.minute);
  }

  #prune(buckets: Map<number, number>, nowMs: number): void {
    const cutoff = nowMs - this.#windowMs;
    for (const start of buckets.keys()) if (start + BUCKET_MS <= cutoff) buckets.delete(start);
  }
}
