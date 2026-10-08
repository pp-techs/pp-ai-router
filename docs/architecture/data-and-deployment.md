# Data, accounting and deployment

## Storage

One SQLite file (`node:sqlite`, WAL, `foreign_keys=ON`, `STRICT` tables). `db/migrate.ts` applies `src/db/migrations/NNN_name.sql` files above `PRAGMA user_version`, each in its own transaction. Current migrations: `001_init.sql`, `002_provider_models.sql`.

| Table(s)                                                  | Holds                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `providers`, `credentials`, `model_aliases`               | Routing config; secrets in `credentials.secret_enc` (AES-256-GCM)                      |
| `provider_models`, `provider_model_sync`                  | Stored model lists and last sync outcome per provider                                  |
| `virtual_keys`, `limits`                                  | Client keys (SHA-256 only) and their limits                                            |
| `usage_buckets`                                           | Pre-aggregated per-key usage: minute buckets (windows <= 1 day), hour buckets (longer) |
| `usage_events`                                            | Append-only ledger, no foreign keys so history survives key/credential deletion        |
| `model_prices`, `pricing_overrides`, `pricing_sync_state` | Synced and manual prices (USD per token), sync ETags and errors                        |

Not persisted: pool health/cooldowns, sticky sessions, pending OAuth logins, Antigravity thought signatures.

## Accounting and limits

`Accounting.record` runs in one transaction: ledger row (`usage_events`), bump of the key's buckets, and the pool's balancing counters. Cost = `computeCost(price, usage)` (cached/reasoning tokens, long-context tiers); no price -> $0 with `price_source=unknown`. `UsageMeter` evaluates limits (`metric` x `window` x `mode` fixed/rolling) from buckets; rolling windows include the partially aged oldest bucket, so they err towards blocking.

## Pricing

`pricing/sync.ts` pulls LiteLLM and OpenRouter on `PRICING_SYNC_INTERVAL_HOURS` (default 24, ETag-aware, `PRICING_SYNC_ENABLED`). Lookup order: override > litellm > openrouter > unknown (`price_source`).

## Process model

`main.ts` loads config (Zod, fails fast), builds everything with `createServices` (`app.ts`, also used by tests), starts the pricing scheduler and model sync, serves with `@hono/node-server`, and stops timers on SIGINT/SIGTERM. Synchronous SQLite calls make a limit check followed by a record atomic within the process. **Run a single replica.**

## Deployment

Single Docker image (`Dockerfile`, `compose.yaml`): multi-stage build with the Vite+ image builds `apps/web`; production-only server deps; `debian:bookworm-slim` runtime runs `node src/main.ts` (Node 24 strips types, no compile step) as non-root `router` (uid 10001). The server serves the built UI (`WEB_DIST=/app/web`) from the same port: UI at `/`, API at `/v1/*`, `/admin/*`, `/healthz`; any other GET falls back to `index.html`. State volume `/data` (`DB_PATH=/data/router.db`); health check on `/healthz`. Back up `/data` **and** `MASTER_KEY`.

## Configuration

Env vars validated in `apps/server/src/config.ts` (template: `apps/server/.env.example`): `MASTER_KEY` (base64 of 32 bytes) and `ADMIN_TOKEN` (>= 16 chars) are required; optional `HOST`, `PORT`, `DB_PATH`, `PRICING_SYNC_ENABLED`, `PRICING_SYNC_INTERVAL_HOURS`, `MODEL_SYNC_INTERVAL_HOURS`, `UNPRICED_MODELS`, `UPSTREAM_TIMEOUT_MS`, `WEB_DIST`. Antigravity also reads `GOOGLE_ANTIGRAVITY_CLIENT_ID`, `GOOGLE_ANTIGRAVITY_CLIENT_SECRET`, `GOOGLE_ANTIGRAVITY_USER_AGENT`.
