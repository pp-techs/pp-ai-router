import { all, type Db } from "../db/database.ts";
import type { Logger } from "../logger.ts";

export type AuditCategory = "admin" | "gateway";
export type AuditStatus = "success" | "failure";

export interface AuditEntryInput {
  category: AuditCategory;
  action: string;
  actor: string;
  targetType?: string | null;
  targetId?: string | null;
  status: AuditStatus;
  statusCode?: number | null;
  ip?: string | null;
  details?: Record<string, unknown> | null;
  latencyMs?: number | null;
}

export interface AuditLogRecord {
  id: number;
  ts: number;
  category: AuditCategory;
  action: string;
  actor: string;
  target_type: string | null;
  target_id: string | null;
  status: AuditStatus;
  status_code: number | null;
  ip: string | null;
  details: string | null;
  latency_ms: number | null;
}

export interface AuditLogFilter {
  category?: AuditCategory;
  action?: string;
  actor?: string;
  target_type?: string;
  target_id?: string;
  status?: AuditStatus;
  since?: number;
  until?: number;
  before?: number;
  limit?: number;
}

const SENSITIVE_KEYS: Record<string, true> = {
  authorization: true,
  secret: true,
  token: true,
  key: true,
  admin_token: true,
  admintoken: true,
  api_key: true,
  apikey: true,
  master_key: true,
  masterkey: true,
  password: true,
  secret_enc: true,
  refresh_token: true,
  refreshtoken: true,
  access_token: true,
  accesstoken: true,
};

/** Recursively redacts sensitive keys from audit log detail objects. */
export function sanitizeDetails(val: unknown, depth = 0): unknown {
  if (depth > 6 || val === null || val === undefined) return val;
  if (typeof val === "string") {
    if (val.toLowerCase().startsWith("bearer ")) return "Bearer [REDACTED]";
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => sanitizeDetails(item, depth + 1));
  }
  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (SENSITIVE_KEYS[k.toLowerCase()]) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeDetails(v, depth + 1);
      }
    }
    return out;
  }
  return val;
}

export class AuditLogStore {
  readonly #db: Db;
  readonly #log: Logger;
  readonly #now: () => number;

  constructor(db: Db, log: Logger, now: () => number = Date.now) {
    this.#db = db;
    this.#log = log;
    this.#now = now;
  }

  record(entry: AuditEntryInput): void {
    const ts = this.#now();
    const sanitized = entry.details ? sanitizeDetails(entry.details) : null;
    const detailsJson = sanitized ? JSON.stringify(sanitized) : null;

    try {
      this.#db
        .prepare(
          `INSERT INTO audit_logs (ts, category, action, actor, target_type, target_id, status, status_code, ip, details, latency_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ts,
          entry.category,
          entry.action,
          entry.actor,
          entry.targetType ?? null,
          entry.targetId ?? null,
          entry.status,
          entry.statusCode ?? null,
          entry.ip ?? null,
          detailsJson,
          entry.latencyMs ?? null,
        );
    } catch (err) {
      this.#log.error("failed to record audit log", {
        action: entry.action,
        error: (err as Error).message,
      });
    }

    const payload = {
      audit_action: entry.action,
      audit_category: entry.category,
      actor: entry.actor,
      status: entry.status,
      status_code: entry.statusCode,
      target_type: entry.targetType,
      target_id: entry.targetId,
      latency_ms: entry.latencyMs,
      details: sanitized,
    };
    if (entry.status === "failure") {
      this.#log.warn("audit_event", payload);
    } else {
      this.#log.info("audit_event", payload);
    }
  }

  list(filter: AuditLogFilter = {}): AuditLogRecord[] {
    const limit = Math.min(Math.max(Number(filter.limit ?? 50) || 50, 1), 500);
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filter.category) {
      where.push("category = ?");
      params.push(filter.category);
    }
    if (filter.action) {
      where.push("action = ?");
      params.push(filter.action);
    }
    if (filter.actor) {
      where.push("actor = ?");
      params.push(filter.actor);
    }
    if (filter.target_type) {
      where.push("target_type = ?");
      params.push(filter.target_type);
    }
    if (filter.target_id) {
      where.push("target_id = ?");
      params.push(filter.target_id);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.since !== undefined && Number.isFinite(filter.since)) {
      where.push("ts >= ?");
      params.push(filter.since);
    }
    if (filter.until !== undefined && Number.isFinite(filter.until)) {
      where.push("ts <= ?");
      params.push(filter.until);
    }
    if (filter.before !== undefined && Number.isFinite(filter.before)) {
      where.push("id < ?");
      params.push(filter.before);
    }

    const sql = `SELECT * FROM audit_logs ${
      where.length ? `WHERE ${where.join(" AND ")}` : ""
    } ORDER BY id DESC LIMIT ?`;

    return all<AuditLogRecord>(this.#db.prepare(sql), ...params, limit);
  }
}
