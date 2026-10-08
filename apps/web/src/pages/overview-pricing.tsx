import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client.ts";
import { qk } from "../api/queries.ts";
import { Badge } from "../components/badge.tsx";
import { Card } from "../components/page.tsx";
import { EmptyState, QueryBoundary } from "../components/query-state.tsx";
import { formatDateTime, formatInt } from "../lib/format.ts";

export function OverviewPricing() {
  const states = useQuery({ queryKey: qk.pricingSync, queryFn: api.pricingSync });

  return (
    <Card
      title="Pricing sync"
      actions={
        <Link to="/pricing" className="text-accent hover:underline">
          Manage
        </Link>
      }
    >
      <QueryBoundary
        query={states}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState title="Never synced">
            Unknown models are billed at $0. Sync prices on the Pricing page.
          </EmptyState>
        }
      >
        {(list) => (
          <ul className="grid gap-3">
            {list.map((s) => (
              <li key={s.source} className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{s.source}</p>
                  <p className="text-xs text-muted">
                    {s.synced_at === null
                      ? "never synced"
                      : `synced ${formatDateTime(s.synced_at)}`}
                    {s.model_count !== null && ` · ${formatInt(s.model_count)} models`}
                  </p>
                  {s.last_error && (
                    <p className="mt-1 text-xs break-words text-danger">{s.last_error}</p>
                  )}
                </div>
                <Badge tone={s.last_error ? "danger" : "ok"}>{s.last_error ? "error" : "ok"}</Badge>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Card>
  );
}
