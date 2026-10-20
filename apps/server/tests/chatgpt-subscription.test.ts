import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { OAuthRefreshError, type OAuthTokens } from "../src/oauth/types.ts";
import { ADAPTERS, type ProviderAdapter } from "../src/providers/adapter.ts";
import { parseSse, type ChatCompletion, type OpenAIChunk } from "../src/providers/chunks.ts";
import { createChatgptSubscriptionAdapter } from "../src/providers/chatgpt-subscription/adapter.ts";
import {
  accountApiBase,
  AUTHORIZE_URL,
  CLIENT_ID,
  DEFAULT_BASE_URL,
  ORIGINATOR,
  REDIRECT_URI,
  resolveResponsesUrl,
  SCOPES,
  TOKEN_URL,
  USER_AGENT,
} from "../src/providers/chatgpt-subscription/constants.ts";
import { CODEX_MODELS } from "../src/providers/chatgpt-subscription/models.ts";
import { createChatgptSubscriptionOAuth } from "../src/providers/chatgpt-subscription/oauth.ts";
import {
  fetchCodexQuota,
  modelScope,
  parseRateLimitHeaders,
  parseUsage,
} from "../src/providers/chatgpt-subscription/quota.ts";
import { toCodexRequest } from "../src/providers/chatgpt-subscription/request.ts";
import { codexChunks } from "../src/providers/chatgpt-subscription/stream.ts";
import type { Quota, QuotaError } from "../src/quota/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHAT = { model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An unsigned JWT carrying `claims`, which is all the router ever reads from one. */
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

const ACCOUNT = "acct-1234";
const accessToken = (accountId = ACCOUNT) =>
  jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
const idToken = (email = "Dev@Example.com", plan = "Plus") =>
  jwt({
    "https://api.openai.com/profile": { email },
    "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: plan },
  });

interface Seen {
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON or the form fields of the body. */
  body: Record<string, any>;
  raw: string;
}

function fakeFetch(handler: (seen: Seen, n: number) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const seen: Seen = {
      url: url.toString(),
      headers,
      raw,
      body: !raw
        ? {}
        : headers["content-type"]?.includes("x-www-form-urlencoded")
          ? Object.fromEntries(new URLSearchParams(raw))
          : JSON.parse(raw),
    };
    calls.push(seen);
    return handler(seen, calls.length);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

describe("sign-in", () => {
  const oauth = createChatgptSubscriptionOAuth({ now: () => NOW });

  it("starts a PKCE paste login against the Codex client", async () => {
    const { info, state } = await oauth.start();
    if (info.flow !== "paste") throw new Error("expected a paste flow");
    const url = new URL(info.authUrl);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: "http://localhost:1455/auth/callback",
      scope: SCOPES,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: ORIGINATOR,
      state: state.state,
    });
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(state.verifier).digest("base64url"),
    );
    expect(info.expiresAt).toBe(NOW + 10 * 60_000);
  });

  const tokenResponse = (extra: Record<string, unknown> = {}) =>
    Response.json({
      access_token: accessToken(),
      refresh_token: "rt-1",
      id_token: idToken(),
      expires_in: 3600,
      ...extra,
    });

  it("exchanges the pasted redirect with the verifier and reads the account from the token claims", async () => {
    const up = fakeFetch(() => tokenResponse());
    const provider = createChatgptSubscriptionOAuth({ fetch: up.fetch, now: () => NOW });
    const { state } = await provider.start();

    await expect(provider.complete!(state, `${REDIRECT_URI}?code=c1&state=nope`)).rejects.toThrow(
      "state mismatch",
    );
    await expect(provider.complete!(state, `${REDIRECT_URI}?error=access_denied`)).rejects.toThrow(
      "access_denied",
    );
    expect(up.calls).toHaveLength(0);

    const tokens = await provider.complete!(state, `${REDIRECT_URI}?code=c1&state=${state.state}`);
    expect(up.calls[0]!.url).toBe(TOKEN_URL);
    expect(up.calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(up.calls[0]!.body).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: "c1",
      code_verifier: state.verifier,
      redirect_uri: REDIRECT_URI,
    });
    expect(tokens).toEqual({
      accessToken: accessToken(),
      refreshToken: "rt-1",
      expiresAt: NOW + HOUR,
      account: "dev@example.com",
      extra: { account_id: ACCOUNT, plan: "plus" },
    });

    // A bare code is accepted without a state.
    await expect(provider.complete!(state, "c2")).resolves.toMatchObject({
      account: "dev@example.com",
    });
    expect(up.calls[1]!.body.code).toBe("c2");
  });

  it("falls back to the account id when the tokens carry no email, and refuses an anonymous token", async () => {
    const fallback = createChatgptSubscriptionOAuth({
      fetch: fakeFetch(() => tokenResponse({ id_token: undefined })).fetch,
      now: () => NOW,
    });
    const { state } = await fallback.start();
    expect(await fallback.complete!(state, "c")).toMatchObject({
      account: ACCOUNT,
      extra: { account_id: ACCOUNT },
    });

    const anonymous = createChatgptSubscriptionOAuth({
      fetch: fakeFetch(() => tokenResponse({ access_token: "opaque", id_token: undefined })).fetch,
    });
    await expect(anonymous.complete!((await anonymous.start()).state, "c")).rejects.toThrow(
      "account identity",
    );
    const noRefresh = createChatgptSubscriptionOAuth({
      fetch: fakeFetch(() => tokenResponse({ refresh_token: undefined })).fetch,
    });
    await expect(noRefresh.complete!((await noRefresh.start()).state, "c")).rejects.toThrow(
      "refresh token",
    );
  });

  const stored: OAuthTokens = {
    accessToken: "old",
    refreshToken: "rt-old",
    expiresAt: NOW - 1,
    account: "dev@example.com",
    extra: { account_id: ACCOUNT, plan: "plus" },
  };

  it("refreshes with the stored refresh token and keeps what the response leaves out", async () => {
    const up = fakeFetch(() => Response.json({ access_token: "new-access", expires_in: 7200 }));
    const provider = createChatgptSubscriptionOAuth({ fetch: up.fetch, now: () => NOW });
    const refreshed = await provider.refresh(stored);
    expect(up.calls[0]!.body).toEqual({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: "rt-old",
    });
    expect(refreshed).toEqual({
      accessToken: "new-access",
      refreshToken: "rt-old",
      expiresAt: NOW + 2 * HOUR,
      account: "dev@example.com",
      extra: { account_id: ACCOUNT, plan: "plus" },
    });

    const rotated = createChatgptSubscriptionOAuth({
      fetch: fakeFetch(() =>
        tokenResponse({ refresh_token: "rt-new", id_token: idToken("new@example.com", "Pro") }),
      ).fetch,
      now: () => NOW,
    });
    // The plan is the one given at login; the email and workspace follow the new claims.
    expect(await rotated.refresh(stored)).toMatchObject({
      refreshToken: "rt-new",
      account: "new@example.com",
      extra: { account_id: ACCOUNT, plan: "plus" },
    });
  });

  it("calls a refresh refusal terminal on omp's grant-failure patterns", async () => {
    const outcome = async (status: number, body: unknown) => {
      const provider = createChatgptSubscriptionOAuth({
        fetch: fakeFetch(() =>
          typeof body === "string"
            ? new Response(body, { status })
            : Response.json(body, { status }),
        ).fetch,
      });
      const error = await provider.refresh(stored).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OAuthRefreshError);
      return (error as OAuthRefreshError).terminal;
    };
    expect(await outcome(400, { error: "invalid_grant" })).toBe(true);
    expect(await outcome(401, { error: { code: "refresh_token_expired", message: "x" } })).toBe(
      true,
    );
    expect(await outcome(401, { error: { code: "refresh_token_reused" } })).toBe(true);
    expect(await outcome(400, { error_description: "token was revoked" })).toBe(true);
    expect(await outcome(500, { error: "invalid_grant" })).toBe(true);
    // Passing trouble and unknown codes never kill an account.
    expect(await outcome(403, { error: "token_invalidated" })).toBe(false);
    expect(await outcome(429, { error: "rate_limit_exceeded" })).toBe(false);
    expect(await outcome(401, { error: "rate_limit_exceeded" })).toBe(false);
    expect(await outcome(503, "upstream connect error")).toBe(false);
    expect(await outcome(400, { error: "invalid_request" })).toBe(false);

    const noToken = createChatgptSubscriptionOAuth();
    await expect(noToken.refresh({ ...stored, refreshToken: null })).rejects.toMatchObject({
      terminal: true,
    });

    const malformed = createChatgptSubscriptionOAuth({
      fetch: fakeFetch(() => Response.json({ expires_in: 5 })).fetch,
    });
    await expect(malformed.refresh(stored)).rejects.toMatchObject({ terminal: false });
  });
});

