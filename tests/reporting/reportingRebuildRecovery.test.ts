/**
 * Task 13 Part B1 review T13B1-1: a replacement worker with NO process state
 * recovers a rebuild from the saved progress returned by takeover, and never
 * restarts copying or touches private tables. Driven against a stateful fake
 * of the B1 rules (keyset pages, cursor/replay decision, fence and lease) and
 * the SQL text of resume/status.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../staging/sqlStatements";
import {
  beginReportingRebuild,
  copyCursorDecision,
  copyReportingSourcePage,
  getReportingJobStatus,
  parseRebuildProgress,
  recoverRebuildCopy,
  ReportingJobError,
  resumeReportingBatch,
  selectSourcePage,
  type RpcClient,
} from "../../api/_lib/reporting-jobs";

const BATCH = "5f0c1a7e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const LEASE_MS = 360_000;

/** In-memory model of one site's B1 state; it answers the RPCs the way 0038 does. */
class FakeReportingDb implements RpcClient {
  now = 0;
  calls: Array<[string, Record<string, unknown>]> = [];
  copyCursors: Array<string | null> = [];
  candidate = new Map<string, number>(); // event id -> times written
  batch: { id: string; kind: "rebuild"; state: string; fence: number; leaseUntil: number; cursor: { after: string | null; pages: number; rows: number; bytes: number; complete: boolean; last?: { after: string | null; response: Record<string, unknown> } } } | null = null;
  siteFence = 0;
  constructor(private readonly source: ReadonlyArray<{ id: string; bytes: number }>) {}

  private err(message: string): { data: null; error: { message: string } } {
    return { data: null, error: { message } };
  }

  async rpc(fn: string, a: Record<string, unknown>) {
    this.calls.push([fn, a]);
    const b = this.batch;
    if (fn === "begin_reporting_rebuild") {
      this.siteFence++;
      this.batch = { id: BATCH, kind: "rebuild", state: "active", fence: this.siteFence, leaseUntil: this.now + LEASE_MS, cursor: { after: null, pages: 0, rows: 0, bytes: 0, complete: false } };
      return { data: [{ batch_id: BATCH, lease_fence: this.siteFence, base_generation_id: null, capture_epoch: 4, rule_version: "item-counting-summary-v1", state: "active", lease_expires_at: `t+${this.now + LEASE_MS}` }], error: null };
    }
    if (fn === "get_reporting_job_status") {
      return {
        data: [{
          site: "au", processor_enabled: true, read_mode: "legacy", capture_enabled: true, capture_epoch: 4, source_epoch: null, active_generation_id: null,
          active_batch_id: b?.id ?? null, active_batch_state: b?.state ?? null, active_batch_kind: b?.kind ?? null, lease_fence: this.siteFence,
          lease_expires_at: b ? `t+${b.leaseUntil}` : null, heartbeat_at: null, last_verified_cutoff: null, pending_changes: 0, oldest_pending_captured_at: null,
        }],
        error: null,
      };
    }
    if (!b || a.p_batch !== b.id) return this.err("reporting batch not found");
    if (fn === "copy_reporting_source_page") {
      if (a.p_fence !== b.fence || this.siteFence !== b.fence) return this.err(`fence ${a.p_fence} is obsolete (current ${this.siteFence})`);
      if (b.leaseUntil <= this.now) return this.err("lease expired");
      const after = a.p_after_event_id as string | null;
      this.copyCursors.push(after);
      const d = copyCursorDecision(b.cursor, after);
      if (d === "replay") return { data: [{ ...b.cursor.last!.response, after_event_id: after, pages: b.cursor.pages, total_rows: b.cursor.rows, replay: true }], error: null };
      if (d === "complete") return this.err("copy is already complete");
      if (d === "mismatch") return this.err(`cursor mismatch: requested ${after}, persisted ${b.cursor.after}`);
      const page = selectSourcePage(this.source.filter((r) => after === null || r.id > after));
      for (const id of page.kept) this.candidate.set(id, (this.candidate.get(id) ?? 0) + 1);
      const next = page.kept.at(-1) ?? after;
      const response = { rows_copied: page.kept.length, bytes_copied: page.bytes, next_after_event_id: next, page_checksum: "c".repeat(64), complete: page.complete };
      b.cursor = { after: next, pages: b.cursor.pages + 1, rows: b.cursor.rows + page.kept.length, bytes: b.cursor.bytes + page.bytes, complete: page.complete, last: { after, response } };
      return { data: [{ ...response, after_event_id: after, pages: b.cursor.pages, total_rows: b.cursor.rows, replay: false }], error: null };
    }
    if (fn === "resume_reporting_batch") {
      if (a.p_expected_fence !== b.fence || this.siteFence !== b.fence) return this.err("obsolete fence");
      if (b.leaseUntil > this.now) return this.err("busy");
      this.siteFence++;
      b.fence = this.siteFence;
      b.leaseUntil = this.now + LEASE_MS;
      const c = b.cursor;
      return {
        data: [{
          batch_id: b.id, lease_fence: b.fence, lease_expires_at: `t+${b.leaseUntil}`, state: b.state, returned_work: 0, kind: "rebuild", base_generation_id: null,
          rule_version: "item-counting-summary-v1", capture_epoch: 4, source_cutoff: null,
          rebuild_progress: { afterEventId: c.after, complete: c.complete, pages: c.pages, rows: c.rows, bytes: c.bytes },
        }],
        error: null,
      };
    }
    return this.err(`unexpected rpc ${fn}`);
  }
}

