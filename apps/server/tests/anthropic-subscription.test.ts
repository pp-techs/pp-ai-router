import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ADAPTERS } from "../src/providers/adapter.ts";
import { createAnthropicSubscriptionAdapter } from "../src/providers/anthropic-subscription/adapter.ts";
import {
  BOOTSTRAP_URL,
  CLIENT_ID,
  EFFORT_BETA,
  MESSAGES_BETAS,
  OAUTH_BETA,
  REDIRECT_URI,
  SCOPES,
  SYSTEM_INSTRUCTION,
  TOKEN_URL,
} from "../src/providers/anthropic-subscription/constants.ts";
import { createAnthropicSubscriptionOAuth } from "../src/providers/anthropic-subscription/oauth.ts";
import {
  modelScope,
  parseRateLimitHeaders,
  parseUsage,
} from "../src/providers/anthropic-subscription/quota.ts";
import { xxhash64 } from "../src/providers/anthropic-subscription/xxhash64.ts";
import {
  anthropicMessage,
  anthropicSse,
  createHarness,
  readJson,
  type Harness,
} from "./harness.ts";

const HOUR = 3_600_000;

/** The part of a Messages request body these tests look at. */
interface SentBody {
  system?: { type: string; text: string; cache_control?: unknown }[];
  tools?: { name: string }[];
  tool_choice?: unknown;
  metadata?: { user_id: string };
  messages: { content: { type: string; name?: string }[] }[];
}

interface Seen {
  path: string;
  search: string;
  headers: Headers;
  /** The body exactly as it went over the wire. */
  raw: string;
  body: SentBody;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A real HTTP server standing in for api.anthropic.com: Messages, models and usage, all Bearer-authenticated. */
async function startClaude() {
  const validTokens = new Set<string>();
  const seen: Seen[] = [];
  const replies: Response[] = [];
  const usage: Response[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    const raw = c.req.method === "POST" ? await c.req.raw.clone().text() : "";
    seen.push({
      path: c.req.path,
      search: new URL(c.req.url).search,
      headers: new Headers(c.req.raw.headers),
      raw,
      body: raw ? (JSON.parse(raw) as SentBody) : { messages: [] },
    });
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
    if (!validTokens.has(token)) return c.json({ type: "error", error: {} }, 401);
    return next();
  });
  app.post(
    "/v1/messages",
    () => replies.shift() ?? anthropicMessage([{ type: "text", text: "hi" }]),
  );
  app.get("/v1/models", (c) =>
    c.json({
      data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }],
      has_more: false,
    }),
  );
  app.get("/api/oauth/usage", () => usage.shift() ?? Response.json({}));
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    url: `http://127.0.0.1:${port}/v1`,
    validTokens,
    replies,
    usage,
    messages: () => seen.filter((s) => s.path === "/v1/messages"),
  };
}

/** The OAuth token endpoint and Claude's bootstrap; every other URL goes to the network (the local fake above). */
function fakeTokenEndpoint(validTokens: Set<string>) {
  const calls: Record<string, string>[] = [];
  const headers: Headers[] = [];
  const bootstraps: string[] = [];
  const failures: Response[] = [];
  let issued = 0;
  const fetchFake: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith(BOOTSTRAP_URL)) {
      bootstraps.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({
        oauth_account: {
          account_uuid: "acct-uuid",
          account_email: "Dev@Example.com",
          organization_uuid: "org-uuid",
          organization_name: "Dev Org",
        },
      });
    }
    if (url !== TOKEN_URL) return fetch(input, init);
    calls.push(JSON.parse(String(init?.body as string)) as Record<string, string>);
    headers.push(new Headers(init?.headers));
    const failure = failures.shift();
    if (failure) return failure;
    issued++;
    validTokens.add(`at-${issued}`);
    return Response.json({
      access_token: `at-${issued}`,
      refresh_token: `rt-${issued}`,
      expires_in: 3600,
      account: { uuid: "acct-uuid", email_address: "Dev@Example.com" },
    });
  };
  return { calls, headers, bootstraps, failures, fetch: fetchFake };
}