type Json = Record<string, any>;

const WEATHER = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Weather of a city",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
};

describe("request translation", () => {
  const translate = (body: Json) => toCodexRequest({ model: "gpt-5.6-sol", ...body }) as Json;

  it("sends a stored-nothing, always-streamed Responses request with the first system prompt as instructions", () => {
    const out = translate({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "developer", content: [{ type: "text", text: "Use metric units." }] },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: [{ type: "text", text: "weather?" }] },
        { role: "system", content: "Reminder: answer in French." },
      ],
      max_tokens: 100,
      max_completion_tokens: 100,
      temperature: 0.2,
      top_p: 0.5,
      stop: ["x"],
      service_tier: "priority",
      stream: false,
    });
    // Like omp: the other system prompts are developer messages in front of the conversation.
    expect(out).toEqual({
      model: "gpt-5.6-sol",
      instructions: "Be brief.",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Use metric units." }],
        },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Reminder: answer in French." }],
        },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello", annotations: [] }],
          status: "completed",
        },
        { role: "user", content: [{ type: "input_text", text: "weather?" }] },
      ],
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    });
  });

  it("keys the prompt cache like omp: a short key as is, a long one hashed", () => {
    const key = (value: unknown) =>
      translate({ messages: [{ role: "user", content: "x" }], prompt_cache_key: value })
        .prompt_cache_key;
    expect(key("conversation-1")).toBe("conversation-1");
    expect(key("")).toBeUndefined();
    expect(key(undefined)).toBeUndefined();
    const long = key("k".repeat(100));
    expect(long).toMatch(/^pc_[0-9a-z]+$/);
    expect(long).toBe(key("k".repeat(100)));
  });

  it("supplies instructions when the client sent none, and asks the system prompt when it is all there is", () => {
    expect(translate({ messages: [{ role: "user", content: "hi" }] }).instructions).toBe(
      "You are a helpful assistant.",
    );
    const only = translate({ messages: [{ role: "system", content: "Say hi." }] });
    expect(only.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Say hi." }] },
    ]);
    expect(() => translate({ messages: [] })).toThrow("at least one");
    // Blank messages carry nothing.
    expect(() => translate({ messages: [{ role: "user", content: "  " }] })).toThrow(
      "at least one",
    );
  });

  it("maps images, and refuses what the backend cannot take", () => {
    const out = translate({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "https://x.test/a.png", detail: "high" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    // Text first, then the images; the detail is always on the wire.
    expect(out.input[0].content).toEqual([
      { type: "input_text", text: "what is this" },
      { type: "input_image", detail: "high", image_url: "https://x.test/a.png" },
      { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
    ]);
    const bad = (content: unknown) => () => translate({ messages: [{ role: "user", content }] });
    expect(bad([{ type: "image_url", image_url: { url: "ftp://x" } }])).toThrow("image_url");
    expect(bad([{ type: "input_audio", input_audio: {} }])).toThrow("Unsupported content part");
    expect(() => translate({ messages: [{ role: "critic", content: "x" }] })).toThrow("role");
  });

  it("maps tools, tool choice and tool-call history, pairing every call with a result", () => {
    const out = translate({
      messages: [
        { role: "user", content: "weather in Oslo and Rome" },
        {
          role: "assistant",
          content: "Checking.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
            },
            {
              id: "weird id/with:chars",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
            {
              id: "call_3",
              type: "function",
              function: { name: "get_weather", arguments: { city: "Rome" } },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
        {
          role: "tool",
          tool_call_id: "weird id/with:chars",
          content: [{ type: "text", text: "rainy" }],
        },
        { role: "tool", tool_call_id: "ghost", content: "no such call" },
      ],
      tools: [
        WEATHER,
        { ...WEATHER, function: { ...WEATHER.function, name: "strict_tool", strict: true } },
      ],
      tool_choice: { type: "function", function: { name: "get_weather" } },
      parallel_tool_calls: false,
    });
    // `strict` is on the wire only when the tool said so; the schema is Responses-safe.
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Weather of a city",
        parameters: WEATHER.function.parameters,
      },
      expect.objectContaining({ name: "strict_tool", strict: true }),
    ]);
    expect(out.tool_choice).toEqual({ type: "function", name: "get_weather" });
    expect(out.parallel_tool_calls).toBe(false);

    const sanitized = out.input[3].call_id as string;
    expect(sanitized).toMatch(/^weird_id_with_chars_[0-9a-z]+$/);
    expect(out.input.slice(1)).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Checking.", annotations: [] }],
        status: "completed",
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Oslo"}',
      },
      { type: "function_call", call_id: sanitized, name: "get_weather", arguments: "{}" },
      {
        type: "function_call",
        call_id: "call_3",
        name: "get_weather",
        arguments: '{"city":"Rome"}',
      },
      // The call without a result gets a placeholder right after it; the result without a call is folded into a note.
      {
        type: "function_call_output",
        call_id: "call_3",
        output: expect.stringContaining("interrupted"),
      },
      { type: "function_call_output", call_id: "call_1", output: "sunny" },
      { type: "function_call_output", call_id: sanitized, output: "rainy" },
      {
        type: "message",
        role: "assistant",
        content: "[Previous tool result; call_id=ghost]: no such call",
      },
    ]);

    const choice = (tool_choice: unknown, tools = [WEATHER]) =>
      translate({ messages: [{ role: "user", content: "x" }], tools, tool_choice }).tool_choice;
    expect(choice("required")).toBe("required");
    // A function the request does not offer is dropped, like omp.
    expect(choice({ type: "function", function: { name: "nope" } })).toBeUndefined();
    expect(() =>
      translate({ messages: [{ role: "user", content: "x" }], tools: [{ type: "web_search" }] }),
    ).toThrow("function tools");
  });

  it("maps reasoning effort like omp: only with an effort, summaries on by default", () => {
    const effort = (model: string, body: Json) =>
      (toCodexRequest({ model, messages: [{ role: "user", content: "x" }], ...body }) as Json)
        .reasoning;
    expect(effort("gpt-5.6-sol", {})).toBeUndefined();
    expect(effort("gpt-5.6-sol", { reasoning_effort: "high" })).toEqual({
      effort: "high",
      summary: "auto",
    });
    expect(effort("gpt-5.6-sol", { reasoning_effort: "max" })).toEqual({
      effort: "max",
      summary: "auto",
    });
    expect(effort("gpt-6-luna", { reasoning_effort: "minimal" })).toEqual({
      effort: "low",
      summary: "auto",
    });
    expect(effort("gpt-6-luna", { reasoning_effort: "none" })).toEqual({ effort: "none" });
    expect(effort("gpt-6-luna", { reasoning: { effort: "medium", summary: "detailed" } })).toEqual({
      effort: "medium",
      summary: "detailed",
    });
    // `summary: null` hides the summaries; a summary without an effort is not requested.
    expect(effort("gpt-6-luna", { reasoning: { effort: "medium", summary: null } })).toEqual({
      effort: "medium",
    });
    expect(effort("gpt-6-luna", { reasoning: { summary: "concise" } })).toBeUndefined();
    expect(() => effort("gpt-6-luna", { reasoning_effort: "turbo" })).toThrow("reasoning_effort");
  });

  it("makes tool schemas acceptable to the Responses API", () => {
    const parameters = (schema: Json) =>
      (
        translate({
          messages: [{ role: "user", content: "x" }],
          tools: [{ type: "function", function: { name: "t", parameters: schema } }],
        }).tools as Json[]
      )[0]!.parameters;
    expect(
      parameters({
        type: "object",
        properties: {
          pick: { oneOf: [{ type: "string" }, { type: "object" }] },
          any: {},
          code: { type: "string", pattern: "^(?=a)b$" },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        pick: { anyOf: [{ type: "string" }, { type: "object", properties: {} }] },
        any: true,
        code: { type: "string" },
      },
    });
    expect(parameters({})).toEqual({ type: "object", properties: {} });
  });

  it("maps response_format and verbosity to the text object", () => {
    const text = (body: Json) =>
      translate({ messages: [{ role: "user", content: "x" }], ...body }).text;
    expect(
      text({
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", strict: true, schema: { type: "object", properties: {} } },
        },
        verbosity: "low",
      }),
    ).toEqual({
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object", properties: {} },
        strict: true,
      },
    });
    expect(text({ response_format: { type: "json_object" } })).toEqual({
      format: { type: "json_object" },
    });
    expect(text({ response_format: { type: "text" } })).toBeUndefined();
    expect(() =>
      text({ response_format: { type: "json_schema", json_schema: { name: "x" } } }),
    ).toThrow("schema is required");
  });
});

