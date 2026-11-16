/**
 * Task 15 second hosted blocker (AU, 2026-11-17): one owner group took ~6 min
 * and starved the 30 s heartbeat. Shape: an owner whose member lines are far
 * apart in its worker's stream. The predecessor walk consumes EVERY line
 * between its latest and earliest member (none of them can satisfy the stop,
 * which needs a line BELOW the earliest member), and read each such line's
 * children one round trip at a time.
 *
 * Fix under test: children of lines that are certain to be consumed (they
 * cannot stop the walk) are read per stream page in one bounded multi-parent
 * read and charged in the original order; stop candidates stay sequential.
 * Plus a heartbeat/budget guard inside long owner materialization.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildOwnerInput, coalescingChildren, materializeOwnerGroup, materializeOwnerWorks, MAX_PARTITION_EVENTS, memoryFrozenReader, PartitionTooLargeError,
  type FrozenReader, type MaterializedWork, type MaterializeStats, type Owner,
} from "../../api/_lib/production-reporting-materialize";
import { HEARTBEAT_MS, OWNER_GROUP, runReportingCycle, WORKER_BUDGET_MS } from "../../api/_lib/production-reporting-worker";
import { canonicalJson } from "../../src/lib/domain/productionReporting";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";
import { reportingDb } from "./pg/harness";
import { pgRpc } from "./pg/rpc";
import { pgDb } from "./pg/runtimeFixtures";
import { parityProblems } from "../staging/reportingWorkerRuntime";

type Ev = ProductionEvidenceEvent;
const SITE = "au";
const CUT = "2026-11-15T12:00:00.000000Z";
const FB = "INKA-KAN0566-A4-FB";
const W = (i: number) => `${String(i).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const at = (s: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + s * 1000).toISOString().replace("Z", "000Z");
const ev = (id: string, type: string, order: string | null, staff: string, s: number, o: Partial<Ev> = {}): Ev =>
  ({ id, location: SITE, staff_id: staff, department: "framed", order_number: order, line_sku: type === "line_verified" ? FB : null, line_quantity: type === "line_verified" ? 1 : null, event_type: type, created_at: at(s), parent_event_id: null, cs_case_id: null, ...o });

/** `workers` workers; each has ONE long order (first line, `between` other lines in small orders, last line), some lines cancelled. */
function longSpan(workers: number, between: number): Ev[] {
  const out: Ev[] = [];
  for (let w = 0; w < workers; w++) {
    const s = W(w);
    let t = w * 3;
    out.push(ev(`w${w}-pre`, "line_verified", `PRE-${w}`, s, t)); // the effective predecessor below the long order
    t += 60;
    out.push(ev(`w${w}-long-a`, "line_verified", `LONG-${w}`, s, t));
    for (let i = 0; i < between; i++) {
      t += 60;
      const id = `w${w}-m${String(i).padStart(5, "0")}`;
      out.push(ev(id, "line_verified", `MID-${w}-${Math.floor(i / 5)}`, s, t));
      if (i % 9 === 0) out.push(ev(`${id}-x`, "cancelled", `MID-${w}-${Math.floor(i / 5)}`, s, t + 1, { parent_event_id: id }));
    }
    t += 60;
    out.push(ev(`w${w}-long-b`, "line_verified", `LONG-${w}`, s, t));
  }
  return out;
}
function counted(r: FrozenReader) {
  const c = { childCalls: 0, childRows: 0 };
  const reader: FrozenReader = {
    ...r,
    children(ids) {
      c.childCalls++;
      const inner = r.children(ids);
      return (async function* () {
        for await (const e of inner) {
          c.childRows++;
          yield e;
        }
      })();
    },
  };
  return { reader, c };
}
/** The pre-fix RPC pattern: every multi-parent request served as sequential single-parent reads. */
function singleParent(r: FrozenReader): FrozenReader {
  return { ...r, children: (ids) => (async function* () { for (const p of [...new Set(ids)].sort()) yield* r.children([p]); })() };
}
const stats = (): MaterializeStats => ({ owners: 0, works: 0, maxInput: 0, totalInput: 0, requests: 0, peakInput: 0 });
const key = (w: MaterializedWork) => canonicalJson({ d: w.desc, r: w.rows });
const LONG = (w: number): Owner => ({ partitionKind: "order", partitionKey: `LONG-${w}` });

