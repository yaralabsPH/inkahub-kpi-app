/**
 * Task 15: the protected scheduled worker, its durable resumable state and the
 * auth-first handlers — without a database. A fake reporting database models
 * the 0038/0043 job semantics the worker relies on (fence + live lease on
 * every mutation, takeover returning leased work, durable enumeration
 * checkpoints with replay, per-owner planning, the exact seal, bounded claims,
 * chunk staging, atomic publication). Frozen reads come from the in-memory
 * frozen view, so results are compared with the whole-batch reference path.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildOwnerInput, diffFrozenViews, materializeBatch, materializeOwnerWorks, memoryFrozenReader, ownerDescriptors, ownerKey, ownerOfEvent, ownerWorksFromInput, type ChangedKey, type Owner } from "../../api/_lib/production-reporting-materialize";
import type { EnumerationPages, FrozenBatchRef, FrozenReaderPages } from "../../api/_lib/production-reporting-reader";
import { failureKind, FIRST_UNIT_CPU_MS, FIXED_PREREQUISITE_RPCS, HASH_UNIT_RPCS, HEARTBEAT_MS, isTransient, processCpuMs, READ_LEG_RPCS, runReportingCycle, WORKER_BUDGET_MS, type AdmissionRecord, type CycleResult, type WorkerEnv } from "../../api/_lib/production-reporting-worker";
import { bearerMatches } from "../../api/_lib/reporting-auth";
import { REPORTING_SITES, type RpcClient } from "../../api/_lib/reporting-jobs";
import { compareUtf8, reportingManifestHash, sortDescriptors, type WorkDescriptor } from "../../api/_lib/reporting-stage";
import { checkpointOwners, manifestFromSaved, parseEnumCursor } from "../../api/_lib/reporting-worker-state";
import { AdminCommand, createAdminHandler, runAdminCommand } from "../../api/reports/reporting-admin";
import { createRefreshHandler } from "../../api/reports/refresh-summaries";
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";

type Ev = ProductionEvidenceEvent;
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const CUT = "2026-03-01T00:00:00.000000Z";
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// Fixtures: a small site view, a change set, a refresh/rebuild frozen view
// ---------------------------------------------------------------------------

const ev = (id: string, o: Partial<Ev> = {}): Ev => ({ id, location: "uk", staff_id: W1, department: "framed", order_number: "O-1", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, event_type: "line_verified", created_at: "2026-02-10T08:00:00+00:00", parent_event_id: null, cs_case_id: null, ...o });
function baseView(n: number): Ev[] {
  const out: Ev[] = [];
  for (let i = 0; i < n; i++) {
    const t = `2026-02-${String(10 + (i % 5)).padStart(2, "0")}T${String(8 + (i % 9)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00+00:00`;
    out.push(ev(`e${String(i).padStart(3, "0")}`, { order_number: `O-${i % 23}`, staff_id: i % 3 ? W1 : W2, created_at: t }));
  }
  out.push(ev("c-1", { event_type: "cancelled", order_number: "O-1", parent_event_id: "e001", created_at: "2026-02-15T10:00:00+00:00", line_sku: null, line_quantity: null }));
  out.push(ev("c-2", { event_type: "cancelled", order_number: "   ", staff_id: W2, parent_event_id: "e002", created_at: "2026-02-15T11:00:00+00:00", line_sku: null, line_quantity: null }));
  out.push(ev("solo", { order_number: "O-SOLO", staff_id: W2, created_at: "2026-02-15T12:00:00+00:00" }));
  // The immediate W1 timing successor of e007's OLD position (e007 moves to W2): reachable only by the successor walk.
  out.push(ev("succ", { order_number: "O-SUCC", staff_id: W1, created_at: "2026-02-12T15:07:30+00:00" }));
  return out;
}
function refreshChange(base: Ev[]): { after: Ev[]; changed: ChangedKey[] } {
  const after = base.filter((e) => e.id !== "e005").map((e) => (e.id === "e007" ? { ...e, order_number: "O-NEW", staff_id: W2 } : e.id === "solo" ? { ...e, order_number: "O-X2", staff_id: W1 } : e.id === "e002" ? { ...e, line_quantity: 2 } : e));
  for (let i = 0; i < 120; i++) after.push(ev(`n${String(i).padStart(3, "0")}`, { order_number: `O-${i % 31}`, created_at: `2026-02-16T0${i % 9}:${String(i % 60).padStart(2, "0")}:00+00:00` }));
  return { after, changed: diffFrozenViews(base, after, CUT, CUT) };
}

// ---------------------------------------------------------------------------
// The fake reporting database
// ---------------------------------------------------------------------------

interface Work { workId: string; desc: WorkDescriptor; state: "pending" | "leased" | "done"; chunks: Map<number, string>; chunkCount: number | null }
/** One owner-input journal (0046): committed pieces by (ord, piece_no), pending pieces, step state, hash progress. */
interface Journal {
  handle: string; batch: string; kind: string; key: string; purpose: "plan" | "stage"; phase: "reading" | "hashing" | "complete"; seq: bigint;
  state: unknown; membersCount: number | null; events: Map<number, unknown[][]>; pending: Map<number, unknown[][]>;
  audiences: unknown[] | null; hashes: unknown[]; last: { expected: string; payload: string; result: Record<string, unknown> } | null;
  /** Running piece counts (committed, pending): the reload accounting without re-scanning the journal. */
  pieces: { committed: number; pending: number };
}
/**
 * FAKE LIMITS (Astra wiring-step-3 review Should-fix 1). This journal models what the routed PLANNING path exercises:
 * fence/lease, pinned-seq loads with a lone eof, pending vs committed pieces, last-checkpoint replay, reading ->
 * hashing -> complete, immutability of a complete journal, and all-or-nothing checkpoints. It does NOT model:
 * 0046's 1,000-row AND 1,048,576-byte load pages (a fixed 500 pieces is synthetic pagination, so reload counts here
 * are not production reload accounting and prove nothing about 119/121), heavy proofs (always false), the
 * frozen/sealed/purpose gates, the audience-set and ordered-hash validation of a hash checkpoint, or jsonb-normalised
 * replay identity (string equality here). Cost, heavy-policy and stage acceptance must use real-SQL evidence.
 */
const LOAD_PAGE = 500;
interface Batch { id: string; site: string; kind: "refresh" | "rebuild"; state: string; fence: number; leaseUntil: number; cutoff: string | null; copyPages: number; copied: number; sealed: { count: number; hash: string } | null }
type Fail = Partial<{ verifyCountOff: boolean; tamperClaim: boolean; lostSaveResponse: number; transientAt: string; transientTimes: number; extraWork: boolean; publishFails: boolean; recordFails: boolean; processorDisabled: boolean; ownerInputVersion: number | "missing"; versionTransient: number }>;

