// Adapted from lidge-jun/opencodex (MIT)
import type { ProviderAdapter } from "../adapter.ts";
import { respond } from "../chunks.ts";
import { DEFAULT_BASE_URL, PROJECT_KEY } from "./constants.ts";
import { ANTIGRAVITY_MODELS } from "./models.ts";
import { fetchAntigravityQuota } from "./quota.ts";
import { createAntigravityOAuth, type OAuthDeps } from "./oauth.ts";
import { buildRequest, UnsupportedRequestError, type BuiltRequest } from "./request.ts";
import { chunksFromJson, chunksFromSse, GeminiMapper } from "./stream.ts";

/**
 * Google Antigravity (Cloud Code Assist): the OpenAI request is compiled into the `v1internal`
 * envelope, the Gemini SSE/JSON answer is mapped back to OpenAI chunks. Upstream non-2xx responses
 * are returned untouched (status, body and `retry-after`) so the gateway classifies 401/403/429/5xx.
 */
export function createAntigravityAdapter(deps: OAuthDeps = {}): ProviderAdapter {
  const doFetch = deps.fetch ?? fetch;
  return {
    type: "antigravity",
    label: "Google Antigravity",
    defaultBaseUrl: DEFAULT_BASE_URL,
    oauth: createAntigravityOAuth(deps),
    staticModels: ANTIGRAVITY_MODELS,
    quota: (input) => fetchAntigravityQuota(input, doFetch),

    async call({ baseUrl, token, meta, body, stream, signal }) {
      const project = meta[PROJECT_KEY];
      if (!project) {
        throw new Error("Antigravity account has no Cloud Code Assist project: sign in again");
      }
      let built: BuiltRequest;
      try {
        built = buildRequest({ baseUrl, token, project, body, stream });
      } catch (error) {
        if (!(error instanceof UnsupportedRequestError)) throw error;
        return Response.json(
          { error: { message: error.message, type: "invalid_request_error", code: null } },
          { status: 400 },
        );
      }

      const res = await doFetch(built.url, {
        method: "POST",
        headers: built.headers,
        body: built.body,
        signal,
      });
      if (!res.ok) return res;
      if (!res.body) throw new Error("Antigravity returned an empty response body");

      const mapper = new GeminiMapper({
        model: typeof body.model === "string" ? body.model : built.wireModelId,
        wireModelId: built.wireModelId,
        sessionId: built.sessionId,
        restoreToolName: built.restoreToolName,
      });
      return respond(
        stream ? chunksFromSse(res.body, mapper) : chunksFromJson(res, mapper),
        stream,
      );
    },
  };
}

export const antigravity = createAntigravityAdapter();