/** A router with one `anthropic-subscription` provider ("sub") pointed at the fake, signed in. */
async function setup() {
  const claude = await startClaude();
  const token = fakeTokenEndpoint(claude.validTokens);
  let h: Harness | undefined;
  const adapter = createAnthropicSubscriptionAdapter({
    fetch: token.fetch,
    now: () => h!.clock.now,
  });
  h = createHarness({}, { adapters: { ...ADAPTERS, [adapter.type]: adapter } });
  const created = await h.admin("POST", "/providers", {
    id: "sub",
    type: "anthropic-subscription",
    base_url: claude.url,
  });
  expect(created.status).toBe(201);
  const key = await h.newKey();

  const started = await h.admin("POST", "/providers/sub/oauth/start", {});
  expect(started.status).toBe(201);
  const authUrl = new URL(started.json.auth_url);
  const state = authUrl.searchParams.get("state")!;
  const sid = started.json.session_id as string;
  const login = () =>
    h.admin("POST", `/oauth/sessions/${sid}/complete`, {
      input: `${REDIRECT_URI}?code=c1&state=${state}`,
    });
  return { h, claude, token, key, authUrl, state, sid, login };
}

interface Session {
  h: Harness;
  key: { secret: string };
}

const chat = ({ h, key }: Session, body: Record<string, unknown>) =>
  h.chat(key.secret, {
    model: "sub/claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    ...body,
  });

const WEATHER = {
  type: "function",
  function: { name: "get_weather", parameters: { type: "object", properties: {} } },
};

describe("sign-in", () => {
  it("is offered for the provider type, with the Claude authorize URL", async () => {
    const { h, authUrl } = await setup();
    const types = (await h.admin("GET", "/provider-types")).json.data;
    expect(types.find((t: { type: string }) => t.type === "anthropic-subscription")).toMatchObject({
      default_base_url: "https://api.anthropic.com/v1",
      oauth: { label: "Sign in with Claude (Pro/Max)" },
      models: "fetch",
      quota: true,
    });
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe("https://claude.ai/oauth/authorize");
    expect(Object.fromEntries(authUrl.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge_method: "S256",
    });
  });

  it("exchanges the pasted code with the PKCE verifier and stores the account", async () => {
    const { h, token, sid, login } = await setup();
    const wrong = await h.admin("POST", `/oauth/sessions/${sid}/complete`, {
      input: `${REDIRECT_URI}?code=c1&state=nope`,
    });
    expect(wrong.status).toBe(400);
    expect(token.calls).toHaveLength(0);

    expect((await login()).json.status).toBe("complete");
    expect(token.calls[0]).toMatchObject({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: "c1",
      redirect_uri: REDIRECT_URI,
    });
    expect(token.calls[0]!.code_verifier).toMatch(/^[\w-]{43,}$/);
    const [cred] = (await h.admin("GET", "/providers/sub/credentials")).json.data;
    expect(cred).toMatchObject({
      status: "active",
      label: "dev@example.com",
      expires_at: h.clock.now + HOUR,
    });
  });

  it("accepts the `code#state` string Claude shows on its own code page", async () => {
    const { h, sid, state } = await setup();
    const done = await h.admin("POST", `/oauth/sessions/${sid}/complete`, { input: `c1#${state}` });
    expect(done.json.status).toBe("complete");
  });
});

