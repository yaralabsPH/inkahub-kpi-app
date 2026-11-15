/**
 * T13B2b-16/-17/-18: the ACTUAL fence coordinator (runFence + ownedToggle +
 * receipts) and the rollback interleavings wrapper, driven against an
 * in-memory fake database with injected failures. No real database.
 */
import { describe, expect, it } from "vitest";
import { fenceStatus, newFenceReport, type FenceId, type FenceObservation, type FenceReport } from "../staging/reportingFence";
import { fenceAllowance, ownedToggle, RECEIPT_LOCK_SQL, runFence, type FenceRunIO, type ReceiptIO } from "../staging/reportingFenceRun";
import type { Conn } from "../staging/reportingCommitted";
import { runInterleavings, type FullState, type InterleaveCtx, type Observation } from "../staging/reportingPublication";

// ---------------------------------------------------------------------------
// In-memory database: committed state + per-connection transactions
// ---------------------------------------------------------------------------

type State = { enabled: boolean; epoch: number; updatedAt: number; payload: string; ledger: string };
class FakeDb {
  committed: State = { enabled: false, epoch: 3, updatedAt: 100, payload: "rows=40;hash=aaa", ledger: "rows=7;hash=bbb" };
  opened = 0;
  ends = 0;
  log: string[] = [];
  /** Inject: the n-th COMMIT (1-based) throws; `applied` says whether it took effect first (a lost response). */
  failCommit: { n: number; applied: boolean } | null = null;
  commits = 0;
  failOpen: ((n: number) => Error | null) | null = null;
  failEnd = false;
  open = async (): Promise<Conn> => {
    this.opened++;
    const f = this.failOpen?.(this.opened);
    if (f) throw f;
    const id = this.opened;
    let tx: State | null = null;
    const cur = () => tx ?? this.committed;
    const conn: Conn = {
      query: async (sql: string, params: unknown[] = []) => {
        this.log.push(`${id}: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
        const ok = (rows: Array<Record<string, unknown>> = []) => ({ rows, rowCount: rows.length });
        if (sql === "begin") return void (tx = { ...this.committed }), ok();
        if (sql === "rollback") return void (tx = null), ok();
        if (sql === "commit") {
          this.commits++;
          if (this.failCommit && this.failCommit.n === this.commits) {
            if (this.failCommit.applied && tx) this.committed = tx;
            tx = null;
            throw new Error("connection reset during commit");
          }
          if (tx) this.committed = tx;
          tx = null;
          return ok();
        }
        if (sql.startsWith("select pg_backend_pid()")) return ok([{ p: 1000 + id }]);
        if (sql.includes("name = 'lock_timeout'")) return ok([{ ms: 0 }]);
        if (sql.startsWith("select set_config")) return ok();
        if (sql === RECEIPT_LOCK_SQL.update || sql === RECEIPT_LOCK_SQL.share) return ok([{ e: String(cur().epoch) }]);
        if (sql.includes("public.set_reporting_capture")) {
          const t = tx ?? (tx = { ...this.committed });
          const want = params[0] === true;
          if (t.enabled !== want) Object.assign(t, { enabled: want, epoch: t.epoch + 1, updatedAt: t.updatedAt + 1 });
          return ok([{ capture_epoch: t.epoch, capture_enabled: t.enabled }]);
        }
        if (sql.includes("pg_stat_activity")) return ok([{ x: false }]);
        return ok();
      },
      end: async () => {
        this.ends++;
        if (this.failEnd) throw new Error("socket hang up");
      },
    };
    return conn;
  };
  /** A change made by SOMEONE ELSE (no receipt): committed directly. */
  external(change: Partial<State>) {
    this.committed = { ...this.committed, ...change };
  }
  fullState = async (): Promise<FullState> => {
    const s = this.committed;
    return {
      surfaces: { "source:production_events": s.payload, "stock:inventory_ledger": s.ledger },
      privateTables: { changes: "rows=0" },
      control: { capture_epoch: String(s.epoch), capture_enabled: s.enabled, rule_version: "r1", updated_at: String(s.updatedAt) },
      siteState: [{ site: "au", mode: "legacy", processor_enabled: false }],
    };
  };
}

const GOOD: Record<FenceId, FenceObservation> = {
  F1: { id: "F1", existingLockMs: 0, writerLimitMs: 3000, secondWriterMs: 40, secondWriterError: null },
  F2: { id: "F2", toggleWaited: true, queuedWriterWaited: true, epochBefore: 4, epochAfter: 5, journalRows: 1, journalEpoch: 5 },
  F3: { id: "F3", oldSnapshotError: "error 40001" },
  F4: { id: "F4", epochBefore: 6, epochAfterDisable: 7, epochAfterEnable: 8, journalRows: 1, journalEpoch: 8 },
  F5: { id: "F5", existingLockMs: 0, defaultLimitMs: 3000, timeoutError: "error 55P03", timeoutMs: 3010, stricterLimitMs: 1000, stricterError: "error 55P03", stricterMs: 1005, controlUnchanged: true },
  F6: { id: "F6", lockRows: 1, updateUpdatedAtError: "error 42501", updateEnabledError: "error 42501" },
};
const IDS: FenceId[] = ["F1", "F2", "F3", "F4", "F5", "F6"];

interface Harness {
  db: FakeDb;
  report: FenceReport;
  ran: FenceId[];
  restored: boolean[];
  saveFails: (() => boolean) | null;
  run: () => Promise<FenceReport>;
}

/** The real coordinator; each scenario toggles through the REAL ownedToggle (as the runner's F1/F3/F4 do). */
function harness(over: Partial<Record<FenceId, (h: Harness, toggle: (on: boolean) => Promise<number>) => Promise<FenceObservation>>> = {}, opts: { restoreFails?: boolean } = {}): Harness {
  const db = new FakeDb();
  const report = newFenceReport("rev", "t0");
  const h: Harness = { db, report, ran: [], restored: [], saveFails: null, run: null as unknown as () => Promise<FenceReport> };
  const save = () => {
    if (h.saveFails?.()) throw new Error("ENOSPC: disk full");
  };
  const receipts: ReceiptIO = { transitions: report.captureTransitions, errors: report.errors, save, open: db.open, redact: (s) => s, sleep: async () => undefined };
  const toggle = (on: boolean, restoring = false) => ownedToggle({ ...receipts, as: async () => undefined }, on, restoring);
  const dflt: Record<FenceId, (h: Harness, t: (on: boolean) => Promise<number>) => Promise<FenceObservation>> = {
    F1: async (_h, t) => (await t(true), GOOD.F1),
    F2: async () => GOOD.F2,
    F3: async (_h, t) => (await t(false), await t(true), GOOD.F3),
    F4: async (_h, t) => (await t(false), await t(true), GOOD.F4),
    F5: async () => GOOD.F5,
    F6: async () => GOOD.F6,
  };
  const io: FenceRunIO = {
    open: db.open,
    save,
    now: () => "t1",
    redact: (s) => s,
    stderr: () => undefined,
    prepare: async () => undefined,
    scenarios: IDS.map((id) => ({ id, run: async () => (h.ran.push(id), (over[id] ?? dflt[id])(h, (on) => toggle(on))) })),
    restore: async (enabled) => {
      h.restored.push(enabled);
      if (opts.restoreFails) throw new Error("restore connection refused");
      await toggle(enabled, true);
    },
    fullState: () => db.fullState(),
    controlState: async () => ({ epoch: db.committed.epoch, enabled: db.committed.enabled }),
  };
  h.run = () => runFence(report, io);
  return h;
}

describe("T13B2b-16/-17/-18: the fence coordinator", () => {
  it("a clean run: every receipt confirmed, capture returned to off, the full-state audit allows exactly the confirmed increments", async () => {
    const h = harness();
    await h.run();
    expect(fenceStatus(h.report)).toBe("STATUS: COMPLETE");
    expect(h.ran).toEqual(IDS);
    expect(h.restored).toEqual([false]);
    expect(h.db.committed.enabled).toBe(false);
    // on(3->4), off(4->5), on(5->6), off(6->7), on(7->8), restore off(8->9)
    expect(h.report.captureTransitions.map((t) => `${t.before}->${t.after}:${t.state}`)).toEqual(["3->4:confirmed", "4->5:confirmed", "5->6:confirmed", "6->7:confirmed", "7->8:confirmed", "8->9:confirmed"]);
    expect(h.db.committed.epoch).toBe(9);
    expect(h.report.captureAfter).toEqual({ epoch: 9, enabled: false });
    expect(h.db.opened).toBe(h.db.ends); // every connection closed
  });

  it("T13B2b-16: a save failure AFTER F1's committed toggle stops the run, yet capture is restored on a fresh connection and the fresh audit still runs", async () => {
    const h = harness();
    h.saveFails = () => h.report.observations.length >= 1; // persistence breaks after F1's observation (and stays broken)
    await h.run();
    expect(h.ran).toEqual(["F1"]); // F2.. never ran
    expect(h.restored).toEqual([false]);
    expect(h.db.committed.enabled).toBe(false); // the committed capture=true was undone
    expect(h.report.restorationVerified).toBe(true); // the audit ran and matched exactly: 3 -> 4 (on) -> 5 (restore off)
    expect(h.report.captureTransitions.map((t) => t.state)).toEqual(["confirmed", "confirmed"]);
    const errs = h.report.errors.join("\n");
    expect(errs).toMatch(/ENOSPC: disk full/); // the original persistence failure
    expect(errs).toMatch(/during capture restoration; restoration continued/); // the restoration's own persistence failure, kept separately
    expect(fenceStatus(h.report)).toMatch(/^STATUS: FAILED/);
    expect(h.db.opened).toBe(h.db.ends);
  });

  it("T13B2b-16: a restoration failure is kept separately from the original failure; the audit still runs and reports capture left on", async () => {
    const h = harness({ F2: async () => ({ ...GOOD.F2, toggleWaited: false }) }, { restoreFails: true });
    await h.run();
    expect(h.ran).toEqual(["F1", "F2"]);
    const errs = h.report.errors.join("\n");
    expect(errs).toMatch(/F2 failed \(F2: the enable did not wait/);
    expect(errs).toMatch(/restoration failed: capture could not be returned to disabled: restore connection refused/);
    expect(h.report.restorationVerified).toBe(false);
    expect(h.report.restorationProblems.join("\n")).toMatch(/capture_enabled is true, was false/);
  });

  it("T13B2b-16: a failure BEFORE the baseline (prepare) toggles nothing and restores nothing", async () => {
    const h = harness();
    const report = newFenceReport("rev", "t0");
    const restored: boolean[] = [];
    await runFence(report, { open: h.db.open, save: () => undefined, now: () => "t1", redact: (s) => s, prepare: async () => { throw new Error("0038 is not installed"); }, scenarios: [{ id: "F1", run: async () => GOOD.F1 }], restore: async (e) => void restored.push(e), fullState: () => h.db.fullState(), controlState: async () => ({ epoch: 3, enabled: false }) });
    expect(restored).toEqual([]);
    expect(report.errors.join()).toMatch(/0038 is not installed/);
    expect(report.restorationVerified).toBe(false); // no baseline, so restoration cannot be claimed
  });

  it("T13B2b-17: a false expectation stops at once; no later scenario runs", async () => {
    const h = harness({ F1: async (_h, t) => (await t(true), { ...GOOD.F1, secondWriterMs: null, secondWriterError: "error 55P03" }) });
    await h.run();
    expect(h.ran).toEqual(["F1"]);
    expect(h.report.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^F1: second writer error 55P03/), "F2 did not run", "F6 did not run"]));
    expect(h.restored).toEqual([false]);
    expect(h.db.committed.enabled).toBe(false);
    expect(fenceStatus(h.report)).toMatch(/^STATUS: FAILED/);
  });

  it("T13B2b-17: an exception or a scenario-connection cleanup failure stops at once", async () => {
    for (const msg of ["boom", "cleanup failed: scenario connection rollback: terminated"]) {
      const h = harness({ F2: async () => { throw new Error(msg); } });
      await h.run();
      expect(h.ran).toEqual(["F1", "F2"]);
      expect(h.report.observations.at(-1)).toEqual({ id: "F2", error: msg });
      expect(h.report.errors.join()).toMatch(/F2 failed .*later fence scenarios are not run/);
      expect(h.db.committed.enabled).toBe(false);
    }
  });

  it("T13B2b-17: expected refusals that PASS their expectation are successful scenarios (F3 40001, F5 55P03, F6 42501)", async () => {
    const h = harness();
    await h.run();
    expect(h.report.observations.map((o) => o.id)).toEqual(IDS);
    expect(h.report.problems).toEqual([]);
  });

  it("T13B2b-18: a SAME-COUNT payload change is caught by the full-state audit", async () => {
    const h = harness({ F2: async (x) => (x.db.external({ payload: "rows=40;hash=ccc" }), GOOD.F2) });
    await h.run();
    expect(h.ran).toEqual(IDS);
    expect(h.report.restorationVerified).toBe(false);
    expect(h.report.restorationProblems.join("\n")).toMatch(/source:production_events differs \(rows=40;hash=aaa -> rows=40;hash=ccc\)/);
    expect(fenceStatus(h.report)).toMatch(/^STATUS: FAILED/);
  });

  it("T13B2b-18: unexpected epoch drift (an external off/on) fails; it is never normalized away", async () => {
    const h = harness({ F5: async (x) => (x.db.external({ epoch: x.db.committed.epoch + 2, updatedAt: x.db.committed.updatedAt + 2 }), GOOD.F5) });
    await h.run();
    expect(h.report.restorationVerified).toBe(false);
    expect(h.report.restorationProblems.join("\n")).toMatch(/capture_epoch is 11, expected exactly 9 \(3 \+ 6\)/);
  });

  it("T13B2b-18: an uncertain COMMIT is not counted; the run fails even though the toggle took effect", async () => {
    const h = harness();
    h.db.failCommit = { n: 1, applied: true }; // F1's toggle commits but the response is lost
    await h.run();
    expect(h.ran).toEqual(["F1"]);
    expect(h.report.captureTransitions[0]).toMatchObject({ before: "3", after: "4", state: "uncertain" });
    const all = [...h.report.errors, ...h.report.restorationProblems].join("\n");
    expect(all).toMatch(/uncertain commit/);
    expect(all).toMatch(/capture_epoch is 5, expected exactly 4 \(3 \+ 1\)/); // only the restore's confirmed +1 is allowed
    expect(all).toMatch(/is uncertain; its outcome is not counted/);
    expect(h.db.committed.enabled).toBe(false);
  });

  it("T13B2b-18: a receipt is saved BEFORE commit; a failed save rolls the toggle back (absent) and stops", async () => {
    const h = harness();
    let saves = 0;
    h.saveFails = () => ++saves === 2; // 1 = baseline save, 2 = F1's tentative receipt
    await h.run();
    expect(h.report.captureTransitions[0]).toMatchObject({ before: "3", after: "4", state: "absent" });
    expect(h.db.committed.epoch).toBe(3); // nothing committed: the restore toggle was a no-op (confirmed 3 -> 3)
    expect(h.report.restorationVerified).toBe(true);
    expect(h.ran).toEqual(["F1"]);
  });

  it("T13B2b-18: the allowance is only CONFIRMED increments; a no-op confirmed receipt does not allow a timestamp change", () => {
    expect(fenceAllowance([{ enable: true, before: "3", after: "4", state: "confirmed" }, { enable: false, before: "4", after: "5", state: "uncertain" }, { enable: true, before: "5", after: "6", state: "tentative" }])).toEqual({ epochIncrement: 1, controlUpdatedAt: true, siteFields: [], sites: [] });
    expect(fenceAllowance([{ enable: false, before: "3", after: "3", state: "confirmed" }])).toEqual({ epochIncrement: 0, controlUpdatedAt: false, siteFields: [], sites: [] });
  });

  it("each toggle caps its lock wait exactly like the RPC (3 s when none is set) BEFORE locking the control row FOR UPDATE", async () => {
    const h = harness();
    await h.run();
    const firstToggle = h.db.log.filter((l) => l.startsWith("2: "));
    const cap = firstToggle.findIndex((l) => l.includes("set_config('lock_timeout'"));
    const lock = firstToggle.findIndex((l) => l.includes("for update"));
    const rpc = firstToggle.findIndex((l) => l.includes("set_reporting_capture"));
    expect(cap).toBeGreaterThan(-1);
    expect(cap).toBeLessThan(lock);
    expect(lock).toBeLessThan(rpc);
    expect(RECEIPT_LOCK_SQL.update).toMatch(/where c\.singleton for update$/);
    expect(RECEIPT_LOCK_SQL.share).toMatch(/where c\.singleton for share$/);
  });

  it("toggle disconnect failures are recorded, not swallowed", async () => {
    const h = harness();
    h.db.failEnd = true;
    await h.run();
    expect(h.report.errors.join("\n")).toMatch(/cleanup failed: toggle disconnect: socket hang up/);
    expect(fenceStatus(h.report)).toMatch(/^STATUS: FAILED/);
  });
});

// ---------------------------------------------------------------------------
// Rollback interleavings: stop at the first failure (I0 included)
// ---------------------------------------------------------------------------

describe("T13B2b-17: rollback interleavings stop at the first failure", () => {
  function ctxFor(i0: () => Record<string, unknown>, opts: { endFails?: boolean; throwI0?: boolean } = {}) {
    const log: string[] = [];
    const recorded: Observation[] = [];
    let opened = 0;
    let ended = 0;
    const ctx: InterleaveCtx = {
      sites: ["uk", "us"],
      staff: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      open: async () => {
        opened++;
        return {
          query: async (sql: string) => {
            log.push(sql);
            if (sql.includes("as cap")) {
              if (opts.throwI0) throw new Error("permission denied for table control");
              return { rows: [i0()], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          },
          end: async () => {
            ended++;
            if (opts.endFails) throw new Error("socket hang up");
          },
        };
      },
      as: async () => undefined,
      record: (o) => void recorded.push(o),
      redact: (s) => s,
      now: () => 0,
      sleep: async () => undefined,
      maxPages: 1,
    };
    return { ctx, log, recorded, counts: () => ({ opened, ended }) };
  }
  const noLaterWork = (log: string[]) => expect(log.filter((l) => /begin_reporting|insert into|pg_backend_pid|set_reporting_capture/.test(l))).toEqual([]);

  it("I0 precondition false (capture off): refused, I1 never runs", async () => {
    const t = ctxFor(() => ({ cap: false, proc: true, active: 0 }));
    const cleanup: string[] = [];
    await expect(runInterleavings(t.ctx, cleanup)).rejects.toThrow(/I0 failed; later interleavings are not run/);
    expect(t.recorded.map((o) => `${o.id}:${o.ok}`)).toEqual(["I0:false"]);
    noLaterWork(t.log);
    expect(t.counts()).toEqual({ opened: 1, ended: 1 });
  });

  it("I0 exception: refused, I1 never runs", async () => {
    const t = ctxFor(() => ({}), { throwI0: true });
    await expect(runInterleavings(t.ctx, [])).rejects.toThrow(/I0 failed/);
    expect(t.recorded[0]).toMatchObject({ id: "I0", ok: false, result: "permission denied for table control" });
    noLaterWork(t.log);
  });

  it("I0 passes its check but its connection cleanup fails: refused, I1 never runs", async () => {
    const t = ctxFor(() => ({ cap: true, proc: true, active: 0 }), { endFails: true });
    const cleanup: string[] = [];
    await expect(runInterleavings(t.ctx, cleanup)).rejects.toThrow(/I0 failed \(scenario connection cleanup\)/);
    expect(t.recorded[0]).toMatchObject({ id: "I0", ok: false });
    expect(cleanup.join()).toMatch(/scenario connection disconnect: socket hang up/);
    noLaterWork(t.log);
  });

  it("a record (persistence) failure stops too", async () => {
    const t = ctxFor(() => ({ cap: true, proc: true, active: 0 }));
    t.ctx.record = () => {
      throw new Error("ENOSPC");
    };
    await expect(runInterleavings(t.ctx, [])).rejects.toThrow("ENOSPC");
    noLaterWork(t.log);
  });

  it("I0 passing proceeds to I1 (the stop is not a blanket refusal)", async () => {
    const t = ctxFor(() => ({ cap: true, proc: true, active: 0 }));
    await expect(runInterleavings(t.ctx, [])).rejects.toThrow(/I1 failed/); // the fake has no real RPCs, so I1 fails...
    expect(t.recorded.map((o) => o.id)).toEqual(["I0", "I1"]); // ...but it ran, and nothing after it did
    expect(t.log.some((l) => l.includes("begin_reporting_rebuild"))).toBe(true);
    expect(t.log.some((l) => l.includes("rp-i2") || l.includes("insert into public.production_events"))).toBe(false);
  });
});
