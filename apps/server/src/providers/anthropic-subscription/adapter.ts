// Adapted from lidge-jun/opencodex (MIT); the Claude Code identity follows can1357/oh-my-pi
import type { ProviderAdapter } from "../adapter.ts";
import { createAnthropicAdapter } from "../anthropic.ts";
import { DEFAULT_BASE_URL } from "./constants.ts";
import { adoptRequiredVersion } from "./identity.ts";
import { createAnthropicSubscriptionOAuth, type OAuthDeps } from "./oauth.ts";
import { fetchAnthropicQuota, modelScope, parseRateLimitHeaders } from "./quota.ts";
import { prepareSubscriptionRequest, restoreToolNames, subscriptionHeaders } from "./wire.ts";

/**
 * Claude Pro/Max: the same Messages translation as the `anthropic` provider, billed to the signed-in
 * Claude account's subscription instead of an API key. The token is a Bearer and the request is a
 * Claude Code request (betas, headers, signed billing block, identity, metadata); tool names are
 * wrapped on the way out and unwrapped on the way back. A "Claude Code is too old" rejection moves the
 * presented version up and resends once. Every answer's rate-limit headers update the account's quota,
 * and Opus/Sonnet/Fable/Mythos are separate model scopes of it.
 */
export function createAnthropicSubscriptionAdapter(deps: OAuthDeps = {}): ProviderAdapter {
  const doFetch = deps.fetch ?? fetch;
  return createAnthropicAdapter({
    type: "anthropic-subscription",
    label: "Anthropic Subscription",
    defaultBaseUrl: DEFAULT_BASE_URL,
    oauth: createAnthropicSubscriptionOAuth(deps),
    quota: (input) => fetchAnthropicQuota(input, doFetch),
    modelScope,
    readAllowance: parseRateLimitHeaders,
    headers: subscriptionHeaders,
    messagesQuery: "beta=true",
    prepare: prepareSubscriptionRequest,
    retryRejection: adoptRequiredVersion,
    restore: restoreToolNames,
  });
}

export const anthropicSubscription = createAnthropicSubscriptionAdapter();
