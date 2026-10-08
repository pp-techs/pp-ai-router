import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { qk } from "../api/queries.ts";
import { Card, PageHeader, Stat } from "../components/page.tsx";
import { EmptyState, QueryBoundary } from "../components/query-state.tsx";
import { formatInt, formatUsd } from "../lib/format.ts";
import { OverviewPricing } from "./overview-pricing.tsx";
import { ProviderHealthCard } from "./overview-providers.tsx";
import { SummaryTable, summaryTotals } from "./usage/summary-table.tsx";

const DAY_MS = 86_400_000;

export function OverviewPage() {
  const summary = useQuery({
    queryKey: qk.usageSummary("model", "24h"),
    queryFn: () => api.usageSummary("model", Date.now() - DAY_MS),
    refetchInterval: 15_000,
  });
  const totals = summary.data && summaryTotals(summary.data.data);

  return (
    <>
      <PageHeader title="Overview" description="What the router served in the last 24 hours." />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Requests" value={totals ? formatInt(totals.requests) : "—"} />
        <Stat label="Input tokens" value={totals ? formatInt(totals.input_tokens) : "—"} />
        <Stat label="Output tokens" value={totals ? formatInt(totals.output_tokens) : "—"} />
        <Stat
          label="Cost"
          value={totals ? formatUsd(totals.cost_usd) : "—"}
          hint={
            totals && totals.unpriced_requests > 0
              ? `${formatInt(totals.unpriced_requests)} requests had no known price`
              : undefined
          }
        />
      </div>

      <div className="grid gap-6">
        <Card title="Usage by model" flush>
          <QueryBoundary
            query={summary}
            isEmpty={(s) => s.data.length === 0}
            empty={
              <EmptyState title="No requests in the last 24 hours">
                Usage appears here once a client calls <code className="font-mono">/v1</code>.
              </EmptyState>
            }
          >
            {(s) => <SummaryTable rows={s.data} groupLabel="Model" />}
          </QueryBoundary>
        </Card>
        <div className="grid gap-6 lg:grid-cols-2">
          <ProviderHealthCard />
          <OverviewPricing />
        </div>
      </div>
    </>
  );
}
