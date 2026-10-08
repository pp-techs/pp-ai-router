import { useQuery } from "@tanstack/react-query";
import { PencilIcon, PlusIcon, TagIcon, Trash2Icon } from "lucide-react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Price } from "@/api/types";
import { ConfirmModal } from "@/components/confirm-modal";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
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

  const newButton = (
    <Button size="sm" onClick={onNew}>
      <PlusIcon data-icon="inline-start" />
      New override
    </Button>
  );

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Overrides
          {overrides.data && overrides.data.length > 0 && (
            <Badge variant="secondary">{overrides.data.length} configured</Badge>
          )}
        </span>
      }
      description="Custom rates configured by operators. Overrides take precedence over fetched prices."
      flush
      actions={newButton}
    >
      <QueryBoundary
        query={overrides}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState icon={TagIcon} title="No overrides">
            Overrides take precedence over fetched prices, e.g. for negotiated rates or private
            models.
          </EmptyState>
        }
      >
        {(list) => (
          <PriceTable
            prices={list}
            actions={(p) => [
              [{ label: "Edit", icon: PencilIcon, onSelect: () => onEdit(p) }],
              [
                {
                  label: "Delete",
                  icon: Trash2Icon,
                  destructive: true,
                  onSelect: () =>
                    void ConfirmModal.show({
                      title: `Delete override for ${p.model}?`,
                      message: "Billing falls back to the fetched price for this model, if any.",
                      confirmLabel: "Delete override",
                      action: () => remove.mutateAsync(p.model),
                    }),
                },
              ],
            ]}
          />
        )}
      </QueryBoundary>
    </Panel>
  );
}
