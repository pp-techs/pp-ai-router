// Adapted from lidge-jun/opencodex (MIT)
import { createHash } from "node:crypto";
import { API_VERSION, USER_AGENT } from "./constants.ts";
import { isRecord } from "./json.ts";
import {
  clampMaxOutputTokens,
  IMAGE_CAPABLE_MODELS,
  rejectsClaudeSdkParagraph,
  resolveWireModel,
} from "./models.ts";
import { applyReplay, applySignatureFallback, usesReplayCache } from "./replay.ts";
import { compileGoogleWireBody } from "./wire-compiler.ts";

type Json = Record<string, unknown>;

/** The client's request cannot be expressed on this upstream (answered with a 400, never sent). */
export class UnsupportedRequestError extends Error {}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  wireModelId: string;
  sessionId: string;
  /** Maps a (possibly rewritten) tool name from the response back to the client's. */
  restoreToolName: (name: string) => string;
}

const EMPTY_PLACEHOLDER = "(empty)";
const EMPTY_TOOL_OUTPUT_PLACEHOLDER = "(empty tool output)";
const MISSING_TOOL_RESULT = "[missing tool_result for this tool_use in history]";
const CONTINUE_TURN = { role: "user", parts: [{ text: "(continue)" }] };

/** Tool-call ids Gemini/Claude-on-Antigravity accept: `[a-zA-Z0-9_-]{1,64}`. */
const CONFORMING_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Request-scoped raw-id -> wire-id mapping. Injective (conforming ids are reserved first, rewrites
 * get a hash and, on collision, a counter) and stable, so a result finds the wire id its call used.
 */
function createIdAllocator() {
  const rawToWire = new Map<string, string>();
  const occupied = new Set<string>();
  return {
    reserve(raw: string) {
      if (!CONFORMING_ID.test(raw) || rawToWire.has(raw)) return;
      rawToWire.set(raw, raw);
      occupied.add(raw);
    },
    allocate(raw: string): string | undefined {
      if (!raw) return undefined;
      const known = rawToWire.get(raw);
      if (known) return known;
      let wire = raw;
      if (!CONFORMING_ID.test(raw) || occupied.has(raw)) {
        const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
        const prefix = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
        const fit = (reserve: number) => `${prefix.slice(0, Math.max(1, 55 - reserve))}_${hash}`;
        wire = fit(0);
        for (let n = 2; occupied.has(wire); n++) wire = `${fit(`_${n}`.length)}_${n}`;
      }
      rawToWire.set(raw, wire);
      occupied.add(wire);
      return wire;
    },
    lookup: (raw: string) => rawToWire.get(raw),
  };
}

function parseDataUrl(url: string): { mime: string; data: string } | undefined {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);
  return match ? { mime: match[1]!, data: match[2]! } : undefined;
}

const inlineData = (mime: string, data: string) => ({ inline_data: { mime_type: mime, data } });

/** Text of an OpenAI content value (string or array of parts); non-text parts are skipped. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

function userParts(content: unknown): Json[] {
  if (typeof content === "string") return [{ text: content || EMPTY_PLACEHOLDER }];
  const parts: Json[] = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      if (part.text) parts.push({ text: part.text }); // an empty text part 400s on the Claude bridge
    } else if (part.type === "image_url") {
      const url = isRecord(part.image_url) ? part.image_url.url : part.image_url;
      if (typeof url !== "string") continue;
      const data = parseDataUrl(url);
      // A remote URL has no mime type we could supply: leave a marker instead of a huge inline blob.
      parts.push(data ? inlineData(data.mime, data.data) : { text: `[image: ${url}]` });
    } else if (part.type === "input_audio" && isRecord(part.input_audio)) {
      const { data, format } = part.input_audio;
      if (typeof data === "string")
        parts.push(inlineData(`audio/${typeof format === "string" ? format : "wav"}`, data));
    } else if (
      part.type === "file" &&
      isRecord(part.file) &&
      typeof part.file.file_data === "string"
    ) {
      const data = parseDataUrl(part.file.file_data);
      if (data) parts.push(inlineData(data.mime, data.data));
    }
  }
  return parts.length > 0 ? parts : [{ text: EMPTY_PLACEHOLDER }];
}

function parseArguments(raw: unknown): Json {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const toolOutput = (message: Json): string =>
  contentText(message.content) || EMPTY_TOOL_OUTPUT_PLACEHOLDER;

/** A functionResponse without an adjacent matching functionCall batch is invalid: keep it as plain text. */
const orphanResultPart = (message: Json): Json => ({
  text: `[tool_result without adjacent tool_use: ${typeof message.tool_call_id === "string" ? message.tool_call_id : "?"}]\n${toolOutput(message)}`,
});

