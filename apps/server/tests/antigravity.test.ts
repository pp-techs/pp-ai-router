import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { OAuthRefreshError, type OAuthTokens } from "../src/oauth/types.ts";
import { ADAPTERS } from "../src/providers/adapter.ts";
import { createAntigravityAdapter } from "../src/providers/antigravity/adapter.ts";
import { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } from "../src/providers/antigravity/constants.ts";
import { resolveWireModel } from "../src/providers/antigravity/models.ts";
import {
  createAntigravityOAuth,
  parseCallbackInput,
  type LoginState,
} from "../src/providers/antigravity/oauth.ts";
import { resetReplay } from "../src/providers/antigravity/replay.ts";
import { buildRequest } from "../src/providers/antigravity/request.ts";
import { chunksFromSse, GeminiMapper } from "../src/providers/antigravity/stream.ts";
import { sanitizeToolParameters } from "../src/providers/antigravity/tool-schema.ts";
import { aggregateChunks, type OpenAIChunk } from "../src/providers/chunks.ts";
import { createHarness, readJson, type UpstreamCall } from "./harness.ts";

const HOUR = 3_600_000;
const SIG = "c2lnbmF0dXJlLWZyb20tZ2VtaW5pLTM="; // a real-looking (>=16 chars base64) thought signature

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const idToken = (email: string) => `${b64({ alg: "none" })}.${b64({ email })}.sig`;

interface Recorded {
  url: URL;
  headers: Headers;
  body: UpstreamCall["body"] | undefined;
  form?: URLSearchParams;
}

/** One fake standing in for accounts.google.com's token endpoint and the cloudcode API. */
function fakeGoogle(clock: { now: number } = { now: 0 }) {
  const calls: Recorded[] = [];
  const state = {
    tokens: 0,
    validTokens: new Set<string>(),
    /** Handler results for token grants, consumed in order; falls back to success. */
    tokenFailures: [] as Response[],
    loadProject: "proj-1" as string | null,
    onboard: [] as Record<string, unknown>[],
    generate: [] as Response[],
    email: "Alice@Example.com",
  };

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : "";
    const rec: Recorded = { url, headers, body: undefined };
    if (headers.get("content-type")?.includes("x-www-form-urlencoded")) {
      rec.form = new URLSearchParams(raw);
    } else if (raw) rec.body = JSON.parse(raw);
    calls.push(rec);

    if (url.hostname === "oauth2.googleapis.com") {
      const failure = state.tokenFailures.shift();
      if (failure) return failure;
      state.tokens++;
      const access = `at-${state.tokens}`;
      state.validTokens.add(access);
      const grant = rec.form!.get("grant_type");
      return Response.json({
        access_token: access,
        expires_in: 3600,
        ...(grant === "authorization_code"
          ? { refresh_token: "rt-1", id_token: idToken(state.email) }
          : {}),
      });
    }
    if (url.pathname.endsWith(":loadCodeAssist")) {
      return state.loadProject
        ? Response.json({ cloudaicompanionProject: state.loadProject })
        : Response.json({ currentTier: {} });
    }
    if (url.pathname.endsWith(":onboardUser")) {
      return Response.json(state.onboard.shift() ?? { done: false });
    }
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!state.validTokens.has(token)) {
      return Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 });
    }
    return state.generate.shift() ?? completionFrame("hello");
  };

  const generations = () =>
    calls.filter((c) => /:(stream)?[gG]enerateContent$/.test(c.url.pathname));
  return { calls, state, fetch: handler as typeof fetch, generations, clock };
}

const frame = (response: Record<string, unknown>) => ({ response, traceId: "t" });

function completionFrame(text: string, usage: Record<string, unknown> = USAGE): Response {
  return Response.json(
    frame({
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: usage,
    }),
  );
}

const USAGE = {
  promptTokenCount: 100,
  cachedContentTokenCount: 40,
  candidatesTokenCount: 20,
  thoughtsTokenCount: 30,
  totalTokenCount: 150,
};

function sseResponse(frames: unknown[]): Response {
  return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Byte stream cut into pieces of `size` bytes, to prove frames survive arbitrary network chunking. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size));
      controller.close();
    },
  });
}

async function collect(iterable: AsyncIterable<OpenAIChunk>): Promise<OpenAIChunk[]> {
  const out: OpenAIChunk[] = [];
  for await (const c of iterable) out.push(c);
  return out;
}

const mapperFor = (wireModelId = "gemini-3.8-flash-medium") =>
  new GeminiMapper({
    model: "gemini-3.8-flash",
    wireModelId,
    sessionId: "-1",
    restoreToolName: (name) => name,
  });

beforeEach(() => resetReplay());