describe("long-span owners: children of certain-to-be-consumed walk lines are read per page", () => {
  it("one long owner: identical output; children reads bounded by stream pages, not by lines (2,500 lines between members)", async () => {
    const view = longSpan(1, 2500);
    const ref = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] }));
    const want = await materializeOwnerWorks(singleParent(ref.reader), LONG(0), [], stats());
    const got = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] }));
    const works = await materializeOwnerWorks(got.reader, LONG(0), [], stats());
    expect(works.map(key)).toEqual(want.map(key));
    expect(ref.c.childCalls).toBeGreaterThan(2500); // one round trip per consumed line before the fix
    expect(got.c.childCalls).toBeLessThanOrEqual(Math.ceil(2503 / 200) + 5); // ~one read per 200-line stream page
    expect(got.c.childRows).toBe(ref.c.childRows); // the same children rows: nothing beyond what the walk consumes
  });
  it("a group of 8 long owners over the coalescing reader: identical outputs, bounded calls", async () => {
    const view = longSpan(8, 1500);
    const owners = Array.from({ length: 8 }, (_, w) => LONG(w));
    const ref = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] }));
    const want: MaterializedWork[] = [];
    for (const o of owners) want.push(...(await materializeOwnerWorks(singleParent(ref.reader), o, [], stats())));
    const got = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] }));
    const settled = await materializeOwnerGroup(coalescingChildren(got.reader), owners.map((owner) => ({ owner, oldStaff: [] })), stats());
    expect(settled.flatMap((s) => (s.status === "fulfilled" ? s.value : [])).map(key)).toEqual(want.map(key));
    expect(got.c.childCalls).toBeLessThan(ref.c.childCalls / 50);
  }, 60_000); // the single-parent reference over 12,000 lines is the slow part
  it("stop candidates stay sequential and nothing beyond the stop is read: an old line below the predecessor with 60,000 cancellations", async () => {
    const view = longSpan(1, 600);
    view.push(ev("w0-ancient", "line_verified", "ANCIENT", W(0), -100));
    for (let i = 1; i <= 60_000; i++) view.push(ev(`k${String(i).padStart(6, "0")}`, "cancelled", null, W(1), -50, { parent_event_id: "w0-ancient" }));
    for (const maxPage of [1, 7, 200]) {
      const { reader, c } = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [], maxPage }));
      const input = await buildOwnerInput(reader, LONG(0));
      expect(input.events.some((e) => e.id === "w0-ancient")).toBe(false);
      expect(c.childRows, `maxPage ${maxPage}`).toBe(Math.ceil(600 / 9)); // only the in-span lines' own 67 cancellations
    }
  });
  it("overflow inside the span is attributed exactly as before: size 50,001, reading stops promptly", async () => {
    const view = longSpan(1, 300);
    for (let i = 1; i <= 60_000; i++) view.push(ev(`z${String(i).padStart(6, "0")}`, "cancelled", null, W(1), 400 * 60, { parent_event_id: "w0-m00150" }));
    const ref = await buildOwnerInput(singleParent(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] })), LONG(0)).then(() => null, (e: unknown) => e);
    const { reader, c } = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] }));
    const err = await buildOwnerInput(reader, LONG(0)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PartitionTooLargeError);
    expect((err as PartitionTooLargeError).owner).toEqual(LONG(0));
    expect((err as PartitionTooLargeError).size).toBe(MAX_PARTITION_EVENTS + 1);
    expect((ref as PartitionTooLargeError).size).toBe(MAX_PARTITION_EVENTS + 1);
    expect(c.childRows).toBeLessThanOrEqual(MAX_PARTITION_EVENTS + 1000);
  }, 120_000);
});

