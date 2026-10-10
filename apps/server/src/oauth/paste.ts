import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 S256 pair. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(96).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface ParsedCallback {
  kind: "url" | "query" | "raw";
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}

/**
 * Reads what the admin pasted: the full redirect URL, its query string, or a bare `code` /
 * `code#state`. `kind` records the shape so the caller can insist on `state` for anything that is an
 * authorization response. For a URL the query wins as a whole; the fragment is only consulted when
 * the query has no `code`, and the two are never mixed.
 */
export function parseCallbackInput(input: string): ParsedCallback {
  const value = input.trim();
  if (!value) return { kind: "raw" };
  const fromParams = (kind: "url" | "query", params: URLSearchParams): ParsedCallback => ({
    kind,
    code: params.get("code") ?? undefined,
    state: params.get("state") ?? undefined,
    error: params.get("error") ?? undefined,
  });
  try {
    const url = new URL(value);
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    const source =
      url.searchParams.has("code") || url.searchParams.has("error") ? url.searchParams : fragment;
    return fromParams("url", source);
  } catch {
    // not a URL
  }
  if (value.includes("code=") || value.includes("error=")) {
    return fromParams("query", new URLSearchParams(value.replace(/^[?#]/, "")));
  }
  const hash = value.indexOf("#");
  return hash < 0
    ? { kind: "raw", code: value }
    : { kind: "raw", code: value.slice(0, hash), state: value.slice(hash + 1) || undefined };
}