describe("OAuth login (paste flow)", () => {
  const setup = () => {
    const google = fakeGoogle();
    const clock = { now: 1_000_000 };
    const oauth = createAntigravityOAuth({
      fetch: google.fetch,
      now: () => clock.now,
      sleep: () => Promise.resolve(),
    });
    return { google, clock, oauth };
  };

  it("builds a PKCE authorize URL and a paste-flow session", async () => {
    const { oauth, clock } = setup();
    const { info, state } = await oauth.start();
    expect(info.flow).toBe("paste");
    if (info.flow !== "paste") throw new Error("unreachable");
    expect(info.expiresAt).toBe(clock.now + 600_000);

    const url = new URL(info.authUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe("http://127.0.0.1:51121/callback");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent select_account");
    expect(p.get("scope")?.split(" ")).toContain("https://www.googleapis.com/auth/cloud-platform");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe(state.state);
    expect(p.get("code_challenge")).toBe(
      createHash("sha256").update(state.verifier).digest("base64url"),
    );
    expect(state.verifier.length).toBeGreaterThanOrEqual(43);
    expect(state.verifier.length).toBeLessThanOrEqual(128);

    const other = await oauth.start();
    expect(other.state.state).not.toBe(state.state);
    expect(other.state.verifier).not.toBe(state.verifier);
  });

  it("parses every paste shape", () => {
    expect(parseCallbackInput(`http://127.0.0.1:51121/callback?code=c1&state=s1`)).toMatchObject({
      kind: "url",
      code: "c1",
      state: "s1",
    });
    expect(parseCallbackInput(`  ?code=c2&state=s2 `)).toMatchObject({
      kind: "query",
      code: "c2",
      state: "s2",
    });
    expect(parseCallbackInput("c3#s3")).toEqual({ kind: "raw", code: "c3", state: "s3" });
    expect(parseCallbackInput("4/0Abc-def")).toEqual({ kind: "raw", code: "4/0Abc-def" });
    // The query wins as a whole: a fragment is never mixed into it.
    expect(parseCallbackInput("http://h/cb?code=q&state=s#code=f&state=other")).toMatchObject({
      code: "q",
      state: "s",
    });
    expect(parseCallbackInput("http://h/cb#code=f&state=s")).toMatchObject({
      code: "f",
      state: "s",
    });
    expect(parseCallbackInput("http://h/cb?error=access_denied")).toMatchObject({
      error: "access_denied",
    });
    expect(parseCallbackInput("   ")).toEqual({ kind: "raw" });
  });

  it("exchanges the code, discovers the project and stores email + project", async () => {
    const { google, clock, oauth } = setup();
    const { state } = await oauth.start();
    const tokens = await oauth.complete!(
      state,
      `http://127.0.0.1:51121/callback?code=the-code&state=${state.state}`,
    );
    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: clock.now + HOUR,
      account: "alice@example.com",
      extra: { project_id: "proj-1" },
    });

    const exchange = google.calls[0]!;
    expect(exchange.url.href).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(exchange.form!)).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "the-code",
      redirect_uri: REDIRECT_URI,
      code_verifier: state.verifier,
    });
    const load = google.calls[1]!;
    expect(load.url.href).toBe("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
    expect(load.headers.get("authorization")).toBe("Bearer at-1");
    expect(load.headers.get("user-agent")).toMatch(/^antigravity\/ide\//);
    expect(load.body).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
  });

  it("accepts `code#state`, a bare code and a query string", async () => {
    const { oauth } = setup();
    for (const make of [
      (s: LoginState) => `c#${s.state}`,
      () => "bare-code",
      (s: LoginState) => `?code=c&state=${s.state}`,
    ]) {
      const { state } = await oauth.start();
      expect((await oauth.complete!(state, make(state))).accessToken).toMatch(/^at-/);
    }
  });

  it("rejects a wrong or missing state and surfaces denials, without calling Google", async () => {
    const { google, oauth } = setup();
    const { state } = await oauth.start();
    for (const bad of [
      "http://127.0.0.1:51121/callback?code=c&state=wrong",
      "http://127.0.0.1:51121/callback?code=c",
      "?code=c&state=wrong",
      "c#wrong",
    ]) {
      await expect(oauth.complete!(state, bad)).rejects.toThrow(/state mismatch/);
    }
    await expect(oauth.complete!(state, "http://x/cb?error=access_denied")).rejects.toThrow(
      /access_denied/,
    );
    await expect(oauth.complete!(state, "")).rejects.toThrow(/No authorization code/);
    expect(google.calls).toHaveLength(0);
  });

  it("falls back to onboardUser (polling until done) when loadCodeAssist knows no project", async () => {
    const { google, oauth } = setup();
    google.state.loadProject = null;
    google.state.onboard = [
      { done: false },
      { done: true, response: { cloudaicompanionProject: { id: "proj-new" } } },
    ];
    const { state } = await oauth.start();
    const tokens = await oauth.complete!(state, `c#${state.state}`);
    expect(tokens.extra).toEqual({ project_id: "proj-new" });
    const onboard = google.calls.filter((c) => c.url.pathname.endsWith(":onboardUser"));
    expect(onboard).toHaveLength(2);
    expect(onboard[0]!.url.hostname).toBe("daily-cloudcode-pa.googleapis.com");
    expect(onboard[0]!.body).toMatchObject({
      tier_id: "free-tier",
      metadata: { ide_type: "ANTIGRAVITY" },
    });
  });

  it("fails the login instead of storing an account without a project", async () => {
    const { google, oauth } = setup();
    google.state.loadProject = null; // onboarding never finishes
    const { state } = await oauth.start();
    await expect(oauth.complete!(state, `c#${state.state}`)).rejects.toThrow(
      /Cloud Code Assist project/,
    );
  });

  it("reports a failed code exchange by status only", async () => {
    const { google, oauth } = setup();
    google.state.tokenFailures.push(
      Response.json({ error: "invalid_grant", secret: "x" }, { status: 400 }),
    );
    const { state } = await oauth.start();
    const error = await oauth.complete!(state, `c#${state.state}`).catch((e: Error) => e);
    expect((error as Error).message).toBe("Antigravity token request failed: 400 (invalid_grant)");
  });

  describe("refresh", () => {
    const account: OAuthTokens = {
      accessToken: "at-old",
      refreshToken: "rt-1",
      expiresAt: 0,
      account: "alice@example.com",
      extra: { project_id: "proj-1" },
    };

    it("refreshes, keeping the refresh token, account and project", async () => {
      const { google, clock, oauth } = setup();
      const fresh = await oauth.refresh(account);
      expect(fresh).toEqual({
        accessToken: "at-1",
        refreshToken: "rt-1",
        expiresAt: clock.now + HOUR,
        account: "alice@example.com",
        extra: { project_id: "proj-1" },
      });
      expect(Object.fromEntries(google.calls[0]!.form!)).toEqual({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: "rt-1",
      });
      expect(google.calls).toHaveLength(1); // project already known: no re-discovery
    });

    it("discovers the project on refresh when the account has none yet", async () => {
      const { oauth } = setup();
      const fresh = await oauth.refresh({ ...account, extra: {} });
      expect(fresh.extra).toEqual({ project_id: "proj-1" });
    });

    it("classifies invalid_grant as terminal and everything else as transient", async () => {
      const { google, oauth } = setup();
      const failure = async (res: Response | Error) => {
        if (res instanceof Error) {
          const original = google.fetch;
          const broken = createAntigravityOAuth({ fetch: () => Promise.reject(res) });
          void original;
          return broken.refresh(account).catch((e: unknown) => e);
        }
        google.state.tokenFailures.push(res);
        return oauth.refresh(account).catch((e: unknown) => e);
      };

      const terminal = (await failure(
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      )) as OAuthRefreshError;
      expect(terminal).toBeInstanceOf(OAuthRefreshError);
      expect(terminal.terminal).toBe(true);
      expect(
        (
          (await failure(
            Response.json({ error: "invalid_client" }, { status: 401 }),
          )) as OAuthRefreshError
        ).terminal,
      ).toBe(true);

      for (const transient of [
        Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
        Response.json({ error: "invalid_grant" }, { status: 500 }),
        Response.json({ error: "invalid_request" }, { status: 400 }),
        new Response("<html>", { status: 429 }),
        new Error("socket hang up"),
      ]) {
        const error = (await failure(transient)) as OAuthRefreshError;
        expect(error).toBeInstanceOf(OAuthRefreshError);
        expect(error.terminal).toBe(false);
      }
    });

    it("treats an account without a refresh token as terminal", async () => {
      const { oauth } = setup();
      const error = (await oauth
        .refresh({ ...account, refreshToken: null })
        .catch((e) => e)) as OAuthRefreshError;
      expect(error.terminal).toBe(true);
    });
  });
});

