import type { ReactNode } from "react";
import { cx } from "../lib/cx.ts";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

const TONES: Record<Tone, string> = {
  neutral: "bg-subtle text-muted",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  accent: "bg-accent-soft text-accent",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
