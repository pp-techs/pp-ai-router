import { NetworkIcon } from "lucide-react";
import { RowActions } from "@/components/row-actions";
import { StatusBadge } from "@/components/status-badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatPer1m } from "@/lib/format";
import { formatContextWindow, type ModelRow } from "@/lib/models";
import type { ProviderModel } from "@/api/types";
import { cn } from "@/lib/utils";
/** "text, image → text": what a model takes in and gives out, when the catalog knows. */
function modalitySummary(m: ProviderModel): string | null {
  const input = m.input_modalities ?? [];
  const output = m.output_modalities ?? [];
  if (input.length === 0 && output.length === 0) return null;
  return `${input.join(", ") || "?"} → ${output.join(", ") || "?"}`;
}

/** Modalities and the supported request parameters as tags, on one line. */
function ModelTags({ model: m }: { model: ProviderModel }) {
  const modalities = modalitySummary(m);
  const params = m.supported_parameters ?? [];
  if (modalities === null && params.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-nowrap gap-1 whitespace-nowrap">
      {modalities !== null && <StatusBadge tone="neutral">{modalities}</StatusBadge>}
      {params.length > 0 && (
        <span title={params.join(", ")}>
          <StatusBadge tone="neutral">{params.length} params</StatusBadge>
        </span>
      )}
    </div>
  );
}
export function ModelTable({
  rows,
  showProvider,
  pending,
  onToggle,
  onCreateAlias,
}: {
  rows: ModelRow[];
  /** A Provider column, for lists that mix providers. */
  showProvider: boolean;
  /** The `provider/model` whose switch is being saved. */
  pending: string | null;
  onToggle: (row: ModelRow, enabled: boolean) => void;
  /** Absent while the provider list the alias form needs is still loading. */
  onCreateAlias: ((row: ModelRow) => void) | undefined;
}) {
  return (
    <Table className="min-w-176">
      <TableHeader>
        <TableRow>
          {showProvider && <TableHead>Provider</TableHead>}
          <TableHead>Model</TableHead>
          <TableHead className="text-right">Context</TableHead>
          <TableHead className="text-right">Max output</TableHead>
          <TableHead className="text-right">Input / 1M</TableHead>
          <TableHead className="text-right">Output / 1M</TableHead>
          <TableHead>Tags</TableHead>
          <TableHead>Price source</TableHead>
          <TableHead>Enabled</TableHead>
          <TableHead className="w-10">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const { provider, model: m } = row;
          const key = `${provider}/${m.id}`;
          return (
            <TableRow key={key}>
              {showProvider && <TableCell className="font-mono text-xs">{provider}</TableCell>}
              <TableCell
                className={cn(
                  "max-w-80 truncate font-mono text-xs",
                  !m.enabled && "text-muted-foreground line-through decoration-1",
                )}
                title={m.name ? `${m.id} — ${m.name}` : m.id}
              >
                {m.id}
                {m.name && m.name !== m.id && (
                  <span className="ml-2 font-sans text-muted-foreground no-underline">
                    {m.name}
                  </span>
                )}
              </TableCell>
              <TableCell
                className="text-right tabular-nums"
                title={m.sources?.context_window ? `from ${m.sources.context_window}` : undefined}
              >
                {formatContextWindow(m.context_window)}
              </TableCell>
              <TableCell
                className="text-right tabular-nums"
                title={
                  m.sources?.max_output_tokens ? `from ${m.sources.max_output_tokens}` : undefined
                }
              >
                {formatContextWindow(m.max_output_tokens)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPer1m(m.price?.input_per_1m ?? null)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPer1m(m.price?.output_per_1m ?? null)}
              </TableCell>
              <TableCell>
                <ModelTags model={m} />
              </TableCell>
              <TableCell>
                {m.price ? (
                  <StatusBadge tone={m.price.source === "override" ? "accent" : "neutral"}>
                    {m.price.source}
                  </StatusBadge>
                ) : (
                  <span
                    className="text-muted-foreground"
                    title="No price known: requests are billed at $0"
                  >
                    —
                  </span>
                )}
              </TableCell>
              <TableCell>
                <Switch
                  size="sm"
                  checked={m.enabled}
                  disabled={pending === key}
                  aria-label={`${m.enabled ? "Disable" : "Enable"} ${key}`}
                  onCheckedChange={(enabled) => onToggle(row, enabled)}
                />
              </TableCell>
              <TableCell>
                <RowActions
                  label={`Actions for ${key}`}
                  groups={[
                    [
                      {
                        label: "Create alias",
                        icon: NetworkIcon,
                        disabled: !onCreateAlias,
                        onSelect: () => onCreateAlias?.(row),
                      },
                    ],
                  ]}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
