// Adapted from lidge-jun/opencodex (MIT)
import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";

export const KIRO_DEFAULT_BASE_URL = "https://runtime.us-east-1.kiro.dev";
export const DEFAULT_REGION = "us-east-1";
export const AMZ_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

const SDK_VERSION = "1.0.27";
const NODE_VERSION = "22.21.1";
const KIRO_IDE_VERSION = "1.0.0";

/**
 * Request-scoped CodeWhisperer service profile for AWS Builder ID accounts. Builder ID has no AWS
 * account behind it, so AWS never mints an account `profile/<id>` ARN; the Kiro CLI carries this fixed
 * profile on Builder ID requests and so do we. It is never stored with the account and never seeds
 * region inference (it is us-east-1 and would pin every Builder ID account there).
 */
const BUILDER_ID_SERVICE_PROFILE_ARN =
  "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";

const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const CANONICAL_RUNTIME_HOST = /^runtime\.([a-z]{2}(?:-[a-z]+)+-\d)\.kiro\.dev$/i;

export function normalizeRegion(region: string | undefined): string | undefined {
  const trimmed = region?.trim();
  return trimmed && REGION_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** `arn:<partition>:codewhisperer:<region>:<account>:profile/<id>` -> region. */
function regionFromProfileArn(arn: string | undefined): string | undefined {
  return normalizeRegion(arn?.split(":")[3]);
}

/** Region of the runtime API: explicit `apiRegion`, else the profile ARN's, else the SSO region. */
export function resolveApiRegion(meta: Readonly<Record<string, string>>): string {
  return (
    normalizeRegion(meta.apiRegion) ??
    regionFromProfileArn(meta.profileArn) ??
    normalizeRegion(meta.ssoRegion) ??
    DEFAULT_REGION
  );
}

export type KiroWireClient = "ide" | "cli";

export interface RequestIdentity {
  wireClient: KiroWireClient;
  /** Sent as `profileArn` + `x-amzn-kiro-profile-arn`; undefined for API keys and profile-less accounts. */
  profileArn: string | undefined;
  apiKey: boolean;
}

/**
 * Which request shape and profile to send. Builder ID and `ksk_` API keys are accepted only on Kiro's
 * CLI request path; accounts with their own profile (enterprise / social login) keep the IDE shape.
 * The Builder ID fallback keys on `authType`, not on a missing ARN, so an account whose profile
 * could not be captured keeps failing loudly instead of silently borrowing a service profile.
 */
export function resolveIdentity(
  token: string,
  meta: Readonly<Record<string, string>>,
): RequestIdentity {
  const apiKey = token.trim().startsWith("ksk_");
  const own = meta.profileArn || undefined;
  const builderId = !own && meta.authType === "aws_sso_oidc";
  const profileArn = apiKey
    ? undefined
    : (own ?? (builderId ? BUILDER_ID_SERVICE_PROFILE_ARN : undefined));
  return {
    wireClient: apiKey || builderId || !profileArn ? "cli" : "ide",
    profileArn,
    apiKey,
  };
}

/** A canonical `runtime.<region>.kiro.dev` base URL follows the account's region; anything else is used as given. */
export function runtimeEndpoint(baseUrl: string, region: string): string {
  const configured = new URL(baseUrl);
  if (CANONICAL_RUNTIME_HOST.test(configured.hostname) && configured.pathname === "/")
    return `https://runtime.${region}.kiro.dev/`;
  return configured.toString();
}

/** The pre-`kiro.dev` host of the same service, used when the canonical one is unreachable. */
export function legacyEndpoint(requestUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  const match = CANONICAL_RUNTIME_HOST.exec(url.hostname);
  if (!match || url.pathname !== "/" || url.search || url.hash) return undefined;
  url.hostname = `q.${match[1]}.amazonaws.com`;
  return url.toString();
}

function fingerprint(): string {
  try {
    return createHash("sha256").update(`${hostname()}-${userInfo().username}-kiro`).digest("hex");
  } catch {
    return createHash("sha256").update("default-kiro").digest("hex");
  }
}

function osTag(): string {
  if (process.platform === "darwin") return "macos#24.0.0";
  if (process.platform === "win32") return "win32#10.0.26100";
  return "linux#6.8.0";
}

function cliUserAgent(includeAppVersion: boolean): string {
  const platform =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  return [
    "aws-sdk-rust/1.3.15",
    "ua/2.1",
    "api/codewhispererstreaming/0.1.17975",
    `os/${platform}`,
    "lang/rust/1.92.0",
    ...(includeAppVersion ? ["md/appVersion-2.14.2"] : []),
    "m/F",
    "app/AmazonQ-For-CLI",
  ].join(" ");
}

export function requestHeaders(token: string, identity: RequestIdentity): Record<string, string> {
  const base = {
    authorization: `Bearer ${token}`,
    "content-type": "application/x-amz-json-1.0",
    "x-amz-target": AMZ_TARGET,
    "x-amzn-codewhisperer-optout": "true",
    "amz-sdk-invocation-id": randomUUID(),
  };
  const headers: Record<string, string> =
    identity.wireClient === "cli"
      ? {
          ...base,
          accept: "*/*",
          "user-agent": cliUserAgent(true),
          "x-amz-user-agent": cliUserAgent(false),
          "amz-sdk-request": "attempt=1; max=3",
          ...(identity.apiKey ? { tokentype: "API_KEY" } : {}),
        }
      : {
          ...base,
          accept: "application/vnd.amazon.eventstream",
          "user-agent": `aws-sdk-js/${SDK_VERSION} ua/2.1 os/${osTag()} lang/js md/nodejs#${NODE_VERSION} api/codewhispererstreaming#${SDK_VERSION} m/E KiroIDE-${KIRO_IDE_VERSION}-${fingerprint().slice(0, 64)}`,
          "x-amz-user-agent": `aws-sdk-js/${SDK_VERSION} KiroIDE-${KIRO_IDE_VERSION}-${fingerprint().slice(0, 64)}`,
          "x-amzn-kiro-agent-mode": "vibe",
        };
  if (identity.profileArn) headers["x-amzn-kiro-profile-arn"] = identity.profileArn;
  return headers;
}
