// Adapted from lidge-jun/opencodex (MIT)
import { createHash } from "node:crypto";
import { isRecord } from "./json.ts";
import { sanitizeToolParameters } from "./tool-schema.ts";

type JsonObject = Record<string, unknown>;

const GOOGLE_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const THINKING_LEVELS: Record<string, true> = {
  minimal: true,
  low: true,
  medium: true,
  high: true,
};

/** Maps tool names to ones Google accepts (and back). Rewritten names keep a hash so they stay injective. */
function toolNameCodec(names: readonly string[]): {
  toWire: (name: string) => string;
  fromWire: (name: string) => string;
} {
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  const used = new Set<string>();

  for (const name of names) {
    if (toWire.has(name)) continue;
    if (GOOGLE_TOOL_NAME.test(name) && !used.has(name)) {
      toWire.set(name, name);
      fromWire.set(name, name);
      used.add(name);
      continue;
    }

    let cleaned = name.replace(/[^A-Za-z0-9_-]/g, "_");
    if (!/^[A-Za-z_]/.test(cleaned)) cleaned = `_${cleaned}`;
    const prefix = (cleaned || "tool").slice(0, 55);
    for (let salt = 0; ; salt++) {
      const hashInput = salt === 0 ? name : `${name}#${salt}`;
      const suffix = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
      const candidate = `${prefix}_${suffix}`;
      if (used.has(candidate)) continue;
      toWire.set(name, candidate);
      fromWire.set(candidate, name);
      used.add(candidate);
      break;
    }
  }

  return {
    toWire: (name) => toWire.get(name) ?? name,
    fromWire: (name) => fromWire.get(name) ?? name,
  };
}

function collectToolNames(body: JsonObject): string[] {
  const names: string[] = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) continue;
      for (const declaration of tool.functionDeclarations) {
        if (isRecord(declaration) && typeof declaration.name === "string")
          names.push(declaration.name);
      }
    }
  }
  if (Array.isArray(body.contents)) {
    for (const content of body.contents) {
      if (!isRecord(content) || !Array.isArray(content.parts)) continue;
      for (const part of content.parts) {
        if (!isRecord(part)) continue;
        for (const key of ["functionCall", "functionResponse"]) {
          const call = part[key];
          if (isRecord(call) && typeof call.name === "string") names.push(call.name);
        }
      }
    }
  }
  return names;
}

function compileContents(
  value: unknown,
  toWireName: (name: string) => string,
): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((rawContent) => {
    if (!isRecord(rawContent)) return {};
    const content = { ...rawContent };
    if (!Array.isArray(rawContent.parts)) return content;
    content.parts = rawContent.parts.map((rawPart) => {
      if (!isRecord(rawPart)) return {};
      const part = { ...rawPart };
      for (const key of ["functionCall", "functionResponse"]) {
        const call = rawPart[key];
        if (isRecord(call) && typeof call.name === "string") {
          part[key] = { ...call, name: toWireName(call.name) };
        }
      }
      return part;
    });
    return content;
  });
}

