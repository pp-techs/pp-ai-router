import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
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
import { AliasModal } from "./alias-dialog";

export function AliasesPage() {
  const aliases = useQuery({ queryKey: qk.aliases, queryFn: api.aliases });
  const providers = useQuery({ queryKey: qk.providers, queryFn: api.providers });

  const remove = useAction((alias: string) => api.deleteAlias(alias), {
    invalidate: [qk.aliases],
    inline: true,
    success: "Alias deleted.",
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
            disabled={!providers.data?.length}
            onClick={() =>
              providers.data && void AliasModal.show({ alias: null, providers: providers.data })
            }
          >
            New alias
          </Button>
        }
      />
      <Panel flush>
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
              <TableHeader>
                <TableRow>
                  <TableHead>Alias</TableHead>
                  <TableHead>Targets, in fallback order</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((a) => (
                  <TableRow key={a.alias}>
                    <TableCell className="font-mono font-medium">{a.alias}</TableCell>
                    <TableCell>
                      <ol className="grid gap-1">
                        {a.targets.map((t, i) => (
                          <li key={i} className="flex items-center gap-2">
                            <span className="w-20">
                              <StatusBadge tone={i === 0 ? "accent" : "neutral"}>
                                {i === 0 ? "primary" : `fallback ${i}`}
                              </StatusBadge>
                            </span>
                            <span className="font-mono text-xs">
                              {t.provider}/{t.model}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!providers.data}
                          onClick={() =>
                            providers.data &&
                            void AliasModal.show({ alias: a, providers: providers.data })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            void ConfirmModal.show({
                              title: `Delete alias ${a.alias}?`,
                              message:
                                "Clients using this model name will get an error until it is recreated.",
                              confirmLabel: "Delete alias",
                              action: () => remove.mutateAsync(a.alias),
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
