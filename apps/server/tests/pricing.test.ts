import { describe, expect, it } from "vite-plus/test";
import { computeCost } from "../src/pricing/cost.ts";
import { parseLiteLLM } from "../src/pricing/litellm.ts";
import { parseOpenRouter } from "../src/pricing/openrouter.ts";
import { openDatabase } from "../src/db/database.ts";
import { PricingStore } from "../src/pricing/store.ts";
import { syncPricing } from "../src/pricing/sync.ts";
import type { ModelPrice, Usage } from "../src/pricing/types.ts";

const usage = (over: Partial<Usage>): Usage => ({
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  ...over,
});

const base: ModelPrice = {
  model: "m",
  source: "litellm",
  input: 3e-6,
  output: 15e-6,
  cacheRead: 3e-7,
  cacheWrite: 3.75e-6,
  tiers: [],
};

describe("computeCost", () => {
  it("bills fresh, cached and cache-written prompt tokens at their own rates", () => {
    const cost = computeCost(
      base,
      usage({
        promptTokens: 1000,
        cachedTokens: 600,
        cacheWriteTokens: 100,
        completionTokens: 200,
      }),
    );
    expect(cost).toBeCloseTo(300 * 3e-6 + 600 * 3e-7 + 100 * 3.75e-6 + 200 * 15e-6, 12);
  });

  it("falls back to the input rate when the model has no cache price", () => {
    const price: ModelPrice = { ...base };
    delete price.cacheRead;
    expect(computeCost(price, usage({ promptTokens: 100, cachedTokens: 100 }))).toBeCloseTo(
      100 * 3e-6,
      12,
    );
  });

  it("bills reasoning tokens separately only when a reasoning price exists", () => {
    const withReasoning: ModelPrice = { ...base, reasoning: 30e-6 };
    const u = usage({ completionTokens: 100, reasoningTokens: 40 });
    expect(computeCost(withReasoning, u)).toBeCloseTo(60 * 15e-6 + 40 * 30e-6, 12);
    expect(computeCost(base, u)).toBeCloseTo(100 * 15e-6, 12);
  });

  it("applies the highest tier whose threshold the prompt exceeds, to the whole request", () => {
    const tiered: ModelPrice = {
      ...base,
      tiers: [{ aboveTokens: 200_000, input: 6e-6, output: 22.5e-6 }],
    };
    expect(computeCost(tiered, usage({ promptTokens: 200_000, completionTokens: 10 }))).toBeCloseTo(
      200_000 * 3e-6 + 10 * 15e-6,
      9,
    );
    expect(computeCost(tiered, usage({ promptTokens: 200_001, completionTokens: 10 }))).toBeCloseTo(
      200_001 * 6e-6 + 10 * 22.5e-6,
      9,
    );
  });

  it("never lets cached counts exceed the prompt", () => {
    expect(computeCost(base, usage({ promptTokens: 10, cachedTokens: 50 }))).toBeCloseTo(
      10 * 3e-7,
      12,
    );
  });
});

describe("parsers", () => {
  it("reads LiteLLM entries, tiers and skips non-token-priced rows", () => {
    const prices = parseLiteLLM({
      sample_spec: { input_cost_per_token: 0 },
      "claude-x": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 15e-6,
        cache_read_input_token_cost: 3e-7,
        input_cost_per_token_above_200k_tokens: 6e-6,
        output_cost_per_token_above_200k_tokens: 22.5e-6,
        input_cost_per_token_above_200k_tokens_batches: 1,
        input_cost_per_token_batches: 1.5e-6,
      },
      "image-model": { output_cost_per_image: 0.04 },
    });
    expect(prices).toHaveLength(1);
    expect(prices[0]).toMatchObject({
      model: "claude-x",
      input: 3e-6,
      output: 15e-6,
      cacheRead: 3e-7,
    });
    expect(prices[0]!.tiers).toEqual([{ aboveTokens: 200_000, input: 6e-6, output: 22.5e-6 }]);
  });

  it("reads OpenRouter string prices, converts inclusive overrides and drops dynamic (negative) pricing", () => {
    const prices = parseOpenRouter({
      data: [
        {
          id: "anthropic/claude-haiku",
          pricing: {
            prompt: "0.0000001",
            completion: "0.0000005",
            input_cache_read: "0.00000001",
            overrides: [
              { min_prompt_tokens: 100000, prompt: "0.0000005", completion: "0.0000025" },
            ],
          },
        },
        { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
      ],
    });
    expect(prices.map((p) => p.model)).toEqual(["anthropic/claude-haiku"]);
    expect(prices[0]).toMatchObject({ input: 1e-7, output: 5e-7, cacheRead: 1e-8 });
    expect(prices[0]!.tiers).toEqual([{ aboveTokens: 99_999, input: 5e-7, output: 2.5e-6 }]);
  });
});

