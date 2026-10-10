// Adapted from lidge-jun/opencodex (MIT): src/oauth/anthropic.ts, src/adapters/client-fingerprint.ts
import { createHash } from "node:crypto";

/**
 * Every protocol constant of the Claude Pro/Max sign-in lives here. The OAuth client id is the public
 * identifier of the Claude Code CLI (not a user secret); it is the one the reference uses.
 */
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const SCOPES = "org:create_api_key user:profile user:inference";

/** Registered redirect of the Claude Code client. Nothing listens here on the router: the admin pastes the dead URL back. */
export const REDIRECT_URI = "http://localhost:54545/callback";

export const REQUEST_TIMEOUT_MS = 30_000;
export const LOGIN_TTL_MS = 10 * 60_000;

/** Key of the provider-side account id inside `OAuthTokens.extra`. */
export const ACCOUNT_UUID_KEY = "account_uuid";

/** Default `base_url` of the provider. */
export const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

/** A subscription token is only accepted together with these betas. */
export const OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";

/** A subscription token is only accepted when the first system block is the Claude Code identity. */
export const SYSTEM_INSTRUCTION = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * A subscription token rejects arbitrary tool names, so every client tool is sent as `custom_<name>`
 * and the prefix is removed again from the answer. Anthropic's own tools keep their names.
 */
export const TOOL_PREFIX = "custom_";
export const BUILTIN_TOOLS: Readonly<Record<string, true>> = {
  web_search: true,
  code_execution: true,
  text_editor: true,
  computer: true,
};

/** `@anthropic-ai/sdk` version the Claude Code CLI bundles; pinned here so it is trivial to bump. */
const SDK_VERSION = "0.74.0";
export const MESSAGES_USER_AGENT = `@anthropic-ai/sdk/${SDK_VERSION}`;

/**
 * Claude Code CLI version presented on the account endpoints (`/api/oauth/usage`). Upstream gates
 * response blocks on this: only the `claude-cli/<version> (external, cli)` form of a current release
 * is treated as the CLI. Bump it together with a live check.
 */
export const CLI_VERSION = "2.1.280";
export const CLI_USER_AGENT = `claude-cli/${CLI_VERSION} (external, cli)`;

/** Betas the CLI sends on the usage probe. */
export const USAGE_BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05";

/** The headers of the real Claude Code CLI; a valid token behind an empty header set is a non-first-party signature. */
export const CLAUDE_CODE_HEADERS: Readonly<Record<string, string>> = {
  "X-App": "cli",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Timeout": "600",
  "X-Stainless-Arch": process.arch,
  "X-Stainless-OS": process.platform,
  "X-Stainless-Package-Version": SDK_VERSION,
  "X-Stainless-Runtime-Version": process.version.slice(1),
};

/**
 * Stable per-token session id, like Claude Code's `X-Claude-Code-Session-Id`: a UUIDv4-shaped id
 * derived from the token's hash, so it stays the same across a conversation without keeping state
 * (and the token itself never leaves this function).
 */
export function sessionId(token: string): string {
  const h = createHash("sha256").update(`claude-code-session:${token}`, "utf8").digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
