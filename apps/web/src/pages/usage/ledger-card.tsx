import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client.ts";
import { qk } from "../../api/queries.ts";
import type {
  Provider,
  UsageEvent,
  UsageFilter,
  UsageStatus,
  VirtualKey,
} from "../../api/types.ts";
import { Badge, type Tone } from "../../components/badge.tsx";
import { Button } from "../../components/button.tsx";
import { Field, Input, Select } from "../../components/fields.tsx";
import { Card } from "../../components/page.tsx";
import { EmptyState, QueryBoundary } from "../../components/query-state.tsx";
import { Table, Td, Th, Tr } from "../../components/table.tsx";
import { formatDateTime, formatInt, formatLatency, formatUsd } from "../../lib/format.ts";

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
    <Tr>
      <Td className="text-xs whitespace-nowrap">{formatDateTime(event.ts)}</Td>
      <Td>{keyName}</Td>
      <Td>{event.provider_id}</Td>
      <Td className="min-w-36 font-mono text-xs break-all">
        {event.model}
        {event.upstream_model !== event.model && (
          <p className="text-muted">→ {event.upstream_model}</p>
        )}
      </Td>
      <Td className="text-right whitespace-nowrap tabular-nums">
        {formatInt(event.input_tokens)} in · {formatInt(event.output_tokens)} out
        {event.cached_tokens > 0 && (
          <p className="text-xs text-muted">{formatInt(event.cached_tokens)} cached</p>
        )}
      </Td>
      <Td className="text-right whitespace-nowrap tabular-nums">
        {formatUsd(event.cost_usd)}
        {event.price_source === "unknown" && (
          <p>
            <Badge tone="warn">unpriced</Badge>
          </p>
        )}
      </Td>
      <Td>
        <Badge tone={STATUS_TONE[event.status]}>{event.status}</Badge>
        {event.stream === 1 && <p className="text-xs text-muted">stream</p>}
      </Td>
      <Td className="text-right whitespace-nowrap tabular-nums">
        {formatLatency(event.latency_ms)}
      </Td>
    </Tr>
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
    <Card title="Ledger" flush>
      <form onSubmit={apply} className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        <Field label="API key" className="min-w-40">
          <Select
            value={draft.key_id}
            onChange={(e) => setDraft((d) => ({ ...d, key_id: e.target.value }))}
          >
            <option value="">All keys</option>
            {keys?.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Provider" className="min-w-40">
          <Select
            value={draft.provider_id}
            onChange={(e) => setDraft((d) => ({ ...d, provider_id: e.target.value }))}
          >
            <option value="">All providers</option>
            {providers?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model (exact)" className="min-w-48">
          <Input
            value={draft.model}
            placeholder="e.g. fast"
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
          />
        </Field>
        <Button type="submit" variant="primary">
          Apply
        </Button>
        {hasFilter && <Button onClick={reset}>Clear</Button>}
      </form>

      <QueryBoundary
        query={events}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState title={hasFilter ? "No events match these filters" : "No usage recorded yet"}>
            {!hasFilter && "Requests sent through /v1 appear here."}
          </EmptyState>
        }
      >
        {(list) => (
          <Table wide>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Key</Th>
                <Th>Provider</Th>
                <Th>Model</Th>
                <Th className="text-right">Tokens</Th>
                <Th className="text-right">Cost</Th>
                <Th>Status</Th>
                <Th className="text-right">Latency</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <EventRow key={e.id} event={e} keyName={keyName(e.key_id)} />
              ))}
            </tbody>
          </Table>
        )}
      </QueryBoundary>

      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
        <Button
          small
          disabled={cursors.length === 1}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          ← Newer
        </Button>
        <span className="text-xs text-muted">Page {cursors.length}</span>
        <Button
          small
          disabled={rows.length < PAGE_SIZE}
          onClick={() => setCursors((c) => [...c, rows[rows.length - 1]!.id])}
        >
          Older →
        </Button>
      </div>
    </Card>
  );
}
