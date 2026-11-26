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
  REFRESH_SCOPES,
  REFRESH_URL,
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
 * Token endpoint failure; `code` and `description` are the OAuth `error` and `error_description`. The answer
 * body is never kept in the message: it carries grant details.
 */
class TokenEndpointError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly description: string | undefined;

  constructor(status: number, code: string | undefined, description: string | undefined) {
    super(`Anthropic token request failed: ${status}${code ? ` (${code})` : ""}`);
    this.status = status;
    this.code = code;
    this.description = description;
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
    url: string,
    body: Record<string, string>,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const res = await doFetch(url, {
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
    if (!res.ok) {
      const description = isRecord(payload) ? payload.error_description : undefined;
      throw new TokenEndpointError(
        res.status,
        errorCode(payload),
        typeof description === "string" ? description : undefined,
      );
    }
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
          // A redirect must never carry the bearer to another host (opencodex bfdb2bc43).
          redirect: "error",
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
      const payload = await postToken(TOKEN_URL, {
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
      const { refreshToken } = tokens;
      if (!refreshToken) {
        throw new OAuthRefreshError("Anthropic account has no refresh token", true);
      }
      const exchange = (scope: string | undefined) =>
        postToken(
          REFRESH_URL,
          {
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: refreshToken,
            ...(scope === undefined ? {} : { scope }),
          },
          // Claude Code renews through axios, whose defaults supply these (omp 19.2.1); the code exchange sends neither.
          { accept: "application/json, text/plain, */*", "user-agent": REFRESH_USER_AGENT },
        );
      let payload: Record<string, unknown>;
      try {
        try {
          payload = await exchange(REFRESH_SCOPES);
        } catch (error) {
          // A grant issued before a requested scope existed is refused whole; omitting `scope` reissues the
          // scopes it already holds (RFC 6749 §6, as omp does).
          if (
            !(
              error instanceof TokenEndpointError &&
              error.status === 400 &&
              error.code === "invalid_scope"
            )
          )
            throw error;
          payload = await exchange(undefined);
        }
      } catch (error) {
        // omp's `dead-grant "invalid_grant" except-description="account_on_hold"`: Claude Code ends a login only
        // when the endpoint refuses the grant itself (RFC 6749: a grant with 400, a client with 401), and a held
        // account can appeal. Every other failure (outage, rate limit, another code, a bare 401) keeps the grant.
        const terminal =
          error instanceof TokenEndpointError &&
          (error.status === 400 || error.status === 401) &&
          error.code === "invalid_grant" &&
          error.description !== "account_on_hold";
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
