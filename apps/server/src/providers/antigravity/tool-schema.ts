// Adapted from lidge-jun/opencodex (MIT)

import { isRecord } from "./json.ts";

type Schema = Record<string, unknown>;

/**
 * Reduces an arbitrary JSON Schema (typically from MCP tools) to the function-declaration subset
 * Google documents: type, nullable, required, format, description, properties, items, enum, anyOf,
 * $ref/$defs. Local refs are inlined and `anyOf` is normalised; everything else is dropped by
 * building the output from an allowlist, so a new JSON-Schema annotation can never turn into a
 * request-wide 400. The reference's lossy-compilation *report* (diagnostics only) is not ported.
 */
const ALLOWED_TYPES: Record<string, true> = {
  string: true,
  integer: true,
  number: true,
  boolean: true,
  array: true,
  object: true,
};
const MAX_SCHEMA_DEPTH = 24; // Google's documented nesting limit is 32; leave headroom for CCA.
const MAX_DEREF_DEPTH = 16;
const MAX_SCHEMA_NODES = 1_024;
const BUDGET_EXHAUSTED = Symbol("schema-budget-exhausted");
const RETAINED_UNION_KEYS = [
  "type",
  "nullable",
  "format",
  "enum",
  "properties",
  "items",
  "required",
];
// Keys of a `$ref` target that an overlay may override (everything else is annotation-only or dropped).
const MERGED_SCHEMA_KEYS = [
  "type",
  "nullable",
  "description",
  "format",
  "enum",
  "const",
  "properties",
  "items",
  "required",
  "anyOf",
];

type SanitizeResult = Schema | typeof BUDGET_EXHAUSTED;

interface SanitizeState {
  activeRefs: Set<string>;
  remainingNodes: number;
}

function resolveRef(ref: string, defs: Map<string, unknown>): unknown {
  // Only local pointers into the schema's own $defs/definitions are safe to inline.
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) return undefined;
  try {
    return defs.get(decodeURIComponent(match[1]!.replace(/~1/g, "/").replace(/~0/g, "~")));
  } catch {
    return undefined;
  }
}

function collectDefs(root: unknown, defs: Map<string, unknown>): void {
  if (!isRecord(root)) return;
  for (const bag of ["$defs", "definitions"] as const) {
    const group = root[bag];
    if (!isRecord(group)) continue;
    for (const [name, value] of Object.entries(group)) {
      if (!defs.has(name)) defs.set(name, value);
    }
  }
}

/** Overlay keys beat the ref target's. Only allowlisted keys are copied, so an untrusted definition is never spread wholesale. */
function mergeRefTarget(target: Schema, overlay: Schema): Schema {
  const merged: Schema = {};
  if (Object.hasOwn(target, "$ref")) merged.$ref = target.$ref;
  for (const key of MERGED_SCHEMA_KEYS) {
    if (Object.hasOwn(overlay, key)) merged[key] = overlay[key];
    else if (Object.hasOwn(target, key)) merged[key] = target[key];
  }
  return merged;
}

function normalizeType(value: unknown, out: Schema, preserveNullType: boolean): void {
  let sawNull = false;
  for (const candidate of Array.isArray(value) ? value : [value]) {
    if (typeof candidate !== "string") continue;
    const type = candidate.toLowerCase();
    if (type === "null") sawNull = true;
    else if (Object.hasOwn(ALLOWED_TYPES, type) && out.type === undefined) out.type = type;
  }
  if (!sawNull) return;
  if (out.type !== undefined) out.nullable = true;
  else if (preserveNullType) out.type = "null";
  else out.nullable = true;
}

function sanitizeEnum(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = [...new Set(value.filter((item): item is string => typeof item === "string"))];
  return values.length > 0 ? values : undefined;
}

function normalizeAnyOf(
  value: unknown,
  defs: Map<string, unknown>,
  depth: number,
  refDepth: number,
  state: SanitizeState,
): Schema {
  if (!Array.isArray(value) || value.length === 0) return {};
  const schemas: Schema[] = [];
  for (const branch of value) {
    if (state.remainingNodes <= 0) return {};
    const schema = sanitizeSchema(branch, defs, depth + 1, refDepth, true, state);
    if (schema === BUDGET_EXHAUSTED) return {};
    schemas.push(schema);
  }

  const nonNull = schemas.filter((schema) => schema.type !== "null");
  const nulls = schemas.filter((schema) => schema.type === "null");
  if (
    nonNull.length === 1 &&
    nulls.length > 0 &&
    nulls.every((schema) => Object.keys(schema).every((key) => key === "type"))
  ) {
    return { ...nonNull[0], nullable: true };
  }

  const type = schemas[0]?.type;
  const allowedKeys = new Set(type === undefined ? ["enum"] : ["type", "enum"]);
  const sameType = schemas.every((schema) => schema.type === type);
  const enumOnly = schemas.every(
    (schema) => Array.isArray(schema.enum) && Object.keys(schema).every((k) => allowedKeys.has(k)),
  );
  if (sameType && enumOnly && type !== "null") {
    const values = sanitizeEnum(schemas.flatMap((schema) => schema.enum as unknown[]));
    if (values) return { ...(typeof type === "string" ? { type } : {}), enum: values };
  }

  // CCA's Claude bridge turns typed anyOf branches into an invalid input_schema: widen only this node.
  return {};
}

