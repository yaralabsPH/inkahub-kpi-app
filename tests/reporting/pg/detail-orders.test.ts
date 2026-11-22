/**
 * Task 16, SQL slice 2 (offline, real 0037–0044 SQL in PGlite): read_reporting_detail `orders`.
 * Every paged sequence must equal the EXISTING app grouping (summarizeProduction's orders over the
 * four-family snapshot of the same source and scope): the same overall keys in the same UTF-16 order,
 * caseId/group, Items and completion, with no gap or repeat across pages, exact totals, `more` and
 * `last`. Handcrafted orders pin the remaining DTO fields (work types, verified lines, first/last
 * instants), a rework case, the order selector and UTF-16 (not bytewise) key order.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { imageToEvent } from "../../../api/_lib/production-reporting-reader";
import { rpcPublishedReader } from "../../../api/_lib/production-reporting-rpc";
import type { ReaderScope } from "../../../api/_lib/production-reporting";
import { productionEventAdmissibility } from "../../staging/reportingPublication";
import { prepareProductionEvidence, summarizeProduction, type ProductionEvidenceEvent, type WorkType } from "../../../src/lib/domain/productionCounts";
import { productionRange } from "../../../src/lib/domain/productionPeriods";
import { ANNA, BEN, CARL, fourFamilySnapshot, history, randomHistory } from "../../fixtures/reporting-history";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const SITE = "uk";
const FIRST = "2026-01-01";
const LAST = "2026-01-31";
const range = productionRange(SITE, FIRST, LAST);
let db: PGlite;
let gen = "";
let cutoff = "";
let view: ProductionEvidenceEvent[] = [];

const mk = (id: string, staff: string, department: string, order: string, type: string, at: string, o: Partial<ProductionEvidenceEvent> = {}) =>
  ({ id, location: SITE, staff_id: staff, department, order_number: order, line_sku: type === "line_verified" ? "INKA-KAN0566-A4-FB" : null, line_quantity: type === "line_verified" ? 1 : null, event_type: type, created_at: at, cs_case_id: null, parent_event_id: null, ...o }) as unknown as ProductionEvidenceEvent;
const HAND = [
  // UTF-16 order puts the surrogate pair (U+D83D…) before U+FF21; bytewise UTF-8 order is the reverse
  mk("zz-e1", ANNA, "framed", "Z-\u{1F600}", "line_verified", "2026-01-25T09:00:00.000000Z"),
  mk("zz-e2", ANNA, "framed", "Z-Ａ", "line_verified", "2026-01-25T09:01:00.000000Z"),
  // one order across three work types and people, then completed at dispatch
  mk("zz-m1", ANNA, "framed", "Z-MIX", "line_verified", "2026-01-25T10:00:00.123456Z", { line_quantity: 2 }),
  mk("zz-m2", BEN, "unframed", "Z-MIX", "line_verified", "2026-01-25T10:05:00.000000Z"),
  mk("zz-m3", CARL, "dispatch", "Z-MIX", "dispatched", "2026-01-25T10:30:00.654321Z"),
  // the same order number as a separate rework case
  mk("zz-r1", ANNA, "framed", "Z-MIX", "line_verified", "2026-01-25T11:00:00.000000Z", { cs_case_id: "C9" }),
];
const EXPECT_MIX = {
  key: "uk|Z-MIX", orderNumber: "Z-MIX", caseId: null, group: "normal", firstAtUtc: "2026-01-25T10:00:00.123456Z", lastAtUtc: "2026-01-25T10:30:00.654321Z",
  workTypes: ["framed", "unframed", "dispatch"], verifiedLines: 2, items: 3, completed: true,
};

beforeAll(async () => {
  db = await reportingDb();
  for (const u of [ANNA, BEN, CARL]) await db.query("insert into auth.users (id) values ($1)", [u]);
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: null, p_processor_enabled: true });
  const seen = new Set<string>();
  for (const e of [...history(), ...randomHistory(11, 700), ...HAND]) {
    if (e.location !== SITE || e.id === "" || seen.has(e.id) || productionEventAdmissibility(e as unknown as Record<string, unknown>, SITE).length) continue;
    seen.add(e.id);
    await db.query("insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id) values ($1,$2,$3,$4,$5,$6,$7,$8,'s','',$9,$10,$11)",
      [SITE, e.id, e.staff_id, e.department, e.order_number, e.line_sku, e.line_quantity, e.event_type, e.created_at, e.cs_case_id, e.parent_event_id]);
  }
  const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: SITE, mode: "rebuild" });
  if (r.state !== "published") throw new Error(r.problems.join("; "));
  const g = (await db.query<{ g: string; c: string }>("select generation_id::text as g, to_char(source_cutoff at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as c from reporting_private.generations where site = 'uk' and state = 'published'")).rows[0];
  gen = g.g;
  cutoff = g.c;
  view = (await db.query<{ img: unknown }>("select to_jsonb(pe) as img from public.production_events pe where pe.location = 'uk'")).rows.map((x) => imageToEvent(x.img, SITE));
}, 300_000);
afterAll(async () => db?.close());

interface Page { rows: Array<Record<string, any>>; last: string | null; more: boolean; total_rows: number }
const base = (o: Record<string, unknown> = {}) => ({ p_site: SITE, p_audience_kind: "site", p_audience_staff: null, p_generation: gen, p_first_date: FIRST, p_last_date: LAST, p_start: range.startUtc, p_end: range.endUtcExclusive, p_staff: null, p_work_type: null, p_kind: "orders", p_order: null, p_after: null, p_limit: 25, ...o });
const call = (o: Record<string, unknown>) => pgRpc(db).rpc("read_reporting_detail", base(o)) as Promise<{ data: Page | null; error: { message: string } | null }>;
const ok = async (o: Record<string, unknown>) => {
  const r = await call(o);
  expect(r.error).toBeNull();
  return r.data!;
};
const walk = async (o: Record<string, unknown>, limit: number) => {
  const pages: Page[] = [];
  let after: string | null = null;
  for (let i = 0; i < 100; i++) {
    const p = await ok({ ...o, p_after: after, p_limit: limit });
    pages.push(p);
    if (!p.more) break;
    after = p.last;
  }
  return pages;
};
/** The app's own order grouping for one audience and display scope. */
const reference = (audience: { kind: "site" } | { kind: "self"; staffId: string }, staffId: string | null, workType: WorkType | null) => {
  const source = audience.kind === "self" ? view.filter((e) => e.staff_id === audience.staffId) : view;
  const snap = fourFamilySnapshot(source, { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive }, audience.kind === "site" ? { kind: "site" } : { kind: "limited", reason: "own work only" }, SITE, cutoff);
  return summarizeProduction(prepareProductionEvidence(snap), { range, ...(staffId ? { staffIds: [staffId] } : {}), ...(workType ? { workTypes: [workType] } : {}) }).orders;
};
const comparable = (r: Record<string, any>) => ({ key: r.key, orderNumber: r.orderNumber, caseId: r.caseId, group: r.group, items: r.items, completed: r.completed });

