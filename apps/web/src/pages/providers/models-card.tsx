import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Provider, ProviderModels, ProviderType } from "@/api/types";
import { Panel } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/query-state";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatInt, formatPer1m } from "@/lib/format";
import { filterModels, formatContextWindow } from "@/lib/models";
import { toast } from "@/lib/toast";

/** Rows rendered at once: a provider can list thousands of models. */
const PAGE = 50;

function Status({ list, count }: { list: ProviderModels; count: number }) {
  const when =
    list.source === "static"
      ? "Built-in list"
      : list.fetched_at === null
        ? "Never fetched"
        : `Last fetched ${formatDateTime(list.fetched_at)}`;
  return (
    <p className="text-xs text-muted-foreground">
      {formatInt(count)} {count === 1 ? "model" : "models"} · {when}
    </p>
  );
}

export function ModelsCard({
  provider,
  type,
  onCreateAlias,
}: {
  provider: Provider;
  type: ProviderType | undefined;
  onCreateAlias: (model: string) => void;
}) {
  const client = useQueryClient();
  const models = useQuery({
    queryKey: qk.providerModels(provider.id),
    queryFn: () => api.providerModels(provider.id),
  });
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);

  const refresh = useAction(() => api.refreshProviderModels(provider.id), {
    onSuccess: (list) => {
      client.setQueryData(qk.providerModels(provider.id), list);
      if (list.error === null) toast.success(`Fetched ${formatInt(list.data.length)} models.`);
    },
  });

  const fetchable = type?.models === "fetch";
  const list = models.data;
  const matches = list ? filterModels(list.data, search) : [];

  return (
    <Panel
      title="Models"
      flush
      actions={
        type?.models === "static" ? (
          <Button
            size="sm"
            variant="outline"
            disabled
            title="This provider's models are built in; there is nothing to refresh."
          >
            Refresh
          </Button>
        ) : fetchable ? (
          <Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            {refresh.isPending && <Spinner data-icon="inline-start" />}
            Refresh
          </Button>
        ) : null
      }
    >
      {models.isPending ? (
        <LoadingState label="Loading models… the first load may fetch them from the upstream." />
      ) : models.isError ? (
        <ErrorState error={models.error} onRetry={() => void models.refetch()} />
      ) : (
        <>
          <div className="grid gap-3 border-b border-border p-4">
            {list && <Status list={list} count={list.data.length} />}
            {list?.error && (
              <Alert>
                <TriangleAlertIcon />
                <AlertDescription>
                  Could not refresh the list: {list.error}
                  {list.data.length > 0 && " Showing the previous list."}
                </AlertDescription>
              </Alert>
            )}
            {list && list.data.length > 0 && (
              <Input
                type="search"
                aria-label="Search models"
                placeholder="Search by id or name"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setShown(PAGE);
                }}
              />
            )}
          </div>
          {!list || list.data.length === 0 ? (
            <EmptyState title="No models known">
              {fetchable
                ? provider.credentials === 0
                  ? "Add a credential, then refresh to fetch the list from the upstream."
                  : "Refresh to fetch the list from the upstream."
                : "This provider type does not list its models. You can still route to any provider/model id."}
            </EmptyState>
          ) : matches.length === 0 ? (
            <EmptyState title={`No models match “${search.trim()}”`} />
          ) : (
            <>
              <Table className="min-w-176">
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Context</TableHead>
                    <TableHead className="text-right">Input / 1M</TableHead>
                    <TableHead className="text-right">Output / 1M</TableHead>
                    <TableHead>Price source</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matches.slice(0, shown).map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="font-mono text-xs break-all whitespace-normal">
                        {m.id}
                        {m.name && <p className="font-sans text-muted-foreground">{m.name}</p>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatContextWindow(m.context_window)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPer1m(m.price?.input_per_1m ?? null)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPer1m(m.price?.output_per_1m ?? null)}
                      </TableCell>
                      <TableCell>
                        {m.price ? (
                          <StatusBadge tone={m.price.source === "override" ? "accent" : "neutral"}>
                            {m.price.source}
                          </StatusBadge>
                        ) : (
                          <span
                            className="text-muted-foreground"
                            title="No price known: requests are billed at $0"
                          >
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => onCreateAlias(m.id)}>
                          Create alias
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {matches.length > shown && (
                <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
                  <span className="text-xs text-muted-foreground">
                    Showing {formatInt(shown)} of {formatInt(matches.length)}
                    {search.trim() ? " matches" : ""}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setShown((n) => n + PAGE)}>
                    Show more
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Panel>
  );
}
