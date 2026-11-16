/**
 * Task 16 end to end, offline: real worker publication → real 0044 public RPCs
 * (read_reporting_generation / read_reporting_summary) → rpcPublishedReader
 * (strict DTO validation) → readPublishedSummary. Includes the review's
 * two-valid-quantities overflow fixture: two individually valid Items values
 * whose sum exceeds Number.MAX_SAFE_INTEGER must surface as the overflow null
 * in every aggregate that contains both (never a rounded number), with Orders
 * exact.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { readPublishedSummary, type ReportingPrincipal } from "../../../api/_lib/production-reporting";
import { rpcPublishedReader } from "../../../api/_lib/production-reporting-rpc";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const W3 = "33333333-3333-4333-8333-333333333333";
let db: PGlite;
const owner: ReportingPrincipal = { userId: W1, role: "owner", nav: new Set(["reports", "welcome"]), sites: new Set(["uk"]) };
const staff: ReportingPrincipal = { userId: W2, role: "staff", nav: new Set(["reports", "welcome"]), sites: new Set(["uk"]) };
const REQ = { site: "uk" as const, firstDate: "2026-02-10", lastDate: "2026-02-12", view: "reports" as const };

beforeAll(async () => {
  db = await reportingDb();
  await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [W1, W2, W3]);
  const ins = (id: string, staffId: string, type: string, order: string, at: string) =>
    db.query("insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at) values ('uk',$1,$2,'framed',$3,$4,$5,$6,'s','',$7)",
      [id, staffId, order, type === "line_verified" ? "INKA-KAN0566-A4-FB" : null, type === "line_verified" ? 1 : 99, type, at]);
  await ins("v1", W1, "line_verified", "O-1", "2026-02-11T09:00:00Z");
  await ins("v2", W1, "line_verified", "O-1", "2026-02-11T09:10:00Z");
  await ins("t1", W1, "completed", "O-1", "2026-02-11T09:20:00Z");
  await ins("v3", W2, "line_verified", "O-2", "2026-02-11T10:00:00Z");
  await ins("t2", W2, "completed", "O-2", "2026-02-11T10:05:00Z");
  // W3 verifies two lines on 2026-02-12 and completes NO order: an Items-only worked day
  await ins("v4", W3, "line_verified", "O-3", "2026-02-12T09:00:00Z");
  await ins("v5", W3, "line_verified", "O-3", "2026-02-12T09:05:00Z");
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true });
  const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: "uk", mode: "rebuild" });
  if (r.state !== "published") throw new Error(r.problems.join("; "));
  await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: "summary", p_processor_enabled: null });
}, 120_000);
afterAll(async () => db?.close());

const read = (p: ReportingPrincipal, req = REQ) => readPublishedSummary(p, req, { reader: rpcPublishedReader(pgRpc(db)), now: () => Date.now(), cursorSecret: "s" });

describe("Task 16: the published summary through the real SQL and the real API layer", () => {
  it("returns exact totals, one pinned generation and the derived audience", async () => {
    const s = await read(owner);
    expect(s.totals).toEqual({ normal: { items: 5, orders: 2 }, rework: { items: 0, orders: 0 } });
    expect(s.byWorkType.find((w) => w.workType === "framed")!.totals.normal).toEqual({ items: 5, orders: 2 });
    expect(s.dailyPage.rows.map((d) => [d.productionDate, d.totals.normal.items])).toEqual([["2026-02-10", 0], ["2026-02-11", 3], ["2026-02-12", 2]]);
    expect(s.peoplePage.totalRows).toBe(3);
    expect(s.staffDays).toBe(3); // W1, W2 and W3 each worked one day
    expect(s.meta.visibility).toEqual({ kind: "site" });
    const self = await read(staff);
    expect(self.totals.normal).toEqual({ items: 1, orders: 1 });
    expect(self.meta.visibility).toEqual({ kind: "limited", reason: "own work only" });
    expect(self.coverage.incomplete).toBe(true);
  }, 60_000);
  it("Welcome comes back from the same generation through the same path", async () => {
    const w = await read(owner, { ...REQ, view: "welcome", firstDate: "2026-02-03", lastDate: "2026-02-11" });
    expect(w.welcome?.today).toBe("2026-02-11");
    expect(w.welcome?.todayTotals.normal).toEqual({ items: 3, orders: 2 });
    expect(w.welcome?.perDepartment.framed.topWorker).toMatchObject({ orders: 1 });
    expect(w.peoplePage.rows).toEqual([]);
  }, 60_000);
  it("two individually valid Items values whose sum exceeds 2^53-1 surface as the overflow null everywhere they meet; Orders stay exact", async () => {
    await db.query("update reporting_private.event_facts set items = 9007199254740990 where site = 'uk' and event_id = 'v1' and audience_kind = 'site'");
    await db.query("update reporting_private.event_facts set items = 5 where site = 'uk' and event_id = 'v2' and audience_kind = 'site'");
    const s = await read(owner);
    expect(s.totals.normal).toEqual({ items: null, orders: 2 });
    expect(s.byWorkType.find((w) => w.workType === "framed")!.totals.normal).toEqual({ items: null, orders: 2 });
    expect(s.dailyPage.rows.find((d) => d.productionDate === "2026-02-11")!.totals.normal).toEqual({ items: null, orders: 2 });
    const p1 = s.peoplePage.rows.find((p) => p.staffId === W1)!;
    expect(p1.normal).toEqual({ items: null, orders: 1 });
    expect(p1.itemsPerDay).toBe(9007199254740995); // rates use the raw exact sum (planner T16 rule), not the overflow null
    expect(s.peoplePage.rows.find((p) => p.staffId === W2)!.normal).toEqual({ items: 1, orders: 1 }); // the other person is unaffected
    expect(s.coverage.incomplete).toBe(true); // overflow makes the coverage incomplete
    const w = await read(owner, { ...REQ, view: "welcome", firstDate: "2026-02-03", lastDate: "2026-02-11" });
    expect(w.welcome?.todayTotals.normal).toEqual({ items: null, orders: 2 });
  }, 60_000);
  it("an overflow-only worked day (no completed order) still counts in daysWorked and staffDays; Items surface null", async () => {
    await db.query("update reporting_private.event_facts set items = 9007199254740990 where site = 'uk' and event_id = 'v4' and audience_kind = 'site'");
    await db.query("update reporting_private.event_facts set items = 5 where site = 'uk' and event_id = 'v5' and audience_kind = 'site'");
    const s = await read(owner);
    const p3 = s.peoplePage.rows.find((p) => p.staffId === W3)!;
    expect(p3.normal).toEqual({ items: null, orders: 0 });
    expect(p3.daysWorked).toBe(1); // raw credit 9007199254740995 > 0: a worked day even though its Items overflow
    expect(s.staffDays).toBe(3);
    expect(s.dailyPage.rows.find((d) => d.productionDate === "2026-02-12")!.totals.normal).toEqual({ items: null, orders: 0 });
    expect(s.peoplePage.rows.map((p) => p.staffId)[2]).toBe(W3); // ordering: Orders desc first (0 orders last), raw Items next
    const solo = await read(owner, { ...REQ, staffId: W3 });
    expect([solo.staffDays, solo.activeStaff]).toEqual([1, 1]);
  }, 60_000);
  it("the SQL refuses a forged window, a wrong-site generation and a malformed audience", async () => {
    const c = pgRpc(db);
    const gen = (await db.query<{ g: string }>("select generation_id::text as g from reporting_private.generations where site = 'uk' and state = 'published'")).rows[0].g;
    const base = { p_site: "uk", p_audience_kind: "site", p_audience_staff: null, p_generation: gen, p_first_date: "2026-02-10", p_last_date: "2026-02-12", p_start: "2026-02-10T04:00:00Z", p_end: "2026-02-13T04:00:00Z", p_staff: null, p_work_type: null, p_view: "reports", p_daily_limit: 10, p_people_limit: 10 };
    expect((await c.rpc("read_reporting_summary", base)).error).toBeNull();
    expect((await c.rpc("read_reporting_summary", { ...base, p_start: "2026-01-01T00:00:00Z" })).error?.message).toMatch(/window does not match/);
    expect((await c.rpc("read_reporting_summary", { ...base, p_site: "au", p_start: "2026-02-09T17:00:00Z", p_end: "2026-02-12T17:00:00Z" })).error?.message).toMatch(/not a retained complete publication/);
    expect((await c.rpc("read_reporting_summary", { ...base, p_audience_kind: "self" })).error?.message).toMatch(/needs its staff/);
    expect((await c.rpc("read_reporting_summary", { ...base, p_audience_staff: W1 })).error?.message).toMatch(/site audience has no staff/);
    expect((await pgRpc(db, { role: "authenticated" }).rpc("read_reporting_summary", base)).error?.message).toMatch(/permission denied/);
  }, 60_000);
});
