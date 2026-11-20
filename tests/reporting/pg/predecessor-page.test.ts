/**
 * Task 15 scale contingency (0045), over the REAL 0037-0045 SQL (PGlite,
 * offline): public.read_reporting_predecessor_page against an independent
 * oracle built from the installed 0042 stream read and 0041 children read,
 * over a frozen REBUILD candidate and a frozen REFRESH overlay.
 *
 *  - rows: every line exactly as the 'before' stream page; children ONLY for
 *    line_verified lines in the certain range and the FIRST one below it
 *    (never a later candidate), each exactly as its children read; the end row
 *    only when nothing was cut;
 *  - the bytewise same-instant boundary (id bound) and the instant-only
 *    fallback (ids whose UTF-16 and bytewise order differ);
 *  - bounds: <= 1,000 rows including the end row, <= 1 MiB complete response,
 *    a cut response carries no end row; the walk then DISCARDS that combined
 *    page and reads it the previous way (exact owner input either way);
 *  - anon/authenticated are refused; the read writes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import { buildOwnerInput, memoryFrozenReader, ownerKey, type CertainBound, type FrozenReader, type Owner } from "../../../api/_lib/production-reporting-materialize";
import { imageToEvent, rpcFrozenReader, type EnumerationPages, type FrozenBatchRef } from "../../../api/_lib/production-reporting-reader";
import type { RpcClient } from "../../../api/_lib/reporting-jobs";
import { compareUtf8 } from "../../../api/_lib/reporting-stage";
import { exactInstant, type ProductionEvidenceEvent } from "../../../src/lib/domain/productionCounts";
import { canonicalJson } from "../../../src/lib/domain/productionReporting";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

type Ev = ProductionEvidenceEvent;
type Json = Record<string, unknown>;
interface Out { row_kind: string; event_id: string | null; image: Json | null }
const SITE = "au";
const FB = "INKA-KAN0566-A4-FB";
const W = (i: number) => `${String(i).padStart(8, "0")}-cccc-4ccc-8ccc-cccccccccccc`;
const at = (s: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + s * 1000).toISOString();
const MiB = 1048576;
const SMILE = "t-\u{1F600}"; // bytewise after U+FFFD, UTF-16 before it
const REPL = "t-�";

interface Row { id: string; staff: string; order: string | null; type: string; s: number; parent?: string | null }
const line = (id: string, staff: string, order: string, s: number): Row => ({ id, staff, order, type: "line_verified", s });
const cancel = (id: string, staff: string, order: string, s: number, parent: string): Row => ({ id, staff, order, type: "cancelled", s, parent });

/** Worker 0: clustered orders with cancellations, then one long order. Worker 1: same-instant ties at s=5000 with exotic ids. */
function base(between: number, orders = 12): Row[] {
  const s0 = W(0);
  const out: Row[] = [];
  let t = 0;
  for (let o = 0; o < orders; o++) {
    out.push({ id: `c${o}-clock`, staff: s0, order: null, type: "clock_in", s: t++ });
    for (let i = 0; i < 10; i++) {
      const id = `c${String(o).padStart(2, "0")}-l${i}`;
      out.push(line(id, s0, `CL-${o}`, (t += 30)));
      if (i === 3) out.push(cancel(`${id}-x`, s0, `CL-${o}`, t + 1, id));
    }
  }
  out.push(line("long-a", s0, "LONG", (t += 30)));
  for (let i = 0; i < between; i++) {
    const id = `m${String(i).padStart(4, "0")}`;
    out.push(line(id, s0, `MID-${Math.floor(i / 5)}`, (t += 30)));
    if (i % 7 === 0) out.push(cancel(`${id}-x`, s0, `MID-${Math.floor(i / 5)}`, t + 1, id));
  }
  out.push(line("long-b", s0, "LONG", (t += 30)));
  const s1 = W(1);
  out.push(line("pre1", s1, "PRE", 4000), line("pre0", s1, "PRE0", 3000));
  for (const [id, order] of [["t-a", "TA"], ["t-b", "TIE"], ["t-c", "TC"], [REPL, "EXO"], [SMILE, "TS"]] as const) out.push(line(id, s1, order, 5000));
  out.push(cancel("t-a-x", s1, "TA", 5001, "t-a"), cancel("t-c-x", s1, "TC", 5001, "t-c"), cancel("pre1-x", s1, "PRE", 4001, "pre1"));
  out.push(line("tie-hi", s1, "TIE", 6000), line("exo-hi", s1, "EXO", 6100));
  return out;
}
async function insert(db: PGlite, rows: readonly Row[]) {
  for (const r of rows) {
    const isLine = r.type === "line_verified";
    await db.query(
      `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
       values ($1, $2, $3, 'framed', $4, $5, $6, $7, 's', '', $8, $9)`,
      [SITE, r.id, r.staff, r.order, isLine ? FB : null, isLine ? 1 : null, r.type, at(r.s), r.parent ?? null]);
  }
}
/** Worker 2: a line in the long span with 1,500 cancellations (the 1,000-row cap cuts it). Worker 3: 2 KB order numbers (the 1 MiB cap cuts). The cancellations are worker 4's (off both streams). */
async function bulky(db: PGlite) {
  const s2 = W(2), s3 = W(3);
  await insert(db, [line("big-pre", s2, "BPRE", 100), line("big-a", s2, "BIG", 200), line("big-mid", s2, "BMID", 300), line("big-b", s2, "BIG", 400)]);
  await db.query(`insert into public.production_events (location, id, staff_id, department, order_number, event_type, station_id, note, created_at, parent_event_id)
    select $1, 'bk' || lpad(g::text, 5, '0'), $2, 'framed', 'BMID', 'cancelled', 's', '', $3::timestamptz + g * interval '1 millisecond', 'big-mid' from generate_series(1, 1500) g`, [SITE, W(4), at(301)]);
  const long = (k: string) => k + "-" + "L".repeat(2000);
  await insert(db, [line("byt-pre", s3, long("YPRE"), 100), line("byt-a", s3, long("BYT"), 200), line("byt-mid", s3, long("YMID"), 300), line("byt-b", s3, long("BYT"), 400)]);
  await db.query(`insert into public.production_events (location, id, staff_id, department, order_number, event_type, station_id, note, created_at, parent_event_id)
    select $1, 'yk' || lpad(g::text, 5, '0'), $2, 'framed', $4, 'cancelled', 's', '', $3::timestamptz + g * interval '1 millisecond', 'byt-mid' from generate_series(1, 600) g`, [SITE, W(4), at(301), long("YMID")]);
}

