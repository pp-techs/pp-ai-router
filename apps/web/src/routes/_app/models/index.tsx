import { createFileRoute } from "@tanstack/react-router";
import { ModelsTab } from "@/pages/models/models-tab";

export const Route = createFileRoute("/_app/models/")({ component: ModelsTab });