describe("the worker stays heartbeat-safe inside a long owner group (real SQL, simulated 1 s per RPC)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await reportingDb();
    for (let w = 0; w < 8; w++) await db.query("insert into auth.users (id, email) values ($1, $2)", [W(w), `w${w}@x`]);
    for (const e of longSpan(8, 400)) {
      await db.query(
        `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
         values ('au', $1, $2, 'framed', $3, $4, $5, $6, 's', '', $7, $8)`,
        [e.id, e.staff_id, e.order_number, e.line_sku, e.line_quantity, e.event_type, e.created_at, e.parent_event_id]);
    }
    const c = pgRpc(db);
    expect((await c.rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
    expect((await c.rpc("set_reporting_site_mode", { p_site: "au", p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
  }, 300_000);
  afterAll(async () => db?.close());

  it("lease renewals never gap by more than ~30 simulated seconds while owners are materialized, and the budget is never overrun by more than one call", async () => {
    let t = Date.parse("2026-11-17T00:00:00Z");
    const inner = pgRpc(db);
    const renewals: number[] = [];
    let calls = 0;
    const client = { rpc: async (fn: string, a: Record<string, unknown>) => { t += 1000; calls++; if (fn === "renew_reporting_lease") renewals.push(t); return inner.rpc(fn, a); } };
    const started = t;
    const r = await runReportingCycle({ client, now: () => t, sleep: async () => undefined }, { site: "au", mode: "rebuild" });
    expect(["pending", "published"]).toContain(r.state);
    expect(r.problems).toEqual([]);
    const beats = [started, ...renewals];
    const gaps = beats.slice(1).map((x, i) => x - beats[i]);
    // Due every 30 s; on ONE serialized connection a due renewal can queue behind at most the group's in-flight reads
    // (OWNER_GROUP + the renewal + one), at 1 simulated second per call. Before the fix: one 511 s gap.
    expect(Math.max(...gaps), `renewal gaps (ms): ${gaps.join(",")}`).toBeLessThanOrEqual(HEARTBEAT_MS + (OWNER_GROUP + 2) * 1000);
    expect(Math.max(...gaps)).toBeLessThan(360_000 / 8); // far inside the 360 s lease
    if (r.state === "pending") expect(t - started).toBeLessThanOrEqual(WORKER_BUDGET_MS + 8 * 1000 + 5000);
    expect(calls).toBeGreaterThan(0);
  }, 300_000);
});

describe("long-span owners over the real SQL: exact publication and children RPC count", () => {
  it("a full rebuild publishes exactly (mirror = source; daily totals = the independent reducer, site and every worker)", async () => {
    const db = await reportingDb();
    try {
      for (let w = 0; w < 4; w++) await db.query("insert into auth.users (id, email) values ($1, $2)", [W(w), `w${w}@x`]);
      for (const e of longSpan(4, 250)) { // publish is slow in single-threaded PGlite at higher volume (not the worker)
        await db.query(
          `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
           values ('au', $1, $2, 'framed', $3, $4, $5, $6, 's', '', $7, $8)`,
          [e.id, e.staff_id, e.order_number, e.line_sku, e.line_quantity, e.event_type, e.created_at, e.parent_event_id]);
      }
      const c = pgRpc(db);
      expect((await c.rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
      expect((await c.rpc("set_reporting_site_mode", { p_site: "au", p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
      const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined }, { site: "au", mode: "rebuild" });
      expect(r.problems).toEqual([]);
      expect(r.state).toBe("published");
      const children = c.calls.filter((f) => f === "read_reporting_children").length;
      for (const who of [null, ...Array.from({ length: 4 }, (_, w) => W(w))]) expect(await parityProblems(pgDb(db), "au", who)).toEqual([]);
      // measured on this exact data: 1,280 children RPCs at 3d57bec (before the walk fix), 360 after
      expect(children).toBeLessThan(500);
    } finally {
      await db.close();
    }
  }, 300_000);
});
