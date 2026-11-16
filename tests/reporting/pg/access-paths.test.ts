/**
 * Task 14 access-path repair (0042), over the REAL 0037–0044 SQL (PGlite, offline).
 *
 * The real worker builds a frozen batch (rebuild: copy + freeze; refresh: a
 * published rebuild, source edits, freeze) and is held at its first frozen
 * read, so the batch stays frozen, fenced and leased while the tests call the
 * installed public.read_reporting_owner_members / read_reporting_staff_stream
 * through the PostgREST-shaped RPC client.
 *
 *  - Exact parity: every page (identities, images, order) equals an
 *    independent oracle computed from plain table reads of the frozen view
 *    (source_candidate, or batch_events over source_current), with first and
 *    later keysets, event/order/mixed owners, overlay replacements/tombstones/
 *    inserts, both stream directions, ties, page sizes and the 1 MiB
 *    complete-response cap (short pages continue from the last keyset).
 *  - Security/immutability: client roles are refused; reads change nothing.
 *  - Structure: EXPLAIN ANALYZE of the exact effective SELECTs. 0042's rebuild
 *    members read only the owners' rows by keyed lookups and its stream
 *    branches stop near one page; the same assertions FAIL on the 0041 shapes.
 *    The refresh overlay (batch_events) stream branch is NOT claimed bounded:
 *    its scanned rows are measured and reported (a remaining hosted gate).
 *
 * PGlite proves semantics and plan shape on this fixture, not hosted scan
 * counts; the rollback-only 0042 plan diagnostic is the hosted gate.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runReportingCycle } from "../../../api/_lib/production-reporting-worker";
import type { FrozenReader } from "../../../api/_lib/production-reporting-materialize";
import type { EnumerationPages, FrozenBatchRef } from "../../../api/_lib/production-reporting-reader";
import { compareUtf8 } from "../../../api/_lib/reporting-stage";
import { boundReadQuery } from "../../staging/reportingDependencyRehearsal";
import { reportingDb } from "./harness";
import { pgRpc } from "./rpc";

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const W3 = "33333333-3333-4333-8333-333333333333";
const T41 = readFileSync("supabase/migrations/0041_reporting_dependency_read_bounds.sql", "utf8");
const T42 = readFileSync("supabase/migrations/0042_reporting_access_paths.sql", "utf8");
const MiB = 1048576;

type Json = Record<string, unknown>;
interface Row { id: string; orderKey: string | null; staff: string; at: number; image: Json }
type OwnerArg = ["order" | "event", string];
interface MemberOut { owner_index: number; event_id: string; image: Json }
interface StreamOut { event_id: string; image: Json }

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

/** Bulk events: every 50th a clock event (an event owner), orders BULK-0..599 (some padded), ties in groups of six seconds. */
async function bulk(db: PGlite, n: number) {
  await db.query(
    `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at)
     select 'uk', 'v' || lpad(g::text, 5, '0'), (array[$1, $2, $3]::uuid[])[g % 3 + 1], 'framed',
            case when g % 50 = 0 then null when g % 97 = 0 then '  BULK-' || (g % 600) || ' ' else 'BULK-' || (g % 600) end,
            case when g % 50 = 0 then null else 'INKA-KAN0566-A4-FB' end, case when g % 50 = 0 then null else 1 end,
            case when g % 50 = 0 then 'clock_in' else 'line_verified' end, 's', '',
            timestamptz '2026-03-01 00:00:00+00' + ((g / 6) * interval '1 second')
       from generate_series(1, $4::int) g`,
    [W1, W2, W3, n],
  );
}
async function one(db: PGlite, id: string, staff: string, order: string | null, at: string, note = "") {
  await db.query(
    `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at)
     values ('uk', $1, $2, 'framed', $3, $4, $5, $6, 's', $7, $8)`,
    [id, staff, order, order === null ? null : "INKA-KAN0566-A4-FB", order === null ? null : 1, order === null ? "clock_in" : "line_verified", note, at],
  );
}

