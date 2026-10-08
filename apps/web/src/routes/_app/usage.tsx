import { createFileRoute } from "@tanstack/react-router";
import { UsagePage } from "@/pages/usage/usage-page";

export const Route = createFileRoute("/_app/usage")({
  staticData: { crumb: "Usage" },
  component: UsagePage,
});
