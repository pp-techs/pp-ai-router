import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import { useState } from "react";
import { OptionSelect } from "@/components/option-select";
import { PageHeader } from "@/components/page";
import { RANGE_KEYS, RANGES, type RangeKey } from "@/lib/timeline";
import { UsageChart } from "./usage-chart";
import { UsageLedgerCard } from "./ledger-card";
import { UsageSummaryCard } from "./summary-card";

export function UsagePage() {
  const keys = useQuery({ queryKey: qk.keys, queryFn: api.keys });
  const providers = useQuery({ queryKey: qk.providers, queryFn: api.providers });
  const [range, setRange] = useState<RangeKey>("24h");

  return (
    <>
      <PageHeader
        title="Usage"
        description="Every request the router served, with token counts and cost at the price in force at the time."
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
        <UsageChart range={range} />
        <UsageSummaryCard keys={keys.data} range={range} />
        <UsageLedgerCard keys={keys.data} providers={providers.data} />
      </div>
    </>
  );
}
