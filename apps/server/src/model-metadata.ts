import { all, one, transaction, type Db } from "./db/database.ts";
import { candidateVariants } from "./pricing/aliases.ts";
import type { ModelDetails, ModelInfo } from "./providers/adapter.ts";
import { isRecord } from "./providers/anthropic/json.ts";
import { MAX_MODELS, readModelDetails } from "./providers/model-list.ts";

/** What an external catalog may supply for a model. `name` is not filled in: catalogs prefix it with the vendor. */
export type ModelMeta = Omit<ModelDetails, "name">;

export interface ModelMetaEntry {
  model: string;
  meta: ModelMeta;
}

interface Hit {
  source: string;
  meta: ModelMeta;
}

/** Fields enrichment may fill when the upstream left them out. */
const FILLABLE = [
  "description",
  "created",
  "contextWindow",
  "maxOutputTokens",
  "inputModalities",
  "outputModalities",
  "supportedParameters",
] as const satisfies readonly (keyof ModelMeta)[];

/** Reads an OpenRouter `GET /models` body into one entry per model that has at least one usable fact. */
export function parseOpenRouterMetadata(json: unknown): ModelMetaEntry[] {
  const data = isRecord(json) ? json.data : undefined;
  if (!Array.isArray(data)) throw new Error("openrouter: expected { data: [...] }");
  const entries: ModelMetaEntry[] = [];
  for (const item of data.slice(0, MAX_MODELS)) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) continue;
    const { name: _name, ...meta } = readModelDetails(item);
    if (Object.keys(meta).length > 0) entries.push({ model: item.id, meta });
  }
  return entries;
}

/**
 * Model facts from external catalogs, kept apart from `provider_models` (which is rewritten on every
 * refresh) and merged in at read time, so a catalog sync reaches every provider without refetching it.
 * Held in memory after first use: lookups run per model on every `/v1/models` request.
 */
export class ModelMetadataStore {
  readonly #db: Db;
  #index: Map<string, Hit> | null = null;

  constructor(db: Db) {
    this.#db = db;
  }

  /** True once `source` has stored at least one model. */
  has(source: string): boolean {
    return (
      one(
        this.#db.prepare("SELECT 1 AS x FROM model_metadata WHERE source = ? LIMIT 1"),
        source,
      ) !== undefined
    );
  }

  /** Atomically swaps every row of `source` (models that disappeared upstream are dropped). */
  replaceSource(source: string, entries: readonly ModelMetaEntry[], now: number): void {
    transaction(this.#db, () => {
      this.#db.prepare("DELETE FROM model_metadata WHERE source = ?").run(source);
      const insert = this.#db.prepare(
        "INSERT OR REPLACE INTO model_metadata (source, model, data, fetched_at) VALUES (?, ?, ?, ?)",
      );
      for (const e of entries) insert.run(source, e.model, JSON.stringify(e.meta), now);
    });
    this.#index = null;
  }

  #load(): Map<string, Hit> {
    if (this.#index) return this.#index;
    const index = new Map<string, Hit>();
    for (const row of all<{ source: string; model: string; data: string }>(
      this.#db.prepare("SELECT source, model, data FROM model_metadata ORDER BY source"),
    )) {
      if (!index.has(row.model)) {
        index.set(row.model, { source: row.source, meta: JSON.parse(row.data) as ModelMeta });
      }
    }
    this.#index = index;
    return index;
  }

  /**
   * Returns `info` with the facts the upstream left out filled in from the catalog, each noted in
   * `sources`. An exact id (`provider/model`, then `model`) beats another spelling of it. Upstream
   * values are never overwritten.
   */
  enrich(providerId: string, info: ModelInfo): ModelInfo {
    const index = this.#load();
    if (index.size === 0) return info;
    const candidates = [`${providerId}/${info.id}`, info.id];
    const hit = [...candidates, ...candidateVariants(candidates)]
      .map((id) => index.get(id))
      .find((h) => h !== undefined);
    if (!hit) return info;

    const out: ModelInfo = { ...info };
    const sources: NonNullable<ModelInfo["sources"]> = { ...info.sources };
    for (const key of FILLABLE) {
      const value = hit.meta[key];
      if (out[key] !== undefined || value === undefined) continue;
      Object.assign(out, { [key]: value });
      sources[key] = hit.source;
    }
    if (Object.keys(sources).length > 0) out.sources = sources;
    return out;
  }
}
