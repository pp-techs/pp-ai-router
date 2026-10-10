import { describe, expect, it } from "vite-plus/test";
import { OAuthRefreshError, type OAuthTokens } from "../src/oauth/types.ts";
import { ADAPTERS, type ProviderAdapter } from "../src/providers/adapter.ts";
import {
  fetchAntigravityQuota,
  parseModelQuotas,
  parseQuotaSummary,
} from "../src/providers/antigravity/quota.ts";
import { fetchKiroQuota, parseKiroUsage, usageEndpoint } from "../src/providers/kiro/quota.ts";
import { QuotaError, type Quota, type QuotaCall } from "../src/quota/types.ts";
import { completion, createHarness } from "./harness.ts";

const call = (overrides: Partial<QuotaCall> = {}): QuotaCall => ({
  baseUrl: "http://upstream.test",
  token: "tok",
  meta: {},
  signal: new AbortController().signal,
  ...overrides,
});

interface Seen {
  url: URL;
  headers: Headers;
  body: Record<string, unknown>;
}

type Reply = () => Response;

/** A `fetch` that records requests and answers from a script (one entry per call, last repeats). */
function scriptedFetch(...replies: Reply[]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    seen.push({
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    });
    return replies[Math.min(seen.length - 1, replies.length - 1)]!();
  }) as typeof fetch;
  return { seen, fetch: fetchImpl };
}

const json =
  (body: unknown, code = 200): Reply =>
  () =>
    Response.json(body, { status: code });
const httpStatus =
  (code: number): Reply =>
  () =>
    new Response("", { status: code });

const kiroUsage = (extra: Record<string, unknown> = {}) => ({
  nextDateReset: 1_792_000_000,
  usageBreakdownList: [
    { resourceType: "CREDIT", currentUsage: 5, usageLimit: 50 },
    {
      resourceType: "AGENTIC_REQUEST",
      currentUsage: 12,
      currentUsageWithPrecision: 12.5,
      usageLimit: 50,
      usageLimitWithPrecision: 50,
      freeTrialInfo: { currentUsage: 1, usageLimit: 10 },
    },
  ],
  userInfo: { email: "someone@example.com", userId: "u-1" },
  ...extra,
});

