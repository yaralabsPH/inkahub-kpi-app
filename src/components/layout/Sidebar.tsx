import { NavLink } from "react-router-dom";
import {
  Home, LayoutDashboard, Package, ClipboardList, Truck,
  CalendarDays, Warehouse, ShoppingCart, Settings, Users, Printer, ArrowLeftRight, LifeBuoy,
  PackageOpen, ScanLine, BarChart3,
  PanelLeftClose, PanelLeftOpen, LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useDataset } from "@/lib/hooks/useDataset";
import { navLabel, type NavKey } from "@/lib/domain";
import { useAppStore } from "@/lib/state/appStore";
import { LOCATIONS, LOCATION_LABELS } from "@/lib/domain";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { effectiveNavAccess, allNavAccess } from "@/lib/auth/permissions";

interface NavItem {
  key: NavKey;
  to: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
}

const ITEMS: NavItem[] = [
  { key: "welcome", to: "/", icon: Home, end: true },
  { key: "dashboard", to: "/dashboard", icon: LayoutDashboard },
  { key: "skus", to: "/skus", icon: Package },
  { key: "sales", to: "/sales", icon: ClipboardList },
  { key: "shipments", to: "/shipments", icon: Truck },
  { key: "events", to: "/events", icon: CalendarDays },
  { key: "warehouse", to: "/warehouse", icon: Warehouse },
  { key: "orders", to: "/orders", icon: ShoppingCart },
  { key: "paper", to: "/paper", icon: Printer },
  { key: "movements", to: "/movements", icon: ArrowLeftRight },
  { key: "cs_cases", to: "/cs-cases", icon: LifeBuoy },
  { key: "cs_returns", to: "/returns", icon: PackageOpen },
  { key: "order_submission", to: "/production", icon: ScanLine },
  { key: "reports", to: "/reports", icon: BarChart3 },
  { key: "team", to: "/team", icon: Users },
  { key: "settings", to: "/settings", icon: Settings },
];

export function Sidebar() {
  const { data } = useDataset();
  const location = useAppStore((s) => s.location);
  const setLocation = useAppStore((s) => s.setLocation);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  // Per-user sidebar permissions. In Supabase mode this comes from the
  // logged-in user's profile; in Dexie mode there's no auth, so every
  // page is allowed (matches the single-user experience).
  const auth = useAuthOptional();
  const allowed = auth?.profile
    ? effectiveNavAccess(auth.profile)
    : allNavAccess();

  return (
    <aside
      className={cn(
        "hidden md:flex shrink-0 flex-col border-r border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 backdrop-blur transition-[width] duration-200",
        collapsed ? "w-14" : "w-56",
      )}
      aria-label="Primary navigation"
    >
      {/* Header: brand + collapse toggle */}
      <div className={cn("flex items-center", collapsed ? "justify-center px-1 py-3" : "justify-between px-4 py-5 gap-2")}>
        {collapsed ? null : (
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate">
              Inka Arthouse
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Hub</div>
          </div>
        )}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      {/* Location switcher — hidden when collapsed; expand to switch locations */}
      {collapsed ? null : (
        <div className="px-3 pb-3">
          <label className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold">
            Location
          </label>
          <select
            value={location}
            onChange={(e) => {
              const next = e.target.value as typeof location;
              if (next === location) return;
              // Persist the new location to Zustand (writes to localStorage)
              // and then do a full page reload. The reload wipes every piece
              // of in-memory state (React Query cache, mutation closures,
              // open modals, Dexie connection handles), guaranteeing the new
              // location starts from a clean slate. This is the only way to
              // eliminate ALL possible classes of cross-location state leak
              // (closure capture of old repo, cached query data under
              // wrong key, half-open dexie transactions, etc).
              setLocation(next);
              window.location.reload();
            }}
            aria-label="Switch location"
            className="mt-1 w-full h-8 rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-900"
          >
            {LOCATIONS.map((l) => (
              <option key={l} value={l}>{LOCATION_LABELS[l]}</option>
            ))}
          </select>
        </div>
      )}

      <nav className={cn("py-2 space-y-0.5", collapsed ? "px-1.5" : "px-2")}>
        {ITEMS.filter((item) => allowed.has(item.key)).map(({ to, key, icon: Icon, end }) => {
          const label = navLabel(key, data?.settings);
          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={collapsed ? label : undefined}
              className={({ isActive }) =>
                cn(
                  "flex items-center rounded-lg text-sm font-medium transition",
                  collapsed
                    ? "justify-center h-9 w-9 mx-auto"
                    : "gap-2 px-3 py-2",
                  isActive
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                )
              }
            >
              <Icon size={16} />
              {collapsed ? null : <span className="truncate">{label}</span>}
            </NavLink>
          );
        })}
      </nav>

      {/* Footer: signed-in email + Sign out. Anchored to the bottom via
          mt-auto so it sits at the bottom of the sidebar regardless of
          how short the nav list is. */}
      {auth?.session ? (
        collapsed ? (
          <div className="mt-auto px-1 py-3 border-t border-slate-200 dark:border-slate-800 flex justify-center">
            <button
              type="button"
              onClick={() => { void auth.signOut(); }}
              title={`Sign out${auth.session.user?.email ? ` (${auth.session.user.email})` : ""}`}
              aria-label="Sign out"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <LogOut size={16} />
            </button>
          </div>
        ) : (
          <div className="mt-auto px-3 py-3 border-t border-slate-200 dark:border-slate-800 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500 font-semibold">
              Signed in as
            </div>
            <div className="text-xs text-slate-700 dark:text-slate-300 truncate" title={auth.session.user?.email ?? ""}>
              {auth.session.user?.email ?? "(unknown)"}
            </div>
            <button
              type="button"
              onClick={() => { void auth.signOut(); }}
              className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 mt-1"
            >
              <LogOut size={13} /> Sign out
            </button>
          </div>
        )
      ) : null}
    </aside>
  );
}
