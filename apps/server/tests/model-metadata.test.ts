import { describe, expect, it } from "vite-plus/test";
import { openDatabase } from "../src/db/database.ts";
import { ModelMetadataStore, parseOpenRouterMetadata } from "../src/model-metadata.ts";
import { OPENROUTER_SOURCE, OPENROUTER_URL, parseOpenRouter } from "../src/pricing/openrouter.ts";
import { PricingStore } from "../src/pricing/store.ts";
import { syncPricing } from "../src/pricing/sync.ts";
import { ADAPTERS, type ProviderAdapter } from "../src/providers/adapter.ts";
import { readModelDetails } from "../src/providers/model-list.ts";
import { createHarness, readJson } from "./harness.ts";

const openRouterBody = {
  data: [
    {
      id: "acme/alpha",
      name: "Acme: Alpha",
      description: "Alpha does things.",
      created: 1_700_000_000,
      context_length: 128_000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      top_provider: { context_length: 128_000, max_completion_tokens: 8192 },
      supported_parameters: ["tools", "temperature"],
      pricing: { prompt: "0.000001", completion: "0.000002" },
    },
    { id: "acme/empty", pricing: { prompt: "0", completion: "0" } },
  ],
};

const openRouterSource = {
  name: OPENROUTER_SOURCE,
  url: OPENROUTER_URL,
  parse: parseOpenRouter,
  parseMeta: parseOpenRouterMetadata,
};

describe("readModelDetails", () => {
  it("reads OpenRouter-style entries", () => {
    expect(readModelDetails(openRouterBody.data[0]!)).toMatchObject({
      description: "Alpha does things.",
      created: 1_700_000_000,
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportedParameters: ["tools", "temperature"],
    });
  });

  it("reads Anthropic capabilities and Gemini limits, and ignores junk", () => {
    expect(
      readModelDetails({
        id: "claude-x",
        display_name: "Claude X",
        created_at: "2025-01-01T00:00:00Z",
        max_input_tokens: 200_000,
        max_tokens: 64_000,
        capabilities: { image_input: { supported: true }, thinking: { supported: false } },
      }),
    ).toMatchObject({
      name: "Claude X",
      created: 1_735_689_600,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      inputModalities: expect.arrayContaining(["text", "image"]),
    });
    expect(
      readModelDetails({ displayName: "Gemini X", inputTokenLimit: 1000, outputTokenLimit: 500 }),
    ).toEqual({ name: "Gemini X", contextWindow: 1000, maxOutputTokens: 500 });
    expect(
      readModelDetails({ context_length: -5, supported_parameters: "tools", created: "soon" }),
    ).toEqual({});
  });
});

describe("ModelMetadataStore", () => {
  const store = () => new ModelMetadataStore(openDatabase(":memory:"));

  it("fills only what the upstream left out and records where it came from", () => {
    const meta = store();
    meta.replaceSource(OPENROUTER_SOURCE, parseOpenRouterMetadata(openRouterBody), 1);
    const out = meta.enrich("acme", { id: "alpha", name: "Mine", contextWindow: 1000 });
    expect(out).toMatchObject({
      name: "Mine",
      contextWindow: 1000, // the upstream's own value stands
      maxOutputTokens: 8192,
      description: "Alpha does things.",
    });
    expect(out.sources).toMatchObject({ maxOutputTokens: OPENROUTER_SOURCE });
    expect(out.sources).not.toHaveProperty("contextWindow");
  });

  it("leaves a model alone when nothing matches or nothing was synced", () => {
    const meta = store();
    expect(meta.enrich("acme", { id: "alpha" })).toEqual({ id: "alpha" });
    meta.replaceSource(OPENROUTER_SOURCE, parseOpenRouterMetadata(openRouterBody), 1);
    expect(meta.enrich("acme", { id: "unknown" })).toEqual({ id: "unknown" });
  });

  it("drops models that disappeared from the source", () => {
    const meta = store();
    meta.replaceSource(OPENROUTER_SOURCE, parseOpenRouterMetadata(openRouterBody), 1);
    meta.replaceSource(OPENROUTER_SOURCE, [], 2);
    expect(meta.has(OPENROUTER_SOURCE)).toBe(false);
    expect(meta.enrich("acme", { id: "alpha" })).toEqual({ id: "alpha" });
  });
});

