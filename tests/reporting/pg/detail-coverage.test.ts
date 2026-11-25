/**
 * Task 16, SQL slice 4 (offline, real 0037–0044 SQL in PGlite): read_reporting_detail `coverage`.
 * Every paged sequence is compared to an INDEPENDENT oracle: the app's own coverage issue list
 * (summarizeProduction over the four-family snapshot of the same source and scope; issues only, never
 * notes; deduplicated per kind/event; sorted by the app's comparator) narrowed by the trimmed order
 * selector, plus hand-derived rows for a SEEDED selected source issue (an identity problem the real
 * table cannot hold, so it is placed in source_issue_facts directly, as the overflow tests place facts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { rpcPublishedReader } from "../../../api/_lib/production-reporting-rpc";
import type { ReaderScope } from "../../../api/_lib/production-reporting";
import { prepareProductionEvidence, summarizeProduction, type ProductionEvidenceEvent, type WorkType } from "../../../src/lib/domain/productionCounts";
import { productionRange } from "../../../src/lib/domain/productionPeriods";
import { fourFamilySnapshot } from "../../fixtures/reporting-history";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SITE = "uk";
const DAY = "2026-01-11";
const range = productionRange(SITE, DAY, DAY);
const SKU = "INKA-KAN0566-A4-FB";

type Row = ProductionEvidenceEvent & { station_id: string; note: string };
const at = (hh: number, mm: number, ss = 0) => `${DAY}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.000000Z`;
const row = (id: string, created_at: string, o: Partial<Row> = {}): Row =>
  ({ id, location: SITE, staff_id: A, department: "framed", order_number: `O-${id}`, line_sku: SKU, line_quantity: 1, event_type: "line_verified", created_at, cs_case_id: null, parent_event_id: null, station_id: "s", note: "", ...o }) as Row;
const SRC: Row[] = [
  // ordinary counted work (no issues)
  row("ok-1", at(8, 0)), row("ok-t", at(8, 5), { event_type: "completed", line_sku: null, line_quantity: null, order_number: "O-ok-1" }),
  // unclassified_sku: eight rows over two workers and two work types, incl. a same-kind tie that UTF-16 and bytewise order disagree on
  ...["u-01", "u-02", "u-03", "u-04", "u-05", "u-06"].map((id, i) => row(id, at(9, i), { line_sku: `MYSTERY-${i}`, staff_id: i % 2 ? B : A, department: i % 3 ? "framed" : "unframed", order_number: i < 2 ? "O-SHARED" : `O-${id}` })),
  row("u-\u{1F600}", at(9, 10), { line_sku: "MYSTERY-X" }), row("u-Ａ", at(9, 11), { line_sku: "MYSTERY-Y" }),
  // invalid_quantity (missing quantity), invalid_event (blank order), unresolved_parent (unknown parent)
  row("iq-1", at(10, 0), { line_quantity: null, staff_id: B, department: "unframed", order_number: "O-SHARED" }),
  row("ie-1", at(10, 1), { order_number: "   " }),
  row("up-1", at(10, 2), { event_type: "cancelled", line_sku: null, line_quantity: null, parent_event_id: "no-such-parent", order_number: "O-up" }),
  // missing_completion_detail (a completion with no verified line), ambiguous_repeat (the same line verified twice)
  row("mc-1", at(10, 3), { event_type: "completed", line_sku: null, line_quantity: null, staff_id: B, department: "unframed", order_number: "O-MC" }),
  row("ar-1", at(10, 4), { order_number: "O-AR" }), row("ar-2", at(10, 5), { order_number: "O-AR" }),
  // a corrected verification: a NOTE, never a coverage issue row
  row("v-x", at(10, 6), { order_number: "O-X" }), row("c-x", at(10, 7), { event_type: "cancelled", line_sku: null, line_quantity: null, parent_event_id: "v-x", order_number: "O-X" }),
  // issues outside the window are not selected
  row("u-early", "2026-01-11T03:59:59.000000Z", { line_sku: "MYSTERY-E" }), row("u-late", "2026-01-12T04:00:00.000000Z", { line_sku: "MYSTERY-L" }),
];
/** Generation 2: u-01 gets a valid SKU (its issue disappears there, but not in the retained generation 1). */
const SRC2: Row[] = SRC.map((r) => (r.id === "u-01" ? { ...r, line_sku: SKU } : r));
/** The seeded selected source issues (site audience, and B's self audience): selection-wide, never staff/work-type scoped. */
const SEED = { id: "src-1", at: at(11, 0), staff: B, rawOrder: " O-SRC ", detail: "missing id or site" };

