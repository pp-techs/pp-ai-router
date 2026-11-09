import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import type { UsageQuery } from "@/api/types";
import { useState } from "react";
import { OptionSelect } from "@/components/option-select";
import { PageHeader } from "@/components/page";
import { RANGE_KEYS, RANGES, type RangeKey } from "@/lib/timeline";
import { UsageChart } from "./usage-chart";
import { UsageFilterBar } from "./usage-filters";
import { UsageLedgerCard } from "./ledger-card";
import { UsageSummaryCard } from "./summary-card";

export function UsagePage() {
  const keys = useQuery({ queryKey: qk.keys, queryFn: api.keys });
  const providers = useQuery({ queryKey: qk.providers, queryFn: api.providers });
  const [range, setRange] = useState<RangeKey>("24h");
  const [query, setQuery] = useState<UsageQuery>({});

  return (
    <>
      <PageHeader
        title="Usage"
        description="Every request the router served, with token counts and cost at the price in force at the time. The filters narrow all three panels."
        actions={
          <OptionSelect
            aria-label="Time range"
            className="w-auto min-w-40"
            value={range}
            onValueChange={(v) => setRange(v as RangeKey)}
            options={RANGE_KEYS.map((value) => ({ value, label: RANGES[value].label }))}
          />
        }
      />
      <div className="grid gap-6">
        <UsageFilterBar
          keys={keys.data}
          providers={providers.data}
          value={query}
          onChange={setQuery}
        />
        <UsageChart range={range} query={query} />
        <UsageSummaryCard keys={keys.data} range={range} query={query} />
        <UsageLedgerCard keys={keys.data} range={range} query={query} />
      </div>
    </>
  );
}
