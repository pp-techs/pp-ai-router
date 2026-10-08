import { afterEach, describe, expect, it } from "vite-plus/test";
import { all } from "../src/db/database.ts";
import { OAuthRefreshError, type OAuthTokens } from "../src/oauth/types.ts";
import { ADAPTERS, type ProviderAdapter } from "../src/providers/adapter.ts";
import { completion, createHarness } from "./harness.ts";

const HOUR = 3_600_000;

/** Scriptable OAuth provider: device (`fake-device`) and paste (`fake-paste`) logins, countable refreshes. */
function fakeAdapters(clock: { now: number }) {
  const state = {
    polls: 0,
    refreshes: 0,
    refreshFailure: null as null | "terminal" | "transient",
    /** Access tokens the fake upstream accepts. */
    valid: new Set<string>(),
    seen: [] as { token: string; meta: Record<string, string> }[],
  };
  const fresh = (n: number, expiresIn = HOUR): OAuthTokens => ({
    accessToken: `at-${n}`,
    refreshToken: `rt-${n}`,
    expiresAt: clock.now + expiresIn,
    account: "alice@example.com",
    extra: { project: "proj-1" },
  });
  const refresh = async (): Promise<OAuthTokens> => {
    state.refreshes++;
    await new Promise((r) => setTimeout(r, 5)); // let concurrent callers pile up
    if (state.refreshFailure === "terminal") throw new OAuthRefreshError("invalid_grant", true);
    if (state.refreshFailure === "transient") throw new OAuthRefreshError("503 from idp", false);
    const next = fresh(100 + state.refreshes);
    state.valid.add(next.accessToken);
    return next;
  };
  const call: ProviderAdapter["call"] = ({ token, meta }) => {
    state.seen.push({ token, meta: { ...meta } });
    return Promise.resolve(
      state.valid.has(token) ? completion() : new Response("expired", { status: 401 }),
    );
  };
  const device: ProviderAdapter = {
    type: "fake-device",
    label: "Fake device",
    defaultBaseUrl: "http://unused.test",
    call,
    oauth: {
      label: "Sign in (device)",
      start: () =>
        Promise.resolve({
          info: {
            flow: "device",
            verificationUri: "https://idp.test/device",
            userCode: "ABCD-1234",
            intervalSec: 5,
            expiresAt: clock.now + 600_000,
          },
          state: { polls: 0 },
        }),
      poll: (s) => {
        state.polls++;
        const session = s as { polls: number };
        if (++session.polls < 2) return Promise.resolve({ status: "pending" });
        const t = fresh(1);
        state.valid.add(t.accessToken);
        return Promise.resolve({ status: "complete", tokens: t });
      },
      refresh,
    },
  };
  const paste: ProviderAdapter = {
    type: "fake-paste",
    label: "Fake paste",
    defaultBaseUrl: "http://unused.test",
    call,
    oauth: {
      label: "Sign in (paste)",
      start: () =>
        Promise.resolve({
          info: {
            flow: "paste",
            authUrl: "https://idp.test/auth?state=s1",
            instructions: "paste the URL",
            expiresAt: clock.now + 600_000,
          },
          state: { expect: "s1" },
        }),
      complete: (s, input) => {
        if (!input.includes((s as { expect: string }).expect))
          return Promise.reject(new Error("state mismatch"));
        const t = fresh(1);
        state.valid.add(t.accessToken);
        return Promise.resolve(t);
      },
      refresh,
    },
  };
  return { state, adapters: { ...ADAPTERS, [device.type]: device, [paste.type]: paste } };
}

