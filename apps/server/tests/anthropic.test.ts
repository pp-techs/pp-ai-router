import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  anthropicMessage,
  anthropicSse,
  createHarness,
  readJson,
  sse,
  startAnthropicUpstream,
  startUpstream,
} from "./harness.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A fake Anthropic upstream behind a router with one `anthropic` provider ("claude", credential k1). */
async function claude(handler: Parameters<typeof startAnthropicUpstream>[0]) {
  const up = await startAnthropicUpstream(handler);
  closers.push(up.close);
  const h = createHarness();
  const [credential] = await h.addProvider("claude", up.url, ["k1"], { type: "anthropic" });
  const key = await h.newKey();
  return { up, h, key, credential: credential! };
}

/** A fake OpenAI-compatible upstream behind a router with one provider ("acme", credential k1). */
async function acme(handler: Parameters<typeof startUpstream>[0]) {
  const up = await startUpstream(handler);
  closers.push(up.close);
  const h = createHarness();
  await h.addProvider("acme", up.url, ["k1"]);
  const key = await h.newKey();
  return { up, h, key };
}

const SONNET = "claude/claude-sonnet-4-5";

type Harness = ReturnType<typeof createHarness>;

interface ToolDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface Delta {
  content?: string;
  reasoning_content?: string;
  thinking_blocks?: unknown[];
  tool_calls?: ToolDelta[];
}
interface Chunk {
  choices: { delta: Delta; finish_reason: string | null }[];
}

async function credential(h: Harness, id: string) {
  const list: { id: string; status: string; cooldown_until: number | null }[] = (
    await h.admin("GET", "/providers/claude/credentials")
  ).json.data;
  return list.find((c) => c.id === id)!;
}

const chat = (h: Harness, key: { secret: string }, body: Record<string, unknown>) =>
  h.chat(key.secret, { model: SONNET, ...body });

/** Inbound Anthropic request, authenticated like the Anthropic SDK does. */
const messages = (
  h: Harness,
  key: { secret: string },
  body: Record<string, unknown>,
  headers: Record<string, string> = { "x-api-key": key.secret },
) =>
  h.services.app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...body }),
  });

/** Parses an SSE body into `{ event, data }` pairs (`data: [DONE]` is skipped). */
async function events(res: Response) {
  return (await res.text())
    .split("\n\n")
    .filter((block) => block.trim() && !block.includes("[DONE]"))
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const data = JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6));
      return { event, data };
    });
}

const usageRows = async (h: Harness, keyId: string) =>
  (await h.admin("GET", `/usage?key_id=${keyId}`)).json.data;

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Weather",
    parameters: { properties: { city: { type: "string" } }, required: ["city"] },
  },
};
const weatherSchema = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
};

