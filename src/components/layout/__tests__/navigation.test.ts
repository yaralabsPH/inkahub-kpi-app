import { describe, expect, it } from "vitest";
import { NAV_KEYS, type NavKey } from "@/lib/domain";
import { allNavAccess, effectiveNavAccess } from "@/lib/auth/permissions";
import type { UserProfile } from "@/lib/auth/AuthProvider";
import { NAV_GROUPS, visibleNavGroups } from "../navigation";

const profile = (role: UserProfile["role"], allowed_nav: string[] | null = null): UserProfile => ({
  user_id: "u1",
  display_name: "Test",
  role,
  allowed_nav,
});

const flat = (allowed: ReadonlySet<NavKey>) => visibleNavGroups(allowed).flatMap((g) => g.items.map((i) => i.key));
const order = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.key));
const expected = (allowed: ReadonlySet<NavKey>) => order.filter((k) => allowed.has(k));

describe("NAV_GROUPS", () => {
  it("covers every nav key exactly once, with unique routes", () => {
    expect([...order].sort()).toEqual([...NAV_KEYS].sort());
    const routes = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to));
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("uses the agreed groups and order", () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([null, "Inventory", "Planning", "Customer service", "Insights", "Workspace"]);
    expect(order).toEqual([
      "welcome", "dashboard",
      "skus", "warehouse", "movements", "paper",
      "sales", "events", "orders", "shipments",
      "cs_cases", "cs_returns", "order_submission",
      "reports",
      "team", "settings",
    ]);
  });

  it("keeps the existing route strings", () => {
    const to = Object.fromEntries(NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.to])));
    expect(to).toEqual({
      welcome: "/", dashboard: "/dashboard", skus: "/skus", sales: "/sales", shipments: "/shipments",
      events: "/events", warehouse: "/warehouse", orders: "/orders", paper: "/paper", movements: "/movements",
      cs_cases: "/cs-cases", cs_returns: "/returns", order_submission: "/production", reports: "/reports",
      team: "/team", settings: "/settings",
    });
    const welcome = NAV_GROUPS[0].items.find((i) => i.key === "welcome");
    expect(welcome?.end).toBe(true);
  });
});

describe("visibleNavGroups", () => {
  it("flattens to exactly the allowed keys, in nav order", () => {
    for (const set of [allNavAccess(), new Set<NavKey>(["reports", "welcome"]), new Set<NavKey>(["settings"])]) {
      expect(flat(set)).toEqual(expected(set));
    }
  });

  it("returns no groups for an empty set and hides empty groups", () => {
    expect(visibleNavGroups(new Set())).toEqual([]);
    const groups = visibleNavGroups(new Set<NavKey>(["welcome", "settings"]));
    expect(groups.map((g) => g.label)).toEqual([null, "Workspace"]);
  });

  it("never mutates its input or the shared groups", () => {
    const set = new Set<NavKey>(["welcome", "skus"]);
    const before = JSON.stringify(NAV_GROUPS);
    const groups = visibleNavGroups(set);
    groups[0].items.length;
    expect([...set]).toEqual(["welcome", "skus"]);
    expect(JSON.stringify(NAV_GROUPS)).toBe(before);
    expect(groups[0]).not.toBe(NAV_GROUPS[0]);
  });

  it("ignores unknown keys", () => {
    const set = new Set<string>(["welcome", "not_a_page"]) as unknown as ReadonlySet<NavKey>;
    expect(flat(set)).toEqual(["welcome"]);
  });
});

describe("role defaults through effectiveNavAccess", () => {
  it("owner sees everything", () => {
    expect(flat(effectiveNavAccess(profile("owner")))).toEqual(order);
  });
  it("manager sees everything except Dashboard", () => {
    expect(flat(effectiveNavAccess(profile("manager")))).toEqual(order.filter((k) => k !== "dashboard"));
  });
  it("staff sees Home and Reports", () => {
    expect(flat(effectiveNavAccess(profile("staff")))).toEqual(["welcome", "reports"]);
  });
  it("kiosk sees Home and Order submission", () => {
    expect(flat(effectiveNavAccess(profile("kiosk")))).toEqual(["welcome", "order_submission"]);
  });
  it("cs sees Home, CS cases and Returns", () => {
    expect(flat(effectiveNavAccess(profile("cs")))).toEqual(["welcome", "cs_cases", "cs_returns"]);
  });
  it("overrides replace role defaults, Dashboard stays owner-only, owners keep Settings", () => {
    expect(flat(effectiveNavAccess(profile("staff", ["skus", "dashboard"])))).toEqual(["welcome", "skus"]);
    expect(flat(effectiveNavAccess(profile("owner", ["skus"])))).toEqual(["welcome", "skus", "settings"]);
    expect(flat(effectiveNavAccess(profile("manager", [])))).toEqual(["welcome"]);
  });
  it("no profile means no pages; Dexie mode means every page", () => {
    expect(visibleNavGroups(effectiveNavAccess(null))).toEqual([]);
    expect(flat(allNavAccess())).toEqual(order);
  });
});