async function setup() {
  const clock = { now: 0 };
  const fake = fakeAdapters(clock);
  const h = createHarness({}, { adapters: fake.adapters });
  clock.now = h.clock.now;
  // Keep the fake's clock and the harness clock identical.
  Object.defineProperty(clock, "now", {
    get: () => h.clock.now,
    set: (v: number) => (h.clock.now = v),
  });
  await h.admin("POST", "/providers", { id: "sub", type: "fake-device" });
  const key = await h.newKey();
  /** Completes a device login and returns the credential id. */
  const login = async () => {
    const started = await h.admin("POST", "/providers/sub/oauth/start", {});
    expect(started.status).toBe(201);
    const sid = started.json.session_id as string;
    expect((await h.admin("GET", `/oauth/sessions/${sid}`)).json.status).toBe("pending");
    h.clock.now += 6000;
    const done = await h.admin("GET", `/oauth/sessions/${sid}`);
    expect(done.json.status).toBe("complete");
    return done.json.credential_id as string;
  };
  return { h, key, login, ...fake };
}

describe("OAuth login", () => {
  it("runs a device flow through the admin API and stores the account encrypted", async () => {
    const { h, login } = await setup();
    const started = await h.admin("POST", "/providers/sub/oauth/start", {
      label: "work",
      weight: 2,
    });
    expect(started.json).toMatchObject({
      flow: "device",
      user_code: "ABCD-1234",
      verification_uri: "https://idp.test/device",
      interval_sec: 5,
    });
    const early = await h.admin("GET", `/oauth/sessions/${started.json.session_id}`);
    expect(early.json.status).toBe("pending");
    expect(early.json.user_code).toBe("ABCD-1234");

    const credentialId = await login();
    const [cred] = (await h.admin("GET", "/providers/sub/credentials")).json.data;
    expect(cred).toMatchObject({
      id: credentialId,
      kind: "oauth",
      account: "alice@example.com",
      secret_hint: null,
      status: "active",
    });
    expect(cred.expires_at).toBeGreaterThan(h.clock.now);

    const [row] = all<{ secret_enc: string }>(
      h.services.db.prepare("SELECT secret_enc FROM credentials"),
    );
    expect(row!.secret_enc).not.toContain("at-1");
    expect(row!.secret_enc).not.toContain("rt-1");
  });

  it("does not poll the identity provider more often than it asked", async () => {
    const { h, state } = await setup();
    const sid = (await h.admin("POST", "/providers/sub/oauth/start", {})).json.session_id;
    await h.admin("GET", `/oauth/sessions/${sid}`);
    await h.admin("GET", `/oauth/sessions/${sid}`);
    await h.admin("GET", `/oauth/sessions/${sid}`);
    expect(state.polls).toBe(1);
  });

  it("keeps a paste flow pending after a bad paste and finishes on a good one", async () => {
    const { h } = await setup();
    await h.admin("POST", "/providers", { id: "pasty", type: "fake-paste" });
    const started = await h.admin("POST", "/providers/pasty/oauth/start", {});
    expect(started.json).toMatchObject({
      flow: "paste",
      auth_url: "https://idp.test/auth?state=s1",
    });
    const sid = started.json.session_id;

    const bad = await h.admin("POST", `/oauth/sessions/${sid}/complete`, {
      input: "http://localhost/cb?state=wrong",
    });
    expect(bad.status).toBe(400);
    expect((await h.admin("GET", `/oauth/sessions/${sid}`)).json.status).toBe("pending");

    const good = await h.admin("POST", `/oauth/sessions/${sid}/complete`, {
      input: "http://localhost/cb?code=c&state=s1",
    });
    expect(good.json.status).toBe("complete");
    expect((await h.admin("GET", "/providers/pasty/credentials")).json.data).toHaveLength(1);
  });

  it("expires abandoned sessions and refuses OAuth for providers that have none", async () => {
    const { h } = await setup();
    const sid = (await h.admin("POST", "/providers/sub/oauth/start", {})).json.session_id;
    h.clock.now += 601_000;
    expect((await h.admin("GET", `/oauth/sessions/${sid}`)).json.status).toBe("expired");

    await h.admin("POST", "/providers", {
      id: "plain",
      type: "openai-compat",
      base_url: "https://x.test/v1",
    });
    expect((await h.admin("POST", "/providers/plain/oauth/start", {})).status).toBe(400);
    expect((await h.admin("GET", "/oauth/sessions/nope")).status).toBe(404);
  });

  it("lists provider types with their OAuth capability and applies default base URLs", async () => {
    const { h } = await setup();
    const types = (await h.admin("GET", "/provider-types")).json.data;
    expect(types.find((t: any) => t.type === "fake-device")).toMatchObject({
      default_base_url: "http://unused.test",
      oauth: { label: "Sign in (device)" },
    });
    expect(types.find((t: any) => t.type === "openai-compat")).toMatchObject({
      default_base_url: null,
      oauth: null,
    });
    expect(
      (await h.admin("GET", "/providers")).json.data.find((p: any) => p.id === "sub"),
    ).toMatchObject({ base_url: "http://unused.test", oauth: true });
    expect(
      (await h.admin("POST", "/providers", { id: "nobase", type: "openai-compat" })).status,
    ).toBe(400);
  });
});

