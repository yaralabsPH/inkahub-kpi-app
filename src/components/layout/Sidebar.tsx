import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  Home, LayoutDashboard, Package, ClipboardList, Truck,
  CalendarDays, Warehouse, ShoppingCart, Settings, Users, Printer, ArrowLeftRight, LifeBuoy,
  PackageOpen, ScanLine, BarChart3, LogOut, Search, X,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useDataset } from "@/lib/hooks/useDataset";
import { navLabel, type NavKey } from "@/lib/domain";
import { useAppStore } from "@/lib/state/appStore";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { effectiveNavAccess, allNavAccess } from "@/lib/auth/permissions";
import { visibleNavGroups } from "./navigation";
import logoUrl from "@/assets/inka-arthouse-logo.png";

const ICONS: Record<NavKey, typeof LayoutDashboard> = {
  welcome: Home,
  dashboard: LayoutDashboard,
  skus: Package,
  sales: ClipboardList,
  shipments: Truck,
  events: CalendarDays,
  warehouse: Warehouse,
  orders: ShoppingCart,
  paper: Printer,
  movements: ArrowLeftRight,
  cs_cases: LifeBuoy,
  cs_returns: PackageOpen,
  order_submission: ScanLine,
  reports: BarChart3,
  team: Users,
  settings: Settings,
};

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  staff: "Staff",
  kiosk: "Kiosk",
  cs: "Customer service",
};

/** Opens the existing command palette through its own Ctrl/Cmd+K hotkey. */
function openPalette() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, metaKey: true, bubbles: true }));
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/**
 * Grouped navigation. `rail` is the desktop sidebar (hidden below 768px,
 * 240px or 56px collapsed); `drawer` is the same content, always expanded,
 * inside the mobile menu dialog.
 */
