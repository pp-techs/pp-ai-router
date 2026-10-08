import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { Price } from "../../api/types.ts";
import { Button } from "../../components/button.tsx";
import { ConfirmDialog } from "../../components/dialog.tsx";
import { Card } from "../../components/page.tsx";
import { EmptyState, QueryBoundary } from "../../components/query-state.tsx";
import { PriceTable } from "./price-table.tsx";

export function OverridesCard({
  onNew,
  onEdit,
}: {
  onNew: () => void;
  onEdit: (price: Price) => void;
}) {
  const overrides = useQuery({ queryKey: qk.overrides, queryFn: api.overrides });
  const [deleting, setDeleting] = useState<Price | null>(null);
  const remove = useAction((model: string) => api.deleteOverride(model), {
    invalidate: [qk.pricing],
    success: "Override deleted.",
    onSuccess: () => setDeleting(null),
  });

  return (
    <>
      <Card
        title="Overrides"
        flush
        actions={
          <Button small variant="primary" onClick={onNew}>
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
                  <Button small onClick={() => onEdit(p)}>
                    Edit
                  </Button>
                  <Button small variant="danger" onClick={() => setDeleting(p)}>
                    Delete
                  </Button>
                </div>
              )}
            />
          )}
        </QueryBoundary>
      </Card>

      {deleting && (
        <ConfirmDialog
          title={`Delete override for ${deleting.model}?`}
          message="Billing falls back to the fetched price for this model, if any."
          confirmLabel="Delete override"
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.model)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