describe("anthropic adapter: request mapping", () => {
  it("sends text, system, sampling and stop sequences exactly as Anthropic expects", async () => {
    const { up, h, key } = await claude(() => anthropicMessage([{ type: "text", text: "hello" }]));
    const res = await chat(h, key, {
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
      temperature: 1.7,
      top_p: 0.9,
      top_k: 40,
      stop: ["END", ""],
      user: "u-1",
    });

    expect(res.status).toBe(200);
    expect(up.calls[0]).toMatchObject({ secret: "k1", version: "2023-06-01" });
    expect(up.calls[0]!.body).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 8192,
      system: "Be brief.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stop_sequences: ["END"],
      temperature: 1, // clamped from 1.7; Sonnet 4.5 rejects temperature together with top_p, so top_p is dropped
      top_k: 40,
      metadata: { user_id: "u-1" },
    });
    const body = await readJson(res);
    expect(body.choices[0]).toMatchObject({
      message: { role: "assistant", content: "hello" },
      finish_reason: "stop",
    });
    expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("keeps both sampling parameters for models whose contract is unknown, and honours max_completion_tokens", async () => {
    const { up, h, key } = await claude(() => anthropicMessage([{ type: "text", text: "ok" }]));
    await h.chat(key.secret, {
      model: "claude/some-proxy-model",
      temperature: 0.5,
      top_p: 0.5,
      max_completion_tokens: 321,
    });
    expect(up.calls[0]!.body).toMatchObject({ max_tokens: 321, temperature: 0.5, top_p: 0.5 });
  });

  it("hoists system/developer messages and merges consecutive same-role turns", async () => {
    const { up, h, key } = await claude(() => anthropicMessage([{ type: "text", text: "ok" }]));
    await chat(h, key, {
      messages: [
        { role: "system", content: "s1" },
        { role: "developer", content: [{ type: "text", text: "s2" }] },
        { role: "user", content: "a" },
        { role: "user", content: [{ type: "text", text: "b" }] },
      ],
    });
    expect(up.calls[0]!.body.system).toBe("s1\n\ns2");
    expect(up.calls[0]!.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
  });

  it("maps tools, tool_choice and parallel_tool_calls", async () => {
    const { up, h, key } = await claude(() =>
      anthropicMessage(
        [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }],
        {
          stop_reason: "tool_use",
        },
      ),
    );
    const res = await chat(h, key, {
      tools: [weatherTool],
      tool_choice: { type: "function", function: { name: "get_weather" } },
      parallel_tool_calls: false,
    });

    expect(up.calls[0]!.body.tools).toEqual([
      { name: "get_weather", description: "Weather", input_schema: weatherSchema },
    ]);
    expect(up.calls[0]!.body.tool_choice).toEqual({
      type: "tool",
      name: "get_weather",
      disable_parallel_tool_use: true,
    });
    const choice = (await readJson(res)).choices[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);
  });

  it("maps tool_choice required/none/auto and flattens root-level anyOf schemas", async () => {
    const { up, h, key } = await claude(() => anthropicMessage([{ type: "text", text: "ok" }]));
    const tool = {
      type: "function",
      function: {
        name: "pick",
        parameters: {
          anyOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "number" } } },
          ],
        },
      },
    };
    await chat(h, key, { tools: [tool], tool_choice: "required" });
    await chat(h, key, { tools: [tool], tool_choice: "none" });
    await chat(h, key, { tools: [tool], tool_choice: "auto" });
    expect(up.calls.map((c) => c.body.tool_choice)).toEqual([
      { type: "any" },
      { type: "none" },
      { type: "auto" },
    ]);
    expect(up.calls[0]!.body.tools).toEqual([
      {
        name: "pick",
        input_schema: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "number" } },
        },
      },
    ]);
  });

  it("turns assistant tool_calls into tool_use and tool messages into tool_result blocks", async () => {
    const { up, h, key } = await claude(() => anthropicMessage([{ type: "text", text: "done" }]));
    await chat(h, key, {
      tools: [weatherTool],
      messages: [
        { role: "user", content: "Paris and Rome?" },
        {
          role: "assistant",
          content: "Checking.",
          tool_calls: [
            {
              id: "call:1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
            {
              id: "call_2",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Rome"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call:1", content: "18C" },
        { role: "tool", tool_call_id: "call_2", content: "25C" },
        { role: "user", content: "summarize" },
      ],
    });
    expect(up.calls[0]!.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Paris and Rome?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }, // ':' is not a legal id character
          { type: "tool_use", id: "call_2", name: "get_weather", input: { city: "Rome" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "18C" },
          { type: "tool_result", tool_use_id: "call_2", content: "25C" },
          { type: "text", text: "summarize" },
        ],
      },
    ]);
  });

  it("repairs histories Anthropic would reject: orphan tool results and unanswered tool calls", async () => {
    const { up, h, key } = await claude(() => anthropicMessage([{ type: "text", text: "ok" }]));
    await chat(h, key, {
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "a", type: "function", function: { name: "f", arguments: "" } }],
        },
        { role: "user", content: "never mind" },
        { role: "tool", tool_call_id: "zzz", content: "x" },
      ],
    });
    expect(up.calls[0]!.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "f", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "a",
            content: "[missing tool result for this tool call]",
            is_error: true,
          },
          { type: "text", text: "never mind" },
          { type: "text", text: "[result of unknown tool call zzz]" },
          { type: "text", text: "x" },
        ],
      },
    ]);
  });

  it("maps images (data URLs and http URLs) and passes cache_control through", async () => {
    const { up, h, key } = await claude(() => anthropicMessage([{ type: "text", text: "ok" }]));
    await chat(h, key, {
      tools: [{ ...weatherTool, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Long prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "look", cache_control: { type: "ephemeral" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
          ],
        },
      ],
    });
    const sent = up.calls[0]!.body;
    expect(sent.system).toEqual([
      { type: "text", text: "Long prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(sent.messages[0].content).toEqual([
      { type: "text", text: "look", cache_control: { type: "ephemeral" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "url", url: "https://example.com/cat.jpg" } },
    ]);
    expect(sent.tools[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("answers content it cannot translate with Anthropic's 400, without calling upstream", async () => {
    const { up, h, key } = await claude(() => anthropicMessage([{ type: "text", text: "ok" }]));
    const res = await chat(h, key, {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "file:///etc/passwd" } }],
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
    expect(up.calls).toHaveLength(0);
  });

  describe("thinking", () => {
    const run = async (model: string, body: Record<string, unknown>) => {
      const { up, h, key } = await claude(() => anthropicMessage([{ type: "text", text: "ok" }]));
      await h.chat(key.secret, { model, ...body });
      return up.calls[0]!.body;
    };

    it("derives a manual budget from reasoning_effort and drops sampling parameters", async () => {
      const sent = await run(SONNET, { reasoning_effort: "high", temperature: 0.3 });
      expect(sent.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
      expect(sent.max_tokens).toBe(16384 + 8192);
      expect(sent).not.toHaveProperty("temperature");
    });

    it("uses adaptive thinking plus an effort on models that reject manual budgets", async () => {
      const sent = await run("claude/claude-sonnet-5", {
        reasoning_effort: "medium",
        temperature: 0.3,
      });
      expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(sent.output_config).toEqual({ effort: "medium" });
      expect(sent).not.toHaveProperty("temperature");
    });

    it("keeps an explicit thinking budget and skips derived ones that would not fit", async () => {
      const explicit = await run(SONNET, {
        thinking: { type: "enabled", budget_tokens: 2048 },
        max_tokens: 4096,
      });
      expect(explicit.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
      expect(explicit.max_tokens).toBe(4096);

      const tooSmall = await run(SONNET, { reasoning_effort: "high", max_tokens: 2000 });
      expect(tooSmall).not.toHaveProperty("thinking");
      expect(tooSmall.max_tokens).toBe(2000);
    });

    const toolHistory = (extra: Record<string, unknown>) => [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
        ...extra,
      },
      { role: "tool", tool_call_id: "t1", content: "sunny" },
    ];

    it("replays signed thinking blocks, and drops thinking when history cannot satisfy the replay rule", async () => {
      const signed = await run(SONNET, {
        reasoning_effort: "low",
        messages: toolHistory({
          reasoning_content: "hmm",
          thinking_blocks: [{ type: "thinking", thinking: "hmm", signature: "sig-123" }],
        }),
      });
      expect(signed.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
      expect(signed.messages[1].content[0]).toEqual({
        type: "thinking",
        thinking: "hmm",
        signature: "sig-123",
      });

      const unsigned = await run(SONNET, {
        reasoning_effort: "low",
        messages: toolHistory({ reasoning_content: "hmm" }),
      });
      expect(unsigned).not.toHaveProperty("thinking");
    });
  });
});

describe("anthropic adapter: response mapping", () => {
  it("maps thinking, text, tool calls and cache usage, and bills them", async () => {
    const { up, h, key } = await claude(() =>
      anthropicMessage(
        [
          { type: "thinking", thinking: "plan", signature: "SIG" },
          { type: "text", text: "ok" },
          { type: "tool_use", id: "toolu_9", name: "get_weather", input: { city: "Rome" } },
        ],
        {
          stop_reason: "tool_use",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
          },
        },
      ),
    );
    await h.admin("PUT", "/pricing/overrides", {
      model: SONNET,
      input_per_1m: 10,
      output_per_1m: 20,
      cache_read_per_1m: 1,
      cache_write_per_1m: 12.5,
    });

    const res = await chat(h, key, { tools: [weatherTool] });
    expect(up.calls).toHaveLength(1);
    const body = await readJson(res);
    const message = body.choices[0].message;
    expect(message.reasoning_content).toBe("plan");
    expect(message.thinking_blocks).toEqual([
      { type: "thinking", thinking: "plan", signature: "SIG" },
    ]);
    expect(message.content).toBe("ok");
    expect(message.tool_calls[0].function).toEqual({
      name: "get_weather",
      arguments: '{"city":"Rome"}',
    });
    // OpenAI semantics: prompt_tokens includes cache reads and writes; Anthropic's input_tokens does not.
    expect(body.usage).toEqual({
      prompt_tokens: 150,
      completion_tokens: 20,
      total_tokens: 170,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
    });

    const [event] = await usageRows(h, key.id);
    expect(event).toMatchObject({
      input_tokens: 150,
      output_tokens: 20,
      cached_tokens: 40,
      cache_write_tokens: 10,
      status: "ok",
      price_source: "override",
    });
    // 100 fresh @ $10 + 40 cache reads @ $1 + 10 cache writes @ $12.5 + 20 out @ $20, per 1M
    expect(event.cost_usd).toBeCloseTo(0.001565, 9);
  });

  it("maps stop reasons", async () => {
    const reasons: Record<string, string> = {
      end_turn: "stop",
      stop_sequence: "stop",
      max_tokens: "length",
      tool_use: "tool_calls",
      refusal: "content_filter",
    };
    const { h, key } = await claude((_c, n) =>
      anthropicMessage([{ type: "text", text: "x" }], {
        stop_reason: Object.keys(reasons)[n - 1]!,
      }),
    );
    for (const expected of Object.values(reasons)) {
      expect((await readJson(await chat(h, key, {}))).choices[0].finish_reason).toBe(expected);
    }
  });

  it("streams thinking, text and tool calls as OpenAI chunks with usage last, and bills the stream", async () => {
    const { up, h, key } = await claude(() =>
      anthropicSse([
        [
          "message_start",
          {
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 5 },
            },
          },
        ],
        ["ping", {}],
        ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }],
        ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "a" } }],
        ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "b" } }],
        ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "SIG" } }],
        ["content_block_stop", { index: 0 }],
        ["content_block_start", { index: 1, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { index: 1, delta: { type: "text_delta", text: "Hel" } }],
        ["content_block_delta", { index: 1, delta: { type: "text_delta", text: "lo" } }],
        ["content_block_stop", { index: 1 }],
        [
          "content_block_start",
          {
            index: 2,
            content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
          },
        ],
        [
          "content_block_delta",
          { index: 2, delta: { type: "input_json_delta", partial_json: '{"city":' } },
        ],
        [
          "content_block_delta",
          { index: 2, delta: { type: "input_json_delta", partial_json: '"Paris"}' } },
        ],
        ["content_block_stop", { index: 2 }],
        [
          "content_block_start",
          { index: 3, content_block: { type: "tool_use", id: "toolu_2", name: "noop", input: {} } },
        ],
        ["content_block_stop", { index: 3 }],
        ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 15 } }],
        ["message_stop", {}],
      ]),
    );

    const res = await chat(h, key, { stream: true, tools: [weatherTool] });
    expect(up.calls[0]!.body.stream).toBe(true);
    const text = await res.text();
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    const chunks: Chunk[] = text
      .split("\n\n")
      .filter((b) => b.startsWith("data: {"))
      .map((b) => JSON.parse(b.slice(6)));

    const deltas = chunks.flatMap((c) => c.choices.map((ch) => ch.delta));
    expect(deltas.map((d) => d.reasoning_content ?? "").join("")).toBe("ab");
    expect(deltas.map((d) => d.content ?? "").join("")).toBe("Hello");
    expect(deltas.find((d) => d.thinking_blocks)!.thinking_blocks).toEqual([
      { type: "thinking", thinking: "ab", signature: "SIG" },
    ]);
    const calls = deltas.flatMap((d) => d.tool_calls ?? []);
    expect(calls[0]).toMatchObject({ index: 0, id: "toolu_1", function: { name: "get_weather" } });
    const argsOf = (index: number) =>
      calls
        .filter((c) => c.index === index)
        .map((c) => c.function?.arguments ?? "")
        .join("");
    expect(argsOf(0)).toBe('{"city":"Paris"}');
    expect(argsOf(1)).toBe("{}"); // a tool without parameters still gets valid JSON arguments
    expect(chunks.find((c) => c.choices[0]?.finish_reason)!.choices[0]!.finish_reason).toBe(
      "tool_calls",
    );
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: {
        prompt_tokens: 30,
        completion_tokens: 15,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    });

    const [event] = await usageRows(h, key.id);
    expect(event).toMatchObject({
      input_tokens: 30,
      output_tokens: 15,
      cached_tokens: 5,
      stream: 1,
      status: "ok",
    });
  });

  it("surfaces a mid-stream Anthropic error as an SSE error event", async () => {
    const { h, key } = await claude(() =>
      anthropicSse([
        [
          "message_start",
          {
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              model: "c",
              content: [],
              usage: {},
            },
          },
        ],
        ["error", { error: { type: "overloaded_error", message: "Overloaded" } }],
      ]),
    );
    const text = await (await chat(h, key, { stream: true })).text();
    expect(text).toContain("Overloaded");
    expect(text).toContain('"error"');
  });
});

