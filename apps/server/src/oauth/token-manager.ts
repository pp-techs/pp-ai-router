import type { Registry, CredentialRuntime } from "../registry.ts";
import type { Logger } from "../logger.ts";
import type { ProviderAdapter } from "../providers/adapter.ts";
import { OAuthRefreshError, type OAuthTokens } from "./types.ts";

export interface ResolvedAuth {
  /** Bearer/API token to present upstream. */
  token: string;
  /** Provider-specific extras stored with the account (project id, profile ARN, ...). Empty for API keys. */
  meta: Readonly<Record<string, string>>;
}

/** The credential cannot be used right now. `terminal` means it was retired until re-authorised. */
export class CredentialUnavailableError extends Error {
  readonly terminal: boolean;

  constructor(message: string, terminal: boolean, options?: ErrorOptions) {
    super(message, options);
    this.terminal = terminal;
  }
}

const REFRESH_SKEW_MS = 60_000;

/**
 * Turns a credential into something an adapter can send: API keys pass straight through, OAuth
 * accounts are refreshed shortly before expiry. Concurrent refreshes of one account share a single
 * upstream call (refresh tokens are often single-use), and the result is persisted encrypted.
 */
export class TokenManager {
  readonly #registry: Registry;
  readonly #adapters: Readonly<Record<string, ProviderAdapter>>;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #inflight = new Map<string, Promise<OAuthTokens>>();

  constructor(
    registry: Registry,
    adapters: Readonly<Record<string, ProviderAdapter>>,
    log: Logger,
    now: () => number = Date.now,
  ) {
    this.#registry = registry;
    this.#adapters = adapters;
    this.#log = log;
    this.#now = now;
  }

  async resolve(
    credential: CredentialRuntime,
    providerType: string,
    force = false,
  ): Promise<ResolvedAuth> {
    const { auth } = credential;
    if (auth.type === "api_key") return { token: auth.key, meta: {} };

    let tokens = auth.tokens;
    const expiring = tokens.expiresAt !== null && tokens.expiresAt - REFRESH_SKEW_MS <= this.#now();
    if (force || expiring) tokens = await this.#refresh(credential, providerType, tokens);
    return { token: tokens.accessToken, meta: tokens.extra };
  }

  /** Forces a refresh (e.g. after an upstream 401). Throws `CredentialUnavailableError` on failure. */
  refreshNow(credential: CredentialRuntime, providerType: string): Promise<ResolvedAuth> {
    return this.resolve(credential, providerType, true);
  }

  #refresh(
    credential: CredentialRuntime,
    providerType: string,
    current: OAuthTokens,
  ): Promise<OAuthTokens> {
    const existing = this.#inflight.get(credential.id);
    if (existing) return existing;

    const run = async (): Promise<OAuthTokens> => {
      const oauth = this.#adapters[providerType]?.oauth;
      if (!oauth)
        throw new CredentialUnavailableError(
          `provider type "${providerType}" has no OAuth support`,
          false,
        );
      if (!current.refreshToken) {
        this.#registry.markDead(
          credential.id,
          "access token expired and no refresh token is stored",
        );
        throw new CredentialUnavailableError(
          "access token expired and no refresh token is stored",
          true,
        );
      }
      try {
        const next = await oauth.refresh(current);
        this.#registry.saveTokens(credential.id, next);
        return next;
      } catch (error) {
        const terminal = error instanceof OAuthRefreshError && error.terminal;
        const message = (error as Error).message;
        this.#log.warn("oauth refresh failed", {
          credential: credential.id,
          terminal,
          error: message,
        });
        if (terminal)
          this.#registry.markDead(credential.id, `re-authorisation required: ${message}`);
        throw new CredentialUnavailableError(message, terminal, { cause: error });
      }
    };

    const promise = run().finally(() => this.#inflight.delete(credential.id));
    this.#inflight.set(credential.id, promise);
    return promise;
  }
}
