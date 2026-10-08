import { useQuery } from "@tanstack/react-query";
import { PlusIcon, SearchIcon, ServerIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Provider } from "@/api/types";
import { ConfirmModal } from "@/components/confirm-modal";
import { PageHeader, Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const [filter, setFilter] = useState("");

  return (
    <>
      <PageHeader
        title="Providers"
        description="Upstream endpoints. Each holds a pool of credentials that the router rotates through."
        actions={
          <Button onClick={() => void CreateProviderModal.show({})}>
            <PlusIcon data-icon="inline-start" />
            Add provider
          </Button>
        }
      />
      <Panel flush>
        <QueryBoundary
          query={providers}
          isEmpty={(list) => list.length === 0}
          empty={
            <EmptyState
              title="No providers yet"
              icon={ServerIcon}
              action={
                <Button onClick={() => void CreateProviderModal.show({})}>
                  <PlusIcon data-icon="inline-start" />
                  Add provider
                </Button>
              }
            >
              Add one, then give it at least one credential.
            </EmptyState>
          }
        >
          {(all) => {
            const q = filter.trim().toLowerCase();
            const list = q
              ? all.filter(
                  (p) => p.id.toLowerCase().includes(q) || p.base_url.toLowerCase().includes(q),
                )
              : all;
            const pooled = all.reduce((n, p) => n + p.credentials, 0);
            return (
              <div className="flex flex-col">
                <div className="relative max-w-sm p-3">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-5.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    placeholder="Filter providers or URLs…"
                    aria-label="Filter providers or URLs"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
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
                        <TableCell>
                          <span
                            className="inline-block max-w-64 truncate rounded-md bg-muted px-2 py-0.5 align-middle font-mono text-xs text-muted-foreground"
                            title={p.base_url}
                          >
                            {p.base_url}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono">
                            {p.key_strategy}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {p.credentials === 0 ? (
                            <StatusBadge tone="warn">none</StatusBadge>
                          ) : (
                            p.credentials
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusBadge dot tone={p.enabled ? "ok" : "neutral"}>
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
                    {list.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          No providers match “{filter}”.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                <p className="border-t px-4 py-3 text-xs text-muted-foreground">
                  {all.length} {all.length === 1 ? "provider" : "providers"} configured · {pooled}{" "}
                  {pooled === 1 ? "credential" : "credentials"} pooled
                </p>
              </div>
            );
          }}
        </QueryBoundary>
      </Panel>
    </>
  );
}
