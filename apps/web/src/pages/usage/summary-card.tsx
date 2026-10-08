import { useQuery } from "@tanstack/react-query";
import { ChartColumnIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import type { UsageGroup, VirtualKey } from "@/api/types";
import { OptionSelect } from "@/components/option-select";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { RANGES, type RangeKey } from "@/lib/timeline";
import { SummaryTable } from "./summary-table";

const GROUPS: Record<UsageGroup, string> = { model: "Model", provider: "Provider", key: "API key" };

export function UsageSummaryCard({
  keys,
  range,
}: {
  keys: VirtualKey[] | undefined;
  range: RangeKey;
}) {
  const [group, setGroup] = useState<UsageGroup>("model");

  const summary = useQuery({
    queryKey: qk.usageSummary(group, range),
    // `since` is computed per fetch so the key stays stable while the window slides.
    queryFn: () => {
      const { ms } = RANGES[range]!;
      return api.usageSummary(group, ms === null ? 0 : Date.now() - ms);
    },
    refetchInterval: 15_000,
  });

  const keyName = (id: string) =>
    keys?.find((k) => k.id === id)?.name ?? `${id.slice(0, 8)}… (deleted)`;

  return (
    <Panel
      title="Summary"
      flush
      description="Aggregated metrics by model, provider or API key."
      actions={
        <>
          <span aria-hidden className="text-xs text-muted-foreground">
            Group by
          </span>
          <OptionSelect
            aria-label="Group by"
            className="w-auto min-w-32"
            value={group}
            onValueChange={(v) => setGroup(v as UsageGroup)}
            options={Object.entries(GROUPS).map(([value, label]) => ({
              value,
              label: `By ${label.toLowerCase()}`,
            }))}
          />
        </>
      }
    >
      <QueryBoundary
        query={summary}
        isEmpty={(s) => s.data.length === 0}
        empty={<EmptyState icon={ChartColumnIcon} title="No usage in this period" />}
      >
        {(s) => (
          <SummaryTable
            rows={s.data}
            groupLabel={GROUPS[group]}
            nameOf={group === "key" ? keyName : undefined}
            showTotals
          />
        )}
      </QueryBoundary>
    </Panel>
  );
}