describe("anthropic adapter: failure classification", () => {
  const error = (type: string, status: number, headers: Record<string, string> = {}) =>
    Response.json({ type: "error", error: { type, message: type } }, { status, headers });

  it("cools a credential down on 429 (Retry-After) and fails over", async () => {
    const up = await startAnthropicUpstream((c) =>
      c.secret === "k1"
        ? error("rate_limit_error", 429, { "retry-after": "120" })
        : anthropicMessage([{ type: "text", text: "ok" }]),
    );
    closers.push(up.close);
    const h = createHarness();
    const [a] = await h.addProvider("claude", up.url, ["k1", "k2"], {
      type: "anthropic",
      key_strategy: "fill_first",
    });
    await h.admin("PATCH", `/credentials/${a}`, { priority: -1 });
    const key = await h.newKey();

    expect((await chat(h, key, {})).status).toBe(200);
    expect(up.calls.map((c) => c.secret)).toEqual(["k1", "k2"]);
    const cred = await credential(h, a!);
    expect(cred.cooldown_until).toBe(h.clock.now + 120_000);
  });

  it("retires a credential on 401 and fails over", async () => {
    const up = await startAnthropicUpstream((c) =>
      c.secret === "k1"
        ? error("authentication_error", 401)
        : anthropicMessage([{ type: "text", text: "ok" }]),
    );
    closers.push(up.close);
    const h = createHarness();
    const [a] = await h.addProvider("claude", up.url, ["k1", "k2"], {
      type: "anthropic",
      key_strategy: "fill_first",
    });
    await h.admin("PATCH", `/credentials/${a}`, { priority: -1 });
    const key = await h.newKey();

    expect((await chat(h, key, {})).status).toBe(200);
    await chat(h, key, {});
    expect(up.calls.filter((c) => c.secret === "k1")).toHaveLength(1);
    const dead = await credential(h, a!);
    expect(dead.status).toBe("dead");
  });

  it("returns 502 once every credential has failed, and passes a 400 through untouched", async () => {
    const { h, key } = await claude((_c, n) =>
      n === 1 ? error("invalid_request_error", 400) : error("overloaded_error", 529),
    );
    const bad = await chat(h, key, {});
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error).toMatchObject({ type: "invalid_request_error" });

    const down = await chat(h, key, {});
    expect(down.status).toBe(502);
    expect((await readJson(down)).error.code).toBe("upstream_error");
  });

  it("treats a 200 that is not a Message as a failed attempt", async () => {
    const { h, key } = await claude(() => Response.json({ hello: "world" }));
    expect((await chat(h, key, {})).status).toBe(502);
  });
});

