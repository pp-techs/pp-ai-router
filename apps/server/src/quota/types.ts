/** One usage meter of an account, e.g. "Gemini 5h" or "Monthly credits". Times are epoch ms. */
export interface QuotaWindow {
  label: string;
  /** 0..100; how much of the allowance is spent. */
  usedPercent: number;
  resetsAt: number | null;
  /**
   * The model scope this meter gates (see `ModelScope`), e.g. `opus`. Absent = it gates the whole
   * account. A spent scoped window only stops requests for models of that scope.
   */
  scope?: string;
}

/** A group of models of one provider that share an allowance the rest of the account does not. */
export interface ModelScope {
  name: string;
  /**
   * A 429 for a model of this scope is taken to be this scope's own cap, so it cools the account down
   * for this scope only. Without it a 429 is taken to be shared and cools the whole account.
   */
  local: boolean;
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
  /**
   * Every window that gates the whole account was reported. Only a complete reading may lift a
   * scope's cooldown early: a reading without a shared window cannot say why a 429 happened.
   */
  complete?: boolean;
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
