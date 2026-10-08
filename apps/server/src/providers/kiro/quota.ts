// Adapted from lidge-jun/opencodex (MIT): src/providers/kiro-usage.ts
import { QuotaError, type Quota, type QuotaCall, type QuotaWindow } from "../../quota/types.ts";
import {
  asRecord,
  failureForStatus,
  normalizePercent,
  normalizeResetAt,
  readQuotaJson,
  toFiniteNumber,
} from "../../quota/wire.ts";
import { resolveApiRegion, resolveIdentity } from "./wire.ts";

const AMZ_USAGE_TARGET = "AmazonCodeWhispererService.GetUsageLimits";
const CANONICAL_RUNTIME_HOST = /^runtime\.([a-z]{2}(?:-[a-z]+)+-\d)\.kiro\.dev$/i;

/**
 * Which usage bucket is the plan allowance, in preference order. Picking by position would let an
 * upstream reordering silently report an unrelated resource, so an unrecognised list is unusable.
 */
const RESOURCE_PRIORITY = ["AGENTIC_REQUEST", "CREDIT"] as const;

/**
 * Usage lives on `management.<region>.kiro.dev`, not on the runtime host that serves generation. A
 * canonical `runtime.<region>.kiro.dev` base URL maps to it; any other base URL (proxy, test double)
 * is used as given.
 */
export function usageEndpoint(baseUrl: string, region: string): string {
  const configured = new URL(baseUrl);
  if (CANONICAL_RUNTIME_HOST.test(configured.hostname) && configured.pathname === "/")
    return `https://management.${region}.kiro.dev/`;
  return configured.toString();
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Credit balances are fractional; the integer fields round 695.17 down to 695. */
const precise = (row: Record<string, unknown>, withPrecision: string, whole: string) =>
  toFiniteNumber(row[withPrecision]) ?? toFiniteNumber(row[whole]);

function selectBreakdown(list: unknown): Record<string, unknown> | null {
  if (!Array.isArray(list)) return null;
  const rows = list.map(asRecord).filter((row): row is Record<string, unknown> => row !== null);
  for (const wanted of RESOURCE_PRIORITY) {
    const match = rows.find((row) => text(row.resourceType).trim().toUpperCase() === wanted);
    if (match) return match;
  }
  return null;
}

/** `null` when the body is not a usage document we recognise: unknown, never a fabricated zero. */
export function parseKiroUsage(body: unknown): Quota | null {
  const payload = asRecord(body);
  const breakdown = selectBreakdown(payload?.usageBreakdownList);
  if (!payload || !breakdown) return null;

  const used = precise(breakdown, "currentUsageWithPrecision", "currentUsage");
  const limit = precise(breakdown, "usageLimitWithPrecision", "usageLimit");
  if (used === undefined || used < 0 || limit === undefined || limit <= 0) return null;
  const percent = normalizePercent((used / limit) * 100);
  if (percent === undefined) return null;

  const resetsAt = normalizeResetAt(payload.nextDateReset);
  const windows: QuotaWindow[] = [{ label: "Monthly credits", usedPercent: percent, resetsAt }];

  // A trial allowance is a separate pool: folding it into the plan window would understate what the
  // account can actually spend.
  const trial = asRecord(breakdown.freeTrialInfo);
  if (trial) {
    const trialUsed = precise(trial, "currentUsageWithPrecision", "currentUsage");
    const trialLimit = precise(trial, "usageLimitWithPrecision", "usageLimit");
    const trialPercent =
      trialUsed !== undefined && trialLimit !== undefined && trialLimit > 0
        ? normalizePercent((trialUsed / trialLimit) * 100)
        : undefined;
    if (trialPercent !== undefined)
      windows.push({ label: "Free trial", usedPercent: trialPercent, resetsAt: null });
  }

  // Enterprise accounts with overage enabled keep serving past the included limit, so "used >= limit"
  // alone is not a reason to stop routing to the account.
  const overage = text(asRecord(payload.overageConfiguration)?.overageStatus).trim().toUpperCase();

  return {
    windows,
    credits: { used, limit },
    exhausted: used >= limit && overage === "DISABLED",
    resetsAt,
  };
}

/**
 * One account's plan usage. `userInfo` in the response carries an email and user id; both are read
 * past and dropped, so nothing identifying reaches the cache, the admin API or a log line.
 */
export async function fetchKiroQuota(
  { baseUrl, token, meta, signal }: QuotaCall,
  doFetch: typeof fetch,
): Promise<Quota> {
  const { profileArn } = resolveIdentity(token, meta);
  // GetUsageLimits rejects a missing ARN with 400; an account whose profile was never captured must
  // sign in again rather than borrow another profile.
  if (!profileArn) throw new QuotaError("account_unavailable");

  const url = new URL(usageEndpoint(baseUrl, resolveApiRegion(meta)));
  url.searchParams.set("origin", "AI_EDITOR");
  url.searchParams.set("isEmailRequired", "true");
  url.searchParams.set("profileArn", profileArn);

  // The arguments appear in BOTH the query string and the body: that duplication is the observed
  // Kiro CLI contract, and which side the service reads is untestable from here, so both are sent.
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-amz-json-1.0",
      accept: "application/json",
      "x-amz-target": AMZ_USAGE_TARGET,
      "x-amzn-codewhisperer-optout": "true",
    },
    body: JSON.stringify({ origin: "AI_EDITOR", isEmailRequired: true, profileArn }),
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new QuotaError(failureForStatus(res.status), res.status);
  }
  const quota = parseKiroUsage(await readQuotaJson(res));
  if (!quota) throw new QuotaError("response_unusable");
  return quota;
}
