import { Link } from "react-router";
import { EmptyState } from "@/components/query-state";

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found">
      <Link to="/" className="text-primary underline">
        Back to the overview
      </Link>
    </EmptyState>
  );
}
