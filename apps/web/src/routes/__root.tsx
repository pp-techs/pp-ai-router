import { ModalContainer } from "@buiducnhat/better-modal";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRoute({
  component: () => (
    <TooltipProvider>
      <Outlet />
      {/* Inside the router so modals can navigate. */}
      <ModalContainer />
    </TooltipProvider>
  ),
});
