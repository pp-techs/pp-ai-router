import { ServerOffIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import { PageHeader, Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { OverviewStats } from "./overview-stats";
import { OverviewPricing } from "./overview-pricing";
import { ProviderHealthCard } from "./overview-providers";
import { BreakdownChart } from "./usage/breakdown-chart";
import { UsageChart } from "./usage/usage-chart";
import { SummaryTable } from "./usage/summary-table";

const DAY_MS = 86_400_000;

export function OverviewPage() {
  const keys = useQuery({ queryKey: qk.keys, queryFn: api.keys });
  const summary = useQuery({
    queryKey: qk.usageSummary("model", "24h"),
    queryFn: () => api.usageSummary("model", Date.now() - DAY_MS),
    refetchInterval: 15_000,
  });

  return (
    <>
      <PageHeader title="Overview" description="What the router served in the last 24 hours." />

      <OverviewStats />

      <div className="grid gap-6">
        <UsageChart range="24h" />
        <BreakdownChart keys={keys.data} range="24h" />
        <Panel title="Usage by model" description="Breakdown by routed upstream model." flush>
          <QueryBoundary
            query={summary}
            isEmpty={(s) => s.data.length === 0}
            empty={
              <EmptyState icon={ServerOffIcon} title="No requests in the last 24 hours">
                Usage appears here once a client calls <code className="font-mono">/v1</code>.
              </EmptyState>
            }
          >
            {(s) => <SummaryTable rows={s.data} groupLabel="Model" />}
          </QueryBoundary>
        </Panel>
        <div className="grid gap-6 lg:grid-cols-2">
          <ProviderHealthCard />
          <OverviewPricing />
        </div>
      </div>
    </>
  );
}
