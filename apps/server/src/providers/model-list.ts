import type { ModelInfo } from "./adapter.ts";

/** Upper bound on one provider's list: protects the DB and the admin UI from a hostile/buggy endpoint. */
export const MAX_MODELS = 5000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
    if (isRecord(item)) {
      const name = item.display_name ?? item.displayName;
      if (typeof name === "string" && name && name !== id) info.name = name;
      const ctx =
        item.context_length ?? item.context_window ?? item.max_input_tokens ?? item.inputTokenLimit;
      if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) info.contextWindow = ctx;
    }
    models.push(info);
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

export async function httpError(what: string, res: Response): Promise<Error> {
  const text = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
  return new Error(`${what} failed: HTTP ${res.status}${text ? ` ${text}` : ""}`);
}
