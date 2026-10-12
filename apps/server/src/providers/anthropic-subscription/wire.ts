// Adapted from lidge-jun/opencodex (MIT): src/oauth/anthropic.ts, src/adapters/anthropic.ts;
// the request identity follows can1357/oh-my-pi (packages/ai/src/providers/anthropic.ts).
import type { PreparedRequest } from "../anthropic.ts";
import type { OpenAIChunk } from "../chunks.ts";
import { isRecord } from "../anthropic/json.ts";
import {
  ACCOUNT_UUID_KEY,
  BUILTIN_TOOLS,
  CLAUDE_CODE_HEADERS,
  EFFORT_BETA,
  MESSAGES_BETAS,
  OAUTH_BETA,
  SYSTEM_INSTRUCTION,
  TOOL_PREFIX,
} from "./constants.ts";
import { billingHeader, cliUserAgent, metadataUserId, sessionId, signBody } from "./identity.ts";

/** The most `cache_control` breakpoints one Messages request may carry. */
const MAX_CACHE_BREAKPOINTS = 4;

/** Credential headers; a Messages request also carries the Claude Code client fingerprint. */
export function subscriptionHeaders(
  token: string,
  purpose: "models" | "messages",
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "anthropic-beta": OAUTH_BETA,
    "user-agent": cliUserAgent(),
  };
  // The SDK asks for JSON even when the body asks for a stream.
  if (purpose === "messages")
    Object.assign(headers, CLAUDE_CODE_HEADERS, { accept: "application/json" });
  return headers;
}

const toWire = (name: string) =>
  Object.hasOwn(BUILTIN_TOOLS, name.toLowerCase()) ? name : TOOL_PREFIX + name;
const fromWire = (name: string) =>
  name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;

/** The same shallow copy with `name` renamed, for any record that has one. */
const renamed = <T>(value: T): T =>
  isRecord(value) && typeof value.name === "string"
    ? ({ ...value, name: toWire(value.name) } as T)
    : value;

/** Text of the first user turn that has any, as Claude Code fingerprints it ("" when that turn is an image). */
function firstUserText(messages: unknown): string {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message) || message.role !== "user") continue;
    const { content } = message;
    if (typeof content === "string") {
      if (content.trim()) return content;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim()
      ) {
        return block.text;
      }
    }
    if (content.some((block) => isRecord(block) && block.type === "image")) return "";
  }
  return "";
}

/** `cache_control` breakpoints the translated request already carries (system, tools and message blocks). */
function cacheBreakpoints(payload: Record<string, unknown>): number {
  const blocks = [
    ...(Array.isArray(payload.system) ? payload.system : []),
    ...(Array.isArray(payload.tools) ? payload.tools : []),
    ...(Array.isArray(payload.messages)
      ? payload.messages.flatMap((m) => (isRecord(m) && Array.isArray(m.content) ? m.content : []))
      : []),
  ];
  return blocks.filter((block) => isRecord(block) && block.cache_control !== undefined).length;
}

/** Whether the request asks for extended thinking, which Claude Code announces with the effort beta. */
const thinks = (payload: Record<string, unknown>) =>
  isRecord(payload.thinking) &&
  (payload.thinking.type === "enabled" || payload.thinking.type === "adaptive");

/**
 * A subscription request is a Claude Code request: a billing block (CLI version, fingerprint, signed
 * `cch`) and the Claude Code identity as the first two system blocks, wire-safe tool names everywhere
 * a tool is named (definitions, `tool_choice` and the tool calls of the history), the session and device
 * in `metadata.user_id`, and the betas of the CLI.
 */
export function prepareSubscriptionRequest(
  payload: Record<string, unknown>,
  { token, meta }: { token: string; meta: Readonly<Record<string, string>> },
): PreparedRequest {
  const { system, tools, tool_choice: toolChoice, messages } = payload;
  const userSystem = [
    ...(typeof system === "string" ? [{ type: "text", text: system }] : []),
    ...(Array.isArray(system) ? system : []),
  ];
  const text = firstUserText(messages);
  const accountUuid = meta[ACCOUNT_UUID_KEY];
  const session = sessionId(accountUuid ?? token, text);

  const identity: Record<string, unknown> = { type: "text", text: SYSTEM_INSTRUCTION };
  if (cacheBreakpoints({ ...payload, system: userSystem }) < MAX_CACHE_BREAKPOINTS) {
    identity.cache_control = { type: "ephemeral" };
  }
  const out: Record<string, unknown> = {
    ...payload,
    system: [{ type: "text", text: billingHeader(text) }, identity, ...userSystem],
    metadata: { user_id: metadataUserId(accountUuid ?? token, session, accountUuid) },
  };
  if (Array.isArray(tools)) out.tools = tools.map(renamed);
  if (toolChoice !== undefined) out.tool_choice = renamed(toolChoice);
  if (Array.isArray(messages)) {
    out.messages = messages.map((message) =>
      isRecord(message) && Array.isArray(message.content)
        ? {
            ...message,
            content: message.content.map((block) =>
              isRecord(block) && block.type === "tool_use" ? renamed(block) : block,
            ),
          }
        : message,
    );
  }
  return {
    body: signBody(JSON.stringify(out)),
    headers: {
      "anthropic-beta": [...MESSAGES_BETAS, ...(thinks(payload) ? [EFFORT_BETA] : [])].join(","),
      "X-Claude-Code-Session-Id": session,
      "x-client-request-id": crypto.randomUUID(),
    },
  };
}

/** Gives the client back the tool names it sent. */
export function restoreToolNames(chunk: OpenAIChunk): void {
  for (const choice of chunk.choices) {
    for (const call of choice.delta.tool_calls ?? []) {
      if (call.function?.name) call.function.name = fromWire(call.function.name);
    }
  }
}
