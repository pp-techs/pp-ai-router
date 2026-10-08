// Adapted from lidge-jun/opencodex (MIT): src/providers/quota/antigravity.ts
import { QuotaError, type Quota, type QuotaCall, type QuotaWindow } from "../../quota/types.ts";
import {
  asRecord,
  failureForError,
  failureForStatus,
  normalizePercent,
  normalizeResetAt,
  readQuotaJson,
  toFiniteNumber,
} from "../../quota/wire.ts";
import { API_VERSION, PROJECT_KEY, USER_AGENT } from "./constants.ts";

/** Some valid accounts reject the IDE fingerprint on quota accounting only. */
const FALLBACK_USER_AGENT = "antigravity/1.0";

/** Share of the allowance already spent, from either shape upstream uses for what remains. */
function usedPercent(info: Record<string, unknown>): number | undefined {
  const target = asRecord(info.remaining) ?? info;
  const fraction = toFiniteNumber(target.remainingFraction);
  const percentage = toFiniteNumber(target.remainingPercentage);
  const remaining = normalizePercent(
    fraction !== undefined
      ? fraction * 100
      : percentage !== undefined
        ? percentage * 100
        : undefined,
  );
  return remaining === undefined ? undefined : normalizePercent(100 - remaining);
}

type Family = "Gemini" | "Claude";

/** Gemini models, and Claude / third-party (gpt-oss) models, are separate allowances. */
function familyOf(text: string): Family | null {
  const haystack = text.toLowerCase();
  if (haystack.includes("gemini")) return "Gemini";
  if (/claude|opus|sonnet|gpt[-_]?oss|3p|gpt/.test(haystack)) return "Claude";
  return null;
}

const FAMILY_ORDER = [
  "Gemini 5h",
  "Gemini weekly",
  "Gemini",
  "Claude 5h",
  "Claude weekly",
  "Claude",
];

function ordered(windows: QuotaWindow[]): QuotaWindow[] {
  const rank = (label: string) => {
    const i = FAMILY_ORDER.indexOf(label);
    return i === -1 ? FAMILY_ORDER.length : i;
  };
  return [...windows].sort(
    (a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label),
  );
}

/**
 * `v1internal:retrieveUserQuotaSummary`: groups (Gemini, Claude/3P) holding 5-hour and weekly
 * buckets. Anything unrecognised is dropped; no window at all is `null` (unusable).
 */
export function parseQuotaSummary(body: unknown): Quota | null {
  const groups = asRecord(body)?.groups;
  if (!Array.isArray(groups)) return null;

  const windows = new Map<string, QuotaWindow>();
  const add = (window: QuotaWindow) => {
    if (!windows.has(window.label)) windows.set(window.label, window);
  };

  for (const raw of groups) {
    const group = asRecord(raw);
    if (!group || !Array.isArray(group.buckets)) continue;
    const name = typeof group.displayName === "string" ? group.displayName : "";
    const description = typeof group.description === "string" ? group.description : "";
    const family = familyOf(`${name} ${description}`);

    for (const rawBucket of group.buckets) {
      const bucket = asRecord(rawBucket);
      const used = bucket ? usedPercent(bucket) : undefined;
      if (!bucket || used === undefined) continue;
      const text = ["window", "bucketId", "displayName"]
        .map((k) => (typeof bucket[k] === "string" ? (bucket[k] as string) : ""))
        .join(" ")
        .toLowerCase();
      const weekly = text.includes("week");
      const fiveHour = text.includes("5h") || text.includes("five");
      const resetsAt = normalizeResetAt(bucket.resetTime);

      if (family) {
        if (fiveHour) add({ label: `${family} 5h`, usedPercent: used, resetsAt });
        else if (weekly) add({ label: `${family} weekly`, usedPercent: used, resetsAt });
      } else {
        const base = name || "Other";
        add({ label: weekly ? `${base} weekly` : base, usedPercent: used, resetsAt });
      }
    }
  }
  if (windows.size === 0) return null;
  return {
    windows: ordered([...windows.values()]),
    credits: null,
    exhausted: false,
    resetsAt: null,
  };
}

