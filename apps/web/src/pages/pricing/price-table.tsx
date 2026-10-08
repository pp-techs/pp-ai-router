import type { Price } from "@/api/types";
import { RowActions, type RowEntry } from "@/components/row-actions";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatPer1m, formatTier } from "@/lib/format";

/** Prices per 1M tokens; `actions` adds a trailing dropdown of actions per row. */
export function PriceTable({
  prices,
  actions,
}: {
  prices: Price[];
  actions?: (price: Price) => (RowEntry | false)[][];
}) {
  return (
    <Table className="min-w-176">
      <TableHeader>
        <TableRow>
          <TableHead>Model</TableHead>
          <TableHead>Source</TableHead>
          <TableHead className="text-right">Input / 1M</TableHead>
          <TableHead className="text-right">Output / 1M</TableHead>
          <TableHead className="text-right">Cache read / 1M</TableHead>
          <TableHead className="text-right">Cache write / 1M</TableHead>
          <TableHead>Long-context tiers</TableHead>
          {actions && (
            <TableHead className="w-10">
              <span className="sr-only">Actions</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {prices.map((p) => (
          <TableRow key={`${p.source}:${p.model}`}>
            <TableCell className="font-mono text-xs break-all whitespace-normal">
              {p.model}
            </TableCell>
            <TableCell>
              <StatusBadge tone={p.source === "override" ? "accent" : "neutral"}>
                {p.source}
              </StatusBadge>
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatPer1m(p.input_per_1m)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatPer1m(p.output_per_1m)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatPer1m(p.cache_read_per_1m)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatPer1m(p.cache_write_per_1m)}
            </TableCell>
            <TableCell className="text-xs">
              {p.tiers.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <ul className="grid gap-0.5">
                  {p.tiers.map((t) => (
                    <li key={t.aboveTokens}>{formatTier(t)}</li>
                  ))}
                </ul>
              )}
            </TableCell>
            {actions && (
              <TableCell>
                <RowActions label={`Actions for ${p.model}`} groups={actions(p)} />
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
