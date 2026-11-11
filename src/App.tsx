import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RepositoryProvider } from "@/lib/repository/RepositoryProvider";
import { getBackendMode } from "@/lib/repository/supabase/client";
import { AuthProvider, useAuthOptional } from "@/lib/auth/AuthProvider";
import { AuthGate } from "@/components/AuthGate";
import { effectiveNavAccess, allNavAccess } from "@/lib/auth/permissions";
import type { NavKey } from "@/lib/domain";
import { Layout } from "@/components/layout/Layout";
import { Dashboard } from "@/pages/Dashboard";
import { StockValue } from "@/pages/StockValue";
import { Welcome } from "@/pages/Welcome";
import { SkuDetail } from "@/pages/SkuDetail";
import { Skus } from "@/pages/Skus";
import { SalesEntry } from "@/pages/SalesEntry";
import { Shipments } from "@/pages/Shipments";
import { Events } from "@/pages/Events";
import { Warehouse } from "@/pages/Warehouse";
import { ShoppingList } from "@/pages/ShoppingList";
import { PaperUsage } from "@/pages/PaperUsage";
import { Movements } from "@/pages/Movements";
import { CsCases } from "@/pages/CsCases";
import { CsReturns } from "@/pages/CsReturns";
import { Production } from "@/pages/Production";
import { Reports } from "@/pages/Reports";
import { Team } from "@/pages/Team";
import { Settings } from "@/pages/Settings";

// The dataset query is keyed by location (see useDataset.ts), so each
// location gets its own cache slot. No global invalidate-on-switch
// required — flipping location just observes a different cache key. The
// short staleTime keeps the active location fresh after edits without
// forcing a refetch every tab switch.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: true },
  },
});

/**
 * In Supabase mode we wrap the routed app in <AuthProvider> + <AuthGate>
 * so the login screen displays before the app mounts, and the auth
 * session is available everywhere. In Dexie mode neither is rendered —
 * the existing local-only behaviour is unchanged.
 */
function MaybeAuthGated({ children }: { children: ReactNode }) {
  if (getBackendMode() === "supabase") {
    return (
      <AuthProvider>
        <AuthGate>{children}</AuthGate>
      </AuthProvider>
    );
  }
  return <>{children}</>;
}

/**
 * Route-level permission guard. Redirects to dashboard if the current
 * user's `allowed_nav` doesn't include the requested page. In Dexie mode
 * (no auth context) it always allows — the single user owns everything.
 *
 * Catches the case where someone types a URL directly (e.g. /skus) for
 * a page their role doesn't cover. The Sidebar already hides such links,
 * but URL bar typing bypasses that.
 */
function NavGate({ navKey, children }: { navKey: NavKey; children: ReactNode }) {
  const auth = useAuthOptional();
  const allowed = auth?.profile
    ? effectiveNavAccess(auth.profile)
    : allNavAccess();
  if (!allowed.has(navKey)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MaybeAuthGated>
        <RepositoryProvider>
          <BrowserRouter>
            <Routes>
              {/* /production is intentionally OUTSIDE the Layout shell —
                  no sidebar, no topbar, no Scenario/Department selectors.
                  Tablet-first UI for the framing team. NavGate still
                  enforces the order_submission permission so a Staff
                  user without the right allowed_nav can't open it. */}
              <Route
                path="/production"
                element={<NavGate navKey="order_submission"><Production /></NavGate>}
              />
              <Route element={<Layout />}>
                <Route index element={<NavGate navKey="welcome"><Welcome /></NavGate>} />
                <Route path="/dashboard" element={<NavGate navKey="dashboard"><Dashboard /></NavGate>} />
                <Route path="/stock-value" element={<NavGate navKey="dashboard"><StockValue /></NavGate>} />
                <Route path="/skus" element={<NavGate navKey="skus"><Skus /></NavGate>} />
                <Route path="/skus/:id" element={<NavGate navKey="skus"><SkuDetail /></NavGate>} />
                <Route path="/sales" element={<NavGate navKey="sales"><SalesEntry /></NavGate>} />
                <Route path="/shipments" element={<NavGate navKey="shipments"><Shipments /></NavGate>} />
                <Route path="/events" element={<NavGate navKey="events"><Events /></NavGate>} />
                <Route path="/warehouse" element={<NavGate navKey="warehouse"><Warehouse /></NavGate>} />
                <Route path="/orders" element={<NavGate navKey="orders"><ShoppingList /></NavGate>} />
                <Route path="/paper" element={<NavGate navKey="paper"><PaperUsage /></NavGate>} />
                <Route path="/movements" element={<NavGate navKey="movements"><Movements /></NavGate>} />
                <Route path="/cs-cases" element={<NavGate navKey="cs_cases"><CsCases /></NavGate>} />
                <Route path="/returns" element={<NavGate navKey="cs_returns"><CsReturns /></NavGate>} />
                <Route path="/reports" element={<NavGate navKey="reports"><Reports /></NavGate>} />
                <Route path="/team" element={<NavGate navKey="team"><Team /></NavGate>} />
                <Route path="/settings" element={<NavGate navKey="settings"><Settings /></NavGate>} />
              </Route>
            </Routes>
          </BrowserRouter>
        </RepositoryProvider>
      </MaybeAuthGated>
    </QueryClientProvider>
  );
}
