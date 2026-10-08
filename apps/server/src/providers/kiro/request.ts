// Adapted from lidge-jun/opencodex (MIT)
import { randomUUID } from "node:crypto";
import {
  injectThinkingTags,
  nativeEffortField,
  NATIVE_EFFORTS,
  normalizeKiroModelId,
} from "./reasoning.ts";
import { convertTools, createToolNames, normalizeToolId, type ClientTool } from "./tools.ts";
import { estimateInputTokens } from "./usage.ts";
import type { RequestIdentity } from "./wire.ts";

export interface KiroImage {
  /** `jpeg` | `png` | `webp` | `gif`, from the media subtype. */
  format: string;
  /** Pure base64, no `data:` prefix. */
  source: { bytes: string };
}

export interface KiroToolUse {
  name: string;
  /** An object, not a JSON string. */
  input: Record<string, unknown>;
  toolUseId: string;
}

export interface KiroToolResult {
  content: { text: string }[];
  status: "success" | "error";
  toolUseId: string;
}

export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: string;
  userInputMessageContext?: { tools?: unknown[]; toolResults?: KiroToolResult[] };
  images?: KiroImage[];
}

export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: { content: string; toolUses?: KiroToolUse[] };
}

/** The request cannot be expressed in Kiro's wire format; surfaced to the client as HTTP 400. */
export class KiroRequestError extends Error {}

export interface BuiltKiroRequest {
  payload: Record<string, unknown>;
  /** Kiro tool name -> client tool name, for names that had to be rewritten. */
  nameMap: Map<string, string>;
  /** Heuristic prompt size, used when the stream reports no token counts. */
  estimatedInputTokens: number;
}

const CONTINUATION_MESSAGE =
  "Continue from the prior conversation. Do not quote or mention this instruction.";
const EMPTY_TOOL_RESULT_MESSAGE = "The tool completed without textual output.";
const TOOL_RESULT_CARRIER_MESSAGE = "The requested tool result is attached.";

/** 100 images/request is Kiro's own limit (IMAGE_COUNT_EXCEEDED); 20/message is the adjacent Bedrock limit. */
const MAX_IMAGES_PER_MESSAGE = 20;
const MAX_IMAGES_PER_REQUEST = 100;
const MESSAGE_CAP_NOTE =
  "[image omitted: exceeded the 20-image per-message cap; oldest images in this message were dropped]";
const REQUEST_CAP_NOTE =
  "[images omitted: exceeded the 100-image request cap; oldest images in this message were dropped]";
const REQUEST_CAP_EMPTY_NOTE =
  "[images omitted: exceeded the 100-image request cap; no images remain in this message]";

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

interface UserTurn {
  kind: "user";
  content: string;
  images: KiroImage[];
  toolResults: KiroToolResult[];
}
interface AssistantTurn {
  kind: "assistant";
  content: string;
  toolUses: KiroToolUse[];
}
type Turn = UserTurn | AssistantTurn;

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const appendText = (target: string, next: string) =>
  next ? (target ? `${target}\n\n${next}` : next) : target;

function validateCapabilities(body: Rec): void {
  const choice = body.tool_choice;
  if (choice !== undefined && choice !== null && choice !== "auto" && choice !== "none")
    throw new KiroRequestError("Kiro supports only automatic tool choice or tool_choice:none");
  if (typeof body.service_tier === "string")
    throw new KiroRequestError("Kiro does not support service tiers");
  // The wire has no schema-constrained response mode; a caller expecting parseable JSON would get prose.
  const format = isRec(body.response_format) ? body.response_format.type : undefined;
  if (format !== undefined && format !== "text")
    throw new KiroRequestError("Kiro does not support structured output (response_format)");
}

function readTools(tools: unknown): ClientTool[] {
  if (!Array.isArray(tools)) return [];
  const out: ClientTool[] = [];
  for (const raw of tools) {
    if (!isRec(raw) || raw.type !== "function") continue;
    const fn = isRec(raw.function) ? raw.function : raw;
    if (typeof fn.name !== "string" || fn.name.length === 0) continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters: fn.parameters,
    });
  }
  return out;
}

function imageUrlOf(part: Rec): string | undefined {
  if (part.type !== "image_url" && part.type !== "input_image") return undefined;
  const value = isRec(part.image_url) ? part.image_url.url : part.image_url;
  return typeof value === "string" ? value : undefined;
}

