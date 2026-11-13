/**
 * Welcome projections over one prepared snapshot (F1 Task 6).
 *
 * Source periods are site production days (04:00 local), anchored on the
 * snapshot's as-of instant:
 *   - department cards: TODAY so far, compared with the same weekday one week
 *     earlier (whole day), with the top worker and their consecutive-day streak
 *     ending today;
 *   - most improved: YESTERDAY versus that person's average over the 7 days
 *     before it (days with completed orders only);
 *   - team total and sparkline: completed orders per day for the 7 days ending
 *     yesterday.
 * All counts come from summarizeProduction; Orders are completed orders.
 */
import { summarizeProduction, WORK_TYPES, type PreparedProductionEvidence, type ProductionSummary, type WorkType } from "./productionCounts";
import { productionDateAt, productionRange, shiftProductionDate, type ProductionRange, type ReportSite } from "./productionPeriods";

/** Production days the Welcome page needs, ending today: 8 days back covers every comparison. */
export const WELCOME_LOOKBACK_DAYS = 8;

export function welcomeRange(site: ReportSite, today: string): ProductionRange {
  return productionRange(site, shiftProductionDate(today, -WELCOME_LOOKBACK_DAYS), today);
}

export interface WelcomeCounts {
  items: number | null;
  orders: number;
}

export interface WelcomeTopWorker {
  staffId: string;
  orders: number;
  items: number | null;
}

export interface WelcomeDepartment {
  normal: WelcomeCounts;
  rework: WelcomeCounts;
  topWorker: WelcomeTopWorker | null;
  /** Today's Orders minus the same weekday last week (whole day); null when that day had no completed orders here. */
  vsLastWeek: number | null;
  lastWeekDate: string;
  /** Consecutive production days ending today with the same top worker. */
  streak: number;
}

export interface WelcomeMostImproved {
  staffId: string;
  yesterdayOrders: number;
  avgBefore: number;
  delta: number;
}

export interface ProductionWelcomeView {
  today: string;
  yesterday: string;
  todayTotals: { normal: WelcomeCounts; rework: WelcomeCounts };
  perDepartment: Record<WorkType, WelcomeDepartment>;
  mostImproved: WelcomeMostImproved | null;
  sparkline: Array<{ day: string; orders: number }>;
  teamTotalYesterday: number;
  /** Coverage for today's cards. */
  todaySummary: ProductionSummary;
}

const counts = (g: { items: number | null; orders: number }): WelcomeCounts => ({ items: g.items, orders: g.orders });

/** Top person by completed Orders, then Items, then id (deterministic). */
function topOf(s: ProductionSummary): WelcomeTopWorker | null {
  let best: WelcomeTopWorker | null = null;
  for (const [staffId, g] of Object.entries(s.byPerson)) {
    const cand = { staffId, orders: g.normal.orders, items: g.normal.items };
    if (cand.orders === 0) continue;
    if (
      !best ||
      cand.orders > best.orders ||
      (cand.orders === best.orders && (cand.items ?? 0) > (best.items ?? 0)) ||
      (cand.orders === best.orders && (cand.items ?? 0) === (best.items ?? 0) && staffId < best.staffId)
    ) {
      best = cand;
    }
  }
  return best;
}

export function buildProductionWelcomeView(evidence: PreparedProductionEvidence, site: ReportSite, asOfUtc: string): ProductionWelcomeView {
  const today = productionDateAt(new Date(asOfUtc), site);
  const yesterday = shiftProductionDate(today, -1);
  const day = (date: string, workType?: WorkType) => {
    const r = productionRange(site, date, date);
    return summarizeProduction(evidence, {
      range: { startUtc: r.startUtc, endUtcExclusive: r.endUtcExclusive },
      ...(workType ? { workTypes: [workType] } : {}),
    });
  };

  const todaySummary = day(today);
  const lastWeekDate = shiftProductionDate(today, -7);
  const perDepartment = {} as Record<WorkType, WelcomeDepartment>;
  for (const wt of WORK_TYPES) {
    const t = day(today, wt);
    const lw = day(lastWeekDate, wt);
    const top = topOf(t);
    let streak = 0;
    if (top) {
      streak = 1;
      for (let i = 1; i <= 7; i++) {
        const prior = topOf(day(shiftProductionDate(today, -i), wt));
        if (prior && prior.staffId === top.staffId) streak++;
        else break;
      }
    }
    perDepartment[wt] = {
      normal: counts(t.normal),
      rework: counts(t.rework),
      topWorker: top,
      vsLastWeek: lw.normal.orders > 0 ? t.normal.orders - lw.normal.orders : null,
      lastWeekDate,
      streak,
    };
  }

  const yesterdaySummary = day(yesterday);
  const before = Array.from({ length: 7 }, (_, i) => day(shiftProductionDate(yesterday, -(i + 1))));
  let mostImproved: WelcomeMostImproved | null = null;
  for (const [staffId, g] of Object.entries(yesterdaySummary.byPerson).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const yesterdayOrders = g.normal.orders;
    if (yesterdayOrders === 0) continue;
    const prior = before.map((s) => s.byPerson[staffId]?.normal.orders ?? 0).filter((n) => n > 0);
    if (prior.length === 0) continue;
    const avgBefore = prior.reduce((a, b) => a + b, 0) / prior.length;
    const delta = yesterdayOrders - avgBefore;
    if (delta > 0 && (!mostImproved || delta > mostImproved.delta)) mostImproved = { staffId, yesterdayOrders, avgBefore, delta };
  }

  const sparkline = Array.from({ length: 7 }, (_, i) => {
    const d = shiftProductionDate(yesterday, i - 6);
    return { day: d, orders: d === yesterday ? yesterdaySummary.normal.orders : day(d).normal.orders };
  });

  return {
    today,
    yesterday,
    todayTotals: { normal: counts(todaySummary.normal), rework: counts(todaySummary.rework) },
    perDepartment,
    mostImproved,
    sparkline,
    teamTotalYesterday: yesterdaySummary.normal.orders,
    todaySummary,
  };
}
