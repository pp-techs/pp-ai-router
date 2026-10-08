-- Upstream providers. `type` selects the adapter, `key_strategy` selects how a credential is picked.
CREATE TABLE providers (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  base_url         TEXT NOT NULL,
  key_strategy     TEXT NOT NULL DEFAULT 'round_robin',
  sticky_ttl_sec   INTEGER NOT NULL DEFAULT 0,
  max_key_attempts INTEGER NOT NULL DEFAULT 3,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
) STRICT;

-- Upstream credentials (API keys / OAuth accounts). Many per provider.
CREATE TABLE credentials (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'api_key',
  secret_enc  TEXT NOT NULL,
  weight      INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 0,
  models      TEXT,            -- JSON array of glob patterns; NULL = every model
  rpm_limit   INTEGER,         -- per-credential requests per minute; NULL = unlimited
  enabled     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | dead
  last_error  TEXT,
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX credentials_provider ON credentials(provider_id);

-- Public model name -> ordered list of upstream targets (first = preferred, rest = fallback).
CREATE TABLE model_aliases (
  alias      TEXT PRIMARY KEY,
  targets    TEXT NOT NULL,    -- JSON [{provider, model}]
  created_at INTEGER NOT NULL
) STRICT;

-- Virtual keys handed to clients. Only a SHA-256 of the key is stored.
CREATE TABLE virtual_keys (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  key_hash       TEXT NOT NULL UNIQUE,
  key_prefix     TEXT NOT NULL,
  allowed_models TEXT,         -- JSON array of glob patterns; NULL = every model
  expires_at     INTEGER,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
) STRICT;

-- window_sec NULL = lifetime total. mode: fixed (aligned to epoch, UTC) | rolling.
CREATE TABLE limits (
  id         TEXT PRIMARY KEY,
  key_id     TEXT NOT NULL REFERENCES virtual_keys(id) ON DELETE CASCADE,
  metric     TEXT NOT NULL CHECK (metric IN ('usd','input_tokens','output_tokens','total_tokens','requests')),
  window_sec INTEGER CHECK (window_sec IS NULL OR window_sec >= 60),
  mode       TEXT NOT NULL DEFAULT 'fixed' CHECK (mode IN ('fixed','rolling')),
  max_value  REAL NOT NULL CHECK (max_value >= 0),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX limits_key ON limits(key_id);

-- Pre-aggregated usage. granularity 60 (minute) serves windows <= 1 day, 3600 (hour) the rest.
CREATE TABLE usage_buckets (
  key_id        TEXT NOT NULL REFERENCES virtual_keys(id) ON DELETE CASCADE,
  granularity   INTEGER NOT NULL,
  bucket_start  INTEGER NOT NULL,  -- unix seconds
  requests      INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, granularity, bucket_start)
) STRICT, WITHOUT ROWID;

-- Append-only ledger. No FKs so history survives deleting keys / credentials.
CREATE TABLE usage_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,   -- unix ms
  key_id           TEXT NOT NULL,
  provider_id      TEXT NOT NULL,
  credential_id    TEXT NOT NULL,
  model            TEXT NOT NULL,      -- model as requested by the client
  upstream_model   TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL,
  output_tokens    INTEGER NOT NULL,
  cached_tokens    INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  cost_usd         REAL NOT NULL,
  price_source     TEXT NOT NULL,      -- override | litellm | openrouter | unknown
  stream           INTEGER NOT NULL,
  status           TEXT NOT NULL,      -- ok | aborted | error | no_usage
  latency_ms       INTEGER NOT NULL
) STRICT;
CREATE INDEX usage_events_key_ts ON usage_events(key_id, ts);
CREATE INDEX usage_events_cred_ts ON usage_events(credential_id, ts);

-- Prices in USD per token. tiers: JSON [{aboveTokens, input?, output?, cacheRead?, cacheWrite?}] ascending.
CREATE TABLE model_prices (
  source       TEXT NOT NULL,
  model        TEXT NOT NULL,
  input_cost   REAL NOT NULL,
  output_cost  REAL NOT NULL,
  cache_read_cost  REAL,
  cache_write_cost REAL,
  reasoning_cost   REAL,
  tiers        TEXT NOT NULL DEFAULT '[]',
  fetched_at   INTEGER NOT NULL,
  PRIMARY KEY (source, model)
) STRICT, WITHOUT ROWID;

CREATE TABLE pricing_overrides (
  model            TEXT PRIMARY KEY,
  input_cost       REAL NOT NULL,
  output_cost      REAL NOT NULL,
  cache_read_cost  REAL,
  cache_write_cost REAL,
  created_at       INTEGER NOT NULL
) STRICT;

CREATE TABLE pricing_sync_state (
  source      TEXT PRIMARY KEY,
  etag        TEXT,
  synced_at   INTEGER,
  model_count INTEGER,
  last_error  TEXT
) STRICT;