describe("model mapping", () => {
  it("maps base models and efforts to wire ids and thinking levels", () => {
    expect(resolveWireModel("gemini-3.8-flash")).toEqual({
      wireModelId: "gemini-3.8-flash-medium",
    });
    expect(resolveWireModel("gemini-3.8-flash", "xhigh")).toEqual({
      wireModelId: "gemini-3.8-flash-high",
    });
    expect(resolveWireModel("gemini-3.1-pro", "high")).toEqual({
      wireModelId: "gemini-pro-agent",
      thinkingLevel: "high",
    });
    expect(resolveWireModel("gemini-3.1-pro")).toEqual({ wireModelId: "gemini-pro-agent" });
    expect(resolveWireModel("gemini-3.7-flash", "low")).toEqual({
      wireModelId: "gemini-3.7-flash-tiered",
      thinkingLevel: "low",
    });
    expect(resolveWireModel("gemini-3.6-flash-high")).toEqual({
      wireModelId: "gemini-3.7-flash-tiered",
      thinkingLevel: "high",
    });
    expect(resolveWireModel("claude-sonnet-4-6", "max")).toEqual({
      wireModelId: "claude-sonnet-4-6",
      thinkingLevel: "high",
    });
    // Suffix wire ids and unknown ids are identity: the suffix IS the effort.
    expect(resolveWireModel("gemini-3.8-flash-low", "high")).toEqual({
      wireModelId: "gemini-3.8-flash-low",
    });
    expect(resolveWireModel("gemini-3.1-pro-preview")).toEqual({ wireModelId: "gemini-pro-agent" });
    expect(resolveWireModel("some-new-model")).toEqual({ wireModelId: "some-new-model" });
  });
});

describe("tool schema sanitiser", () => {
  it("keeps only the function-declaration subset", () => {
    const out = sanitizeToolParameters({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      title: "Args",
      properties: {
        path: { type: "string", description: "file", minLength: 1, pattern: "^/", default: "/" },
        mode: { type: "string", enum: ["r", "w", 1, "r"] },
        count: { type: ["integer", "null"], minimum: 0 },
        tags: { type: "array" },
        opt: { anyOf: [{ type: "string" }, { type: "null" }] },
        kind: { anyOf: [{ const: "a" }, { const: "b" }] },
        nested: { $ref: "#/$defs/Nested", description: "overlay" },
        loop: { $ref: "#/$defs/Loop" },
      },
      required: ["path", "ghost"],
      $defs: {
        Nested: {
          type: "object",
          properties: { x: { type: "number", exclusiveMinimum: 1 } },
          required: ["x"],
        },
        Loop: { type: "object", properties: { again: { $ref: "#/$defs/Loop" } } },
      },
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "file" },
        mode: { type: "string", enum: ["r", "w"] },
        count: { type: "integer", nullable: true },
        tags: { type: "array", items: { type: "string" } },
        opt: { type: "string", nullable: true },
        kind: { enum: ["a", "b"] },
        nested: {
          type: "object",
          description: "overlay",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
        loop: { type: "object", properties: { again: {} } },
      },
      required: ["path"],
    });
  });

  it("coerces a missing or non-object root and widens unsound unions", () => {
    expect(sanitizeToolParameters(undefined)).toEqual({ type: "object", properties: {} });
    expect(sanitizeToolParameters("nope")).toEqual({ type: "object", properties: {} });
    expect(sanitizeToolParameters({ type: "string" })).toEqual({ type: "object", properties: {} });
    expect(
      sanitizeToolParameters({
        type: "object",
        properties: { u: { description: "d", anyOf: [{ type: "string" }, { type: "number" }] } },
      }),
    ).toEqual({ type: "object", properties: { u: { description: "d" } } });
  });
});