/** Kiro inlines base64 bytes only; remote references are never fetched. */
function parseDataUrlImage(url: string): KiroImage | undefined {
  if (!url.startsWith("data:")) return undefined;
  const comma = url.indexOf(",");
  if (comma === -1) return undefined;
  const bytes = url.slice(comma + 1);
  if (!bytes) return undefined;
  const mediaType = url.slice(5, comma).split(";")[0] || "image/jpeg";
  const subtype = (mediaType.includes("/") ? mediaType.split("/")[1] : mediaType) || "jpeg";
  const format = subtype.toLowerCase() === "jpg" ? "jpeg" : subtype.toLowerCase();
  return { format, source: { bytes } };
}

interface ReadContent {
  text: string;
  images: KiroImage[];
  /** Content-free note for images that could not be inlined, so the loss is never silent. */
  omitted: string;
}

/** Text parts joined by newline, inline images extracted, everything else refused or ignored. */
function readContent(content: unknown): ReadContent {
  if (typeof content === "string") return { text: content, images: [], omitted: "" };
  const texts: string[] = [];
  const images: KiroImage[] = [];
  let remote = 0;
  let malformed = 0;
  for (const raw of Array.isArray(content) ? content : []) {
    if (typeof raw === "string") {
      texts.push(raw);
      continue;
    }
    if (!isRec(raw)) continue;
    if (
      (raw.type === "text" || raw.type === "input_text" || raw.type === "output_text") &&
      typeof raw.text === "string"
    ) {
      texts.push(raw.text);
      continue;
    }
    const url = imageUrlOf(raw);
    if (url !== undefined) {
      const image = parseDataUrlImage(url);
      if (image) images.push(image);
      else if (url.startsWith("data:")) malformed++;
      else remote++;
      continue;
    }
    if (raw.type === "file" || raw.type === "input_audio" || raw.type === "video_url")
      throw new KiroRequestError(`Kiro does not support "${String(raw.type)}" content parts`);
  }
  const notes: string[] = [];
  if (remote === 1)
    notes.push("[image omitted: remote image references are not supported by this provider]");
  else if (remote > 1)
    notes.push(
      `[${remote} images omitted: remote image references are not supported by this provider]`,
    );
  if (malformed === 1) notes.push("[image omitted: malformed inline image data URL]");
  else if (malformed > 1)
    notes.push(`[${malformed} images omitted: malformed inline image data URLs]`);
  return { text: texts.join("\n"), images, omitted: notes.join("\n") };
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRec(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isRec(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRec(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function capImages(turns: Turn[]): void {
  const users = turns.filter((t): t is UserTurn => t.kind === "user");
  for (const turn of users) {
    if (turn.images.length <= MAX_IMAGES_PER_MESSAGE) continue;
    turn.images.splice(0, turn.images.length - MAX_IMAGES_PER_MESSAGE);
    turn.content = turn.content ? `${turn.content}\n${MESSAGE_CAP_NOTE}` : MESSAGE_CAP_NOTE;
  }
  let excess = users.reduce((n, t) => n + t.images.length, 0) - MAX_IMAGES_PER_REQUEST;
  for (const turn of users) {
    if (excess <= 0) break;
    const drop = Math.min(excess, turn.images.length);
    if (drop === 0) continue;
    turn.images.splice(0, drop);
    excess -= drop;
    const note = turn.images.length === 0 ? REQUEST_CAP_EMPTY_NOTE : REQUEST_CAP_NOTE;
    turn.content = turn.content ? `${turn.content}\n${note}` : note;
  }
}

/** Kiro's own invariants: strictly alternating roles, non-empty turns, every tool use answered exactly once. */
function validateConversation(entries: readonly KiroHistoryEntry[]): void {
  const pending = new Set<string>();
  let previous: "user" | "assistant" | undefined;
  for (const entry of entries) {
    const user = entry.userInputMessage;
    const assistant = entry.assistantResponseMessage;
    const role = user ? "user" : "assistant";
    if (role === previous) throw new KiroRequestError("Kiro conversation roles must alternate");
    previous = role;

    if (user) {
      if (
        !user.content.trim() &&
        !user.images?.length &&
        !user.userInputMessageContext?.toolResults?.length
      )
        throw new KiroRequestError("Kiro user messages must not be empty");
      for (const result of user.userInputMessageContext?.toolResults ?? []) {
        if (!pending.delete(result.toolUseId))
          throw new KiroRequestError(
            `Kiro tool result has no matching tool use ${JSON.stringify(result.toolUseId)}`,
          );
      }
      continue;
    }
    const toolUses = assistant?.toolUses ?? [];
    if (!assistant?.content.trim() && toolUses.length === 0)
      throw new KiroRequestError("Kiro assistant messages must not be empty");
    for (const toolUse of toolUses) {
      if (pending.has(toolUse.toolUseId))
        throw new KiroRequestError(
          `Kiro conversation contains duplicate tool use ${JSON.stringify(toolUse.toolUseId)}`,
        );
      pending.add(toolUse.toolUseId);
    }
  }
  if (pending.size > 0)
    throw new KiroRequestError("Kiro conversation contains an unanswered tool use");
}

/** Builds the `GenerateAssistantResponse` request from an OpenAI chat-completions body. */
export function buildKiroRequest(body: Rec, identity: RequestIdentity): BuiltKiroRequest {
  validateCapabilities(body);
  const modelId = normalizeKiroModelId(String(body.model));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const origin = identity.wireClient === "cli" ? "KIRO_CLI" : "AI_EDITOR";

  const names = createToolNames();
  const clientTools = readTools(body.tools);
  // Every listed name is validated and claimed even when tool_choice:none advertises none of them.
  for (const tool of clientTools) names.alias(tool.name);
  const { specs: toolSpecs, notice } = convertTools(
    body.tool_choice === "none" ? [] : clientTools,
    modelId,
    names,
  );

  const systemParts: string[] = [];
  const turns: Turn[] = [];
  /** Normalized toolUseId -> the client's raw id. */
  const priorCalls = new Map<string, string>();
  /** Raw ids of tool calls whose result has not arrived yet. */
  const pending = new Set<string>();
  /** Instructions that arrived inside an open tool batch; they wait so call and result stay adjacent. */
  const held: string[] = [];

  const pushUser = (
    content: string,
    images: KiroImage[] = [],
    toolResults: KiroToolResult[] = [],
  ) => {
    const last = turns.at(-1);
    if (last?.kind === "user") {
      last.content = appendText(last.content, content);
      last.images.push(...images);
      last.toolResults.push(...toolResults);
    } else {
      turns.push({ kind: "user", content, images: [...images], toolResults: [...toolResults] });
    }
  };
  const pushAssistant = (content: string, toolUses: KiroToolUse[]) => {
    const last = turns.at(-1);
    if (last?.kind === "assistant") {
      last.content = appendText(last.content, content);
      last.toolUses.push(...toolUses);
    } else {
      turns.push({ kind: "assistant", content, toolUses: [...toolUses] });
    }
  };
  const releaseHeld = () => {
    if (held.length === 0) return;
    pushUser(held.join("\n\n"));
    held.length = 0;
  };
  /** A user or assistant message ends any open tool batch. */
  const beginTurn = () => {
    releaseHeld();
    pending.clear();
  };

  for (const msg of messages) {
    if (!isRec(msg)) continue;
    switch (msg.role) {
      case "system":
      case "developer": {
        const { text } = readContent(msg.content);
        // A leading block is this request's system prompt; later ones apply from where they stand.
        if (turns.length === 0) {
          if (text.trim()) systemParts.push(text);
        } else if (text.trim()) {
          if (pending.size > 0) held.push(text.trim());
          else pushUser(text.trim());
        }
        break;
      }
      case "user": {
        beginTurn();
        const { text, images, omitted } = readContent(msg.content);
        const content = omitted ? (text ? `${text}\n${omitted}` : omitted) : text;
        if (content || images.length > 0) pushUser(content, images);
        break;
      }
      case "assistant": {
        beginTurn();
        const toolUses: KiroToolUse[] = [];
        for (const raw of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
          if (!isRec(raw)) continue;
          const fn = isRec(raw.function) ? raw.function : undefined;
          if (typeof fn?.name !== "string" || !fn.name)
            throw new KiroRequestError("tool_calls entries require function.name");
          const rawId =
            typeof raw.id === "string" && raw.id
              ? raw.id
              : `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
          const toolUseId = normalizeToolId(rawId);
          if (priorCalls.has(toolUseId))
            throw new KiroRequestError(
              `Kiro history contains duplicate tool call id ${JSON.stringify(rawId)}`,
            );
          priorCalls.set(toolUseId, rawId);
          pending.add(rawId);
          toolUses.push({
            name: names.alias(fn.name),
            input: parseToolArguments(fn.arguments),
            toolUseId,
          });
        }
        const text = assistantText(msg.content);
        // Reasoning is not replayable on the Kiro wire; a turn with nothing else has no visible content.
        if (text || toolUses.length > 0) pushAssistant(text, toolUses);
        break;
      }
      case "tool": {
        const callId =
          typeof msg.tool_call_id === "string"
            ? msg.tool_call_id
            : typeof msg.tool_use_id === "string"
              ? msg.tool_use_id
              : "";
        if (!callId) throw new KiroRequestError("tool messages require tool_call_id");
        const toolUseId = normalizeToolId(callId);
        if (priorCalls.get(toolUseId) !== callId)
          throw new KiroRequestError(
            `Kiro history contains an orphaned tool result for call ${JSON.stringify(callId)}`,
          );
        const { text, images, omitted } = readContent(msg.content);
        const chosen = text.trim() ? text : EMPTY_TOOL_RESULT_MESSAGE;
        pushUser("", images, [
          {
            content: [{ text: omitted ? `${chosen}\n${omitted}` : chosen }],
            status: "success",
            toolUseId,
          },
        ]);
        pending.delete(callId);
        if (pending.size === 0) releaseHeld();
        break;
      }
    }
  }
  releaseHeld();

  if (turns.length === 0 && systemParts.length === 0)
    throw new KiroRequestError("messages must include at least one user/assistant/tool turn");
  if (notice) systemParts.push(notice);

  if (turns.length === 0 || turns[0]?.kind === "assistant")
    turns.unshift({ kind: "user", content: CONTINUATION_MESSAGE, images: [], toolResults: [] });
  // Kiro requires the request to end with a user turn.
  if (turns.at(-1)?.kind === "assistant")
    turns.push({ kind: "user", content: CONTINUATION_MESSAGE, images: [], toolResults: [] });
  capImages(turns);
  // A tool-result-only turn carries a sentence; real text from the same turn is never preceded by filler.
  for (const turn of turns) {
    if (turn.kind === "user" && !turn.content.trim() && turn.toolResults.length > 0)
      turn.content = TOOL_RESULT_CARRIER_MESSAGE;
  }

  const currentTurn = turns.pop();
  if (currentTurn?.kind !== "user")
    throw new KiroRequestError("Kiro request must end with a user turn");
  const toEntry = (turn: Turn): KiroHistoryEntry =>
    turn.kind === "assistant"
      ? {
          assistantResponseMessage: {
            content: turn.content,
            ...(turn.toolUses.length > 0 ? { toolUses: turn.toolUses } : {}),
          },
        }
      : {
          userInputMessage: {
            content: turn.content,
            modelId,
            origin,
            ...(turn.images.length > 0 ? { images: turn.images } : {}),
            ...(turn.toolResults.length > 0
              ? { userInputMessageContext: { toolResults: turn.toolResults } }
              : {}),
          },
        };
  const history = turns.map(toEntry);
  const current = toEntry(currentTurn);
  const currentMessage = current.userInputMessage!;

  // Kiro has no system role: the prompt rides in front of the first user message.
  if (systemParts.length > 0) {
    const target = history.find((e) => e.userInputMessage)?.userInputMessage ?? currentMessage;
    target.content = `${systemParts.join("\n\n")}\n\n${target.content}`;
  }
  if (toolSpecs.length > 0)
    currentMessage.userInputMessageContext = {
      ...currentMessage.userInputMessageContext,
      tools: toolSpecs,
    };

  const maxTokens =
    typeof body.max_completion_tokens === "number"
      ? body.max_completion_tokens
      : typeof body.max_tokens === "number"
        ? body.max_tokens
        : undefined;
  const effortValue = isRec(body.reasoning) ? body.reasoning.effort : undefined;
  const effort = [body.reasoning_effort, effortValue].find(
    (v): v is string => typeof v === "string" && EFFORTS.includes(v),
  );
  if (
    !currentMessage.userInputMessageContext?.toolResults &&
    currentMessage.content !== CONTINUATION_MESSAGE
  )
    currentMessage.content = injectThinkingTags(currentMessage.content, modelId, effort, maxTokens);

  validateConversation([...history, current]);

  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      ...(identity.wireClient === "cli"
        ? { agentContinuationId: randomUUID(), agentTaskType: "vibe" }
        : {}),
      conversationId: randomUUID(),
      currentMessage: { userInputMessage: currentMessage },
      ...(history.length > 0 ? { history } : {}),
    },
  };
  if (nativeEffortField(modelId) && effort && effort !== "none") {
    if (!NATIVE_EFFORTS.includes(effort))
      throw new KiroRequestError(
        `Kiro ${modelId} does not support reasoning effort ${JSON.stringify(effort)}`,
      );
    const field = nativeEffortField(modelId, effort);
    if (field) payload.additionalModelRequestFields = { [field]: { effort } };
  }
  if (identity.profileArn) payload.profileArn = identity.profileArn;
  return {
    payload,
    nameMap: names.nameMap,
    estimatedInputTokens: estimateInputTokens(history, current),
  };
}
