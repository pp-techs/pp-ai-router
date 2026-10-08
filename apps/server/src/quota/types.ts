/** One usage meter of an account, e.g. "Gemini 5h" or "Monthly credits". Times are epoch ms. */
export interface QuotaWindow {
  label: string;
  /** 0..100; how much of the allowance is spent. */
  usedPercent: number;
  resetsAt: number | null;
}

export interface Quota {
  windows: QuotaWindow[];
  /** Plan credits when the provider counts them (Kiro); null otherwise. */
  credits: { used: number; limit: number } | null;
  /**
   * The whole account is out of allowance and cannot overspend: the pool parks it until `resetsAt`.
   * Per-model windows (Antigravity) never set this, because the account still serves other models.
   */
  exhausted: boolean;
  /** When the allowance rolls over, if the upstream says. */
  resetsAt: number | null;
}

/** Closed diagnoses of a failed probe; never upstream text, URLs or credentials. */
export const QUOTA_FAILURES = [
  "account_unavailable",
  "access_denied",
  "rate_limited",
  "upstream_error",
  "timeout",
  "transport_error",
  "response_unusable",
] as const;
export type QuotaFailure = (typeof QUOTA_FAILURES)[number];

export class QuotaError extends Error {
  readonly code: QuotaFailure;
  readonly status: number | undefined;

  constructor(code: QuotaFailure, status?: number, options?: ErrorOptions) {
    super(status === undefined ? code : `${code} (HTTP ${status})`, options);
    this.code = code;
    this.status = status;
  }
}

/** What a provider adapter needs to read one account's quota. */
export interface QuotaCall {
  baseUrl: string;
  token: string;
  meta: Readonly<Record<string, string>>;
  signal: AbortSignal;
}
