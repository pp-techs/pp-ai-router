import { randomUUID } from "node:crypto";
import type { SecretBox } from "../crypto.ts";
import type { Db } from "../db/database.ts";
import { insertCredential } from "../credentials.ts";
import type { ProviderAdapter } from "../providers/adapter.ts";
import type { Registry } from "../registry.ts";
import type { LoginStartInfo, OAuthProvider, OAuthTokens } from "./types.ts";

export interface LoginOptions {
  label?: string | undefined;
  weight?: number | undefined;
  priority?: number | undefined;
  models?: string[] | null | undefined;
  rpmLimit?: number | null | undefined;
}

export type SessionStatus =
  | { status: "pending" }
  | { status: "complete"; credentialId: string }
  | { status: "error"; error: string }
  | { status: "expired" };

interface Session {
  providerId: string;
  oauth: OAuthProvider<unknown>;
  state: unknown;
  info: LoginStartInfo;
  options: LoginOptions;
  result: SessionStatus;
  lastPollAt: number;
}

export class LoginError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_SESSIONS = 100;

/**
 * Server-side state for admin-driven OAuth logins. A finished login becomes a credential of the
 * provider that started it. Sessions live in memory only: an unfinished login dies with a restart.
 */
export class LoginSessions {
  readonly #db: Db;
  readonly #box: SecretBox;
  readonly #registry: Registry;
  readonly #adapters: Readonly<Record<string, ProviderAdapter>>;
  readonly #now: () => number;
  readonly #sessions = new Map<string, Session>();

  constructor(
    db: Db,
    box: SecretBox,
    registry: Registry,
    adapters: Readonly<Record<string, ProviderAdapter>>,
    now: () => number = Date.now,
  ) {
    this.#db = db;
    this.#box = box;
    this.#registry = registry;
    this.#adapters = adapters;
    this.#now = now;
  }

  async start(
    providerId: string,
    options: LoginOptions,
  ): Promise<{ id: string; info: LoginStartInfo }> {
    const provider = this.#registry.provider(providerId);
    if (!provider) throw new LoginError(404, "Provider not found.");
    const oauth = this.#adapters[provider.type]?.oauth;
    if (!oauth)
      throw new LoginError(400, `Provider type "${provider.type}" does not support OAuth login.`);

    this.#prune();
    if (this.#sessions.size >= MAX_SESSIONS) throw new LoginError(429, "Too many pending logins.");
    const { info, state } = await oauth.start();
    const id = randomUUID();
    this.#sessions.set(id, {
      providerId,
      oauth,
      state,
      info,
      options,
      result: { status: "pending" },
      lastPollAt: 0,
    });
    return { id, info };
  }

  /** Current state; device flows are polled here, at most once per provider-requested interval. */
  async status(id: string): Promise<SessionStatus & { info?: LoginStartInfo }> {
    const session = this.#get(id);
    if (session.result.status === "pending") {
      const now = this.#now();
      if (now >= session.info.expiresAt) {
        session.result = { status: "expired" };
      } else if (session.info.flow === "device" && session.oauth.poll) {
        if (now - session.lastPollAt >= session.info.intervalSec * 1000) {
          session.lastPollAt = now;
          try {
            const polled = await session.oauth.poll(session.state);
            if (polled.status === "complete") session.result = this.#finish(session, polled.tokens);
            else if (polled.status === "error")
              session.result = { status: "error", error: polled.message };
          } catch (error) {
            session.result = { status: "error", error: (error as Error).message };
          }
        }
      }
    }
    return session.result.status === "pending"
      ? { ...session.result, info: session.info }
      : session.result;
  }

  /** Finishes a `paste` flow with the redirect URL / code the user copied back. */
  async complete(id: string, input: string): Promise<SessionStatus> {
    const session = this.#get(id);
    if (session.result.status !== "pending") return session.result;
    if (session.info.flow !== "paste" || !session.oauth.complete)
      throw new LoginError(400, "This login does not accept pasted input.");
    if (this.#now() >= session.info.expiresAt) return (session.result = { status: "expired" });
    try {
      session.result = this.#finish(session, await session.oauth.complete(session.state, input));
    } catch (error) {
      // Keep the session pending: a mistyped paste should be retryable.
      throw new LoginError(400, (error as Error).message);
    }
    return session.result;
  }

  #finish(session: Session, tokens: OAuthTokens): SessionStatus {
    const { options } = session;
    const id = insertCredential(
      this.#db,
      this.#box,
      {
        providerId: session.providerId,
        label: options.label ?? tokens.account ?? `${session.providerId} account`,
        auth: { type: "oauth", tokens },
        ...(options.weight !== undefined && { weight: options.weight }),
        ...(options.priority !== undefined && { priority: options.priority }),
        ...(options.models !== undefined && { models: options.models }),
        ...(options.rpmLimit !== undefined && { rpmLimit: options.rpmLimit }),
      },
      this.#now(),
    );
    this.#registry.reload();
    return { status: "complete", credentialId: id };
  }

  #get(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new LoginError(404, "Login session not found (it may have expired).");
    return session;
  }

  #prune(): void {
    // Keep finished/expired sessions readable for an hour past expiry so a UI poll never races a prune.
    const cutoff = this.#now() - 3_600_000;
    for (const [id, s] of this.#sessions) if (s.info.expiresAt < cutoff) this.#sessions.delete(id);
  }
}
