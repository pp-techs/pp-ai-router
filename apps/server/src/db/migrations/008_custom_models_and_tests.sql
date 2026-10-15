-- Models an operator added by hand: merged into the provider's list at read time, so a refresh from
-- the upstream (which rewrites provider_models) never drops them. Same columns as provider_models.
CREATE TABLE custom_models (
  provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id       TEXT NOT NULL,
  name           TEXT,
  context_window INTEGER,
  details        TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
) STRICT, WITHOUT ROWID;

-- Outcome of the latest test request per model (`POST /admin/models/test`); a model never tested has no row.
CREATE TABLE model_tests (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  status      INTEGER,          -- upstream HTTP status; NULL when nothing came back
  latency_ms  INTEGER NOT NULL,
  error       TEXT,
  reply       TEXT,
  credential  TEXT,             -- label of the credential that served (or last refused) the test
  tested_at   INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
) STRICT, WITHOUT ROWID;
