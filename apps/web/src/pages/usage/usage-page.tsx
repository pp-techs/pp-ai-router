import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import { PageHeader } from "@/components/page";
import { UsageLedgerCard } from "./ledger-card";
import { UsageSummaryCard } from "./summary-card";

export function UsagePage() {
  const keys = useQuery({ queryKey: qk.keys, queryFn: api.keys });
  const providers = useQuery({ queryKey: qk.providers, queryFn: api.providers });

  return (
    <>
      <PageHeader
        title="Usage"
        description="Every request the router served, with token counts and cost at the price in force at the time."
      />
      <div className="grid gap-6">
        <UsageSummaryCard keys={keys.data} />
        <UsageLedgerCard keys={keys.data} providers={providers.data} />
      </div>
    </>
  );
}
