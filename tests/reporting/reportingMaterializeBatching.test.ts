/**
 * Task 15 hosted scale fix (2026-11-17): child reads are batched only where
 * they are already independently required.
 *
 *  - an owner's members' children: one lazy multi-parent read (was one RPC per member);
 *  - consumed stream lines' children across a bounded group of concurrently
 *    materialized owners: coalesced into one bounded multi-parent page (each
 *    request is still issued only when its line is consumed: no lookahead).
 *
 * Reference: the same owners materialized one at a time over a reader that
 * serves every multi-parent request as sequential single-parent reads (the
 * pre-fix RPC pattern); plus the complete-history oracle. Outputs (descriptors,
 * input hashes, rows) must be identical; overflow attribution and early stops
 * unchanged; children RPCs substantially fewer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { OWNER_GROUP, runReportingCycle } from "../../api/_lib/production-reporting-worker";
import { reportingDb } from "./pg/harness";
import { pgRpc } from "./pg/rpc";
import {
  coalescingChildren, materializeOwnerGroup, materializeOwnerWorks, MAX_PARTITION_EVENTS, memoryFrozenReader, ownerKey, PartitionTooLargeError, rowsByOwner,
  type FrozenReader, type MaterializedWork, type MaterializeStats, type Owner,
} from "../../api/_lib/production-reporting-materialize";
import { canonicalJson, REPORTING_RULE_VERSION } from "../../src/lib/domain/productionReporting";
import { projectReportingPartition } from "../../src/lib/domain/productionReportingProjection";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";

type Ev = ProductionEvidenceEvent;
const SITE = "uk";
const CUT = "2026-11-15T12:00:00.000000Z";
const FB = "INKA-KAN0566-A4-FB";
const STAFF = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"];
const at = (s: number) => new Date(Date.parse("2026-11-02T06:00:00Z") + s * 1000).toISOString().replace("Z", "000Z");
const ev = (id: string, type: string, order: string | null, staff: string, s: number, o: Partial<Ev> = {}): Ev =>
  ({ id, location: SITE, staff_id: staff, department: "framed", order_number: order, line_sku: type === "line_verified" ? FB : null, line_quantity: type === "line_verified" ? 1 : null, event_type: type, created_at: at(s), parent_event_id: null, cs_case_id: null, ...o });

/** Realistic shape: four workers, each a clock-in then clustered orders (6 lines + completion); some lines cancelled shortly after. */
function clustered(ordersPerWorker = 25): Ev[] {
  const out: Ev[] = [];
  STAFF.forEach((w, wi) => {
    let t = wi * 7;
    out.push(ev(`w${wi}-in`, "clock_in", null, w, t));
    for (let o = 0; o < ordersPerWorker; o++) {
      const order = `CL-${wi}-${o}`;
      for (let l = 0; l < 6; l++) {
        t += 60;
        const id = `w${wi}-o${o}-l${l}`;
        out.push(ev(id, "line_verified", order, w, t));
        if ((o + l) % 7 === 0) out.push(ev(`${id}-x`, "cancelled", order, w, t + 5, { parent_event_id: id }));
      }
      t += 60;
      out.push(ev(`w${wi}-o${o}-done`, "completed", order, w, t));
    }
  });
  return out;
}

/** Counts underlying children() calls (= read_reporting_children RPC groups) and rows. */
function counted(r: FrozenReader) {
  const c = { childCalls: 0, childRows: 0, parentsRequested: 0 };
  const reader: FrozenReader = {
    ...r,
    children(ids) {
      c.childCalls++;
      c.parentsRequested += ids.length;
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
/** The pre-fix RPC pattern: a multi-parent request is served as sequential single-parent reads. */
function singleParent(r: FrozenReader): FrozenReader {
  return {
    ...r,
    children(ids) {
      return (async function* () {
        for (const p of [...new Set(ids)].sort()) yield* r.children([p]);
      })();
    },
  };
}
const ownersOf = (view: readonly Ev[]): Owner[] => {
  const m = new Map<string, Owner>();
  for (const e of view) {
    const o: Owner = e.order_number?.trim() ? { partitionKind: "order", partitionKey: e.order_number.trim() } : { partitionKind: "event", partitionKey: e.id };
    m.set(ownerKey(o), o);
  }
  return [...m.values()].sort((a, b) => (ownerKey(a) < ownerKey(b) ? -1 : 1));
};
const stats = (): MaterializeStats => ({ owners: 0, works: 0, maxInput: 0, totalInput: 0, requests: 0, peakInput: 0 });
const key = (w: MaterializedWork) => canonicalJson({ d: w.desc, r: w.rows });

async function sequentialReference(view: Ev[]) {
  const { reader, c } = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] }));
  const old = singleParent(reader);
  const works: MaterializedWork[] = [];
  for (const o of ownersOf(view)) works.push(...(await materializeOwnerWorks(old, o, [], stats())));
  return { works, c };
}

