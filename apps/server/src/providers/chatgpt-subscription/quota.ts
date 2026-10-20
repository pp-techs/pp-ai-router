// Adapted from can1357/oh-my-pi (MIT): packages/ai usage/openai-codex.ts (windows, labels, credit overage,
// Spark meter, `x-codex-*` headers, request headers), usage/openai-codex-base-url.ts;
// lidge-jun/opencodex (MIT): src/codex/quota.ts for the shape of the router's `Quota`.
import {
  QuotaError,
  type ModelScope,
  type Quota,
  type QuotaCall,
  type QuotaWindow,
} from "../../quota/types.ts";
import {
  asRecord,
  failureForError,
  failureForStatus,
  normalizePercent,
  normalizeResetAt,
  readQuotaJson,
  toFiniteNumber,
} from "../../quota/wire.ts";
import { accountApiBase, USER_AGENT } from "./constants.ts";
import { accountIdOf } from "./wire.ts";

/** The scope of the Spark models: the account has a separate allowance for them, and a 429 there is only theirs. */
const SPARK_SCOPE = "spark";

export function modelScope(model: string): ModelScope | undefined {
  return /spark/i.test(model) ? { name: SPARK_SCOPE, local: true } : undefined;
}

/** What a window that does not say how long it is is called, by position (omp). */
const FALLBACK_LABELS = ["Primary window", "Secondary window"] as const;

/** omp `buildWindowLabel`: `300` s -> `5 hours`, `604800` s -> `7 days`; unknown durations have no label. */
function durationLabel(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  const unit = (value: number, name: "hour" | "day") =>
    `${value} ${value === 1 ? name : `${name}s`}`;
  if (seconds >= 86_400) return unit(Math.round(seconds / 86_400), "day");
  return unit(Math.max(1, Math.round(seconds / 3600)), "hour");
}

/** The same label may not name two windows: the later one gets its position behind it. */
function uniqueLabels(windows: QuotaWindow[]): QuotaWindow[] {
  const seen: string[] = [];
  return windows.map((w) => {
    const label = seen.includes(w.label) ? `${w.label} (${seen.length + 1})` : w.label;
    seen.push(label);
    return label === w.label ? w : { ...w, label };
  });
}

/**
 * `{ used_percent, limit_window_seconds, reset_at, reset_after_seconds }`. A window that does not say how
 * long it is takes `fallback`; one without a usage is no meter.
 */
function usageWindow(
  value: unknown,
  fallback: string,
  now: number,
  scope?: string,
): QuotaWindow | null {
  const window = asRecord(value);
  const used = normalizePercent(window?.used_percent);
  if (!window || used === undefined) return null;
  const after = toFiniteNumber(window.reset_after_seconds);
  return {
    label: durationLabel(toFiniteNumber(window.limit_window_seconds)) ?? fallback,
    usedPercent: used,
    resetsAt:
      normalizeResetAt(window.reset_at) ??
      (after !== undefined && after >= 0 ? now + after * 1000 : null),
    ...(scope === undefined ? {} : { scope }),
  };
}

/** The account is out of allowance when a shared window is spent, and back once every spent one has rolled over. */
function exhaustion(
  shared: QuotaWindow[],
  blocked: boolean,
): Pick<Quota, "exhausted" | "resetsAt"> {
  const spent = shared.filter((w) => w.usedPercent >= 100);
  const resets = spent.map((w) => w.resetsAt);
  return {
    exhausted: blocked,
    // Unknown if any reset is.
    resetsAt:
      blocked && spent.length > 0 && resets.every((r) => r !== null)
        ? Math.max(...(resets as number[]))
        : null,
  };
}

/**
 * Whether paid credits keep the account serving past a spent plan window (omp `hasPlanCreditOverage`).
 * `/wham/usage` only describes the plan's allowance; the Codex CLI itself never gates on it, so an
 * account with credits is not parked. Only a spent plan verdict (`limit_reached: true`) is covered.
 */
function creditsCoverOverage(usage: Record<string, unknown>, planLimitReached: unknown): boolean {
  if (planLimitReached !== true) return false;
  const credits = asRecord(usage.credits);
  if (!credits || (credits.unlimited !== true && credits.has_credits !== true)) return false;
  if (credits.overage_limit_reached === true) return false;
  return asRecord(usage.spend_control)?.reached !== true;
}

