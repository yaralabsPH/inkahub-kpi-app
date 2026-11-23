/**
 * F9 frame timing end to end, offline: real publication -> real 0058
 * read_frame_timing_rows (pinned generation, sel_eval, source_versions) ->
 * readFrameTiming; and the owner-only weight RPCs (immutable versions,
 * optimistic concurrency, role checks).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import type { ReportingPrincipal } from "../../../api/_lib/production-reporting";
import { rpcPublishedReader } from "../../../api/_lib/production-reporting-rpc";
import { readFrameTiming } from "../../../api/_lib/frame-timing";
import { readReportsOverview } from "../../../api/_lib/reports-overview";
import { addDepartmentSnapshotColumns, reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const OWNER = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const MGR = "33333333-3333-4333-8333-333333333333";
const DA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RID = "0123456789abcdef0123456789abcdef";
const A3 = "INKA-ABC0003-A3-FN";
const A2 = "INKA-ABC0002-A2-FB";
const UN = "INKA-HIG0207-A3-UN";
const owner: ReportingPrincipal = { userId: OWNER, role: "owner", nav: new Set(["reports", "welcome"]), sites: new Set(["uk"]) };
const staff: ReportingPrincipal = { userId: W2, role: "staff", nav: new Set(["reports", "welcome"]), sites: new Set(["uk"]) };
const REQ = { site: "uk", firstDate: "2026-02-10", lastDate: "2026-02-10" };
let db: PGlite;
let gen1 = "";

async function ins(id: string, staffId: string, type: string, at: string, sku: string | null = null, qty: number | null = null, dept = "framed", parent: string | null = null) {
  await db.query(
    `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id,
       business_department_id, business_department_name, business_department_status)
     values ('uk',$1,$2,$3,$4,$5,$6,$7,'s','',$8,$9,$10,'Framing','assigned')`,
    [id, staffId, dept, type.startsWith("clock") ? null : "O-1", sku, qty, type, at, parent, DA],
  );
}
async function publish() {
  const c = pgRpc(db);
  const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: "uk", mode: "rebuild" });
  if (r.state !== "published") throw new Error(r.problems.join("; "));
}
const asUser = async (uid: string | null, sql: string, params: unknown[]) =>
  db.transaction(async (tx) => {
    await tx.query("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid ?? ""]);
    return (await tx.query<{ r: Record<string, unknown> }>(sql, params)).rows[0].r;
  });

beforeAll(async () => {
  db = await reportingDb();
  await addDepartmentSnapshotColumns(db);
  await db.exec(`CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, role text NOT NULL);`);
  await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [OWNER, W2, MGR]);
  await db.query("insert into public.profiles values ($1,'owner'), ($2,'staff'), ($3,'manager')", [OWNER, W2, MGR]);
  // W2, 2026-02-10 UK: clock 08:00-15:30 (450 min). 09:00 classic A3; 09:03 one shared capture with two lines
  // (2 + 1 pieces): 3 min over 3 pieces; 09:10 UN breaks the chain; 09:12 A3 untimed; 09:20 A3 timed 8 min;
  // 09:25 A2 verified then cancelled (ignored); 09:28 A2 timed 8 min (09:20 -> 09:28).
  await ins("ci", W2, "clock_in", "2026-02-10T08:00:00Z");
  await ins("v1", W2, "line_verified", "2026-02-10T09:00:00Z", A3, 1);
  await ins(`scn-${RID}-v01`, W2, "line_verified", "2026-02-10T09:03:00Z", A3, 2);
  await ins(`scn-${RID}-v02`, W2, "line_verified", "2026-02-10T09:03:00Z", A2, 1);
  await ins("u1", W2, "line_verified", "2026-02-10T09:10:00Z", UN, 1, "unframed");
  await ins("v3", W2, "line_verified", "2026-02-10T09:12:00Z", A3, 1);
  await ins("v4", W2, "line_verified", "2026-02-10T09:20:00Z", A3, 1);
  await ins("v5", W2, "line_verified", "2026-02-10T09:25:00Z", A2, 1);
  await ins("x5", W2, "cancelled", "2026-02-10T09:26:00Z", A2, 1, "framed", "v5");
  await ins("v6", W2, "line_verified", "2026-02-10T09:28:00Z", A2, 1);
  await ins("co", W2, "clock_out", "2026-02-10T15:30:00Z");
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true });
  await publish();
  await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: "summary", p_processor_enabled: null });
  gen1 = (await db.query<{ g: string }>("select generation_id::text as g from reporting_private.generations where site = 'uk' and state = 'published'")).rows[0].g;
}, 180_000);
afterAll(async () => db?.close());

const deps = () => ({ reader: rpcPublishedReader(pgRpc(db)), rpc: pgRpc(db), now: () => Date.now() });
const timing = (p: ReportingPrincipal, q: Record<string, unknown>) => readFrameTiming(p, q, deps());
const g = (b: Awaited<ReturnType<typeof timing>>, key: string) => b.groups.find((x) => x.key === key && !x.rework)!;

describe("F9 timing over the real SQL", () => {
  it("measured gaps: one shared capture, breaks, cancellation; pinned to the overview's generation", async () => {
    const o = await readReportsOverview(owner, REQ, deps());
    const t = await timing(owner, { ...REQ, generationId: o.meta.generationId });
    expect(t.meta.generationId).toBe(o.meta.generationId);
    expect(t.meta.sourceCutoffUtc).toBe(o.meta.sourceCutoffUtc);
    const a3 = g(t, "A3-FN");
    expect(a3.pieces).toBe(1 + 2 + 1 + 1);
    expect(a3.timedPieces).toBe(2 + 1); // shared capture's 2 pieces + 09:20
    expect(a3.measuredMinutes).toBeCloseTo(2 + 8);
    const a2 = g(t, "A2-FB");
    expect(a2.pieces).toBe(2); // the cancelled v5 is not framing credit
    expect(a2.measuredMinutes).toBeCloseTo(1 + 8);
    expect(t.groups.some((x) => x.key.endsWith("-UN"))).toBe(false);
    expect(t.weights).toBeNull();
    expect(t.coverage.missingWeightPieces).toBe(2); // v1, v3 unmeasured with no weights: unavailable, not zero
  }, 60_000);

  it("staff timing is their own stream; a forged person, kiosk and a missing/foreign generation are refused", async () => {
    const self = await timing(staff, { ...REQ, generationId: gen1 });
    expect(self.request.staffId).toBe(W2);
    expect(self.coverage.framePieces).toBe(7);
    await expect(timing(staff, { ...REQ, generationId: gen1, staffId: OWNER })).rejects.toMatchObject({ status: 403 });
    await expect(timing({ ...owner, role: "kiosk" }, { ...REQ, generationId: gen1 })).rejects.toMatchObject({ status: 403 });
    await expect(timing(owner, REQ)).rejects.toMatchObject({ status: 400 });
    await expect(timing(owner, { ...REQ, generationId: "99999999-9999-4999-8999-999999999999" })).rejects.toMatchObject({ status: 410 });
    expect((await pgRpc(db, { role: "authenticated" }).rpc("read_frame_timing_rows", { p_site: "uk", p_audience_kind: "site", p_audience_staff: null, p_generation: gen1, p_first_date: "2026-02-10", p_last_date: "2026-02-10", p_start: "2026-02-10T04:00:00Z", p_end: "2026-02-11T04:00:00Z", p_row_limit: 10 })).error?.message).toMatch(/permission denied/);
    expect((await pgRpc(db).rpc("read_frame_timing_rows", { p_site: "uk", p_audience_kind: "site", p_audience_staff: null, p_generation: gen1, p_first_date: "2026-02-10", p_last_date: "2026-02-10", p_start: "2026-02-10T04:00:00Z", p_end: "2026-02-11T04:00:00Z", p_row_limit: 5 })).error?.message).toMatch(/rows exceed the limit 5/);
  }, 60_000);

  it("owner-only weights: blank by default, immutable versions, optimistic conflict; estimates use the saved version", async () => {
    const read = (uid: string | null) => asUser(uid, "select public.read_frame_timing_weights('uk') as r", []);
    const save = (uid: string | null, expected: number, w: unknown) => asUser(uid, "select public.save_frame_timing_weights('uk', $1, $2::jsonb) as r", [expected, JSON.stringify(w)]);
    expect(await read(OWNER)).toMatchObject({ version: 0, weights: {} });
    await expect(read(MGR)).rejects.toThrow(/owner_only/);
    await expect(read(W2)).rejects.toThrow(/owner_only/);
    await expect(read(null)).rejects.toThrow(/not_signed_in/);
    await expect(save(MGR, 0, { A3: 1 })).rejects.toThrow(/owner_only/);
    for (const bad of [{}, { A9: 1 }, { A3: 0 }, { A3: -2 }, { A3: 1001 }, { A3: "1" }]) await expect(save(OWNER, 0, bad)).rejects.toThrow(/invalid_weights/);
    expect(await save(OWNER, 0, { A3: 1, A2: 2 })).toMatchObject({ version: 1 });
    await expect(save(OWNER, 0, { A3: 5 })).rejects.toThrow(/version_conflict/); // a stale form never overwrites
    expect(await save(OWNER, 1, { A3: 1, A2: 1 })).toMatchObject({ version: 2 });
    await expect(db.query("update public.frame_timing_weight_versions set weights = '{}' where version = 1")).rejects.toThrow(/immutable/);
    await expect(db.query("delete from public.frame_timing_weight_versions")).rejects.toThrow(/immutable/);
    await expect(asUser(OWNER, "select count(*)::int as r from public.frame_timing_weight_versions", [])).rejects.toThrow(/permission denied/);
    const t = await timing(owner, { ...REQ, generationId: gen1 });
    expect(t.weights).toEqual({ version: 2, weights: { A3: 1, A2: 1 } });
    // shift 450 min -> 405 productive - 19 measured = 386, split over the unmeasured v1 and v3 (A3, weight 1 each)
    expect(g(t, "A3-FN").estimatedPieces).toBe(2);
    expect(g(t, "A3-FN").estimatedMinutes).toBeCloseTo(386);
    expect(g(t, "A3-FN").measuredMinutes).toBeCloseTo(10); // unchanged: never blended
  }, 60_000);
});
