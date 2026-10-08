import { useQuery } from "@tanstack/react-query";
import { ScrollTextIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import type { Provider, UsageEvent, UsageFilter, UsageStatus, VirtualKey } from "@/api/types";
import { FormField } from "@/components/form-field";
import { OptionSelect } from "@/components/option-select";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { StatusBadge, type Tone } from "@/components/status-badge";
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
import { formatDateTime, formatInt, formatLatency, formatUsd } from "@/lib/format";

const PAGE_SIZE = 50;

const STATUS_TONE: Record<UsageStatus, Tone> = {
  ok: "ok",
  aborted: "warn",
  no_usage: "warn",
  error: "danger",
};

interface Draft {
  key_id: string;
  provider_id: string;
  model: string;
}

const toFilter = (draft: Draft): UsageFilter => ({
  ...(draft.key_id && { key_id: draft.key_id }),
  ...(draft.provider_id && { provider_id: draft.provider_id }),
  ...(draft.model.trim() && { model: draft.model.trim() }),
});

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
  providers,
}: {
  keys: VirtualKey[] | undefined;
  providers: Provider[] | undefined;
}) {
  const [draft, setDraft] = useState<Draft>({ key_id: "", provider_id: "", model: "" });
  const [filter, setFilter] = useState<UsageFilter>({});
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
  const before = cursors[cursors.length - 1];

  const events = useQuery({
    queryKey: qk.usage({ ...filter, before, limit: PAGE_SIZE }),
    queryFn: () => api.usage({ ...filter, before, limit: PAGE_SIZE }),
    // Only the newest page is live; older pages are immutable history.
    refetchInterval: before === undefined ? 10_000 : false,
  });

  function apply(event: FormEvent) {
    event.preventDefault();
    setFilter(toFilter(draft));
    setCursors([undefined]);
  }

  function reset() {
    setDraft({ key_id: "", provider_id: "", model: "" });
    setFilter({});
    setCursors([undefined]);
  }

  const keyName = (id: string) =>
    keys?.find((k) => k.id === id)?.name ?? `${id.slice(0, 8)}… (deleted)`;
  const hasFilter = Object.keys(filter).length > 0;
  const rows = events.data ?? [];

  return (
    <Panel title="Ledger" description="Request stream and per-call token breakdown." flush>
      <form
        onSubmit={apply}
        className="flex flex-wrap items-end gap-3 border-b border-border bg-muted/30 p-4"
      >
        <FormField label="API key" className="w-auto min-w-40">
          <OptionSelect
            value={draft.key_id}
            onValueChange={(v) => setDraft((d) => ({ ...d, key_id: v }))}
            options={[
              { value: "", label: "All keys" },
              ...(keys?.map((k) => ({ value: k.id, label: k.name })) ?? []),
            ]}
          />
        </FormField>
        <FormField label="Provider" className="w-auto min-w-40">
          <OptionSelect
            value={draft.provider_id}
            onValueChange={(v) => setDraft((d) => ({ ...d, provider_id: v }))}
            options={[
              { value: "", label: "All providers" },
              ...(providers?.map((p) => ({ value: p.id, label: p.id })) ?? []),
            ]}
          />
        </FormField>
        <FormField label="Model (exact)" className="w-auto min-w-48">
          <Input
            value={draft.model}
            placeholder="e.g. fast"
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
          />
        </FormField>
        <Button type="submit">Apply</Button>
        {hasFilter && (
          <Button type="button" variant="outline" onClick={reset}>
            Clear
          </Button>
        )}
      </form>

      <QueryBoundary
        query={events}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState
            icon={ScrollTextIcon}
            title={hasFilter ? "No events match these filters" : "No usage recorded yet"}
          >
            {!hasFilter && "Requests sent through /v1 appear here."}
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
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          ← Newer
        </Button>
        <span className="text-xs text-muted-foreground">Page {cursors.length}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={rows.length < PAGE_SIZE}
          onClick={() => setCursors((c) => [...c, rows[rows.length - 1]!.id])}
        >
          Older →
        </Button>
      </div>
    </Panel>
  );
}
