/**
 * Task 16, SQL slice 3 (offline, real 0037–0044 SQL in PGlite): read_reporting_detail `events` and
 * `raw-export`. Each paged sequence is compared to an INDEPENDENT oracle computed in this file from the
 * inserted fixture rows (never SQL to itself): the selection's in-window rows of the four relevant event
 * types, narrowed by audience/staff/work type (the app's classifyEvidenceEvent)/trimmed order, ordered
 * by exact instant then event id in UTF-16 order, with the raw saved values. A retained generation
 * must read its own source_versions image, not a later mutable one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { rpcPublishedReader } from "../../../api/_lib/production-reporting-rpc";
import type { ReaderScope } from "../../../api/_lib/production-reporting";
import { classifyEvidenceEvent, evidenceOrderKey, exactInstant } from "../../../src/lib/domain/productionCounts";
import { productionRange } from "../../../src/lib/domain/productionPeriods";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SITE = "uk";
const DAY = "2026-01-11";
const range = productionRange(SITE, DAY, DAY); // [2026-01-11T04:00Z, 2026-01-12T04:00Z)
const SKU = "INKA-KAN0566-A4-FB";

interface Row { id: string; staff_id: string; department: string; order_number: string; line_sku: string | null; line_quantity: number | null; event_type: string; created_at: string; station_id: string | null; note: string; cs_case_id: string | null; parent_event_id: string | null }
const row = (id: string, at: string, o: Partial<Row> = {}): Row => ({ id, staff_id: A, department: "framed", order_number: "O-1", line_sku: SKU, line_quantity: 1, event_type: "line_verified", created_at: at, station_id: "st-1", note: "n", cs_case_id: null, parent_event_id: null, ...o });
const at = (hh: number, mm: number, us = 0) => `${DAY}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.${String(us).padStart(6, "0")}Z`;
const term = (o: Partial<Row>): Partial<Row> => ({ event_type: "completed", line_sku: null, line_quantity: null, ...o });
const SRC: Row[] = [
  ...Array.from({ length: 20 }, (_, i) => row(`v-${String(i).padStart(2, "0")}`, at(9, i), { staff_id: i % 2 ? B : A, order_number: `O-${(i % 5) + 1}`, department: i % 3 ? "framed" : "unframed" })),
  row("t-01", at(9, 40), term({ order_number: "O-1" })),
  row("t-02", at(9, 41), term({ staff_id: B, order_number: "O-2", department: "unframed" })),
  // four events at ONE instant: ids in UTF-16 order (the surrogate pair sorts before U+FF21; bytewise is the reverse)
  row("tie-b", at(10, 0)), row("tie-a", at(10, 0)), row("tie-\u{1F600}", at(10, 0)), row("tie-Ａ", at(10, 0)),
  // one microsecond decides, whatever the ids say
  row("us-a2", at(10, 30, 2)), row("us-z1", at(10, 30, 1)),
  // raw values: a quantity no business rule allows on a completion, an extreme quantity, blank vs text note, null vs set station
  row("q-raw", at(11, 0), term({ line_quantity: 7, note: "", station_id: null })),
  row("q-big", at(11, 1), { line_quantity: 2147483647, note: "  spaced  " }),
  row("c-1", at(11, 2), { event_type: "cancelled", line_sku: null, line_quantity: null, parent_event_id: "v-03", order_number: "O-4" }),
  row("d-1", at(11, 3), { event_type: "dispatched", department: "dispatch", staff_id: B, order_number: " O-2 ", line_sku: null, line_quantity: null, cs_case_id: "C7" }),
  row("blank-o", at(11, 4), { order_number: "   " }),
  // in the window but not a selected event type: never in the stream
  row("s-1", at(11, 5), { event_type: "started", line_sku: null, line_quantity: null }),
  // just outside the window on both sides
  row("early", "2026-01-11T03:59:59.999999Z"), row("late", "2026-01-12T04:00:00.000000Z"),
];

let db: PGlite;
let gen1 = "";
let gen2 = "";
const insert = async (r: Row) =>
  db.query("insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id) values ('uk',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [r.id, r.staff_id, r.department, r.order_number, r.line_sku, r.line_quantity, r.event_type, r.station_id, r.note, r.created_at, r.cs_case_id, r.parent_event_id]);
const cycle = async (mode: "rebuild" | "refresh") => {
  const r = await runReportingCycle({ client: pgRpc(db), now: () => Date.now(), sleep: async () => undefined }, { site: SITE, mode });
  if (r.state !== "published") throw new Error(`${mode}: ${r.state} ${r.problems.join("; ")}`);
  return (await db.query<{ g: string }>("select generation_id::text as g from reporting_private.generations where site = 'uk' and state = 'published'")).rows[0].g;
};
/** The generation-2 source: an edited note/quantity/station, a deleted event and a new one. */
const SRC2: Row[] = SRC.filter((r) => r.id !== "v-05").map((r) => (r.id === "q-big" ? { ...r, note: "edited later", line_quantity: 3, station_id: null } : r)).concat([row("new-1", at(12, 0), { staff_id: B })]);

