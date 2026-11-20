import {
  ActivityIcon,
  CircleDollarSignIcon,
  DatabaseZapIcon,
  GaugeIcon,
  TimerIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
  WholeWordIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import { Stat } from "@/components/page";
import { formatInt, formatLatency, formatUsd } from "@/lib/format";
import {
  cacheHitRate,
  changeFrom,
  costPer1mTokens,
  costPerRequest,
  errorRate,
  formatChange,
  formatPercent,
  projectMonthly,
  totalsOf,
} from "@/lib/insights";

const DAY_MS = 86_400_000;

/** `+12% vs previous 24h`, or the fallback when the previous period had no traffic. */
function vsPrevious(current: number, previous: number, fallback?: string) {
  const change = formatChange(changeFrom(current, previous));
  return change ? `${change} vs previous 24h` : fallback;
}

/** Eight headline numbers for the last 24 hours, the cost and traffic ones compared with the 24 hours before. */
export function OverviewStats() {
  const current = useQuery({
    queryKey: qk.usageSummary("model", "24h"),
    queryFn: () => api.usageSummary("model", Date.now() - DAY_MS),
    refetchInterval: 15_000,
  });
  const previous = useQuery({
    queryKey: qk.usageSummary("model", "24h-prev"),
    queryFn: () => {
      const now = Date.now();
      return api.usageSummary("model", now - 2 * DAY_MS, {}, now - DAY_MS);
    },
    refetchInterval: 60_000,
  });

  const t = current.data && totalsOf(current.data.data);
  const p = previous.data && totalsOf(previous.data.data);
  const dash = "—";

  return (
    <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Stat
        label="Requests"
        icon={ActivityIcon}
        value={t ? formatInt(t.requests) : dash}
        hint={t && p ? vsPrevious(t.requests, p.requests) : undefined}
      />
      <Stat
        label="Cost"
        icon={CircleDollarSignIcon}
        value={t ? formatUsd(t.cost_usd) : dash}
        hint={
          t && t.unpriced_requests > 0
            ? `${formatInt(t.unpriced_requests)} requests had no known price`
            : t && p
              ? vsPrevious(t.cost_usd, p.cost_usd)
              : undefined
        }
      />
      <Stat
        label="Projected / 30 days"
        icon={TrendingUpIcon}
        value={t ? formatUsd(projectMonthly(t.cost_usd, DAY_MS)) : dash}
        hint="Today's rate held for a month"
      />
      <Stat
        label="Tokens"
        icon={WholeWordIcon}
        value={t ? formatInt(t.input_tokens + t.output_tokens) : dash}
        hint={
          t
            ? `${formatInt(t.input_tokens)} in · ${formatInt(t.output_tokens)} out${
                t.reasoning_tokens > 0 ? ` · ${formatInt(t.reasoning_tokens)} reasoning` : ""
              }`
            : undefined
        }
      />
      <Stat
        label="Error rate"
        icon={TriangleAlertIcon}
        value={t ? formatPercent(errorRate(t)) : dash}
        hint={
          t
            ? `${formatInt(t.failed_requests)} of ${formatInt(t.requests)} requests failed`
            : undefined
        }
      />
      <Stat
        label="Avg latency"
        icon={TimerIcon}
        value={t && t.requests > 0 ? formatLatency(t.avg_latency_ms) : dash}
        hint="Time to complete a request"
      />
      <Stat
        label="Cache hit rate"
        icon={DatabaseZapIcon}
        value={t ? formatPercent(cacheHitRate(t)) : dash}
        hint={t ? `${formatInt(t.cached_tokens)} input tokens read from cache` : undefined}
      />
      <Stat
        label="Cost efficiency"
        icon={GaugeIcon}
        value={t ? formatUsdOrDash(costPer1mTokens(t)) : dash}
        hint={t ? `per 1M tokens · ${formatUsdOrDash(costPerRequest(t))} per request` : undefined}
      />
    </div>
  );
}

const formatUsdOrDash = (value: number | null) => (value === null ? "—" : formatUsd(value));
