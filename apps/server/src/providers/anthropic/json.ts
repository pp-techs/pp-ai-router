/** The one JSON-object guard of the Anthropic adapter and its inbound twin: narrows to an object, fields stay `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A string field of untyped JSON, or `fallback` when it is anything else. */
export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
