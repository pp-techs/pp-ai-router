import type { ModelCatalog } from "./models.ts";
import type { PricingStore } from "./pricing/store.ts";
import type { ModelInfo } from "./providers/adapter.ts";
import type { Registry } from "./registry.ts";

/** Who owns the aliases in the listing. */
export const ALIAS_OWNER = "pp-ai-router";

/** USD per token as a plain decimal string (OpenRouter's convention), never exponent notation. */
const usd = (n: number): string =>
  n
    .toFixed(12)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");

/**
 * One entry of the client `GET /v1/models`: the OpenAI shape (`id`, `object`, `created`, `owned_by`)
 * plus OpenRouter-style detail fields. A fact that is not known is left out, never null or guessed.
 */
function entry(
  id: string,
  owner: string,
  info: ModelInfo | undefined,
  pricing: PricingStore,
  priceKeys: readonly string[],
  verbose: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id,
    object: "model",
    created: info?.created ?? 0,
    owned_by: owner,
  };
  if (info?.name) out.name = info.name;
  if (verbose && info?.description) out.description = info.description;
  if (info?.contextWindow) out.context_length = info.contextWindow;
  if (info?.inputModalities || info?.outputModalities) {
    out.architecture = {
      ...(info.inputModalities && { input_modalities: info.inputModalities }),
      ...(info.outputModalities && { output_modalities: info.outputModalities }),
    };
  }

  const price = pricing.lookup(priceKeys);
  if (price) {
    out.pricing = {
      prompt: usd(price.input),
      completion: usd(price.output),
      ...(price.cacheRead !== undefined && { input_cache_read: usd(price.cacheRead) }),
      ...(price.cacheWrite !== undefined && { input_cache_write: usd(price.cacheWrite) }),
      ...(price.reasoning !== undefined && { internal_reasoning: usd(price.reasoning) }),
    };
  }
  if (info?.contextWindow || info?.maxOutputTokens) {
    out.top_provider = {
      ...(info.contextWindow && { context_length: info.contextWindow }),
      ...(info.maxOutputTokens && { max_completion_tokens: info.maxOutputTokens }),
    };
  }
  if (info?.supportedParameters) out.supported_parameters = info.supportedParameters;
  return out;
}

/**
 * Every model a key may call: aliases first (described by their first enabled target), then each
 * `provider/model` the providers offer. Stored data only, so the request never waits on an upstream.
 */
export function listClientModels(
  deps: { registry: Registry; models: ModelCatalog; pricing: PricingStore },
  allowed: (id: string) => boolean,
  verbose: boolean,
): Record<string, unknown>[] {
  const { registry, models, pricing } = deps;
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const id of registry.aliasNames()) {
    if (registry.isDisabled(id) || !allowed(id) || seen.has(id)) continue;
    seen.add(id);
    const target = registry.resolve(id)[0];
    const info = target && models.describe(target.provider, target.model);
    const keys = target ? [`${target.provider}/${target.model}`, target.model] : [];
    out.push(entry(id, ALIAS_OWNER, info, pricing, keys, verbose));
  }
  for (const { provider, model } of models.all()) {
    const id = `${provider}/${model.id}`;
    // A concrete `provider/model` replaces an alias of the same name, as it always has.
    if (!allowed(id)) continue;
    const at = seen.has(id) ? out.findIndex((e) => e.id === id) : -1;
    const item = entry(id, provider, model, pricing, [id, model.id], verbose);
    if (at >= 0) out[at] = item;
    else out.push(item);
    seen.add(id);
  }
  return out;
}
