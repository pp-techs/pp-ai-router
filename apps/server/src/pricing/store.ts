import type { StatementSync } from "node:sqlite";
import { all, one, transaction, type Db } from "../db/database.ts";
import type { ModelPrice, PriceTier } from "./types.ts";

export const OVERRIDE_SOURCE = "override";
/** Fetched sources in lookup priority order; overrides always win. */
const FETCHED_SOURCES = ["litellm", "openrouter"] as const;

interface PriceRow {
  source: string;
  model: string;
  input_cost: number;
  output_cost: number;
  cache_read_cost: number | null;
  cache_write_cost: number | null;
  reasoning_cost: number | null;
  tiers: string;
}

export interface OverrideInput {
  model: string;
  input: number;
  output: number;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}

export interface SyncState {
  source: string;
  etag: string | null;
  synced_at: number | null;
  model_count: number | null;
  last_error: string | null;
}

function toPrice(row: PriceRow): ModelPrice {
  const price: ModelPrice = {
    model: row.model,
    source: row.source,
    input: row.input_cost,
    output: row.output_cost,
    tiers: JSON.parse(row.tiers) as PriceTier[],
  };
  if (row.cache_read_cost !== null) price.cacheRead = row.cache_read_cost;
  if (row.cache_write_cost !== null) price.cacheWrite = row.cache_write_cost;
  if (row.reasoning_cost !== null) price.reasoning = row.reasoning_cost;
  return price;
}

export class PricingStore {
  readonly #db: Db;
  readonly #getOverride: StatementSync;
  readonly #getFetched: StatementSync;

  constructor(db: Db) {
    this.#db = db;
    this.#getOverride = db.prepare(
      `SELECT 'override' AS source, model, input_cost, output_cost, cache_read_cost, cache_write_cost,
              NULL AS reasoning_cost, '[]' AS tiers
         FROM pricing_overrides WHERE model = ?`,
    );
    this.#getFetched = db.prepare(
      `SELECT source, model, input_cost, output_cost, cache_read_cost, cache_write_cost, reasoning_cost, tiers
         FROM model_prices WHERE source = ? AND model = ?`,
    );
  }

  /**
   * Resolves a price for the first matching candidate id, trying every override before any fetched
   * source, and fetched sources in priority order.
   */
  lookup(candidates: readonly string[]): ModelPrice | null {
    for (const id of candidates) {
      const row = one<PriceRow>(this.#getOverride, id);
      if (row) return toPrice(row);
    }
    for (const source of FETCHED_SOURCES) {
      for (const id of candidates) {
        const row = one<PriceRow>(this.#getFetched, source, id);
        if (row) return toPrice(row);
      }
    }
    return null;
  }

  /** Atomically swaps every row of `source` for `prices` (models that disappeared upstream are dropped). */
  replaceSource(source: string, prices: readonly ModelPrice[], now: number): void {
    transaction(this.#db, () => {
      this.#db.prepare("DELETE FROM model_prices WHERE source = ?").run(source);
      const insert = this.#db.prepare(
        `INSERT OR REPLACE INTO model_prices
           (source, model, input_cost, output_cost, cache_read_cost, cache_write_cost, reasoning_cost, tiers, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of prices) {
        insert.run(
          source,
          p.model,
          p.input,
          p.output,
          p.cacheRead ?? null,
          p.cacheWrite ?? null,
          p.reasoning ?? null,
          JSON.stringify(p.tiers),
          now,
        );
      }
    });
  }

  search(query: string | undefined, limit: number): ModelPrice[] {
    const rows = query
      ? all<PriceRow>(
          this.#db.prepare(
            `SELECT * FROM model_prices WHERE model LIKE ? ESCAPE '\\' ORDER BY model, source LIMIT ?`,
          ),
          `%${query.replace(/[\\%_]/g, "\\$&")}%`,
          limit,
        )
      : all<PriceRow>(
          this.#db.prepare("SELECT * FROM model_prices ORDER BY model, source LIMIT ?"),
          limit,
        );
    return rows.map(toPrice);
  }

  setOverride(o: OverrideInput, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO pricing_overrides (model, input_cost, output_cost, cache_read_cost, cache_write_cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET input_cost = excluded.input_cost, output_cost = excluded.output_cost,
           cache_read_cost = excluded.cache_read_cost, cache_write_cost = excluded.cache_write_cost`,
      )
      .run(o.model, o.input, o.output, o.cacheRead ?? null, o.cacheWrite ?? null, now);
  }

  deleteOverride(model: string): boolean {
    return this.#db.prepare("DELETE FROM pricing_overrides WHERE model = ?").run(model).changes > 0;
  }

  listOverrides(): ModelPrice[] {
    const rows = all<{ model: string }>(
      this.#db.prepare("SELECT model FROM pricing_overrides ORDER BY model"),
    );
    return rows.flatMap((r) => {
      const row = one<PriceRow>(this.#getOverride, r.model);
      return row ? [toPrice(row)] : [];
    });
  }

  syncStates(): SyncState[] {
    return all<SyncState>(this.#db.prepare("SELECT * FROM pricing_sync_state ORDER BY source"));
  }

  syncState(source: string): SyncState | undefined {
    return one<SyncState>(
      this.#db.prepare("SELECT * FROM pricing_sync_state WHERE source = ?"),
      source,
    );
  }

  saveSyncState(s: SyncState): void {
    this.#db
      .prepare(
        `INSERT INTO pricing_sync_state (source, etag, synced_at, model_count, last_error) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET etag = excluded.etag, synced_at = excluded.synced_at,
           model_count = excluded.model_count, last_error = excluded.last_error`,
      )
      .run(s.source, s.etag, s.synced_at, s.model_count, s.last_error);
  }
}
