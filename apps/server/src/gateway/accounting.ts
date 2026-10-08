import { transaction, type Db } from "../db/database.ts";
import type { UsageMeter } from "../governance/limits.ts";
import type { CredentialPool } from "../pool/pool.ts";
import { computeCost } from "../pricing/cost.ts";
import type { ModelPrice, Usage } from "../pricing/types.ts";

export type EventStatus = "ok" | "aborted" | "error" | "no_usage";

export interface UsageRecord {
  keyId: string;
  providerId: string;
  credentialId: string;
  model: string;
  upstreamModel: string;
  usage: Usage;
  price: ModelPrice | null;
  stream: boolean;
  status: EventStatus;
  latencyMs: number;
}

/** Writes the ledger row, bumps the key's buckets and feeds the pool's balancing counters. */
export class Accounting {
  readonly #db: Db;
  readonly #meter: UsageMeter;
  readonly #pool: CredentialPool;
  readonly #now: () => number;

  constructor(db: Db, meter: UsageMeter, pool: CredentialPool, now: () => number = Date.now) {
    this.#db = db;
    this.#meter = meter;
    this.#pool = pool;
    this.#now = now;
  }

  record(r: UsageRecord): number {
    const now = this.#now();
    const cost = r.price ? computeCost(r.price, r.usage) : 0;
    transaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO usage_events (ts, key_id, provider_id, credential_id, model, upstream_model, input_tokens,
             output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, cost_usd, price_source, stream, status, latency_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          now,
          r.keyId,
          r.providerId,
          r.credentialId,
          r.model,
          r.upstreamModel,
          r.usage.promptTokens,
          r.usage.completionTokens,
          r.usage.cachedTokens,
          r.usage.cacheWriteTokens,
          r.usage.reasoningTokens,
          cost,
          r.price?.source ?? "unknown",
          r.stream ? 1 : 0,
          r.status,
          r.latencyMs,
        );
      this.#meter.record(
        r.keyId,
        {
          requests: 1,
          inputTokens: r.usage.promptTokens,
          outputTokens: r.usage.completionTokens,
          costUsd: cost,
        },
        now,
      );
    });
    this.#pool.recordTokens(r.credentialId, r.usage.promptTokens + r.usage.completionTokens);
    return cost;
  }
}
