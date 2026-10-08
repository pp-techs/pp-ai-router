import { createFileRoute } from "@tanstack/react-router";
import { NotFoundPage } from "@/pages/not-found";

// Unknown URLs keep the sidebar and header instead of falling out to a bare page.
export const Route = createFileRoute("/_app/$")({
  staticData: { crumb: "Not found" },
  component: NotFoundPage,
});
