import { useQuery } from "@tanstack/react-query";
import { TagsIcon } from "lucide-react";
import { Link } from "react-router";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import { StatusBadge } from "@/components/status-badge";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { formatDateTime, formatInt } from "@/lib/format";

export function OverviewPricing() {
  const states = useQuery({ queryKey: qk.pricingSync, queryFn: api.pricingSync });

  return (
    <Panel
      title="Pricing sync"
      description="Catalog sync status and pricing feeds."
      actions={
        <Link to="/pricing" className="text-sm font-medium text-primary hover:underline">
          Manage
        </Link>
      }
    >
      <QueryBoundary
        query={states}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState icon={TagsIcon} title="Never synced">
            Unknown models are billed at $0. Sync prices on the Pricing page.
          </EmptyState>
        }
      >
        {(list) => (
          <ul className="-my-3 divide-y">
            {list.map((s) => (
              <li key={s.source} className="flex items-start justify-between gap-3 py-3">
                <div>
                  <p className="font-medium">{s.source}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.synced_at === null
                      ? "never synced"
                      : `synced ${formatDateTime(s.synced_at)}`}
                    {s.model_count !== null && ` · ${formatInt(s.model_count)} models`}
                  </p>
                  {s.last_error && (
                    <p className="mt-1 text-xs break-words text-destructive">{s.last_error}</p>
                  )}
                </div>
                <StatusBadge dot tone={s.last_error ? "danger" : "ok"}>
                  {s.last_error ? "error" : "ok"}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Panel>
  );
}
