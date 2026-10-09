import { createFileRoute } from "@tanstack/react-router";
import { AliasesTab } from "@/pages/models/aliases-tab";

export const Route = createFileRoute("/_app/models/aliases")({
  staticData: { crumb: "Aliases" },
  component: AliasesTab,
});