describe("Kiro usage", () => {
  it("reports the plan allowance with fractional precision, a separate trial window and the reset", () => {
    const quota = parseKiroUsage(kiroUsage())!;
    expect(quota).toEqual({
      windows: [
        { label: "Monthly credits", usedPercent: 25, resetsAt: 1_792_000_000_000 },
        { label: "Free trial", usedPercent: 10, resetsAt: null },
      ],
      credits: { used: 12.5, limit: 50 },
      exhausted: false,
      resetsAt: 1_792_000_000_000,
    });
    expect(JSON.stringify(quota)).not.toContain("someone@example.com");
  });

  it("falls back to CREDIT only when there is no AGENTIC_REQUEST row, and never guesses by position", () => {
    const credit = parseKiroUsage({
      usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: 10, usageLimit: 40 }],
    });
    expect(credit?.credits).toEqual({ used: 10, limit: 40 });
    expect(
      parseKiroUsage({
        usageBreakdownList: [{ resourceType: "OTHER", currentUsage: 1, usageLimit: 2 }],
      }),
    ).toBeNull();
  });

  it("is exhausted only when the allowance is spent and overage is disabled", () => {
    const spent = {
      usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: 50, usageLimit: 50 }],
    };
    expect(
      parseKiroUsage({ ...spent, overageConfiguration: { overageStatus: "DISABLED" } })?.exhausted,
    ).toBe(true);
    expect(
      parseKiroUsage({ ...spent, overageConfiguration: { overageStatus: "ENABLED" } })?.exhausted,
    ).toBe(false);
    expect(parseKiroUsage(spent)?.exhausted).toBe(false);
  });

  it.each([
    ["no limit", { currentUsage: 1, usageLimit: 0 }],
    ["negative usage", { currentUsage: -1, usageLimit: 10 }],
    ["missing numbers", {}],
  ])("treats %s as unknown instead of a zero reading", (_name, row) => {
    expect(parseKiroUsage({ usageBreakdownList: [{ resourceType: "CREDIT", ...row }] })).toBeNull();
  });

  it("maps a canonical runtime host to the management host and keeps any other base URL", () => {
    expect(usageEndpoint("https://runtime.us-east-1.kiro.dev", "eu-central-1")).toBe(
      "https://management.eu-central-1.kiro.dev/",
    );
    expect(usageEndpoint("http://127.0.0.1:9000/", "us-east-1")).toBe("http://127.0.0.1:9000/");
  });

  it("sends the CLI contract: target header, bearer, and the ARN in both query and body", async () => {
    const f = scriptedFetch(json(kiroUsage()));
    await fetchKiroQuota(call({ token: "at-1", meta: { authType: "aws_sso_oidc" } }), f.fetch);
    const [req] = f.seen;
    expect(req!.headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.GetUsageLimits");
    expect(req!.headers.get("authorization")).toBe("Bearer at-1");
    // Builder ID accounts have no ARN of their own: they use the same service profile as requests do.
    const arn = req!.url.searchParams.get("profileArn");
    expect(arn).toMatch(/^arn:aws:codewhisperer:us-east-1:\d+:profile\//);
    expect(req!.body).toMatchObject({ profileArn: arn, origin: "AI_EDITOR" });
  });

  it("uses an account's own profile ARN and refuses to borrow one when there is none", async () => {
    const own = "arn:aws:codewhisperer:eu-west-1:111122223333:profile/ABC";
    const f = scriptedFetch(json(kiroUsage()));
    await fetchKiroQuota(call({ meta: { profileArn: own } }), f.fetch);
    expect(f.seen[0]!.url.searchParams.get("profileArn")).toBe(own);

    const none = scriptedFetch(json(kiroUsage()));
    await expect(fetchKiroQuota(call({ meta: {} }), none.fetch)).rejects.toMatchObject({
      code: "account_unavailable",
    });
    expect(none.seen).toHaveLength(0);
  });

  it.each([
    [401, "access_denied"],
    [403, "access_denied"],
    [429, "rate_limited"],
    [500, "upstream_error"],
  ])("diagnoses HTTP %i as %s", async (status, code) => {
    const f = scriptedFetch(httpStatus(status));
    await expect(
      fetchKiroQuota(call({ meta: { authType: "aws_sso_oidc" } }), f.fetch),
    ).rejects.toMatchObject({
      code,
      status,
    });
  });

  it("calls an unrecognised or oversized body unusable", async () => {
    const odd = scriptedFetch(json({ usageBreakdownList: "nope" }));
    await expect(
      fetchKiroQuota(call({ meta: { authType: "aws_sso_oidc" } }), odd.fetch),
    ).rejects.toMatchObject({
      code: "response_unusable",
    });
    const huge = scriptedFetch(
      () =>
        new Response("x".repeat(600 * 1024), { headers: { "content-type": "application/json" } }),
    );
    await expect(
      fetchKiroQuota(call({ meta: { authType: "aws_sso_oidc" } }), huge.fetch),
    ).rejects.toMatchObject({
      code: "response_unusable",
    });
  });
});

const summary = {
  groups: [
    {
      displayName: "Gemini models",
      buckets: [
        { window: "5h", remainingFraction: 0.75, resetTime: "2026-10-08T12:00:00Z" },
        { window: "weekly", remainingFraction: 0.5 },
      ],
    },
    { displayName: "Claude and 3P", buckets: [{ bucketId: "claude-5h", remainingFraction: 0 }] },
  ],
};

