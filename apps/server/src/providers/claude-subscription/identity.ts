// Adapted from can1357/oh-my-pi (MIT): packages/ai/src/{providers/claude-code-fingerprint,providers/anthropic-identity,providers/anthropic}.ts
import { createHash } from "node:crypto";
import { DEFAULT_CLI_VERSION } from "./constants.ts";
import { xxhash64 } from "./xxhash64.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// ---- CLI version -------------------------------------------------------------------------------

let adoptedVersion: string | null = null;

/** The Claude Code release the requests present: the pinned default until Anthropic names a newer minimum. */
export const cliVersion = () => adoptedVersion ?? DEFAULT_CLI_VERSION;
export const cliUserAgent = () => `claude-cli/${cliVersion()} (external, cli)`;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const REQUIRED_VERSION = /version (\d+\.\d+\.\d+) or newer is required/i;

function newer(a: string, b: string): boolean {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * Adopts the minimum release an Anthropic `claude_code_version_too_old` rejection names, for the rest
 * of the process, so a stale pinned version costs one retried request instead of an outage. True only
 * when the presented version actually went up: callers retry on true, so a repeated rejection at the
 * same version cannot loop.
 */
export function adoptRequiredVersion(rejection: string): boolean {
  if (!rejection.includes("claude_code_version_too_old")) return false;
  const required = REQUIRED_VERSION.exec(rejection)?.[1];
  if (!required || !newer(required, cliVersion())) return false;
  adoptedVersion = required;
  return true;
}

// ---- Billing header and its `cch` attestation --------------------------------------------------

const BILLING_PREFIX = "x-anthropic-billing-header:";
const CCH_PLACEHOLDER = "cch=00000";
const CCH_SEED = 0x4d659218e32a3268n;
const encoder = new TextEncoder();
const MARKER = encoder.encode(`"system":[{"type":"text","text":"${BILLING_PREFIX}`);
const PLACEHOLDER = encoder.encode(CCH_PLACEHOLDER);
/** The placeholder sits within this many bytes of the marker, in the first system block. */
const SEARCH_WINDOW = 150;

/**
 * First system block of a Claude Code request: the CLI version, a fingerprint of three characters of
 * the first user turn, and the `cch` placeholder that `signBody` replaces.
 */
export function billingHeader(firstUserText: string): string {
  const picked = [4, 7, 20].map((i) => firstUserText[i] ?? "0").join("");
  const version = cliVersion();
  const suffix = sha256(`59cf53e54c78${picked}${version}`).slice(0, 3);
  return `${BILLING_PREFIX} cc_version=${version}.${suffix}; cc_entrypoint=cli; ${CCH_PLACEHOLDER};`;
}

/**
 * The request body as bytes, with the `cch` placeholder of the billing block replaced by the low 20
 * bits of an XXH64 of the body (hashed with the placeholder in place, as the CLI does). A body without
 * the billing block is returned unsigned.
 */
export function signBody(body: string): Uint8Array {
  const bytes = encoder.encode(body);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const marker = buffer.indexOf(MARKER);
  if (marker === -1) return bytes;
  const from = marker + MARKER.length;
  const at = buffer.indexOf(PLACEHOLDER, from);
  if (at === -1 || at - from > SEARCH_WINDOW) return bytes;
  const cch = (xxhash64(bytes, CCH_SEED) & 0xfffffn).toString(16).padStart(5, "0");
  bytes.set(encoder.encode(cch), at + "cch=".length);
  return bytes;
}

// ---- Session and device ------------------------------------------------------------------------

/** A UUIDv4-shaped id taken from a hash. */
function uuidFrom(text: string): string {
  const h = sha256(text);
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Claude Code's session id, one per conversation. The router keeps no conversation state, so it is
 * derived from the account and the first user turn, which stay the same for the whole conversation.
 */
export const sessionId = (accountKey: string, firstUserText: string) =>
  uuidFrom(`claude-code-session:${accountKey}\0${firstUserText}`);

/** The `metadata.user_id` Claude Code sends: a JSON string naming the device, the session and the account. */
export function metadataUserId(accountKey: string, session: string, accountUuid?: string): string {
  return JSON.stringify({
    device_id: sha256(`pp-ai-router-claude-device-id-v1\0${accountKey}`),
    session_id: session,
    ...(accountUuid ? { account_uuid: accountUuid } : {}),
  });
}
