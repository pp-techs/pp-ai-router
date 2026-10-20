// Adapted from can1357/oh-my-pi (MIT): packages/ai providers/openai-codex/response-handler.ts (parseCodexError),
// providers/openai-codex-responses.ts (createCodexProviderStreamError, formatCodexFailure, formatCodexErrorEvent),
// error/flags.ts (ACCOUNT_POLICY_PATTERN).
import { errorBody } from "../../errors.ts";
import { isRecord } from "../anthropic/json.ts";

const MAX_BODY_CHARS = 64 * 1024;
const USAGE_LIMIT = /usage_limit_reached|usage_not_included/i;
const RATE_LIMIT = /rate_limit_exceeded/i;
/** An account-scoped policy denial (Codex `cyber_policy`): another account may be served where this one is not. */
const ACCOUNT_POLICY = /\bcyber_policy\b|trusted access for cyber/i;

const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

/** A number header, or undefined (omp `toNumber` / `toInt` of the `x-codex-*` rate-limit headers). */
function headerInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** What a failure body (`{"error":{...}}`) and the rate-limit headers say; the minutes are to the reset. */
export interface CodexFailure {
  status: number;
  code: string;
  message: string;
  /** omp's friendly sentence for a usage limit or a rate limit; absent for any other failure. */
  friendly: string | undefined;
  /** Epoch seconds at which the limit resets. */
  resetsAt: number | undefined;
}

/** omp `parseCodexError`, from the body text, the headers and the HTTP status. */
export function readFailure(
  text: string,
  headers: Headers,
  status: number,
  now = Date.now(),
): CodexFailure {
  let message = text || "Request failed";
  let friendly: string | undefined;
  let code = "";
  let resetsAt: number | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
    const raw = error.code ?? error.type;
    code = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
    resetsAt =
      (typeof error.resets_at === "number" && error.resets_at > 0 ? error.resets_at : undefined) ??
      headerInt(headers, "x-codex-primary-reset-at") ??
      headerInt(headers, "x-codex-secondary-reset-at");
    const minutes =
      resetsAt === undefined
        ? undefined
        : Math.max(0, Math.round((resetsAt * 1000 - now) / 60_000));
    const when = minutes === undefined ? "" : ` Try again in ~${minutes} min.`;
    if (USAGE_LIMIT.test(code)) {
      const plan =
        typeof error.plan_type === "string" ? ` (${error.plan_type.toLowerCase()} plan)` : "";
      friendly = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
    } else if (RATE_LIMIT.test(code) || status === 429) {
      friendly = `ChatGPT rate limit exceeded.${when}`.trim();
    }
    message = optionalString(error.message) || friendly || message;
  } catch {
    // not JSON
  }
  return { status, code, message, friendly, resetsAt };
}

/**
 * Upstream non-2xx. The gateway classifies on the status and `retry-after`, so both are kept. A spent usage
 * limit is a 429 (the account's problem, not the request's) in the OpenAI envelope with the reset time as
 * `retry-after`, a rate limit is the same without the quota code, and an account policy denial is a 403 so
 * the gateway tries another account. Every other failure is passed on as the backend sent it.
 */
export async function normalizeCodexHttpError(res: Response, now = Date.now()): Promise<Response> {
  const text = (await res.text().catch(() => "")).slice(0, MAX_BODY_CHARS);
  const headers = new Headers();
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);

  const failure = readFailure(text, res.headers, res.status, now);
  const limited = USAGE_LIMIT.test(failure.code);
  if (limited || failure.friendly !== undefined) {
    if (!headers.has("retry-after") && failure.resetsAt !== undefined) {
      headers.set("retry-after", String(Math.max(1, Math.ceil(failure.resetsAt - now / 1000))));
    }
    return Response.json(
      errorBody(
        limited ? "insufficient_quota" : "rate_limit_exceeded",
        failure.friendly ?? failure.message,
      ),
      { status: 429, headers },
    );
  }
  if (ACCOUNT_POLICY.test(`${failure.code} ${failure.message}`)) {
    return Response.json(errorBody("permission_error", failure.message), {
      status: 403,
      headers,
    });
  }
  const type = res.headers.get("content-type");
  if (type) headers.set("content-type", type);
  return new Response(text, { status: res.status, headers });
}

/** The pieces of a failure event omp reads: `type`, `code`, `message`, `status`, and the nested `error` / `response`. */
function failureDetail(event: Record<string, unknown>) {
  const response = isRecord(event.response) ? event.response : {};
  const nested = [event.error, response.error].find(isRecord);
  return {
    code:
      optionalString(nested?.code) ?? optionalString(nested?.type) ?? optionalString(event.code),
    message:
      optionalString(nested?.message) ??
      optionalString(event.message) ??
      optionalString(response.message),
    status: optionalString(response.status) ?? optionalString(event.status),
  };
}

function truncatedJson(event: Record<string, unknown>): string | undefined {
  try {
    const json = JSON.stringify(event);
    return json.length <= 800 ? json : `${json.slice(0, 800)}…[truncated ${json.length - 800}]`;
  } catch {
    return undefined;
  }
}

/** omp `formatCodexFailure`; null when the event says nothing. */
function formatFailure(event: Record<string, unknown>): string | null {
  const { code, message, status } = failureDetail(event);
  const meta = [...(code ? [`code=${code}`] : []), ...(status ? [`status=${status}`] : [])];
  if (message)
    return `Codex response failed: ${message}${meta.length ? ` (${meta.join(", ")})` : ""}`;
  if (meta.length) return `Codex response failed (${meta.join(", ")})`;
  const json = truncatedJson(event);
  return json === undefined ? null : `Codex response failed: ${json}`;
}

/** An error event of the Responses stream (`error` / `response.failed`) as the `Error` the chunk stream throws (omp `createCodexProviderStreamError`). */
export function streamFailure(event: Record<string, unknown>): Error {
  if (event.type !== "error") return new Error(formatFailure(event) ?? "Codex response failed");
  const detail = formatFailure(event);
  if (detail) return new Error(detail.replace("response failed", "error event"));
  const code = failureDetail(event).code ?? "";
  const message = optionalString(event.message) ?? "";
  const meta = [...(code ? [`code=${code}`] : []), ...(message ? [`message=${message}`] : [])];
  if (meta.length > 0) return new Error(`Codex error event (${meta.join(", ")})`);
  const json = truncatedJson(event);
  return new Error(json === undefined ? "Codex error event" : `Codex error event: ${json}`);
}
