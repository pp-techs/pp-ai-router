// Adapted from can1357/oh-my-pi (MIT): packages/catalog src/models.json (provider `openai-codex`),
// compat/rules/providers/openai-codex.kdl (context windows, the 1M floor of GPT-5.6), discovery/codex.ts.
import type { ModelInfo } from "../adapter.ts";

const model = (id: string, name: string, contextWindow: number): ModelInfo => ({
  id,
  name,
  contextWindow,
  maxOutputTokens: 128_000,
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  // `max_tokens`, `temperature` and the other sampling parameters are deliberately absent: the Codex
  // backend refuses them, so the adapter does not forward them.
  supportedParameters: [
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "include_reasoning",
    "response_format",
    "structured_outputs",
    "verbosity",
  ],
});

/**
 * The chat models omp's catalog ships for `openai-codex` (all text + image in, 128k output, effort ladder
 * low..max). The Codex backend lists models per client version and account (`/codex/models`, which omp
 * fetches live); the router has no live listing, so this is omp's bundled list. Windows are omp's
 * effective ones: GPT-5.6 Luna/Sol/Terra 1M (the registry still reports 272k; a floor in the KDL rules),
 * GPT-6.1 Sol 500k, GPT-6 272k. Left out like omp's pickers: the Daybreak cyber programme (account-gated
 * by access programs) and `gpt-image-2` (an image tool, not a chat model). Any other id still works as
 * `chatgpt-subscription/<id>` (the router passes unknown ids through) and fails upstream if the account
 * cannot use it. Which of these an account may use depends on its plan.
 */
export const CODEX_MODELS: readonly ModelInfo[] = [
  model("gpt-6.1-sol", "GPT-6.1 Sol", 500_000),
  model("gpt-6-sol", "GPT-6 Sol", 272_000),
  model("gpt-6-luna", "GPT-6 Luna", 272_000),
  model("gpt-6-astra", "GPT-6 Astra", 272_000),
  model("gpt-5.6-sol", "GPT-5.6 Sol", 1_000_000),
  model("gpt-5.6-terra", "GPT-5.6 Terra", 1_000_000),
  model("gpt-5.6-luna", "GPT-5.6 Luna", 1_000_000),
];
