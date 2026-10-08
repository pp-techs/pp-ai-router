import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Provider } from "@/api/types";
import { ConfirmModal } from "@/components/confirm-modal";
import { PageHeader, Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateProviderModal } from "./provider-dialogs";

export function ProvidersPage() {
  const providers = useQuery({ queryKey: qk.providers, queryFn: api.providers });
  const types = useQuery({ queryKey: qk.providerTypes, queryFn: api.providerTypes });

  const toggle = useAction((p: Provider) => api.updateProvider(p.id, { enabled: !p.enabled }), {
    invalidate: [qk.providers],
  });
  const remove = useAction(api.deleteProvider, {
    invalidate: [qk.providers],
    success: "Provider deleted.",
    inline: true,
  });

  const typeLabel = (type: string) => types.data?.find((t) => t.type === type)?.label ?? type;

  return (
    <>
      <PageHeader
        title="Providers"
        description="Upstream endpoints. Each holds a pool of credentials that the router rotates through."
        actions={<Button onClick={() => void CreateProviderModal.show({})}>Add provider</Button>}
      />
      <Panel flush>
        <QueryBoundary
          query={providers}
          isEmpty={(list) => list.length === 0}
          empty={
            <EmptyState title="No providers yet">
              Add one, then give it at least one credential.
            </EmptyState>
          }
        >
          {(list) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Base URL</TableHead>
                  <TableHead>Strategy</TableHead>
                  <TableHead className="text-right">Credentials</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Link
                        to={`/providers/${encodeURIComponent(p.id)}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {p.id}
                      </Link>
                      <p className="text-xs text-muted-foreground">{typeLabel(p.type)}</p>
                    </TableCell>
                    <TableCell className="max-w-64 truncate font-mono text-xs" title={p.base_url}>
                      {p.base_url}
                    </TableCell>
                    <TableCell>{p.key_strategy}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.credentials === 0 ? (
                        <StatusBadge tone="warn">none</StatusBadge>
                      ) : (
                        p.credentials
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={p.enabled ? "ok" : "neutral"}>
                        {p.enabled ? "enabled" : "disabled"}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => toggle.mutate(p)}>
                          {p.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            void ConfirmModal.show({
                              title: `Delete ${p.id}?`,
                              message:
                                "Its credentials are deleted with it and aliases pointing here stop resolving. Usage history is kept.",
                              confirmLabel: "Delete provider",
                              action: () => remove.mutateAsync(p.id),
                            })
                          }
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </QueryBoundary>
      </Panel>
    </>
  );
}
