/**
 * Task 13 activation-fence coordinator (T13B2b-16/-17/-18), database-agnostic
 * so the actual coordinator is tested with injected failures
 * (tests/reporting/reportingFenceRun.test.ts). The scenario bodies stay in
 * reporting-jobs.ts; this module owns ordering, stopping, capture restoration,
 * transition receipts and the full-state audit.
 *
 * - Every committed capture toggle locks the control row in its own
 *   transaction, reads the epoch, calls the RPC, and persists a TENTATIVE
 *   receipt BEFORE COMMIT; it is confirmed only after a successful COMMIT. A
 *   failed COMMIT leaves the receipt UNCERTAIN (never counted) and the run FAILED.
 * - Scenarios run in order and the run stops at the first exception, failed
 *   expectation, scenario-cleanup failure or persistence failure. An expected
 *   refusal that matches its expectation is a pass.
 * - After the scenarios (whatever happened, including persistence/query
 *   failures) capture is returned to its starting on/off state on a FRESH
 *   connection; every original, persistence, cleanup and restoration failure
 *   is kept separately.
 * - The fresh audit compares the complete fullState; the only allowance is
 *   this run's CONFIRMED epoch increments and, when they changed the row, the
 *   control timestamp. Nothing else is normalized.
 */
import { capLimit, checkFence, checkFenceObservation, type FenceId, type FenceObservation, type FenceReport } from "./reportingFence";
import { runCaptureLifecycle } from "./reportingCapture";
import { settleOrigin, transitionIncrement, type CaptureTransition, type Conn } from "./reportingCommitted";
import { compareFullState, type Db, type FullState, type StateAllowance } from "./reportingPublication";

