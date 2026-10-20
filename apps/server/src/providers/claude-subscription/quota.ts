// Adapted from can1357/oh-my-pi (MIT) and lidge-jun/opencodex (MIT): omp packages/ai/src/usage/{claude,claude-api}.ts;
// opencodex src/providers/quota/vendor-probes-oauth.ts.
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
} from "../../quota/wire.ts";
import { ACCOUNT_BETAS } from "./constants.ts";
import { cliUserAgent } from "./identity.ts";

/** Model families the usage endpoint reports a weekly allowance for, by the word in their display name. */
const FAMILIES = ["Fable", "Mythos", "Opus", "Sonnet"] as const;

/** Families whose weekly cap is their own: a 429 for them says nothing about the rest of the account. */
const LOCAL_FAMILIES: readonly string[] = ["fable", "mythos"];

/** The scope of a model id: its family, when it is one of those with a weekly allowance of its own. */
export function modelScope(model: string): ModelScope | undefined {
  const id = model.toLowerCase();
  const family = FAMILIES.find((f) => id.includes(f.toLowerCase()))?.toLowerCase();
  return family ? { name: family, local: LOCAL_FAMILIES.includes(family) } : undefined;
}

/** `{ utilization, resets_at }`; a bucket without a utilization is no meter. */
function bucketWindow(label: string, value: unknown, scope?: string): QuotaWindow | null {
  const bucket = asRecord(value);
  const used = normalizePercent(bucket?.utilization);
  return bucket && used !== undefined
    ? {
        label,
        usedPercent: used,
        resetsAt: normalizeResetAt(bucket.resets_at),
        ...(scope === undefined ? {} : { scope }),
      }
    : null;
}

/** A `weekly_scoped` entry of `limits`: `{ percent, resets_at, scope: { model: { display_name } } }`. */
function scopedLimitWindow(value: unknown): QuotaWindow | null {
  const limit = asRecord(value);
  if (
    !limit ||
    typeof limit.kind !== "string" ||
    limit.kind.trim().toLowerCase() !== "weekly_scoped"
  )
    return null;
  const used = normalizePercent(limit.percent);
  const displayName = asRecord(asRecord(limit.scope)?.model)?.display_name;
  const name = typeof displayName === "string" ? displayName.toLowerCase() : "";
  // A label is never taken from upstream text: only a recognised family is published.
  const family = FAMILIES.find((f) => name.includes(f.toLowerCase()));
  return used !== undefined && family
    ? {
        label: `${family} weekly`,
        usedPercent: used,
        resetsAt: normalizeResetAt(limit.resets_at),
        scope: family.toLowerCase(),
      }
    : null;
}

/** The account is out of allowance when a shared window is spent, and back once every spent one has rolled over. */
function sharedExhaustion(shared: QuotaWindow[]): Pick<Quota, "exhausted" | "resetsAt"> {
  const spent = shared.filter((w) => w.usedPercent >= 100);
  const resets = spent.map((w) => w.resetsAt);
  return {
    exhausted: spent.length > 0,
    // Unknown if any reset is.
    resetsAt:
      spent.length > 0 && resets.every((r) => r !== null)
        ? Math.max(...(resets as number[]))
        : null,
  };
}

/**
 * `GET /api/oauth/usage`: a 5-hour and a weekly allowance for the whole account, plus weekly ones for
 * single model families (scoped: a spent one stops that family only, never the account).
 */
export function parseUsage(body: unknown): Quota | null {
  const usage = asRecord(body);
  if (!usage) return null;
  const limits = Array.isArray(usage.limits) ? usage.limits : [];

  /** An account-wide window that older payloads carry only as a `limits` entry (`session`, `weekly_all`). */
  const limitBucket = (kind: string) => {
    const entry = limits
      .map(asRecord)
      .find((l) => typeof l?.kind === "string" && l.kind.trim().toLowerCase() === kind);
    return entry ? { utilization: entry.percent, resets_at: entry.resets_at } : undefined;
  };

  const shared = [
    bucketWindow("5h", usage.five_hour) ?? bucketWindow("5h", limitBucket("session")),
    bucketWindow("Weekly", usage.seven_day) ?? bucketWindow("Weekly", limitBucket("weekly_all")),
  ].filter((w): w is QuotaWindow => w !== null);

  const scoped = new Map<string, QuotaWindow>();
  // The legacy per-model buckets omp reads; Fable and Mythos only ever arrive as scoped `limits` entries.
  for (const family of ["Opus", "Sonnet"]) {
    const window = bucketWindow(
      `${family} weekly`,
      usage[`seven_day_${family.toLowerCase()}`],
      family.toLowerCase(),
    );
    if (window) scoped.set(window.label, window);
  }
  for (const raw of limits) {
    const window = scopedLimitWindow(raw);
    if (window && !scoped.has(window.label)) scoped.set(window.label, window);
  }

  const windows = [...shared, ...scoped.values()];
  if (windows.length === 0) return null;

  return {
    windows,
    credits: null,
    ...sharedExhaustion(shared),
    // Only a reading of both shared windows can vouch that a spent family is not a shared wall.
    complete: shared.length === 2,
  };
}

