/**
 * Task 15 third hosted blocker (US rerun at bebedcb, 2026-11-17): one full
 * 240 s worker budget planned only 139 of 16,060 owners (549 RPCs). The
 * predecessor walk of every owner still costs several sequential round trips
 * per stream page: the page (read_reporting_staff_stream), the certain lines'
 * children (read_reporting_children, plus the empty probe that ends them) and
 * the first stop candidate's own children.
 *
 * Contingency under test (0045): read_reporting_predecessor_page returns ONE
 * worker stream page of the frozen batch, in the same bytewise keyset order,
 * WITH the children of exactly the lines the walk is certain to consume (every
 * line_verified line at or above the earliest member, and the first one below
 * it), under the same 1,000-row / 1 MiB complete-response bounds, and says
 * when the page and every included line's children are complete. The walk is
 * then about one round trip per stream page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../api/_lib/production-reporting-worker";
import {
  buildOwnerInput, MAX_PARTITION_EVENTS, memoryFrozenReader, ownerKey, PartitionTooLargeError, type FrozenReader, type Owner,
} from "../../api/_lib/production-reporting-materialize";
import { imageToEvent, rpcFrozenReader, type EnumerationPages, type FrozenBatchRef } from "../../api/_lib/production-reporting-reader";
import type { RpcClient } from "../../api/_lib/reporting-jobs";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";
import { canonicalJson } from "../../src/lib/domain/productionReporting";
import { reportingDb } from "./pg/harness";
import { pgRpc } from "./pg/rpc";

type Ev = ProductionEvidenceEvent;
const SITE = "au";
const FB = "INKA-KAN0566-A4-FB";
const W = (i: number) => `${String(i).padStart(8, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
const at = (s: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + s * 1000).toISOString().replace("Z", "000Z");
const ev = (id: string, type: string, order: string | null, staff: string, s: number, o: Partial<Ev> = {}): Ev =>
  ({ id, location: SITE, staff_id: staff, department: "framed", order_number: order, line_sku: type === "line_verified" ? FB : null, line_quantity: type === "line_verified" ? 1 : null, event_type: type, created_at: at(s), parent_event_id: null, cs_case_id: null, ...o });

/** Worker 0: 30 clustered orders of 25 lines (the hosted shape) then ONE long order spanning `between` lines; some lines cancelled. */
export function fixture(between: number): Ev[] {
  const s = W(0);
  const out: Ev[] = [];
  let t = 0;
  for (let o = 0; o < 30; o++) {
    out.push(ev(`c${String(o).padStart(2, "0")}-clock`, "clock_in", null, s, t++, { line_sku: null, line_quantity: null }));
    for (let i = 0; i < 25; i++) {
      const id = `c${String(o).padStart(2, "0")}-l${String(i).padStart(2, "0")}`;
      out.push(ev(id, "line_verified", `CL-${o}`, s, (t += 30)));
      if (i === 7) out.push(ev(`${id}-x`, "cancelled", `CL-${o}`, s, t + 1, { parent_event_id: id }));
    }
  }
  out.push(ev("long-a", "line_verified", "LONG", s, (t += 30)));
  for (let i = 0; i < between; i++) {
    const id = `m${String(i).padStart(5, "0")}`;
    out.push(ev(id, "line_verified", `MID-${Math.floor(i / 5)}`, s, (t += 30)));
    if (i % 9 === 0) out.push(ev(`${id}-x`, "cancelled", `MID-${Math.floor(i / 5)}`, s, t + 1, { parent_event_id: id }));
  }
  out.push(ev("long-b", "line_verified", "LONG", s, (t += 30)));
  return out;
}
const CL = (o: number): Owner => ({ partitionKind: "order", partitionKey: `CL-${o}` });
const LONG: Owner = { partitionKind: "order", partitionKey: "LONG" };
const WALK_FNS = new Set(["read_reporting_staff_stream", "read_reporting_predecessor_page", "read_reporting_children"]);

/** The RPCs one owner's predecessor walk makes: every call from the first stream read on (members, parents and members' children come first). */
function walkCalls(calls: readonly string[]): string[] {
  const i = calls.findIndex((f) => f === "read_reporting_staff_stream" || f === "read_reporting_predecessor_page");
  return i < 0 ? [] : calls.slice(i).filter((f) => WALK_FNS.has(f));
}