beforeAll(async () => {
  db = await reportingDb();
  await db.query("insert into auth.users (id) values ($1), ($2)", [A, B]);
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: null, p_processor_enabled: true });
  for (const r of SRC) await insert(r);
  gen1 = await cycle("rebuild");
  await db.query("update public.production_events set note = 'edited later', line_quantity = 3, station_id = null where location = 'uk' and id = 'q-big'");
  await db.query("delete from public.production_events where location = 'uk' and id = 'v-05'");
  await insert(SRC2[SRC2.length - 1]);
  gen2 = await cycle("refresh");
}, 300_000);
afterAll(async () => db?.close());

// ---------------------------------------------------------------- the independent oracle
const RELEVANT = new Set(["line_verified", "completed", "dispatched", "cancelled"]);
const us = (s: string) => exactInstant(s)!;
const utf16 = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
interface Scope { self?: string; staff?: string; workType?: string; order?: string }
function oracle(src: Row[], s: Scope, raw: boolean) {
  const lo = us(range.startUtc);
  const hi = us(range.endUtcExclusive);
  return src
    .filter((r) => RELEVANT.has(r.event_type) && us(r.created_at) >= lo && us(r.created_at) < hi)
    .filter((r) => !s.self || r.staff_id === s.self)
    .filter((r) => !s.staff || r.staff_id === s.staff)
    .filter((r) => !s.workType || classifyEvidenceEvent(r).workType === s.workType)
    .filter((r) => !s.order || evidenceOrderKey(r.order_number) === s.order.trim())
    .sort((x, y) => (us(x.created_at) < us(y.created_at) ? -1 : us(x.created_at) > us(y.created_at) ? 1 : utf16(x.id, y.id)))
    .map((r) => ({
      id: r.id, staffId: r.staff_id, department: r.department, orderNumber: r.order_number, sku: r.line_sku, quantity: r.line_quantity, eventType: r.event_type,
      createdAtUtc: r.created_at, parentEventId: r.parent_event_id, caseId: r.cs_case_id, ...(raw ? { note: r.note, stationId: r.station_id } : {}),
    }));
}

