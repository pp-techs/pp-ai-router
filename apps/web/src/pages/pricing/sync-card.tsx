import { useQuery } from "@tanstack/react-query";
import { CoinsIcon, RefreshCwIcon } from "lucide-react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { PricingSyncResult } from "@/api/types";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatInt } from "@/lib/format";
import { toast } from "@/lib/toast";

function describe(results: PricingSyncResult[]): string {
  return results
    .map((r) =>
      r.status === "error"
        ? `${r.source}: failed (${r.error})`
        : r.status === "updated"
          ? `${r.source}: ${formatInt(r.models ?? 0)} models updated`
          : `${r.source}: already up to date`,
    )
    .join(" · ");
}

export function PricingSyncCard() {
  const states = useQuery({ queryKey: qk.pricingSync, queryFn: api.pricingSync });
  const sync = useAction(api.syncPricing, {
    invalidate: [qk.pricing],
    // One source failing must not read as an all-clear.
    onSuccess: (results) =>
      (results.some((r) => r.status === "error") ? toast.error : toast.success)(describe(results)),
  });

  const syncButton = (
    <Button size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
      {sync.isPending ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <RefreshCwIcon data-icon="inline-start" />
      )}
      Sync now
    </Button>
  );

  return (
    <Panel
      title="Price sources"
      description="Upstream pricing catalogs and when each was last refreshed."
      flush
      actions={syncButton}
    >
      <QueryBoundary
        query={states}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState icon={CoinsIcon} title="Never synced">
            Automatic sync may be disabled. Use “Sync now” to fetch prices.
          </EmptyState>
        }
      >
        {(list) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Last synced</TableHead>
                <TableHead className="text-right">Models</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((s) => (
                <TableRow key={s.source}>
                  <TableCell className="font-medium">{s.source}</TableCell>
                  <TableCell>
                    {s.synced_at === null ? "never" : formatDateTime(s.synced_at)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.model_count === null ? "—" : formatInt(s.model_count)}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {s.last_error ? (
                      <>
                        <StatusBadge dot tone="danger">
                          error
                        </StatusBadge>
                        <p className="mt-1 text-xs break-words text-destructive">{s.last_error}</p>
                      </>
                    ) : (
                      <StatusBadge dot tone="ok">
                        ok
                      </StatusBadge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </QueryBoundary>
    </Panel>
  );
}