let db: PGlite;
let gen1 = "";
let gen2 = "";
let seq1 = "";
let cut1 = "";
let cut2 = "";
const insert = (r: Row) =>
  db.query("insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id) values ('uk',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [r.id, r.staff_id, r.department, r.order_number, r.line_sku, r.line_quantity, r.event_type, r.station_id, r.note, r.created_at, r.cs_case_id, r.parent_event_id]);
const published = async () => (await db.query<{ g: string; s: string; c: string }>("select generation_id::text as g, generation_seq::text as s, to_char(source_cutoff at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as c from reporting_private.generations where site = 'uk' and state = 'published'")).rows[0];
const cycle = async (mode: "rebuild" | "refresh") => {
  const r = await runReportingCycle({ client: pgRpc(db), now: () => Date.now(), sleep: async () => undefined }, { site: SITE, mode });
  if (r.state !== "published") throw new Error(`${mode}: ${r.state} ${r.problems.join("; ")}`);
  return published();
};

beforeAll(async () => {
  db = await reportingDb();
  await db.query("insert into auth.users (id) values ($1), ($2)", [A, B]);
  const c = pgRpc(db);
  await c.rpc("set_reporting_capture", { p_enabled: true });
  await c.rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: null, p_processor_enabled: true });
  for (const r of SRC) await insert(r);
  const g1 = await cycle("rebuild");
  [gen1, seq1, cut1] = [g1.g, g1.s, g1.c];
  await db.query("update public.production_events set line_sku = $1 where location = 'uk' and id = 'u-01'", [SKU]);
  const g2 = await cycle("refresh");
  [gen2, cut2] = [g2.g, g2.c];
  // seeded selected source issues, visible from generation 1 on (site audience, and B's self audience)
  for (const [ak, as] of [["site", null], ["self", B]] as const) {
    await db.query(
      "insert into reporting_private.source_issue_facts (site, audience_kind, audience_staff, event_id, valid_from_seq, event_type, created_at, staff_id, raw_order, parent_event_id, issue_kind, issue_detail, rule_version, partition_kind, partition_key) values ('uk',$1,$2,$3,$4::bigint,'line_verified',$5,$6,$7,null,'invalid_event',$8,'item-counting-summary-v1','event',$3)",
      [ak, as, SEED.id, seq1, SEED.at, SEED.staff, SEED.rawOrder, SEED.detail]);
  }
}, 300_000);
afterAll(async () => db?.close());

// ---------------------------------------------------------------- the independent oracle
interface Scope { self?: string; staff?: string; workType?: WorkType; order?: string }
interface Cov { kind: string; eventId: string; location: string; detail: string | null }
function oracle(src: Row[], cutoff: string, s: Scope): Cov[] {
  const source = s.self ? src.filter((e) => e.staff_id === s.self) : src;
  const snap = fourFamilySnapshot(source, { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive }, s.self ? { kind: "limited", reason: "own work only" } : { kind: "site" }, SITE, cutoff);
  const app = summarizeProduction(prepareProductionEvidence(snap), { range, ...(s.staff ? { staffIds: [s.staff] } : {}), ...(s.workType ? { workTypes: [s.workType] } : {}) }).coverage.issues
    .map((i) => ({ kind: i.kind, eventId: i.eventId, location: i.location, detail: i.detail ?? null, order: src.find((e) => e.id === i.eventId)?.order_number ?? null }));
  // the seeded source issue: selected (in window, a counting event type), visible to the site and to B's self audience only
  if (!s.self || s.self === SEED.staff) app.push({ kind: "invalid_event", eventId: SEED.id, location: SITE, detail: SEED.detail, order: SEED.rawOrder });
  return app
    .filter((i) => !s.order || (i.order ?? "").trim() === s.order.trim())
    .map(({ order: _o, ...i }) => (void _o, i))
    .sort((x, y) => {
      const kx = `${x.kind}\u0000${x.location}\u0000${x.eventId}\u0000${x.detail ?? ""}`;
      const ky = `${y.kind}\u0000${y.location}\u0000${y.eventId}\u0000${y.detail ?? ""}`;
      return kx < ky ? -1 : kx > ky ? 1 : 0;
    });
}

