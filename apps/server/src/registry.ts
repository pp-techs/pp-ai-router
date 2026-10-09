import { openAuth, sealAuth } from "./credentials.ts";
import type { SecretBox } from "./crypto.ts";
import { all, type Db } from "./db/database.ts";
import type { CredentialAuth, OAuthTokens } from "./oauth/types.ts";
import { createSelector, type KeySelector, type Strategy } from "./pool/selectors.ts";

export interface CredentialRuntime {
  id: string;
  providerId: string;
  label: string;
  kind: string;
  auth: CredentialAuth;
  weight: number;
  priority: number;
  models: string[] | null;
  rpmLimit: number | null;
  enabled: boolean;
  status: "active" | "dead";
  lastError: string | null;
}

export interface ProviderRuntime {
  id: string;
  type: string;
  baseUrl: string;
  strategy: Strategy;
  stickyTtlMs: number;
  maxKeyAttempts: number;
  enabled: boolean;
  selector: KeySelector;
  credentials: CredentialRuntime[];
}

export interface Target {
  provider: string;
  model: string;
}

interface ProviderRow {
  id: string;
  type: string;
  base_url: string;
  key_strategy: Strategy;
  sticky_ttl_sec: number;
  max_key_attempts: number;
  enabled: number;
}

interface CredentialRow {
  id: string;
  provider_id: string;
  label: string;
  kind: string;
  secret_enc: string;
  weight: number;
  priority: number;
  models: string | null;
  rpm_limit: number | null;
  enabled: number;
  status: "active" | "dead";
  last_error: string | null;
}

/**
 * In-memory snapshot of providers, credentials (secrets decrypted), aliases and switched-off models. Admin writes call
 * `reload()`; selector instances survive a reload while their strategy is unchanged so round-robin
 * position and weights are not reset.
 */
export class Registry {
  readonly #db: Db;
  readonly #box: SecretBox;
  #providers = new Map<string, ProviderRuntime>();
  #aliases = new Map<string, Target[]>();
  /** `provider/model` of every disabled model (provider ids never contain `/`, so the key is unambiguous). */
  #disabled = new Set<string>();
  readonly #selectors = new Map<string, { strategy: Strategy; selector: KeySelector }>();

  constructor(db: Db, box: SecretBox) {
    this.#db = db;
    this.#box = box;
    this.reload();
  }

  reload(): void {
    const credentials = new Map<string, CredentialRuntime[]>();
    for (const r of all<CredentialRow>(
      this.#db.prepare("SELECT * FROM credentials ORDER BY created_at, rowid"),
    )) {
      const list = credentials.get(r.provider_id) ?? [];
      list.push({
        id: r.id,
        providerId: r.provider_id,
        label: r.label,
        kind: r.kind,
        auth: openAuth(this.#box, r.kind, r.secret_enc),
        weight: r.weight,
        priority: r.priority,
        models: r.models === null ? null : (JSON.parse(r.models) as string[]),
        rpmLimit: r.rpm_limit,
        enabled: r.enabled === 1,
        status: r.status,
        lastError: r.last_error,
      });
      credentials.set(r.provider_id, list);
    }

    const providers = new Map<string, ProviderRuntime>();
    for (const r of all<ProviderRow>(this.#db.prepare("SELECT * FROM providers ORDER BY id"))) {
      let entry = this.#selectors.get(r.id);
      if (!entry || entry.strategy !== r.key_strategy) {
        entry = { strategy: r.key_strategy, selector: createSelector(r.key_strategy) };
        this.#selectors.set(r.id, entry);
      }
      providers.set(r.id, {
        id: r.id,
        type: r.type,
        baseUrl: r.base_url,
        strategy: r.key_strategy,
        stickyTtlMs: r.sticky_ttl_sec * 1000,
        maxKeyAttempts: r.max_key_attempts,
        enabled: r.enabled === 1,
        selector: entry.selector,
        credentials: credentials.get(r.id) ?? [],
      });
    }
    for (const id of this.#selectors.keys()) if (!providers.has(id)) this.#selectors.delete(id);

    const aliases = new Map<string, Target[]>();
    for (const r of all<{ alias: string; targets: string }>(
      this.#db.prepare("SELECT alias, targets FROM model_aliases"),
    )) {
      aliases.set(r.alias, JSON.parse(r.targets) as Target[]);
    }
    const disabled = new Set<string>();
    for (const r of all<{ provider_id: string; model_id: string }>(
      this.#db.prepare("SELECT provider_id, model_id FROM disabled_models"),
    )) {
      disabled.add(`${r.provider_id}/${r.model_id}`);
    }
    this.#providers = providers;
    this.#aliases = aliases;
    this.#disabled = disabled;
  }

  provider(id: string): ProviderRuntime | undefined {
    return this.#providers.get(id);
  }

  providers(): ProviderRuntime[] {
    return [...this.#providers.values()];
  }

  aliasNames(): string[] {
    return [...this.#aliases.keys()];
  }

  /**
   * Ordered upstream targets for a client-facing model name: an alias expands to its target list;
   * `provider/model` addresses one provider directly. Targets whose model is switched off are left
   * out. Empty when nothing matches.
   */
  resolve(model: string): Target[] {
    return this.#route(model).filter((t) => !this.isModelDisabled(t.provider, t.model));
  }

  /** True when `model` routes somewhere but every target of it is switched off. */
  isDisabled(model: string): boolean {
    const routes = this.#route(model);
    return routes.length > 0 && routes.every((t) => this.isModelDisabled(t.provider, t.model));
  }

  isModelDisabled(provider: string, model: string): boolean {
    return this.#disabled.has(`${provider}/${model}`);
  }

  #route(model: string): Target[] {
    const alias = this.#aliases.get(model);
    if (alias) return alias.filter((t) => this.#providers.has(t.provider));
    const slash = model.indexOf("/");
    if (slash > 0) {
      const provider = model.slice(0, slash);
      if (this.#providers.has(provider)) return [{ provider, model: model.slice(slash + 1) }];
    }
    return [];
  }

  /** Persists a terminal credential failure (e.g. revoked key) so it stays out of rotation across restarts. */
  markDead(credentialId: string, reason: string): void {
    this.#db
      .prepare("UPDATE credentials SET status = 'dead', last_error = ? WHERE id = ?")
      .run(reason, credentialId);
    this.reload();
  }

  /** Persists refreshed OAuth tokens (encrypted) and republishes the snapshot. */
  saveTokens(credentialId: string, tokens: OAuthTokens): void {
    this.#db
      .prepare("UPDATE credentials SET secret_enc = ? WHERE id = ? AND kind = 'oauth'")
      .run(sealAuth(this.#box, { type: "oauth", tokens }), credentialId);
    this.reload();
  }
}
