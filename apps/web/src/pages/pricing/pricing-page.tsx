import { PageHeader } from "@/components/page";
import { OverrideModal } from "./override-dialog";
import { OverridesCard } from "./overrides-card";
import { PriceSearchCard } from "./search-card";
import { PricingSyncCard } from "./sync-card";

export function PricingPage() {
  return (
    <>
      <PageHeader
        title="Pricing"
        description="Prices are USD per 1M tokens. Fetched lists are synced daily; an override always wins."
      />
      <div className="grid gap-6">
        <PricingSyncCard />
        <OverridesCard
          onNew={() => void OverrideModal.show({ base: null })}
          onEdit={(price) => void OverrideModal.show({ base: price })}
        />
        <PriceSearchCard onOverride={(price) => void OverrideModal.show({ base: price })} />
      </div>
    </>
  );
}
