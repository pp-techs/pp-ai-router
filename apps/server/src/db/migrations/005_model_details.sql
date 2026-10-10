-- Extra model facts reported by the upstream beyond name/context_window (description, created,
-- max output, modalities, supported parameters), as JSON. NULL = the upstream reported none.
ALTER TABLE provider_models ADD COLUMN details TEXT;

-- Model facts synced from an external catalog (OpenRouter), used to fill what an upstream leaves out.
-- `data` is JSON of the same fields as provider_models.details plus context_window.
CREATE TABLE model_metadata (
  source     TEXT NOT NULL,
  model      TEXT NOT NULL,
  data       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (source, model)
) STRICT, WITHOUT ROWID;
