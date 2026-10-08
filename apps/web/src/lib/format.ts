import type { Metric, PriceTier } from "../api/types.ts";

// Numbers are always en-US so "$" and separators read the same everywhere; dates follow the browser locale.
const int = new Intl.NumberFormat("en-US");
const MIN_USD = 1e-8;

export const formatInt = (n: number) => int.format(n);

/** USD with at least cents, and as many decimals as it takes to show three significant digits of a tiny amount. */
export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  const abs = Math.abs(value);
  if (abs < MIN_USD) return `<$${MIN_USD.toFixed(8)}`;
  const maxDigits = abs >= 1 ? 2 : Math.min(8, Math.floor(-Math.log10(abs)) + 3);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDigits,
  }).format(value);
}

export const formatPer1m = (value: number | null) => (value === null ? "—" : formatUsd(value));

export const formatMetric = (metric: Metric, value: number) =>
  metric === "usd" ? formatUsd(value) : formatInt(value);

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export const formatDateTime = (ms: number) => new Date(ms).toLocaleString();

/** "3d 4h", "2h 5m", "45s": the two largest non-zero units of a duration. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const units: [string, number][] = [
    ["d", 86_400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];
  const parts: string[] = [];
  let rest = total;
  for (const [unit, size] of units) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0) parts.push(`${count}${unit}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "0s";
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });
const PER_MILLION = 1_000_000;

/** Long-context tier, e.g. "> 200K tokens: in $6 · out $22.50"; tier prices arrive per single token. */
export function formatTier(tier: PriceTier): string {
  const prices = (
    [
      ["in", tier.input],
      ["out", tier.output],
      ["cache read", tier.cacheRead],
      ["cache write", tier.cacheWrite],
    ] as const
  ).flatMap(([label, perToken]) =>
    perToken === undefined
      ? []
      : [`${label} ${formatUsd(Number((perToken * PER_MILLION).toPrecision(12)))}`],
  );
  return `> ${compact.format(tier.aboveTokens)} tokens: ${prices.join(" · ")}`;
}
