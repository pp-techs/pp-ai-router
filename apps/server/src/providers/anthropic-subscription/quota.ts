// Adapted from lidge-jun/opencodex (MIT): src/providers/quota/vendor-probes-oauth.ts
import { QuotaError, type Quota, type QuotaCall, type QuotaWindow } from "../../quota/types.ts";
import {
  asRecord,
  failureForError,
  failureForStatus,
  normalizePercent,
  normalizeResetAt,
  readQuotaJson,
} from "../../quota/wire.ts";
import { CLI_USER_AGENT, USAGE_BETA } from "./constants.ts";

/** Model families the usage endpoint reports a weekly allowance for, by the word in their display name. */
const FAMILIES = ["Fable", "Opus", "Sonnet"] as const;

/** `{ utilization, resets_at }`; a bucket without a utilization is no meter. */
function bucketWindow(label: string, value: unknown): QuotaWindow | null {
  const bucket = asRecord(value);
  const used = normalizePercent(bucket?.utilization);
  return bucket && used !== undefined
    ? { label, usedPercent: used, resetsAt: normalizeResetAt(bucket.resets_at) }
    : null;
}

/** A `weekly_scoped` entry of `limits`: `{ percent, resets_at, scope: { model: { display_name } } }`. */
function scopedLimitWindow(value: unknown): QuotaWindow | null {
  const limit = asRecord(value);
  if (!limit || limit.kind !== "weekly_scoped") return null;
  const used = normalizePercent(limit.percent);
  const displayName = asRecord(asRecord(limit.scope)?.model)?.display_name;
  const name = typeof displayName === "string" ? displayName.toLowerCase() : "";
  // A label is never taken from upstream text: only a recognised family is published.
  const family = FAMILIES.find((f) => name.includes(f.toLowerCase()));
  return used !== undefined && family
    ? { label: `${family} weekly`, usedPercent: used, resetsAt: normalizeResetAt(limit.resets_at) }
    : null;
}

/**
 * `GET /api/oauth/usage`: a 5-hour and a weekly allowance for the whole account, plus weekly ones for
 * single model families. The account is out of allowance (parked until the reset) when either shared
 * window is spent; a spent family window only closes that family, so it never exhausts the account.
 */
export function parseUsage(body: unknown): Quota | null {
  const usage = asRecord(body);
  if (!usage) return null;

  const shared = [
    bucketWindow("5h", usage.five_hour),
    bucketWindow("Weekly", usage.seven_day),
  ].filter((w): w is QuotaWindow => w !== null);

  const scoped = new Map<string, QuotaWindow>();
  for (const family of FAMILIES) {
    const window = bucketWindow(`${family} weekly`, usage[`seven_day_${family.toLowerCase()}`]);
    if (window) scoped.set(window.label, window);
  }
  for (const raw of Array.isArray(usage.limits) ? usage.limits : []) {
    const window = scopedLimitWindow(raw);
    if (window && !scoped.has(window.label)) scoped.set(window.label, window);
  }

  const windows = [...shared, ...scoped.values()];
  if (windows.length === 0) return null;

  const spent = shared.filter((w) => w.usedPercent >= 100);
  const resets = spent.map((w) => w.resetsAt);
  return {
    windows,
    credits: null,
    exhausted: spent.length > 0,
    // The account is back once every spent window has rolled over; unknown if any reset is.
    resetsAt:
      spent.length > 0 && resets.every((r) => r !== null)
        ? Math.max(...(resets as number[]))
        : null,
  };
}

/** One account's usage, read with that account's own token. */
export async function fetchAnthropicQuota(
  { baseUrl, token, signal }: QuotaCall,
  doFetch: typeof fetch,
): Promise<Quota> {
  let res: Response;
  try {
    res = await doFetch(new URL("/api/oauth/usage", baseUrl), {
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": CLI_USER_AGENT,
        "anthropic-beta": USAGE_BETA,
        authorization: `Bearer ${token}`,
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
