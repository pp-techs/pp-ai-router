import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { PricingSyncResult } from "../../api/types.ts";
import { Badge } from "../../components/badge.tsx";
import { Button } from "../../components/button.tsx";
import { Card } from "../../components/page.tsx";
import { EmptyState, QueryBoundary } from "../../components/query-state.tsx";
import { Table, Td, Th, Tr } from "../../components/table.tsx";
import { formatDateTime, formatInt } from "../../lib/format.ts";
import { toast } from "../../lib/toast.ts";

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

  return (
    <Card
      title="Price sources"
      flush
      actions={
        <Button small variant="primary" loading={sync.isPending} onClick={() => sync.mutate()}>
          Sync now
        </Button>
      }
    >
      <QueryBoundary
        query={states}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState title="Never synced">
            Automatic sync may be disabled. Use “Sync now” to fetch prices.
          </EmptyState>
        }
      >
        {(list) => (
          <Table>
            <thead>
              <tr>
                <Th>Source</Th>
                <Th>Last synced</Th>
                <Th className="text-right">Models</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <Tr key={s.source}>
                  <Td className="font-medium">{s.source}</Td>
                  <Td>{s.synced_at === null ? "never" : formatDateTime(s.synced_at)}</Td>
                  <Td className="text-right tabular-nums">
                    {s.model_count === null ? "—" : formatInt(s.model_count)}
                  </Td>
                  <Td>
                    {s.last_error ? (
                      <>
                        <Badge tone="danger">error</Badge>
                        <p className="mt-1 text-xs break-words text-danger">{s.last_error}</p>
                      </>
                    ) : (
                      <Badge tone="ok">ok</Badge>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryBoundary>
    </Card>
  );
}
