import type { ReactNode } from "react";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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
        <h1 className="font-heading text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A titled card section. `flush` drops the content padding for tables that run edge to edge. */
export function Panel({
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
  flush?: boolean;
}) {
  return (
    <Card className={cn("min-w-0", className)}>
      {(title || actions) && (
        <CardHeader className="border-b">
          <CardTitle>{title}</CardTitle>
          {actions && <CardAction className="flex items-center gap-2">{actions}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={cn(flush && "px-0")}>{children}</CardContent>
    </Card>
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
    <Card size="sm">
      <CardContent>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