describe("request compilation", () => {
  const build = (body: Record<string, unknown>, stream = true) => {
    const built = buildRequest({
      baseUrl: "https://daily-cloudcode-pa.googleapis.com/",
      token: "tok",
      project: "proj-1",
      body: { model: "gemini-3.8-flash", ...body },
      stream,
    });
    return { built, env: JSON.parse(built.body) };
  };

  it("builds the envelope, headers and URL", () => {
    const { built, env } = build({ messages: [{ role: "user", content: "hi" }] });
    expect(built.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
    expect(build({ messages: [{ role: "user", content: "hi" }] }, false).built.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    );
    expect(built.headers.authorization).toBe("Bearer tok");
    expect(built.headers["user-agent"]).toMatch(/^antigravity\/ide\/.* aidev_client/);
    expect(env).toMatchObject({
      model: "gemini-3.8-flash-medium",
      userAgent: "antigravity",
      requestType: "agent",
      project: "proj-1",
    });
    expect(env.requestId).toMatch(/^agent-[0-9a-f-]{36}$/);
    expect(env.request.sessionId).toMatch(/^-\d+$/);
    expect(env.request.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(env.request.systemInstruction).toBeUndefined();
    expect(env.request.generationConfig).toBeUndefined();
  });

  it("derives a stable session id from the first user message", () => {
    const a = build({ messages: [{ role: "user", content: "same" }] }).env.request.sessionId;
    const b = build({
      messages: [
        { role: "user", content: "same" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "later" },
      ],
    }).env.request.sessionId;
    const other = build({ messages: [{ role: "user", content: "different" }] }).env.request
      .sessionId;
    expect(a).toBe(b);
    expect(other).not.toBe(a);
  });

  it("maps system text, images, sampling parameters and stop sequences", () => {
    const { env } = build({
      messages: [
        { role: "system", content: "x-anthropic-billing-header: abc\nBe brief." },
        { role: "developer", content: [{ type: "text", text: "Use metric units." }] },
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "text", text: "" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "image_url", image_url: { url: "https://x.test/a.png" } },
          ],
        },
      ],
      max_completion_tokens: 999_999,
      temperature: 0.2,
      top_p: 0.9,
      stop: "END",
    });
    expect(env.request.systemInstruction).toEqual({
      parts: [{ text: "Be brief.\n\nUse metric units." }],
    });
    expect(env.request.contents[0].parts).toEqual([
      { text: "what is this?" },
      { inline_data: { mime_type: "image/png", data: "AAAA" } },
      { text: "[image: https://x.test/a.png]" },
    ]);
    expect(env.request.generationConfig).toEqual({
      maxOutputTokens: 65536,
      temperature: 0.2,
      topP: 0.9,
      stopSequences: ["END"],
    });
  });

  it("strips the Claude-SDK identity paragraph only for generations that reject it", () => {
    const system =
      "Intro.\n\nYou are a Claude agent, built on Anthropic's Claude Agent SDK.\n\nRules.";
    const messages = [
      { role: "system", content: system },
      { role: "user", content: "hi" },
    ];
    expect(build({ messages }).env.request.systemInstruction.parts[0].text).toBe(
      "Intro.\n\nRules.",
    );
    expect(
      build({ messages, model: "gemini-3.1-pro" }).env.request.systemInstruction.parts[0].text,
    ).toBe(system);
  });

  it("sends reasoning effort as wire model / thinkingConfig and asks for thought text", () => {
    const user = [{ role: "user", content: "think" }];
    const flash = build({ messages: user, reasoning_effort: "high" }).env;
    expect(flash.model).toBe("gemini-3.8-flash-high");
    expect(flash.request.generationConfig).toEqual({ thinkingConfig: { includeThoughts: true } });

    const pro = build({ messages: user, model: "gemini-3.1-pro", reasoning_effort: "low" }).env;
    expect(pro.model).toBe("gemini-3.1-pro-low");
    expect(pro.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "low",
      includeThoughts: true,
    });

    const tiered = build({ messages: user, model: "gemini-3.7-flash" }).env;
    expect(tiered.model).toBe("gemini-3.7-flash-tiered");
    expect(tiered.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "medium" });

    const none = build({ messages: user, reasoning_effort: "none" }).env;
    expect(none.request.generationConfig).toBeUndefined();

    const claude = build({
      messages: user,
      model: "claude-sonnet-4-6",
      reasoning_effort: "high",
    }).env;
    expect(claude.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("compiles tools with sanitised schemas, tool_choice and Google-legal names", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "read.file",
          description: "Read",
          parameters: {
            type: "object",
            properties: { p: { type: "string", pattern: "x" } },
            additionalProperties: false,
          },
        },
      },
      { type: "function", function: { name: "noop", strict: true } },
    ];
    const messages = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read.file", arguments: '{"p":"/a"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "contents" },
    ];
    const { env, built } = build({ messages, tools });
    const decls = env.request.tools[0].functionDeclarations;
    expect(decls).toHaveLength(2);
    expect(decls[0].name).toMatch(/^read_file_[0-9a-f]{8}$/);
    expect(decls[0]).toMatchObject({
      description: "Read",
      parameters: { type: "object", properties: { p: { type: "string" } } },
    });
    expect(decls[1]).toEqual({ name: "noop", parameters: { type: "object", properties: {} } });
    expect(built.restoreToolName(decls[0].name)).toBe("read.file");
    expect(env.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    // History uses the same wire name as the declaration.
    expect(env.request.contents[1].parts[0].functionCall.name).toBe(decls[0].name);

    const forced = build({
      messages,
      tools,
      tool_choice: { type: "function", function: { name: "noop" } },
    }).env.request.toolConfig;
    expect(forced).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["noop"] },
    });
    expect(build({ messages, tools, tool_choice: "required" }).env.request.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY" },
    });
    expect(build({ messages, tools, tool_choice: "none" }).env.request.toolConfig).toEqual({
      functionCallingConfig: { mode: "NONE" },
    });
    const allowed = build({
      messages,
      tools,
      tool_choice: {
        type: "allowed_tools",
        allowed_tools: {
          mode: "required",
          tools: [{ type: "function", function: { name: "noop" } }],
        },
      },
    }).env.request;
    expect(allowed.tools[0].functionDeclarations.map((d: { name: string }) => d.name)).toEqual([
      "noop",
    ]);
    expect(allowed.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    // No declarations on the wire -> no toolConfig (mode ANY without tools is a guaranteed 400).
    expect(
      build({ messages: [{ role: "user", content: "x" }], tool_choice: "required" }).env.request
        .toolConfig,
    ).toBeUndefined();
  });

  it("forces VALIDATED function calling for Claude, except for tool_choice none", () => {
    const tools = [{ type: "function", function: { name: "t", parameters: { type: "object" } } }];
    const messages = [{ role: "user", content: "x" }];
    const base = { messages, tools, model: "claude-sonnet-4-6" };
    expect(build(base).env.request.toolConfig).toEqual({
      functionCallingConfig: { mode: "VALIDATED" },
    });
    expect(build({ ...base, tool_choice: "required" }).env.request.toolConfig).toEqual({
      functionCallingConfig: { mode: "VALIDATED" },
    });
    const none = build({ ...base, tool_choice: "none" }).env.request;
    expect(none.tools).toBeUndefined();
    expect(none.toolConfig).toBeUndefined();
  });

  it("groups tool results after their call, repairs gaps and keeps ids pairable", () => {
    const call = (id: string, name: string) => ({
      id,
      type: "function",
      function: { name, arguments: "{}" },
    });
    const { env } = build({
      messages: [
        { role: "assistant", content: null, tool_calls: [call("a:1", "t1")] }, // history opens on a call
        { role: "tool", tool_call_id: "a:1", content: "r1" },
        { role: "user", content: "next" },
        {
          role: "assistant",
          content: "thinking out loud",
          tool_calls: [call("b", "t1"), call("c", "t2")],
        },
        { role: "tool", tool_call_id: "c", content: [{ type: "text", text: "rc" }] },
        { role: "tool", tool_call_id: "stray", content: "" },
      ],
    });
    const contents = env.request.contents;
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "(continue)" }] });
    const wireId = contents[1].parts[0].functionCall.id;
    expect(wireId).toMatch(/^a_1_[0-9a-f]{8}$/);
    expect(contents[2].parts[0].functionResponse).toEqual({
      name: "t1",
      response: { result: "r1" },
      id: wireId,
    });
    expect(contents[4].parts[0]).toEqual({ text: "thinking out loud" });
    expect(
      contents[5].parts.slice(0, 2).map((p: { functionResponse: unknown }) => p.functionResponse),
    ).toEqual([
      {
        name: "t1",
        response: { result: "[missing tool_result for this tool_use in history]" },
        id: "b",
      },
      { name: "t2", response: { result: "rc" }, id: "c" },
    ]);
    expect(contents[5].parts[2].text).toContain("tool_result without adjacent tool_use: stray");
    expect(contents[5].parts[2].text).toContain("(empty tool output)");
    expect(contents).toHaveLength(6); // already ends on a user turn: no extra nudge
  });

  it("appends a user turn to a history that ends on the model", () => {
    const { env } = build({
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    });
    expect(env.request.contents.map((c: { role: string }) => c.role)).toEqual([
      "user",
      "model",
      "user",
    ]);
  });

  it("maps response_format to structured output and refuses it where it cannot work", () => {
    const schema = { type: "object", properties: { a: { type: "string", pattern: "x" } } };
    const { env } = build({
      messages: [{ role: "user", content: "x" }],
      response_format: { type: "json_schema", json_schema: { name: "n", schema } },
    });
    // The output schema is the caller's: passed through unmodified, unlike tool parameters.
    expect(env.request.generationConfig).toEqual({
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    });
    expect(
      build({
        messages: [{ role: "user", content: "x" }],
        response_format: { type: "json_object" },
      }).env.request.generationConfig,
    ).toEqual({ responseMimeType: "application/json" });
    expect(() =>
      build({
        messages: [{ role: "user", content: "x" }],
        model: "claude-sonnet-4-6",
        response_format: { type: "json_object" },
      }),
    ).toThrow(/only supported for Gemini/);
    expect(() =>
      build({
        messages: [{ role: "user", content: "x" }],
        response_format: { type: "json_schema", json_schema: {} },
      }),
    ).toThrow(/schema is required/);
  });

  it("asks image models for image output", () => {
    const { env } = build({
      model: "gemini-3.1-flash-image",
      messages: [{ role: "user", content: "draw" }],
    });
    expect(env.request.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"] });
  });
});

