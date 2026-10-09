/**
 * Price sources spell the same model differently: LiteLLM writes `claude-sonnet-5-5`, OpenRouter writes
 * `anthropic/claude-sonnet-5.5`, a provider lists `claude-sonnet-5.5`. These helpers derive the likely
 * spellings of an id so a lookup can still find its price. They only ever propose ids; the price store
 * decides which exist, and exact ids always win over any derived one.
 */

/** Model-name prefix -> the vendor slug OpenRouter (and some LiteLLM entries) put in front of it. */
const VENDORS: readonly (readonly [RegExp, string])[] = [
  [/^claude-/, "anthropic"],
  [/^(?:gpt-|chatgpt-|o\d)/, "openai"],
  [/^(?:gemini-|gemma-)/, "google"],
  [/^deepseek-/, "deepseek"],
  [/^grok-/, "x-ai"],
  [/^qwen/, "qwen"],
  [/^llama-?\d/, "meta-llama"],
  [/^(?:mistral|ministral|codestral|devstral|magistral)/, "mistralai"],
  [/^glm-/, "z-ai"],
  [/^kimi-/, "moonshotai"],
  [/^minimax-/, "minimax"],
];

/** `5.5` -> `5-5`. */
const dashed = (id: string) => id.replace(/(?<=\d)\.(?=\d)/g, "-");
/** `5-5` -> `5.5`, only between single digits so dates such as `20250514` or `2025-05-14` are left alone. */
const dotted = (id: string) => id.replace(/(?<!\d)(\d)-(\d)(?!\d)/g, "$1.$2");
/** `4.0` / `4-0` -> `4`: a trailing zero minor version is not part of the canonical name. */
const trimmed = (id: string) => id.replace(/(?<=\d)[.-]0(?!\d)/g, "");

/**
 * Other spellings of `id`, most likely first and never including `id` itself: version separators as
 * `-` and `.`, a trailing `.0` dropped, then the same forms behind the model's vendor (`anthropic/…`).
 * Only the last path segment is considered, so `kiro/claude-opus-4.8` yields `claude-opus-4-8`,
 * `anthropic/claude-opus-4.8`, and so on.
 */
export function idVariants(id: string): string[] {
  const name = id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  const forms = new Set<string>();
  // DeepSeek ids are written with and without the `v` before the version (`deepseek-3.2`, `deepseek-v3.2`).
  for (const n of [name, name.replace(/^deepseek-(?=\d)/, "deepseek-v")]) {
    for (const spelling of [n, dashed(n), dotted(n)]) {
      forms.add(spelling);
      forms.add(trimmed(spelling));
    }
  }

  const vendor = VENDORS.find(([pattern]) => pattern.test(name))?.[1];
  const variants = new Set<string>(forms);
  if (vendor) for (const form of forms) variants.add(`${vendor}/${form}`);

  variants.delete(id);
  return [...variants];
}

/** Variants of every candidate, in candidate order, without repeating a candidate or each other. */
export function candidateVariants(candidates: readonly string[]): string[] {
  const seen = new Set(candidates);
  const out: string[] = [];
  for (const candidate of candidates) {
    for (const variant of idVariants(candidate)) {
      if (seen.has(variant)) continue;
      seen.add(variant);
      out.push(variant);
    }
  }
  return out;
}
