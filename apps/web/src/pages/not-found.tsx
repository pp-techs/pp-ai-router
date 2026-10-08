import { CompassIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { EmptyState } from "@/components/query-state";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <EmptyState
      icon={CompassIcon}
      title="Page not found"
      action={
        <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
          Back to the overview
        </Button>
      }
    />
  );
}
