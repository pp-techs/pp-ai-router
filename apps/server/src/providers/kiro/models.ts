// Adapted from lidge-jun/opencodex (MIT): src/providers/kiro-models.ts
import type { ModelInfo } from "../adapter.ts";

/**
 * Kiro has no discovery endpoint we can call per account, so this is a fixed list. Context windows
 * are the ones Kiro documents. Any other id still works as `kiro/<id>` (the router passes unknown
 * ids through); the reference also lists a few ids announced but not yet served by Kiro, which are
 * deliberately left out here because requests for them fail upstream.
 */
export const KIRO_MODELS: readonly ModelInfo[] = [
  { id: "kiro-auto" },
  { id: "gpt-5.6-sol", contextWindow: 1_000_000 },
  { id: "gpt-5.6-terra", contextWindow: 1_000_000 },
  { id: "gpt-5.6-luna", contextWindow: 1_000_000 },
  { id: "claude-sonnet-5", contextWindow: 1_000_000 },
  { id: "claude-opus-5", contextWindow: 1_000_000 },
  { id: "claude-opus-4.8", contextWindow: 1_000_000 },
  { id: "claude-opus-4.7", contextWindow: 1_000_000 },
  { id: "claude-opus-4.6", contextWindow: 1_000_000 },
  { id: "claude-opus-4.5", contextWindow: 200_000 },
  { id: "claude-sonnet-4.6", contextWindow: 1_000_000 },
  { id: "claude-sonnet-4.5", contextWindow: 200_000 },
  { id: "claude-sonnet-4.0", contextWindow: 200_000 },
  { id: "claude-haiku-4.5", contextWindow: 200_000 },
  { id: "deepseek-3.2", contextWindow: 128_000 },
  { id: "minimax-m2.5", contextWindow: 200_000 },
  { id: "minimax-m2.1", contextWindow: 200_000 },
  { id: "glm-5", contextWindow: 200_000 },
  { id: "qwen3-coder-next", contextWindow: 256_000 },
];
