-- Models each provider offers (fetched from the upstream, or copied from an adapter's fixed list on demand).
CREATE TABLE provider_models (
  provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id       TEXT NOT NULL,
  name           TEXT,
  context_window INTEGER,
  PRIMARY KEY (provider_id, model_id)
) STRICT, WITHOUT ROWID;

-- One row per provider: last successful fetch and the outcome of the last attempt.
CREATE TABLE provider_model_sync (
  provider_id     TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  synced_at       INTEGER,
  last_attempt_at INTEGER NOT NULL,
  last_error      TEXT
) STRICT;
