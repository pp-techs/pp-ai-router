import { useQuery } from "@tanstack/react-query";
import { ClipboardListIcon, EyeIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import type { AuditCategory, AuditLog, AuditLogFilter, AuditStatus } from "@/api/types";
import { FormField } from "@/components/form-field";
import { OptionSelect } from "@/components/option-select";
import { PageHeader, Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatLatency } from "@/lib/format";

const PAGE_SIZE = 50;

const STATUS_TONE: Record<AuditStatus, Tone> = {
  success: "ok",
  failure: "danger",
};

interface Draft {
  category: string;
  action: string;
  status: string;
  actor: string;
  target_id: string;
}

function toFilter(draft: Draft): AuditLogFilter {
  return {
    ...(draft.category && { category: draft.category as AuditCategory }),
    ...(draft.action.trim() && { action: draft.action.trim() }),
    ...(draft.status && { status: draft.status as AuditStatus }),
    ...(draft.actor.trim() && { actor: draft.actor.trim() }),
    ...(draft.target_id.trim() && { target_id: draft.target_id.trim() }),
  };
}

function AuditRow({
  log,
  onViewDetails,
}: {
  log: AuditLog;
  onViewDetails: (log: AuditLog) => void;
}) {
  return (
    <TableRow>
      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(log.ts)}</TableCell>
      <TableCell>
        <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 font-mono text-xs font-medium">
          {log.category}
        </span>
      </TableCell>
      <TableCell className="font-mono text-xs font-semibold">{log.action}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{log.actor}</TableCell>
      <TableCell className="min-w-32 font-mono text-xs">
        {log.target_type && <span className="text-muted-foreground">{log.target_type}: </span>}
        {log.target_id ?? "—"}
      </TableCell>
      <TableCell>
        <StatusBadge dot tone={STATUS_TONE[log.status]}>
          {log.status}
        </StatusBadge>
        {log.status_code && (
          <span className="ml-1.5 font-mono text-xs text-muted-foreground">
            ({log.status_code})
          </span>
        )}
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{log.ip ?? "—"}</TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {log.latency_ms !== null ? formatLatency(log.latency_ms) : "—"}
      </TableCell>
      <TableCell className="text-right">
        {log.details ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onViewDetails(log)}
            aria-label="View details"
          >
            <EyeIcon className="h-4 w-4" />
          </Button>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

export function AuditLogsPage() {
  const [draft, setDraft] = useState<Draft>({
    category: "",
    action: "",
    status: "",
    actor: "",
    target_id: "",
  });
  const [filter, setFilter] = useState<AuditLogFilter>({});
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const before = cursors[cursors.length - 1];

  const logsQuery = useQuery({
    queryKey: qk.auditLogs({ ...filter, before, limit: PAGE_SIZE }),
    queryFn: () => api.auditLogs({ ...filter, before, limit: PAGE_SIZE }),
    refetchInterval: before === undefined ? 10_000 : false,
  });

  function apply(e: FormEvent) {
    e.preventDefault();
    setFilter(toFilter(draft));
    setCursors([undefined]);
  }

  function reset() {
    setDraft({ category: "", action: "", status: "", actor: "", target_id: "" });
    setFilter({});
    setCursors([undefined]);
  }

  const hasFilter = Object.keys(filter).length > 0;
  const rows = logsQuery.data ?? [];

  let parsedDetails: unknown = null;
  if (selectedLog?.details) {
    try {
      parsedDetails = JSON.parse(selectedLog.details);
    } catch {
      parsedDetails = selectedLog.details;
    }
  }

  return (
    <>
      <PageHeader
        title="Audit Logs"
        description="Immutable record of administrative operations and gateway request events."
      />

      <Panel
        title="Events"
        description="Track system operations, security, and usage audit entries."
        flush
      >
        <form
          onSubmit={apply}
          className="flex flex-wrap items-end gap-3 border-b border-border bg-muted/30 p-4"
        >
          <FormField label="Category" className="w-auto min-w-36">
            <OptionSelect
              value={draft.category}
              onValueChange={(v) => setDraft((d) => ({ ...d, category: v }))}
              options={[
                { value: "", label: "All categories" },
                { value: "admin", label: "Admin" },
                { value: "gateway", label: "Gateway" },
              ]}
            />
          </FormField>
          <FormField label="Status" className="w-auto min-w-32">
            <OptionSelect
              value={draft.status}
              onValueChange={(v) => setDraft((d) => ({ ...d, status: v }))}
              options={[
                { value: "", label: "All statuses" },
                { value: "success", label: "Success" },
                { value: "failure", label: "Failure" },
              ]}
            />
          </FormField>
          <FormField label="Action" className="w-auto min-w-40">
            <Input
              value={draft.action}
              placeholder="e.g. key.create"
              onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value }))}
            />
          </FormField>
          <FormField label="Actor" className="w-auto min-w-36">
            <Input
              value={draft.actor}
              placeholder="e.g. admin or key id"
              onChange={(e) => setDraft((d) => ({ ...d, actor: e.target.value }))}
            />
          </FormField>
          <FormField label="Target ID" className="w-auto min-w-36">
            <Input
              value={draft.target_id}
              placeholder="e.g. model or provider"
              onChange={(e) => setDraft((d) => ({ ...d, target_id: e.target.value }))}
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
          query={logsQuery}
          isEmpty={(list) => list.length === 0}
          empty={
            <EmptyState
              icon={ClipboardListIcon}
              title={
                hasFilter ? "No audit events match these filters" : "No audit events recorded yet"
              }
            >
              {!hasFilter && "Administrative mutations and gateway traffic appear here."}
            </EmptyState>
          }
        >
          {(list) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((log) => (
                  <AuditRow key={log.id} log={log} onViewDetails={setSelectedLog} />
                ))}
              </TableBody>
            </Table>
          )}
        </QueryBoundary>

        <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <span>Showing {rows.length} event(s)</span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursors.length <= 1}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length < PAGE_SIZE}
              onClick={() => {
                const last = rows[rows.length - 1];
                if (last) setCursors((c) => [...c, last.id]);
              }}
            >
              Older
            </Button>
          </div>
        </div>
      </Panel>

      <Dialog open={selectedLog !== null} onOpenChange={(open) => !open && setSelectedLog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{selectedLog?.action}</DialogTitle>
            <DialogDescription>
              Audit event #{selectedLog?.id} recorded at{" "}
              {selectedLog ? formatDateTime(selectedLog.ts) : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="font-medium text-muted-foreground">Category:</span>{" "}
                <span className="font-mono">{selectedLog?.category}</span>
              </div>
              <div>
                <span className="font-medium text-muted-foreground">Actor:</span>{" "}
                <span className="font-mono">{selectedLog?.actor}</span>
              </div>
              <div>
                <span className="font-medium text-muted-foreground">Target:</span>{" "}
                <span className="font-mono">
                  {selectedLog?.target_type ? `${selectedLog.target_type}: ` : ""}
                  {selectedLog?.target_id ?? "—"}
                </span>
              </div>
              <div>
                <span className="font-medium text-muted-foreground">Status:</span>{" "}
                <span>
                  {selectedLog?.status} ({selectedLog?.status_code ?? "—"})
                </span>
              </div>
              <div>
                <span className="font-medium text-muted-foreground">IP:</span>{" "}
                <span className="font-mono">{selectedLog?.ip ?? "—"}</span>
              </div>
              <div>
                <span className="font-medium text-muted-foreground">Latency:</span>{" "}
                <span>
                  {selectedLog?.latency_ms !== null && selectedLog?.latency_ms !== undefined
                    ? formatLatency(selectedLog.latency_ms)
                    : "—"}
                </span>
              </div>
            </div>
            {parsedDetails !== null && parsedDetails !== undefined && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Payload Details:</span>
                <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs">
                  {typeof parsedDetails === "string"
                    ? parsedDetails
                    : JSON.stringify(parsedDetails, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
