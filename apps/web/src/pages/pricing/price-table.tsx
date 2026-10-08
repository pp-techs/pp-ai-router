import type { ReactNode } from "react";
import type { Price } from "../../api/types.ts";
import { Badge } from "../../components/badge.tsx";
import { Table, Td, Th, Tr } from "../../components/table.tsx";
import { formatPer1m, formatTier } from "../../lib/format.ts";

/** Prices per 1M tokens; `actions` renders an extra cell per row. */
export function PriceTable({
  prices,
  actions,
}: {
  prices: Price[];
  actions?: (price: Price) => ReactNode;
}) {
  return (
    <Table wide>
      <thead>
        <tr>
          <Th>Model</Th>
          <Th>Source</Th>
          <Th className="text-right">Input / 1M</Th>
          <Th className="text-right">Output / 1M</Th>
          <Th className="text-right">Cache read / 1M</Th>
          <Th className="text-right">Cache write / 1M</Th>
          <Th>Long-context tiers</Th>
          {actions && <Th className="text-right">Actions</Th>}
        </tr>
      </thead>
      <tbody>
        {prices.map((p) => (
          <Tr key={`${p.source}:${p.model}`}>
            <Td className="font-mono text-xs break-all">{p.model}</Td>
            <Td>
              <Badge tone={p.source === "override" ? "accent" : "neutral"}>{p.source}</Badge>
            </Td>
            <Td className="text-right tabular-nums">{formatPer1m(p.input_per_1m)}</Td>
            <Td className="text-right tabular-nums">{formatPer1m(p.output_per_1m)}</Td>
            <Td className="text-right tabular-nums">{formatPer1m(p.cache_read_per_1m)}</Td>
            <Td className="text-right tabular-nums">{formatPer1m(p.cache_write_per_1m)}</Td>
            <Td className="text-xs">
              {p.tiers.length === 0 ? (
                <span className="text-muted">—</span>
              ) : (
                <ul className="grid gap-0.5">
                  {p.tiers.map((t) => (
                    <li key={t.aboveTokens}>{formatTier(t)}</li>
                  ))}
                </ul>
              )}
            </Td>
            {actions && <Td className="text-right">{actions(p)}</Td>}
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