class FakeDb implements RpcClient {
  clock = 1_700_000_000_000;
  calls: Array<{ fn: string; args: Record<string, unknown>; at: number }> = [];
  batch: Batch | null = null;
  fenceSeq = 0;
  progress: { cursor: unknown; complete: boolean; discovered: number; planned: number; descriptors: number } | null = null;
  owners = new Map<string, { kind: string; key: string; staff: string[]; count: number | null }>();
  works: Work[] = [];
  published: Array<{ batch: string; generation: string; works: Work[] }> = [];
  runs: Array<Record<string, unknown>> = [];
  cleanupPasses = 2;
  saves = 0;
  /** 0043 worker_seen (distinct ids per key|seed) and worker_walk_line (one paged line per batch). */
  seen = new Map<string, Set<string>>();
  walkLine: { key: string; seed: number; line: string; image: unknown } | null = null;
  /** T15P-4d: owner-input journals by handle (fenced, seq-checked, replay-safe; see `journal*`). */
  journals = new Map<string, Journal>();
  transientLeft: number;
  /** T15P-4d step 3: code-only transient failures of the version probe still to inject (message is not transient-looking). */
  versionTransientLeft: number;
  constructor(public kind: "refresh" | "rebuild", public fail: Fail = {}, public tick = 50) {
    this.transientLeft = fail.transientTimes ?? 0;
    this.versionTransientLeft = fail.versionTransient ?? 0;
  }
  private err(message: string, code = "P0001") {
    return { data: null, error: { message, code } };
  }
  private ok(data: unknown) {
    return { data, error: null };
  }
  private live(a: Record<string, unknown>) {
    const b = this.batch;
    if (!b || a.p_batch !== b.id) throw new Error(`reporting batch ${String(a.p_batch)} not found`);
    if (a.p_fence !== b.fence) throw new Error(`reporting batch ${b.id} fence ${String(a.p_fence)} is obsolete (current ${b.fence})`);
    if (b.leaseUntil <= this.clock) throw new Error(`reporting batch ${b.id} lease expired`);
    return b;
  }
  async rpc(fn: string, args: Record<string, unknown>) {
    this.clock += this.tick;
    this.calls.push({ fn, args, at: this.clock });
    if (this.fail.transientAt === fn && this.transientLeft > 0) {
      this.transientLeft--;
      return this.err("canceling statement due to statement timeout", "57014");
    }
    try {
      return this.handle(fn, args);
    } catch (e) {
      return this.err(e instanceof Error ? e.message : String(e));
    }
  }
  private batchRow(b: Batch) {
    return { batch_id: b.id, lease_fence: b.fence, base_generation_id: null, capture_epoch: 2, rule_version: "item-counting-summary-v1", source_cutoff: b.cutoff, state: b.state };
  }
  private saveWalk(a: Record<string, unknown>): { data: unknown; error: { message: string; code: string } | null } {
    const key = a.p_key as string;
    const seed = a.p_seed as number | null;
    const next = a.p_next_cursor as Record<string, unknown>;
    const expected = a.p_expected_cursor as Record<string, unknown> | null;
    const nk = next.key as { id?: string; phase?: string; seed?: number; walk?: { line?: { id?: string } | null } | null } | undefined;
    if (a.p_key_complete ? "key" in next || next.after !== key : nk?.id !== key) throw new Error("save_reporting_walk: the cursor does not match the key");
    if (!a.p_key_complete && nk?.phase === "children" && seed !== null) throw new Error("save_reporting_walk: the children phase consumes no seed budget");
    if (!a.p_key_complete && nk?.phase === "seeds" && seed !== nk.seed) throw new Error("save_reporting_walk: p_seed must be the cursor's seed");
    const ek = expected?.key as { id?: string; phase?: string; seed?: number } | undefined;
    if (ek && ek.id !== key) throw new Error("save_reporting_walk: the saved cursor is inside another changed key");
    if (a.p_key_complete && seed !== null && (ek?.phase !== "seeds" || ek.seed !== seed)) throw new Error("save_reporting_walk: a completing checkpoint carries only the seed it was on");
    const ids = a.p_seen as string[];
    if (ids.length && seed === null) throw new Error("consumed ids need their seed");
    const r = this.handle("save_reporting_enumeration", { ...a, p_complete: false });
    if (r.error && r.error.code !== "08006") return r;
    let n: number | null = null;
    if (seed !== null) {
      const s = this.seen.get(`${key}|${seed}`) ?? this.seen.set(`${key}|${seed}`, new Set()).get(`${key}|${seed}`)!;
      for (const id of ids) s.add(id);
      n = s.size;
      const img = a.p_line_image as { id: string } | null;
      if (img) {
        if (nk?.walk?.line?.id !== img.id) throw new Error("the line image is not the cursor's paged line");
        this.walkLine = { key, seed, line: img.id, image: img };
      }
      if (n > 50_000) throw new Error(`partition_too_large: successor seed ${seed} consumed ${n} distinct dependency ids`);
    }
    if (a.p_key_complete) {
      for (const k of [...this.seen.keys()]) if (k.startsWith(`${key}|`)) this.seen.delete(k);
      this.walkLine = null;
    }
    if (r.error) return r; // committed, response lost
    return this.ok([{ ...(r.data as Array<Record<string, unknown>>)[0], seen_count: n }]);
  }
  private handle(fn: string, a: Record<string, unknown>): { data: unknown; error: { message: string; code: string } | null } {
    switch (fn) {
      case "reporting_owner_input_version": {
        // 0046's protocol probe: installed (version 1 by default), another version, missing, or a code-only transient
        if (this.versionTransientLeft > 0) {
          this.versionTransientLeft--;
          return this.err("retry this transaction", "40001");
        }
        if (this.fail.ownerInputVersion === "missing") return this.err("Could not find the function public.reporting_owner_input_version without parameters in the schema cache", "PGRST202");
        return this.ok([{ version: this.fail.ownerInputVersion ?? 1 }]);
      }
      case "open_reporting_owner_input": {
        const b = this.live(a);
        const found = [...this.journals.values()].find((j) => j.batch === b.id && j.kind === a.p_kind && j.key === a.p_key);
        const j = found ?? this.newJournal(b.id, String(a.p_kind), String(a.p_key), a.p_purpose as "plan" | "stage");
        return this.ok([{ handle: j.handle, created: !found, phase: j.phase, seq: String(j.seq), reload_calls: this.reloadCalls(j, false), provisional_reload_calls: this.reloadCalls(j, true), heavy_proven: false, pending_events: j.pending.size }]);
      }
      case "lookup_reporting_owner_inputs": {
        const b = this.live(a);
        return this.ok((a.p_owners as Array<[string, string]>).map(([k, key], idx) => {
          const j = [...this.journals.values()].find((x) => x.batch === b.id && x.kind === k && x.key === key);
          const o = this.owners.get(`${k}\u0000${key}`);
          return j
            ? { idx, handle: j.handle, phase: j.phase, seq: String(j.seq), purpose: j.purpose, reload_calls: this.reloadCalls(j, false), provisional_reload_calls: this.reloadCalls(j, true), heavy_proven: false, pending_events: j.pending.size, old_staff_count: o?.staff.length ?? 0 }
            : { idx, handle: null, phase: null, seq: null, purpose: null, reload_calls: null, provisional_reload_calls: null, heavy_proven: null, pending_events: null, old_staff_count: o?.staff.length ?? 0 };
        }));
      }
      case "load_reporting_owner_input_header": {
        const j = this.journal(a);
        return this.ok([{ phase: j.phase, purpose: j.purpose, seq: String(j.seq), state: j.state, members_count: j.membersCount, event_count: j.events.size, pending_events: j.pending.size,
          pending_pieces: j.pieces.pending, audiences: j.audiences, hashes_done: j.hashes.length, input_hashes: j.hashes,
          reload_calls: this.reloadCalls(j, false), provisional_reload_calls: this.reloadCalls(j, true), heavy_proven: false }]);
      }
      case "load_reporting_owner_input_events": {
        const j = this.journal(a);
        if (String(a.p_seq) !== String(j.seq)) throw new Error("owner input seq moved: the reload is not pinned");
        const all = this.pieceRows(j.events);
        const after = [Number(a.p_after_ord), Number(a.p_after_piece)];
        const rest = all.filter((r) => r[0] > after[0] || (r[0] === after[0] && r[1] > after[1]));
        if (!rest.length) return this.ok([{ ord: null, piece_no: null, pieces: null, event_id: null, text_bytes: null, text_sha256: null, piece: null, eof: true }]);
        return this.ok(rest.slice(0, LOAD_PAGE).map(([ord, no, piece, meta]) => {
          const m = meta as { event_id: string; pieces: number; text_bytes: number; text_sha256: string } | undefined;
          return { ord, piece_no: no, pieces: m ? m.pieces : null, event_id: m ? m.event_id : null, text_bytes: m ? m.text_bytes : null, text_sha256: m ? m.text_sha256 : null, piece, eof: false };
        }));
      }
      case "checkpoint_reporting_owner_input":
        return this.ok([this.checkpoint(this.journal(a), String(a.p_expected_seq), a.p_payload as Record<string, unknown>)]);
      case "get_reporting_job_status": {
        const b = this.batch && ["active", "frozen", "publishing"].includes(this.batch.state) ? this.batch : null;
        return this.ok([{ site: a.p_site, processor_enabled: !this.fail.processorDisabled, read_mode: "legacy", capture_enabled: true, capture_epoch: 2, source_epoch: 2, active_generation_id: null,
          active_batch_id: b?.id ?? null, active_batch_state: b?.state ?? null, active_batch_kind: b?.kind ?? null, lease_fence: this.fenceSeq, lease_expires_at: b ? new Date(b.leaseUntil).toISOString() : null,
          heartbeat_at: null, last_verified_cutoff: null, pending_changes: 3, oldest_pending_captured_at: null }]);
      }
      case "begin_reporting_batch": {
        this.batch = { id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(this.published.length + 1).padStart(12, "0")}`, site: String(a.p_site), kind: "refresh", state: "frozen", fence: ++this.fenceSeq, leaseUntil: this.clock + 360_000, cutoff: "2026-03-01T00:00:00+00:00", copyPages: 0, copied: 0, sealed: null };
        this.resetWork();
        return this.ok([{ ...this.batchRow(this.batch), change_count: 3, event_count: 3, reused: false }]);
      }
      case "begin_reporting_rebuild": {
        this.batch = { id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(this.published.length + 1).padStart(12, "0")}`, site: String(a.p_site), kind: "rebuild", state: "active", fence: ++this.fenceSeq, leaseUntil: this.clock + 360_000, cutoff: null, copyPages: 3, copied: 0, sealed: null };
        this.resetWork();
        return this.ok([{ ...this.batchRow(this.batch), lease_expires_at: new Date(this.batch.leaseUntil).toISOString() }]);
      }
      case "resume_reporting_batch": {
        const b = this.batch!;
        if (a.p_expected_fence !== b.fence) throw new Error(`reporting batch ${b.id} fence is obsolete`);
        if (b.leaseUntil > this.clock) throw new Error(`reporting batch ${b.id} is busy until ${new Date(b.leaseUntil).toISOString()}`);
        b.fence = ++this.fenceSeq;
        b.leaseUntil = this.clock + 360_000;
        let back = 0;
        for (const w of this.works) if (w.state === "leased") { w.state = "pending"; back++; }
        return this.ok([{ ...this.batchRow(b), lease_expires_at: new Date(b.leaseUntil).toISOString(), returned_work: back, kind: b.kind,
          rebuild_progress: b.kind === "rebuild" ? { afterEventId: b.copied ? `c${b.copied}` : null, complete: b.copied >= b.copyPages, pages: b.copied, rows: b.copied, bytes: b.copied } : null }]);
      }
      case "renew_reporting_lease": {
        const b = this.live(a);
        b.leaseUntil = this.clock + 360_000;
        return this.ok([{ batch_id: b.id, lease_fence: b.fence, lease_expires_at: new Date(b.leaseUntil).toISOString() }]);
      }
      case "copy_reporting_source_page": {
        const b = this.live(a);
        if ((a.p_after_event_id ?? null) !== (b.copied ? `c${b.copied}` : null)) throw new Error("cursor mismatch");
        b.copied++;
        return this.ok([{ rows_copied: 1, bytes_copied: 1, after_event_id: a.p_after_event_id ?? null, next_after_event_id: `c${b.copied}`, page_checksum: "0".repeat(64), complete: b.copied >= b.copyPages, pages: b.copied, total_rows: b.copied, replay: false }]);
      }
      case "freeze_reporting_rebuild": {
        const b = this.live(a);
        b.state = "frozen";
        b.cutoff = "2026-03-01T00:00:00+00:00";
        return this.ok([{ batch_id: b.id, source_cutoff: b.cutoff, change_count: 0, event_count: 0, upserted: 0, deleted: 0, candidate_rows: 0 }]);
      }
      case "read_reporting_worker_progress": {
        const b = this.live(a);
        const p = this.progress;
        return this.ok([{ enum_cursor: p?.cursor ?? null, enum_complete: p?.complete ?? false, owners_discovered: p?.discovered ?? 0, owners_planned: p?.planned ?? 0, descriptors_planned: p?.descriptors ?? 0, sealed: !!b.sealed }]);
      }
      case "save_reporting_enumeration": {
        const b = this.live(a);
        if (b.sealed) throw new Error("sealed");
        this.progress ??= { cursor: null, complete: false, discovered: 0, planned: 0, descriptors: 0 };
        const p = this.progress;
        const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
        const owners = a.p_owners as Array<[string, string, string[]]>;
        if (same(p.cursor, a.p_next_cursor) && p.complete === a.p_complete) {
          for (const [k, key, staff] of owners) {
            const o = this.owners.get(`${k}\u0000${key}`);
            if (!o || !staff.every((s) => o.staff.includes(s))) throw new Error("replay differs");
          }
          return this.ok([{ owners_discovered: p.discovered, enum_cursor: p.cursor, enum_complete: p.complete, replay: true }]);
        }
        if (p.complete) throw new Error("enumeration already complete");
        if (!same(p.cursor, a.p_expected_cursor)) throw new Error("cursor mismatch");
        for (const [k, key, staff] of owners) {
          const id = `${k}\u0000${key}`;
          const o = this.owners.get(id);
          if (o) o.staff = [...new Set([...o.staff, ...staff])].sort();
          else { this.owners.set(id, { kind: k, key, staff: [...staff].sort(), count: null }); p.discovered++; }
        }
        p.cursor = a.p_next_cursor;
        p.complete = a.p_complete as boolean;
        this.saves++;
        const row = { owners_discovered: p.discovered, enum_cursor: p.cursor, enum_complete: p.complete, replay: false };
        if (this.fail.lostSaveResponse === this.saves) return this.err("socket hang up", "08006"); // committed, response lost
        return this.ok([row]);
      }
      case "save_reporting_walk": {
        // ONE transaction, like the SQL: any failure restores cursor, owners, counters and scratch state together.
        const snap = { progress: this.progress && { ...this.progress }, owners: new Map([...this.owners].map(([k, v]) => [k, { ...v, staff: [...v.staff] }])), seen: new Map([...this.seen].map(([k, v]) => [k, new Set(v)])), walkLine: this.walkLine, saves: this.saves };
        try {
          return this.saveWalk(a);
        } catch (err) {
          Object.assign(this, snap);
          throw err;
        }
      }
      case "read_reporting_walk_line": {
        this.live(a);
        const w = this.walkLine;
        return this.ok(w && w.key === a.p_key && w.seed === a.p_seed && w.line === a.p_line ? [{ image: w.image }] : []);
      }
      case "list_reporting_worker_owners": {
        this.live(a);
        const after = a.p_after_kind === null ? null : `${String(a.p_after_kind)}\u0000${String(a.p_after_key)}`;
        const rows = [...this.owners.entries()].filter(([id, o]) => (!a.p_unplanned_only || o.count === null) && (after === null || compareUtf8(id, after) > 0)).sort((x, y) => compareUtf8(x[0], y[0])).slice(0, Number(a.p_limit));
        return this.ok(rows.map(([, o]) => ({ partition_kind: o.kind, partition_key: o.key, old_staff: o.staff, descriptor_count: o.count })));
      }
      case "plan_reporting_owner": {
        const b = this.live(a);
        if (b.sealed || !this.progress?.complete) throw new Error("not plannable");
        const o = this.owners.get(`${String(a.p_kind)}\u0000${String(a.p_key)}`);
        if (!o) throw new Error("not discovered");
        const items = a.p_items as WorkDescriptor[];
        if (items.filter((d) => d.audienceKind === "site").length !== 1) throw new Error("exactly one site descriptor is required");
        if (!o.staff.every((s) => items.some((d) => d.audienceStaff === s))) throw new Error("an old self audience has no descriptor");
        for (const d of items) {
          const ex = this.works.find((w) => w.desc.audienceKind === d.audienceKind && w.desc.audienceStaff === d.audienceStaff && w.desc.partitionKind === d.partitionKind && w.desc.partitionKey === d.partitionKey);
          if (ex && ex.desc.inputHash !== d.inputHash) throw new Error("conflicting descriptor");
          if (!ex) this.works.push({ workId: String(this.works.length + 1), desc: d, state: "pending", chunks: new Map(), chunkCount: null });
        }
        if (o.count !== null) return this.ok([{ descriptor_count: o.count, replay: true }]);
        o.count = items.length;
        this.progress.planned++;
        this.progress.descriptors += items.length;
        if (this.fail.extraWork) this.works.push({ workId: String(this.works.length + 1), desc: { ...items[0], partitionKey: "ORPHAN" }, state: "pending", chunks: new Map(), chunkCount: null });
        return this.ok([{ descriptor_count: items.length, replay: false }]);
      }
      case "verify_reporting_plan": {
        this.live(a);
        const p = this.progress!;
        if (!p.complete) throw new Error("verify_reporting_plan: enumeration of batch is not complete");
        if ([...this.owners.values()].some((o) => o.count === null)) throw new Error("verify_reporting_plan: owners are not planned");
        for (const o of this.owners.values()) if (this.works.filter((w) => w.desc.partitionKind === o.kind && w.desc.partitionKey === o.key).length !== o.count) throw new Error("verify_reporting_plan: missing work");
        if (this.works.some((w) => !this.owners.has(`${w.desc.partitionKind}\u0000${w.desc.partitionKey}`))) throw new Error("verify_reporting_plan: 1 owners have missing, extra or orphan work");
        return this.ok([{ owners: this.owners.size, descriptors: this.works.length + (this.fail.verifyCountOff ? 1 : 0) }]);
      }
      case "list_reporting_work_descriptors": {
        this.live(a);
        const after = a.p_after as string[] | null;
        const key = (d: WorkDescriptor) => [d.audienceKind, d.audienceStaff ?? "", d.partitionKind, d.partitionKey];
        const cmp = (x: string[], y: string[]) => x.map((v, i) => compareUtf8(v, y[i])).find((c) => c !== 0) ?? 0;
        const rows = sortDescriptors(this.works.map((w) => w.desc)).filter((d) => after === null || cmp(key(d), after) > 0).slice(0, Number(a.p_limit));
        return this.ok(rows.map((d) => ({ audience_kind: d.audienceKind, audience_staff: d.audienceStaff, partition_kind: d.partitionKind, partition_key: d.partitionKey, input_hash: d.inputHash })));
      }
      case "seal_reporting_work": {
        const b = this.live(a);
        const hash = reportingManifestHash(this.works.map((w) => w.desc));
        if (a.p_expected_count !== this.works.length) throw new Error("seal_reporting_work: count");
        if (a.p_manifest_hash !== hash) throw new Error("seal_reporting_work: manifest hash mismatch");
        const replay = !!b.sealed;
        b.sealed = { count: this.works.length, hash };
        return this.ok([{ batch_id: b.id, work_count: this.works.length, manifest_hash: hash, sealed_at: new Date(this.clock).toISOString(), replay }]);
      }
      case "claim_reporting_work": {
        const b = this.live(a);
        if (!b.sealed) throw new Error("not sealed");
        const picked = this.works.filter((w) => w.state === "pending").slice(0, Number(a.p_limit));
        for (const w of picked) w.state = "leased";
        return this.ok(picked.map((w) => ({ work_id: w.workId, audience_kind: w.desc.audienceKind, audience_staff: w.desc.audienceStaff, partition_kind: w.desc.partitionKind, partition_key: w.desc.partitionKey, input_hash: this.fail.tamperClaim ? "f".repeat(64) : w.desc.inputHash, expected_chunk_count: w.chunkCount, staged_chunks: w.chunks.size })));
      }
      case "stage_reporting_results": {
        this.live(a);
        const out = (a.p_results as Array<{ partition: string; chunk: { chunkNo: number; chunkCount: number; canonicalRows: string } }>).map((e) => {
          const w = this.works.find((x) => x.workId === e.partition)!;
          if (w.state !== "leased" && w.state !== "done") throw new Error("not leased");
          const prior = w.chunks.get(e.chunk.chunkNo);
          if (prior !== undefined && prior !== e.chunk.canonicalRows) throw new Error("conflicting chunk");
          w.chunks.set(e.chunk.chunkNo, e.chunk.canonicalRows);
          w.chunkCount = e.chunk.chunkCount;
          if (w.chunks.size === w.chunkCount) w.state = "done";
          return { work_id: w.workId, chunk_no: e.chunk.chunkNo, stored: prior === undefined, done: w.state === "done" };
        });
        return this.ok(out);
      }
      case "publish_reporting_batch": {
        const b = this.live(a);
        if (this.fail.publishFails) throw new Error("publish: batch is incomplete: injected");
        if (!b.sealed || this.works.some((w) => w.state !== "done")) throw new Error("publish: batch is incomplete");
        b.state = "published";
        const generation = `cccccccc-cccc-4ccc-8ccc-${String(this.published.length + 1).padStart(12, "0")}`;
        this.published.push({ batch: b.id, generation, works: this.works });
        return this.ok([{ batch_id: b.id, generation_id: generation, generation_seq: String(this.published.length), site: b.site, kind: b.kind, source_cutoff: "2026-03-01T00:00:00+00:00", work_count: this.works.length, receipts: 3, acknowledged: 3, replay: false }]);
      }
      case "record_reporting_run":
        if (this.fail.recordFails) throw new Error("run log unavailable");
        this.runs.push(a);
        return this.ok([{ run_id: this.runs.length }]);
      case "cleanup_reporting_history":
        return this.ok([{ expired_generations: 1, deleted_versions: 10, deleted_runs: 2, deleted_worker_rows: 3, more: --this.cleanupPasses > 0 }]);
      case "set_reporting_capture":
        return this.ok([{ capture_epoch: 3, capture_enabled: a.p_enabled }]);
      case "set_reporting_site_mode":
        return this.ok([{ site: a.p_site, read_mode: a.p_read_mode ?? "legacy", processor_enabled: a.p_processor_enabled ?? true, active_generation_id: null }]);
      case "abandon_reporting_batch":
        return this.ok([{ batch_id: a.p_batch, state: "abandoned", failure_kind: `abandoned: ${String(a.p_reason)}` }]);
      default:
        throw new Error(`unexpected rpc ${fn}`);
    }
  }
  private newJournal(batch: string, kind: string, key: string, purpose: "plan" | "stage"): Journal {
    const j: Journal = { handle: String(this.journals.size + 1), batch, kind, key, purpose, phase: "reading", seq: 0n, state: { v: 1, step: "members", m: { afterOrd: null } }, membersCount: null, events: new Map(), pending: new Map(), audiences: null, hashes: [], last: null, pieces: { committed: 0, pending: 0 } };
    this.journals.set(j.handle, j);
    return j;
  }
  private journal(a: Record<string, unknown>): Journal {
    const b = this.live(a);
    const j = this.journals.get(String(a.p_handle));
    if (!j || j.batch !== b.id) throw new Error("owner input not found");
    return j;
  }
  /** Committed (or committed + pending) pieces as [ord, piece_no, piece, meta?], in (ord, piece_no) order. */
  private pieceRows(...maps: Array<Map<number, unknown[][]>>): Array<[number, number, string, unknown]> {
    const out: Array<[number, number, string, unknown]> = [];
    for (const m of maps) for (const [ord, ps] of m) for (const e of ps) out.push([ord, e[1] as number, e[2] as string, e[3]]);
    return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  }
  /** header + every load page + the lone eof call, as the loader will spend them. */
  private reloadCalls(j: Journal, provisional: boolean): number {
    const n = j.pieces.committed + (provisional ? j.pieces.pending : 0);
    return 1 + Math.ceil(n / LOAD_PAGE) + 1;
  }
  private checkpoint(j: Journal, expected: string, payload: Record<string, unknown>): Record<string, unknown> {
    const body = JSON.stringify(payload);
    // a lost response retried identically is a replay of the stored result
    if (j.last && j.last.expected === expected && j.last.payload === body && BigInt(expected) + 1n === j.seq) return { ...j.last.result, replay: true };
    if (BigInt(expected) !== j.seq) throw new Error(`owner_input_conflict: expected seq ${expected}, current ${j.seq}`);
    // 0046: after the identical-replay check, every NEW write to a complete journal is refused
    if (j.phase === "complete") throw new Error("owner_input_conflict: the owner input is complete");
    // all or nothing, like the SQL statement: a rejected checkpoint restores every field it touched
    const saved = { events: new Map(j.events), pending: new Map([...j.pending].map(([k, v]) => [k, [...v]])), state: j.state, membersCount: j.membersCount, audiences: j.audiences, hashes: [...j.hashes], phase: j.phase, pieces: { ...j.pieces } };
    try {
      return this.applyCheckpoint(j, expected, payload, body);
    } catch (e) {
      Object.assign(j, saved);
      throw e;
    }
  }
  private applyCheckpoint(j: Journal, expected: string, payload: Record<string, unknown>, body: string): Record<string, unknown> {
    const take = (pieces: unknown[][]) => {
      for (const e of pieces) {
        const ord = e[0] as number;
        if (j.events.has(ord)) throw new Error(`owner_input_conflict: ordinal ${ord} is committed`);
        (j.pending.get(ord) ?? j.pending.set(ord, []).get(ord)!).push(e);
        j.pieces.pending++;
      }
    };
    switch (payload.kind) {
      case "pieces":
        if (j.phase !== "reading") throw new Error("pieces outside reading");
        take(payload.pieces as unknown[][]);
        break;
      case "page": {
        if (j.phase !== "reading") throw new Error("a page outside reading");
        const steps = payload.steps as unknown[];
        if (!Array.isArray(steps) || !steps.length) throw new Error("a page needs a step"); // validated before any insert
        take(payload.pieces as unknown[][]);
        const ords = [...j.pending.keys()].sort((x, y) => x - y);
        ords.forEach((o, i) => {
          if (o !== j.events.size + 1 + i) throw new Error("owner_input_conflict: ordinals are not contiguous");
        });
        for (const o of ords) j.events.set(o, j.pending.get(o)!);
        j.pending.clear();
        j.pieces.committed += j.pieces.pending;
        j.pieces.pending = 0;
        j.state = steps[steps.length - 1];
        if (payload.members_count !== undefined) j.membersCount = payload.members_count as number;
        break;
      }
      case "discard_pending":
        j.pending.clear();
        j.pieces.pending = 0;
        break;
      case "hash": {
        if (j.phase === "reading") {
          if ((j.state as { step?: string }).step !== "done" || j.pending.size) throw new Error("hashing needs a finished read");
          j.audiences = payload.audiences as unknown[];
          j.phase = "hashing";
        } else if (j.phase !== "hashing") throw new Error("the journal is complete");
        j.hashes.push(...(payload.hashes as unknown[]));
        if (j.hashes.length === j.audiences!.length) j.phase = "complete";
        break;
      }
      default:
        throw new Error("unknown checkpoint kind");
    }
    j.seq++;
    const result = { seq: String(j.seq), event_count: j.events.size, pending_events: j.pending.size, pending_pieces: j.pieces.pending, reload_calls: this.reloadCalls(j, false), provisional_reload_calls: this.reloadCalls(j, true), heavy: false, replay: false };
    j.last = { expected, payload: body, result };
    return result;
  }
  /** Journal RPCs (everything but the version probe), with each handle they named. */
  journalCalls(): Array<{ fn: string; handle: string | null }> {
    const J = ["open_reporting_owner_input", "lookup_reporting_owner_inputs", "load_reporting_owner_input_header", "load_reporting_owner_input_events", "checkpoint_reporting_owner_input", "read_reporting_owner_old_staff"];
    return this.calls.filter((c) => J.includes(c.fn)).map((c) => ({ fn: c.fn, handle: c.args.p_handle === undefined ? null : String(c.args.p_handle) }));
  }
  private resetWork() {
    this.progress = null;
    this.owners.clear();
    this.works = [];
  }
  /** The published (descriptor, rows) pairs of the last generation, in manifest order. */
  lastPublished(): Array<{ desc: WorkDescriptor; rows: string }> {
    const g = this.published.at(-1)!;
    return sortDescriptors(g.works.map((w) => w.desc)).map((d) => {
      const w = g.works.find((x) => x.desc === d)!;
      return { desc: d, rows: [...w.chunks.entries()].sort((x, y) => x[0] - y[0]).map(([, r]) => r).join("|") };
    });
  }
}

