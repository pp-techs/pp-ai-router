import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client.ts";
import { qk } from "../api/queries.ts";
import { Badge, type Tone } from "../components/badge.tsx";
import { Card } from "../components/page.tsx";
import { EmptyState, QueryBoundary } from "../components/query-state.tsx";
import { summarizeHealth, type ProviderHealth } from "../lib/credential-health.ts";

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
    <Card
      title="Provider health"
      actions={
        <Link to="/providers" className="text-accent hover:underline">
          Manage
        </Link>
      }
    >
      <QueryBoundary
        query={providers}
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No providers yet">Add one on the Providers page.</EmptyState>}
      >
        {(list) => (
          <ul className="grid gap-3">
            {list.map((p, i) => {
              const creds = credentials[i]?.data;
              const health = creds && summarizeHealth(p.enabled, creds, now);
              return (
                <li key={p.id} className="flex items-start justify-between gap-3">
                  <div>
                    <Link
                      to={`/providers/${encodeURIComponent(p.id)}`}
                      className="font-medium hover:underline"
                    >
                      {p.id}
                    </Link>
                    <p className="text-xs text-muted">
                      {health
                        ? `${health.counts.ready} ready · ${health.counts.cooling} cooling · ${health.counts.dead} dead · ${health.counts.disabled} disabled`
                        : `${p.credentials} credentials`}
                    </p>
                  </div>
                  {health && <Badge tone={TONE[health.state]}>{health.state}</Badge>}
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
    </Card>
  );
}