describe("syncPricing and model metadata", () => {
  it("saves model facts, and ignores the stored ETag while none were saved", async () => {
    const db = openDatabase(":memory:");
    const pricing = new PricingStore(db);
    const metadata = new ModelMetadataStore(db);
    const seen: (string | null)[] = [];
    const fetcher = (_url: string | URL | Request, init?: RequestInit) => {
      const inm = new Headers(init?.headers).get("if-none-match");
      seen.push(inm);
      return Promise.resolve(
        inm
          ? new Response(null, { status: 304 })
          : Response.json(openRouterBody, { headers: { etag: '"v1"' } }),
      );
    };
    const run = (withMetadata: boolean) =>
      syncPricing({
        store: pricing,
        ...(withMetadata && { metadata }),
        sources: [openRouterSource],
        fetch: fetcher,
      });

    // an older deployment: prices and an ETag exist, model facts do not
    await run(false);
    expect(metadata.has(OPENROUTER_SOURCE)).toBe(false);

    expect((await run(true))[0]).toMatchObject({ status: "updated" });
    expect(metadata.has(OPENROUTER_SOURCE)).toBe(true);
    expect((await run(true))[0]).toMatchObject({ status: "not_modified" });
    expect(seen).toEqual([null, null, '"v1"']);
    expect(metadata.enrich("acme", { id: "alpha" }).maxOutputTokens).toBe(8192);
  });
});

describe("/v1/models detail", () => {
  const fixed: ProviderAdapter = {
    ...ADAPTERS["openai-compat"]!,
    type: "fixed",
    staticModels: [{ id: "alpha", contextWindow: 1000 }, { id: "bare" }],
  };

  async function setup() {
    const h = createHarness({}, { adapters: { ...ADAPTERS, fixed } });
    await h.admin("POST", "/providers", {
      id: "acme",
      type: "fixed",
      base_url: "http://x.test/v1",
    });
    await h.admin("PUT", "/aliases/smart", { targets: [{ provider: "acme", model: "alpha" }] });
    await h.admin("PUT", "/pricing/overrides", {
      model: "acme/alpha",
      input_per_1m: 0.1,
      output_per_1m: 0.4,
    });
    h.services.metadata.replaceSource(
      OPENROUTER_SOURCE,
      parseOpenRouterMetadata(openRouterBody),
      h.clock.now,
    );
    const key = await h.newKey();
    const list = async (query = "") =>
      (
        await readJson(
          await h.services.app.request(`/v1/models${query}`, {
            headers: { authorization: `Bearer ${key.secret}` },
          }),
        )
      ).data as Record<string, any>[];
    return { h, list };
  }

  it("keeps the OpenAI shape and adds context, modalities, parameters and price", async () => {
    const { list } = await setup();
    const byId = Object.fromEntries((await list()).map((m) => [m.id, m]));
    expect(byId["acme/alpha"]).toEqual({
      id: "acme/alpha",
      object: "model",
      created: 1_700_000_000,
      owned_by: "acme",
      context_length: 1000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      // plain decimals, never exponent notation
      pricing: { prompt: "0.0000001", completion: "0.0000004" },
      top_provider: { context_length: 1000, max_completion_tokens: 8192 },
      supported_parameters: ["tools", "temperature"],
    });
    // an alias reports the model it would route to first
    expect(byId.smart).toMatchObject({
      owned_by: "pp-ai-router",
      context_length: 1000,
      pricing: { prompt: "0.0000001" },
    });
    // unknown facts are omitted rather than nulled
    expect(byId["acme/bare"]).toEqual({
      id: "acme/bare",
      object: "model",
      created: 0,
      owned_by: "acme",
    });
  });

  it("shows the description only on request, and still honours allowed_models", async () => {
    const { h, list } = await setup();
    expect((await list()).some((m) => "description" in m)).toBe(false);
    for (const q of ["?verbose=1", "?verbose=true"]) {
      expect((await list(q)).find((m) => m.id === "acme/alpha")?.description).toBe(
        "Alpha does things.",
      );
    }
    expect((await list("?verbose=0")).some((m) => "description" in m)).toBe(false);

    const narrow = await h.newKey({ allowed_models: ["smart"] });
    const res = await readJson(
      await h.services.app.request("/v1/models?verbose=1", {
        headers: { authorization: `Bearer ${narrow.secret}` },
      }),
    );
    expect(res.data.map((m: { id: string }) => m.id)).toEqual(["smart"]);
  });

  it("reports the same facts, snake_case with sources, in the admin list", async () => {
    const { h } = await setup();
    const { data } = (await h.admin("GET", "/providers/acme/models")).json;
    expect(data.find((m: { id: string }) => m.id === "alpha")).toMatchObject({
      context_window: 1000,
      max_output_tokens: 8192,
      description: "Alpha does things.",
      supported_parameters: ["tools", "temperature"],
      sources: { max_output_tokens: OPENROUTER_SOURCE },
    });
  });
});
