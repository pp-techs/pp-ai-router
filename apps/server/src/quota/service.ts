import type { Logger } from "../logger.ts";
import { CredentialUnavailableError, type TokenManager } from "../oauth/token-manager.ts";
import type { CredentialPool } from "../pool/pool.ts";
import type { ProviderAdapter } from "../providers/adapter.ts";
import type { CredentialRuntime, ProviderRuntime, Registry } from "../registry.ts";
import { QuotaError, type Quota, type QuotaFailure } from "./types.ts";
import { QUOTA_TIMEOUT_MS, failureForError } from "./wire.ts";

/** A reading is reused this long: probes multiply by account count and upstreams rate-limit them. */
export const QUOTA_TTL_MS = 10 * 60_000;
/** A failed probe is remembered briefly so a broken account is not hammered by every page view. */
export const QUOTA_FAILURE_TTL_MS = 60_000;
/** Park time of an exhausted account whose reset time is unknown: long enough to spare upstream, short enough to re-check. */
const EXHAUSTED_FALLBACK_MS = QUOTA_TTL_MS;
const PROBE_CONCURRENCY = 4;

export type QuotaStatus =
  | { ok: true; credentialId: string; quota: Quota; checkedAt: number }
  | { ok: false; credentialId: string; failure: QuotaFailure; checkedAt: number };

interface Entry {
  status: QuotaStatus;
  expiresAt: number;
}

/**
 * Per-account quota of OAuth providers. A reading is cached, probes of one account are single-flight,
 * and an account that proves to be out of allowance is parked in the pool until its quota resets, so
 * requests stop being sent to an account that can only answer 429.
 */
export class QuotaService {
  readonly #registry: Registry;
  readonly #pool: CredentialPool;
  readonly #tokens: TokenManager;
  readonly #adapters: Readonly<Record<string, ProviderAdapter>>;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #cache = new Map<string, Entry>();
  readonly #inflight = new Map<string, Promise<QuotaStatus>>();

  constructor(
    registry: Registry,
    pool: CredentialPool,
    tokens: TokenManager,
    adapters: Readonly<Record<string, ProviderAdapter>>,
    log: Logger,
    now: () => number = Date.now,
  ) {
    this.#registry = registry;
    this.#pool = pool;
    this.#tokens = tokens;
    this.#adapters = adapters;
    this.#log = log;
    this.#now = now;
  }

  /** Whether the provider type can report account quota at all. */
  supports(providerType: string): boolean {
    return this.#adapters[providerType]?.quota !== undefined;
  }

  /**
   * Quota of one credential, or `undefined` when it has none to report (unknown credential, API key,
   * provider type without a usage endpoint). `maxAgeMs` bounds how old a cached reading may be
   * (default: the TTL); `0` forces a live probe.
   */
  async get(
    credentialId: string,
    options: { maxAgeMs?: number } = {},
  ): Promise<QuotaStatus | undefined> {
    const found = this.#locate(credentialId);
    if (!found) return undefined;
    const { provider, credential } = found;

    const entry = this.#cache.get(credentialId);
    const maxAge = options.maxAgeMs;
    const now = this.#now();
    if (entry && entry.expiresAt > now) {
      if (maxAge === undefined || now - entry.status.checkedAt < maxAge) return entry.status;
    }
    const running = this.#inflight.get(credentialId);
    if (running) return running;

    const probe = this.#probe(provider, credential).finally(() => {
      this.#inflight.delete(credentialId);
    });
    this.#inflight.set(credentialId, probe);
    return probe;
  }

  /** Quota of every OAuth credential of a provider, in credential order. */
  async forProvider(
    providerId: string,
    options: { maxAgeMs?: number } = {},
  ): Promise<QuotaStatus[]> {
    const provider = this.#registry.provider(providerId);
    if (!provider || !this.supports(provider.type)) return [];
    const ids = provider.credentials.filter((c) => c.auth.type === "oauth").map((c) => c.id);

    const results: QuotaStatus[] = [];
    for (let i = 0; i < ids.length; i += PROBE_CONCURRENCY) {
      const batch = await Promise.all(
        ids.slice(i, i + PROBE_CONCURRENCY).map((id) => this.get(id, options)),
      );
      for (const status of batch) if (status) results.push(status);
    }
    return results;
  }

  /** Re-reads every quota-capable account (the periodic job) and forgets credentials that are gone. */
  async refreshAll(): Promise<void> {
    const live = new Set<string>();
    for (const provider of this.#registry.providers()) {
      for (const c of provider.credentials) live.add(c.id);
      if (!provider.enabled || !this.supports(provider.type)) continue;
      try {
        await this.forProvider(provider.id, { maxAgeMs: 0 });
      } catch (error) {
        this.#log.warn("quota sync failed", {
          provider: provider.id,
          error: (error as Error).message,
        });
      }
    }
    for (const id of this.#cache.keys()) if (!live.has(id)) this.#cache.delete(id);
  }

  #locate(
    credentialId: string,
  ): { provider: ProviderRuntime; credential: CredentialRuntime } | undefined {
    for (const provider of this.#registry.providers()) {
      const credential = provider.credentials.find((c) => c.id === credentialId);
      if (credential)
        return credential.auth.type === "oauth" && this.supports(provider.type)
          ? { provider, credential }
          : undefined;
    }
    return undefined;
  }

  async #probe(provider: ProviderRuntime, credential: CredentialRuntime): Promise<QuotaStatus> {
    const adapter = this.#adapters[provider.type]!;
    const finish = (status: QuotaStatus): QuotaStatus => {
      this.#cache.set(credential.id, {
        status,
        expiresAt: status.checkedAt + (status.ok ? QUOTA_TTL_MS : QUOTA_FAILURE_TTL_MS),
      });
      return status;
    };
    const fail = (failure: QuotaFailure): QuotaStatus =>
      finish({ ok: false, credentialId: credential.id, failure, checkedAt: this.#now() });

    // A retired account would only be refused; its last_error already says why.
    if (credential.status === "dead") return fail("account_unavailable");

    const read = (auth: { token: string; meta: Readonly<Record<string, string>> }) =>
      adapter.quota!({
        baseUrl: provider.baseUrl,
        token: auth.token,
        meta: auth.meta,
        signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
      });

    let quota: Quota;
    try {
      const auth = await this.#tokens.resolve(credential, provider.type);
      try {
        quota = await read(auth);
      } catch (error) {
        // The access token may have been revoked early: refresh once, as the request path does.
        if (!(error instanceof QuotaError && error.status === 401)) throw error;
        quota = await read(await this.#tokens.refreshNow(credential, provider.type));
      }
    } catch (error) {
      const failure =
        error instanceof CredentialUnavailableError
          ? "account_unavailable"
          : failureForError(error);
      this.#log.warn("quota probe failed", {
        provider: provider.id,
        credential: credential.id,
        failure,
      });
      return fail(failure);
    }

    const checkedAt = this.#now();
    this.#pool.park(
      credential.id,
      quota.exhausted ? (quota.resetsAt ?? checkedAt + EXHAUSTED_FALLBACK_MS) : null,
    );
    return finish({ ok: true, credentialId: credential.id, quota, checkedAt });
  }
}

/** Probes every account at startup (non-blocking) and every `intervalMs`. The timer never keeps the process alive. */
export function startQuotaSync(service: QuotaService, intervalMs: number): () => void {
  void service.refreshAll();
  const timer = setInterval(() => void service.refreshAll(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
