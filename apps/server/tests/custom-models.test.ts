import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { all } from "../src/db/database.ts";
import { completion, createHarness } from "./harness.ts";

interface ChatCall {
  secret: string;
  body: Record<string, unknown>;
}

/** The fields of an admin model entry these tests read. */
interface Entry {
  id: string;
  custom: boolean;
  last_test: { ok: boolean } | null;
}

/** Upstream serving `GET /v1/models` and `POST /v1/chat/completions`. */
async function upstream(
  list: string[],
  chat: (call: ChatCall, n: number) => Response | Promise<Response>,
) {
  const calls: ChatCall[] = [];
  const app = new Hono();
  app.get("/v1/models", (c) => c.json({ data: list.map((id) => ({ id })) }));
  app.post("/v1/chat/completions", async (c) => {
    calls.push({
      secret: (c.req.header("authorization") ?? "").replace(/^Bearer /, ""),
      body: await c.req.json(),
    });
    return chat(calls.at(-1)!, calls.length);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}/v1`, calls };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("custom models", () => {
  it("adds a hand-made model with its config, keeps it across refreshes, and removes it", async () => {
    const up = await upstream(["alpha"], () => completion());
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k"]);

    const put = await h.admin("PUT", "/models/acme/vendor/my-model", {
      name: "My model",
      description: "tuned in-house",
      context_window: 32_000,
      max_output_tokens: 4096,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      supported_parameters: ["tools", "temperature"],
    });
    expect(put).toMatchObject({
      status: 200,
      json: {
        id: "vendor/my-model",
        name: "My model",
        description: "tuned in-house",
        context_window: 32_000,
        max_output_tokens: 4096,
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        supported_parameters: ["tools", "temperature"],
        custom: true,
        enabled: true,
      },
    });

    // listed alongside the fetched ones, after a refresh that rewrote the stored list
    await h.admin("POST", "/providers/acme/models/refresh");
    const list = (await h.admin("GET", "/providers/acme/models")).json;
    expect(list.source).toBe("fetched");
    expect(list.data.map((m: Entry) => [m.id, m.custom])).toEqual([
      ["alpha", false],
      ["vendor/my-model", true],
    ]);

    // a custom model is offered to clients like any other
    const { secret } = await h.newKey();
    const v1 = await h.services.app.request("/v1/models", {
      headers: { authorization: `Bearer ${secret}` },
    });
    const clientList = (await v1.json()) as { data: { id: string }[] }; // the shape /v1/models documents
    expect(clientList.data.map((m) => m.id)).toContain("acme/vendor/my-model");

    // editing replaces the whole entry
    await h.admin("PUT", "/models/acme/vendor/my-model", { context_window: 8000 });
    const edited = (await h.admin("GET", "/providers/acme/models")).json.data.find(
      (m: Entry) => m.custom,
    );
    expect(edited).toMatchObject({ name: null, description: null, context_window: 8000 });

    expect((await h.admin("DELETE", "/models/acme/vendor/my-model")).status).toBe(204);
    expect((await h.admin("DELETE", "/models/acme/vendor/my-model")).status).toBe(404);
    // a listed model is not deletable
    expect((await h.admin("DELETE", "/models/acme/alpha")).status).toBe(404);
  });

  it("overrides a listed model of the same id, works on providers with no list, and validates", async () => {
    const up = await upstream(["alpha"], () => completion());
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k"]);
    await h.admin("POST", "/providers/acme/models/refresh");

    await h.admin("PUT", "/models/acme/alpha", { name: "Mine", context_window: 1000 });
    const data = (await h.admin("GET", "/providers/acme/models")).json.data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: "alpha",
      name: "Mine",
      context_window: 1000,
      custom: true,
    });

    await h.admin("POST", "/providers", { id: "kiro", type: "kiro" });
    await h.admin("PUT", "/models/kiro/my-kiro-model", {});
    const kiro = (await h.admin("GET", "/providers/kiro/models")).json;
    expect(kiro.source).toBe("static");
    expect(kiro.data.at(-1)).toMatchObject({ id: "my-kiro-model", custom: true });

    expect((await h.admin("PUT", "/models/ghost/m", {})).status).toBe(404);
    expect((await h.admin("PUT", "/models/acme/m", { context_window: 0 })).status).toBe(400);
    expect((await h.admin("PUT", "/models/acme/m", { price: 1 })).status).toBe(400);

    await h.admin("DELETE", "/providers/acme");
    expect(
      all(h.services.db.prepare("SELECT 1 FROM custom_models WHERE provider_id = 'acme'")),
    ).toHaveLength(0);
  });
});

describe("testing models", () => {
  it("sends a tiny request through the provider's credential and stores the outcome", async () => {
    const up = await upstream(["alpha", "beta"], (call) =>
      call.body.model === "beta"
        ? Response.json({ error: { message: "model beta does not exist" } }, { status: 404 })
        : Response.json({ choices: [{ message: { content: "ok" } }] }),
    );
    const h = createHarness();
    await h.addProvider("acme", up.url, ["sk-acme"]);
    await h.admin("POST", "/providers/acme/models/refresh");

    const good = await h.admin("POST", "/model-tests", { provider: "acme", model: "alpha" });
    expect(good).toMatchObject({
      status: 200,
      json: { ok: true, status: 200, error: null, reply: "ok", credential: "acme-1" },
    });
    expect(up.calls[0]).toMatchObject({
      secret: "sk-acme",
      body: { model: "alpha", max_tokens: 32 },
    });
    expect(up.calls[0]!.body.stream).toBeFalsy();

    const bad = await h.admin("POST", "/model-tests", { provider: "acme", model: "beta" });
    expect(bad.json).toMatchObject({
      ok: false,
      status: 404,
      error: "model beta does not exist",
      reply: null,
    });

    const list = (await h.admin("GET", "/models")).json.data[0].data;
    expect(list.map((m: Entry) => [m.id, m.last_test?.ok])).toEqual([
      ["alpha", true],
      ["beta", false],
    ]);
    // a test is not traffic: no usage is recorded
    expect(all(h.services.db.prepare("SELECT 1 FROM usage_events"))).toHaveLength(0);

    expect((await h.admin("POST", "/model-tests", { provider: "ghost", model: "m" })).status).toBe(
      404,
    );
  });

  it("retries with max_completion_tokens when the model refuses max_tokens", async () => {
    const up = await upstream([], (call) =>
      "max_tokens" in call.body
        ? Response.json(
            { error: { message: "Unsupported parameter: use max_completion_tokens" } },
            { status: 400 },
          )
        : completion(),
    );
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k"]);

    const r = await h.admin("POST", "/model-tests", { provider: "acme", model: "gpt-x" });
    expect(r.json).toMatchObject({ ok: true, status: 200 });
    expect(up.calls.map((c) => Object.keys(c.body).filter((k) => k.startsWith("max_")))).toEqual([
      ["max_tokens"],
      ["max_completion_tokens"],
    ]);
  });

  it("tries the next credential after one is refused, without cooling the refused one down", async () => {
    const up = await upstream([], (call) =>
      call.secret === "bad" ? new Response("no", { status: 401 }) : completion(),
    );
    const h = createHarness();
    await h.addProvider("acme", up.url, ["bad", "good"], { key_strategy: "fill_first" });

    const r = await h.admin("POST", "/model-tests", { provider: "acme", model: "m" });
    expect(r.json).toMatchObject({ ok: true, credential: "acme-2" });
    expect(up.calls.map((c) => c.secret)).toEqual(["bad", "good"]);
    // still active: the real traffic path decides health, not a test
    const creds = (await h.admin("GET", "/providers/acme/credentials")).json.data;
    expect(creds.map((c: { status: string }) => c.status)).toEqual(["active", "active"]);
  });

  it("reports why nothing was sent", async () => {
    const h = createHarness();
    await h.admin("POST", "/providers", {
      id: "empty",
      type: "openai-compat",
      base_url: "http://127.0.0.1:1/v1",
    });
    const noKey = await h.admin("POST", "/model-tests", { provider: "empty", model: "m" });
    expect(noKey.json).toMatchObject({ ok: false, status: null });
    expect(noKey.json.error).toContain("No credential");
  });
});
