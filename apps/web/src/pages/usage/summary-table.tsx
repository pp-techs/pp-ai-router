import { Badge } from "../../components/badge.tsx";
import { Table, Td, Th, Tr } from "../../components/table.tsx";
import type { UsageSummaryRow } from "../../api/types.ts";
import { formatInt, formatUsd } from "../../lib/format.ts";

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
}: {
  rows: UsageSummaryRow[];
  groupLabel: string;
  nameOf?: (group: string) => string;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>{groupLabel}</Th>
          <Th className="text-right">Requests</Th>
          <Th className="text-right">Input tokens</Th>
          <Th className="text-right">Output tokens</Th>
          <Th className="text-right">Cost</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <Tr key={r.group}>
            <Td className="font-mono text-xs">{nameOf(r.group)}</Td>
            <Td className="text-right tabular-nums">{formatInt(r.requests)}</Td>
            <Td className="text-right tabular-nums">{formatInt(r.input_tokens)}</Td>
            <Td className="text-right tabular-nums">{formatInt(r.output_tokens)}</Td>
            <Td className="text-right whitespace-nowrap tabular-nums">
              {formatUsd(r.cost_usd)}
              {r.unpriced_requests > 0 && (
                <span className="ml-2">
                  <Badge tone="warn">{formatInt(r.unpriced_requests)} unpriced</Badge>
                </span>
              )}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
