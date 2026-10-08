import { XIcon } from "lucide-react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Limit, VirtualKey } from "@/api/types";
import { ProgressBar } from "@/components/progress";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime, formatDuration, formatMetric } from "@/lib/format";
import { formatList } from "@/lib/input";
import { METRIC_LABELS, usedFraction } from "@/lib/limits";

function resetText(limit: Limit, now: number): string {
  if (limit.window === "total") return "lifetime total, never resets";
  if (limit.resets_at === null) return "rolling window";
  return `resets in ${formatDuration(limit.resets_at - now)} (${formatDateTime(limit.resets_at)})`;
}

function LimitRow({ limit, now }: { limit: Limit; now: number }) {
  const remove = useAction(() => api.deleteLimit(limit.id), {
    invalidate: [qk.keys],
    success: "Limit removed.",
  });
  const fraction = usedFraction(limit.used, limit.max);
  const title = `${METRIC_LABELS[limit.metric]} / ${limit.window} / ${limit.mode}`;

  return (
    <li className="grid gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{title}</span>
        <span className="flex items-center gap-2 tabular-nums">
          {formatMetric(limit.metric, limit.used)} / {formatMetric(limit.metric, limit.max)}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove limit ${title}`}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? <Spinner /> : <XIcon />}
          </Button>
        </span>
      </div>
      <ProgressBar fraction={fraction} label={`${title} used`} />
      <p className="text-xs text-muted-foreground">
        {Math.round(fraction * 100)}% used · {resetText(limit, now)}
      </p>
    </li>
  );
}

export function KeyCard({
  apiKey,
  onAddLimit,
  onDelete,
}: {
  apiKey: VirtualKey;
  onAddLimit: () => void;
  onDelete: () => void;
}) {
  const toggle = useAction(() => api.updateKey(apiKey.id, { enabled: !apiKey.enabled }), {
    invalidate: [qk.keys],
  });
  const now = Date.now();
  const expired = apiKey.expires_at !== null && apiKey.expires_at <= now;

  return (
    <article className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 font-semibold">
            {apiKey.name}
            {expired ? (
              <StatusBadge tone="danger">expired</StatusBadge>
            ) : (
              <StatusBadge tone={apiKey.enabled ? "ok" : "neutral"}>
                {apiKey.enabled ? "enabled" : "disabled"}
              </StatusBadge>
            )}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            <code className="font-mono">{apiKey.prefix}…</code> · created{" "}
            {formatDateTime(apiKey.created_at)}
            {apiKey.expires_at !== null && <> · expires {formatDateTime(apiKey.expires_at)}</>}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Models:{" "}
            <span className="font-mono">
              {apiKey.allowed_models ? formatList(apiKey.allowed_models) : "any"}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onAddLimit}>
            Add limit
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate()}
          >
            {toggle.isPending && <Spinner data-icon="inline-start" />}
            {apiKey.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="destructive" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </header>
      <div className="px-4 py-3">
        {apiKey.limits.length === 0 ? (
          <p className="text-muted-foreground">No limits: this key is unrestricted.</p>
        ) : (
          <ul className="grid gap-4">
            {apiKey.limits.map((limit) => (
              <LimitRow key={limit.id} limit={limit} now={now} />
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
