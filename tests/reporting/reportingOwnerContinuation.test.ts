/**
 * T15P-4d part 1: the durable owner read over the REAL 0040–0046 SQL (PGlite,
 * offline, synthetic). For every owner of a varied frozen batch it must equal
 * buildOwnerInput exactly; a process that dies after ANY journal commit and a
 * fresh process that reloads the journal and resumes must also equal it, and
 * the resumed process never re-reads a completed source page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { beginReportingRebuild, copyReportingSourcePage, freezeReportingRebuild, type RpcClient } from "../../api/_lib/reporting-jobs";
import { ACTIVATION_LIMITS, activationWatch, buildOwnerInput, durableOwnerInput, materializeOwnerWorks, ownerKey, ownerWorksFromInput, reducedBytes, routedOwnerInput, sharedChildren, type ActivationLimits, type Owner, type OwnerJournal } from "../../api/_lib/production-reporting-materialize";
import { rpcFrozenReader, type FrozenBatchRef } from "../../api/_lib/production-reporting-reader";
import { failureKind, isTransient, OwnerInputPurposeError, OwnerInputTooHeavyError, OwnerInputUnsupportedError, recoverOwnerJournal, requireOwnerInputProtocol } from "../../api/_lib/production-reporting-worker";
import { checkpointOwnerInput, hashOwnerInput, hashOwnerInputStep, loadOwnerInputHeader, openOwnerInput, ownerJournal, ownerJournalSnapshot, readOwnerOldStaff, reloadOwnerInput, saveEnumeration } from "../../api/_lib/reporting-worker-state";
import type { ProductionEvidenceEvent as Ev } from "../../src/lib/domain/productionCounts";
import { exactInstant } from "../../src/lib/domain/productionCounts";
import { compareUtf8 } from "../../api/_lib/reporting-stage";
import { reportingDb } from "./pg/harness";
import { pgRpc } from "./pg/rpc";

const W1 = "00000008-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W2 = "00000009-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W3 = "0000000a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W4 = "0000000b-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W7 = "0000000c-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W8 = "0000000d-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W9 = "0000000e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W10 = "0000000f-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** scope review Must-fix 4, Proof 3: each owner's earliest member id ends in this code point (built, never escaped). */
const UNI = [["U7FF", W7, 0xd7ff, true], ["UE000", W8, 0xe000, false], ["UASTRAL", W9, 0x1f600, false]] as const;
const uniId = (cp: number) => "cu" + String.fromCodePoint(cp);
/** 200 old-self audiences for owner OQ-3 (resumable hashing across three checkpoints). */
const OLD200 = Array.from({ length: 200 }, (_, i) => `${(0x100 + i).toString(16).padStart(8, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`);
const SITE = "au";
let db: PGlite;
let ref: FrozenBatchRef;
let owners: Owner[] = [];
const c = (): RpcClient => pgRpc(db);
const at = (s: number) => new Date(Date.parse("2026-10-01T10:00:00Z") + s * 1000).toISOString();

async function ins(r: { id: string; staff?: string; order: string | null; type?: string; parent?: string | null; at: string; dept?: string; sku?: string | null }) {
  const type = r.type ?? "line_verified";
  await db.query(
    `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
     values ('au', $1, $2, $3, $4, $5, $6, $7, 's', '', $8, $9)`,
    [r.id, r.staff ?? W1, r.dept ?? "framed", r.order, type === "line_verified" ? (r.sku === undefined ? "INKA-KAN0566-A4-FB" : r.sku) : null, type === "line_verified" ? 1 : null, type, r.at, r.parent ?? null],
  );
}

/** Records every RPC (fn + args) so a resumed process can be checked for re-reads. */
function recording(inner: RpcClient) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = { rpc: async (fn, args) => (calls.push({ fn, args: args ?? {} }), inner.rpc(fn, args)) };
  return { client, calls };
}
class Crash extends Error {}
/** A journal that dies (before writing) on commit number `k` (1-based). */
function dying(inner: OwnerJournal, k: number): OwnerJournal & { commits: number } {
  const j = {
    commits: 0,
    async commit(p: Parameters<OwnerJournal["commit"]>[0]) {
      if (++j.commits === k) throw new Crash(`died at commit ${k}`);
      await inner.commit(p);
    },
  };
  return j;
}

