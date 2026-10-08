import type { ProviderModel } from "../api/types.ts";

/** Models whose id or name contains every whitespace-separated term (case-insensitive). */
export function filterModels(models: ProviderModel[], query: string): ProviderModel[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return models;
  return models.filter((m) => {
    const haystack = `${m.id} ${m.name ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** 131072 -> "131.1K"; a model without a known window shows "—". */
export const formatContextWindow = (tokens: number | null) =>
  tokens === null ? "—" : compact.format(tokens);
