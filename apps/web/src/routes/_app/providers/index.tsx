import { createFileRoute } from "@tanstack/react-router";
import { ProvidersPage } from "@/pages/providers/providers-page";

export const Route = createFileRoute("/_app/providers/")({ component: ProvidersPage });
