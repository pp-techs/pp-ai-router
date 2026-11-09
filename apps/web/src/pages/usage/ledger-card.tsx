import { useQuery } from "@tanstack/react-query";
import { ScrollTextIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import type { UsageEvent, UsageQuery, UsageStatus, VirtualKey } from "@/api/types";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatInt, formatLatency, formatUsd } from "@/lib/format";
import { RANGES, type RangeKey } from "@/lib/timeline";

const PAGE_SIZE = 50;

const STATUS_TONE: Record<UsageStatus, Tone> = {
  ok: "ok",
  aborted: "warn",
  no_usage: "warn",
  error: "danger",
};

function EventRow({ event, keyName }: { event: UsageEvent; keyName: string }) {
  return (
    <TableRow>
      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(event.ts)}</TableCell>
      <TableCell>{keyName}</TableCell>
      <TableCell className="font-mono text-xs">{event.provider_id}</TableCell>
      <TableCell className="min-w-36 font-mono text-xs break-all">
        {event.model}
        {event.upstream_model !== event.model && (
          <p className="text-muted-foreground">→ {event.upstream_model}</p>
        )}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatInt(event.input_tokens)} in · {formatInt(event.output_tokens)} out
        {event.cached_tokens > 0 && (
          <p className="text-xs text-muted-foreground">{formatInt(event.cached_tokens)} cached</p>
        )}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatUsd(event.cost_usd)}
        {event.price_source === "unknown" && (
          <p>
            <StatusBadge tone="warn">unpriced</StatusBadge>
          </p>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge dot tone={STATUS_TONE[event.status]}>
          {event.status}
        </StatusBadge>
        {event.stream === 1 && <p className="text-xs text-muted-foreground">stream</p>}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatLatency(event.latency_ms)}
      </TableCell>
    </TableRow>
  );
}

/** Newest-first ledger. The server pages by `before=<id>`, so paging is a stack of cursors. */
export function UsageLedgerCard({
  keys,
  range,
  query,
}: {
  keys: VirtualKey[] | undefined;
  range: RangeKey;
  query: UsageQuery;
}) {
  // A new filter set (or range) starts a new paging stack without an effect: stale stacks are ignored.
  const filterKey = `${range}:${JSON.stringify(query)}`;
  const [paging, setPaging] = useState<{ key: string; cursors: (number | undefined)[] }>({
    key: "",
    cursors: [undefined],
  });
  const cursors = paging.key === filterKey ? paging.cursors : [undefined];
  const before = cursors[cursors.length - 1];

  const events = useQuery({
    queryKey: qk.usage({ ...query, before, limit: PAGE_SIZE }, range),
    queryFn: () => {
      const { ms } = RANGES[range];
      return api.usage({
        ...query,
        ...(ms !== null && { since: Date.now() - ms }),
        before,
        limit: PAGE_SIZE,
      });
    },
    // Only the newest page is live; older pages are immutable history.
    refetchInterval: before === undefined ? 10_000 : false,
  });

  const keyName = (id: string) =>
    keys?.find((k) => k.id === id)?.name ?? `${id.slice(0, 8)}… (deleted)`;
  const hasFilter = Object.keys(query).length > 0;
  const rows = events.data ?? [];

  return (
    <Panel title="Ledger" description="Request stream and per-call token breakdown." flush>
      <QueryBoundary
        query={events}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState
            icon={ScrollTextIcon}
            title={hasFilter ? "No events match these filters" : "No usage in this period"}
          >
            {!hasFilter &&
              (range === "all"
                ? "Requests sent through /v1 appear here."
                : "Widen the time range or add a filter.")}
          </EmptyState>
        }
      >
        {(list) => (
          <Table className="min-w-176">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Latency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((e) => (
                <EventRow key={e.id} event={e} keyName={keyName(e.key_id)} />
              ))}
            </TableBody>
          </Table>
        )}
      </QueryBoundary>

      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <Button
          variant="outline"
          size="sm"
          disabled={cursors.length === 1}
          onClick={() => setPaging({ key: filterKey, cursors: cursors.slice(0, -1) })}
        >
          ← Newer
        </Button>
        <span className="text-xs text-muted-foreground">Page {cursors.length}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={rows.length < PAGE_SIZE}
          onClick={() =>
            setPaging({ key: filterKey, cursors: [...cursors, rows[rows.length - 1]!.id] })
          }
        >
          Older →
        </Button>
      </div>
    </Panel>
  );
}