describe("child-read batching: exact parity with the sequential single-parent reference, far fewer children RPCs", () => {
  it("member children: one lazy multi-parent read per owner instead of one per member (same outputs, same input hashes)", async () => {
    const view = clustered();
    const ref = await sequentialReference(view);
    const { reader, c } = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] }));
    const works: MaterializedWork[] = [];
    for (const o of ownersOf(view)) works.push(...(await materializeOwnerWorks(reader, o, [], stats())));
    expect(works.map(key)).toEqual(ref.works.map(key));
    expect(c.childCalls).toBeLessThan(ref.c.childCalls * 0.6);
    expect(c.childRows).toBe(ref.c.childRows); // the same child rows are read: nothing extra
  });
  it("grouped owners over the coalescing reader: identical outputs in owner order; children RPCs reduced by well over half again", async () => {
    const view = clustered();
    const ref = await sequentialReference(view);
    const { reader, c } = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] }));
    const coalesced = coalescingChildren(reader);
    const owners = ownersOf(view);
    const works: MaterializedWork[] = [];
    for (let i = 0; i < owners.length; i += 8) {
      const settled = await materializeOwnerGroup(coalesced, owners.slice(i, i + 8).map((owner) => ({ owner, oldStaff: [] })), stats());
      for (const s of settled) {
        if (s.status === "rejected") throw s.reason;
        works.push(...s.value);
      }
    }
    expect(works.map(key)).toEqual(ref.works.map(key));
    expect(c.childCalls).toBeLessThan(ref.c.childCalls * 0.25);
    // every row matches the complete-history oracle (site audience)
    const oracle = rowsByOwner(projectReportingPartition({ site: SITE, audience: { kind: "site" }, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: CUT, events: view }));
    for (const w of works.filter((x) => x.desc.audienceKind === "site")) {
      const want = oracle.get(ownerKey({ partitionKind: w.desc.partitionKind, partitionKey: w.desc.partitionKey }))?.rows;
      expect(canonicalJson(w.rows)).toBe(canonicalJson(want ?? { event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] }));
    }
    expect(c.childCalls).toBeLessThan(ref.c.childCalls * 0.15); // measured at commit: 1,500 -> 116
  });
  it("no lookahead: an unconsumed candidate's 60,000 cancellations are never requested, also when coalesced across a group", async () => {
    const A = STAFF[0];
    // RP-1's walk stops at p0 (never consuming "old"); RP-2 (another worker) walks concurrently in the same group.
    const view: Ev[] = [ev("p0", "line_verified", "RP-0", A, 100), ev("v", "line_verified", "RP-1", A, 200), ev("old", "line_verified", "RP-OLD", A, 50), ev("q0", "line_verified", "RP-Q", STAFF[2], 90), ev("q", "line_verified", "RP-2", STAFF[2], 190)];
    for (let i = 1; i <= 60_000; i++) view.push(ev(`k${String(i).padStart(6, "0")}`, "cancelled", null, STAFF[1], 60, { parent_event_id: "old" }));
    const { reader, c } = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [], maxPage: 3 }));
    const settled = await materializeOwnerGroup(coalescingChildren(reader), [{ owner: { partitionKind: "order", partitionKey: "RP-1" }, oldStaff: [] }, { owner: { partitionKind: "order", partitionKey: "RP-2" }, oldStaff: [] }], stats());
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    expect(c.childRows).toBe(0);
  }, 60_000);
  it("overflow attribution is unchanged inside a group: the failing owner is reported with size 50,001; earlier owners' results are intact", async () => {
    const A = STAFF[0];
    const view: Ev[] = [ev("a1", "line_verified", "AA", A, 10), ev("t", "completed", "ZZ", A, 20)];
    for (let i = 1; i <= 60_000; i++) view.push(ev(`c${String(i).padStart(6, "0")}`, "cancelled", null, STAFF[1], 30 + i, { parent_event_id: "t" }));
    const { reader, c } = counted(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [] }));
    const settled = await materializeOwnerGroup(coalescingChildren(reader), [{ owner: { partitionKind: "order", partitionKey: "AA" }, oldStaff: [] }, { owner: { partitionKind: "order", partitionKey: "ZZ" }, oldStaff: [] }], stats());
    expect(settled[0].status).toBe("fulfilled");
    expect(settled[1].status).toBe("rejected");
    const err = (settled[1] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(PartitionTooLargeError);
    expect((err as PartitionTooLargeError).owner).toEqual({ partitionKind: "order", partitionKey: "ZZ" });
    expect((err as PartitionTooLargeError).size).toBe(MAX_PARTITION_EVENTS + 1);
    expect(c.childRows).toBeLessThanOrEqual(MAX_PARTITION_EVENTS + 1000); // stops promptly (at most one bounded page beyond the proof)
  }, 120_000);
  it("byte/row-capped pages: identical outputs at page sizes 1, 3 and 1000", async () => {
    const view = clustered(6);
    const ref = await sequentialReference(view);
    for (const maxPage of [1, 3, 1000]) {
      const coalesced = coalescingChildren(memoryFrozenReader({ site: SITE, cutoff: CUT, kind: "rebuild", view, changed: [], maxPage }));
      const settled = await materializeOwnerGroup(coalesced, ownersOf(view).map((owner) => ({ owner, oldStaff: [] })), stats());
      expect(settled.flatMap((s) => (s.status === "fulfilled" ? s.value : [])).map(key), `maxPage ${maxPage}`).toEqual(ref.works.map(key));
    }
  });
});

