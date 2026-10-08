// Adapted from lidge-jun/opencodex (MIT)
import { createHash, randomBytes } from "node:crypto";
import { OAuthRefreshError, type OAuthProvider, type OAuthTokens } from "../../oauth/types.ts";
import { isRecord } from "./json.ts";
import {
  API_VERSION,
  AUTH_ENDPOINT,
  CLIENT_ID,
  CLIENT_SECRET,
  DAILY_API,
  IDE_VERSION,
  LOGIN_TTL_MS,
  ONBOARD_ATTEMPTS,
  ONBOARD_POLL_MS,
  PROD_API,
  PROJECT_KEY,
  REDIRECT_URI,
  REQUEST_TIMEOUT_MS,
  SCOPES,
  TOKEN_ENDPOINT,
  USER_AGENT,
} from "./constants.ts";

export interface OAuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Server-side state of one pending paste login. */
export interface LoginState {
  state: string;
  verifier: string;
}

type Json = Record<string, unknown>;

const timeout = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** RFC 7636 S256 pair. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(96).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface ParsedCallback {
  kind: "url" | "query" | "raw";
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}

/**
 * Reads what the admin pasted: the full redirect URL, its query string, or a bare `code` /
 * `code#state`. `kind` records the shape so the caller can insist on `state` for anything that is an
 * authorization response. For a URL the query wins as a whole; the fragment is only consulted when
 * the query has no `code`, and the two are never mixed.
 */
