// Adapted from lidge-jun/opencodex (MIT)
import { errorBody } from "../../errors.ts";

const DETAIL_KEYS = [
  "__type",
  "code",
  "error",
  "name",
  "reason",
  "message",
  "Message",
  "errorMessage",
];
const MAX_DETAIL_CHARS = 500;
const MAX_ERROR_BODY_CHARS = 64 * 1024;

export interface KiroFailure {
  /** HTTP status to report; equals the upstream status unless the body shows a more precise class. */
  status: number;
  code: string;
  message: string;
}

/** Control characters and bearer tokens never belong in an error surfaced to a client. */
function sanitize(text: string): string {
  return (
    text
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .trim()
  );
}

function payloadDetails(payloadText: string): string[] {
  const trimmed = payloadText.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("{")) return [trimmed];
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return DETAIL_KEYS.map((key) => parsed[key]).filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
  } catch {
    return [];
  }
}

const any = (text: string, needles: string[]) => needles.some((n) => text.includes(n));

/** Short class prefix, in the reference's precedence order. */
function classPrefix(status: number | undefined, text: string): string {
  if (
    any(text, ["insufficient_quota", "quota exhausted", "quota exceeded", "monthly_request_count"])
  )
    return "Kiro quota exhausted";
  if (status === 429 || any(text, ["throttlingexception", "too many requests", "rate limit"]))
    return "Kiro rate limit exceeded";
  if (
    status === 401 ||
    status === 403 ||
    any(text, [
      "accessdenied",
      "access denied",
      "unauthorized",
      "unrecognizedclient",
      "expiredtoken",
      "expired token",
      "invalid token",
      "authentication",
    ])
  )
    return "Kiro authentication failed";
  if (status === 503 || any(text, ["overloaded", "server is busy", "temporarily unavailable"]))
    return "Kiro server overloaded";
  if (
    status === 400 ||
    any(text, [
      "validationexception",
      "invalid request",
      "profile arn",
      "model unavailable",
      "model not found",
      "unsupported model",
      "malformed",
    ])
  )
    return "Kiro invalid request";
  return "Kiro upstream error";
}

/**
 * Names what went wrong from an HTTP status and/or an event-stream exception frame. `errorType` is
 * the `:exception-type` / `:error-type` header (or the `x-amzn-errortype` response header).
 */
export function describeKiroFailure(
  status: number | undefined,
  errorType: string | undefined,
  payloadText: string,
): KiroFailure {
  const parts = [errorType?.trim(), ...payloadDetails(payloadText)].filter((p): p is string => !!p);
  const detail = sanitize(parts.join(": ")).slice(0, MAX_DETAIL_CHARS);
  const evidence = detail.toLowerCase();
  const fallbackStatus = status ?? 502;

  if (any(evidence, ["content_length_exceeds_threshold", "content length exceeds"]))
    return {
      status: 400,
      code: "context_length_exceeded",
      message:
        "Kiro rejected the request because the conversation exceeds the model's context window. Compact or reduce the history, or start a new session.",
    };
  if (evidence.includes("profilearn") && evidence.includes("required"))
    return {
      status: 400,
      code: "kiro_profile_required",
      message:
        "kiro_profile_required: Kiro requires a CodeWhisperer profileArn for this account and model. Sign in again so the profile is captured, then retry.",
    };

  const prefix = classPrefix(status, evidence);
  const message = detail ? `${prefix}: ${detail}` : prefix;
  if (
    any(evidence, [
      "monthly_request_count",
      "insufficient_quota",
      "quota exhausted",
      "quota exceeded",
    ])
  )
    // A spent quota is the account's problem, not the request's: report 429 so the gateway rotates credentials.
    return { status: 429, code: "insufficient_quota", message };
  if (fallbackStatus === 429 || any(evidence, ["throttlingexception", "too many requests"]))
    return { status: 429, code: "rate_limit_exceeded", message };
  return { status: fallbackStatus, code: "upstream_error", message };
}

/**
 * Re-shapes an upstream non-2xx into the OpenAI error envelope, keeping the status (the gateway
 * classifies on it) except where the body proves a different class. 5xx bodies are replaced by a
 * generic message instead of echoing upstream internals.
 */
export async function normalizeKiroHttpError(res: Response): Promise<Response> {
  const text = (await res.text().catch(() => "")).slice(0, MAX_ERROR_BODY_CHARS);
  const failure = describeKiroFailure(
    res.status,
    res.headers.get("x-amzn-errortype")?.split(":")[0],
    text,
  );
  const serverSide = failure.status >= 500;
  const message = serverSide
    ? failure.status === 504
      ? "Kiro upstream gateway timeout"
      : "Kiro upstream service unavailable"
    : failure.message;
  const headers = new Headers();
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  return Response.json(errorBody(failure.code, message), { status: failure.status, headers });
}