// ---------------------------------------------------------------- calls
interface Page { rows: Cov[]; last: [string, string] | null; more: boolean; total_rows: number }
const args = (gen: string, s: Scope, o: Record<string, unknown> = {}) => ({
  p_site: SITE, p_audience_kind: s.self ? "self" : "site", p_audience_staff: s.self ?? null, p_generation: gen, p_first_date: DAY, p_last_date: DAY,
  p_start: range.startUtc, p_end: range.endUtcExclusive, p_staff: s.staff ?? null, p_work_type: s.workType ?? null, p_kind: "coverage", p_order: s.order ?? null, p_after: null, p_limit: 3, ...o,
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
function expectSequence(pages: Page[], want: Cov[], limit: number) {
  expect(pages.flatMap((p) => p.rows)).toEqual(want);
  for (const [i, p] of pages.entries()) {
    expect(p.total_rows).toBe(want.length);
    expect(p.more).toBe(i < pages.length - 1);
    if (p.more) expect(p.rows.length).toBe(limit);
    const l = p.rows[p.rows.length - 1];
    expect(p.last).toEqual(l ? [l.kind, l.eventId] : null);
  }
}

describe("Task 16 slice 4: read_reporting_detail coverage over the real SQL", () => {
  it("the fixture is non-vacuous: all six issue kinds, notes present, a same-kind UTF-16/bytewise tie", () => {
    const all = oracle(SRC, cut1, {});
    expect(new Set(all.map((i) => i.kind))).toEqual(new Set(["invalid_event", "unclassified_sku", "invalid_quantity", "unresolved_parent", "missing_completion_detail", "ambiguous_repeat"]));
    expect(all.length).toBeGreaterThanOrEqual(15);
    expect(Buffer.compare(Buffer.from("u-\u{1F600}"), Buffer.from("u-Ａ"))).toBe(1); // bytewise puts U+FF21 first; UTF-16 the reverse
    const s = fourFamilySnapshot(SRC, { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive }, { kind: "site" }, SITE, cut1);
    expect(summarizeProduction(prepareProductionEvidence(s), { range }).coverage.notes.corrected_verification).toBe(1); // a note that must NOT appear as a row
  });
  const SCOPES: Array<[string, Scope]> = [
    ["site, everyone", {}],
    ["self A (no other worker's issue; no seeded source issue)", { self: A }],
    ["self B (its own seeded source issue only)", { self: B }],
    ["staff filter B (anchored issues narrow; the source issue stays selection-wide)", { staff: B }],
    ["work type unframed", { workType: "unframed" }],
    ["order O-SHARED (trimmed)", { order: " O-SHARED\t" }],
    ["order O-SRC narrows the source issue by its raw order", { order: "O-SRC" }],
    ["self B + order O-SHARED + unframed", { self: B, order: "O-SHARED", workType: "unframed" }],
    ["an order with no issue: empty", { order: "O-ok-1" }],
  ];
  for (const [name, s] of SCOPES) {
    it(`${name}: pages of 3 equal the oracle exactly`, async () => {
      const want = oracle(SRC2, cut2, s);
      expectSequence(await walk(gen2, s, 3), want, 3);
      if (name.startsWith("an order with no issue")) expect(want).toEqual([]);
      if (name === "site, everyone") expect(want.length).toBeGreaterThan(6); // several pages
    }, 120_000);
  }
  it("rows are issues only, exactly {kind, eventId, location, detail}, with each kind's detail", async () => {
    const rows = (await call(gen1, {}, { p_limit: 1000 })).data!.rows;
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["detail", "eventId", "kind", "location"]);
    expect(rows.map((r) => r.eventId)).not.toContain("v-x"); // a corrected verification is a note
    const by = (id: string) => rows.find((r) => r.eventId === id);
    expect(by("iq-1")).toMatchObject({ kind: "invalid_quantity", detail: "missing_quantity" });
    expect(by("ie-1")).toMatchObject({ kind: "invalid_event", detail: "verification without work type, person or order" });
    expect(by("up-1")).toMatchObject({ kind: "unresolved_parent", detail: "parent not found" });
    expect(by("mc-1")).toMatchObject({ kind: "missing_completion_detail", detail: "no line detail" });
    expect(by("ar-1")).toMatchObject({ kind: "ambiguous_repeat", detail: "2 verifications of the same line" });
    expect(by(SEED.id)).toEqual({ kind: "invalid_event", eventId: SEED.id, location: SITE, detail: SEED.detail });
    expect(by("u-early")).toBeUndefined();
    const ids = rows.filter((r) => r.kind === "unclassified_sku").map((r) => r.eventId);
    expect(ids.indexOf("u-\u{1F600}")).toBeLessThan(ids.indexOf("u-Ａ")); // UTF-16 order inside one kind
  }, 120_000);
  it("a retained generation keeps its own issues: u-01 is an issue in generation 1, not in generation 2", async () => {
    expect((await db.query<{ s: string }>("select state as s from reporting_private.generations where generation_id = $1", [gen1])).rows[0].s).toBe("superseded");
    expectSequence(await walk(gen1, {}, 4), oracle(SRC, cut1, {}), 4);
    const u01 = (rows: Cov[]) => rows.filter((r) => r.eventId === "u-01");
    expect(u01(oracle(SRC, cut1, {})).map((r) => r.kind)).toContain("unclassified_sku");
    const later = u01((await call(gen2, {}, { p_limit: 1000 })).data!.rows);
    expect(later.map((r) => r.kind)).not.toContain("unclassified_sku"); // fixed in generation 2
    expect(later).toEqual(u01(oracle(SRC2, cut2, {}))); // whatever remains is exactly the app's
  }, 120_000);
  it("continuation is strictly after [kind, eventId], including a boundary inside a same-kind tie; total never depends on it", async () => {
    const all = oracle(SRC2, cut2, {});
    const i = all.findIndex((r) => r.eventId === "u-\u{1F600}");
    const p = (await call(gen2, {}, { p_after: ["unclassified_sku", "u-\u{1F600}"], p_limit: 1000 })).data!;
    expect(p.rows).toEqual(all.slice(i + 1));
    expect(p.rows[0]?.eventId).toBe("u-Ａ");
    expect(p.total_rows).toBe(all.length);
    expect((await call(gen2, {}, { p_after: ["zzz", "zzz"] })).data).toEqual({ rows: [], last: null, more: false, total_rows: all.length });
  }, 120_000);
  it("the API reader parses the real pages strictly and follows the keyset to the end", async () => {
    const reader = rpcPublishedReader(pgRpc(db));
    const scope: ReaderScope = { site: SITE, audience: { kind: "site" }, generationId: gen2, firstDate: DAY, lastDate: DAY, startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive, staffId: null, workType: null };
    const got: unknown[] = [];
    let after: unknown = null;
    for (let k = 0; k < 100; k++) {
      const pg = await reader.detail(scope, "coverage", null, after, 4);
      got.push(...pg.rows.map((r) => r.row));
      if (!pg.more) break;
      after = pg.last;
    }
    expect(got).toEqual(oracle(SRC2, cut2, {}));
  }, 120_000);
  it("refuses malformed continuations and a blank order selector", async () => {
    for (const after of ["unclassified_sku", ["unclassified_sku"], ["unclassified_sku", "u-01", "x"], [1, "u-01"], ["unclassified_sku", 2], ["", "u-01"], ["unclassified_sku", ""], { kind: "a", id: "b" }, 3, true]) {
      expect([JSON.stringify(after), (await call(gen2, {}, { p_after: after })).error?.message ?? "accepted"]).toEqual([JSON.stringify(after), expect.stringMatching(/coverage continuation must be \[issue kind, event id\]/)]);
    }
    for (const order of ["", "   ", "　"]) expect((await call(gen2, { order })).error?.message).toMatch(/order selector is blank/);
  }, 120_000);
});