describe("POST /v1/messages -> openai-compat upstream", () => {
  const openAiReply = () =>
    Response.json({
      id: "c1",
      object: "chat.completion",
      model: "gpt-x",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Sure",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    });

  it("translates the request, the response and a tool-call round trip, and accounts the call", async () => {
    const { up, h, key } = await acme(openAiReply);
    const tool = {
      name: "get_weather",
      description: "Weather",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    };

    const first = await messages(h, key, {
      model: "acme/gpt-x",
      max_tokens: 256,
      system: [{ type: "text", text: "Be brief." }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "weather?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
      temperature: 0.2,
      stop_sequences: ["END"],
      tools: [tool],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      metadata: { user_id: "u1" },
    });

    expect(first.status).toBe(200);
    expect(up.calls[0]!.secret).toBe("k1");
    expect(up.calls[0]!.body).toEqual({
      model: "gpt-x",
      max_tokens: 256,
      messages: [
        { role: "system", content: "Be brief." },
        {
          role: "user",
          content: [
            { type: "text", text: "weather?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
      temperature: 0.2,
      stop: ["END"],
      user: "u1",
      tools: [
        {
          type: "function",
          function: { name: "get_weather", description: "Weather", parameters: tool.input_schema },
        },
      ],
      tool_choice: "required",
      parallel_tool_calls: false,
    });
    const message = await readJson(first);
    expect(message).toMatchObject({
      type: "message",
      role: "assistant",
      model: "acme/gpt-x",
      content: [
        { type: "text", text: "Sure" },
        { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 100, // Anthropic's input_tokens excludes the 20 cached tokens
        output_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
      },
    });
    expect(message.id).toMatch(/^msg_/);

    const second = await messages(h, key, {
      model: "acme/gpt-x",
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: message.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [{ type: "text", text: "sunny" }],
            },
            { type: "text", text: "thanks" },
          ],
        },
      ],
    });
    expect(second.status).toBe(200);
    expect(up.calls[1]!.body.messages).toEqual([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "Sure",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
      { role: "user", content: "thanks" },
    ]);

    const rows = await usageRows(h, key.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      model: "acme/gpt-x",
      input_tokens: 120,
      output_tokens: 30,
      cached_tokens: 20,
      status: "ok",
    });
  });

  it("authenticates with a Bearer token too", async () => {
    const { h, key } = await acme(openAiReply);
    const res = await messages(
      h,
      key,
      { model: "acme/gpt-x" },
      { authorization: `Bearer ${key.secret}` },
    );
    expect(res.status).toBe(200);
  });

  it("streams text and tool calls as Anthropic SSE events, with usage in message_delta", async () => {
    const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        model: "gpt-x",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...extra,
      })}\n\n`;
    const { up, h, key } = await acme(() =>
      sse([
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "Hel" }),
        chunk({ content: "lo" }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
        chunk({}, "tool_calls"),
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "gpt-x",
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );

    const res = await messages(h, key, { model: "acme/gpt-x", stream: true });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(up.calls[0]!.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });

    const seen = await events(res);
    expect(seen.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(seen.every((e) => e.data.type === e.event)).toBe(true);
    expect(seen[0]!.data.message).toMatchObject({
      type: "message",
      role: "assistant",
      model: "acme/gpt-x",
      content: [],
      stop_reason: null,
    });
    expect(seen[1]!.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    expect(seen[2]!.data.delta).toEqual({ type: "text_delta", text: "Hel" });
    expect(seen[5]!.data).toEqual({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
    });
    expect(seen[6]!.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"city":' });
    expect(seen[9]!.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
      },
    });

    const [event] = await usageRows(h, key.id);
    expect(event).toMatchObject({ input_tokens: 120, output_tokens: 30, stream: 1, status: "ok" });
  });

  it("turns an upstream stream error into an Anthropic error event", async () => {
    const { h, key } = await acme(() =>
      sse([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ error: { message: "boom", type: "upstream_error" } })}\n\n`,
      ]),
    );
    const seen = await events(await messages(h, key, { model: "acme/m", stream: true }));
    expect(seen.at(-1)).toEqual({
      event: "error",
      data: { type: "error", error: { type: "api_error", message: "boom" } },
    });
    expect(seen.map((e) => e.event)).not.toContain("message_stop");
  });

  it("maps reasoning_content to thinking blocks", async () => {
    const { h, key } = await acme(() =>
      Response.json({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "42", reasoning_content: "let me think" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const message = await readJson(await messages(h, key, { model: "acme/m" }));
    expect(message.content).toEqual([
      { type: "thinking", thinking: "let me think", signature: "" },
      { type: "text", text: "42" },
    ]);
    expect(message.stop_reason).toBe("end_turn");
  });
});

describe("POST /v1/messages -> anthropic upstream", () => {
  const upstreamContent = [
    { type: "thinking", thinking: "plan", signature: "SIG" },
    { type: "text", text: "Checking" },
    { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
  ];
  const usage = {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 10,
  };
  const tool = {
    name: "get_weather",
    description: "Weather",
    input_schema: weatherSchema,
    cache_control: { type: "ephemeral" },
  };

  it("round-trips a thinking + tool-use conversation with signatures, cache_control and usage intact", async () => {
    const { up, h, key } = await claude(() =>
      anthropicMessage(upstreamContent, { stop_reason: "tool_use", usage }),
    );
    const res = await messages(h, key, {
      model: SONNET,
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 2048 },
      system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
      tools: [tool],
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hm", signature: "SIGNATURE" },
            { type: "text", text: "Checking" },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }],
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(up.calls[0]!.body).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 2048 },
      system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
      tools: [tool],
      messages: [
        { role: "user", content: [{ type: "text", text: "weather?" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hm", signature: "SIGNATURE" },
            { type: "text", text: "Checking" },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }],
        },
      ],
    });
    expect(await readJson(res)).toMatchObject({
      type: "message",
      model: SONNET,
      content: upstreamContent,
      stop_reason: "tool_use",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      },
    });
    const [event] = await usageRows(h, key.id);
    expect(event).toMatchObject({ input_tokens: 150, cached_tokens: 40, cache_write_tokens: 10 });
  });

  it("streams thinking (with its signature), text and tool_use as Anthropic SSE", async () => {
    const { up, h, key } = await claude(() =>
      anthropicSse([
        [
          "message_start",
          {
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40 },
            },
          },
        ],
        ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }],
        ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "plan" } }],
        ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "SIG" } }],
        ["content_block_stop", { index: 0 }],
        ["content_block_start", { index: 1, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { index: 1, delta: { type: "text_delta", text: "Checking" } }],
        ["content_block_stop", { index: 1 }],
        [
          "content_block_start",
          {
            index: 2,
            content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
          },
        ],
        [
          "content_block_delta",
          { index: 2, delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' } },
        ],
        ["content_block_stop", { index: 2 }],
        [
          "message_delta",
          {
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 20, cache_creation_input_tokens: 10 },
          },
        ],
        ["message_stop", {}],
      ]),
    );

    const res = await messages(h, key, { model: SONNET, stream: true, tools: [tool] });
    expect(up.calls[0]!.body.stream).toBe(true);
    const seen = await events(res);
    expect(
      seen.map((e) => [
        e.event,
        e.data.index ?? null,
        e.data.delta?.type ?? e.data.content_block?.type ?? null,
      ]),
    ).toEqual([
      ["message_start", null, null],
      ["content_block_start", 0, "thinking"],
      ["content_block_delta", 0, "thinking_delta"],
      ["content_block_delta", 0, "signature_delta"],
      ["content_block_stop", 0, null],
      ["content_block_start", 1, "text"],
      ["content_block_delta", 1, "text_delta"],
      ["content_block_stop", 1, null],
      ["content_block_start", 2, "tool_use"],
      ["content_block_delta", 2, "input_json_delta"],
      ["content_block_stop", 2, null],
      ["message_delta", null, null],
      ["message_stop", null, null],
    ]);
    expect(seen[2]!.data.delta.thinking).toBe("plan");
    expect(seen[3]!.data.delta.signature).toBe("SIG");
    expect(seen[9]!.data.delta.partial_json).toBe('{"city":"Paris"}');
    expect(seen[11]!.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 40,
      },
    });
    const [event] = await usageRows(h, key.id);
    expect(event).toMatchObject({
      input_tokens: 150,
      cached_tokens: 40,
      cache_write_tokens: 10,
      stream: 1,
    });
  });
});

