import {
  ArrowLeftRightIcon,
  CoinsIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MenuIcon,
  NetworkIcon,
  ServerIcon,
  TrendingUpIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { auth } from "@/api/http";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useToken } from "@/lib/use-token";
import { cn } from "@/lib/utils";

const NAV: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: "/", label: "Overview", icon: LayoutDashboardIcon, end: true },
  { to: "/providers", label: "Providers", icon: ServerIcon },
  { to: "/models", label: "Models", icon: NetworkIcon },
  { to: "/keys", label: "API keys", icon: KeyRoundIcon },
  { to: "/usage", label: "Usage", icon: TrendingUpIcon },
  { to: "/pricing", label: "Pricing", icon: CoinsIcon },
];

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground",
        className,
      )}
    >
      <ArrowLeftRightIcon className="size-4" />
    </span>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <BrandMark />
      <span className="font-heading text-base font-semibold tracking-tight">AI Router</span>
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )
          }
        >
          <Icon className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function SignOut() {
  return (
    <Button variant="ghost" className="w-full justify-start" onClick={auth.clear}>
      <LogOutIcon data-icon="inline-start" />
      Sign out
    </Button>
  );
}

/** Authenticated shell: fixed sidebar from `md`, a top bar with a nav sheet below. Sends anonymous visitors to /login. */
export function AppLayout() {
  const token = useToken();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:flex md:h-screen md:flex-col md:gap-6 md:px-3 md:py-5">
        <Brand />
        <div className="flex-1">
          <NavList />
        </div>
        <SignOut />
      </aside>

      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-sidebar-border bg-sidebar px-4 py-2.5 md:hidden">
        <Brand />
        <Button variant="ghost" size="icon" aria-label="Open menu" onClick={() => setOpen(true)}>
          <MenuIcon />
        </Button>
      </header>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="gap-6 bg-sidebar px-3 py-5">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Pages of the admin console</SheetDescription>
          <Brand />
          <div className="flex-1">
            <NavList onNavigate={() => setOpen(false)} />
          </div>
          <SignOut />
        </SheetContent>
      </Sheet>

      <main className="mx-auto w-full max-w-7xl min-w-0 px-4 py-6 md:px-8 md:py-8">
        <Outlet />
      </main>
    </div>
  );
}
