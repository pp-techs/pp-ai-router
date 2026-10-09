import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { PageHeader } from "@/components/page";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** Header and tab bar shared by the Models and Aliases pages; the tab follows the URL. */
export function ModelsLayout() {
  const aliases = useLocation({ select: (l) => l.pathname.startsWith("/models/aliases") });
  return (
    <>
      <PageHeader
        title="Models"
        description="Every model your providers offer, with a switch to turn each one off, and the public names (aliases) that route to them."
      />
      <Tabs value={aliases ? "aliases" : "models"} className="mb-4">
        <TabsList>
          <TabsTrigger value="models" nativeButton={false} render={<Link to="/models" />}>
            Models
          </TabsTrigger>
          <TabsTrigger value="aliases" nativeButton={false} render={<Link to="/models/aliases" />}>
            Aliases
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Outlet />
    </>
  );
}