describe("requests", () => {
  it("presents a Claude Code request: billing block, identity, betas, metadata and session", async () => {
    const s = await setup();
    await s.login();
    const res = await chat(s, {
      user: "client-chosen-id",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).choices[0].message.content).toBe("hi");

    const [sent] = s.claude.messages();
    expect(sent!.search).toBe("?beta=true");
    expect(sent!.headers.get("authorization")).toBe("Bearer at-1");
    expect(sent!.headers.get("x-api-key")).toBeNull();
    expect(sent!.headers.get("anthropic-beta")).toBe(MESSAGES_BETAS.join(","));
    expect(sent!.headers.get("x-app")).toBe("cli");
    expect(sent!.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(sent!.headers.get("accept")).toBe("application/json");
    expect(sent!.headers.get("user-agent")).toMatch(
      /^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/,
    );

    const [billing, identity, brief] = sent!.body.system!;
    expect(billing!.text).toMatch(
      /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    );
    expect(billing).not.toHaveProperty("cache_control");
    expect(identity).toEqual({
      type: "text",
      text: SYSTEM_INSTRUCTION,
      cache_control: { type: "ephemeral" },
    });
    expect(brief).toEqual({ type: "text", text: "Be brief." });

    // The client's own `user` is not a Claude Code user id: the account, device and session are.
    const session = sent!.headers.get("x-claude-code-session-id")!;
    expect(session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.parse(sent!.body.metadata!.user_id)).toEqual({
      device_id: expect.stringMatching(/^[0-9a-f]{64}$/),
      session_id: session,
      account_uuid: "acct-uuid",
    });
  });

  it("signs the body it sends: `cch` is the XXH64 of the bytes with the placeholder in place", async () => {
    const s = await setup();
    await s.login();
    // Non-ASCII text before the billing block would shift a character offset away from the byte offset.
    await chat(s, { messages: [{ role: "user", content: "héllo — 日本語 ✓" }] });
    const { raw } = s.claude.messages()[0]!;
    const cch = /cch=([0-9a-f]{5});/.exec(raw)![1]!;
    const unsigned = new TextEncoder().encode(raw.replace(`cch=${cch};`, "cch=00000;"));
    const expected = xxhash64(unsigned, 0x4d659218e32a3268n) & 0xfffffn;
    expect(cch).toBe(expected.toString(16).padStart(5, "0"));
    expect(raw.match(/cch=/g)).toHaveLength(1);
  });

  it("keeps one session for a conversation and tells conversations apart", async () => {
    const s = await setup();
    await s.login();
    const ask = (messages: Record<string, unknown>[]) => chat(s, { messages });
    await ask([{ role: "user", content: "first question" }]);
    await ask([
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "follow up" },
    ]);
    await ask([{ role: "user", content: "another conversation" }]);
    const [a, b, c] = s.claude.messages().map((m) => m.headers.get("x-claude-code-session-id"));
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it("adds the effort beta only when thinking is requested", async () => {
    const s = await setup();
    await s.login();
    await chat(s, {});
    await chat(s, { reasoning_effort: "high" });
    const [plain, thinking] = s.claude.messages().map((m) => m.headers.get("anthropic-beta")!);
    expect(plain).not.toContain(EFFORT_BETA);
    expect(thinking).toBe([...MESSAGES_BETAS, EFFORT_BETA].join(","));
  });

  it("leaves out its own cache breakpoint when the client already uses all four", async () => {
    const s = await setup();
    await s.login();
    const part = (text: string) => ({ type: "text", text, cache_control: { type: "ephemeral" } });
    await chat(s, {
      messages: [{ role: "user", content: ["a", "b", "c", "d"].map(part) }],
    });
    expect(s.claude.messages()[0]!.body.system![1]).toEqual({
      type: "text",
      text: SYSTEM_INSTRUCTION,
    });
  });

  it("wraps every tool name on the way out and unwraps the answer, streamed or not", async () => {
    const s = await setup();
    await s.login();
    s.claude.replies.push(
      anthropicMessage(
        [{ type: "tool_use", id: "toolu_1", name: "_get_weather", input: { city: "Paris" } }],
        {
          stop_reason: "tool_use",
        },
      ),
    );
    const res = await chat(s, {
      tools: [WEATHER, { ...WEATHER, function: { ...WEATHER.function, name: "_x" } }],
      tool_choice: { type: "function", function: { name: "get_weather" } },
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_0",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Rome"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_0", content: "25C" },
      ],
    });
    const sent = s.claude.messages()[0]!.body;
    expect(sent.tools?.map((t) => t.name)).toEqual(["_get_weather", "__x"]);
    expect(sent.tool_choice).toMatchObject({ type: "tool", name: "_get_weather" });
    const history = sent.messages.flatMap((m) => m.content);
    expect(history.find((b) => b.type === "tool_use")?.name).toBe("_get_weather");
    expect((await readJson(res)).choices[0].message.tool_calls[0].function.name).toBe(
      "get_weather",
    );

    // Streaming: the name arrives in the first delta and is restored there.
    s.claude.replies.push(
      anthropicSse([
        [
          "message_start",
          {
            message: {
              id: "m",
              model: "claude-test",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
        ],
        [
          "content_block_start",
          {
            index: 0,
            content_block: { type: "tool_use", id: "t1", name: "__x", input: {} },
          },
        ],
        [
          "content_block_delta",
          { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        ],
        ["content_block_stop", { index: 0 }],
        ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }],
        ["message_stop", {}],
      ]),
    );
    const streamed = await (await chat(s, { stream: true, tools: [WEATHER] })).text();
    expect(streamed).toContain('"name":"_x"');
    expect(streamed).not.toContain("__x");
  });

  it("leaves Anthropic's own tool names alone", async () => {
    const s = await setup();
    await s.login();
    const search = {
      type: "function",
      function: { name: "web_search", parameters: { type: "object" } },
    };
    await chat(s, { tools: [search] });
    expect(s.claude.messages()[0]!.body.tools?.[0]?.name).toBe("web_search");
  });

  it("moves the presented Claude Code version up once when Anthropic names a newer minimum", async () => {
    const s = await setup();
    await s.login();
    s.claude.replies.push(
      Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "claude_code_version_too_old: Claude Code version 2.99.0 or newer is required",
          },
        },
        { status: 400 },
      ),
    );
    const res = await chat(s, {});
    expect(res.status).toBe(200);
    const [rejected, resent] = s.claude.messages();
    expect(rejected!.headers.get("user-agent")).not.toBe("claude-cli/2.99.0 (external, cli)");
    expect(resent!.headers.get("user-agent")).toBe("claude-cli/2.99.0 (external, cli)");
    expect(resent!.body.system![0]!.text).toContain("cc_version=2.99.0.");

    // The same rejection again is the answer: no loop.
    s.claude.replies.push(
      Response.json(
        {
          type: "error",
          error: { message: "claude_code_version_too_old: version 2.99.0 or newer is required" },
        },
        { status: 400 },
      ),
    );
    expect((await chat(s, {})).status).toBe(400);
    expect(s.claude.messages()).toHaveLength(3);
  });
});