describe("response mapping", () => {
  const sseOf = (frames: unknown[]) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  const part = (parts: unknown[], finishReason?: string, usageMetadata?: unknown) =>
    frame({
      candidates: [
        { content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) },
      ],
      ...(usageMetadata ? { usageMetadata } : {}),
    });

  it("decodes text, thoughts, function calls, usage and finish across arbitrary chunk boundaries", async () => {
    const text = sseOf([
      part([{ text: "Héllo € ", thought: false }]),
      part([{ text: "plan…", thought: true, thoughtSignature: SIG }]),
      part([{ text: "world" }, { functionCall: { name: "lookup", args: { q: "wörld" } } }]),
      part([], "STOP", USAGE),
    ]);
    for (const size of [1, 2, 3, 7, 64, 100_000]) {
      const chunks = await collect(chunksFromSse(chunked(text, size), mapperFor()));
      const deltas = chunks.flatMap((c) => c.choices.map((ch) => ch.delta));
      expect(
        deltas
          .map((d) => d.content)
          .filter(Boolean)
          .join(""),
      ).toBe("Héllo € world");
      expect(deltas.map((d) => d.reasoning_content).filter(Boolean)).toEqual(["plan…"]);
      const call = deltas.flatMap((d) => d.tool_calls ?? []);
      expect(call).toEqual([
        {
          index: 0,
          id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
          type: "function",
          function: { name: "lookup", arguments: '{"q":"wörld"}' },
        },
      ]);
      expect(chunks.at(-2)!.choices[0]!.finish_reason).toBe("tool_calls");
      expect(chunks.at(-1)).toMatchObject({
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      });
      expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    }
  });

  it("aggregates into a chat.completion", async () => {
    const completion = await aggregateChunks(
      chunksFromSse(
        chunked(
          sseOf([
            part([{ text: "a", thought: true }, { text: "b" }]),
            part(
              [{ functionCall: { name: "t", args: {} } }, { functionCall: { name: "u" } }],
              "STOP",
              USAGE,
            ),
          ]),
          5,
        ),
        mapperFor(),
      ),
    );
    expect(completion.choices[0]!).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        content: "b",
        reasoning_content: "a",
        tool_calls: [
          { type: "function", function: { name: "t", arguments: "{}" } },
          { type: "function", function: { name: "u", arguments: "{}" } },
        ],
      },
    });
    expect(completion.usage!.total_tokens).toBe(150);
  });

  it("maps finish reasons", async () => {
    const run = async (reason: string, parts: unknown[] = [{ text: "x" }]) =>
      (await collect(chunksFromSse(chunked(sseOf([part(parts, reason)]), 9), mapperFor())))
        .flatMap((c) => c.choices)
        .map((c) => c.finish_reason)
        .find(Boolean);
    expect(await run("STOP")).toBe("stop");
    expect(await run("MAX_TOKENS")).toBe("length");
    expect(await run("SAFETY")).toBe("content_filter");
    expect(await run("PROHIBITED_CONTENT")).toBe("content_filter");
    expect(await run("OTHER")).toBe("stop");
  });

  it("emits usage computed OpenAI-style: prompt includes cached, completion includes reasoning", async () => {
    const chunks = await collect(
      chunksFromSse(
        chunked(
          sseOf([
            part([{ text: "x" }], "STOP", {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              toolUsePromptTokenCount: 3,
              totalTokenCount: 18,
            }),
          ]),
          11,
        ),
        mapperFor(),
      ),
    );
    expect(chunks.at(-1)!.usage).toEqual({
      prompt_tokens: 13,
      completion_tokens: 5,
      total_tokens: 18,
    });
  });

  it("fails closed on truncation, missing terminal signal and upstream/structural errors", async () => {
    const run = (frames: unknown[] | string) =>
      collect(
        chunksFromSse(
          chunked(typeof frames === "string" ? frames : sseOf(frames), 13),
          mapperFor(),
        ),
      );
    await expect(
      run([part([{ functionCall: { name: "t", args: {} } }], "MAX_TOKENS")]),
    ).rejects.toThrow(/truncated/);
    await expect(run([part([], "MALFORMED_FUNCTION_CALL")])).rejects.toThrow(/truncated/);
    await expect(run([part([{ text: "cut off" }])])).rejects.toThrow(/without a terminal signal/);
    await expect(run([])).rejects.toThrow(/without a terminal signal/);
    await expect(run("data: {not json}\n\n")).rejects.toThrow(/malformed upstream SSE/);
    await expect(
      run([{ error: { message: "model overloaded", status: "UNAVAILABLE" } }]),
    ).rejects.toThrow("model overloaded");
    await expect(run([{ candidates: [] }])).rejects.toThrow(/missing response wrapper/);
    await expect(run([frame({ candidates: [null] })])).rejects.toThrow(/invalid candidate/);
    await expect(run([part([{ functionCall: { args: {} } }])])).rejects.toThrow(
      /invalid function call/,
    );
    await expect(run([frame({ promptFeedback: { blockReason: "SAFETY" } })])).rejects.toThrow(
      /blocked the prompt \(SAFETY\)/,
    );
    // MAX_TOKENS without a started call is an ordinary length stop; keep-alive padding is skipped.
    const ok = await run(
      `: keep-alive\n\ndata: null\n\n${sseOf([part([{ text: "x" }], "MAX_TOKENS")])}`,
    );
    expect(ok.flatMap((c) => c.choices).some((c) => c.finish_reason === "length")).toBe(true);
  });

  it("renders inline images as markdown data URLs", async () => {
    const chunks = await collect(
      chunksFromSse(
        chunked(
          sseOf([part([{ inlineData: { mimeType: "image/png", data: "QUJD" } }], "STOP")]),
          8,
        ),
        mapperFor(),
      ),
    );
    expect(
      chunks
        .flatMap((c) => c.choices)
        .map((c) => c.delta.content)
        .join(""),
    ).toContain("![image](data:image/png;base64,QUJD)");
  });
});

