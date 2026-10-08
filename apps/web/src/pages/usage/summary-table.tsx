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
import { formatInt, formatUsd } from "@/lib/format";

export function summaryTotals(rows: UsageSummaryRow[]) {
  return rows.reduce(
    (t, r) => ({
      requests: t.requests + r.requests,
      input_tokens: t.input_tokens + r.input_tokens,
      output_tokens: t.output_tokens + r.output_tokens,
      cost_usd: t.cost_usd + r.cost_usd,
      unpriced_requests: t.unpriced_requests + r.unpriced_requests,
    }),
    { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_requests: 0 },
  );
}

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
            <TableCell className="text-right font-semibold whitespace-nowrap tabular-nums">
              {formatUsd(totals.cost_usd)}
            </TableCell>
          </TableRow>
        </TableFooter>
      )}
    </Table>
  );
}