/** Frozen reads from memory with real paging (the enumeration pages honour the cursor). */
function memorySource(view: Ev[], changed: ChangedKey[], counters: { keyPages: Array<string | null>; ownerPages: Array<string | null> }, pageSize = 37, clock?: { db: FakeDb; perRead: number }, fail?: { method: string; nth: number; seen?: number }) {
  return (ref: FrozenBatchRef): { reader: ReturnType<typeof memoryFrozenReader> & { pages: FrozenReaderPages }; pages: EnumerationPages } => {
    const inner = memoryFrozenReader({ site: ref.site, cutoff: ref.cutoff, kind: ref.kind, view, changed });
    const tick = () => void (clock && (clock.db.clock += clock.perRead));
    /** A transient on the nth call of `fail.method` (counted across invocations), thrown before the read. */
    const maybeFail = (method: string) => {
      if (!fail || fail.method !== method) return;
      fail.seen = (fail.seen ?? 0) + 1;
      if (fail.seen === fail.nth) throw new Error("fetch failed (injected)");
    };
    // T15P-4d: one-call pages over the same view (keyset order exactly as the 0044 adapter validates it)
    const byOwner = new Map<string, Ev[]>();
    const byParent = new Map<string, Ev[]>();
    for (const e of view) {
      const k = ownerKey(ownerOfEvent(e));
      (byOwner.get(k) ?? byOwner.set(k, []).get(k)!).push(e);
      if (e.parent_event_id !== null) (byParent.get(e.parent_event_id) ?? byParent.set(e.parent_event_id, []).get(e.parent_event_id)!).push(e);
    }
    for (const l of [...byOwner.values(), ...byParent.values()]) l.sort((x, y) => compareUtf8(x.id, y.id));
    const byId = new Map(view.map((e) => [e.id, e]));
    const pages: FrozenReaderPages = {
      async membersPage(owners, after, limit = 1000) {
        tick();
        maybeFail("membersPage");
        const rows = owners.flatMap((o, i) => (byOwner.get(ownerKey(o)) ?? []).map((ev) => ({ ownerIndex: i, ev })))
          .filter((r) => after === null || r.ownerIndex > after.index || (r.ownerIndex === after.index && after.id !== null && compareUtf8(r.ev.id, after.id) > 0)).slice(0, limit);
        const last = rows.at(-1);
        return { rows, next: last ? { index: last.ownerIndex, id: last.ev.id } : null, empty: !rows.length };
      },
      async byIdsPage(ids) {
        tick();
        maybeFail("byIdsPage");
        const rows = ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
        return { rows, pending: [], empty: !rows.length };
      },
      async childrenPage(parentIds, after, limit = 1000) {
        tick();
        maybeFail("childrenPage");
        const rows = parentIds.flatMap((p) => byParent.get(p) ?? [])
          .filter((e) => after === null || compareUtf8(e.parent_event_id!, after.parent) > 0 || (e.parent_event_id === after.parent && compareUtf8(e.id, after.id) > 0)).slice(0, limit);
        const last = rows.at(-1);
        return { rows, next: last ? { parent: last.parent_event_id!, id: last.id } : null, empty: !rows.length };
      },
    };
    const reader: typeof inner & { pages: FrozenReaderPages } = { ...inner, pages, members: (o, c) => (tick(), inner.members(o, c)), byIds: (ids) => (tick(), inner.byIds(ids)), children: (p) => (tick(), inner.children(p)), stream: (s, d, f, l) => (tick(), inner.stream(s, d, f, l)), childPage: async (p, a, l) => (tick(), maybeFail("childPage"), inner.childPage(p, a, l)) };
    const owners = [...new Map(view.map((e) => [ownerKey(ownerOfEvent(e)), ownerOfEvent(e)])).values()].sort((x, y) => compareUtf8(ownerKey(x), ownerKey(y)));
    return {
      reader,
      pages: {
        async changedKeyPage(after) {
          counters.keyPages.push(after);
          return changed.filter((k) => after === null || compareUtf8(k.id, after) > 0).slice(0, pageSize);
        },
        async ownerPage(after) {
          counters.ownerPages.push(after ? ownerKey(after) : null);
          return owners.filter((o) => after === null || compareUtf8(ownerKey(o), ownerKey(after)) > 0).slice(0, pageSize);
        },
      },
    };
  };
}

/** The whole-batch reference (tests only): every descriptor with its staged chunk text. */
async function reference(kind: "refresh" | "rebuild", view: Ev[], changed: ChangedKey[]) {
  const { works } = await materializeBatch(memoryFrozenReader({ site: "uk", cutoff: "2026-03-01T00:00:00.000000Z", kind, view, changed }));
  const { buildChunks } = await import("../../api/_lib/reporting-stage");
  return sortDescriptors(works.map((w) => w.desc)).map((d) => ({ desc: d, rows: buildChunks(works.find((w) => w.desc === d)!.rows).map((c) => c.canonicalRows).join("|") }));
}

function env(db: FakeDb, source: WorkerEnv["source"]): WorkerEnv & { slept: number[] } {
  const slept: number[] = [];
  return { client: db, now: () => db.clock, sleep: async (ms) => void (slept.push(ms), (db.clock += ms)), source, slept };
}

// ---------------------------------------------------------------------------
// Worker: complete cycles and parity with the whole-batch reference
// ---------------------------------------------------------------------------

