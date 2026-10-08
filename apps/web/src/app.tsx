import { ModalContainer } from "@buiducnhat/better-modal";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { AppLayout } from "./components/layout.tsx";
import { Toaster } from "./components/ui/toast.tsx";
import { AliasesPage } from "./pages/aliases.tsx";
import { KeysPage } from "./pages/keys/keys-page.tsx";
import { LoginPage } from "./pages/login.tsx";
import { NotFoundPage } from "./pages/not-found.tsx";
import { OverviewPage } from "./pages/overview.tsx";
import { PricingPage } from "./pages/pricing/pricing-page.tsx";
import { ProviderDetailPage } from "./pages/providers/provider-detail.tsx";
import { ProvidersPage } from "./pages/providers/providers-page.tsx";
import { UsagePage } from "./pages/usage/usage-page.tsx";
import { queryClient } from "./query-client.ts";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route element={<AppLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="providers" element={<ProvidersPage />} />
            <Route path="providers/:id" element={<ProviderDetailPage />} />
            <Route path="models" element={<AliasesPage />} />
            <Route path="keys" element={<KeysPage />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="pricing" element={<PricingPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
        <ModalContainer />
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
