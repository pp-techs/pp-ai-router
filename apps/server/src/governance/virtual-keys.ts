import { randomUUID } from "node:crypto";
import { all, one, type Db } from "../db/database.ts";
import { generateVirtualKey, hashKey } from "../crypto.ts";
import { matchesAny } from "../glob.ts";
import { toLimit, type Limit, type LimitMode, type Metric } from "./limits.ts";

export interface VirtualKey {
  id: string;
  name: string;
  prefix: string;
  allowedModels: string[] | null;
  expiresAt: number | null;
  enabled: boolean;
  createdAt: number;
}

interface KeyRow {
  id: string;
  name: string;
  key_prefix: string;
  allowed_models: string | null;
  expires_at: number | null;
  enabled: number;
  created_at: number;
}

const toKey = (r: KeyRow): VirtualKey => ({
  id: r.id,
  name: r.name,
  prefix: r.key_prefix,
  allowedModels: r.allowed_models === null ? null : (JSON.parse(r.allowed_models) as string[]),
  expiresAt: r.expires_at,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
});

export interface NewKey {
  name: string;
  allowedModels?: string[] | null | undefined;
  expiresAt?: number | null | undefined;
}

export interface NewLimit {
  metric: Metric;
  windowSec: number | null;
  mode: LimitMode;
  max: number;
}

export class VirtualKeyStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Returns the plaintext once; only its hash is stored. */
  create(input: NewKey, now: number): { key: VirtualKey; plaintext: string } {
    const { plaintext, hash, prefix } = generateVirtualKey();
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO virtual_keys (id, name, key_hash, key_prefix, allowed_models, expires_at, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        input.name,
        hash,
        prefix,
        input.allowedModels ? JSON.stringify(input.allowedModels) : null,
        input.expiresAt ?? null,
        now,
      );
    return { key: this.get(id)!, plaintext };
  }

  /** The key behind a presented secret if it exists, is enabled and has not expired. */
  authenticate(plaintext: string, now: number): VirtualKey | null {
    const row = one<KeyRow>(
      this.#db.prepare("SELECT * FROM virtual_keys WHERE key_hash = ?"),
      hashKey(plaintext),
    );
    if (!row || row.enabled !== 1) return null;
    if (row.expires_at !== null && row.expires_at <= now) return null;
    return toKey(row);
  }

  get(id: string): VirtualKey | undefined {
    const row = one<KeyRow>(this.#db.prepare("SELECT * FROM virtual_keys WHERE id = ?"), id);
    return row && toKey(row);
  }

  list(): VirtualKey[] {
    return all<KeyRow>(this.#db.prepare("SELECT * FROM virtual_keys ORDER BY created_at DESC")).map(
      toKey,
    );
  }

  update(
    id: string,
    patch: Partial<Pick<VirtualKey, "name" | "allowedModels" | "expiresAt" | "enabled">>,
  ): VirtualKey | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.#db
      .prepare(
        "UPDATE virtual_keys SET name = ?, allowed_models = ?, expires_at = ?, enabled = ? WHERE id = ?",
      )
      .run(
        next.name,
        next.allowedModels ? JSON.stringify(next.allowedModels) : null,
        next.expiresAt,
        next.enabled ? 1 : 0,
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.#db.prepare("DELETE FROM virtual_keys WHERE id = ?").run(id).changes > 0;
  }

  addLimit(keyId: string, input: NewLimit, now: number): Limit {
    const id = randomUUID();
    this.#db
      .prepare(
        "INSERT INTO limits (id, key_id, metric, window_sec, mode, max_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, keyId, input.metric, input.windowSec, input.mode, input.max, now);
    return toLimit(one(this.#db.prepare("SELECT * FROM limits WHERE id = ?"), id)!);
  }

  deleteLimit(id: string): boolean {
    return this.#db.prepare("DELETE FROM limits WHERE id = ?").run(id).changes > 0;
  }
}

export function isModelAllowed(key: VirtualKey, model: string): boolean {
  return key.allowedModels === null || matchesAny(key.allowedModels, model);
}