describe("OAuth token lifecycle", () => {
  it("sends the access token and the account's stored extras to the adapter", async () => {
    const { h, key, login, state } = await setup();
    await login();
    expect((await h.chat(key.secret, { model: "sub/m" })).status).toBe(200);
    expect(state.seen.at(-1)).toEqual({ token: "at-1", meta: { project: "proj-1" } });
    expect(state.refreshes).toBe(0);
  });

  it("refreshes once, even under concurrent requests, shortly before expiry and persists the result", async () => {
    const { h, key, login, state } = await setup();
    await login();
    h.clock.now += HOUR - 30_000; // inside the 60s refresh skew
    const results = await Promise.all(
      Array.from({ length: 5 }, () => Promise.resolve(h.chat(key.secret, { model: "sub/m" }))),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(state.refreshes).toBe(1);
    expect(new Set(state.seen.slice(-5).map((s) => s.token))).toEqual(new Set(["at-101"]));

    h.services.registry.reload(); // what a restart would see
    const [cred] = (await h.admin("GET", "/providers/sub/credentials")).json.data;
    expect(cred.expires_at).toBe(h.clock.now + HOUR);
    await h.chat(key.secret, { model: "sub/m" });
    expect(state.refreshes).toBe(1);
  });

  it("refreshes and retries once when the upstream rejects a not-yet-expired token", async () => {
    const { h, key, login, state } = await setup();
    await login();
    state.valid.delete("at-1"); // revoked early
    const res = await h.chat(key.secret, { model: "sub/m" });
    expect(res.status).toBe(200);
    expect(state.seen.map((s) => s.token).slice(-2)).toEqual(["at-1", "at-101"]);
    expect((await h.admin("GET", "/providers/sub/credentials")).json.data[0].status).toBe("active");
  });

  it("retires the account when the refresh token is rejected for good, until it signs in again", async () => {
    const { h, key, login, state } = await setup();
    const id = await login();
    state.refreshFailure = "terminal";
    h.clock.now += HOUR;
    expect((await h.chat(key.secret, { model: "sub/m" })).status).toBe(502);
    const [cred] = (await h.admin("GET", "/providers/sub/credentials")).json.data;
    expect(cred).toMatchObject({ id, status: "dead" });
    expect(cred.last_error).toContain("re-authorisation required");
    expect((await h.chat(key.secret, { model: "sub/m" })).status).toBe(503);
    expect((await h.admin("PATCH", `/credentials/${id}`, { secret: "x" })).status).toBe(400);
  });

  it("only cools the account down when the refresh fails transiently", async () => {
    const { h, key, login, state } = await setup();
    await login();
    state.refreshFailure = "transient";
    h.clock.now += HOUR;
    expect((await h.chat(key.secret, { model: "sub/m" })).status).toBe(502);
    const [cred] = (await h.admin("GET", "/providers/sub/credentials")).json.data;
    expect(cred.status).toBe("active");
    expect(cred.cooldown_until).toBeGreaterThan(h.clock.now);

    state.refreshFailure = null;
    h.clock.now += 10 * 60_000;
    expect((await h.chat(key.secret, { model: "sub/m" })).status).toBe(200);
  });
});

afterEach(() => {});
