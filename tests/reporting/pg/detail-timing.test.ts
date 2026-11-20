/**
 * Task 16, SQL slice 5 (offline, real 0037–0044 SQL in PGlite): read_reporting_detail `timing`.
 * Every paged sequence is compared to an INDEPENDENT oracle: the app's frameTimingLines over the
 * four-family snapshot of the same source (self isolation before selection; the work type narrows the
 * stream BEFORE predecessors; staff and order narrow the output only AFTER), with the exact source
 * microseconds of each line and of its stream predecessor, and the app's millisecond duration.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { rpcPublishedReader } from "../../../api/_lib/production-reporting-rpc";
import type { ReaderScope } from "../../../api/_lib/production-reporting";
import { exactInstant, prepareProductionEvidence, type ProductionEvidenceEvent, type WorkType } from "../../../src/lib/domain/productionCounts";
import { frameTimingLines } from "../../../src/lib/domain/productionFrameTiming";
import { productionRange } from "../../../src/lib/domain/productionPeriods";
import { fourFamilySnapshot } from "../../fixtures/reporting-history";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SITE = "uk";
const DAY = "2026-01-11";
const range = productionRange(SITE, DAY, DAY); // [04:00Z, next 04:00Z)
const FB = "INKA-KAN0566-A4-FB";
const UN = "INKA-KAN0566-A4-UN"; // a timing-stream line of weight 0

type Row = ProductionEvidenceEvent & { station_id: string; note: string };
const t = (hms: string, us = 0) => `${DAY}T${hms}.${String(us).padStart(6, "0")}Z`;
const v = (id: string, created_at: string, o: Partial<Row> = {}): Row =>
  ({ id, location: SITE, staff_id: A, department: "framed", order_number: "O-1", line_sku: FB, line_quantity: 1, event_type: "line_verified", created_at, cs_case_id: null, parent_event_id: null, station_id: "s", note: "", ...o }) as Row;
const SRC: Row[] = [
  // a predecessor just before the window, which is ALSO selected context (its order completes in the window): never in the stream
  v("a-0", "2026-01-11T03:59:59.999900Z"),
  v("o1-done", t("09:05:00"), { event_type: "completed", line_sku: null, line_quantity: null }),
  // first in range: zero gap; a same-instant line: zero gap (gap must be > 0)
  v("a-1", t("09:00:00", 1)), v("a-2", t("09:00:00", 1)),
  // 10 minutes; exactly 30 minutes (timed); 35 minutes (> 30: zero); weight 0 (zero)
  v("a-3", t("09:10:00", 123456), { order_number: "O-2" }), v("a-4", t("09:40:00", 123456), { order_number: "O-2" }),
  v("a-5", t("10:15:00"), { order_number: "O-3" }), v("a-6", t("10:20:00"), { order_number: "O-3", line_sku: UN }),
  // a cancelled line is not effective: never a line, never a predecessor
  v("a-7", t("10:25:00"), { order_number: "O-4" }), v("c-7", t("10:26:00"), { event_type: "cancelled", line_sku: null, line_quantity: null, parent_event_id: "a-7", order_number: "O-4" }),
  // an unframed line: in the all-types stream, not in the framed one (changes a-9's predecessor)
  v("a-8", t("10:30:00"), { order_number: "O-5", department: "unframed" }), v("a-9", t("10:40:00"), { order_number: "O-5" }),
  // a same-instant pair whose ids UTF-16 and bytewise order disagree on
  v("t-\u{1F600}", t("11:00:00")), v("t-Ａ", t("11:00:00")),
  // another worker: a same-instant line with A's first, then a run for paging
  v("b-0", t("09:00:00", 1), { staff_id: B, order_number: "O-B" }),
  ...Array.from({ length: 10 }, (_, i) => v(`b-${String(i + 1).padStart(2, "0")}`, t(`12:${String(i * 2).padStart(2, "0")}:00`, i), { staff_id: B, order_number: i < 5 ? "O-B" : "O-2", department: i % 4 === 3 ? "unframed" : "framed" })),
  // outside the window at the end
  v("a-late", "2026-01-12T04:00:00.000000Z"),
];
const SRC2 = SRC.filter((r) => r.id !== "a-3"); // generation 2: a-3 deleted (a-4's predecessor changes)

let db: PGlite;
let gen1 = "";
let gen2 = "";
let cut1 = "";
let cut2 = "";
const insert = (r: Row) =>
  db.query("insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id) values ('uk',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [r.id, r.staff_id, r.department, r.order_number, r.line_sku, r.line_quantity, r.event_type, r.station_id, r.note, r.created_at, r.cs_case_id, r.parent_event_id]);
const cycle = async (mode: "rebuild" | "refresh") => {
  const r = await runReportingCycle({ client: pgRpc(db), now: () => Date.now(), sleep: async () => undefined }, { site: SITE, mode });
  if (r.state !== "published") throw new Error(`${mode}: ${r.state} ${r.problems.join("; ")}`);
  return (await db.query<{ g: string; c: string }>("select generation_id::text as g, to_char(source_cutoff at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as c from reporting_private.generations where site = 'uk' and state = 'published'")).rows[0];
};

beforeAll(async () => {
  db = await reportingDb();
  await db.query("insert into auth.users (id) values ($1), ($2)", [A, B]);
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: null, p_processor_enabled: true });
  for (const r of SRC) await insert(r);
  ({ g: gen1, c: cut1 } = await cycle("rebuild"));
  await db.query("delete from public.production_events where location = 'uk' and id = 'a-3'");
  ({ g: gen2, c: cut2 } = await cycle("refresh"));
}, 300_000);
afterAll(async () => db?.close());

// ---------------------------------------------------------------- the independent oracle
interface Scope { self?: string; staff?: string; workType?: WorkType; order?: string }
interface Line { eventId: string; staffId: string; workType: string; orderNumber: string; sku: string | null; weight: number; startedAtUtc: string; completedAtUtc: string; durationMin: number }
const us = (s: string) => exactInstant(s)!;
function oracle(src: Row[], cutoff: string, s: Scope): Line[] {
  const source = s.self ? src.filter((e) => e.staff_id === s.self) : src;
  const snap = fourFamilySnapshot(source, { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive }, s.self ? { kind: "limited", reason: "own work only" } : { kind: "site" }, SITE, cutoff);
  // the whole selected stream (work type narrows BEFORE predecessors; no staff narrowing yet)
  const stream = frameTimingLines(prepareProductionEvidence(snap), { range, ...(s.workType ? { workTypes: [s.workType] } : {}) });
  const at = (id: string) => src.find((e) => e.id === id)!.created_at;
  const prev = new Map<string, string>();
  const out: Line[] = [];
  for (const l of stream) {
    const p = prev.get(l.staffId);
    if (p !== undefined) expect(l.startedAtMs).toBe(Date.parse(at(p))); // the app's start IS the predecessor's instant (to the ms)
    out.push({ eventId: l.eventId, staffId: l.staffId, workType: l.workType, orderNumber: l.orderNumber, sku: l.sku, weight: l.weight, startedAtUtc: at(p ?? l.eventId), completedAtUtc: at(l.eventId), durationMin: l.durationMin });
    prev.set(l.staffId, l.eventId);
  }
  const byKey = (x: Line, y: Line) => (us(x.completedAtUtc) < us(y.completedAtUtc) ? -1 : us(x.completedAtUtc) > us(y.completedAtUtc) ? 1 : x.eventId < y.eventId ? -1 : x.eventId > y.eventId ? 1 : 0);
  expect([...out].sort(byKey)).toEqual(out); // the app's stream order IS the keyset order
  return out.filter((l) => (!s.staff || l.staffId === s.staff) && (!s.order || l.orderNumber === s.order.trim()));
}

// ---------------------------------------------------------------- calls
interface Page { rows: Line[]; last: [string, string] | null; more: boolean; total_rows: number }
const args = (gen: string, s: Scope, o: Record<string, unknown> = {}) => ({
  p_site: SITE, p_audience_kind: s.self ? "self" : "site", p_audience_staff: s.self ?? null, p_generation: gen, p_first_date: DAY, p_last_date: DAY,
  p_start: range.startUtc, p_end: range.endUtcExclusive, p_staff: s.staff ?? null, p_work_type: s.workType ?? null, p_kind: "timing", p_order: s.order ?? null, p_after: null, p_limit: 3, ...o,
});
const call = (gen: string, s: Scope, o: Record<string, unknown> = {}) => pgRpc(db).rpc("read_reporting_detail", args(gen, s, o)) as Promise<{ data: Page | null; error: { message: string } | null }>;
async function walk(gen: string, s: Scope, limit: number) {
  const pages: Page[] = [];
  let after: unknown = null;
  for (let i = 0; i < 100; i++) {
    const r = await call(gen, s, { p_after: after, p_limit: limit });
    expect(r.error).toBeNull();
    pages.push(r.data!);
    if (!r.data!.more) break;
    after = r.data!.last;
  }
  return pages;
}
function expectSequence(pages: Page[], want: Line[], limit: number) {
  expect(pages.flatMap((p) => p.rows)).toEqual(want);
  for (const [i, p] of pages.entries()) {
    expect(p.total_rows).toBe(want.length);
    expect(p.more).toBe(i < pages.length - 1);
    if (p.more) expect(p.rows.length).toBe(limit);
    const l = p.rows[p.rows.length - 1];
    expect(p.last).toEqual(l ? [l.completedAtUtc, l.eventId] : null);
  }
}
const line = (rows: Line[], id: string) => rows.find((r) => r.eventId === id);

describe("Task 16 slice 5: read_reporting_detail timing over the real SQL", () => {
  const SCOPES: Array<[string, Scope]> = [
    ["site, all work types", {}],
    ["site, framed only (work type narrows the stream before predecessors)", { workType: "framed" }],
    ["site, unframed only", { workType: "unframed" }],
    ["staff B (narrows after predecessors)", { staff: B }],
    ["order O-2 (trimmed; narrows after predecessors, across workers)", { order: " O-2\t" }],
    ["self A", { self: A }],
    ["self B + framed + order O-2", { self: B, workType: "framed", order: "O-2" }],
    ["an order with no timing line: empty", { order: "O-NONE" }],
  ];
  for (const [name, s] of SCOPES) {
    it(`${name}: pages of 3 equal the oracle exactly`, async () => {
      const want = oracle(SRC, cut1, s);
      expectSequence(await walk(gen1, s, 3), want, 3);
      if (name.startsWith("an order")) expect(want).toEqual([]);
      if (name === "site, all work types") expect(want.length).toBeGreaterThan(15);
    }, 120_000);
  }
  it("the app's gap rules hold row by row: first in range, ties, 10 / exactly 30 / 35 minutes, weight 0, cancelled", async () => {
    const rows = (await call(gen1, {}, { p_limit: 1000 })).data!.rows;
    expect(line(rows, "a-1")).toMatchObject({ startedAtUtc: t("09:00:00", 1), completedAtUtc: t("09:00:00", 1), durationMin: 0 }); // first in range (a-0 is outside, though selected context)
    expect(line(rows, "a-2")).toMatchObject({ startedAtUtc: t("09:00:00", 1), durationMin: 0 }); // same instant: no positive gap
    expect(line(rows, "a-3")).toMatchObject({ startedAtUtc: t("09:00:00", 1), completedAtUtc: t("09:10:00", 123456) });
    expect(line(rows, "a-3")!.durationMin).toBeCloseTo(600_123 / 60_000, 12); // millisecond arithmetic: 09:00:00.000 -> 09:10:00.123
    expect(line(rows, "a-4")).toMatchObject({ startedAtUtc: t("09:10:00", 123456), durationMin: 30 }); // exactly the cap: timed
    expect(line(rows, "a-5")).toMatchObject({ durationMin: 0 }); // 35 minutes: over the cap
    expect(line(rows, "a-6")).toMatchObject({ weight: 0, durationMin: 0, sku: UN }); // weight 0: never timed
    expect(line(rows, "a-7")).toBeUndefined(); // cancelled: not effective
    expect(line(rows, "a-8")).toMatchObject({ startedAtUtc: t("10:20:00"), durationMin: 10, workType: "unframed" }); // its predecessor skips the cancelled a-7
    expect(line(rows, "a-0")).toBeUndefined();
    expect(line(rows, "a-late")).toBeUndefined();
    const framed = (await call(gen1, { workType: "framed" }, { p_limit: 1000 })).data!.rows;
    expect(line(framed, "a-9")).toMatchObject({ startedAtUtc: t("10:20:00"), durationMin: 20 }); // a-8 is not in the framed stream
    expect(line(rows, "a-9")).toMatchObject({ startedAtUtc: t("10:30:00"), durationMin: 10 });
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["completedAtUtc", "durationMin", "eventId", "orderNumber", "sku", "staffId", "startedAtUtc", "weight", "workType"]);
  }, 120_000);
  it("ties order by id in UTF-16 order; microseconds are preserved; a boundary inside a tie continues exactly", async () => {
    const rows = (await call(gen1, {}, { p_limit: 1000 })).data!.rows;
    const ids = rows.map((r) => r.eventId);
    expect(ids.indexOf("t-\u{1F600}")).toBe(ids.indexOf("t-Ａ") - 1);
    expect(Buffer.compare(Buffer.from("t-\u{1F600}"), Buffer.from("t-Ａ"))).toBe(1); // bytewise is the reverse
    expect(ids.slice(0, 3)).toEqual(["a-1", "a-2", "b-0"]); // three lines at one microsecond: id order
    const after = (await call(gen1, {}, { p_after: [t("11:00:00"), "t-\u{1F600}"], p_limit: 1 })).data!;
    expect(after.rows.map((r) => r.eventId)).toEqual(["t-Ａ"]);
    expect(after.total_rows).toBe(rows.length); // the total never depends on the continuation
  }, 120_000);
  it("a retained generation keeps its own stream: deleting a-3 changes a-4 only in generation 2", async () => {
    expect((await db.query<{ s: string }>("select state as s from reporting_private.generations where generation_id = $1", [gen1])).rows[0].s).toBe("superseded");
    expectSequence(await walk(gen1, {}, 4), oracle(SRC, cut1, {}), 4);
    expectSequence(await walk(gen2, {}, 4), oracle(SRC2, cut2, {}), 4);
    expect(line((await call(gen2, {}, { p_limit: 1000 })).data!.rows, "a-4")).toMatchObject({ startedAtUtc: t("09:00:00", 1), durationMin: 0 }); // 40 minutes now
    expect(line((await call(gen1, {}, { p_limit: 1000 })).data!.rows, "a-4")).toMatchObject({ durationMin: 30 });
  }, 120_000);
  it("the API reader parses the real pages strictly and follows the keyset to the end", async () => {
    const reader = rpcPublishedReader(pgRpc(db));
    const scope: ReaderScope = { site: SITE, audience: { kind: "site" }, generationId: gen1, firstDate: DAY, lastDate: DAY, startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive, staffId: B, workType: null };
    const got: unknown[] = [];
    let after: unknown = null;
    for (let k = 0; k < 100; k++) {
      const pg = await reader.detail(scope, "timing", null, after, 4);
      got.push(...pg.rows.map((r) => r.row));
      if (!pg.more) break;
      after = pg.last;
    }
    expect(got).toEqual(oracle(SRC, cut1, { staff: B }));
  }, 120_000);
  it("refuses malformed continuations and a blank order selector", async () => {
    const BAD: unknown[] = [
      t("10:00:00"), [t("10:00:00")], [t("10:00:00"), "a-1", "x"], [1, "a-1"], [t("10:00:00"), 2], [t("10:00:00"), ""], ["", "a-1"],
      ["2026-01-11T10:00:00Z", "a-1"], ["2026-01-11T10:00:00.000Z", "a-1"], ["2026-01-11T10:00:00.000000+00:00", "a-1"], ["2026-01-11 10:00:00.000000Z", "a-1"],
      ["2026-02-30T10:00:00.000000Z", "a-1"], ["2026-01-11T25:00:00.000000Z", "a-1"], ["nonsense", "a-1"], { at: t("10:00:00"), id: "a-1" }, 4, true,
    ];
    for (const after of BAD) {
      expect([JSON.stringify(after), (await call(gen1, {}, { p_after: after })).error?.message ?? "accepted"]).toEqual([JSON.stringify(after), expect.stringMatching(/timing continuation must be \[canonical UTC instant, event id\]/)]);
    }
    for (const order of ["", "   ", "　"]) expect((await call(gen1, { order })).error?.message).toMatch(/order selector is blank/);
  }, 120_000);
});
