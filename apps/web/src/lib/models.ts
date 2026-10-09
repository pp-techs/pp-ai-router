import type { ProviderModel, ProviderModelGroup } from "../api/types.ts";

const searchTerms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Models whose id or name contains every whitespace-separated term (case-insensitive). */
export function filterModels(models: ProviderModel[], query: string): ProviderModel[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return models;
  return models.filter((m) => {
    const haystack = `${m.id} ${m.name ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export type StatusFilter = "all" | "enabled" | "disabled";

/** A model together with the provider that offers it, as one row of the Models page. */
export interface ModelRow {
  provider: string;
  model: ProviderModel;
}

/**
 * Narrows provider groups to the models whose provider id, model id or name contains every term of
 * `query`, and that match `status`. Groups the filter leaves empty are dropped; with no filter every
 * group is kept, including providers that have no models yet.
 */
export function filterGroups(
  groups: ProviderModelGroup[],
  query: string,
  status: StatusFilter,
): ProviderModelGroup[] {
  const terms = searchTerms(query);
  if (terms.length === 0 && status === "all") return groups;
  return groups.flatMap((group) => {
    const data = group.data.filter((m) => {
      if (status !== "all" && m.enabled !== (status === "enabled")) return false;
      const haystack = `${group.provider} ${m.id} ${m.name ?? ""}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    return data.length > 0 ? [{ ...group, data }] : [];
  });
}

export const flattenGroups = (groups: ProviderModelGroup[]): ModelRow[] =>
  groups.flatMap((group) => group.data.map((model) => ({ provider: group.provider, model })));

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** 131072 -> "131.1K"; a model without a known window shows "—". */
export const formatContextWindow = (tokens: number | null) =>
  tokens === null ? "—" : compact.format(tokens);