/**
 * `GET /backend-api/wham/usage`: the plan's short (5-hour) and weekly allowance for the whole account, the
 * account's own verdict (`allowed` / `limit_reached`) and, per metered feature, extra allowances. Only the
 * Spark one maps to models of ours (scoped: a spent one stops those models only, never the account).
 */
export function parseUsage(body: unknown, now = Date.now()): Quota | null {
  const usage = asRecord(body);
  const rateLimit = asRecord(usage?.rate_limit);
  if (!usage || !rateLimit) return null;

  const raw = [rateLimit.primary_window, rateLimit.secondary_window];
  const parsed = raw.map((w, i) => usageWindow(w, FALLBACK_LABELS[i]!, now));
  const shared = uniqueLabels(parsed.filter((w): w is QuotaWindow => w !== null));

  const scoped: QuotaWindow[] = [];
  for (const extra of Array.isArray(usage.additional_rate_limits)
    ? usage.additional_rate_limits
    : []) {
    const entry = asRecord(extra);
    const limit = asRecord(entry?.rate_limit);
    const feature = [entry?.limit_name, entry?.metered_feature].filter(
      (v) => typeof v === "string",
    );
    if (!limit || !/spark|bengalfox/i.test(feature.join(" "))) continue;
    for (const [i, w] of [limit.primary_window, limit.secondary_window].entries()) {
      const window = usageWindow(w, FALLBACK_LABELS[i]!, now, SPARK_SCOPE);
      if (window) scoped.push({ ...window, label: `${window.label} (Spark)` });
    }
  }

  const windows = [...shared, ...uniqueLabels(scoped)];
  if (windows.length === 0) return null;

  // An explicit verdict outranks the percentages: a window at 100% that Codex still allows is a warning.
  const { allowed, limit_reached: limitReached } = rateLimit;
  const blocked =
    allowed === false || limitReached === true
      ? true
      : allowed === true
        ? false
        : shared.some((w) => w.usedPercent >= 100);
  return {
    windows,
    credits: null,
    ...exhaustion(shared, blocked && !creditsCoverOverage(usage, limitReached)),
    // Only a reading of every window the account reports can vouch that a spent Spark window is not a shared wall.
    complete: shared.length > 0 && parsed.filter((w, i) => w === null && raw[i]).length === 0,
  };
}

/** A header carrying a number, or undefined. */
function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  return raw ? toFiniteNumber(raw) : undefined;
}

/**
 * What the `x-codex-{primary,secondary}-*` headers of an inference answer (a refusal too) say
 * about the account: used percent, window length in minutes and the reset in epoch seconds. An answer that
 * succeeded is proof the account was still served, so a window at 100% then is not an exhaustion (credits
 * may fund the overage). Never complete, so it can park but not heal.
 */
export function parseRateLimitHeaders(headers: Headers, succeeded: boolean): Quota | null {
  const windows = (["primary", "secondary"] as const).flatMap((key, i) => {
    const used = headerNumber(headers, `x-codex-${key}-used-percent`);
    if (used === undefined) return [];
    const minutes = headerNumber(headers, `x-codex-${key}-window-minutes`);
    const reset = normalizeResetAt(headerNumber(headers, `x-codex-${key}-reset-at`));
    return [
      {
        label:
          durationLabel(minutes === undefined ? undefined : minutes * 60) ?? FALLBACK_LABELS[i]!,
        usedPercent: Math.min(100, Math.max(0, used)),
        resetsAt: reset,
      } satisfies QuotaWindow,
    ];
  });
  if (windows.length === 0) return null;
  const shared = uniqueLabels(windows);
  return {
    windows: shared,
    credits: null,
    ...exhaustion(shared, !succeeded && shared.some((w) => w.usedPercent >= 100)),
  };
}

/** One account's usage, read with that account's own token. */
export async function fetchCodexQuota(
  { baseUrl, token, meta, headers, signal }: QuotaCall,
  doFetch: typeof fetch,
): Promise<Quota> {
  const account = accountIdOf(token, meta);
  let res: Response;
  try {
    res = await doFetch(`${accountApiBase(baseUrl)}/wham/usage`, {
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": USER_AGENT,
        ...(account ? { "chatgpt-account-id": account } : {}),
        ...headers,
      },
      signal,
    });
  } catch (error) {
    throw new QuotaError(failureForError(error));
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new QuotaError(failureForStatus(res.status), res.status);
  }
  const quota = parseUsage(await readQuotaJson(res));
  if (!quota) throw new QuotaError("response_unusable");
  return quota;
}