describe("POST /v1/messages errors use Anthropic's envelope", () => {
  const envelope = (type: string) => ({
    type: "error",
    error: { type, message: expect.any(String) },
  });

  it("covers authentication, authorization, routing, limits and validation", async () => {
    const { up, h, key } = await acme(() => Response.json({ choices: [], usage: {} }));
    const limited = await h.newKey({ limits: [{ metric: "requests", window: "1h", max: 1 }] });
    const narrow = await h.newKey({ allowed_models: ["acme/cheap-*"] });

    const unauthenticated = await messages(
      h,
      key,
      { model: "acme/m" },
      { "x-api-key": "sk-pp-nope" },
    );
    expect(unauthenticated.status).toBe(401);
    expect(await readJson(unauthenticated)).toEqual(envelope("authentication_error"));

    const denied = await messages(h, narrow, { model: "acme/expensive" });
    expect(denied.status).toBe(403);
    expect(await readJson(denied)).toEqual(envelope("permission_error"));

    const unknown = await messages(h, key, { model: "ghost/model" });
    expect(unknown.status).toBe(404);
    expect(await readJson(unknown)).toEqual(envelope("not_found_error"));

    expect((await messages(h, limited, { model: "acme/m" })).status).toBe(200);
    const exhausted = await messages(h, limited, { model: "acme/m" });
    expect(exhausted.status).toBe(429);
    expect(await readJson(exhausted)).toEqual(envelope("rate_limit_error"));
    expect(exhausted.headers.get("retry-after")).not.toBeNull();

    const invalid = await messages(h, key, { model: "acme/m", max_tokens: undefined });
    expect(invalid.status).toBe(400);
    expect(await readJson(invalid)).toEqual(envelope("invalid_request_error"));

    const serverTool = await messages(h, key, {
      model: "acme/m",
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    expect(serverTool.status).toBe(400);
    expect(await readJson(serverTool)).toEqual(envelope("invalid_request_error"));
    expect(up.calls).toHaveLength(1);
  });

  it("converts upstream failures: a passed-through 4xx and an exhausted pool", async () => {
    const { h, key } = await acme((_c, n) =>
      n === 1
        ? Response.json(
            { error: { message: "bad param", type: "invalid_request_error" } },
            { status: 400 },
          )
        : new Response("overloaded", { status: 503 }),
    );
    const bad = await messages(h, key, { model: "acme/m" });
    expect(bad.status).toBe(400);
    expect(await readJson(bad)).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "bad param" },
    });

    const down = await messages(h, key, { model: "acme/m" });
    expect(down.status).toBe(502);
    expect(await readJson(down)).toEqual({
      type: "error",
      error: { type: "api_error", message: expect.stringContaining("upstream 503") },
    });
  });

  it("passes an Anthropic upstream's own error envelope straight through", async () => {
    const { h, key } = await claude(() =>
      Response.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "max_tokens too large" },
        },
        { status: 400 },
      ),
    );
    const res = await messages(h, key, { model: SONNET });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "max_tokens too large" },
    });
  });

  it("leaves /v1/chat/completions errors in the OpenAI shape", async () => {
    const { h } = await acme(() => Response.json({ choices: [], usage: {} }));
    const res = await h.chat("sk-pp-nope", { model: "acme/m" });
    expect(res.status).toBe(401);
    expect((await readJson(res)).error).toMatchObject({ code: "invalid_api_key" });
  });
});

describe("admin", () => {
  it("lists the anthropic provider type with its default base URL", async () => {
    const h = createHarness();
    const types: { type: string }[] = (await h.admin("GET", "/provider-types")).json.data;
    expect(types.find((t) => t.type === "anthropic")).toMatchObject({
      label: "Anthropic",
      default_base_url: "https://api.anthropic.com/v1",
      oauth: null,
    });
    const created = await h.admin("POST", "/providers", { id: "claude", type: "anthropic" });
    expect(created.status).toBe(201);
    const listed: { id: string; base_url: string }[] = (await h.admin("GET", "/providers")).json
      .data;
    expect(listed.find((p) => p.id === "claude")!.base_url).toBe("https://api.anthropic.com/v1");
  });
});