interface PendingCall {
  wireId: string;
  name: string;
}

function messagesToContents(messages: unknown[]): { system: string[]; contents: Json[] } {
  const system: string[] = [];
  const contents: Json[] = [];
  const ids = createIdAllocator();
  const records = messages.filter(isRecord);
  for (const message of records) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls)
        if (isRecord(call) && typeof call.id === "string") ids.reserve(call.id);
    } else if (message.role === "tool" && typeof message.tool_call_id === "string") {
      ids.reserve(message.tool_call_id);
    }
  }

  for (let i = 0; i < records.length; i++) {
    const message = records[i]!;
    switch (message.role) {
      case "system":
      case "developer": {
        const text = contentText(message.content);
        if (text) system.push(text);
        break;
      }
      case "user":
        contents.push({ role: "user", parts: userParts(message.content) });
        break;
      case "assistant": {
        const parts: Json[] = [];
        const text = contentText(message.content);
        if (text) parts.push({ text });
        const calls: PendingCall[] = [];
        for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
          if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== "string")
            continue;
          const name = call.function.name;
          const wireId = ids.allocate(typeof call.id === "string" ? call.id : "");
          if (wireId === undefined) {
            // Claude-on-Antigravity needs a usable id for every tool_use; without one the pairing is lost.
            parts.push({
              text: `[tool_use without a usable id: ${name}]\n${typeof call.function.arguments === "string" ? call.function.arguments : ""}`,
            });
            continue;
          }
          calls.push({ wireId, name });
          parts.push({
            functionCall: { name, args: parseArguments(call.function.arguments), id: wireId },
          });
        }
        // A turn with nothing Gemini can represent would serialise as `parts: []`, which the bridge rejects.
        if (parts.length === 0) break;
        contents.push({ role: "model", parts });
        if (calls.length === 0) break;

        // One adjacent response batch for the whole function-call turn; repair only this wire boundary.
        const required = new Set(calls.map((call) => call.wireId));
        const results = new Map<string, Json>();
        const orphans: Json[] = [];
        let j = i + 1;
        while (j < records.length && records[j]!.role === "tool") {
          const result = records[j]!;
          const wireId =
            typeof result.tool_call_id === "string" ? ids.lookup(result.tool_call_id) : undefined;
          if (wireId !== undefined && required.has(wireId) && !results.has(wireId))
            results.set(wireId, result);
          else orphans.push(result);
          j++;
        }
        const responses: Json[] = calls.map((call) => {
          const result = results.get(call.wireId);
          return {
            functionResponse: {
              name: call.name,
              response: { result: result ? toolOutput(result) : MISSING_TOOL_RESULT },
              id: call.wireId,
            },
          };
        });
        contents.push({ role: "user", parts: [...responses, ...orphans.map(orphanResultPart)] });
        i = j - 1;
        break;
      }
      case "tool":
        contents.push({ role: "user", parts: [orphanResultPart(message)] });
        break;
    }
  }

  // A functionCall turn may not open the request (compaction can truncate the history that far).
  const first = contents[0];
  if (
    first?.role === "model" &&
    (first.parts as Json[]).some((part) => part.functionCall !== undefined)
  ) {
    contents.unshift(CONTINUE_TURN);
  }
  // Gemini and Claude-on-Antigravity reject histories that end on a model turn.
  const last = contents.at(-1);
  if (!last || last.role === "model") contents.push(CONTINUE_TURN);
  return { system, contents };
}

/** Strips Claude Code's `x-anthropic-billing-header: ...` first line, which CCA answers with a 429. */
const stripBillingHeader = (text: string): string =>
  text.replace(/^x-anthropic-billing-header:[^\n]*\n*/, "");

