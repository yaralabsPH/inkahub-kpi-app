/**
 * scanner-wall-redesign: today's numbers on the shared scanner wall.
 *
 * A pure projection of the existing F1 production evidence (the same rule
 * Classic Production and Reports use): one framing summary for the distinct
 * people currently on the wall. Display only; it never feeds credit, stock,
 * identity or retry decisions.
 */
import {
  snapshotCovers,
  summarizeProduction,
  type PreparedProductionEvidence,
  type UtcWindow,
  type WorkType,
} from "@/lib/domain/productionCounts";

/** Framing output only: the work types a framing wall records. */
export const WALL_WORK_TYPES: readonly WorkType[] = ["framed", "a0_framed"];

export interface PersonWallTotals {
  /** Distinct normal (non-rework) framing orders today. */
  orders: number;
  /** Normal pieces by the shared SKU/set rule; null when not exact. */
  pieces: number | null;
  /** Competition rank (1, 1, 3); null when ranking is withheld. */
  rank: number | null;
  /** Share of the active people's order credits (0..1); null when withheld. */
  share: number | null;
  /** True for every tied positive leader. */
  leading: boolean;
  /** Leading together with someone else. */
  jointLead: boolean;
}

export interface ScannerWallTotals {
  byPerson: Record<string, PersonWallTotals>;
  /** Distinct active people together: union of their orders, shared-rule pieces. */
  team: { orders: number; pieces: number | null };
  /** Someone on the wall has CS/rework output today (never in the headline). */
  hasRework: boolean;
  /** Coverage issues, limited visibility or inexact pieces: no ranking/leaders/share. */
  incomplete: boolean;
}

export class WallTotalsRangeError extends Error {
  constructor() {
    super("The production snapshot was not read for this production day.");
    this.name = "WallTotalsRangeError";
  }
}

/**
 * Today's totals for the given people. `range` is the site production day;
 * a snapshot read for any other window is refused, never reused.
 */
export function buildScannerWallTotals(
  evidence: PreparedProductionEvidence,
  range: UtcWindow,
  personIds: readonly string[],
): ScannerWallTotals {
  if (!snapshotCovers(evidence.snapshot, range)) throw new WallTotalsRangeError();
  const people = [...new Set(personIds)].sort();
  if (people.length === 0) {
    return { byPerson: {}, team: { orders: 0, pieces: 0 }, hasRework: false, incomplete: false };
  }
  const summary = summarizeProduction(evidence, { range, staffIds: people, workTypes: WALL_WORK_TYPES });

  const raw = people.map((id) => {
    const g = summary.byPerson[id];
    return { id, orders: g?.normal.orders ?? 0, pieces: g ? g.normal.items : 0, rework: (g?.rework.orders ?? 0) > 0 };
  });
  const incomplete = summary.coverage.incomplete || summary.normal.items === null || raw.some((r) => r.pieces === null);
  const top = Math.max(...raw.map((r) => r.orders));
  const leaders = raw.filter((r) => r.orders === top && top > 0).length;
  const denominator = raw.reduce((s, r) => s + r.orders, 0);

  const byPerson: Record<string, PersonWallTotals> = {};
  for (const r of raw) {
    const rank = 1 + raw.filter((o) => o.orders > r.orders).length;
    const leading = !incomplete && top > 0 && r.orders === top;
    byPerson[r.id] = {
      orders: r.orders,
      pieces: r.pieces,
      rank: incomplete ? null : rank,
      share: incomplete ? null : denominator === 0 ? 0 : r.orders / denominator,
      leading,
      jointLead: leading && leaders > 1,
    };
  }
  return {
    byPerson,
    team: { orders: summary.normal.orders, pieces: summary.normal.items },
    hasRework: raw.some((r) => r.rework),
    incomplete,
  };
}
