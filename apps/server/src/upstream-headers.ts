import * as z from "zod";

/**
 * Extra headers a provider sends with every upstream request, with per-credential overrides. The
 * router builds the request itself, so headers that frame it or its connection stay its own.
 */

/** RFC 9110 field-name: a token, so no separators or whitespace. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Set by `fetch`, the adapter or the connection: a custom value would break the call, not customize it. */
const RESERVED: Record<string, true> = {
  connection: true,
  "content-length": true,
  expect: true,
  host: true,
  "keep-alive": true,
  "proxy-connection": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
};

/** Control characters an HTTP field value may not carry (HTAB apart), CR and LF above all. */
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** Longest name (`fetch` refuses more) and value accepted, how many, and their total size. */
const MAX_NAME = 256;
const MAX_VALUE = 1000;
const MAX_COUNT = 20;
const MAX_BYTES = 8000;

/** Admin-API shape of a custom header map: names are tokens, values are single-line, the count is capped. */
export const customHeaders = z
  .record(
    z
      .string()
      .max(MAX_NAME, `may be at most ${MAX_NAME} characters`)
      .regex(HEADER_NAME, "must be a valid HTTP header name"),
    z
      .string()
      .trim()
      .min(1, "must not be empty")
      .max(MAX_VALUE, `may be at most ${MAX_VALUE} characters`)
      .refine((value) => !CONTROL_CHARS.test(value), "must not contain control characters"),
  )
  .superRefine((headers, ctx) => {
    const entries = Object.entries(headers);
    if (entries.length > MAX_COUNT)
      ctx.addIssue({ code: "custom", message: `at most ${MAX_COUNT} headers` });
    for (const [name, value] of entries) {
      if (Object.hasOwn(RESERVED, name.toLowerCase()))
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "is set by the router and cannot be overridden",
        });
      else if (name.length + value.length > MAX_BYTES)
        ctx.addIssue({ code: "custom", path: [name], message: `is too long (max ${MAX_BYTES})` });
    }
  });

/** Stored JSON -> a header map; an absent column, or one holding something else, is no headers. */
export function parseHeaders(stored: string | null): Record<string, string> {
  if (!stored) return {};
  const parsed: unknown = JSON.parse(stored);
  if (typeof parsed !== "object" || parsed === null) return {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

/** What one upstream request carries: the provider's headers with the credential's on top of them. */
export function mergeHeaders(
  provider: Record<string, string>,
  credential: Record<string, string>,
): Record<string, string> {
  return { ...provider, ...credential };
}
