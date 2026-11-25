/**
 * Task 16: 0044 read SQL parity, offline (PGlite). The Task 11 fixtures are
 * saved as source rows, the REAL worker publishes a generation, and the SQL
 * aggregation over that generation's classified facts must equal the Task 11
 * TypeScript reference (referenceSummary) over the same frozen source, for
 * many windows (full days, partial days, multi-day), both audiences, and
 * staff/work-type display scopes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { imageToEvent } from "../../../api/_lib/production-reporting-reader";
import { productionEventAdmissibility } from "../../staging/reportingPublication";
import { REPORTING_RULE_VERSION, type ReportingAudience } from "../../../src/lib/domain/productionReporting";
import { projectReportingPartition, referenceSummary } from "../../../src/lib/domain/productionReportingProjection";
import type { ProductionEvidenceEvent, UtcWindow, WorkType } from "../../../src/lib/domain/productionCounts";
import { ANNA, BEN, CARL, history, randomHistory } from "../../fixtures/reporting-history";
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
  const rows = [...history(), ...randomHistory(7, 600)].filter((e) => e.location === SITE && productionEventAdmissibility(e as unknown as Record<string, unknown>, SITE).length === 0 && e.id !== "");
  // One order reworked under TWO different cases in the same window: distinct rework Orders are per (order, case).
  const rk = (id: string, type: string, caseId: string, hh: string) => ({ id, location: SITE, staff_id: ANNA, department: "framed", order_number: "R-9", line_sku: type === "line_verified" ? "INKA-KAN0566-A4-FB" : null, line_quantity: type === "line_verified" ? 1 : 99, event_type: type, created_at: `2026-01-13T${hh}:00:00.000000Z`, cs_case_id: caseId, parent_event_id: null }) as unknown as ProductionEvidenceEvent;
  rows.push(rk("rk-v1", "line_verified", "case-a", "09"), rk("rk-t1", "completed", "case-a", "10"), rk("rk-v2", "line_verified", "case-b", "11"), rk("rk-t2", "completed", "case-b", "12"));
  const seen = new Set<string>();
  for (const e of rows) {
    if (seen.has(e.id)) continue;
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

type Totals = { totals: { normal: { items: number | null; orders: number }; rework: { items: number | null; orders: number } }; byWorkType: Array<{ workType: WorkType; totals: { normal: { items: number; orders: number }; rework: { items: number; orders: number } } }>; coverage: { issueCounts: Record<string, number>; notes: Record<string, number>; issueRows: number; overflow: boolean } };
async function sqlTotals(audience: ReportingAudience, sel: UtcWindow, scope: { range: UtcWindow; staffIds?: string[]; workTypes?: WorkType[] }): Promise<Totals> {
  const r = await db.query<{ v: Totals }>("select reporting_private.sel_totals($1, $2, $3::uuid, $4::bigint, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::uuid[], $10::text[]) as v",
    [SITE, audience.kind, audience.kind === "self" ? audience.staffId : null, seq, sel.startUtc, sel.endUtcExclusive, scope.range.startUtc, scope.range.endUtcExclusive, scope.staffIds ?? null, scope.workTypes ?? null]);
  return r.rows[0].v;
}
function reference(audience: ReportingAudience, sel: UtcWindow, scope: { range: UtcWindow; staffIds?: string[]; workTypes?: WorkType[] }) {
  const events = audience.kind === "self" ? view.filter((e) => e.staff_id === audience.staffId) : view;
  const result = projectReportingPartition({ site: SITE, audience, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: cutoff, events });
  return referenceSummary(result, { selection: sel, scope, visibility: audience.kind === "site" ? { kind: "site" } : { kind: "limited", reason: "own work only" } });
}
const win = (a: string, b: string): UtcWindow => ({ startUtc: a, endUtcExclusive: b });
const WINDOWS: UtcWindow[] = [
  win("2026-01-12T04:00:00.000Z", "2026-01-13T04:00:00.000Z"),
  win("2026-01-10T04:00:00.000Z", "2026-01-20T04:00:00.000Z"),
  win("2026-01-12T09:15:00.000Z", "2026-01-12T17:45:00.000Z"),
  win("2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"),
  win("2026-01-14T04:00:00.000Z", "2026-01-15T04:00:00.000Z"),
  win("2026-01-20T10:00:00.000123Z", "2026-01-25T10:00:00.000456Z"),
];

describe("Task 16: 0044 range totals equal the Task 11 reference over the same published generation", () => {
  const audiences: ReportingAudience[] = [{ kind: "site" }, { kind: "self", staffId: ANNA }, { kind: "self", staffId: BEN }];
  for (const [wi, w] of WINDOWS.entries()) {
    for (const a of audiences) {
      for (const [si, scope] of [{ range: w }, { range: w, staffIds: [BEN] }, { range: w, workTypes: ["framed"] as WorkType[] }, { range: w, workTypes: ["dispatch"] as WorkType[], staffIds: [ANNA, CARL] }].entries()) {
        it(`window ${wi} · ${a.kind === "site" ? "site" : `self ${a.staffId.slice(0, 4)}`} · scope ${si}`, async () => {
          const ref = reference(a, w, scope);
          const got = await sqlTotals(a, w, scope);
          expect(got.totals).toEqual({ normal: { items: ref.normal.items, orders: ref.normal.orders }, rework: { items: ref.rework.items, orders: ref.rework.orders } });
          expect(Object.fromEntries(got.byWorkType.map((x) => [x.workType, x.totals]))).toEqual(Object.fromEntries(Object.entries(ref.byWorkType).map(([k, g]) => [k, { normal: { items: g.normal.items, orders: g.normal.orders }, rework: { items: g.rework.items, orders: g.rework.orders } }])));
          expect(got.coverage.issueCounts).toEqual(ref.coverage.issueCounts);
          expect(got.coverage.notes).toEqual(ref.coverage.notes);
          expect(got.coverage.issueRows).toBe(ref.coverage.issues.length);
        });
      }
    }
  }
  it("the fixture is non-vacuous: items, orders, rework, issues and notes all occur", async () => {
    const ref = reference({ kind: "site" }, WINDOWS[3], { range: WINDOWS[3] });
    expect(ref.normal.items).toBeGreaterThan(50);
    expect(ref.normal.orders).toBeGreaterThan(10);
    expect(ref.rework.orders).toBeGreaterThan(0);
    expect(Object.values(ref.coverage.issueCounts).filter((n) => n > 0).length).toBeGreaterThanOrEqual(3);
    expect(Object.values(ref.coverage.notes).filter((n) => n > 0).length).toBeGreaterThanOrEqual(2);
    const issues = (await db.query<{ n: number }>("select count(*)::int as n from reporting_private.source_issue_facts where site = $1 and valid_to_seq is null", [SITE])).rows[0].n;
    expect(issues).toBeGreaterThan(0); // malformed-identity source rows are present (selected-source-issue path)
    const r9 = reference({ kind: "site" }, WINDOWS[1], { range: WINDOWS[1] });
    expect(r9.orders.filter((o) => o.orderNumber === "R-9").map((o) => o.caseId).sort()).toEqual(["case-a", "case-b"]);
  });
});
