/**
 * Task 16: the 0044 Reports view (sel_report + the server SKU grouping) equals
 * the EXISTING app reducer (buildProductionReportView over the four-family
 * snapshot of the same source), offline in PGlite: tiles, page coverage,
 * leaderboard (staff-days), timing (selected-stream predecessors), active
 * staff, average, SKU board and the selected person's daily series.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { imageToEvent } from "../../../api/_lib/production-reporting-reader";
import { skuBoardFrom, type SkuTiming } from "../../../api/_lib/production-reporting-sku";
import { productionEventAdmissibility } from "../../staging/reportingPublication";
import { prepareProductionEvidence, type ProductionEvidenceEvent, type WorkType } from "../../../src/lib/domain/productionCounts";
import { productionRange } from "../../../src/lib/domain/productionPeriods";
import { buildProductionReportView } from "../../../src/lib/domain/productionReportView";
import type { ReportingAudience } from "../../../src/lib/domain/productionReporting";
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
  // A cancelled timing line between two of the same worker's lines: the stream must skip it (gap 20, not 10).
  const tl = (id: string, hhmm: string, type = "line_verified", parent: string | null = null) => ({ id, location: SITE, staff_id: ANNA, department: "framed", order_number: "T-1", line_sku: type === "line_verified" ? "INKA-KAN0566-A4-FB" : null, line_quantity: type === "line_verified" ? 1 : null, event_type: type, created_at: `2026-01-22T${hhmm}:00.000000Z`, cs_case_id: null, parent_event_id: parent }) as unknown as ProductionEvidenceEvent;
  const extra = [tl("tl-1", "09:00"), tl("tl-2", "09:10"), tl("tl-c", "09:15", "cancelled", "tl-2"), tl("tl-3", "09:20")];
  for (const e of [...history(), ...randomHistory(11, 700), ...extra]) {
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

interface SqlReport {
  totals: { normal: { items: number; orders: number }; rework: { items: number; orders: number } };
  byWorkType: Array<{ workType: WorkType; totals: { normal: { items: number; orders: number }; rework: { items: number; orders: number } } }>;
  coverage: { issueCounts: Record<string, number>; notes: Record<string, number> };
  activeStaff: number; staffDays: number; avgOrdersPerStaffDay: number;
  timing: { durationMin: number; timedWeight: number; avgMinPerUnit: number };
  people: Array<{ staffId: string; normal: { items: number; orders: number }; rework: { items: number; orders: number }; daysWorked: number; itemsPerDay: number; ordersPerDay: number; timing: { durationMin: number; timedWeight: number; avgMinPerUnit: number } }>;
  skuTiming: SkuTiming[];
  daily: Array<{ productionDate: string; totals: { normal: { items: number; orders: number }; rework: { items: number; orders: number } } }>;
}
const n = (v: unknown) => Number(v);
const close = (a: unknown, b: number) => expect(n(a)).toBeCloseTo(b, 9);

const RANGES: Array<[string, string]> = [["2026-01-12", "2026-01-12"], ["2026-01-10", "2026-01-20"], ["2026-01-01", "2026-01-31"], ["2026-01-14", "2026-01-16"], ["2026-01-22", "2026-01-22"]];
const AUDIENCES: ReportingAudience[] = [{ kind: "site" }, { kind: "self", staffId: ANNA }];
const FILTERS: Array<{ staffId: string | null; workType: WorkType | null }> = [{ staffId: null, workType: null }, { staffId: BEN, workType: null }, { staffId: null, workType: "framed" }, { staffId: ANNA, workType: "unframed" }];

describe("Task 16: 0044 Reports view equals the existing reducer over the same source", () => {
  for (const [first, last] of RANGES) for (const a of AUDIENCES) for (const f of FILTERS) {
    it(`${first}..${last} · ${a.kind === "site" ? "site" : "self ANNA"} · staff ${f.staffId?.slice(0, 4) ?? "-"} · ${f.workType ?? "all"}`, async () => {
      const range = productionRange(SITE, first, last);
      const source = a.kind === "self" ? view.filter((e) => e.staff_id === a.staffId) : view;
      const snap = fourFamilySnapshot(source, { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive }, a.kind === "site" ? { kind: "site" } : { kind: "limited", reason: "own work only" }, SITE, cutoff);
      const ref = buildProductionReportView(prepareProductionEvidence(snap), { range, staffId: f.staffId, workType: f.workType });
      const got = (await db.query<{ v: SqlReport }>("select reporting_private.sel_report($1, $2, $3::uuid, $4::bigint, $5::timestamptz, $6::timestamptz, $7::date, $8::date, $9::uuid, $10) as v",
        [SITE, a.kind, a.kind === "self" ? a.staffId : null, seq, range.startUtc, range.endUtcExclusive, first, last, f.staffId, f.workType])).rows[0].v;
      const io = (g: { items: number | null; orders: number }) => ({ items: g.items, orders: g.orders });
      expect({ normal: { items: n(got.totals.normal.items), orders: n(got.totals.normal.orders) }, rework: { items: n(got.totals.rework.items), orders: n(got.totals.rework.orders) } }).toEqual({ normal: io(ref.summary.normal), rework: io(ref.summary.rework) });
      expect(Object.fromEntries(got.byWorkType.map((x) => [x.workType, { normal: { items: n(x.totals.normal.items), orders: n(x.totals.normal.orders) }, rework: { items: n(x.totals.rework.items), orders: n(x.totals.rework.orders) } }]))).toEqual(Object.fromEntries(Object.entries(ref.summary.byWorkType).map(([k, g]) => [k, { normal: io(g.normal), rework: io(g.rework) }])));
      expect(got.coverage.issueCounts).toEqual(ref.coverage.issueCounts);
      expect(got.coverage.notes).toEqual(ref.coverage.notes);
      expect(n(got.activeStaff)).toBe(ref.activeStaff);
      expect(n(got.staffDays)).toBe(ref.staffDays);
      close(got.avgOrdersPerStaffDay, ref.avgOrdersPerStaffDay);
      close(got.timing.durationMin, ref.timing.durationMin);
      close(got.timing.timedWeight, ref.timing.timedWeight);
      close(got.timing.avgMinPerUnit, ref.timing.avgMinPerUnit);
      expect(got.people.map((p) => p.staffId)).toEqual(ref.leaderboard.map((p) => p.staffId));
      for (const [i, p] of got.people.entries()) {
        const r = ref.leaderboard[i];
        expect({ normal: { items: n(p.normal.items), orders: n(p.normal.orders) }, rework: { items: n(p.rework.items), orders: n(p.rework.orders) }, daysWorked: n(p.daysWorked) }).toEqual({ normal: io(r.normal), rework: io(r.rework), daysWorked: r.daysWorked });
        close(p.itemsPerDay, r.itemsPerDay);
        close(p.ordersPerDay, r.ordersPerDay);
        close(p.timing.durationMin, r.timing.durationMin);
        close(p.timing.timedWeight, r.timing.timedWeight);
      }
      const board = skuBoardFrom(got.skuTiming.map((s) => ({ sku: s.sku, durationMin: n(s.durationMin), weight: n(s.weight) })));
      expect(board.map((b) => b.sku)).toEqual(ref.skuBoard.map((b) => b.sku));
      for (const [i, b] of board.entries()) close(b.avgMin, ref.skuBoard[i].avgMin);
      if (f.staffId) expect(got.daily.map((d) => [d.productionDate, n(d.totals.normal.items), n(d.totals.normal.orders), n(d.totals.rework.items), n(d.totals.rework.orders)]))
        .toEqual(ref.personDaily!.map((d) => [d.date, d.normal.items, d.normal.orders, d.rework.items, d.rework.orders]));
      expect(got.daily.map((d) => d.productionDate)).toEqual(Array.from({ length: got.daily.length }, (_, i) => new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)));
    });
  }
  it("non-vacuous: timing, SKU board and several people occur", async () => {
    const range = productionRange(SITE, "2026-01-01", "2026-01-31");
    const ref = buildProductionReportView(prepareProductionEvidence(fourFamilySnapshot(view, { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive }, { kind: "site" }, SITE, cutoff)), { range });
    expect(ref.timing.timedWeight).toBeGreaterThan(0);
    expect(ref.skuBoard.length).toBeGreaterThan(0);
    expect(ref.leaderboard.length).toBeGreaterThanOrEqual(3);
  });
});

describe("Task 16: the SQL tie-break key is JavaScript's UTF-16 order", () => {
  it("utf16_key sorts like JS `<` (non-BMP vs U+E000-U+FFFF differs from code-point/UTF-8 order)", async () => {
    const ids = ["dr-\u{1F600}", "dr-�", "dr-", "dr-a", "dr-", "dr-é", "dr-\u{10000}", "dr-\u{10FFFF}", "DR-Z"];
    const js = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const r = await db.query<{ id: string }>("select id from unnest($1::text[]) id order by reporting_private.utf16_key(id)", [ids]);
    expect(r.rows.map((x) => x.id)).toEqual(js);
    const c = await db.query<{ id: string }>('select id from unnest($1::text[]) id order by id collate "C"', [ids]);
    expect(c.rows.map((x) => x.id)).not.toEqual(js); // bytewise order really differs here: the key matters
  });
});
