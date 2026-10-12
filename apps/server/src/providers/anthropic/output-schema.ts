// Adapted from lidge-jun/opencodex (MIT): src/adapters/anthropic-output-schema.ts
// Based on Anthropic SDK's transformJSONSchema, preserving root $defs required by a root $ref:
// https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/transform-json-schema.ts
import { isRecord } from "./json.ts";

/** String formats `output_config.format` accepts; any other is folded into the description. */
const SUPPORTED_STRING_FORMATS: Record<string, true> = {
  "date-time": true,
  time: true,
  date: true,
  duration: true,
  email: true,
  hostname: true,
  uri: true,
  ipv4: true,
  ipv6: true,
  uuid: true,
};

type Schema = Record<string, unknown>;

function take(schema: Schema, key: string): unknown {
  const value = schema[key];
  delete schema[key];
  return value;
}

function normalizeSubschema(value: unknown): unknown {
  return isRecord(value) ? normalizeSchema(value) : value;
}

/**
 * Anthropic's structured output accepts a subset of JSON Schema: objects must be closed, `oneOf`
 * becomes `anyOf`, and constraints it cannot enforce are moved into the description so the model
 * still sees them. Consumes `schema`.
 */
function normalizeSchema(schema: Schema): Schema {
  const normalized: Schema = {};

  const defs = take(schema, "$defs");
  if (isRecord(defs)) {
    normalized.$defs = Object.fromEntries(
      Object.entries(defs).map(([name, definition]) => [name, normalizeSubschema(definition)]),
    );
  }

  const ref = take(schema, "$ref");
  if (ref !== undefined) {
    normalized.$ref = ref;
    return normalized;
  }

  const type = take(schema, "type");
  const { anyOf, oneOf, allOf } = schema;

  if (Array.isArray(anyOf)) {
    take(schema, "anyOf");
    normalized.anyOf = anyOf.map(normalizeSubschema);
  } else if (Array.isArray(oneOf)) {
    take(schema, "oneOf");
    normalized.anyOf = oneOf.map(normalizeSubschema);
  } else if (Array.isArray(allOf)) {
    take(schema, "allOf");
    normalized.allOf = allOf.map(normalizeSubschema);
  } else {
    if (type === undefined) {
      throw new Error("JSON schema must have a type defined if anyOf/oneOf/allOf are not used");
    }
    normalized.type = type;
  }

  const description = take(schema, "description");
  if (description !== undefined) normalized.description = description;
  const title = take(schema, "title");
  if (title !== undefined) normalized.title = title;

  if (type === "object") {
    const properties = take(schema, "properties");
    normalized.properties = isRecord(properties)
      ? Object.fromEntries(
          Object.entries(properties).map(([name, property]) => [
            name,
            normalizeSubschema(property),
          ]),
        )
      : {};
    take(schema, "additionalProperties");
    normalized.additionalProperties = false;
    const required = take(schema, "required");
    if (required !== undefined) normalized.required = required;
  } else if (type === "string") {
    const format = take(schema, "format");
    if (typeof format === "string" && Object.hasOwn(SUPPORTED_STRING_FORMATS, format)) {
      normalized.format = format;
    } else if (format !== undefined) {
      schema.format = format;
    }
  } else if (type === "array") {
    const items = take(schema, "items");
    if (items !== undefined) normalized.items = normalizeSubschema(items);
    const minItems = take(schema, "minItems");
    if (minItems === 0 || minItems === 1) normalized.minItems = minItems;
    else if (minItems !== undefined) schema.minItems = minItems;
  }

  const unsupported = Object.entries(schema);
  if (unsupported.length > 0) {
    const existing =
      typeof normalized.description === "string" ? `${normalized.description}\n\n` : "";
    normalized.description = `${existing}{${unsupported
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(", ")}}`;
  }

  return normalized;
}

/** Throws when the schema has a node without a `type` (and no `anyOf`/`oneOf`/`allOf`/`$ref`). */
export function normalizeOutputSchema(schema: Schema): Schema {
  return normalizeSchema(structuredClone(schema));
}
