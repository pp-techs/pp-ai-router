import { afterEach, describe, expect, it } from "vite-plus/test";
import { completion, createHarness, startUpstream } from "./harness.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function upstream(handler: Parameters<typeof startUpstream>[0]) {
  const u = await startUpstream(handler);
  closers.push(u.close);
  return u;
}

describe("custom upstream headers", () => {
  it("sends a provider's headers upstream, with the credential's overrides on top", async () => {
    const up = await upstream(() => completion());
    const h = createHarness();
    const [credentialId] = await h.addProvider("acme", up.url, ["k1"], {
      headers: { "x-gateway": "provider", "x-title": "router", "x-keep": "yes" },
    });
    await h.admin("PATCH", `/credentials/${credentialId}`, {
      headers: { "x-gateway": "credential", "x-key-secret": "s3cr3t" },
    });
    const key = await h.newKey();

    expect((await h.chat(key.secret, { model: "acme/m" })).status).toBe(200);
    expect(up.calls[0]!.headers["x-gateway"]).toBe("credential");
    expect(up.calls[0]!.headers["x-title"]).toBe("router");
    expect(up.calls[0]!.headers["x-keep"]).toBe("yes");
    expect(up.calls[0]!.headers["x-key-secret"]).toBe("s3cr3t");
    // The adapter's own headers survive the merge.
    expect(up.calls[0]!.headers["content-type"]).toBe("application/json");
    expect(up.calls[0]!.secret).toBe("k1");
  });

  it("reports the headers on the admin API and clears them with an empty patch", async () => {
    const h = createHarness();
    await h.admin("POST", "/providers", {
      id: "acme",
      type: "openai-compat",
      base_url: "https://x.test",
      headers: { "x-gateway": "p" },
    });
    const provider = (await h.admin("GET", "/providers")).json.data[0];
    expect(provider.headers).toEqual({ "x-gateway": "p" });

    const created = await h.admin("POST", "/providers/acme/credentials", {
      label: "one",
      secret: "k",
      headers: { "x-title": "c" },
    });
    expect((await h.admin("GET", "/providers/acme/credentials")).json.data[0].headers).toEqual({
      "x-title": "c",
    });

    // A patch touching another field leaves the headers alone; an explicit `{}` clears them.
    await h.admin("PATCH", "/providers/acme", { enabled: false });
    expect((await h.admin("GET", "/providers")).json.data[0].headers).toEqual({ "x-gateway": "p" });
    await h.admin("PATCH", "/providers/acme", { headers: {} });
    expect((await h.admin("GET", "/providers")).json.data[0].headers).toEqual({});

    await h.admin("PATCH", `/credentials/${created.json.id}`, { headers: {} });
    expect((await h.admin("GET", "/providers/acme/credentials")).json.data[0].headers).toEqual({});
  });

  it("keeps the rest of a provider's settings when a patch only toggles it", async () => {
    const h = createHarness();
    await h.admin("POST", "/providers", {
      id: "acme",
      type: "openai-compat",
      base_url: "https://x.test",
      key_strategy: "weighted",
      sticky_ttl_sec: 120,
      max_key_attempts: 7,
    });
    await h.admin("PATCH", "/providers/acme", { enabled: false });
    const provider = (await h.admin("GET", "/providers")).json.data[0];
    expect(provider).toMatchObject({
      key_strategy: "weighted",
      sticky_ttl_sec: 120,
      max_key_attempts: 7,
      enabled: false,
    });
  });

  it("refuses names the router owns and values that would break the request", async () => {
    const h = createHarness();
    const create = (headers: Record<string, string>) =>
      h.admin("POST", "/providers", {
        id: "acme",
        type: "openai-compat",
        base_url: "https://x.test",
        headers,
      });

    expect((await create({ host: "elsewhere.test" })).status).toBe(400);
    expect((await create({ "Content-Length": "12" })).status).toBe(400);
    expect((await create({ "x-a": "one\r\ntwo" })).status).toBe(400);
    expect((await create({ "x a": "v" })).status).toBe(400);
    expect((await create({ "x-a": "   " })).status).toBe(400);
    expect((await create({})).status).toBe(201);
  });
});
