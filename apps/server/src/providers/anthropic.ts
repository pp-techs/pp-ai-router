// Adapted from lidge-jun/opencodex (MIT)
import type { Quota } from "../quota/types.ts";
import type { ModelInfo, ProviderAdapter } from "./adapter.ts";
import { httpError, MAX_MODELS, readModelDetails } from "./model-list.ts";
import { aggregateChunks, respond, type OpenAIChunk } from "./chunks.ts";
import { isRecord } from "./anthropic/json.ts";
import { InvalidRequestError, toAnthropicRequest } from "./anthropic/request.ts";
import {
  messageChunks,
  streamChunks,
  type AnthropicDelta,
  type ThinkingBlock,
} from "./anthropic/response.ts";

/** Pinned: the version header selects the wire contract, not the model generation. */
const ANTHROPIC_VERSION = "2023-06-01";

/** The 400 a client would get from Anthropic itself, for input the router cannot translate. */
const invalidRequest = (message: string) =>
  Response.json(
    { type: "error", error: { type: "invalid_request_error", message } },
    { status: 400 },
  );

/**
 * Non-streaming completions are folded by `aggregateChunks`, which only knows the standard OpenAI
 * fields; the signed thinking blocks needed to continue a tool loop are re-attached afterwards.
 */
async function completion(chunks: Iterable<OpenAIChunk>): Promise<Response> {
  const thinking: ThinkingBlock[] = [];
  async function* tap() {
    for (const c of chunks) {
      for (const choice of c.choices) {
        thinking.push(...((choice.delta as AnthropicDelta).thinking_blocks ?? []));
      }
      yield c;
    }
  }
  const result = await aggregateChunks(tap());
  if (thinking.length > 0) {
    Object.assign(result.choices[0]!.message, { thinking_blocks: thinking });
  }
  return Response.json(result);
}

/** A translated request as it goes out: the body (possibly signed bytes) and any headers that depend on it. */
export interface PreparedRequest {
  body: string | Uint8Array;
  headers?: Record<string, string>;
}

/**
 * Resending a request once the protocol version it presented has been fixed, e.g. Anthropic answering
 * `claude_code_version_too_old`: the flavor adopts the required version for the rest of the process.
 */
export interface VersionRetry {
  /**
   * The protocol version the next attempt presents on the wire, read right before its body and
   * headers are built. `accept` judges a rejection against the version the failed request actually
   * sent, not the process-wide adopted one: of several concurrent stale-version requests, adoption
   * moves the shared version up on the first answer, and comparing against it would let all the
   * others skip their retry (oh-my-pi `b328cf183f`, 18.18.8).
   */
  requestVersion: () => string;
  /** Whether this 4xx answer names something the flavor has since fixed, so the request is worth one resend. */
  accept: (rejection: string, sentVersion: string) => boolean;
}

/** What distinguishes one way of reaching the Messages API from another. */
export interface AnthropicFlavor extends Pick<
  ProviderAdapter,
  "type" | "label" | "oauth" | "quota" | "modelScope"
> {
  defaultBaseUrl: string;
  /** Credential headers (on top of `anthropic-version`); `messages` may carry more than `models`. */
  headers: (
    token: string,
    purpose: "models" | "messages",
    meta: Readonly<Record<string, string>>,
  ) => Record<string, string>;
  /** Query string of the Messages URL. */
  messagesQuery?: string;
  /** Serialises the translated Messages body, and may rewrite it first. Default: plain JSON. */
  prepare?: (
    payload: Record<string, unknown>,
    account: { token: string; meta: Readonly<Record<string, string>> },
  ) => PreparedRequest;
  /** One resend allowed when a 4xx names a protocol version the flavor has since fixed. */
  retryRejection?: VersionRetry;
  /** What the headers of an answer (a refusal too) say about the account's allowance, if anything. */
  readAllowance?: (headers: Headers) => Quota | null;
  /** Rewrites every chunk translated from the answer, in place, before the client sees it. */
  restore?: (chunk: OpenAIChunk) => void;
}

function* restoreEach(chunks: Iterable<OpenAIChunk>, restore: (chunk: OpenAIChunk) => void) {
  for (const chunk of chunks) {
    restore(chunk);
    yield chunk;
  }
}

async function* restoreEachAsync(
  chunks: AsyncIterable<OpenAIChunk>,
  restore: (chunk: OpenAIChunk) => void,
) {
  for await (const chunk of chunks) {
    restore(chunk);
    yield chunk;
  }
}

