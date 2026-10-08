import type { Context } from "hono";
import * as z from "zod";
import type { Config } from "../config.ts";
import { errorBody, HttpError } from "../errors.ts";
import { formatWindow, listLimits, type UsageMeter } from "../governance/limits.ts";
import {
  isModelAllowed,
  type VirtualKey,
  type VirtualKeyStore,
} from "../governance/virtual-keys.ts";
import type { CredentialPool, FailureKind } from "../pool/pool.ts";
import type { PricingStore } from "../pricing/store.ts";
import type { ModelPrice, Usage } from "../pricing/types.ts";
import { ZERO_USAGE } from "../pricing/types.ts";
import type { ProviderAdapter } from "../providers/adapter.ts";
import {
  CredentialUnavailableError,
  type ResolvedAuth,
  type TokenManager,
} from "../oauth/token-manager.ts";
import type { Registry, Target } from "../registry.ts";
import type { Db } from "../db/database.ts";
import type { Accounting, EventStatus } from "./accounting.ts";
import { parseOpenAiUsage, tapStream } from "./usage.ts";
import type { Logger } from "../logger.ts";

export interface GatewayDeps {
  config: Pick<Config, "UPSTREAM_TIMEOUT_MS" | "UNPRICED_MODELS">;
  db: Db;
  keys: VirtualKeyStore;
  meter: UsageMeter;
  registry: Registry;
  pool: CredentialPool;
  pricing: PricingStore;
  accounting: Accounting;
  log: Logger;
  tokens: TokenManager;
  adapters: Readonly<Record<string, ProviderAdapter>>;
  now?: () => number;
}

const requestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(z.unknown()).min(1),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({}).optional(),
  user: z.string().optional(),
  prompt_cache_key: z.string().optional(),
});

const MAX_UPSTREAM_ERROR_CHARS = 500;
const REQUEST_ID = "x-request-id";

function bearer(c: Context): string | null {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim() || null;
  return c.req.header("x-api-key")?.trim() || null;
}

function retryAfterMs(res: Response, now: number): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Status -> how to treat the credential. `null` means the failure is the caller's, not the key's. */
function classify(status: number): FailureKind | null {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status === 408 || status >= 500) return "server_error";
  return null;
}

const pricingCandidates = (t: Target) => [`${t.provider}/${t.model}`, t.model];

/** What the pipeline needs from a request, whatever wire format the client spoke. */
export type ChatBody = z.infer<typeof requestSchema>;

/**
 * The shared request pipeline: limits -> route -> pick credential -> upstream -> account.
 * It speaks canonical OpenAI chat completions; `/v1/chat/completions` calls it directly and
 * `/v1/messages` translates to and from it.
 */
export interface Pipeline {
  now(): number;
  log: Logger;
  /** Resolves the virtual key from `Authorization: Bearer` / `x-api-key`; throws 401. */
  authenticate(c: Context, at: number): VirtualKey;
  run(c: Context, key: VirtualKey, body: ChatBody, startedAt: number): Promise<Response>;
}

