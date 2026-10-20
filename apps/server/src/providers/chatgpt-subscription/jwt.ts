// Adapted from can1357/oh-my-pi (MIT): packages/ai registry/oauth/openai-codex.ts (getTokenProfile),
// packages/catalog wire/codex.ts (getCodexAccountId, getCodexResidency).
import { isRecord } from "../anthropic/json.ts";
import { JWT_AUTH_CLAIM, JWT_PROFILE_CLAIM } from "./constants.ts";

/** The payload of a JWT, unverified: the router only reads identity labels from tokens it just received. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** What the tokens say about the signed-in ChatGPT workspace. */
export interface TokenIdentity {
  accountId?: string | undefined;
  email?: string | undefined;
  plan?: string | undefined;
}

/**
 * Per claim, the access token wins over the id token. The workspace id is
 * `https://api.openai.com/auth`.`chatgpt_account_id`; the email is `https://api.openai.com/profile`.`email`;
 * the plan name is `https://api.openai.com/auth`.`chatgpt_plan_type`, which may only be present on the id
 * token. Nothing is read from the top level of the payload (omp does not).
 */
export function readIdentity(...tokens: (string | undefined)[]): TokenIdentity {
  const identity: TokenIdentity = {};
  for (const token of tokens) {
    const payload = token ? decodeJwtPayload(token) : undefined;
    if (!payload) continue;
    const auth = isRecord(payload[JWT_AUTH_CLAIM]) ? payload[JWT_AUTH_CLAIM] : {};
    const profile = isRecord(payload[JWT_PROFILE_CLAIM]) ? payload[JWT_PROFILE_CLAIM] : {};
    identity.accountId ??= text(auth.chatgpt_account_id);
    identity.email ??= text(profile.email)?.toLowerCase();
    identity.plan ??= text(auth.chatgpt_plan_type)?.toLowerCase();
  }
  return identity;
}

/**
 * The data residency of a region-pinned enterprise workspace. Such a workspace answers 401 "Workspace is
 * not authorized in this region" unless the client declares it; the access token already carries it
 * (`chatgpt_data_residency`, else `chatgpt_compute_residency`).
 */
export function readResidency(accessToken: string): string | undefined {
  const auth = decodeJwtPayload(accessToken)?.[JWT_AUTH_CLAIM];
  if (!isRecord(auth)) return undefined;
  return text(auth.chatgpt_data_residency) ?? text(auth.chatgpt_compute_residency);
}
