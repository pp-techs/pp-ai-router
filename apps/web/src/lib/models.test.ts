import { describe, expect, it } from "vite-plus/test";
import type { ProviderModel } from "../api/types.ts";
import { filterModels, formatContextWindow } from "./models.ts";

const model = (id: string, name: string | null = null): ProviderModel => ({
  id,
  name,
  context_window: null,
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