// ---------------------------------------------------------------- calls
interface Page { rows: Array<Record<string, unknown>>; last: [string, string] | null; more: boolean; total_rows: number }
const args = (kind: string, gen: string, s: Scope, o: Record<string, unknown> = {}) => ({
  p_site: SITE, p_audience_kind: s.self ? "self" : "site", p_audience_staff: s.self ?? null, p_generation: gen, p_first_date: DAY, p_last_date: DAY,
  p_start: range.startUtc, p_end: range.endUtcExclusive, p_staff: s.staff ?? null, p_work_type: s.workType ?? null, p_kind: kind, p_order: s.order ?? null, p_after: null, p_limit: 5, ...o,
});
const call = (kind: string, gen: string, s: Scope, o: Record<string, unknown> = {}) => pgRpc(db).rpc("read_reporting_detail", args(kind, gen, s, o)) as Promise<{ data: Page | null; error: { message: string } | null }>;
async function walk(kind: string, gen: string, s: Scope, limit: number) {
  const pages: Page[] = [];
  let after: unknown = null;
  for (let i = 0; i < 100; i++) {
    const r = await call(kind, gen, s, { p_after: after, p_limit: limit });
    expect(r.error).toBeNull();
    pages.push(r.data!);
    if (!r.data!.more) break;
    after = r.data!.last;
  }
  return pages;
}
function expectSequence(pages: Page[], want: unknown[], limit: number) {
  const rows = pages.flatMap((p) => p.rows);
  expect(rows).toEqual(want); // no gap, no repeat, exact values and order
  for (const [i, p] of pages.entries()) {
    expect(p.total_rows).toBe(want.length);
    expect(p.more).toBe(i < pages.length - 1);
    if (p.more) expect(p.rows.length).toBe(limit);
    const lastRow = p.rows[p.rows.length - 1] as { createdAtUtc: string; id: string } | undefined;
    expect(p.last).toEqual(lastRow ? [lastRow.createdAtUtc, lastRow.id] : null);
  }
}

