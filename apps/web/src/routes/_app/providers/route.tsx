import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/providers")({
  staticData: { crumb: "Providers" },
  component: Outlet,
});
