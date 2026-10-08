import type { ModelPrice } from "./types.ts";
import { LITELLM_SOURCE, LITELLM_URL, parseLiteLLM } from "./litellm.ts";
import { OPENROUTER_SOURCE, OPENROUTER_URL, parseOpenRouter } from "./openrouter.ts";
import type { PricingStore } from "./store.ts";

interface PricingSource {
  name: string;
  url: string;
  parse: (json: unknown) => ModelPrice[];
}

const SOURCES: PricingSource[] = [
  { name: LITELLM_SOURCE, url: LITELLM_URL, parse: parseLiteLLM },
  { name: OPENROUTER_SOURCE, url: OPENROUTER_URL, parse: parseOpenRouter },
];

export interface SyncResult {
  source: string;
  status: "updated" | "not_modified" | "error";
  models?: number;
  error?: string;
}

export interface SyncDeps {
  store: PricingStore;
  fetch?: typeof fetch;
  now?: () => number;
  sources?: PricingSource[];
  log?: (msg: string) => void;
}

/**
 * Pulls every pricing source once. Each source is independent: a failure is recorded in
 * `pricing_sync_state` and the previous prices stay in place. Conditional requests use the stored ETag.
 */
export async function syncPricing(deps: SyncDeps): Promise<SyncResult[]> {
  const { store, fetch: doFetch = fetch, now = Date.now, sources = SOURCES, log = () => {} } = deps;
  const results: SyncResult[] = [];

  for (const source of sources) {
    const prev = store.syncState(source.name);
    try {
      const res = await doFetch(source.url, {
        headers: {
          accept: "application/json",
          ...(prev?.etag ? { "if-none-match": prev.etag } : {}),
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
      const prices = source.parse(await res.json());
      if (prices.length === 0) throw new Error("source returned no usable prices");
      store.replaceSource(source.name, prices, now());
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
  const { store, now = Date.now, sources = SOURCES } = deps;
  const stale = sources.some((s) => {
    const at = store.syncState(s.name)?.synced_at;
    return at == null || now() - at >= intervalMs;
  });
  if (stale) void syncPricing(deps);
  const timer = setInterval(() => void syncPricing(deps), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