const sseOf = (events: Json[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const completed = (response: Json = {}, type = "response.completed") => ({
  type,
  response: {
    status: "completed",
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      total_tokens: 19,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 3 },
    },
    ...response,
  },
});

async function collect(events: Json[]): Promise<OpenAIChunk[]> {
  const chunks: OpenAIChunk[] = [];
  for await (const c of codexChunks(sseOf(events).body!, "gpt-5.6-sol")) chunks.push(c);
  return chunks;
}

describe("response mapping", () => {
  it("streams text and reasoning summaries, then finishes with usage in the last chunk", async () => {
    const chunks = await collect([
      { type: "response.created", response: { id: "resp_1" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Thinking" },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: " hard" },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Done" },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "msg_1" },
      },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "Hel" },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "lo" },
      { type: "response.codex.rate_limits", rate_limits: {} },
      completed(),
    ]);
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: "assistant", content: "" });
    expect(chunks.map((c) => c.choices[0]?.delta.reasoning_content).filter(Boolean)).toEqual([
      "Thinking",
      " hard",
      "\n\nDone",
    ]);
    expect(chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual(["Hel", "lo"]);
    const finish = chunks.at(-2)!;
    expect(finish.choices[0]).toMatchObject({ delta: {}, finish_reason: "stop" });
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    });
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
  });

  it("streams function calls by index, with arguments in pieces or whole", async () => {
    const chunks = await collect([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 0,
        delta: '{"city":',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 0,
        delta: '"Oslo"}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        output_index: 0,
        arguments: '{"city":"Oslo"}',
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"Oslo"}',
        },
      },
      // This one never announced itself and sends its arguments only with the finished item.
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "ping", arguments: "" },
      },
      completed(),
    ]);
    const calls = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
    expect(calls).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: "" },
      },
      { index: 0, function: { arguments: '{"city":' } },
      { index: 0, function: { arguments: '"Oslo"}' } },
      { index: 1, id: "call_2", type: "function", function: { name: "ping", arguments: "" } },
      { index: 1, function: { arguments: "{}" } },
    ]);
    expect(chunks.at(-2)!.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("recovers text and summaries from finished items when no deltas were sent", async () => {
    const chunks = await collect([
      {
        type: "response.output_item.done",
        item: { type: "reasoning", id: "rs", summary: [{ text: "A" }, { text: "B" }] },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          id: "m",
          content: [
            { type: "output_text", text: "Hi" },
            { type: "refusal", refusal: " no" },
          ],
        },
      },
      completed(),
    ]);
    expect(chunks.map((c) => c.choices[0]?.delta.reasoning_content).filter(Boolean)).toEqual([
      "A\n\nB",
    ]);
    expect(chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual(["Hi no"]);
  });

  it("maps an incomplete answer to its finish reason", async () => {
    const reason = async (incomplete: string, events: Json[] = []) =>
      (
        await collect([
          ...events,
          completed(
            { status: "incomplete", incomplete_details: { reason: incomplete } },
            "response.incomplete",
          ),
        ])
      ).at(-2)!.choices[0]!.finish_reason;
    expect(await reason("max_output_tokens")).toBe("length");
    expect(await reason("content_filter")).toBe("content_filter");

    // omp promotes an answer the cap cut after its calls were complete, not one cut in the middle of a call.
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "f" };
    const added = { type: "response.output_item.added", output_index: 0, item: call };
    const done = {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...call, arguments: "{}" },
    };
    expect(await reason("max_output_tokens", [added, done])).toBe("tool_calls");
    expect(await reason("max_output_tokens", [added])).toBe("length");
  });

  it("fails the stream like omp does: error events, failed responses, an unfinished stream", async () => {
    await expect(
      collect([{ type: "error", code: "server_error", message: "Overloaded" }]),
    ).rejects.toThrow("Codex error event: Overloaded (code=server_error)");
    await expect(
      collect([
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: { code: "context_length_exceeded", message: "Too long" },
          },
        },
      ]),
    ).rejects.toThrow(
      "Codex response failed: Too long (code=context_length_exceeded, status=failed)",
    );
    await expect(
      collect([{ type: "response.failed", response: { error: { code: "usage_limit_reached" } } }]),
    ).rejects.toThrow("Codex response failed (code=usage_limit_reached)");
    await expect(collect([completed({ status: "failed" })])).rejects.toThrow(
      "Codex response failed (status=failed)",
    );
    await expect(
      collect([{ type: "response.output_text.delta", delta: "partial" }]),
    ).rejects.toThrow("ended before terminal completion event");
  });
});

