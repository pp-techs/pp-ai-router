// Adapted from lidge-jun/opencodex (MIT)
import type { ModelInfo, ProviderAdapter } from "./adapter.ts";
import { httpError, MAX_MODELS } from "./model-list.ts";
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

/** Anthropic Messages API (`x-api-key`). The router's OpenAI request is translated to `/messages` and back. */
export const anthropic: ProviderAdapter = {
  type: "anthropic",
  label: "Anthropic",
  defaultBaseUrl: "https://api.anthropic.com/v1",
  /** `GET /models`, newest first, paginated with `after_id` until `has_more` is false. */
  async listModels({ baseUrl, token, signal }) {
    const models: ModelInfo[] = [];
    let afterId: string | null = null;
    for (let page = 0; page < 20 && models.length < MAX_MODELS; page++) {
      const url = new URL(`${baseUrl.replace(/\/+$/, "")}/models`);
      url.searchParams.set("limit", "1000");
      if (afterId) url.searchParams.set("after_id", afterId);
      const res = await fetch(url, {
        headers: { "x-api-key": token, "anthropic-version": ANTHROPIC_VERSION },
        signal,
      });
      if (!res.ok) throw await httpError("GET /models", res);
      const json: unknown = await res.json();
      if (!isRecord(json) || !Array.isArray(json.data))
        throw new Error("unexpected /models response");
      for (const item of json.data) {
        if (!isRecord(item) || typeof item.id !== "string") continue;
        const info: ModelInfo = { id: item.id };
        if (typeof item.display_name === "string" && item.display_name !== item.id)
          info.name = item.display_name;
        if (typeof item.max_input_tokens === "number" && item.max_input_tokens > 0) {
          info.contextWindow = item.max_input_tokens;
        }
        models.push(info);
      }
      afterId = typeof json.last_id === "string" ? json.last_id : null;
      if (json.has_more !== true || !afterId) break;
    }
    return models.slice(0, MAX_MODELS);
  },
  async call({ baseUrl, token, body, stream, signal }) {
    let payload: Record<string, unknown>;
    try {
      payload = toAnthropicRequest(body, stream);
    } catch (error) {
      if (error instanceof InvalidRequestError) return invalidRequest(error.message);
      throw error;
    }

    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": token,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) return res;

    const model = String(body.model);
    if (stream) {
      if (!res.body) throw new Error("Anthropic returned an empty stream");
      return respond(streamChunks(res.body, model), true);
    }
    const message: unknown = await res.json();
    if (!isRecord(message) || message.type !== "message") {
      throw new Error("Anthropic returned an unexpected response body");
    }
    return completion(messageChunks(message, model));
  },
};
