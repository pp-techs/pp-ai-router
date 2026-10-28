// Adapted from can1357/oh-my-pi (MIT): packages/catalog (wire/codex.ts, compat/rules/auth/openai-codex.kdl),
// packages/ai (registry/oauth/openai-codex.ts, providers/openai-codex-responses.ts, usage/openai-codex-base-url.ts),
// packages/utils (dirs.ts: USER_AGENT).

/**
 * Every protocol constant of the ChatGPT sign-in and the Codex backend lives here. The OAuth client id
 * is the public identifier of the Codex CLI (not a user secret). The values are oh-my-pi's effective ones
 * at 9d5d4ac5b5 (the KDL auth rule and `wire/codex.ts` resolved), so a bump there is a bump here.
 */
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

/** Registered redirect of the Codex client. Nothing listens here on the router: the admin pastes the dead URL back. */
export const REDIRECT_URI = "http://localhost:1455/auth/callback";

/** Token endpoint timeout (omp `token ... timeout-ms=15000`). */
export const REQUEST_TIMEOUT_MS = 15_000;
export const LOGIN_TTL_MS = 10 * 60_000;

/** Keys of the provider-side identity inside `OAuthTokens.extra`. */
export const ACCOUNT_ID_KEY = "account_id";
export const PLAN_KEY = "plan";

/**
 * Default `base_url` of the provider (omp `CODEX_BASE_URL`). The Responses route is derived from it by
 * {@link resolveResponsesUrl}; the account endpoints (`wham/usage`) hang directly under it.
 */
export const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

/** JWT claim namespaces of the access and id tokens. */
export const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
export const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";

/**
 * The identity the requests present: omp's. The backend gates model availability on the version (a newer
 * model is simply missing for an older one), so it is pinned to omp's `CODEX_CLIENT_VERSION`.
 * `OMP_VERSION` is the `packages/utils` version omp reports in its `omp/<version>` user agent.
 */
export const ORIGINATOR = "omp";
export const CLIENT_VERSION = "0.159.0";
export const OPENAI_BETA = "responses=experimental";
export const OMP_VERSION = "18.13.2";
export const USER_AGENT = `omp/${OMP_VERSION}`;

/** `POST {base}/responses` for a base ending in `/codex`, `{base}/codex/responses` otherwise (omp `resolveCodexResponsesUrl`). */
export function resolveResponsesUrl(baseUrl: string): string {
  const raw = baseUrl.trim() || DEFAULT_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

/**
 * Base of the account endpoints (`wham/usage`; omp `normalizeCodexBaseUrl`). They live on the canonical
 * ChatGPT origin directly under `/backend-api` and are not part of the `/responses` surface a proxy
 * forwards, so any other host falls back to the default.
 */
export function accountApiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return DEFAULT_BASE_URL;
  }
  const host = parsed.host.toLowerCase();
  if (host !== "chatgpt.com" && host !== "chat.openai.com") return DEFAULT_BASE_URL;
  return `${parsed.origin}/backend-api`;
}
