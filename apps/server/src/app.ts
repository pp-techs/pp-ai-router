import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { SecretBox } from "./crypto.ts";
import type { Config } from "./config.ts";
import { openDatabase, type Db } from "./db/database.ts";
import { createAdminApp } from "./admin/routes.ts";
import { Accounting } from "./gateway/accounting.ts";
import { createChatHandler, createPipeline, toErrorResponse } from "./gateway/chat.ts";
import { createMessagesHandler } from "./gateway/messages.ts";
import { UsageMeter } from "./governance/limits.ts";
import { isModelAllowed, VirtualKeyStore } from "./governance/virtual-keys.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { LoginSessions } from "./oauth/login-sessions.ts";
import { TokenManager } from "./oauth/token-manager.ts";
import { CredentialPool } from "./pool/pool.ts";
import { QuotaService } from "./quota/service.ts";
import { RecentUsage } from "./pool/recent-usage.ts";
import { PricingStore } from "./pricing/store.ts";
import { ADAPTERS, type ProviderAdapter } from "./providers/adapter.ts";
import { listClientModels } from "./client-models.ts";
import { ModelMetadataStore } from "./model-metadata.ts";
import { ModelCatalog } from "./models.ts";
import { Registry } from "./registry.ts";
import { AuditLogStore } from "./audit/store.ts";

export interface Services {
  app: Hono;
  db: Db;
  pricing: PricingStore;
  metadata: ModelMetadataStore;
  registry: Registry;
  pool: CredentialPool;
  keys: VirtualKeyStore;
  meter: UsageMeter;
  tokens: TokenManager;
  logins: LoginSessions;
  models: ModelCatalog;
  quota: QuotaService;
  audit: AuditLogStore;
}

export type AppConfig = Pick<
  Config,
  "DB_PATH" | "MASTER_KEY" | "ADMIN_TOKEN" | "UNPRICED_MODELS" | "UPSTREAM_TIMEOUT_MS"
> &
  Partial<Pick<Config, "WEB_DIST">>;

export interface ServiceOptions {
  /** Inject a database (tests use `:memory:`). */
  db?: Db;
  log?: Logger;
  /** Makes time deterministic in tests. */
  now?: () => number;
  /** Replace the provider adapters (tests plug in fakes). */
  adapters?: Readonly<Record<string, ProviderAdapter>>;
}

const API_PREFIXES = ["/v1/", "/admin/", "/healthz"];

/** Wires every module together and returns the Hono app plus the services tests need to poke at. */
export function createServices(config: AppConfig, options: ServiceOptions = {}): Services {
  const log = options.log ?? silentLogger;
  const now = options.now ?? Date.now;
  const adapters = options.adapters ?? ADAPTERS;
  const db = options.db ?? openDatabase(config.DB_PATH);
  const box = new SecretBox(Buffer.from(config.MASTER_KEY, "base64"));

  const pricing = new PricingStore(db);
  const metadata = new ModelMetadataStore(db);
  const registry = new Registry(db, box);
  const recent = new RecentUsage();
  recent.load(db, now());
  const pool = new CredentialPool(registry, recent, now);
  const keys = new VirtualKeyStore(db);
  const meter = new UsageMeter(db);
  const audit = new AuditLogStore(db, log, now);
  const accounting = new Accounting(db, meter, pool, now, audit);
  const tokens = new TokenManager(registry, adapters, log, now);
  const logins = new LoginSessions(db, box, registry, adapters, now);
  const models = new ModelCatalog(db, registry, tokens, adapters, log, metadata, now);
  const quota = new QuotaService(registry, pool, tokens, adapters, log, now);

  const app = new Hono();
  app.onError((error, c) => {
    const { status, body, headers } = toErrorResponse(error);
    if (status >= 500 && status !== 502 && status !== 503)
      log.error("unhandled error", { error: String(error), path: c.req.path });
    for (const [k, v] of Object.entries(headers)) c.header(k, v);
    return c.json(body, status as 400);
  });
  app.notFound((c) =>
    c.json({ error: { message: "Not found.", type: "not_found", code: "not_found" } }, 404),
  );

  app.get("/healthz", (c) => c.json({ ok: true }));

  const pipeline = createPipeline({
    config,
    db,
    keys,
    meter,
    registry,
    pool,
    pricing,
    accounting,
    log,
    tokens,
    quota,
    adapters,
    now,
  });
  app.post("/v1/chat/completions", createChatHandler(pipeline));
  app.post("/v1/messages", createMessagesHandler(pipeline));

  app.get("/v1/models", (c) => {
    const header = c.req.header("authorization") ?? "";
    const secret = header.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : c.req.header("x-api-key");
    const key = secret ? keys.authenticate(secret, now()) : null;
    if (!key)
      return c.json(
        {
          error: {
            message: "Missing, unknown, disabled or expired API key.",
            type: "invalid_api_key",
            code: "invalid_api_key",
          },
        },
        401,
      );
    const verbose = ["1", "true"].includes(c.req.query("verbose") ?? "");
    const data = listClientModels(
      { registry, models, pricing },
      (id) => isModelAllowed(key, id),
      verbose,
    );
    return c.json({ object: "list", data });
  });

  app.route(
    "/admin",
    createAdminApp({
      adminToken: config.ADMIN_TOKEN,
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
      log,
      audit,
      now,
    }),
  );

  if (config.WEB_DIST) mountWeb(app, resolve(config.WEB_DIST), log);

  return {
    app,
    db,
    pricing,
    metadata,
    registry,
    pool,
    keys,
    meter,
    tokens,
    logins,
    models,
    quota,
    audit,
  };
}

/**
 * Serves the built admin UI from the same origin as the API: real files first, then `index.html` for
 * any other GET so client-side routes survive a refresh. API paths are never shadowed by the fallback.
 */
function mountWeb(app: Hono, root: string, log: Logger): void {
  if (!existsSync(resolve(root, "index.html"))) {
    log.warn("WEB_DIST has no index.html; admin UI disabled", { root });
    return;
  }
  app.use("*", serveStatic({ root }));
  app.get("*", (c, next) =>
    API_PREFIXES.some((p) => c.req.path === p.replace(/\/$/, "") || c.req.path.startsWith(p))
      ? next()
      : serveStatic({ root, path: "index.html" })(c, next),
  );
}