async function setup(db: PGlite) {
  await db.query("insert into auth.users (id, email) values ($1, 'a@x'), ($2, 'b@x'), ($3, 'c@x')", [W1, W2, W3]);
  const c = pgRpc(db);
  expect((await c.rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
  expect((await c.rpc("set_reporting_site_mode", { p_site: "uk", p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
}

const never = new Promise<never>(() => undefined);
const neverIter = { [Symbol.asyncIterator]: () => ({ next: () => never }) };
/** Runs the REAL worker cycle and holds it at its first frozen read: the batch stays frozen/fenced/leased. */
function holdAtFrozen(db: PGlite, mode: "rebuild" | "refresh"): Promise<FrozenBatchRef> {
  return new Promise<FrozenBatchRef>((resolve, reject) => {
    void runReportingCycle({
      client: pgRpc(db), now: () => Date.now(), sleep: async () => undefined,
      source: (ref) => {
        resolve(ref);
        const reader: FrozenReader = {
          site: ref.site, cutoff: ref.cutoff, kind: ref.kind,
          changedKeys: () => neverIter, owners: () => neverIter, children: () => neverIter,
          members: () => never, byIds: () => never, childPage: () => never, stream: () => never,
        };
        const pages: EnumerationPages = { changedKeyPage: () => never, ownerPage: () => never };
        return { reader, pages };
      },
    }, { site: "uk", mode }).then((r) => reject(new Error(`the cycle ended before a frozen read: ${JSON.stringify(r)}`)), reject);
  });
}

// ---------------------------------------------------------------------------
// the independent oracle (plain table reads of the frozen view)
// ---------------------------------------------------------------------------

const trimKey = (s: unknown) => (typeof s === "string" ? s.replace(/^[\s ﻿]+|[\s ﻿]+$/g, "") : null);
const toRow = (id: string, image: Json): Row => ({ id, orderKey: trimKey(image.order_number), staff: String(image.staff_id), at: Date.parse(String(image.created_at)), image });

/** The frozen view as the reads must see it: the candidate (rebuild) or the overlay over the base mirror (refresh). */
async function frozenView(db: PGlite, ref: FrozenBatchRef): Promise<Row[]> {
  if (ref.kind === "rebuild") {
    const r = await db.query<{ id: string; order_key: string | null; image: Json }>("select event_id as id, order_key, image from reporting_private.source_candidate where batch_id = $1 and site = 'uk'", [ref.batchId]);
    return r.rows.map((x) => { const row = toRow(x.id, x.image); expect(row.orderKey ?? "").toBe(x.order_key ?? ""); return row; });
  }
  const base = await db.query<{ id: string; image: Json }>("select event_id as id, image from reporting_private.source_current where site = 'uk'");
  const over = await db.query<{ id: string; image: Json | null }>("select event_id as id, image from reporting_private.batch_events where batch_id = $1 and site = 'uk'", [ref.batchId]);
  const view = new Map(base.rows.map((x) => [x.id, toRow(x.id, x.image)]));
  for (const o of over.rows) {
    if (o.image === null) view.delete(o.id);
    else view.set(o.id, toRow(o.id, o.image));
  }
  return [...view.values()];
}

/** The complete JSON row size (+ separator) exactly as PostgreSQL text renders it (a plain expression, not the reader). */
async function sizes(db: PGlite, rows: Array<Record<string, unknown>>): Promise<number[]> {
  if (!rows.length) return [];
  const r = await db.query<{ n: number }>(
    `select (pg_catalog.octet_length((case when a.x ? 'owner_index' then jsonb_build_object('owner_index', (a.x ->> 'owner_index')::int, 'event_id', a.x ->> 'event_id', 'image', a.x -> 'image')
                                           else jsonb_build_object('event_id', a.x ->> 'event_id', 'image', a.x -> 'image') end)::text) + 1)::int as n
       from jsonb_array_elements($1::jsonb) with ordinality a(x, o) order by a.o`,
    [JSON.stringify(rows)],
  );
  return r.rows.map((x) => x.n);
}
/** Take `limit` rows, then the complete-response cap: brackets (2) + each row; a short page at the first row that would exceed 1 MiB. */
async function capPage<T extends Record<string, unknown>>(db: PGlite, ordered: T[], limit: number): Promise<T[]> {
  const page = ordered.slice(0, limit);
  const n = await sizes(db, page);
  let bytes = 2;
  const out: T[] = [];
  for (let i = 0; i < page.length; i++) {
    if (bytes + n[i] > MiB) {
      if (i === 0) throw new Error("oracle: one row is larger than 1 MiB");
      break;
    }
    bytes += n[i];
    out.push(page[i]);
  }
  return out;
}

function memberOrder(view: Row[], owners: OwnerArg[]): MemberOut[] {
  const out: MemberOut[] = [];
  owners.forEach(([kind, key], idx) => {
    const hits = view.filter((r) => (kind === "order" ? r.orderKey === key : r.id === key && (r.orderKey ?? "") === ""));
    hits.sort((a, b) => compareUtf8(a.id, b.id));
    for (const h of hits) out.push({ owner_index: idx, event_id: h.id, image: h.image });
  });
  return out;
}
function afterMember(all: MemberOut[], after: [number, string] | null): MemberOut[] {
  return after === null ? all : all.filter((m) => m.owner_index > after[0] || (m.owner_index === after[0] && compareUtf8(m.event_id, after[1]) > 0));
}
interface Pos { at: string; id: string }
function streamOrder(view: Row[], staff: string, dir: "before" | "after", pos: Pos): StreamOut[] {
  const at = Date.parse(pos.at);
  const cmp = (r: Row) => (r.at !== at ? r.at - at : compareUtf8(r.id, pos.id));
  const hits = view.filter((r) => r.staff === staff && (dir === "after" ? cmp(r) > 0 : cmp(r) < 0));
  hits.sort((a, b) => (a.at !== b.at ? a.at - b.at : compareUtf8(a.id, b.id)) * (dir === "after" ? 1 : -1));
  return hits.map((h) => ({ event_id: h.id, image: h.image }));
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

async function members(db: PGlite, ref: FrozenBatchRef, owners: OwnerArg[], after: [number, string] | null, limit: number, role?: string) {
  return pgRpc(db, { role }).rpc("read_reporting_owner_members", { p_batch: ref.batchId, p_fence: ref.fence, p_owners: owners, p_after_index: after?.[0] ?? null, p_after_event_id: after?.[1] ?? null, p_limit: limit });
}
async function stream(db: PGlite, ref: FrozenBatchRef, staff: string, dir: "before" | "after", pos: Pos, limit: number, role?: string) {
  return pgRpc(db, { role }).rpc("read_reporting_staff_stream", { p_batch: ref.batchId, p_fence: ref.fence, p_staff: staff, p_direction: dir, p_at: pos.at, p_at_event_id: pos.id, p_limit: limit });
}
function ok<T>(r: { data: unknown; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

/** Walks every page from the first keyset; each page must equal the oracle page from its keyset. Returns the pages. */
async function walkMembers(db: PGlite, ref: FrozenBatchRef, view: Row[], owners: OwnerArg[], limit: number) {
  const all = memberOrder(view, owners);
  let after: [number, string] | null = null;
  const got: MemberOut[] = [];
  const pageSizes: number[] = [];
  for (let guard = 0; guard < 10_000; guard++) {
    const page = ok<MemberOut[]>(await members(db, ref, owners, after, limit));
    expect(page).toEqual(await capPage(db, afterMember(all, after), limit));
    if (!page.length) break;
    pageSizes.push(page.length);
    got.push(...page);
    const last = page[page.length - 1];
    after = [last.owner_index, last.event_id];
  }
  expect(got).toEqual(all);
  return { all, pageSizes };
}
async function walkStream(db: PGlite, ref: FrozenBatchRef, view: Row[], staff: string, dir: "before" | "after", start: Pos, limit: number) {
  const all = streamOrder(view, staff, dir, start);
  let pos = start;
  const got: StreamOut[] = [];
  const pageSizes: number[] = [];
  for (let guard = 0; guard < 10_000; guard++) {
    const page = ok<StreamOut[]>(await stream(db, ref, staff, dir, pos, limit));
    expect(page).toEqual(await capPage(db, streamOrder(view, staff, dir, pos), limit));
    if (!page.length) break;
    pageSizes.push(page.length);
    got.push(...page);
    const last = page[page.length - 1];
    pos = { at: String(last.image.created_at), id: last.event_id };
  }
  expect(got).toEqual(all);
  return { all, pageSizes };
}

// ---------------------------------------------------------------------------
// plans
// ---------------------------------------------------------------------------

interface PlanNode { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string; "Actual Rows"?: number; "Actual Loops"?: number; "Rows Removed by Filter"?: number; "Rows Removed by Index Recheck"?: number; Plans?: PlanNode[] }
function flat(n: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(n);
  for (const c of n.Plans ?? []) flat(c, out);
  return out;
}
/** Rows a scan node read: produced plus removed by its own filters, over every loop. */
const scanned = (n: PlanNode) => ((n["Actual Rows"] ?? 0) + (n["Rows Removed by Filter"] ?? 0) + (n["Rows Removed by Index Recheck"] ?? 0)) * (n["Actual Loops"] ?? 0);
const onRel = (nodes: PlanNode[], rel: string) => nodes.filter((n) => n["Relation Name"] === rel);
const readOf = (nodes: PlanNode[], rel: string) => onRel(nodes, rel).reduce((s, n) => s + scanned(n), 0);

async function explain(db: PGlite, text: string, fn: "read_reporting_owner_members" | "read_reporting_staff_stream", ref: FrozenBatchRef, params: unknown[], settings: string[] = []): Promise<PlanNode[]> {
  const sql = `EXPLAIN (ANALYZE, FORMAT JSON) ${boundReadQuery(text, fn)}`;
  await db.exec("begin");
  try {
    for (const s of settings) await db.exec(s);
    const r = await db.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(sql, [ref.batchId, "uk", ref.kind, ...params]);
    return flat(r.rows[0]["QUERY PLAN"][0].Plan);
  } finally {
    await db.exec("rollback");
  }
}

/** The 0042 members bound: the candidate is read by keyed lookups and only about the owners' own rows are read. */
function membersBounded(nodes: PlanNode[], memberRows: number, owners: number): boolean {
  const sc = onRel(nodes, "source_candidate");
  const keyed = sc.length > 0 && sc.every((n) => scanned(n) === 0 || /order_key = |event_id = /.test(n["Index Cond"] ?? ""));
  return keyed && readOf(nodes, "source_candidate") <= memberRows + owners;
}
/** The stream bound for a mirror relation: each executed branch read at most about one page. */
function streamBounded(nodes: PlanNode[], rel: string, limit: number): boolean {
  const s = onRel(nodes, rel);
  return s.length > 0 && s.every((n) => scanned(n) <= limit + 1);
}

// ===========================================================================

describe("0042 rebuild dependency reads over a frozen candidate (PGlite)", () => {
  let db: PGlite;
  let ref: FrozenBatchRef;
  let view: Row[];
  beforeAll(async () => {
    db = await reportingDb();
    await setup(db);
    await bulk(db, 3000);
    // bytewise ordering inside one tie group of W1 (C order: "Z" < "a" < "v" < "~" < "ä")
    for (const id of ["Zq-1", "aq-1", "~q-1", "äq-1"]) await one(db, id, W1, "BULK-6", "2026-03-01T00:00:01+00:00");
    // four ~400 KB images: one owner and one worker whose pages the 1 MiB response cap shortens
    for (let i = 1; i <= 4; i++) await one(db, `big-${i}`, W3, "BIG", `2026-03-09T00:00:0${i}+00:00`, "x".repeat(400_000));
    ref = await holdAtFrozen(db, "rebuild");
    expect(ref.kind).toBe("rebuild");
    await db.exec("analyze reporting_private.source_candidate");
    view = await frozenView(db, ref);
    expect(view.length).toBe(3008);
  }, 300_000);
  beforeEach(async () => { expect((await pgRpc(db).rpc("renew_reporting_lease", { p_batch: ref.batchId, p_fence: ref.fence })).error).toBeNull(); });
  afterAll(async () => db?.close());

  const orderOwners = (keys: number[]): OwnerArg[] => keys.map((k) => ["order", `BULK-${k}`]);
  const clock = (g: number): OwnerArg => ["event", `v${String(g).padStart(5, "0")}`];

  it("order owners (incl. a trimmed padded order and a missing key): every page and the whole walk, at several page sizes", async () => {
    const owners: OwnerArg[] = [...orderOwners([6, 97 % 600, 3, 599]), ["order", "NOPE"], ["order", "BULK-1"]];
    for (const limit of [1, 3, 7, 1000]) {
      const { all } = await walkMembers(db, ref, view, owners, limit);
      expect(all.length).toBeGreaterThan(20);
      expect(all.some((m) => m.event_id === "v00097")).toBe(true); // stored as '  BULK-97 ', owner key BULK-97
    }
  }, 120_000);
  it("event owners: the clock event alone; an event id that has an order is not an event owner", async () => {
    const owners: OwnerArg[] = [clock(50), clock(100), ["event", "v00001"], clock(2950)];
    const { all } = await walkMembers(db, ref, view, owners, 2);
    expect(all.map((m) => [m.owner_index, m.event_id])).toEqual([[0, "v00050"], [1, "v00100"], [3, "v02950"]]);
  }, 60_000);
  it("mixed owners keep ordinality and bytewise order inside an owner, with first and later cursors", async () => {
    const owners: OwnerArg[] = [["order", "BULK-6"], clock(150), ["order", "BULK-10"], clock(200)];
    const { all } = await walkMembers(db, ref, view, owners, 4);
    const six = all.filter((m) => m.owner_index === 0).map((m) => m.event_id);
    expect(six.slice(0, 2)).toEqual(["Zq-1", "aq-1"]);
    expect(six.slice(-2)).toEqual(["~q-1", "äq-1"]);
    // a later cursor in the middle of owner 2
    const mid = all.findIndex((m) => m.owner_index === 2) + 1;
    const after: [number, string] = [all[mid].owner_index, all[mid].event_id];
    expect(ok<MemberOut[]>(await members(db, ref, owners, after, 3))).toEqual(await capPage(db, afterMember(all, after), 3));
  }, 60_000);
  it("the 1 MiB complete-response cap shortens a member page; the walk continues from the last keyset", async () => {
    const { pageSizes, all } = await walkMembers(db, ref, view, [["order", "BIG"], ["order", "BULK-6"]], 1000);
    expect(all.filter((m) => m.owner_index === 0)).toHaveLength(4);
    expect(pageSizes[0]).toBe(2); // two 400 KB rows fit, a third would pass 1 MiB
    expect(pageSizes.length).toBeGreaterThanOrEqual(2); // the next page continues at big-3
  }, 60_000);
  it("worker streams in both directions: ties, bytewise ids, page sizes, from the ends and from mid positions", async () => {
    const first: Pos = { at: "2000-01-01T00:00:00+00:00", id: "" };
    const last: Pos = { at: "2100-01-01T00:00:00+00:00", id: "" };
    const tie: Pos = { at: "2026-03-01T00:00:01+00:00", id: "aq-1" }; // inside W1's tie group at 00:00:01
    for (const limit of [7, 200]) {
      const a = await walkStream(db, ref, view, W1, "after", first, limit);
      expect(a.all.length).toBeGreaterThan(900);
      const b = await walkStream(db, ref, view, W1, "before", last, limit);
      expect(b.all.map((x) => x.event_id)).toEqual([...a.all].reverse().map((x) => x.event_id));
    }
    const after = await walkStream(db, ref, view, W1, "after", tie, 3);
    // the rest of the tie group in bytewise order: bulk v00006/v00009 ("v" 0x76) before "~" and "ä"
    expect(after.all.slice(0, 4).map((x) => x.event_id)).toEqual(["v00006", "v00009", "~q-1", "äq-1"]);
    const before = await walkStream(db, ref, view, W1, "before", tie, 3);
    expect(before.all[0].event_id).toBe("Zq-1");
  }, 240_000);
  it("the 1 MiB cap shortens a stream page in each direction", async () => {
    const a = await walkStream(db, ref, view, W3, "after", { at: "2026-03-08T00:00:00+00:00", id: "" }, 200);
    expect(a.pageSizes[0]).toBe(2);
    const b = await walkStream(db, ref, view, W3, "before", { at: "2100-01-01T00:00:00+00:00", id: "" }, 200);
    expect(b.pageSizes[0]).toBe(2);
  }, 60_000);
  it("parameter checks, the fence and the frozen lock are unchanged", async () => {
    const pos: Pos = { at: "2026-03-01T00:00:00+00:00", id: "" };
    expect((await members(db, ref, [["order", "BULK-1"]], null, 0)).error?.message).toMatch(/p_limit must be 1..1000/);
    expect((await members(db, ref, [["order", "BULK-1"]], null, 1001)).error?.message).toMatch(/p_limit must be 1..1000/);
    expect((await members(db, ref, Array.from({ length: 101 }, (_, i) => ["order", `K${i}`] as OwnerArg), null, 10)).error?.message).toMatch(/1..100/);
    expect((await members(db, ref, [["order", ""] as OwnerArg], null, 10)).error?.message).toMatch(/nonblank key/);
    expect((await stream(db, ref, W1, "sideways" as "after", pos, 10)).error?.message).toMatch(/before or after/);
    expect((await stream(db, ref, W1, "after", pos, 1001)).error?.message).toMatch(/p_limit must be 1..1000/);
    expect((await members(db, { ...ref, fence: ref.fence + 1 }, [["order", "BULK-1"]], null, 10)).error?.message).toMatch(/obsolete/);
    expect((await stream(db, { ...ref, fence: ref.fence + 1 }, W1, "after", pos, 10)).error?.message).toMatch(/obsolete/);
  });
  it("client roles are refused and the reads change nothing", async () => {
    const pos: Pos = { at: "2026-03-01T00:00:00+00:00", id: "" };
    for (const role of ["anon", "authenticated"]) {
      expect((await members(db, ref, [["order", "BULK-1"]], null, 10, role)).error?.message).toMatch(/permission denied/);
      expect((await stream(db, ref, W1, "after", pos, 10, role)).error?.message).toMatch(/permission denied/);
    }
    const digest = async () => (await db.query<{ h: string }>(
      `select md5(coalesce((select string_agg(event_id || image::text, '|' order by event_id) from reporting_private.source_candidate), '')
             || coalesce((select string_agg(to_jsonb(b)::text, '|' order by batch_id) from reporting_private.batches b), '')
             || coalesce((select string_agg(to_jsonb(s)::text, '|' order by site) from reporting_private.site_state s), '')) as h`)).rows[0].h;
    const before = await digest();
    ok(await members(db, ref, [["order", "BULK-6"], clock(50)], null, 100));
    ok(await stream(db, ref, W1, "after", pos, 100));
    expect(await digest()).toBe(before);
  });
  it("plans: 0042 members are per-owner keyed lookups; the 0041 OR join reads the whole candidate (fails the same bound)", async () => {
    const owners: OwnerArg[] = [...orderOwners([5, 11, 17, 23, 29, 35, 41, 47]), clock(250), clock(300)];
    const memberRows = memberOrder(view, owners).length;
    const params = [JSON.stringify(owners), null, null, 1000];
    // PGlite's planner may serve the 0041 OR join with a BitmapOr; the hosted plan (T14S3) did not and
    // scanned the whole (batch, site) range. With bitmap scans off the OR join has no keyed access left
    // (the hosted shape), while the 0042 per-owner lookups stay keyed under either setting.
    const HOSTED = ["set local enable_bitmapscan = off"];
    for (const settings of [[], HOSTED]) {
      const p42 = await explain(db, T42, "read_reporting_owner_members", ref, params, settings);
      expect(membersBounded(p42, memberRows, owners.length)).toBe(true);
      expect(readOf(p42, "source_candidate")).toBeLessThanOrEqual(memberRows + owners.length);
      // a later cursor keeps the 0042 bound
      const later = await explain(db, T42, "read_reporting_owner_members", ref, [JSON.stringify(owners), 3, "v00011", 1000], settings);
      expect(membersBounded(later, memberRows, owners.length)).toBe(true);
    }
    const p41 = await explain(db, T41, "read_reporting_owner_members", ref, params, HOSTED);
    expect(membersBounded(p41, memberRows, owners.length)).toBe(false);
    expect(readOf(p41, "source_candidate")).toBeGreaterThanOrEqual(view.length);
  }, 120_000);
  it("plans: each 0042 candidate stream branch stops near one page; the 0041 outer sort reads every row of the worker", async () => {
    const limit = 50;
    for (const [dir, pos] of [["after", { at: "2026-03-01T00:01:00+00:00", id: "" }], ["before", { at: "2026-03-01T00:07:00+00:00", id: "" }]] as const) {
      const rows = streamOrder(view, W1, dir, pos).length;
      expect(rows).toBeGreaterThan(300);
      const params = [W1, dir, pos.at, pos.id, limit];
      const p42 = await explain(db, T42, "read_reporting_staff_stream", ref, params);
      const p41 = await explain(db, T41, "read_reporting_staff_stream", ref, params);
      expect(streamBounded(p42, "source_candidate", limit)).toBe(true);
      expect(streamBounded(p41, "source_candidate", limit)).toBe(false);
      expect(readOf(p41, "source_candidate")).toBeGreaterThanOrEqual(rows);
    }
  }, 120_000);
});

describe("0042 refresh dependency reads over an overlay (PGlite)", () => {
  let db: PGlite;
  let ref: FrozenBatchRef;
  let view: Row[];
  let overlay: Array<{ id: string; image: Json | null }>;
  beforeAll(async () => {
    db = await reportingDb();
    await setup(db);
    await bulk(db, 300);
    const r = await runReportingCycle({ client: pgRpc(db), now: () => Date.now(), sleep: async () => undefined }, { site: "uk", mode: "rebuild" });
    expect(r.problems).toEqual([]);
    expect(r.state).toBe("published");
    // replacements (same owner; new owner and worker), tombstones, inserts (order and event owners)
    await db.query("update public.production_events set note = 'changed' where location = 'uk' and id = 'v00010'");
    await db.query("update public.production_events set order_number = 'MOVED', staff_id = $1 where location = 'uk' and id = 'v00011'", [W2]);
    await db.query("delete from public.production_events where location = 'uk' and id in ('v00012', 'v00013', 'v00100')");
    await one(db, "n-1", W1, "BULK-1", "2026-03-01T00:00:01+00:00");
    await one(db, "n-2", W1, null, "2026-03-01T00:00:01+00:00");
    ref = await holdAtFrozen(db, "refresh");
    expect(ref.kind).toBe("refresh");
    await db.exec("analyze reporting_private.source_current, reporting_private.batch_events");
    view = await frozenView(db, ref);
    overlay = (await db.query<{ id: string; image: Json | null }>("select event_id as id, image from reporting_private.batch_events where batch_id = $1 order by event_id", [ref.batchId])).rows;
    expect(overlay.filter((o) => o.image === null).map((o) => o.id).sort()).toEqual(["v00012", "v00013", "v00100"]);
    expect(overlay.some((o) => o.id === "n-1") && overlay.some((o) => o.id === "v00011")).toBe(true);
  }, 300_000);
  beforeEach(async () => { expect((await pgRpc(db).rpc("renew_reporting_lease", { p_batch: ref.batchId, p_fence: ref.fence })).error).toBeNull(); });
  afterAll(async () => db?.close());

  it("owner members see replacements, moved owners, tombstones and inserts exactly", async () => {
    const owners: OwnerArg[] = [["order", "BULK-10"], ["order", "BULK-11"], ["order", "MOVED"], ["order", "BULK-12"], ["event", "v00100"], ["event", "n-2"], ["order", "BULK-1"]];
    for (const limit of [1, 2, 1000]) {
      const { all } = await walkMembers(db, ref, view, owners, limit);
      const ids = all.map((m) => m.event_id);
      expect(ids).toContain("n-1");
      expect(ids).toContain("n-2");
      expect(ids).not.toContain("v00012");
      expect(ids).not.toContain("v00100");
      expect(all.find((m) => m.event_id === "v00010")?.image.note).toBe("changed");
      expect(all.find((m) => m.event_id === "v00011")?.owner_index).toBe(2);
    }
  }, 120_000);
  it("worker streams exclude superseded base rows and include overlay rows, in both directions", async () => {
    for (const staff of [W1, W2]) {
      for (const limit of [5, 1000]) {
        const a = await walkStream(db, ref, view, staff, "after", { at: "2000-01-01T00:00:00+00:00", id: "" }, limit);
        const b = await walkStream(db, ref, view, staff, "before", { at: "2100-01-01T00:00:00+00:00", id: "" }, limit);
        expect(b.all.map((x) => x.event_id)).toEqual([...a.all].reverse().map((x) => x.event_id));
        const ids = a.all.map((x) => x.event_id);
        expect(ids).not.toContain("v00012");
        if (staff === W2) expect(ids).toContain("v00011"); // moved to W2 by the overlay
        if (staff === W1) expect(ids).toContain("n-1");
      }
    }
  }, 120_000);
  it("plans: the base-mirror stream branch stops near one page; the overlay branch's scanned rows are measured (not claimed bounded)", async () => {
    const limit = 5;
    const pos = { at: "2026-03-01T00:00:00+00:00", id: "" };
    const p42 = await explain(db, T42, "read_reporting_staff_stream", ref, [W1, "after", pos.at, pos.id, limit]);
    const p41 = await explain(db, T41, "read_reporting_staff_stream", ref, [W1, "after", pos.at, pos.id, limit]);
    expect(streamBounded(p42, "source_current", limit)).toBe(true);
    expect(streamBounded(p41, "source_current", limit)).toBe(false);
    // The overlay branch: a primary-key-only table filtered on JSON staff/created_at. Recorded, not bounded.
    const overlayRead = onRel(p42, "batch_events").reduce((m, n) => Math.max(m, scanned(n)), 0);
    expect(overlayRead).toBeGreaterThan(0);
    expect(overlayRead).toBeLessThanOrEqual(overlay.length);
  }, 120_000);
  it("refresh members keep the 0041 refresh access (the two refresh branches are unchanged text)", () => {
    const q41 = boundReadQuery(T41, "read_reporting_owner_members");
    const q42 = boundReadQuery(T42, "read_reporting_owner_members");
    const refreshPart = (q: string) => q.slice(q.indexOf("-- frozen images of the batch (refresh)"), q.indexOf("UNION ALL", q.indexOf("-- base mirror rows")));
    expect(refreshPart(q42)).toBe(refreshPart(q41));
    expect(refreshPart(q42).length).toBeGreaterThan(400);
  });
});