describe("Task 15 worker: complete refresh and rebuild cycles", () => {
  const base = baseView(80);
  const { after, changed } = refreshChange(base);
  it("a refresh enumerates changed keys durably, plans every owner, seals with the exact proof and publishes the SAME work as the whole-batch path", async () => {
    const db = new FakeDb("refresh");
    const counters = { keyPages: [] as Array<string | null>, ownerPages: [] as Array<string | null> };
    const r = await runReportingCycle(env(db, memorySource(after, changed, counters)), { site: "uk", mode: "refresh" });
    expect(r.state).toBe("published");
    expect(r.problems).toEqual([]);
    expect(db.lastPublished()).toEqual(await reference("refresh", after, changed));
    expect(r.counts.changedKeys).toBe(changed.length);
    expect(db.progress!.complete).toBe(true);
    expect(db.saves).toBeGreaterThanOrEqual(changed.length); // every key completes with its own checkpoint (no whole-batch save)
    expect(db.seen.size).toBe(0); // completed keys leave no scratch state
    expect(db.runs.at(-1)).toMatchObject({ p_outcome: "published", p_mode: "refresh", p_failure_kind: null });
  });
  it("a rebuild copies, freezes, enumerates owner keysets in pages and publishes the same work as the whole-batch path", async () => {
    const db = new FakeDb("rebuild");
    const counters = { keyPages: [] as Array<string | null>, ownerPages: [] as Array<string | null> };
    const r = await runReportingCycle(env(db, memorySource(base, [], counters)), { site: "uk", mode: "rebuild" });
    expect(r.state).toBe("published");
    expect(r.counts.copiedPages).toBe(3);
    expect(db.lastPublished()).toEqual(await reference("rebuild", base, []));
    expect(counters.ownerPages.length).toBeGreaterThan(1);
  });
  it("a no-change refresh still seals zero work and publishes (verified freshness advances only through the complete check)", async () => {
    const db = new FakeDb("refresh");
    const r = await runReportingCycle(env(db, memorySource(base, [], { keyPages: [], ownerPages: [] })), { site: "uk", mode: "refresh" });
    expect(r).toMatchObject({ state: "published", counts: expect.objectContaining({ sealedWork: 0 }) });
  });
  it("the worker never uses the whole-batch arrays (materializeBatch / affectedOwners) as its resume mechanism", () => {
    const src = read("api/_lib/production-reporting-worker.ts");
    const code = src.slice(src.indexOf("import "));
    expect(code).not.toMatch(/\bmaterializeBatch\b|\baffectedOwners\b/);
  });
});

describe("Task 15 worker: durable resume, fences and recovery", () => {
  const base = baseView(80);
  const { after, changed } = refreshChange(base);
  it("stops at its budget mid-enumeration, then a later invocation takes over (new fence) and continues from the SAVED cursor, never from zero", async () => {
    const db = new FakeDb("refresh", {}, 400);
    const counters = { keyPages: [] as Array<string | null>, ownerPages: [] as Array<string | null> };
    const first = await runReportingCycle(env(db, memorySource(after, changed, counters)), { site: "uk", mode: "refresh", deadlineMs: 12_000 });
    expect(first.state).toBe("pending");
    const saved = db.progress!.cursor as { after: string };
    expect(db.progress!.complete).toBe(false);
    expect(saved.after).not.toBeNull();
    const fence1 = db.batch!.fence;
    // a duplicate invocation while the lease is live is busy and does nothing
    const busy = await runReportingCycle(env(db, memorySource(after, changed, counters)), { site: "uk", mode: "refresh" });
    expect(busy.state).toBe("busy");
    db.clock += 400_000; // the lease expired
    counters.keyPages.length = 0;
    // Each later invocation resumes from the cursor the previous one saved (never from zero), until publication.
    let resumeFrom = saved.after;
    let second: CycleResult | null = null;
    for (let run = 0; run < 10 && second?.state !== "published"; run++) {
      counters.keyPages.length = 0;
      second = await runReportingCycle(env(db, memorySource(after, changed, counters)), { site: "uk", mode: "refresh" });
      if (counters.keyPages.length) expect(counters.keyPages[0]).toBe(resumeFrom); // resumed from the checkpoint
      expect(counters.keyPages).not.toContain(null);
      resumeFrom = (db.progress!.cursor as { after: string }).after;
      db.clock += 400_000;
    }
    expect(second!.state).toBe("published");
    expect(db.batch!.fence).toBeGreaterThan(fence1);
    expect(db.lastPublished()).toEqual(await reference("refresh", after, changed));
  });
  it("the deadline is enforced INSIDE a page of changed keys: the checkpoint is the last processed key, not the page end", async () => {
    const db = new FakeDb("refresh", {}, 10);
    const counters = { keyPages: [] as Array<string | null>, ownerPages: [] as Array<string | null> };
    const r = await runReportingCycle(env(db, memorySource(after, changed, counters, 200, { db, perRead: 50 })), { site: "uk", mode: "refresh", deadlineMs: 1_500 });
    expect(r.state).toBe("pending");
    expect(r.counts.changedKeys).toBeGreaterThan(0);
    expect(r.counts.changedKeys).toBeLessThan(changed.length);
    expect((db.progress!.cursor as { after: string }).after).toBe(changed[r.counts.changedKeys - 1].id);
  });
  it("a rebuild resumes its owner enumeration from the SAVED owner keyset", async () => {
    const db = new FakeDb("rebuild", {}, 300);
    const counters = { keyPages: [] as Array<string | null>, ownerPages: [] as Array<string | null> };
    const r1 = await runReportingCycle(env(db, memorySource(baseView(80), [], counters, 10)), { site: "uk", mode: "rebuild", deadlineMs: 2_500 });
    expect(r1.state).toBe("pending");
    const saved = (db.progress?.cursor as { after: [string, string] } | undefined)?.after;
    expect(saved).toBeTruthy();
    expect(db.progress!.complete).toBe(false);
    db.clock += 400_000;
    counters.ownerPages.length = 0;
    const r2 = await runReportingCycle(env(db, memorySource(baseView(80), [], counters, 10)), { site: "uk", mode: "rebuild" });
    expect(r2.state).toBe("published");
    expect(counters.ownerPages[0]).toBe(`${saved![0]}\u0000${saved![1]}`);
    expect(db.lastPublished()).toEqual(await reference("rebuild", baseView(80), []));
  });
  it("the seal refuses when the saved-descriptor traversal and the plan proof disagree", async () => {
    const db = new FakeDb("refresh", { verifyCountOff: true });
    const r = await runReportingCycle(env(db, memorySource(after, changed, { keyPages: [], ownerPages: [] })), { site: "uk", mode: "refresh" });
    expect(r.state).toBe("failed");
    expect(r.problems.join()).toMatch(/the plan proof has/);
    expect(db.batch!.sealed).toBeNull();
  });
  it("an old self audience whose owner lost every member of that worker is still planned (empty replacement)", async () => {
    const db = new FakeDb("refresh");
    await runReportingCycle(env(db, memorySource(after, changed, { keyPages: [], ownerPages: [] })), { site: "uk", mode: "refresh" });
    const solo = db.lastPublished().filter((w) => w.desc.partitionKey === "O-SOLO");
    expect(solo.map((w) => [w.desc.audienceKind, w.desc.audienceStaff])).toEqual([["self", W2], ["site", null]]);
  });
  it("a checkpoint whose response was lost is replayed as a no-op (no lost or doubled owner)", async () => {
    const db = new FakeDb("refresh", { lostSaveResponse: 2 });
    const e = env(db, memorySource(after, changed, { keyPages: [], ownerPages: [] }));
    const r = await runReportingCycle(e, { site: "uk", mode: "refresh" });
    expect(r.state).toBe("published");
    expect(e.slept).toEqual([30_000]); // one bounded retry of the transient failure
    expect(db.lastPublished()).toEqual(await reference("refresh", after, changed));
    expect(db.progress!.discovered).toBe(db.owners.size);
  });
  it("claimed-but-unstaged work at the deadline returns to pending on takeover and is staged exactly once", async () => {
    const db = new FakeDb("refresh", {}, 2_000);
    const src = memorySource(after, changed, { keyPages: [], ownerPages: [] });
    const r1 = await runReportingCycle(env(db, src), { site: "uk", mode: "refresh", deadlineMs: 60_000 });
    expect(r1.state).toBe("pending");
    let takeovers = 0;
    for (let i = 0; i < 60 && db.batch!.state !== "published"; i++, takeovers++) {
      db.clock += 400_000;
      await runReportingCycle(env(db, src), { site: "uk", mode: "refresh", deadlineMs: 60_000 });
    }
    expect(db.batch!.state).toBe("published");
    expect(takeovers).toBeGreaterThan(1);
    // heartbeat: within every invocation the lease is renewed at least every 30 s of work (plus one bounded unit)
    const marks = db.calls.filter((c) => ["resume_reporting_batch", "begin_reporting_batch", "renew_reporting_lease"].includes(c.fn)).map((c) => c.at);
    const spans = db.calls.filter((c) => c.at >= marks[0] && c.fn !== "get_reporting_job_status" && c.fn !== "reporting_owner_input_version").map((c) => c.at - Math.max(...marks.filter((m) => m <= c.at)));
    expect(Math.max(...spans)).toBeLessThanOrEqual(30_000 + 10 * 2_000);
    expect(db.calls.filter((c) => c.fn === "renew_reporting_lease").length).toBeGreaterThan(0);
    expect(db.calls.some((c) => c.fn === "resume_reporting_batch")).toBe(true);
    expect(db.lastPublished()).toEqual(await reference("refresh", after, changed));
  });
  it("a claimed work whose saved input hash differs from the frozen re-materialization fails as conflicting_work (nothing staged)", async () => {
    const db = new FakeDb("refresh", { tamperClaim: true });
    const r = await runReportingCycle(env(db, memorySource(after, changed, { keyPages: [], ownerPages: [] })), { site: "uk", mode: "refresh" });
    expect(r).toMatchObject({ state: "failed", failureKind: "conflicting_work" });
    expect(db.calls.some((c) => c.fn === "stage_reporting_results")).toBe(false);
  });
  it("a stale fence is refused (a takeover happened): the old worker's mutation fails visibly", async () => {
    const db = new FakeDb("refresh");
    await db.rpc("begin_reporting_batch", { p_site: "uk" });
    const old = db.batch!.fence;
    db.clock += 400_000;
    await db.rpc("resume_reporting_batch", { p_batch: db.batch!.id, p_expected_fence: old });
    const r = await db.rpc("save_reporting_enumeration", { p_batch: db.batch!.id, p_fence: old, p_expected_cursor: null, p_next_cursor: { kind: "refresh", after: "x" }, p_owners: [], p_complete: false });
    expect(r.error?.message).toMatch(/fence .* is obsolete/);
  });
  it("seal refuses when saved work disagrees with the per-owner proof (orphan work); the batch stays failed and inspectable, not abandoned", async () => {
    const db = new FakeDb("refresh", { extraWork: true });
    const r = await runReportingCycle(env(db, memorySource(after, changed, { keyPages: [], ownerPages: [] })), { site: "uk", mode: "refresh" });
    expect(r.state).toBe("failed");
    expect(r.problems.join()).toMatch(/orphan work/);
    expect(db.batch!.state).toBe("frozen");
    expect(db.batch!.sealed).toBeNull();
    expect(db.calls.some((c) => c.fn === "abandon_reporting_batch")).toBe(false);
  });
  it("a transient failure is retried after 30/60/120 s within the budget; beyond it the cycle is deferred (pending), never slept past the deadline", async () => {
    const db = new FakeDb("refresh", { transientAt: "verify_reporting_plan", transientTimes: 2 });
    const e = env(db, memorySource(after, changed, { keyPages: [], ownerPages: [] }));
    expect((await runReportingCycle(e, { site: "uk", mode: "refresh" })).state).toBe("published");
    expect(e.slept).toEqual([30_000, 60_000]);
    const db2 = new FakeDb("refresh", { transientAt: "verify_reporting_plan", transientTimes: 9 });
    const e2 = env(db2, memorySource(after, changed, { keyPages: [], ownerPages: [] }));
    const r2 = await runReportingCycle(e2, { site: "uk", mode: "refresh", deadlineMs: 80_000 });
    expect(r2.state).toBe("pending");
    expect(r2.problems.join()).toMatch(/^deferred: /);
    expect(e2.slept).toEqual([30_000]); // the 60 s retry would cross the deadline: deferred instead of sleeping past it
  });
  it("partition_too_large is a permanent, visible failure kind (no truncation, nothing published)", async () => {
    const big: Ev[] = Array.from({ length: 50_001 }, (_, i) => ev(`b${String(i).padStart(5, "0")}`, { order_number: "BIG", created_at: "2026-02-10T08:00:00+00:00", line_sku: null, line_quantity: null, event_type: "completed" }));
    const db = new FakeDb("rebuild");
    const r = await runReportingCycle(env(db, memorySource(big, [], { keyPages: [], ownerPages: [] }, 1000)), { site: "uk", mode: "rebuild" });
    expect(r).toMatchObject({ state: "failed", failureKind: "partition_too_large" });
    expect(db.published).toHaveLength(0);
    expect(db.runs.at(-1)).toMatchObject({ p_outcome: "failed", p_failure_kind: "partition_too_large" });
  }, 60_000);
  it("a disabled processor does no batch work; a failed run log never masks the result", async () => {
    const db = new FakeDb("refresh", { processorDisabled: true });
    const r = await runReportingCycle(env(db, memorySource(after, changed, { keyPages: [], ownerPages: [] })), { site: "uk", mode: "refresh" });
    expect(r).toMatchObject({ state: "failed", failureKind: "processor_disabled" });
    expect(db.calls.map((c) => c.fn)).toEqual(["reporting_owner_input_version", "get_reporting_job_status", "record_reporting_run"]); // T15P-4d: version first
    const db2 = new FakeDb("refresh", { recordFails: true });
    const r2 = await runReportingCycle(env(db2, memorySource(after, changed, { keyPages: [], ownerPages: [] })), { site: "uk", mode: "refresh" });
    expect(r2.state).toBe("published");
    expect(r2.problems.join()).toMatch(/run log not recorded/);
  });
  it("cleanup repeats bounded passes until nothing more is eligible", async () => {
    const db = new FakeDb("refresh");
    const r = await runReportingCycle(env(db, undefined), { site: "uk", mode: "cleanup" });
    expect(r).toMatchObject({ state: "done", counts: expect.objectContaining({ expiredGenerations: 2, deletedVersions: 20 }) });
    expect(db.calls.filter((c) => c.fn === "cleanup_reporting_history")).toHaveLength(2);
  });
  it("failure kinds and transient classification", () => {
    expect(isTransient(Object.assign(new Error("x"), { code: "57014" }))).toBe(true);
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    expect(isTransient(new Error("plan_reporting_work: conflicting descriptor"))).toBe(false);
    expect(failureKind(new Error("site uk has no continuous published base at rule r and capture epoch 2; a rebuild is required"))).toBe("rebuild_required");
    expect(failureKind(new Error("reporting batch x is no longer valid: capture epoch changed"))).toBe("invalidated");
  });
});