describe("Task 16 slice 2: read_reporting_detail orders over the real SQL", () => {
  const SCOPES: Array<[string, Record<string, unknown>, { kind: "site" } | { kind: "self"; staffId: string }, string | null, WorkType | null]> = [
    ["site, everyone", {}, { kind: "site" }, null, null],
    ["site, staff BEN", { p_staff: BEN }, { kind: "site" }, BEN, null],
    ["site, work type framed", { p_work_type: "framed" }, { kind: "site" }, null, "framed"],
    ["site, work type dispatch", { p_work_type: "dispatch" }, { kind: "site" }, null, "dispatch"],
    ["self ANNA", { p_audience_kind: "self", p_audience_staff: ANNA }, { kind: "self", staffId: ANNA }, null, null],
    ["self ANNA, work type unframed", { p_audience_kind: "self", p_audience_staff: ANNA, p_work_type: "unframed" }, { kind: "self", staffId: ANNA }, null, "unframed"],
  ];
  for (const [name, o, audience, staffId, workType] of SCOPES) {
    it(`${name}: pages of 7 equal the app's orders exactly (keys, order, case, Items, completion; no gap or repeat)`, async () => {
      const ref = reference(audience, staffId, workType);
      const pages = await walk(o, 7);
      const rows = pages.flatMap((p) => p.rows);
      expect(rows.map(comparable)).toEqual(ref.map((r) => ({ key: r.key, orderNumber: r.orderNumber, caseId: r.caseId, group: r.group, items: r.items, completed: r.completed })));
      expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
      for (const [i, p] of pages.entries()) {
        expect(p.total_rows).toBe(ref.length);
        expect(p.more).toBe(i < pages.length - 1);
        expect(p.last).toBe(p.rows.length ? p.rows[p.rows.length - 1].key : null);
        if (p.more) expect(p.rows.length).toBe(7);
      }
      if (name === "site, everyone") expect(pages.length).toBeGreaterThanOrEqual(3); // non-vacuous: several pages
    }, 120_000);
  }
  it("the DTO fields aggregate the contributing events exactly (work types, verified lines, Items, first/last instants)", async () => {
    const [mix, rework] = (await ok({ p_order: "Z-MIX" })).rows;
    expect(mix).toEqual(EXPECT_MIX);
    expect(rework).toEqual({ key: "uk|Z-MIX|case:C9", orderNumber: "Z-MIX", caseId: "C9", group: "rework", firstAtUtc: "2026-01-25T11:00:00.000000Z", lastAtUtc: "2026-01-25T11:00:00.000000Z", workTypes: ["framed"], verifiedLines: 1, items: 1, completed: false });
  }, 120_000);
  it("p_order narrows to that order number (trimmed) without weakening staff, work type or audience", async () => {
    expect(await ok({ p_order: "  Z-MIX\t" })).toEqual(await ok({ p_order: "Z-MIX" }));
    const p = await ok({ p_order: "Z-MIX" });
    expect([p.total_rows, p.more, p.last, p.rows.map((r) => r.key)]).toEqual([2, false, "uk|Z-MIX|case:C9", ["uk|Z-MIX", "uk|Z-MIX|case:C9"]]);
    expect((await ok({ p_order: "Z-MIX", p_staff: BEN })).rows).toEqual([{ ...EXPECT_MIX, firstAtUtc: "2026-01-25T10:05:00.000000Z", lastAtUtc: "2026-01-25T10:05:00.000000Z", workTypes: ["unframed"], verifiedLines: 1, items: 1, completed: false }]);
    expect((await ok({ p_order: "Z-MIX", p_work_type: "dispatch" })).rows).toEqual([{ ...EXPECT_MIX, firstAtUtc: "2026-01-25T10:30:00.654321Z", workTypes: ["dispatch"], verifiedLines: 0, items: 0 }]);
    const self = await ok({ p_order: "Z-MIX", p_audience_kind: "self", p_audience_staff: CARL });
    expect(self.rows).toEqual([{ ...EXPECT_MIX, firstAtUtc: "2026-01-25T10:30:00.654321Z", workTypes: ["dispatch"], verifiedLines: 0, items: 0 }]);
    expect(await ok({ p_order: "NO-SUCH-ORDER" })).toEqual({ rows: [], last: null, more: false, total_rows: 0 });
  }, 120_000);
  it("keys are in UTF-16 order (the app's `<`), not bytewise; continuation is strictly after p_after", async () => {
    const keys = (await walk({}, 1000)).flatMap((p) => p.rows.map((r) => r.key as string));
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(keys.indexOf("uk|Z-\u{1F600}")).toBeLessThan(keys.indexOf("uk|Z-Ａ")); // surrogate pair < U+FF21 in UTF-16
    expect(Buffer.compare(Buffer.from("uk|Z-\u{1F600}"), Buffer.from("uk|Z-Ａ"))).toBe(1); // …and the opposite bytewise
    const after = await ok({ p_after: "uk|Z-MIX", p_limit: 1000 });
    expect(after.rows.map((r) => r.key)).toEqual(keys.filter((k) => k > "uk|Z-MIX"));
    expect(after.total_rows).toBe(keys.length); // the total never depends on the page
  }, 120_000);
  it("the API reader parses the real pages strictly and the continued sequence is complete", async () => {
    const reader = rpcPublishedReader(pgRpc(db));
    const scope: ReaderScope = { site: SITE, audience: { kind: "site" }, generationId: gen, firstDate: FIRST, lastDate: LAST, startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive, staffId: null, workType: null };
    const all: string[] = [];
    let after: unknown = null;
    for (let i = 0; i < 100; i++) {
      const p = await reader.detail(scope, "orders", null, after, 9);
      all.push(...p.rows.map((r) => (r.row as { key: string }).key));
      if (!p.more) break;
      after = p.last;
    }
    expect(all).toEqual(reference({ kind: "site" }, null, null).map((r) => r.key));
    const mix = await reader.detail(scope, "orders", "Z-MIX", null, 1);
    expect(mix).toMatchObject({ rows: [{ kind: "orders", row: EXPECT_MIX }], last: "uk|Z-MIX", more: true, totalRows: 2 });
  }, 120_000);
  it("refuses malformed continuations and blank order selectors", async () => {
    for (const after of [5, "", ["uk|O-1"], { k: 1 }, true]) expect((await call({ p_after: after })).error?.message).toMatch(/orders continuation must be an order key/);
    for (const order of ["", "   ", " \t"]) expect((await call({ p_order: order })).error?.message).toMatch(/order selector is blank/);
    expect((await call({ p_limit: 0 })).error?.message).toMatch(/p_limit must be 1\.\.1000/);
  }, 120_000);
});
