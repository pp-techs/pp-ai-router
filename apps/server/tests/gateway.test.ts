import { afterEach, describe, expect, it } from "vite-plus/test";
import { all } from "../src/db/database.ts";
import { completion, createHarness, readJson, sse, startUpstream } from "./harness.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function upstream(handler: Parameters<typeof startUpstream>[0]) {
  const u = await startUpstream(handler);
  closers.push(u.close);
  return u;
}

interface Bucket {
  ts: number;
  requests: number;
  input_tokens: number;
}

/** $10 per 1M tokens in and out, so cost = tokens / 100_000. */
const price = (h: ReturnType<typeof createHarness>, model: string) =>
  h.admin("PUT", "/pricing/overrides", { model, input_per_1m: 10, output_per_1m: 10 });

describe("request lifecycle", () => {
  it("routes an aliased model, rewrites the model name, and bills from the price override", async () => {
    const up = await upstream(() => completion({ prompt_tokens: 100, completion_tokens: 50 }));
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    await h.admin("PUT", "/aliases/smart", {
      targets: [{ provider: "acme", model: "acme-large" }],
    });
    await price(h, "acme/acme-large");
    const key = await h.newKey();

    const res = await h.chat(key.secret, { model: "smart" });
    expect(res.status).toBe(200);
    expect((await readJson(res)).choices[0].message.content).toBe("hi");
    expect(up.calls[0]!.body.model).toBe("acme-large");

    const events = (await h.admin("GET", `/usage?key_id=${key.id}`)).json.data;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      model: "smart",
      upstream_model: "acme-large",
      input_tokens: 100,
      output_tokens: 50,
      status: "ok",
      price_source: "override",
    });
    expect(events[0].cost_usd).toBeCloseTo(150 / 100_000, 10);
  });

  it("buckets usage over time, aligned to the bucket size and scoped to a key", async () => {
    const up = await upstream(() => completion({ prompt_tokens: 100, completion_tokens: 50 }));
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    await price(h, "acme/m");
    const a = await h.newKey({ name: "a" });
    const b = await h.newKey({ name: "b" });
    const HOUR = 3_600_000;
    const start = Math.floor(h.clock.now / HOUR) * HOUR;

    h.clock.now = start + 5 * 60_000;
    await h.chat(a.secret, { model: "acme/m" });
    await h.chat(b.secret, { model: "acme/m" });
    h.clock.now = start + 2 * HOUR + 1000;
    await h.chat(a.secret, { model: "acme/m" });

    const all = (await h.admin("GET", `/usage/timeline?since=${start}&bucket_ms=${HOUR}`)).json;
    expect(all.data.map((r: Bucket) => [r.ts, r.requests, r.input_tokens])).toEqual([
      [start, 2, 200],
      [start + 2 * HOUR, 1, 100],
    ]);
    expect(all.data[0].cost_usd).toBeCloseTo(300 / 100_000, 10);

    const scoped = (
      await h.admin("GET", `/usage/timeline?since=${start}&bucket_ms=${HOUR}&key_id=${b.id}`)
    ).json;
    expect(scoped.data.map((r: Bucket) => [r.ts, r.requests])).toEqual([[start, 1]]);

    expect((await h.admin("GET", "/usage/timeline?bucket_ms=5")).status).toBe(400);
    expect((await h.admin("GET", "/usage/timeline")).status).toBe(400);
  });

  it("addresses a provider directly with provider/model", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    const key = await h.newKey();
    expect((await h.chat(key.secret, { model: "acme/some-model" })).status).toBe(200);
    expect(up.calls[0]!.body.model).toBe("some-model");
  });

  it("rejects missing keys, disallowed models and unknown models with distinct errors", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    const key = await h.newKey({ allowed_models: ["acme/cheap-*"] });

    expect((await h.chat("sk-pp-nope", { model: "acme/cheap-1" })).status).toBe(401);
    const denied = await h.chat(key.secret, { model: "acme/expensive" });
    expect(denied.status).toBe(403);
    expect((await readJson(denied)).error.code).toBe("model_not_allowed");
    const open = await h.newKey();
    expect((await h.chat(open.secret, { model: "ghost/model" })).status).toBe(404);
    expect(up.calls).toHaveLength(0);
  });

  it("refuses a disabled model, falls back past it inside an alias, and routes to it again once enabled", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    await h.admin("PUT", "/aliases/smart", {
      targets: [
        { provider: "acme", model: "primary" },
        { provider: "acme", model: "fallback" },
      ],
    });
    await h.admin("PUT", "/aliases/only-primary", {
      targets: [{ provider: "acme", model: "primary" }],
    });
    const key = await h.newKey();
    await h.admin("PATCH", "/models/acme/primary", { enabled: false });

    const direct = await h.chat(key.secret, { model: "acme/primary" });
    expect(direct.status).toBe(404);
    expect((await readJson(direct)).error).toMatchObject({
      code: "model_not_found",
      message: 'Model "acme/primary" is disabled.',
    });
    expect((await h.chat(key.secret, { model: "only-primary" })).status).toBe(404);
    expect(up.calls).toHaveLength(0);

    expect((await h.chat(key.secret, { model: "smart" })).status).toBe(200);
    expect(up.calls.map((c) => c.body.model)).toEqual(["fallback"]);

    await h.admin("PATCH", "/models/acme/primary", { enabled: true });
    expect((await h.chat(key.secret, { model: "acme/primary" })).status).toBe(200);
    expect(up.calls.map((c) => c.body.model)).toEqual(["fallback", "primary"]);
  });

  it("does not accept a disabled or expired key", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    const expiring = await h.newKey({ expires_at: h.clock.now + 1000 });
    const disabled = await h.newKey();
    await h.admin("PATCH", `/keys/${disabled.id}`, { enabled: false });

    expect((await h.chat(expiring.secret, { model: "acme/m" })).status).toBe(200);
    h.clock.now += 2000;
    expect((await h.chat(expiring.secret, { model: "acme/m" })).status).toBe(401);
    expect((await h.chat(disabled.secret, { model: "acme/m" })).status).toBe(401);
  });

  it("passes an upstream 4xx through without penalising the credential", async () => {
    const up = await upstream((_c, n) =>
      n === 1 ? Response.json({ error: { message: "bad param" } }, { status: 400 }) : completion(),
    );
    const h = createHarness();
    const [cred] = await h.addProvider("acme", up.url, ["k1"]);
    const key = await h.newKey();

    const bad = await h.chat(key.secret, { model: "acme/m" });
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error.message).toBe("bad param");
    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(200);
    const list = (await h.admin("GET", "/providers/acme/credentials")).json.data;
    expect(list.find((c: any) => c.id === cred)).toMatchObject({ status: "active", fail_count: 0 });
  });
});

