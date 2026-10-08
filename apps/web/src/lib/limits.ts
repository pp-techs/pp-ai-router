import type { LimitInput, LimitMode, Metric } from "../api/types.ts";

export const METRIC_LABELS: Record<Metric, string> = {
  usd: "Spend (USD)",
  input_tokens: "Input tokens",
  output_tokens: "Output tokens",
  total_tokens: "Total tokens",
  requests: "Requests",
};

export const WINDOW_PRESETS = ["30m", "1h", "1d", "7d", "total"];

const UNIT_SECONDS: Record<string, number> = { m: 60, h: 3600, d: 86_400, w: 604_800 };

/** What the limit builder edits: `max` stays text until it is validated. */
export interface LimitDraft {
  metric: Metric;
  window: string;
  mode: LimitMode;
  max: string;
}

export const emptyLimitDraft = (): LimitDraft => ({
  metric: "usd",
  window: "1d",
  mode: "fixed",
  max: "",
});

/** Mirrors the server's `parseWindow`: "total", or <n><m|h|d|w>, at least a minute, whole hours above a day. */
export function windowError(window: string): string | null {
  if (window === "total") return null;
  const match = /^(\d+)([mhdw])$/.exec(window);
  if (!match) return `Invalid window "${window}" (use e.g. 30m, 1h, 1d, 7d or total).`;
  const seconds = Number(match[1]) * UNIT_SECONDS[match[2]!]!;
  if (seconds < 60) return "A window must be at least 1 minute.";
  if (seconds > 86_400 && seconds % 3600 !== 0) return "Windows over 1 day must be whole hours.";
  return null;
}

export type LimitResult = { ok: true; limit: LimitInput } | { ok: false; error: string };

export function validateLimit(draft: LimitDraft): LimitResult {
  const window = draft.window.trim();
  const problem = windowError(window);
  if (problem) return { ok: false, error: problem };
  const text = draft.max.trim();
  const max = Number(text);
  if (text === "" || !Number.isFinite(max) || max < 0)
    return { ok: false, error: "Enter a maximum of 0 or more." };
  if (draft.metric !== "usd" && !Number.isInteger(max))
    return { ok: false, error: "Token and request limits must be whole numbers." };
  return { ok: true, limit: { metric: draft.metric, window, mode: draft.mode, max } };
}

/** Fraction of a limit consumed, clamped to [0, 1]; an exhausted zero limit counts as full. */
export function usedFraction(used: number, max: number): number {
  if (max <= 0) return 1;
  return Math.min(1, Math.max(0, used / max));
}