describe("Antigravity quota", () => {
  it("turns the quota summary into ordered per-family windows", () => {
    expect(parseQuotaSummary(summary)).toEqual({
      windows: [
        { label: "Gemini 5h", usedPercent: 25, resetsAt: Date.parse("2026-10-08T12:00:00Z") },
        { label: "Gemini weekly", usedPercent: 50, resetsAt: null },
        { label: "Claude 5h", usedPercent: 100, resetsAt: null },
      ],
      credits: null,
      // The account still serves the other family, so a full window must not park it.
      exhausted: false,
      resetsAt: null,
    });
    expect(parseQuotaSummary({ groups: [] })).toBeNull();
    expect(
      parseQuotaSummary({ groups: [{ displayName: "Gemini", buckets: [{ window: "5h" }] }] }),
    ).toBeNull();
  });

  it("reads one meter per family from the models listing", () => {
    const quota = parseModelQuotas({
      models: {
        "gemini-3.1-pro": {
          displayName: "Gemini 3.1 Pro",
          quotaInfo: { remainingFraction: 0.9, resetTime: "2026-10-08T12:00:00Z" },
        },
        "claude-sonnet-4-6": { quotaInfo: [{ remainingFraction: 0.2 }] },
        "tab-completion": { quotaInfo: { remainingFraction: 0.1 } },
      },
    });
    expect(quota?.windows.map((w) => [w.label, Math.round(w.usedPercent)])).toEqual([
      ["Gemini", 10],
      ["Claude", 80],
    ]);
  });

  const account = { meta: { project_id: "proj-1" }, baseUrl: "http://agy.test/" };

  it("posts the project to the quota summary of the provider's base URL", async () => {
    const f = scriptedFetch(json(summary));
    const quota = await fetchAntigravityQuota(call({ ...account, token: "at-9" }), f.fetch);
    expect(quota.windows).toHaveLength(3);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]!.url.toString()).toBe("http://agy.test/v1internal:retrieveUserQuotaSummary");
    expect(f.seen[0]!.body).toEqual({ project: "proj-1" });
    expect(f.seen[0]!.headers.get("authorization")).toBe("Bearer at-9");
  });

  it("retries a 403 with the plain user agent, but ends on 401 without the fallback", async () => {
    const retried = scriptedFetch(httpStatus(403), json(summary));
    await fetchAntigravityQuota(call(account), retried.fetch);
    expect(retried.seen.map((s) => s.headers.get("user-agent"))).toEqual([
      expect.stringContaining("antigravity/ide"),
      "antigravity/1.0",
    ]);

    const expired = scriptedFetch(httpStatus(401), json(summary));
    await expect(fetchAntigravityQuota(call(account), expired.fetch)).rejects.toMatchObject({
      code: "access_denied",
      status: 401,
    });
    expect(expired.seen).toHaveLength(1);
  });

  it("falls back to the models listing when the summary is unusable", async () => {
    const f = scriptedFetch(
      json({ groups: [] }),
      json({ models: { "gemini-3.1-pro": { quotaInfo: { remainingFraction: 0.6 } } } }),
    );
    const quota = await fetchAntigravityQuota(call(account), f.fetch);
    expect(quota.windows).toEqual([{ label: "Gemini", usedPercent: 40, resetsAt: null }]);
    expect(f.seen.map((s) => s.url.pathname)).toEqual([
      "/v1internal:retrieveUserQuotaSummary",
      "/v1internal:fetchAvailableModels",
    ]);
  });

  it("keeps the specific summary diagnosis when the fallback is merely unusable", async () => {
    const limited = scriptedFetch(httpStatus(429), json({ models: {} }));
    await expect(fetchAntigravityQuota(call(account), limited.fetch)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("needs the Cloud Code Assist project, and reports a dropped connection as transport_error", async () => {
    await expect(
      fetchAntigravityQuota(call({ meta: {} }), scriptedFetch(json(summary)).fetch),
    ).rejects.toMatchObject({ code: "account_unavailable" });
    const down = scriptedFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchAntigravityQuota(call(account), down.fetch)).rejects.toMatchObject({
      code: "transport_error",
    });
  });
});

const HOUR = 3_600_000;

