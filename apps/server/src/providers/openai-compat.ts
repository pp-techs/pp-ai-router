import type { ProviderAdapter } from "./adapter.ts";
import { httpError, parseOpenAiModels } from "./model-list.ts";

/** Any endpoint that speaks OpenAI `/chat/completions` (OpenAI, OpenRouter, Groq, DeepSeek, vLLM, Ollama, ...). */
export const openAiCompat: ProviderAdapter = {
  type: "openai-compat",
  label: "OpenAI-compatible",
  defaultBaseUrl: null,
  call({ baseUrl, token, body, signal }) {
    return fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
  },
  async listModels({ baseUrl, token, signal }) {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) throw await httpError("GET /models", res);
    return parseOpenAiModels(await res.json());
  },
};
