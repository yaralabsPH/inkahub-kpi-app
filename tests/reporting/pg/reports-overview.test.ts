/**
 * F8 Reports v2 end to end, offline: real worker publication -> real 0057
 * read_reports_overview (over 0044 checked_generation/sel_eval and
 * source_versions at the same sequence) -> readReportsOverview.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import type { ReportingPrincipal } from "../../../api/_lib/production-reporting";
import { rpcPublishedReader } from "../../../api/_lib/production-reporting-rpc";
import { readReportsOverview } from "../../../api/_lib/reports-overview";
import { overviewCsv } from "../../../src/lib/domain/reportsOverview";
import { addDepartmentSnapshotColumns, reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const W3 = "33333333-3333-4333-8333-333333333333";
const DA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SET3 = "INKA-S3WIL0049-A3-FN";
const FB = "INKA-KAN0566-A4-FB";
const UN = "INKA-HIG0207-A3-UN";
const owner: ReportingPrincipal = { userId: W1, role: "owner", nav: new Set(["reports", "welcome"]), sites: new Set(["uk"]) };
const staff2: ReportingPrincipal = { userId: W2, role: "staff", nav: new Set(["reports", "welcome"]), sites: new Set(["uk"]) };
const REQ = { site: "uk", firstDate: "2026-02-10", lastDate: "2026-02-11" };
let db: PGlite;

type Ev = { id: string; staff: string; dept: string; type: string; order: string; sku?: string | null; qty?: number | null; at: string; parent?: string; cs?: string; bd?: { id: string | null; name: string | null; status: string } };
async function ins(e: Ev) {
  await db.query(
    `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id, cs_case_id,
       business_department_id, business_department_name, business_department_status)
     values ('uk',$1,$2,$3,$4,$5,$6,$7,'s','',$8,$9,$10,$11,$12,$13)`,
    [e.id, e.staff, e.dept, e.order, e.sku ?? null, e.qty ?? null, e.type, e.at, e.parent ?? null, e.cs ?? null, e.bd?.id ?? null, e.bd?.name ?? null, e.bd?.status ?? null],
  );
}
const A1 = { id: DA, name: "Framing", status: "assigned" };
const B_OLD = { id: DB, name: "Mount", status: "assigned" };
const B_NEW = { id: DB, name: "Mounting", status: "assigned" };

beforeAll(async () => {
  db = await reportingDb();
  await addDepartmentSnapshotColumns(db);
  await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [W1, W2, W3]);
  // Day 1 (2026-02-10, UK from 04:00): W1 in department A frames O-1 (a set of 3 = 3 Items) and completes it.
  await ins({ id: "v1", staff: W1, dept: "framed", type: "line_verified", order: "O-1", sku: SET3, qty: 1, at: "2026-02-10T09:00:00Z", bd: A1 });
  await ins({ id: "t1", staff: W1, dept: "framed", type: "completed", order: "O-1", qty: 1, at: "2026-02-10T09:05:00Z", bd: A1 });
  // A verified line that is cancelled: no credit.
  await ins({ id: "v2", staff: W1, dept: "framed", type: "line_verified", order: "O-2", sku: FB, qty: 2, at: "2026-02-10T10:00:00Z", bd: A1 });
  await ins({ id: "x2", staff: W1, dept: "framed", type: "cancelled", order: "O-2", sku: FB, qty: 2, at: "2026-02-10T10:01:00Z", parent: "v2", bd: A1 });
  // W2 in department B (then named "Mount"): unframed UN print, 2 Items, order O-3.
  await ins({ id: "v3", staff: W2, dept: "unframed", type: "line_verified", order: "O-3", sku: UN, qty: 2, at: "2026-02-10T11:00:00Z", bd: B_OLD });
  await ins({ id: "t3", staff: W2, dept: "unframed", type: "completed", order: "O-3", qty: 2, at: "2026-02-10T11:05:00Z", bd: B_OLD });
  // Day 2: W1 has MOVED to department B (renamed "Mounting") and completes O-1 again (same identity: one period Order).
  await ins({ id: "v4", staff: W1, dept: "framed", type: "line_verified", order: "O-1", sku: FB, qty: 1, at: "2026-02-11T09:00:00Z", bd: B_NEW });
  await ins({ id: "t4", staff: W1, dept: "framed", type: "completed", order: "O-1", qty: 1, at: "2026-02-11T09:05:00Z", bd: B_NEW });
  // CS rework by W2 (case C-1), separate from normal work.
  await ins({ id: "v5", staff: W2, dept: "framed", type: "line_verified", order: "O-4", sku: FB, qty: 1, at: "2026-02-11T10:00:00Z", cs: "C-1", bd: B_NEW });
  await ins({ id: "t5", staff: W2, dept: "framed", type: "completed", order: "O-4", qty: 1, at: "2026-02-11T10:05:00Z", cs: "C-1", bd: B_NEW });
  // W3 unassigned: a shared-scanner style dispatch with no line scans (no framing credit, Unknown department).
  await ins({ id: "dsp-1-d", staff: W3, dept: "dispatch", type: "dispatched", order: "O-1", qty: 4, at: "2026-02-11T15:00:00Z", bd: { id: null, name: null, status: "unassigned" } });
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true });
  const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: "uk", mode: "rebuild" });
  if (r.state !== "published") throw new Error(r.problems.join("; "));
  await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: "summary", p_processor_enabled: null });
}, 120_000);
afterAll(async () => db?.close());

const deps = () => ({ reader: rpcPublishedReader(pgRpc(db)), rpc: pgRpc(db), now: () => Date.now() });
const read = (p: ReportingPrincipal, q: Record<string, unknown> = REQ) => readReportsOverview(p, q, deps());

describe("F8 overview over the real SQL", () => {
  it("whole-period Orders are distinct identities, not a sum of days; set/UN Items; cancellation gives no credit; rework apart", async () => {
    const o = await read(owner);
    // normal: O-1 (W1 framed, twice), O-3 (W2 unframed), O-1 dispatch -> distinct (order, case) identities: O-1, O-3
    expect(o.totals.normal).toEqual({ items: 3 + 2 + 1, orders: 2 });
    expect(o.totals.rework).toEqual({ items: 1, orders: 1 });
    expect(o.daily.map((d) => [d.productionDate, d.normal.items, d.normal.orders])).toEqual([["2026-02-10", 5, 2], ["2026-02-11", 1, 1]]);
    const sumOfDays = o.daily.reduce((s, d) => s + d.normal.orders, 0);
    expect(sumOfDays).toBe(3); // the daily trend would over-count: the period figure is the distinct 2
    const w1 = o.people.find((p) => p.staffId === W1)!;
    expect(w1.normal).toEqual({ items: 4, orders: 1 }); // O-1 completed on both days = one Order for the period
    const w3 = o.people.find((p) => p.staffId === W3)!;
    expect(w3.normal).toEqual({ items: 0, orders: 1 }); // dispatch: an Order, no invented Items
    expect(o.meta.generationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(o.meta.sourceCutoffUtc).toBeTruthy();
  }, 60_000);

  it("departments are the event's RECORDED department: a move splits credit, a rename keeps one id with both names, no snapshot is Unknown", async () => {
    const o = await read(owner);
    const byId = new Map(o.departments.map((d) => [d.departmentId, d]));
    expect(byId.get(DA)!.normal).toEqual({ items: 3, orders: 1 }); // W1's day-1 work stays in A after the move
    expect(byId.get(DA)!.names).toEqual(["Framing"]);
    const b = byId.get(DB)!;
    expect(b.names).toEqual(["Mounting", "Mount"]); // most recent first
    expect(b.normal).toEqual({ items: 2 + 1, orders: 2 }); // W2's O-3 and W1's day-2 O-1
    expect(b.rework).toEqual({ items: 1, orders: 1 });
    expect(byId.get(null)!.normal).toEqual({ items: 0, orders: 1 }); // Unknown: W3's dispatch
    expect(o.departments.at(-1)!.departmentId).toBeNull(); // Unknown listed last
    // department filter (recorded id) and Unknown filter
    const onlyA = await read(owner, { ...REQ, departmentId: DA });
    expect(onlyA.totals.normal).toEqual({ items: 3, orders: 1 });
    expect(onlyA.people.map((p) => p.staffId)).toEqual([W1]);
    const unknown = await read(owner, { ...REQ, departmentId: "unknown" });
    expect(unknown.people.map((p) => p.staffId)).toEqual([W3]);
  }, 60_000);

  it("staff see only their own work; a forged person is refused before any read; kiosk is refused", async () => {
    const self = await read(staff2);
    expect(self.people.map((p) => p.staffId)).toEqual([W2]);
    expect(self.totals.normal).toEqual({ items: 2, orders: 1 });
    expect(self.request.staffId).toBe(W2);
    expect(self.meta.visibility).toEqual({ kind: "limited", reason: "own work only" });
    await expect(read(staff2, { ...REQ, staffId: W1 })).rejects.toMatchObject({ status: 403 });
    await expect(read({ ...owner, role: "kiosk", userId: W3 })).rejects.toMatchObject({ status: 403 });
    await expect(read({ ...owner, role: "cs", nav: new Set(["cs_cases", "welcome"]) })).rejects.toMatchObject({ status: 403 });
    const cs = await read({ ...owner, role: "cs", nav: new Set(["cs_cases", "welcome", "reports"]) });
    expect(cs.totals.normal.orders).toBe(2);
    await expect(read({ ...owner, sites: new Set(["au"]) })).rejects.toMatchObject({ status: 403 }); // manager/owner without that site
  }, 60_000);

  it("work type filter and the summary CSV match what is shown, with formula prefixes neutralised", async () => {
    const o = await read(owner, { ...REQ, workType: "unframed" });
    expect(o.totals.normal).toEqual({ items: 2, orders: 1 });
    const csv = overviewCsv(o, { person: (id) => (id === W2 ? "=HYPERLINK(evil)" : id) });
    expect(csv).toContain("work_type,unframed");
    expect(csv).toContain(`generation,${o.meta.generationId}`);
    expect(csv).toContain("total,,Whole period,2,1,0,0");
    expect(csv).toContain(`person,${W2},'=HYPERLINK(evil),2,1,0,0`);
    expect(csv).toContain("department,bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb,Mount,2,1,0,0");
  }, 60_000);

  it("the SQL bounds dates, groups and departments, and is service-only", async () => {
    const c = pgRpc(db);
    const gen = (await db.query<{ g: string }>("select generation_id::text as g from reporting_private.generations where site = 'uk' and state = 'published'")).rows[0].g;
    const base = { p_site: "uk", p_audience_kind: "site", p_audience_staff: null, p_generation: gen, p_first_date: "2026-02-10", p_last_date: "2026-02-11", p_start: "2026-02-10T04:00:00Z", p_end: "2026-02-12T04:00:00Z", p_staff: null, p_work_type: null, p_department: null, p_group_limit: 10 };
    expect((await c.rpc("read_reports_overview", base)).error).toBeNull();
    expect((await c.rpc("read_reports_overview", { ...base, p_group_limit: 2 })).error?.message).toMatch(/3 people exceed the limit 2/);
    expect((await c.rpc("read_reports_overview", { ...base, p_group_limit: 0 })).error?.message).toMatch(/group limit/);
    expect((await c.rpc("read_reports_overview", { ...base, p_department: "x';--" })).error?.message).toMatch(/unsupported department/);
    expect((await c.rpc("read_reports_overview", { ...base, p_start: "2026-01-01T00:00:00Z" })).error?.message).toMatch(/window does not match/);
    expect((await c.rpc("read_reports_overview", { ...base, p_first_date: "2024-01-01", p_start: "2024-01-01T04:00:00Z" })).error?.message).toMatch(/at most 731/);
    expect((await pgRpc(db, { role: "authenticated" }).rpc("read_reports_overview", base)).error?.message).toMatch(/permission denied/);
    await expect(read(owner, { ...REQ, firstDate: "2024-01-01" })).rejects.toMatchObject({ status: 400 });
  }, 60_000);
});

describe("F8 overview with more than 1,000 source events", () => {
  let big: PGlite;
  beforeAll(async () => {
    big = await reportingDb();
    await addDepartmentSnapshotColumns(big);
    await big.query("insert into auth.users (id) values ($1), ($2)", [W1, W2]);
    // 1,200 orders, each one verified line + one completion (2,400 events) over two production days.
    await big.query(
      `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at,
         business_department_id, business_department_name, business_department_status)
       select 'uk', 'v' || g, case when g % 2 = 0 then $1::uuid else $2::uuid end, 'framed', 'B-' || g, $3, 1, 'line_verified', 's', '',
              timestamptz '2026-02-10 05:00:00Z' + (g || ' seconds')::interval * 60, $4::uuid, 'Framing', 'assigned'
         from generate_series(1, 1200) g
       union all
       select 'uk', 't' || g, case when g % 2 = 0 then $1::uuid else $2::uuid end, 'framed', 'B-' || g, null, 1, 'completed', 's', '',
              timestamptz '2026-02-10 05:00:30Z' + (g || ' seconds')::interval * 60, $4::uuid, 'Framing', 'assigned'
         from generate_series(1, 1200) g`,
      [W1, W2, FB, DA],
    );
    const c = pgRpc(big);
    await c.rpc("set_reporting_capture", { p_enabled: true });
    await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true });
    for (let i = 0; i < 20; i++) {
      const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: "uk", mode: "rebuild" });
      if (r.state === "published") break;
      if (r.state !== "pending") throw new Error(`${r.state}: ${r.problems.join("; ")}`);
    }
    await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: "summary", p_processor_enabled: null });
  }, 300_000);
  afterAll(async () => big?.close());

  it("aggregates every event server-side: exact totals, no 1,000-row truncation", async () => {
    const o = await readReportsOverview(owner, REQ, { reader: rpcPublishedReader(pgRpc(big)), rpc: pgRpc(big), now: () => Date.now() });
    expect(o.totals.normal).toEqual({ items: 1200, orders: 1200 });
    expect(o.people.map((p) => p.normal.orders).sort()).toEqual([600, 600]);
    expect(o.departments).toHaveLength(1);
    expect(o.daily.reduce((s, d) => s + (d.normal.items ?? 0), 0)).toBe(1200);
  }, 120_000);
});
