import { createFileRoute } from "@tanstack/react-router";
import { ProviderDetailPage } from "@/pages/providers/provider-detail";

export const Route = createFileRoute("/_app/providers/$id")({
  // The breadcrumb shows the provider's id.
  loader: ({ params }) => ({ crumb: params.id }),
  component: ProviderDetailPage,
});
