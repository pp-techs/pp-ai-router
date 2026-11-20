// Adapted from lidge-jun/opencodex (MIT)
import type { ProviderAdapter } from "../adapter.ts";
import { respond } from "../chunks.ts";
import { DEFAULT_BASE_URL, PROJECT_KEY } from "./constants.ts";
import { isRecord } from "./json.ts";
import { ANTIGRAVITY_MODELS } from "./models.ts";
import { fetchAntigravityQuota } from "./quota.ts";
import { createAntigravityOAuth, type OAuthDeps } from "./oauth.ts";
import { clearReplay } from "./replay.ts";
import { buildRequest, UnsupportedRequestError, type BuiltRequest } from "./request.ts";
import { chunksFromJson, chunksFromSse, GeminiMapper } from "./stream.ts";
import { repairInvalidRequestBody } from "./wire-compiler.ts";

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
  us: 0.001,
  µs: 0.001,
  ns: 0.000001,
};
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Google duration text as milliseconds: protobuf Duration JSON ("30s", "0.5s") and Go-style compound
 * durations ("1h2m3s", "500ms"). Undefined for anything else, a negative value or more than 30 days.
 */
function parseGoogleDurationMs(raw: string): number | undefined {
  const text = raw.trim();
  if (!text || text.length > 64) return undefined;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/gy)) {
    if (match.index !== consumed) return undefined;
    total += Number(match[1]) * DURATION_UNIT_MS[match[2]!]!;
    consumed += match[0].length;
  }
  if (consumed !== text.length || !Number.isFinite(total) || total > MAX_DURATION_MS) {
    return undefined;
  }
  return total;
}

function positiveDelayMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  // Legacy responses also put whitespace before the seconds suffix.
  const seconds = /^\s*(\d+(?:\.\d+)?)\s*s\s*$/i.exec(value);
  const ms = parseGoogleDurationMs(seconds ? `${seconds[1]}s` : value);
  return ms !== undefined && ms > 0 ? ms : undefined;
}

/**
 * The retry delay (whole seconds) a Google error body names: a typed `RetryInfo.retryDelay`, then
 * `ErrorInfo.metadata.quotaResetDelay`, then an untyped detail, then "retry/reset after <duration>"
 * in the message (`"42.5s"` -> `"43"`). Undefined when it names none.
 */
export function googleRetryAfterSeconds(payloadText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return undefined;
  }
  const error = isRecord(parsed) ? parsed.error : undefined;
  const root = Array.isArray(error) ? error[0] : (error ?? parsed);
  if (!isRecord(root)) return undefined;
  let typedRetry: number | undefined;
  let quotaReset: number | undefined;
  let untyped: number | undefined;
  const details: unknown[] = Array.isArray(root.details) ? root.details.slice(0, 32) : [];
  for (const detail of details) {
    if (!isRecord(detail)) continue;
    const type = detail["@type"];
    const name = typeof type === "string" ? type.slice(type.lastIndexOf("/") + 1) : undefined;
    const metadata = isRecord(detail.metadata) ? detail.metadata : undefined;
    if (name === "google.rpc.ErrorInfo") {
      quotaReset ??= positiveDelayMs(metadata?.quotaResetDelay);
    } else if (name === "google.rpc.RetryInfo") {
      typedRetry ??= positiveDelayMs(detail.retryDelay);
    } else if (type === undefined) {
      untyped ??= positiveDelayMs(detail.retryDelay) ?? positiveDelayMs(metadata?.quotaResetDelay);
    }
  }
  let ms = typedRetry ?? quotaReset ?? untyped;
  if (ms === undefined && typeof root.message === "string") {
    const match = /\b(?:retry|resets?)\s+after\s+(\d[\w.µ]*?)[.,;]?(?:\s|$)/i.exec(
      root.message.slice(0, 2_000),
    );
    if (match) ms = parseGoogleDurationMs(match[1]!);
  }
  return ms !== undefined && ms > 0 ? String(Math.ceil(ms / 1000)) : undefined;
}

/**
 * A 429 without `retry-after` gets one from the delay its body names, so the gateway's cooldown
 * follows Google's hint instead of its own backoff. Otherwise the response is returned as it came.
 */
async function withRetryHint(res: Response): Promise<Response> {
  if (res.status !== 429 || res.headers.has("retry-after")) return res;
  const text = await res
    .clone()
    .text()
    .catch(() => "");
  const seconds = googleRetryAfterSeconds(text);
  if (!seconds) return res;
  await res.body?.cancel().catch(() => {});
  const headers = new Headers(res.headers);
  // The body is re-emitted decoded.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("retry-after", seconds);
  return new Response(text, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Google Antigravity (Cloud Code Assist): the OpenAI request is compiled into the `v1internal`
 * envelope, the Gemini SSE/JSON answer is mapped back to OpenAI chunks. Upstream non-2xx responses
 * are returned with their status, body and `retry-after` so the gateway classifies 401/403/429/5xx
 * (a 429 without `retry-after` gets one from Google's `RetryInfo` / `quotaResetDelay`); the one
 * exception is a 400 that blames the tool schemas or the thinking config, which is replayed once
 * with those parts relaxed.
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

    async call({ baseUrl, token, meta, headers, body, stream, signal }) {
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

      const send = (requestBody: string) =>
        doFetch(built.url, {
          method: "POST",
          headers: { ...built.headers, ...headers },
          body: requestBody,
          signal,
        });
      let res = await send(built.body);
      if (res.status === 400) {
        // A 400 that blames the tool schemas or the thinking config is replayed once with those
        // parts relaxed (the Vertex/Antigravity "repair" of the reference); anything else is final.
        const repaired = repairInvalidRequestBody(
          built.body,
          (await res.clone().text()).slice(0, 8_192),
        );
        if (repaired !== undefined) {
          await res.body?.cancel().catch(() => {});
          res = await send(repaired);
        }
      }
      if (!res.ok) {
        // A rejected replay usually arrives as a real HTTP 400, and this layer returns a non-ok
        // response without ever reaching the parsers' clear-on-invalid. The normalized error text
        // keeps only Google's message, so a 400 whose text names neither a signature nor an invalid
        // argument (for example "bad model") still counts as an invalid-argument rejection and drops
        // the session's replay entry, so the next turn does not replay the rejected signature until
        // the TTL expires. The rejected request itself is not resent (payload rejection is final).
        if (res.status === 400) clearReplay(built.wireModelId, built.sessionId);
        return withRetryHint(res);
      }
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
