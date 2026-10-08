import { useQuery } from "@tanstack/react-query";
import { NetworkIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Alias, Provider } from "@/api/types";
import { ConfirmModal } from "@/components/confirm-modal";
import { PageHeader, Panel } from "@/components/page";
import { RowActions } from "@/components/row-actions";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { StatusBadge } from "@/components/status-badge";
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
import { AliasModal } from "./alias-dialog";

const matches = (alias: Alias, needle: string) =>
  alias.alias.toLowerCase().includes(needle) ||
  alias.targets.some((t) => `${t.provider}/${t.model}`.toLowerCase().includes(needle));

function AliasTable({
  aliases,
  providers,
  onDelete,
}: {
  aliases: Alias[];
  providers: Provider[] | undefined;
  onDelete: (alias: Alias) => void;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const shown = needle ? aliases.filter((a) => matches(a, needle)) : aliases;
  const noun = aliases.length === 1 ? "alias" : "aliases";

  return (
    <>
      <div className="relative border-b border-border bg-muted/30 p-4">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-7 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Filter aliases"
          className="pl-8"
          value={search}
          placeholder="Filter aliases or provider targets…"
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={SearchIcon} title={`No aliases match “${search.trim()}”`} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Alias</TableHead>
              <TableHead>Targets, in fallback order</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((a) => (
              <TableRow key={a.alias}>
                <TableCell className="align-top">
                  <p className="font-mono font-medium">{a.alias}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.targets.length > 1
                      ? `${a.targets.length - 1} ${a.targets.length === 2 ? "fallback" : "fallbacks"}`
                      : "single target"}
                  </p>
                </TableCell>
                <TableCell>
                  <ol className="grid gap-1.5">
                    {a.targets.map((t, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <span className="w-20">
                          <StatusBadge tone={i === 0 ? "accent" : "neutral"}>
                            {i === 0 ? "primary" : `fallback ${i}`}
                          </StatusBadge>
                        </span>
                        <span className="font-mono text-xs">
                          {t.provider} / {t.model}
                        </span>
                      </li>
                    ))}
                  </ol>
                </TableCell>
                <TableCell className="align-top">
                  <RowActions
                    label={`Actions for ${a.alias}`}
                    groups={[
                      [
                        {
                          label: "Edit",
                          icon: PencilIcon,
                          disabled: !providers,
                          onSelect: () =>
                            providers && void AliasModal.show({ alias: a, providers }),
                        },
                      ],
                      [
                        {
                          label: "Delete",
                          icon: Trash2Icon,
                          destructive: true,
                          onSelect: () => onDelete(a),
                        },
                      ],
                    ]}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        {shown.length === aliases.length
          ? `${aliases.length} ${noun}`
          : `${shown.length} of ${aliases.length} ${noun}`}
      </p>
    </>
  );
}

export function AliasesPage() {
  const aliases = useQuery({ queryKey: qk.aliases, queryFn: api.aliases });
  const providers = useQuery({ queryKey: qk.providers, queryFn: api.providers });

  const remove = useAction((alias: string) => api.deleteAlias(alias), {
    invalidate: [qk.aliases],
    inline: true,
    success: "Alias deleted.",
  });

  const newButton = (
    <Button
      disabled={!providers.data?.length}
      onClick={() =>
        providers.data && void AliasModal.show({ alias: null, providers: providers.data })
      }
    >
      <PlusIcon data-icon="inline-start" />
      New alias
    </Button>
  );

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
        actions={newButton}
      />
      <Panel flush>
        <QueryBoundary
          query={aliases}
          isEmpty={(list) => list.length === 0}
          empty={
            <EmptyState
              icon={NetworkIcon}
              title="No aliases yet"
              action={providers.data?.length ? newButton : undefined}
            >
              {providers.data?.length === 0
                ? "Add a provider first."
                : "Create one to give clients a stable model name."}
            </EmptyState>
          }
        >
          {(list) => (
            <AliasTable
              aliases={list}
              providers={providers.data}
              onDelete={(a) =>
                void ConfirmModal.show({
                  title: `Delete alias ${a.alias}?`,
                  message: "Clients using this model name will get an error until it is recreated.",
                  confirmLabel: "Delete alias",
                  action: () => remove.mutateAsync(a.alias),
                })
              }
            />
          )}
        </QueryBoundary>
      </Panel>
    </>
  );
}
