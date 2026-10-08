import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

// The theme has no success or warning colors, so those two tones borrow Tailwind's emerald and amber.
// Every tone is a soft tint with a hairline border and a leading dot, never a solid fill (accent excepted).
const TONES: Record<Tone, { variant: "default" | "secondary" | "destructive"; className: string }> =
  {
    neutral: { variant: "secondary", className: "border-border" },
    accent: { variant: "default", className: "" },
    danger: { variant: "destructive", className: "border-destructive/20" },
    ok: {
      variant: "secondary",
      className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    },
    warn: {
      variant: "secondary",
      className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    },
  };

const DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground/60",
  accent: "bg-primary-foreground",
  danger: "bg-destructive",
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
};

export function StatusBadge({
  tone = "neutral",
  dot = false,
  children,
}: {
  tone?: Tone;
  /** Leading status dot, for state badges (healthy, enabled); omit for tags (api_key, primary). */
  dot?: boolean;
  children: ReactNode;
}) {
  const { variant, className } = TONES[tone];
  return (
    <Badge variant={variant} className={cn(className)}>
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full", DOT[tone])} />}
      {children}
    </Badge>
  );
}