function callOf(
  adapter: ProviderAdapter,
  input: {
    token?: string;
    meta?: Record<string, string>;
    stream?: boolean;
    headers?: Record<string, string>;
    body?: Json;
    baseUrl?: string;
    observe?: (quota: Quota) => void;
  } = {},
) {
  return adapter.call({
    baseUrl: input.baseUrl ?? adapter.defaultBaseUrl!,
    token: input.token ?? accessToken(),
    meta: input.meta ?? { account_id: ACCOUNT },
    headers: input.headers ?? {},
    body: input.body ?? { model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] },
    stream: input.stream ?? false,
    signal: new AbortController().signal,
    ...(input.observe ? { observe: input.observe } : {}),
  });
}

const okEvents = () => [
  { type: "response.output_text.delta", item_id: "m", delta: "Hi" },
  { type: "response.output_text.delta", item_id: "m", delta: " there" },
  completed(),
];

describe("adapter", () => {
  it("is the ChatGPT subscription provider with a static model list, sign-in and quota", () => {
    const adapter = createChatgptSubscriptionAdapter();
    expect(adapter).toMatchObject({
      type: "chatgpt-subscription",
      defaultBaseUrl: DEFAULT_BASE_URL,
      staticModels: CODEX_MODELS,
    });
    expect(adapter.oauth!.label).toBe("Sign in with ChatGPT (Codex)");
    expect(typeof adapter.quota).toBe("function");
    expect(DEFAULT_BASE_URL).toBe("https://chatgpt.com/backend-api");
    expect(CODEX_MODELS.map((m) => m.id)).toContain("gpt-5.6-sol");
    expect(new Set(CODEX_MODELS.map((m) => m.id)).size).toBe(CODEX_MODELS.length);
  });

  it("posts a Codex request with the account's identity and serves JSON or SSE", async () => {
    const up = fakeFetch(() => sseOf(okEvents()));
    const adapter = createChatgptSubscriptionAdapter({ fetch: up.fetch });

    const json = await callOf(adapter, {
      token: accessToken(),
      body: {
        model: "gpt-5.6-sol",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "hi" },
        ],
        prompt_cache_key: "conv-1",
      },
    });
    expect(json.status).toBe(200);
    const completion = (await json.json()) as ChatCompletion;
    expect(completion.choices[0]!.message.content).toBe("Hi there");
    expect(completion.model).toBe("gpt-5.6-sol");
    expect(completion.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 7 });

    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    // omp's identity, headers and all.
    expect(sent.headers).toMatchObject({
      authorization: `Bearer ${accessToken()}`,
      "chatgpt-account-id": ACCOUNT,
      "openai-beta": "responses=experimental",
      originator: "omp",
      version: "0.159.0",
      "user-agent": USER_AGENT,
      accept: "text/event-stream",
      "content-type": "application/json",
      session_id: "conv-1",
      conversation_id: "conv-1",
      "session-id": "conv-1",
      "x-client-request-id": "conv-1",
      "x-codex-routing-hint": "model=gpt-5.6-sol",
    });
    expect(USER_AGENT).toMatch(/^omp\/\d+\.\d+\.\d+$/);
    expect(sent.headers["thread-id"]).toMatch(UUID);
    expect(sent.headers["x-codex-window-id"]).toMatch(UUID);
    expect(sent.headers["x-codex-installation-id"]).toBeUndefined();
    expect(sent.headers["x-oai-attestation"]).toBeUndefined();
    expect(sent.headers["x-openai-internal-codex-residency"]).toBeUndefined();
    const turn = JSON.parse(sent.headers["x-codex-turn-metadata"]!);
    expect(turn).toMatchObject({
      session_id: "conv-1",
      thread_id: sent.headers["thread-id"],
      window_id: sent.headers["x-codex-window-id"],
      request_kind: "turn",
    });
    expect(sent.body.client_metadata).toEqual({
      "x-codex-installation-id": turn.installation_id,
      session_id: "conv-1",
      thread_id: turn.thread_id,
      "x-codex-window-id": turn.window_id,
      turn_id: turn.turn_id,
      "x-codex-turn-metadata": sent.headers["x-codex-turn-metadata"],
    });
    expect(sent.body).toMatchObject({
      model: "gpt-5.6-sol",
      instructions: "Be brief.",
      store: false,
      stream: true,
      prompt_cache_key: "conv-1",
    });

    // Always streamed upstream, whatever the client asked for.
    const sse = await callOf(adapter, { stream: true });
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    const events: string[] = [];
    for await (const e of parseSse(sse.body!)) events.push(e.data);
    expect(events.at(-1)).toBe("[DONE]");
    const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(parsed.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual([
      "Hi",
      " there",
    ]);
    expect(parsed.at(-1).usage.total_tokens).toBe(19);
    expect(up.calls[1]!.body.stream).toBe(true);
    // Without a cache key the session is fresh and the cache-affinity headers are left out, like omp.
    expect(up.calls[1]!.headers.session_id).toBeUndefined();
    expect(up.calls[1]!.headers.conversation_id).toBeUndefined();
    expect(up.calls[1]!.headers["x-client-request-id"]).toBeUndefined();
    expect(up.calls[1]!.headers["session-id"]).toMatch(UUID);
    expect(up.calls[1]!.body.prompt_cache_key).toBeUndefined();
    // A session keeps its thread and window across requests.
    await callOf(adapter, { body: { ...CHAT, prompt_cache_key: "conv-1" } });
    expect(up.calls[2]!.headers["thread-id"]).toBe(sent.headers["thread-id"]);
    expect(up.calls[2]!.headers["x-codex-window-id"]).toBe(sent.headers["x-codex-window-id"]);
    expect(up.calls[2]!.headers["x-codex-turn-metadata"]).not.toBe(
      sent.headers["x-codex-turn-metadata"],
    );
  });

  it("takes the workspace from the token, declares residency, and lets only the residency be overridden", async () => {
    const up = fakeFetch(() => sseOf(okEvents()));
    const adapter = createChatgptSubscriptionAdapter({ fetch: up.fetch });
    const token = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "from-token",
        chatgpt_data_residency: "eu",
      },
    });
    await callOf(adapter, {
      token,
      meta: { account_id: "stored" },
      baseUrl: "http://127.0.0.1:9/backend-api/codex/",
      headers: { originator: "custom", "x-extra": "1" },
    });
    const sent = up.calls[0]!;
    expect(sent.url).toBe("http://127.0.0.1:9/backend-api/codex/responses");
    expect(sent.headers).toMatchObject({
      "chatgpt-account-id": "from-token",
      "x-openai-internal-codex-residency": "eu",
      originator: "omp",
      "x-extra": "1",
    });
    await callOf(adapter, { token, headers: { "x-openai-internal-codex-residency": "us" } });
    expect(up.calls[1]!.headers["x-openai-internal-codex-residency"]).toBe("us");
  });

  it("reports unrepresentable requests as 400 without calling upstream", async () => {
    const up = fakeFetch(() => sseOf(okEvents()));
    const res = await callOf(createChatgptSubscriptionAdapter({ fetch: up.fetch }), {
      body: {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: [{ type: "input_audio" }] }],
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error).toMatchObject({
      code: "invalid_request_error",
      message: 'Unsupported content part type "input_audio".',
    });
    expect(up.calls).toHaveLength(0);
  });

  it("returns upstream failures with their status, and a spent usage limit as a 429 with its reset", async () => {
    const respondWith = async (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ) => {
      const up = fakeFetch(() => new Response(body, { status, headers }));
      const res = await callOf(createChatgptSubscriptionAdapter({ fetch: up.fetch }));
      return { res, text: await res.text() };
    };

    const plain = await respondWith(401, '{"detail":"Unauthorized"}', {
      "content-type": "application/json",
      "retry-after": "7",
    });
    expect(plain.res.status).toBe(401);
    expect(plain.res.headers.get("content-type")).toBe("application/json");
    expect(plain.res.headers.get("retry-after")).toBe("7");
    expect(plain.text).toBe('{"detail":"Unauthorized"}');
    expect((await respondWith(503, "<html>bad gateway</html>")).res.status).toBe(503);
    const rate = await respondWith(429, '{"error":{"type":"rate_limit_exceeded"}}');
    expect(rate.res.status).toBe(429);
    expect(JSON.parse(rate.text).error).toMatchObject({
      code: "rate_limit_exceeded",
      message: "ChatGPT rate limit exceeded.",
    });

    // An account policy denial is a 403, which the gateway answers by trying another account.
    const cyber = await respondWith(
      400,
      JSON.stringify({
        error: { code: "cyber_policy", message: "Trusted access for cyber is required" },
      }),
    );
    expect(cyber.res.status).toBe(403);
    expect(JSON.parse(cyber.text).error.message).toBe("Trusted access for cyber is required");

    const limit = await respondWith(
      429,
      JSON.stringify({
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          plan_type: "pro",
          resets_at: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    );
    expect(limit.res.status).toBe(429);
    expect(Number(limit.res.headers.get("retry-after"))).toBeGreaterThan(3590);
    expect(JSON.parse(limit.text).error).toMatchObject({
      code: "insufficient_quota",
      type: "insufficient_quota",
    });
    expect(JSON.parse(limit.text).error.message).toMatch(
      /usage limit \(pro plan\)\. Try again in ~6\d min\./,
    );

    // A limit the backend reports with another status is still the account's problem.
    const odd = await respondWith(
      403,
      JSON.stringify({
        error: { code: "usage_limit_reached", resets_at: Math.floor(Date.now() / 1000) + 120 },
      }),
    );
    expect(odd.res.status).toBe(429);
    expect(Number(odd.res.headers.get("retry-after"))).toBeGreaterThan(100);
  });

  it("throws transport errors and failures of a non-streamed answer so the gateway can fail over", async () => {
    const broken = createChatgptSubscriptionAdapter({
      fetch: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
    });
    await expect(callOf(broken)).rejects.toThrow("fetch failed");

    const failing = createChatgptSubscriptionAdapter({
      fetch: fakeFetch(() =>
        sseOf([{ type: "error", code: "server_error", message: "Overloaded" }]),
      ).fetch,
    });
    await expect(callOf(failing)).rejects.toThrow("Overloaded");
  });

  it("reports what the rate-limit headers of every answer reveal about the account", async () => {
    const seen: Quota[] = [];
    const headers = {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(NOW / 1000 + 600),
      "x-codex-secondary-used-percent": "40",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": String(NOW / 1000 + 86_400),
    };
    const refused = createChatgptSubscriptionAdapter({
      fetch: fakeFetch(() => new Response("{}", { status: 429, headers })).fetch,
    });
    await callOf(refused, { observe: (q) => seen.push(q) });
    const served = createChatgptSubscriptionAdapter({
      fetch: fakeFetch(() => new Response(sseOf(okEvents()).body, { headers })).fetch,
    });
    await callOf(served, { observe: (q) => seen.push(q) });
    const bare = createChatgptSubscriptionAdapter({
      fetch: fakeFetch(() => sseOf(okEvents())).fetch,
    });
    await callOf(bare, { observe: (q) => seen.push(q) });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ exhausted: true, resetsAt: (NOW / 1000 + 600) * 1000 });
    // An answer that was served proves the account still works (credits may fund the overage).
    expect(seen[1]).toMatchObject({ exhausted: false });
    expect(seen[1]!.windows.map((w) => w.usedPercent)).toEqual([100, 40]);
  });
});

