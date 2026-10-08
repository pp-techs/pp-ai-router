import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { OAuthRefreshError } from "../src/oauth/types.ts";
import { ADAPTERS, type ProviderAdapter } from "../src/providers/adapter.ts";
import {
  aggregateChunks,
  parseSse,
  type ChatCompletion,
  type OpenAIChunk,
} from "../src/providers/chunks.ts";
import { createKiroAdapter } from "../src/providers/kiro/adapter.ts";
import { decodeEventStream } from "../src/providers/kiro/eventstream.ts";
import { createKiroOAuth } from "../src/providers/kiro/oauth.ts";
import { buildKiroRequest, KiroRequestError } from "../src/providers/kiro/request.ts";
import { kiroChunks } from "../src/providers/kiro/stream.ts";
import {
  requestHeaders,
  resolveApiRegion,
  resolveIdentity,
  runtimeEndpoint,
} from "../src/providers/kiro/wire.ts";
import { createHarness } from "./harness.ts";

interface WireMessage {
  content: string;
  modelId: string;
  origin: string;
  images?: { format: string; source: { bytes: string } }[];
  userInputMessageContext?: {
    tools?: { toolSpecification: { name: string } }[];
    toolResults?: unknown[];
  };
}
interface WireEntry {
  userInputMessage?: WireMessage;
  assistantResponseMessage?: { content: string; toolUses?: unknown[] };
}
interface WirePayload {
  profileArn?: string;
  additionalModelRequestFields?: unknown;
  conversationState: {
    chatTriggerType: string;
    agentTaskType?: string;
    agentContinuationId?: string;
    conversationId: string;
    currentMessage: { userInputMessage: WireMessage };
    history?: WireEntry[];
  };
}
/** Typed read-only view of a built payload for assertions; the assertions themselves check the shape. */
const wire = (payload: Record<string, unknown>) => payload as unknown as WirePayload;

