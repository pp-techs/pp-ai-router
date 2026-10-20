// Adapted from can1357/oh-my-pi (MIT) and lidge-jun/opencodex (MIT): packages/ai/src/providers/{anthropic,anthropic-identity}.ts,
// catalog provider-models/openai-compat.ts (model discovery headers); opencodex src/adapters/anthropic.ts.
import type { PreparedRequest } from "../anthropic.ts";
import type { OpenAIChunk } from "../chunks.ts";
import { isRecord } from "../anthropic/json.ts";
import {
  ACCOUNT_BETAS,
  ACCOUNT_UUID_KEY,
  AGENT_BETAS,
  BUILTIN_TOOLS,
  CLAUDE_CODE_HEADERS,
  EFFORT_BETA,
  SYSTEM_INSTRUCTION,
  TOOL_PREFIX,
  UTILITY_BETAS,
} from "./constants.ts";
import { billingHeader, cliUserAgent, metadataUserId, sessionId, signBody } from "./identity.ts";

/** The most `cache_control` breakpoints one Messages request may carry. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Credential headers. Account routes (model discovery) carry omp's discovery headers; a Messages request
 * carries the Claude Code client fingerprint instead (its `anthropic-beta` comes from the prepared request).
 */
export function subscriptionHeaders(
  token: string,
  purpose: "models" | "messages",
): Record<string, string> {
  if (purpose === "models") {
    return {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "anthropic-beta": ACCOUNT_BETAS,
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
  return {
    authorization: `Bearer ${token}`,
    "user-agent": cliUserAgent(),
    ...CLAUDE_CODE_HEADERS,
    // The SDK asks for JSON even when the body asks for a stream.
    accept: "application/json",
    "accept-encoding": "gzip, deflate, br, zstd",
    connection: "keep-alive",
  };
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

/**
 * omp's beta profile: an agent request (tools or thinking) carries Claude Code's agent betas, anything
 * else the utility ones; the effort beta rides with thinking and with any effort the body pins.
 */
function messagesBetas(payload: Record<string, unknown>): string {
  const { thinking: thinkingConfig, output_config: outputConfig, tools } = payload;
  const thinking =
    isRecord(thinkingConfig) &&
    (thinkingConfig.type === "enabled" || thinkingConfig.type === "adaptive");
  const agent = thinking || (Array.isArray(tools) && tools.length > 0);
  const effort = isRecord(outputConfig) && outputConfig.effort !== undefined;
  return [
    ...(agent ? AGENT_BETAS : UTILITY_BETAS),
    ...(thinking || effort ? [EFFORT_BETA] : []),
  ].join(",");
}

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
    // omp's OAuth default is a 1h breakpoint (Claude Code's own policy). The API refuses a 1h breakpoint
    // that follows a shorter one, and tools come before the system prompt: a client that cached a tool
    // keeps the default 5-minute lifetime.
    const toolCached = Array.isArray(tools) && tools.some((t) => isRecord(t) && t.cache_control);
    identity.cache_control = toolCached ? { type: "ephemeral" } : { type: "ephemeral", ttl: "1h" };
  }
  const out: Record<string, unknown> = {
    ...payload,
    system: [{ type: "text", text: billingHeader(text) }, identity, ...userSystem],
    metadata: { user_id: metadataUserId(accountUuid ?? token, session, accountUuid) },
  };
  // An OAuth request always names its tools, even when there are none.
  out.tools = Array.isArray(tools) ? tools.map(renamed) : [];
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
      "anthropic-beta": messagesBetas(payload),
      "X-Claude-Code-Session-Id": session,
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
