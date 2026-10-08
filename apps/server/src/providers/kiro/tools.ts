// Adapted from lidge-jun/opencodex (MIT)
import { createHash } from "node:crypto";

export interface ClientTool {
  name: string;
  description: string | undefined;
  parameters: unknown;
}

const MAX_TOOL_DESCRIPTION = 1024;
/** GPT-5.6 Sol is the one model verified to accept longer descriptions. */
const MAX_TOOL_DESCRIPTION_LONG = 9_216;
/** Kiro rejects very large catalogs; these bound what is sent (a measured 49-tool probe was ~108 KiB). */
const MAX_TOOL_COUNT = 48;
const MAX_TOOL_CATALOG_BYTES = 96_000;

/**
 * JSON Schema keywords Kiro's runtime rejects ("ValidationException: Invalid tool use format.").
 * They are advisory to the model, so they are dropped everywhere in the schema tree.
 */
const REJECTED_SCHEMA_KEYS: Record<string, true> = {
  additionalProperties: true,
  pattern: true,
  format: true,
  minLength: true,
  maxLength: true,
  minimum: true,
  maximum: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  multipleOf: true,
  minItems: true,
  maxItems: true,
  uniqueItems: true,
  minProperties: true,
  maxProperties: true,
  contentEncoding: true,
  contentMediaType: true,
  $schema: true,
  patternProperties: true,
  propertyNames: true,
  dependentSchemas: true,
  dependentRequired: true,
  if: true,
  // `then` is rejected too; see sanitizeSchema (a `then` key in a literal trips no-thenable).
  else: true,
  contains: true,
  unevaluatedProperties: true,
  unevaluatedItems: true,
  encrypted: true,
};

/** Keys whose values map a *name* to a schema: names must survive even when they equal a rejected keyword. */
const SCHEMA_MAP_KEYS: Record<string, true> = { properties: true, $defs: true, definitions: true };

function sanitizeSchemaMap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return sanitizeSchema(value);
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value)) out[name] = sanitizeSchema(child);
  return out;
}

function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "then" || Object.hasOwn(REJECTED_SCHEMA_KEYS, key)) continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    out[key] = Object.hasOwn(SCHEMA_MAP_KEYS, key)
      ? sanitizeSchemaMap(child)
      : sanitizeSchema(child);
  }
  return out;
}

const COMPOSITION_KEYS = ["oneOf", "anyOf", "allOf"] as const;

/**
 * Bedrock-backed models need a root `type: "object"` and refuse root oneOf/anyOf/allOf. A root
 * composition is flattened into one object schema: allOf merges `required` (conjunction), anyOf/oneOf
 * drop it so a single valid branch still passes.
 */
function ensureRootObjectType(schema: unknown): Record<string, unknown> {
  const obj =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : {};
  if (!COMPOSITION_KEYS.some((k) => Array.isArray(obj[k])))
    return obj.type === "object" ? obj : { ...obj, type: "object" };

  const props: Record<string, unknown> = {};
  const required = new Set<string>();
  if (obj.properties && typeof obj.properties === "object")
    Object.assign(props, sanitizeSchemaMap(obj.properties));
  if (Array.isArray(obj.required))
    for (const r of obj.required) if (typeof r === "string") required.add(r);
  for (const key of COMPOSITION_KEYS) {
    const variants = obj[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
      const v = variant as Record<string, unknown>;
      if (v.properties && typeof v.properties === "object")
        Object.assign(props, sanitizeSchemaMap(v.properties));
      if (key === "allOf" && Array.isArray(v.required))
        for (const r of v.required) if (typeof r === "string") required.add(r);
    }
  }
  const merged: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj)) {
    if (key === "type" || key === "properties" || key === "required") continue;
    if ((COMPOSITION_KEYS as readonly string[]).includes(key)) continue;
    merged[key] = child;
  }
  merged.type = "object";
  if (Object.keys(props).length > 0) merged.properties = props;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

function truncateDescription(description: string, limit: number): string {
  if (description.length <= limit) return description;
  let end = limit - 1;
  // Never end on a lone high surrogate: encoding it would substitute U+FFFD.
  const last = description.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${description.slice(0, end)}…`;
}

/** CodeWhisperer toolUseId constraint: `^[a-zA-Z0-9_-]{1,64}$`. */
export function normalizeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * Kiro rejects a `toolSpecification.name` outside `^[a-zA-Z0-9_-]{1,64}$`. Conforming, unclaimed names
 * pass through; anything else becomes `<=55-char cleaned prefix>_<8 hex of sha256(original)>`, salted
 * until unclaimed, so distinct client names can never collapse to one Kiro name.
 */
function kiroToolName(wireName: string, used: Set<string>): string {
  const cleaned = wireName.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (cleaned === wireName && cleaned.length >= 1 && cleaned.length <= 64 && !used.has(cleaned)) {
    used.add(cleaned);
    return cleaned;
  }
  const base = cleaned.slice(0, 55) || "tool";
  for (let salt = 0; ; salt++) {
    const input = salt === 0 ? wireName : `${wireName}#${salt}`;
    const candidate = `${base}_${createHash("sha256").update(input).digest("hex").slice(0, 8)}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export interface ToolNames {
  /** Kiro-safe name for a client tool name (stable within one request). */
  alias(clientName: string): string;
  /** Kiro name -> client name, for names that had to be rewritten. */
  readonly nameMap: Map<string, string>;
}

/** One collision domain for advertised tools and replayed calls; `nameMap` restores client names on the response. */
export function createToolNames(): ToolNames {
  const used = new Set<string>();
  const byClientName = new Map<string, string>();
  const nameMap = new Map<string, string>();
  return {
    alias(clientName) {
      const existing = byClientName.get(clientName);
      if (existing) return existing;
      const alias = kiroToolName(clientName, used);
      byClientName.set(clientName, alias);
      if (alias !== clientName) nameMap.set(alias, clientName);
      return alias;
    },
    nameMap,
  };
}

/**
 * Converts the client's tools to Kiro `toolSpecification`s within the catalog budget. Tools that do
 * not fit are dropped from the end and named in `notice`, which the caller appends to the system prompt
 * so the model knows they are unavailable this turn.
 */
export function convertTools(
  tools: readonly ClientTool[],
  modelId: string,
  names: ToolNames,
): { specs: unknown[]; notice: string | undefined } {
  const limit = modelId === "gpt-5.6-sol" ? MAX_TOOL_DESCRIPTION_LONG : MAX_TOOL_DESCRIPTION;
  const converted = tools.map((tool) => ({
    tool,
    spec: {
      toolSpecification: {
        name: names.alias(tool.name),
        description: truncateDescription(tool.description || `Tool: ${tool.name}`, limit),
        inputSchema: { json: ensureRootObjectType(sanitizeSchema(tool.parameters ?? {})) },
      },
    },
  }));
  const specs: unknown[] = [];
  for (const entry of converted) {
    if (
      specs.length + 1 > MAX_TOOL_COUNT ||
      Buffer.byteLength(JSON.stringify([...specs, entry.spec])) > MAX_TOOL_CATALOG_BYTES
    )
      break;
    specs.push(entry.spec);
  }
  const omitted = converted.slice(specs.length).map((entry) => names.alias(entry.tool.name));
  if (omitted.length === 0) return { specs, notice: undefined };
  const shown = omitted.slice(0, 12);
  const rest = omitted.length - shown.length;
  return {
    specs,
    notice: `[router] Kiro's outbound catalog budget allows ${specs.length} of ${converted.length} client tools this turn. Omitted and unavailable this turn: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}.`,
  };
}
