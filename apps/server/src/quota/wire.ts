import { QuotaError, type QuotaFailure } from "./types.ts";

export const QUOTA_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 512 * 1024;

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function normalizePercent(value: unknown): number | undefined {
  const n = toFiniteNumber(value);
  return n === undefined ? undefined : Math.max(0, Math.min(100, n));
}

/**
 * Epoch ms from the shapes upstreams use: epoch seconds or ms (number or numeric string) and ISO
 * strings. Zero and negative values are "no reset" sentinels, not dates.
 */
export function normalizeResetAt(value: unknown): number | null {
  const fromNumber = (n: number): number | null => {
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n > 10_000_000_000 ? n : n * 1000;
    return Number.isFinite(new Date(ms).getTime()) ? ms : null;
  };
  if (typeof value === "number") return fromNumber(value);
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    if (/^[+-]?\d+(\.\d+)?$/.test(text)) return fromNumber(Number(text));
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function failureForStatus(status: number): QuotaFailure {
  if (status === 401 || status === 403) return "access_denied";
  if (status === 429) return "rate_limited";
  return "upstream_error";
}

/** Classifies a thrown fetch/read error. `QuotaError`s already carry their diagnosis. */
export function failureForError(error: unknown): QuotaFailure {
  if (error instanceof QuotaError) return error.code;
  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return "timeout";
  return "transport_error";
}

/** Reads a JSON body of at most 512 KiB; anything else is `response_unusable`. */
export async function readQuotaJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new QuotaError("response_unusable");
  }
  const reader = res.body?.getReader();
  if (!reader) throw new QuotaError("response_unusable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new QuotaError("response_unusable");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new QuotaError("response_unusable");
  }
}
