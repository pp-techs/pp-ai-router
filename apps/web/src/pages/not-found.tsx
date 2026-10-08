import { Link } from "react-router";
import { EmptyState } from "../components/query-state.tsx";

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found">
      <Link to="/" className="text-accent underline">
        Back to the overview
      </Link>
    </EmptyState>
  );
}
