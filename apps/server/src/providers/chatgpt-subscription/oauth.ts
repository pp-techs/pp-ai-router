// Adapted from can1357/oh-my-pi (MIT): packages/ai registry/oauth/openai-codex.ts and the resolved
// catalog rule compat/rules/auth/openai-codex.kdl (authorize params, form-encoded token/refresh bodies,
// 15 s timeout), registry/engine/refresh.ts and error/flags.ts (refresh failure classification).
import { randomBytes } from "node:crypto";
import { generatePkce, parseCallbackInput } from "../../oauth/paste.ts";
import { OAuthRefreshError, type OAuthProvider, type OAuthTokens } from "../../oauth/types.ts";
import { isRecord } from "../anthropic/json.ts";
import {
  ACCOUNT_ID_KEY,
  AUTHORIZE_URL,
  CLIENT_ID,
  LOGIN_TTL_MS,
  ORIGINATOR,
  PLAN_KEY,
  REDIRECT_URI,
  REQUEST_TIMEOUT_MS,
  SCOPES,
  TOKEN_URL,
} from "./constants.ts";
import { readIdentity } from "./jwt.ts";

export interface OAuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/** Server-side state of one pending paste login. */
export interface LoginState {
  state: string;
  verifier: string;
}

/**
 * omp's `isOAuthExpiry`, applied to `<status> <body>`: the grant is definitively dead on an
 * `invalid_grant`/`invalid_token`/`unauthorized_client`/revoked/"refresh token ... expired" answer, or on a
 * 401 unless the text also reads like a passing outage (timeouts, 408/425/429/5xx, rate limits, forbidden...).
 */
const DEFINITIVE_FAILURE =
  /invalid_grant|invalid_token|unauthorized_client|\brevoked\b|refresh[\s_]?token.*expired/i;
const TRANSIENT_FAILURE =
  /timeout|network|fetch failed|ECONN(?:REFUSED|RESET)|ETIMEDOUT|ETIMEOUT|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|FailedToOpenSocket|EAI_AGAIN|socket hang up|\b(?:408|425|429|5\d{2})\b|rate.?limit|too many requests|temporar|unavailable|forbidden|permission_denied|cloudflare|captcha/i;
const AUTH_STATUS = /\b401\b/;

function isDefinitiveFailure(message: string): boolean {
  if (DEFINITIVE_FAILURE.test(message)) return true;
  return AUTH_STATUS.test(message) && !TRANSIENT_FAILURE.test(message);
}

/** A token endpoint value (string, number, or `{code, message}`) as one line (omp `describeTokenEndpointValue`). */
function describe(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!isRecord(value)) return undefined;
  const code = describe(value.code ?? value.error);
  const message = describe(value.message ?? value.error_description ?? value.description);
  if (code && message && code !== message) return `${code}: ${message}`;
  return code ?? message ?? JSON.stringify(value);
}

/** `<status> <error>: <description>` of a failed token request (omp `formatOpenAICodexTokenEndpointError`). */
function formatFailure(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return `${status}`;
  try {
    const body: unknown = JSON.parse(trimmed);
    if (!isRecord(body)) return `${status} ${trimmed}`;
    const error = describe(body.error);
    const description = describe(body.error_description);
    if (error && description && error !== description) return `${status} ${error}: ${description}`;
    return `${status} ${error ?? description ?? describe(body.message) ?? trimmed}`;
  } catch {
    return `${status} ${trimmed}`;
  }
}

/** The token endpoint refused; `definitive` is omp's verdict that the grant itself is dead. */
class TokenEndpointError extends Error {
  readonly definitive: boolean;

  constructor(what: string, status: number, bodyText: string) {
    super(`ChatGPT ${what} failed: ${formatFailure(status, bodyText)}`);
    this.definitive = isDefinitiveFailure(`${status} ${bodyText.slice(0, 500)}`);
  }
}