const msgOf = (e: unknown, redact: (s: string) => string) => redact(e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export interface ReceiptIO {
  /** This run's receipts (the report's captureTransitions). */
  transitions: CaptureTransition[];
  /** Persist the report; throws on failure. */
  save(): void;
  /** Failures that must survive (the report's errors). */
  errors: string[];
  open(): Promise<Conn>;
  redact(s: string): string;
  sleep?: (ms: number) => Promise<void>;
}

/** Control row lock SQL. FOR UPDATE for a plain toggle; FOR SHARE where the toggle's own UPDATE must be the statement that waits (F2). */
export const RECEIPT_LOCK_SQL = {
  update: "select capture_epoch::text as e from reporting_private.control c where c.singleton for update",
  share: "select capture_epoch::text as e from reporting_private.control c where c.singleton for share",
} as const;

/**
 * Inside an open transaction: the same at-most-3-s lock cap the RPC applies
 * (a stricter existing limit is kept; nothing is loosened), then lock the
 * control row and read the epoch. While the lock is held no other transition
 * can change the epoch before this run's own.
 */
export async function lockForReceipt(c: Db, mode: keyof typeof RECEIPT_LOCK_SQL): Promise<string> {
  const existing = Number((await c.query("select setting::bigint as ms from pg_catalog.pg_settings where name = 'lock_timeout'")).rows[0]?.ms ?? 0);
  const used = capLimit(3000, existing);
  if (used !== existing) await c.query("select set_config('lock_timeout', $1, true)", [`${used}ms`]);
  const r = await c.query(RECEIPT_LOCK_SQL[mode]);
  if (r.rows.length !== 1) throw new Error("the reporting control row is missing");
  return String(r.rows[0].e);
}

/** Record a TENTATIVE receipt and persist it BEFORE COMMIT (a failed save throws; the caller rolls back and marks it absent). */
export function tentativeReceipt(io: ReceiptIO, enable: boolean, before: string, after: unknown): CaptureTransition {
  if (after === undefined || after === null || !/^\d+$/.test(String(after))) throw new Error(`set_reporting_capture returned no epoch (${String(after)})`);
  const t: CaptureTransition = { enable, before, after: String(after), state: "tentative" };
  io.transitions.push(t);
  try {
    io.save();
  } catch (e) {
    t.state = "absent"; // never committed: the caller rolls back before any COMMIT
    throw e;
  }
  return t;
}

/**
 * COMMIT a transaction that carries a receipt. Success confirms it (then
 * persists; a failed save after COMMIT keeps the confirmed receipt in memory
 * and throws). A failed COMMIT marks it UNCERTAIN, records the failure,
 * closes the originating session and waits (bounded) for its backend to go;
 * the receipt is never counted.
 */
export async function commitReceipt(c: Db, t: CaptureTransition, pid: number, io: ReceiptIO): Promise<void> {
  try {
    await c.query("commit");
  } catch (e) {
    t.state = "uncertain";
    io.errors.push(`capture transition ${t.before} -> ${t.after} has an uncertain commit (${msgOf(e, io.redact)}); it is NOT added to the expected epoch`);
    await settleOrigin(c, pid, io, io.errors);
    throw e;
  }
  t.state = "confirmed";
  io.save();
}

function bestEffortSave(io: ReceiptIO): void {
  try {
    io.save();
  } catch (e) {
    const line = `report persistence failed (during capture restoration; restoration continued): ${msgOf(e, io.redact)}`;
    if (!io.errors.includes(line)) io.errors.push(line);
  }
}

/** Roll back a transaction whose receipt (if any) did not commit; the receipt becomes ABSENT. */
export async function abandonReceipt(c: Db, t: CaptureTransition | null, io: ReceiptIO): Promise<void> {
  if (t && t.state === "tentative") t.state = "absent";
  await c.query("rollback").catch((e: unknown) => io.errors.push(`cleanup failed: toggle rollback: ${msgOf(e, io.redact)}`));
}

/**
 * One committed capture transition on a FRESH connection, as service_role
 * (`as`), with its receipt. Returns the epoch after. The connection is always
 * closed; a disconnect failure is recorded.
 *
 * `restoring`: the unconditional return to the starting state. A persistence
 * failure there is recorded (the run is FAILED) but does not stop the
 * restoration, whose receipt is still kept in memory before COMMIT; every
 * other toggle stops before COMMIT if its receipt cannot be saved.
 */
export async function ownedToggle(base: ReceiptIO & { as(c: Db): Promise<void> }, enabled: boolean, restoring = false): Promise<number> {
  const io: typeof base = restoring ? { ...base, save: () => bestEffortSave(base) } : base;
  const c = await io.open();
  let t: CaptureTransition | null = null;
  let pid = 0;
  let closed = false;
  try {
    await c.query("begin");
    pid = Number((await c.query("select pg_backend_pid() as p")).rows[0]?.p ?? 0);
    await io.as(c);
    const before = await lockForReceipt(c, "update");
    const r = await c.query("select capture_epoch from public.set_reporting_capture($1)", [enabled]);
    t = tentativeReceipt(io, enabled, before, r.rows[0]?.capture_epoch);
  } catch (e) {
    await abandonReceipt(c, t, io);
    await c.end().catch((x: unknown) => io.errors.push(`cleanup failed: toggle disconnect: ${msgOf(x, io.redact)}`));
    throw e;
  }
  const receipt = t as CaptureTransition;
  try {
    await commitReceipt(c, receipt, pid, io);
  } catch (e) {
    closed = receipt.state === "uncertain"; // settleOrigin already closed it
    throw e;
  } finally {
    if (!closed) await c.end().catch((x: unknown) => io.errors.push(`cleanup failed: toggle disconnect: ${msgOf(x, io.redact)}`));
  }
  return Number(receipt.after);
}

/** The audit allowance: this run's CONFIRMED increments only; the control timestamp only if a confirmed receipt changed the row. */
export function fenceAllowance(ts: readonly CaptureTransition[]): StateAllowance {
  const changed = ts.some((t) => t.state === "confirmed" && t.after !== t.before);
  return { epochIncrement: transitionIncrement(ts), controlUpdatedAt: changed, siteFields: [], sites: [] };
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export interface FenceRunIO {
  open(): Promise<Conn>;
  save(): void;
  now(): string;
  redact(s: string): string;
  stderr?(t: string): void;
  /** Installed/staff checks on the main connection (read-only). */
  prepare(main: Conn): Promise<void>;
  /** In order; each settles its own sessions before it returns or throws. */
  scenarios: ReadonlyArray<{ id: FenceId; run(): Promise<FenceObservation> }>;
  /** Return capture to `enabled` with a receipt, on a fresh connection (ownedToggle). */
  restore(enabled: boolean): Promise<void>;
  fullState(c: Db): Promise<FullState>;
  controlState(c: Db): Promise<{ epoch: number; enabled: boolean }>;
}

export async function runFence(report: FenceReport, io: FenceRunIO): Promise<FenceReport> {
  let before: FullState | null = null;
  await runCaptureLifecycle(report, {
    open: io.open,
    now: io.now,
    redact: io.redact,
    save: io.save,
    stderr: io.stderr,
    body: async (main) => {
      try {
        await io.prepare(main);
        before = await io.fullState(main);
        report.captureBefore = await io.controlState(main);
        io.save(); // the baseline is on disk before the first committed toggle
        for (const s of io.scenarios) {
          let o: FenceObservation;
          try {
            o = await s.run();
          } catch (e) {
            o = { id: s.id, error: msgOf(e, io.redact) };
          }
          report.observations.push(o);
          const problems = checkFenceObservation(o);
          io.save(); // a persistence failure stops here, before the next scenario
          if (problems.length) throw new Error(`${s.id} failed (${problems[0]}); later fence scenarios are not run`);
        }
      } finally {
        // T13B2b-16: unconditional, after every scenario session has settled; on a FRESH connection.
        if (report.captureBefore) {
          try {
            await io.restore(report.captureBefore.enabled);
          } catch (e) {
            report.errors.push(`restoration failed: capture could not be returned to ${report.captureBefore.enabled ? "enabled" : "disabled"}: ${msgOf(e, io.redact)}`);
          }
        }
        report.problems = checkFence(report.observations);
      }
    },
    audit: async (fresh) => {
      if (!before) throw new Error("no starting baseline was taken, so nothing can be compared");
      const after = await io.fullState(fresh);
      report.captureAfter = await io.controlState(fresh);
      const p = compareFullState(before, after, fenceAllowance(report.captureTransitions)).map((d) => `baseline differs after the run: ${d}`);
      for (const t of report.captureTransitions) if (t.state === "tentative" || t.state === "uncertain") p.push(`capture transition ${t.before} -> ${t.after} is ${t.state}; its outcome is not counted`);
      return p;
    },
  });
  return report;
}
