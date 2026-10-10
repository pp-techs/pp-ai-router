import { timingSafeEqual, createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import * as z from "zod";
import { insertCredential } from "../credentials.ts";
import type { SecretBox } from "../crypto.ts";
import { all, one, type Db } from "../db/database.ts";
import { HttpError } from "../errors.ts";
import {
  formatWindow,
  listLimits,
  METRICS,
  parseWindow,
  type Limit,
  type UsageMeter,
} from "../governance/limits.ts";
import type { VirtualKey, VirtualKeyStore } from "../governance/virtual-keys.ts";
import type { CredentialPool } from "../pool/pool.ts";
import { STRATEGIES } from "../pool/selectors.ts";
import type { PricingStore } from "../pricing/store.ts";
import type { ModelPrice } from "../pricing/types.ts";
import { syncPricing } from "../pricing/sync.ts";
import type { ProviderAdapter } from "../providers/adapter.ts";
import type { ModelCatalog, ModelList } from "../models.ts";
import type { ModelMetadataStore } from "../model-metadata.ts";
import { LoginError, type LoginSessions, type SessionStatus } from "../oauth/login-sessions.ts";
import type { LoginStartInfo } from "../oauth/types.ts";
import type { QuotaService, QuotaStatus } from "../quota/service.ts";
import type { Registry } from "../registry.ts";
import type { Logger } from "../logger.ts";
import type { AuditLogStore } from "../audit/store.ts";

export interface AdminDeps {
  adminToken: string;
  db: Db;
  box: SecretBox;
  registry: Registry;
  pool: CredentialPool;
  keys: VirtualKeyStore;
  meter: UsageMeter;
  pricing: PricingStore;
  metadata: ModelMetadataStore;
  adapters: Readonly<Record<string, ProviderAdapter>>;
  logins: LoginSessions;
  models: ModelCatalog;
  quota: QuotaService;
  log: Logger;
  audit?: AuditLogStore;
  now?: () => number;
}

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "lowercase letters, digits, '-' or '_'");
const globs = z.array(z.string().min(1)).min(1).nullable();
const httpUrl = z.url({ protocol: /^https?$/ });
const perMillion = z.number().min(0).max(1_000_000);

const providerCreate = z.strictObject({
  id: slug,
  type: z.string().min(1),
  base_url: httpUrl.optional(),
  key_strategy: z.enum(STRATEGIES).default("round_robin"),
  sticky_ttl_sec: z.number().int().min(0).max(86_400).default(0),
  max_key_attempts: z.number().int().min(1).max(20).default(3),
  enabled: z.boolean().default(true),
});
const providerPatch = providerCreate.omit({ id: true, type: true }).partial().strict();

const credentialFields = {
  label: z.string().min(1).max(100),
  weight: z.number().int().min(1).max(1000),
  priority: z.number().int().min(-1000).max(1000),
  models: globs,
  rpm_limit: z.number().int().min(1).nullable(),
  enabled: z.boolean(),
};
const credentialCreate = z.strictObject({
  kind: z.literal("api_key").default("api_key"),
  secret: z.string().min(1),
  label: credentialFields.label,
  weight: credentialFields.weight.default(1),
  priority: credentialFields.priority.default(0),
  models: credentialFields.models.default(null),
  rpm_limit: credentialFields.rpm_limit.default(null),
  enabled: credentialFields.enabled.default(true),
});
const credentialPatch = z
  .strictObject({ ...credentialFields, secret: z.string().min(1), status: z.literal("active") })
  .partial();

const aliasBody = z.strictObject({
  targets: z
    .array(z.strictObject({ provider: slug, model: z.string().min(1) }))
    .min(1)
    .max(20),
});
const modelPatch = z.strictObject({ enabled: z.boolean() });

const limitInput = z.strictObject({
  metric: z.enum(METRICS),
  window: z.string().default("total"),
  mode: z.enum(["fixed", "rolling"]).default("fixed"),
  max: z.number().min(0),
});
const keyCreate = z.strictObject({
  name: z.string().min(1).max(100),
  allowed_models: globs.default(null),
  expires_at: z.number().int().positive().nullable().default(null),
  limits: z.array(limitInput).max(20).default([]),
});
const keyPatch = z
  .strictObject({
    name: z.string().min(1).max(100),
    allowed_models: globs,
    expires_at: z.number().int().positive().nullable(),
    enabled: z.boolean(),
  })
  .partial();