export function createPipeline(deps: GatewayDeps): Pipeline {
  const now = deps.now ?? Date.now;

  function authenticate(c: Context, at: number): VirtualKey {
    const secret = bearer(c);
    const key = secret ? deps.keys.authenticate(secret, at) : null;
    if (!key)
      throw new HttpError(401, "invalid_api_key", "Missing, unknown, disabled or expired API key.");
    return key;
  }

  async function run(
    c: Context,
    key: VirtualKey,
    body: ChatBody,
    startedAt: number,
  ): Promise<Response> {
    const requestedModel = body.model;
    const stream = body.stream === true;

    if (!isModelAllowed(key, requestedModel)) {
      throw new HttpError(
        403,
        "model_not_allowed",
        `This API key may not use model "${requestedModel}".`,
      );
    }
    const exceeded = deps.meter.firstExceeded(listLimits(deps.db, key.id), startedAt);
    if (exceeded) {
      const { limit, used, resetsAt } = exceeded;
      throw new HttpError(
        429,
        "limit_exceeded",
        `Key limit reached: ${limit.metric} ${used} / ${limit.max} per ${formatWindow(limit.windowSec)}.`,
        {
          limit: {
            id: limit.id,
            metric: limit.metric,
            window: formatWindow(limit.windowSec),
            mode: limit.mode,
            max: limit.max,
            used,
          },
          resets_at: resetsAt,
          retry_after:
            resetsAt === null ? null : Math.max(1, Math.ceil((resetsAt - startedAt) / 1000)),
        },
      );
    }

    const targets = deps.registry.resolve(requestedModel);
    if (targets.length === 0) {
      throw new HttpError(
        404,
        "model_not_found",
        `No provider route for model "${requestedModel}".`,
      );
    }

    const stickyKey = c.req.header("x-session-id") ?? body.prompt_cache_key ?? body.user;
    let lastUpstream: { status: number; message: string } | null = null;
    let earliestRetry: number | null = null;
    let sawUnpriced = false;

    for (const target of targets) {
      const provider = deps.registry.provider(target.provider);
      const adapter = provider && deps.adapters[provider.type];
      if (!provider || !adapter) continue;

      const price = deps.pricing.lookup(pricingCandidates(target));
      if (!price && deps.config.UNPRICED_MODELS === "reject") {
        sawUnpriced = true;
        continue;
      }

      const upstreamBody: Record<string, unknown> = { ...body, model: target.model };
      if (stream) upstreamBody.stream_options = { ...body.stream_options, include_usage: true };

      const tried = new Set<string>();
      for (let attempt = 0; attempt < provider.maxKeyAttempts; attempt++) {
        const acquired = deps.pool.acquire(target.provider, {
          model: target.model,
          exclude: tried,
          stickyKey,
        });
        if ("error" in acquired) {
          if (acquired.error === "no_credential" && acquired.retryAt !== null) {
            earliestRetry = Math.min(earliestRetry ?? Infinity, acquired.retryAt);
          }
          break;
        }
        const { lease } = acquired;
        const credentialId = lease.credential.id;
        tried.add(credentialId);

        const send = async (auth: ResolvedAuth): Promise<Response> => {
          const timeout = new AbortController();
          const timer = setTimeout(
            () => timeout.abort(new Error("upstream timeout")),
            deps.config.UPSTREAM_TIMEOUT_MS,
          );
          try {
            return await adapter.call({
              baseUrl: provider.baseUrl,
              token: auth.token,
              meta: auth.meta,
              body: upstreamBody,
              stream,
              signal: AbortSignal.any([timeout.signal, c.req.raw.signal]),
            });
          } finally {
            clearTimeout(timer);
          }
        };

        let res: Response;
        try {
          let auth = await deps.tokens.resolve(lease.credential, provider.type);
          res = await send(auth);
          if (res.status === 401 && lease.credential.auth.type === "oauth") {
            // The access token may simply have been revoked/rotated early: refresh once before giving up on the account.
            await res.body?.cancel().catch(() => {});
            auth = await deps.tokens.refreshNow(lease.credential, provider.type);
            res = await send(auth);
          }
        } catch (error) {
          lease.release();
          if (c.req.raw.signal.aborted)
            throw new HttpError(499, "client_closed_request", "Client closed the request.");
          // A terminal OAuth failure already retired the credential; anything else is worth a cooldown.
          if (!(error instanceof CredentialUnavailableError && error.terminal))
            lease.fail("server_error");
          lastUpstream = { status: 502, message: (error as Error).message };
          deps.log.warn("upstream call failed", {
            provider: target.provider,
            credential: credentialId,
            error: (error as Error).message,
          });
          continue;
        }

        const failure = res.ok ? null : classify(res.status);
        if (res.ok) {
          lease.ok();
          return respond({
            res,
            stream,
            key,
            target,
            requestedModel,
            credentialId,
            price,
            lease,
            startedAt,
          });
        }
        if (failure === null) {
          // 400/404/422...: the request itself is wrong; retrying elsewhere will not help.
          lease.release();
          return new Response(res.body, { status: res.status, headers: passHeaders(res) });
        }

        const text = (await res.text().catch(() => "")).slice(0, MAX_UPSTREAM_ERROR_CHARS);
        lease.fail(failure, retryAfterMs(res, now()));
        lease.release();
        lastUpstream = { status: res.status, message: text };
        deps.log.warn("upstream failure", {
          provider: target.provider,
          credential: credentialId,
          status: res.status,
          failure,
        });
      }
    }

    if (lastUpstream) {
      throw new HttpError(502, "upstream_error", "All upstream attempts failed.", {
        upstream_status: lastUpstream.status,
        upstream_message: lastUpstream.message,
      });
    }
    if (sawUnpriced) {
      throw new HttpError(
        422,
        "model_unpriced",
        `No price known for "${requestedModel}" and UNPRICED_MODELS=reject.`,
      );
    }
    const retryIn =
      earliestRetry === null ? null : Math.max(1, Math.ceil((earliestRetry - now()) / 1000));
    throw new HttpError(
      503,
      "no_available_credential",
      "No upstream credential is currently available.",
      {
        retry_after: retryIn,
      },
    );
  }

  function respond(ctx: {
    res: Response;
    stream: boolean;
    key: VirtualKey;
    target: Target;
    requestedModel: string;
    credentialId: string;
    price: ModelPrice | null;
    lease: { release(): void };
    startedAt: number;
  }): Response | Promise<Response> {
    const { res, stream, key, target, requestedModel, credentialId, price, lease, startedAt } = ctx;

    const record = (usage: Usage | null, status: EventStatus) => {
      try {
        const final: EventStatus = status === "ok" && usage === null ? "no_usage" : status;
        deps.accounting.record({
          keyId: key.id,
          providerId: target.provider,
          credentialId,
          model: requestedModel,
          upstreamModel: target.model,
          usage: usage ?? ZERO_USAGE,
          price,
          stream,
          status: final,
          latencyMs: now() - startedAt,
        });
      } catch (error) {
        deps.log.error("failed to record usage", { key: key.id, error: (error as Error).message });
      }
    };
    const headers = passHeaders(res);
    headers.set("x-router-provider", target.provider);

    if (stream && res.body) {
      const tapped = tapStream(res.body, ({ usage, end }) => {
        lease.release();
        record(usage, end);
      });
      headers.set("cache-control", "no-cache");
      headers.set("x-accel-buffering", "no");
      return new Response(tapped, { status: res.status, headers });
    }

    return res.text().then(
      (text) => {
        lease.release();
        let usage: Usage | null = null;
        try {
          usage = parseOpenAiUsage((JSON.parse(text) as { usage?: unknown }).usage);
        } catch {
          // Non-JSON 200 body: pass through, bill nothing.
        }
        record(usage, "ok");
        return new Response(text, { status: res.status, headers });
      },
      (error: Error) => {
        lease.release();
        record(null, "error");
        throw new HttpError(502, "upstream_error", `Upstream body failed: ${error.message}`);
      },
    );
  }

  return { now, log: deps.log, authenticate, run };
}

/** `POST /v1/chat/completions`: auth -> parse -> shared pipeline. */
export function createChatHandler(pipeline: Pipeline) {
  return async function chat(c: Context): Promise<Response> {
    const startedAt = pipeline.now();
    const key = pipeline.authenticate(c, startedAt);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", z.prettifyError(parsed.error));
    }
    return pipeline.run(c, key, parsed.data, startedAt);
  };
}

function passHeaders(res: Response): Headers {
  const headers = new Headers();
  for (const name of ["content-type", "retry-after", REQUEST_ID]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/** Maps any thrown error to the OpenAI-style envelope; Retry-After is derived where the cause knows it. */
export function toErrorResponse(error: unknown): {
  status: number;
  body: ReturnType<typeof errorBody>;
  headers: Record<string, string>;
} {
  if (error instanceof HttpError) {
    const headers: Record<string, string> = {};
    const retryAfter = error.extra?.retry_after;
    if (typeof retryAfter === "number") headers["retry-after"] = String(retryAfter);
    return {
      status: error.status,
      body: errorBody(error.code, error.message, error.extra),
      headers,
    };
  }
  return { status: 500, body: errorBody("internal_error", "Internal server error."), headers: {} };
}
