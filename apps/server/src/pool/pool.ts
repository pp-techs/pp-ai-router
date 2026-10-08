import { matchesAny } from "../glob.ts";
import type { CredentialRuntime, Registry } from "../registry.ts";
import type { RecentUsage } from "./recent-usage.ts";
import type { Candidate } from "./selectors.ts";

export type FailureKind = "rate_limited" | "server_error" | "forbidden" | "auth";

interface CredentialState {
  inflight: number;
  failCount: number;
  cooldownUntil: number;
  lastUsedAt: number;
  /** Request start times in the last minute, for the per-credential rpm cap. */
  recent: number[];
}

const BACKOFF: Record<Exclude<FailureKind, "auth">, { baseMs: number; maxMs: number }> = {
  rate_limited: { baseMs: 30_000, maxMs: 600_000 },
  server_error: { baseMs: 5_000, maxMs: 300_000 },
  // A 403 is usually a per-model/permission problem, not a dead key: park it for a long while.
  forbidden: { baseMs: 300_000, maxMs: 3_600_000 },
};

export interface Lease {
  credential: CredentialRuntime;
  /** Upstream accepted the request: clears the failure streak. */
  ok(): void;
  /** Upstream rejected it: puts the credential on cooldown (or retires it for `auth`). */
  fail(kind: FailureKind, retryAfterMs?: number): void;
  /** Frees the in-flight slot. Idempotent; call when the response (or stream) is finished. */
  release(): void;
}

export type AcquireError =
  | { error: "provider_unavailable" }
  | { error: "no_credential"; retryAt: number | null };

export interface AcquireOptions {
  model: string;
  /** Credentials that already failed this request. */
  exclude?: ReadonlySet<string>;
  /** Same key => same credential while the provider's sticky TTL lasts. */
  stickyKey?: string | undefined;
}

const STICKY_MAX = 10_000;

/**
 * Chooses which of a provider's credentials serves a request and tracks their health. Pure
 * in-memory state (in-flight, cooldowns, rpm) keyed by credential id; it survives registry reloads.
 */
export class CredentialPool {
  readonly #registry: Registry;
  readonly #usage: RecentUsage;
  readonly #now: () => number;
  readonly #state = new Map<string, CredentialState>();
  readonly #sticky = new Map<string, { credentialId: string; expiresAt: number }>();

  constructor(registry: Registry, usage: RecentUsage, now: () => number = Date.now) {
    this.#registry = registry;
    this.#usage = usage;
    this.#now = now;
  }

  acquire(providerId: string, options: AcquireOptions): { lease: Lease } | AcquireError {
    const provider = this.#registry.provider(providerId);
    if (!provider?.enabled) return { error: "provider_unavailable" };
    const now = this.#now();

    const usable = provider.credentials.filter(
      (c) =>
        c.enabled &&
        c.status === "active" &&
        !options.exclude?.has(c.id) &&
        (c.models === null || matchesAny(c.models, options.model)),
    );
    const ready = usable.filter((c) => {
      const s = this.#stateOf(c.id);
      if (s.cooldownUntil > now) return false;
      return c.rpmLimit === null || this.#requestsLastMinute(s, now) < c.rpmLimit;
    });
    if (ready.length === 0) {
      const waits = usable.map((c) => this.#stateOf(c.id).cooldownUntil).filter((t) => t > now);
      return { error: "no_credential", retryAt: waits.length ? Math.min(...waits) : null };
    }

    let chosen: CredentialRuntime | undefined;
    const stickyId =
      options.stickyKey && provider.stickyTtlMs > 0
        ? `${providerId}\u0000${options.stickyKey}`
        : null;
    if (stickyId) {
      const hit = this.#sticky.get(stickyId);
      if (hit && hit.expiresAt > now) chosen = ready.find((c) => c.id === hit.credentialId);
    }
    if (!chosen) {
      const candidates: Candidate[] = ready.map((c) => ({
        id: c.id,
        weight: c.weight,
        priority: c.priority,
        inflight: this.#stateOf(c.id).inflight,
        recentTokens: this.#usage.sum(c.id, now),
        lastUsedAt: this.#stateOf(c.id).lastUsedAt,
      }));
      const picked = provider.selector.pick(candidates);
      chosen = ready.find((c) => c.id === picked.id)!;
    }
    if (stickyId) this.#remember(stickyId, chosen.id, now + provider.stickyTtlMs);

    return { lease: this.#lease(chosen, now) };
  }

  /** Credit tokens to a credential so `least_used` sees them. */
  recordTokens(credentialId: string, tokens: number): void {
    this.#usage.add(credentialId, tokens, this.#now());
  }

  /** Live health for the admin API. */
  snapshot(credentialId: string): {
    inflight: number;
    failCount: number;
    cooldownUntil: number | null;
  } {
    const s = this.#stateOf(credentialId);
    return {
      inflight: s.inflight,
      failCount: s.failCount,
      cooldownUntil: s.cooldownUntil > this.#now() ? s.cooldownUntil : null,
    };
  }

  #lease(credential: CredentialRuntime, now: number): Lease {
    const state = this.#stateOf(credential.id);
    state.inflight++;
    state.lastUsedAt = now;
    state.recent.push(now);
    let released = false;

    return {
      credential,
      ok: () => {
        state.failCount = 0;
        state.cooldownUntil = 0;
      },
      fail: (kind, retryAfterMs) => {
        if (kind === "auth") {
          this.#registry.markDead(credential.id, "upstream rejected the credential (401)");
          return;
        }
        state.failCount++;
        const { baseMs, maxMs } = BACKOFF[kind];
        // An explicit Retry-After wins over the computed backoff, but never parks a key beyond maxMs.
        const wait =
          retryAfterMs === undefined
            ? Math.min(baseMs * 2 ** (state.failCount - 1), maxMs)
            : Math.min(retryAfterMs, maxMs);
        state.cooldownUntil = this.#now() + wait;
      },
      release: () => {
        if (released) return;
        released = true;
        state.inflight = Math.max(0, state.inflight - 1);
      },
    };
  }

  #stateOf(id: string): CredentialState {
    let s = this.#state.get(id);
    if (!s) {
      s = { inflight: 0, failCount: 0, cooldownUntil: 0, lastUsedAt: 0, recent: [] };
      this.#state.set(id, s);
    }
    return s;
  }

  #requestsLastMinute(s: CredentialState, now: number): number {
    const cutoff = now - 60_000;
    while (s.recent.length > 0 && s.recent[0]! <= cutoff) s.recent.shift();
    return s.recent.length;
  }

  #remember(key: string, credentialId: string, expiresAt: number): void {
    this.#sticky.delete(key); // re-insert so Map order approximates LRU
    this.#sticky.set(key, { credentialId, expiresAt });
    if (this.#sticky.size > STICKY_MAX) this.#sticky.delete(this.#sticky.keys().next().value!);
  }
}
