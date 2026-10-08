// Adapted from lidge-jun/opencodex (MIT)
import { errorBody } from "../../errors.ts";
import type { ProviderAdapter } from "../adapter.ts";
import { respond } from "../chunks.ts";
import { normalizeKiroHttpError } from "./errors.ts";
import { fetchKiroQuota } from "./quota.ts";
import { createKiroOAuth, type KiroOAuthOptions } from "./oauth.ts";
import { buildKiroRequest, KiroRequestError } from "./request.ts";
import { kiroChunks } from "./stream.ts";
import { KIRO_MODELS } from "./models.ts";
import {
  KIRO_DEFAULT_BASE_URL,
  legacyEndpoint,
  requestHeaders,
  resolveApiRegion,
  resolveIdentity,
  runtimeEndpoint,
} from "./wire.ts";

const CONNECT_ERROR_CODES: Record<string, true> = {
  ENOTFOUND: true,
  EAI_AGAIN: true,
  ECONNREFUSED: true,
  ENETUNREACH: true,
  EHOSTUNREACH: true,
};
const ENDPOINT_ERROR_MARKERS = [
  "unknownoperation",
  "unknown operation",
  "invalidsignature",
  "invalid signature",
  "endpoint not found",
  "unsupported endpoint",
];

/** DNS / connect failures anywhere in the error's cause chain (never aborts or timeouts). */
function isConnectFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = error; e instanceof Error && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (e.name === "AbortError" || e.name === "TimeoutError") return false;
    const code = (e as Error & { code?: unknown }).code;
    if (typeof code === "string" && Object.hasOwn(CONNECT_ERROR_CODES, code)) return true;
    const message = e.message.toLowerCase();
    if (
      message.includes("dns") ||
      message.includes("name resolution") ||
      message.includes("failed to lookup address") ||
      message.includes("connection refused") ||
      message.includes("failed to connect")
    )
      return true;
  }
  return false;
}

/**
 * Kiro's AWS event-stream API (`GenerateAssistantResponse`) behind the OpenAI chat-completions shape.
 * `fetch`/`now` are injectable for tests; the default adapter uses the global ones.
 */
export function createKiroAdapter(options: KiroOAuthOptions = {}): ProviderAdapter {
  const doFetch = options.fetch ?? fetch;

  /**
   * One POST, with a single fallback to the older `q.<region>.amazonaws.com` host of the same service
   * when the canonical `runtime.<region>.kiro.dev` host is unreachable, unknown, or answers 502-504.
   */
  async function send(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const post = (target: string) => doFetch(target, { method: "POST", headers, body, signal });
    const legacy = legacyEndpoint(url);
    let res: Response;
    try {
      res = await post(url);
    } catch (error) {
      if (!legacy || !isConnectFailure(error)) throw error;
      return post(legacy);
    }
    if (res.ok || !legacy) return res;
    if ([404, 405, 502, 503, 504].includes(res.status)) {
      await res.body?.cancel().catch(() => {});
      return post(legacy);
    }
    if (res.status === 400 || res.status === 403) {
      const text = await res.text().catch(() => "");
      const lower = text.toLowerCase();
      if (ENDPOINT_ERROR_MARKERS.some((marker) => lower.includes(marker))) return post(legacy);
      return new Response(text, { status: res.status, headers: res.headers });
    }
    return res;
  }

  return {
    type: "kiro",
    label: "Kiro",
    defaultBaseUrl: KIRO_DEFAULT_BASE_URL,
    oauth: createKiroOAuth(options),
    staticModels: KIRO_MODELS,
    quota: (input) => fetchKiroQuota(input, doFetch),
    async call({ baseUrl, token, meta, body, stream, signal }) {
      const identity = resolveIdentity(token, meta);
      let built;
      try {
        built = buildKiroRequest(body, identity);
      } catch (error) {
        if (!(error instanceof KiroRequestError)) throw error;
        return Response.json(errorBody("invalid_request_error", error.message), { status: 400 });
      }

      const res = await send(
        runtimeEndpoint(baseUrl, resolveApiRegion(meta)),
        requestHeaders(token, identity),
        JSON.stringify(built.payload),
        signal,
      );
      if (!res.ok) return normalizeKiroHttpError(res);
      if (!res.body) throw new Error("Kiro response has no body");

      // The service only streams: non-streaming clients are served by aggregating the same chunks.
      return respond(
        kiroChunks(res.body, {
          model: String(body.model),
          nameMap: built.nameMap,
          estimatedInputTokens: built.estimatedInputTokens,
        }),
        stream,
      );
    },
  };
}

export const kiro: ProviderAdapter = createKiroAdapter();
