// Adapted from lidge-jun/opencodex (MIT): src/providers/kiro-models.ts
import type { ModelInfo } from "../adapter.ts";

/**
 * The reference's model list is static too (its `ListAvailableModels` call only feeds per-account routing
 * evidence, never the list), so this is a fixed list. Context windows are the ones Kiro documents. Any
 * other id still works as `kiro/<id>` (the router passes unknown ids through). Like the reference, the
 * list also carries ids announced ahead of Kiro's catalog (Claude Sonnet 5.5, Opus 5.5, Haiku 5.5):
 * requests for them fail upstream until Kiro ships them. GPT-6 Sol/Luna and GPT-6.1 Sol, which the
 * reference lists the same way, are left out. Checked against https://kiro.dev/docs/models/
 * (updated 2026-10-08). Claude Fable 5.1 (Enterprise-only preview, us-east-1) is not listed either.
 */
export const KIRO_MODELS: readonly ModelInfo[] = [
  { id: "kiro-auto" },
  { id: "gpt-5.6-sol", contextWindow: 1_000_000 },
  { id: "gpt-5.6-terra", contextWindow: 1_000_000 },
  { id: "gpt-5.6-luna", contextWindow: 1_000_000 },
  { id: "claude-sonnet-5.5", contextWindow: 1_000_000 },
  { id: "claude-sonnet-5", contextWindow: 1_000_000 },
  { id: "claude-opus-5.5", contextWindow: 1_000_000 },
  { id: "claude-opus-5", contextWindow: 1_000_000 },
  { id: "claude-opus-4.8", contextWindow: 1_000_000 },
  { id: "claude-opus-4.7", contextWindow: 1_000_000 },
  { id: "claude-opus-4.6", contextWindow: 1_000_000 },
  { id: "claude-opus-4.5", contextWindow: 200_000 },
  { id: "claude-sonnet-4.6", contextWindow: 1_000_000 },
  { id: "claude-sonnet-4.5", contextWindow: 200_000 },
  { id: "claude-sonnet-4.0", contextWindow: 200_000 },
  { id: "claude-haiku-4.5", contextWindow: 200_000 },
  { id: "claude-haiku-5.5", contextWindow: 1_000_000 },
  { id: "deepseek-3.2", contextWindow: 128_000 },
  { id: "minimax-m2.5", contextWindow: 200_000 },
  { id: "minimax-m2.1", contextWindow: 200_000 },
  { id: "glm-5", contextWindow: 200_000 },
  { id: "qwen3-coder-next", contextWindow: 256_000 },
];
