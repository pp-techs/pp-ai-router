import { all, one, transaction, type Db } from "./db/database.ts";
import type { Logger } from "./logger.ts";
import type { TokenManager } from "./oauth/token-manager.ts";
import type { ModelInfo, ProviderAdapter } from "./providers/adapter.ts";
import type { Registry } from "./registry.ts";

export interface ModelList {
  /** `static` = fixed list shipped with the adapter; `fetched` = from the upstream; `none` = nothing known yet. */
  source: "static" | "fetched" | "none";
  models: ModelInfo[];
  /** Last successful fetch (epoch ms); null for static lists and never-fetched providers. */
  fetchedAt: number | null;
  /** Error of the most recent attempt, kept alongside the previous good list. */
  error: string | null;
}

interface ModelRow {
  model_id: string;
  name: string | null;
  context_window: number | null;
}

interface SyncRow {
  synced_at: number | null;
  last_attempt_at: number;
  last_error: string | null;
}

const FETCH_TIMEOUT_MS = 15_000;
/** Credentials tried per refresh before giving up (a dead or rate-limited key should not block discovery). */
const MAX_CREDENTIAL_TRIES = 3;

const toInfo = (r: ModelRow): ModelInfo => ({
  id: r.model_id,
  ...(r.name !== null && { name: r.name }),
  ...(r.context_window !== null && { contextWindow: r.context_window }),
});

/**
 * What each provider offers. OAuth/subscription adapters ship a fixed list. For the rest the list is
 * fetched from the upstream with one of the provider's credentials and stored, so it survives
 * restarts and `/v1/models` never waits on the network. A failed refresh keeps the previous list.
 */
export class ModelCatalog {
  readonly #db: Db;
  readonly #registry: Registry;
  readonly #tokens: TokenManager;
  readonly #adapters: Readonly<Record<string, ProviderAdapter>>;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #inflight = new Map<string, Promise<ModelList>>();

  constructor(
    db: Db,
    registry: Registry,
    tokens: TokenManager,
    adapters: Readonly<Record<string, ProviderAdapter>>,
    log: Logger,
    now: () => number = Date.now,
  ) {
    this.#db = db;
    this.#registry = registry;
    this.#tokens = tokens;
    this.#adapters = adapters;
    this.#log = log;
    this.#now = now;
  }

  /** Stored list, no network. */
  get(providerId: string): ModelList {
    const provider = this.#registry.provider(providerId);
    const adapter = provider && this.#adapters[provider.type];
    if (adapter?.staticModels) {
      return { source: "static", models: [...adapter.staticModels], fetchedAt: null, error: null };
    }
    const sync = one<SyncRow>(
      this.#db.prepare("SELECT * FROM provider_model_sync WHERE provider_id = ?"),
      providerId,
    );
    const models = all<ModelRow>(
      this.#db.prepare(
        "SELECT model_id, name, context_window FROM provider_models WHERE provider_id = ? ORDER BY model_id",
      ),
      providerId,
    ).map(toInfo);
    return {
      source: models.length > 0 ? "fetched" : "none",
      models,
      fetchedAt: sync?.synced_at ?? null,
      error: sync?.last_error ?? null,
    };
  }

  /** Stored list, fetching first if this provider has never been attempted. */
  async ensure(providerId: string): Promise<ModelList> {
    const attempted = one(
      this.#db.prepare("SELECT 1 AS x FROM provider_model_sync WHERE provider_id = ?"),
      providerId,
    );
    return attempted ? this.get(providerId) : this.refresh(providerId);
  }

  /** Every enabled `provider/model` pair across enabled providers, from stored data only. */
  all(): { provider: string; model: ModelInfo }[] {
    const out: { provider: string; model: ModelInfo }[] = [];
    for (const p of this.#registry.providers()) {
      if (!p.enabled) continue;
      for (const model of this.get(p.id).models) {
        if (!this.#registry.isModelDisabled(p.id, model.id)) out.push({ provider: p.id, model });
      }
    }
    return out;
  }

  /** Fetches from the upstream now. Concurrent calls for one provider share one fetch. */
  refresh(providerId: string): Promise<ModelList> {
    const existing = this.#inflight.get(providerId);
    if (existing) return existing;
    const run = this.#fetch(providerId).finally(() => this.#inflight.delete(providerId));
    this.#inflight.set(providerId, run);
    return run;
  }

  /** Background pass over every provider that supports discovery; never throws. */
  async refreshAll(): Promise<void> {
    for (const p of this.#registry.providers()) {
      if (!p.enabled || !this.#adapters[p.type]?.listModels || this.#adapters[p.type]?.staticModels)
        continue;
      await this.refresh(p.id).catch(() => {});
    }
  }

  async #fetch(providerId: string): Promise<ModelList> {
    const provider = this.#registry.provider(providerId);
    const adapter = provider && this.#adapters[provider.type];
    if (!provider || !adapter || adapter.staticModels || !adapter.listModels)
      return this.get(providerId);

    const credentials = provider.credentials.filter((c) => c.enabled && c.status === "active");
    let lastError = "no usable credential: add an active credential to fetch models";
    let tried = 0;
    for (const credential of credentials) {
      if (tried++ >= MAX_CREDENTIAL_TRIES) break;
      try {
        const auth = await this.#tokens.resolve(credential, provider.type);
        const models = await adapter.listModels({
          baseUrl: provider.baseUrl,
          token: auth.token,
          meta: auth.meta,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (models.length === 0) throw new Error("provider returned no models");
        this.#store(providerId, models);
        this.#log.info("models fetched", { provider: providerId, count: models.length });
        return this.get(providerId);
      } catch (error) {
        lastError = (error as Error).message;
      }
    }
    this.#log.warn("model fetch failed", { provider: providerId, error: lastError });
    this.#recordFailure(providerId, lastError);
    return this.get(providerId);
  }

  #store(providerId: string, models: readonly ModelInfo[]): void {
    const now = this.#now();
    transaction(this.#db, () => {
      this.#db.prepare("DELETE FROM provider_models WHERE provider_id = ?").run(providerId);
      const insert = this.#db.prepare(
        "INSERT OR REPLACE INTO provider_models (provider_id, model_id, name, context_window) VALUES (?, ?, ?, ?)",
      );
      for (const m of models) insert.run(providerId, m.id, m.name ?? null, m.contextWindow ?? null);
      this.#db
        .prepare(
          `INSERT INTO provider_model_sync (provider_id, synced_at, last_attempt_at, last_error) VALUES (?, ?, ?, NULL)
           ON CONFLICT(provider_id) DO UPDATE SET synced_at = excluded.synced_at,
             last_attempt_at = excluded.last_attempt_at, last_error = NULL`,
        )
        .run(providerId, now, now);
    });
  }

  #recordFailure(providerId: string, error: string): void {
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO provider_model_sync (provider_id, synced_at, last_attempt_at, last_error) VALUES (?, NULL, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error`,
      )
      .run(providerId, now, error);
  }
}

/** Refreshes at startup (non-blocking) and every `intervalMs`. The timer never keeps the process alive. */
export function startModelSync(catalog: ModelCatalog, intervalMs: number): () => void {
  void catalog.refreshAll();
  const timer = setInterval(() => void catalog.refreshAll(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
