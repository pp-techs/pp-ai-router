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
];

/** Registered redirect of the Antigravity client. Nothing listens here on the router: the admin pastes the dead URL back. */
export const REDIRECT_URI = "http://127.0.0.1:51121/callback";

export const REQUEST_TIMEOUT_MS = 30_000;
export const LOGIN_TTL_MS = 10 * 60_000;
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

/** Default `base_url` of the provider. */
export const DEFAULT_BASE_URL = DAILY_API;

/** Key of the Cloud Code Assist project id inside `OAuthTokens.extra`. */
export const PROJECT_KEY = "project_id";
