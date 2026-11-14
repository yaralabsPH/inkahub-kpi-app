/**
 * Task 12 review fixes T12-2..T12-5 for the staging capture runner: the
 * immutable staging target at every query, no timeout override, run-specific
 * outputs with a fresh restoration audit after success AND failure, and the
 * supported-site journal + stock + event-ID-change steps.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CC_JOURNAL_SQL,
  concurrencyProbe,
  openGuardedClient,
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
const PURE = readFileSync("tests/staging/reportingCapture.ts", "utf8");
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
    expect(RUNNER).toMatch(/return openGuardedClient\(\(\) => new pg\.Client\(/);
    expect(RUNNER).not.toMatch(/\bpg\.Pool\b/);
    expect(RUNNER).toMatch(/const open = \(\) => openGuarded\(/);
  });
});

describe("T12-3: the runner never overrides a database timeout", () => {
  it("no statement/idle timeout override; only the concurrency probe's transaction-local lock_timeout; settings recorded", () => {
    expect(RUNNER).not.toMatch(/statement_timeout\s*:/);
    expect(RUNNER).not.toMatch(/set (local |session )?(statement_timeout|idle_in_transaction_session_timeout)/i);
    expect(RUNNER).not.toMatch(/set (local |session )?lock_timeout|lock_timeout\s*:/i);
    expect(PURE).not.toMatch(/statement_timeout\s*[:=]|set (local |session )?(statement_timeout|idle_in_transaction_session_timeout)/i);
    expect(PURE.match(/set local lock_timeout = '3s'/g)?.length).toBe(2);
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

// ---------------------------------------------------------------------------
// Focused runner integration fixes (planner checkpoint at a029bd2)
// ---------------------------------------------------------------------------

/** A pg-like client: connect/query/end, connection params, scripted failures and rows. */
class PgFake {
  sent: string[] = [];
  connected = false;
  ended = false;
  role = "postgres";
  host = TARGET.host;
  user = TARGET.user;
  constructor(private opts: { connectFails?: boolean; endFails?: boolean; failOn?: (sql: string, role: string) => Error | undefined; rows?: (sql: string) => Array<Record<string, unknown>> } = {}) {}
  async connect() {
    if (this.opts.connectFails) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    this.connected = true;
  }
  async query(sql: string) {
    this.sent.push(sql);
    if (sql === "reset role") this.role = "postgres";
    const m = /^set local role (\w+)$/.exec(sql);
    if (m) this.role = m[1];
    const e = this.opts.failOn?.(sql, this.role);
    if (e) throw e;
    return { rows: this.opts.rows?.(sql) ?? [] };
  }
  async end() {
    this.ended = true;
    if (this.opts.endFails) throw new Error("socket already closed");
  }
}

describe("openGuardedClient: a client that fails to connect or fails the marker is always closed", () => {
  const markerFails = async () => {
    throw new Error("Refusing to run: this database is not the staging project (no staging location/test users).");
  };

  it("marker failure after connect: the client is ended, the original error is rethrown", async () => {
    const c = new PgFake();
    await expect(openGuardedClient(() => c, TARGET, markerFails)).rejects.toThrow(/not the staging project/);
    expect(c.connected).toBe(true);
    expect(c.ended).toBe(true);
  });

  it("connect failure: the client is ended; the original error and its code survive", async () => {
    const c = new PgFake({ connectFails: true });
    const err = await openGuardedClient(() => c, TARGET, async () => {}).catch((e) => e);
    expect(err.message).toBe("connect ECONNREFUSED");
    expect(err.code).toBe("ECONNREFUSED");
    expect(c.ended).toBe(true);
  });

  it("a cleanup failure is kept as evidence next to the original error", async () => {
    const c = new PgFake({ endFails: true });
    await expect(openGuardedClient(() => c, TARGET, markerFails)).rejects.toThrow(/not the staging project.*; cleanup failed: disconnect: socket already closed/);
  });

  it("success returns the connected, guarded client (not ended); a wrong target never connects", async () => {
    const c = new PgFake();
    const g = await openGuardedClient(() => c, TARGET, async () => {});
    expect(c.connected && !c.ended).toBe(true);
    c.host = "db.other.supabase.co";
    await expect(g.query("select 1")).rejects.toThrow(/not connected to the staging target/);
    const wrong = new PgFake();
    wrong.host = "db.lkboboagiikvozvbcpvg.supabase.co";
    await expect(openGuardedClient(() => wrong, TARGET, async () => {})).rejects.toThrow(/not connected to the staging target/);
    expect(wrong.connected).toBe(false);
  });

  it("in the run lifecycle: a marker failure on the first connection ends it and the run fails, with the audit still attempted", async () => {
    const clients: PgFake[] = [];
    let calls = 0;
    const report = newCaptureReport("check", "rev", "t0");
    await runCaptureLifecycle(report, {
      open: () => openGuardedClient(() => (clients[clients.length] = new PgFake()), TARGET, async () => {
        if (calls++ === 0) await markerFails();
      }),
      body: async () => {},
      audit: async () => [],
      save: () => {},
      now: () => "t1",
      redact: (x) => x,
    });
    expect(clients).toHaveLength(2);
    expect(clients[0].ended).toBe(true);
    expect(clients[1].ended).toBe(true);
    expect(captureStatus(report)).toMatch(/^STATUS: FAILED – Refusing to run: this database is not the staging project/);
  });
});