const REJECTED_CLAUDE_SDK_PARAGRAPH =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

interface Declaration {
  name: string;
  description?: string;
  parameters?: unknown;
  strict: boolean;
}

function declarations(tools: unknown): Declaration[] {
  const out: Declaration[] = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) continue;
    const fn = tool.function;
    if (typeof fn.name !== "string") continue;
    out.push({
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      parameters: fn.parameters,
      strict: fn.strict === true,
    });
  }
  return out;
}

/**
 * tool_choice on the wire. `auto` stays absent; `strict` tool declarations ask for VALIDATED (it
 * replaces AUTO only: ANY/NONE are stronger constraints the caller chose). `allowed_tools` filters
 * the declarations, and its `required` mode becomes ANY.
 */
function toolSelection(
  tools: Declaration[],
  choice: unknown,
): { tools: Declaration[]; toolConfig?: Json } {
  const mode = (name: string, allowed?: string[]): Json => ({
    functionCallingConfig: { mode: name, ...(allowed ? { allowedFunctionNames: allowed } : {}) },
  });
  const validated = tools.some((tool) => tool.strict) ? mode("VALIDATED") : undefined;
  const plain = (toolConfig?: Json) => ({ tools, ...(toolConfig ? { toolConfig } : {}) });
  if (choice === undefined || choice === null || choice === "auto") return plain(validated);
  if (choice === "none") return plain(mode("NONE"));
  if (choice === "required") return plain(mode("ANY"));
  if (isRecord(choice) && choice.type === "allowed_tools" && isRecord(choice.allowed_tools)) {
    const names = new Set<string>();
    for (const entry of Array.isArray(choice.allowed_tools.tools)
      ? choice.allowed_tools.tools
      : []) {
      if (isRecord(entry) && isRecord(entry.function) && typeof entry.function.name === "string") {
        names.add(entry.function.name);
      }
    }
    const filtered = tools.filter((tool) => names.has(tool.name));
    return {
      tools: filtered,
      ...(choice.allowed_tools.mode === "required"
        ? { toolConfig: mode("ANY") }
        : validated
          ? { toolConfig: validated }
          : {}),
    };
  }
  if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === "string") {
    return plain(mode("ANY", [choice.function.name]));
  }
  return plain(validated);
}

/**
 * Deterministic Cloud Code Assist session id from the first user message (sha256 -> uint64 & 0x7FFF..,
 * prefixed with "-"), mirroring CLIProxyAPI. Must be identical on turn N and N+1 so the thought-signature
 * replay keeps matching; random when there is no text to anchor on.
 */
function sessionIdFor(messages: unknown[]): string {
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "user") continue;
    const text = contentText(message.content);
    if (!text) continue;
    const digest = createHash("sha256").update(text, "utf8").digest();
    return `-${(digest.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString()}`;
  }
  return `-${Math.floor(Math.random() * 9e18)}`;
}

