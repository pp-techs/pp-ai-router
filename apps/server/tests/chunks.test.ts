import { describe, expect, it } from "vite-plus/test";
import {
  aggregateChunks,
  chunk,
  makeUsage,
  newChunkMeta,
  parseSse,
  respond,
  usageChunk,
  type OpenAIChunk,
} from "../src/providers/chunks.ts";

async function* gen(items: OpenAIChunk[], failAfter?: Error): AsyncGenerator<OpenAIChunk> {
  for (const i of items) yield i;
  if (failAfter) throw failAfter;
}

const meta = newChunkMeta("m");
const sample = () => [
  chunk(meta, { role: "assistant", content: "Hel" }),
  chunk(meta, { content: "lo", reasoning_content: "hmm" }),
  chunk(meta, {
    tool_calls: [
      { index: 0, id: "call_1", type: "function", function: { name: "get", arguments: '{"a"' } },
    ],
  }),
  chunk(meta, { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }, "tool_calls"),
  usageChunk(meta, makeUsage({ prompt: 10, completion: 5, cached: 4, reasoning: 2 })),
];

describe("aggregateChunks", () => {
  it("merges text, reasoning, split tool-call arguments, finish reason and usage", async () => {
    const out = await aggregateChunks(gen(sample()));
    expect(out.choices[0]!.message).toEqual({
      role: "assistant",
      content: "Hello",
      reasoning_content: "hmm",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get", arguments: '{"a":1}' } },
      ],
    });
    expect(out.choices[0]!.finish_reason).toBe("tool_calls");
    expect(out.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
  });
});

describe("respond", () => {
  it("streams chunks as SSE terminated by [DONE]", async () => {
    const res = await respond(gen(sample()), true);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const events: string[] = [];
    for await (const e of parseSse(res.body!)) events.push(e.data);
    expect(events.at(-1)).toBe("[DONE]");
    expect(JSON.parse(events[0]!).choices[0].delta.content).toBe("Hel");
    expect(JSON.parse(events.at(-2)!).usage.total_tokens).toBe(15);
  });

  it("turns a mid-stream failure into an error event instead of a broken connection", async () => {
    const res = await respond(gen(sample().slice(0, 1), new Error("upstream died")), true);
    const events: string[] = [];
    for await (const e of parseSse(res.body!)) events.push(e.data);
    expect(JSON.parse(events.at(-2)!).error.message).toBe("upstream died");
    expect(events.at(-1)).toBe("[DONE]");
  });

  it("rejects instead of answering half-complete when a non-streaming upstream fails", async () => {
    await expect(respond(gen(sample().slice(0, 1), new Error("boom")), false)).rejects.toThrow(
      "boom",
    );
  });
});

describe("parseSse", () => {
  it("handles CRLF, named events, multi-line data, comments and chunk boundaries inside a line", async () => {
    const text = ': ping\r\nevent: message_start\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: tail';
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const out: unknown[] = [];
    for await (const e of parseSse(body)) out.push(e);
    expect(out).toEqual([
      { event: "message_start", data: '{"a":\n1}' },
      { event: undefined, data: "tail" },
    ]);
  });
});
