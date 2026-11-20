import { useQuery } from "@tanstack/react-query";
import { ChartColumnIcon } from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import type { UsageGroup, UsageQuery, VirtualKey } from "@/api/types";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type BreakdownMetric, metricOf, OTHER, stackBuckets, topGroups } from "@/lib/breakdown";
import { formatDateTime, formatInt, formatUsd } from "@/lib/format";
import { RANGES, type RangeKey } from "@/lib/timeline";

const GROUPS: Record<UsageGroup, string> = { key: "API key", provider: "Provider", model: "Model" };
const METRICS: Record<BreakdownMetric, { label: string; format: (n: number) => string }> = {
  cost: { label: "Cost", format: formatUsd },
  requests: { label: "Requests", format: formatInt },
  tokens: { label: "Tokens", format: formatInt },
};

// Series need real hues to tell apart; the theme's chart tokens are a single-hue ramp.
const PALETTE = [
  "oklch(0.62 0.17 255)",
  "oklch(0.7 0.16 150)",
  "oklch(0.75 0.15 75)",
  "oklch(0.63 0.2 20)",
  "oklch(0.62 0.18 305)",
  "oklch(0.7 0.12 200)",
];
const OTHER_COLOR = "var(--muted-foreground)";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/**
 * Who is spending: a stacked timeline and a ranked share list, split by API key, provider or model.
 * The six biggest groups get a colour each; the rest are folded into "Other".
 */
export function BreakdownChart({
  keys,
  range,
  query = {},
  defaultGroup = "key",
}: {
  keys?: VirtualKey[];
  range: RangeKey;
  query?: UsageQuery;
  defaultGroup?: UsageGroup;
}) {
  const [group, setGroup] = useState<UsageGroup>(defaultGroup);
  const [metric, setMetric] = useState<BreakdownMetric>("cost");
  const { ms, bucketMs } = RANGES[range];
  const { format } = METRICS[metric];

  const nameOf = (id: string) => {
    if (id === OTHER) return "Other";
    if (group === "key") return keys?.find((k) => k.id === id)?.name ?? `${id.slice(0, 8)}…`;
    return id;
  };

  const data = useQuery({
    queryKey: qk.usageTimelineBy(group, range, query),
    queryFn: async () => {
      const until = Date.now();
      const since = ms === null ? 0 : until - ms;
      const [summary, timeline] = await Promise.all([
        api.usageSummary(group, since, query),
        api.usageTimelineBy(group, since, bucketMs, query),
      ]);
      return {
        summary: summary.data,
        rows: timeline.data,
        since: ms === null ? null : since,
        until,
      };
    },
    refetchInterval: 15_000,
    placeholderData: (previous) => previous,
  });

  return (
    <Panel
      title="Breakdown"
      description={`${METRICS[metric].label} by ${GROUPS[group].toLowerCase()} over time, and each one's share of the period.`}
      actions={
        <>
          <ToggleGroup
            variant="outline"
            size="sm"
            aria-label="Group by"
            value={[group]}
            onValueChange={([next]) => next && setGroup(next as UsageGroup)}
          >
            {(Object.keys(GROUPS) as UsageGroup[]).map((g) => (
              <ToggleGroupItem key={g} value={g}>
                {GROUPS[g]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <ToggleGroup
            variant="outline"
            size="sm"
            aria-label="Metric"
            value={[metric]}
            onValueChange={([next]) => next && setMetric(next as BreakdownMetric)}
          >
            {(Object.keys(METRICS) as BreakdownMetric[]).map((m) => (
              <ToggleGroupItem key={m} value={m}>
                {METRICS[m].label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </>
      }
    >
      <QueryBoundary
        query={data}
        isEmpty={(d) => d.summary.length === 0}
        empty={<EmptyState icon={ChartColumnIcon} title="No usage in this period" />}
      >
        {(d) => {
          const top = topGroups(d.summary, metric);
          const buckets = stackBuckets(d.rows, top, metric, d.since, d.until, bucketMs);
          const config: ChartConfig = Object.fromEntries(
            top.map((g, i) => [g, { label: nameOf(g), color: PALETTE[i % PALETTE.length] }]),
          );
          config[OTHER] = { label: "Other", color: OTHER_COLOR };
          const total = d.summary.reduce((sum, r) => sum + metricOf(r, metric), 0);
          const ranked = [...d.summary].sort((a, b) => metricOf(b, metric) - metricOf(a, metric));
          const max = ranked[0] ? metricOf(ranked[0], metric) : 0;
          const tickFormat = ms !== null && ms <= 24 * 3_600_000 ? clock : day;
          const colorOf = (g: string) => (top.includes(g) ? config[g]!.color : OTHER_COLOR);

          return (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <ChartContainer config={config} className="aspect-auto h-64 w-full">
                <BarChart data={buckets} margin={{ left: 4, right: 12 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="ts"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={32}
                    tickFormatter={(ts: number) => tickFormat.format(ts)}
                  />
                  <YAxis
                    width={56}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(n: number) =>
                      metric === "cost" ? formatUsd(n) : compact.format(n)
                    }
                  />
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) => {
                          const ts = (payload[0]?.payload as { ts?: number } | undefined)?.ts;
                          return ts === undefined ? null : formatDateTime(ts);
                        }}
                        formatter={(value, name, item) =>
                          Number(value) === 0 ? null : (
                            <>
                              <span
                                className="size-2.5 shrink-0 rounded-[2px]"
                                style={{ background: item.color }}
                              />
                              <span className="flex-1 text-muted-foreground">
                                {nameOf(String(name))}
                              </span>
                              <span className="font-mono font-medium tabular-nums">
                                {format(Number(value))}
                              </span>
                            </>
                          )
                        }
                      />
                    }
                  />
                  {[...top, OTHER].map((g) => (
                    <Bar
                      key={g}
                      dataKey={g}
                      stackId="a"
                      fill={`var(--color-${g})`}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              </ChartContainer>

              <ol
                className="grid content-start gap-3"
                aria-label={`${METRICS[metric].label} share`}
              >
                {ranked.slice(0, 8).map((r) => {
                  const value = metricOf(r, metric);
                  return (
                    <li key={r.group} className="grid gap-1">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-[2px]"
                            style={{ background: colorOf(r.group) }}
                          />
                          <span className="truncate">{nameOf(r.group)}</span>
                        </span>
                        <span className="shrink-0 font-mono text-xs tabular-nums">
                          {format(value)}
                          <span className="ml-2 text-muted-foreground">
                            {total > 0 ? `${((value / total) * 100).toFixed(0)}%` : "—"}
                          </span>
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${max > 0 ? (value / max) * 100 : 0}%`,
                            background: colorOf(r.group),
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
                {ranked.length > 8 && (
                  <li className="text-xs text-muted-foreground">
                    +{ranked.length - 8} more in the summary below
                  </li>
                )}
              </ol>
            </div>
          );
        }}
      </QueryBoundary>
    </Panel>
  );
}
