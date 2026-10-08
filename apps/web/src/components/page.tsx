import type { ReactNode } from "react";
import { cx } from "../lib/cx.ts";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
  flush = false,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No inner padding, for tables that run edge to edge. */
  flush?: boolean;
}) {
  return (
    <section className={cx("min-w-0 rounded-xl border border-line bg-surface", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
