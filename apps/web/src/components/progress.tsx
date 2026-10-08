import { cx } from "../lib/cx.ts";

/** Horizontal usage meter: turns amber past 80% and red when the limit is reached. */
export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const percent = Math.round(fraction * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-2 w-full overflow-hidden rounded-full bg-subtle"
    >
      <div
        className={cx(
          "h-full rounded-full transition-[width]",
          fraction >= 1 ? "bg-danger" : fraction >= 0.8 ? "bg-warn" : "bg-accent",
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
