import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { Provider } from "../../api/types.ts";
import { Badge } from "../../components/badge.tsx";
import { Button } from "../../components/button.tsx";
import { ConfirmDialog } from "../../components/dialog.tsx";
import { Card, PageHeader } from "../../components/page.tsx";
import { EmptyState, QueryBoundary } from "../../components/query-state.tsx";
import { Table, Td, Th, Tr } from "../../components/table.tsx";
import { CreateProviderDialog } from "./provider-dialogs.tsx";

export function ProvidersPage() {
  const providers = useQuery({ queryKey: qk.providers, queryFn: api.providers });
  const types = useQuery({ queryKey: qk.providerTypes, queryFn: api.providerTypes });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Provider | null>(null);

  const toggle = useAction((p: Provider) => api.updateProvider(p.id, { enabled: !p.enabled }), {
    invalidate: [qk.providers],
  });
  const remove = useAction(api.deleteProvider, {
    invalidate: [qk.providers],
    success: "Provider deleted.",
    onSuccess: () => setDeleting(null),
  });

  const typeLabel = (type: string) => types.data?.find((t) => t.type === type)?.label ?? type;

  return (
    <>
      <PageHeader
        title="Providers"
        description="Upstream endpoints. Each holds a pool of credentials that the router rotates through."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Add provider
          </Button>
        }
      />
      <Card flush>
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
              <thead>
                <tr>
                  <Th>Provider</Th>
                  <Th>Base URL</Th>
                  <Th>Strategy</Th>
                  <Th className="text-right">Credentials</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <Tr key={p.id}>
                    <Td>
                      <Link
                        to={`/providers/${encodeURIComponent(p.id)}`}
                        className="font-medium text-accent hover:underline"
                      >
                        {p.id}
                      </Link>
                      <p className="text-xs text-muted">{typeLabel(p.type)}</p>
                    </Td>
                    <Td className="max-w-64 truncate font-mono text-xs" title={p.base_url}>
                      {p.base_url}
                    </Td>
                    <Td>{p.key_strategy}</Td>
                    <Td className="text-right tabular-nums">
                      {p.credentials === 0 ? <Badge tone="warn">none</Badge> : p.credentials}
                    </Td>
                    <Td>
                      <Badge tone={p.enabled ? "ok" : "neutral"}>
                        {p.enabled ? "enabled" : "disabled"}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-2">
                        <Button small onClick={() => toggle.mutate(p)}>
                          {p.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button small variant="danger" onClick={() => setDeleting(p)}>
                          Delete
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>

      {creating && <CreateProviderDialog onClose={() => setCreating(false)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.id}?`}
          message="Its credentials are deleted with it and aliases pointing here stop resolving. Usage history is kept."
          confirmLabel="Delete provider"
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