describe("Task 16 slice 3: read_reporting_detail events and raw-export over the real SQL", () => {
  const SCOPES: Array<[string, Scope]> = [
    ["site, everyone", {}],
    ["self A (another worker never leaks)", { self: A }],
    ["self B", { self: B }],
    ["staff filter B", { staff: B }],
    ["work type unframed", { workType: "unframed" }],
    ["work type dispatch", { workType: "dispatch" }],
    ["order O-2 (trimmed)", { order: "  O-2\t" }],
    ["self A + order O-1 + work type framed", { self: A, order: "O-1", workType: "framed" }],
  ];
  for (const kind of ["events", "raw-export"]) {
    for (const [name, s] of SCOPES) {
      it(`${kind} · ${name}: pages of 4 equal the independent oracle exactly`, async () => {
        const want = oracle(SRC, s, kind === "raw-export");
        const pages = await walk(kind, gen1, s, 4);
        expectSequence(pages, want, 4);
        if (name === "site, everyone") expect(pages.length).toBeGreaterThanOrEqual(8); // page 2+ and many pages: non-vacuous
        if (s.self) expect(pages.flatMap((p) => p.rows).every((r) => r.staffId === s.self)).toBe(true);
      }, 120_000);
    }
  }
  it("tied instants order by id in UTF-16 order; one microsecond beats any id; microseconds are preserved", async () => {
    const ids = (await walk("events", gen1, {}, 1000)).flatMap((p) => p.rows.map((r) => r.id as string));
    expect(ids.filter((i) => i.startsWith("tie-"))).toEqual(["tie-a", "tie-b", "tie-\u{1F600}", "tie-Ａ"]);
    expect(Buffer.compare(Buffer.from("tie-\u{1F600}"), Buffer.from("tie-Ａ"))).toBe(1); // bytewise would reverse them
    expect(ids.filter((i) => i.startsWith("us-"))).toEqual(["us-z1", "us-a2"]);
    const r = (await call("events", gen1, { order: "O-1" }, { p_limit: 1000 })).data!.rows.find((x) => x.id === "us-a2")!;
    expect(r.createdAtUtc).toBe("2026-01-11T10:30:00.000002Z");
    // a page boundary INSIDE the tie: continuing from [instant, "tie-b"] returns exactly the rest of the tie next
    const after = await call("events", gen1, {}, { p_after: ["2026-01-11T10:00:00.000000Z", "tie-b"], p_limit: 2 });
    expect(after.data!.rows.map((x) => x.id)).toEqual(["tie-\u{1F600}", "tie-Ａ"]);
  }, 120_000);
  it("raw values are never coerced: quantity, event type, blank note, null station, case, parent", async () => {
    const all = (await walk("raw-export", gen1, {}, 1000)).flatMap((p) => p.rows);
    const by = (id: string) => all.find((r) => r.id === id)!;
    expect(by("q-raw")).toMatchObject({ quantity: 7, eventType: "completed", note: "", stationId: null });
    expect(by("q-big")).toMatchObject({ quantity: 2147483647, note: "  spaced  ", stationId: "st-1" });
    expect(by("c-1")).toMatchObject({ quantity: null, eventType: "cancelled", parentEventId: "v-03" });
    expect(by("d-1")).toMatchObject({ eventType: "dispatched", orderNumber: " O-2 ", caseId: "C7" });
    expect(by("blank-o")).toMatchObject({ orderNumber: "   " });
    expect(all.map((r) => r.id)).not.toContain("s-1"); // a `started` event is not part of the selected stream
    expect(all.map((r) => r.id)).not.toContain("early");
    expect(all.map((r) => r.id)).not.toContain("late");
    const ev = (await call("events", gen1, {}, { p_limit: 1000 })).data!.rows.find((r) => r.id === "q-raw")!;
    expect(Object.keys(ev).sort()).toEqual(["caseId", "createdAtUtc", "department", "eventType", "id", "orderNumber", "parentEventId", "quantity", "sku", "staffId"]);
  }, 120_000);
  it("a retained generation reads ITS source_versions image; the newer generation reads the edit, deletion and insertion", async () => {
    expect((await db.query<{ s: string }>("select state as s from reporting_private.generations where generation_id = $1", [gen1])).rows[0].s).toBe("superseded");
    expect(await db.query("select note from public.production_events where id = 'q-big'").then((r) => r.rows)).toEqual([{ note: "edited later" }]); // the live row changed
    expectSequence(await walk("raw-export", gen1, {}, 6), oracle(SRC, {}, true), 6);
    expectSequence(await walk("raw-export", gen2, {}, 6), oracle(SRC2, {}, true), 6);
    expectSequence(await walk("events", gen2, { staff: B }, 3), oracle(SRC2, { staff: B }, false), 3);
  }, 120_000);
  it("the API reader parses the real pages strictly and follows the keyset to the end", async () => {
    const reader = rpcPublishedReader(pgRpc(db));
    const scope: ReaderScope = { site: SITE, audience: { kind: "site" }, generationId: gen1, firstDate: DAY, lastDate: DAY, startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive, staffId: null, workType: null };
    for (const kind of ["events", "raw-export"] as const) {
      const got: unknown[] = [];
      let after: unknown = null;
      for (let i = 0; i < 100; i++) {
        const p = await reader.detail(scope, kind, null, after, 7);
        expect(p.rows.every((r) => r.kind === kind)).toBe(true);
        got.push(...p.rows.map((r) => r.row));
        if (!p.more) break;
        after = p.last;
      }
      expect(got).toEqual(oracle(SRC, {}, kind === "raw-export"));
    }
  }, 120_000);
  it("refuses malformed continuations and blank order selectors", async () => {
    const BAD: unknown[] = [
      "2026-01-11T10:00:00.000000Z", ["2026-01-11T10:00:00.000000Z"], ["2026-01-11T10:00:00.000000Z", "tie-a", "x"], [1, "tie-a"], ["2026-01-11T10:00:00.000000Z", 5],
      ["2026-01-11T10:00:00.000000Z", ""], ["2026-01-11T10:00:00Z", "tie-a"], ["2026-01-11 10:00:00.000000Z", "tie-a"], ["2026-01-11T10:00:00.000000+00:00", "tie-a"],
      ["2026-02-30T10:00:00.000000Z", "tie-a"], ["2026-01-11T24:00:00.000000Z", "tie-a"], ["not a time", "tie-a"], { at: "x", id: "y" }, 3, true,
    ];
    for (const kind of ["events", "raw-export"]) {
      for (const after of BAD) expect([kind, JSON.stringify(after), (await call(kind, gen1, {}, { p_after: after })).error?.message ?? "accepted"]).toEqual([kind, JSON.stringify(after), expect.stringMatching(/continuation must be \[canonical UTC instant, event id\]/)]);
      for (const order of ["", "   ", "　"]) expect((await call(kind, gen1, { order })).error?.message).toMatch(/order selector is blank/);
    }
  }, 120_000);
});