const overrideBody = z.strictObject({
  model: z.string().min(1),
  input_per_1m: perMillion,
  output_per_1m: perMillion,
  cache_read_per_1m: perMillion.optional(),
  cache_write_per_1m: perMillion.optional(),
});

async function parse<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(400, "invalid_request", z.prettifyError(result.error));
  return result.data;
}

const sha = (s: string) => createHash("sha256").update(s).digest();
// Prices are stored per token; rounding to 12 significant digits hides binary float noise (0.19999999999999998 -> 0.2).
const per1m = (v: number | undefined) =>
  v === undefined ? null : Number((v * 1_000_000).toPrecision(12));

function priceView(p: ModelPrice) {
  return {
    model: p.model,
    source: p.source,
    input_per_1m: per1m(p.input),
    output_per_1m: per1m(p.output),
    cache_read_per_1m: per1m(p.cacheRead),
    cache_write_per_1m: per1m(p.cacheWrite),
    reasoning_per_1m: per1m(p.reasoning),
    tiers: p.tiers,
  };
}

function parseLimit(input: z.infer<typeof limitInput>) {
  try {
    return {
      metric: input.metric,
      windowSec: parseWindow(input.window),
      mode: input.mode,
      max: input.max,
    };
  } catch (error) {
    throw new HttpError(400, "invalid_request", (error as Error).message);
  }
}

