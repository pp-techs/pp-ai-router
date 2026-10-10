import type { OAuthProvider } from "../oauth/types.ts";
import type { Quota, QuotaCall } from "../quota/types.ts";
import { antigravity } from "./antigravity/adapter.ts";
import { anthropic } from "./anthropic.ts";
import { anthropicSubscription } from "./anthropic-subscription/adapter.ts";
import { kiro } from "./kiro/adapter.ts";
import { openAiCompat } from "./openai-compat.ts";

export interface UpstreamCall {
  /** Provider base URL (the adapter's `defaultBaseUrl` unless the provider overrides it). */
  baseUrl: string;
  /** API key, or a fresh OAuth access token. */
  token: string;
  /** Provider-specific extras stored with an OAuth account (project id, profile ARN, ...). Empty for API keys. */
  meta: Readonly<Record<string, string>>;
  /** OpenAI chat-completions body with `model` already rewritten to the upstream model. */
  body: Record<string, unknown>;
  /** Whether the client asked for SSE. */
  stream: boolean;
  signal: AbortSignal;
}

/** A model an upstream offers. `id` is the upstream name, i.e. what follows `provider/` in requests. */
export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
}

export type ModelListCall = Pick<UpstreamCall, "baseUrl" | "token" | "meta" | "signal">;
/**
 * An adapter turns the canonical OpenAI chat-completions request into one upstream call and returns
 * a `Response` in OpenAI chat-completions shape: JSON when `stream` is false, SSE when true (usage in
 * the final chunk). Upstream HTTP failures are returned as-is (non-2xx) so the gateway can classify
 * them; only transport errors throw. See `chunks.ts` for helpers that build the OpenAI shape.
 */
export interface ProviderAdapter {
  readonly type: string;
  /** Shown in the admin UI. */
  readonly label: string;
  /** Used when a provider is created without `base_url`. Null = base_url is mandatory. */
  readonly defaultBaseUrl: string | null;
  /** Present for subscription/OAuth providers; enables account login and token refresh. */
  readonly oauth?: OAuthProvider;
  /**
   * Fixed model list for providers with no discovery endpoint (subscription/OAuth backends). Takes
   * precedence over `listModels`.
   */
  readonly staticModels?: readonly ModelInfo[];
  /** Live discovery with one of the provider's credentials. Throws on any failure. */
  listModels?(input: ModelListCall): Promise<ModelInfo[]>;
  /**
   * Reads one OAuth account's remaining allowance from the upstream. Throws `QuotaError` with a
   * closed diagnosis (access refused, rate limited, unusable response, ...); transport errors may
   * throw as-is. Absent for providers without an account-level usage endpoint.
   */
  quota?(input: QuotaCall): Promise<Quota>;
  call(input: UpstreamCall): Promise<Response>;
}

export const ADAPTERS: Readonly<Record<string, ProviderAdapter>> = {
  [openAiCompat.type]: openAiCompat,
  [antigravity.type]: antigravity,
  [anthropic.type]: anthropic,
  [anthropicSubscription.type]: anthropicSubscription,
  [kiro.type]: kiro,
};

export const PROVIDER_TYPES = Object.keys(ADAPTERS);