/** Anthropic Messages API: the router's OpenAI request is translated to `/messages` and back. */
export function createAnthropicAdapter(flavor: AnthropicFlavor): ProviderAdapter {
  const { restore } = flavor;
  return {
    type: flavor.type,
    label: flavor.label,
    defaultBaseUrl: flavor.defaultBaseUrl,
    ...(flavor.oauth ? { oauth: flavor.oauth } : {}),
    ...(flavor.quota ? { quota: flavor.quota } : {}),
    ...(flavor.modelScope ? { modelScope: flavor.modelScope } : {}),
    /** `GET /models`, newest first, paginated with `after_id` until `has_more` is false. */
    async listModels({ baseUrl, token, meta, headers, signal }) {
      const models: ModelInfo[] = [];
      let afterId: string | null = null;
      for (let page = 0; page < 20 && models.length < MAX_MODELS; page++) {
        const url = new URL(`${baseUrl.replace(/\/+$/, "")}/models`);
        url.searchParams.set("limit", "1000");
        if (afterId) url.searchParams.set("after_id", afterId);
        const res = await fetch(url, {
          headers: {
            ...flavor.headers(token, "models", meta),
            "anthropic-version": ANTHROPIC_VERSION,
            ...headers,
          },
          signal,
        });
        if (!res.ok) throw await httpError("GET /models", res);
        const json: unknown = await res.json();
        if (!isRecord(json) || !Array.isArray(json.data))
          throw new Error("unexpected /models response");
        for (const item of json.data) {
          if (!isRecord(item) || typeof item.id !== "string") continue;
          models.push({ id: item.id, ...readModelDetails(item) });
        }
        afterId = typeof json.last_id === "string" ? json.last_id : null;
        if (json.has_more !== true || !afterId) break;
      }
      return models.slice(0, MAX_MODELS);
    },
    async call({ baseUrl, token, meta, headers, body, stream, signal, observe }) {
      let payload: Record<string, unknown>;
      try {
        payload = toAnthropicRequest(body, stream);
      } catch (error) {
        if (error instanceof InvalidRequestError) return invalidRequest(error.message);
        throw error;
      }

      const url = new URL(`${baseUrl.replace(/\/+$/, "")}/messages`);
      if (flavor.messagesQuery) url.search = flavor.messagesQuery;
      const send = async () => {
        // Read before the body and headers are built, so a rejection is judged against the version
        // this attempt sent rather than the one the process has since adopted (oh-my-pi 18.18.8).
        const sentVersion = flavor.retryRejection?.requestVersion() ?? "";
        const prepared = flavor.prepare?.(payload, { token, meta }) ?? {
          body: JSON.stringify(payload),
        };
        const answer = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: stream ? "text/event-stream" : "application/json",
            ...flavor.headers(token, "messages", meta),
            ...prepared.headers,
            "anthropic-version": ANTHROPIC_VERSION,
            ...headers,
          },
          body: prepared.body,
          signal,
        });
        const allowance = observe && flavor.readAllowance?.(answer.headers);
        if (allowance) observe(allowance);
        return { answer, sentVersion };
      };
      const first = await send();
      let res = first.answer;
      if (
        flavor.retryRejection &&
        res.status >= 400 &&
        res.status < 500 &&
        flavor.retryRejection.accept(await res.clone().text(), first.sentVersion)
      ) {
        await res.body?.cancel().catch(() => {});
        // `send` re-runs `prepare`, so the rebuilt body and headers carry the adopted version.
        res = (await send()).answer;
      }
      if (!res.ok) return res;

      const model = String(body.model);
      if (stream) {
        if (!res.body) throw new Error("Anthropic returned an empty stream");
        const chunks = streamChunks(res.body, model);
        return respond(restore ? restoreEachAsync(chunks, restore) : chunks, true);
      }
      const message: unknown = await res.json();
      if (!isRecord(message) || message.type !== "message") {
        throw new Error("Anthropic returned an unexpected response body");
      }
      const chunks = messageChunks(message, model);
      return completion(restore ? restoreEach(chunks, restore) : chunks);
    },
  };
}

/** API-key access (`x-api-key`). */
export const anthropic = createAnthropicAdapter({
  type: "anthropic",
  label: "Anthropic API",
  defaultBaseUrl: "https://api.anthropic.com/v1",
  headers: (token) => ({ "x-api-key": token }),
});
