import { request } from "./http.ts";
import type {
  Alias,
  AliasTarget,
  CreatedKey,
  Credential,
  CredentialCreate,
  CredentialPatch,
  KeyCreate,
  KeyPatch,
  Limit,
  LimitInput,
  OAuthSession,
  OAuthStart,
  OAuthStartBody,
  OverrideInput,
  Price,
  PricingSyncResult,
  PricingSyncState,
  Provider,
  ProviderCreate,
  ProviderPatch,
  ProviderModelGroup,
  ProviderModels,
  ProviderQuotaReport,
  ProviderType,
  UsageEvent,
  UsageFilter,
  UsageGroup,
  UsageSummary,
  UsageTimeline,
  VirtualKey,
} from "./types.ts";

interface List<T> {
  data: T[];
}

const id = encodeURIComponent;
// Alias names and model ids may contain "/" (the server routes match the rest of the path), so encode per segment.
const slashPath = (path: string) => path.split("/").map(id).join("/");
const unwrap = async <T>(list: Promise<List<T>>) => (await list).data;

/** Typed client for the admin API (`/admin/*`); one function per endpoint. */
export const api = {
  /** Cheapest authenticated call; resolves only for a valid admin token. */
  checkToken: (token: string) =>
    request<List<ProviderType>>("GET", "/admin/provider-types", { token }),
  providerTypes: () => unwrap(request<List<ProviderType>>("GET", "/admin/provider-types")),
  providers: () => unwrap(request<List<Provider>>("GET", "/admin/providers")),
  createProvider: (body: ProviderCreate) =>
    request<{ id: string }>("POST", "/admin/providers", { body }),
  updateProvider: (providerId: string, body: ProviderPatch) =>
    request<{ id: string }>("PATCH", `/admin/providers/${id(providerId)}`, { body }),
  deleteProvider: (providerId: string) =>
    request<void>("DELETE", `/admin/providers/${id(providerId)}`),

  /** Stored list; the first request for a never-fetched provider fetches it, which can take seconds. */
  providerModels: (providerId: string) =>
    request<ProviderModels>("GET", `/admin/providers/${id(providerId)}/models`),
  refreshProviderModels: (providerId: string) =>
    request<ProviderModels>("POST", `/admin/providers/${id(providerId)}/models/refresh`),

  /** Cached when fresh; `refresh` forces a live upstream probe. */
  providerQuota: (providerId: string, refresh = false) =>
    request<ProviderQuotaReport>("GET", `/admin/providers/${id(providerId)}/quota`, {
      query: { refresh: refresh ? "true" : undefined },
    }),

  credentials: (providerId: string) =>
    unwrap(request<List<Credential>>("GET", `/admin/providers/${id(providerId)}/credentials`)),
  createCredential: (providerId: string, body: CredentialCreate) =>
    request<{ id: string }>("POST", `/admin/providers/${id(providerId)}/credentials`, {
      body: { kind: "api_key", ...body },
    }),
  updateCredential: (credentialId: string, body: CredentialPatch) =>
    request<{ id: string }>("PATCH", `/admin/credentials/${id(credentialId)}`, { body }),
  deleteCredential: (credentialId: string) =>
    request<void>("DELETE", `/admin/credentials/${id(credentialId)}`),

  startOAuth: (providerId: string, body: OAuthStartBody) =>
    request<OAuthStart>("POST", `/admin/providers/${id(providerId)}/oauth/start`, { body }),
  oauthSession: (sessionId: string) =>
    request<OAuthSession>("GET", `/admin/oauth/sessions/${id(sessionId)}`),
  completeOAuth: (sessionId: string, input: string) =>
    request<OAuthSession>("POST", `/admin/oauth/sessions/${id(sessionId)}/complete`, {
      body: { input },
    }),

  aliases: () => unwrap(request<List<Alias>>("GET", "/admin/aliases")),
  putAlias: (alias: string, targets: AliasTarget[]) =>
    request<{ alias: string }>("PUT", `/admin/aliases/${slashPath(alias)}`, { body: { targets } }),
  deleteAlias: (alias: string) => request<void>("DELETE", `/admin/aliases/${slashPath(alias)}`),

  /** Every provider's stored model list (no upstream fetches). */
  models: () => unwrap(request<List<ProviderModelGroup>>("GET", "/admin/models")),
  setModelEnabled: (providerId: string, model: string, enabled: boolean) =>
    request<{ provider: string; id: string; enabled: boolean }>(
      "PATCH",
      `/admin/models/${id(providerId)}/${slashPath(model)}`,
      { body: { enabled } },
    ),

  keys: () => unwrap(request<List<VirtualKey>>("GET", "/admin/keys")),
  createKey: (body: KeyCreate) => request<CreatedKey>("POST", "/admin/keys", { body }),
  updateKey: (keyId: string, body: KeyPatch) =>
    request<VirtualKey>("PATCH", `/admin/keys/${id(keyId)}`, { body }),
  deleteKey: (keyId: string) => request<void>("DELETE", `/admin/keys/${id(keyId)}`),
  addLimit: (keyId: string, body: LimitInput) =>
    request<Limit>("POST", `/admin/keys/${id(keyId)}/limits`, { body }),
  deleteLimit: (limitId: string) => request<void>("DELETE", `/admin/limits/${id(limitId)}`),

  usage: (filter: UsageFilter) =>
    unwrap(request<List<UsageEvent>>("GET", "/admin/usage", { query: { ...filter } })),
  usageSummary: (groupBy: UsageGroup, since: number) =>
    request<UsageSummary>("GET", "/admin/usage/summary", {
      query: { group_by: groupBy, since },
    }),

  usageTimeline: (since: number, bucketMs: number) =>
    request<UsageTimeline>("GET", "/admin/usage/timeline", {
      query: { since, bucket_ms: bucketMs },
    }),

  prices: (q: string) => unwrap(request<List<Price>>("GET", "/admin/pricing", { query: { q } })),
  priceLookup: (model: string) =>
    request<Price>("GET", "/admin/pricing/lookup", { query: { model } }),
  pricingSync: () => unwrap(request<List<PricingSyncState>>("GET", "/admin/pricing/sync")),
  syncPricing: () => unwrap(request<List<PricingSyncResult>>("POST", "/admin/pricing/sync")),
  overrides: () => unwrap(request<List<Price>>("GET", "/admin/pricing/overrides")),
  putOverride: (body: OverrideInput) =>
    request<{ model: string }>("PUT", "/admin/pricing/overrides", { body }),
  deleteOverride: (model: string) =>
    request<void>("DELETE", "/admin/pricing/overrides", { query: { model } }),
};
