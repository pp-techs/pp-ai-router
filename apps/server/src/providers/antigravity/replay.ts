// Adapted from lidge-jun/opencodex (MIT)
import { createHash } from "node:crypto";
import { isRecord } from "./json.ts";

/**
 * Thought-signature replay. Gemini 3 returns an opaque `thoughtSignature` on function-call parts and
 * rejects the next turn when the call comes back without it. An OpenAI client cannot carry the
 * signature, so the adapter remembers it (per model + session, keyed by the call's name and
 * arguments) and re-injects it when the same call appears in the history of a later request.
 * In memory only, TTL + size bounded. The reference's disk snapshot and byte budgets are not ported.
 */

const MIN_SIGNATURE_LEN = 16;
const MAX_SIGNATURES_PER_CALL = 32;
const MAX_CALLS_PER_SESSION = 256;
const MAX_SESSIONS = 1_024;
const REPLAY_TTL_MS = 60 * 60_000;

/** Official validator-bypass token, used only where no real signature exists. */
export const THOUGHT_SIGNATURE_BYPASS = "skip_thought_signature_validator";

interface Session {
  /** callKey -> signatures, oldest first (a repeated identical call gets a new one each time). */
  calls: Map<string, string[]>;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

const sessionKey = (model: string, sessionId: string): string =>
  createHash("sha256").update(`${model}\0${sessionId}`).digest("hex");

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function callKey(name: unknown, args: unknown): string | undefined {
  if (typeof name !== "string" || name.length === 0) return undefined;
  return createHash("sha256")
    .update(`${name}\0${canonicalJson(args ?? {})}`)
    .digest("hex");
}

/** A real signature on a part (direct, snake_case or the OpenAI-compat `extra_content` spelling). */
export function extractSignature(part: Record<string, unknown>): string | undefined {
  const extra =
    isRecord(part.extra_content) && isRecord(part.extra_content.google)
      ? part.extra_content.google.thought_signature
      : undefined;
  for (const candidate of [part.thoughtSignature, part.thought_signature, extra]) {
    if (
      typeof candidate === "string" &&
      candidate.length >= MIN_SIGNATURE_LEN &&
      candidate !== THOUGHT_SIGNATURE_BYPASS
    ) {
      return candidate;
    }
  }
  return undefined;
}

/** Claude-on-Antigravity does not take replayed signatures (thinking blocks are dropped from history instead). */
export const usesReplayCache = (model: string): boolean => !/claude/i.test(model);

/**
 * Only the Gemini dialect requires (and accepts the bypass for) a signature on the first function
 * call. Deliberately not `usesReplayCache`: fabricating a Gemini token for `gpt-oss` is not harmless.
 */
const supportsSentinel = (model: string): boolean => /^gemini[-.\d]/i.test(model);

function prune(now: number): void {
  for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
}

/**
 * Records the signatures of one response frame's `parts`. A signature on a standalone thought part
 * pairs with the function calls that follow it, including in later SSE frames of the same turn:
 * `carried` threads the still-unpaired signature in and the return value hands the remainder on.
 */
export function observeReplay(
  model: string,
  sessionId: string,
  parts: readonly unknown[],
  carried?: string,
  now = Date.now(),
): string | undefined {
  if (!usesReplayCache(model)) return carried;
  let pending = carried;
  const key = sessionKey(model, sessionId);
  for (const raw of parts) {
    if (!isRecord(raw)) continue;
    const sig = extractSignature(raw);
    const fc = raw.functionCall;
    if (!isRecord(fc)) {
      if (sig && raw.thought === true) pending = sig;
      continue;
    }
    const callSig = sig ?? pending; // a signature on the call part itself wins
    const ck = callKey(fc.name, fc.args);
    if (!callSig || !ck) continue;

    prune(now);
    const session = sessions.get(key) ?? { calls: new Map(), expiresAt: 0 };
    const sigs = session.calls.get(ck) ?? [];
    if (!sigs.includes(callSig)) {
      if (sigs.length >= MAX_SIGNATURES_PER_CALL) sigs.shift();
      sigs.push(callSig);
    }
    session.calls.delete(ck); // re-insert: most recently used last
    session.calls.set(ck, sigs);
    while (session.calls.size > MAX_CALLS_PER_SESSION) {
      session.calls.delete(session.calls.keys().next().value!);
    }
    session.expiresAt = now + REPLAY_TTL_MS;
    sessions.delete(key);
    sessions.set(key, session);
  }
  return pending;
}

/**
 * Re-injects remembered signatures into `contents`, matched by call identity across ALL model turns.
 * Aligned from the END: history may be truncated, so the last occurrence of a call is the most recent
 * one and gets the newest signature. Already-signed parts are kept but still occupy their slot.
 */
export function applyReplay(
  model: string,
  sessionId: string,
  contents: unknown[],
  now = Date.now(),
): void {
  if (!usesReplayCache(model)) return;
  const session = sessions.get(sessionKey(model, sessionId));
  if (!session || session.expiresAt <= now) return;
  const seen = new Map<string, number>();
  for (let ci = contents.length - 1; ci >= 0; ci--) {
    const content = contents[ci];
    if (!isRecord(content) || content.role !== "model" || !Array.isArray(content.parts)) continue;
    for (let pi = content.parts.length - 1; pi >= 0; pi--) {
      const part: unknown = content.parts[pi];
      if (!isRecord(part) || !isRecord(part.functionCall)) continue;
      const ck = callKey(part.functionCall.name, part.functionCall.args);
      if (!ck) continue;
      const fromEnd = seen.get(ck) ?? 0;
      seen.set(ck, fromEnd + 1);
      if (part.thoughtSignature !== undefined || part.thought_signature !== undefined) continue;
      const sigs = session.calls.get(ck);
      if (sigs?.length) part.thoughtSignature = sigs[Math.max(0, sigs.length - 1 - fromEnd)];
    }
  }
}

/** Drops a session whose replayed signatures upstream rejected, so the next turn starts clean. */
export function clearReplay(model: string, sessionId: string): void {
  sessions.delete(sessionKey(model, sessionId));
}

/**
 * Gemini 3 rejects a turn whose FIRST functionCall carries no signature. Runs after replay so a real
 * signature always wins; the bypass only fills what replay could not sign.
 */
export function applySignatureFallback(model: string, contents: unknown[]): void {
  if (!supportsSentinel(model)) return;
  for (const content of contents) {
    if (!isRecord(content) || content.role !== "model" || !Array.isArray(content.parts)) continue;
    for (const part of content.parts as unknown[]) {
      if (!isRecord(part) || !part.functionCall) continue;
      if (!extractSignature(part)) part.thoughtSignature = THOUGHT_SIGNATURE_BYPASS;
      break;
    }
  }
}

/** Test seam. */
export function resetReplay(): void {
  sessions.clear();
}