const never = new Promise<never>(() => undefined);
const neverIter = { [Symbol.asyncIterator]: () => ({ next: () => never }) };
function holdAtFrozen(db: PGlite, mode: "rebuild" | "refresh"): Promise<FrozenBatchRef> {
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
    }, { site: SITE, mode }).then((r) => reject(new Error(`the cycle ended before a frozen read: ${JSON.stringify(r)}`)), reject);
  });
}
async function setup(db: PGlite) {
  for (let w = 0; w < 5; w++) await db.query("insert into auth.users (id, email) values ($1, $2)", [W(w), `w${w}@x`]);
  const c = pgRpc(db);
  expect((await c.rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
  expect((await c.rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
}
/** The frozen view as plain table reads: the candidate (rebuild) or the overlay over the base mirror (refresh). */
async function frozenView(db: PGlite, ref: FrozenBatchRef): Promise<Ev[]> {
  const q = async (sql: string, p: unknown[]) => (await db.query<{ id: string; image: Json | null }>(sql, p)).rows;
  if (ref.kind === "rebuild") return (await q("select event_id as id, image from reporting_private.source_candidate where batch_id = $1 and site = $2", [ref.batchId, SITE])).map((x) => imageToEvent(x.image, SITE, x.id));
  const view = new Map((await q("select event_id as id, image from reporting_private.source_current where site = $1", [SITE])).map((x) => [x.id, x.image]));
  for (const o of await q("select event_id as id, image from reporting_private.batch_events where batch_id = $1 and site = $2", [ref.batchId, SITE])) {
    if (o.image === null) view.delete(o.id);
    else view.set(o.id, o.image);
  }
  return [...view.entries()].map(([id, image]) => imageToEvent(image, SITE, id));
}

const args = (ref: FrozenBatchRef, staff: string, from: { at: string; id: string }, certain: CertainBound | null, limit: number) =>
  ({ p_batch: ref.batchId, p_fence: ref.fence, p_staff: staff, p_at: from.at, p_at_event_id: from.id, p_certain_at: certain?.createdAt ?? null, p_certain_event_id: certain?.id ?? null, p_limit: limit });
async function page(c: RpcClient, ref: FrozenBatchRef, staff: string, from: { at: string; id: string }, certain: CertainBound | null, limit: number): Promise<Out[]> {
  const r = await c.rpc("read_reporting_predecessor_page", args(ref, staff, from, certain, limit));
  if (r.error) throw new Error(r.error.message);
  return r.data as Out[];
}
/** The independent oracle: the installed 0042 'before' page, the stated certain rule, and the installed 0041 children read per included line. */
async function oracle(c: RpcClient, ref: FrozenBatchRef, staff: string, from: { at: string; id: string }, certain: CertainBound | null, limit: number): Promise<Out[]> {
  const s = await c.rpc("read_reporting_staff_stream", { p_batch: ref.batchId, p_fence: ref.fence, p_staff: staff, p_direction: "before", p_at: from.at, p_at_event_id: from.id, p_limit: limit });
  if (s.error) throw new Error(s.error.message);
  const cu = certain ? exactInstant(certain.createdAt)! : null;
  let open = true;
  const out: Out[] = [];
  for (const l of s.data as Array<{ event_id: string; image: Json }>) {
    const us = exactInstant(String(l.image.created_at))!;
    let kids = false;
    if (l.image.event_type === "line_verified") {
      if (cu !== null && (us > cu || (certain!.id !== null && us === cu && compareUtf8(l.event_id, certain!.id) >= 0))) kids = true;
      else if (open) [kids, open] = [true, false];
    }
    out.push({ row_kind: kids ? "line_kids" : "line", event_id: l.event_id, image: l.image });
    if (!kids) continue;
    let after: string | null = null;
    for (;;) {
      const k = await c.rpc("read_reporting_children", { p_batch: ref.batchId, p_fence: ref.fence, p_parent_ids: [l.event_id], p_after_parent_id: after === null ? null : l.event_id, p_after_event_id: after, p_limit: 1000 });
      if (k.error) throw new Error(k.error.message);
      const rows = k.data as Array<{ event_id: string; image: Json }>;
      if (!rows.length) break;
      for (const x of rows) out.push({ row_kind: "child", event_id: x.event_id, image: x.image });
      after = rows[rows.length - 1].event_id;
    }
  }
  if (out.length < 1000) out.push({ row_kind: "end", event_id: null, image: null });
  return out;
}
const bytes = (rows: unknown[]) => new TextEncoder().encode(JSON.stringify(rows)).length;
const kidsOf = (rows: Out[]) => rows.filter((r) => r.row_kind === "line_kids").map((r) => r.event_id);
const TOP = { at: at(9_000_000), id: "" };
const inputKey = (i: { owner: Owner; members: Ev[]; events: Ev[] }) => canonicalJson({ o: ownerKey(i.owner), m: i.members.map((e) => e.id), e: i.events });
const order = (k: string): Owner => ({ partitionKind: "order", partitionKey: k });
/** Counts and sequences the RPCs a reader makes. */
function recording(db: PGlite) {
  const inner = pgRpc(db);
  const calls: Array<{ fn: string; a: Record<string, unknown>; rows: number }> = [];
  const client: RpcClient = { rpc: async (fn, a) => { const r = await inner.rpc(fn, a); calls.push({ fn, a, rows: Array.isArray(r.data) ? r.data.length : 0 }); return r; } };
  return { client, calls };
}

for (const mode of ["rebuild", "refresh"] as const) {
  describe(`0045 over a frozen ${mode} view`, () => {
    let db: PGlite;
    let ref: FrozenBatchRef;
    let view: Ev[];
    beforeAll(async () => {
      db = await reportingDb();
      await setup(db);
      await insert(db, base(mode === "rebuild" ? 420 : 60));
      if (mode === "rebuild") await bulky(db);
      else {
        const r = await runReportingCycle({ client: pgRpc(db), now: () => Date.now(), sleep: async () => undefined }, { site: SITE, mode: "rebuild" });
        expect(r.problems).toEqual([]);
        expect(r.state).toBe("published");
        // overlay: an inserted cancellation of a BASE line, a replacement, a tombstone, inserted lines (one in the long span)
        await insert(db, [cancel("m0003-x2", W(0), "MID-0", 0, "m0003"), line("m-new", W(0), "MID-NEW", 0), cancel("t-b-x", W(1), "TIE", 5002, "t-b")]);
        await db.query("update public.production_events set created_at = (select created_at + interval '10 seconds' from public.production_events where location = $1 and id = 'm0030') where location = $1 and id = 'm-new'", [SITE]);
        await db.query("update public.production_events set order_number = 'MID-0B' where location = $1 and id = 'm0002'", [SITE]);
        await db.query("delete from public.production_events where location = $1 and id in ('m0007-x', 'c03-l5')", [SITE]);
      }
      ref = await holdAtFrozen(db, mode);
      expect(ref.kind).toBe(mode);
      view = await frozenView(db, ref);
      if (mode === "refresh") {
        const over = (await db.query<{ id: string; image: unknown }>("select event_id as id, image from reporting_private.batch_events where batch_id = $1", [ref.batchId])).rows;
        expect(over.filter((o) => o.image === null).map((o) => o.id).sort()).toEqual(["c03-l5", "m0007-x"]);
        expect(over.some((o) => o.id === "m0003-x2") && over.some((o) => o.id === "m0002")).toBe(true);
      }
    }, 300_000);
    afterAll(async () => db?.close());

    it("rows equal the oracle (installed stream + children reads) for many cursors, bounds and limits; children never beyond the first below-boundary candidate", async () => {
      const c = pgRpc(db);
      const w0 = view.filter((e) => e.staff_id === W(0) && e.event_type === "line_verified").sort((a, b) => compareUtf8(a.created_at, b.created_at) || compareUtf8(a.id, b.id));
      const pick = (i: number) => w0[Math.floor(i * (w0.length - 1))];
      let cases = 0;
      for (const fromF of [1, 0.8, 0.5]) for (const boundF of [null, 0.9, 0.6, 0.3, 0]) for (const limit of [1, 7, 200]) {
        const f = pick(fromF);
        const from = { at: f.created_at, id: f.id };
        const b = boundF === null ? null : pick(boundF);
        for (const certain of b === null ? [null] : [{ createdAt: b.created_at, id: b.id }, { createdAt: b.created_at, id: null }]) {
          const got = await page(c, ref, W(0), from, certain, limit);
          expect(got, JSON.stringify({ fromF, boundF, limit, certain })).toEqual(await oracle(c, ref, W(0), from, certain, limit));
          // exactly one included line outside the certain range at most, and it is the FIRST line_verified one there
          const cu = certain ? exactInstant(certain.createdAt)! : null;
          const outside = got.filter((r) => r.row_kind.startsWith("line") && r.image!.event_type === "line_verified"
            && !(cu !== null && (exactInstant(String(r.image!.created_at))! > cu || (certain!.id !== null && exactInstant(String(r.image!.created_at))! === cu && compareUtf8(r.event_id!, certain!.id) >= 0))));
          expect(outside.slice(1).every((r) => r.row_kind === "line")).toBe(true);
          if (outside.length) expect(outside[0].row_kind).toBe("line_kids");
          cases++;
        }
      }
      expect(cases).toBe(3 * (1 + 4 * 2) * 3);
    }, 120_000);

    it("the bytewise same-instant boundary: an id bound includes exactly the ties at or above it; the instant-only bound includes none but the first", async () => {
      const c = pgRpc(db);
      const T = at(5000);
      const ids = (rows: Out[]) => kidsOf(rows);
      const exact = await page(c, ref, W(1), TOP, { createdAt: T, id: "t-b" }, 200);
      // bytewise descending at T: SMILE, REPL, t-c, t-b (certain), then t-a = the first below: included; pre1/pre0 not
      expect(exact.filter((r) => r.row_kind.startsWith("line") && r.image!.event_type === "line_verified").map((r) => r.event_id)).toEqual(["exo-hi", "tie-hi", SMILE, REPL, "t-c", "t-b", "t-a", "pre1", "pre0"]);
      expect(ids(exact)).toEqual(["exo-hi", "tie-hi", SMILE, REPL, "t-c", "t-b", "t-a"]);
      const instant = await page(c, ref, W(1), TOP, { createdAt: T, id: null }, 200);
      expect(ids(instant)).toEqual(["exo-hi", "tie-hi", SMILE]);
      expect(instant).toEqual(await oracle(c, ref, W(1), TOP, { createdAt: T, id: null }, 200));
      expect(exact).toEqual(await oracle(c, ref, W(1), TOP, { createdAt: T, id: "t-b" }, 200));
      // and the owner inputs over both boundaries equal the in-memory reference (TIE uses the id bound; EXO's earliest id is not bytewise-safe)
      const mem = memoryFrozenReader({ site: SITE, cutoff: ref.cutoff, kind: mode, view, changed: [] });
      for (const o of ["TIE", "EXO", "TA", "TS", "PRE"].map(order)) {
        expect(inputKey(await buildOwnerInput(rpcFrozenReader(pgRpc(db), ref), o)), o.partitionKey).toBe(inputKey(await buildOwnerInput({ ...mem, predecessorPage: undefined }, o)));
      }
    });

    it("every owner of worker 0 has the reference input, and its walk is about one round trip per page", async () => {
      const mem = memoryFrozenReader({ site: SITE, cutoff: ref.cutoff, kind: mode, view, changed: [] });
      const owners = [...new Set(view.filter((e) => e.staff_id === W(0) && e.order_number).map((e) => e.order_number!.trim()))].sort().map(order);
      let walk = 0;
      let before = 0;
      for (const o of owners) {
        const { client, calls } = recording(db);
        expect(inputKey(await buildOwnerInput(rpcFrozenReader(client, ref), o)), o.partitionKey).toBe(inputKey(await buildOwnerInput({ ...mem, predecessorPage: undefined }, o)));
        walk += calls.length - calls.findIndex((x) => x.fn === "read_reporting_predecessor_page");
        // the same owner through the bebedcb walk (no 0045 read): identical input, and its walk RPCs
        const prev = recording(db);
        const r = rpcFrozenReader(prev.client, ref);
        expect(inputKey(await buildOwnerInput({ ...r, predecessorPage: undefined }, o))).toBe(inputKey(await buildOwnerInput({ ...mem, predecessorPage: undefined }, o)));
        before += prev.calls.length - prev.calls.findIndex((x) => x.fn === "read_reporting_staff_stream");
      }
      // most owners: ONE call (their predecessor's children come with the page); an extra call only when the first
      // below-boundary candidate does not satisfy the walk (the next one is read alone: no lookahead)
      expect(walk, `${owners.length} owners: walk RPCs ${before} -> ${walk}`).toBeLessThan(before / 2);
      expect(walk).toBeLessThanOrEqual(Math.ceil(owners.length * 1.25) + 4);
    }, 120_000);

    it("service-only: anon and authenticated are refused; the read writes nothing", async () => {
      const a = args(ref, W(0), TOP, null, 200);
      const before = (await db.query<{ h: string }>("select md5(string_agg(to_jsonb(t)::text, '' order by to_jsonb(t)::text)) as h from reporting_private.batches t")).rows[0].h;
      expect((await pgRpc(db).rpc("read_reporting_predecessor_page", a)).error).toBeNull();
      for (const role of ["anon", "authenticated"]) {
        const r = await pgRpc(db, { role }).rpc("read_reporting_predecessor_page", a);
        expect(r.error?.message ?? "", role).toMatch(/permission denied/i);
      }
      const acl = (await db.query<Json>(`select p.prosecdef as definer, array_to_string(p.proconfig, ',') as config,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
          has_function_privilege('service_role', p.oid, 'EXECUTE') as service
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'read_reporting_predecessor_page'`)).rows;
      expect(acl).toEqual([{ definer: false, config: 'search_path=""', anon: false, auth: false, service: true }]);
      const after = (await db.query<{ h: string }>("select md5(string_agg(to_jsonb(t)::text, '' order by to_jsonb(t)::text)) as h from reporting_private.batches t")).rows[0].h;
      expect(after).toBe(before);
    });

    it("refuses bad parameters and a wrong fence", async () => {
      const c = pgRpc(db);
      for (const [k, v, re] of [["p_limit", 0, /p_limit/], ["p_limit", 1001, /p_limit/], ["p_at", null, /required/], ["p_certain_event_id", "x", /needs p_certain_at/], ["p_fence", 999, /fence|obsolete|lease|batch/i]] as const) {
        const r = await c.rpc("read_reporting_predecessor_page", { ...args(ref, W(0), TOP, null, 200), [k]: v });
        expect(r.error?.message ?? "", k).toMatch(re);
      }
    });

    if (mode === "rebuild") {
      it("the 1,000-row cap cuts inside a certain line's children: no end row; the walk discards that page and reads it the previous way (exact input)", async () => {
        const c = pgRpc(db);
        const certain = { createdAt: at(200), id: "big-a" };
        const got = await page(c, ref, W(2), TOP, certain, 200);
        expect(got).toHaveLength(1000);
        expect(got.some((r) => r.row_kind === "end")).toBe(false);
        expect(got).toEqual((await oracle(c, ref, W(2), TOP, certain, 200)).slice(0, 1000));
        const { client, calls } = recording(db);
        const input = await buildOwnerInput(rpcFrozenReader(client, ref), order("BIG"));
        expect(inputKey(input)).toBe(inputKey(await buildOwnerInput(memoryFrozenReader({ site: SITE, cutoff: ref.cutoff, kind: "rebuild", view, changed: [] }), order("BIG"))));
        expect(input.events.filter((e) => e.parent_event_id === "big-mid")).toHaveLength(1500);
        // the cut combined page is followed by the plain page FROM THE SAME CURSOR (nothing advanced)
        const i = calls.findIndex((x) => x.fn === "read_reporting_predecessor_page");
        expect(calls[i + 1].fn).toBe("read_reporting_staff_stream");
        expect([calls[i + 1].a.p_at, calls[i + 1].a.p_at_event_id]).toEqual([calls[i].a.p_at, calls[i].a.p_at_event_id]);
      });
      it("the 1 MiB cap cuts inside a line's children (2 KB rows): the response stays within 1 MiB, carries no end row, and the walk falls back exactly", async () => {
        const c = pgRpc(db);
        const certain = { createdAt: at(200), id: "byt-a" };
        const got = await page(c, ref, W(3), TOP, certain, 200);
        expect(got.length).toBeLessThan(600);
        expect(bytes(got)).toBeLessThanOrEqual(MiB);
        expect(got.some((r) => r.row_kind === "end")).toBe(false);
        expect(got).toEqual((await oracle(c, ref, W(3), TOP, certain, 200)).slice(0, got.length));
        const input = await buildOwnerInput(rpcFrozenReader(pgRpc(db), ref), order("BYT-" + "L".repeat(2000)));
        expect(input.events.filter((e) => e.parent_event_id === "byt-mid")).toHaveLength(600);
      });
    }
  });
}
