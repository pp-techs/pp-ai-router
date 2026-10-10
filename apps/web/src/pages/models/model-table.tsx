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
/** Modalities, release date and the supported request parameters: whatever the catalog knows about a model. */
function ModelFacts({ model: m }: { model: ProviderModel }) {
  const modalities = [
    ...(m.input_modalities ?? []).map((x) => `${x} in`),
    ...(m.output_modalities ?? []).map((x) => `${x} out`),
  ];
  const params = m.supported_parameters ?? [];
  if (modalities.length === 0 && params.length === 0 && m.created === null) return null;
  return (
    <div className="mt-1 space-y-1 font-sans no-underline">
      {modalities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {modalities.map((x) => (
            <StatusBadge key={x} tone="neutral">
              {x}
            </StatusBadge>
          ))}
        </div>
      )}
      {m.created !== null && (
        <p className="text-muted-foreground">
          Released {new Date(m.created * 1000).toISOString().slice(0, 10)}
        </p>
      )}
      {params.length > 0 && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">{params.length} parameters</summary>
          <p className="font-mono">{params.join(", ")}</p>
        </details>
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
                  "font-mono text-xs break-all whitespace-normal",
                  !m.enabled && "text-muted-foreground line-through decoration-1",
                )}
              >
                {m.id}
                {m.name && <p className="font-sans text-muted-foreground no-underline">{m.name}</p>}
                {m.description && (
                  <p
                    className="line-clamp-2 font-sans text-muted-foreground no-underline"
                    title={m.description}
                  >
                    {m.description}
                  </p>
                )}
                <ModelFacts model={m} />
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
