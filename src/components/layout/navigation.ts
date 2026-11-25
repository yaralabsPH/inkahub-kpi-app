import {
  Home, LayoutDashboard, Package, ClipboardList, Truck,
  CalendarDays, Warehouse, ShoppingCart, Settings, Users, Printer, ArrowLeftRight, LifeBuoy,
  PackageOpen, ScanLine, BarChart3,
} from "lucide-react";
import { NAV_KEYS, type NavKey } from "@/lib/domain";

/**
 * Sidebar structure for the redesigned shell. Routes and keys are the same as
 * before; only grouping and order are new. Permissions are NOT decided here:
 * callers pass the set from effectiveNavAccess()/allNavAccess().
 */
export interface NavItem {
  key: NavKey;
  to: string;
  end?: boolean;
}

export interface NavGroup {
  label: string | null;
  items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: null,
    items: [
      { key: "welcome", to: "/", end: true },
      { key: "dashboard", to: "/dashboard" },
    ],
  },
  {
    label: "Inventory",
    items: [
      { key: "skus", to: "/skus" },
      { key: "warehouse", to: "/warehouse" },
      { key: "movements", to: "/movements" },
      { key: "paper", to: "/paper" },
    ],
  },
  {
    label: "Planning",
    items: [
      { key: "sales", to: "/sales" },
      { key: "events", to: "/events" },
      { key: "orders", to: "/orders" },
      { key: "shipments", to: "/shipments" },
    ],
  },
  {
    label: "Customer service",
    items: [
      { key: "cs_cases", to: "/cs-cases" },
      { key: "cs_returns", to: "/returns" },
      { key: "order_submission", to: "/production" },
    ],
  },
  {
    label: "Insights",
    items: [{ key: "reports", to: "/reports" }],
  },
  {
    label: "Workspace",
    items: [
      { key: "team", to: "/team" },
      { key: "settings", to: "/settings" },
    ],
  },
];

/** Groups filtered to the allowed keys, in order; empty groups are dropped. */
export function visibleNavGroups(allowed: ReadonlySet<NavKey>): NavGroup[] {
  const out: NavGroup[] = [];
  for (const group of NAV_GROUPS) {
    const items = group.items.filter((item) => allowed.has(item.key)).map((item) => ({ ...item }));
    if (items.length > 0) out.push({ label: group.label, items });
  }
  return out;
}

/** One icon per page; shared by the sidebar and the Team page access editor. */
export const NAV_ICONS: Record<NavKey, typeof LayoutDashboard> = {
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

/**
 * Every page in sidebar order, grouped like the sidebar (the untitled first
 * group is "General"); any page not in a group is listed under "Other".
 * Used by the Team page access editor.
 */
export function accessGroups(): Array<{ label: string; keys: NavKey[] }> {
  const groups = NAV_GROUPS.map((g) => ({ label: g.label ?? "General", keys: g.items.map((i) => i.key) }));
  const seen = new Set<NavKey>(groups.flatMap((g) => g.keys));
  const rest = NAV_KEYS.filter((k) => !seen.has(k));
  return rest.length ? [...groups, { label: "Other", keys: [...rest] }] : groups;
}
