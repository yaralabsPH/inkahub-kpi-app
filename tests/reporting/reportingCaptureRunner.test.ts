/**
 * Task 12 review fixes T12-2..T12-5 for the staging capture runner: the
 * immutable staging target at every query, no timeout override, run-specific
 * outputs with a fresh restoration audit after success AND failure, and the
 * supported-site journal + stock + event-ID-change steps.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_STEPS,
  CAPTURE_TRIGGER,
  captureMarkdown,
  captureStatus,
  checkSteps,
  compareSnapshots,
  guardClient,
  newCaptureReport,
  runCaptureLifecycle,
  runOutputName,
  stagingTarget,
  STAGING_PROJECT_REF,
  type LifecycleClient,
  type StateSnapshot,
  type StepResult,
} from "../staging/reportingCapture";

const RUNNER = readFileSync("tests/staging/reporting-capture.ts", "utf8");
const STAGING_URL = `postgresql://postgres.${STAGING_PROJECT_REF}:pw@aws-0-region.pooler.supabase.com:5432/postgres`;

const TARGET = stagingTarget(STAGING_URL);

class FakeClient implements LifecycleClient {
  sent: string[] = [];
  ended = false;
  /** Connection parameters, as pg.Client exposes them. */
  host = TARGET.host;
  user = TARGET.user;
  constructor(private failOn: (sql: string) => Error | undefined = () => undefined) {}
  async query(sql: string): Promise<unknown> {
    this.sent.push(sql);
    const e = this.failOn(sql);
    if (e) throw e;
    return { rows: [] };
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

const goodSteps = (): StepResult[] =>
  CAPTURE_STEPS.map((s) => ({ id: s.id, actor: s.actor, what: s.what, result: typeof s.expect === "string" ? s.expect : s.id === "c01" ? "advanced" : "?", ms: 1 }));

describe("T12-2: immutable staging target at every query", () => {
  it("rejects a non-staging target before any client exists", () => {
    expect(() => stagingTarget("postgresql://postgres:pw@db.lkboboagiikvozvbcpvg.supabase.co:5432/postgres")).toThrow(/not the staging project/);
    expect(() => stagingTarget("not a url")).toThrow();
    expect(Object.isFrozen(stagingTarget(STAGING_URL))).toBe(true);
  });

  it("an invalid or tampered target issues ZERO queries", () => {
    const inner = new FakeClient();
    expect(() => guardClient(inner, Object.freeze({ host: "db.lkboboagiikvozvbcpvg.supabase.co", user: "postgres" }))).toThrow(/not the staging project/);
    expect(() => guardClient(inner, { host: `db.${STAGING_PROJECT_REF}.supabase.co`, user: "postgres" })).toThrow(/not the staging project/);
    expect(inner.sent).toEqual([]);
  });

  it("a client connected anywhere but the frozen target sends nothing, at construction or at any later query", async () => {
    const elsewhere = new FakeClient();
    elsewhere.host = "db.lkboboagiikvozvbcpvg.supabase.co";
    expect(() => guardClient(elsewhere, TARGET)).toThrow(/not connected to the staging target/);
    const drifting = new FakeClient();
    const g = guardClient(drifting, TARGET);
    await g.query("select 1");
    drifting.user = "postgres.lkboboagiikvozvbcpvg";
    await expect(g.query("select 2")).rejects.toThrow(/not connected to the staging target/);
    await expect(g.query("rollback")).rejects.toThrow(/not connected to the staging target/);
    expect(elsewhere.sent).toEqual([]);
    expect(drifting.sent).toEqual(["select 1"]);
  });

  it("every query on a guarded client is checked, including role changes and cleanup after an SQL error", async () => {
    const inner = new FakeClient((sql) => (sql === "select broken" ? Object.assign(new Error("syntax"), { code: "42601" }) : undefined));
    const c = guardClient(inner, stagingTarget(STAGING_URL));
    await c.query("set local role authenticated");
    await expect(c.query("select broken")).rejects.toThrow("syntax");
    await c.query("rollback"); // local check, no SQL: cleanup works inside an aborted transaction
    expect(inner.sent).toEqual(["set local role authenticated", "select broken", "rollback"]);
  });

  it("the runner creates database clients only through the guarded opener", () => {
    expect(RUNNER.match(/new pg\.Client\(/g)).toHaveLength(1);
    expect(RUNNER).toMatch(/guardClient\(new pg\.Client\(/);
    expect(RUNNER).not.toMatch(/\bpg\.Pool\b/);
    expect(RUNNER).toMatch(/const open = \(\) => openGuarded\(/);
  });
});

describe("T12-3: the runner never overrides a database timeout", () => {
  it("no statement/idle timeout override; only the concurrency probe's transaction-local lock_timeout; settings recorded", () => {
    expect(RUNNER).not.toMatch(/statement_timeout\s*:/);
    expect(RUNNER).not.toMatch(/set (local |session )?(statement_timeout|idle_in_transaction_session_timeout)/i);
    expect(RUNNER.match(/set local lock_timeout/g)?.length).toBe(2);
    expect(RUNNER).toMatch(/current_setting\('statement_timeout'\)/);
  });
});

describe("T12-4: run-specific outputs and a fresh restoration audit after success AND failure", () => {
  it("every invocation gets its own report name and never overwrites one", () => {
    const a = runOutputName("check", "2026-11-14T15:00:00.000Z", "a1b2c3d4");
    expect(a).toBe("staging-results-reporting-capture-check-20261114T150000000Z-a1b2c3d4.md");
    expect(a).not.toBe(runOutputName("check", "2026-11-14T15:00:00.000Z", "e5f6a7b8"));
    expect(() => runOutputName("check", "t", "../x")).toThrow();
    expect(RUNNER).toMatch(/if \(existsSync\(out\)\) throw new Error\(`refusing to overwrite/);
  });

  function harness(opts: { body?: () => Promise<void>; rollbackFails?: boolean; auditOpenFails?: boolean; audit?: string[] } = {}) {
    const opened: FakeClient[] = [];
    const saves: string[] = [];
    const report = newCaptureReport("check", "rev", "t0");
    report.overhead = { offPerRowMs: 0.5, onPerRowMs: 0.6, deltaPerRowMs: 0.1, ratio: 1.2, rounds: 3 };
    const io = {
      open: async () => {
        if (opts.auditOpenFails && opened.length === 1) throw new Error("connect ECONNREFUSED");
        const c = new FakeClient((sql) => (opts.rollbackFails && sql === "rollback" ? new Error("connection terminated") : undefined));
        opened.push(c);
        return c;
      },
      body: opts.body ?? (async () => {}),
      audit: async () => opts.audit ?? [],
      save: () => void saves.push(captureStatus(report)),
      now: () => "t1",
      redact: (x: string) => x,
    };
    return { report, opened, saves, io };
  }

  it("success: cleanup, then a fresh audit on a NEW connection verifies restoration", async () => {
    const h = harness();
    await runCaptureLifecycle(h.report, h.io);
    expect(h.opened).toHaveLength(2);
    expect(h.opened[0].sent).toEqual(["rollback"]);
    expect(h.opened[0].ended && h.opened[1].ended).toBe(true);
    expect(h.report.restorationVerified).toBe(true);
    expect(captureStatus(h.report)).toBe("STATUS: COMPLETE");
    expect(captureMarkdown(h.report)).toMatch(/verified by a fresh audit after cleanup/);
  });

  it("fatal migration failure: rollback attempted, the audit STILL runs, FAILED with the cause", async () => {
    const h = harness({ body: async () => { throw new Error('relation "reporting_private.changes" does not exist'); } });
    await runCaptureLifecycle(h.report, h.io);
    expect(h.opened).toHaveLength(2);
    expect(h.opened[0].sent).toEqual(["rollback"]);
    expect(h.report.restorationVerified).toBe(true);
    expect(captureStatus(h.report)).toMatch(/^STATUS: FAILED – relation "reporting_private\.changes" does not exist/);
  });

  it("cleanup failure is explicit and cannot be COMPLETE, even when the audit passes", async () => {
    const h = harness({ rollbackFails: true });
    await runCaptureLifecycle(h.report, h.io);
    expect(h.report.errors.join()).toMatch(/cleanup failed: rollback: connection terminated/);
    expect(h.opened).toHaveLength(2);
    expect(captureStatus(h.report)).toMatch(/^STATUS: FAILED – cleanup failed/);
  });

  it("inaccessible verification: restoration NOT verified, FAILED, never 'nothing kept'", async () => {
    const h = harness({ auditOpenFails: true });
    await runCaptureLifecycle(h.report, h.io);
    expect(h.report.restorationVerified).toBe(false);
    expect(captureStatus(h.report)).toMatch(/^STATUS: FAILED – restoration not verified: connect ECONNREFUSED/);
    const md = captureMarkdown(h.report);
    expect(md).toMatch(/NOT verified/);
    expect(md).not.toMatch(/nothing was kept|verified by a fresh audit/);
  });

  it("an audit that finds leftovers fails the run", async () => {
    const h = harness({ audit: ['fixture state "rc-events=1" (before "rc-events=0")'] });
    await runCaptureLifecycle(h.report, h.io);
    expect(h.report.restorationVerified).toBe(false);
    expect(captureStatus(h.report)).toMatch(/^STATUS: FAILED – restoration: fixture state/);
  });

  it("an unverified run is never COMPLETE; partial outputs are saved during the run", async () => {
    const r = newCaptureReport("check", "rev", "t0");
    r.finishedAt = "t1";
    r.overhead = { offPerRowMs: 0.5, onPerRowMs: 0.6, deltaPerRowMs: 0.1, ratio: 1.2, rounds: 3 };
    expect(captureStatus(r)).toBe("STATUS: FAILED – restoration not verified");
    const h = harness();
    await runCaptureLifecycle(h.report, h.io);
    expect(h.saves.length).toBeGreaterThanOrEqual(2);
    expect(h.saves[0]).toMatch(/^STATUS: FAILED/);
  });

  it("the audit compares schema/ACL, capture role, source triggers and fixture state", () => {
    const base: StateSnapshot = { catalog: null, roleExists: false, triggers: "", fixtures: "rc-events=0;wc-events=0;rc-products=0;test-ledger=0;staging-stock=a:1;au-stock=x" };
    expect(compareSnapshots(base, { ...base })).toEqual([]);
    expect(compareSnapshots(base, { ...base, roleExists: true }).join()).toMatch(/reporting_capture role exists/);
    expect(compareSnapshots(base, { ...base, triggers: CAPTURE_TRIGGER }).join()).toMatch(/triggers/);
    expect(compareSnapshots(base, { ...base, catalog: { schema: "reporting_private" } as never }).join()).toMatch(/absent before, present after/);
    expect(compareSnapshots(base, { ...base, fixtures: base.fixtures.replace("staging-stock=a:1", "staging-stock=a:0") }).join()).toMatch(/fixture state/);
  });
});

describe("T12-5: supported-site journal with stock deduction, and event-ID changes", () => {
  const idx = (id: string) => CAPTURE_STEPS.findIndex((s) => s.id === id);

  it("a rolled-back au completion + deduction + idempotent retry with synthetic products, while capture is enabled", () => {
    const k = CAPTURE_STEPS.filter((s) => s.id.startsWith("k"));
    expect(k.map((s) => s.id)).toEqual(["k01", "k02", "k03", "k04", "k05", "k06", "k07"]);
    expect(k[0].group).toBe("begin");
    expect(k[5].group).toBe("end");
    expect(k[0].sql).toMatch(/'au', 'rc-sup-frame'/);
    expect(k.map((s) => s.sql).join()).not.toMatch(/stg-frame|stg-box|update public\.products/);
    expect(k[2].expect).toBe("ok:2:0");
    expect(k[3].expect).toBe("ok:0:2");
    expect(k[4].expect).toBe("rc-sup-box=4,rc-sup-frame=8;ledger=2");
    expect(k[5].expect).toBe("INSERT|/>au/rc-sup-done");
    expect(k[6].expect).toBe("0:0:0");
    expect(idx("k01")).toBeGreaterThan(idx("c01"));
    expect(idx("k07")).toBeLessThan(idx("e02"));
    expect(RUNNER).toMatch(/if \(s\.group === "begin"\) await client\.query\("savepoint rc_group"\)/);
    expect(RUNNER).toMatch(/if \(s\.group === "end"\) await client\.query\("rollback to savepoint rc_group"\)/);
  });

  it("an event-ID change keeps both old and new keys and images; wrong results are rejected", () => {
    expect(CAPTURE_STEPS[idx("c21")].sql).toMatch(/set id = 'rc-idnew'/);
    expect(CAPTURE_STEPS[idx("c22")].expect).toBe("UPDATE|au/rc-idold>au/rc-idnew:rc-idold>rc-idnew");
    expect(checkSteps(goodSteps())).toEqual([]);
    const lostOld = goodSteps().map((r) => (r.id === "c22" ? { ...r, result: "UPDATE|au/rc-idnew>au/rc-idnew:rc-idnew>rc-idnew" } : r));
    expect(checkSteps(lostOld).join()).toMatch(/c22/);
    const doubleDeduct = goodSteps().map((r) => (r.id === "k04" ? { ...r, result: "ok:2:0" } : r));
    expect(checkSteps(doubleDeduct).join()).toMatch(/k04/);
    const leftover = goodSteps().map((r) => (r.id === "k07" ? { ...r, result: "2:2:1" } : r));
    expect(checkSteps(leftover).join()).toMatch(/k07/);
  });
});
