import { NAV_KEYS, type NavKey } from "@/lib/domain";
import type { UserProfile } from "./AuthProvider";

/**
 * Compute the set of NavKey pages a user can access in the sidebar and
 * via direct URL navigation.
 *
 * === welcome-default + owner-only-dashboard ===
 *
 * Rules (in order):
 *   1. Owner: full access to every NAV_KEY (including dashboard + settings).
 *   2. Manager: every NAV_KEY EXCEPT dashboard (sensitive financial data).
 *   3. Staff: just welcome (managers can grant more via allowed_nav).
 *   4. allowed_nav array on the profile overrides the role default
 *      EXCEPT dashboard, which is always stripped from non-owners.
 *   5. Welcome is always included so the user has a landing page.
 *   6. Owners always have settings.
 */
export function effectiveNavAccess(profile: UserProfile | null): Set<NavKey> {
  if (!profile) return new Set<NavKey>();
  let keys: NavKey[];
  if (Array.isArray(profile.allowed_nav)) {
    keys = profile.allowed_nav as NavKey[];
  } else {
    switch (profile.role) {
      case "owner":
        keys = [...NAV_KEYS];
        break;
      case "manager":
        keys = NAV_KEYS.filter((k) => k !== "dashboard") as NavKey[];
        break;
      case "kiosk":
        // Shared kiosk login - locked down to the production page (+ welcome,
        // which is added unconditionally below). No SKUs / Shipments / Settings
        // exposure even though the browser sits unattended at a station.
        keys = ["order_submission"] as NavKey[];
        break;
      case "cs":
        // Customer Service - locked to the returns + cases pages plus
        // welcome. No inventory, no reports, no team management.
        keys = ["cs_returns", "cs_cases"] as NavKey[];
        break;
      case "staff":
      default:
        keys = ["welcome"];
        break;
    }
  }
  // Dashboard is OWNER-ONLY regardless of allowed_nav (defence in depth).
  if (profile.role !== "owner") {
    keys = keys.filter((k) => k !== "dashboard");
  }
  // Welcome is always available as the landing page.
  if (!keys.includes("welcome")) keys = [...keys, "welcome"];
  // Owners always have settings - they need to manage users / config.
  if (profile.role === "owner" && !keys.includes("settings")) {
    keys = [...keys, "settings"];
  }
  return new Set(keys);
}

/**
 * In Dexie mode there''s no auth context - single-user, sees everything.
 */
export function allNavAccess(): Set<NavKey> {
  return new Set(NAV_KEYS);
}