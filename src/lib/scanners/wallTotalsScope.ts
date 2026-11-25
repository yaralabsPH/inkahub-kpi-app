/**
 * scanner-wall-redesign: the pure decisions behind the wall's totals hook,
 * kept here so they are tested without a React renderer.
 */
import { isReportSite } from "@/lib/domain/productionPeriods";
import { productionVisibilityFor } from "@/lib/repository/supabase/productionEvidence";

export interface WallAccessInput {
  hasClient: boolean;
  site: string;
  callerId: string | null;
  /** Owner, manager or kiosk (the shared-scanner operator roles). */
  roleAllowed: boolean;
  role: string | null;
  /** Confirmed membership of this site. */
  siteMember: boolean;
}

/**
 * True only when the caller can read every production event at this site:
 * a site-wide role with confirmed membership. Anything less would turn an
 * RLS-filtered (partial) answer into wrong "zero" totals, so nothing is shown.
 */
export function wallTotalsAccess(a: WallAccessInput): boolean {
  return a.hasClient && isReportSite(a.site) && !!a.callerId && a.roleAllowed
    && productionVisibilityFor(a.role, a.siteMember).kind === "site";
}

/**
 * Monotonic generation of the scanner→person map. Every change, including a
 * change back to an earlier map (A→B→A), is a new generation, so numbers read
 * before it are never shown as current.
 */
export function createBindingGeneration(initialKey: string): { observe(key: string): number; readonly current: number } {
  let key = initialKey;
  let gen = 0;
  return {
    observe(next: string) {
      if (next !== key) {
        key = next;
        gen += 1;
      }
      return gen;
    },
    get current() {
      return gen;
    },
  };
}
