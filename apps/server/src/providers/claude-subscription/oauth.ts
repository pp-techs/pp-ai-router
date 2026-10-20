// Adapted from can1357/oh-my-pi (MIT) and lidge-jun/opencodex (MIT): omp registry/oauth/anthropic.ts,
// rules/auth/anthropic.kdl, registry/engine/{common,oauth-code,refresh}.ts, error/flags.ts (refresh classification);
// opencodex src/oauth/anthropic.ts (paste-login shape).
import { randomBytes } from "node:crypto";
import { generatePkce, parseCallbackInput } from "../../oauth/paste.ts";
import { OAuthRefreshError, type OAuthProvider, type OAuthTokens } from "../../oauth/types.ts";
import { isRecord } from "../anthropic/json.ts";
import {
  ACCOUNT_UUID_KEY,
  AUTHORIZE_URL,
  BOOTSTRAP_MODEL,
  BOOTSTRAP_URL,
  CLIENT_ID,
  EXPIRY_SKEW_MS,
  LOGIN_TTL_MS,
  OAUTH_BETA,
  ORG_NAME_KEY,
  ORG_UUID_KEY,
  REDIRECT_URI,
  REFRESH_USER_AGENT,
  REQUEST_TIMEOUT_MS,
  SCOPES,
  TOKEN_URL,
} from "./constants.ts";
import { cliVersion } from "./identity.ts";

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
 * omp's `isOAuthExpiry` (error/flags.ts): a refresh failure whose text says the grant or the client is dead,
 * or a bare 401, as opposed to a passing outage. The text is the status and the start of the answer body.
 */
const DEFINITIVE_FAILURE =
  /invalid_grant|invalid_token|unauthorized_client|\brevoked\b|refresh[\s_]?token.*expired/i;
const TRANSIENT_FAILURE =
  /timeout|network|fetch failed|ECONN(?:REFUSED|RESET)|ETIMEDOUT|ETIMEOUT|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|FailedToOpenSocket|EAI_AGAIN|socket hang up|\b(?:408|425|429|5\d{2})\b|rate.?limit|too many requests|temporar|unavailable|forbidden|permission_denied|cloudflare|captcha/i;

/** Whether a refresh failure with this text means the stored grant is gone for good. */
const refusesForGood = (evidence: string) =>
  DEFINITIVE_FAILURE.test(evidence) ||
  (/\b401\b/.test(evidence) && !TRANSIENT_FAILURE.test(evidence));

/**
 * Token endpoint failure; `code` is the OAuth `error`. The answer body is classified but never kept in the
 * message: it carries grant details.
 */
class TokenEndpointError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** What `refusesForGood` reads: the status and the start of the answer body. */
  readonly evidence: string;

  constructor(status: number, code: string | undefined, body: string) {
    super(`Anthropic token request failed: ${status}${code ? ` (${code})` : ""}`);
    this.status = status;
    this.code = code;
    this.evidence = `anthropic token refresh failed: ${status} ${body.slice(0, 500)}`;
  }
}

/** `{"error":"invalid_grant"}` and `{"error":{"type":"invalid_grant"}}` both occur. */
function errorCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const { error } = body;
  if (typeof error === "string") return error;
  return isRecord(error) && typeof error.type === "string" ? error.type : undefined;
}

/** A non-empty string, or undefined. */
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** Who the bootstrap says the token belongs to. */
interface Identity {
  uuid?: string | undefined;
  email?: string | undefined;
  orgUuid?: string | undefined;
  orgName?: string | undefined;
}

/** Which identity fields a token response itself carried (the bootstrap fills the rest). */
interface NamedIdentity {
  account: boolean;
  email: boolean;
}

/** Tokens read from a token response, and what that response said about the account. */
interface PayloadTokens {
  tokens: OAuthTokens;
  named: NamedIdentity;
}

