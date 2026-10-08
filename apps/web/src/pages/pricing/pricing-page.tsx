import { useState } from "react";
import type { Price } from "../../api/types.ts";
import { PageHeader } from "../../components/page.tsx";
import { OverrideDialog } from "./override-dialog.tsx";
import { OverridesCard } from "./overrides-card.tsx";
import { PriceSearchCard } from "./search-card.tsx";
import { PricingSyncCard } from "./sync-card.tsx";

export function PricingPage() {
  // undefined = dialog closed, null = blank form, Price = prefilled (from a search result or an existing override).
  const [editing, setEditing] = useState<Price | null | undefined>(undefined);

  return (
    <>
      <PageHeader
        title="Pricing"
        description="Prices are USD per 1M tokens. Fetched lists are synced daily; an override always wins."
      />
      <div className="grid gap-6">
        <PricingSyncCard />
        <OverridesCard onNew={() => setEditing(null)} onEdit={setEditing} />
        <PriceSearchCard onOverride={setEditing} />
      </div>
      {editing !== undefined && (
        <OverrideDialog base={editing} onClose={() => setEditing(undefined)} />
      )}
    </>
  );
}
