import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/** Horizontal usage meter: turns amber past 80% and red when the limit is reached. */
export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const percent = Math.round(fraction * 100);
  return (
    <Progress
      value={Math.min(percent, 100)}
      aria-label={label}
      className={cn(
        "[&_[data-slot=progress-track]]:h-2",
        fraction >= 1
          ? "[&_[data-slot=progress-indicator]]:bg-destructive"
          : fraction >= 0.8 && "[&_[data-slot=progress-indicator]]:bg-amber-500",
      )}
    />
  );
}
