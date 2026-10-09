-- Models an operator switched off: not routed to and not listed in /v1/models. Kept apart from
-- provider_models, which is rewritten on every refresh and also holds nothing for ids the provider
-- does not list (any `provider/model` id can be routed to).
CREATE TABLE disabled_models (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL,
  disabled_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
) STRICT, WITHOUT ROWID;
