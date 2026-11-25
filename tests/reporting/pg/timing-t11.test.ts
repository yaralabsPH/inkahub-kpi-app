/**
 * Review T11-1 over the real SQL (PGlite): sel_timing decides "in range" by MILLISECOND, exactly as the
 * app's frameTimingLines/referenceTimingLines (`Date.parse` of the range bounds), while the SELECTION of
 * evidence stays exact. At a sub-millisecond selection start:
 *   1. a predecessor saved microseconds before the start (same millisecond) that is NOT selected
 *      evidence is not in the stream;
 *   2. the same-millisecond predecessor IS in the stream when it is selected context evidence.
 * Public reads only ever use whole-minute production-day windows; this pins the shared function itself.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { prepareProductionEvidence, type ProductionEvidenceEvent } from "../../../src/lib/domain/productionCounts";
import { frameTimingLines } from "../../../src/lib/domain/productionFrameTiming";
import { fourFamilySnapshot } from "../../fixtures/reporting-history";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const A = "11111111-1111-4111-8111-111111111111";
const ev = (id: string, order: string, at: string, type = "line_verified") =>
  ({ id, location: "uk", staff_id: A, department: "framed", order_number: order, line_sku: type === "line_verified" ? "INKA-KAN0566-A4-FB" : null, line_quantity: type === "line_verified" ? 1 : null, event_type: type, created_at: at, cs_case_id: null, parent_event_id: null }) as unknown as ProductionEvidenceEvent;
// case 1: t11-p (order 5200) is not selected evidence; case 2: t11-q (order 5201) is selected context (its order completes in range)
const SRC = [
  ev("t11-p", "5200", "2026-01-14T10:00:00.000100Z"),
  ev("t11-q", "5201", "2026-01-14T10:00:00.000200Z"),
  ev("t11-m", "5201", "2026-01-14T10:10:00.000000Z"),
  ev("t11-c", "5201", "2026-01-14T10:20:00.000000Z", "completed"),
];
const SEL = { startUtc: "2026-01-14T10:00:00.000500Z", endUtcExclusive: "2026-01-15T04:00:00.000000Z" };
let db: PGlite;
let seq = "";
let cutoff = "";

beforeAll(async () => {
  db = await reportingDb();
  await db.query("insert into auth.users (id) values ($1)", [A]);
  for (const e of SRC) {
    await db.query("insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at) values ('uk',$1,$2,'framed',$3,$4,$5,$6,'s','',$7)",
      [e.id, e.staff_id, e.order_number, e.line_sku, e.line_quantity, e.event_type, e.created_at]);
  }
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true });
  const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: "uk", mode: "rebuild" });
  if (r.state !== "published") throw new Error(r.problems.join("; "));
  const g = (await db.query<{ s: string; c: string }>("select generation_seq::text as s, to_char(source_cutoff at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as c from reporting_private.generations where state = 'published'")).rows[0];
  [seq, cutoff] = [g.s, g.c];
}, 120_000);
afterAll(async () => db?.close());

const sqlLines = async (sel: { startUtc: string; endUtcExclusive: string }) =>
  (await db.query<{ e: string; d: string; s: string }>(
    "select event_id as e, duration_min::text as d, to_char(started_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as s from reporting_private.sel_timing('uk', 'site', null, $1::bigint, $2::timestamptz, $3::timestamptz, $2::timestamptz, $3::timestamptz, null) order by completed_at, event_id",
    [seq, sel.startUtc, sel.endUtcExclusive])).rows.map((r) => [r.e, Number(r.d), r.s]);
const reference = (src: ProductionEvidenceEvent[], sel: { startUtc: string; endUtcExclusive: string }) =>
  frameTimingLines(prepareProductionEvidence(fourFamilySnapshot(src, sel, { kind: "site" }, "uk", cutoff)), { range: sel }).map((l) => [l.eventId, l.durationMin]);

describe("review T11-1: sel_timing's range is the app's millisecond range over the exact selection", () => {
  it("the reference itself: t11-p is excluded (not selected), t11-q is in the stream (selected context, same millisecond)", () => {
    expect(reference(SRC, SEL)).toEqual([["t11-q", 0], ["t11-m", 10]]);
  });
  it("sel_timing equals the reference at the sub-millisecond selection, with exact predecessor instants", async () => {
    expect((await sqlLines(SEL)).map(([e, d]) => [e, d])).toEqual(reference(SRC, SEL));
    expect(await sqlLines(SEL)).toEqual([["t11-q", 0, "2026-01-14T10:00:00.000200Z"], ["t11-m", 10, "2026-01-14T10:00:00.000200Z"]]);
  });
  it("case 1 alone (no selected context for t11-q's order): neither early line is in the stream, the first in-range line has zero gap", async () => {
    // a selection that ends before the completion: t11-q is no longer selected context
    const sel = { startUtc: SEL.startUtc, endUtcExclusive: "2026-01-14T10:15:00.000000Z" };
    expect((await sqlLines(sel)).map(([e, d]) => [e, d])).toEqual(reference(SRC, sel));
    expect((await sqlLines(sel)).map(([e, d]) => [e, d])).toEqual([["t11-m", 0]]);
  });
  it("the end bound is also by millisecond: a line microseconds past a sub-millisecond end in the same millisecond is excluded, as in the app", async () => {
    const sel = { startUtc: "2026-01-14T09:00:00.000000Z", endUtcExclusive: "2026-01-14T10:00:00.000150Z" };
    expect((await sqlLines(sel)).map(([e, d]) => [e, d])).toEqual(reference(SRC, sel));
  });
});