/** A header carrying a number, or undefined. */
function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * What the `anthropic-ratelimit-unified-*` headers of an inference answer (a refusal too) say about
 * the account: utilization as a fraction and the reset in epoch seconds for the 5-hour window (`5h`),
 * the weekly one (`7d`) and the Fable weekly one (`7d_oi`). Never complete, so it can park but not heal.
 */
export function parseRateLimitHeaders(headers: Headers): Quota | null {
  const read = (id: string, label: string, scope?: string): QuotaWindow | null => {
    const used = headerNumber(headers, `anthropic-ratelimit-unified-${id}-utilization`);
    const reset = headerNumber(headers, `anthropic-ratelimit-unified-${id}-reset`);
    if (used === undefined) return null;
    return {
      label,
      usedPercent: Math.min(100, Math.max(0, used * 100)),
      resetsAt: reset !== undefined && reset > 0 ? reset * 1000 : null,
      ...(scope === undefined ? {} : { scope }),
    };
  };
  const shared = [read("5h", "5h"), read("7d", "Weekly")].filter(
    (w): w is QuotaWindow => w !== null,
  );
  const fable = read("7d_oi", "Fable weekly", "fable");
  const windows = fable ? [...shared, fable] : shared;
  return windows.length > 0 ? { windows, credits: null, ...sharedExhaustion(shared) } : null;
}

/** The canonical account API root; `${root}/api/oauth/usage` is the subscription usage route. */
const DEFAULT_API_ROOT = "https://api.anthropic.com";

/** Statuses that answer "this host does not implement the endpoint" (omp's `ENDPOINT_ABSENT_STATUSES`). */
const ENDPOINT_ABSENT_STATUSES: readonly number[] = [404, 405, 410, 501];

/**
 * omp's `normalizeClaudeApiBaseUrl`: the API root of a Messages (`/v1`) or OAuth (`/api/oauth`) base URL,
 * keeping a proxy's path prefix; the canonical root when the URL is unusable.
 */
function apiRoot(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return DEFAULT_API_ROOT;
  }
  let path = url.pathname.replace(/\/+$/, "");
  const lower = path.toLowerCase();
  if (lower.endsWith("/api/oauth")) path = path.slice(0, -"/api/oauth".length);
  else if (lower.endsWith("/v1")) path = path.slice(0, -"/v1".length);
  return `${url.origin}${path}`;
}

/**
 * One account's usage, read with that account's own token. A host that does not serve the endpoint is
 * given up on for the canonical one (omp's `claudeOAuthBaseUrls`); any other failure is that host's
 * answer about this account. The provider's custom headers go only to the configured host.
 */
export async function fetchAnthropicQuota(
  { baseUrl, token, headers, signal }: QuotaCall,
  doFetch: typeof fetch,
): Promise<Quota> {
  const urls = [
    ...new Set([`${apiRoot(baseUrl)}/api/oauth/usage`, `${DEFAULT_API_ROOT}/api/oauth/usage`]),
  ];
  for (const [index, url] of urls.entries()) {
    const last = index === urls.length - 1;
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-encoding": "gzip, compress, deflate, br",
          "anthropic-beta": ACCOUNT_BETAS,
          "content-type": "application/json",
          connection: "keep-alive",
          "user-agent": cliUserAgent(),
          authorization: `Bearer ${token}`,
          ...(index === 0 ? headers : {}),
        },
        signal,
      });
    } catch (error) {
      throw new QuotaError(failureForError(error));
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (!last && ENDPOINT_ABSENT_STATUSES.includes(res.status)) continue;
      throw new QuotaError(failureForStatus(res.status), res.status);
    }
    let body: unknown;
    try {
      body = await readQuotaJson(res);
    } catch (error) {
      if (!last && error instanceof QuotaError && error.code === "response_unusable") continue;
      throw error;
    }
    const quota = parseUsage(body);
    if (quota) return quota;
    // A body with none of the usage keys is a host answering something else at this path (omp's `looksLikeUsagePayload`).
    const usageShaped =
      asRecord(body) !== null &&
      ["five_hour", "seven_day", "limits", "extra_usage", "spend"].some(
        (key) => key in (body as object),
      );
    if (last || usageShaped) throw new QuotaError("response_unusable");
  }
  throw new QuotaError("response_unusable");
}
