import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Price } from "@/api/types";
import { ConfirmModal } from "@/components/confirm-modal";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { PriceTable } from "./price-table";

export function OverridesCard({
  onNew,
  onEdit,
}: {
  onNew: () => void;
  onEdit: (price: Price) => void;
}) {
  const overrides = useQuery({ queryKey: qk.overrides, queryFn: api.overrides });
  const remove = useAction((model: string) => api.deleteOverride(model), {
    invalidate: [qk.pricing],
    inline: true,
    success: "Override deleted.",
  });

  return (
    <Panel
      title="Overrides"
      flush
      actions={
        <Button size="sm" onClick={onNew}>
          New override
        </Button>
      }
    >
      <QueryBoundary
        query={overrides}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState title="No overrides">
            Overrides take precedence over fetched prices, e.g. for negotiated rates or private
            models.
          </EmptyState>
        }
      >
        {(list) => (
          <PriceTable
            prices={list}
            actions={(p) => (
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => onEdit(p)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    void ConfirmModal.show({
                      title: `Delete override for ${p.model}?`,
                      message: "Billing falls back to the fetched price for this model, if any.",
                      confirmLabel: "Delete override",
                      action: () => remove.mutateAsync(p.model),
                    })
                  }
                >
                  Delete
                </Button>
              </div>
            )}
          />
        )}
      </QueryBoundary>
    </Panel>
  );
}
