/**
 * Task 16, SQL slice 1 (offline, real 0037–0044 SQL in PGlite): public.read_reporting_detail for the
 * `days` and `people` kinds. The worker publishes a real generation; detail pages are read as
 * service_role and must continue the summary's own order with SQL-bounded rows, exact total_rows,
 * `more` and `last`, and no gap or repeat across pages. Malformed continuations, limits and selectors
 * are refused; anon/authenticated cannot execute the function.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { rpcPublishedReader } from "../../../api/_lib/production-reporting-rpc";
import type { ReaderScope } from "../../../api/_lib/production-reporting";
import { productionRange } from "../../../src/lib/domain/productionPeriods";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const W = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
const FIRST = "2026-02-01";
const LAST = "2026-02-10"; // 10 production dates
let db: PGlite;
let gen = "";
const range = productionRange("uk", FIRST, LAST);

beforeAll(async () => {
  db = await reportingDb();
  await db.query(`insert into auth.users (id) values ${W.map((_, i) => `($${i + 1})`).join(", ")}`, W);
  const ins = (id: string, staff: string, type: string, order: string, at: string) =>
    db.query("insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at) values ('uk',$1,$2,'framed',$3,$4,$5,$6,'s','',$7)",
      [id, staff, order, type === "line_verified" ? "INKA-KAN0566-A4-FB" : null, type === "line_verified" ? 1 : null, type, at]);
  // Orders per worker 3,2,2,1,1 (two ties: W2/W3 and W4/W5, broken by raw Items then staff id), spread over days 2..8
  const orders = [3, 2, 2, 1, 1];
  let n = 0;
  for (const [w, count] of orders.entries()) {
    for (let k = 0; k < count; k++, n++) {
      const day = `2026-02-0${2 + (n % 7)}`;
      const o = `O-${w}-${k}`;
      await ins(`v-${w}-${k}`, W[w], "line_verified", o, `${day}T09:${String(10 + k).padStart(2, "0")}:00Z`);
      if (w === 2) await ins(`v2-${w}-${k}`, W[w], "line_verified", o, `${day}T09:${String(30 + k).padStart(2, "0")}:00Z`); // W3 has more Items than W2
      await ins(`t-${w}-${k}`, W[w], "completed", o, `${day}T10:${String(10 + k).padStart(2, "0")}:00Z`);
    }
  }
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true });
  const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: "uk", mode: "rebuild" });
  if (r.state !== "published") throw new Error(r.problems.join("; "));
  gen = (await db.query<{ g: string }>("select generation_id::text as g from reporting_private.generations where site = 'uk' and state = 'published'")).rows[0].g;
}, 180_000);
afterAll(async () => db?.close());

const base = () => ({ p_site: "uk", p_audience_kind: "site", p_audience_staff: null, p_generation: gen, p_first_date: FIRST, p_last_date: LAST, p_start: range.startUtc, p_end: range.endUtcExclusive, p_staff: null, p_work_type: null });
interface Page { rows: Array<Record<string, any>>; last: number | null; more: boolean; total_rows: number }
const detail = async (kind: string, after: unknown, limit: number, extra: Record<string, unknown> = {}) => {
  const r = await pgRpc(db).rpc("read_reporting_detail", { ...base(), p_kind: kind, p_order: null, p_after: after, p_limit: limit, ...extra });
  return r as { data: Page | null; error: { message: string } | null };
};
const ok = async (kind: string, after: unknown, limit: number, extra: Record<string, unknown> = {}) => {
  const r = await detail(kind, after, limit, extra);
  expect(r.error).toBeNull();
  return r.data!;
};
/** The summary's own full lists (limits 1,000): what every detail sequence must reproduce exactly. */
const summary = async (extra: Record<string, unknown> = {}) => {
  const r = await pgRpc(db).rpc("read_reporting_summary", { ...base(), p_view: "reports", p_daily_limit: 1000, p_people_limit: 1000, ...extra });
  expect(r.error).toBeNull();
  return (r.data as { report: { daily: { rows: unknown[]; total: number }; people: { rows: Array<{ staffId: string }>; total: number } } }).report;
};
/** Follow `last` from offset 0 to the end; return every page. */
const walk = async (kind: string, limit: number, extra: Record<string, unknown> = {}) => {
  const pages: Page[] = [];
  let after: unknown = null;
  for (let i = 0; i < 50; i++) {
    const p = await ok(kind, after, limit, extra);
    pages.push(p);
    if (!p.more) break;
    after = p.last;
  }
  return pages;
};