/** Provider type `fake-quota`: paste login (`input` = account name), scriptable quota, 429 on demand. */
function fakeQuotaAdapter() {
  const state = {
    probes: [] as string[],
    refreshes: 0,
    /** Quota answer per access token; a function so a test can change it mid-way. */
    answer: (_token: string): Quota | QuotaError => okQuota(10),
    /** Access tokens the chat upstream answers 429 to. */
    limited: new Set<string>(),
  };
  const adapter: ProviderAdapter = {
    type: "fake-quota",
    label: "Fake quota",
    defaultBaseUrl: "http://unused.test",
    oauth: {
      label: "Sign in",
      start: () =>
        Promise.resolve({
          info: {
            flow: "paste",
            authUrl: "https://idp.test",
            instructions: "",
            expiresAt: 1_800_000_000_000 + HOUR,
          },
          state: {},
        }),
      complete: (_s, input): Promise<OAuthTokens> =>
        Promise.resolve({
          accessToken: `at-${input}`,
          refreshToken: `rt-${input}`,
          expiresAt: 1_800_000_000_000 + 10 * HOUR,
          account: `${input}@example.com`,
          extra: {},
        }),
      refresh: (tokens) => {
        state.refreshes++;
        if (!tokens.refreshToken) throw new OAuthRefreshError("none", true);
        return Promise.resolve({ ...tokens, accessToken: `${tokens.accessToken}+` });
      },
    },
    quota: ({ token }) => {
      state.probes.push(token);
      const result = state.answer(token);
      return result instanceof QuotaError ? Promise.reject(result) : Promise.resolve(result);
    },
    call: ({ token }) =>
      Promise.resolve(
        state.limited.has(token) ? new Response("slow down", { status: 429 }) : completion(),
      ),
  };
  return { state, adapters: { ...ADAPTERS, [adapter.type]: adapter } };
}

const okQuota = (used: number, extra: Partial<Quota> = {}): Quota => ({
  windows: [{ label: "Monthly", usedPercent: used, resetsAt: null }],
  credits: null,
  exhausted: false,
  resetsAt: null,
  ...extra,
});

async function setup() {
  const fake = fakeQuotaAdapter();
  const h = createHarness({}, { adapters: fake.adapters });
  await h.admin("POST", "/providers", { id: "sub", type: "fake-quota" });
  /** Signs an account in and returns its credential id. */
  const login = async (name: string) => {
    const started = await h.admin("POST", "/providers/sub/oauth/start", { label: name });
    const done = await h.admin("POST", `/oauth/sessions/${started.json.session_id}/complete`, {
      input: name,
    });
    return done.json.credential_id as string;
  };
  return { h, login, ...fake, quota: h.services.quota, pool: h.services.pool };
}

