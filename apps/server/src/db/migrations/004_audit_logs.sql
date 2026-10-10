-- Audit log records administrative mutations and gateway traffic events.
-- Append-only ledger without foreign keys so history survives resource deletions.
CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,   -- unix ms
  category    TEXT NOT NULL CHECK (category IN ('admin', 'gateway')),
  action      TEXT NOT NULL,      -- e.g. 'provider.create', 'key.delete', 'chat.completion', 'messages.create'
  actor       TEXT NOT NULL,      -- 'admin', key_id, or 'system'
  target_type TEXT,               -- 'provider', 'credential', 'key', 'alias', 'pricing', 'model', etc.
  target_id   TEXT,               -- identifier of modified resource or model
  status      TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  status_code INTEGER,            -- HTTP status code (e.g. 200, 201, 400, 401, 502)
  ip          TEXT,               -- caller client IP
  details     TEXT,               -- JSON metadata (redacted payload, changed keys, token counts, error message, etc.)
  latency_ms  INTEGER             -- request execution duration in ms
) STRICT;

CREATE INDEX audit_logs_ts ON audit_logs(ts);
CREATE INDEX audit_logs_category_ts ON audit_logs(category, ts);
CREATE INDEX audit_logs_action ON audit_logs(action);
CREATE INDEX audit_logs_actor ON audit_logs(actor);
CREATE INDEX audit_logs_target ON audit_logs(target_type, target_id);