/** Older `fetchAvailableModels` fallback: one meter per family, from the models' quota info. */
export function parseModelQuotas(body: unknown): Quota | null {
  const models = asRecord(asRecord(body)?.models);
  if (!models) return null;

  const windows = new Map<Family, QuotaWindow>();
  for (const [id, raw] of Object.entries(models)) {
    const info = asRecord(raw);
    if (!info) continue;
    const entries: unknown[] = [];
    const quotaInfo = info.quotaInfo;
    if (Array.isArray(quotaInfo)) entries.push(...quotaInfo);
    else if (quotaInfo) entries.push(quotaInfo);
    if (Array.isArray(info.quotaInfos)) entries.push(...info.quotaInfos);
    for (const tiered of Object.values(asRecord(info.quotaInfoByTier) ?? {}))
      entries.push(...(Array.isArray(tiered) ? tiered : [tiered]));

    for (const rawEntry of entries) {
      const entry = asRecord(rawEntry);
      if (!entry) continue;
      const display = typeof info.displayName === "string" ? info.displayName : "";
      const tier = typeof entry.tier === "string" ? entry.tier : "";
      const family = familyOf(`${id} ${display} ${tier}`);
      const used = usedPercent(entry);
      if (!family || used === undefined || windows.has(family)) continue;
      windows.set(family, {
        label: family,
        usedPercent: used,
        resetsAt: normalizeResetAt(entry.resetTime),
      });
    }
  }
  if (windows.size === 0) return null;
  return {
    windows: ordered([...windows.values()]),
    credits: null,
    exhausted: false,
    resetsAt: null,
  };
}

/**
 * One account's quota: the quota summary, falling back to the models listing when the summary is
 * unusable. A 401 (expired token) or an access refusal ends the probe: the fallback would be refused
 * too, and the caller refreshes the token.
 */
export async function fetchAntigravityQuota(
  { baseUrl, token, meta, signal }: QuotaCall,
  doFetch: typeof fetch,
): Promise<Quota> {
  const project = meta[PROJECT_KEY];
  if (!project) throw new QuotaError("account_unavailable");
  const root = baseUrl.replace(/\/+$/, "");
  const post = (method: string, userAgent = USER_AGENT) =>
    doFetch(`${root}/${API_VERSION}:${method}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": userAgent,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ project }),
      signal,
    });
  const discard = (res: Response) => res.body?.cancel().catch(() => {});

  let summaryFailure: QuotaError | null = null;
  try {
    let res = await post("retrieveUserQuotaSummary");
    if (res.status === 403) {
      await discard(res);
      res = await post("retrieveUserQuotaSummary", FALLBACK_USER_AGENT);
    }
    if (res.status === 401 || res.status === 403) {
      await discard(res);
      throw new QuotaError("access_denied", res.status);
    }
    if (res.ok) {
      const quota = parseQuotaSummary(await readQuotaJson(res));
      if (quota) return quota;
      summaryFailure = new QuotaError("response_unusable");
    } else {
      await discard(res);
      summaryFailure = new QuotaError(failureForStatus(res.status), res.status);
    }
  } catch (error) {
    if (error instanceof QuotaError && error.code === "access_denied") throw error;
    summaryFailure = new QuotaError(failureForError(error));
  }

  try {
    const res = await post("fetchAvailableModels");
    if (!res.ok) {
      await discard(res);
      throw new QuotaError(failureForStatus(res.status), res.status);
    }
    const quota = parseModelQuotas(await readQuotaJson(res));
    if (quota) return quota;
    throw new QuotaError("response_unusable");
  } catch (error) {
    const fallback = error instanceof QuotaError ? error : new QuotaError(failureForError(error));
    // A vaguer fallback diagnosis must not hide a more specific summary one (e.g. a rate limit).
    throw summaryFailure &&
      summaryFailure.code !== "response_unusable" &&
      fallback.code === "response_unusable"
      ? summaryFailure
      : fallback;
  }
}
