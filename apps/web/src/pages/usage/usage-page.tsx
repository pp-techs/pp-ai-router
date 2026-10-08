import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.ts";
import { qk } from "../../api/queries.ts";
import { PageHeader } from "../../components/page.tsx";
import { UsageLedgerCard } from "./ledger-card.tsx";
import { UsageSummaryCard } from "./summary-card.tsx";

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
