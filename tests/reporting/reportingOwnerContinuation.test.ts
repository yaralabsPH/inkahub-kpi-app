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
import { openOwnerInput, ownerJournal, ownerJournalSnapshot, reloadOwnerInput, saveEnumeration } from "../../api/_lib/reporting-worker-state";
import { exactInstant } from "../../src/lib/domain/productionCounts";
import { reportingDb } from "./pg/harness";
import { pgRpc } from "./pg/rpc";

const W1 = "00000008-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W2 = "00000009-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
  owners = keys.map((k) => ({ partitionKind: "order" as const, partitionKey: k }));
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
