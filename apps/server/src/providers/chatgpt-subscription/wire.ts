// Adapted from can1357/oh-my-pi (MIT): packages/ai providers/openai-codex-responses.ts (createCodexHeaders,
// createCodexRequestMetadata, applyCodexCompatibilityHeaders), packages/catalog wire/codex.ts
// (OPENAI_HEADERS, codexRoutingHint, applyCodexResidencyHeader).
import { randomUUID } from "node:crypto";
import {
  ACCOUNT_ID_KEY,
  CLIENT_VERSION,
  OPENAI_BETA,
  ORIGINATOR,
  USER_AGENT,
} from "./constants.ts";
import { readIdentity, readResidency } from "./jwt.ts";

/** The workspace the token draws limits from, as the quota probe knows it: the stored one, else the token's claim. */
export const accountIdOf = (token: string, meta: Readonly<Record<string, string>>) =>
  meta[ACCOUNT_ID_KEY] || readIdentity(token).accountId;

const HEADER = {
  ACCOUNT_ID: "chatgpt-account-id",
  INSTALLATION_ID: "x-codex-installation-id",
  WINDOW_ID: "x-codex-window-id",
  TURN_METADATA: "x-codex-turn-metadata",
  RESIDENCY: "x-openai-internal-codex-residency",
  ROUTING_HINT: "x-codex-routing-hint",
} as const;

/**
 * The installation id the Codex client reports. omp keeps one per machine on disk; the router keeps one per
 * process, so it changes on restart (nothing on the backend side is known to depend on it staying put).
 */
const INSTALLATION_ID = randomUUID();

/** Thread and window of one session (omp keeps them for the life of the session; the cache bounds a long-running router). */
const SESSIONS_MAX = 1000;
const sessions = new Map<string, { threadId: string; windowId: string }>();

function sessionOf(sessionId: string | undefined): { threadId: string; windowId: string } {
  if (sessionId === undefined) return { threadId: randomUUID(), windowId: randomUUID() };
  let session = sessions.get(sessionId);
  if (session) {
    // Most recently used last, so the oldest session is the one evicted.
    sessions.delete(sessionId);
  } else {
    session = { threadId: randomUUID(), windowId: randomUUID() };
    if (sessions.size >= SESSIONS_MAX) sessions.delete(sessions.keys().next().value as string);
  }
  sessions.set(sessionId, session);
  return session;
}

/** JSON with everything past ASCII `\uXXXX`-escaped (omp `toAsciiJsonString`): it travels in a header. */
const asciiJson = (value: Record<string, unknown>) =>
  JSON.stringify(value).replace(
    /[\x7f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** What identifies one request as a turn of a Codex session: the body's `client_metadata` and the session headers. */
export interface CodexIdentity {
  clientMetadata: Record<string, string>;
  headers: Record<string, string>;
}

/**
 * The turn identity of a request. `sessionId` is the (normalised) prompt-cache key of the client; without
 * one the session is fresh, like omp's programmatic callers. Every request is a new turn.
 */
export function codexIdentity(sessionId: string | undefined, now = Date.now()): CodexIdentity {
  const metadataSessionId = sessionId ?? randomUUID();
  const { threadId, windowId } = sessionOf(sessionId);
  const turnId = randomUUID();
  const turnMetadata = asciiJson({
    installation_id: INSTALLATION_ID,
    session_id: metadataSessionId,
    thread_id: threadId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: "turn",
    turn_started_at_unix_ms: now,
  });
  return {
    clientMetadata: {
      [HEADER.INSTALLATION_ID]: INSTALLATION_ID,
      session_id: metadataSessionId,
      thread_id: threadId,
      [HEADER.WINDOW_ID]: windowId,
      turn_id: turnId,
      [HEADER.TURN_METADATA]: turnMetadata,
    },
    headers: {
      "session-id": metadataSessionId,
      "thread-id": threadId,
      [HEADER.WINDOW_ID]: windowId,
      [HEADER.TURN_METADATA]: turnMetadata,
    },
  };
}

/**
 * Headers of a Codex `/responses` request (omp `createCodexHeaders`, SSE transport). The identity below
 * overrides a custom header of the same name; only the residency a caller declared itself is kept.
 * `sessionId` is what the backend derives prompt-cache affinity from; without one the session headers
 * are left out, as omp does.
 */
export function requestHeaders(
  token: string,
  custom: Readonly<Record<string, string>>,
  model: string,
  sessionId: string | undefined,
  identity: CodexIdentity,
): Headers {
  const headers = new Headers(custom);
  headers.delete("x-api-key");
  headers.set("authorization", `Bearer ${token}`);
  const account = readIdentity(token).accountId;
  if (account) headers.set(HEADER.ACCOUNT_ID, account);
  headers.set(HEADER.ROUTING_HINT, `model=${model}`);
  const residency = readResidency(token);
  if (residency && !headers.has(HEADER.RESIDENCY)) headers.set(HEADER.RESIDENCY, residency);
  headers.delete("x-oai-attestation");
  headers.set("openai-beta", OPENAI_BETA);
  headers.set("originator", ORIGINATOR);
  headers.set("version", CLIENT_VERSION);
  headers.set("user-agent", USER_AGENT);
  for (const name of ["conversation_id", "session_id", "x-client-request-id"]) {
    if (sessionId) headers.set(name, sessionId);
    else headers.delete(name);
  }
  headers.delete(HEADER.INSTALLATION_ID);
  for (const [name, value] of Object.entries(identity.headers)) headers.set(name, value);
  headers.delete("x-codex-turn-state");
  headers.delete("x-models-etag");
  headers.delete("x-openai-internal-codex-responses-lite");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  return headers;
}