export function createChatgptSubscriptionOAuth(deps: OAuthDeps = {}): OAuthProvider<LoginState> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  async function postToken(
    what: "token exchange" | "token refresh",
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new TokenEndpointError(what, res.status, await res.text().catch(() => ""));
    const payload: unknown = await res.json().catch(() => undefined);
    if (!isRecord(payload)) throw new Error("ChatGPT token response was not a JSON object");
    return payload;
  }

  /**
   * Tokens (and the identity their claims carry) from a token response. A login needs all of access
   * token, refresh token and lifetime; a refresh keeps the stored refresh token when none is rotated, the
   * stored email/workspace when the claims omit them, and the plan it was given at login.
   */
  function tokensFromPayload(
    payload: Record<string, unknown>,
    previous: OAuthTokens | null,
  ): OAuthTokens {
    const {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      id_token: idToken,
    } = payload;
    if (typeof accessToken !== "string" || !accessToken)
      throw new Error("ChatGPT token response did not include an access token");
    const refresh =
      typeof refreshToken === "string" && refreshToken ? refreshToken : previous?.refreshToken;
    if (!refresh) throw new Error("ChatGPT token response did not include a refresh token");
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn))
      throw new Error("ChatGPT token response did not include expires_in");

    const identity = readIdentity(accessToken, typeof idToken === "string" ? idToken : undefined);
    if (!previous && !identity.accountId && !identity.email) {
      throw new Error("Could not read the account identity from the ChatGPT tokens");
    }
    const extra = { ...previous?.extra };
    if (identity.accountId) extra[ACCOUNT_ID_KEY] = identity.accountId;
    if (!previous && identity.plan) extra[PLAN_KEY] = identity.plan;
    return {
      accessToken,
      refreshToken: refresh,
      expiresAt: now() + expiresIn * 1000,
      account: identity.email ?? previous?.account ?? identity.accountId,
      extra,
    };
  }

  return {
    label: "Sign in with ChatGPT (Codex)",

    start() {
      const pkce = generatePkce();
      const state = randomBytes(16).toString("hex");
      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        state,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: ORIGINATOR,
      });
      return Promise.resolve({
        info: {
          flow: "paste" as const,
          authUrl: `${AUTHORIZE_URL}?${params.toString()}`,
          instructions:
            "Open the link and sign in to ChatGPT. The browser will then land on a page at localhost:1455 that fails to load: that is expected. Copy the full URL from the address bar (or just the code) and paste it here.",
          expiresAt: now() + LOGIN_TTL_MS,
        },
        state: { state, verifier: pkce.verifier },
      });
    },

    async complete(session, input) {
      const parsed = parseCallbackInput(input);
      if (parsed.error) throw new Error(`ChatGPT sign-in was not completed: ${parsed.error}`);
      if (!parsed.code) throw new Error("No authorization code found in the pasted text");
      // A URL/query is an authorization response and must carry the state; only a bare code may omit it.
      if ((parsed.kind !== "raw" || parsed.state !== undefined) && parsed.state !== session.state) {
        throw new Error("OAuth state mismatch: paste the URL from the sign-in you just started");
      }
      const payload = await postToken("token exchange", {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: parsed.code,
        code_verifier: session.verifier,
        redirect_uri: REDIRECT_URI,
      });
      return tokensFromPayload(payload, null);
    },

    async refresh(tokens) {
      if (!tokens.refreshToken) {
        throw new OAuthRefreshError("ChatGPT account has no refresh token", true);
      }
      let payload: Record<string, unknown>;
      try {
        payload = await postToken("token refresh", {
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: tokens.refreshToken,
        });
      } catch (error) {
        const terminal = error instanceof TokenEndpointError && error.definitive;
        throw new OAuthRefreshError((error as Error).message, terminal, { cause: error });
      }
      try {
        return tokensFromPayload(payload, tokens);
      } catch (error) {
        throw new OAuthRefreshError((error as Error).message, false, { cause: error });
      }
    },
  };
}
