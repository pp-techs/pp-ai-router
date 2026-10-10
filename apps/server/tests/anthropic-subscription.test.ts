import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ADAPTERS } from "../src/providers/adapter.ts";
import { createAnthropicSubscriptionAdapter } from "../src/providers/anthropic-subscription/adapter.ts";
import {
  CLIENT_ID,
  OAUTH_BETA,
  REDIRECT_URI,
  SYSTEM_INSTRUCTION,
  TOKEN_URL,
} from "../src/providers/anthropic-subscription/constants.ts";
import { parseUsage } from "../src/providers/anthropic-subscription/quota.ts";
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
  system?: unknown;
  tools?: { name: string }[];
  tool_choice?: unknown;
  messages: { content: { type: string; name?: string }[] }[];
}

interface Seen {
  path: string;
  headers: Headers;
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
    seen.push({
      path: c.req.path,
      headers: new Headers(c.req.raw.headers),
      body:
        c.req.method === "POST" ? ((await c.req.raw.clone().json()) as SentBody) : { messages: [] },
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

/** The OAuth token endpoint; every other URL goes to the network (the local fake above). */
function fakeTokenEndpoint(validTokens: Set<string>) {
  const calls: Record<string, string>[] = [];
  const failures: Response[] = [];
  let issued = 0;
  const fetchFake: typeof fetch = async (input, init) => {
    if ((input instanceof Request ? input.url : input.toString()) !== TOKEN_URL) {
      return fetch(input, init);
    }
    calls.push(JSON.parse(String(init?.body as string)) as Record<string, string>);
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
  return { calls, failures, fetch: fetchFake };
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
  it("authenticates as Claude Code and sends the identity as the first system block", async () => {
    const s = await setup();
    await s.login();
    const res = await chat(s, {
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).choices[0].message.content).toBe("hi");

    const [sent] = s.claude.messages();
    expect(sent!.headers.get("authorization")).toBe("Bearer at-1");
    expect(sent!.headers.get("x-api-key")).toBeNull();
    expect(sent!.headers.get("anthropic-beta")).toBe(OAUTH_BETA);
    expect(sent!.headers.get("x-app")).toBe("cli");
    expect(sent!.headers.get("x-claude-code-session-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent!.body.system).toEqual([
      { type: "text", text: SYSTEM_INSTRUCTION },
      { type: "text", text: "Be brief." },
    ]);
  });

  it("sends the identity alone when the client has no system prompt", async () => {
    const s = await setup();
    await s.login();
    await chat(s, {});
    expect(s.claude.messages()[0]!.body.system).toEqual([
      { type: "text", text: SYSTEM_INSTRUCTION },
    ]);
  });

  it("wraps every tool name on the way out and unwraps the answer, streamed or not", async () => {
    const s = await setup();
    await s.login();
    s.claude.replies.push(
      anthropicMessage(
        [{ type: "tool_use", id: "toolu_1", name: "custom_get_weather", input: { city: "Paris" } }],
        {
          stop_reason: "tool_use",
        },
      ),
    );
    const res = await chat(s, {
      tools: [WEATHER, { ...WEATHER, function: { ...WEATHER.function, name: "custom_x" } }],
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
    expect(sent.tools?.map((t) => t.name)).toEqual(["custom_get_weather", "custom_custom_x"]);
    expect(sent.tool_choice).toMatchObject({ type: "tool", name: "custom_get_weather" });
    const history = sent.messages.flatMap((m) => m.content);
    expect(history.find((b) => b.type === "tool_use")?.name).toBe("custom_get_weather");
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
            content_block: { type: "tool_use", id: "t1", name: "custom_custom_x", input: {} },
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
    expect(streamed).toContain('"name":"custom_x"');
    expect(streamed).not.toContain("custom_custom_x");
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

  it("is unusable without any window", () => {
    expect(parseUsage({ five_hour: null, seven_day: null })).toBeNull();
    expect(parseUsage("nope")).toBeNull();
  });
});
