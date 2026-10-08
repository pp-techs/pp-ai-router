import { createFileRoute } from "@tanstack/react-router";
import { KeysPage } from "@/pages/keys/keys-page";

export const Route = createFileRoute("/_app/keys")({
  staticData: { crumb: "API keys" },
  component: KeysPage,
});
