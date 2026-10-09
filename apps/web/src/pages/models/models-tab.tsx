import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BoxesIcon, RefreshCwIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Provider, ProviderModelGroup } from "@/api/types";
import { OptionSelect } from "@/components/option-select";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatDateTime, formatInt } from "@/lib/format";
import { filterGroups, flattenGroups, type ModelRow, type StatusFilter } from "@/lib/models";
import { toast } from "@/lib/toast";
import { AliasModal } from "../alias-dialog";
import { ModelTable } from "./model-table";

/** Rows rendered at once per list: a provider can offer thousands of models. */
const PAGE = 50;
/** Key of the single list in flat mode. */
const FLAT = "*";

type Grouping = "provider" | "flat";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Any status" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

const plural = (n: number, noun: string) => `${formatInt(n)} ${noun}${n === 1 ? "" : "s"}`;

function describeGroup(group: ProviderModelGroup) {
  const disabled = group.data.filter((m) => !m.enabled).length;
  const when =
    group.source === "static"
      ? "Built-in list"
      : group.fetched_at === null
        ? "Never fetched"
        : `Last fetched ${formatDateTime(group.fetched_at)}`;
  return [
    plural(group.data.length, "model"),
    disabled > 0 && `${formatInt(disabled)} disabled`,
    when,
  ]
    .filter(Boolean)
    .join(" · ");
}

function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (total <= shown) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
      <span className="text-xs text-muted-foreground">
        Showing {formatInt(shown)} of {formatInt(total)}
      </span>
      <Button size="sm" variant="outline" onClick={onMore}>
        Show more
      </Button>
    </div>
  );
}

interface ResultsProps {
  groups: ProviderModelGroup[];
  search: string;
  status: StatusFilter;
  grouping: Grouping;
  providers: Provider[] | undefined;
  pending: string | null;
  refreshing: string | null;
  onToggle: (row: ModelRow, enabled: boolean) => void;
  onRefresh: (provider: string) => void;
}

function Results({
  groups,
  search,
  status,
  grouping,
  providers,
  pending,
  refreshing,
  onToggle,
  onRefresh,
}: ResultsProps) {
  const [shown, setShown] = useState<Record<string, number>>({});
  const limit = (key: string) => shown[key] ?? PAGE;
  const more = (key: string) => setShown((s) => ({ ...s, [key]: limit(key) + PAGE }));

  const visible = filterGroups(groups, search, status);
  const filtering = visible !== groups;
  const all = new Map(groups.map((g) => [g.provider, g]));
  const total = groups.reduce((n, g) => n + g.data.length, 0);
  const disabled = groups.reduce((n, g) => n + g.data.filter((m) => !m.enabled).length, 0);

  const createAlias = providers
    ? (row: ModelRow) =>
        void AliasModal.show({
          alias: null,
          firstTarget: { provider: row.provider, model: row.model.id },
          providers,
        })
    : undefined;

  const summary = (
    <p className="mb-4 text-xs text-muted-foreground">
      {plural(total, "model")} across {plural(groups.length, "provider")}
      {disabled > 0 && ` · ${formatInt(disabled)} disabled`}
    </p>
  );

  if (filtering && visible.length === 0) {
    const label = search.trim()
      ? `No models match “${search.trim()}”`
      : "No models match the filter";
    return (
      <>
        {summary}
        <Panel>
          <EmptyState title={label} icon={SearchIcon} />
        </Panel>
      </>
    );
  }

  if (grouping === "flat") {
    const rows = flattenGroups(visible);
    return (
      <>
        {summary}
        <Panel flush>
          <ModelTable
            rows={rows.slice(0, limit(FLAT))}
            showProvider
            pending={pending}
            onToggle={onToggle}
            onCreateAlias={createAlias}
          />
          <ShowMore shown={limit(FLAT)} total={rows.length} onMore={() => more(FLAT)} />
        </Panel>
      </>
    );
  }

  return (
    <>
      {summary}
      <div className="grid gap-6">
        {visible.map((group) => {
          const full = all.get(group.provider) ?? group;
          const rows = group.data.map((model) => ({ provider: group.provider, model }));
          const isRefreshing = refreshing === group.provider;
          return (
            <Panel
              key={group.provider}
              flush
              title={
                <span className="flex items-center gap-2">
                  <span className="font-mono">{group.provider}</span>
                  {!group.provider_enabled && (
                    <StatusBadge tone="warn">provider disabled</StatusBadge>
                  )}
                </span>
              }
              description={describeGroup(full)}
              actions={
                group.source !== "static" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isRefreshing}
                    aria-label={`Refresh ${group.provider} models`}
                    onClick={() => onRefresh(group.provider)}
                  >
                    {isRefreshing ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <RefreshCwIcon data-icon="inline-start" />
                    )}
                    Refresh
                  </Button>
                )
              }
            >
              {full.error && (
                <div className="border-b border-border p-4">
                  <Alert>
                    <TriangleAlertIcon />
                    <AlertDescription>
                      Could not refresh the list: {full.error}
                      {full.data.length > 0 && " Showing the previous list."}
                    </AlertDescription>
                  </Alert>
                </div>
              )}
              {rows.length === 0 ? (
                <EmptyState title="No models known" icon={BoxesIcon}>
                  Refresh to fetch the list from the upstream. You can still route to any
                  provider/model id.
                </EmptyState>
              ) : (
                <>
                  <ModelTable
                    rows={rows.slice(0, limit(group.provider))}
                    showProvider={false}
                    pending={pending}
                    onToggle={onToggle}
                    onCreateAlias={createAlias}
                  />
                  <ShowMore
                    shown={limit(group.provider)}
                    total={rows.length}
                    onMore={() => more(group.provider)}
                  />
                </>
              )}
            </Panel>
          );
        })}
      </div>
    </>
  );
}