beforeAll(async () => {
  db = await reportingDb();
  for (const w of [W1, W2]) await db.query("insert into auth.users (id, email) values ($1, $2)", [w, `${w}@x`]);
  // O-1: members of two workers and two work types, a member cancellation (W2), a member that cancels a line of another order
  await ins({ id: "p9", staff: W2, order: "O-9", at: at(-3600) });
  await ins({ id: "o1-a", order: "O-1", at: at(0) });
  await ins({ id: "o1-b", order: "O-1", at: at(30) });
  await ins({ id: "o1-u", order: "O-1", at: at(40), dept: "unframed" });
  await ins({ id: "o1-w2", staff: W2, order: "O-1", at: at(20) });
  await ins({ id: "o1-a-x", staff: W2, order: "O-1", type: "cancelled", parent: "o1-a", at: at(60) });
  await ins({ id: "o1-cx", staff: W2, order: "O-1", type: "cancelled", parent: "p9", at: at(70) });
  await ins({ id: "o1-clk", order: null, type: "clock_in", at: at(5) });
  // W1 predecessors below O-1 (two+ stream pages): every 3rd line is cancelled (ineffective), clock-ins, ties, and
  // the first effective UNFRAMED line far down, so the walk must cross pages before its stop instant.
  for (let g = 1; g <= 260; g++) {
    const id = `pr-${String(g).padStart(4, "0")}`;
    const t = at(-g * 10);
    await ins({ id, order: `OP-${g % 7}`, at: t, dept: g === 240 ? "unframed" : "framed" });
    if (g % 3 === 0) await ins({ id: `${id}-x`, staff: g % 2 ? W1 : W2, order: `OP-${g % 7}`, type: "cancelled", parent: id, at: at(-g * 10 + 1) });
    if (g % 50 === 0) await ins({ id: `clk-${g}`, order: null, type: "clock_in", at: at(-g * 10 - 2) });
  }
  await ins({ id: "pr-0240-tie", order: "OP-T", at: at(-2400), dept: "unframed" }); // a tie at the stop instant
  for (let g = 1; g <= 5; g++) await ins({ id: `w2-${g}`, staff: W2, order: `OQ-${g}`, at: at(-g * 7) });
  // review r2 Must-fix 4 fixtures:
  //  BIG: 1,001 member cancellations (two member pages, two 1,000-groups of children); the first 501 name distinct parents
  //       outside the order (501 by-id requests in two 500-groups), every 5th of them (g % 5 = 3) absent from the source.
  //  NOTE: W3 lines with 400 KB notes (byte-shortened member and kid pages), a line whose cancellations span several
  //        non-empty kid pages, and a non-timing line with a 300,000-backslash SKU (a multi-call fragmented page).
  //  EMPTY: a discovered owner with no members (zero groups and zero workers).
  await db.query("insert into auth.users (id, email) values ($1, 'w3@x')", [W3]);
  await db.query(
    `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
     select 'au', 'bp-' || lpad(g::text, 4, '0'), $1, 'framed', null, null, null, 'clock_in', 's', '', timestamptz '2026-09-01' + g * interval '1 second', null
       from generate_series(0, 500) g where g % 5 <> 3`, [W3]);
  await db.query(
    `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
     select 'au', 'bg-' || lpad(g::text, 4, '0'), $1, 'framed', 'BIG', null, null, 'cancelled', 's', '', timestamptz '2026-09-02' + g * interval '1 second',
            case when g <= 500 then 'bp-' || lpad(g::text, 4, '0') end
       from generate_series(0, 1000) g`, [W2]);
  // three 400 KB parents byte-shorten the by-id pages inside group 0, so a parents cursor is stored mid-group
  await db.query("update public.production_events set note = repeat('n', 400000) where id in ('bp-0010', 'bp-0011', 'bp-0012')");
  for (const [id, parent] of [["bk-0005", "bg-0005"], ["bk-1000", "bg-1000"]]) await ins({ id, staff: W2, order: "BIGK", type: "cancelled", parent, at: "2026-09-03T00:00:00Z" });
  const noteRow = async (id: string, type: string, order: string, at: string, parent: string | null, sku: string | null, staff = W3) =>
    db.query(
      `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
       values ('au', $1, $2, 'framed', $3, $4, $5, $6, 's', repeat('n', 400000), $7, $8)`,
      [id, staff, order, sku, type === "line_verified" ? 1 : null, type, at, parent]);
  for (let i = 1; i <= 5; i++) await noteRow(`nt-${i}`, "line_verified", "NOTE", `2026-10-01T08:00:0${i}Z`, null, "INKA-KAN0566-A4-FB");
  for (let i = 1; i <= 3; i++) await noteRow(`ntk-${i}`, "cancelled", "NOTEK", `2026-10-01T08:01:0${i}Z`, "nt-2", null, W2);
  // review r3 Must-fix 2: PRE-P is a W3 predecessor (not a member of NOTE). Its first two cancellations carry another
  // order (the pair rule rejects them: they do not cancel); the third, on a LATER kid page, matches and cancels it.
  await noteRow("pre-p", "line_verified", "PRE", "2026-10-01T07:59:00Z", null, "INKA-KAN0566-A4-FB");
  await noteRow("pre-k1", "cancelled", "PX", "2026-10-01T07:59:10Z", "pre-p", null, W3);
  await noteRow("pre-k2", "cancelled", "PX", "2026-10-01T07:59:11Z", "pre-p", null, W3);
  await noteRow("pre-k3", "cancelled", "PRE", "2026-10-01T07:59:12Z", "pre-p", null, W3);
  await db.query(
    `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
     values ('au', 'nt-big', $1, 'framed', 'NOTE', 'X' || repeat(chr(92), 300000), 1, 'line_verified', 's', '', '2026-10-01T08:00:10Z', null)`, [W3]);
  // scope review Must-fix 4: order CP-M of W4 has lines at T1 and T3; another order's W4 line at T2 lies between them and a
  // predecessor at T0 below; each line has one small cancellation. The walk's first 0045 page therefore includes, complete,
  // the children of T3, T2, T1 (at/above the certain bound) and T0 (the first line below it).
  await db.query("insert into auth.users (id, email) values ($1, 'w4@x')", [W4]);
  const cp = (s: number) => new Date(Date.parse("2026-10-02T06:00:00Z") + s * 1000).toISOString();
  for (const [id, order, t] of [["cp-t3", "CP-M", 30], ["cp-t2", "CP-X", 20], ["cp-t1", "CP-M", 10], ["cp-t0", "CP-Y", 0]] as const) {
    await ins({ id, staff: W4, order, at: cp(t) });
    await ins({ id: `${id}-k`, staff: W2, order: order === "CP-M" ? "CP-K" : order, type: "cancelled", parent: id, at: cp(t + 1) });
  }
  // scope review Must-fix 4, Proof 3: three single-worker owners whose earliest member id is just below U+D800 (exact
  // bound), above it in the BMP (instant only) and astral (a UTF-16 surrogate pair: instant only); each has a later member
  // line and one predecessor below, so the walk reads a 0045 page with the certain bound.
  for (const [key, staff, cp] of UNI) {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [staff, `${staff}@x`]);
    const u = (s: number) => new Date(Date.parse("2026-10-03T06:00:00Z") + s * 1000).toISOString();
    await ins({ id: uniId(cp), staff, order: key, at: u(10) });
    await ins({ id: `cv-${key}`, staff, order: key, at: u(20) });
    await ins({ id: `cw-${key}`, staff, order: `${key}-P`, at: u(0) });
  }
  // scope review Must-fix 4, Proof 2: CQ-M of W10 mirrors CP-M (lines at T3/T1, another order's line at T2, a predecessor
  // at T0, one small cancellation each; T0's cancels it), plus a second line below, cq-tm1 (effective: its three 400 KB
  // cancellations carry another order). 0045 includes kids only through the FIRST line below the certain bound (T0), so
  // cq-tm1 arrives in the same combined page with kids === null; its kids need byte-capped kid pages of its own.
  await db.query("insert into auth.users (id, email) values ($1, 'w10@x')", [W10]);
  const cq = (s: number) => new Date(Date.parse("2026-10-04T06:00:00Z") + s * 1000).toISOString();
  for (const [id, order, t] of [["cq-t3", "CQ-M", 30], ["cq-t2", "CQ-X", 20], ["cq-t1", "CQ-M", 10], ["cq-t0", "CQ-Y", 0], ["cq-tm1", "CQ-Z", -10]] as const) {
    await ins({ id, staff: W10, order, at: cq(t) });
    if (id !== "cq-tm1") await ins({ id: `${id}-k`, staff: W2, order: order === "CQ-M" ? "CQ-K" : order, type: "cancelled", parent: id, at: cq(t + 1) });
  }
  for (let i = 1; i <= 3; i++) await noteRow(`cq-tm1-k${i}`, "cancelled", "CQ-W", cq(-9 + i / 10), "cq-tm1", null, W2);
  expect((await c().rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
  expect((await c().rpc("set_reporting_site_mode", { p_site: SITE, p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
  const r = await beginReportingRebuild(c(), SITE);
  let after: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const p = await copyReportingSourcePage(c(), r.batchId, r.leaseFence, after);
    if (p.complete) break;
    after = p.nextAfterEventId;
  }
  await freezeReportingRebuild(c(), r.batchId, r.leaseFence);
  const b = (await db.query<{ cutoff: string }>("select to_char(source_cutoff at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as cutoff from reporting_private.batches where batch_id = $1", [r.batchId])).rows[0];
  ref = { batchId: r.batchId, fence: r.leaseFence, site: SITE, cutoff: b.cutoff, kind: "rebuild" };
  const keys = (await db.query<{ k: string }>("select distinct order_number as k from public.production_events where order_number is not null order by 1")).rows.map((x) => x.k);
  owners = [...keys, "EMPTY"].map((k) => ({ partitionKind: "order" as const, partitionKey: k }));
  const sorted = [...owners].sort((x, y) => (ownerKey(x) < ownerKey(y) ? -1 : 1));
  const last: ["order", string] = ["order", sorted.at(-1)!.partitionKey];
  await saveEnumeration(c(), ref.batchId, ref.fence, null, { kind: "rebuild", after: last }, sorted.map((o) => ({ owner: o, oldStaff: o.partitionKey === "OP-1" ? [W3] : o.partitionKey === "OQ-3" ? OLD200 : [] })), false);
  await saveEnumeration(c(), ref.batchId, ref.fence, { kind: "rebuild", after: last }, { kind: "rebuild", after: last, end: true }, [], true);
  await db.query("update reporting_private.batches set lease_expires_at = now() + interval '1 hour' where batch_id = $1", [ref.batchId]);
}, 180_000);
afterAll(async () => db?.close());

const cutoffUs = (): bigint => {
  const u = exactInstant(ref.cutoff);
  if (u === null) throw new Error("bad cutoff");
  return u;
};
async function freshJournal(owner: Owner) {
  const h = await openOwnerInput(c(), ref.batchId, ref.fence, owner, "plan");
  return { handle: h.handle, journal: ownerJournal(c(), ref.batchId, ref.fence, h.handle, h.seq, cutoffUs()) };
}

describe("durable owner read (journaled buildOwnerInput)", () => {
  it("equals buildOwnerInput for every owner of the batch, journaling every page", async () => {
    expect(owners.length).toBeGreaterThan(8);
    for (const o of owners) {
      const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
      const { handle, journal } = await freshJournal(o);
      const got = await durableOwnerInput(rpcFrozenReader(c(), ref), o, journal);
      expect(got, o.partitionKey).toEqual(want);
      // the journal holds exactly the read's input, and its state is done
      const back = await reloadOwnerInput(c(), ref.batchId, ref.fence, handle, SITE);
      expect(back.events.map((e) => e.ev).sort((x, y) => (Buffer.compare(Buffer.from(x.id), Buffer.from(y.id))))).toEqual(want.events);
      expect(back.header.state).toEqual({ v: 1, step: "done" });
    }
  }, 300_000);

  it("a crash BEFORE a sampled set of commits (each resumable state kind) resumes in a fresh process to the same input", async () => {
    const o: Owner = { partitionKind: "order", partitionKey: "O-1" };
    const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
    // learn the commit count of an uninterrupted durable read in a scratch batch-free way: count on a throwaway journal
    // record the state each commit stores, so crash points cover every kind of resumable state
    const stored: Array<Record<string, unknown>> = [];
    const probe = { n: 0, async commit(p: Parameters<OwnerJournal["commit"]>[0]) { probe.n++; stored.push(p.steps[p.steps.length - 1] as unknown as Record<string, unknown>); } };
    await durableOwnerInput(rpcFrozenReader(c(), ref), o, probe);
    const total = probe.n;
    expect(total).toBeGreaterThan(20);
    // Crashing at commit k resumes from the state stored by commit k-1 (index k-2). Pick the FIRST stored state of each kind:
    // each phase, a pending line before its first kid page, a pending line mid-kids, and a walk whose stopAt is already set.
    type W = { worker: number; stopAt: string | null; line: { afterKidOrd: number | null } | null };
    const kinds: Array<(s: Record<string, unknown>) => boolean> = [
      (s) => s.step === "members", (s) => s.step === "parents", (s) => s.step === "children", (s) => s.step === "walk",
      (s) => s.step === "walk" && (s.w as W).line !== null && (s.w as W).line!.afterKidOrd === null,
      (s) => s.step === "walk" && (s.w as W).line !== null && (s.w as W).line!.afterKidOrd !== null,
      (s) => s.step === "walk" && (s.w as W).stopAt !== null,
      (s) => s.step === "walk" && (s.w as W).worker === 1,
    ];
    const chosen = kinds.map((f) => stored.findIndex(f));
    expect(chosen.every((i) => i >= 0), `every resumable state kind occurs: ${chosen.join(",")}`).toBe(true);
    const points = [...new Set([1, 2, 3, ...chosen.map((i) => i + 2), Math.floor(total / 2), total - 1, total])].filter((k) => k >= 1 && k <= total).sort((x, y) => x - y);
    for (const k of points) {
      await db.query("delete from reporting_private.owner_input_pieces where handle in (select handle from reporting_private.owner_inputs where partition_key = 'O-1')");
      await db.query("delete from reporting_private.owner_input_events where handle in (select handle from reporting_private.owner_inputs where partition_key = 'O-1')");
      await db.query("delete from reporting_private.owner_inputs where partition_key = 'O-1'");
      const { handle, journal } = await freshJournal(o);
      await expect(durableOwnerInput(rpcFrozenReader(c(), ref), o, dying(journal, k))).rejects.toBeInstanceOf(Crash);
      // a fresh process: reload the journal (snapshot-pinned), then resume from its stored state
      const rec = recording(c());
      const back = await reloadOwnerInput(rec.client, ref.batchId, ref.fence, handle, SITE);
      const snap = ownerJournalSnapshot(back);
      const reads = recording(c());
      const got = await durableOwnerInput(rpcFrozenReader(reads.client, ref), o, ownerJournal(c(), ref.batchId, ref.fence, handle, back.header.seq, cutoffUs()), snap);
      expect(got, `crash at commit ${k}/${total}`).toEqual(want);
      // nothing already journaled is fetched again by id, and no member page before the saved member cursor
      const journaled = new Set(back.events.map((e) => e.ev.id));
      for (const call of reads.calls) if (call.fn === "read_reporting_events_by_id") for (const id of call.args.p_ids as string[]) expect(journaled.has(id), `re-read ${id} at ${k}`).toBe(false);
      if (snap.state.step !== "members") expect(reads.calls.some((x) => x.fn === "read_reporting_owner_members"), `members re-read at ${k}`).toBe(false);
      if (snap.state.step === "walk" || snap.state.step === "done") expect(reads.calls.some((x) => x.fn === "read_reporting_events_by_id"), `parents re-read at ${k}`).toBe(false);
    }
  }, 600_000);
});

// ---- shared recovery harness (hoisted from the recovery-boundaries describe; behaviour unchanged) ----
type St = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SOURCE = new Set(["read_reporting_owner_members", "read_reporting_events_by_id", "read_reporting_children", "read_reporting_staff_stream", "read_reporting_predecessor_page"]);
/** Wipe one owner's journal so a scenario starts from an empty journal. */
async function reset(key: string) {
  const sel = `select handle from reporting_private.owner_inputs where partition_key = '${key.replace(/'/g, "''")}'`;
  await db.query(`delete from reporting_private.owner_input_pieces where handle in (${sel})`);
  await db.query(`delete from reporting_private.owner_input_events where handle in (${sel})`);
  await db.query(`delete from reporting_private.owner_inputs where partition_key = '${key.replace(/'/g, "''")}'`);
}
/** What the journal has committed so far (state, events in ordinal order, members count), as a fresh process would see it. */
interface Track { state: St; events: Ev[]; membersCount: number | null }
const trackOf = (snap: { state: unknown; events: Ev[]; membersCount: number | null } | null): Track =>
  snap ? { state: snap.state as St, events: [...snap.events], membersCount: snap.membersCount } : { state: { v: 1, step: "members", m: { afterOrd: null } }, events: [], membersCount: null };
const record = (t: Track, p: { events: Ev[]; steps: unknown[]; membersCount?: number }) => {
  t.events.push(...p.events);
  if (p.membersCount !== undefined) t.membersCount = p.membersCount;
  t.state = p.steps[p.steps.length - 1] as St;
};
/**
 * The EXACT arguments the next dependent source read must carry, derived only from the committed journal
 * (checkpoint-before-dependent-read, no repeat of a completed member/parent/child unit). Null = not derivable
 * (the first stream page of a worker starts at its latest member line + 1 µs; only the phase is checked then).
 */
function expectedArgs(t: Track, fn: string, args: Record<string, unknown>, owner: Owner): Record<string, unknown> | null {
  const s = t.state;
  const at = (ord: number) => t.events[ord - 1];
  const members = () => t.events.slice(0, t.membersCount ?? 0);
  const fail = (why: string): never => {
    throw new Error(`${fn} ${JSON.stringify(args).slice(0, 200)} was requested while the committed state is ${JSON.stringify(s)}: ${why}`);
  };
  if (fn === "read_reporting_owner_members") {
    if (s.step !== "members") fail("not in the members phase");
    const a = s.m.afterOrd === null ? null : at(s.m.afterOrd);
    return { p_owners: [[owner.partitionKind, owner.partitionKey]], p_after_index: a ? 0 : null, p_after_event_id: a ? a.id : null };
  }
  if (fn === "read_reporting_events_by_id") {
    if (s.step !== "parents") fail("not in the parents phase");
    const ids = new Set(members().map((m) => m.id));
    const parents = [...new Set(members().map((m) => m.parent_event_id).filter((x): x is string => !!x && !ids.has(x)))].sort(compareUtf8);
    const group = parents.slice(s.p.group * 500, s.p.group * 500 + 500);
    const a = s.p.afterOrd === null ? null : at(s.p.afterOrd);
    return { p_ids: a ? group.filter((id) => compareUtf8(id, a.id) > 0) : group };
  }
  if (fn === "read_reporting_children" && s.step === "children") {
    const group = members().map((m) => m.id).sort(compareUtf8).slice(s.c.group * 1000, s.c.group * 1000 + 1000);
    const a = s.c.afterOrd === null ? null : at(s.c.afterOrd);
    return { p_parent_ids: group, p_after_parent_id: a ? a.parent_event_id : null, p_after_event_id: a ? a.id : null };
  }
  if (fn === "read_reporting_children") {
    if (s.step !== "walk" || !s.w.line || s.w.line.phase !== "kids") fail("no pending line is committed before its kid page");
    const l = at(s.w.line.ord);
    const k = s.w.line.afterKidOrd === null ? null : at(s.w.line.afterKidOrd);
    return { p_parent_ids: [l.id], p_after_parent_id: k ? l.id : null, p_after_event_id: k ? k.id : null };
  }
  if (fn === "read_reporting_predecessor_page") {
    // step 4: the 0045 combined page is read only while the walk is unsatisfied, from the committed cursor
    if (s.step !== "walk" || s.w.line !== null || s.w.stopAt !== null) fail("a combined page while a line is pending, after the stop or outside the walk");
    if (s.w.cursorOrd === null) return null;
    const cur = at(s.w.cursorOrd);
    return { p_at: cur.created_at, p_at_event_id: cur.id };
  }
  if (fn === "read_reporting_staff_stream") {
    if (s.step !== "walk" || s.w.line !== null) fail("a stream page while a line is pending or outside the walk");
    if (s.w.cursorOrd === null) return null;
    const cur = at(s.w.cursorOrd);
    return { p_direction: "before", p_at: cur.created_at, p_at_event_id: cur.id };
  }
  return fail("an unexpected source read");
}
/** A source client that checks EVERY source read's exact arguments against the committed journal, and records the reads. */
function guardedSource(t: Track, owner: Owner) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc: async (fn, args) => {
      const a = args ?? {};
      if (SOURCE.has(fn)) {
        const want = expectedArgs(t, fn, a, owner);
        if (want) for (const [k, v] of Object.entries(want)) if (JSON.stringify(a[k]) !== JSON.stringify(v)) throw new Error(`${fn}: ${k} = ${JSON.stringify(a[k])?.slice(0, 120)}, the committed journal implies ${JSON.stringify(v)?.slice(0, 120)}`);
        calls.push({ fn, args: a });
      }
      return c().rpc(fn, args);
    },
  };
  return { client, calls };
}
/** The exact first source request a resume from `s` must make (null: none is predictable / no read at all). */
function expectedFirst(s: St, events: Ev[], owner: Owner, snapMembers: number | null): { fn: string; args: Record<string, unknown> } | "none" | null {
  const at = (ord: number) => events[ord - 1];
  if (s.step === "done") return "none";
  if (s.step === "members") {
    const a = s.m.afterOrd === null ? null : at(s.m.afterOrd);
    return { fn: "read_reporting_owner_members", args: { p_owners: [[owner.partitionKind, owner.partitionKey]], p_after_index: a ? 0 : null, p_after_event_id: a ? a.id : null } };
  }
  if (s.step === "parents" || s.step === "children") {
    const t: Track = { state: s, events, membersCount: snapMembers };
    const fn = s.step === "parents" ? "read_reporting_events_by_id" : "read_reporting_children";
    const args = expectedArgs(t, fn, {}, owner)!;
    if (fn === "read_reporting_events_by_id" && !(args.p_ids as string[]).length) return null; // the group ends without a read
    return { fn, args };
  }
  if (s.step === "walk" && s.w.line && s.w.line.phase === "kids") {
    const l = at(s.w.line.ord);
    const k = s.w.line.afterKidOrd === null ? null : at(s.w.line.afterKidOrd);
    return { fn: "read_reporting_children", args: { p_parent_ids: [l.id], p_after_parent_id: k ? l.id : null, p_after_event_id: k ? k.id : null } };
  }
  if (s.step === "walk" && s.w.line === null && s.w.cursorOrd !== null) {
    const cur = at(s.w.cursorOrd);
    // while unsatisfied the walk reads the 0045 combined page; after the stop, plain pages for the ties
    return s.w.stopAt === null
      ? { fn: "read_reporting_predecessor_page", args: { p_at: cur.created_at, p_at_event_id: cur.id } }
      : { fn: "read_reporting_staff_stream", args: { p_direction: "before", p_at: cur.created_at, p_at_event_id: cur.id } };
  }
  return null;
}
/** Run `owner` to the k-th journal call boundary: mode "before" dies before commit k, "after" commits k then loses the response. */
async function crashAt(owner: Owner, k: number, mode: "before" | "after", truncateDone = false) {
  await reset(owner.partitionKey);
  const h = await openOwnerInput(c(), ref.batchId, ref.fence, owner, "plan");
  const j = ownerJournal(c(), ref.batchId, ref.fence, h.handle, h.seq, cutoffUs());
  const t = trackOf(null);
  let n = 0;
  const src = guardedSource(t, owner);
  const journal: OwnerJournal = {
    async commit(p) {
      n++;
      let steps = p.steps;
      // seed the legal intermediate state "done{effective}" (pending line finished, cursor not yet moved) through the adapter
      if (truncateDone && n === k) {
        const i = steps.findIndex((s) => s.step === "walk" && s.w.line?.phase === "done");
        if (i < 0) throw new Error("no done line in this commit");
        steps = steps.slice(0, i + 1);
      }
      if (mode === "before" && n === k) throw new Crash(`before ${k}`);
      await j.commit({ ...p, steps });
      record(t, { ...p, steps });
      if ((mode === "after" || truncateDone) && n === k) throw new Crash(`after ${k}`);
    },
  };
  await expect(durableOwnerInput(rpcFrozenReader(src.client, ref), owner, journal)).rejects.toBeInstanceOf(Crash);
  return h.handle;
}
async function resume(owner: Owner, handle: string, want: unknown, label: string) {
  const back = await reloadOwnerInput(c(), ref.batchId, ref.fence, handle, SITE);
  const snap = ownerJournalSnapshot(back);
  const t = trackOf(snap);
  const j = ownerJournal(c(), ref.batchId, ref.fence, handle, back.header.seq, cutoffUs());
  const src = guardedSource(t, owner);
  const got = await durableOwnerInput(rpcFrozenReader(src.client, ref), owner, { commit: async (p) => { await j.commit(p); record(t, p); } }, snap);
  expect(got, label).toEqual(want);
  const first = expectedFirst(snap.state as unknown as St, snap.events, owner, snap.membersCount);
  if (first === "none") expect(src.calls, `${label}: a done journal reads nothing`).toEqual([]);
  else if (first) expect(src.calls[0], `${label}: the first resumed request continues exactly at the saved cursor`).toMatchObject(first);
  return snap.state as unknown as St;
}
/** The steps of every commit of an uninterrupted durable read (journal-free). */
async function commitsOf(owner: Owner) {
  const commits: St[][] = [];
  // the uninterrupted pass is guarded too: every read must carry the exact arguments its committed prefix implies
  const t = trackOf(null);
  const src = guardedSource(t, owner);
  await durableOwnerInput(rpcFrozenReader(src.client, ref), owner, { commit: async (p) => { commits.push(p.steps as unknown as St[]); record(t, p); } });
  return commits;
}

/** Interleaved trace of source RPCs and journal commits of a fresh durable read of `owner` (optionally crashing at commit k). */
async function traced(owner: Owner, crash?: { k: number; mode: "before" | "after" }) {
  await reset(owner.partitionKey);
  const h = await openOwnerInput(c(), ref.batchId, ref.fence, owner, "plan");
  const trace: Array<{ rpc: string; args: Record<string, unknown> } | { commit: number; ids: string[]; steps: unknown[] }> = [];
  const client: RpcClient = { rpc: async (fn, a) => (fn.startsWith("read_reporting_") && trace.push({ rpc: fn, args: a ?? {} }), c().rpc(fn, a)) };
  const j = ownerJournal(c(), ref.batchId, ref.fence, h.handle, h.seq, cutoffUs());
  let n = 0;
  const journal: OwnerJournal = {
    async commit(p) {
      n++;
      if (crash && crash.mode === "before" && n === crash.k) throw new Crash("before");
      await j.commit(p);
      trace.push({ commit: n, ids: p.events.map((e) => e.id), steps: p.steps });
      if (crash && crash.mode === "after" && n === crash.k) throw new Crash("after");
    },
  };
  const run = durableOwnerInput(rpcFrozenReader(client, ref), owner, journal);
  if (crash) await expect(run).rejects.toBeInstanceOf(Crash);
  else await run;
  return { trace, handle: h.handle };
}

describe("recovery boundaries (review r2 Must-fix 4): every commit, both crash modes, exact resumed requests", () => {
  for (const key of ["EMPTY", "NOTE", "BIG"]) {
    it(`${key}: a crash before or after EVERY commit resumes to buildOwnerInput, with the exact next request and checkpoint-first reads`, async () => {
      const o: Owner = { partitionKind: "order", partitionKey: key };
      const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
      const stored = (await commitsOf(o)).map((steps) => steps[steps.length - 1]);
      const kinds = new Set<string>();
      for (let k = 1; k <= stored.length; k++) {
        for (const mode of ["before", "after"] as const) {
          const handle = await crashAt(o, k, mode);
          const s = await resume(o, handle, want, `${key} ${mode} ${k}/${stored.length}`);
          kinds.add(s.step === "walk" ? `walk:${s.w.line ? `line-${s.w.line.phase}${s.w.line.afterKidOrd === null ? "" : "-mid"}` : "cursor"}` : `${s.step}${s.m?.afterOrd || s.p?.afterOrd || s.c?.afterOrd ? "-cursor" : ""}${s.p?.group || s.c?.group ? "-g1" : ""}`);
        }
      }
      if (key === "EMPTY") expect(stored.map((s) => s.step)).toEqual(["done"]);
      if (key === "BIG") for (const kind of ["members-cursor", "parents-cursor", "parents-g1", "children-cursor", "children-g1", "children-cursor-g1", "done"]) expect(kinds, [...kinds].join(",")).toContain(kind);
      if (key === "NOTE") {
        // PRE-P: two non-cancelling kid pages, then the decisive cancellation on a LATER page -> done{effective: false}
        const evs: Ev[] = [];
        const steps: St[] = [];
        await durableOwnerInput(rpcFrozenReader(c(), ref), o, { commit: async (p) => { evs.push(...p.events); steps.push(...(p.steps as unknown as St[])); } });
        const preOrd = evs.findIndex((e) => e.id === "pre-p") + 1;
        expect(preOrd).toBeGreaterThan(0);
        expect(evs.some((e) => e.id === "pre-k3")).toBe(true);
        const pre = steps.filter((x) => x.step === "walk" && x.w.line?.ord === preOrd);
        expect(pre.some((x) => x.w.line.phase === "kids" && x.w.line.afterKidOrd !== null)).toBe(true); // between non-empty kid pages
        expect(pre.find((x) => x.w.line.phase === "done")?.w.line.effective).toBe(false);
      }
      if (key === "NOTE") for (const kind of ["members-cursor", "walk:line-kids", "walk:line-kids-mid", "walk:cursor", "done"]) expect(kinds, [...kinds].join(",")).toContain(kind);
    }, 600_000);
  }

  it("a seeded pending done{effective} line resumes through its done branch", async () => {
    const o: Owner = { partitionKind: "order", partitionKey: "NOTE" };
    const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
    const commits = await commitsOf(o);
    const k = commits.findIndex((steps) => steps.some((s) => s.step === "walk" && s.w.line?.phase === "done")) + 1; // the first commit that finishes a line
    expect(k).toBeGreaterThan(0);
    const handle = await crashAt(o, k, "after", true);
    const s = await resume(o, handle, want, "seeded done");
    expect(s.w.line).toMatchObject({ phase: "done", effective: expect.any(Boolean) });
  }, 300_000);

  it("a fragmented page interrupted between pieces calls: the new process discards the pending data and redoes that source unit", async () => {
    const o: Owner = { partitionKind: "order", partitionKey: "NOTE" };
    const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
    await reset("NOTE");
    const h = await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan");
    let pieceCalls = 0;
    const lossy: RpcClient = {
      rpc: async (fn, args) => {
        const r = await c().rpc(fn, args);
        if (fn === "checkpoint_reporting_owner_input" && (args?.p_payload as { kind?: string })?.kind === "pieces" && ++pieceCalls === 1) throw new Crash("lost after the first pieces call");
        return r;
      },
    };
    const j = ownerJournal(lossy, ref.batchId, ref.fence, h.handle, h.seq, cutoffUs());
    await expect(durableOwnerInput(rpcFrozenReader(c(), ref), o, j)).rejects.toBeInstanceOf(Crash);
    const head = await loadOwnerInputHeader(c(), ref.batchId, ref.fence, h.handle);
    expect(head.pendingEvents).toBeGreaterThan(0);
    expect(head.heavyProven).toBe(false);
    const d = await checkpointOwnerInput(c(), ref.batchId, ref.fence, h.handle, head.seq, { kind: "discard_pending" });
    expect(d.pendingEvents).toBe(0);
    await resume(o, h.handle, want, "after discard");
  }, 300_000);
});

describe("a malformed source page never becomes durable (review r2 Must-fix 3, durable route)", () => {
  it("an out-of-order stream page is refused: nothing from it is committed and no next dependent read is made", async () => {
    const o: Owner = { partitionKind: "order", partitionKey: "O-1" };
    const sel = "select handle from reporting_private.owner_inputs where partition_key = 'O-1'";
    await db.query(`delete from reporting_private.owner_input_pieces where handle in (${sel})`);
    await db.query(`delete from reporting_private.owner_input_events where handle in (${sel})`);
    await db.query("delete from reporting_private.owner_inputs where partition_key = 'O-1'");
    const h = await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan");
    const calls: string[] = [];
    let poisoned = false;
    const client: RpcClient = {
      rpc: async (fn, args) => {
        calls.push(fn);
        const r = await c().rpc(fn, args);
        if ((fn === "read_reporting_staff_stream" || fn === "read_reporting_predecessor_page") && !poisoned && Array.isArray(r.data) && (r.data as unknown[]).length > 1) {
          poisoned = true;
          return { data: [...(r.data as unknown[])].reverse(), error: null };
        }
        return r;
      },
    };
    const j = ownerJournal(c(), ref.batchId, ref.fence, h.handle, h.seq, cutoffUs());
    // a reversed plain page breaks keyset order; a reversed 0045 page also misplaces its end row: either way it is refused
    await expect(durableOwnerInput(rpcFrozenReader(client, ref), o, j)).rejects.toThrow(/keyset order|misplaced end row/);
    expect(poisoned).toBe(true);
    expect(["read_reporting_staff_stream", "read_reporting_predecessor_page"]).toContain(calls.at(-1)); // the refused page was the last request
    const head = await loadOwnerInputHeader(c(), ref.batchId, ref.fence, h.handle);
    expect(head.seq).toBe(j.seq); // nothing was written after the refused page
    expect(head.state).toMatchObject({ step: "walk", w: { cursorOrd: null, line: null } });
    // and the journal still resumes to the exact input
    const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
    const back = await reloadOwnerInput(c(), ref.batchId, ref.fence, h.handle, SITE);
    expect(await durableOwnerInput(rpcFrozenReader(c(), ref), o, ownerJournal(c(), ref.batchId, ref.fence, h.handle, back.header.seq, cutoffUs()), ownerJournalSnapshot(back))).toEqual(want);
  }, 120_000);
});

describe("durable works and the hash checkpoint (T15P-4d part 2)", () => {
  it("a done journal resumes with no source read; its works equal materializeOwnerWorks; hashing completes the journal with exactly those hashes", async () => {
    for (const o of owners) {
      const old = await readOwnerOldStaff(c(), ref.batchId, ref.fence, o, null);
      const want = await materializeOwnerWorks(rpcFrozenReader(c(), ref), o, old);
      const h = await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan");
      const back = await reloadOwnerInput(c(), ref.batchId, ref.fence, h.handle, SITE);
      const snap = ownerJournalSnapshot(back);
      expect(snap.state, o.partitionKey).toEqual({ v: 1, step: "done" });
      const reads = recording(c());
      const input = await durableOwnerInput(rpcFrozenReader(reads.client, ref), o, { commit: async () => { throw new Error("a done journal must not commit"); } }, snap);
      expect(reads.calls, `${o.partitionKey}: a done journal reads nothing`).toEqual([]);
      const works = ownerWorksFromInput(rpcFrozenReader(c(), ref), o, input, old);
      expect(works, o.partitionKey).toEqual(want);
      const hashes = works.map((w) => ({ audienceKind: w.desc.audienceKind, audienceStaff: w.desc.audienceStaff, inputHash: w.desc.inputHash }));
      const r = await hashOwnerInput(c(), ref.batchId, ref.fence, h.handle, hashes);
      expect(r).toMatchObject({ calls: Math.ceil(hashes.length / 100), complete: true });
      const head = await loadOwnerInputHeader(c(), ref.batchId, ref.fence, h.handle);
      expect(head).toMatchObject({ phase: "complete", hashesDone: hashes.length });
      expect(head.inputHashes).toEqual(hashes);
      // a fresh process on a complete journal adopts it: zero hash writes
      expect(await hashOwnerInput(c(), ref.batchId, ref.fence, h.handle, hashes)).toEqual({ result: null, calls: 0, complete: true });
    }
    // the old-staff audience (not a member's staff) is part of the required set
    const op1 = owners.find((o) => o.partitionKey === "OP-1")!;
    expect((await materializeOwnerWorks(rpcFrozenReader(c(), ref), op1, [W3])).some((w) => w.desc.audienceStaff === W3)).toBe(true);
  }, 300_000);

  it("the server refuses a hash set that is not the exact required audience list", async () => {
    const o = owners.find((x) => x.partitionKey === "OQ-1")!;
    // a fresh journal for this owner on a scratch handle: delete and redo its read
    await db.query("delete from reporting_private.owner_input_pieces where handle in (select handle from reporting_private.owner_inputs where partition_key = 'OQ-1')");
    await db.query("delete from reporting_private.owner_input_events where handle in (select handle from reporting_private.owner_inputs where partition_key = 'OQ-1')");
    await db.query("delete from reporting_private.owner_inputs where partition_key = 'OQ-1'");
    const { handle, journal } = await freshJournal(o);
    const input = await durableOwnerInput(rpcFrozenReader(c(), ref), o, journal);
    const works = ownerWorksFromInput(rpcFrozenReader(c(), ref), o, input, []);
    const hashes = works.map((w) => ({ audienceKind: w.desc.audienceKind, audienceStaff: w.desc.audienceStaff, inputHash: w.desc.inputHash }));
    const seq = (await loadOwnerInputHeader(c(), ref.batchId, ref.fence, handle)).seq;
    await expect(hashOwnerInput(c(), ref.batchId, ref.fence, handle, [...hashes, { audienceKind: "self", audienceStaff: W3, inputHash: "c".repeat(64) }])).rejects.toThrow(/required set/);
    await expect(hashOwnerInput(c(), ref.batchId, ref.fence, handle, [{ audienceKind: "self", audienceStaff: W1, inputHash: "c".repeat(64) }])).rejects.toThrow(/first audience is the site/);
    expect((await hashOwnerInput(c(), ref.batchId, ref.fence, handle, hashes)).result!.seq).toBe(String(BigInt(seq) + 1n));
  });
});

describe("resumable hashing (review r3 Must-fix 1): 202 audiences across three checkpoints", () => {
  const o: Owner = { partitionKind: "order", partitionKey: "OQ-3" };
  async function prepared() {
    const sel = "select handle from reporting_private.owner_inputs where partition_key = 'OQ-3'";
    await db.query(`delete from reporting_private.owner_input_pieces where handle in (${sel})`);
    await db.query(`delete from reporting_private.owner_input_events where handle in (${sel})`);
    await db.query("delete from reporting_private.owner_inputs where partition_key = 'OQ-3'");
    const { handle, journal } = await freshJournal(o);
    const input = await durableOwnerInput(rpcFrozenReader(c(), ref), o, journal);
    const old = await readOwnerOldStaff(c(), ref.batchId, ref.fence, o, null);
    expect(old).toHaveLength(200);
    const hashes = ownerWorksFromInput(rpcFrozenReader(c(), ref), o, input, old).map((w) => ({ audienceKind: w.desc.audienceKind, audienceStaff: w.desc.audienceStaff, inputHash: w.desc.inputHash }));
    expect(hashes.length).toBe(202); // site + the member worker + 200 old self audiences
    return { handle, hashes };
  }
  const head = (handle: string, fence = ref.fence) => loadOwnerInputHeader(c(), ref.batchId, fence, handle);

  it("each checkpoint's lost response: the identical RPC replays without advancing; a fresh process adopts saved progress; complete needs zero writes", async () => {
    const { handle, hashes } = await prepared();
    const seqs: string[] = [];
    for (const [from, to, entering] of [[0, 100, true], [100, 200, false], [200, 202, false]] as const) {
      const step = await hashOwnerInputStep(c(), ref.batchId, ref.fence, handle, hashes); // a fresh process: reloads and adopts
      expect(step.payload, `unit ${from}`).toEqual({
        kind: "hash", ...(entering ? { audiences: hashes.map((h) => ({ audienceKind: h.audienceKind, audienceStaff: h.audienceStaff })) } : {}), hashes: hashes.slice(from, to),
      });
      expect(step.result).toMatchObject({ seq: String(BigInt(step.seq) + 1n), replay: false });
      expect(step.complete).toBe(to === 202);
      // the response was lost: the identical individual RPC (same expected seq, same payload) replays, seq unchanged
      const again = await checkpointOwnerInput(c(), ref.batchId, ref.fence, handle, step.seq, step.payload!);
      expect(again).toMatchObject({ seq: step.result!.seq, replay: true });
      const h = await head(handle);
      expect(h).toMatchObject({ seq: step.result!.seq, hashesDone: to, phase: to === 202 ? "complete" : "hashing" });
      expect(h.inputHashes).toEqual(hashes.slice(0, to));
      seqs.push(step.result!.seq);
    }
    expect(seqs.map((s) => BigInt(s) - BigInt(seqs[0]))).toEqual([0n, 1n, 2n]);
    // a fresh process on the complete journal makes zero writes
    const rec = { n: 0 };
    const counting: RpcClient = { rpc: async (fn, a) => (fn === "checkpoint_reporting_owner_input" && rec.n++, c().rpc(fn, a)) };
    expect(await hashOwnerInputStep(counting, ref.batchId, ref.fence, handle, hashes)).toMatchObject({ result: null, complete: true, payload: null });
    expect(rec.n).toBe(0);
  }, 300_000);

  it("a unit smaller than 100 returns after its checkpoint; a mismatched saved prefix is refused; a new fence continues and a stale fence is refused", async () => {
    const { handle, hashes } = await prepared();
    const one = await hashOwnerInput(c(), ref.batchId, ref.fence, handle, hashes, { unit: 37, maxSteps: 1 });
    expect(one).toMatchObject({ calls: 1, complete: false });
    expect(await head(handle)).toMatchObject({ phase: "hashing", hashesDone: 37 });
    const forged = hashes.map((h, i) => (i === 5 ? { ...h, inputHash: "e".repeat(64) } : h));
    await expect(hashOwnerInputStep(c(), ref.batchId, ref.fence, handle, forged, 37)).rejects.toThrow(/saved hash 5 differs/);
    const shifted = [hashes[0], ...hashes.slice(2), hashes[1]];
    await expect(hashOwnerInputStep(c(), ref.batchId, ref.fence, handle, shifted, 37)).rejects.toThrow(/saved audience list differs/);
    expect(await head(handle)).toMatchObject({ hashesDone: 37 }); // nothing written by the refused calls
    // a takeover: the site's lease fence moves on; the old writer is refused, the new one continues from the saved progress
    const old = Number((await db.query<{ f: string }>("select lease_fence::text as f from reporting_private.site_state where site = $1", [SITE])).rows[0].f);
    const bump = async (f: number) => {
      await db.query("update reporting_private.site_state set lease_fence = $2 where site = $1", [SITE, f]);
      await db.query("update reporting_private.batches set lease_fence = $2 where batch_id = $1", [ref.batchId, f]);
    };
    await bump(old + 1);
    try {
      await expect(hashOwnerInputStep(c(), ref.batchId, old, handle, hashes, 37)).rejects.toThrow(/obsolete/);
      const next = await hashOwnerInputStep(c(), ref.batchId, old + 1, handle, hashes, 37);
      expect((next.payload as { hashes: unknown[] }).hashes).toEqual(hashes.slice(37, 74));
      const rest = await hashOwnerInput(c(), ref.batchId, old + 1, handle, hashes, { unit: 37 });
      expect(rest).toMatchObject({ complete: true, calls: Math.ceil((202 - 74) / 37) });
      expect((await head(handle, old + 1)).inputHashes).toEqual(hashes);
    } finally {
      await bump(old);
    }
  }, 300_000);
});

describe("light-route activation (T15P-4d step 1)", () => {
  async function wipe(key: string) {
    const sel = `select handle from reporting_private.owner_inputs where partition_key = '${key}'`;
    await db.query(`delete from reporting_private.owner_input_pieces where handle in (${sel})`);
    await db.query(`delete from reporting_private.owner_input_events where handle in (${sel})`);
    await db.query(`delete from reporting_private.owner_inputs where partition_key = '${key}'`);
  }
  /** Run one owner through the routed read, recording the LIGHT route's source RPCs and whether the journal was opened. */
  async function routed(key: string, limits?: ActivationLimits) {
    const o: Owner = { partitionKind: "order", partitionKey: key };
    await wipe(key);
    const lightCalls: string[] = [];
    const lightClient: RpcClient = { rpc: async (fn, a) => (lightCalls.push(fn), c().rpc(fn, a)) };
    let opened = 0;
    const r = await routedOwnerInput((beforeRead) => rpcFrozenReader(lightClient, ref, { beforeRead }), o, async () => {
      opened++;
      const h = await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan");
      return { reader: rpcFrozenReader(c(), ref), journal: ownerJournal(c(), ref.batchId, ref.fence, h.handle, h.seq, cutoffUs()), resume: null };
    }, limits);
    const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
    expect(r.input, key).toEqual(want);
    const journals = (await db.query<{ n: number }>("select count(*)::int as n from reporting_private.owner_inputs where partition_key = $1", [key])).rows[0].n;
    return { r, lightCalls, opened, journals };
  }

  it("an owner that never crosses a trigger completes on the light route and never opens a journal", async () => {
    const { r, lightCalls, opened, journals } = await routed("OQ-1");
    expect(r.route).toBe("light");
    expect(r.activation).toBeNull();
    expect(r.light.calls).toBe(lightCalls.length);
    expect(r.light.calls).toBeLessThan(16);
    expect([opened, journals]).toEqual([0, 0]);
  });

  it("16 source attempts: activates before the 17th, then the durable route reproduces buildOwnerInput", async () => {
    const { r, lightCalls, opened, journals } = await routed("O-1");
    expect(r.route).toBe("durable");
    expect(r.activation?.trigger).toBe("calls");
    expect(r.activation?.counts.calls).toBe(16);
    expect(lightCalls).toHaveLength(16); // no 17th light RPC was sent
    expect([opened, journals]).toEqual([1, 1]);
  });

  it("1,000 distinct consumed rows: activates before the next dependent call, with at most one page of overshoot", async () => {
    const { r, lightCalls } = await routed("BIG");
    expect(r.activation?.trigger).toBe("rows");
    expect(r.activation!.counts.rows).toBeGreaterThanOrEqual(1000);
    expect(r.activation!.counts.rows).toBeLessThanOrEqual(2000); // the triggering page is the only overshoot
    expect(lightCalls).toEqual(["read_reporting_owner_members"]); // the member page that crossed it; nothing after
    expect(r.route).toBe("durable");
  });

  it("reduced bytes (UTF-8 of the canonical text): activates on the byte trigger", async () => {
    const big = (await db.query<{ n: number }>("select octet_length(line_sku)::int as n from public.production_events where id = 'nt-big'")).rows[0].n;
    expect(big).toBeGreaterThan(300_000);
    const { r } = await routed("NOTE", { calls: 16, rows: 1000, bytes: 500_000 });
    expect(r.activation?.trigger).toBe("bytes");
    expect(r.activation!.counts.bytes).toBeGreaterThanOrEqual(500_000);
    expect(r.route).toBe("durable");
    // the counter is UTF-8 bytes of the reduced text, not string length
    expect(reducedBytes({ ...((await buildOwnerInput(rpcFrozenReader(c(), ref), { partitionKind: "order", partitionKey: "OQ-1" })).events[0]), line_sku: "é" })).toBeGreaterThan(
      JSON.stringify({ ...((await buildOwnerInput(rpcFrozenReader(c(), ref), { partitionKind: "order", partitionKey: "OQ-1" })).events[0]), line_sku: "é" }).length);
  });

  it("the default limits are the approved ones", () => {
    expect(ACTIVATION_LIMITS).toEqual({ calls: 16, rows: 1000, bytes: 921_600 });
  });
});

describe("allowance-bounded shared flush for simultaneous light owners (T15P-4d step 1b)", () => {
  async function wipe(key: string) {
    const sel = `select handle from reporting_private.owner_inputs where partition_key = '${key}'`;
    await db.query(`delete from reporting_private.owner_input_pieces where handle in (${sel})`);
    await db.query(`delete from reporting_private.owner_input_events where handle in (${sel})`);
    await db.query(`delete from reporting_private.owner_inputs where partition_key = '${key}'`);
  }
  async function together(keys: string[], limits: ActivationLimits = ACTIVATION_LIMITS, maxRows?: number) {
    for (const k of keys) await wipe(k);
    const shared = sharedChildren(rpcFrozenReader(c(), ref), { maxRows });
    const own: Record<string, string[]> = {};
    const results = await Promise.all(keys.map((key) => {
      const o: Owner = { partitionKind: "order", partitionKey: key };
      own[key] = [];
      const client: RpcClient = { rpc: async (fn, a) => (own[key].push(fn), c().rpc(fn, a)) };
      return routedOwnerInput((beforeRead, share) => shared.forOwner(rpcFrozenReader(client, ref, { beforeRead }), share), o, async () => {
        const h = await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan");
        return { reader: rpcFrozenReader(c(), ref), journal: ownerJournal(c(), ref.batchId, ref.fence, h.handle, h.seq, cutoffUs()), resume: null };
      }, limits);
    }));
    for (let i = 0; i < keys.length; i++) expect(results[i].input, keys[i]).toEqual(await buildOwnerInput(rpcFrozenReader(c(), ref), { partitionKind: "order", partitionKey: keys[i] }));
    return { results, stats: shared.stats, own };
  }
  const KEYS = ["O-1", "OP-1", "OP-2", "OQ-2"];

  it("every flush issues at most its smallest waiter allowance; activated owners never exceed 16 counted calls", async () => {
    const { results, stats } = await together(KEYS);
    expect(stats.flushes.length).toBeGreaterThan(0);
    expect(stats.flushes.some((f) => f.waiters >= 2)).toBe(true); // genuinely shared
    for (const f of stats.flushes) {
      expect(f.allowance).toBeLessThanOrEqual(16);
      expect(f.pages).toBeLessThanOrEqual(Math.max(0, f.allowance));
    }
    for (const r of results) if (r.activation) expect(r.activation.counts.calls).toBeLessThanOrEqual(16);
    expect(results.find((r) => r.input.owner.partitionKey === "O-1")!.route).toBe("durable");
  }, 300_000);

  it("tight allowances and a small window: flushes are capped, the discarded prefix is not evidence, results are unchanged", async () => {
    const { results, stats } = await together(KEYS, { calls: 4, rows: 1000, bytes: 921_600 }, 2);
    for (const f of stats.flushes) expect(f.pages).toBeLessThanOrEqual(Math.max(0, f.allowance));
    expect(stats.flushes.some((f) => f.allowance <= 0 || f.pages === f.allowance)).toBe(true); // the allowance bound was reached
    for (const r of results) if (r.activation) expect(r.activation.counts.calls).toBeLessThanOrEqual(4);
  }, 300_000);
});

describe("failed and retried attempts count toward activation (step 1b hardening)", () => {
  it("a failed shared attempt is charged to every waiting owner before it is sent", async () => {
    let failNext = true;
    const flaky: RpcClient = {
      rpc: async (fn, a) => {
        if (fn === "read_reporting_children" && failNext) {
          failNext = false;
          return { data: null, error: { message: "fetch failed" } };
        }
        return c().rpc(fn, a);
      },
    };
    const shared = sharedChildren(rpcFrozenReader(flaky, ref));
    const mk = () => {
      const s = { calls: 0, allowance: () => 16 - s.calls, charge: () => void s.calls++ };
      return s;
    };
    const a = mk();
    const b = mk();
    const drain = async (it: AsyncIterable<Ev>) => {
      for await (const _ of it) void 0;
    };
    const ra = drain(shared.forOwner(rpcFrozenReader(c(), ref), a).children(["o1-a"]));
    const rb = drain(shared.forOwner(rpcFrozenReader(c(), ref), b).children(["nt-2"]));
    await expect(ra).rejects.toThrow(/fetch failed/);
    await expect(rb).rejects.toThrow(/fetch failed/);
    expect(shared.stats.flushes).toEqual([{ allowance: 16, pages: 1, waiters: 2 }]); // ONE shared attempt, failed
    expect([a.calls, b.calls]).toEqual([1, 1]); // charged to both waiters although it failed
  });

  it("an owner retried with the same watch keeps its failed attempts: the retry gets only the remaining allowance", async () => {
    const o: Owner = { partitionKind: "order", partitionKey: "O-1" };
    const sel = "select handle from reporting_private.owner_inputs where partition_key = 'O-1'";
    await db.query(`delete from reporting_private.owner_input_pieces where handle in (${sel})`);
    await db.query(`delete from reporting_private.owner_input_events where handle in (${sel})`);
    await db.query("delete from reporting_private.owner_inputs where partition_key = 'O-1'");
    const durable = async () => {
      const h = await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan");
      return { reader: rpcFrozenReader(c(), ref), journal: ownerJournal(c(), ref.batchId, ref.fence, h.handle, h.seq, cutoffUs()), resume: null };
    };
    const w = activationWatch(o);
    let n = 0;
    const failing4th: RpcClient = { rpc: async (fn, a) => (++n === 4 ? { data: null, error: { message: "fetch failed" } } : c().rpc(fn, a)) };
    const shared1 = sharedChildren(rpcFrozenReader(c(), ref));
    await expect(routedOwnerInput((beforeRead, share) => shared1.forOwner(rpcFrozenReader(failing4th, ref, { beforeRead }), share), o, durable, ACTIVATION_LIMITS, w)).rejects.toThrow(/fetch failed/);
    const sharedPages1 = shared1.stats.flushes.reduce((x, f) => x + f.pages, 0);
    expect(n).toBe(4); // the failed 4th attempt was the last one
    expect(w.calls).toBe(4 + sharedPages1); // own attempts (the failed one included) plus charged shared attempts
    expect(w.calls).toBeLessThan(16);
    const before = w.calls;
    let m = 0;
    const counting: RpcClient = { rpc: async (fn, a) => (m++, c().rpc(fn, a)) };
    const shared2 = sharedChildren(rpcFrozenReader(c(), ref));
    const r = await routedOwnerInput((beforeRead, share) => shared2.forOwner(rpcFrozenReader(counting, ref, { beforeRead }), share), o, durable, ACTIVATION_LIMITS, w);
    expect(r.activation?.trigger).toBe("calls");
    expect(r.activation?.counts.calls).toBe(16);
    const sharedPages2 = shared2.stats.flushes.reduce((x, f) => x + f.pages, 0);
    expect(m + sharedPages2).toBe(16 - before); // only the remaining allowance on the retry
    expect(r.input).toEqual(await buildOwnerInput(rpcFrozenReader(c(), ref), o));
  }, 120_000);
});

describe("worker seams over the journal (T15P-4d step 3a)", () => {
  async function wipe(key: string) {
    const sel = `select handle from reporting_private.owner_inputs where partition_key = '${key}'`;
    await db.query(`delete from reporting_private.owner_input_pieces where handle in (${sel})`);
    await db.query(`delete from reporting_private.owner_input_events where handle in (${sel})`);
    await db.query(`delete from reporting_private.owner_inputs where partition_key = '${key}'`);
  }
  it("version first: the supported protocol passes; a missing function or another version is a typed refusal", async () => {
    await expect(requireOwnerInputProtocol(c())).resolves.toBeUndefined();
    const missing: RpcClient = { rpc: async (fn, a) => (fn === "reporting_owner_input_version" ? { data: null, error: { message: "Could not find the function public.reporting_owner_input_version" } } : c().rpc(fn, a)) };
    await expect(requireOwnerInputProtocol(missing)).rejects.toThrow(/owner_input_unsupported: reporting_owner_input_version is unavailable/);
    const v2: RpcClient = { rpc: async (fn, a) => (fn === "reporting_owner_input_version" ? { data: [{ version: 2 }], error: null } : c().rpc(fn, a)) };
    await expect(requireOwnerInputProtocol(v2)).rejects.toThrow(/owner_input_unsupported: protocol version 2/);
    await expect(requireOwnerInputProtocol(v2)).rejects.toBeInstanceOf(OwnerInputUnsupportedError);
  });

  it("plan -> stage: a stage request recovers a plan journal and its first sealed write upgrades the stored purpose; a plan request then refuses it right after lookup", async () => {
    const o: Owner = { partitionKind: "order", partitionKey: "OQ-5" };
    await wipe("OQ-5");
    await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan");
    // (2) the single legal upgrade: a stage request recovers the plan journal
    const r = await recoverOwnerJournal(c(), ref.batchId, ref.fence, o, SITE, "stage");
    expect(r.header.purpose).toBe("plan");
    expect(r.snapshot?.state).toEqual({ v: 1, step: "members", m: { afterOrd: null } });
    const member = (await buildOwnerInput(rpcFrozenReader(c(), ref), o)).members[0];
    // the first write on the SEALED batch (all three seal fields; restored afterwards) upgrades the stored purpose
    await db.query("update reporting_private.batches set sealed_at = now(), sealed_work_count = 0, sealed_manifest_hash = repeat('0', 64) where batch_id = $1", [ref.batchId]);
    try {
      const j = ownerJournal(c(), ref.batchId, ref.fence, r.handle, r.seq, cutoffUs());
      await j.commit({ events: [member], firstOrd: 1, steps: [{ v: 1, step: "members", m: { afterOrd: 1 } }] });
      expect((await loadOwnerInputHeader(c(), ref.batchId, ref.fence, r.handle)).purpose).toBe("stage");
    } finally {
      await db.query("update reporting_private.batches set sealed_at = null, sealed_work_count = null, sealed_manifest_hash = null where batch_id = $1", [ref.batchId]);
    }
    // (1) a plan request never downgrades a stage journal: refused right after lookup, nothing discarded or reloaded
    const calls: string[] = [];
    const rec: RpcClient = { rpc: async (fn, a) => (calls.push(fn), c().rpc(fn, a)) };
    await expect(recoverOwnerJournal(rec, ref.batchId, ref.fence, o, SITE, "plan")).rejects.toBeInstanceOf(OwnerInputPurposeError);
    await expect(recoverOwnerJournal(rec, ref.batchId, ref.fence, o, SITE, "plan")).rejects.toThrow(/owner_input_purpose: an order owner has a stage journal, not plan/);
    expect(calls).toEqual(["lookup_reporting_owner_inputs", "lookup_reporting_owner_inputs"]);
    // a stage request still recovers the (now stage) journal
    expect((await recoverOwnerJournal(c(), ref.batchId, ref.fence, o, SITE, "stage")).header).toMatchObject({ purpose: "stage", eventCount: 1 });
    await wipe("OQ-5");
  });

  it("a reloaded header that disagrees with the requested purpose is rejected, not adopted", async () => {
    const o: Owner = { partitionKind: "order", partitionKey: "OQ-5" };
    const forged: RpcClient = {
      rpc: async (fn, a) => {
        const r = await c().rpc(fn, a);
        if (fn === "load_reporting_owner_input_header" && Array.isArray(r.data)) return { data: (r.data as Array<Record<string, unknown>>).map((x) => ({ ...x, purpose: "stage" })), error: null };
        return r;
      },
    };
    const before = await loadOwnerInputHeader(c(), ref.batchId, ref.fence, (await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan")).handle);
    await expect(recoverOwnerJournal(forged, ref.batchId, ref.fence, o, SITE, "plan")).rejects.toThrow(/owner_input_purpose: an order owner has a stage journal, not plan/);
    const after = await loadOwnerInputHeader(c(), ref.batchId, ref.fence, (await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan")).handle);
    expect(after).toEqual(before); // nothing was written
  });

  it("a transient version failure stays transient (code-only and message-only); diagnostics and failure kinds are stable and key-free", async () => {
    const codeOnly: RpcClient = { rpc: async (fn, a) => (fn === "reporting_owner_input_version" ? { data: null, error: { message: "retry this transaction", code: "40001" } } : c().rpc(fn, a)) };
    const e1 = await requireOwnerInputProtocol(codeOnly).then(() => null, (e: unknown) => e);
    expect(e1).not.toBeInstanceOf(OwnerInputUnsupportedError);
    expect(isTransient(e1)).toBe(true);
    expect(failureKind(e1)).toBe("transient");
    expect((e1 as { code?: string }).code).toBe("40001");
    const network: RpcClient = { rpc: async (fn, a) => (fn === "reporting_owner_input_version" ? { data: null, error: { message: "fetch failed" } } : c().rpc(fn, a)) };
    expect(failureKind(await requireOwnerInputProtocol(network).then(() => null, (e: unknown) => e))).toBe("transient");
    // stable kinds for the owner-input failures, and no raw owner key in any diagnostic
    const secretOrder: Owner = { partitionKind: "order", partitionKey: "CUSTOMER-ORDER-123" };
    const secretEvent: Owner = { partitionKind: "event", partitionKey: "evt-9f8e7d" };
    const errors = [new OwnerInputTooHeavyError(secretOrder, 121), new OwnerInputTooHeavyError(secretEvent, 130), new OwnerInputPurposeError(secretOrder, "stage", "plan"), new OwnerInputUnsupportedError("protocol version 2")];
    expect(errors.map(failureKind)).toEqual(["owner_input_too_heavy", "owner_input_too_heavy", "owner_input_purpose", "owner_input_unsupported"]);
    expect(failureKind(Object.assign(new Error("x"), { code: "owner_input_capacity" }))).toBe("owner_input_capacity");
    for (const e of errors) expect(e.message).not.toMatch(/CUSTOMER-ORDER-123|evt-9f8e7d/);
    expect(errors.every((e) => !isTransient(e))).toBe(true);
  });

  it("a partially hashed or complete journal recovers its validated input once: zero source reads, exactly the accounted reload, no second event reload (scope review Should-fix 1)", async () => {
    const o: Owner = { partitionKind: "order", partitionKey: "OQ-3" }; // 202 audiences: hashing spans three units
    await wipe("OQ-3");
    const h = await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan");
    const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
    await durableOwnerInput(rpcFrozenReader(c(), ref), o, ownerJournal(c(), ref.batchId, ref.fence, h.handle, h.seq, cutoffUs()));
    const old = await readOwnerOldStaff(c(), ref.batchId, ref.fence, o, null);
    const hashes = ownerWorksFromInput(rpcFrozenReader(c(), ref), o, want, old).map((w) => ({ audienceKind: w.desc.audienceKind, audienceStaff: w.desc.audienceStaff, inputHash: w.desc.inputHash }));
    await hashOwnerInput(c(), ref.batchId, ref.fence, h.handle, hashes, { unit: 100, maxSteps: 1 }); // now partially hashed
    for (const phase of ["hashing", "complete"] as const) {
      const calls: string[] = [];
      const rec: RpcClient = { rpc: async (fn, a) => (calls.push(fn), c().rpc(fn, a)) };
      const r = await recoverOwnerJournal(rec, ref.batchId, ref.fence, o, SITE, "plan");
      expect(r.header.phase).toBe(phase);
      expect(r.snapshot).toBeNull();
      expect(r.input).toEqual(want); // exactly buildOwnerInput's input, from the journal alone
      const eventLoads = calls.filter((x) => x === "load_reporting_owner_input_events").length;
      expect(1 + eventLoads).toBe(r.header.reloadCalls); // header + event pages = the accounted reload, once
      expect(r.reloadCalls).toBe(r.header.reloadCalls);
      // the next unit is computed from the returned input: no source read and no further event reload
      calls.length = 0;
      const works = ownerWorksFromInput(rpcFrozenReader(rec, ref), o, r.input!, old);
      expect(works.map((w) => w.desc.inputHash)).toEqual(hashes.map((x) => x.inputHash));
      if (phase === "hashing") await hashOwnerInput(rec, ref.batchId, ref.fence, r.handle, hashes);
      const SOURCE_FNS = ["read_reporting_owner_members", "read_reporting_events_by_id", "read_reporting_children", "read_reporting_staff_stream", "read_reporting_predecessor_page"];
      expect(calls.filter((x) => SOURCE_FNS.includes(x))).toEqual([]);
      expect(calls.filter((x) => x === "load_reporting_owner_input_events")).toEqual([]);
    }
  }, 120_000);

  it("a heavy journal fails fast after lookup, before any reload or discard", async () => {
    const o: Owner = { partitionKind: "order", partitionKey: "OQ-4" };
    await wipe("OQ-4");
    const h = await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan");
    await db.query("update reporting_private.owner_inputs set heavy_proven = true where handle = $1::bigint", [h.handle]);
    const calls: string[] = [];
    const rec: RpcClient = { rpc: async (fn, a) => (calls.push(fn), c().rpc(fn, a)) };
    await expect(recoverOwnerJournal(rec, ref.batchId, ref.fence, o, SITE, "plan")).rejects.toBeInstanceOf(OwnerInputTooHeavyError);
    expect(calls).toEqual(["lookup_reporting_owner_inputs"]); // no header load, no events load, no discard
    await wipe("OQ-4");
  });

  it("a new process: an unfinished page's pending data is discarded, then the journal reloads to a resumable snapshot", async () => {
    const o: Owner = { partitionKind: "order", partitionKey: "NOTE" };
    await wipe("NOTE");
    const h = await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan");
    // an interrupted process left the first pieces call of a fragmented page (not heavy)
    let pieceCalls = 0;
    const lossy: RpcClient = {
      rpc: async (fn, a) => {
        const r = await c().rpc(fn, a);
        if (fn === "checkpoint_reporting_owner_input" && (a?.p_payload as { kind?: string })?.kind === "pieces" && ++pieceCalls === 1) throw new Error("process died");
        return r;
      },
    };
    await expect(durableOwnerInput(rpcFrozenReader(c(), ref), o, ownerJournal(lossy, ref.batchId, ref.fence, h.handle, h.seq, cutoffUs()))).rejects.toThrow(/process died/);
    const r = await recoverOwnerJournal(c(), ref.batchId, ref.fence, o, SITE, "plan");
    expect(r.discarded).toBeGreaterThan(0);
    expect(r.header.pendingEvents).toBe(0);
    expect(r.snapshot).not.toBeNull();
    expect(r.reloadCalls).toBe(r.header.reloadCalls);
    const got = await durableOwnerInput(rpcFrozenReader(c(), ref), o, ownerJournal(c(), ref.batchId, ref.fence, r.handle, r.seq, cutoffUs()), r.snapshot);
    expect(got).toEqual(await buildOwnerInput(rpcFrozenReader(c(), ref), o));
    // a journal past reading recovers with no snapshot (the caller continues hashing)
    const old = await readOwnerOldStaff(c(), ref.batchId, ref.fence, o, null);
    const hashes = ownerWorksFromInput(rpcFrozenReader(c(), ref), o, got, old).map((w) => ({ audienceKind: w.desc.audienceKind, audienceStaff: w.desc.audienceStaff, inputHash: w.desc.inputHash }));
    await hashOwnerInput(c(), ref.batchId, ref.fence, r.handle, hashes, { unit: 1, maxSteps: 1 });
    const again = await recoverOwnerJournal(c(), ref.batchId, ref.fence, o, SITE, "plan");
    expect(again.snapshot).toBeNull();
    expect(again.header.phase).toBe(hashes.length === 1 ? "complete" : "hashing");
  }, 120_000);
});

describe("a complete multi-line 0045 page is ONE atomic durable page (scope review Must-fix 4)", () => {
  const o: Owner = { partitionKind: "order", partitionKey: "CP-M" };

  it("lines and included kids commit together in ordered steps, before the next dependent read, with no child request for them", async () => {
    const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
    const { trace } = await traced(o);
    const i = trace.findIndex((x) => "rpc" in x && x.rpc === "read_reporting_predecessor_page");
    expect(i).toBeGreaterThan(-1);
    const page = trace[i] as { rpc: string; args: Record<string, unknown> };
    expect(page.args).toMatchObject({ p_staff: W4, p_at_event_id: "" }); // the first page starts just above the latest member line
    expect(page.args.p_certain_event_id).toBe("cp-t1"); // ASCII earliest id: the exact (instant, id) bound
    // the very next entry after the combined page is its commit: no dependent read happens before it
    const next = trace[i + 1] as { commit: number; ids: string[]; steps: Array<{ step: string; w?: { line: { phase: string } | null } }> };
    expect("commit" in next).toBe(true);
    expect(next.ids).toEqual(expect.arrayContaining(["cp-t2", "cp-t2-k", "cp-t0", "cp-t0-k"]));
    // ordered steps per line: pending kids -> kids at its included child -> done -> cursor
    const phases = next.steps.map((st) => (st.step === "walk" ? (st.w!.line ? st.w!.line.phase : "cursor") : st.step));
    expect(phases.join(",")).toMatch(/^(kids,kids,done,cursor,)+/);
    // no children request for any line whose complete kids were included in the page
    const kidReads = trace.filter((x) => "rpc" in x && x.rpc === "read_reporting_children" && (x.args.p_parent_ids as string[]).some((pid) => ["cp-t3", "cp-t2", "cp-t1", "cp-t0"].includes(pid)) && (x.args.p_parent_ids as string[]).length === 1);
    expect(kidReads).toEqual([]);
    const back = await reloadOwnerInput(c(), ref.batchId, ref.fence, (await openOwnerInput(c(), ref.batchId, ref.fence, o, "plan")).handle, SITE);
    expect(back.events.map((e) => e.ev).sort((x, y) => compareUtf8(x.id, y.id))).toEqual(want.events);
  });

  it("a crash just before that commit, or after it with the response lost, recovers from the saved cursor without re-reading the committed page", async () => {
    const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
    const full = await traced(o);
    const i = full.trace.findIndex((x) => "rpc" in x && x.rpc === "read_reporting_predecessor_page");
    const k = (full.trace[i + 1] as { commit: number }).commit;
    for (const mode of ["before", "after"] as const) {
      const { handle } = await traced(o, { k, mode });
      const back = await reloadOwnerInput(c(), ref.batchId, ref.fence, handle, SITE);
      const snap = ownerJournalSnapshot(back);
      const reads: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const client: RpcClient = { rpc: async (fn, a) => (fn.startsWith("read_reporting_") && reads.push({ fn, args: a ?? {} }), c().rpc(fn, a)) };
      const got = await durableOwnerInput(rpcFrozenReader(client, ref), o, ownerJournal(c(), ref.batchId, ref.fence, handle, back.header.seq, cutoffUs()), snap);
      expect(got, mode).toEqual(want);
      const committed = new Set(back.events.map((e) => e.ev.id));
      if (mode === "after") {
        // the page was committed: the resume starts at the saved cursor (the last consumed line), never re-reads it
        expect(committed.has("cp-t0")).toBe(true);
        const st = snap.state as { step: string; w?: { cursorOrd: number | null } };
        if (st.step === "walk" && st.w!.cursorOrd !== null) {
          const first = reads.find((r) => r.fn === "read_reporting_predecessor_page" || r.fn === "read_reporting_staff_stream")!;
          const cur = snap.events[st.w!.cursorOrd - 1];
          expect(first.args).toMatchObject({ p_at: cur.created_at, p_at_event_id: cur.id });
        } else {
          // the complete short page also proved the stream end in the same atomic commit: nothing is read again
          expect(st.step).toBe("done");
          expect(reads).toEqual([]);
        }
      } else {
        expect(committed.has("cp-t2")).toBe(false); // nothing of the page was committed: it is read again
      }
    }
  });
});

describe("the conservative Unicode certain bound: exact below U+D800, instant only otherwise (scope review Must-fix 4, Proof 3)", () => {
  for (const [key, staff, cp, exact] of UNI) {
    it(`${key}: every 0045 page of both routes carries the same certain bound, ${exact ? "with the exact id" : "instant only (null id)"}`, async () => {
      const o: Owner = { partitionKind: "order", partitionKey: key };
      const light = recording(c());
      const want = await buildOwnerInput(rpcFrozenReader(light.client, ref), o);
      const earliest = want.members.find((m) => m.id === uniId(cp))!;
      expect(earliest, "the fixture's earliest member").toBeDefined();
      const { trace, handle } = await traced(o);
      const durable = trace.filter((x): x is { rpc: string; args: Record<string, unknown> } => "rpc" in x && x.rpc === "read_reporting_predecessor_page");
      const plain = light.calls.filter((x) => x.fn === "read_reporting_predecessor_page");
      expect(durable.length).toBeGreaterThan(0);
      expect(plain.length).toBeGreaterThan(0);
      for (const [route, pages] of [["durable", durable.map((x) => x.args)], ["light", plain.map((x) => x.args)]] as const) {
        for (const a of pages) {
          expect(a.p_staff, route).toBe(staff);
          expect(a.p_certain_event_id, `${route}: certain id`).toBe(exact ? uniId(cp) : null);
          // the certain instant is the earliest member line's exact microsecond
          expect(exactInstant(a.p_certain_at as string), `${route}: certain instant`).toBe(exactInstant(earliest.created_at));
        }
      }
      expect(durable.map((x) => [x.args.p_certain_at, x.args.p_certain_event_id])).toEqual(plain.map((x) => [x.args.p_certain_at, x.args.p_certain_event_id]));
      const back = await reloadOwnerInput(c(), ref.batchId, ref.fence, handle, SITE);
      expect(back.events.map((e) => e.ev).sort((x, y) => compareUtf8(x.id, y.id))).toEqual(want.events);
    });
  }
});

describe("a line without included kids inside a combined 0045 page (scope review Must-fix 4, Proof 2)", () => {
  const o: Owner = { partitionKind: "order", partitionKey: "CQ-M" };
  type Rpc = { rpc: string; args: Record<string, unknown> };
  type Commit = { commit: number; ids: string[]; steps: Array<Record<string, any>> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const KIDS = ["cq-tm1-k1", "cq-tm1-k2", "cq-tm1-k3"];

  async function shape() {
    const { trace } = await traced(o);
    const ords: string[] = [];
    for (const x of trace) if ("commit" in x) ords.push(...x.ids);
    const ordOf = (id: string) => ords.indexOf(id) + 1;
    const i = trace.findIndex((x) => "rpc" in x && x.rpc === "read_reporting_predecessor_page");
    return { trace, ordOf, i };
  }

  it("the page and cq-tm1's pending line commit first; then its own kid pages, each committed; then done and the cursor", async () => {
    const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
    expect(want.events.map((e) => e.id)).toEqual(expect.arrayContaining(["cq-tm1", ...KIDS]));
    const { trace, ordOf, i } = await shape();
    expect(i).toBeGreaterThan(-1);
    expect((trace[i] as Rpc).args).toMatchObject({ p_staff: W10, p_certain_event_id: "cq-t1" });
    // commit A: the combined page through cq-t0, plus cq-tm1 and its pending kids step (no kid yet), before any kid read
    const A = trace[i + 1] as Commit;
    expect("commit" in A).toBe(true);
    expect(A.ids).toEqual(expect.arrayContaining(["cq-t2", "cq-t2-k", "cq-t0", "cq-t0-k", "cq-tm1"]));
    for (const k of KIDS) expect(A.ids).not.toContain(k);
    const tm1 = ordOf("cq-tm1");
    expect(A.steps.at(-1)).toMatchObject({ step: "walk", w: { line: { ord: tm1, phase: "kids", afterKidOrd: null } } });
    // then cq-tm1's own kid pages: each non-empty page is committed before the next request, which continues after its last kid
    let j = i + 2;
    let after: string | null = null;
    const kidPages: string[][] = [];
    for (;;) {
      const r = trace[j] as Rpc;
      expect(r.rpc, `entry ${j}`).toBe("read_reporting_children");
      expect(r.args).toMatchObject({ p_parent_ids: ["cq-tm1"], p_after_parent_id: after === null ? null : "cq-tm1", p_after_event_id: after });
      const next = trace[j + 1] as Commit;
      expect("commit" in next, `a commit follows the kid read at ${j}`).toBe(true);
      const kids = next.ids.filter((id) => KIDS.includes(id));
      if (!kids.length) {
        // the empty kid page: commit D finishes the line (done{effective}), then moves the cursor to it
        const phases = next.steps.map((st) => (st.step === "walk" ? (st.w.line ? `${st.w.line.ord === tm1 ? "tm1-" : ""}${st.w.line.phase}` : `cursor:${st.w.cursorOrd}`) : st.step));
        expect(phases.slice(0, 2)).toEqual(["tm1-done", `cursor:${tm1}`]);
        expect(next.steps[0].w.line.effective).toBe(true);
        break;
      }
      kidPages.push(kids);
      expect(next.ids).toEqual(kids); // a kid page's commit holds exactly that page
      after = kids.at(-1)!;
      expect(next.steps.at(-1)).toMatchObject({ w: { line: { ord: tm1, phase: "kids", afterKidOrd: ordOf(after) } } });
      j += 2;
    }
    expect(kidPages.flat()).toEqual(KIDS);
    expect(kidPages.length, "the 400 KB kids span more than one non-empty kid page").toBeGreaterThan(1);
    // no kid request for the lines whose complete kids the combined page included
    const included = trace.filter((x) => "rpc" in x && x.rpc === "read_reporting_children" && (x.args.p_parent_ids as string[]).some((p) => ["cq-t3", "cq-t2", "cq-t1", "cq-t0"].includes(p)) && (x.args.p_parent_ids as string[]).length === 1);
    expect(included).toEqual([]);
  }, 300_000);

  it("a crash before or after each of those commits resumes to buildOwnerInput with the exact next request", async () => {
    const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
    const { trace, i } = await shape();
    const first = (trace[i + 1] as Commit).commit;
    const last = (trace.filter((x) => "commit" in x).at(-1) as Commit).commit;
    for (let k = first; k <= last; k++) {
      for (const mode of ["before", "after"] as const) {
        const handle = await crashAt(o, k, mode);
        const s = await resume(o, handle, want, `CQ-M ${mode} ${k}`);
        if (mode === "after" && k === first) expect(s.w.line).toMatchObject({ phase: "kids", afterKidOrd: null }); // resumes at its first kid read
      }
    }
  }, 600_000);
});
