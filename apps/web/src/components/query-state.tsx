import type { UseQueryResult } from "@tanstack/react-query";
import { InboxIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 px-4 py-8 text-muted-foreground">
      <Spinner />
      {label}
    </p>
  );
}

export function EmptyState({
  title,
  icon: Icon = InboxIcon,
  action,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  /** A call to action, usually a Button. */
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <Empty role="alert">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon className="text-destructive" />
        </EmptyMedia>
        <EmptyTitle className="text-destructive">Something went wrong</EmptyTitle>
        <EmptyDescription>{error.message}</EmptyDescription>
      </EmptyHeader>
      {onRetry && (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

/** Renders loading / error / empty states for a query, and `children(data)` once there is data. */
export function QueryBoundary<T>({
  query,
  isEmpty,
  empty,
  children,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (isEmpty?.(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
