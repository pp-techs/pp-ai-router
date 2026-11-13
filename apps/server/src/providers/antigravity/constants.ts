// Adapted from lidge-jun/opencodex (MIT)

/**
 * Every Antigravity protocol constant lives here. The OAuth client id/secret are the public
 * identifiers embedded in the Antigravity desktop client (not user secrets); both can be
 * overridden through the environment, as in the reference implementation.
 */
export const CLIENT_ID =
  process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID ||
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const CLIENT_SECRET =
  process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET || "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";

export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const PROD_API = "https://cloudcode-pa.googleapis.com";
export const DAILY_API = "https://daily-cloudcode-pa.googleapis.com";
export const API_VERSION = "v1internal";

export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
];

/** Registered redirect of the Antigravity client. Nothing listens here on the router: the admin pastes the dead URL back. */
export const REDIRECT_URI = "http://127.0.0.1:51121/callback";

export const REQUEST_TIMEOUT_MS = 30_000;
export const LOGIN_TTL_MS = 10 * 60_000;

/** A token is treated as expired this long before Google says (opencodex `REFRESH_SKEW_MS`, omp `skew-ms=300000`). */
export const EXPIRY_SKEW_MS = 5 * 60_000;
export const ONBOARD_ATTEMPTS = 5;
export const ONBOARD_POLL_MS = 2_000;

/** Pinned Antigravity IDE language-server version. */
export const IDE_VERSION = "2.5.5";

/**
 * Real Antigravity IDE User-Agent format. The IDE client family (`antigravity/ide/...`) is required:
 * Cloud Code Assist answers 404 to CLI-shaped UAs for the newer agent models.
 * `GOOGLE_ANTIGRAVITY_USER_AGENT` overrides it.
 */
export const USER_AGENT =
  process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim() ||
  `antigravity/ide/${IDE_VERSION} (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)`;

/**
 * Antigravity CLI User-Agent. Cloud Code Assist serves the Gemini 4 codename models (Argon,
 * Carbon) only to the CLI client family and 404s the other agent models (`gemini-3.7-flash-tiered`,
 * `gemini-3.1-pro-low`) under it, so it is chosen per wire model (`userAgentForWireModel`). The
 * quota summary is asked with it too: its Argon group is CLI-only.
 * `GOOGLE_ANTIGRAVITY_USER_AGENT` never applies to it: letting it replace this header would lock
 * the Gemini 4 models again.
 */
export const CLI_USER_AGENT =
  "antigravity/cli/1.3.4 (os_type=darwin; arch=arm64; aidev_client; auth_method=oauth)";

/**
 * Wire ids sent with the CLI User-Agent: every Gemini 4 codename, bare or with a low, medium, high
 * or xhigh tier suffix. Argon was verified 2026-10-14; on 2026-11-11 `gemini-4-carbon-medium` 404'd
 * under the IDE User-Agent ("Requested entity was not found") while answering 200 under the CLI
 * one, the same split as Argon. Hydrogen's four tiers were listed by CCA discovery on 2026-11-12 and
 * `gemini-4-hydrogen-xhigh` answered 200 under the CLI one. Matching the generation keeps a newly
 * discovered codename callable instead of listing it and 404ing every request.
 */
const CLI_ONLY_WIRE_MODEL = /^gemini-4-[a-z][a-z0-9]*(?:-(?:low|medium|high|xhigh))?$/;

/** The User-Agent an inference request for `wireModelId` must carry. */
export function userAgentForWireModel(wireModelId: string): string {
  return CLI_ONLY_WIRE_MODEL.test(wireModelId) ? CLI_USER_AGENT : USER_AGENT;
}

/** Default `base_url` of the provider. */
export const DEFAULT_BASE_URL = DAILY_API;

/** Key of the Cloud Code Assist project id inside `OAuthTokens.extra`. */
export const PROJECT_KEY = "project_id";
