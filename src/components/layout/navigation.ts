import type { NavKey } from "@/lib/domain";

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