export function createClaudeSubscriptionOAuth(deps: OAuthDeps = {}): OAuthProvider<LoginState> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  async function postToken(
    body: Record<string, string>,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      // A redirect may follow a completed POST and a token rotation: it is an unknown outcome, not a refusal.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const answer = await res.text().catch(() => "");
    const payload: unknown = (() => {
      try {
        return JSON.parse(answer);
      } catch {
        return undefined;
      }
    })();
    if (!res.ok) throw new TokenEndpointError(res.status, errorCode(payload), answer);
    if (!isRecord(payload)) throw new Error("Anthropic token response was not a JSON object");
    return payload;
  }

  /**
   * The account and organization Claude Code's own bootstrap reports, for a token response that left
   * them out. Best effort: identity is a label, never a reason to fail a sign-in.
   */
  async function bootstrapIdentity(accessToken: string): Promise<Identity> {
    try {
      const res = await doFetch(
        `${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(BOOTSTRAP_MODEL)}`,
        {
          headers: {
            accept: "application/json, text/plain, */*",
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "user-agent": `claude-code/${cliVersion()}`,
            "anthropic-beta": OAUTH_BETA,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!res.ok) return {};
      const body: unknown = await res.json().catch(() => undefined);
      const found = isRecord(body) && isRecord(body.oauth_account) ? body.oauth_account : {};
      return {
        uuid: text(found.account_uuid),
        email: text(found.account_email),
        orgUuid: text(found.organization_uuid),
        orgName: text(found.organization_name),
      };
    } catch {
      return {};
    }
  }

  /**
   * Fills the identity a token response omitted from the bootstrap. The organization is the workspace
   * the token draws limits from and is fixed at sign-in; a refresh never rewrites it.
   */
  async function withIdentity(
    tokens: OAuthTokens,
    phase: "login" | "refresh",
    named: NamedIdentity,
  ): Promise<OAuthTokens> {
    const { extra } = tokens;
    const missingOrg = phase === "login" && !extra[ORG_UUID_KEY];
    if (named.account && named.email && !missingOrg) return tokens;
    const found = await bootstrapIdentity(tokens.accessToken);
    const filled = { ...extra };
    const uuid = extra[ACCOUNT_UUID_KEY] ?? found.uuid;
    if (uuid) filled[ACCOUNT_UUID_KEY] = uuid;
    if (phase === "login") {
      if (!filled[ORG_UUID_KEY] && found.orgUuid) filled[ORG_UUID_KEY] = found.orgUuid;
      if (!filled[ORG_NAME_KEY] && found.orgName) filled[ORG_NAME_KEY] = found.orgName;
    }
    return {
      ...tokens,
      account: named.email ? tokens.account : (found.email ?? tokens.account ?? uuid),
      extra: filled,
    };
  }

  /** What the token response says about the account; `named` tells which identity fields it carried. */
  function tokensFromPayload(
    payload: Record<string, unknown>,
    previous: OAuthTokens | null,
  ): PayloadTokens {
    const {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
    } = payload;
    if (typeof accessToken !== "string" || !accessToken)
      throw new Error("Anthropic token response did not include an access token");
    const refresh =
      typeof refreshToken === "string" && refreshToken ? refreshToken : previous?.refreshToken;
    if (!refresh) throw new Error("Anthropic token response did not include a refresh token");
    // omp has no fallback lifetime either: a response without one is not a usable token.
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn))
      throw new Error("Anthropic token response did not include expires_in");

    const account = isRecord(payload.account) ? payload.account : undefined;
    const uuid = text(account?.uuid);
    const email = text(account?.email_address);
    const extra = { ...previous?.extra };
    if (uuid) extra[ACCOUNT_UUID_KEY] = uuid;
    // The organization is fixed when the account signs in; a refresh carries it over untouched.
    if (!previous) {
      const org = isRecord(payload.organization) ? payload.organization : undefined;
      const orgUuid = text(org?.uuid);
      const orgName = text(org?.name);
      if (orgUuid) extra[ORG_UUID_KEY] = orgUuid;
      if (orgName) extra[ORG_NAME_KEY] = orgName;
    }
    return {
      tokens: {
        accessToken,
        refreshToken: refresh,
        expiresAt: now() + expiresIn * 1000 - EXPIRY_SKEW_MS,
        account: email ?? previous?.account ?? uuid,
        extra,
      },
      named: { account: uuid !== undefined, email: email !== undefined },
    };
  }

  return {
    label: "Sign in with Claude (Pro/Max)",

    start() {
      const pkce = generatePkce();
      const state = randomBytes(16).toString("hex");
      const params = new URLSearchParams({
        code: "true",
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        state,
      });
      return Promise.resolve({
        info: {
          flow: "paste" as const,
          authUrl: `${AUTHORIZE_URL}?${params.toString()}`,
          instructions:
            "Open the link and sign in to Claude. The browser will then land on a page at localhost:54545 that fails to load: that is expected. Copy the full URL from the address bar (or just the code) and paste it here.",
          expiresAt: now() + LOGIN_TTL_MS,
        },
        state: { state, verifier: pkce.verifier },
      });
    },

    async complete(session, input) {
      const parsed = parseCallbackInput(input);
      if (parsed.error) throw new Error(`Claude sign-in was not completed: ${parsed.error}`);
      if (!parsed.code) throw new Error("No authorization code found in the pasted text");
      // A URL/query is an authorization response and must carry the state; only a bare code may omit it.
      if ((parsed.kind !== "raw" || parsed.state !== undefined) && parsed.state !== session.state) {
        throw new Error("OAuth state mismatch: paste the URL from the sign-in you just started");
      }
      const payload = await postToken({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: parsed.code,
        state: session.state,
        redirect_uri: REDIRECT_URI,
        code_verifier: session.verifier,
      });
      const { tokens, named } = tokensFromPayload(payload, null);
      return withIdentity(tokens, "login", named);
    },

    async refresh(tokens) {
      if (!tokens.refreshToken) {
        throw new OAuthRefreshError("Anthropic account has no refresh token", true);
      }
      let payload: Record<string, unknown>;
      try {
        payload = await postToken(
          {
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: tokens.refreshToken,
          },
          // The SDK sends these on a refresh but not on the code exchange.
          { "anthropic-beta": OAUTH_BETA, "user-agent": REFRESH_USER_AGENT },
        );
      } catch (error) {
        const terminal = error instanceof TokenEndpointError && refusesForGood(error.evidence);
        throw new OAuthRefreshError((error as Error).message, terminal, { cause: error });
      }
      let refreshed: PayloadTokens;
      try {
        refreshed = tokensFromPayload(payload, tokens);
      } catch (error) {
        throw new OAuthRefreshError((error as Error).message, false, { cause: error });
      }
      return withIdentity(refreshed.tokens, "refresh", refreshed.named);
    },
  };
}
