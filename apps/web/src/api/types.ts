// Wire types of the admin API (apps/server/src/admin/routes.ts). All fields are snake_case; times are epoch ms.

export const STRATEGIES = [
  "round_robin",
  "weighted",
  "least_inflight",
  "least_used",
  "fill_first",
  "random",
] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const METRICS = [
  "usd",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "requests",
] as const;
export type Metric = (typeof METRICS)[number];
export type LimitMode = "fixed" | "rolling";

export interface ProviderType {
  type: string;
  label: string;
  default_base_url: string | null;
  oauth: { label: string } | null;
  /** How the provider's model list is known: fixed in the adapter, fetched from the upstream, or not at all. */
  models: "static" | "fetch" | "none";
  /** True when the provider type can report per-account quota. */
  quota: boolean;
}

export interface Provider {
  id: string;
  type: string;
  base_url: string;
  key_strategy: Strategy;
  sticky_ttl_sec: number;
  max_key_attempts: number;
  enabled: boolean;
  credentials: number;
  oauth: boolean;
}

export interface ProviderCreate {
  id: string;
  type: string;
  base_url?: string;
  key_strategy: Strategy;
  sticky_ttl_sec: number;
  max_key_attempts: number;
  enabled: boolean;
}

export type ProviderPatch = Partial<Omit<ProviderCreate, "id" | "type">>;

export interface Credential {
  id: string;
  provider_id: string;
  label: string;
  kind: "api_key" | "oauth";
  secret_hint: string | null;
  account: string | null;
  expires_at: number | null;
  weight: number;
  priority: number;
  models: string[] | null;
  rpm_limit: number | null;
  enabled: boolean;
  status: "active" | "dead";
  last_error: string | null;
  inflight: number;
  fail_count: number;
  cooldown_until: number | null;
}

export interface CredentialCreate {
  secret: string;
  label: string;
  weight: number;
  priority: number;
  models: string[] | null;
  rpm_limit: number | null;
  enabled: boolean;
}

export interface CredentialPatch {
  label?: string;
  secret?: string;
  weight?: number;
  priority?: number;
  models?: string[] | null;
  rpm_limit?: number | null;
  enabled?: boolean;
  status?: "active";
}

/** Optional settings applied to the credential an OAuth login creates. */
export interface OAuthStartBody {
  label?: string;
  weight?: number;
  priority?: number;
  models?: string[] | null;
  rpm_limit?: number | null;
}

export type OAuthStart = { session_id: string } & (
  | {
      flow: "device";
      verification_uri: string;
      verification_uri_complete: string | null;
      user_code: string;
      interval_sec: number;
      expires_at: number;
    }
  | { flow: "paste"; auth_url: string; instructions: string; expires_at: number }
);

export type OAuthSession =
  | { status: "pending" }
  | { status: "complete"; credential_id: string }
  | { status: "error"; error: string }
  | { status: "expired" };

export interface AliasTarget {
  provider: string;
  model: string;
}

export interface Alias {
  alias: string;
  targets: AliasTarget[];
}

export interface LimitInput {
  metric: Metric;
  window: string;
  mode: LimitMode;
  max: number;
}

export interface Limit extends LimitInput {
  id: string;
  used: number;
  resets_at: number | null;
}

export interface VirtualKey {
  id: string;
  name: string;
  prefix: string;
  allowed_models: string[] | null;
  expires_at: number | null;
  enabled: boolean;
  created_at: number;
  limits: Limit[];
}

export interface KeyCreate {
  name: string;
  allowed_models: string[] | null;
  expires_at: number | null;
  limits: LimitInput[];
}

export interface KeyPatch {
  name?: string;
  allowed_models?: string[] | null;
  expires_at?: number | null;
  enabled?: boolean;
}

export type CreatedKey = VirtualKey & { key: string };

export type UsageStatus = "ok" | "aborted" | "error" | "no_usage";

export interface UsageEvent {
  id: number;
  ts: number;
  key_id: string;
  provider_id: string;
  credential_id: string;
  model: string;
  upstream_model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  price_source: string;
  stream: 0 | 1;
  status: UsageStatus;
  latency_ms: number;
}

export interface UsageFilter {
  key_id?: string;
  provider_id?: string;
  credential_id?: string;
  model?: string;
  before?: number;
  limit?: number;
}

export type UsageGroup = "model" | "provider" | "key";

export interface UsageSummaryRow {
  group: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  unpriced_requests: number;
}

export interface UsageBucket {
  /** Start of the bucket, ms since the epoch. */
  ts: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface UsageTimeline {
  since: number;
  bucket_ms: number;
  /** Only buckets that saw traffic; see `fillBuckets`. */
  data: UsageBucket[];
}

export interface UsageSummary {
  since: number;
  group_by: string;
  data: UsageSummaryRow[];
}

export interface PriceTier {
  aboveTokens: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Prices are USD per 1M tokens, except `tiers`, which the server returns per single token. */
export interface Price {
  model: string;
  source: string;
  input_per_1m: number | null;
  output_per_1m: number | null;
  cache_read_per_1m: number | null;
  cache_write_per_1m: number | null;
  reasoning_per_1m: number | null;
  tiers: PriceTier[];
}

export interface OverrideInput {
  model: string;
  input_per_1m: number;
  output_per_1m: number;
  cache_read_per_1m?: number;
  cache_write_per_1m?: number;
}

export interface PricingSyncState {
  source: string;
  etag: string | null;
  synced_at: number | null;
  model_count: number | null;
  last_error: string | null;
}

export interface PricingSyncResult {
  source: string;
  status: "updated" | "not_modified" | "error";
  models?: number;
  error?: string;
}

export interface ProviderModel {
  id: string;
  name: string | null;
  context_window: number | null;
  /** False when an operator switched the model off: it is not routed to and not listed in `/v1/models`. */
  enabled: boolean;
  price: { input_per_1m: number | null; output_per_1m: number | null; source: string } | null;
}

export interface ProviderModels {
  source: "static" | "fetched" | "none";
  fetched_at: number | null;
  /** Error of the latest fetch; the previous list stays in `data`. */
  error: string | null;
  data: ProviderModel[];
}

/** One provider's stored model list, as returned for all providers at once by `GET /admin/models`. */
export interface ProviderModelGroup extends ProviderModels {
  provider: string;
  type: string;
  provider_enabled: boolean;
}

export interface QuotaWindow {
  label: string;
  used_percent: number;
  /** Epoch ms; null when unknown. */
  resets_at: number | null;
}

export interface QuotaCredits {
  used: number;
  limit: number;
}

export type QuotaFailure =
  | "account_unavailable"
  | "access_denied"
  | "rate_limited"
  | "upstream_error"
  | "timeout"
  | "transport_error"
  | "response_unusable";

export interface ProviderQuota {
  windows: QuotaWindow[];
  /** Null when the provider has no credit counter. */
  credits: QuotaCredits | null;
  /** The credential is parked (not routed to) until `resets_at`. */
  exhausted: boolean;
  resets_at: number | null;
}

/** One credential's quota in a provider's quota report. */
export interface AccountQuota {
  credential_id: string;
  label: string;
  account: string | null;
  status: "ok" | "unavailable";
  failure: QuotaFailure | null;
  checked_at: number;
  quota: ProviderQuota | null;
}

export interface ProviderQuotaReport {
  supported: boolean;
  data: AccountQuota[];
}

export type AuditCategory = "admin" | "gateway";
export type AuditStatus = "success" | "failure";

export interface AuditLog {
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