export function createAdminApp(deps: AdminDeps): Hono {
  const {
    db,
    box,
    registry,
    pool,
    keys,
    meter,
    pricing,
    metadata,
    adapters,
    logins,
    models,
    quota,
    audit,
  } = deps;
  const now = deps.now ?? Date.now;
  const app = new Hono();
  const expected = sha(deps.adminToken);

  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!timingSafeEqual(sha(presented), expected))
      throw new HttpError(401, "unauthorized", "Invalid admin token.");
    await next();
  });

  const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found.`);
  const limitView = (l: Limit) => {
    const s = meter.status(l, now());
    return {
      id: l.id,
      metric: l.metric,
      window: formatWindow(l.windowSec),
      mode: l.mode,
      max: l.max,
      used: s.used,
      resets_at: s.resetsAt,
    };
  };
  const keyView = (k: VirtualKey) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    allowed_models: k.allowedModels,
    expires_at: k.expiresAt,
    enabled: k.enabled,
    created_at: k.createdAt,
    limits: listLimits(db, k.id).map(limitView),
  });

  // ---- audit logs -----------------------------------------------------------------------
  app.get("/audit-logs", (c) => {
    if (!audit) return c.json({ data: [] });
    const q = c.req.query();
    const category = q.category === "admin" || q.category === "gateway" ? q.category : undefined;
    const status = q.status === "success" || q.status === "failure" ? q.status : undefined;
    const since = q.since ? Number(q.since) : undefined;
    const until = q.until ? Number(q.until) : undefined;
    const before = q.before ? Number(q.before) : undefined;
    const limit = q.limit ? Number(q.limit) : undefined;
    const rows = audit.list({
      category,
      action: q.action,
      actor: q.actor,
      target_type: q.target_type,
      target_id: q.target_id,
      status,
      since: Number.isFinite(since) ? since : undefined,
      until: Number.isFinite(until) ? until : undefined,
      before: Number.isFinite(before) ? before : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return c.json({ data: rows });
  });

  // ---- providers -------------------------------------------------------------------------
  app.get("/providers", (c) =>
    c.json({
      data: registry.providers().map((p) => ({
        id: p.id,
        type: p.type,
        base_url: p.baseUrl,
        key_strategy: p.strategy,
        sticky_ttl_sec: p.stickyTtlMs / 1000,
        max_key_attempts: p.maxKeyAttempts,
        enabled: p.enabled,
        credentials: p.credentials.length,
        oauth: Boolean(adapters[p.type]?.oauth),
      })),
    }),
  );

  app.get("/provider-types", (c) =>
    c.json({
      data: Object.values(adapters).map((a) => ({
        type: a.type,
        label: a.label,
        default_base_url: a.defaultBaseUrl,
        oauth: a.oauth ? { label: a.oauth.label } : null,
        models: a.staticModels ? "static" : a.listModels ? "fetch" : "none",
        quota: a.quota !== undefined,
      })),
    }),
  );

  app.post("/providers", async (c) => {
    const b = await parse(c, providerCreate);
    const adapter = adapters[b.type];
    if (!adapter)
      throw new HttpError(
        400,
        "invalid_request",
        `Unknown provider type "${b.type}". Known: ${Object.keys(adapters).join(", ")}.`,
      );
    const baseUrl = b.base_url ?? adapter.defaultBaseUrl;
    if (!baseUrl)
      throw new HttpError(400, "invalid_request", "base_url is required for this provider type.");
    if (registry.provider(b.id))
      throw new HttpError(409, "conflict", `Provider "${b.id}" already exists.`);
    db.prepare(
      `INSERT INTO providers (id, type, base_url, key_strategy, sticky_ttl_sec, max_key_attempts, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      b.id,
      b.type,
      baseUrl,
      b.key_strategy,
      b.sticky_ttl_sec,
      b.max_key_attempts,
      b.enabled ? 1 : 0,
      now(),
    );
    registry.reload();
    audit?.record({
      category: "admin",
      action: "provider.create",
      actor: "admin",
      targetType: "provider",
      targetId: b.id,
      status: "success",
      statusCode: 201,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      details: { type: b.type, base_url: baseUrl, key_strategy: b.key_strategy },
    });
    return c.json({ id: b.id }, 201);
  });

  app.patch("/providers/:id", async (c) => {
    const id = c.req.param("id");
    const current = registry.provider(id);
    if (!current) throw notFound("Provider");
    const b = await parse(c, providerPatch);
    db.prepare(
      "UPDATE providers SET base_url = ?, key_strategy = ?, sticky_ttl_sec = ?, max_key_attempts = ?, enabled = ? WHERE id = ?",
    ).run(
      b.base_url ?? current.baseUrl,
      b.key_strategy ?? current.strategy,
      b.sticky_ttl_sec ?? current.stickyTtlMs / 1000,
      b.max_key_attempts ?? current.maxKeyAttempts,
      (b.enabled ?? current.enabled) ? 1 : 0,
      id,
    );
    registry.reload();
    audit?.record({
      category: "admin",
      action: "provider.update",
      actor: "admin",
      targetType: "provider",
      targetId: id,
      status: "success",
      statusCode: 200,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      details: b,
    });
    return c.json({ id });
  });

  app.delete("/providers/:id", (c) => {
    const removed =
      db.prepare("DELETE FROM providers WHERE id = ?").run(c.req.param("id")).changes > 0;
    if (!removed) throw notFound("Provider");
    registry.reload();
    audit?.record({
      category: "admin",
      action: "provider.delete",
      actor: "admin",
      targetType: "provider",
      targetId: c.req.param("id"),
      status: "success",
      statusCode: 204,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    return c.body(null, 204);
  });

  // ---- credentials -----------------------------------------------------------------------
  const credentialView = (
    cred: ReturnType<Registry["providers"]>[number]["credentials"][number],
  ) => {
    const live = pool.snapshot(cred.id);
    return {
      id: cred.id,
      provider_id: cred.providerId,
      label: cred.label,
      kind: cred.kind,
      secret_hint: cred.auth.type === "api_key" ? `…${cred.auth.key.slice(-4)}` : null,
      account: cred.auth.type === "oauth" ? (cred.auth.tokens.account ?? null) : null,
      expires_at: cred.auth.type === "oauth" ? cred.auth.tokens.expiresAt : null,
      weight: cred.weight,
      priority: cred.priority,
      models: cred.models,
      rpm_limit: cred.rpmLimit,
      enabled: cred.enabled,
      status: cred.status,
      last_error: cred.lastError,
      inflight: live.inflight,
      fail_count: live.failCount,
      cooldown_until: live.cooldownUntil,
    };
  };
  // ---- provider models (fixed list for OAuth providers, fetched + stored for the rest) ---------
  const modelsView = (providerId: string, list: ModelList) => ({
    source: list.source,
    fetched_at: list.fetchedAt,
    error: list.error,
    data: list.models.map((m) => {
      const price = pricing.lookup([`${providerId}/${m.id}`, m.id]);
      return {
        id: m.id,
        name: m.name ?? null,
        context_window: m.contextWindow ?? null,
        description: m.description ?? null,
        created: m.created ?? null,
        max_output_tokens: m.maxOutputTokens ?? null,
        input_modalities: m.inputModalities ?? null,
        output_modalities: m.outputModalities ?? null,
        supported_parameters: m.supportedParameters ?? null,
        // Which facts did not come from the provider itself, e.g. `{ context_window: "openrouter" }`.
        sources: m.sources
          ? Object.fromEntries(
              Object.entries(m.sources).map(([k, v]) => [
                k.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`),
                v,
              ]),
            )
          : null,
        enabled: !registry.isModelDisabled(providerId, m.id),
        price: price
          ? {
              input_per_1m: per1m(price.input),
              output_per_1m: per1m(price.output),
              source: price.source,
            }
          : null,
      };
    }),
  });

  /** Stored list; the first view of a provider that was never fetched triggers a fetch. */
  app.get("/providers/:id/models", async (c) => {
    const id = c.req.param("id");
    if (!registry.provider(id)) throw notFound("Provider");
    return c.json(modelsView(id, await models.ensure(id)));
  });

  /** Forces a fetch; a failure is reported in `error` and the previous list is kept. */
  app.post("/providers/:id/models/refresh", async (c) => {
    const id = c.req.param("id");
    if (!registry.provider(id)) throw notFound("Provider");
    return c.json(modelsView(id, await models.refresh(id)));
  });

  /** Every provider's stored model list in one call (no upstream fetches), for the Models page. */
  app.get("/models", (c) =>
    c.json({
      data: registry.providers().map((p) => ({
        provider: p.id,
        type: p.type,
        provider_enabled: p.enabled,
        ...modelsView(p.id, models.get(p.id)),
      })),
    }),
  );

  /** Switches one model on or off. Any `provider/model` id can be routed to, so it need not be in the list. */
  app.patch("/models/:provider/:model{.+}", async (c) => {
    const provider = c.req.param("provider");
    const model = c.req.param("model");
    if (!registry.provider(provider)) throw notFound("Provider");
    const { enabled } = await parse(c, modelPatch);
    if (enabled) {
      db.prepare("DELETE FROM disabled_models WHERE provider_id = ? AND model_id = ?").run(
        provider,
        model,
      );
    } else {
      db.prepare(
        "INSERT OR IGNORE INTO disabled_models (provider_id, model_id, disabled_at) VALUES (?, ?, ?)",
      ).run(provider, model, now());
    }
    registry.reload();
    audit?.record({
      category: "admin",
      action: enabled ? "model.enable" : "model.disable",
      actor: "admin",
      targetType: "model",
      targetId: `${provider}/${model}`,
      status: "success",
      statusCode: 200,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      details: { provider, model, enabled },
    });
    return c.json({ provider, id: model, enabled });
  });
  app.get("/providers/:id/credentials", (c) => {
    const provider = registry.provider(c.req.param("id"));
    if (!provider) throw notFound("Provider");
    return c.json({ data: provider.credentials.map(credentialView) });
  });

  // ---- OAuth account quota (cached; `?refresh=true` probes the upstream now) -------------------
  const quotaView = (
    status: QuotaStatus,
    credential: { label: string; account: string | null },
  ) => ({
    credential_id: status.credentialId,
    label: credential.label,
    account: credential.account,
    status: status.ok ? "ok" : "unavailable",
    failure: status.ok ? null : status.failure,
    checked_at: status.checkedAt,
    quota: status.ok
      ? {
          windows: status.quota.windows.map((w) => ({
            label: w.label,
            used_percent: w.usedPercent,
            resets_at: w.resetsAt,
          })),
          credits: status.quota.credits,
          exhausted: status.quota.exhausted,
          resets_at: status.quota.resetsAt,
        }
      : null,
  });
  const quotaOptions = (c: Context) => (c.req.query("refresh") === "true" ? { maxAgeMs: 0 } : {});
  const accountOf = (cred: { auth: { type: string; tokens?: { account?: string | undefined } } }) =>
    cred.auth.tokens?.account ?? null;

  app.get("/providers/:id/quota", async (c) => {
    const provider = registry.provider(c.req.param("id"));
    if (!provider) throw notFound("Provider");
    const supported = quota.supports(provider.type);
    const statuses = supported ? await quota.forProvider(provider.id, quotaOptions(c)) : [];
    const byId = new Map(provider.credentials.map((cred) => [cred.id, cred]));
    return c.json({
      supported,
      data: statuses.flatMap((s) => {
        const cred = byId.get(s.credentialId);
        return cred ? [quotaView(s, { label: cred.label, account: accountOf(cred) })] : [];
      }),
    });
  });

  app.get("/credentials/:id/quota", async (c) => {
    const id = c.req.param("id");
    const cred = registry
      .providers()
      .flatMap((p) => p.credentials)
      .find((x) => x.id === id);
    if (!cred) throw notFound("Credential");
    const status = await quota.get(id, quotaOptions(c));
    if (!status) throw notFound("Quota for this credential");
    return c.json(quotaView(status, { label: cred.label, account: accountOf(cred) }));
  });

  app.post("/providers/:id/credentials", async (c) => {
    const providerId = c.req.param("id");
    if (!registry.provider(providerId)) throw notFound("Provider");
    const b = await parse(c, credentialCreate);
    const id = insertCredential(
      db,
      box,
      {
        providerId,
        label: b.label,
        auth: { type: "api_key", key: b.secret },
        weight: b.weight,
        priority: b.priority,
        models: b.models,
        rpmLimit: b.rpm_limit,
        enabled: b.enabled,
      },
      now(),
    );
    registry.reload();
    audit?.record({
      category: "admin",
      action: "credential.create",
      actor: "admin",
      targetType: "credential",
      targetId: id,
      status: "success",
      statusCode: 201,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      details: { providerId, label: b.label, weight: b.weight, priority: b.priority },
    });
    return c.json({ id }, 201);
  });

  app.patch("/credentials/:id", async (c) => {
    const id = c.req.param("id");
    const row = one<{ kind: string }>(db.prepare("SELECT kind FROM credentials WHERE id = ?"), id);
    if (!row) throw notFound("Credential");
    const b = await parse(c, credentialPatch);
    if (b.secret !== undefined && row.kind !== "api_key")
      throw new HttpError(
        400,
        "invalid_request",
        "OAuth accounts have no secret to replace; sign in again to add a fresh account.",
      );
    // Column -> value; a Map so a replaced secret and an explicit revive cannot assign `status` twice.
    const columns = new Map<string, string | number | null>();
    if (b.label !== undefined) columns.set("label", b.label);
    if (b.secret !== undefined) columns.set("secret_enc", box.seal(b.secret));
    if (b.weight !== undefined) columns.set("weight", b.weight);
    if (b.priority !== undefined) columns.set("priority", b.priority);
    if (b.models !== undefined) columns.set("models", b.models && JSON.stringify(b.models));
    if (b.rpm_limit !== undefined) columns.set("rpm_limit", b.rpm_limit);
    if (b.enabled !== undefined) columns.set("enabled", b.enabled ? 1 : 0);
    if (b.secret !== undefined || b.status === "active") {
      // A replaced secret (or an explicit revive) puts a dead credential back in rotation.
      columns.set("status", "active");
      columns.set("last_error", null);
    }
    if (columns.size > 0) {
      const assignments = [...columns.keys()].map((column) => `${column} = ?`).join(", ");
      db.prepare(`UPDATE credentials SET ${assignments} WHERE id = ?`).run(...columns.values(), id);
    }
    registry.reload();
    audit?.record({
      category: "admin",
      action: "credential.update",
      actor: "admin",
      targetType: "credential",
      targetId: id,
      status: "success",
      statusCode: 200,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      details: {
        label: b.label,
        weight: b.weight,
        priority: b.priority,
        enabled: b.enabled,
        has_new_secret: b.secret !== undefined,
      },
    });
    return c.json({ id });
  });

  app.delete("/credentials/:id", (c) => {
    const removed =
      db.prepare("DELETE FROM credentials WHERE id = ?").run(c.req.param("id")).changes > 0;
    if (!removed) throw notFound("Credential");
    registry.reload();
    audit?.record({
      category: "admin",
      action: "credential.delete",
      actor: "admin",
      targetType: "credential",
      targetId: c.req.param("id"),
      status: "success",
      statusCode: 204,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    return c.body(null, 204);
  });

  // ---- OAuth login (browser-driven; see oauth/types.ts for the flows) ---------------------
  const loginBody = z.strictObject({
    label: credentialFields.label.optional(),
    weight: credentialFields.weight.optional(),
    priority: credentialFields.priority.optional(),
    models: credentialFields.models.optional(),
    rpm_limit: credentialFields.rpm_limit.optional(),
  });
  const loginInfoView = (info: LoginStartInfo) =>
    info.flow === "device"
      ? {
          flow: info.flow,
          verification_uri: info.verificationUri,
          verification_uri_complete: info.verificationUriComplete ?? null,
          user_code: info.userCode,
          interval_sec: info.intervalSec,
          expires_at: info.expiresAt,
        }
      : {
          flow: info.flow,
          auth_url: info.authUrl,
          instructions: info.instructions,
          expires_at: info.expiresAt,
        };
  const sessionView = (s: SessionStatus & { info?: LoginStartInfo }) => ({
    status: s.status,
    ...(s.status === "complete" && { credential_id: s.credentialId }),
    ...(s.status === "error" && { error: s.error }),
    ...(s.info && loginInfoView(s.info)),
  });
  const loginErrors = (error: unknown): never => {
    if (error instanceof LoginError)
      throw new HttpError(error.status, "oauth_error", error.message);
    throw error;
  };

  app.post("/providers/:id/oauth/start", async (c) => {
    const b = await parse(c, loginBody);
    try {
      const { id, info } = await logins.start(c.req.param("id"), {
        label: b.label,
        weight: b.weight,
        priority: b.priority,
        models: b.models,
        rpmLimit: b.rpm_limit,
      });
      return c.json({ session_id: id, ...loginInfoView(info) }, 201);
    } catch (error) {
      return loginErrors(error);
    }
  });

  app.get("/oauth/sessions/:id", async (c) => {
    try {
      return c.json(sessionView(await logins.status(c.req.param("id"))));
    } catch (error) {
      return loginErrors(error);
    }
  });

  app.post("/oauth/sessions/:id/complete", async (c) => {
    const b = await parse(c, z.strictObject({ input: z.string().min(1) }));
    try {
      return c.json(sessionView(await logins.complete(c.req.param("id"), b.input)));
    } catch (error) {
      return loginErrors(error);
    }
  });

  // ---- aliases ---------------------------------------------------------------------------
  app.get("/aliases", (c) =>
    c.json({
      data: all<{ alias: string; targets: string }>(
        db.prepare("SELECT alias, targets FROM model_aliases ORDER BY alias"),
      ).map((r) => ({
        alias: r.alias,
        targets: JSON.parse(r.targets) as unknown,
      })),
    }),
  );

  app.put("/aliases/:alias{.+}", async (c) => {
    const alias = c.req.param("alias");
    const b = await parse(c, aliasBody);
    for (const t of b.targets) {
      if (!registry.provider(t.provider))
        throw new HttpError(400, "invalid_request", `Unknown provider "${t.provider}".`);
    }
    db.prepare(
      `INSERT INTO model_aliases (alias, targets, created_at) VALUES (?, ?, ?)
       ON CONFLICT(alias) DO UPDATE SET targets = excluded.targets`,
    ).run(alias, JSON.stringify(b.targets), now());
    registry.reload();
    audit?.record({
      category: "admin",
      action: "alias.update",
      actor: "admin",
      targetType: "alias",
      targetId: alias,
      status: "success",
      statusCode: 200,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      details: { targets: b.targets },
    });
    return c.json({ alias });
  });

  app.delete("/aliases/:alias{.+}", (c) => {
    const removed =
      db.prepare("DELETE FROM model_aliases WHERE alias = ?").run(c.req.param("alias")).changes > 0;
    if (!removed) throw notFound("Alias");
    registry.reload();
    audit?.record({
      category: "admin",
      action: "alias.delete",
      actor: "admin",
      targetType: "alias",
      targetId: c.req.param("alias"),
      status: "success",
      statusCode: 204,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    return c.body(null, 204);
  });

  // ---- virtual keys & limits ------------------------------------------------------------
  app.get("/keys", (c) => c.json({ data: keys.list().map(keyView) }));

  app.post("/keys", async (c) => {
    const b = await parse(c, keyCreate);
    const limits = b.limits.map(parseLimit); // validate everything before writing anything
    const { key, plaintext } = keys.create(
      { name: b.name, allowedModels: b.allowed_models, expiresAt: b.expires_at },
      now(),
    );
    for (const l of limits) keys.addLimit(key.id, l, now());
    audit?.record({
      category: "admin",
      action: "key.create",
      actor: "admin",
      targetType: "key",
      targetId: key.id,
      status: "success",
      statusCode: 201,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      details: { name: b.name, allowed_models: b.allowed_models, expires_at: b.expires_at },
    });
    return c.json({ ...keyView(key), key: plaintext }, 201);
  });

  app.get("/keys/:id", (c) => {
    const key = keys.get(c.req.param("id"));
    if (!key) throw notFound("Key");
    return c.json(keyView(key));
  });

  app.patch("/keys/:id", async (c) => {
    const b = await parse(c, keyPatch);
    const patch: Parameters<VirtualKeyStore["update"]>[1] = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.allowed_models !== undefined) patch.allowedModels = b.allowed_models;
    if (b.expires_at !== undefined) patch.expiresAt = b.expires_at;
    if (b.enabled !== undefined) patch.enabled = b.enabled;
    const key = keys.update(c.req.param("id"), patch);
    if (!key) throw notFound("Key");
    audit?.record({
      category: "admin",
      action: "key.update",
      actor: "admin",
      targetType: "key",
      targetId: c.req.param("id"),
      status: "success",
      statusCode: 200,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      details: patch,
    });
    return c.json(keyView(key));
  });

  app.delete("/keys/:id", (c) => {
    if (!keys.delete(c.req.param("id"))) throw notFound("Key");
    audit?.record({
      category: "admin",
      action: "key.delete",
      actor: "admin",
      targetType: "key",
      targetId: c.req.param("id"),
      status: "success",
      statusCode: 204,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    return c.body(null, 204);
  });

  app.post("/keys/:id/limits", async (c) => {
    const key = keys.get(c.req.param("id"));
    if (!key) throw notFound("Key");
    const limit = keys.addLimit(key.id, parseLimit(await parse(c, limitInput)), now());
    audit?.record({
      category: "admin",
      action: "limit.create",
      actor: "admin",
      targetType: "limit",
      targetId: limit.id,
      status: "success",
      statusCode: 201,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      details: { key_id: key.id, metric: limit.metric, max: limit.max },
    });
    return c.json(limitView(limit), 201);
  });

  app.delete("/limits/:id", (c) => {
    if (!keys.deleteLimit(c.req.param("id"))) throw notFound("Limit");
    audit?.record({
      category: "admin",
      action: "limit.delete",
      actor: "admin",
      targetType: "limit",
      targetId: c.req.param("id"),
      status: "success",
      statusCode: 204,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    return c.body(null, 204);
  });

  // ---- usage -----------------------------------------------------------------------------
  app.get("/usage", (c) => {
    const q = c.req.query();
    const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 1000);
    const where: string[] = [];
    const params: (string | number)[] = [];
    for (const [param, column] of [
      ["key_id", "key_id"],
      ["provider_id", "provider_id"],
      ["credential_id", "credential_id"],
      ["model", "model"],
    ] as const) {
      const v = q[param];
      if (v) {
        where.push(`${column} = ?`);
        params.push(v);
      }
    }
    if (q.before) {
      where.push("id < ?");
      params.push(Number(q.before));
    }
    const rows = all<Record<string, unknown>>(
      db.prepare(
        `SELECT * FROM usage_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
      ),
      ...params,
      limit,
    );
    return c.json({ data: rows });
  });

  app.get("/usage/summary", (c) => {
    const q = c.req.query();
    const since = Number(q.since ?? now() - 86_400_000);
    const group =
      q.group_by === "provider" ? "provider_id" : q.group_by === "key" ? "key_id" : "model";
    const rows = all<Record<string, unknown>>(
      db.prepare(
        `SELECT ${group} AS "group", COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd, SUM(price_source = 'unknown') AS unpriced_requests
           FROM usage_events WHERE ts >= ? ${q.key_id ? "AND key_id = ?" : ""} GROUP BY ${group} ORDER BY cost_usd DESC`,
      ),
      ...(q.key_id ? [since, q.key_id] : [since]),
    );
    return c.json({ since, group_by: group, data: rows });
  });

  // Non-empty buckets only, aligned to multiples of `bucket_ms` since the epoch; the UI fills gaps.
  app.get("/usage/timeline", (c) => {
    const q = c.req.query();
    const since = Number(q.since ?? now() - 86_400_000);
    const bucketMs = Math.floor(Number(q.bucket_ms));
    if (!Number.isFinite(since) || !Number.isFinite(bucketMs) || bucketMs < 1000) {
      throw new HttpError(400, "invalid_request", "bucket_ms must be an integer of at least 1000");
    }
    const rows = all<Record<string, unknown>>(
      db.prepare(
        `SELECT CAST(ts / ?1 AS INTEGER) * ?1 AS ts, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd
           FROM usage_events WHERE ts >= ?2 ${q.key_id ? "AND key_id = ?3" : ""} GROUP BY 1 ORDER BY 1`,
      ),
      ...(q.key_id ? [bucketMs, since, q.key_id] : [bucketMs, since]),
    );
    return c.json({ since, bucket_ms: bucketMs, data: rows });
  });

  // ---- pricing ---------------------------------------------------------------------------
  app.get("/pricing", (c) =>
    c.json({
      data: pricing
        .search(c.req.query("q"), Math.min(Number(c.req.query("limit") ?? 50) || 50, 500))
        .map(priceView),
    }),
  );
  app.get("/pricing/lookup", (c) => {
    const model = c.req.query("model");
    if (!model) throw new HttpError(400, "invalid_request", "model query parameter is required.");
    const price = pricing.lookup(c.req.queries("model") ?? [model]);
    if (!price) throw notFound("Price");
    return c.json(priceView(price));
  });
  app.get("/pricing/sync", (c) => c.json({ data: pricing.syncStates() }));
  app.post("/pricing/sync", async (c) =>
    c.json({
      data: await syncPricing({ store: pricing, metadata, log: (m) => deps.log.info(m) }),
    }),
  );
  app.get("/pricing/overrides", (c) => c.json({ data: pricing.listOverrides().map(priceView) }));
  app.put("/pricing/overrides", async (c) => {
    const b = await parse(c, overrideBody);
    pricing.setOverride(
      {
        model: b.model,
        input: b.input_per_1m / 1e6,
        output: b.output_per_1m / 1e6,
        cacheRead: b.cache_read_per_1m === undefined ? undefined : b.cache_read_per_1m / 1e6,
        cacheWrite: b.cache_write_per_1m === undefined ? undefined : b.cache_write_per_1m / 1e6,
      },
      now(),
    );
    audit?.record({
      category: "admin",
      action: "pricing.override",
      actor: "admin",
      targetType: "pricing",
      targetId: b.model,
      status: "success",
      statusCode: 200,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      details: { model: b.model, input_per_1m: b.input_per_1m, output_per_1m: b.output_per_1m },
    });
    return c.json({ model: b.model });
  });
  app.delete("/pricing/overrides", (c) => {
    const model = c.req.query("model");
    if (!model || !pricing.deleteOverride(model)) throw notFound("Override");
    audit?.record({
      category: "admin",
      action: "pricing.delete_override",
      actor: "admin",
      targetType: "pricing",
      targetId: model,
      status: "success",
      statusCode: 204,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    return c.body(null, 204);
  });

  return app;
}