function compileTools(value: unknown, toWireName: (name: string) => string): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value.flatMap((tool) => {
    if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) return [];
    const functionDeclarations = tool.functionDeclarations.flatMap((declaration) => {
      if (!isRecord(declaration) || typeof declaration.name !== "string") return [];
      return [
        {
          name: toWireName(declaration.name),
          ...(typeof declaration.description === "string"
            ? { description: declaration.description }
            : {}),
          parameters: sanitizeToolParameters(declaration.parameters),
        },
      ];
    });
    return functionDeclarations.length > 0 ? [{ functionDeclarations }] : [];
  });
  return tools.length > 0 ? tools : undefined;
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function compileGenerationConfig(value: unknown): JsonObject | undefined {
  if (!isRecord(value)) return undefined;
  const out: JsonObject = {};
  const maxOutputTokens = finiteNumber(value.maxOutputTokens);
  if (maxOutputTokens !== undefined && maxOutputTokens > 0)
    out.maxOutputTokens = Math.floor(maxOutputTokens);
  const temperature = finiteNumber(value.temperature);
  if (temperature !== undefined && temperature >= 0) out.temperature = Math.min(2, temperature);
  const topP = finiteNumber(value.topP);
  if (topP !== undefined && topP >= 0) out.topP = Math.min(1, topP);
  if (Array.isArray(value.stopSequences)) {
    const stopSequences = [
      ...new Set(
        value.stopSequences.filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        ),
      ),
    ].slice(0, 5);
    if (stopSequences.length > 0) out.stopSequences = stopSequences;
  }
  if (isRecord(value.thinkingConfig)) {
    const thinking: JsonObject = {};
    if (typeof value.thinkingConfig.thinkingLevel === "string") {
      const raw = value.thinkingConfig.thinkingLevel.toLowerCase();
      const thinkingLevel = Object.hasOwn(THINKING_LEVELS, raw)
        ? raw
        : ["xhigh", "max", "ultra"].includes(raw)
          ? "high"
          : undefined;
      if (thinkingLevel) thinking.thinkingLevel = thinkingLevel;
    }
    // CCA serves thinking either way but withholds the `thought: true` text unless the request opts in.
    if (value.thinkingConfig.includeThoughts === true) thinking.includeThoughts = true;
    if (Object.keys(thinking).length > 0) out.thinkingConfig = thinking;
  }
  if (Array.isArray(value.responseModalities)) {
    const valid = value.responseModalities.filter(
      (m): m is string => typeof m === "string" && ["TEXT", "IMAGE", "AUDIO"].includes(m),
    );
    if (valid.length > 0) out.responseModalities = valid;
  }
  if (typeof value.responseMimeType === "string" && value.responseMimeType.length > 0) {
    out.responseMimeType = value.responseMimeType;
  }
  // A caller-authored output schema is not a tool declaration: carried through unmodified.
  if (isRecord(value.responseJsonSchema)) out.responseJsonSchema = value.responseJsonSchema;
  return Object.keys(out).length > 0 ? out : undefined;
}

function compileToolConfig(
  value: unknown,
  toWireName: (name: string) => string,
): JsonObject | undefined {
  if (!isRecord(value) || !isRecord(value.functionCallingConfig)) return undefined;
  const raw = value.functionCallingConfig;
  const out: JsonObject = {};
  if (
    typeof raw.mode === "string" &&
    ["AUTO", "ANY", "NONE", "VALIDATED"].includes(raw.mode.toUpperCase())
  ) {
    out.mode = raw.mode.toUpperCase();
  }
  if (Array.isArray(raw.allowedFunctionNames)) {
    const names = raw.allowedFunctionNames
      .filter((name): name is string => typeof name === "string")
      .map(toWireName);
    if (names.length > 0) out.allowedFunctionNames = names;
  }
  return Object.keys(out).length > 0 ? { functionCallingConfig: out } : undefined;
}

/**
 * Final trust boundary of every request: the adapter builds a convenient Gemini-shaped object, and
 * only this compiler decides what reaches the wire (whitelisted fields, sanitised tool schemas,
 * Google-legal tool names).
 */
export function compileGoogleWireBody(input: JsonObject): {
  body: JsonObject;
  restoreToolName: (name: string) => string;
} {
  const names = toolNameCodec(collectToolNames(input));
  const body: JsonObject = {};
  const contents = compileContents(input.contents, names.toWire);
  if (contents) body.contents = contents;
  if (isRecord(input.systemInstruction)) body.systemInstruction = input.systemInstruction;
  const tools = compileTools(input.tools, names.toWire);
  if (tools) body.tools = tools;
  const generationConfig = compileGenerationConfig(input.generationConfig);
  if (generationConfig) body.generationConfig = generationConfig;
  const toolConfig = compileToolConfig(input.toolConfig, names.toWire);
  if (toolConfig) body.toolConfig = toolConfig;
  if (typeof input.sessionId === "string" && input.sessionId.length > 0)
    body.sessionId = input.sessionId;
  return { body, restoreToolName: names.fromWire };
}
