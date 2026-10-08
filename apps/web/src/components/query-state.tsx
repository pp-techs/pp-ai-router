import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Button } from "./button.tsx";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="flex items-center gap-2 px-4 py-8 text-muted">
      <span
        aria-hidden
        className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
      />
      {label}
    </p>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-muted">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div role="alert" className="px-4 py-8 text-center">
      <p className="font-medium text-danger">Something went wrong</p>
      <p className="mt-1 text-muted">{error.message}</p>
      {onRetry && (
        <Button className="mt-3" small onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
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
