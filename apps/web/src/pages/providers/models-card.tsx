import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { Provider, ProviderModels, ProviderType } from "../../api/types.ts";
import { Badge } from "../../components/badge.tsx";
import { Button } from "../../components/button.tsx";
import { Input } from "../../components/fields.tsx";
import { Card } from "../../components/page.tsx";
import { EmptyState, ErrorState, LoadingState } from "../../components/query-state.tsx";
import { Table, Td, Th, Tr } from "../../components/table.tsx";
import { formatDateTime, formatInt, formatPer1m } from "../../lib/format.ts";
import { filterModels, formatContextWindow } from "../../lib/models.ts";
import { toast } from "../../lib/toast.ts";

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
    <p className="text-xs text-muted">
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
    <Card
      title="Models"
      flush
      actions={
        type?.models === "static" ? (
          <Button
            small
            disabled
            title="This provider's models are built in; there is nothing to refresh."
          >
            Refresh
          </Button>
        ) : fetchable ? (
          <Button
            small
            variant="primary"
            loading={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
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
          <div className="grid gap-3 border-b border-line p-4">
            {list && <Status list={list} count={list.data.length} />}
            {list?.error && (
              <p role="alert" className="rounded-md bg-warn-soft px-3 py-2 text-warn">
                Could not refresh the list: {list.error}
                {list.data.length > 0 && " Showing the previous list."}
              </p>
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
              <Table wide>
                <thead>
                  <tr>
                    <Th>Model</Th>
                    <Th className="text-right">Context</Th>
                    <Th className="text-right">Input / 1M</Th>
                    <Th className="text-right">Output / 1M</Th>
                    <Th>Price source</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {matches.slice(0, shown).map((m) => (
                    <Tr key={m.id}>
                      <Td className="font-mono text-xs break-all">
                        {m.id}
                        {m.name && <p className="font-sans text-muted">{m.name}</p>}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {formatContextWindow(m.context_window)}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {formatPer1m(m.price?.input_per_1m ?? null)}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {formatPer1m(m.price?.output_per_1m ?? null)}
                      </Td>
                      <Td>
                        {m.price ? (
                          <Badge tone={m.price.source === "override" ? "accent" : "neutral"}>
                            {m.price.source}
                          </Badge>
                        ) : (
                          <span
                            className="text-muted"
                            title="No price known: requests are billed at $0"
                          >
                            —
                          </span>
                        )}
                      </Td>
                      <Td className="text-right">
                        <Button small onClick={() => onCreateAlias(m.id)}>
                          Create alias
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              {matches.length > shown && (
                <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
                  <span className="text-xs text-muted">
                    Showing {formatInt(shown)} of {formatInt(matches.length)}
                    {search.trim() ? " matches" : ""}
                  </span>
                  <Button small onClick={() => setShown((n) => n + PAGE)}>
                    Show more
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}
