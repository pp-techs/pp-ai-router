-- A limit may be scoped to the models it governs: `model` is a `*` glob matched against the model name
-- the client requested. NULL = the whole key (every model).
ALTER TABLE limits ADD COLUMN model TEXT;

-- Per-model twin of usage_buckets, so a model-scoped limit can sum just the models it covers.
CREATE TABLE usage_model_buckets (
  key_id        TEXT NOT NULL REFERENCES virtual_keys(id) ON DELETE CASCADE,
  granularity   INTEGER NOT NULL,
  bucket_start  INTEGER NOT NULL,  -- unix seconds
  model         TEXT NOT NULL,
  requests      INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, granularity, bucket_start, model)
) STRICT, WITHOUT ROWID;

-- Seed from the ledger so a model limit added after upgrade already sees past usage.
INSERT INTO usage_model_buckets (key_id, granularity, bucket_start, model, requests, input_tokens, output_tokens, cost_usd)
SELECT e.key_id, g.granularity, (e.ts / 1000 / g.granularity) * g.granularity, e.model,
       COUNT(*), SUM(e.input_tokens), SUM(e.output_tokens), SUM(e.cost_usd)
  FROM usage_events e
  JOIN virtual_keys k ON k.id = e.key_id
  CROSS JOIN (SELECT 60 AS granularity UNION ALL SELECT 3600) g
 GROUP BY e.key_id, g.granularity, (e.ts / 1000 / g.granularity) * g.granularity, e.model;
