import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BoxesIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Price, Provider, ProviderModelGroup } from "@/api/types";
import { ConfirmModal } from "@/components/confirm-modal";
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
import { OverrideModal } from "../pricing/override-dialog";
import { CustomModelModal } from "./custom-model-dialog";
import { ModelTable, type ModelTableProps } from "./model-table";
import { useModelTests } from "./use-model-tests";

/** More tests than this ask for confirmation first. */
const CONFIRM_TESTS_ABOVE = 10;
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
  /** What every model table needs besides its rows: switches, tests, row actions. */
  rowProps: Omit<ModelTableProps, "rows" | "showProvider" | "onCreateAlias">;
  refreshing: string | null;
  /** The provider whose bulk switch is being saved. */
  bulkPending: string | null;
  onRefresh: (provider: string) => void;
  /** `ids` absent = the provider's whole list. */
  onBulk: (provider: string, enabled: boolean, ids?: string[]) => void;
  onAddModel: (provider: string) => void;
  onTestRows: (rows: ModelRow[]) => void;
}

function Results({
  groups,
  search,
  status,
  grouping,
  providers,
  rowProps,
  refreshing,
  bulkPending,
  onRefresh,
  onBulk,
  onAddModel,
  onTestRows,
}: ResultsProps) {
  const [shown, setShown] = useState<Record<string, number>>({});
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const limit = (key: string) => shown[key] ?? PAGE;
  const more = (key: string) => setShown((s) => ({ ...s, [key]: limit(key) + PAGE }));
  const toggleCollapsed = (provider: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (!next.delete(provider)) next.add(provider);
      return next;
    });

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
    <p className="text-xs text-muted-foreground">
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
        <div className="mb-4">{summary}</div>
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
        <div className="mb-4">{summary}</div>
        <Panel flush>
          <ModelTable
            {...rowProps}
            rows={rows.slice(0, limit(FLAT))}
            showProvider
            onCreateAlias={createAlias}
          />
          <ShowMore shown={limit(FLAT)} total={rows.length} onMore={() => more(FLAT)} />
        </Panel>
      </>
    );
  }

  const providerKeys = visible.map((g) => g.provider);
  const allCollapsed = providerKeys.length > 0 && providerKeys.every((p) => collapsed.has(p));

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        {summary}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(providerKeys))}
        >
          {allCollapsed ? "Expand all" : "Collapse all"}
        </Button>
      </div>
      <div className="grid gap-6">
        {visible.map((group) => {
          const full = all.get(group.provider) ?? group;
          const rows = group.data.map((model) => ({ provider: group.provider, model }));
          const isRefreshing = refreshing === group.provider;
          const isCollapsed = collapsed.has(group.provider);
          const busy = bulkPending === group.provider;
          // With a filter on, the bulk buttons act on the models shown, otherwise on the whole list.
          const scope = filtering ? "shown" : "all";
          const bulkIds = filtering ? group.data.map((m) => m.id) : undefined;
          // Enabled models only: switching a model off is how you keep it out of a test run.
          const testable = rows.filter((r) => r.model.enabled);
          return (
            <Panel
              key={group.provider}
              flush
              collapsed={isCollapsed}
              title={
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.provider}`}
                    onClick={() => toggleCollapsed(group.provider)}
                  >
                    {isCollapsed ? (
                      <ChevronRightIcon className="size-4 text-muted-foreground" />
                    ) : (
                      <ChevronDownIcon className="size-4 text-muted-foreground" />
                    )}
                    <span className="font-mono">{group.provider}</span>
                  </button>
                  {!group.provider_enabled && (
                    <StatusBadge tone="warn">provider disabled</StatusBadge>
                  )}
                </span>
              }
              description={describeGroup(full)}
              actions={
                <>
                  <Button size="sm" variant="outline" onClick={() => onAddModel(group.provider)}>
                    <PlusIcon data-icon="inline-start" />
                    Add model
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rowProps.testBusy || testable.length === 0}
                    onClick={() => onTestRows(testable)}
                  >
                    <PlayIcon data-icon="inline-start" />
                    Test {scope}
                  </Button>
                  {group.data.some((m) => m.enabled) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onBulk(group.provider, false, bulkIds)}
                    >
                      Disable {scope}
                    </Button>
                  )}
                  {group.data.some((m) => !m.enabled) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onBulk(group.provider, true, bulkIds)}
                    >
                      Enable {scope}
                    </Button>
                  )}
                  {group.source !== "static" && (
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
                  )}
                </>
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
                    {...rowProps}
                    rows={rows.slice(0, limit(group.provider))}
                    showProvider={false}
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

  const bulk = useAction(
    ({ provider, enabled, ids }: { provider: string; enabled: boolean; ids?: string[] }) =>
      api.setModelsEnabled(provider, enabled, ids),
    {
      invalidate: [qk.models],
      onSuccess: (result) => {
        void client.invalidateQueries({ queryKey: qk.providerModels(result.provider) });
        toast.success(
          `${result.enabled ? "Enabled" : "Disabled"} ${plural(result.count, "model")} of ${result.provider}.`,
        );
      },
    },
  );

  const pending = toggle.isPending
    ? `${toggle.variables.row.provider}/${toggle.variables.row.model.id}`
    : null;

  const tests = useModelTests();
  const providerNames = (groups.data ?? []).map((g) => g.provider);
  // What the toolbar's test button covers: every enabled model the current filter shows.
  const shownGroups = filterGroups(groups.data ?? [], search, status);
  const filtering = search.trim() !== "" || status !== "all";
  const testable = flattenGroups(shownGroups).filter((r) => r.model.enabled);

  const addModel = (provider: string | null) =>
    void CustomModelModal.show({ providers: providerNames, provider, model: null });

  const deleteModel = (row: ModelRow) =>
    void ConfirmModal.show({
      title: `Delete ${row.provider}/${row.model.id}?`,
      message:
        "The custom model leaves the list. Requests that name it directly still reach the provider.",
      confirmLabel: "Delete model",
      action: async () => {
        await api.deleteCustomModel(row.provider, row.model.id);
        await client.invalidateQueries({ queryKey: qk.models });
        void client.invalidateQueries({ queryKey: qk.providerModels(row.provider) });
      },
    });

  /** Opens the price override form for `provider/model`, prefilled with what is known. */
  async function setPrice(row: ModelRow) {
    const key = `${row.provider}/${row.model.id}`;
    const found = await api.priceLookup(key).catch(() => null);
    const own = found !== null && found.source === "override" && found.model === key;
    const base: Price = own
      ? found
      : {
          model: key,
          source: "",
          input_per_1m: found?.input_per_1m ?? null,
          output_per_1m: found?.output_per_1m ?? null,
          cache_read_per_1m: found?.cache_read_per_1m ?? null,
          cache_write_per_1m: found?.cache_write_per_1m ?? null,
          reasoning_per_1m: null,
          tiers: [],
        };
    if (await OverrideModal.show({ base })) {
      void client.invalidateQueries({ queryKey: qk.models });
    }
  }

  /** Runs the tests, asking first when it is a lot of requests (each may be billed by the upstream). */
  function runTests(rows: ModelRow[]) {
    if (rows.length <= CONFIRM_TESTS_ABOVE) {
      void tests.start(rows);
      return;
    }
    void ConfirmModal.show({
      title: `Test ${plural(rows.length, "model")}?`,
      message:
        "Each test sends one tiny request through the provider's own credentials, which the upstream may bill. They run a few at a time and you can stop at any point.",
      confirmLabel: `Run ${formatInt(rows.length)} tests`,
      destructive: false,
      action: async () => {
        void tests.start(rows);
      },
    });
  }

  const rowProps: Omit<ModelTableProps, "rows" | "showProvider" | "onCreateAlias"> = {
    pending,
    testing: tests.testing,
    testBusy: tests.run !== null,
    onToggle: (row, enabled) => toggle.mutate({ row, enabled }),
    onTest: (row) => void tests.start([row]),
    onSetPrice: (row) => void setPrice(row),
    onEdit: (row) =>
      void CustomModelModal.show({ providers: providerNames, provider: row.provider, model: row }),
    onDelete: deleteModel,
  };

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
        <Button
          variant="outline"
          onClick={() => addModel(null)}
          disabled={providerNames.length === 0}
        >
          <PlusIcon data-icon="inline-start" />
          Add model
        </Button>
        {tests.run ? (
          <>
            <span className="text-xs text-muted-foreground tabular-nums">
              Testing {tests.run.done} / {tests.run.total}
            </span>
            <Button variant="outline" onClick={tests.stop}>
              <SquareIcon data-icon="inline-start" />
              Stop
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            disabled={testable.length === 0}
            onClick={() => runTests(testable)}
          >
            <PlayIcon data-icon="inline-start" />
            Test {filtering ? "shown" : "all"}
          </Button>
        )}
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
            rowProps={rowProps}
            refreshing={refresh.isPending ? (refresh.variables ?? null) : null}
            bulkPending={bulk.isPending ? bulk.variables.provider : null}
            onRefresh={(provider) => refresh.mutate(provider)}
            onBulk={(provider, enabled, ids) => bulk.mutate({ provider, enabled, ids })}
            onAddModel={addModel}
            onTestRows={runTests}
          />
        )}
      </QueryBoundary>
    </>
  );
}
