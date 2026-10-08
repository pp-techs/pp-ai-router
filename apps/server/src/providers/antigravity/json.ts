/** The one JSON-object guard of the Antigravity adapter: narrows to an object, its fields stay `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
