import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { qk } from "../../api/queries.ts";
import type { UsageGroup, VirtualKey } from "../../api/types.ts";
import { Select } from "../../components/fields.tsx";
import { Card } from "../../components/page.tsx";
import { EmptyState, QueryBoundary } from "../../components/query-state.tsx";
import { SummaryTable } from "./summary-table.tsx";

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
    <Card
      title="Summary"
      flush
      actions={
        <>
          <Select
            aria-label="Group by"
            value={group}
            onChange={(e) => setGroup(e.target.value as UsageGroup)}
          >
            {Object.entries(GROUPS).map(([value, label]) => (
              <option key={value} value={value}>
                By {label.toLowerCase()}
              </option>
            ))}
          </Select>
          <Select aria-label="Time range" value={range} onChange={(e) => setRange(e.target.value)}>
            {Object.entries(RANGES).map(([value, { label }]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
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
    </Card>
  );
}
