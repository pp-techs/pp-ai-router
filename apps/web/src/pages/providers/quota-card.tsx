import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { AccountQuota, Provider, QuotaWindow } from "@/api/types";
import { Panel } from "@/components/page";
import { ProgressBar } from "@/components/progress";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime, formatDuration } from "@/lib/format";
import { describeFailure, formatCredits, quotaFraction } from "@/lib/quota";

/** Quota changes slowly and every probe hits the upstream, so poll at most once a minute. */
const POLL_MS = 60_000;

function Window({ window }: { window: QuotaWindow }) {
  const percent = Math.round(window.used_percent * 10) / 10;
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="font-medium">{window.label}</span>
        <span className="text-muted-foreground tabular-nums">
          {percent}% used
          {window.resets_at !== null &&
            ` · resets in ${formatDuration(window.resets_at - Date.now())}`}
        </span>
      </div>
      <ProgressBar fraction={quotaFraction(window.used_percent)} label={window.label} />
    </div>
  );
}

function AccountRow({ row }: { row: AccountQuota }) {
  const quota = row.quota;
  return (
    <li className="grid gap-3 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium break-all">{row.label}</p>
          {row.account && row.account !== row.label && (
            <p className="text-xs break-all text-muted-foreground">{row.account}</p>
          )}
        </div>
        {quota?.exhausted && (
          <StatusBadge tone="danger">
            {quota.resets_at === null
              ? "Exhausted · parked"
              : `Exhausted until ${formatDateTime(quota.resets_at)}`}
          </StatusBadge>
        )}
      </div>
      {row.status === "unavailable" || !quota ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">{describeFailure(row.failure)}</p>
      ) : (
        <>
          {quota.windows.map((w) => (
            <Window key={w.label} window={w} />
          ))}
          {quota.credits && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatCredits(quota.credits)}
            </p>
          )}
        </>
      )}
      <p className="text-xs text-muted-foreground">Checked {formatDateTime(row.checked_at)}</p>
    </li>
  );
}

export function QuotaCard({ provider }: { provider: Provider }) {
  const client = useQueryClient();
  const quota = useQuery({
    queryKey: qk.providerQuota(provider.id),
    queryFn: () => api.providerQuota(provider.id),
    refetchInterval: POLL_MS,
  });
  const refresh = useAction(() => api.providerQuota(provider.id, true), {
    onSuccess: (report) => client.setQueryData(qk.providerQuota(provider.id), report),
  });

  return (
    <Panel
      title="Quota"
      flush
      actions={
        <Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending && <Spinner data-icon="inline-start" />}
          Refresh
        </Button>
      }
    >
      <QueryBoundary
        query={quota}
        isEmpty={(report) => !report.supported || report.data.length === 0}
        empty={
          <EmptyState title="No quota to show">
            {provider.credentials === 0
              ? "Add a credential to see its quota."
              : "This provider did not report quota for any credential."}
          </EmptyState>
        }
      >
        {(report) => (
          <ul className="divide-y divide-border">
            {report.data.map((row) => (
              <AccountRow key={row.credential_id} row={row} />
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Panel>
  );
}
