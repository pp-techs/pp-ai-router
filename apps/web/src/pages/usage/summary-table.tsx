import type { UsageSummaryRow } from "@/api/types";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatInt, formatLatency, formatUsd } from "@/lib/format";
import { cacheHitRate, errorRate, formatPercent, totalsOf } from "@/lib/insights";

export const summaryTotals = totalsOf;

export function SummaryTable({
  rows,
  groupLabel,
  nameOf = (group) => group,
  showTotals = false,
}: {
  rows: UsageSummaryRow[];
  groupLabel: string;
  nameOf?: (group: string) => string;
  /** Bold totals row; only for tables that list every group of the period. */
  showTotals?: boolean;
}) {
  const totals = showTotals ? summaryTotals(rows) : null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{groupLabel}</TableHead>
          <TableHead className="text-right">Requests</TableHead>
          <TableHead className="text-right">Input tokens</TableHead>
          <TableHead className="text-right">Output tokens</TableHead>
          <TableHead className="text-right">Cache hit</TableHead>
          <TableHead className="text-right">Errors</TableHead>
          <TableHead className="text-right">Avg latency</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.group}>
            <TableCell className="font-mono text-xs">{nameOf(r.group)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatInt(r.requests)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatInt(r.input_tokens)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatInt(r.output_tokens)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatPercent(cacheHitRate(r), 0)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {r.failed_requests > 0 ? (
                <span className="text-destructive">{formatPercent(errorRate(r))}</span>
              ) : (
                formatPercent(0, 0)
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatLatency(r.avg_latency_ms)}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap tabular-nums">
              {formatUsd(r.cost_usd)}
              {r.unpriced_requests > 0 && (
                <span className="ml-2">
                  <StatusBadge tone="warn">{formatInt(r.unpriced_requests)} unpriced</StatusBadge>
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      {totals && (
        <TableFooter>
          <TableRow>
            <TableCell className="font-semibold">
              Total ({formatInt(rows.length)} {groupLabel.toLowerCase()}
              {rows.length === 1 ? "" : "s"})
            </TableCell>
            <TableCell className="text-right font-semibold tabular-nums">
              {formatInt(totals.requests)}
            </TableCell>
            <TableCell className="text-right font-semibold tabular-nums">
              {formatInt(totals.input_tokens)}
            </TableCell>
            <TableCell className="text-right font-semibold tabular-nums">
              {formatInt(totals.output_tokens)}
            </TableCell>
            <TableCell className="text-right font-semibold tabular-nums">
              {formatPercent(cacheHitRate(totals), 0)}
            </TableCell>
            <TableCell className="text-right font-semibold tabular-nums">
              {formatPercent(errorRate(totals))}
            </TableCell>
            <TableCell className="text-right font-semibold tabular-nums">
              {totals.requests > 0 ? formatLatency(totals.avg_latency_ms) : "—"}
            </TableCell>
            <TableCell className="text-right font-semibold whitespace-nowrap tabular-nums">
              {formatUsd(totals.cost_usd)}
            </TableCell>
          </TableRow>
        </TableFooter>
      )}
    </Table>
  );
}
