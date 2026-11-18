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
import { buildOwnerInput, durableOwnerInput, ownerKey, type Owner, type OwnerJournal } from "../../api/_lib/production-reporting-materialize";
import { rpcFrozenReader, type FrozenBatchRef } from "../../api/_lib/production-reporting-reader";
import { checkpointOwnerInput, loadOwnerInputHeader, openOwnerInput, ownerJournal, ownerJournalSnapshot, reloadOwnerInput, saveEnumeration } from "../../api/_lib/reporting-worker-state";
import type { ProductionEvidenceEvent as Ev } from "../../src/lib/domain/productionCounts";
import { exactInstant } from "../../src/lib/domain/productionCounts";
import { reportingDb } from "./pg/harness";
import { pgRpc } from "./pg/rpc";

const W1 = "00000008-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W2 = "00000009-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W3 = "0000000a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
  await db.query(
    `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
     values ('au', 'nt-big', $1, 'framed', 'NOTE', 'X' || repeat(chr(92), 300000), 1, 'line_verified', 's', '', '2026-10-01T08:00:10Z', null)`, [W3]);
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
  await saveEnumeration(c(), ref.batchId, ref.fence, null, { kind: "rebuild", after: last }, sorted.map((o) => ({ owner: o, oldStaff: [] })), false);
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

  it("a crash after ANY commit resumes in a fresh process to the same input, without re-reading completed pages", async () => {
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

describe("recovery boundaries (review r2 Must-fix 4): every commit, both crash modes, exact resumed requests", () => {
  type St = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const SOURCE = new Set(["read_reporting_owner_members", "read_reporting_events_by_id", "read_reporting_children", "read_reporting_staff_stream"]);
  /** Wipe one owner's journal so a scenario starts from an empty journal. */
  async function reset(key: string) {
    const sel = `select handle from reporting_private.owner_inputs where partition_key = '${key.replace(/'/g, "''")}'`;
    await db.query(`delete from reporting_private.owner_input_pieces where handle in (${sel})`);
    await db.query(`delete from reporting_private.owner_input_events where handle in (${sel})`);
    await db.query(`delete from reporting_private.owner_inputs where partition_key = '${key.replace(/'/g, "''")}'`);
  }
  /**
   * A source client that checks, before EVERY source read, that the journal's stored state is the phase that read
   * depends on (checkpoint-before-dependent-read), and records each source call.
   */
  function guardedSource(stored: () => St | null) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const client: RpcClient = {
      rpc: async (fn, args) => {
        if (SOURCE.has(fn)) {
          const s = stored();
          const a = args ?? {};
          if (s) {
            const ok =
              fn === "read_reporting_owner_members" ? s.step === "members"
              : fn === "read_reporting_events_by_id" ? s.step === "parents"
              : fn === "read_reporting_staff_stream" ? s.step === "walk" && s.w.line === null
              : (a.p_parent_ids as string[]).length === 1 && s.step === "walk" ? s.w.line !== null && s.w.line.phase === "kids"
              : s.step === "children";
            if (!ok) throw new Error(`${fn} was requested while the stored state is ${JSON.stringify(s)}`);
          }
          calls.push({ fn, args: a });
        }
        return c().rpc(fn, args);
      },
    };
    return { client, calls };
  }
  /** The exact first source request a resume from `s` must make (null: none is predictable / no read at all). */
  function expectedFirst(s: St, events: Ev[], owner: Owner): { fn: string; args: Record<string, unknown> } | "none" | null {
    const at = (ord: number) => events[ord - 1];
    if (s.step === "done") return "none";
    if (s.step === "members") {
      const a = s.m.afterOrd === null ? null : at(s.m.afterOrd);
      return { fn: "read_reporting_owner_members", args: { p_owners: [[owner.partitionKind, owner.partitionKey]], p_after_index: a ? 0 : null, p_after_event_id: a ? a.id : null } };
    }
    if (s.step === "children") {
      const a = s.c.afterOrd === null ? null : at(s.c.afterOrd);
      return { fn: "read_reporting_children", args: { p_after_parent_id: a ? a.parent_event_id : null, p_after_event_id: a ? a.id : null } };
    }
    if (s.step === "walk" && s.w.line && s.w.line.phase === "kids") {
      const l = at(s.w.line.ord);
      const k = s.w.line.afterKidOrd === null ? null : at(s.w.line.afterKidOrd);
      return { fn: "read_reporting_children", args: { p_parent_ids: [l.id], p_after_parent_id: k ? l.id : null, p_after_event_id: k ? k.id : null } };
    }
    if (s.step === "walk" && s.w.line === null && s.w.cursorOrd !== null) {
      const cur = at(s.w.cursorOrd);
      return { fn: "read_reporting_staff_stream", args: { p_direction: "before", p_at: cur.created_at, p_at_event_id: cur.id } };
    }
    return null;
  }
  /** Run `owner` to the k-th journal call boundary: mode "before" dies before commit k, "after" commits k then loses the response. */
  async function crashAt(owner: Owner, k: number, mode: "before" | "after", truncateDone = false) {
    await reset(owner.partitionKey);
    const h = await openOwnerInput(c(), ref.batchId, ref.fence, owner, "plan");
    const j = ownerJournal(c(), ref.batchId, ref.fence, h.handle, h.seq, cutoffUs());
    let stored: St | null = { v: 1, step: "members", m: { afterOrd: null } };
    let n = 0;
    const src = guardedSource(() => stored);
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
        stored = steps[steps.length - 1] as unknown as St;
        if ((mode === "after" || truncateDone) && n === k) throw new Crash(`after ${k}`);
      },
    };
    await expect(durableOwnerInput(rpcFrozenReader(src.client, ref), owner, journal)).rejects.toBeInstanceOf(Crash);
    return h.handle;
  }
  async function resume(owner: Owner, handle: string, want: unknown, label: string) {
    const back = await reloadOwnerInput(c(), ref.batchId, ref.fence, handle, SITE);
    const snap = ownerJournalSnapshot(back);
    let stored: St = snap.state as unknown as St;
    const j = ownerJournal(c(), ref.batchId, ref.fence, handle, back.header.seq, cutoffUs());
    const src = guardedSource(() => stored);
    const got = await durableOwnerInput(rpcFrozenReader(src.client, ref), owner, { commit: async (p) => { await j.commit(p); stored = p.steps[p.steps.length - 1] as unknown as St; } }, snap);
    expect(got, label).toEqual(want);
    const first = expectedFirst(snap.state as unknown as St, snap.events, owner);
    if (first === "none") expect(src.calls, `${label}: a done journal reads nothing`).toEqual([]);
    else if (first) expect(src.calls[0], `${label}: the first resumed request continues exactly at the saved cursor`).toMatchObject(first);
    return snap.state as unknown as St;
  }
  /** The steps of every commit of an uninterrupted durable read (journal-free). */
  async function commitsOf(owner: Owner) {
    const commits: St[][] = [];
    await durableOwnerInput(rpcFrozenReader(c(), ref), owner, { commit: async (p) => void commits.push(p.steps as unknown as St[]) });
    return commits;
  }

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
        if (fn === "read_reporting_staff_stream" && !poisoned && Array.isArray(r.data) && (r.data as unknown[]).length > 1) {
          poisoned = true;
          return { data: [...(r.data as unknown[])].reverse(), error: null };
        }
        return r;
      },
    };
    const j = ownerJournal(c(), ref.batchId, ref.fence, h.handle, h.seq, cutoffUs());
    await expect(durableOwnerInput(rpcFrozenReader(client, ref), o, j)).rejects.toThrow(/keyset order/);
    expect(poisoned).toBe(true);
    expect(calls.at(-1)).toBe("read_reporting_staff_stream"); // the refused page was the last request
    const head = await loadOwnerInputHeader(c(), ref.batchId, ref.fence, h.handle);
    expect(head.seq).toBe(j.seq); // nothing was written after the refused page
    expect(head.state).toMatchObject({ step: "walk", w: { cursorOrd: null, line: null } });
    // and the journal still resumes to the exact input
    const want = await buildOwnerInput(rpcFrozenReader(c(), ref), o);
    const back = await reloadOwnerInput(c(), ref.batchId, ref.fence, h.handle, SITE);
    expect(await durableOwnerInput(rpcFrozenReader(c(), ref), o, ownerJournal(c(), ref.batchId, ref.fence, h.handle, back.header.seq, cutoffUs()), ownerJournalSnapshot(back))).toEqual(want);
  }, 120_000);
});
