// Adapted from can1357/oh-my-pi (MIT): packages/ai utils/schema/normalize.ts (sanitizeSchemaForOpenAIResponses).
import { isRecord } from "../anthropic/json.ts";

type Json = Record<string, unknown>;

const ARRAY_KEYS: Record<string, true> = {
  anyOf: true,
  oneOf: true,
  allOf: true,
  prefixItems: true,
};
const MAP_KEYS: Record<string, true> = {
  properties: true,
  patternProperties: true,
  dependencies: true,
  dependentSchemas: true,
  $defs: true,
  definitions: true,
};
const VALUE_KEYS: Record<string, true> = {
  items: true,
  additionalItems: true,
  contains: true,
  contentSchema: true,
  propertyNames: true,
  if: true,
  // JSON Schema keyword, not a thenable.
  // oxlint-disable-next-line unicorn/no-thenable
  then: true,
  else: true,
  not: true,
  additionalProperties: true,
  unevaluatedItems: true,
  unevaluatedProperties: true,
};

const FALLBACK_PATTERN_PROPERTY = ".*";

/** Whether a regex uses a lookahead/lookbehind group, which the Responses API refuses in `pattern`s. */
function hasLookaround(pattern: string): boolean {
  let start = pattern.indexOf("(?");
  while (start !== -1) {
    let escapes = 0;
    for (let i = start - 1; i >= 0 && pattern[i] === "\\"; i--) escapes++;
    if (escapes % 2 === 0) {
      const operator =
        pattern[start + 2] === "<" ? pattern.slice(start + 2, start + 4) : pattern[start + 2];
      if (operator === "=" || operator === "!" || operator === "<=" || operator === "<!")
        return true;
    }
    start = pattern.indexOf("(?", start + 2);
  }
  return false;
}

function node(value: unknown): unknown {
  if (!isRecord(value)) return value;
  // `{}` is the empty schema, `true` in draft 2020-12.
  if (Object.keys(value).length === 0) return true;

  const output: Json = {};
  for (const key of Object.keys(value)) {
    const child = value[key];
    // `oneOf` is rejected even without strict mode: it is re-emitted as `anyOf` below.
    if (key === "oneOf" && Array.isArray(child)) continue;
    if (key === "pattern" && typeof child === "string" && hasLookaround(child)) continue;
    if (key === "patternProperties" && isRecord(child)) output[key] = map(child, true);
    else if (MAP_KEYS[key] && isRecord(child)) output[key] = map(child, false);
    else if (ARRAY_KEYS[key] && Array.isArray(child)) output[key] = child.map(node);
    else if (VALUE_KEYS[key] && isRecord(child)) output[key] = node(child);
    else output[key] = child;
  }

  if (Array.isArray(value.oneOf)) {
    const oneOf = value.oneOf.map(node);
    output.anyOf = Array.isArray(output.anyOf) ? [...output.anyOf, ...oneOf] : oneOf;
  }
  // Every object schema needs `properties`; `type` may be an array such as `["object", "null"]`.
  const type = value.type;
  const isObject = type === "object" || (Array.isArray(type) && type.includes("object"));
  if (isObject && !Object.hasOwn(value, "properties")) output.properties = {};
  // An omitted `items` permits any element, the tail after `prefixItems` included: Codex wants that explicit
  // (omp `repairArrayItems`, codex only; `items: undefined` counts as omitted, as JSON drops it). A node with
  // `unevaluatedItems` is left alone, as adding `items` would change which elements that constrains.
  const isArray =
    type === "array" ||
    (Array.isArray(type) && type.includes("array")) ||
    (type === undefined && Array.isArray(value.prefixItems));
  if (isArray && value.items === undefined && !Object.hasOwn(value, "unevaluatedItems"))
    output.items = true;
  return Object.keys(output).length === 0 ? true : output;
}

/** A `{name: schema}` map; a pattern key with a lookaround is folded into a catch-all `.*` property. */
function map(schemas: Json, patterns: boolean): Json {
  const output: Json = {};
  for (const key of Object.keys(schemas)) {
    const next = node(schemas[key]);
    if (patterns && hasLookaround(key)) {
      const existing = output[FALLBACK_PATTERN_PROPERTY];
      if (existing === undefined) output[FALLBACK_PATTERN_PROPERTY] = next;
      else if (
        isRecord(existing) &&
        Array.isArray(existing.anyOf) &&
        Object.keys(existing).length === 1
      )
        existing.anyOf = [...existing.anyOf, next];
      else output[FALLBACK_PATTERN_PROPERTY] = { anyOf: [existing, next] };
      continue;
    }
    output[key] = next;
  }
  return output;
}

/**
 * A tool's parameter schema as the Responses API takes it: no `oneOf` (it becomes `anyOf`), every object
 * schema has `properties`, every array schema has `items` (open `true` when omitted), no lookaround regexes,
 * and the empty schema is `true`. The parameters
 * themselves stay an object schema. Draft-07 to 2020-12 upgrading and strict-mode enforcement (omp's
 * `adaptSchemaForStrict`) are not ported.
 */
export function sanitizeToolSchema(schema: Json): Json {
  const sanitized = node(schema);
  return isRecord(sanitized) ? sanitized : { type: "object", properties: {} };
}
