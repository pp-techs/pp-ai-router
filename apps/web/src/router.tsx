import { createRouter } from "@tanstack/react-router";
import { auth } from "./api/http.ts";
import { NotFoundPage } from "./pages/not-found.tsx";
import { routeTree } from "./route-tree.gen.ts";

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  // Pages scroll inside the layout's content area, not the window.
  scrollToTopSelectors: ["#main-scroll"],
  defaultNotFoundComponent: NotFoundPage,
});

// Signing in or out (or a 401) re-runs every `beforeLoad`, so the auth guards redirect immediately.
auth.subscribe(() => void router.invalidate());

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    /** Label of this route in the header breadcrumb; routes without one are skipped. */
    crumb?: string;
  }
}