describe("T15P-4d step 3: the owner-input protocol is checked FIRST (scope review Must-fix 1 and 3)", () => {
  const base = baseView(80);
  const { after, changed } = refreshChange(base);
  const src = () => memorySource(after, changed, { keyPages: [], ownerPages: [] });
  for (const [label, v] of [["missing", "missing"], ["version 2", 2]] as const) {
    for (const mode of ["refresh", "rebuild"] as const) {
      it(`${label} (${mode}): failed owner_input_unsupported before ANY batch work, and no run record`, async () => {
        const db = new FakeDb(mode, { ownerInputVersion: v });
        let sourced = 0; // the injected source factory: a frozen view is never even created
        const inner = memorySource(mode === "refresh" ? after : base, mode === "refresh" ? changed : [], { keyPages: [], ownerPages: [] });
        const r = await runReportingCycle(env(db, (ref) => (sourced++, inner(ref))), { site: "uk", mode });
        expect(r).toMatchObject({ state: "failed", failureKind: "owner_input_unsupported", batchId: null, generationId: null });
        expect(db.calls.map((c) => c.fn)).toEqual(["reporting_owner_input_version"]); // no status/acquire/source/journal/publish/run record
        expect(sourced).toBe(0);
        expect(db.runs).toEqual([]);
        expect(db.batch).toBeNull();
        expect(r.problems.join()).toMatch(/owner_input_unsupported/);
      });
    }
  }
  it("a code-only transient on the version probe is retried (30 s), then the cycle works normally", async () => {
    const db = new FakeDb("refresh", { versionTransient: 1 });
    const e = env(db, src());
    const r = await runReportingCycle(e, { site: "uk", mode: "refresh" });
    expect(r.state).toBe("published");
    expect(r.failureKind).toBeNull();
    expect(e.slept).toEqual([30_000]);
    expect(db.calls.slice(0, 3).map((c) => c.fn)).toEqual(["reporting_owner_input_version", "reporting_owner_input_version", "get_reporting_job_status"]);
    expect(db.lastPublished()).toEqual(await reference("refresh", after, changed));
  });
  it("an exhausted transient is deferred (pending), never diagnosed as unsupported, and acquires nothing", async () => {
    const db = new FakeDb("refresh", { versionTransient: 9 });
    const e = env(db, src());
    const r = await runReportingCycle(e, { site: "uk", mode: "refresh" });
    expect(r).toMatchObject({ state: "pending", failureKind: null });
    expect(r.problems.join()).toMatch(/^deferred: /);
    expect(r.problems.join()).not.toMatch(/unsupported/);
    expect(e.slept).toEqual([30_000, 60_000, 120_000]);
    expect(db.calls.filter((c) => c.fn !== "reporting_owner_input_version").map((c) => c.fn)).toEqual(["record_reporting_run"]);
    expect(db.batch).toBeNull();
  });
});