describe("QuotaService", () => {
  it("serves a fresh reading from cache, re-probes after the TTL, and `maxAgeMs: 0` forces a probe", async () => {
    const { h, login, state, quota } = await setup();
    const id = await login("alice");

    const first = await quota.get(id);
    expect(first).toMatchObject({ ok: true, credentialId: id });
    await quota.get(id);
    expect(state.probes).toHaveLength(1);

    await quota.get(id, { maxAgeMs: 0 });
    expect(state.probes).toHaveLength(2);

    h.clock.now += 11 * 60_000;
    await quota.get(id);
    expect(state.probes).toHaveLength(3);
  });

  it("shares one probe between concurrent callers", async () => {
    const { login, state, quota } = await setup();
    const id = await login("alice");
    await Promise.all([quota.get(id), quota.get(id), quota.get(id)]);
    expect(state.probes).toHaveLength(1);
  });

  it("remembers a failure only briefly and keeps the closed diagnosis", async () => {
    const { h, login, state, quota } = await setup();
    const id = await login("alice");
    state.answer = () => new QuotaError("rate_limited", 429);

    expect(await quota.get(id)).toMatchObject({ ok: false, failure: "rate_limited" });
    await quota.get(id);
    expect(state.probes).toHaveLength(1);

    h.clock.now += 61_000;
    state.answer = () => okQuota(5);
    expect(await quota.get(id)).toMatchObject({ ok: true });
  });

  it("refreshes the token once and retries when the upstream says 401", async () => {
    const { login, state, quota } = await setup();
    const id = await login("alice");
    state.answer = (token) =>
      token.endsWith("+") ? okQuota(1) : new QuotaError("access_denied", 401);

    expect(await quota.get(id)).toMatchObject({ ok: true });
    expect(state.probes).toEqual(["at-alice", "at-alice+"]);
    expect(state.refreshes).toBe(1);
  });

  it("does not loop on a credential that keeps answering 401", async () => {
    const { login, state, quota } = await setup();
    const id = await login("alice");
    state.answer = () => new QuotaError("access_denied", 401);
    expect(await quota.get(id)).toMatchObject({ ok: false, failure: "access_denied" });
    expect(state.probes).toHaveLength(2);
  });

  it("parks an exhausted account until its quota resets, and releases it when the quota is back", async () => {
    const { h, login, state, quota, pool } = await setup();
    await login("alice");
    const bob = await login("bob");
    const resetsAt = h.clock.now + 5 * HOUR;
    state.answer = (token) =>
      token === "at-alice" ? okQuota(100, { exhausted: true, resetsAt }) : okQuota(10);

    await quota.refreshAll();
    for (let i = 0; i < 6; i++) {
      const acquired = pool.acquire("sub", { model: "m" });
      if ("error" in acquired) throw new Error("bob should still be available");
      expect(acquired.lease.credential.id).toBe(bob);
      acquired.lease.release();
    }

    const creds = (await h.admin("GET", "/providers/sub/credentials")).json.data as {
      label: string;
      cooldown_until: number | null;
    }[];
    expect(creds.find((c) => c.label === "alice")?.cooldown_until).toBe(resetsAt);

    state.answer = () => okQuota(0);
    await quota.refreshAll();
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const acquired = pool.acquire("sub", { model: "m" });
      if ("error" in acquired) throw new Error("both should be available");
      seen.add(acquired.lease.credential.label);
      acquired.lease.release();
    }
    expect(seen).toEqual(new Set(["alice", "bob"]));
  });

  it("parks for a while when an exhausted account does not say when it resets", async () => {
    const { h, login, state, quota, pool } = await setup();
    await login("alice");
    state.answer = () => okQuota(100, { exhausted: true });
    await quota.refreshAll();

    const blocked = pool.acquire("sub", { model: "m" });
    expect(blocked).toEqual({ error: "no_credential", retryAt: h.clock.now + 10 * 60_000 });
  });

  it("has nothing to report for API keys, unknown ids or unsupported provider types", async () => {
    const { h, quota } = await setup();
    await h.admin("POST", "/providers", {
      id: "plain",
      type: "openai-compat",
      base_url: "http://x.test/v1",
    });
    const [keyId] = (await h.addProvider("keys", "http://x.test/v1", ["k1"])) as [string];
    expect(await quota.get(keyId)).toBeUndefined();
    expect(await quota.get("nope")).toBeUndefined();
    expect(await quota.forProvider("plain")).toEqual([]);
  });

  it("does not call the upstream for a retired account", async () => {
    const { h, login, state, quota } = await setup();
    const id = await login("alice");
    h.services.registry.markDead(id, "revoked");
    expect(await quota.get(id)).toMatchObject({ ok: false, failure: "account_unavailable" });
    expect(state.probes).toHaveLength(0);
  });
});

