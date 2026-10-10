// Adapted from lidge-jun/opencodex (MIT): src/oauth/anthropic.ts, src/adapters/anthropic.ts
import type { OpenAIChunk } from "../chunks.ts";
import { isRecord } from "../anthropic/json.ts";
import {
  BUILTIN_TOOLS,
  CLAUDE_CODE_HEADERS,
  MESSAGES_USER_AGENT,
  OAUTH_BETA,
  SYSTEM_INSTRUCTION,
  TOOL_PREFIX,
  sessionId,
} from "./constants.ts";

/** Credential headers; a Messages request also carries the Claude Code client fingerprint. */
export function subscriptionHeaders(
  token: string,
  purpose: "models" | "messages",
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "anthropic-beta": OAUTH_BETA,
    "user-agent": MESSAGES_USER_AGENT,
  };
  if (purpose === "messages") {
    Object.assign(headers, CLAUDE_CODE_HEADERS, {
      "X-Claude-Code-Session-Id": sessionId(token),
      "x-client-request-id": crypto.randomUUID(),
    });
  }
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

/**
 * A subscription request needs the Claude Code identity as its first system block and wire-safe tool
 * names everywhere a tool is named: definitions, `tool_choice` and the tool calls of the history.
 */
export function prepareSubscriptionRequest(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { system, tools, tool_choice: toolChoice, messages } = payload;
  const out: Record<string, unknown> = {
    ...payload,
    system: [
      { type: "text", text: SYSTEM_INSTRUCTION },
      ...(typeof system === "string" ? [{ type: "text", text: system }] : []),
      ...(Array.isArray(system) ? system : []),
    ],
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
  return out;
}

/** Gives the client back the tool names it sent. */
export function restoreToolNames(chunk: OpenAIChunk): void {
  for (const choice of chunk.choices) {
    for (const call of choice.delta.tool_calls ?? []) {
      if (call.function?.name) call.function.name = fromWire(call.function.name);
    }
  }
}