export function Sidebar({ variant, onClose }: { variant: "rail" | "drawer"; onClose?: () => void }) {
  const { data } = useDataset();
  const storedCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const collapsed = variant === "rail" && storedCollapsed;
  // Per-user sidebar permissions. In Supabase mode this comes from the
  // logged-in user's profile; in Dexie mode there's no auth, so every
  // page is allowed (matches the single-user experience).
  const auth = useAuthOptional();
  const allowed = auth?.profile ? effectiveNavAccess(auth.profile) : allNavAccess();
  const groups = visibleNavGroups(allowed);

  // Collapsed rail: one visible tooltip, fixed-positioned so the rail's scroll
  // clipping cannot hide it. Shown on hover and on keyboard focus.
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const showTip = (el: HTMLElement, label: string) => {
    const r = el.getBoundingClientRect();
    setTip({ label, top: r.top + r.height / 2, left: r.right + 8 });
  };
  const hideTip = () => setTip(null);

  const email = auth?.session?.user?.email ?? "";
  const displayName = auth?.profile?.display_name || email || "";
  const roleLabel = auth?.profile ? ROLE_LABEL[auth.profile.role] ?? auth.profile.role : "";

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col overflow-y-auto overflow-x-hidden border-r border-hub-sidebar-line bg-hub-sidebar text-hub-sidebar-text transition-[width] duration-150",
        variant === "rail" ? "hidden md:flex" : "w-full",
        variant === "rail" && (collapsed ? "w-14" : "w-60"),
      )}
      aria-label={variant === "rail" ? "Main navigation" : undefined}
    >
      {/* Brand */}
      <div
        className={cn(
          "flex h-11 shrink-0 items-center border-b border-hub-sidebar-line",
          collapsed ? "justify-center px-1" : "justify-between gap-2 px-3.5",
        )}
      >
        {collapsed ? (
          <span
            aria-label="Inka Arthouse"
            role="img"
            className="grid h-7 w-7 place-items-center rounded-[5px] bg-hub-accent text-[11px] font-extrabold text-[#111]"
          >
            IA
          </span>
        ) : (
          <img src={logoUrl} alt="Inka Arthouse" className="h-7 w-auto dark:invert" />
        )}
        {variant === "drawer" && onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="inline-grid h-9 w-9 place-items-center rounded-hub text-hub-sidebar-dim hover:bg-hub-sidebar-2 hover:text-hub-sidebar-hi"
          >
            <X size={18} />
          </button>
        ) : null}
      </div>

      {/* Search opener: the existing palette (/ or Ctrl/Cmd+K) */}
      <div className={cn("shrink-0", collapsed ? "px-1.5 pt-2" : "px-2.5 pt-2.5")}>
        <button
          type="button"
          onClick={() => {
            onClose?.();
            openPalette();
          }}
          aria-label="Search or jump to (slash or Ctrl K)"
          title={collapsed ? "Search (/ or Ctrl K)" : undefined}
          className={cn(
            "flex w-full items-center rounded-hub border border-hub-sidebar-line text-[12.5px] text-hub-sidebar-text hover:bg-hub-sidebar-2 hover:text-hub-sidebar-hi",
            collapsed ? "h-9 justify-center" : "h-8 justify-between px-2.5",
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            <Search size={14} aria-hidden="true" />
            {collapsed ? null : <span>Search or jump to…</span>}
          </span>
          {collapsed ? null : (
            <kbd className="font-mono text-[11px] text-hub-sidebar-dim" aria-hidden="true">/</kbd>
          )}
        </button>
      </div>

      <nav className="flex-1 pb-3" aria-label={variant === "drawer" ? "Main navigation" : undefined}>
        {groups.map((group, gi) => (
          <div key={group.label ?? `top-${gi}`}>
            {group.label && !collapsed ? (
              <div className="px-3.5 pb-1 pt-3.5 text-[11px] uppercase tracking-[0.06em] text-hub-sidebar-dim">
                {group.label}
              </div>
            ) : (
              <div className={collapsed && gi > 0 ? "mx-3 my-2 border-t border-hub-sidebar-line" : "h-1.5"} />
            )}
            <ul className="space-y-px">
              {group.items.map(({ key, to, end }) => {
                const Icon = ICONS[key];
                const label = navLabel(key, data?.settings);
                return (
                  <li key={key}>
                    <NavLink
                      to={to}
                      end={end}
                      title={collapsed ? undefined : label}
                      aria-label={collapsed ? label : undefined}
                      onMouseEnter={collapsed ? (e) => showTip(e.currentTarget, label) : undefined}
                      onFocus={collapsed ? (e) => showTip(e.currentTarget, label) : undefined}
                      onMouseLeave={collapsed ? hideTip : undefined}
                      onBlur={collapsed ? hideTip : undefined}
                      className={({ isActive }) =>
                        cn(
                          "mx-1.5 flex items-center rounded-[5px] text-[13.5px] transition-colors",
                          collapsed ? "h-9 justify-center" : "gap-2.5 px-3.5 py-1.5 max-md:py-2.5",
                          isActive
                            ? "bg-hub-sidebar-2 text-hub-sidebar-hi shadow-[inset_2px_0_0_rgb(var(--hub-accent))]"
                            : "hover:bg-hub-sidebar-2 hover:text-hub-sidebar-hi",
                        )
                      }
                    >
                      <Icon size={16} aria-hidden="true" className="shrink-0 opacity-85" />
                      {collapsed ? null : <span className="min-w-0 truncate">{label}</span>}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Signed-in user + sign out */}
      {auth?.session ? (
        <div
          className={cn(
            "mt-auto flex shrink-0 items-center gap-2 border-t border-hub-sidebar-line text-[12.5px]",
            collapsed ? "justify-center px-1 py-2.5" : "px-3.5 py-2.5",
          )}
        >
          {collapsed ? null : (
            <>
              <span
                aria-hidden="true"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-hub-sidebar-2 text-[10.5px] font-bold text-hub-sidebar-hi"
              >
                {initials(displayName)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-hub-sidebar-hi" title={email}>{displayName}</div>
                {roleLabel ? <div className="text-[11px]">{roleLabel}</div> : null}
              </div>
            </>
          )}
          <button
            type="button"
            onClick={() => { void auth.signOut(); }}
            title={`Sign out${email ? ` (${email})` : ""}`}
            aria-label="Sign out"
            className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-hub text-hub-sidebar-dim hover:bg-hub-sidebar-2 hover:text-hub-sidebar-hi"
          >
            <LogOut size={15} />
          </button>
        </div>
      ) : null}
      {collapsed && tip ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-hub bg-hub-text px-2 py-1 text-xs text-hub-panel shadow-hub-pop"
          style={{ top: tip.top, left: tip.left }}
        >
          {tip.label}
        </div>
      ) : null}
    </aside>
  );
}
