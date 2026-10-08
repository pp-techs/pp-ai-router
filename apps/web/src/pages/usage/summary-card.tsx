import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import type { UsageGroup, VirtualKey } from "@/api/types";
import { OptionSelect } from "@/components/option-select";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { SummaryTable } from "./summary-table";

const HOUR = 3_600_000;
const RANGES: Record<string, { label: string; ms: number | null }> = {
  "1h": { label: "Last hour", ms: HOUR },
  "24h": { label: "Last 24 hours", ms: 24 * HOUR },
  "7d": { label: "Last 7 days", ms: 7 * 24 * HOUR },
  "30d": { label: "Last 30 days", ms: 30 * 24 * HOUR },
  all: { label: "All time", ms: null },
};

const GROUPS: Record<UsageGroup, string> = { model: "Model", provider: "Provider", key: "API key" };

export function UsageSummaryCard({ keys }: { keys: VirtualKey[] | undefined }) {
  const [group, setGroup] = useState<UsageGroup>("model");
  const [range, setRange] = useState("24h");

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
      actions={
        <>
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
          <OptionSelect
            aria-label="Time range"
            className="w-auto min-w-32"
            value={range}
            onValueChange={setRange}
            options={Object.entries(RANGES).map(([value, { label }]) => ({ value, label }))}
          />
        </>
      }
    >
      <QueryBoundary
        query={summary}
        isEmpty={(s) => s.data.length === 0}
        empty={<EmptyState title="No usage in this period" />}
      >
        {(s) => (
          <SummaryTable
            rows={s.data}
            groupLabel={GROUPS[group]}
            nameOf={group === "key" ? keyName : undefined}
          />
        )}
      </QueryBoundary>
    </Panel>
  );
}