describe("token lifecycle", () => {
  it("refreshes shortly before expiry with the rotated refresh token, and after an upstream 401", async () => {
    const s = await setup();
    await s.login();
    expect((await chat(s, {})).status).toBe(200);

    s.h.clock.now += HOUR - 30_000;
    expect((await chat(s, {})).status).toBe(200);
    expect(s.token.calls.at(-1)).toMatchObject({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: "rt-1",
    });
    expect(s.claude.messages().at(-1)!.headers.get("authorization")).toBe("Bearer at-2");

    // Revoked early: one refresh and a retry, the account stays usable.
    s.claude.validTokens.delete("at-2");
    expect((await chat(s, {})).status).toBe(200);
    expect(
      s.claude
        .messages()
        .slice(-2)
        .map((m) => m.headers.get("authorization")),
    ).toEqual(["Bearer at-2", "Bearer at-3"]);
    expect((await s.h.admin("GET", "/providers/sub/credentials")).json.data[0].status).toBe(
      "active",
    );
  });

  it("retires the account when the refresh token is refused for good, but not on an outage", async () => {
    const s = await setup();
    await s.login();

    s.token.failures.push(Response.json({ error: "server_error" }, { status: 503 }));
    s.h.clock.now += HOUR;
    expect((await chat(s, {})).status).toBeGreaterThanOrEqual(500);
    expect((await s.h.admin("GET", "/providers/sub/credentials")).json.data[0].status).toBe(
      "active",
    );

    s.h.clock.now += HOUR; // past the cooldown the outage put the account in
    s.token.failures.push(Response.json({ error: { type: "invalid_grant" } }, { status: 400 }));
    expect((await chat(s, {})).status).toBeGreaterThanOrEqual(500);
    expect((await s.h.admin("GET", "/providers/sub/credentials")).json.data[0].status).toBe("dead");
  });

  it("treats the reference's revocation codes as final too", async () => {
    const s = await setup();
    await s.login();
    s.token.failures.push(Response.json({ error: "refresh_token_revoked" }, { status: 401 }));
    s.h.clock.now += HOUR;
    expect((await chat(s, {})).status).toBeGreaterThanOrEqual(500);
    expect((await s.h.admin("GET", "/providers/sub/credentials")).json.data[0].status).toBe("dead");
  });
});