const USAGE = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42.5,
      limit_window_seconds: 18_000,
      reset_at: NOW / 1000 + 600,
    },
    secondary_window: {
      used_percent: 10,
      limit_window_seconds: 604_800,
      reset_after_seconds: 3600,
    },
  },
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      rate_limit: {
        allowed: true,
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 18_000,
          reset_at: NOW / 1000 + 300,
        },
        secondary_window: {
          used_percent: 5,
          limit_window_seconds: 604_800,
          reset_at: NOW / 1000 + 7200,
        },
      },
    },
    {
      limit_name: "Something else",
      metered_feature: "other",
      rate_limit: { primary_window: { used_percent: 99 } },
    },
  ],
  credits: { has_credits: false, unlimited: false },
};

describe("quota", () => {
  it("reads the 5-hour and weekly windows, and Spark's own as a scope", () => {
    const quota = parseUsage(USAGE, NOW)!;
    expect(quota.windows).toEqual([
      { label: "5 hours", usedPercent: 42.5, resetsAt: (NOW / 1000 + 600) * 1000 },
      { label: "7 days", usedPercent: 10, resetsAt: NOW + HOUR },
      {
        label: "5 hours (Spark)",
        usedPercent: 100,
        resetsAt: (NOW / 1000 + 300) * 1000,
        scope: "spark",
      },
      {
        label: "7 days (Spark)",
        usedPercent: 5,
        resetsAt: (NOW / 1000 + 7200) * 1000,
        scope: "spark",
      },
    ]);
    // A spent Spark window never exhausts the account.
    expect(quota).toMatchObject({
      credits: null,
      exhausted: false,
      resetsAt: null,
      complete: true,
    });
    expect(modelScope("gpt-5.3-codex-spark")).toEqual({ name: "spark", local: true });
    expect(modelScope("gpt-5.6-sol")).toBeUndefined();
  });

  it("is exhausted when the account's verdict or a spent shared window says so, unless credits fund it", () => {
    const rate = (limit: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      parseUsage({ rate_limit: { ...USAGE.rate_limit, ...limit }, ...extra }, NOW)!;
    const spent = {
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 18_000,
        reset_at: NOW / 1000 + 600,
      },
    };

    expect(rate({ ...spent, allowed: false, limit_reached: true })).toMatchObject({
      exhausted: true,
      resetsAt: (NOW / 1000 + 600) * 1000,
    });
    // No explicit verdict: the percentages decide.
    expect(rate({ ...spent, allowed: undefined, limit_reached: undefined }).exhausted).toBe(true);
    // An explicit "still allowed" outranks a window at 100%.
    expect(rate({ ...spent, allowed: true, limit_reached: false }).exhausted).toBe(false);
    // A refusal without a spent window parks until the fallback.
    expect(rate({ limit_reached: true })).toMatchObject({ exhausted: true, resetsAt: null });
    // Credits cover the overage unless capped.
    const funded = { credits: { has_credits: true, overage_limit_reached: false } };
    expect(rate({ ...spent, limit_reached: true }, funded).exhausted).toBe(false);
    expect(
      rate({ ...spent, limit_reached: true }, { credits: { unlimited: true } }).exhausted,
    ).toBe(false);
    expect(
      rate(
        { ...spent, limit_reached: true },
        { credits: { ...funded.credits, overage_limit_reached: true } },
      ).exhausted,
    ).toBe(true);
    expect(
      rate({ ...spent, limit_reached: true }, { ...funded, spend_control: { reached: true } })
        .exhausted,
    ).toBe(true);
  });

  it("labels windows by their length like omp, and by position when they do not say", () => {
    const labels = (rate_limit: Record<string, unknown>) =>
      parseUsage({ rate_limit }, NOW)!.windows.map((w) => w.label);
    expect(
      labels({ primary_window: { used_percent: 1, limit_window_seconds: 2_592_000 } }),
    ).toEqual(["30 days"]);
    expect(
      labels({
        primary_window: { used_percent: 1, limit_window_seconds: 3_600 },
        secondary_window: { used_percent: 1 },
      }),
    ).toEqual(["1 hour", "Secondary window"]);
    expect(labels({ primary_window: { used_percent: 1 }, secondary_window: null })).toEqual([
      "Primary window",
    ]);
    expect(
      labels({
        primary_window: { used_percent: 1, limit_window_seconds: 604_800 },
        secondary_window: { used_percent: 2, limit_window_seconds: 604_800 },
      }),
    ).toEqual(["7 days", "7 days (2)"]);
    // A window that fails to parse stops a reading from vouching for the whole account.
    expect(
      parseUsage(
        {
          rate_limit: {
            primary_window: { used_percent: 1 },
            secondary_window: { used_percent: "x" },
          },
        },
        NOW,
      ),
    ).toMatchObject({ complete: false });
    expect(parseUsage({}, NOW)).toBeNull();
    expect(parseUsage({ rate_limit: { primary_window: null } }, NOW)).toBeNull();
    expect(parseUsage("nope", NOW)).toBeNull();
  });

  it("reads rate-limit headers, with the reset as epoch seconds", () => {
    const h = (entries: Record<string, string>) => new Headers(entries);
    const quota = parseRateLimitHeaders(
      h({
        "x-codex-primary-used-percent": "63.5",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(NOW / 1000 + 120),
        "x-codex-secondary-used-percent": "250",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": String(NOW / 1000 + 5000),
        // omp reads the two windows only.
        "x-codex-tertiary-used-percent": "5",
      }),
      true,
    );
    expect(quota).toEqual({
      windows: [
        { label: "5 hours", usedPercent: 63.5, resetsAt: NOW + 120_000 },
        { label: "7 days", usedPercent: 100, resetsAt: (NOW / 1000 + 5000) * 1000 },
      ],
      credits: null,
      exhausted: false,
      resetsAt: null,
    });
    expect(quota!.complete).toBeUndefined();
    expect(parseRateLimitHeaders(h({ "content-type": "x" }), false)).toBeNull();
    expect(parseRateLimitHeaders(h({ "x-codex-primary-used-percent": "n/a" }), false)).toBeNull();
  });

  it("resolves the Responses route and the account endpoints like omp", () => {
    expect(resolveResponsesUrl(DEFAULT_BASE_URL)).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(resolveResponsesUrl("https://chatgpt.com/backend-api/codex/")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(resolveResponsesUrl("https://proxy.test/codex/responses")).toBe(
      "https://proxy.test/codex/responses",
    );
    expect(resolveResponsesUrl("https://proxy.test/v1")).toBe(
      "https://proxy.test/v1/codex/responses",
    );
    expect(resolveResponsesUrl("  ")).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(accountApiBase("https://chatgpt.com/backend-api/codex/responses")).toBe(
      DEFAULT_BASE_URL,
    );
    expect(accountApiBase("https://chat.openai.com/x")).toBe("https://chat.openai.com/backend-api");
    expect(accountApiBase("https://proxy.test/backend-api")).toBe(DEFAULT_BASE_URL);
    expect(accountApiBase("not a url")).toBe(DEFAULT_BASE_URL);
  });

  it("probes the usage endpoint of the ChatGPT origin with the account's token", async () => {
    const up = fakeFetch(() => Response.json(USAGE));
    const call = (baseUrl: string) =>
      fetchCodexQuota(
        {
          baseUrl,
          token: "tok",
          meta: { account_id: ACCOUNT },
          headers: { "x-extra": "1" },
          signal: new AbortController().signal,
        },
        up.fetch,
      );
    expect((await call(DEFAULT_BASE_URL)).windows).toHaveLength(4);
    // Only the canonical origins carry the account endpoints: a proxy's base URL is not used for them.
    await call("http://127.0.0.1:9/backend-api/codex/");
    await call("https://chat.openai.com/backend-api/codex/");
    expect(up.calls.map((c) => c.url)).toEqual([
      "https://chatgpt.com/backend-api/wham/usage",
      "https://chatgpt.com/backend-api/wham/usage",
      "https://chat.openai.com/backend-api/wham/usage",
    ]);
    expect(up.calls[0]!.headers).toMatchObject({
      authorization: "Bearer tok",
      "chatgpt-account-id": ACCOUNT,
      "user-agent": USER_AGENT,
      "x-extra": "1",
    });
  });

  it("diagnoses a failed probe without upstream text", async () => {
    const probe = (handler: () => Response | Promise<Response>) =>
      fetchCodexQuota(
        {
          baseUrl: DEFAULT_BASE_URL,
          token: "t",
          meta: {},
          headers: {},
          signal: new AbortController().signal,
        },
        fakeFetch(handler).fetch,
      ).catch((e: unknown) => e as QuotaError);
    expect(await probe(() => new Response("no", { status: 401 }))).toMatchObject({
      code: "access_denied",
      status: 401,
    });
    expect(await probe(() => new Response("no", { status: 429 }))).toMatchObject({
      code: "rate_limited",
    });
    expect(await probe(() => new Response("no", { status: 502 }))).toMatchObject({
      code: "upstream_error",
    });
    expect(await probe(() => Response.json({ plan_type: "free" }))).toMatchObject({
      code: "response_unusable",
    });
    expect(await probe(() => new Response("<html>", { status: 200 }))).toMatchObject({
      code: "response_unusable",
    });
    expect(await probe(() => Promise.reject(new TypeError("down")))).toMatchObject({
      code: "transport_error",
    });
  });
});

describe("through the gateway", () => {
  it("signs in, lists the static models and serves a chat completion", async () => {
    const up = fakeFetch((seen) =>
      seen.url === TOKEN_URL
        ? Response.json({
            access_token: accessToken(),
            refresh_token: "rt-1",
            id_token: idToken(),
            expires_in: 3600,
          })
        : sseOf(okEvents()),
    );
    let h: Harness | undefined;
    const adapter = createChatgptSubscriptionAdapter({ fetch: up.fetch, now: () => h!.clock.now });
    h = createHarness({}, { adapters: { ...ADAPTERS, [adapter.type]: adapter } });

    expect(
      (await h.admin("POST", "/providers", { id: "codex", type: "chatgpt-subscription" })).status,
    ).toBe(201);
    const types = (await h.admin("GET", "/provider-types")).json.data;
    expect(types.find((t: { type: string }) => t.type === "chatgpt-subscription")).toMatchObject({
      default_base_url: DEFAULT_BASE_URL,
      oauth: { label: "Sign in with ChatGPT (Codex)" },
      models: "static",
      quota: true,
    });

    const started = await h.admin("POST", "/providers/codex/oauth/start", {});
    expect(started.status).toBe(201);
    const state = new URL(started.json.auth_url).searchParams.get("state")!;
    const done = await h.admin("POST", `/oauth/sessions/${started.json.session_id}/complete`, {
      input: `${REDIRECT_URI}?code=c1&state=${state}`,
    });
    expect(done.json.status).toBe("complete");
    const [cred] = (await h.admin("GET", "/providers/codex/credentials")).json.data;
    expect(cred).toMatchObject({
      status: "active",
      label: "dev@example.com",
      expires_at: h.clock.now + HOUR,
    });

    const models = (await h.admin("GET", "/providers/codex/models")).json;
    expect(models.source).toBe("static");
    expect(models.data.map((m: { id: string }) => m.id)).toContain("gpt-6.1-sol");

    const key = await h.newKey();
    const res = await h.chat(key.secret, {
      model: "codex/gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ChatCompletion).choices[0]!.message.content).toBe("Hi there");
    const sent = up.calls.find((c) => c.url.endsWith("/responses"))!;
    expect(sent.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(sent.headers).toMatchObject({
      authorization: `Bearer ${accessToken()}`,
      "chatgpt-account-id": ACCOUNT,
    });
    expect(sent.body.model).toBe("gpt-5.6-sol");
  });
});
