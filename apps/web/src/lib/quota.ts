import type { QuotaCredits, QuotaFailure } from "../api/types.ts";

const FAILURES: Record<QuotaFailure, string> = {
  account_unavailable:
    "The account cannot be queried right now (retired credential, missing project or profile, or sign-in failed). Re-authorize it.",
  access_denied: "Access denied: the credential was rejected. Re-authorize it.",
  rate_limited: "The upstream rate-limited the quota check. Try again later.",
  upstream_error: "The upstream failed to answer the quota check.",
  timeout: "The quota check timed out.",
  transport_error: "Could not reach the upstream.",
  response_unusable: "The upstream answered with data that could not be read.",
};

export const describeFailure = (code: QuotaFailure | null): string =>
  code === null ? "Quota is unavailable." : (FAILURES[code] ?? "Quota is unavailable.");

const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** "12.5 / 50 credits": up to two decimals, no trailing zeros. */
export const formatCredits = ({ used, limit }: QuotaCredits): string =>
  `${amount.format(used)} / ${amount.format(limit)} credits`;

/** Used share as a 0–1 meter fraction, clamped to the valid range. */
export const quotaFraction = (percent: number): number =>
  Number.isFinite(percent) ? Math.min(Math.max(percent / 100, 0), 1) : 0;