describe("Task 16 slice 1: read_reporting_detail days and people over the real SQL", () => {
  it("days: pages of 3 continue by offset with no gap or repeat, exact total_rows/more/last, equal to the summary's series", async () => {
    const pages = await walk("days", 3);
    expect(pages.map((p) => p.rows.length)).toEqual([3, 3, 3, 1]);
    expect(pages.map((p) => p.more)).toEqual([true, true, true, false]);
    expect(pages.map((p) => p.last)).toEqual([3, 6, 9, 10]);
    expect(pages.every((p) => p.total_rows === 10)).toBe(true);
    const dates = pages.flatMap((p) => p.rows.map((r) => r.productionDate));
    expect(dates).toEqual(Array.from({ length: 10 }, (_, i) => `2026-02-${String(i + 1).padStart(2, "0")}`)); // consecutive, no gap/repeat
    expect(pages.flatMap((p) => p.rows)).toEqual((await summary()).daily.rows);
    // a page that exactly reaches the end has more = false; the next offset is past the end: empty, last null
    expect(await ok("days", 7, 3)).toMatchObject({ more: false, last: 10, total_rows: 10 });
    expect(await ok("days", 10, 3)).toEqual({ rows: [], last: null, more: false, total_rows: 10 });
    expect(await ok("days", 25, 3)).toEqual({ rows: [], last: null, more: false, total_rows: 10 });
  }, 120_000);
  it("people: pages of 2 continue the summary's leaderboard order (Orders desc, raw Items desc, staff id) exactly", async () => {
    const full = (await summary()).people;
    expect(full.total).toBe(5);
    expect(full.rows.map((p) => p.staffId)).toEqual([W[0], W[2], W[1], W[3], W[4]]); // ties broken by Items (W3 > W2), then id (W4 < W5)
    const pages = await walk("people", 2);
    expect(pages.map((p) => [p.rows.length, p.more, p.last, p.total_rows])).toEqual([[2, true, 2, 5], [2, true, 4, 5], [1, false, 5, 5]]);
    const ids = pages.flatMap((p) => p.rows.map((r) => r.staffId));
    expect(new Set(ids).size).toBe(ids.length); // no repeat
    expect(pages.flatMap((p) => p.rows)).toEqual(full.rows); // no gap: the same rows in the same order
    // page 2 continues exactly where the summary's first page of 2 stops
    const first = (await summary({ p_people_limit: 2 })).people;
    expect(first.rows).toEqual(pages[0].rows);
    expect((await ok("people", first.rows.length, 2)).rows).toEqual(pages[1].rows);
  }, 120_000);
  it("the API reader parses the real pages strictly and the sequence is complete", async () => {
    const reader = rpcPublishedReader(pgRpc(db));
    const scope: ReaderScope = { site: "uk", audience: { kind: "site" }, generationId: gen, firstDate: FIRST, lastDate: LAST, startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive, staffId: null, workType: null };
    const p1 = await reader.detail(scope, "people", null, null, 2);
    const p2 = await reader.detail(scope, "people", null, p1.last, 2);
    const p3 = await reader.detail(scope, "people", null, p2.last, 2);
    expect([p1.more, p2.more, p3.more, p3.totalRows]).toEqual([true, true, false, 5]);
    expect([...p1.rows, ...p2.rows, ...p3.rows].map((r) => (r.row as { staffId: string }).staffId)).toEqual([W[0], W[2], W[1], W[3], W[4]]);
    const d = await reader.detail(scope, "days", null, 8, 5);
    expect(d.rows.map((r) => (r.row as { productionDate: string }).productionDate)).toEqual(["2026-02-09", "2026-02-10"]);
  }, 120_000);
  it("the filters and audience are the summary's: a staff filter narrows days, a self audience sees only itself", async () => {
    const days = await walk("days", 4, { p_staff: W[0] });
    expect(days.flatMap((p) => p.rows)).toEqual((await summary({ p_staff: W[0] })).daily.rows);
    const self = await ok("people", null, 10, { p_audience_kind: "self", p_audience_staff: W[1] });
    expect([self.total_rows, self.rows.map((r) => r.staffId)]).toEqual([1, [W[1]]]);
    const typed = await ok("people", null, 10, { p_work_type: "dispatch" });
    expect([typed.total_rows, typed.rows]).toEqual([0, []]);
  }, 120_000);
  it("refuses malformed continuations, limits, selectors and kinds", async () => {
    for (const after of [-1, 1.5, "3", [1], { a: 1 }, true, 2 ** 53]) {
      for (const kind of ["days", "people"]) expect((await detail(kind, after, 3)).error?.message).toMatch(/continuation must be a non-negative integer offset/);
    }
    for (const limit of [0, 1001, -5, null]) expect((await detail("days", null, limit as number)).error?.message).toMatch(/p_limit must be 1\.\.1000/);
    for (const kind of ["days", "people"]) expect((await detail(kind, null, 3, { p_order: "O-0-0" })).error?.message).toMatch(/order selector does not apply/);
    expect((await detail("everything", null, 3)).error?.message).toMatch(/unsupported kind/);
    expect((await detail("days", null, 3, { p_start: "2026-01-01T00:00:00Z" })).error?.message).toMatch(/read_reporting_detail: the window does not match/);
    expect((await detail("days", null, 3, { p_audience_kind: "self" })).error?.message).toMatch(/needs its staff/);
    expect((await detail("days", null, 3, { p_work_type: "paint" })).error?.message).toMatch(/unsupported work type/);
    expect((await detail("days", null, 3, { p_generation: "99999999-9999-4999-8999-999999999999" })).error?.message).toMatch(/not a retained complete publication/);
  }, 120_000);
  it("only service_role may execute it (anon and authenticated are denied; PUBLIC has nothing)", async () => {
    const sig = "public.read_reporting_detail(text, text, uuid, uuid, date, date, timestamptz, timestamptz, uuid, text, text, text, jsonb, integer)";
    const can = async (role: string) => (await db.query<{ ok: boolean }>(`select has_function_privilege($1, '${sig}', 'EXECUTE') as ok`, [role])).rows[0].ok;
    expect([await can("service_role"), await can("anon"), await can("authenticated")]).toEqual([true, false, false]);
    const acl = (await db.query<{ acl: string[] | null }>(`select p.proacl::text[] as acl from pg_proc p where p.oid = '${sig}'::regprocedure`)).rows[0].acl ?? [];
    expect(acl.some((a) => a.startsWith("=X"))).toBe(false); // no PUBLIC execute
    for (const role of ["anon", "authenticated"]) {
      const r = await pgRpc(db, { role }).rpc("read_reporting_detail", { ...base(), p_kind: "days", p_order: null, p_after: null, p_limit: 3 });
      expect(r.error?.message).toMatch(/permission denied/);
    }
  }, 120_000);
});