describe("thought-signature replay", () => {
  const messages = [
    { role: "user", content: "run the tool" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "lookup", arguments: '{"b":2,"a":1}' } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];
  const next = (model = "gemini-3.1-pro") =>
    JSON.parse(
      buildRequest({
        baseUrl: "https://x.test",
        token: "t",
        project: "p",
        body: { model, messages },
        stream: true,
      }).body,
    ).request;

  it("re-injects a signature seen in a response (carried from a thought part in an earlier frame)", async () => {
    const first = JSON.parse(
      buildRequest({
        baseUrl: "https://x.test",
        token: "t",
        project: "p",
        body: { model: "gemini-3.1-pro", messages: [messages[0]] },
        stream: true,
      }).body,
    ).request;
    const mapper = new GeminiMapper({
      model: "gemini-3.1-pro",
      wireModelId: "gemini-pro-agent",
      sessionId: first.sessionId,
      restoreToolName: (n) => n,
    });
    const body = [
      frame({
        candidates: [
          { content: { parts: [{ text: "hm", thought: true, thoughtSignature: SIG }] } },
        ],
      }),
      frame({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "lookup", args: { a: 1, b: 2 } } }] },
            finishReason: "STOP",
          },
        ],
      }),
    ];
    await collect(
      chunksFromSse(
        chunked(body.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), 17),
        mapper,
      ),
    );

    // Same call (argument order does not matter) in the next request's history gets its signature back.
    expect(next().contents[1].parts[0]).toEqual({
      functionCall: { name: "lookup", args: { b: 2, a: 1 }, id: "c1" },
      thoughtSignature: SIG,
    });
    // Another model/session has nothing to replay: the first call gets the documented bypass token.
    resetReplay();
    expect(next().contents[1].parts[0].thoughtSignature).toBe("skip_thought_signature_validator");
  });

  it("never fabricates the bypass token for non-Gemini models", () => {
    expect(next("claude-sonnet-4-6").contents[1].parts[0].thoughtSignature).toBeUndefined();
    expect(next("gpt-oss-120b-medium").contents[1].parts[0].thoughtSignature).toBeUndefined();
  });
});

