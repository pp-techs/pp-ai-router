import { useQuery } from "@tanstack/react-query";
import { ChartColumnIcon } from "lucide-react";
import { useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import type { UsageBucket } from "@/api/types";
import { Panel } from "@/components/page";
import { EmptyState, QueryBoundary } from "@/components/query-state";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatDateTime, formatInt, formatUsd } from "@/lib/format";
import { fillBuckets, RANGES, type RangeKey } from "@/lib/timeline";

type MetricKey = "requests" | "tokens" | "cost";

const METRICS: Record<
  MetricKey,
  { label: string; series: (keyof typeof CONFIG)[]; format: (n: number) => string }
> = {
  requests: { label: "Requests", series: ["requests"], format: formatInt },
  tokens: { label: "Tokens", series: ["input_tokens", "output_tokens"], format: formatInt },
  cost: { label: "Cost", series: ["cost_usd"], format: formatUsd },
};

const CONFIG = {
  requests: { label: "Requests", color: "var(--primary)" },
  input_tokens: { label: "Input tokens", color: "var(--primary)" },
  output_tokens: { label: "Output tokens", color: "var(--muted-foreground)" },
  cost_usd: { label: "Cost", color: "var(--primary)" },
} satisfies ChartConfig;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** Requests, tokens or cost over time for the selected range, from the server's bucketed timeline. */
export function UsageChart({ range }: { range: RangeKey }) {
  const [metric, setMetric] = useState<MetricKey>("requests");
  const { ms, bucketMs } = RANGES[range];

  const timeline = useQuery({
    queryKey: qk.usageTimeline(range),
    queryFn: async () => {
      const until = Date.now();
      const since = ms === null ? 0 : until - ms;
      const { data } = await api.usageTimeline(since, bucketMs);
      return fillBuckets(data, ms === null ? null : since, until, bucketMs);
    },
    refetchInterval: 15_000,
    // Keep the old curve on screen while a new range loads.
    placeholderData: (previous) => previous,
  });

  const { format, series } = METRICS[metric];
  const axisFormat = metric === "cost" ? formatUsd : (n: number) => compact.format(n);
  const tickFormat = ms !== null && ms <= 24 * 3_600_000 ? clock : day;

  return (
    <Panel
      title="Activity"
      description={`${METRICS[metric].label} per ${bucketMs >= 86_400_000 ? "day" : bucketMs >= 3_600_000 ? `${bucketMs / 3_600_000}h` : "minute"}.`}
      actions={
        <ToggleGroup
          variant="outline"
          size="sm"
          aria-label="Metric"
          value={[metric]}
          onValueChange={([next]) => next && setMetric(next as MetricKey)}
        >
          {(Object.keys(METRICS) as MetricKey[]).map((key) => (
            <ToggleGroupItem key={key} value={key}>
              {METRICS[key].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    >
      <QueryBoundary
        query={timeline}
        isEmpty={(buckets) => buckets.every((b) => b.requests === 0)}
        empty={<EmptyState icon={ChartColumnIcon} title="No usage in this period" />}
      >
        {(buckets) => (
          <ChartContainer config={CONFIG} className="aspect-auto h-64 w-full">
            <AreaChart data={buckets} margin={{ left: 4, right: 12 }}>
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
                tickFormatter={(n: number) => axisFormat(n)}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const ts = (payload[0]?.payload as UsageBucket | undefined)?.ts;
                      return ts === undefined ? null : formatDateTime(ts);
                    }}
                    formatter={(value, name, item) => (
                      <>
                        <span
                          className="size-2.5 shrink-0 rounded-[2px]"
                          style={{ background: item.color }}
                        />
                        <span className="flex-1 text-muted-foreground">
                          {CONFIG[name as keyof typeof CONFIG]?.label ?? name}
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {format(Number(value))}
                        </span>
                      </>
                    )}
                  />
                }
              />
              {series.map((key) => (
                <Area
                  key={key}
                  dataKey={key}
                  type="monotone"
                  stackId={metric}
                  stroke={`var(--color-${key})`}
                  fill={`var(--color-${key})`}
                  fillOpacity={0.2}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ChartContainer>
        )}
      </QueryBoundary>
    </Panel>
  );
}
