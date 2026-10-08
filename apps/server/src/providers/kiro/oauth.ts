// Adapted from lidge-jun/opencodex (MIT)
import {
  OAuthRefreshError,
  type LoginStartInfo,
  type OAuthProvider,
  type OAuthTokens,
  type PollResult,
} from "../../oauth/types.ts";
import { DEFAULT_REGION, normalizeRegion } from "./wire.ts";

/** AWS Builder ID device login runs against us-east-1 SSO OIDC; the account's regions are stored for later. */
const OIDC = "https://oidc.us-east-1.amazonaws.com";
const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const OIDC_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
];
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REQUEST_TIMEOUT_MS = 20_000;
const REFRESH_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 5_000;
const SLOW_DOWN_STEP_MS = 5_000;
const DEFAULT_DEVICE_LIFETIME_MS = 600_000;
/** No login outlives this, whatever the IdP says. */
const MAX_DEVICE_LIFETIME_MS = 15 * 60_000;
const DEFAULT_ACCESS_TOKEN_TTL_SEC = 3600;

const USER_CODE = /^[A-Za-z0-9-]{4,32}$/;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/** OAuth error codes after which retrying the refresh token cannot succeed. */
const TERMINAL_REFRESH_ERRORS: Record<string, true> = {
  invalid_grant: true,
  refresh_token_reused: true,
  revoked: true,
  revoked_token: true,
  refresh_token_revoked: true,
  access_denied: true,
  expired_token: true,
};

export interface KiroOAuthOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

interface DeviceState {
  clientId: string;
  clientSecret: string;
  deviceCode: string;
  intervalMs: number;
  nextPollAt: number;
}

interface Reply {
  status: number;
  data: Record<string, unknown>;
  /** `x-amzn-errortype` without its `:` suffix. */
  errorType: string;
}

const isRec = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** Client registration values must survive storage unchanged. */
const isStorable = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  value === value.trim() &&
  // oxlint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/.test(value);