describe("models and quota", () => {
  it("lists the account's models with its Bearer token", async () => {
    const s = await setup();
    await s.login();
    const models = await s.h.admin("POST", "/providers/sub/models/refresh", {});
    expect(models.status).toBe(200);
    expect(JSON.stringify(models.json)).toContain("claude-sonnet-4-5");
  });

  it("reads the usage windows and parks an account whose 5-hour window is spent until it resets", async () => {
    const s = await setup();
    await s.login();
    const resetsAt = new Date(s.h.clock.now + 2 * HOUR).toISOString();
    s.claude.usage.push(
      Response.json({
        five_hour: { utilization: 100, resets_at: resetsAt },
        seven_day: { utilization: 40, resets_at: null },
      }),
    );
    const [cred] = (await s.h.admin("GET", "/providers/sub/credentials")).json.data;
    const quota = await s.h.admin("GET", `/credentials/${cred.id}/quota`);
    expect(quota.json.quota).toMatchObject({
      exhausted: true,
      resets_at: s.h.clock.now + 2 * HOUR,
      windows: [
        { label: "5h", used_percent: 100 },
        { label: "Weekly", used_percent: 40 },
      ],
    });
    // The only account is parked, so the gateway has nothing to send to.
    expect((await chat(s, {})).status).toBeGreaterThanOrEqual(429);
    expect(s.claude.messages()).toHaveLength(0);
  });
});

describe("parseUsage", () => {
  it("never exhausts the account for a spent single-model window", () => {
    const quota = parseUsage({
      five_hour: { utilization: 10, resets_at: null },
      seven_day: { utilization: 20, resets_at: null },
      seven_day_opus: { utilization: 100, resets_at: "2026-10-12T00:00:00Z" },
    });
    expect(quota).toMatchObject({ exhausted: false, resetsAt: null });
    expect(quota!.windows.map((w) => w.label)).toEqual(["5h", "Weekly", "Opus weekly"]);
  });

  it("waits for the last spent shared window, and for an unknown reset", () => {
    expect(
      parseUsage({
        five_hour: { utilization: 100, resets_at: "2026-10-10T05:00:00Z" },
        seven_day: { utilization: 100, resets_at: "2026-10-14T00:00:00Z" },
      }),
    ).toMatchObject({ exhausted: true, resetsAt: Date.parse("2026-10-14T00:00:00Z") });
    expect(parseUsage({ five_hour: { utilization: 100, resets_at: null } })).toMatchObject({
      exhausted: true,
      resetsAt: null,
    });
  });

  it("reads model-scoped limits, publishing only recognised family labels", () => {
    const quota = parseUsage({
      five_hour: { utilization: 1, resets_at: null },
      limits: [
        { kind: "session", percent: 1 },
        {
          kind: "weekly_scoped",
          percent: 55,
          scope: { model: { display_name: "Claude Sonnet 5" } },
        },
        {
          kind: "weekly_scoped",
          percent: 90,
          scope: { model: { display_name: "Evil \u001b[31mname" } },
        },
      ],
    });
    expect(quota!.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["5h", 1],
      ["Sonnet weekly", 55],
    ]);
  });

  it("reads a scoped limit whatever the case or padding of its kind", () => {
    const quota = parseUsage({
      five_hour: { utilization: 1, resets_at: null },
      limits: [
        {
          kind: " Weekly_Scoped ",
          percent: 30,
          scope: { model: { display_name: "Claude Opus 5" } },
        },
      ],
    });
    expect(quota!.windows.map((w) => w.label)).toEqual(["5h", "Opus weekly"]);
  });

  it("is unusable without any window", () => {
    expect(parseUsage({ five_hour: null, seven_day: null })).toBeNull();
    expect(parseUsage("nope")).toBeNull();
  });
});