interface ErrorBody {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------------------------
// AWS event-stream ENCODER (test-only): [total u32][headers len u32][prelude crc][headers][payload][crc]
// ---------------------------------------------------------------------------------------------

const strHeader = (name: string, value: string): Buffer => {
  const n = Buffer.from(name);
  const v = Buffer.from(value);
  const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
  out.writeUInt8(n.length, 0);
  n.copy(out, 1);
  out.writeUInt8(7, 1 + n.length);
  out.writeUInt16BE(v.length, 2 + n.length);
  v.copy(out, 4 + n.length);
  return out;
};

function frameWith(headerBytes: Buffer, payload: Buffer): Buffer {
  const total = 12 + headerBytes.length + payload.length + 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(headerBytes.length, 4);
  out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  headerBytes.copy(out, 12);
  payload.copy(out, 12 + headerBytes.length);
  out.writeUInt32BE(crc32(out.subarray(0, total - 4)), total - 4);
  return out;
}

function frame(headers: Record<string, string>, payload: string): Buffer {
  return frameWith(
    Buffer.concat(Object.entries(headers).map(([k, v]) => strHeader(k, v))),
    Buffer.from(payload),
  );
}

const event = (type: string, body: unknown): Buffer =>
  frame(
    { ":event-type": type, ":content-type": "application/json", ":message-type": "event" },
    JSON.stringify(body),
  );

const exception = (type: string, body: unknown): Buffer =>
  frame(
    { ":exception-type": type, ":content-type": "application/json", ":message-type": "exception" },
    JSON.stringify(body),
  );

const text = (content: string) => event("assistantResponseEvent", { content });
const metadata = (body: Record<string, unknown>) => event("metadataEvent", body);
const usageBody = {
  tokenUsage: {
    uncachedInputTokens: 30,
    cacheReadInputTokens: 10,
    cacheWriteInputTokens: 2,
    outputTokens: 5,
    totalTokens: 47,
  },
};

/** Splits the concatenated frames into chunks of the given sizes (cycled): arbitrary network boundaries. */
function bodyOf(frames: Buffer[], sizes: number[] = [1 << 20]): ReadableStream<Uint8Array> {
  const all = Buffer.concat(frames);
  const parts: Uint8Array[] = [];
  for (let offset = 0, i = 0; offset < all.length; i++) {
    const size = sizes[i % sizes.length]!;
    parts.push(all.subarray(offset, offset + size));
    offset += size;
  }
  return ReadableStream.from(parts);
}

async function collect(chunks: AsyncIterable<OpenAIChunk>): Promise<OpenAIChunk[]> {
  const out: OpenAIChunk[] = [];
  for await (const c of chunks) out.push(c);
  return out;
}

const ctx = {
  model: "claude-sonnet-4.5",
  nameMap: new Map<string, string>(),
  estimatedInputTokens: 123,
};

// ---------------------------------------------------------------------------------------------
// Event-stream decoding
// ---------------------------------------------------------------------------------------------

describe("event-stream decoder", () => {
  const frames = [text("Hello"), text(" wörld 🌍"), metadata({ stopReason: "END_TURN" })];

  it("decodes frames however the bytes are split", async () => {
    for (const sizes of [[1 << 20], [1], [3, 5, 7], [11, 1, 2, 19]]) {
      const out: string[] = [];
      for await (const m of decodeEventStream(bodyOf(frames, sizes))) {
        expect(m.headers[":message-type"]).toBe("event");
        out.push(`${m.headers[":event-type"]}:${Buffer.from(m.payload).toString()}`);
      }
      expect(out).toEqual([
        'assistantResponseEvent:{"content":"Hello"}',
        'assistantResponseEvent:{"content":" wörld 🌍"}',
        'metadataEvent:{"stopReason":"END_TURN"}',
      ]);
    }
  });

  it("parses every header value type", async () => {
    const headers = Buffer.concat([
      Buffer.from([4, ...Buffer.from("bool"), 0]), // true
      Buffer.from([2, ...Buffer.from("no"), 1]), // false
      Buffer.from([1, ...Buffer.from("b"), 2, 0xfe]), // byte -2
      Buffer.from([1, ...Buffer.from("s"), 3, 0xff, 0xfe]), // short -2
      Buffer.from([1, ...Buffer.from("i"), 4, 0, 0, 1, 0]), // int 256
      Buffer.from([1, ...Buffer.from("l"), 5, 0, 0, 0, 0, 0, 0, 1, 0]), // long 256
      Buffer.from([1, ...Buffer.from("x"), 6, 0, 2, 1, 2]), // bytes
      Buffer.from([1, ...Buffer.from("t"), 8, 0, 0, 0, 0, 0, 0, 0, 0]), // timestamp epoch
      Buffer.from([1, ...Buffer.from("u"), 9, ...Array.from({ length: 16 }, (_, i) => i)]), // uuid
      strHeader("str", "v"),
    ]);
    const [m] = await collect2(decodeEventStream(bodyOf([frameWith(headers, Buffer.from("{}"))])));
    expect(m!.headers).toEqual({
      bool: "true",
      no: "false",
      b: "-2",
      s: "-2",
      i: "256",
      l: "256",
      x: "AQI=",
      t: "1970-01-01T00:00:00.000Z",
      u: "00010203-0405-0607-0809-0a0b0c0d0e0f",
      str: "v",
    });
  });

  it("rejects a corrupt prelude CRC, a corrupt message CRC and a stream cut mid-frame", async () => {
    const good = text("x");

    const badPrelude = Buffer.from(good);
    badPrelude[8] = badPrelude[8]! ^ 0xff;
    await expect(collect2(decodeEventStream(bodyOf([badPrelude])))).rejects.toThrow(
      "prelude CRC mismatch",
    );

    const badMessage = Buffer.from(good);
    badMessage[badMessage.length - 1] = badMessage[badMessage.length - 1]! ^ 0xff;
    await expect(collect2(decodeEventStream(bodyOf([badMessage])))).rejects.toThrow(
      "message CRC mismatch",
    );

    const badPayload = Buffer.from(good);
    badPayload[badPayload.length - 6] = badPayload[badPayload.length - 6]! ^ 0xff;
    await expect(collect2(decodeEventStream(bodyOf([badPayload])))).rejects.toThrow(
      "message CRC mismatch",
    );

    await expect(
      collect2(decodeEventStream(bodyOf([good.subarray(0, good.length - 3)]))),
    ).rejects.toThrow("truncated message at end of stream");
  });
});

async function collect2<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------------------------

const IDE = {
  wireClient: "ide",
  profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC",
  apiKey: false,
} as const;
const CLI = { wireClient: "cli", profileArn: undefined, apiKey: false } as const;

const weatherTool = {
  type: "function",
  function: {
    name: "get weather",
    description: "Weather",
    parameters: {
      type: "object",
      $schema: "x",
      properties: {
        city: { type: "string", format: "city", minLength: 1 },
        format: { type: "string" },
      },
      additionalProperties: false,
      required: [],
    },
  },
};

describe("request building", () => {
  it("builds history, system prompt, tools, tool calls/results and the model id", () => {
    const { payload, nameMap, estimatedInputTokens } = buildKiroRequest(
      {
        model: "kiro-claude-sonnet-4-5",
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "Weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get weather", arguments: '{"city":"Oslo"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "12C" },
          { role: "assistant", content: "It is 12C." },
          { role: "user", content: "Thanks" },
        ],
        tools: [weatherTool],
      },
      IDE,
    );
    const alias = [...nameMap.keys()][0]!;
    expect(alias).toMatch(/^get_weather_[0-9a-f]{8}$/);
    expect(alias).toBe(
      `get_weather_${createHash("sha256").update("get weather").digest("hex").slice(0, 8)}`,
    );
    expect(nameMap.get(alias)).toBe("get weather");
    expect(estimatedInputTokens).toBeGreaterThan(50);

    const state = wire(payload).conversationState;
    expect(payload.profileArn).toBe(IDE.profileArn);
    expect(state.chatTriggerType).toBe("MANUAL");
    expect(state.agentTaskType).toBeUndefined(); // IDE shape
    expect(state.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.history).toEqual([
      {
        userInputMessage: {
          content: "Be terse.\n\nWeather?",
          modelId: "claude-sonnet-4.5",
          origin: "AI_EDITOR",
        },
      },
      {
        assistantResponseMessage: {
          content: "",
          toolUses: [{ name: alias, input: { city: "Oslo" }, toolUseId: "call_1" }],
        },
      },
      {
        userInputMessage: {
          content: "The requested tool result is attached.",
          modelId: "claude-sonnet-4.5",
          origin: "AI_EDITOR",
          userInputMessageContext: {
            toolResults: [{ content: [{ text: "12C" }], status: "success", toolUseId: "call_1" }],
          },
        },
      },
      { assistantResponseMessage: { content: "It is 12C." } },
    ]);
    expect(state.currentMessage.userInputMessage).toEqual({
      content: "Thanks",
      modelId: "claude-sonnet-4.5",
      origin: "AI_EDITOR",
      userInputMessageContext: {
        tools: [
          {
            toolSpecification: {
              name: alias,
              description: "Weather",
              inputSchema: {
                json: {
                  type: "object",
                  // rejected keywords are dropped, but a property *named* `format` survives
                  properties: { city: { type: "string" }, format: { type: "string" } },
                },
              },
            },
          },
        ],
      },
    });
  });

  it("uses the CLI request shape with a continuation id for profile-less accounts", () => {
    const { payload } = buildKiroRequest(
      { model: "auto", messages: [{ role: "user", content: "hi" }] },
      CLI,
    );
    const state = wire(payload).conversationState;
    expect(state.agentTaskType).toBe("vibe");
    expect(state.agentContinuationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.currentMessage.userInputMessage).toMatchObject({
      modelId: "auto",
      origin: "KIRO_CLI",
    });
    expect(payload.profileArn).toBeUndefined();
    expect(state.history).toBeUndefined();
  });

  it("inlines base64 images and marks the ones it cannot send", () => {
    const { payload } = buildKiroRequest(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/jpg;base64,AAAA" } },
              { type: "image_url", image_url: { url: "https://example.test/a.png" } },
              { type: "image_url", image_url: { url: "data:image/png;base64," } },
            ],
          },
        ],
      },
      CLI,
    );
    const uim = wire(payload).conversationState.currentMessage.userInputMessage;
    expect(uim.images).toEqual([{ format: "jpeg", source: { bytes: "AAAA" } }]);
    expect(uim.content).toBe(
      "look\n[image omitted: remote image references are not supported by this provider]\n[image omitted: malformed inline image data URL]",
    );
  });

  it("keeps only the newest 20 images per message", () => {
    const part = (i: number) => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,IMG${i}` },
    });
    const { payload } = buildKiroRequest(
      {
        model: "m",
        messages: [{ role: "user", content: Array.from({ length: 22 }, (_, i) => part(i)) }],
      },
      CLI,
    );
    const uim = wire(payload).conversationState.currentMessage.userInputMessage;
    expect(uim.images).toHaveLength(20);
    expect(uim.images![0]!.source.bytes).toBe("IMG2");
    expect(uim.content).toContain("20-image per-message cap");
  });

  it("maps reasoning effort natively where verified and to thinking tags elsewhere", () => {
    const messages = [{ role: "user", content: "solve" }];
    const native = buildKiroRequest(
      { model: "claude-opus-5", messages, reasoning_effort: "high" },
      CLI,
    );
    expect(native.payload.additionalModelRequestFields).toEqual({
      output_config: { effort: "high" },
    });
    expect(wire(native.payload).conversationState.currentMessage.userInputMessage.content).toBe(
      "solve",
    );

    const gpt = buildKiroRequest(
      { model: "kiro/gpt-5.6-sol-max", messages, reasoning: { effort: "max" } },
      CLI,
    );
    expect(gpt.payload.additionalModelRequestFields).toEqual({ reasoning: { effort: "max" } });

    const emulated = buildKiroRequest(
      { model: "claude-sonnet-4.5", messages, reasoning_effort: "medium", max_tokens: 1000 },
      CLI,
    );
    expect(emulated.payload.additionalModelRequestFields).toBeUndefined();
    const content = wire(emulated.payload).conversationState.currentMessage.userInputMessage
      .content;
    expect(content).toMatch(
      /^<thinking_mode>enabled<\/thinking_mode>\n<max_thinking_length>500<\/max_thinking_length>\n<thinking_instruction>/,
    );
    expect(content.endsWith("\nsolve")).toBe(true);

    // luna's xhigh rung is unverified natively, so it keeps the emulated path
    const luna = buildKiroRequest(
      { model: "gpt-5.6-luna", messages, reasoning_effort: "xhigh" },
      CLI,
    );
    expect(luna.payload.additionalModelRequestFields).toBeUndefined();
    expect(wire(luna.payload).conversationState.currentMessage.userInputMessage.content).toContain(
      "<thinking_mode>enabled",
    );

    expect(() =>
      buildKiroRequest({ model: "claude-opus-5", messages, reasoning_effort: "minimal" }, CLI),
    ).toThrow(/does not support reasoning effort/);
  });

  it("never lets a tool's name collide, and caps the catalog it advertises", () => {
    const tool = (name: string) => ({ type: "function", function: { name, parameters: {} } });
    const { payload, nameMap } = buildKiroRequest(
      {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [tool("a b"), tool("a_b"), tool("a.b")],
      },
      CLI,
    );
    const names = wire(
      payload,
    ).conversationState.currentMessage.userInputMessage.userInputMessageContext!.tools!.map(
      (t) => t.toolSpecification.name,
    );
    expect(new Set(names).size).toBe(3);
    expect(names).toContain("a_b");
    expect([...nameMap.values()].sort()).toEqual(["a b", "a.b"]);

    const many = buildKiroRequest(
      {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: Array.from({ length: 60 }, (_, i) => tool(`tool_${i}`)),
      },
      CLI,
    );
    const uim = wire(many.payload).conversationState.currentMessage.userInputMessage;
    expect(uim.userInputMessageContext!.tools).toHaveLength(48);
    expect(uim.content).toContain("allows 48 of 60 client tools this turn");
    expect(uim.content).toContain("tool_48, tool_49");

    const none = buildKiroRequest(
      {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [tool("t")],
        tool_choice: "none",
      },
      CLI,
    );
    expect(
      wire(none.payload).conversationState.currentMessage.userInputMessage.userInputMessageContext,
    ).toBeUndefined();
  });

  it("starts with a user turn, ends with one, and merges adjacent same-role messages", () => {
    const { payload } = buildKiroRequest(
      {
        model: "m",
        messages: [
          { role: "assistant", content: "I speak first" },
          { role: "user", content: "a" },
          { role: "user", content: "b" },
          { role: "assistant", content: "x" },
          { role: "developer", content: "late instruction" },
          { role: "assistant", content: "y" },
        ],
      },
      CLI,
    );
    const state = wire(payload).conversationState;
    const history = state.history!;
    const roles = history.map((e) => (e.userInputMessage ? "user" : "assistant"));
    expect(roles).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(history[0]!.userInputMessage!.content).toContain("Continue from the prior conversation");
    expect(history[2]!.userInputMessage!.content).toBe("a\n\nb");
    expect(history[4]!.userInputMessage!.content).toBe("late instruction");
    expect(state.currentMessage.userInputMessage.content).toContain(
      "Continue from the prior conversation",
    );
  });

  it("refuses what the wire cannot express with a request error", () => {
    const base = { model: "m", messages: [{ role: "user", content: "x" }] };
    const bad = (extra: Record<string, unknown>, match: RegExp) => {
      expect(() => buildKiroRequest({ ...base, ...extra }, CLI)).toThrow(KiroRequestError);
      expect(() => buildKiroRequest({ ...base, ...extra }, CLI)).toThrow(match);
    };
    bad({ tool_choice: "required" }, /only automatic tool choice/);
    bad(
      { tool_choice: { type: "function", function: { name: "f" } } },
      /only automatic tool choice/,
    );
    bad({ service_tier: "flex" }, /service tiers/);
    bad({ response_format: { type: "json_object" } }, /structured output/);
    bad(
      { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] },
      /input_audio/,
    );
    bad(
      { messages: [{ role: "tool", tool_call_id: "nope", content: "r" }] },
      /orphaned tool result/,
    );
    bad(
      {
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c", function: { name: "f", arguments: "{}" } }],
          },
          { role: "user", content: "y" },
        ],
      },
      /unanswered tool use/,
    );
    bad(
      {
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c", function: { name: "f", arguments: "{}" } },
              { id: "c", function: { name: "f", arguments: "{}" } },
            ],
          },
        ],
      },
      /duplicate tool call id/,
    );
    bad({ messages: [{ role: "user", content: "" }] }, /at least one/);
  });
});

describe("wire identity", () => {
  it("picks region, profile and request shape from the account", () => {
    expect(resolveApiRegion({})).toBe("us-east-1");
    expect(resolveApiRegion({ ssoRegion: "eu-west-1" })).toBe("eu-west-1");
    expect(
      resolveApiRegion({
        ssoRegion: "eu-west-1",
        profileArn: "arn:aws:codewhisperer:ap-south-1:123456789012:profile/X",
      }),
    ).toBe("ap-south-1");
    expect(resolveApiRegion({ apiRegion: "us-west-2", ssoRegion: "eu-west-1" })).toBe("us-west-2");
    expect(resolveApiRegion({ apiRegion: "not a region" })).toBe("us-east-1");

    expect(resolveIdentity("t", { profileArn: IDE.profileArn })).toEqual({ ...IDE });
    const builder = resolveIdentity("t", { authType: "aws_sso_oidc" });
    expect(builder).toMatchObject({ wireClient: "cli", apiKey: false });
    expect(builder.profileArn).toBe(
      "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
    );
    expect(resolveIdentity("t", {})).toEqual({
      wireClient: "cli",
      profileArn: undefined,
      apiKey: false,
    });
    expect(resolveIdentity("ksk_abc", { profileArn: IDE.profileArn })).toEqual({
      wireClient: "cli",
      profileArn: undefined,
      apiKey: true,
    });

    expect(runtimeEndpoint("https://runtime.us-east-1.kiro.dev", "eu-central-1")).toBe(
      "https://runtime.eu-central-1.kiro.dev/",
    );
    expect(runtimeEndpoint("https://proxy.internal/kiro", "eu-central-1")).toBe(
      "https://proxy.internal/kiro",
    );
  });

  it("sends the headers each request shape requires", () => {
    const ide = requestHeaders("tok", IDE);
    expect(ide).toMatchObject({
      authorization: "Bearer tok",
      "content-type": "application/x-amz-json-1.0",
      accept: "application/vnd.amazon.eventstream",
      "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      "x-amzn-codewhisperer-optout": "true",
      "x-amzn-kiro-agent-mode": "vibe",
      "x-amzn-kiro-profile-arn": IDE.profileArn,
    });
    expect(ide["user-agent"]).toMatch(/aws-sdk-js\/1\.0\.27 .* KiroIDE-1\.0\.0-[0-9a-f]{64}$/);
    expect(ide["amz-sdk-invocation-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const cli = requestHeaders("ksk_1", { wireClient: "cli", profileArn: undefined, apiKey: true });
    expect(cli).toMatchObject({
      accept: "*/*",
      tokentype: "API_KEY",
      "amz-sdk-request": "attempt=1; max=3",
      "x-amz-user-agent": expect.stringContaining("app/AmazonQ-For-CLI"),
    });
    expect(cli["x-amzn-kiro-profile-arn"]).toBeUndefined();
    expect(cli["x-amzn-kiro-agent-mode"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------------------------

describe("stream mapping", () => {
  it("maps text, native reasoning and usage, whatever the chunk boundaries", async () => {
    const frames = [
      event("messageMetadataEvent", { conversationId: "c-1" }), // ignored
      event("reasoningContentEvent", { text: "think " }),
      event("reasoningContentEvent", { signature: ".KTR~~opaque" }), // opaque blob: dropped
      text("Hel"),
      text("lo"),
      event("meteringEvent", { unit: "credit", usage: 0.01 }), // ignored
      event("contextUsageEvent", { contextUsagePercentage: 1.5 }), // ignored
      metadata({ ...usageBody, stopReason: "END_TURN" }),
    ];
    const reference = await collect(kiroChunks(bodyOf(frames), ctx));
    for (const sizes of [[1], [4, 9], [13]]) {
      const got = await collect(kiroChunks(bodyOf(frames, sizes), ctx));
      expect(got.map((c) => c.choices.map((x) => x.delta))).toEqual(
        reference.map((c) => c.choices.map((x) => x.delta)),
      );
    }

    expect(reference[0]!.choices[0]!.delta).toEqual({ role: "assistant", content: "" });
    const completion = await aggregateChunks(collectAsync(reference));
    expect(completion.choices[0]!.message).toEqual({
      role: "assistant",
      content: "Hello",
      reasoning_content: "think ",
    });
    expect(completion.choices[0]!.finish_reason).toBe("stop");
    expect(completion.model).toBe("claude-sonnet-4.5");
    expect(completion.usage).toEqual({
      prompt_tokens: 42, // 30 fresh + 10 cache read + 2 cache write
      completion_tokens: 5,
      total_tokens: 47,
      prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 2 },
    });
    // usage travels in its own trailing chunk with empty choices, after the finish chunk
    expect(reference.at(-1)!.choices).toEqual([]);
    expect(reference.at(-2)!.choices[0]!.finish_reason).toBe("stop");
  });

  it("estimates usage when the stream reports none", async () => {
    const chunks = await collect(
      kiroChunks(bodyOf([text("a".repeat(28)), metadata({ stopReason: "END_TURN" })]), ctx),
    );
    expect(chunks.at(-1)!.usage).toEqual({
      prompt_tokens: 123,
      completion_tokens: 10, // ceil(28 / 2.8)
      total_tokens: 133,
    });
    // a malformed tokenUsage is ignored rather than failing a delivered answer
    const lenient = await collect(
      kiroChunks(bodyOf([text("hi"), metadata({ tokenUsage: { outputTokens: "x" } })]), ctx),
    );
    expect(lenient.at(-1)!.usage!.prompt_tokens).toBe(123);
  });

  it("assembles tool calls from split events and restores the client's tool name", async () => {
    const nameMap = new Map([["get_weather_deadbeef", "get weather"]]);
    const tool = (b: Record<string, unknown>) => event("toolUseEvent", b);
    const frames = [
      text("Checking."),
      tool({ name: "get_weather_deadbeef", toolUseId: "tooluse_1", input: '{"ci' }),
      tool({ name: "get_weather_deadbeef", toolUseId: "tooluse_1", input: 'ty":"Oslo"}' }),
      tool({ name: "get_weather_deadbeef", toolUseId: "tooluse_1", stop: true }),
      tool({ name: "noop", toolUseId: "tooluse_2" }),
      tool({ name: "noop", toolUseId: "tooluse_2", stop: true }),
      metadata({ ...usageBody, stopReason: "TOOL_USE" }),
    ];
    const chunks = await collect(kiroChunks(bodyOf(frames, [5]), { ...ctx, nameMap }));
    const calls = chunks.flatMap((c) => c.choices.flatMap((x) => x.delta.tool_calls ?? []));
    expect(calls).toEqual([
      {
        index: 0,
        id: "tooluse_1",
        type: "function",
        function: { name: "get weather", arguments: '{"city":"Oslo"}' },
      },
      { index: 1, id: "tooluse_2", type: "function", function: { name: "noop", arguments: "{}" } },
    ]);
    expect(chunks.at(-2)!.choices[0]!.finish_reason).toBe("tool_calls");
    const completion = await aggregateChunks(collectAsync(chunks));
    expect(completion.choices[0]!.message.content).toBe("Checking.");
    expect(completion.choices[0]!.message.tool_calls).toHaveLength(2);
  });

  it("splits emulated <thinking> blocks into reasoning, even across chunk boundaries", async () => {
    const frames = [
      text("  <thin"),
      text("king>step one, "),
      text("step two</think"),
      text("ing>\n\nThe answer"),
      text(" is 4."),
      metadata({ stopReason: "END_TURN" }),
    ];
    const completion = await aggregateChunks(
      collectAsync(await collect(kiroChunks(bodyOf(frames), ctx))),
    );
    expect(completion.choices[0]!.message).toEqual({
      role: "assistant",
      content: "The answer is 4.",
      reasoning_content: "step one, step two",
    });

    // a leading "<" that never becomes a tag is plain text
    const plain = await aggregateChunks(
      collectAsync(
        await collect(kiroChunks(bodyOf([text("<b"), text("> bold"), metadata({})]), ctx)),
      ),
    );
    expect(plain.choices[0]!.message.content).toBe("<b> bold");
  });

  it("maps Kiro stop reasons to finish reasons", async () => {
    const finish = async (stopReason: string) =>
      (await collect(kiroChunks(bodyOf([text("x"), metadata({ stopReason })]), ctx))).at(-2)!
        .choices[0]!.finish_reason;
    expect(await finish("MAX_TOKENS")).toBe("length");
    expect(await finish("CONTENT_FILTERED")).toBe("content_filter");
    expect(await finish("GUARDRAIL_INTERVENED")).toBe("content_filter");
    expect(await finish("STOP_SEQUENCE")).toBe("stop");
    await expect(finish("MODEL_CONTEXT_WINDOW_EXCEEDED")).rejects.toThrow(
      "context window was exhausted",
    );
  });

  it("turns error frames and protocol violations into failures", async () => {
    const run = (frames: Buffer[]) => collect(kiroChunks(bodyOf(frames), ctx));

    await expect(
      run([text("partial"), exception("ThrottlingException", { message: "Too many requests" })]),
    ).rejects.toThrow("Kiro rate limit exceeded: ThrottlingException: Too many requests");
    await expect(
      run([exception("AccessDeniedException", { message: "bad token Bearer abc.def" })]),
    ).rejects.toThrow(/Kiro authentication failed.*Bearer \[redacted\]/);
    await expect(
      run([event("error", { reason: "ValidationException", message: "bad input" })]),
    ).rejects.toThrow("Kiro invalid request: ValidationException: bad input");
    await expect(run([event("invalidStateEvent", { message: "broken" })])).rejects.toThrow(
      "broken",
    );
    await expect(
      run([
        text("x"),
        event("toolUseEvent", { name: "t", toolUseId: "1", input: '{"a":' }),
        text("late"),
      ]),
    ).rejects.toThrow("truncated upstream");
    await expect(
      run([
        event("toolUseEvent", { name: "t", toolUseId: "1", input: '{"a":' }),
        event("toolUseEvent", { name: "t", toolUseId: "1", stop: true }),
      ]),
    ).rejects.toThrow("incomplete tool input JSON");
    await expect(
      run([event("toolUseEvent", { name: "t", toolUseId: "1", input: '{"a":' })]),
    ).rejects.toThrow("stream ended before tool stop");
    await expect(run([event("toolUseEvent", { stop: true })])).rejects.toThrow(
      "without an open tool call",
    );
    await expect(
      run([event("assistantResponseEvent", { content: "x", finish_reason: "max_tokens" })]),
    ).rejects.toThrow("truncated upstream");
    await expect(run([event("assistantResponseEvent", { content: 5 })])).rejects.toThrow(
      "invalid Kiro assistantResponseEvent payload",
    );
    await expect(run([metadata({ stopReason: "END_TURN" })])).rejects.toThrow(
      "empty response stream",
    );
    await expect(
      run([frame({ ":message-type": "weird", ":event-type": "x" }, "{}")]),
    ).rejects.toThrow("unsupported Smithy message type");
    await expect(run([frame({ ":message-type": "event" }, "{}")])).rejects.toThrow(
      "missing :event-type",
    );

    const corrupt = Buffer.from(text("x"));
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0xff;
    await expect(run([text("fine"), corrupt])).rejects.toThrow("CRC mismatch");
  });
});

async function* collectAsync<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

// ---------------------------------------------------------------------------------------------
// Adapter over a fake runtime
// ---------------------------------------------------------------------------------------------

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(handler: (seen: Seen, n: number) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const seen: Seen = {
      url: url.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(seen);
    return handler(seen, calls.length);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const eventStream = (frames: Buffer[], sizes?: number[]) =>
  new Response(bodyOf(frames, sizes), {
    headers: { "content-type": "application/vnd.amazon.eventstream" },
  });

const okFrames = () => [
  text("Hi"),
  text(" there"),
  metadata({ ...usageBody, stopReason: "END_TURN" }),
];

function callOf(
  adapter: ProviderAdapter,
  input: {
    meta?: Record<string, string>;
    token?: string;
    stream?: boolean;
    baseUrl?: string;
    body?: Record<string, unknown>;
  } = {},
) {
  return adapter.call({
    baseUrl: input.baseUrl ?? adapter.defaultBaseUrl!,
    token: input.token ?? "access-token",
    meta: input.meta ?? { authType: "aws_sso_oidc" },
    body: input.body ?? { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] },
    stream: input.stream ?? false,
    signal: new AbortController().signal,
  });
}

describe("kiro adapter", () => {
  it("sends the account's request to its regional runtime and serves JSON or SSE", async () => {
    const up = fakeFetch(() => eventStream(okFrames(), [7]));
    const adapter = createKiroAdapter({ fetch: up.fetch });
    expect(adapter).toMatchObject({
      type: "kiro",
      label: "Kiro",
      defaultBaseUrl: "https://runtime.us-east-1.kiro.dev",
    });

    const meta = {
      profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC",
      ssoRegion: "eu-central-1",
    };
    const json = await callOf(adapter, { meta, token: "tok-1" });
    expect(json.status).toBe(200);
    const body = (await json.json()) as ChatCompletion;
    expect(body.choices[0]!.message.content).toBe("Hi there");
    expect(body.usage!.prompt_tokens).toBe(42);

    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://runtime.eu-central-1.kiro.dev/");
    expect(sent.headers).toMatchObject({
      authorization: "Bearer tok-1",
      accept: "application/vnd.amazon.eventstream",
      "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      "x-amzn-kiro-profile-arn": meta.profileArn,
    });
    expect(wire(sent.body).profileArn).toBe(meta.profileArn);
    expect(wire(sent.body).conversationState.currentMessage.userInputMessage.modelId).toBe(
      "claude-sonnet-4.5",
    );

    const sse = await callOf(adapter, { meta, stream: true });
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    const events: string[] = [];
    for await (const e of parseSse(sse.body!)) events.push(e.data);
    expect(events.at(-1)).toBe("[DONE]");
    const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(parsed.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual([
      "Hi",
      " there",
    ]);
    expect(parsed.at(-1).usage.total_tokens).toBe(47);
  });

  it("uses the CLI shape and Builder ID service profile for SSO OIDC accounts", async () => {
    const up = fakeFetch(() => eventStream(okFrames()));
    const adapter = createKiroAdapter({ fetch: up.fetch });
    await callOf(adapter, { meta: { authType: "aws_sso_oidc", clientId: "c", clientSecret: "s" } });
    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://runtime.us-east-1.kiro.dev/");
    expect(sent.headers["x-amzn-kiro-profile-arn"]).toBe(
      "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
    );
    expect(sent.headers["user-agent"]).toContain("AmazonQ-For-CLI");
    expect(wire(sent.body).conversationState.agentTaskType).toBe("vibe");
    expect(wire(sent.body).conversationState.currentMessage.userInputMessage.origin).toBe(
      "KIRO_CLI",
    );

    await callOf(adapter, { token: "ksk_key", meta: {} });
    expect(up.calls[1]!.headers.tokentype).toBe("API_KEY");
    expect(wire(up.calls[1]!.body).profileArn).toBeUndefined();

    await callOf(adapter, { baseUrl: "http://127.0.0.1:9/custom", meta: {} });
    expect(up.calls[2]!.url).toBe("http://127.0.0.1:9/custom");
  });

  it("maps tool calls back to the client's tool names", async () => {
    const up = fakeFetch(({ body }) => {
      const alias =
        wire(body).conversationState.currentMessage.userInputMessage.userInputMessageContext!
          .tools![0]!.toolSpecification.name;
      return eventStream([
        event("toolUseEvent", { name: alias, toolUseId: "tu_1", input: '{"city":"Oslo"}' }),
        event("toolUseEvent", { name: alias, toolUseId: "tu_1", stop: true }),
        metadata({ stopReason: "TOOL_USE" }),
      ]);
    });
    const adapter = createKiroAdapter({ fetch: up.fetch });
    const res = await callOf(adapter, {
      body: {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "weather in Oslo" }],
        tools: [weatherTool],
      },
    });
    const body = (await res.json()) as ChatCompletion;
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
    expect(body.choices[0]!.message.tool_calls).toEqual([
      {
        id: "tu_1",
        type: "function",
        function: { name: "get weather", arguments: '{"city":"Oslo"}' },
      },
    ]);
  });

  it("reports unrepresentable requests as 400 without calling upstream", async () => {
    const up = fakeFetch(() => eventStream(okFrames()));
    const res = await callOf(createKiroAdapter({ fetch: up.fetch }), {
      body: { model: "m", messages: [{ role: "user", content: "x" }], tool_choice: "required" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error).toMatchObject({
      code: "invalid_request_error",
      message: "Kiro supports only automatic tool choice or tool_choice:none",
    });
    expect(up.calls).toHaveLength(0);
  });

  it("returns upstream failures as OpenAI errors the gateway can classify", async () => {
    const respondWith = async (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ) => {
      const up = fakeFetch(() => new Response(body, { status, headers }));
      const res = await callOf(createKiroAdapter({ fetch: up.fetch }));
      return { res, json: (await res.json()) as ErrorBody, calls: up.calls.length };
    };

    const throttled = await respondWith(
      429,
      '{"message":"Too many requests","__type":"ThrottlingException"}',
      {
        "retry-after": "7",
      },
    );
    expect(throttled.res.status).toBe(429);
    expect(throttled.res.headers.get("retry-after")).toBe("7");
    expect(throttled.json.error).toMatchObject({ code: "rate_limit_exceeded" });
    expect(throttled.json.error.message).toContain("Kiro rate limit exceeded");

    expect((await respondWith(401, '{"message":"The bearer token is expired"}')).res.status).toBe(
      401,
    );
    expect((await respondWith(403, '{"message":"Denied"}')).res.status).toBe(403);

    // spent monthly quota arrives as a 400 but is the account's problem: report 429 so the gateway rotates
    const quota = await respondWith(
      400,
      '{"message":"limit reached","reason":"MONTHLY_REQUEST_COUNT"}',
    );
    expect(quota.res.status).toBe(429);
    expect(quota.json.error.code).toBe("insufficient_quota");

    const context = await respondWith(
      400,
      '{"message":"x","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}',
    );
    expect(context.res.status).toBe(400);
    expect(context.json.error.code).toBe("context_length_exceeded");

    const server = await respondWith(500, '{"message":"internal secret detail"}');
    expect(server.res.status).toBe(500);
    expect(server.json.error.message).toBe("Kiro upstream service unavailable");
  });

  it("falls back once to the legacy host when the canonical one is unreachable or unknown", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
    const connect = fakeFetch((_seen, n) => {
      if (n === 1) throw refused;
      return eventStream(okFrames());
    });
    expect((await callOf(createKiroAdapter({ fetch: connect.fetch }))).status).toBe(200);
    expect(connect.calls.map((c) => c.url)).toEqual([
      "https://runtime.us-east-1.kiro.dev/",
      "https://q.us-east-1.amazonaws.com/",
    ]);

    for (const first of [
      () => new Response("", { status: 404 }),
      () => new Response("", { status: 503 }),
      () => new Response('{"__type":"UnknownOperationException"}', { status: 400 }),
    ]) {
      const up = fakeFetch((_seen, n) => (n === 1 ? first() : eventStream(okFrames())));
      expect((await callOf(createKiroAdapter({ fetch: up.fetch }))).status).toBe(200);
      expect(up.calls).toHaveLength(2);
    }

    // an ordinary 400 is the request's fault: no second attempt
    const plain = fakeFetch(() => new Response('{"message":"bad"}', { status: 400 }));
    expect((await callOf(createKiroAdapter({ fetch: plain.fetch }))).status).toBe(400);
    expect(plain.calls).toHaveLength(1);

    // a custom endpoint has no legacy twin
    const custom = fakeFetch(() => new Response("", { status: 503 }));
    expect(
      (await callOf(createKiroAdapter({ fetch: custom.fetch }), { baseUrl: "http://127.0.0.1:9/" }))
        .status,
    ).toBe(503);
    expect(custom.calls).toHaveLength(1);

    // timeouts and aborts are never mistaken for a connect failure
    const timeout = fakeFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await expect(callOf(createKiroAdapter({ fetch: timeout.fetch }))).rejects.toThrow("timed out");
    expect(timeout.calls).toHaveLength(1);
  });

  it("fails a non-streaming call whose stream breaks, and ends a streaming one with an error event", async () => {
    const broken = () =>
      eventStream([text("partial"), exception("ThrottlingException", { message: "slow down" })]);
    const adapter = createKiroAdapter({ fetch: fakeFetch(broken).fetch });
    await expect(callOf(adapter)).rejects.toThrow("Kiro rate limit exceeded");

    const res = await callOf(adapter, { stream: true });
    const events: string[] = [];
    for await (const e of parseSse(res.body!)) events.push(e.data);
    expect(JSON.parse(events.at(-2)!).error.message).toContain("Kiro rate limit exceeded");
    expect(events.at(-1)).toBe("[DONE]");
  });
});

// ---------------------------------------------------------------------------------------------
// OAuth: AWS Builder ID device login + refresh, against a fake IdP
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function fakeIdp() {
  const clock = { now: 1_800_000_000_000 };
  const state = {
    tokenAnswers: [] as Response[],
    refreshAnswer: null as null | (() => Response),
    refreshes: 0,
    valid: new Set<string>(),
    next: 1,
  };
  const json = (status: number, body: Json, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const f = fakeFetch((seen) => {
    const { url, body } = seen;
    if (url.endsWith("/client/register"))
      return json(200, { clientId: "cid", clientSecret: "csecret" });
    if (url.endsWith("/device_authorization"))
      return json(200, {
        deviceCode: "dev-code",
        userCode: "ABCD-1234",
        verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
        verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-1234",
        expiresIn: 600,
        interval: 5,
      });
    if (url.includes("/token") && body.grantType === "refresh_token") {
      state.refreshes++;
      if (state.refreshAnswer) return state.refreshAnswer();
      const n = ++state.next;
      state.valid.add(`at-${n}`);
      return json(200, { accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresIn: 3600 });
    }
    if (url.endsWith("/token")) {
      const scripted = state.tokenAnswers.shift();
      if (scripted) return scripted;
      state.valid.add("at-1");
      return json(200, { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 });
    }
    if (url.endsWith("/refreshToken")) {
      state.refreshes++;
      if (state.refreshAnswer) return state.refreshAnswer();
      return json(200, { accessToken: "desktop-at", expiresIn: 1800 });
    }
    return new Response("unexpected", { status: 500 });
  });
  const oauth = createKiroOAuth({ fetch: f.fetch, now: () => clock.now });
  return { oauth, clock, state, json, ...f };
}

describe("kiro device login", () => {
  it("registers a client, starts a device grant and completes once approved", async () => {
    const idp = fakeIdp();
    const { info, state } = await idp.oauth.start();
    expect(info).toEqual({
      flow: "device",
      verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
      verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-1234",
      userCode: "ABCD-1234",
      intervalSec: 5,
      expiresAt: idp.clock.now + 600_000,
    });
    expect(idp.calls[0]).toMatchObject({
      url: "https://oidc.us-east-1.amazonaws.com/client/register",
      body: {
        clientName: "kiro-cli",
        clientType: "public",
        scopes: [
          "codewhisperer:completions",
          "codewhisperer:analysis",
          "codewhisperer:conversations",
        ],
      },
    });
    expect(idp.calls[1]).toMatchObject({
      url: "https://oidc.us-east-1.amazonaws.com/device_authorization",
      body: {
        clientId: "cid",
        clientSecret: "csecret",
        startUrl: "https://view.awsapps.com/start",
      },
    });

    // too early: the IdP is not even asked
    expect(await idp.oauth.poll!(state)).toEqual({ status: "pending" });
    expect(idp.calls).toHaveLength(2);

    idp.state.tokenAnswers.push(idp.json(400, { error: "authorization_pending" }));
    idp.clock.now += 5_000;
    expect(await idp.oauth.poll!(state)).toEqual({ status: "pending" });
    expect(idp.calls[2]).toMatchObject({
      url: "https://oidc.us-east-1.amazonaws.com/token",
      body: {
        clientId: "cid",
        clientSecret: "csecret",
        deviceCode: "dev-code",
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      },
    });

    idp.clock.now += 5_000;
    expect(await idp.oauth.poll!(state)).toEqual({
      status: "complete",
      tokens: {
        accessToken: "at-1",
        refreshToken: "rt-1",
        expiresAt: idp.clock.now + 3_600_000,
        extra: {
          authType: "aws_sso_oidc",
          clientId: "cid",
          clientSecret: "csecret",
          ssoRegion: "us-east-1",
          apiRegion: "us-east-1",
        },
      },
    });
  });

  it("honours slow_down, and treats IdP or network hiccups as still pending", async () => {
    const idp = fakeIdp();
    const { state } = await idp.oauth.start();
    idp.clock.now += 5_000;
    idp.state.tokenAnswers.push(idp.json(400, { error: "slow_down" }));
    expect(await idp.oauth.poll!(state)).toEqual({ status: "pending" });
    const asked = idp.calls.length;

    idp.clock.now += 5_000; // the interval is now 10s
    expect(await idp.oauth.poll!(state)).toEqual({ status: "pending" });
    expect(idp.calls).toHaveLength(asked);

    idp.clock.now += 5_000;
    idp.state.tokenAnswers.push(idp.json(503, {}));
    expect(await idp.oauth.poll!(state)).toEqual({ status: "pending" });
    idp.clock.now += 10_000;
    idp.state.tokenAnswers.push(idp.json(400, { error: "authorization_pending" }));
    expect(await idp.oauth.poll!(state)).toEqual({ status: "pending" });

    const flaky = createKiroOAuth({
      now: () => idp.clock.now,
      fetch: (async (url: string) => {
        if (String(url).endsWith("/token")) throw new TypeError("fetch failed");
        return idp.fetch(url);
      }) as unknown as typeof fetch,
    });
    const started = await flaky.start();
    idp.clock.now += 5_000;
    expect(await flaky.poll!(started.state)).toEqual({ status: "pending" });
  });

  it("reports expiry, denial and malformed answers as errors", async () => {
    const outcome = async (answer: Response) => {
      const idp = fakeIdp();
      const { state } = await idp.oauth.start();
      idp.state.tokenAnswers.push(answer);
      idp.clock.now += 5_000;
      return idp.oauth.poll!(state);
    };
    const idp = fakeIdp();
    expect(await outcome(idp.json(400, { error: "expired_token" }))).toEqual({
      status: "error",
      message: "The Kiro device code expired before it was approved.",
    });
    expect(await outcome(idp.json(400, { error: "access_denied" }))).toEqual({
      status: "error",
      message: "Kiro sign-in was denied.",
    });
    // AWS also reports the exception type in a header
    expect(
      await outcome(
        idp.json(
          400,
          {},
          { "x-amzn-errortype": "AccessDeniedException:http://internal.amazon.com/" },
        ),
      ),
    ).toEqual({ status: "error", message: "Kiro sign-in was denied." });
    expect(await outcome(idp.json(400, { error: "invalid_client" }))).toEqual({
      status: "error",
      message: "Kiro device login failed (HTTP 400: invalid_client)",
    });
    expect(
      await outcome(idp.json(200, { accessToken: "a", refreshToken: "", expiresIn: 3600 })),
    ).toMatchObject({
      status: "error",
      message: expect.stringContaining("incomplete"),
    });
  });

  it("refuses an IdP answer that would put a hostile link or bad registration in front of the admin", async () => {
    const start = async (override: (url: string) => Response | null) => {
      const idp = fakeIdp();
      const oauth = createKiroOAuth({
        now: () => idp.clock.now,
        fetch: (async (url: string, init: RequestInit) =>
          override(String(url)) ?? idp.fetch(url, init)) as unknown as typeof fetch,
      });
      return oauth.start();
    };
    const j = (b: Json, status = 200) => Response.json(b, { status });
    const auth = (over: Json) => ({
      deviceCode: "d",
      userCode: "ABCD-1234",
      verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
      ...over,
    });
    await expect(
      start((u) => (u.endsWith("/client/register") ? j({}, 400) : null)),
    ).rejects.toThrow("client registration failed (HTTP 400)");
    await expect(
      start((u) =>
        u.endsWith("/client/register") ? j({ clientId: " x", clientSecret: "y" }) : null,
      ),
    ).rejects.toThrow("client registration failed");
    for (const bad of [
      { verificationUri: "http://insecure.example/" },
      { verificationUri: "https://user:pw@evil.example/" },
      { verificationUri: "javascript:alert(1)" },
      { verificationUriComplete: "https://ok.example/\u202eevil" },
      { userCode: "<script>" },
      { deviceCode: "" },
    ]) {
      await expect(
        start((u) => (u.endsWith("/device_authorization") ? j(auth(bad)) : null)),
      ).rejects.toThrow("device authorization failed");
    }
    // a login never outlives 15 minutes, and polls no faster than once a second
    const long = await start((u) =>
      u.endsWith("/device_authorization") ? j(auth({ expiresIn: 86_400, interval: 0.1 })) : null,
    );
    expect(long.info).toMatchObject({ intervalSec: 1 });
    expect((long.info as { expiresAt: number }).expiresAt - 1_800_000_000_000).toBe(15 * 60_000);
  });
});

const tokens = (extra: Record<string, string>, refreshToken: string | null = "rt-old") => ({
  accessToken: "at-old",
  refreshToken,
  expiresAt: 0,
  account: "label",
  extra,
});
const sso = {
  authType: "aws_sso_oidc",
  clientId: "cid",
  clientSecret: "csecret",
  ssoRegion: "eu-west-1",
  apiRegion: "eu-west-1",
};

describe("kiro token refresh", () => {
  it("refreshes SSO OIDC accounts in their SSO region and keeps what must survive", async () => {
    const idp = fakeIdp();
    const next = await idp.oauth.refresh(tokens(sso));
    expect(idp.calls[0]).toMatchObject({
      url: "https://oidc.eu-west-1.amazonaws.com/token",
      body: {
        grantType: "refresh_token",
        clientId: "cid",
        clientSecret: "csecret",
        refreshToken: "rt-old",
      },
    });
    expect(next).toEqual({
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: idp.clock.now + 3_600_000,
      account: "label",
      extra: sso,
    });
  });

  it("refreshes accounts without a client registration on Kiro's own endpoint and keeps the old refresh token", async () => {
    const idp = fakeIdp();
    const profile = {
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC",
      authType: "kiro_desktop",
    };
    const next = await idp.oauth.refresh(tokens(profile));
    expect(idp.calls[0]).toMatchObject({
      url: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
      body: { refreshToken: "rt-old" },
    });
    expect(next).toMatchObject({
      accessToken: "desktop-at",
      refreshToken: "rt-old",
      expiresAt: idp.clock.now + 1_800_000,
      extra: profile,
    });
    // an invalid region in stored extras falls back to the default instead of building a hostile URL
    await idp.oauth.refresh(tokens({ ssoRegion: "evil.example/" }));
    expect(idp.calls[1]!.url).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken");
  });

  it("classifies failures: only a rejected grant is terminal", async () => {
    const failure = async (answer: () => Response) => {
      const idp = fakeIdp();
      idp.state.refreshAnswer = answer;
      return idp.oauth.refresh(tokens(sso)).then(
        () => null,
        (error: unknown) => error as OAuthRefreshError,
      );
    };
    const idp = fakeIdp();
    for (const code of [
      "invalid_grant",
      "refresh_token_reused",
      "revoked",
      "access_denied",
      "expired_token",
    ]) {
      for (const status of [400, 401]) {
        const error = await failure(() => idp.json(status, { error: code }));
        expect(error).toBeInstanceOf(OAuthRefreshError);
        expect(error).toMatchObject({
          terminal: true,
          message: `Kiro token refresh failed: ${status} (${code})`,
        });
      }
    }
    // transient: server errors, throttling, unknown codes, non-JSON bodies, wrong status for a terminal code
    for (const answer of [
      () => idp.json(500, { error: "server_error" }),
      () => idp.json(503, {}),
      () => idp.json(429, { error: "slow_down" }),
      () => idp.json(400, { error: "something_new" }),
      () => new Response("<html>bad gateway</html>", { status: 400 }),
      () => idp.json(403, { error: "invalid_grant" }),
      () => idp.json(500, { error: "invalid_grant" }),
    ]) {
      const error = await failure(answer);
      expect(error).toBeInstanceOf(OAuthRefreshError);
      expect(error!.terminal).toBe(false);
      expect(error!.message).toMatch(/^Kiro token refresh failed: \d{3}( \(\w+\))?$/);
    }
    // a 2xx without an access token is not a success
    expect(await failure(() => idp.json(200, { expiresIn: 3600 }))).toMatchObject({
      terminal: false,
      message: "Kiro refresh returned no accessToken",
    });
  });

  it("treats a network failure as transient and a missing refresh token as terminal", async () => {
    const oauth = createKiroOAuth({
      fetch: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
    });
    await expect(oauth.refresh(tokens(sso))).rejects.toMatchObject({
      terminal: false,
      message: "Kiro token refresh failed: fetch failed",
    });
    await expect(oauth.refresh(tokens(sso, null))).rejects.toMatchObject({ terminal: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Gateway end to end: admin login -> chat (JSON + SSE) -> refresh
// ---------------------------------------------------------------------------------------------

describe("kiro through the gateway", () => {
  /** One fake that is both the IdP and the Kiro runtime, so nothing touches the network. */
  function world(getNow: () => number) {
    const idp = fakeIdp();
    const runtime: Seen[] = [];
    const combined = fakeFetch((seen, n) => {
      if (!seen.url.startsWith("https://runtime."))
        return idp.fetch(seen.url, {
          method: "POST",
          headers: seen.headers,
          body: JSON.stringify(seen.body),
        });
      runtime.push(seen);
      const token = seen.headers.authorization!.slice("Bearer ".length);
      if (!idp.state.valid.has(token))
        return new Response('{"message":"The bearer token is invalid"}', { status: 401 });
      void n;
      return eventStream(okFrames(), [9, 4]);
    });
    const adapter = createKiroAdapter({ fetch: combined.fetch, now: getNow });
    return { idp, runtime, adapter };
  }

  it("logs in through the admin API, serves JSON and SSE, and refreshes the token", async () => {
    const w = world(() => h.clock.now);
    const h = createHarness({}, { adapters: { ...ADAPTERS, kiro: w.adapter } });
    w.idp.clock.now = h.clock.now;

    expect((await h.admin("POST", "/providers", { id: "kiro", type: "kiro" })).status).toBe(201);
    const types = (await h.admin("GET", "/provider-types")).json.data;
    expect(types.find((t: { type: string }) => t.type === "kiro")).toMatchObject({
      label: "Kiro",
      default_base_url: "https://runtime.us-east-1.kiro.dev",
      oauth: { label: "Sign in with AWS Builder ID (Kiro)" },
    });
    const key = await h.newKey();

    // device login
    const started = await h.admin("POST", "/providers/kiro/oauth/start", { label: "builder" });
    expect(started.status).toBe(201);
    expect(started.json).toMatchObject({
      flow: "device",
      user_code: "ABCD-1234",
      verification_uri: "https://device.sso.us-east-1.amazonaws.com/",
      interval_sec: 5,
    });
    const sid = started.json.session_id as string;
    expect((await h.admin("GET", `/oauth/sessions/${sid}`)).json.status).toBe("pending");
    w.idp.state.tokenAnswers.push(w.idp.json(400, { error: "authorization_pending" }));
    h.clock.now += 6_000;
    w.idp.clock.now = h.clock.now;
    expect((await h.admin("GET", `/oauth/sessions/${sid}`)).json.status).toBe("pending");
    h.clock.now += 6_000;
    const done = await h.admin("GET", `/oauth/sessions/${sid}`);
    expect(done.json.status).toBe("complete");
    const [cred] = (await h.admin("GET", "/providers/kiro/credentials")).json.data;
    expect(cred).toMatchObject({ kind: "oauth", label: "builder", status: "active" });

    // non-streaming chat
    const res = await h.chat(key.secret, { model: "kiro/claude-sonnet-4-5" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatCompletion;
    expect(body.choices[0]!.message.content).toBe("Hi there");
    expect(body.usage).toMatchObject({ prompt_tokens: 42, completion_tokens: 5 });
    const first = w.runtime[0]!;
    expect(first.url).toBe("https://runtime.us-east-1.kiro.dev/");
    expect(first.headers.authorization).toBe("Bearer at-1");
    expect(wire(first.body).conversationState.currentMessage.userInputMessage.modelId).toBe(
      "claude-sonnet-4.5",
    );
    expect(wire(first.body).profileArn).toBe(
      "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
    );

    // streaming chat: usage is requested and accounted for
    const streamed = await h.chat(key.secret, { model: "kiro/claude-sonnet-4-5", stream: true });
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const sseText = await streamed.text();
    expect(sseText).toContain('"content":"Hi"');
    expect(sseText.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const events = (await h.admin("GET", `/usage?key_id=${key.id}`)).json.data;
    expect(events).toHaveLength(2);
    for (const e of events)
      expect(e).toMatchObject({
        status: "ok",
        input_tokens: 42,
        cached_tokens: 10,
        output_tokens: 5,
      });
    expect(events.map((e: { stream: number }) => e.stream).sort()).toEqual([0, 1]);

    // the access token expires: refreshed once with the stored client registration, then used
    h.clock.now += 3_600_000;
    w.idp.clock.now = h.clock.now;
    expect((await h.chat(key.secret, { model: "kiro/auto" })).status).toBe(200);
    expect(w.idp.state.refreshes).toBe(1);
    const refreshCall = w.idp.calls.find((c) => c.body.grantType === "refresh_token")!;
    expect(refreshCall).toMatchObject({
      url: "https://oidc.us-east-1.amazonaws.com/token",
      body: { clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1" },
    });
    expect(w.runtime.at(-1)!.headers.authorization).toBe("Bearer at-2");

    // revoked early: the 401 triggers one refresh and a retry
    w.idp.state.valid.delete("at-2");
    expect((await h.chat(key.secret, { model: "kiro/auto" })).status).toBe(200);
    expect(w.idp.state.refreshes).toBe(2);
    expect(w.runtime.at(-1)!.headers.authorization).toBe("Bearer at-3");

    // a rejected refresh token retires the account until it signs in again
    w.idp.state.refreshAnswer = () => w.idp.json(400, { error: "invalid_grant" });
    h.clock.now += 3_600_000;
    w.idp.clock.now = h.clock.now;
    expect((await h.chat(key.secret, { model: "kiro/auto" })).status).toBe(502);
    const [dead] = (await h.admin("GET", "/providers/kiro/credentials")).json.data;
    expect(dead).toMatchObject({ status: "dead" });
    expect(dead.last_error).toContain("Kiro token refresh failed: 400 (invalid_grant)");
  });
});
