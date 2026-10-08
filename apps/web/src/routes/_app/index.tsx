import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "@/pages/overview";

export const Route = createFileRoute("/_app/")({
  staticData: { crumb: "Overview" },
  component: OverviewPage,
});
