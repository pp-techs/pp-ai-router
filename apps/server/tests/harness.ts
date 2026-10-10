import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServices, type AppConfig, type ServiceOptions } from "../src/app.ts";
import { openDatabase } from "../src/db/database.ts";

export const ADMIN_TOKEN = "admin-token-for-tests-only";

export interface UpstreamCall {
  /** Bearer secret the router presented. */
  secret: string;
  body: Record<string, any>;
}

export type UpstreamHandler = (call: UpstreamCall, n: number) => Response | Promise<Response>;

/** A real HTTP server standing in for an upstream provider; records what the router sent. */
export async function startUpstream(handler: UpstreamHandler) {
  const calls: UpstreamCall[] = [];
  const app = new Hono();
  app.post("/v1/chat/completions", async (c) => {
    const call: UpstreamCall = {
      secret: (c.req.header("authorization") ?? "").replace(/^Bearer /, ""),
      body: await c.req.json(),
    };
    calls.push(call);
    return handler(call, calls.length);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const readJson = (res: Response) => res.json() as Promise<any>;

export const completion = (usage = { prompt_tokens: 100, completion_tokens: 50 }) =>
  Response.json({
    id: "x",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
    usage,
  });

export const sse = (chunks: string[]) =>
  new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } });

export function createHarness(
  overrides: Partial<AppConfig> = {},
  options: Pick<ServiceOptions, "adapters"> = {},
) {
  const clock = { now: 1_800_000_000_000 };
  const config: AppConfig = {
    DB_PATH: ":memory:",
    MASTER_KEY: randomBytes(32).toString("base64"),
    ADMIN_TOKEN,
    UNPRICED_MODELS: "allow",
    UPSTREAM_TIMEOUT_MS: 5000,
    ...overrides,
  };
  const services = createServices(config, {
    db: openDatabase(":memory:"),
    now: () => clock.now,
    ...options,
  });
  const { app } = services;

  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  };

  const chat = (key: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }),
    });

  /** Provider with N credentials named after their secret ("k1", "k2", ...). Returns credential ids. */
  const addProvider = async (
    id: string,
    baseUrl: string,
    secrets: string[],
    extra: Record<string, unknown> = {},
  ) => {
    await admin("POST", "/providers", { id, type: "openai-compat", base_url: baseUrl, ...extra });
    const ids: string[] = [];
    for (const secret of secrets) {
      const r = await admin("POST", `/providers/${id}/credentials`, {
        label: `${id}-${ids.length + 1}`,
        secret,
      });
      ids.push(r.json.id);
    }
    return ids;
  };

  const newKey = async (body: Record<string, unknown> = {}) => {
    const r = await admin("POST", "/keys", { name: "test", ...body });
    return { id: r.json.id as string, secret: r.json.key as string };
  };

  return { clock, services, admin, chat, addProvider, newKey };
}

export type Harness = ReturnType<typeof createHarness>;

export interface AnthropicUpstreamCall extends UpstreamCall {
  /** `anthropic-version` header the router sent. */
  version: string;
}

export type AnthropicUpstreamHandler = (
  call: AnthropicUpstreamCall,
  n: number,
) => Response | Promise<Response>;

/** Like `startUpstream`, but speaks Anthropic's `POST /v1/messages` with `x-api-key` auth. */
export async function startAnthropicUpstream(handler: AnthropicUpstreamHandler) {
  const calls: AnthropicUpstreamCall[] = [];
  const app = new Hono();
  app.post("/v1/messages", async (c) => {
    const call: AnthropicUpstreamCall = {
      secret: c.req.header("x-api-key") ?? "",
      version: c.req.header("anthropic-version") ?? "",
      body: await c.req.json(),
    };
    calls.push(call);
    return handler(call, calls.length);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A non-streaming Anthropic `Message` response. */
export const anthropicMessage = (
  content: unknown[],
  extra: { stop_reason?: string; usage?: Record<string, number>; model?: string } = {},
) =>
  Response.json({
    id: "msg_up",
    type: "message",
    role: "assistant",
    model: extra.model ?? "claude-test",
    content,
    stop_reason: extra.stop_reason ?? "end_turn",
    stop_sequence: null,
    usage: extra.usage ?? { input_tokens: 10, output_tokens: 5 },
  });

/** An Anthropic SSE response from `[event, payload]` pairs (the payload's `type` is filled in). */
export const anthropicSse = (events: [string, Record<string, unknown>][]) =>
  new Response(
    events
      .map(
        ([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
