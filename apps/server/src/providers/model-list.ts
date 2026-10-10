import { isRecord } from "./anthropic/json.ts";
import type { ModelDetails, ModelInfo } from "./adapter.ts";

/** Upper bound on one provider's list: protects the DB and the admin UI from a hostile/buggy endpoint. */
export const MAX_MODELS = 5000;
const MAX_DESCRIPTION = 2000;
const MAX_LIST_ITEMS = 64;
const MAX_ITEM_LENGTH = 64;

function strings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = [
    ...new Set(
      v.filter(
        (s): s is string => typeof s === "string" && s !== "" && s.length <= MAX_ITEM_LENGTH,
      ),
    ),
  ].slice(0, MAX_LIST_ITEMS);
  return out.length > 0 ? out : undefined;
}

/** Unix seconds from a number (seconds, or milliseconds when implausibly large) or an ISO timestamp. */
function seconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0)
    return Math.floor(v > 1e11 ? v / 1000 : v);
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return undefined;
}

/** Modalities and parameters implied by an Anthropic-style `capabilities` object. */
function fromCapabilities(caps: Record<string, unknown>) {
  const on = (key: string) => isRecord(caps[key]) && caps[key].supported === true;
  const input = [
    "text",
    ...(on("image_input") ? ["image"] : []),
    ...(on("pdf_input") ? ["file"] : []),
  ];
  const params = [
    ...(on("thinking") ? ["reasoning"] : []),
    ...(on("structured_outputs") ? ["structured_outputs"] : []),
  ];
  return { input, params };
}

/**
 * Reads every fact a model entry may carry, whichever of the common spellings the upstream uses:
 * OpenRouter (`context_length`, `architecture`, `top_provider`, `supported_parameters`), Anthropic
 * (`display_name`, `max_input_tokens`, `max_tokens`, `capabilities`), Gemini (`displayName`,
 * `inputTokenLimit`, `outputTokenLimit`) and plain OpenAI (`created`). Unknown or malformed fields are
 * left out, never guessed.
 */
export function readModelDetails(item: Record<string, unknown>): ModelDetails {
  const details: ModelDetails = {};
  const id = typeof item.id === "string" ? item.id : undefined;

  // `name` is the display name only when an `id` carries the identity (otherwise it is the id itself).
  const name = item.display_name ?? item.displayName ?? (id ? item.name : undefined);
  if (typeof name === "string" && name && name !== id) details.name = name;
  if (typeof item.description === "string" && item.description) {
    details.description = item.description.slice(0, MAX_DESCRIPTION);
  }
  const created = seconds(item.created ?? item.created_at ?? item.createdAt);
  if (created) details.created = created;

  const top = isRecord(item.top_provider) ? item.top_provider : {};
  // First spelling that holds a usable number wins (a `0` or a string in an earlier one is skipped).
  const usable = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  const ctx = [
    item.context_length,
    item.context_window,
    item.max_input_tokens,
    item.inputTokenLimit,
    top.context_length,
  ].find(usable);
  if (ctx) details.contextWindow = ctx;
  const out = [
    item.max_completion_tokens,
    item.max_output_tokens,
    item.outputTokenLimit,
    top.max_completion_tokens,
    item.max_tokens,
  ].find(usable);
  if (out) details.maxOutputTokens = out;

  const arch = isRecord(item.architecture) ? item.architecture : {};
  const modalities = isRecord(item.modalities) ? item.modalities : {};
  const caps = isRecord(item.capabilities) ? fromCapabilities(item.capabilities) : undefined;
  const input =
    strings(arch.input_modalities ?? item.input_modalities ?? modalities.input) ?? caps?.input;
  if (input) details.inputModalities = input;
  const output = strings(arch.output_modalities ?? item.output_modalities ?? modalities.output);
  if (output) details.outputModalities = output;
  const params =
    strings(item.supported_parameters) ?? (caps?.params.length ? caps.params : undefined);
  if (params) details.supportedParameters = params;
  return details;
}

/**
 * Reads the model list of an OpenAI-style `GET /models` response. Besides the canonical
 * `{ data: [{ id }] }` it tolerates `{ models: [...] }`, a bare array, string entries and `name`
 * instead of `id` (Gemini-style `models/<id>` prefixes are stripped), which is what the many
 * OpenAI-"compatible" servers actually return. `context_length` / `context_window` become `contextWindow`.
 */
export function parseOpenAiModels(json: unknown): ModelInfo[] {
  const items = Array.isArray(json)
    ? json
    : isRecord(json)
      ? Array.isArray(json.data)
        ? json.data
        : Array.isArray(json.models)
          ? json.models
          : null
      : null;
  if (!items) throw new Error("unexpected /models response (no model array)");

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const item of items) {
    const raw =
      typeof item === "string" ? item : isRecord(item) ? (item.id ?? item.name) : undefined;
    if (typeof raw !== "string" || !raw) continue;
    const id = raw.replace(/^models\//, "");
    if (seen.has(id)) continue;
    seen.add(id);
    const info: ModelInfo = { id };
    if (isRecord(item)) Object.assign(info, readModelDetails(item));
    models.push(info);
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

export async function httpError(what: string, res: Response): Promise<Error> {
  const text = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
  return new Error(`${what} failed: HTTP ${res.status}${text ? ` ${text}` : ""}`);
}
