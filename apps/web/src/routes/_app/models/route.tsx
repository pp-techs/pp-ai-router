import { createFileRoute } from "@tanstack/react-router";
import { ModelsLayout } from "@/pages/models/models-layout";

export const Route = createFileRoute("/_app/models")({
  staticData: { crumb: "Models" },
  component: ModelsLayout,
});
