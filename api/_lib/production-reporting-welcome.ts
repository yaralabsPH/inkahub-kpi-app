/**
 * Task 16: the published Welcome view from the database's per-day cells over
 * ONE selection (the Welcome range), with exactly the rules of
 * buildProductionWelcomeView: department cards (today vs the same weekday last
 * week, top worker by Orders then Items then id, streak of the same top worker
 * over up to 7 prior days), most improved (yesterday vs that person's average
 * over the 7 days before, days with Orders only), sparkline and team total for
 * the 7 days ending yesterday, and coverage for every displayed figure.
 */
import { WORK_TYPES, type WorkType } from "../../src/lib/domain/productionCounts.js";
import { shiftProductionDate } from "../../src/lib/domain/productionPeriods.js";
import type { CoverageCounts, PublishedWelcomeView } from "../../src/lib/domain/productionReporting.js";
import type { WelcomeDepartment, WelcomeMostImproved, WelcomeTopWorker } from "../../src/lib/domain/productionWelcomeView.js";

interface G { items: number | null; orders: number }
export interface WelcomeCell { date: string; workType: WorkType | null; staffId: string | null; normal: G; rework: G }
const ZERO = (): { normal: G; rework: G } => ({ normal: { items: 0, orders: 0 }, rework: { items: 0, orders: 0 } });
const num = (g: G): G => ({ items: g.items === null ? null : Number(g.items), orders: Number(g.orders) });

export function welcomeFrom(cells: readonly WelcomeCell[], today: string, todayCoverage: CoverageCounts, coverage: CoverageCounts): PublishedWelcomeView {
  const key = (d: string, wt: WorkType | null, who: string | null) => `${d}|${wt ?? ""}|${who ?? ""}`;
  const at = new Map(cells.map((c) => [key(String(c.date).slice(0, 10), c.workType, c.staffId), { normal: num(c.normal), rework: num(c.rework) }]));
  const day = (d: string, wt: WorkType | null = null) => at.get(key(d, wt, null)) ?? ZERO();
  const people = (d: string, wt: WorkType | null) =>
    cells.filter((c) => String(c.date).slice(0, 10) === d && c.workType === wt && c.staffId !== null).map((c) => ({ staffId: c.staffId as string, ...{ normal: num(c.normal) } }));
  const topOf = (d: string, wt: WorkType): WelcomeTopWorker | null => {
    let best: WelcomeTopWorker | null = null;
    for (const p of people(d, wt)) {
      const cand = { staffId: p.staffId, orders: p.normal.orders, items: p.normal.items };
      if (cand.orders === 0) continue;
      if (!best || cand.orders > best.orders || (cand.orders === best.orders && (cand.items ?? 0) > (best.items ?? 0)) || (cand.orders === best.orders && (cand.items ?? 0) === (best.items ?? 0) && p.staffId < best.staffId)) best = cand;
    }
    return best;
  };
  const yesterday = shiftProductionDate(today, -1);
  const lastWeekDate = shiftProductionDate(today, -7);
  const perDepartment = {} as Record<WorkType, WelcomeDepartment>;
  for (const wt of WORK_TYPES) {
    const t = day(today, wt);
    const lw = day(lastWeekDate, wt);
    const top = topOf(today, wt);
    let streak = 0;
    if (top) {
      streak = 1;
      for (let i = 1; i <= 7; i++) {
        const prior = topOf(shiftProductionDate(today, -i), wt);
        if (prior && prior.staffId === top.staffId) streak++;
        else break;
      }
    }
    perDepartment[wt] = { normal: t.normal, rework: t.rework, topWorker: top, vsLastWeek: lw.normal.orders > 0 ? t.normal.orders - lw.normal.orders : null, lastWeekDate, streak };
  }
  let mostImproved: WelcomeMostImproved | null = null;
  const before = Array.from({ length: 7 }, (_, i) => shiftProductionDate(yesterday, -(i + 1)));
  const personOrders = (d: string, who: string) => at.get(key(d, null, who))?.normal.orders ?? 0;
  for (const p of people(yesterday, null).sort((a, b) => (a.staffId < b.staffId ? -1 : 1))) {
    const yesterdayOrders = p.normal.orders;
    if (yesterdayOrders === 0) continue;
    const prior = before.map((d) => personOrders(d, p.staffId)).filter((n) => n > 0);
    if (prior.length === 0) continue;
    const avgBefore = prior.reduce((a, b) => a + b, 0) / prior.length;
    const delta = yesterdayOrders - avgBefore;
    if (delta > 0 && (!mostImproved || delta > mostImproved.delta)) mostImproved = { staffId: p.staffId, yesterdayOrders, avgBefore, delta };
  }
  const sparkline = Array.from({ length: 7 }, (_, i) => {
    const d = shiftProductionDate(yesterday, i - 6);
    return { day: d, orders: day(d).normal.orders };
  });
  const todayTotals = day(today);
  return { today, yesterday, todayTotals: { normal: todayTotals.normal, rework: todayTotals.rework }, perDepartment, mostImproved, sparkline, teamTotalYesterday: day(yesterday).normal.orders, todayCoverage, coverage };
}