function sanitizeProperties(
  value: unknown,
  defs: Map<string, unknown>,
  depth: number,
  refDepth: number,
  state: SanitizeState,
): Record<string, Schema> | undefined {
  if (!isRecord(value)) return undefined;
  const properties = Object.create(null) as Record<string, Schema>;
  for (const name in value) {
    if (!Object.hasOwn(value, name)) continue;
    if (state.remainingNodes <= 0) break;
    // Property names form a name bag and must never be interpreted as schema keywords.
    const schema = sanitizeSchema(value[name], defs, depth + 1, refDepth, false, state);
    if (schema === BUDGET_EXHAUSTED) break;
    properties[name] = schema;
  }
  return properties;
}

/**
 * Gemini rejects an array declaration without `items`, so no return may leave one incomplete. The
 * synthesized string item charges the node budget; if it cannot be paid for the array is dropped.
 */
function completeArrayItems(out: Schema, state: SanitizeState): SanitizeResult {
  if (out.type !== "array" || Object.hasOwn(out, "items")) return out;
  if (state.remainingNodes <= 0) return BUDGET_EXHAUSTED;
  state.remainingNodes -= 1;
  out.items = { type: "string" };
  return out;
}

function sanitizeSchema(
  node: unknown,
  defs: Map<string, unknown>,
  depth: number,
  refDepth: number,
  preserveNullType: boolean,
  state: SanitizeState,
): SanitizeResult {
  if (state.remainingNodes <= 0) return BUDGET_EXHAUSTED;
  state.remainingNodes -= 1;
  if (depth >= MAX_SCHEMA_DEPTH || !isRecord(node)) return {};

  if (typeof node.$ref === "string" && refDepth < MAX_DEREF_DEPTH) {
    const target = resolveRef(node.$ref, defs);
    if (isRecord(target)) {
      if (state.activeRefs.has(node.$ref)) return {}; // recursive ref: widen
      state.activeRefs.add(node.$ref);
      try {
        return sanitizeSchema(
          mergeRefTarget(target, node),
          defs,
          depth,
          refDepth + 1,
          preserveNullType,
          state,
        );
      } finally {
        state.activeRefs.delete(node.$ref);
      }
    }
  }

  const out: Schema = {};
  normalizeType(node.type, out, preserveNullType);
  if (typeof node.nullable === "boolean") out.nullable = node.nullable;
  if (typeof node.description === "string") out.description = node.description;
  if (typeof node.format === "string") out.format = node.format;
  const enumValues = sanitizeEnum(
    node.enum ?? (typeof node.const === "string" ? [node.const] : undefined),
  );
  if (enumValues) out.enum = enumValues;

  const properties = sanitizeProperties(node.properties, defs, depth, refDepth, state);
  if (properties) {
    out.properties = properties;
    if (Array.isArray(node.required)) {
      const required = [
        ...new Set(node.required.filter((item): item is string => typeof item === "string")),
      ].filter((item) => Object.hasOwn(properties, item));
      if (required.length > 0) out.required = required;
    }
  }

  if (state.remainingNodes <= 0) return completeArrayItems(out, state);

  if (isRecord(node.items)) {
    const items = sanitizeSchema(node.items, defs, depth + 1, refDepth, false, state);
    if (items !== BUDGET_EXHAUSTED) out.items = items;
  }

  if (state.remainingNodes <= 0 || !Object.hasOwn(node, "anyOf"))
    return completeArrayItems(out, state);
  const normalized = normalizeAnyOf(node.anyOf, defs, depth, refDepth, state);
  for (const key of RETAINED_UNION_KEYS) {
    if (Object.hasOwn(normalized, key)) out[key] = normalized[key];
  }
  // Keys outside the retained set cannot come out of normalizeAnyOf; assign for exact parity.
  Object.assign(out, normalized);
  return completeArrayItems(out, state);
}

/** Function arguments are always an object; a missing root type / composition at the root is coerced. */
export function sanitizeToolParameters(parameters: unknown): Schema {
  if (parameters === undefined) return { type: "object", properties: {} };
  try {
    const defs = new Map<string, unknown>();
    collectDefs(parameters, defs);
    const state: SanitizeState = { activeRefs: new Set(), remainingNodes: MAX_SCHEMA_NODES };
    const sanitized = sanitizeSchema(parameters, defs, 0, 0, false, state);
    const root = sanitized === BUDGET_EXHAUSTED ? {} : sanitized;
    root.type = "object";
    if (!isRecord(root.properties)) root.properties = {};
    return root;
  } catch {
    // Last-resort containment: no third-party schema may break every tool in the request.
    return { type: "object", properties: {} };
  }
}
