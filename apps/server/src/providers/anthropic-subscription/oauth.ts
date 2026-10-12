// Adapted from lidge-jun/opencodex (MIT): src/oauth/anthropic.ts; scopes, refresh headers and the
// organization/bootstrap identity follow can1357/oh-my-pi (registry/oauth/anthropic.ts, rules/auth/anthropic.kdl).
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
 * Codes meaning the refresh token / client itself is no longer valid, as opposed to a passing outage:
 * the reference's revocation codes plus the RFC 6749 client failures.
 */
const TERMINAL_TOKEN_ERRORS: Record<string, true> = {
  invalid_grant: true,
  refresh_token_reused: true,
  revoked: true,
  revoked_token: true,
  refresh_token_revoked: true,
  invalid_client: true,
  unauthorized_client: true,
};

/** Token endpoint failure; `code` is the OAuth `error`. Bodies are never kept: they carry grant details. */
class TokenEndpointError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined) {
    super(`Anthropic token request failed: ${status}${code ? ` (${code})` : ""}`);
    this.status = status;
    this.code = code;
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

export function createAnthropicSubscriptionOAuth(deps: OAuthDeps = {}): OAuthProvider<LoginState> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  async function postToken(
    body: Record<string, string>,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      // A redirect may follow a completed POST and a token rotation: it is an unknown outcome, not a refusal.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const failure: unknown = await res.json().catch(() => undefined);
      throw new TokenEndpointError(res.status, errorCode(failure));
    }
    const payload: unknown = await res.json().catch(() => undefined);
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
        email: text(found.account_email)?.toLowerCase(),
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
  ): Promise<OAuthTokens> {
    const { extra } = tokens;
    const missingOrg = phase === "login" && !extra[ORG_UUID_KEY];
    if (extra[ACCOUNT_UUID_KEY] && tokens.account && !missingOrg) return tokens;
    const found = await bootstrapIdentity(tokens.accessToken);
    const filled = { ...extra };
    const uuid = extra[ACCOUNT_UUID_KEY] ?? found.uuid;
    if (uuid) filled[ACCOUNT_UUID_KEY] = uuid;
    if (phase === "login") {
      if (!filled[ORG_UUID_KEY] && found.orgUuid) filled[ORG_UUID_KEY] = found.orgUuid;
      if (!filled[ORG_NAME_KEY] && found.orgName) filled[ORG_NAME_KEY] = found.orgName;
    }
    return { ...tokens, account: tokens.account ?? found.email ?? uuid, extra: filled };
  }

  function tokensFromPayload(
    payload: Record<string, unknown>,
    previous: OAuthTokens | null,
  ): OAuthTokens {
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

    const account = isRecord(payload.account) ? payload.account : undefined;
    const uuid = text(account?.uuid);
    const email = text(account?.email_address)?.toLowerCase();
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
    // A missing, negative, non-finite or overflowing lifetime would never compare as expired: use an hour.
    const lifetimeSeconds =
      typeof expiresIn === "number" && expiresIn >= 0 && Number.isFinite(expiresIn * 1000)
        ? expiresIn
        : 3600;
    return {
      accessToken,
      refreshToken: refresh,
      expiresAt: now() + lifetimeSeconds * 1000,
      account: email ?? previous?.account ?? uuid,
      extra,
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
      return withIdentity(tokensFromPayload(payload, null), "login");
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
        const terminal =
          error instanceof TokenEndpointError &&
          (error.status === 400 || error.status === 401) &&
          error.code !== undefined &&
          Object.hasOwn(TERMINAL_TOKEN_ERRORS, error.code);
        throw new OAuthRefreshError((error as Error).message, terminal, { cause: error });
      }
      let refreshed: OAuthTokens;
      try {
        refreshed = tokensFromPayload(payload, tokens);
      } catch (error) {
        throw new OAuthRefreshError((error as Error).message, false, { cause: error });
      }
      return withIdentity(refreshed, "refresh");
    },
  };
}
