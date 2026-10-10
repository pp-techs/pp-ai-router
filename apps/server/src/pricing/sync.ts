import {
  parseOpenRouterMetadata,
  type ModelMetadataStore,
  type ModelMetaEntry,
} from "../model-metadata.ts";
import type { ModelPrice } from "./types.ts";
import { LITELLM_SOURCE, LITELLM_URL, parseLiteLLM } from "./litellm.ts";
import { OPENROUTER_SOURCE, OPENROUTER_URL, parseOpenRouter } from "./openrouter.ts";
import type { PricingStore } from "./store.ts";

interface PricingSource {
  name: string;
  url: string;
  parse: (json: unknown) => ModelPrice[];
  /** Also read model facts (context window, modalities, ...) out of the same response. */
  parseMeta?: (json: unknown) => ModelMetaEntry[];
}

const SOURCES: PricingSource[] = [
  { name: LITELLM_SOURCE, url: LITELLM_URL, parse: parseLiteLLM },
  {
    name: OPENROUTER_SOURCE,
    url: OPENROUTER_URL,
    parse: parseOpenRouter,
    parseMeta: parseOpenRouterMetadata,
  },
];

export interface SyncResult {
  source: string;
  status: "updated" | "not_modified" | "error";
  models?: number;
  error?: string;
}

export interface SyncDeps {
  store: PricingStore;
  /** Where model facts of sources that carry them are saved. */
  metadata?: ModelMetadataStore | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  sources?: PricingSource[];
  log?: (msg: string) => void;
}

/** True when `source` carries model facts that were never saved (an older deployment, or a fresh table). */
function needsMetadata(source: PricingSource, metadata: ModelMetadataStore | undefined): boolean {
  return !!source.parseMeta && !!metadata && !metadata.has(source.name);
}

/**
 * Pulls every pricing source once. Each source is independent: a failure is recorded in
 * `pricing_sync_state` and the previous prices stay in place. Conditional requests use the stored ETag.
 */
export async function syncPricing(deps: SyncDeps): Promise<SyncResult[]> {
  const {
    store,
    metadata,
    fetch: doFetch = fetch,
    now = Date.now,
    sources = SOURCES,
    log = () => {},
  } = deps;
  const results: SyncResult[] = [];

  for (const source of sources) {
    const prev = store.syncState(source.name);
    try {
      // A stored ETag would answer 304 forever for metadata that was never saved, so it is not sent then.
      const res = await doFetch(source.url, {
        headers: {
          accept: "application/json",
          ...(prev?.etag && !needsMetadata(source, metadata) ? { "if-none-match": prev.etag } : {}),
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 304) {
        store.saveSyncState({
          source: source.name,
          etag: prev?.etag ?? null,
          synced_at: now(),
          model_count: prev?.model_count ?? null,
          last_error: null,
        });
        results.push({ source: source.name, status: "not_modified" });
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      const prices = source.parse(body);
      if (prices.length === 0) throw new Error("source returned no usable prices");
      const entries = metadata && source.parseMeta ? source.parseMeta(body) : undefined;
      store.replaceSource(source.name, prices, now());
      if (entries) metadata?.replaceSource(source.name, entries, now());
      store.saveSyncState({
        source: source.name,
        etag: res.headers.get("etag"),
        synced_at: now(),
        model_count: prices.length,
        last_error: null,
      });
      log(`pricing: ${source.name} updated (${prices.length} models)`);
      results.push({ source: source.name, status: "updated", models: prices.length });
    } catch (error) {
      const message = (error as Error).message;
      store.saveSyncState({
        source: source.name,
        etag: prev?.etag ?? null,
        synced_at: prev?.synced_at ?? null,
        model_count: prev?.model_count ?? null,
        last_error: message,
      });
      log(`pricing: ${source.name} failed: ${message}`);
      results.push({ source: source.name, status: "error", error: message });
    }
  }
  return results;
}

/** Syncs at startup when data is missing/stale, then every `intervalMs`. The timer never keeps the process alive. */
export function startPricingScheduler(deps: SyncDeps, intervalMs: number): () => void {
  const { store, metadata, now = Date.now, sources = SOURCES } = deps;
  const stale = sources.some((s) => {
    const at = store.syncState(s.name)?.synced_at;
    return at == null || now() - at >= intervalMs || needsMetadata(s, metadata);
  });
  if (stale) void syncPricing(deps);
  const timer = setInterval(() => void syncPricing(deps), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
