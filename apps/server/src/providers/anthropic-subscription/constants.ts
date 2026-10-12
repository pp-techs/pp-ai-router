// Adapted from lidge-jun/opencodex (MIT): src/oauth/anthropic.ts, src/adapters/client-fingerprint.ts;
// the Claude Code identity follows can1357/oh-my-pi (packages/ai: claude-code-fingerprint, providers/anthropic).

/**
 * Every protocol constant of the Claude Pro/Max sign-in lives here. The OAuth client id is the public
 * identifier of the Claude Code CLI (not a user secret); it is the one both references use.
 */
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/** Registered redirect of the Claude Code client. Nothing listens here on the router: the admin pastes the dead URL back. */
export const REDIRECT_URI = "http://localhost:54545/callback";

export const REQUEST_TIMEOUT_MS = 30_000;
export const LOGIN_TTL_MS = 10 * 60_000;

/** Keys of the provider-side identity inside `OAuthTokens.extra`. */
export const ACCOUNT_UUID_KEY = "account_uuid";
export const ORG_UUID_KEY = "organization_uuid";
export const ORG_NAME_KEY = "organization_name";

/** Default `base_url` of the provider. */
export const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

/** Claude Code's account-side lookup of the signed-in account and organization. */
export const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
export const BOOTSTRAP_MODEL = "claude-opus-4-8";

/** The protocol beta every account route (token refresh, usage, models, bootstrap) needs. */
export const OAUTH_BETA = "oauth-2025-04-20";

/**
 * The betas a Claude Code agent request carries. `effort` is added when the request asks for it.
 * `context-1m` is deliberately absent: a subscription has no long-context credit balance, so a 1M beta
 * is answered with a 429 whatever the prompt size.
 */
export const MESSAGES_BETAS: readonly string[] = [
  "claude-code-20250219",
  OAUTH_BETA,
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
];
export const EFFORT_BETA = "effort-2025-11-24";

/** Betas the CLI sends on the usage probe. */
export const USAGE_BETA = [
  "claude-code-20250219",
  OAUTH_BETA,
  "interleaved-thinking-2025-05-14",
  "redact-thinking-2026-02-12",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
].join(",");

/** A subscription token is only accepted when the first system blocks are the Claude Code identity. */
export const SYSTEM_INSTRUCTION = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * A subscription token rejects arbitrary tool names, so every client tool is sent as `_<name>` and the
 * prefix is removed again from the answer. Anthropic's own tools keep their names.
 */
export const TOOL_PREFIX = "_";
export const BUILTIN_TOOLS: Readonly<Record<string, true>> = {
  web_search: true,
  code_execution: true,
  text_editor: true,
  computer: true,
};

/** `@anthropic-ai/sdk` version the Claude Code CLI bundles; pinned here so it is trivial to bump. */
export const SDK_VERSION = "0.112.1";

/** Claude Code CLI release the requests present; replaced at run time when Anthropic names a newer minimum. */
export const DEFAULT_CLI_VERSION = "2.1.280";

/** What the Stainless SDK reports for `process.platform` / `process.arch`. */
function stainlessOs(platform: string): string {
  switch (platform) {
    case "darwin":
      return "MacOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "freebsd":
      return "FreeBSD";
    default:
      return `Other::${platform}`;
  }
}
function stainlessArch(arch: string): string {
  switch (arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    case "ia32":
      return "x86";
    default:
      return `other::${arch}`;
  }
}

/** The headers of the real Claude Code CLI; a valid token behind an empty header set is a non-first-party signature. */
export const CLAUDE_CODE_HEADERS: Readonly<Record<string, string>> = {
  "x-app": "cli",
  "anthropic-dangerous-direct-browser-access": "true",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Timeout": "600",
  "X-Stainless-Arch": stainlessArch(process.arch),
  "X-Stainless-OS": stainlessOs(process.platform),
  "X-Stainless-Package-Version": SDK_VERSION,
  "X-Stainless-Runtime-Version": process.version,
};

/** Sent with a token refresh, as the SDK's OAuth provider does (and not with the code exchange). */
export const REFRESH_USER_AGENT = `anthropic-sdk-typescript/${SDK_VERSION} userOAuthProvider`;
