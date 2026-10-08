import { randomUUID } from "node:crypto";
import type { SecretBox } from "./crypto.ts";
import type { Db } from "./db/database.ts";
import type { CredentialAuth, OAuthTokens } from "./oauth/types.ts";

/** `secret_enc` holds the raw key for api_key credentials and a JSON document for oauth ones. */
export function sealAuth(box: SecretBox, auth: CredentialAuth): string {
  return box.seal(auth.type === "api_key" ? auth.key : JSON.stringify(auth.tokens));
}

export function openAuth(box: SecretBox, kind: string, sealed: string): CredentialAuth {
  const plain = box.open(sealed);
  return kind === "oauth"
    ? { type: "oauth", tokens: JSON.parse(plain) as OAuthTokens }
    : { type: "api_key", key: plain };
}

export interface NewCredential {
  providerId: string;
  label: string;
  auth: CredentialAuth;
  weight?: number;
  priority?: number;
  models?: string[] | null;
  rpmLimit?: number | null;
  enabled?: boolean;
}

/** Inserts a credential row and returns its id. The caller reloads the registry. */
export function insertCredential(db: Db, box: SecretBox, c: NewCredential, now: number): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO credentials (id, provider_id, label, kind, secret_enc, weight, priority, models, rpm_limit, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    c.providerId,
    c.label,
    c.auth.type,
    sealAuth(box, c.auth),
    c.weight ?? 1,
    c.priority ?? 0,
    c.models ? JSON.stringify(c.models) : null,
    c.rpmLimit ?? null,
    c.enabled === false ? 0 : 1,
    now,
  );
  return id;
}