describe("concurrencyProbe: the second connection resets its role before reading the private journal", () => {
  const enabledBefore: StateSnapshot = {
    catalog: {
      schema: "reporting_private", tables: [], functions: [], policies: [], role: null, memberOf: [], members: [], triggers: [], schemaPrivs: [], tablePrivs: [],
      functionExec: [], publicAcl: [], exposed: "", siteState: [], control: { capture_epoch: 2, capture_enabled: true, rule_version: "item-counting-summary-v1" },
    },
    roleExists: true,
    triggers: CAPTURE_TRIGGER,
    fixtures: "",
  };
  const become = async (c: PgFake, actor: string) => {
    await c.query("reset role");
    await c.query(`set local role ${actor === "staff" ? "authenticated" : actor}`);
  };
  // The journal is private: any read of it as `authenticated` is denied, as on staging.
  const denyJournalAsClient = (sql: string, role: string) => (sql === CC_JOURNAL_SQL && role !== "postgres" ? Object.assign(new Error("permission denied for schema reporting_private"), { code: "42501" }) : undefined);

  it("success: insert as staff, RESET ROLE, then read the journal; sees exactly its own row; rolled back", async () => {
    const a = new PgFake();
    const b = new PgFake({ failOn: denyJournalAsClient, rows: (sql) => (sql === CC_JOURNAL_SQL ? [{ n: 1 }] : []) });
    const report = newCaptureReport("concurrency", "rev", "t0");
    await concurrencyProbe(a, async () => b, enabledBefore, report, { staff: "s" }, {}, become as never);
    const insert = b.sent.findIndex((x) => x.includes("'rc-cc-b'"));
    const reset = b.sent.lastIndexOf("reset role");
    const read = b.sent.indexOf(CC_JOURNAL_SQL);
    expect(insert).toBeGreaterThan(0);
    expect(reset).toBeGreaterThan(insert);
    expect(read).toBeGreaterThan(reset);
    expect(b.sent.at(-1)).toBe("rollback");
    expect(b.ended).toBe(true);
    expect(report.concurrency).toMatchObject({ captureEnabledCommitted: true, secondError: null, journalRowsSeenBySecond: 1 });
    expect(report.concurrencyProblems).toEqual([]);
  });

  it("a failed second insert leaves the transaction aborted: no role reset or journal read, only ROLLBACK", async () => {
    const a = new PgFake();
    const b = new PgFake({ failOn: (sql) => (sql.includes("'rc-cc-b'") ? Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }) : undefined) });
    const report = newCaptureReport("concurrency", "rev", "t0");
    await concurrencyProbe(a, async () => b, enabledBefore, report, { staff: "s" }, {}, become as never);
    const insert = b.sent.findIndex((x) => x.includes("'rc-cc-b'"));
    expect(b.sent.slice(insert + 1)).toEqual(["rollback"]);
    expect(report.concurrency?.secondError).toBe("error 55P03");
    expect(report.concurrency?.journalRowsSeenBySecond).toBeNull();
    expect(report.concurrencyProblems.join()).toMatch(/55P03/);
    expect(b.ended).toBe(true);
  });

  it("a journal read that still fails is an error, never a silent -1", async () => {
    const a = new PgFake();
    const b = new PgFake({ failOn: (sql) => (sql === CC_JOURNAL_SQL ? Object.assign(new Error("permission denied"), { code: "42501" }) : undefined) });
    const report = newCaptureReport("concurrency", "rev", "t0");
    await expect(concurrencyProbe(a, async () => b, enabledBefore, report, { staff: "s" }, {}, become as never)).rejects.toThrow(/permission denied/);
    expect(b.sent.at(-1)).toBe("rollback");
    expect(b.ended).toBe(true);
  });
});

describe("Task 13: a failed disconnect of the second concurrency connection is reported", () => {
  it("records the cleanup failure and the run cannot be COMPLETE", async () => {
    const before: StateSnapshot = {
      catalog: {
        schema: "reporting_private", tables: [], functions: [], policies: [], role: null, memberOf: [], members: [], triggers: [], schemaPrivs: [], tablePrivs: [],
        functionExec: [], publicAcl: [], exposed: "", siteState: [], control: { capture_epoch: 2, capture_enabled: true, rule_version: "item-counting-summary-v1" },
      },
      roleExists: true,
      triggers: CAPTURE_TRIGGER,
      fixtures: "",
    };
    const a = new PgFake();
    const b = new PgFake({ endFails: true, rows: (sql) => (sql === CC_JOURNAL_SQL ? [{ n: 1 }] : []) });
    const report = newCaptureReport("concurrency", "rev", "t0");
    await concurrencyProbe(a, async () => b, before, report, { staff: "s" }, {}, (async (c: PgFake) => void (await c.query("set local role authenticated"))) as never);
    expect(report.errors).toEqual(["cleanup failed: second connection disconnect: socket already closed"]);
    report.finishedAt = "t1";
    report.restorationVerified = true;
    expect(captureStatus(report)).toMatch(/^STATUS: FAILED – cleanup failed: second connection disconnect/);
  });
});