describe("adapter.call", () => {
  const setup = () => {
    const google = fakeGoogle();
    const adapter = createAntigravityAdapter({ fetch: google.fetch });
    const call = (over: Partial<Parameters<typeof adapter.call>[0]> = {}) =>
      adapter.call({
        baseUrl: adapter.defaultBaseUrl!,
        token: "tok",
        meta: { project_id: "proj-1" },
        body: { model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] },
        stream: false,
        signal: new AbortController().signal,
        ...over,
      });
    return { google, adapter, call };
  };

  it("describes itself and is registered", () => {
    const { adapter } = setup();
    expect(ADAPTERS.antigravity).toBeDefined();
    expect(adapter).toMatchObject({
      type: "antigravity",
      label: "Google Antigravity",
      defaultBaseUrl: "https://daily-cloudcode-pa.googleapis.com",
    });
    expect(adapter.oauth!.label).toBeTruthy();
  });

  it("answers non-stream calls from generateContent and stream calls from streamGenerateContent", async () => {
    const { google, call } = setup();
    google.state.validTokens.add("tok");
    const json = await readJson(await call());
    expect(json).toMatchObject({
      object: "chat.completion",
      model: "gemini-3.8-flash",
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
    expect(google.generations()[0]!.url.pathname).toBe("/v1internal:generateContent");

    google.state.generate.push(
      sseResponse([
        frame({ candidates: [{ content: { parts: [{ text: "he" }] } }] }),
        frame({
          candidates: [{ content: { parts: [{ text: "llo" }] }, finishReason: "STOP" }],
          usageMetadata: USAGE,
        }),
      ]),
    );
    const res = await call({ stream: true });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(google.generations()[1]!.url.search).toBe("?alt=sse");
    expect(text).toContain('"content":"he"');
    expect(text).toContain('"content":"llo"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"total_tokens":150');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("returns upstream failures untouched so the gateway can classify them", async () => {
    const { google, call } = setup();
    google.state.validTokens.add("tok");
    const quota = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } };
    for (const [status, headers] of [
      [429, { "retry-after": "17" }],
      [403, {}],
      [500, {}],
      [503, {}],
    ] as const) {
      google.state.generate.push(Response.json(quota, { status, headers }));
      const res = await call();
      expect(res.status).toBe(status);
      expect(res.headers.get("retry-after")).toBe(
        headers["retry-after" as keyof typeof headers] ?? null,
      );
      expect(await res.json()).toEqual(quota);
    }
    expect((await call({ token: "revoked" })).status).toBe(401);
  });

  it("answers an unsupported request with a 400 without calling Google", async () => {
    const { google, call } = setup();
    const res = await call({
      body: { model: "claude-sonnet-4-6", messages: [], response_format: { type: "json_object" } },
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.type).toBe("invalid_request_error");
    expect(google.generations()).toHaveLength(0);
  });

  it("refuses an account without a project and rejects a malformed upstream body", async () => {
    const { google, call } = setup();
    google.state.validTokens.add("tok");
    await expect(call({ meta: {} })).rejects.toThrow(/no Cloud Code Assist project/);
    google.state.generate.push(new Response("<html>bad gateway</html>", { status: 200 }));
    await expect(call()).rejects.toThrow(/not valid JSON/);
  });
});

describe("through the gateway", () => {
  async function setup() {
    const clock = { now: 0 };
    const google = fakeGoogle(clock);
    const adapter = createAntigravityAdapter({
      fetch: google.fetch,
      now: () => clock.now,
      sleep: () => Promise.resolve(),
    });
    const h = createHarness({}, { adapters: { ...ADAPTERS, [adapter.type]: adapter } });
    Object.defineProperty(clock, "now", {
      get: () => h.clock.now,
      set: (v: number) => (h.clock.now = v),
    });
    expect((await h.admin("POST", "/providers", { id: "agy", type: "antigravity" })).status).toBe(
      201,
    );
    const key = await h.newKey();

    const started = await h.admin("POST", "/providers/agy/oauth/start", {});
    expect(started.status).toBe(201);
    expect(started.json.flow).toBe("paste");
    const authUrl = new URL(started.json.auth_url);
    const state = authUrl.searchParams.get("state")!;
    const sid = started.json.session_id as string;
    return { h, google, key, sid, state, authUrl, clock };
  }

  const chatBody = (extra: Record<string, unknown> = {}) => ({
    model: "agy/gemini-3.8-flash",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

  it("logs in by pasting the dead redirect URL, then serves stream and non-stream chats", async () => {
    const { h, google, key, sid, state } = await setup();
    expect(
      (await h.admin("GET", "/providers")).json.data.find((p: { id: string }) => p.id === "agy"),
    ).toMatchObject({
      base_url: "https://daily-cloudcode-pa.googleapis.com",
      oauth: true,
    });

    // A paste from a different sign-in is refused and leaves the session pending.
    const wrong = await h.admin("POST", `/oauth/sessions/${sid}/complete`, {
      input: "http://127.0.0.1:51121/callback?code=c&state=nope",
    });
    expect(wrong.status).toBe(400);
    expect((await h.admin("GET", `/oauth/sessions/${sid}`)).json.status).toBe("pending");
    expect(google.calls).toHaveLength(0);

    const done = await h.admin("POST", `/oauth/sessions/${sid}/complete`, {
      input: `http://127.0.0.1:51121/callback?state=${state}&code=4%2F0AbCd&scope=x`,
    });
    expect(done.json.status).toBe("complete");
    const [cred] = (await h.admin("GET", "/providers/agy/credentials")).json.data;
    expect(cred).toMatchObject({ status: "active", expires_at: h.clock.now + HOUR });
    expect(JSON.stringify(cred)).not.toContain("at-1");

    // Non-stream.
    const res = await h.chat(key.secret, chatBody({ reasoning_effort: "high" }));
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.choices[0].message.content).toBe("hello");
    expect(json.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 50 });
    const sent = google.generations().at(-1)!;
    expect(sent.headers.get("authorization")).toBe("Bearer at-1");
    expect(sent.body).toMatchObject({
      project: "proj-1",
      model: "gemini-3.8-flash-high",
      requestType: "agent",
    });

    // Stream (frames split inside the network chunks by the fake's single body).
    google.state.generate.push(
      sseResponse([
        frame({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }] } }] }),
        frame({ candidates: [{ content: { parts: [{ text: "str" }] } }] }),
        frame({
          candidates: [{ content: { parts: [{ text: "eam" }] }, finishReason: "STOP" }],
          usageMetadata: USAGE,
        }),
      ]),
    );
    const streamed = await h.chat(key.secret, chatBody({ stream: true }));
    expect(streamed.status).toBe(200);
    const text = await streamed.text();
    expect(text).toContain('"reasoning_content":"thinking"');
    expect(text).toContain('"content":"str"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(google.generations().at(-1)!.url.search).toBe("?alt=sse");

    const usage = (await h.admin("GET", "/usage/summary?group_by=provider")).json;
    expect(JSON.stringify(usage)).toContain("agy");
  });

  it("refreshes the access token shortly before expiry and after an upstream 401", async () => {
    const { h, google, key, sid, state, clock } = await setup();
    await h.admin("POST", `/oauth/sessions/${sid}/complete`, { input: `c#${state}` });
    expect((await h.chat(key.secret, chatBody())).status).toBe(200);
    expect(google.state.tokens).toBe(1);

    clock.now += HOUR - 30_000; // inside the refresh skew
    expect((await h.chat(key.secret, chatBody())).status).toBe(200);
    expect(google.state.tokens).toBe(2);
    expect(google.generations().at(-1)!.headers.get("authorization")).toBe("Bearer at-2");
    const refresh = google.calls.filter((c) => c.form?.get("grant_type") === "refresh_token");
    expect(refresh).toHaveLength(1);
    expect(refresh[0]!.form!.get("refresh_token")).toBe("rt-1");

    // Revoked early: the 401 triggers one refresh + retry, the account stays usable.
    google.state.validTokens.delete("at-2");
    expect((await h.chat(key.secret, chatBody())).status).toBe(200);
    expect(
      google
        .generations()
        .slice(-2)
        .map((c) => c.headers.get("authorization")),
    ).toEqual(["Bearer at-2", "Bearer at-3"]);
    expect((await h.admin("GET", "/providers/agy/credentials")).json.data[0].status).toBe("active");
  });

  it("retires the account when Google rejects the refresh token for good", async () => {
    const { h, google, key, sid, state, clock } = await setup();
    await h.admin("POST", `/oauth/sessions/${sid}/complete`, { input: `c#${state}` });
    google.state.tokenFailures.push(Response.json({ error: "invalid_grant" }, { status: 400 }));
    clock.now += HOUR;
    expect((await h.chat(key.secret, chatBody())).status).toBe(502);
    expect((await h.admin("GET", "/providers/agy/credentials")).json.data[0].status).toBe("dead");
  });

  it("passes a 429 through the gateway's cooldown classification", async () => {
    const { h, google, key, sid, state } = await setup();
    await h.admin("POST", `/oauth/sessions/${sid}/complete`, { input: `c#${state}` });
    google.state.generate.push(
      Response.json(
        { error: { status: "RESOURCE_EXHAUSTED" } },
        { status: 429, headers: { "retry-after": "120" } },
      ),
    );
    expect((await h.chat(key.secret, chatBody())).status).toBeGreaterThanOrEqual(429);
    const [cred] = (await h.admin("GET", "/providers/agy/credentials")).json.data;
    expect(cred.status).toBe("active");
    expect(cred.cooldown_until).toBe(h.clock.now + 120_000);
  });
});