describe("the worker's plan AND stage paths over the real SQL (PGlite): grouped vs one-at-a-time give identical published state", () => {
  const dbs: PGlite[] = [];
  /** Four workers, clustered orders, cancellations; inserted through the real source table. */
  async function seeded(): Promise<PGlite> {
    const db = await reportingDb();
    dbs.push(db);
    for (const s of STAFF) await db.query("insert into auth.users (id, email) values ($1, $2)", [s, `${s.slice(0, 4)}@x`]);
    for (const e of clustered(12)) {
      await db.query(
        `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
         values ('uk', $1, $2, 'framed', $3, $4, $5, $6, 's', '', $7, $8)`,
        [e.id, e.staff_id, e.order_number, e.line_sku, e.line_quantity, e.event_type, e.created_at, e.parent_event_id]);
    }
    const c = pgRpc(db);
    expect((await c.rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
    expect((await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
    return db;
  }
  /** Everything a publication produced, without generation identities (both runs publish their own first generation). */
  const published = async (db: PGlite) => {
    const q = async (sql: string) => (await db.query<{ x: string }>(`select x from (${sql}) s order by x`)).rows.map((r) => r.x);
    const facts = (t: string) => q(`select (to_jsonb(t) - 'valid_from_seq' - 'valid_to_seq')::text as x from reporting_private.${t} t where valid_to_seq is null`);
    return {
      // input_hash covers each database's own frozen cutoff (the two runs freeze at different instants), so it is compared
      // at equal cutoffs above (materializer parity) and re-proven per owner by the stage path's planned-hash check.
      work: await q("select audience_kind || ':' || coalesce(audience_staff::text, '') || ':' || partition_kind || ':' || partition_key || ':' || chunk_count || ':' || coalesce(result_digest, '') || ':' || state as x from reporting_private.partition_work"),
      cutoffs: await q("select count(*)::text as x from reporting_private.partition_work where input_hash !~ '^[0-9a-f]{64}$'"),
      daily: await facts("daily_totals"), events: await facts("event_facts"), timing: await facts("timing_facts"), occurrences: await facts("order_occurrences"), cancels: await facts("cancel_edges"),
    };
  };
  /** Per table: rows only in one database (empty = identical). */
  const differences = async () => {
    const [a, b] = [await published(one), await published(grouped)];
    const out: Record<string, { oneOnly: string[]; groupedOnly: string[] }> = {};
    for (const k of Object.keys(a) as Array<keyof typeof a>) {
      const oneOnly = a[k].filter((x) => !b[k].includes(x));
      const groupedOnly = b[k].filter((x) => !a[k].includes(x));
      if (oneOnly.length || groupedOnly.length || a[k].length !== b[k].length) out[k] = { oneOnly: oneOnly.slice(0, 3), groupedOnly: groupedOnly.slice(0, 3) };
    }
    return out;
  };
  const cycle = async (db: PGlite, mode: "rebuild" | "refresh", ownerGroup: number) => {
    const c = pgRpc(db);
    const r = await runReportingCycle({ client: c, now: () => Date.now(), sleep: async () => undefined, ownerGroup }, { site: "uk", mode });
    expect(r.problems, `${mode} group ${ownerGroup}`).toEqual([]);
    expect(r.state).toBe("published");
    return c.calls.filter((f) => f === "read_reporting_children").length;
  };
  const change = async (db: PGlite) => {
    await db.query("update public.production_events set note = 'changed' where id = 'w1-o3-l2'");
    await db.query("delete from public.production_events where id = 'w2-o5-l1'");
    await db.query(`insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
      values ('uk', 'w0-o4-l2-x2', $1, 'framed', 'CL-0-4', null, null, 'cancelled', 's', '', $2, 'w0-o4-l2')`, [STAFF[0], at(60 * 33)]);
  };
  let one: PGlite;
  let grouped: PGlite;
  beforeAll(async () => {
    one = await seeded();
    grouped = await seeded();
  }, 120_000);
  afterAll(async () => { for (const d of dbs) await d.close(); });

  it(`rebuild then refresh: identical descriptors, input hashes, chunk digests and published rows; group ${OWNER_GROUP} reads children in far fewer RPCs`, async () => {
    const rb1 = await cycle(one, "rebuild", 1);
    const rbG = await cycle(grouped, "rebuild", OWNER_GROUP);
    expect(await differences()).toEqual({});
    await change(one);
    await change(grouped);
    const rf1 = await cycle(one, "refresh", 1);
    const rfG = await cycle(grouped, "refresh", OWNER_GROUP);
    expect(await differences()).toEqual({});
    // measured at commit: rebuild 960 -> 225, refresh 79 -> 43
    expect(rbG).toBeLessThan(rb1 * 0.25);
    expect(rfG).toBeLessThanOrEqual(rf1);
  }, 240_000);
});
