// Adapted from lidge-jun/opencodex (MIT)

export interface KiroTokenUsage {
  /** Fresh + cache-read + cache-write input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
}

export type KiroEvent =
  | { type: "content"; data: string | undefined }
  | { type: "reasoning"; data: string | undefined }
  | {
      type: "tool";
      name: string | undefined;
      toolUseId: string | undefined;
      input: string | undefined;
      stop: boolean | undefined;
    }
  | { type: "metadata"; usage: KiroTokenUsage | undefined; stopReason: string | undefined }
  | { type: "invalid_state"; message: string | undefined }
  | { type: "error"; reason: string | undefined; message: string | undefined }
  | { type: "truncation"; reason: string };

/**
 * Every other event type (`messageMetadataEvent`, `meteringEvent`, `contextUsageEvent`,
 * `initial-response`, ...) carries nothing this adapter maps and is ignored unparsed.
 */
const KNOWN_EVENT_TYPES: Record<string, true> = {
  assistantResponseEvent: true,
  reasoningContentEvent: true,
  toolUseEvent: true,
  metadataEvent: true,
  invalidStateEvent: true,
  error: true,
};

const REASON_KEYS = [
  "finish_reason",
  "finishReason",
  "stop_reason",
  "stopReason",
  "completionReason",
  "reason",
];
const TRUNCATION_PATTERN = /length|max[_-]?tokens?|truncat|incomplete|context_length/i;

function truncationReason(parsed: Record<string, unknown>): string | undefined {
  if (parsed.truncated === true) return "truncated";
  for (const key of REASON_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim() && TRUNCATION_PATTERN.test(value))
      return value.trim();
  }
  return undefined;
}

/** A tool-call input is complete once it is empty or a JSON object/array. */
export function isCompleteToolInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return true;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

export const truncationMessage = (reason: string): string =>
  `Kiro response truncated upstream before the tool call completed (${reason.slice(0, 160)})`;

function malformed(eventType: string, detail: string): never {
  throw new Error(`invalid Kiro ${eventType} payload: ${detail}`);
}

function optionalString(
  eventType: string,
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return malformed(eventType, `${key} must be a string`);
  return value;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * `metadataEvent.tokenUsage`. Unlike the reference, an unusable object is ignored (the caller then
 * estimates) rather than failing a response whose content has already been delivered.
 */
function parseTokenUsage(value: unknown): KiroTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const u = value as Record<string, unknown>;
  const { uncachedInputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens } = u;
  if (!isCount(uncachedInputTokens) || !isCount(outputTokens)) return undefined;
  // An absent cache counter stays "unknown" instead of becoming a measured zero.
  if (cacheReadInputTokens !== undefined && !isCount(cacheReadInputTokens)) return undefined;
  if (cacheWriteInputTokens !== undefined && !isCount(cacheWriteInputTokens)) return undefined;
  return {
    inputTokens: uncachedInputTokens + (cacheReadInputTokens ?? 0) + (cacheWriteInputTokens ?? 0),
    outputTokens,
    cacheRead: cacheReadInputTokens,
    cacheWrite: cacheWriteInputTokens,
  };
}

/** Decodes one Smithy event by its `:event-type` header; null for events this adapter ignores. */
export function parseKiroEvent(eventType: string, payload: Uint8Array): KiroEvent | null {
  if (!Object.hasOwn(KNOWN_EVENT_TYPES, eventType)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return malformed(eventType, "expected valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return malformed(eventType, "expected an object");
  const obj = parsed as Record<string, unknown>;

  // A metadataEvent's `stopReason` is Kiro's own terminal verdict (MAX_TOKENS matches the truncation
  // pattern), so the sniffer below must not swallow it.
  const nativeStop =
    eventType === "metadataEvent" ? optionalString(eventType, obj, "stopReason") : undefined;
  if (nativeStop === undefined) {
    const reason = truncationReason(obj);
    if (reason) return { type: "truncation", reason };
  }

  switch (eventType) {
    case "assistantResponseEvent":
      return { type: "content", data: optionalString(eventType, obj, "content") };
    case "reasoningContentEvent":
      // Plaintext reasoning is `text`. `signature` / `redactedContent` are opaque blobs that only
      // make sense when replayed to Kiro, which the chat-completions API cannot do; they are dropped.
      return { type: "reasoning", data: optionalString(eventType, obj, "text") };
    case "toolUseEvent": {
      const stop = obj.stop;
      if (stop !== undefined && stop !== null && typeof stop !== "boolean")
        return malformed(eventType, "stop must be a boolean");
      return {
        type: "tool",
        name: optionalString(eventType, obj, "name"),
        toolUseId: optionalString(eventType, obj, "toolUseId"),
        input: optionalString(eventType, obj, "input"),
        stop: stop ?? undefined,
      };
    }
    case "metadataEvent":
      return { type: "metadata", usage: parseTokenUsage(obj.tokenUsage), stopReason: nativeStop };
    case "invalidStateEvent":
      return { type: "invalid_state", message: optionalString(eventType, obj, "message") };
    case "error":
      return {
        type: "error",
        reason:
          optionalString(eventType, obj, "reason") ??
          optionalString(eventType, obj, "type") ??
          optionalString(eventType, obj, "__type"),
        message:
          optionalString(eventType, obj, "message") ?? optionalString(eventType, obj, "Message"),
      };
  }
  return null;
}
