// Adapted from lidge-jun/opencodex (MIT)
import type { ProviderAdapter } from "../adapter.ts";
import { createAnthropicAdapter } from "../anthropic.ts";
import { DEFAULT_BASE_URL } from "./constants.ts";
import { createAnthropicSubscriptionOAuth, type OAuthDeps } from "./oauth.ts";
import { fetchAnthropicQuota } from "./quota.ts";
import { prepareSubscriptionRequest, restoreToolNames, subscriptionHeaders } from "./wire.ts";

/**
 * Claude Pro/Max: the same Messages translation as the `anthropic` provider, billed to the signed-in
 * Claude account's subscription instead of an API key. The token is a Bearer, the request carries the
 * Claude Code identity (betas, headers, first system block) and tool names are wrapped on the way out
 * and unwrapped on the way back.
 */
export function createAnthropicSubscriptionAdapter(deps: OAuthDeps = {}): ProviderAdapter {
  const doFetch = deps.fetch ?? fetch;
  return createAnthropicAdapter({
    type: "anthropic-subscription",
    label: "Anthropic Subscription",
    defaultBaseUrl: DEFAULT_BASE_URL,
    oauth: createAnthropicSubscriptionOAuth(deps),
    quota: (input) => fetchAnthropicQuota(input, doFetch),
    headers: subscriptionHeaders,
    prepare: prepareSubscriptionRequest,
    restore: restoreToolNames,
  });
}

export const anthropicSubscription = createAnthropicSubscriptionAdapter();