function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || CONTROL.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Login (AWS Builder ID device grant) and refresh for Kiro accounts. `fetch`/`now` are injectable for tests. */
export function createKiroOAuth(options: KiroOAuthOptions = {}): OAuthProvider<DeviceState> {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  async function post(
    url: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Reply> {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data: unknown = {};
    try {
      data = await res.json();
    } catch {
      // A body that is not JSON carries no usable fields.
    }
    return {
      status: res.status,
      data: isRec(data) ? data : {},
      errorType: res.headers.get("x-amzn-errortype")?.split(":")[0] ?? "",
    };
  }

  async function start(): Promise<{ info: LoginStartInfo; state: DeviceState }> {
    const registration = await post(
      `${OIDC}/client/register`,
      { clientName: "kiro-cli", clientType: "public", scopes: OIDC_SCOPES },
      REQUEST_TIMEOUT_MS,
    );
    const { clientId, clientSecret } = registration.data;
    if (
      registration.status < 200 ||
      registration.status >= 300 ||
      !isStorable(clientId) ||
      !isStorable(clientSecret)
    )
      throw new Error(`Kiro client registration failed (HTTP ${registration.status})`);

    const auth = await post(
      `${OIDC}/device_authorization`,
      { clientId, clientSecret, startUrl: BUILDER_ID_START_URL },
      REQUEST_TIMEOUT_MS,
    );
    const { deviceCode, userCode, verificationUri, verificationUriComplete } = auth.data;
    if (
      auth.status < 200 ||
      auth.status >= 300 ||
      !isNonEmptyString(deviceCode) ||
      typeof userCode !== "string" ||
      !USER_CODE.test(userCode) ||
      !httpsUrl(verificationUri) ||
      (verificationUriComplete !== undefined && !httpsUrl(verificationUriComplete))
    )
      throw new Error(`Kiro device authorization failed (HTTP ${auth.status})`);

    const startedAt = now();
    const lifetimeMs = positive(auth.data.expiresIn)
      ? auth.data.expiresIn * 1000
      : DEFAULT_DEVICE_LIFETIME_MS;
    const intervalMs = Math.max(
      1000,
      positive(auth.data.interval) ? auth.data.interval * 1000 : DEFAULT_INTERVAL_MS,
    );
    return {
      info: {
        flow: "device",
        verificationUri,
        ...(verificationUriComplete ? { verificationUriComplete } : {}),
        userCode,
        intervalSec: Math.ceil(intervalMs / 1000),
        expiresAt: startedAt + Math.min(lifetimeMs, MAX_DEVICE_LIFETIME_MS),
      },
      state: { clientId, clientSecret, deviceCode, intervalMs, nextPollAt: startedAt + intervalMs },
    };
  }

  async function poll(state: DeviceState): Promise<PollResult> {
    // The session layer polls at the interval we advertised; slow_down can raise it afterwards, so the
    // IdP is only asked once the interval it currently wants has passed.
    if (now() < state.nextPollAt) return { status: "pending" };
    state.nextPollAt = now() + state.intervalMs;

    let reply: Reply;
    try {
      reply = await post(
        `${OIDC}/token`,
        {
          clientId: state.clientId,
          clientSecret: state.clientSecret,
          deviceCode: state.deviceCode,
          grantType: DEVICE_GRANT,
        },
        REQUEST_TIMEOUT_MS,
      );
    } catch {
      return { status: "pending" }; // transport hiccup: the next poll retries until the code expires
    }
    const { data } = reply;
    const code = typeof data.error === "string" ? data.error : reply.errorType;

    if (reply.status >= 500) return { status: "pending" };
    if (reply.status === 400) {
      if (code === "authorization_pending" || code === "AuthorizationPendingException")
        return { status: "pending" };
      if (code === "slow_down" || code === "SlowDownException") {
        state.intervalMs += SLOW_DOWN_STEP_MS;
        state.nextPollAt = now() + state.intervalMs;
        return { status: "pending" };
      }
      if (code === "expired_token" || code === "ExpiredTokenException")
        return { status: "error", message: "The Kiro device code expired before it was approved." };
      if (code === "access_denied" || code === "AccessDeniedException")
        return { status: "error", message: "Kiro sign-in was denied." };
    }
    if (reply.status !== 200 || code) {
      const detail = /^[A-Za-z_]{1,64}$/.test(code) ? `: ${code}` : "";
      return {
        status: "error",
        message: `Kiro device login failed (HTTP ${reply.status}${detail})`,
      };
    }
    if (
      !isNonEmptyString(data.accessToken) ||
      !isNonEmptyString(data.refreshToken) ||
      !positive(data.expiresIn)
    )
      return {
        status: "error",
        message: "Kiro device login returned an incomplete token response.",
      };

    return {
      status: "complete",
      tokens: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: now() + data.expiresIn * 1000,
        extra: {
          authType: "aws_sso_oidc",
          clientId: state.clientId,
          clientSecret: state.clientSecret,
          ssoRegion: DEFAULT_REGION,
          apiRegion: DEFAULT_REGION,
        },
      },
    };
  }

  /**
   * Accounts with a client registration (Builder ID / IAM Identity Center) refresh against SSO OIDC in
   * their SSO region; accounts without one (Kiro desktop social login) use Kiro's own refresh endpoint.
   */
  async function refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    const { refreshToken, extra } = tokens;
    if (!refreshToken)
      throw new OAuthRefreshError("Kiro: no refresh token available, sign in again.", true);
    const region = normalizeRegion(extra.ssoRegion) ?? DEFAULT_REGION;
    const { clientId, clientSecret } = extra;
    let url = `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
    let body: Record<string, unknown> = { refreshToken };
    if (clientId && clientSecret) {
      url = `https://oidc.${region}.amazonaws.com/token`;
      body = { grantType: "refresh_token", clientId, clientSecret, refreshToken };
    }

    let reply: Reply;
    try {
      reply = await post(url, body, REFRESH_TIMEOUT_MS);
    } catch (error) {
      throw new OAuthRefreshError(`Kiro token refresh failed: ${(error as Error).message}`, false, {
        cause: error,
      });
    }
    if (reply.status < 200 || reply.status >= 300) {
      // Only an allowlisted OAuth code is ever surfaced; unknown bodies stay out of the message.
      const oauthError =
        typeof reply.data.error === "string" &&
        Object.hasOwn(TERMINAL_REFRESH_ERRORS, reply.data.error)
          ? reply.data.error
          : undefined;
      throw new OAuthRefreshError(
        `Kiro token refresh failed: ${reply.status}${oauthError ? ` (${oauthError})` : ""}`,
        (reply.status === 400 || reply.status === 401) && oauthError !== undefined,
      );
    }
    const { accessToken, refreshToken: rotated, expiresIn } = reply.data;
    if (!isNonEmptyString(accessToken))
      throw new OAuthRefreshError("Kiro refresh returned no accessToken", false);
    return {
      ...tokens,
      accessToken,
      refreshToken: isNonEmptyString(rotated) ? rotated : refreshToken,
      expiresAt: now() + (positive(expiresIn) ? expiresIn : DEFAULT_ACCESS_TOKEN_TTL_SEC) * 1000,
    };
  }

  return { label: "Sign in with AWS Builder ID (Kiro)", start, poll, refresh };
}