export function parseCallbackInput(input: string): ParsedCallback {
  const value = input.trim();
  if (!value) return { kind: "raw" };
  const fromParams = (kind: "url" | "query", params: URLSearchParams): ParsedCallback => ({
    kind,
    code: params.get("code") ?? undefined,
    state: params.get("state") ?? undefined,
    error: params.get("error") ?? undefined,
  });
  try {
    const url = new URL(value);
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    const source =
      url.searchParams.has("code") || url.searchParams.has("error") ? url.searchParams : fragment;
    return fromParams("url", source);
  } catch {
    // not a URL
  }
  if (value.includes("code=") || value.includes("error=")) {
    return fromParams("query", new URLSearchParams(value.replace(/^[?#]/, "")));
  }
  const hash = value.indexOf("#");
  return hash < 0
    ? { kind: "raw", code: value }
    : { kind: "raw", code: value.slice(0, hash), state: value.slice(hash + 1) || undefined };
}

function decodeJwtPayload(token: string): Json | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function emailFromToken(accessToken: string, idToken: string | undefined): string | undefined {
  const payload =
    (idToken ? decodeJwtPayload(idToken) : undefined) ?? decodeJwtPayload(accessToken);
  const email = payload?.email;
  return typeof email === "string" && email.length > 0 ? email.toLowerCase() : undefined;
}

/** Pull a Cloud Code Assist project id out of a loadCodeAssist/onboardUser response shape. */
function extractProjectId(data: Json): string | undefined {
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (isRecord(value) && typeof value.id === "string") return value.id;
  }
  return undefined;
}

/** Token endpoint failure; `code` is Google's `error` field (`invalid_grant`, ...). Bodies are never kept: they carry grant details. */
class TokenEndpointError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined) {
    super(`Antigravity token request failed: ${status}${code ? ` (${code})` : ""}`);
    this.status = status;
    this.code = code;
  }
}

/** Codes meaning the refresh token / client itself is no longer valid, as opposed to a passing outage. */
const TERMINAL_TOKEN_ERRORS: Record<string, true> = {
  invalid_grant: true,
  invalid_client: true,
  unauthorized_client: true,
};

export function createAntigravityOAuth(deps: OAuthDeps = {}): OAuthProvider<LoginState> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function postToken(body: Record<string, string>): Promise<Json> {
    const res = await doFetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: timeout(),
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => undefined);
      const error = isRecord(body) ? body.error : undefined;
      throw new TokenEndpointError(res.status, typeof error === "string" ? error : undefined);
    }
    const payload: unknown = await res.json().catch(() => undefined);
    if (!isRecord(payload)) throw new Error("Antigravity token response was not a JSON object");
    return payload;
  }

  const apiHeaders = (accessToken: string) => ({
    authorization: `Bearer ${accessToken}`,
    accept: "*/*",
    "content-type": "application/json",
    "user-agent": USER_AGENT,
  });

  async function loadCodeAssistProject(accessToken: string): Promise<string | undefined> {
    const res = await doFetch(`${PROD_API}/${API_VERSION}:loadCodeAssist`, {
      method: "POST",
      headers: apiHeaders(accessToken),
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal: timeout(),
    });
    if (!res.ok) return undefined;
    const body: unknown = await res.json().catch(() => undefined);
    return isRecord(body) ? extractProjectId(body) : undefined;
  }

  async function onboardProject(accessToken: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt++) {
      const res = await doFetch(`${DAILY_API}/${API_VERSION}:onboardUser`, {
        method: "POST",
        headers: apiHeaders(accessToken),
        body: JSON.stringify({
          tier_id: "free-tier",
          metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity", ide_version: IDE_VERSION },
        }),
        signal: timeout(),
      });
      if (!res.ok) {
        // Transient (429/5xx): keep polling within the attempt budget. Hard 4xx: give up now.
        if (res.status === 429 || res.status >= 500) {
          await sleep(ONBOARD_POLL_MS);
          continue;
        }
        return undefined;
      }
      const data: unknown = await res.json().catch(() => undefined);
      if (isRecord(data) && data.done === true) {
        return isRecord(data.response) ? extractProjectId(data.response) : undefined;
      }
      await sleep(ONBOARD_POLL_MS);
    }
    return undefined;
  }

  /** loadCodeAssist, then onboardUser when the account has no project yet. */
  async function discoverProject(accessToken: string): Promise<string | undefined> {
    return (await loadCodeAssistProject(accessToken)) ?? (await onboardProject(accessToken));
  }

  function tokensFromPayload(
    payload: Json,
    refreshFallback: string | null,
  ): Omit<OAuthTokens, "extra"> {
    const accessToken = nonEmpty(payload.access_token);
    if (!accessToken) throw new Error("Antigravity token response did not include an access token");
    const refreshToken = nonEmpty(payload.refresh_token) ?? refreshFallback;
    if (!refreshToken)
      throw new Error("Antigravity token response did not include a refresh token");
    const expiresIn =
      typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3600;
    return {
      accessToken,
      refreshToken,
      expiresAt: now() + expiresIn * 1000,
      account: emailFromToken(accessToken, nonEmpty(payload.id_token)),
    };
  }

  return {
    label: "Sign in with Google Antigravity",

    start() {
      const pkce = generatePkce();
      const state = randomBytes(16).toString("hex");
      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES.join(" "),
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        access_type: "offline",
        // select_account lets the admin pick a different Google account when adding another one.
        prompt: "consent select_account",
        state,
      });
      return Promise.resolve({
        info: {
          flow: "paste" as const,
          authUrl: `${AUTH_ENDPOINT}?${params.toString()}`,
          instructions:
            "Open the link and sign in with Google. The browser will then land on a page at 127.0.0.1:51121 that fails to load: that is expected. Copy the full URL from the address bar (or just the code) and paste it here.",
          expiresAt: now() + LOGIN_TTL_MS,
        },
        state: { state, verifier: pkce.verifier },
      });
    },

    async complete(session, input) {
      const parsed = parseCallbackInput(input);
      if (parsed.error) throw new Error(`Google sign-in was not completed: ${parsed.error}`);
      if (!parsed.code) throw new Error("No authorization code found in the pasted text");
      // A URL/query is an authorization response and must carry the state; only a bare code may omit it.
      if ((parsed.kind !== "raw" || parsed.state !== undefined) && parsed.state !== session.state) {
        throw new Error("OAuth state mismatch: paste the URL from the sign-in you just started");
      }
      const payload = await postToken({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: parsed.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: session.verifier,
      });
      const tokens = tokensFromPayload(payload, null);
      const project = await discoverProject(tokens.accessToken);
      // Without a project every request would be rejected; fail the login instead of storing a dud account.
      if (!project) {
        throw new Error(
          "Could not discover a Cloud Code Assist project for this account. Make sure it has Antigravity / Cloud Code Assist access and try again.",
        );
      }
      return { ...tokens, extra: { [PROJECT_KEY]: project } };
    },

    async refresh(tokens) {
      if (!tokens.refreshToken) {
        throw new OAuthRefreshError("Antigravity account has no refresh token", true);
      }
      let payload: Json;
      try {
        payload = await postToken({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: tokens.refreshToken,
        });
      } catch (error) {
        const terminal =
          error instanceof TokenEndpointError &&
          (error.status === 400 || error.status === 401) &&
          error.code !== undefined &&
          Object.hasOwn(TERMINAL_TOKEN_ERRORS, error.code);
        throw new OAuthRefreshError((error as Error).message, terminal, { cause: error });
      }
      let refreshed: Omit<OAuthTokens, "extra">;
      try {
        refreshed = tokensFromPayload(payload, tokens.refreshToken);
      } catch (error) {
        throw new OAuthRefreshError((error as Error).message, false, { cause: error });
      }
      // Only an account that has no project yet re-runs discovery (it may have been onboarded meanwhile).
      const project =
        tokens.extra[PROJECT_KEY] ??
        (await discoverProject(refreshed.accessToken).catch(() => undefined));
      return {
        ...refreshed,
        account: refreshed.account ?? tokens.account,
        extra: project ? { ...tokens.extra, [PROJECT_KEY]: project } : { ...tokens.extra },
      };
    },
  };
}
