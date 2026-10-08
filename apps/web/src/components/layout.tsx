import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { auth } from "@/api/http";
import { Button } from "@/components/ui/button";
import { useToken } from "@/lib/use-token";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/providers", label: "Providers" },
  { to: "/models", label: "Models" },
  { to: "/keys", label: "API keys" },
  { to: "/usage", label: "Usage" },
  { to: "/pricing", label: "Pricing" },
];

/** Authenticated shell: sidebar on tablet and up, a scrollable top bar below. Sends anonymous visitors to /login. */
export function AppLayout() {
  const token = useToken();
  const location = useLocation();
  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return (
    <div className="min-h-screen md:grid md:grid-cols-[12rem_1fr]">
      <aside className="border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:h-screen md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-3 px-4 py-3 md:flex-col md:items-stretch md:gap-4 md:py-5">
          <p className="font-heading text-base font-semibold">⇄ AI Router</p>
          <nav aria-label="Main" className="-mx-1 flex gap-1 overflow-x-auto md:mx-0 md:flex-col">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-2 font-medium whitespace-nowrap",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <Button variant="ghost" className="md:mt-4 md:justify-start" onClick={auth.clear}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="mx-auto w-full max-w-7xl min-w-0 px-4 py-6 md:px-8 md:py-8">
        <Outlet />
      </main>
    </div>
  );
}