describe("credential selection", () => {
  it("round-robins across a provider's credentials", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1", "k2"], { key_strategy: "round_robin" });
    const key = await h.newKey();
    for (let i = 0; i < 4; i++) await h.chat(key.secret, { model: "acme/m" });
    expect(up.calls.map((c) => c.secret).sort()).toEqual(["k1", "k1", "k2", "k2"]);
    expect(new Set(up.calls.slice(0, 2).map((c) => c.secret)).size).toBe(2);
  });

  it("honours weights", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    const [a] = await h.addProvider("acme", up.url, ["k1", "k2"], { key_strategy: "weighted" });
    await h.admin("PATCH", `/credentials/${a}`, { weight: 3 });
    const key = await h.newKey();
    for (let i = 0; i < 8; i++) await h.chat(key.secret, { model: "acme/m" });
    expect(up.calls.filter((c) => c.secret === "k1")).toHaveLength(6);
    expect(up.calls.filter((c) => c.secret === "k2")).toHaveLength(2);
  });

  it("fill_first sticks to the lowest priority until it fails", async () => {
    const up = await upstream((c) =>
      c.secret === "k1" ? new Response("down", { status: 503 }) : completion(),
    );
    const h = createHarness();
    const [first, second] = await h.addProvider("acme", up.url, ["k1", "k2"], {
      key_strategy: "fill_first",
    });
    await h.admin("PATCH", `/credentials/${first}`, { priority: 1 });
    await h.admin("PATCH", `/credentials/${second}`, { priority: 2 });
    const key = await h.newKey();

    const res = await h.chat(key.secret, { model: "acme/m" }); // k1 fails -> retried on k2
    expect(res.status).toBe(200);
    expect(up.calls.map((c) => c.secret)).toEqual(["k1", "k2"]);
    await h.chat(key.secret, { model: "acme/m" }); // k1 cooling down, straight to k2
    expect(up.calls.map((c) => c.secret)).toEqual(["k1", "k2", "k2"]);
  });

  it("keeps a session on one credential when the provider is sticky", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1", "k2", "k3"], {
      key_strategy: "round_robin",
      sticky_ttl_sec: 60,
    });
    const key = await h.newKey();
    for (let i = 0; i < 4; i++)
      await h.chat(key.secret, { model: "acme/m" }, { "x-session-id": "conv-1" });
    expect(new Set(up.calls.map((c) => c.secret)).size).toBe(1);
    h.clock.now += 61_000; // TTL elapsed: free to move
    await h.chat(key.secret, { model: "acme/m" }, { "x-session-id": "conv-1" });
    expect(up.calls).toHaveLength(5);
  });

  it("restricts a credential to the models it is allowed to serve", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    const [a] = await h.addProvider("acme", up.url, ["k1", "k2"]);
    await h.admin("PATCH", `/credentials/${a}`, { models: ["gpt-*"] });
    const key = await h.newKey();
    for (let i = 0; i < 3; i++) await h.chat(key.secret, { model: "acme/claude-x" });
    expect(new Set(up.calls.map((c) => c.secret))).toEqual(new Set(["k2"]));
  });

  it("enforces a per-credential requests-per-minute cap", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    const [a] = await h.addProvider("acme", up.url, ["k1"]);
    await h.admin("PATCH", `/credentials/${a}`, { rpm_limit: 2 });
    const key = await h.newKey();
    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(200);
    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(200);
    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(503);
    h.clock.now += 61_000;
    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(200);
  });
});

