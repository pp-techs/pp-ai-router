import { Outlet, useMatches, useNavigate, useSearch } from "@tanstack/react-router";
import { Fragment } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Link } from "@tanstack/react-router";

/** Header breadcrumb: every matched route that declares a `crumb` (statically or from its loader). */
function Crumbs() {
  const crumbs = useMatches({
    select: (matches) =>
      matches.flatMap((m) => {
        const loaded = (m.loaderData as { crumb?: string } | undefined)?.crumb;
        const label = loaded ?? m.staticData.crumb;
        return label ? [{ label, to: m.pathname }] : [];
      }),
  });

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={c.to}>
              <BreadcrumbItem className={last ? undefined : "hidden md:block"}>
                {last ? (
                  <BreadcrumbPage>{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link to={c.to} />}>{c.label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!last && <BreadcrumbSeparator className="hidden md:block" />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/** Authenticated shell, after shadcn's `sidebar-08`: inset sidebar, header with trigger and breadcrumb. */
export function AppLayout() {
  const { settings } = useSearch({ from: "/_app" });
  const navigate = useNavigate();

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-auto"
            />
            <Crumbs />
          </div>
        </header>
        {/* The only scroll container: the header and sidebar stay put. */}
        <div
          id="main-scroll"
          data-scroll-restoration-id="main-scroll"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-6 md:px-6"
        >
          <div className="mx-auto w-full max-w-7xl min-w-0">
            <Outlet />
          </div>
        </div>
      </SidebarInset>
      <SettingsDialog
        section={settings}
        onSectionChange={(next) =>
          void navigate({ to: ".", search: (prev) => ({ ...prev, settings: next }) })
        }
        onClose={() =>
          void navigate({ to: ".", search: (prev) => ({ ...prev, settings: undefined }) })
        }
      />
    </SidebarProvider>
  );
}