describe("account identity", () => {
  /** The sign-in alone, with a scripted token endpoint and bootstrap. */
  function signIn(answers: { token?: Record<string, unknown>; bootstrap?: Response }) {
    const bootstraps: string[] = [];
    const tokenHeaders: Headers[] = [];
    const oauth = createAnthropicSubscriptionOAuth({
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith(BOOTSTRAP_URL)) {
          bootstraps.push(new Headers(init?.headers).get("authorization") ?? "");
          return answers.bootstrap ?? Response.json({});
        }
        tokenHeaders.push(new Headers(init?.headers));
        return Response.json({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 60,
          ...answers.token,
        });
      },
    });
    const login = async () => {
      const { state } = await oauth.start();
      return oauth.complete!(state, `code#${state.state}`);
    };
    return { oauth, login, bootstraps, tokenHeaders };
  }

  it("keeps the account and organization the token response names, without asking the bootstrap", async () => {
    const s = signIn({
      token: {
        account: { uuid: "u1", email_address: "A@B.C" },
        organization: { uuid: "o1", name: "Team" },
      },
    });
    const tokens = await s.login();
    expect(tokens).toMatchObject({
      account: "a@b.c",
      extra: { account_uuid: "u1", organization_uuid: "o1", organization_name: "Team" },
    });
    expect(s.bootstraps).toEqual([]);
  });

  it("asks Claude Code's bootstrap for what the token response left out, and survives its failure", async () => {
    const found = signIn({
      bootstrap: Response.json({
        oauth_account: {
          account_uuid: "u2",
          account_email: "X@Y.Z",
          organization_uuid: "o2",
          organization_name: "Max",
        },
      }),
    });
    expect(await found.login()).toMatchObject({
      account: "x@y.z",
      extra: { account_uuid: "u2", organization_uuid: "o2", organization_name: "Max" },
    });
    expect(found.bootstraps).toEqual(["Bearer at"]);

    const down = signIn({ bootstrap: new Response("nope", { status: 503 }) });
    expect(await down.login()).toMatchObject({ accessToken: "at", account: undefined, extra: {} });
  });

  it("refreshes with the SDK's OAuth headers (not on the code exchange) and never rewrites the organization", async () => {
    const s = signIn({ token: { account: { uuid: "u1", email_address: "a@b.c" } } });
    const tokens = await s.login();
    const first = s.tokenHeaders[0]!;
    expect(first.get("anthropic-beta")).toBeNull();
    expect(first.get("user-agent")).toBeNull();

    const pinned = {
      ...tokens,
      extra: { ...tokens.extra, organization_uuid: "o-login", organization_name: "Login Org" },
    };
    const refreshed = await createAnthropicSubscriptionOAuth({
      fetch: async (_input, init) => {
        s.tokenHeaders.push(new Headers(init?.headers));
        return Response.json({
          access_token: "at2",
          refresh_token: "rt2",
          expires_in: 60,
          account: { uuid: "u1", email_address: "a@b.c" },
          organization: { uuid: "o-other", name: "Other" },
        });
      },
    }).refresh(pinned);
    const sent = s.tokenHeaders[1]!;
    expect(sent.get("anthropic-beta")).toBe(OAUTH_BETA);
    expect(sent.get("user-agent")).toMatch(/^anthropic-sdk-typescript\/\S+ userOAuthProvider$/);
    expect(refreshed.extra).toMatchObject({
      organization_uuid: "o-login",
      organization_name: "Login Org",
    });
    // Only the sign-in asked the bootstrap; a refresh that has the identity makes no such call.
    expect(s.bootstraps).toEqual(["Bearer at"]);
    expect(s.tokenHeaders).toHaveLength(2);
  });
});