describe("failure handling", () => {
  it("fails over on 429, honours Retry-After, and brings the credential back afterwards", async () => {
    const up = await upstream((c) =>
      c.secret === "k1"
        ? new Response("slow down", { status: 429, headers: { "retry-after": "120" } })
        : completion(),
    );
    const h = createHarness();
    const [a] = await h.addProvider("acme", up.url, ["k1", "k2"], { key_strategy: "fill_first" });
    await h.admin("PATCH", `/credentials/${a}`, { priority: -1 }); // k1 first, deterministically
    const key = await h.newKey();

    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(200);
    const [cred] = (await h.admin("GET", "/providers/acme/credentials")).json.data.filter(
      (c: any) => c.id === a,
    );
    expect(cred.cooldown_until).toBe(h.clock.now + 120_000);

    await h.chat(key.secret, { model: "acme/m" });
    expect(up.calls.filter((c) => c.secret === "k1")).toHaveLength(1); // skipped while cooling down
    h.clock.now += 121_000;
    await h.chat(key.secret, { model: "acme/m" });
    expect(up.calls.filter((c) => c.secret === "k1")).toHaveLength(2); // half-open probe
  });

  it("retires a credential on 401 and keeps it out of rotation until its secret is replaced", async () => {
    const up = await upstream((c) =>
      c.secret === "k1" ? new Response("no", { status: 401 }) : completion(),
    );
    const h = createHarness();
    const [a] = await h.addProvider("acme", up.url, ["k1", "k2"], { key_strategy: "fill_first" });
    await h.admin("PATCH", `/credentials/${a}`, { priority: -1 });
    const key = await h.newKey();

    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(200);
    await h.chat(key.secret, { model: "acme/m" });
    expect(up.calls.filter((c) => c.secret === "k1")).toHaveLength(1);
    const dead = (await h.admin("GET", "/providers/acme/credentials")).json.data.find(
      (c: any) => c.id === a,
    );
    expect(dead.status).toBe("dead");

    await h.admin("PATCH", `/credentials/${a}`, { secret: "k1-new" });
    await h.chat(key.secret, { model: "acme/m" });
    expect(up.calls.at(-1)!.secret).toBe("k1-new");
  });

  it("falls back to the next alias target when a provider is exhausted", async () => {
    const bad = await upstream(() => new Response("boom", { status: 500 }));
    const good = await upstream(() => completion());
    const h = createHarness();
    await h.addProvider("primary", bad.url, ["p1", "p2"]);
    await h.addProvider("backup", good.url, ["b1"]);
    await h.admin("PUT", "/aliases/chat", {
      targets: [
        { provider: "primary", model: "m" },
        { provider: "backup", model: "m2" },
      ],
    });
    const key = await h.newKey();

    const res = await h.chat(key.secret, { model: "chat" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-router-provider")).toBe("backup");
    expect(bad.calls).toHaveLength(2); // both primary credentials were tried
    expect(good.calls[0]!.body.model).toBe("m2");
  });

  it("returns 502 with the upstream status when every attempt fails, and 503 + Retry-After when nothing is available", async () => {
    const up = await upstream(() => new Response("kaput", { status: 500 }));
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    const key = await h.newKey();

    const first = await h.chat(key.secret, { model: "acme/m" });
    expect(first.status).toBe(502);
    expect((await readJson(first)).error).toMatchObject({
      code: "upstream_error",
      upstream_status: 500,
    });

    const second = await h.chat(key.secret, { model: "acme/m" });
    expect(second.status).toBe(503);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("streaming", () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":100}}}\n\n',
    "data: [DONE]\n\n",
  ];

  it("passes bytes through, asks upstream for usage, and accounts for it when the stream ends", async () => {
    const up = await upstream(() => sse(chunks));
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    await h.admin("PUT", "/pricing/overrides", {
      model: "acme/m",
      input_per_1m: 10,
      output_per_1m: 20,
      cache_read_per_1m: 1,
    });
    const key = await h.newKey();

    const res = await h.chat(key.secret, { model: "acme/m", stream: true });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toBe(chunks.join(""));
    expect(up.calls[0]!.body.stream_options).toEqual({ include_usage: true });

    const [event] = (await h.admin("GET", `/usage?key_id=${key.id}`)).json.data;
    expect(event).toMatchObject({
      stream: 1,
      status: "ok",
      input_tokens: 200,
      cached_tokens: 100,
      output_tokens: 20,
    });
    expect(event.cost_usd).toBeCloseTo(100 * 10e-6 + 100 * 1e-6 + 20 * 20e-6, 10);
  });

  it("keeps a client's own stream_options and records no_usage when upstream never reports it", async () => {
    const up = await upstream(() => sse([chunks[0]!, "data: [DONE]\n\n"]));
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    const key = await h.newKey();

    const res = await h.chat(key.secret, {
      model: "acme/m",
      stream: true,
      stream_options: { foo: 1 },
    });
    await res.text();
    expect(up.calls[0]!.body.stream_options).toEqual({ foo: 1, include_usage: true });
    const [event] = (await h.admin("GET", `/usage?key_id=${key.id}`)).json.data;
    expect(event.status).toBe("no_usage");
  });

  it("records an aborted event and frees the credential when the client disconnects", async () => {
    const up = await upstream(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(chunks[0]));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const h = createHarness();
    const [cred] = await h.addProvider("acme", up.url, ["k1"]);
    const key = await h.newKey();

    const res = await h.chat(key.secret, { model: "acme/m", stream: true });
    const reader = res.body!.getReader();
    await reader.read();
    expect(h.services.pool.snapshot(cred!).inflight).toBe(1);
    await reader.cancel();
    expect(h.services.pool.snapshot(cred!).inflight).toBe(0);
    const [event] = (await h.admin("GET", `/usage?key_id=${key.id}`)).json.data;
    expect(event.status).toBe("aborted");
  });
});

describe("budgets", () => {
  it("blocks a key once its dollar limit is spent and reports when the window resets", async () => {
    const up = await upstream(() => completion({ prompt_tokens: 100, completion_tokens: 50 })); // $0.0015 per call
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    await price(h, "acme/m");
    h.clock.now = Date.UTC(2030, 0, 1, 10, 30);
    const key = await h.newKey({
      limits: [{ metric: "usd", window: "1h", mode: "fixed", max: 0.002 }],
    });

    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(200);
    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(200); // $0.0015 < $0.002 at admission
    const blocked = await h.chat(key.secret, { model: "acme/m" });
    expect(blocked.status).toBe(429);
    const body = await readJson(blocked);
    expect(body.error).toMatchObject({
      code: "limit_exceeded",
      limit: { metric: "usd", window: "1h", max: 0.002 },
    });
    expect(body.error.limit.used).toBeCloseTo(0.003, 10);
    expect(body.error.resets_at).toBe(Date.UTC(2030, 0, 1, 11, 0));
    expect(Number(blocked.headers.get("retry-after"))).toBe(30 * 60);
    expect(up.calls).toHaveLength(2); // the blocked request never reached upstream

    h.clock.now = Date.UTC(2030, 0, 1, 11, 0);
    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(200);
  });

  it("enforces token and request limits independently per key", async () => {
    const up = await upstream(() => completion({ prompt_tokens: 100, completion_tokens: 50 }));
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    const tokenKey = await h.newKey({
      limits: [{ metric: "total_tokens", window: "1d", mode: "rolling", max: 200 }],
    });
    const requestKey = await h.newKey({
      limits: [{ metric: "requests", window: "total", max: 1 }],
    });

    expect((await h.chat(tokenKey.secret, { model: "acme/m" })).status).toBe(200); // 150 < 200
    expect((await h.chat(tokenKey.secret, { model: "acme/m" })).status).toBe(200); // 300 >= 200 after this
    expect((await h.chat(tokenKey.secret, { model: "acme/m" })).status).toBe(429);

    expect((await h.chat(requestKey.secret, { model: "acme/m" })).status).toBe(200);
    expect((await h.chat(requestKey.secret, { model: "acme/m" })).status).toBe(429);
    expect((await h.chat(tokenKey.secret, { model: "ghost/x" })).status).toBe(429); // limits apply before routing
  });

  it("exposes live usage against each limit in the admin API", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    const key = await h.newKey({ limits: [{ metric: "total_tokens", window: "1d", max: 10_000 }] });
    await h.chat(key.secret, { model: "acme/m" });
    const view = (await h.admin("GET", `/keys/${key.id}`)).json;
    expect(view.limits[0]).toMatchObject({
      metric: "total_tokens",
      window: "1d",
      mode: "fixed",
      max: 10_000,
      used: 150,
    });
    expect(view.key).toBeUndefined(); // the plaintext is only ever shown at creation
  });

  it("refuses unpriced models when UNPRICED_MODELS=reject and bills them $0 otherwise", async () => {
    const up = await upstream(() => completion());
    const strict = createHarness({ UNPRICED_MODELS: "reject" });
    await strict.addProvider("acme", up.url, ["k1"]);
    const sk = await strict.newKey();
    const refused = await strict.chat(sk.secret, { model: "acme/mystery" });
    expect(refused.status).toBe(422);
    expect(up.calls).toHaveLength(0);

    const lax = createHarness();
    await lax.addProvider("acme", up.url, ["k1"]);
    const lk = await lax.newKey();
    expect((await lax.chat(lk.secret, { model: "acme/mystery" })).status).toBe(200);
    const [event] = all<{ price_source: string; cost_usd: number }>(
      lax.services.db.prepare("SELECT * FROM usage_events"),
    );
    expect(event).toMatchObject({ price_source: "unknown", cost_usd: 0 });
  });
});

describe("admin API", () => {
  it("requires the admin token", async () => {
    const h = createHarness();
    expect((await h.services.app.request("/admin/keys")).status).toBe(401);
    expect(
      (await h.services.app.request("/admin/keys", { headers: { authorization: "Bearer wrong" } }))
        .status,
    ).toBe(401);
  });

  it("never returns upstream secrets and stores them encrypted", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    await h.addProvider("acme", up.url, ["sk-very-secret-1234"]);
    const listing = JSON.stringify((await h.admin("GET", "/providers/acme/credentials")).json);
    expect(listing).not.toContain("sk-very-secret");
    expect(listing).toContain("…1234");
    const [row] = all<{ secret_enc: string }>(
      h.services.db.prepare("SELECT secret_enc FROM credentials"),
    );
    expect(row!.secret_enc.startsWith("v1.")).toBe(true);
    expect(row!.secret_enc).not.toContain("sk-very-secret");
  });

  it("validates input: bad windows, unknown providers in aliases, unknown fields", async () => {
    const h = createHarness();
    expect(
      (
        await h.admin("POST", "/keys", {
          name: "x",
          limits: [{ metric: "usd", window: "90s", max: 1 }],
        })
      ).status,
    ).toBe(400);
    expect((await h.admin("GET", "/keys")).json.data).toHaveLength(0); // nothing half-created
    expect(
      (await h.admin("PUT", "/aliases/a", { targets: [{ provider: "nope", model: "m" }] })).status,
    ).toBe(400);
    expect(
      (
        await h.admin("POST", "/providers", {
          id: "Bad Id",
          type: "openai-compat",
          base_url: "https://x.test",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.admin("POST", "/providers", {
          id: "ok",
          type: "openai-compat",
          base_url: "https://x.test",
          surprise: 1,
        })
      ).status,
    ).toBe(400);
  });

  it("deleting a provider removes its credentials, and deleting a key keeps its ledger", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    await h.addProvider("acme", up.url, ["k1"]);
    const key = await h.newKey();
    await h.chat(key.secret, { model: "acme/m" });
    expect((await h.admin("DELETE", `/keys/${key.id}`)).status).toBe(204);
    expect((await h.admin("GET", `/usage?key_id=${key.id}`)).json.data).toHaveLength(1);
    expect((await h.admin("DELETE", "/providers/acme")).status).toBe(204);
    expect(all(h.services.db.prepare("SELECT 1 FROM credentials"))).toHaveLength(0);
    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(401);
  });
});
