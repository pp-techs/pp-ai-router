import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { all } from "../src/db/database.ts";
import { parseOpenAiModels } from "../src/providers/model-list.ts";
import { ADAPTERS, type ProviderAdapter } from "../src/providers/adapter.ts";
import { createHarness, readJson } from "./harness.ts";

interface Seen {
  auth: string;
  apiKey: string;
  version: string;
  query: URLSearchParams;
}

/** Fake upstream serving only `GET /v1/models`. */
async function modelsServer(handler: (seen: Seen, n: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const app = new Hono();
  app.get("/v1/models", (c) => {
    const entry: Seen = {
      auth: c.req.header("authorization") ?? "",
      apiKey: c.req.header("x-api-key") ?? "",
      version: c.req.header("anthropic-version") ?? "",
      query: new URL(c.req.url).searchParams,
    };
    seen.push(entry);
    return handler(entry, seen.length);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}/v1`, seen };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const openAiList = (...ids: string[]) =>
  Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });

describe("fetching a provider's models", () => {
  it("fetches with the provider's credential on first view, stores it, and prices each model", async () => {
    const up = await modelsServer(() =>
      Response.json({
        data: [
          { id: "acme-large", context_length: 200_000, display_name: "Acme Large" },
          { id: "acme-small" },
        ],
      }),
    );
    const h = createHarness();
    await h.addProvider("acme", up.url, ["sk-acme"]);
    await h.admin("PUT", "/pricing/overrides", {
      model: "acme/acme-large",
      input_per_1m: 2,
      output_per_1m: 8,
    });

    const first = (await h.admin("GET", "/providers/acme/models")).json;
    expect(up.seen.map((s) => s.auth)).toEqual(["Bearer sk-acme"]);
    expect(first).toMatchObject({ source: "fetched", error: null, fetched_at: h.clock.now });
    expect(first.data).toEqual([
      {
        id: "acme-large",
        name: "Acme Large",
        context_window: 200_000,
        enabled: true,
        price: { input_per_1m: 2, output_per_1m: 8, source: "override" },
      },
      { id: "acme-small", name: null, context_window: null, enabled: true, price: null },
    ]);

    await h.admin("GET", "/providers/acme/models");
    expect(up.seen).toHaveLength(1); // served from storage
  });

  it("keeps the previous list and reports the error when a refresh fails", async () => {
    const up = await modelsServer((_s, n) =>
      n === 1 ? openAiList("m1", "m2") : new Response("overloaded", { status: 503 }),
    );
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    await h.admin("POST", "/providers/acme/models/refresh");

    const after = (await h.admin("POST", "/providers/acme/models/refresh")).json;
    expect(after.data.map((m: any) => m.id)).toEqual(["m1", "m2"]);
    expect(after.error).toContain("HTTP 503");
    expect(after.source).toBe("fetched");
  });

  it("falls through to the next credential when one is rejected", async () => {
    const up = await modelsServer((s) =>
      s.auth === "Bearer bad" ? new Response("nope", { status: 401 }) : openAiList("ok-model"),
    );
    const h = createHarness();
    await h.addProvider("acme", up.url, ["bad", "good"]);
    const res = (await h.admin("POST", "/providers/acme/models/refresh")).json;
    expect(res.data.map((m: any) => m.id)).toEqual(["ok-model"]);
    expect(up.seen.map((s) => s.auth)).toEqual(["Bearer bad", "Bearer good"]);
  });

  it("says why when there is nothing to fetch with", async () => {
    const up = await modelsServer(() => openAiList("x"));
    const h = createHarness();
    await h.addProvider("acme", up.url, []);
    const res = (await h.admin("GET", "/providers/acme/models")).json;
    expect(res).toMatchObject({ source: "none", data: [] });
    expect(res.error).toContain("no usable credential");
    expect(up.seen).toHaveLength(0);
  });

  it("shares one upstream call between concurrent refreshes", async () => {
    const up = await modelsServer(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return openAiList("m");
    });
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k"]);
    await Promise.all([1, 2, 3].map(() => h.services.models.refresh("acme")));
    expect(up.seen).toHaveLength(1);
  });

  it("drops the stored list with its provider", async () => {
    const up = await modelsServer(() => openAiList("m"));
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k"]);
    await h.admin("POST", "/providers/acme/models/refresh");
    await h.admin("DELETE", "/providers/acme");
    expect(all(h.services.db.prepare("SELECT 1 FROM provider_models"))).toHaveLength(0);
    expect((await h.admin("GET", "/providers/acme/models")).status).toBe(404);
  });
});

describe("Anthropic discovery", () => {
  it("authenticates with x-api-key and follows has_more / last_id across pages", async () => {
    const up = await modelsServer((s) =>
      s.query.get("after_id") === "claude-b"
        ? Response.json({
            data: [{ type: "model", id: "claude-c", display_name: "Claude C" }],
            has_more: false,
            last_id: "claude-c",
          })
        : Response.json({
            data: [
              {
                type: "model",
                id: "claude-a",
                display_name: "Claude A",
                max_input_tokens: 1_000_000,
              },
              { type: "model", id: "claude-b", display_name: "claude-b" },
            ],
            has_more: true,
            last_id: "claude-b",
          }),
    );
    const h = createHarness();
    await h.addProvider("claude", up.url, ["sk-ant"], { type: "anthropic" });
    const res = (await h.admin("POST", "/providers/claude/models/refresh")).json;
    expect(res.data.map((m: any) => [m.id, m.name, m.context_window])).toEqual([
      ["claude-a", "Claude A", 1_000_000],
      ["claude-b", null, null],
      ["claude-c", "Claude C", null],
    ]);
    expect(
      up.seen.map((s) => [s.apiKey, s.version, s.query.get("limit"), s.query.get("after_id")]),
    ).toEqual([
      ["sk-ant", "2023-06-01", "1000", null],
      ["sk-ant", "2023-06-01", "1000", "claude-b"],
    ]);
  });
});

describe("fixed lists for OAuth providers", () => {
  it("serves Kiro and Antigravity lists without credentials or network", async () => {
    const h = createHarness();
    await h.admin("POST", "/providers", { id: "kiro", type: "kiro" });
    await h.admin("POST", "/providers", { id: "agy", type: "antigravity" });

    const kiro = (await h.admin("GET", "/providers/kiro/models")).json;
    expect(kiro).toMatchObject({ source: "static", error: null, fetched_at: null });
    expect(kiro.data.find((m: any) => m.id === "claude-sonnet-4.5")).toMatchObject({
      context_window: 200_000,
    });

    const agy = (await h.admin("GET", "/providers/agy/models")).json;
    expect(agy.source).toBe("static");
    expect(agy.data.map((m: any) => m.id)).toContain("gemini-3.1-pro");
    expect((await h.admin("POST", "/providers/agy/models/refresh")).json.source).toBe("static");
  });

  it("tells the UI how each provider type learns its models", async () => {
    const h = createHarness();
    const types = Object.fromEntries(
      (await h.admin("GET", "/provider-types")).json.data.map((t: any) => [t.type, t.models]),
    );
    expect(types).toMatchObject({
      "openai-compat": "fetch",
      anthropic: "fetch",
      kiro: "static",
      antigravity: "static",
    });
  });
});

describe("/v1/models", () => {
  it("lists aliases and every provider/model the key may use, from stored data", async () => {
    const up = await modelsServer(() => openAiList("alpha", "beta"));
    const fixed: ProviderAdapter = {
      ...ADAPTERS["openai-compat"]!,
      type: "fixed",
      staticModels: [{ id: "only-one" }],
    };
    const h = createHarness({}, { adapters: { ...ADAPTERS, fixed } });
    await h.addProvider("acme", up.url, ["k"]);
    await h.admin("POST", "/providers", { id: "fx", type: "fixed", base_url: "http://x.test/v1" });
    await h.admin("POST", "/providers/acme/models/refresh");
    await h.admin("PUT", "/aliases/smart", { targets: [{ provider: "acme", model: "alpha" }] });

    const all = await h.newKey();
    const ids = async (secret: string) =>
      (
        await readJson(
          await h.services.app.request("/v1/models", {
            headers: { authorization: `Bearer ${secret}` },
          }),
        )
      ).data
        .map((m: any) => m.id)
        .sort();
    expect(await ids(all.secret)).toEqual(["acme/alpha", "acme/beta", "fx/only-one", "smart"]);
    expect(up.seen).toHaveLength(1); // listing never hits the upstream

    const narrow = await h.newKey({ allowed_models: ["smart", "fx/*"] });
    expect(await ids(narrow.secret)).toEqual(["fx/only-one", "smart"]);

    await h.admin("PATCH", "/providers/acme", { enabled: false });
    expect(await ids(all.secret)).toEqual(["fx/only-one", "smart"]);
  });
});

interface ModelFlag {
  id: string;
  enabled: boolean;
}
interface ProviderGroup {
  provider: string;
  type: string;
  source: string;
  data: unknown[];
}

describe("disabling models", () => {
  it("hides a disabled model from /v1/models and flags it in the admin lists", async () => {
    const up = await modelsServer(() => openAiList("alpha", "beta"));
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k"]);
    await h.admin("POST", "/providers/acme/models/refresh");
    await h.admin("PUT", "/aliases/smart", { targets: [{ provider: "acme", model: "alpha" }] });
    await h.admin("PUT", "/aliases/both", {
      targets: [
        { provider: "acme", model: "alpha" },
        { provider: "acme", model: "beta" },
      ],
    });
    const key = await h.newKey();
    const ids = async () =>
      (
        await readJson(
          await h.services.app.request("/v1/models", {
            headers: { authorization: `Bearer ${key.secret}` },
          }),
        )
      ).data
        .map((m: { id: string }) => m.id)
        .sort();
    const flags = async () =>
      Object.fromEntries(
        (await h.admin("GET", "/models")).json.data[0].data.map((m: ModelFlag) => [
          m.id,
          m.enabled,
        ]),
      );

    expect(await h.admin("PATCH", "/models/acme/alpha", { enabled: false })).toMatchObject({
      status: 200,
      json: { provider: "acme", id: "alpha", enabled: false },
    });
    expect(await flags()).toEqual({ alpha: false, beta: true });
    expect(
      (await h.admin("GET", "/providers/acme/models")).json.data.map((m: ModelFlag) => m.enabled),
    ).toEqual([false, true]);
    // an alias disappears only when all of its targets are off
    expect(await ids()).toEqual(["acme/beta", "both"]);

    await h.admin("PATCH", "/models/acme/alpha", { enabled: true });
    expect(await flags()).toEqual({ alpha: true, beta: true });
    expect(await ids()).toEqual(["acme/alpha", "acme/beta", "both", "smart"]);
  });

  it("lists every provider with its stored models, without fetching", async () => {
    const up = await modelsServer(() => openAiList("alpha"));
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k"]);
    await h.admin("POST", "/providers", { id: "kiro", type: "kiro" });

    const { data } = (await h.admin("GET", "/models")).json;
    expect(
      data.map((g: ProviderGroup) => [g.provider, g.type, g.source, g.data.length > 0]),
    ).toEqual([
      ["acme", "openai-compat", "none", false],
      ["kiro", "kiro", "static", true],
    ]);
    expect(up.seen).toHaveLength(0);
  });

  it("accepts ids the provider does not list (including ones containing a slash) and bad input", async () => {
    const up = await modelsServer(() => openAiList("alpha"));
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k"]);

    expect(
      (await h.admin("PATCH", "/models/acme/vendor/unlisted", { enabled: false })).json,
    ).toMatchObject({ id: "vendor/unlisted", enabled: false });
    expect(
      all<{ model_id: string }>(h.services.db.prepare("SELECT model_id FROM disabled_models")).map(
        (r) => r.model_id,
      ),
    ).toEqual(["vendor/unlisted"]);
    expect((await h.admin("PATCH", "/models/ghost/m", { enabled: false })).status).toBe(404);
    expect((await h.admin("PATCH", "/models/acme/alpha", { enabled: "no" })).status).toBe(400);
  });

  it("forgets a provider's disabled models with the provider", async () => {
    const up = await modelsServer(() => openAiList("alpha"));
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k"]);
    await h.admin("PATCH", "/models/acme/alpha", { enabled: false });
    await h.admin("DELETE", "/providers/acme");
    expect(all(h.services.db.prepare("SELECT 1 FROM disabled_models"))).toHaveLength(0);
  });
});

describe("parseOpenAiModels", () => {
  it("accepts the shapes real servers return and ignores junk", () => {
    expect(
      parseOpenAiModels({ data: [{ id: "a" }, { id: "a" }, { id: "" }, { nope: 1 }, "b"] }).map(
        (m) => m.id,
      ),
    ).toEqual(["a", "b"]);
    expect(
      parseOpenAiModels({
        models: [{ name: "models/gemini-x", displayName: "Gemini X", inputTokenLimit: 1000 }],
      }),
    ).toEqual([{ id: "gemini-x", name: "Gemini X", contextWindow: 1000 }]);
    expect(parseOpenAiModels(["x", "y"]).map((m) => m.id)).toEqual(["x", "y"]);
    expect(() => parseOpenAiModels({ error: "no" })).toThrow(/no model array/);
    expect(() => parseOpenAiModels("html page")).toThrow();
  });
});
