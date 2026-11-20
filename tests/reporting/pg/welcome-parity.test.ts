/**
 * Task 16: the published Welcome view (sel_welcome cells + welcomeFrom) equals
 * the EXISTING buildProductionWelcomeView over the four-family snapshot of the
 * Welcome range of the same source, offline in PGlite, for several "today"s
 * and audiences.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { imageToEvent } from "../../../api/_lib/production-reporting-reader";
import { welcomeFrom, type WelcomeCell } from "../../../api/_lib/production-reporting-welcome";
import { productionEventAdmissibility } from "../../staging/reportingPublication";
import { prepareProductionEvidence, WORK_TYPES, type ProductionEvidenceEvent } from "../../../src/lib/domain/productionCounts";
import { productionRange } from "../../../src/lib/domain/productionPeriods";
import { buildProductionWelcomeView, welcomeRange } from "../../../src/lib/domain/productionWelcomeView";
import type { CoverageCounts, ReportingAudience } from "../../../src/lib/domain/productionReporting";
import { ANNA, BEN, CARL, fourFamilySnapshot, history, randomHistory } from "../../fixtures/reporting-history";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

let db: PGlite;
let seq = "";
let cutoff = "";
let view: ProductionEvidenceEvent[] = [];
const SITE = "uk";

beforeAll(async () => {
  db = await reportingDb();
  for (const u of [ANNA, BEN, CARL]) await db.query("insert into auth.users (id) values ($1)", [u]);
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: null, p_processor_enabled: true });
  const seen = new Set<string>();
  // A deterministic "most improved": Ben completes 1 order on 01-20 and 01-21, then 3 on 01-22 (yesterday of 01-23).
  const done = (id: string, at: string) => ({ id, location: SITE, staff_id: BEN, department: "framed", order_number: `MI-${id}`, line_sku: null, line_quantity: 99, event_type: "completed", created_at: at, cs_case_id: null, parent_event_id: null }) as unknown as ProductionEvidenceEvent;
  const mi = [done("m1", "2026-01-20T10:00:00.000000Z"), done("m2", "2026-01-21T10:00:00.000000Z"), done("m3", "2026-01-22T10:00:00.000000Z"), done("m4", "2026-01-22T10:10:00.000000Z"), done("m5", "2026-01-22T10:20:00.000000Z")];
  for (const e of [...history(), ...randomHistory(23, 900), ...mi]) {
    if (e.location !== SITE || e.id === "" || seen.has(e.id) || productionEventAdmissibility(e as unknown as Record<string, unknown>, SITE).length) continue;
    seen.add(e.id);
    await db.query("insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id) values ($1,$2,$3,$4,$5,$6,$7,$8,'s','',$9,$10,$11)",
      [SITE, e.id, e.staff_id, e.department, e.order_number, e.line_sku, e.line_quantity, e.event_type, e.created_at, e.cs_case_id, e.parent_event_id]);
  }
  const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: SITE, mode: "rebuild" });
  if (r.state !== "published") throw new Error(`rebuild ${r.state}: ${r.problems.join("; ")}`);
  const g = (await db.query<{ seq: string; c: string }>("select generation_seq::text as seq, to_char(source_cutoff at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as c from reporting_private.generations where site = $1 and state = 'published'", [SITE])).rows[0];
  seq = g.seq;
  cutoff = g.c;
  view = (await db.query<{ img: unknown }>("select to_jsonb(pe) as img from public.production_events pe where pe.location = $1", [SITE])).rows.map((x) => imageToEvent(x.img, SITE));
}, 300_000);
afterAll(async () => db?.close());

const cov = (c: { issueCounts: Record<string, number>; notes: Record<string, number>; issueRows: number }): CoverageCounts => ({ issueCounts: c.issueCounts as never, notes: c.notes as never, visibility: { kind: "site" }, incomplete: false, issueRows: Number(c.issueRows) });
const TODAYS = ["2026-01-12", "2026-01-14", "2026-01-16", "2026-01-20", "2026-01-23"];

describe("Task 16: published Welcome equals buildProductionWelcomeView", () => {
  const AUD: ReportingAudience[] = [{ kind: "site" }, { kind: "self", staffId: ANNA }, { kind: "self", staffId: BEN }];
  for (const today of TODAYS) for (const a of AUD) {
    it(`today ${today} · ${a.kind === "site" ? "site" : `self ${a.staffId.slice(0, 4)}`}`, async () => {
      const range = welcomeRange(SITE, today);
      const tr = productionRange(SITE, today, today);
      const source = a.kind === "self" ? view.filter((e) => e.staff_id === a.staffId) : view;
      const ref = buildProductionWelcomeView(prepareProductionEvidence(fourFamilySnapshot(source, { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive }, { kind: "site" }, SITE, cutoff)), SITE, cutoff, today);
      const v = (await db.query<{ v: { cells: WelcomeCell[]; coverage: never; todayCoverage: never } }>("select reporting_private.sel_welcome($1, $2, $3::uuid, $4::bigint, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz) as v",
        [SITE, a.kind, a.kind === "self" ? a.staffId : null, seq, range.startUtc, range.endUtcExclusive, tr.startUtc, tr.endUtcExclusive])).rows[0].v;
      const got = welcomeFrom(v.cells, today, cov(v.todayCoverage), cov(v.coverage));
      const { todayCoverage, coverage, ...rest } = got;
      expect(rest).toEqual({
        today: ref.today, yesterday: ref.yesterday, todayTotals: ref.todayTotals,
        perDepartment: Object.fromEntries(WORK_TYPES.map((w) => [w, ref.perDepartment[w]])), mostImproved: ref.mostImproved, sparkline: ref.sparkline, teamTotalYesterday: ref.teamTotalYesterday,
      });
      expect(coverage.issueCounts).toEqual(ref.coverage.issueCounts);
      expect(coverage.notes).toEqual(ref.coverage.notes);
      expect(coverage.issueRows).toBe(ref.coverage.issues.length);
      expect(todayCoverage.issueCounts).toEqual(ref.todaySummary.coverage.issueCounts);
      expect(todayCoverage.notes).toEqual(ref.todaySummary.coverage.notes);
    });
  }
  it("non-vacuous: top workers, streaks, a most-improved and sparkline orders occur", () => {
    let tops = 0, streaks = 0, improved = 0, spark = 0;
    for (const today of TODAYS) {
      const range = welcomeRange(SITE, today);
      const ref = buildProductionWelcomeView(prepareProductionEvidence(fourFamilySnapshot(view, { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive }, { kind: "site" }, SITE, cutoff)), SITE, cutoff, today);
      tops += WORK_TYPES.filter((w) => ref.perDepartment[w].topWorker).length;
      streaks += WORK_TYPES.filter((w) => ref.perDepartment[w].streak > 1).length;
      improved += ref.mostImproved ? 1 : 0;
      spark += ref.sparkline.reduce((n, s) => n + s.orders, 0);
    }
    expect({ tops: tops > 0, streaks: streaks > 0, improved: improved > 0, spark: spark > 0 }).toEqual({ tops: true, streaks: true, improved: true, spark: true });
  });
});
