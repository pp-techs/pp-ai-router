import { useQueries, useQuery } from "@tanstack/react-query";
import { ServerIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { summarizeHealth, type ProviderHealth } from "@/lib/credential-health";

const TONE: Record<ProviderHealth, Tone> = {
  healthy: "ok",
  degraded: "warn",
  unavailable: "danger",
  "no credentials": "warn",
  disabled: "neutral",
};

export function ProviderHealthCard() {
  const providers = useQuery({
    queryKey: qk.providers,
    queryFn: api.providers,
    refetchInterval: 15_000,
  });
  const credentials = useQueries({
    queries: (providers.data ?? []).map((p) => ({
      queryKey: qk.credentials(p.id),
      queryFn: () => api.credentials(p.id),
      refetchInterval: 15_000,
    })),
  });
  const now = Date.now();

  return (
    <Panel
      title="Provider health"
      description="Circuit breaker and upstream availability."
      actions={
        <Link to="/providers" className="text-sm font-medium text-primary hover:underline">
          Manage
        </Link>
      }
    >
      <QueryBoundary
        query={providers}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState icon={ServerIcon} title="No providers yet">
            Add one on the Providers page.
          </EmptyState>
        }
      >
        {(list) => (
          <ul className="-my-3 divide-y">
            {list.map((p, i) => {
              const creds = credentials[i]?.data;
              const health = creds && summarizeHealth(p.enabled, creds, now);
              return (
                <li key={p.id} className="flex items-start justify-between gap-3 py-3">
                  <div>
                    <Link
                      to="/providers/$id"
                      params={{ id: p.id }}
                      className="font-medium hover:underline"
                    >
                      {p.id}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {health
                        ? `${health.counts.ready} ready · ${health.counts.cooling} cooling · ${health.counts.dead} dead · ${health.counts.disabled} disabled`
                        : `${p.credentials} credentials`}
                    </p>
                  </div>
                  {health && (
                    <StatusBadge dot tone={TONE[health.state]}>
                      {health.state}
                    </StatusBadge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
    </Panel>
  );
}
