import {
  useMutation,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "../lib/toast.ts";
import type { UsageFilter, UsageGroup } from "./types.ts";

/** Query keys are hierarchical: invalidating `providers` also refreshes every provider's credentials. */
export const qk = {
  providerTypes: ["provider-types"] as const,
  providers: ["providers"] as const,
  providerModels: (providerId: string) => ["providers", providerId, "models"] as const,
  providerQuota: (providerId: string) => ["providers", providerId, "quota"] as const,
  credentials: (providerId: string) => ["providers", providerId, "credentials"] as const,
  oauthSession: (sessionId: string) => ["oauth-session", sessionId] as const,
  aliases: ["aliases"] as const,
  keys: ["keys"] as const,
  usage: (filter: UsageFilter) => ["usage", "events", filter] as const,
  usageEvents: ["usage", "events"] as const,
  usageSummary: (group: UsageGroup, range: string) => ["usage", "summary", group, range] as const,
  prices: (q: string) => ["pricing", "search", q] as const,
  priceLookup: (model: string) => ["pricing", "lookup", model] as const,
  pricingSync: ["pricing", "sync"] as const,
  overrides: ["pricing", "overrides"] as const,
  pricing: ["pricing"] as const,
};

interface ActionOptions<TData, TVars> {
  /** Query keys to refresh after success. */
  invalidate?: QueryKey[];
  success?: string | ((data: TData, vars: TVars) => string);
  /** The caller shows `mutation.error` itself (inside a dialog); no global toast. */
  inline?: boolean;
  onSuccess?: (data: TData, vars: TVars) => void;
}

/** useMutation with the app's conventions: refresh affected queries, toast the outcome. */
export function useAction<TData, TVars = void>(
  fn: (vars: TVars) => Promise<TData>,
  { invalidate = [], success, inline = false, onSuccess }: ActionOptions<TData, TVars> = {},
): UseMutationResult<TData, Error, TVars> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    meta: { inline },
    onSuccess: (data, vars) => {
      // Not awaited: dialogs close and navigation happens at once while lists refresh behind them.
      for (const queryKey of invalidate) void client.invalidateQueries({ queryKey });
      if (success) toast.success(typeof success === "function" ? success(data, vars) : success);
      onSuccess?.(data, vars);
    },
  });
}
