import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.ts";
import { qk, useAction } from "../api/queries.ts";
import type { Alias } from "../api/types.ts";
import { Badge } from "../components/badge.tsx";
import { Button } from "../components/button.tsx";
import { ConfirmDialog } from "../components/dialog.tsx";
import { Card, PageHeader } from "../components/page.tsx";
import { EmptyState, QueryBoundary } from "../components/query-state.tsx";
import { Table, Td, Th, Tr } from "../components/table.tsx";
import { AliasDialog } from "./alias-dialog.tsx";

export function AliasesPage() {
  const aliases = useQuery({ queryKey: qk.aliases, queryFn: api.aliases });
  const providers = useQuery({ queryKey: qk.providers, queryFn: api.providers });
  const [editing, setEditing] = useState<Alias | "new" | null>(null);
  const [deleting, setDeleting] = useState<Alias | null>(null);

  const remove = useAction((alias: string) => api.deleteAlias(alias), {
    invalidate: [qk.aliases],
    success: "Alias deleted.",
    onSuccess: () => setDeleting(null),
  });

  return (
    <>
      <PageHeader
        title="Models"
        description={
          <>
            An alias is a public model name that maps to an ordered list of upstream targets. The
            router tries them top to bottom, so later targets are fallbacks. Without an alias,{" "}
            <code className="font-mono text-xs">provider/model</code> also works.
          </>
        }
        actions={
          <Button
            variant="primary"
            disabled={!providers.data?.length}
            onClick={() => setEditing("new")}
          >
            New alias
          </Button>
        }
      />
      <Card flush>
        <QueryBoundary
          query={aliases}
          isEmpty={(list) => list.length === 0}
          empty={
            <EmptyState title="No aliases yet">
              {providers.data?.length === 0
                ? "Add a provider first."
                : "Create one to give clients a stable model name."}
            </EmptyState>
          }
        >
          {(list) => (
            <Table>
              <thead>
                <tr>
                  <Th>Alias</Th>
                  <Th>Targets, in fallback order</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <Tr key={a.alias}>
                    <Td className="font-mono font-medium">{a.alias}</Td>
                    <Td>
                      <ol className="grid gap-1">
                        {a.targets.map((t, i) => (
                          <li key={i} className="flex items-center gap-2">
                            <span className="w-20">
                              <Badge tone={i === 0 ? "accent" : "neutral"}>
                                {i === 0 ? "primary" : `fallback ${i}`}
                              </Badge>
                            </span>
                            <span className="font-mono text-xs">
                              {t.provider}/{t.model}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-2">
                        <Button small onClick={() => setEditing(a)}>
                          Edit
                        </Button>
                        <Button small variant="danger" onClick={() => setDeleting(a)}>
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

      {editing && providers.data && (
        <AliasDialog
          alias={editing === "new" ? null : editing}
          providers={providers.data}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete alias ${deleting.alias}?`}
          message="Clients using this model name will get an error until it is recreated."
          confirmLabel="Delete alias"
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.alias)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