export function buildRequest(input: {
  baseUrl: string;
  token: string;
  project: string;
  body: Json;
  stream: boolean;
}): BuiltRequest {
  const { body } = input;
  const modelId = typeof body.model === "string" ? body.model : "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
  const { wireModelId, thinkingLevel } = resolveWireModel(modelId, effort);
  const isGemini = wireModelId.startsWith("gemini-");
  const isClaude = /claude/i.test(wireModelId);
  const isImageModel = IMAGE_CAPABLE_MODELS.has(modelId);

  const format = isRecord(body.response_format) ? body.response_format : undefined;
  const jsonSchema =
    format?.type === "json_schema" &&
    isRecord(format.json_schema) &&
    isRecord(format.json_schema.schema)
      ? format.json_schema.schema
      : undefined;
  if (format?.type === "json_schema" && !jsonSchema) {
    throw new UnsupportedRequestError(
      "response_format.json_schema.schema is required for type json_schema",
    );
  }
  if (format && (format.type === "json_schema" || format.type === "json_object")) {
    if (!isGemini) {
      throw new UnsupportedRequestError(
        "response_format is only supported for Gemini models on Google Antigravity",
      );
    }
    if (isImageModel) {
      throw new UnsupportedRequestError(
        "image-capable models cannot be combined with response_format",
      );
    }
  }

  const { system, contents } = messagesToContents(messages);
  let systemText = stripBillingHeader(system.join("\n\n"));
  if (rejectsClaudeSdkParagraph(modelId, wireModelId)) {
    systemText = systemText
      .split("\n\n")
      .filter((paragraph) => paragraph !== REJECTED_CLAUDE_SDK_PARAGRAPH)
      .join("\n\n");
  }

  const draft: Json = { contents };
  if (systemText) draft.systemInstruction = { parts: [{ text: systemText }] };

  let selection = toolSelection(declarations(body.tools), body.tool_choice);
  // Claude-on-Antigravity forces VALIDATED function calling; VALIDATED would defeat tool_choice "none",
  // so honour that one by dropping the declarations (the wire shape of a tool-less Claude turn).
  if (isClaude) {
    selection =
      body.tool_choice === "none"
        ? { tools: [] }
        : {
            tools: selection.tools,
            toolConfig: {
              functionCallingConfig: {
                ...(isRecord(selection.toolConfig?.functionCallingConfig)
                  ? selection.toolConfig.functionCallingConfig
                  : {}),
                mode: "VALIDATED",
              },
            },
          };
  }
  if (selection.tools.length > 0) {
    draft.tools = [
      {
        functionDeclarations: selection.tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      },
    ];
    // mode ANY / VALIDATED without declarations is a guaranteed 400.
    if (selection.toolConfig) draft.toolConfig = selection.toolConfig;
  }

  const generationConfig: Json = {};
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  const clamped = clampMaxOutputTokens(
    wireModelId,
    typeof maxTokens === "number" ? maxTokens : undefined,
  );
  if (clamped !== undefined) generationConfig.maxOutputTokens = clamped;
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature;
  if (typeof body.top_p === "number") generationConfig.topP = body.top_p;
  const stops =
    typeof body.stop === "string"
      ? [body.stop]
      : Array.isArray(body.stop)
        ? body.stop.filter((s) => typeof s === "string")
        : undefined;
  if (stops?.length) generationConfig.stopSequences = stops;
  // CCA serves thinking either way but withholds the thought text unless asked: ask when the client asked for reasoning.
  const includeThoughts = effort !== undefined && effort !== "none" && isGemini && !isImageModel;
  if (thinkingLevel || includeThoughts) {
    generationConfig.thinkingConfig = {
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(includeThoughts ? { includeThoughts: true } : {}),
    };
  } else if (isImageModel) {
    generationConfig.responseModalities = ["TEXT", "IMAGE"];
  }
  if (format?.type === "json_schema" || format?.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
    if (jsonSchema) generationConfig.responseJsonSchema = jsonSchema;
  }
  if (Object.keys(generationConfig).length > 0) draft.generationConfig = generationConfig;

  // The real client puts the session id ONLY at `request.sessionId`.
  const sessionId = sessionIdFor(messages);
  draft.sessionId = sessionId;

  const compiled = compileGoogleWireBody(draft);
  const request = compiled.body;
  // Names are compiled before replay: signatures are keyed by the exact provider-visible name.
  const wireContents = request.contents as unknown[];
  // Claude-on-Antigravity takes no replayed signatures, and we never put thought parts into history.
  if (usesReplayCache(wireModelId)) applyReplay(wireModelId, sessionId, wireContents);
  applySignatureFallback(wireModelId, wireContents);

  const method = input.stream ? "streamGenerateContent" : "generateContent";
  return {
    url: `${input.baseUrl.replace(/\/+$/, "")}/${API_VERSION}:${method}${input.stream ? "?alt=sse" : ""}`,
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({
      model: wireModelId,
      // Protocol constant, distinct from the HTTP User-Agent header (CLIProxyAPI `geminiToAntigravity`).
      userAgent: "antigravity",
      requestType: "agent",
      project: input.project,
      requestId: `agent-${crypto.randomUUID()}`,
      request,
    }),
    wireModelId,
    sessionId,
    restoreToolName: compiled.restoreToolName,
  };
}
