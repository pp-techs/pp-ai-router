// Adapted from can1357/oh-my-pi (MIT) and lidge-jun/opencodex (MIT)
import { errorBody } from "../../errors.ts";
import type { ProviderAdapter } from "../adapter.ts";
import { respond } from "../chunks.ts";
import { DEFAULT_BASE_URL, resolveResponsesUrl } from "./constants.ts";
import { normalizeCodexHttpError } from "./errors.ts";
import { CODEX_MODELS } from "./models.ts";
import { createChatgptSubscriptionOAuth, type OAuthDeps } from "./oauth.ts";
import { fetchCodexQuota, modelScope, parseRateLimitHeaders } from "./quota.ts";
import { CodexRequestError, toCodexRequest } from "./request.ts";
import { codexChunks } from "./stream.ts";
import { codexIdentity, requestHeaders } from "./wire.ts";

/**
 * OpenAI models billed to a signed-in ChatGPT Plus/Pro/Team account instead of an API key: the canonical
 * chat-completions request is translated into a Codex Responses request (`{base_url}/codex/responses`,
 * always streamed, never stored) and the Responses SSE is mapped back to chat-completions chunks, or
 * aggregated for a client that did not stream. The token is a Bearer and the request presents oh-my-pi's
 * Codex identity (originator `omp`, version, user agent, workspace id, session/thread/turn metadata). Upstream failures are passed on with their status; a
 * spent usage limit is a 429 with the reset time as `retry-after`. Every answer's `x-codex-*` rate-limit
 * headers update the account's quota, and Spark models are a separate model scope of it.
 */
export function createChatgptSubscriptionAdapter(deps: OAuthDeps = {}): ProviderAdapter {
  const doFetch = deps.fetch ?? fetch;
  return {
    type: "chatgpt-subscription",
    label: "ChatGPT (Plus/Pro, Codex)",
    defaultBaseUrl: DEFAULT_BASE_URL,
    oauth: createChatgptSubscriptionOAuth(deps),
    staticModels: CODEX_MODELS,
    quota: (input) => fetchCodexQuota(input, doFetch),
    modelScope,
    async call({ baseUrl, token, headers, body, signal, stream, observe }) {
      let payload: Record<string, unknown>;
      try {
        payload = toCodexRequest(body);
      } catch (error) {
        if (!(error instanceof CodexRequestError)) throw error;
        return Response.json(errorBody("invalid_request_error", error.message), { status: 400 });
      }

      // The backend derives prompt-cache affinity from the session: a client's cache key keeps one.
      const sessionId =
        typeof payload.prompt_cache_key === "string" ? payload.prompt_cache_key : undefined;
      const identity = codexIdentity(sessionId);
      payload.client_metadata = identity.clientMetadata;
      const res = await doFetch(resolveResponsesUrl(baseUrl), {
        method: "POST",
        headers: requestHeaders(token, headers, String(payload.model), sessionId, identity),
        body: JSON.stringify(payload),
        signal,
      });
      const allowance = observe && parseRateLimitHeaders(res.headers, res.ok);
      if (allowance) observe(allowance);
      if (!res.ok) return normalizeCodexHttpError(res);
      if (!res.body) throw new Error("Codex returned an empty stream");

      // The backend only streams: non-streaming clients are served by aggregating the same chunks.
      return respond(codexChunks(res.body, String(body.model)), stream);
    },
  };
}

export const chatgptSubscription: ProviderAdapter = createChatgptSubscriptionAdapter();
