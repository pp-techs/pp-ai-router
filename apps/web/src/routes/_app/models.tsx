import { createFileRoute } from "@tanstack/react-router";
import { AliasesPage } from "@/pages/aliases";

export const Route = createFileRoute("/_app/models")({
  staticData: { crumb: "Models" },
  component: AliasesPage,
});