describe("PricingStore + sync", () => {
  const source = (name: string, body: unknown, etag = '"v1"') => ({
    name,
    url: `https://example.test/${name}`,
    parse: (json: unknown) =>
      (json as { models: string[] }).models.map((model): ModelPrice => ({
        model,
        source: name,
        input: 1e-6,
        output: 2e-6,
        tiers: [],
      })),
    body,
    etag,
  });

  it("resolves overrides over litellm over openrouter, and keeps data when a refresh fails", async () => {
    const store = new PricingStore(openDatabase(":memory:"));
    store.replaceSource(
      "openrouter",
      [{ model: "m", source: "openrouter", input: 9e-6, output: 9e-6, tiers: [] }],
      1,
    );
    expect(store.lookup(["m"])?.source).toBe("openrouter");
    store.replaceSource(
      "litellm",
      [{ model: "m", source: "litellm", input: 1e-6, output: 1e-6, tiers: [] }],
      1,
    );
    expect(store.lookup(["m"])?.source).toBe("litellm");
    store.setOverride({ model: "m", input: 5e-6, output: 6e-6 }, 1);
    expect(store.lookup(["x", "m"])).toMatchObject({ source: "override", input: 5e-6 });

    const failing = source("litellm", null);
    const results = await syncPricing({
      store,
      sources: [failing],
      fetch: () => Promise.resolve(new Response("nope", { status: 500 })),
    });
    expect(results[0]).toMatchObject({ status: "error" });
    store.deleteOverride("m");
    expect(store.lookup(["m"])?.source).toBe("litellm"); // previous prices survived
    expect(store.syncState("litellm")?.last_error).toContain("500");
  });

  it("finds a price under another spelling of the model id, and prefers an exact id over a derived one", () => {
    const store = new PricingStore(openDatabase(":memory:"));
    const price = (source: string, model: string, input: number): ModelPrice => ({
      model,
      source,
      input,
      output: input * 5,
      tiers: [],
    });
    store.replaceSource(
      "litellm",
      [
        price("litellm", "claude-sonnet-5-5", 2e-6),
        price("litellm", "claude-opus-4-8", 5e-6),
        price("litellm", "claude-haiku-5-5", 1e-6),
        price("litellm", "eu.anthropic.claude-opus-5-5", 9e-6),
      ],
      1,
    );
    store.replaceSource(
      "openrouter",
      [
        price("openrouter", "anthropic/claude-sonnet-4", 3e-6),
        price("openrouter", "anthropic/claude-haiku-5.5", 7e-6),
        price("openrouter", "anthropic/claude-sonnet-5.5:batch", 1e-6),
      ],
      1,
    );

    // dot -> dash (LiteLLM spelling)
    expect(store.lookup(["kiro/claude-sonnet-5.5", "claude-sonnet-5.5"])).toMatchObject({
      model: "claude-sonnet-5-5",
      input: 2e-6,
    });
    expect(store.lookup(["claude-opus-4.8"])?.model).toBe("claude-opus-4-8");
    // vendor prefix and a dropped `.0` (OpenRouter spelling)
    expect(store.lookup(["claude-sonnet-4.0"])?.model).toBe("anthropic/claude-sonnet-4");
    // an exact id in a lower-priority source beats a derived id in a higher-priority one
    expect(store.lookup(["anthropic/claude-haiku-5.5"])).toMatchObject({
      source: "openrouter",
      model: "anthropic/claude-haiku-5.5",
    });
    // a user override on the id as written wins over any derived price
    store.setOverride({ model: "claude-opus-4.8", input: 1e-6, output: 2e-6 }, 1);
    expect(store.lookup(["claude-opus-4.8"])).toMatchObject({ source: "override", input: 1e-6 });
    // never a regional/batch variant, and nothing for a model that is simply unknown
    expect(store.lookup(["claude-opus-5.5"])).toBeNull();
    expect(store.lookup(["kiro-auto"])).toBeNull();
  });

  it("sends the stored ETag and treats 304 as success", async () => {
    const store = new PricingStore(openDatabase(":memory:"));
    const src = source("litellm", { models: ["a", "b"] });
    const seen: (string | null)[] = [];
    const fetcher = (_url: string | URL | Request, init?: RequestInit) => {
      const inm = new Headers(init?.headers).get("if-none-match");
      seen.push(inm);
      return Promise.resolve(
        inm
          ? new Response(null, { status: 304 })
          : Response.json(src.body, { headers: { etag: src.etag } }),
      );
    };
    expect((await syncPricing({ store, sources: [src], fetch: fetcher }))[0]).toMatchObject({
      status: "updated",
      models: 2,
    });
    expect((await syncPricing({ store, sources: [src], fetch: fetcher }))[0]).toMatchObject({
      status: "not_modified",
    });
    expect(seen).toEqual([null, '"v1"']);
    expect(store.lookup(["a"])).not.toBeNull();
  });

  it("drops models that disappeared upstream", async () => {
    const store = new PricingStore(openDatabase(":memory:"));
    const run = (models: string[]) =>
      syncPricing({
        store,
        sources: [source("litellm", null)],
        fetch: () => Promise.resolve(Response.json({ models })),
      });
    await run(["a", "b"]);
    await run(["a"]);
    expect(store.lookup(["b"])).toBeNull();
  });
});
