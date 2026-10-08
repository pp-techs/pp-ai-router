import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

// The theme has no success or warning colors, so those two tones borrow Tailwind's emerald and amber.
const TONES: Record<
  Tone,
  { variant: "default" | "secondary" | "destructive"; className?: string }
> = {
  neutral: { variant: "secondary" },
  accent: { variant: "default" },
  danger: { variant: "destructive" },
  ok: {
    variant: "secondary",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
  warn: {
    variant: "secondary",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
};

export function StatusBadge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  const { variant, className } = TONES[tone];
  return (
    <Badge variant={variant} className={cn(className)}>
      {children}
    </Badge>
  );
}