const never = new Promise<never>(() => undefined);
const neverIter = { [Symbol.asyncIterator]: () => ({ next: () => never }) };
/** Runs the REAL worker cycle and holds it at its first frozen read: the batch stays frozen/fenced/leased. */
function holdAtFrozen(db: PGlite): Promise<FrozenBatchRef> {
  return new Promise<FrozenBatchRef>((resolve, reject) => {
    void runReportingCycle({
      client: pgRpc(db), now: () => Date.now(), sleep: async () => undefined,
      source: (ref) => {
        resolve(ref);
        const reader: FrozenReader = {
          site: ref.site, cutoff: ref.cutoff, kind: ref.kind,
          changedKeys: () => neverIter, owners: () => neverIter, children: () => neverIter,
          members: () => never, byIds: () => never, childPage: () => never, stream: () => never, requests: () => 0,
        };
        const pages: EnumerationPages = { changedKeyPage: () => never, ownerPage: () => never };
        return { reader, pages };
      },
    }, { site: SITE, mode: "rebuild" }).then((r) => reject(new Error(`the cycle ended before a frozen read: ${JSON.stringify(r)}`)), reject);
  });
}
async function insert(db: PGlite, events: readonly Ev[]) {
  for (const e of events) {
    await db.query(
      `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
       values ($1, $2, $3, 'framed', $4, $5, $6, $7, 's', '', $8, $9)`,
      [SITE, e.id, e.staff_id, e.order_number, e.line_sku, e.line_quantity, e.event_type, e.created_at, e.parent_event_id]);
  }
}
const inputKey = (i: { owner: Owner; members: Ev[]; events: Ev[] }) => canonicalJson({ o: ownerKey(i.owner), m: i.members.map((e) => e.id), e: i.events });

