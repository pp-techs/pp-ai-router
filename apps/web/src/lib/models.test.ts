import { describe, expect, it } from "vite-plus/test";
import type { ProviderModel, ProviderModelGroup } from "../api/types.ts";
import { filterGroups, filterModels, flattenGroups, formatContextWindow } from "./models.ts";

const model = (id: string, name: string | null = null, enabled = true): ProviderModel => ({
  id,
  name,
  context_window: null,
  enabled,
  price: null,
});
const LIST = [
  model("gpt-4o"),
  model("gpt-4o-mini"),
  model("claude-sonnet-4", "Claude Sonnet 4"),
  model("llama-3.1-70b"),
];

describe("filterModels", () => {
  it("returns the same list for a blank query", () => {
    expect(filterModels(LIST, "  ")).toBe(LIST);
  });

  it("matches ids and display names case-insensitively", () => {
    expect(filterModels(LIST, "GPT").map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(filterModels(LIST, "sonnet 4").map((m) => m.id)).toEqual(["claude-sonnet-4"]);
  });

  it("requires every term to match", () => {
    expect(filterModels(LIST, "gpt mini").map((m) => m.id)).toEqual(["gpt-4o-mini"]);
    expect(filterModels(LIST, "gpt llama")).toEqual([]);
  });
});

const group = (provider: string, data: ProviderModel[]): ProviderModelGroup => ({
  provider,
  type: "openai-compat",
  provider_enabled: true,
  source: "fetched",
  fetched_at: null,
  error: null,
  data,
});
const GROUPS = [
  group("openai", [model("gpt-4o"), model("gpt-4o-mini", null, false)]),
  group("kiro", [model("claude-sonnet-4", "Claude Sonnet 4"), model("gpt-5.6-sol", null, false)]),
  group("empty", []),
];

describe("filterGroups", () => {
  it("keeps every group, even an empty one, when nothing is filtered", () => {
    expect(filterGroups(GROUPS, "  ", "all")).toBe(GROUPS);
  });

  it("matches the provider id as well as the model id and name, and drops groups left empty", () => {
    const ids = (groups: ProviderModelGroup[]) =>
      groups.map((g) => [g.provider, g.data.map((m) => m.id)]);
    expect(ids(filterGroups(GROUPS, "kiro", "all"))).toEqual([
      ["kiro", ["claude-sonnet-4", "gpt-5.6-sol"]],
    ]);
    expect(ids(filterGroups(GROUPS, "gpt", "all"))).toEqual([
      ["openai", ["gpt-4o", "gpt-4o-mini"]],
      ["kiro", ["gpt-5.6-sol"]],
    ]);
    expect(ids(filterGroups(GROUPS, "kiro sonnet", "all"))).toEqual([
      ["kiro", ["claude-sonnet-4"]],
    ]);
  });

  it("filters by enabled state, combined with the search", () => {
    expect(flattenGroups(filterGroups(GROUPS, "", "disabled")).map((r) => r.model.id)).toEqual([
      "gpt-4o-mini",
      "gpt-5.6-sol",
    ]);
    expect(flattenGroups(filterGroups(GROUPS, "gpt", "enabled")).map((r) => r.model.id)).toEqual([
      "gpt-4o",
    ]);
  });
});

describe("flattenGroups", () => {
  it("lists every model with its provider, in group order", () => {
    expect(flattenGroups(GROUPS).map((r) => `${r.provider}/${r.model.id}`)).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "kiro/claude-sonnet-4",
      "kiro/gpt-5.6-sol",
    ]);
  });
});

describe("formatContextWindow", () => {
  it("abbreviates token counts", () => {
    expect(formatContextWindow(8192)).toBe("8.2K");
    expect(formatContextWindow(200_000)).toBe("200K");
    expect(formatContextWindow(1_000_000)).toBe("1M");
  });

  it("marks an unknown window", () => {
    expect(formatContextWindow(null)).toBe("—");
  });
});