describe("quota admin API", () => {
  it("lists every OAuth account of a provider with windows, and `refresh=true` re-probes", async () => {
    const { h, login, state } = await setup();
    const alice = await login("alice");
    await login("bob");
    state.answer = (token) =>
      token === "at-bob"
        ? new QuotaError("access_denied", 403)
        : okQuota(42, { credits: { used: 21, limit: 50 }, resetsAt: 1_900_000_000_000 });

    const res = await h.admin("GET", "/providers/sub/quota");
    expect(res.status).toBe(200);
    expect(res.json.supported).toBe(true);
    expect(res.json.data).toHaveLength(2);
    expect(res.json.data[0]).toMatchObject({
      credential_id: alice,
      label: "alice",
      account: "alice@example.com",
      status: "ok",
      failure: null,
      checked_at: h.clock.now,
      quota: {
        windows: [{ label: "Monthly", used_percent: 42, resets_at: null }],
        credits: { used: 21, limit: 50 },
        exhausted: false,
        resets_at: 1_900_000_000_000,
      },
    });
    expect(res.json.data[1]).toMatchObject({
      label: "bob",
      status: "unavailable",
      failure: "access_denied",
      quota: null,
    });

    await h.admin("GET", "/providers/sub/quota");
    expect(state.probes.filter((t) => t === "at-alice")).toHaveLength(1);
    await h.admin("GET", "/providers/sub/quota?refresh=true");
    expect(state.probes.filter((t) => t === "at-alice")).toHaveLength(2);
  });

  it("answers one credential, and says so when a provider type has no quota", async () => {
    const { h, login } = await setup();
    const alice = await login("alice");
    const one = await h.admin("GET", `/credentials/${alice}/quota`);
    expect(one.json).toMatchObject({ credential_id: alice, status: "ok" });

    expect((await h.admin("GET", "/credentials/missing/quota")).status).toBe(404);
    const [keyId] = (await h.addProvider("keys", "http://x.test/v1", ["k1"])) as [string];
    expect((await h.admin("GET", `/credentials/${keyId}/quota`)).status).toBe(404);

    const plain = await h.admin("GET", "/providers/keys/quota");
    expect(plain.json).toEqual({ supported: false, data: [] });
    expect((await h.admin("GET", "/providers/nope/quota")).status).toBe(404);
  });

  it("advertises quota support per provider type", async () => {
    const h = createHarness();
    const types = (await h.admin("GET", "/provider-types")).json.data as {
      type: string;
      quota: boolean;
    }[];
    expect(Object.fromEntries(types.map((t) => [t.type, t.quota]))).toEqual({
      "openai-compat": false,
      anthropic: false,
      "anthropic-subscription": true,
      antigravity: true,
      kiro: true,
    });
  });
});

describe("quota and the request path", () => {
  it("parks an account that answers 429 once its quota proves to be spent, and fails over", async () => {
    const { h, login, state, quota, pool } = await setup();
    const alice = await login("alice");
    const bob = await login("bob");
    const key = await h.newKey();
    const resetsAt = h.clock.now + 24 * HOUR;
    state.limited.add("at-alice");
    state.answer = (token) =>
      token === "at-alice" ? okQuota(100, { exhausted: true, resetsAt }) : okQuota(10);

    // Whichever account is tried first, the request succeeds on bob.
    const res = await h.chat(key.secret, { model: "sub/m" });
    expect(res.status).toBe(200);
    await expect.poll(() => quota.get(alice).then((s) => s?.ok === true)).toBe(true);

    for (let i = 0; i < 6; i++) {
      const acquired = pool.acquire("sub", { model: "m" });
      if ("error" in acquired) throw new Error("bob should be available");
      expect(acquired.lease.credential.id).toBe(bob);
      acquired.lease.release();
    }
    expect(pool.snapshot(alice).cooldownUntil).toBe(resetsAt);
  });

  it("probes a rate-limited account at most once a minute", async () => {
    const { h, login, state } = await setup();
    await login("alice");
    const key = await h.newKey();
    state.limited.add("at-alice");

    for (let i = 0; i < 3; i++) {
      h.clock.now += 40_000; // beyond the 30 s cooldown, within the probe throttle
      await h.chat(key.secret, { model: "sub/m" });
    }
    await expect.poll(() => state.probes.length).toBeGreaterThan(0);
    expect(state.probes.length).toBeLessThanOrEqual(2);
  });
});