describe("real SQL: the predecessor walk is about one round trip per stream page", () => {
  const view = fixture(600);
  let db: PGlite;
  let ref: FrozenBatchRef;
  let frozen: Ev[];
  beforeAll(async () => {
    db = await reportingDb();
    await db.query("insert into auth.users (id, email) values ($1, 'w0@x')", [W(0)]);
    await insert(db, view);
    const c = pgRpc(db);
    expect((await c.rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
    expect((await c.rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
    ref = await holdAtFrozen(db);
    // the oracle reads the frozen candidate images themselves (exact stored text)
    const r = await db.query<{ id: string; image: unknown }>("select event_id as id, image from reporting_private.source_candidate where batch_id = $1 and site = $2", [ref.batchId, SITE]);
    frozen = r.rows.map((x) => imageToEvent(x.image, SITE, x.id));
    expect(frozen).toHaveLength(view.length);
  }, 300_000);
  afterAll(async () => db?.close());

  const measure = async (owner: Owner) => {
    const client = pgRpc(db);
    const reader = rpcFrozenReader(client, ref);
    const input = await buildOwnerInput(reader, owner);
    const oracle = await buildOwnerInput(memoryFrozenReader({ site: SITE, cutoff: ref.cutoff, kind: "rebuild", view: frozen, changed: [] }), owner);
    return { input, oracle, walk: walkCalls(client.calls) };
  };

  it("a clustered owner (25 lines, its predecessor right below): identical input in ONE walk round trip (bebedcb: 3)", async () => {
    const { input, oracle, walk } = await measure(CL(17));
    expect(inputKey(input)).toBe(inputKey(oracle));
    expect(walk, walk.join(",")).toHaveLength(1);
  });
  it("a long owner (600 lines between its members, ~670 stream events): identical input, at most one round trip per 200-event page + 1", async () => {
    const { input, oracle, walk } = await measure(LONG);
    expect(inputKey(input)).toBe(inputKey(oracle));
    expect(walk.length, walk.join(",")).toBeLessThanOrEqual(Math.ceil(670 / 200) + 1);
  });
  it("the read is service-only: anon and authenticated are refused, nothing is returned", async () => {
    const args = { p_batch: ref.batchId, p_fence: ref.fence, p_staff: W(0), p_at: at(10_000_000), p_at_event_id: "", p_certain_at: null, p_certain_event_id: null, p_limit: 200 };
    const ok = await pgRpc(db).rpc("read_reporting_predecessor_page", args);
    expect(ok.error).toBeNull();
    for (const role of ["anon", "authenticated"]) {
      const r = await pgRpc(db, { role }).rpc("read_reporting_predecessor_page", args);
      expect(r.error?.message ?? "", role).toMatch(/permission denied/i);
      expect(r.data ?? null).toBeNull();
    }
  });
});

describe("in memory: the walk uses one page-with-children read per stream page", () => {
  const view = fixture(600);
  const counting = (r: FrozenReader) => {
    const calls: string[] = [];
    const reader: FrozenReader = {
      ...r,
      stream: (...a) => (calls.push("stream"), r.stream(...a)),
      children: (ids) => (calls.push("children"), r.children(ids)),
      childPage: (...a) => (calls.push("childPage"), r.childPage(...a)),
      ...(r.predecessorPage ? { predecessorPage: (...a: Parameters<NonNullable<FrozenReader["predecessorPage"]>>) => (calls.push("page"), r.predecessorPage!(...a)) } : {}),
    };
    return { reader, calls };
  };
  it("a clustered owner: one walk read (bebedcb: 3), identical input", async () => {
    const base = memoryFrozenReader({ site: SITE, cutoff: "2026-11-15T12:00:00.000000Z", kind: "rebuild", view, changed: [] });
    const { reader, calls } = counting(base);
    const got = await buildOwnerInput(reader, CL(17));
    const want = await buildOwnerInput({ ...base, predecessorPage: undefined }, CL(17));
    expect(inputKey(got)).toBe(inputKey(want));
    const i = calls.findIndex((c) => c === "stream" || c === "page");
    expect(calls.slice(i), calls.join(",")).toEqual(["page"]);
  });
});

describe("in memory: exact semantics over the page-with-children read", () => {
  const CUT = "2026-11-15T12:00:00.000000Z";
  const mem = (view: Ev[], maxPage?: number) => memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [], maxPage });
  /** Counts every child row a reader hands out (children, childPage and the page's included children). */
  const rowsRead = (r: FrozenReader) => {
    const c = { kids: 0, pages: 0, fallbacks: 0 };
    let lastPage: string | null = null;
    const reader: FrozenReader = {
      ...r,
      children: (ids) => (async function* () { for await (const e of r.children(ids)) { c.kids++; yield e; } })(),
      childPage: async (...a) => { const p = await r.childPage(...a); c.kids += p.length; return p; },
      stream: async (staff, dir, from, limit) => { if (lastPage === `${from.createdAt}|${from.id}`) c.fallbacks++; return r.stream(staff, dir, from, limit); },
      predecessorPage: r.predecessorPage && (async (staff, from, certain, limit) => {
        c.pages++;
        lastPage = `${from.createdAt}|${from.id}`;
        const p = await r.predecessorPage!(staff, from, certain, limit);
        for (const l of p.lines) c.kids += l.kids?.length ?? 0;
        return p;
      }),
    };
    return { reader, c };
  };
  it("identical inputs with and without 0045 for every owner at row caps 1, 7 and 1000 (cut pages are discarded and re-read the previous way)", async () => {
    const view = fixture(300);
    const owners = [...new Set(view.filter((e) => e.order_number).map((e) => e.order_number!))].sort().map((k): Owner => ({ partitionKind: "order", partitionKey: k }));
    for (const maxPage of [1, 7, undefined]) {
      let fallbacks = 0;
      for (const o of owners) {
        const want = await buildOwnerInput({ ...mem(view, maxPage), predecessorPage: undefined }, o);
        const { reader, c } = rowsRead(mem(view, maxPage));
        expect(inputKey(await buildOwnerInput(reader, o)), `${o.partitionKey} @ ${maxPage}`).toBe(inputKey(want));
        fallbacks += c.fallbacks;
      }
      if (maxPage === 1) expect(fallbacks).toBeGreaterThan(0); // the cut path is exercised
      if (maxPage === undefined) expect(fallbacks).toBe(0);
    }
  }, 120_000);
  it("no children after the first below-boundary candidate: an old line below the predecessor with 60,000 cancellations is never read", async () => {
    const view = fixture(600);
    view.push(ev("ancient", "line_verified", "ANCIENT", W(0), -100));
    for (let i = 1; i <= 60_000; i++) view.push(ev(`k${String(i).padStart(6, "0")}`, "cancelled", "ANCIENT", W(1), -50, { parent_event_id: "ancient" }));
    for (const owner of [LONG, CL(17)]) for (const maxPage of [1, 7, undefined]) {
      const ref = rowsRead({ ...mem(view, maxPage), predecessorPage: undefined });
      const want = await buildOwnerInput(ref.reader, owner);
      const { reader, c } = rowsRead(mem(view, maxPage));
      const got = await buildOwnerInput(reader, owner);
      expect(inputKey(got)).toBe(inputKey(want));
      expect(got.events.some((e) => e.id === "ancient")).toBe(false);
      // uncut: exactly the child rows the previous walk consumed; cut: plus at most each discarded window (certain lines only)
      if (maxPage === undefined) expect(c.kids, owner.partitionKey).toBe(ref.c.kids);
      else expect(c.kids, `${owner.partitionKey} @ ${maxPage}`).toBeLessThanOrEqual(ref.c.kids + c.pages * maxPage);
      expect(c.kids).toBeLessThan(60_000);
    }
  }, 120_000);
  it("the 50,000 overflow inside the span is attributed exactly (owner, size 50,001) and reading stops promptly", async () => {
    const view = fixture(300);
    for (let i = 1; i <= 60_000; i++) view.push(ev(`z${String(i).padStart(6, "0")}`, "cancelled", "MID-30", W(1), 30_000, { parent_event_id: "m00150" }));
    const ref = await buildOwnerInput({ ...mem(view), predecessorPage: undefined }, LONG).then(() => null, (e: unknown) => e);
    const { reader, c } = rowsRead(mem(view));
    const err = await buildOwnerInput(reader, LONG).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PartitionTooLargeError);
    expect((err as PartitionTooLargeError).owner).toEqual(LONG);
    expect((err as PartitionTooLargeError).size).toBe(MAX_PARTITION_EVENTS + 1);
    expect((ref as PartitionTooLargeError).size).toBe(MAX_PARTITION_EVENTS + 1);
    expect(c.fallbacks).toBe(1); // the cut page (1,000 rows) was discarded, then read the previous way
    expect(c.kids).toBeLessThanOrEqual(MAX_PARTITION_EVENTS + 2 * 1000);
  }, 120_000);
});

describe("malformed or unproven predecessor pages are never taken as a stream end", () => {
  const CUT = "2026-11-15T12:00:00.000000Z";
  it("a page with zero lines and complete=false falls back to the plain page from the same cursor (exact input)", async () => {
    const view = fixture(300);
    const base = memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] });
    const seen: string[] = [];
    const reader: FrozenReader = {
      ...base,
      predecessorPage: async (_s, from) => (seen.push(`page ${from.createdAt}|${from.id}`), { lines: [], complete: false }),
      stream: (staff, dir, from, limit) => (seen.push(`stream ${from.createdAt}|${from.id}`), base.stream(staff, dir, from, limit)),
    };
    for (const o of [LONG, CL(17)]) {
      seen.length = 0;
      const got = await buildOwnerInput(reader, o);
      expect(inputKey(got)).toBe(inputKey(await buildOwnerInput({ ...base, predecessorPage: undefined }, o)));
      expect(seen[0].startsWith("page ")).toBe(true);
      expect(seen[1]).toBe(seen[0].replace("page ", "stream "));
    }
  });
  const fake = (data: unknown[]): RpcClient => ({ rpc: async () => ({ data, error: null }) });
  const REF: FrozenBatchRef = { batchId: "00000000-0000-4000-8000-000000000001", fence: 3, site: SITE, cutoff: "2026-11-15T12:00:00.000000Z", kind: "rebuild" };
  const img = (e: Ev) => ({ ...e });
  const a = ev("pa", "line_verified", "X", W(0), 100);
  const b = ev("pb", "line_verified", "X", W(0), 50);
  const kid = ev("pa-x", "cancelled", "X", W(0), 101, { parent_event_id: "pa" });
  const FROM = { createdAt: at(1000), id: "" };
  const L = (k: string, e: Ev) => ({ row_kind: k, event_id: e.id, image: img(e) });
  const END = { row_kind: "end", event_id: null, image: null };
  it.each([
    ["an empty response (no end row)", [], /no rows/],
    ["an end row that is not last", [END, L("line", a)], /misplaced end/],
    ["an end row with an id", [L("line", a), { ...END, event_id: "x" }], /misplaced end/],
    ["lines out of descending order", [L("line", b), L("line", a), END], /descending/],
    ["a line at or after the cursor", [L("line", ev("late", "line_verified", "X", W(0), 2000)), END], /descending/],
    ["another worker's line", [L("line", ev("o", "line_verified", "X", W(1), 10)), END], /another worker/],
    ["a child after a plain line", [L("line", a), L("child", kid), END], /child of another line/],
    ["a child of another parent", [L("line_kids", b), L("child", kid), END], /child of another line/],
    ["an unknown row kind", [{ row_kind: "x", event_id: "pa", image: img(a) }], /unknown row kind/],
  ])("rejects %s", async (_n, rows, re) => {
    await expect(rpcFrozenReader(fake(rows as unknown[]), REF).predecessorPage!(W(0), FROM, null, 200)).rejects.toThrow(re as RegExp);
  });
  it("accepts the end-only page as the proven stream end, and a cut page without end as incomplete", async () => {
    const end = await rpcFrozenReader(fake([END]), REF).predecessorPage!(W(0), FROM, null, 200);
    expect(end).toEqual({ lines: [], complete: true });
    const cut = await rpcFrozenReader(fake([L("line_kids", a), L("child", kid)]), REF).predecessorPage!(W(0), FROM, null, 200);
    expect(cut.complete).toBe(false);
    expect(cut.lines[0].kidsComplete).toBe(false);
  });
});
