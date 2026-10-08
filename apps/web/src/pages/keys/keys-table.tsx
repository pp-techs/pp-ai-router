import { MinusCircleIcon, PlusIcon, PowerIcon, PowerOffIcon, Trash2Icon } from "lucide-react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Limit, VirtualKey } from "@/api/types";
import { ProgressBar } from "@/components/progress";
import { RowActions } from "@/components/row-actions";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatDuration, formatMetric } from "@/lib/format";
import { formatList } from "@/lib/input";
import { METRIC_LABELS, usedFraction } from "@/lib/limits";

const limitTitle = (limit: Limit) =>
  `${METRIC_LABELS[limit.metric]} / ${limit.window} / ${limit.mode}`;

function resetText(limit: Limit, now: number): string {
  if (limit.window === "total") return "lifetime total, never resets";
  if (limit.resets_at === null) return "rolling window";
  return `resets in ${formatDuration(limit.resets_at - now)} (${formatDateTime(limit.resets_at)})`;
}

function LimitMeter({ limit, now }: { limit: Limit; now: number }) {
  const fraction = usedFraction(limit.used, limit.max);
  const title = limitTitle(limit);
  return (
    <li className="grid gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">{title}</span>
        <span className="text-xs tabular-nums">
          {formatMetric(limit.metric, limit.used)} / {formatMetric(limit.metric, limit.max)}
        </span>
      </div>
      <ProgressBar fraction={fraction} label={`${title} used`} />
      <p className="text-xs text-muted-foreground">
        {Math.round(fraction * 100)}% used · {resetText(limit, now)}
      </p>
    </li>
  );
}

function KeyRow({
  apiKey,
  now,
  onAddLimit,
  onDelete,
}: {
  apiKey: VirtualKey;
  now: number;
  onAddLimit: () => void;
  onDelete: () => void;
}) {
  const toggle = useAction(() => api.updateKey(apiKey.id, { enabled: !apiKey.enabled }), {
    invalidate: [qk.keys],
  });
  const removeLimit = useAction((limit: Limit) => api.deleteLimit(limit.id), {
    invalidate: [qk.keys],
    success: "Limit removed.",
  });

  const expired = apiKey.expires_at !== null && apiKey.expires_at <= now;
  const limitReached = apiKey.limits.some((l) => usedFraction(l.used, l.max) >= 1);

  return (
    <TableRow>
      <TableCell className="align-top whitespace-nowrap">
        <p className="font-medium">{apiKey.name}</p>
        <code className="font-mono text-xs text-muted-foreground">{apiKey.prefix}…</code>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-wrap gap-1.5">
          {expired ? (
            <StatusBadge tone="danger">expired</StatusBadge>
          ) : (
            <StatusBadge tone={apiKey.enabled ? "ok" : "neutral"} dot={apiKey.enabled}>
              {apiKey.enabled ? "enabled" : "disabled"}
            </StatusBadge>
          )}
          {limitReached && <StatusBadge tone="danger">limit reached</StatusBadge>}
        </div>
      </TableCell>
      <TableCell className="min-w-28 align-top font-mono text-xs whitespace-normal">
        {apiKey.allowed_models ? (
          formatList(apiKey.allowed_models)
        ) : (
          <span className="text-muted-foreground">any</span>
        )}
      </TableCell>
      <TableCell className="min-w-64 align-top whitespace-normal">
        {apiKey.limits.length === 0 ? (
          <span className="text-muted-foreground">unrestricted</span>
        ) : (
          <ul className="grid gap-3">
            {apiKey.limits.map((limit) => (
              <LimitMeter key={limit.id} limit={limit} now={now} />
            ))}
          </ul>
        )}
      </TableCell>
      <TableCell className="align-top text-xs whitespace-nowrap">
        {apiKey.expires_at === null ? (
          <span className="text-muted-foreground">never</span>
        ) : (
          formatDateTime(apiKey.expires_at)
        )}
      </TableCell>
      <TableCell className="align-top text-xs whitespace-nowrap">
        {formatDateTime(apiKey.created_at)}
      </TableCell>
      <TableCell className="align-top">
        <RowActions
          label={`Actions for ${apiKey.name}`}
          groups={[
            [
              { label: "Add limit", icon: PlusIcon, onSelect: onAddLimit },
              apiKey.limits.length > 0 && {
                label: "Remove limit",
                icon: MinusCircleIcon,
                disabled: removeLimit.isPending,
                items: apiKey.limits.map((limit) => ({
                  label: limitTitle(limit),
                  onSelect: () => removeLimit.mutate(limit),
                })),
              },
              {
                label: apiKey.enabled ? "Disable" : "Enable",
                icon: apiKey.enabled ? PowerOffIcon : PowerIcon,
                disabled: toggle.isPending,
                onSelect: () => toggle.mutate(),
              },
            ],
            [{ label: "Delete", icon: Trash2Icon, destructive: true, onSelect: onDelete }],
          ]}
        />
      </TableCell>
    </TableRow>
  );
}

export function KeysTable({
  keys,
  onAddLimit,
  onDelete,
}: {
  keys: VirtualKey[];
  onAddLimit: (key: VirtualKey) => void;
  onDelete: (key: VirtualKey) => void;
}) {
  const now = Date.now();
  return (
    <Table className="min-w-176">
      <TableHeader>
        <TableRow>
          <TableHead>Key</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Allowed models</TableHead>
          <TableHead>Spend & rate limits</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="w-10">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.map((k) => (
          <KeyRow
            key={k.id}
            apiKey={k}
            now={now}
            onAddLimit={() => onAddLimit(k)}
            onDelete={() => onDelete(k)}
          />
        ))}
      </TableBody>
    </Table>
  );
}
