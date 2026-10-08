import { createFileRoute, redirect } from "@tanstack/react-router";
import { auth } from "@/api/http";
import { AppLayout } from "@/components/app-layout";
import { parseSection, type SettingsSection } from "@/components/settings/sections";

/** Authenticated shell (sidebar + header). `?settings=` opens the settings dialog on any page. */
export const Route = createFileRoute("/_app")({
  validateSearch: (search): { settings?: SettingsSection } => {
    const settings = parseSection(search.settings);
    return settings ? { settings } : {};
  },
  beforeLoad: ({ location }) => {
    if (!auth.token()) throw redirect({ to: "/login", search: { from: location.href } });
  },
  component: AppLayout,
});