describe("T15P-4d step 3: routed planning (light owners never touch a journal; activating owners plan from it)", () => {
  const base = baseView(80);
  /**
   * HEAVY-n: 1,200 members of one order (crosses the 1,000-row trigger on its first member page): three timed lines and
   * 1,197 member "started" events (valid order members that produce no detail rows, so they are cheap to stage:
   * reporting-stage buildChunks re-serialises a chunk per added row, so ~1,200 detail rows cost ~20 s on ANY path,
   * the old whole-batch reference included; recorded for 4e CPU sampling with detail-rich events).
   */
  const heavy = (n: number, staff = W1): Ev[] => Array.from({ length: 1200 }, (_, i) => ev(`h${n}-${String(i).padStart(4, "0")}`, {
    order_number: `HEAVY-${n}`, staff_id: staff, created_at: `2026-02-2${n}T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}+00:00`,
    ...(i < 3 ? {} : { event_type: "started", line_sku: null, line_quantity: null }),
  }));
  const rebuild = async (view: Ev[], ownerGroup?: number) => {
    const db = new FakeDb("rebuild");
    const e = env(db, memorySource(view, [], { keyPages: [], ownerPages: [] }, 37));
    const r = await runReportingCycle({ ...e, ownerGroup }, { site: "uk", mode: "rebuild" });
    return { db, r };
  };

  it("a batch of light owners plans with ZERO journal RPCs and publishes exactly the whole-batch reference", async () => {
    const { db, r } = await rebuild(base);
    expect(r.state).toBe("published");
    expect(db.journalCalls()).toEqual([]);
    expect(db.journals.size).toBe(0);
    expect(r.counts.ownersDurable ?? 0).toBe(0);
    expect(db.lastPublished()).toEqual(await reference("rebuild", base, []));
  });

  it("an owner over the 1,000-row trigger activates: ONE plan journal, journal pages, a hash checkpoint, and the same descriptors as materializeOwnerWorks", async () => {
    const view = [...base, ...heavy(1)];
    const { db, r } = await rebuild(view);
    expect(r.state).toBe("published");
    expect(r.counts.ownersDurable).toBe(1);
    expect(db.journals.size).toBe(1);
    const j = [...db.journals.values()][0];
    expect([j.kind, j.key, j.purpose, j.phase]).toEqual(["order", "HEAVY-1", "plan", "complete"]);
    const calls = db.journalCalls();
    expect(calls.filter((c) => c.fn === "open_reporting_owner_input")).toHaveLength(1);
    expect(calls.filter((c) => c.fn === "lookup_reporting_owner_inputs")).toHaveLength(1);
    const pays = db.calls.filter((c) => c.fn === "checkpoint_reporting_owner_input").map((c) => (c.args.p_payload as { kind: string }).kind);
    expect(pays.filter((k) => k === "page").length).toBeGreaterThan(1);
    expect(pays.filter((k) => k === "hash").length).toBeGreaterThanOrEqual(1);
    expect(pays.at(-1)).toBe("hash");
    // the reload of a fresh journal happens once (at recovery), never again before hashing
    expect(calls.filter((c) => c.fn === "load_reporting_owner_input_events").length).toBe(1);
    // the planned descriptors equal the light path's, and so does the whole published batch
    const o: Owner = { partitionKind: "order", partitionKey: "HEAVY-1" };
    const want = (await materializeOwnerWorks(memoryFrozenReader({ site: "uk", cutoff: "2026-03-01T00:00:00.000000Z", kind: "rebuild", view, changed: [] }), o, [])).map((w) => w.desc);
    expect(sortDescriptors(db.works.filter((w) => w.desc.partitionKey === "HEAVY-1").map((w) => w.desc))).toEqual(sortDescriptors(want));
    expect((j.hashes as Array<{ inputHash: string }>).map((h) => h.inputHash)).toEqual(want.map((d) => d.inputHash));
    expect(db.lastPublished()).toEqual(await reference("rebuild", view, []));
  }, 120_000);

  it("two activating owners in one group never run their durable reads at the same time (ordered turns)", async () => {
    const view = [...base, ...heavy(1), ...heavy(2, W2)];
    const { db, r } = await rebuild(view, 8);
    expect(r.state).toBe("published");
    expect(r.counts.ownersDurable).toBe(2);
    // every journal call of one handle comes before every journal call of the other: no interleaving
    const seq = db.journalCalls().map((c) => c.handle).filter((h): h is string => h !== null);
    const firstOf2 = seq.indexOf("2");
    expect(firstOf2).toBeGreaterThan(0);
    expect(seq.slice(firstOf2)).not.toContain("1");
    expect(db.lastPublished()).toEqual(await reference("rebuild", view, []));
  }, 120_000);

  it("a journal already hashed when planning was deferred is reused as is: no new page, the validated input is not re-read", async () => {
    const view = [...base, ...heavy(1)];
    const db = new FakeDb("rebuild", { transientAt: "plan_reporting_owner", transientTimes: 9 });
    const e = () => env(db, memorySource(view, [], { keyPages: [], ownerPages: [] }, 37));
    const first = await runReportingCycle(e(), { site: "uk", mode: "rebuild" });
    expect(first.state).toBe("pending"); // planning HEAVY-1 was deferred after its journal was complete
    const j = [...db.journals.values()][0];
    expect(j.phase).toBe("complete");
    const before = db.calls.length;
    db.transientLeft = 0;
    db.clock += 400_000;
    const second = await runReportingCycle(e(), { site: "uk", mode: "rebuild" });
    expect(second.state).toBe("published");
    const later = db.calls.slice(before).filter((c) => c.fn === "checkpoint_reporting_owner_input");
    expect(later).toEqual([]); // no page and no hash: the complete journal IS the input
    // exactly ONE recovery reload: its event pages (one piece per event here) plus the lone eof call
    expect(db.calls.slice(before).filter((c) => c.fn === "load_reporting_owner_input_events").length).toBe(Math.ceil(j.events.size / 500) + 1);
    expect(db.journals.size).toBe(1);
    expect(db.lastPublished()).toEqual(await reference("rebuild", view, []));
  }, 120_000);

  it("planning keeps descriptors only: one audience projected at a time, never every audience's rows (review Must-fix 1)", async () => {
    const view = [...base, ...heavy(1)];
    const rd = memoryFrozenReader({ site: "uk", cutoff: "2026-03-01T00:00:00.000000Z", kind: "rebuild", view, changed: [] });
    for (const key of ["HEAVY-1", "O-1", "O-SUCC"]) {
      const o: Owner = { partitionKind: "order", partitionKey: key };
      const input = await buildOwnerInput(rd, o);
      const descs = ownerDescriptors(rd, o, input, [W2]);
      expect(descs).toEqual(ownerWorksFromInput(rd, o, input, [W2]).map((w) => w.desc)); // same identities and hashes, same order
      for (const d of descs) expect(Object.keys(d).sort()).toEqual(["audienceKind", "audienceStaff", "inputHash", "partitionKey", "partitionKind"]); // no rows
    }
    // the worker's routed planning uses the per-audience helper, never the all-audience works
    const src = read("api/_lib/production-reporting-worker.ts");
    const routed = src.slice(src.indexOf("async function routedGroup"), src.indexOf("async function seal("));
    expect(routed).toMatch(/ownerDescriptors\(/);
    expect(routed).not.toMatch(/ownerWorksFromInput|materializeOwnerWorks|\.rows\b/);
  });

  describe("retry keeps the count: one activation watch per owner across transient retries (review Must-fix 2)", () => {
    // ATT (W3): one member line; below it five lines of ATT-P, each cancelled, then one effective line. Its light read
    // (member pages, a 0045-style page, ten shared children pages) needs fewer than 16 attempts; a transient on the 3rd
    // shared children page makes the retried read continue on the SAME counter, so it activates before light attempt 17.
    const W3 = "33333333-3333-4333-8333-333333333333";
    const att: Ev[] = [ev("att-m", { order_number: "ATT", staff_id: W3, created_at: "2026-02-20T10:00:00+00:00" })];
    for (let i = 1; i <= 5; i++) {
      att.push(ev(`att-p${i}`, { order_number: "ATT-P", staff_id: W3, created_at: `2026-02-20T09:0${i}:00+00:00` }));
      att.push(ev(`att-p${i}-x`, { order_number: "ATT-P", staff_id: W2, event_type: "cancelled", parent_event_id: `att-p${i}`, line_sku: null, line_quantity: null, created_at: `2026-02-20T09:3${i}:00+00:00` }));
    }
    att.push(ev("att-z", { order_number: "ATT-Z", staff_id: W3, created_at: "2026-02-20T08:00:00+00:00" }));
    const run = async (fail?: { method: string; nth: number }) => {
      const db = new FakeDb("rebuild");
      const e = env(db, memorySource(att, [], { keyPages: [], ownerPages: [] }, 37, undefined, fail));
      const r = await runReportingCycle({ ...e, ownerGroup: 1 }, { site: "uk", mode: "rebuild" });
      return { db, r, slept: e.slept };
    };
    it("control: without a transient, ATT completes on the light route (no journal)", async () => {
      const { db, r } = await run();
      expect(r.state).toBe("published");
      expect(r.counts.ownersActivated ?? 0).toBe(0);
      expect(db.journals.size).toBe(0);
      expect(db.lastPublished()).toEqual(await reference("rebuild", att, []));
    });
    it("a transient during ATT's light read: the same backoff, then the retry continues the SAME count and activates at exactly 16", async () => {
      const { db, r, slept } = await run({ method: "childrenPage", nth: 3 });
      expect(r.state).toBe("published");
      expect(slept).toEqual([30_000]); // the unchanged bounded backoff
      expect(r.counts.ownersActivated).toBe(1);
      expect(r.counts.activationCalls).toBe(16); // failed attempts counted; activated before light attempt 17
      expect([...db.journals.values()].map((j) => [j.key, j.purpose, j.phase])).toEqual([["ATT", "plan", "complete"]]);
      expect(db.journalCalls().filter((c) => c.fn === "open_reporting_owner_input")).toHaveLength(1);
      expect(db.lastPublished()).toEqual(await reference("rebuild", att, []));
    });
  });

  it("the fake journal: a complete journal refuses new writes (identical final replay still allowed); a rejected checkpoint changes nothing (review Must-fix 3)", async () => {
    const db = new FakeDb("rebuild");
    const b = (await db.rpc("begin_reporting_rebuild", { p_site: "uk" })).data as Array<{ batch_id: string; lease_fence: number }>;
    const ba = { p_batch: b[0].batch_id, p_fence: b[0].lease_fence };
    const h = ((await db.rpc("open_reporting_owner_input", { ...ba, p_kind: "order", p_key: "X", p_purpose: "plan" })).data as Array<{ handle: string }>)[0].handle;
    const cp = (seq: string, payload: unknown) => db.rpc("checkpoint_reporting_owner_input", { ...ba, p_handle: h, p_expected_seq: seq, p_payload: payload });
    const piece = [1, 0, "x", { event_id: "e1", pieces: 1, text_bytes: 1, text_sha256: "0".repeat(64), src_at: CUT, stream_candidate: false }];
    // a page with no step is rejected before anything is stored
    expect((await cp("0", { kind: "page", pieces: [piece], steps: [] })).error).not.toBeNull();
    const j = db.journals.get(h)!;
    expect([j.seq, j.events.size, j.pending.size, j.pieces]).toEqual([0n, 0, 0, { committed: 0, pending: 0 }]);
    // finish: a done page, then the one-audience hash
    expect((await cp("0", { kind: "page", pieces: [], steps: [{ v: 1, step: "done" }] })).error).toBeNull();
    const hash = { kind: "hash", audiences: [{ audienceKind: "site", audienceStaff: null }], hashes: [{ audienceKind: "site", audienceStaff: null, inputHash: "a".repeat(64) }] };
    expect((await cp("1", hash)).error).toBeNull();
    expect(j.phase).toBe("complete");
    // the identical final checkpoint is a replay; any new write is refused and moves nothing
    expect(((await cp("1", hash)).data as Array<{ replay: boolean }>)[0].replay).toBe(true);
    for (const payload of [{ kind: "discard_pending" }, { kind: "pieces", pieces: [piece] }, { kind: "page", pieces: [], steps: [{ v: 1, step: "done" }] }, hash]) {
      const res = await cp("2", payload);
      expect(res.error?.message, JSON.stringify(payload).slice(0, 40)).toMatch(/complete/);
      expect(j.seq).toBe(2n);
    }
  });

  it("a durable owner interrupted by its budget resumes from its journal in the next invocation and still publishes the reference", async () => {
    const view = [...base, ...heavy(1)];
    const db = new FakeDb("rebuild", {}, 400);
    const e = () => env(db, memorySource(view, [], { keyPages: [], ownerPages: [] }, 37, { db, perRead: 3_000 }));
    let r = await runReportingCycle(e(), { site: "uk", mode: "rebuild", deadlineMs: 60_000 });
    const seen: Array<{ phase: string; seq: bigint; pendingPieces: number }> = []; // the journal after each pending invocation
    for (let i = 0; i < 40 && r.state !== "published"; i++) {
      db.clock += 400_000;
      seen.push(...[...db.journals.values()].map((j) => ({ phase: j.phase, seq: j.seq, pendingPieces: j.pieces.pending })));
      r = await runReportingCycle(e(), { site: "uk", mode: "rebuild", deadlineMs: 60_000 });
    }
    expect(r.state).toBe("published");
    expect(db.journals.size).toBe(1); // one journal, reused across invocations
    // the budget really stopped the durable read part-way, every stop left no pending (orphan) pieces, and every later
    // invocation ADVANCED the same journal (seq strictly up while reading) until it was complete
    expect(seen.every((x) => x.pendingPieces === 0)).toBe(true);
    const reading = seen.filter((x) => x.phase === "reading");
    expect(reading.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < reading.length; i++) expect(reading[i].seq).toBeGreaterThan(reading[i - 1].seq);
    expect(seen.at(-1)!.phase).toBe("complete");
    expect(r.counts.ownersParked ?? 0).toBe(0); // the publishing invocation parked nothing
    expect(db.journalCalls().filter((c) => c.fn === "open_reporting_owner_input")).toHaveLength(1);
    expect(db.lastPublished()).toEqual(await reference("rebuild", view, []));
  }, 300_000);
});

describe("T15P-4d step 4: every durable leg is admitted against the actual heartbeat phase and time left (scope review Must-fix 2)", () => {
  const base = baseView(80);
  const heavyOnly = (staff = W1): Ev[] => Array.from({ length: 1200 }, (_, i) => ev(`h1-${String(i).padStart(4, "0")}`, {
    order_number: "HEAVY-1", staff_id: staff, created_at: `2026-02-21T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}+00:00`,
    ...(i < 3 ? {} : { event_type: "started", line_sku: null, line_quantity: null }),
  }));
  /** The fake's own reload accounting for a journal right now (header + load pages + eof). */
  const liveReload = (db: FakeDb) => {
    const j = [...db.journals.values()][0];
    return 1 + Math.ceil(j.pieces.committed / 500) + 1;
  };

  it("the path is derived from ACTUAL, LIVE counts; the phase and time left are the real ones; each commit is admitted with its exact calls", async () => {
    const view = [...base, ...heavyOnly()];
    const db = new FakeDb("rebuild", {}, 1_000); // every RPC costs 1 s of wall time, none of it CPU
    const seen: Array<AdmissionRecord & { liveReload: number; callIndex: number }> = [];
    const e = { ...env(db, memorySource(view, [], { keyPages: [], ownerPages: [] }, 37)), cpuNow: () => 0, onAdmission: (x: AdmissionRecord) => void seen.push({ ...x, liveReload: liveReload(db), callIndex: db.calls.length }) };
    const t0 = db.clock;
    const r = await runReportingCycle(e, { site: "uk", mode: "rebuild" });
    expect(r.state).toBe("published");
    expect(new Set(seen.map((x) => x.unit))).toEqual(new Set(["read", "commit", "hash"]));
    const fixed = FIXED_PREREQUISITE_RPCS + r.counts.activationCalls + 1;
    let readMeasured = false;
    seen.forEach((x, i) => {
      expect(x.owner).toEqual({ partitionKind: "order", partitionKey: "HEAVY-1" });
      // prerequisites follow the journal as it grows: fixed + the CURRENT reload cost (no open/discard once done);
      // wall-time I/O never becomes CPU (the CPU clock stands still)
      expect(x.path.prerequisites).toEqual({ rpcs: fixed + x.liveReload, cpuMs: 0 });
      expect(x.path.prerequisitesPaid).toBe(true);
      if (x.unit === "read") {
        expect(x.path.unit).toEqual({ rpcs: READ_LEG_RPCS, cpuMs: readMeasured ? 0 : FIRST_UNIT_CPU_MS });
      } else if (x.unit === "commit") {
        readMeasured = true;
        // the admitted commit is EXACTLY the checkpoint calls that follow it, counted independently in the fake
        const until = seen[i + 1]?.callIndex ?? db.calls.length;
        expect(x.path.unit.rpcs).toBe(db.calls.slice(x.callIndex, until).filter((c) => c.fn === "checkpoint_reporting_owner_input").length);
      } else expect(x.path.unit.rpcs).toBe(HASH_UNIT_RPCS);
      const marks = [t0, ...db.calls.filter((c) => c.fn === "renew_reporting_lease" && c.at <= x.nowMs).map((c) => c.at)];
      expect(x.sinceBeatMs).toBe(x.nowMs - Math.max(...marks));
      expect(x.sinceBeatMs).toBeLessThan(HEARTBEAT_MS);
      expect(x.remainingMs).toBe(t0 + WORKER_BUDGET_MS - x.nowMs);
      expect([x.verdict, x.action]).toEqual(["run", "run"]);
    });
    // the live reload cost really grew during the read (a fresh restart at the end costs more than at the start)
    expect(seen.at(-1)!.liveReload).toBeGreaterThan(seen[0].liveReload);
  });

  it("the default CPU clock is this process's user + system CPU (not elapsed time)", () => {
    // deterministic: a timing probe is unreliable inside a multi-threaded test runner, whose other workers share the
    // process CPU counter (a single function invocation does not)
    const spy = vi.spyOn(process, "cpuUsage").mockReturnValue({ user: 7_000, system: 3_000 });
    try {
      expect(processCpuMs()).toBe(10); // microseconds -> ms
      expect(spy).toHaveBeenCalledWith();
    } finally {
      spy.mockRestore();
    }
  });

  it("descriptor CPU is charged once (only to legs after reading) and measured CPU feeds the next leg", async () => {
    const view = [...base, ...heavyOnly()];
    const db = new FakeDb("rebuild");
    let cpu = 0;
    const seen: AdmissionRecord[] = [];
    // a CPU clock that advances 1 ms per reading: every measured span is >= 1, never derived from wall time
    const e = { ...env(db, memorySource(view, [], { keyPages: [], ownerPages: [] }, 37)), cpuNow: () => cpu++, onAdmission: (x: AdmissionRecord) => void seen.push(x) };
    expect((await runReportingCycle(e, { site: "uk", mode: "rebuild" })).state).toBe("published");
    const reads = seen.filter((x) => x.unit !== "hash");
    const hashes = seen.filter((x) => x.unit === "hash");
    expect(hashes.length).toBeGreaterThan(0);
    // reconstruction CPU (recovery + serialization so far) only grows. With this clock every measured span between two
    // consecutive readings is exactly 1: the last commit adds its serialization (1), and the hash legs add the
    // descriptor CPU (1) ONCE: exactly +2 over the last commit's prerequisites
    const lastCommit = reads.filter((x) => x.unit === "commit").at(-1)!.path.prerequisites.cpuMs;
    expect(hashes[0].path.prerequisites.cpuMs).toBe(lastCommit + 2);
    for (const x of reads) expect(x.path.prerequisites.cpuMs).toBeLessThanOrEqual(lastCommit);
    // after the first measured read, the read leg uses the measurement, not the first-unit estimate
    expect(reads.filter((x) => x.unit === "read").slice(1).every((x) => x.path.unit.cpuMs < FIRST_UNIT_CPU_MS)).toBe(true);
  });

  it("29,500 ms after the last beat (worker level): a two-RPC read leg with 5,000 ms left parks BEFORE its read; with 6,000 ms it renews at the commit boundary, commits and keeps the reserve", async () => {
    // invocation 1 enumerates, then planning's owner list keeps failing (deferred): no journal yet
    const view = heavyOnly();
    const setup = async (latency: number, deadlineMs: number) => {
      const db = new FakeDb("rebuild", { transientAt: "list_reporting_worker_owners", transientTimes: 9 }, 1_000);
      const src = () => memorySource(view, [], { keyPages: [], ownerPages: [] }, 37, { db, perRead: 500 });
      expect((await runReportingCycle(env(db, src()), { site: "uk", mode: "rebuild" })).state).toBe("pending");
      expect(db.journals.size).toBe(0);
      db.transientLeft = 0;
      db.clock += 400_000;
      // invocation 2: a slow owner page brings the first durable admission to exactly 29,500 ms after the start
      const seen: AdmissionRecord[] = [];
      const client: RpcClient = { rpc: async (fn, args) => (fn === "list_reporting_worker_owners" && (db.clock += latency), db.rpc(fn, args)) };
      const t0 = db.clock;
      const reads0 = { n: 0 };
      const r = await runReportingCycle({ ...env(db, src()), client, cpuNow: () => 0, onAdmission: (x) => void (seen.push(x), (reads0.n = reads0.n || db.calls.length)) }, { site: "uk", mode: "rebuild", deadlineMs });
      return { db, r, seen, t0 };
    };
    // the base elapsed time before that admission is fixed by the call sequence; calibrated once
    const probe = await setup(0, 240_000);
    const base0 = probe.seen[0].sinceBeatMs;
    const latency = 29_500 - base0;
    expect(latency).toBeGreaterThan(0);

    const parked = await setup(latency, 29_500 + 5_000);
    const a0 = parked.seen[0];
    expect([a0.unit, a0.sinceBeatMs, a0.remainingMs]).toEqual(["read", 29_500, 5_000]);
    // 2 RPCs + 1,000 ms first-unit CPU cross 30 s: one renewal, then the 2,000 ms reserve = 6,000 > 5,000
    expect([a0.verdict, a0.action]).toEqual(["pending", "park"]);
    expect(parked.r.state).toBe("pending");
    const j0 = [...parked.db.journals.values()][0];
    expect([j0.seq, j0.pieces.pending, j0.events.size]).toEqual([0n, 0, 0]); // nothing started, nothing orphaned
    expect(parked.db.calls.filter((c) => c.at > a0.nowMs && c.fn === "checkpoint_reporting_owner_input")).toEqual([]);

    const ran = await setup(latency, 29_500 + 6_000);
    const b0 = ran.seen[0];
    expect([b0.unit, b0.sinceBeatMs, b0.remainingMs, b0.verdict]).toEqual(["read", 29_500, 6_000, "run"]);
    // the read (500 ms) reaches the 30 s boundary; the commit's admission takes the due renewal FIRST, then checkpoints
    const after = ran.db.calls.filter((c) => c.at > b0.nowMs).map((c) => c.fn);
    expect(after.slice(0, 2)).toEqual(["renew_reporting_lease", "checkpoint_reporting_owner_input"]);
    const cp = ran.db.calls.find((c) => c.at > b0.nowMs && c.fn === "checkpoint_reporting_owner_input")!;
    expect(ran.t0 + 29_500 + 6_000 - cp.at).toBeGreaterThanOrEqual(2_000); // the reserve is kept
    const j1 = [...ran.db.journals.values()][0];
    expect(j1.seq).toBe(1n);
    expect(j1.pieces.pending).toBe(0);
    expect(ran.r.state).toBe("pending"); // the next leg no longer fits: parked, progress kept
    // and the next uninterrupted invocation continues from that position to publication
    ran.db.clock += 400_000;
    const done = await runReportingCycle(env(ran.db, memorySource(view, [], { keyPages: [], ownerPages: [] }, 37)), { site: "uk", mode: "rebuild" });
    expect(done.state).toBe("published");
    expect(ran.db.journals.size).toBe(1);
  });

  it("a multi-call commit admitted 29,500 ms after the beat takes the due renewal BETWEEN its calls (the guard runs inside the unit)", async () => {
    // HEAVY-2: two 700 KB members in one member page: its commit needs several checkpoint calls (pieces..., page)
    const big = [0, 1].map((i) => ev(`hb-${i}`, { order_number: "HEAVY-2", created_at: `2026-02-22T08:00:0${i}+00:00`, line_sku: "X" + "y".repeat(700_000) }));
    const setup = async (latency: number) => {
      const db = new FakeDb("rebuild", { transientAt: "list_reporting_worker_owners", transientTimes: 9 }, 1_000);
      const src = () => memorySource(big, [], { keyPages: [], ownerPages: [] }, 37, { db, perRead: 500 });
      expect((await runReportingCycle(env(db, src()), { site: "uk", mode: "rebuild" })).state).toBe("pending");
      db.transientLeft = 0;
      db.clock += 400_000;
      const seen: Array<AdmissionRecord & { callIndex: number }> = [];
      const client: RpcClient = { rpc: async (fn, args) => (fn === "list_reporting_worker_owners" && (db.clock += latency), db.rpc(fn, args)) };
      await runReportingCycle({ ...env(db, src()), client, cpuNow: () => 0, onAdmission: (x) => void seen.push({ ...x, callIndex: db.calls.length }) }, { site: "uk", mode: "rebuild" });
      return { db, commit: seen.find((x) => x.unit === "commit")! };
    };
    const probe = await setup(0);
    expect(probe.commit.path.unit.rpcs).toBeGreaterThanOrEqual(3); // pieces, pieces, page (at least)
    const { db, commit } = await setup(29_500 - probe.commit.sinceBeatMs);
    expect([commit.sinceBeatMs, commit.verdict]).toEqual([29_500, "run"]);
    // first checkpoint call ends at 30,500: the guard before the SECOND call renews first
    const after = db.calls.slice(commit.callIndex).map((c) => c.fn);
    expect(after.slice(0, 3)).toEqual(["checkpoint_reporting_owner_input", "renew_reporting_lease", "checkpoint_reporting_owner_input"]);
  });

  it("a transient-delayed invocation parks a fitting owner (pending, never capacity); the next invocation publishes", async () => {
    const view = heavyOnly();
    const db = new FakeDb("rebuild", { transientAt: "list_reporting_worker_owners", transientTimes: 9 });
    const src = () => memorySource(view, [], { keyPages: [], ownerPages: [] }, 37);
    expect((await runReportingCycle(env(db, src()), { site: "uk", mode: "rebuild" })).state).toBe("pending");
    db.transientLeft = 0;
    db.clock += 400_000;
    // three slow transient version probes, then the ordinary 30/60/120 s backoff: little time is left for HEAVY-1
    let slow = 3;
    const client: RpcClient = {
      rpc: async (fn, args) => {
        if (fn === "reporting_owner_input_version" && slow > 0) {
          slow--;
          db.clock += 8_200;
          return { data: null, error: { message: "retry", code: "40001" } };
        }
        return db.rpc(fn, args);
      },
    };
    const seen: AdmissionRecord[] = [];
    const r = await runReportingCycle({ ...env(db, src()), client, cpuNow: () => 0, onAdmission: (x) => void seen.push(x) }, { site: "uk", mode: "rebuild" });
    expect(seen.some((x) => x.action === "park")).toBe(true);
    expect(r).toMatchObject({ state: "pending", failureKind: null });
    expect(r.problems.join()).not.toMatch(/capacity|heavy/);
    db.clock += 400_000;
    expect((await runReportingCycle(env(db, src()), { site: "uk", mode: "rebuild" })).state).toBe("published");
  });

  it("a shortened invocation that cannot fit the next leg parks (pending): a fitting owner is never a capacity failure", async () => {
    const view = heavyOnly();
    const db = new FakeDb("rebuild", { transientAt: "list_reporting_worker_owners", transientTimes: 9 });
    const src = () => memorySource(view, [], { keyPages: [], ownerPages: [] }, 37, { db, perRead: 2_100 });
    expect((await runReportingCycle(env(db, src()), { site: "uk", mode: "rebuild" })).state).toBe("pending");
    db.transientLeft = 0;
    db.clock += 400_000;
    const seen: AdmissionRecord[] = [];
    const r = await runReportingCycle({ ...env(db, src()), cpuNow: () => 0, onAdmission: (x) => void seen.push(x) }, { site: "uk", mode: "rebuild", deadlineMs: 8_000 });
    expect(seen.at(-1)?.action).toBe("park");
    expect(r).toMatchObject({ state: "pending", failureKind: null });
  });

  it("an owner whose recovery alone exceeds a fresh run (CPU and wall time together) fails owner_input_capacity once, with retained evidence and no raw key", async () => {
    // HEAVY-1 alone: no earlier owner of its group can stop the invocation on the deadline before its verdict
    const view = heavyOnly();
    const db = new FakeDb("rebuild", { transientAt: "list_reporting_worker_owners", transientTimes: 9 });
    const src = () => memorySource(view, [], { keyPages: [], ownerPages: [] }, 37);
    expect((await runReportingCycle(env(db, src()), { site: "uk", mode: "rebuild" })).state).toBe("pending");
    db.transientLeft = 0;
    db.clock += 400_000;
    // the journal reload's parsing costs 250 s of CPU, which is also 250 s of wall time
    const client: RpcClient = { rpc: async (fn, args) => (fn === "load_reporting_owner_input_header" && (db.clock += 250_000), db.rpc(fn, args)) };
    const seen: AdmissionRecord[] = [];
    const r = await runReportingCycle({ ...env(db, src()), client, cpuNow: () => db.clock, onAdmission: (x) => void seen.push(x) }, { site: "uk", mode: "rebuild" });
    expect(r).toMatchObject({ state: "failed", failureKind: "owner_input_capacity" });
    expect(seen.at(-1)).toMatchObject({ verdict: "capacity", action: "fail" });
    expect(r.problems.join()).toMatch(/owner_input_capacity: an order owner cannot progress/);
    expect(r.problems.join()).not.toMatch(/HEAVY/);
    expect(db.published).toHaveLength(0);
    expect(db.journals.size).toBe(1); // the evidence stays
    expect(db.runs.at(-1)).toMatchObject({ p_outcome: "failed", p_failure_kind: "owner_input_capacity" });
    expect(JSON.stringify(db.runs.at(-1))).not.toMatch(/HEAVY/);
  });

  it("the live prerequisite prediction matches what the next invocation actually reloads", async () => {
    const view = heavyOnly();
    const db = new FakeDb("rebuild", {}, 400);
    const e = () => env(db, memorySource(view, [], { keyPages: [], ownerPages: [] }, 37, { db, perRead: 3_000 }));
    let checked = 0;
    for (let i = 0; i < 20; i++) {
      const seen: AdmissionRecord[] = [];
      const r = await runReportingCycle({ ...e(), cpuNow: () => 0, onAdmission: (x) => void seen.push(x) }, { site: "uk", mode: "rebuild", deadlineMs: 20_000 });
      if (r.state === "published") break;
      const last = seen.at(-1);
      db.clock += 400_000;
      if (!last || last.action !== "park") continue;
      // predicted reload legs of a fresh restart at the parked position ...
      const fixed = last.path.prerequisites.rpcs - (FIXED_PREREQUISITE_RPCS + (r.counts.activationCalls ?? 0) + 1);
      const from = db.calls.length;
      const next = await runReportingCycle({ ...e(), cpuNow: () => 0 }, { site: "uk", mode: "rebuild", deadlineMs: 20_000 });
      // ... equal its actual reload: one header plus the event pages and eof, before its first checkpoint
      const calls = db.calls.slice(from);
      const firstCp = calls.findIndex((c) => c.fn === "checkpoint_reporting_owner_input");
      const recovery = calls.slice(0, firstCp < 0 ? calls.length : firstCp);
      const actual = recovery.filter((c) => c.fn === "load_reporting_owner_input_header").slice(0, 1).length + recovery.filter((c) => c.fn === "load_reporting_owner_input_events").length;
      expect(actual).toBe(fixed);
      checked++;
      if (next.state === "published") break;
      db.clock += 400_000;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("Task 15 worker state helpers", () => {
  it("checkpoint owners are merged per owner with sorted distinct staff; bad staff refused", () => {
    const o: Owner = { partitionKind: "order", partitionKey: "O-1" };
    expect(checkpointOwners([{ owner: o, oldStaff: [W2] }, { owner: o, oldStaff: [W1, W2] }, { owner: { partitionKind: "event", partitionKey: "e" }, oldStaff: [] }])).toEqual([["event", "e", []], ["order", "O-1", [W1, W2]]]);
    expect(() => checkpointOwners([{ owner: o, oldStaff: ["x"] }])).toThrow(/uuid/);
  });
  it("enum cursors parse strictly", () => {
    expect(parseEnumCursor(null)).toBeNull();
    expect(parseEnumCursor({ kind: "refresh", after: "k" })).toEqual({ kind: "refresh", after: "k" });
    expect(parseEnumCursor({ kind: "rebuild", after: ["order", "O"], end: true })).toEqual({ kind: "rebuild", after: ["order", "O"], end: true });
    for (const bad of [{ kind: "refresh", after: "" }, { kind: "refresh" }, { kind: "rebuild", after: ["x", "O"] }, { kind: "refresh", after: "k", end: false }, { kind: "refresh", after: "k", x: 1 }]) expect(() => parseEnumCursor(bad)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Handlers: auth first, precedence, operator actions
// ---------------------------------------------------------------------------

interface Captured { status: number; body: unknown; headers: Record<string, string> }
function res(): { r: Captured; res: { setHeader(n: string, v: string): void; status(c: number): { json(b: unknown): void } } } {
  const r: Captured = { status: 0, body: null, headers: {} };
  return { r, res: { setHeader: (n, v) => void (r.headers[n] = v), status: (c) => ({ json: (b) => void ((r.status = c), (r.body = b)) }) } };
}
const CRON = "cron-secret-value-0123456789";
const OPS = "operator-secret-value-9876543210";

describe("Task 15 handlers: refresh-summaries", () => {
  const mk = () => {
    const t = { clients: 0, runs: [] as string[] };
    const h = createRefreshHandler({ env: { CRON_SECRET: CRON }, client: () => (t.clients++, new FakeDb("refresh")), run: async (_c, s) => (t.runs.push(s), { site: s, mode: "refresh", state: "busy", batchId: null, generationId: null, failureKind: null, counts: {}, problems: [], durationMs: 1 }) });
    return { t, h };
  };
  for (const [name, headers] of [["missing", {}], ["wrong", { authorization: "Bearer nope" }], ["app JWT", { authorization: "Bearer eyJhbGciOi.eyJzdWIi.sig" }], ["two headers", { authorization: `Bearer ${CRON}`, Authorization: `Bearer ${CRON}` }]] as const) {
    it(`401 with ZERO database/client work for a ${name} secret, before method/selector checks`, async () => {
      const { t, h } = mk();
      const { r, res: out } = res();
      await h({ method: "POST", headers, query: { site: "zz" } }, out);
      expect(r.status).toBe(401);
      expect(t.clients).toBe(0);
      expect(r.headers["Cache-Control"]).toBe("no-store");
    });
  }
  it("precedence after auth: 405 (not GET) → 400 (site) → run; duplicate invocation reports busy", async () => {
    const auth = { authorization: `Bearer ${CRON}` };
    for (const [req, status] of [[{ method: "POST", headers: auth, query: { site: "uk" } }, 405], [{ method: "GET", headers: auth, query: { site: "zz" } }, 400], [{ method: "GET", headers: auth, query: { site: "uk", mode: "rebuild" } }, 400], [{ method: "GET", headers: auth, query: { site: ["uk", "us"] } }, 400], [{ method: "GET", headers: auth, query: { site: "uk" } }, 200]] as const) {
      const { t, h } = mk();
      const { r, res: out } = res();
      await h(req as never, out);
      expect(r.status).toBe(status);
      expect(t.clients).toBe(status === 200 ? 1 : 0);
    }
  });
  it("a blank configured secret authorizes nothing", () => {
    expect(bearerMatches({ authorization: "Bearer " }, "")).toBe(false);
    expect(bearerMatches({ authorization: "Bearer  " }, " ")).toBe(false);
    expect(bearerMatches({ authorization: `Bearer ${CRON}` }, CRON)).toBe(true);
    expect(bearerMatches({ authorization: `bearer ${CRON}` }, CRON)).toBe(false);
  });
});

describe("Task 15 handlers: reporting-admin", () => {
  const mk = (envOver: Record<string, string> = {}) => {
    const t = { clients: 0, cycles: [] as string[], db: new FakeDb("refresh") };
    const h = createAdminHandler({ env: { CRON_SECRET: CRON, REPORTING_OPERATOR_SECRET: OPS, ...envOver }, now: () => 1_700_000_000_000, client: () => (t.clients++, t.db),
      cycle: async (_c, s, mode) => (t.cycles.push(`${mode}:${s}`), { site: s, mode, state: "pending", batchId: null, generationId: null, failureKind: null, counts: {}, problems: [], durationMs: 1 }) });
    return { t, h };
  };
  const call = async (h: ReturnType<typeof mk>["h"], headers: Record<string, string>, body: unknown, method = "POST") => {
    const { r, res: out } = res();
    await h({ method, headers, body }, out);
    return r;
  };
  it("the CRON secret and an app token cannot run operator actions (401, zero work)", async () => {
    for (const authz of [`Bearer ${CRON}`, "Bearer eyJhbGciOi.eyJzdWIi.sig", ""]) {
      const { t, h } = mk();
      const r = await call(h, authz ? { authorization: authz } : {}, { action: "rebuild", site: "uk" });
      expect(r.status).toBe(401);
      expect(t.clients).toBe(0);
    }
  });
  it("refuses everything when the operator secret equals the scheduler secret", async () => {
    const { t, h } = mk({ REPORTING_OPERATOR_SECRET: CRON });
    const r = await call(h, { authorization: `Bearer ${CRON}` }, { action: "status", site: "uk" });
    expect(r.status).toBe(500);
    expect(t.clients).toBe(0);
  });
  it("precedence after auth: 405 → 400 strict body → work", async () => {
    const auth = { authorization: `Bearer ${OPS}` };
    for (const [body, method, status] of [[{ action: "rebuild", site: "uk" }, "GET", 405], [{ action: "rebuild" }, "POST", 400], [{ action: "rebuild", site: "uk", extra: 1 }, "POST", 400], [{ action: "nuke", site: "uk" }, "POST", 400],
      [{ action: "set-mode", site: "uk" }, "POST", 400], [{ action: "disable-capture", site: "uk" }, "POST", 400], ["{not json", "POST", 400], [{ action: "rebuild", site: "uk" }, "POST", 200]] as const) {
      const { t, h } = mk();
      const r = await call(h, auth, body, method);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(t.clients).toBe(status === 200 ? 1 : 0);
    }
  });
  it("rebuild/cleanup run the worker for that site; capture actions state their ALL-SITE effect and the required rebuilds", async () => {
    const auth = { authorization: `Bearer ${OPS}` };
    const a = mk();
    expect((await call(a.h, auth, { action: "rebuild", site: "us" })).status).toBe(200);
    expect((await call(a.h, auth, { action: "cleanup", site: "au" })).status).toBe(200);
    expect(a.t.cycles).toEqual(["rebuild:us", "cleanup:au"]);
    const d = await call(a.h, auth, { action: "disable-capture" });
    expect(d.body).toMatchObject({ action: "disable-capture", affectedSites: [...REPORTING_SITES], rebuildRequired: [...REPORTING_SITES], result: { captureEnabled: false } });
    const e = await call(a.h, auth, { action: "enable-capture" });
    expect(e.body).toMatchObject({ rebuildRequired: [...REPORTING_SITES], result: { captureEnabled: true } });
    expect(a.t.db.runs.map((r) => r.p_action)).toEqual(["rebuild", "cleanup", "disable-capture", "enable-capture"]);
    expect(a.t.db.runs.every((r) => r.p_mode === "operator")).toBe(true);
  });
  it("abandon needs an active batch; set-mode passes only the given fields", async () => {
    const db = new FakeDb("refresh");
    expect(await runAdminCommand(db, AdminCommand.parse({ action: "abandon", site: "uk", reason: "stuck" }), { cycle: async () => { throw new Error("no"); } })).toMatchObject({ status: 409 });
    await db.rpc("begin_reporting_batch", { p_site: "uk" });
    expect(await runAdminCommand(db, AdminCommand.parse({ action: "abandon", site: "uk", reason: "stuck" }), { cycle: async () => { throw new Error("no"); } })).toMatchObject({ status: 200, body: { result: { state: "abandoned" } } });
    await runAdminCommand(db, AdminCommand.parse({ action: "set-mode", site: "uk", processorEnabled: false }), { cycle: async () => { throw new Error("no"); } });
    expect(db.calls.at(-1)).toMatchObject({ fn: "set_reporting_site_mode", args: { p_site: "uk", p_read_mode: null, p_processor_enabled: false } });
  });
});

// ---------------------------------------------------------------------------
// Schedule, files and the migration contract
// ---------------------------------------------------------------------------

describe("Task 15 schedule and migration", () => {
  it("adds exactly the three site-staggered refresh schedules; the digest entries are unchanged; 300 s functions", () => {
    const v = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string; schedule: string }>; functions: Record<string, { maxDuration: number }> };
    expect(v.crons).toEqual([
      { path: "/api/reports/daily-digest?location=au", schedule: "55 13 * * *" },
      { path: "/api/reports/daily-digest?location=uk", schedule: "55 22 * * *" },
      { path: "/api/reports/daily-digest?location=us", schedule: "55 4 * * *" },
      { path: "/api/reports/refresh-summaries?site=au", schedule: "0,15,30,45 * * * *" },
      { path: "/api/reports/refresh-summaries?site=uk", schedule: "1,16,31,46 * * * *" },
      { path: "/api/reports/refresh-summaries?site=us", schedule: "2,17,32,47 * * * *" },
    ]);
    expect(v.functions).toEqual({ "api/reports/refresh-summaries.ts": { maxDuration: 300 }, "api/reports/reporting-admin.ts": { maxDuration: 300 } });
  });
  const sql = read("supabase/migrations/0043_reporting_worker_state.sql");
  const fns = ["save_reporting_enumeration(uuid, bigint, jsonb, jsonb, jsonb, boolean)", "read_reporting_worker_progress(uuid, bigint)", "list_reporting_worker_owners(uuid, bigint, boolean, text, text, integer)", "plan_reporting_owner(uuid, bigint, text, text, jsonb)", "verify_reporting_plan(uuid, bigint)", "list_reporting_work_descriptors(uuid, bigint, jsonb, integer)", "set_reporting_site_mode(text, text, boolean)", "record_reporting_run(text, text, text, text, uuid, uuid, timestamptz, integer, jsonb, text)", "cleanup_reporting_history(text, integer)", "save_reporting_walk(uuid, bigint, jsonb, jsonb, jsonb, text, integer, text[], jsonb, boolean)", "read_reporting_walk_line(uuid, bigint, text, integer, text)"];
  it("0043 is one transaction; every public function is service-only, SECURITY INVOKER with an empty search_path", () => {
    expect(sql.trimStart().startsWith("-- 0043_reporting_worker_state.sql")).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    for (const f of fns) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO service_role;`);
    }
    const bodies = sql.split(/CREATE FUNCTION /).slice(1);
    expect(bodies).toHaveLength(fns.length + 1);
    for (const b of bodies) {
      expect(b).toMatch(/SECURITY INVOKER\nSET search_path = ''/);
      expect(b).not.toMatch(/SECURITY DEFINER|SET (LOCAL )?statement_timeout|set_config\('statement_timeout/i);
    }
    for (const t of ["worker_progress", "worker_owners", "worker_runs"]) {
      expect(sql).toContain(`ALTER TABLE reporting_private.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`REVOKE ALL ON TABLE reporting_private.${t} FROM PUBLIC, anon, authenticated;`);
    }
  });
  it("every batch mutation/read is fenced via worker_batch -> lock_batch(live); enumeration saves with the cursor advance; plan + mark are atomic", () => {
    expect(sql).toContain("b := reporting_private.lock_batch(p_batch, p_fence, true);");
    for (const f of ["save_reporting_enumeration", "read_reporting_worker_progress", "list_reporting_worker_owners", "plan_reporting_owner", "verify_reporting_plan", "list_reporting_work_descriptors"]) {
      const body = sql.slice(sql.indexOf(`CREATE FUNCTION public.${f}(`), sql.indexOf("$fn$;", sql.indexOf(`CREATE FUNCTION public.${f}(`)));
      expect(body, f).toMatch(/reporting_private\.worker_batch\(p_batch, p_fence, (true|false)\)/);
    }
    const save = sql.slice(sql.indexOf("CREATE FUNCTION public.save_reporting_enumeration("), sql.indexOf("CREATE FUNCTION public.read_reporting_worker_progress("));
    expect(save).toContain("FOR UPDATE");
    expect(save).toMatch(/IF p\.enum_cursor IS DISTINCT FROM p_expected_cursor THEN\s+RAISE EXCEPTION/);
    expect(save.indexOf("INSERT INTO reporting_private.worker_owners")).toBeLessThan(save.indexOf("SET enum_cursor = p_next_cursor"));
    const planFn = sql.slice(sql.indexOf("CREATE FUNCTION public.plan_reporting_owner("), sql.indexOf("CREATE FUNCTION public.verify_reporting_plan("));
    expect(planFn).toContain("PERFORM 1 FROM public.plan_reporting_work(p_batch, p_fence, p_items);");
    expect(planFn).toContain("an old self audience has no descriptor");
    expect(planFn).toContain("enumeration of batch % is not complete");
  });
  it("the seal proof checks completion, every owner planned, per-owner exact counts and no orphan work", () => {
    const v = sql.slice(sql.indexOf("CREATE FUNCTION public.verify_reporting_plan("), sql.indexOf("CREATE FUNCTION public.list_reporting_work_descriptors("));
    expect(v).toContain("enumeration of batch % is not complete");
    expect(v).toContain("discovered owners are not planned");
    expect(v).toContain("FULL JOIN");
    expect(v).toContain("owners have missing, extra or orphan work");
    const d = sql.slice(sql.indexOf("CREATE FUNCTION public.list_reporting_work_descriptors("), sql.indexOf("CREATE FUNCTION public.set_reporting_site_mode("));
    expect(d).toContain(`ORDER BY w.audience_kind COLLATE "C", coalesce(w.audience_staff::text, '') COLLATE "C", w.partition_kind COLLATE "C", w.partition_key COLLATE "C"`);
    expect(d).toContain("IF v_bytes + v_size > 1048576 THEN");
  });
  it("cleanup protects retained generations, journal, receipts and active work: only versions no published/superseded generation can see", () => {
    const c = sql.slice(sql.indexOf("CREATE FUNCTION public.cleanup_reporting_history("), sql.indexOf("-- Task 15 review repair: durable"));
    expect(c).toContain("SELECT min(g.generation_seq) INTO v_min FROM reporting_private.generations g WHERE g.site = p_site AND g.state IN ('published', 'superseded');");
    expect(c.match(/valid_to_seq IS NOT NULL AND y\.valid_to_seq <= v_min LIMIT p_limit/g)).toHaveLength(7);
    expect(c).toContain("g.state = 'superseded' AND g.expires_at <= now()");
    expect(c).toContain("interval '30 days'");
    expect(c).not.toMatch(/reporting_private\.(changes|batch_changes|batches|partition_work|partition_results|source_current)\b(?! b ON)/);
    expect(c).not.toMatch(/public\.production_events/);
    expect(c).toContain("FOR UPDATE");
  });
  it("no existing migration changed; 0042 is the evidence-backed Task 14 access-path fix it was reserved for", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const names = readdirSync("supabase/migrations").filter((n: string) => n.endsWith(".sql")).sort();
    expect(names.filter((n: string) => n.startsWith("0042"))).toEqual(["0042_reporting_access_paths.sql"]);
    expect(names).toContain("0043_reporting_worker_state.sql");
  });
});

describe("Task 15: the per-key enumeration unit equals the whole-batch closure", () => {
  it("the union of changedKeyDependencies over every changed key is exactly affectedOwners (owners and old self audiences)", async () => {
    const { affectedOwners, changedKeyDependencies } = await import("../../api/_lib/production-reporting-materialize");
    const base = baseView(80);
    const { after, changed } = refreshChange(base);
    const reader = memoryFrozenReader({ site: "uk", cutoff: "2026-03-01T00:00:00.000000Z", kind: "refresh", view: after, changed });
    const whole = await affectedOwners(reader);
    const owners = new Map<string, Owner>();
    const old = new Map<string, Set<string>>();
    for (const k of changed) {
      const d = await changedKeyDependencies(reader, k);
      for (const o of d.owners) owners.set(ownerKey(o), o);
      for (const [ok, s] of d.oldStaff) (old.get(ok) ?? old.set(ok, new Set()).get(ok)!).add(s);
    }
    expect([...owners.values()].sort((x, y) => compareUtf8(ownerKey(x), ownerKey(y)))).toEqual(whole.owners);
    expect(new Map([...old].map(([k, v]) => [k, [...v].sort()]))).toEqual(new Map([...whole.oldStaff].map(([k, v]) => [k, [...v].sort()])));
    expect(whole.owners.length).toBeGreaterThan(20);
    expect(whole.owners.some((x) => x.partitionKey === "O-SUCC")).toBe(true); // non-vacuous: a successor-only owner
  });
});

describe("Task 15: saved-descriptor manifest traversal", () => {
  const descs: WorkDescriptor[] = sortDescriptors([
    { audienceKind: "site", audienceStaff: null, partitionKind: "order", partitionKey: "B", inputHash: "1".repeat(64) },
    { audienceKind: "site", audienceStaff: null, partitionKind: "event", partitionKey: "e", inputHash: "2".repeat(64) },
    { audienceKind: "self", audienceStaff: W2, partitionKind: "order", partitionKey: "A", inputHash: "3".repeat(64) },
    { audienceKind: "self", audienceStaff: W1, partitionKind: "order", partitionKey: "\u{1F600}", inputHash: "4".repeat(64) },
  ]);
  const client = (pages: WorkDescriptor[][]): RpcClient => ({ rpc: async () => ({ data: (pages.shift() ?? []).map((d) => ({ audience_kind: d.audienceKind, audience_staff: d.audienceStaff, partition_kind: d.partitionKind, partition_key: d.partitionKey, input_hash: d.inputHash })), error: null }) });
  it("streams pages into exactly reportingManifestHash (newline-joined lines, manifest order)", async () => {
    const m = await manifestFromSaved(client([descs.slice(0, 1), descs.slice(1, 3), descs.slice(3)]), "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", 1);
    expect(m).toEqual({ count: 4, hash: reportingManifestHash(descs), pages: 3 });
    expect((await manifestFromSaved(client([]), "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", 1)).hash).toBe(reportingManifestHash([]));
  });
  it("refuses an out-of-order or repeated descriptor", async () => {
    await expect(manifestFromSaved(client([[descs[1], descs[0]]]), "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", 1)).rejects.toThrow(/manifest order/);
    await expect(manifestFromSaved(client([[descs[0]], [descs[0]]]), "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", 1)).rejects.toThrow(/manifest order/);
  });
});