describe("xxhash64", () => {
  it("matches the reference vectors, on every code path (empty, bytes, 4, 8, 32-byte stripes)", () => {
    const hash = (text: string, seed = 0n) =>
      xxhash64(new TextEncoder().encode(text), seed).toString(16);
    expect(hash("")).toBe("ef46db3751d8e999");
    expect(hash("a")).toBe("d24ec4f1a98c6e5b");
    expect(hash("abc")).toBe("44bc2cf5ad770999");
    expect(hash("Nobody inspects the spammish repetition")).toBe("fbcea83c8a378bf1");
  });
});
describe("model scopes and rate-limit headers", () => {
  const unified = (fields: Record<string, string>) =>
    new Headers(
      Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [`anthropic-ratelimit-unified-${k}`, v]),
      ),
    );

  it("gives Opus, Sonnet, Fable and Mythos a scope of their own, and Fable and Mythos a local one", () => {
    expect(modelScope("claude-opus-4-8")).toEqual({ name: "opus", local: false });
    expect(modelScope("claude-sonnet-5-5")).toEqual({ name: "sonnet", local: false });
    expect(modelScope("claude-fable-1")).toEqual({ name: "fable", local: true });
    expect(modelScope("claude-mythos-1")).toEqual({ name: "mythos", local: true });
    expect(modelScope("claude-haiku-4-5")).toBeUndefined();
  });

  it("reads utilization (a fraction) and reset (epoch seconds) of each unified window", () => {
    const quota = parseRateLimitHeaders(
      unified({
        "5h-utilization": "0.25",
        "5h-reset": "1800000000",
        "7d-utilization": "1",
        "7d-reset": "1800100000",
        "7d_oi-utilization": "0.5",
      }),
    );
    expect(quota).toEqual({
      windows: [
        { label: "5h", usedPercent: 25, resetsAt: 1_800_000_000_000 },
        { label: "Weekly", usedPercent: 100, resetsAt: 1_800_100_000_000 },
        { label: "Fable weekly", usedPercent: 50, resetsAt: null, scope: "fable" },
      ],
      credits: null,
      exhausted: true,
      resetsAt: 1_800_100_000_000,
    });
    expect(parseRateLimitHeaders(unified({ "5h-reset": "1800000000" }))).toBeNull();
    expect(parseRateLimitHeaders(new Headers())).toBeNull();
  });

  it("parks the account from the headers of a successful answer, before any usage probe", async () => {
    const s = await setup();
    await s.login();
    const resetsAt = Math.floor(s.h.clock.now / 1000) + 3600;
    const answer = anthropicMessage([{ type: "text", text: "hi" }]);
    answer.headers.set("anthropic-ratelimit-unified-5h-utilization", "1");
    answer.headers.set("anthropic-ratelimit-unified-5h-reset", String(resetsAt));
    s.claude.replies.push(answer);

    expect((await chat(s, {})).status).toBe(200);
    expect((await chat(s, {})).status).toBe(503);
    expect(s.claude.messages()).toHaveLength(1);
    const [cred] = (await s.h.admin("GET", "/providers/sub/credentials")).json.data;
    expect(cred.cooldown_until).toBe(resetsAt * 1000);
  });

  it("cools a Fable 429 for Fable only, but takes an Opus 429 to be shared", async () => {
    const s = await setup();
    await s.login();
    const limited = () =>
      Response.json({ type: "error", error: { type: "rate_limit_error" } }, { status: 429 });
    const fable = { model: "sub/claude-fable-1" };
    const opus = { model: "sub/claude-opus-4-8" };

    s.claude.replies.push(limited());
    expect((await chat(s, fable)).status).toBe(502);
    expect((await chat(s, {})).status).toBe(200); // Sonnet still served
    expect((await chat(s, opus)).status).toBe(200);
    expect((await chat(s, fable)).status).toBe(503); // not sent: the scope is cooling down
    expect(s.claude.messages()).toHaveLength(3);

    s.claude.replies.push(limited());
    expect((await chat(s, opus)).status).toBe(502);
    expect((await chat(s, {})).status).toBe(503); // the whole account is cooling down
  });

  it("parks a family whose weekly window is spent, but not the account", async () => {
    const s = await setup();
    await s.login();
    const resetsAt = new Date(s.h.clock.now + 2 * HOUR).toISOString();
    s.claude.usage.push(
      Response.json({
        five_hour: { utilization: 10, resets_at: null },
        seven_day: { utilization: 20, resets_at: null },
        seven_day_opus: { utilization: 100, resets_at: resetsAt },
      }),
    );
    const [cred] = (await s.h.admin("GET", "/providers/sub/credentials")).json.data;
    await s.h.admin("GET", `/credentials/${cred.id}/quota`);

    expect((await chat(s, { model: "sub/claude-opus-4-8" })).status).toBe(503);
    expect(s.claude.messages()).toHaveLength(0);
    expect((await chat(s, {})).status).toBe(200);
  });
});