/** Every model the providers offer, with an on/off switch each; group by provider or one flat list. */
export function ModelsTab() {
  const client = useQueryClient();
  const groups = useQuery({ queryKey: qk.models, queryFn: api.models });
  const providers = useQuery({ queryKey: qk.providers, queryFn: api.providers });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [grouping, setGrouping] = useState<Grouping>("provider");

  const toggle = useAction(
    ({ row, enabled }: { row: ModelRow; enabled: boolean }) =>
      api.setModelEnabled(row.provider, row.model.id, enabled),
    {
      onSuccess: (result) => {
        // Flip the switch from the response rather than waiting for a refetch; the provider page's list is refreshed lazily.
        client.setQueryData<ProviderModelGroup[]>(qk.models, (old) =>
          old?.map((g) =>
            g.provider === result.provider
              ? {
                  ...g,
                  data: g.data.map((m) =>
                    m.id === result.id ? { ...m, enabled: result.enabled } : m,
                  ),
                }
              : g,
          ),
        );
        void client.invalidateQueries({ queryKey: qk.providerModels(result.provider) });
      },
    },
  );

  const refresh = useAction((provider: string) => api.refreshProviderModels(provider), {
    invalidate: [qk.models],
    onSuccess: (list, provider) => {
      if (list.error === null)
        toast.success(`Fetched ${plural(list.data.length, "model")} for ${provider}.`);
    },
  });

  const pending = toggle.isPending
    ? `${toggle.variables.row.provider}/${toggle.variables.row.model.id}`
    : null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Search models"
            className="pl-8"
            value={search}
            placeholder="Search by provider, model id or name…"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <OptionSelect
          aria-label="Filter by status"
          className="w-auto min-w-36"
          value={status}
          onValueChange={(v) => setStatus(v as StatusFilter)}
          options={STATUS_OPTIONS}
        />
        <ToggleGroup
          variant="outline"
          aria-label="Group models"
          value={[grouping]}
          onValueChange={([next]) => next && setGrouping(next as Grouping)}
        >
          <ToggleGroupItem value="provider">By provider</ToggleGroupItem>
          <ToggleGroupItem value="flat">Flat list</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <QueryBoundary
        query={groups}
        isEmpty={(list) => list.length === 0}
        empty={
          <Panel>
            <EmptyState title="No providers yet" icon={BoxesIcon}>
              Add a provider and its models appear here.
            </EmptyState>
          </Panel>
        }
      >
        {(list) => (
          <Results
            groups={list}
            search={search}
            status={status}
            grouping={grouping}
            providers={providers.data}
            pending={pending}
            refreshing={refresh.isPending ? (refresh.variables ?? null) : null}
            onToggle={(row, enabled) => toggle.mutate({ row, enabled })}
            onRefresh={(provider) => refresh.mutate(provider)}
          />
        )}
      </QueryBoundary>
    </>
  );
}