const source = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${String(i).padStart(5, "0")}`, bytes: 200 }));

describe("T13B1-1: a worker with no state recovers a rebuild from takeover's saved progress", () => {
  it("two pages copied, all process state lost, lease expired: takeover returns the cursor and copying CONTINUES (never restarts)", async () => {
    const db = new FakeReportingDb(source(2500));
    // Worker 1: begin and copy two pages, then crash.
    {
      const batch = await beginReportingRebuild(db, "au");
      const p1 = await copyReportingSourcePage(db, batch.batchId, batch.leaseFence, null);
      const p2 = await copyReportingSourcePage(db, batch.batchId, batch.leaseFence, p1.nextAfterEventId);
      expect([p1.complete, p2.complete, p2.totalRows]).toEqual([false, false, 2000]);
    }
    // All process memory is gone. Worker 2 knows only what status tells it.
    db.now += LEASE_MS + 1;
    const status = await getReportingJobStatus(db, "au");
    expect(status).toMatchObject({ activeBatchId: BATCH, activeBatchKind: "rebuild", activeBatchState: "active" });
    const r = await recoverRebuildCopy(db, status.activeBatchId!, status.leaseFence, 10);
    expect(r.resumed.rebuildProgress).toEqual({ afterEventId: "e01999", complete: false, pages: 2, rows: 2000, bytes: 400_000 });
    expect(r.resumed.leaseFence).toBe(status.leaseFence + 1);
    expect(r).toMatchObject({ pagesCopied: 1, next: "freeze" });
    expect(r.progress).toMatchObject({ complete: true, pages: 3, rows: 2500 });
    // Exactly the three cursors, in order: null, e00999, e01999 — no restart from null after takeover.
    expect(db.copyCursors).toEqual([null, "e00999", "e01999"]);
    expect(db.candidate.size).toBe(2500);
    expect([...db.candidate.values()].every((n) => n === 1)).toBe(true);
    // Only service RPCs were used; no private-table access exists in this path.
    expect(new Set(db.calls.map(([f]) => f))).toEqual(new Set(["begin_reporting_rebuild", "copy_reporting_source_page", "get_reporting_job_status", "resume_reporting_batch"]));
  });

  it("the old worker's fence is refused after takeover; a restart from null would be refused as a cursor mismatch", async () => {
    const db = new FakeReportingDb(source(2500));
    const batch = await beginReportingRebuild(db, "au");
    const p1 = await copyReportingSourcePage(db, batch.batchId, batch.leaseFence, null);
    // After ONE page, re-asking from null is an identical replay of the last request: nothing is copied.
    const again = await copyReportingSourcePage(db, batch.batchId, batch.leaseFence, null);
    expect(again).toMatchObject({ replay: true, nextAfterEventId: "e00999" });
    const p2 = await copyReportingSourcePage(db, batch.batchId, batch.leaseFence, p1.nextAfterEventId);
    db.now += LEASE_MS + 1;
    const resumed = await resumeReportingBatch(db, batch.batchId, batch.leaseFence);
    await expect(copyReportingSourcePage(db, batch.batchId, batch.leaseFence, p2.nextAfterEventId)).rejects.toThrow(/obsolete/);
    // After TWO pages, null is neither the saved cursor nor the last request: a restart is refused.
    await expect(copyReportingSourcePage(db, batch.batchId, resumed.leaseFence, null)).rejects.toThrow(/cursor mismatch/);
    expect([...db.candidate.values()].every((n) => n === 1)).toBe(true);
  });

  it("completed-copy recovery: takeover reports complete progress and the next step is freeze, with no copy call", async () => {
    const db = new FakeReportingDb(source(2000)); // exact multiple of 1,000: the final page is empty
    const batch = await beginReportingRebuild(db, "au");
    let after: string | null = null;
    for (;;) {
      const p = await copyReportingSourcePage(db, batch.batchId, batch.leaseFence, after);
      after = p.nextAfterEventId;
      if (p.complete) break;
    }
    const copiesBefore = db.copyCursors.length;
    db.now += LEASE_MS + 1;
    const r = await recoverRebuildCopy(db, batch.batchId, batch.leaseFence, 10);
    expect(r.resumed.rebuildProgress).toEqual({ afterEventId: "e01999", complete: true, pages: 3, rows: 2000, bytes: 400_000 });
    expect(r).toMatchObject({ pagesCopied: 0, next: "freeze" });
    expect(db.copyCursors.length).toBe(copiesBefore);
  });

  it("a takeover before any page continues from the start (the saved cursor is null)", async () => {
    const db = new FakeReportingDb(source(5));
    const batch = await beginReportingRebuild(db, "au");
    db.now += LEASE_MS + 1;
    const r = await recoverRebuildCopy(db, batch.batchId, batch.leaseFence, 10);
    expect(r.resumed.rebuildProgress).toEqual({ afterEventId: null, complete: false, pages: 0, rows: 0, bytes: 0 });
    expect(r).toMatchObject({ pagesCopied: 1, next: "freeze" });
    expect(db.copyCursors).toEqual([null]);
  });
});

describe("T13B1-1: malformed takeover metadata is refused", () => {
  const good = { afterEventId: "e00999", complete: false, pages: 1, rows: 1000, bytes: 200_000 };
  const bad: Array<[string, unknown, RegExp]> = [
    ["not an object", "e00999", /not an object/],
    ["missing key", { afterEventId: "e00999", complete: false, pages: 1, rows: 1000 }, /unexpected keys/],
    ["extra key (e.g. a payload)", { ...good, image: {} }, /unexpected keys/],
    ["empty cursor", { ...good, afterEventId: "" }, /afterEventId/],
    ["string count", { ...good, rows: "1000x" }, /rows/],
    ["negative count", { ...good, bytes: -1 }, /non-negative/],
    ["fractional count", { ...good, pages: 1.5 }, /pages/],
    ["complete with no pages", { afterEventId: null, complete: true, pages: 0, rows: 0, bytes: 0 }, /no pages copied/],
    ["rows without a cursor", { afterEventId: null, complete: false, pages: 1, rows: 10, bytes: 100 }, /without a cursor/],
    ["complete flag not boolean", { ...good, complete: "true" }, /complete/],
  ];
  for (const [name, v, re] of bad) {
    it(`rejects: ${name}`, () => {
      expect(() => parseRebuildProgress(v)).toThrow(re);
    });
  }

  function resumeWith(row: Record<string, unknown>): Promise<unknown> {
    const client: RpcClient = { rpc: async () => ({ data: [row], error: null }) };
    return resumeReportingBatch(client, BATCH, 3);
  }
  const base = { batch_id: BATCH, lease_fence: 4, lease_expires_at: "t", state: "active", returned_work: 0, kind: "rebuild", base_generation_id: null, rule_version: "item-counting-summary-v1", capture_epoch: 4, source_cutoff: null, rebuild_progress: good };

  it("the wrapper validates identity, kind, state and progress", async () => {
    await expect(resumeWith(base)).resolves.toMatchObject({ kind: "rebuild", rebuildProgress: good });
    await expect(resumeWith({ ...base, rebuild_progress: null })).rejects.toThrow(/not an object/);
    await expect(resumeWith({ ...base, kind: "repair" })).rejects.toThrow(/unknown batch kind/);
    await expect(resumeWith({ ...base, kind: "refresh" })).rejects.toThrow(/a refresh has no rebuild progress/);
    await expect(resumeWith({ ...base, batch_id: "0b9d6c62-3d55-4c3d-9a9e-0a9b7f3c1e11" })).rejects.toThrow(/another batch/);
    await expect(resumeWith({ ...base, state: "published" })).rejects.toThrow(/resumed batch is published/);
    await expect(resumeWith({ ...base, source_cutoff: "t1" })).rejects.toThrow(/an active rebuild has no cutoff yet/);
    await expect(resumeWith({ ...base, capture_epoch: "4.5" })).rejects.toThrow(ReportingJobError);
  });

  it("status refuses an unknown kind or a kind without a batch", async () => {
    const row = { site: "au", processor_enabled: true, read_mode: "legacy", capture_enabled: true, capture_epoch: 4, source_epoch: null, active_generation_id: null, active_batch_id: BATCH, active_batch_state: "active", active_batch_kind: "rebuild", lease_fence: 3, lease_expires_at: null, heartbeat_at: null, last_verified_cutoff: null, pending_changes: 0, oldest_pending_captured_at: null };
    const status = (r: Record<string, unknown>) => getReportingJobStatus({ rpc: async () => ({ data: [r], error: null }) }, "au");
    await expect(status(row)).resolves.toMatchObject({ activeBatchKind: "rebuild" });
    await expect(status({ ...row, active_batch_kind: "repair" })).rejects.toThrow(/unknown batch kind/);
    await expect(status({ ...row, active_batch_kind: null })).rejects.toThrow(/disagree/);
    await expect(status({ ...row, active_batch_id: null, active_batch_kind: "rebuild" })).rejects.toThrow(/disagree/);
  });
});

describe("T13B1-1: the 0038 SQL returns the saved progress and the batch kind", () => {
  const sql = readFileSync("supabase/migrations/0038_reporting_jobs.sql", "utf8");
  const codes = splitSqlStatements(sql).map((s) => s.text.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim());
  const resume = codes.find((c) => c.startsWith("CREATE FUNCTION public.resume_reporting_batch(")) ?? "";
  const status = codes.find((c) => c.startsWith("CREATE FUNCTION public.get_reporting_job_status(")) ?? "";

  it("resume returns identity plus typed progress derived from the saved cursor (rebuilds only), and no payload", () => {
    expect(resume).toMatch(/RETURNS TABLE \(batch_id uuid, lease_fence bigint, lease_expires_at timestamptz, state text, returned_work bigint, kind text, base_generation_id uuid, rule_version text, capture_epoch bigint, source_cutoff timestamptz, rebuild_progress jsonb\)/);
    expect(resume).toMatch(/CASE WHEN b\.kind = 'rebuild' THEN pg_catalog\.jsonb_build_object\( 'afterEventId', b\.rebuild_cursor -> 'after', 'complete', coalesce\(\(b\.rebuild_cursor ->> 'complete'\)::boolean, false\), 'pages', coalesce\(\(b\.rebuild_cursor ->> 'pages'\)::bigint, 0\), 'rows', coalesce\(\(b\.rebuild_cursor ->> 'rows'\)::bigint, 0\), 'bytes', coalesce\(\(b\.rebuild_cursor ->> 'bytes'\)::bigint, 0\)\) END;/);
    // The saved 'last' response (checksums) and any image never leave the database here.
    expect(resume).not.toMatch(/rebuild_cursor -> 'last'|image|production_events|source_candidate/);
  });

  it("status reports the active batch kind", () => {
    expect(status).toMatch(/active_batch_state text, active_batch_kind text, lease_fence bigint/);
    expect(status).toMatch(/\(SELECT b\.kind FROM reporting_private\.batches b WHERE b\.batch_id = s\.active_batch_id\)/);
  });
});
