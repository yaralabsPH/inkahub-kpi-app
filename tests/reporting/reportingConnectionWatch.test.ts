/**
 * T13B2b-22: run-scoped connection failure handling, OFFLINE, with
 * EventEmitter clients that behave like node-postgres (an error event rejects
 * outstanding queries AND is emitted; with no listener, emit throws).
 * Through the REAL opener (openGuardedClient), guard, lifecycle
 * (runCaptureLifecycle) and I4/I5 helpers. No database.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { newConnectionWatch, openGuardedClient, runCaptureLifecycle, STAGING_PROJECT_REF, stagingTarget, type ConnectionWatch } from "../staging/reportingCapture";
import { I4_OWNER_SQL, i4Monitored, isExpectedTermination, killOwnVictim, monitorBackends, newPublicationReport, publicationStatus, type Db, type InterleaveCtx } from "../staging/reportingPublication";

const TARGET = stagingTarget(`postgresql://postgres.${STAGING_PROJECT_REF}:pw@aws-0-region.pooler.supabase.com:5432/postgres`);
const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", errno: -4077 });
const terminated = () => Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });

/** A pg-like client: error events reject pending queries, then emit 'error'. */
class FakePg extends EventEmitter {
  host = TARGET.host;
  user = TARGET.user;
  sent: string[] = [];
  dead = false;
  ended = false;
  private pending: Array<(e: unknown) => void> = [];
  constructor(private opts: { onConnect?: (c: FakePg) => void; respond?: (sql: string, params?: unknown[]) => unknown; hang?: (sql: string) => boolean; endFails?: boolean } = {}) {
    super();
  }
  async connect() {
    this.opts.onConnect?.(this);
  }
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    this.sent.push(sql);
    if (this.dead) return Promise.reject(new Error("Client was closed and is not queryable"));
    if (this.opts.hang?.(sql)) return new Promise((_, reject) => this.pending.push(reject));
    const r = this.opts.respond?.(sql, params);
    if (r instanceof Error) return Promise.reject(r);
    const rows = (r as Array<Record<string, unknown>> | undefined) ?? [];
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  async end() {
    this.ended = true;
    if (this.opts.endFails) throw new Error("socket already closed");
  }
  /** What node-postgres does in _handleErrorEvent: reject the outstanding queries, then emit. */
  fail(e: Error): void {
    this.dead = true;
    for (const r of this.pending.splice(0)) r(e);
    this.emit("error", e);
  }
}

const marker = async (c: { query(sql: string): Promise<unknown> }) => void (await c.query("select 1 as marker"));

function setup(over: { save?: () => void; make?: (n: number) => FakePg } = {}) {
  const errors: string[] = [];
  const clients: FakePg[] = [];
  const save = over.save ?? (() => undefined);
  const watch = newConnectionWatch(errors, (s) => s.replace(/pw/g, "***"), save, () => undefined);
  const open = async () => openGuardedClient(() => {
    const c = over.make?.(clients.length) ?? new FakePg();
    clients.push(c);
    return c;
  }, TARGET, marker, (s) => s, watch);
  return { errors, clients, watch, open };
}

describe("T13B2b-22: a pg-like error event without a listener would crash the process (the bug)", () => {
  it("EventEmitter.emit('error') with no listener throws synchronously (outside every promise try/finally)", () => {
    const c = new FakePg();
    expect(() => c.fail(reset())).toThrow("read ECONNRESET");
  });
});

describe("T13B2b-22: the watch", () => {
  it("the listener is installed BEFORE connect: an error during connect is recorded, never thrown", async () => {
    const s = setup({ make: () => new FakePg({ onConnect: (c) => c.fail(reset()) }) });
    // connect itself resolves in this fake; the marker query then fails on the dead client and the opener closes it.
    await expect(s.open()).rejects.toThrow(/run stopped after a connection failure/); // the marker is refused before sending
    expect(s.clients[0].sent).toEqual([]);
    expect(s.errors).toEqual(["connection failure (connection #1): read ECONNRESET [ECONNRESET]"]);
    expect(s.watch.failed()).toBe(true);
    expect(s.clients[0].ended).toBe(true);
  });

  it("an idle connection's error is sticky in the report store and persisted at once; emit never throws", () => {
    const saves: number[] = [];
    const errors: string[] = [];
    const w = newConnectionWatch(errors, (x) => x, () => void saves.push(errors.length), () => undefined);
    const c = w.attach(new FakePg());
    expect(() => c.fail(reset())).not.toThrow();
    expect(errors).toEqual(["connection failure (connection #1): read ECONNRESET [ECONNRESET]"]);
    expect(saves).toEqual([1]); // persisted with the error already in the store
    expect(w.first()).toBe(errors[0]);
  });

  it("a persistence failure inside the listener is retained, not re-thrown as another unhandled exception", () => {
    const errors: string[] = [];
    const out: string[] = [];
    const w = newConnectionWatch(errors, (x) => x, () => { throw new Error("ENOSPC"); }, (t) => void out.push(t));
    const c = w.attach(new FakePg());
    expect(() => c.fail(reset())).not.toThrow();
    expect(errors).toEqual(["connection failure (connection #1): read ECONNRESET [ECONNRESET]", "report persistence failed (after a connection failure): ENOSPC"]);
    expect(out).toEqual(["connection failure (connection #1): read ECONNRESET [ECONNRESET]"]); // also on stderr
  });

  it("after a failure, NEW normal SQL is refused before sending on every client (also new ones); ROLLBACK is allowed; the cleanup phase allows the audit", async () => {
    const s = setup();
    const a = await s.open();
    const b = await s.open();
    s.clients[0].fail(reset());
    const before = s.clients[1].sent.length;
    await expect(b.query("select * from public.begin_reporting_rebuild($1)", ["uk"])).rejects.toThrow(/run stopped after a connection failure; refusing new work \(connection failure \(connection #1\): read ECONNRESET/);
    expect(s.clients[1].sent.length).toBe(before); // not sent
    await expect(s.open()).rejects.toThrow(/run stopped after a connection failure/); // a new normal connection cannot even pass its marker
    await b.query("rollback"); // explicit cleanup of an open transaction
    await b.query("  ROLLBACK");
    expect(s.clients[1].sent.slice(-2)).toEqual(["rollback", "  ROLLBACK"]);
    s.watch.phase("cleanup");
    const auditor = await s.open();
    await auditor.query("select 1");
    void a;
  });

  it("I5's expected termination is armed for ONE client only; an unexpected reset on that client, or 57P01 elsewhere, still fails", () => {
    const errors: string[] = [];
    const w = newConnectionWatch(errors, (x) => x, () => undefined, () => undefined);
    const victim = w.attach(new FakePg());
    const other = w.attach(new FakePg());
    const seen = w.armExpected(victim, isExpectedTermination);
    victim.emit("error", terminated());
    expect(seen()).toBe(1);
    expect(w.failed()).toBe(false);
    other.emit("error", terminated());
    expect(errors).toEqual(["connection failure (connection #2): terminating connection due to administrator command [57P01]"]);
    victim.emit("error", reset());
    expect(errors.at(-1)).toBe("connection failure (connection #1): read ECONNRESET [ECONNRESET]");
    expect(() => w.armExpected(new FakePg(), isExpectedTermination)).toThrow(/does not own/);
  });

  it("even if recording itself throws (e.g. redaction), the listener never throws and the run is still failed", () => {
    const errors: string[] = [];
    const w = newConnectionWatch(errors, () => { throw new Error("redactor broke"); }, () => undefined, () => undefined);
    const c = w.attach(new FakePg());
    expect(() => c.emit("error", reset())).not.toThrow();
    expect(w.failed()).toBe(true);
    expect(errors).toEqual(["connection failure (unrecordable event)"]);
  });

  it("a client that cannot report errors is refused (no silent opener)", () => {
    const w = newConnectionWatch([], (x) => x, () => undefined);
    expect(() => w.attach({ query: async () => ({ rows: [] }) })).toThrow(/cannot report connection errors/);
  });
});

// ---------------------------------------------------------------------------
// Through the actual lifecycle: idle main, active worker, monitor, rollback/end, auditor
// ---------------------------------------------------------------------------

async function lifecycle(s: ReturnType<typeof setup>, body: (main: Db) => Promise<void>, audit: (c: Db) => Promise<string[]> = async () => []) {
  const report = newPublicationReport("interleavings", ["uk", "us"], "rev", "t0", "sha");
  report.errors = s.errors; // the watch writes into the report's own store (as the runner wires it)
  let audited = false;
  await runCaptureLifecycle(report, {
    open: s.open as never,
    watch: s.watch,
    body: async (main) => body(main as unknown as Db),
    audit: async (c) => ((audited = true), audit(c as unknown as Db)),
    save: () => undefined,
    now: () => "t1",
    redact: (x) => x,
    stderr: () => undefined,
  });
  report.observations.push({ id: "I0", what: "", expected: "", result: "", ok: true, ms: 0 }); // status needs one observation
  return { report, audited, status: publicationStatus(report) };
}

describe("T13B2b-22: the lifecycle after a connection failure", () => {
  it("IDLE main resets while a worker runs: the worker's next statement is refused, the run stops, main is rolled back/closed, the fresh audit still runs, FAILED", async () => {
    const s = setup();
    const ran: string[] = [];
    const r = await lifecycle(s, async (main) => {
      const worker = await s.open();
      await worker.query("begin");
      s.clients[0].fail(reset()); // main (connection #1) is idle
      ran.push("before next scenario");
      await worker.query("select * from public.begin_reporting_rebuild($1)", ["uk"]); // refused
      ran.push("after (must not run)");
      void main;
    });
    expect(ran).toEqual(["before next scenario"]);
    expect(r.audited).toBe(true);
    expect(s.clients[1].sent).not.toContain("select * from public.begin_reporting_rebuild($1)");
    expect(s.clients[0].ended).toBe(true);
    expect(s.errors[0]).toBe("connection failure (connection #1): read ECONNRESET [ECONNRESET]");
    expect(s.errors.some((e) => /run stopped after a connection failure/.test(e))).toBe(true); // the body's refusal
    expect(s.errors.some((e) => /cleanup failed: rollback: Client was closed/.test(e))).toBe(true); // main's rollback on the dead client, kept
    expect(r.status).toMatch(/^STATUS: FAILED – connection failure \(connection #1\): read ECONNRESET/);
  });

  it("an ACTIVE worker resets mid-query: its pending query settles (rejected), no later normal SQL, all errors kept", async () => {
    const s = setup({ make: (n) => new FakePg({ hang: (q) => n === 1 && q.startsWith("select * from public.publish_reporting_batch") }) });
    let outcome = "";
    const r = await lifecycle(s, async () => {
      const worker = await s.open();
      const p = worker.query("select * from public.publish_reporting_batch($1, $2)", ["b", 1]).then(() => "resolved", (e: Error) => `rejected: ${e.message}`);
      s.clients[1].fail(reset());
      outcome = await p; // settled, not abandoned
      await worker.query("select 1"); // refused
    });
    expect(outcome).toBe("rejected: read ECONNRESET");
    expect(s.clients[1].sent).not.toContain("select 1"); // the scenario's next statement was refused before sending
    expect(r.status).toMatch(/^STATUS: FAILED – connection failure \(connection #2\)/);
    expect(r.audited).toBe(true);
  });

  it("a MONITOR reset: sampling stops (monitor failed), both jobs settle, the next normal statement is refused", async () => {
    const s = setup({ make: (n) => new FakePg({ hang: (q) => n === 1 && q.includes("pg_stat_activity") }) });
    let settledBoth = false;
    const r = await lifecycle(s, async () => {
      const mon = await s.open();
      let release!: () => void;
      const job = new Promise<string>((res) => (release = () => res("done")));
      const ctx = { sleep: async () => undefined, now: () => 0, redact: (x: string) => x };
      const p = monitorBackends(mon, [1, 2], [job, Promise.resolve("ok")], ctx);
      await Promise.resolve();
      s.clients[1].fail(reset());
      setTimeout(release, 5);
      const m = await p;
      settledBoth = m.outcomes.length === 2 && m.outcomes.every((o) => o.ok);
      expect(m.monitorError).toBe("monitor failed: read ECONNRESET");
      await mon.query("select 2");
    });
    expect(settledBoth).toBe(true);
    expect(s.clients[1].sent).not.toContain("select 2");
    expect(r.status).toMatch(/^STATUS: FAILED/);
  });

  it("rollback/disconnect failures after the reset are kept beside the original error", async () => {
    const s = setup({ make: (n) => new FakePg({ endFails: n === 0 }) });
    const r = await lifecycle(s, async () => { s.clients[0].fail(reset()); throw new Error("scenario stopped"); });
    expect(s.errors[0]).toMatch(/^connection failure \(connection #1\): read ECONNRESET/);
    expect(s.errors).toEqual(expect.arrayContaining(["scenario stopped", "cleanup failed: rollback: Client was closed and is not queryable", "cleanup failed: disconnect: socket already closed"]));
    expect(r.audited).toBe(true);
  });

  it("an AUDITOR reset during the fresh audit is recorded; restoration is NOT verified; FAILED", async () => {
    const s = setup({ make: (n) => new FakePg({ hang: (q) => n === 1 && q === "select * from state" }) });
    const r = await lifecycle(s, async () => undefined, async (c) => {
      const p = c.query("select * from state");
      s.clients[1].fail(reset());
      await p;
      return [];
    });
    expect(s.errors).toEqual(expect.arrayContaining(["connection failure (connection #2): read ECONNRESET [ECONNRESET]", "restoration not verified: read ECONNRESET"]));
    expect(r.report.restorationVerified).toBe(false);
    expect(r.status).toMatch(/^STATUS: FAILED/);
  });

  it("a clean run stays COMPLETE (the listener adds nothing)", async () => {
    const s = setup();
    const r = await lifecycle(s, async (main) => void (await main.query("select 1")));
    expect(s.errors).toEqual([]);
    expect(r.status).toBe("STATUS: COMPLETE");
  });
});

// ---------------------------------------------------------------------------
// I4 ownership and incremental evidence; I5 victim
// ---------------------------------------------------------------------------

describe("T13B2b-22: I4 durable evidence", () => {
  const worker = (pid: number, log: string[], name: string): Db => ({
    query: async (q: string) => {
      log.push(`${name}:${q === I4_OWNER_SQL ? "owner" : q}`);
      return q === I4_OWNER_SQL ? { rows: [{ pid, backend_start: "2026-11-15 07:44:05.123456+00", xact_start: "2026-11-15 07:50:00.000001+00", transaction_timestamp: "2026-11-15 07:50:00.000001+00" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    },
  });
  const ctxWith = (evidence: (e: Record<string, unknown>) => void, log: string[]): InterleaveCtx => ({
    sites: ["uk", "us"], staff: "s", evidence: (e) => { log.push(`evidence:${String(e.kind)}`); evidence(e); }, open: async () => { throw new Error("unused"); }, as: async () => undefined, record: () => undefined, redact: (x) => x, now: () => 0, sleep: () => new Promise<void>((r) => setTimeout(r, 0)), maxPages: 1,
  });

  it("both workers' pid/backend_start/xact_start are persisted (lossless strings) BEFORE any rebuild work; samples are persisted per poll before I4 returns", async () => {
    const log: string[] = [];
    const saved: Array<Record<string, unknown>> = [];
    let polls = 0;
    const jobs: Array<(v: string) => void> = [];
    const mon: Db = { query: async () => { polls++; log.push(`mon:sample${polls}`); if (polls === 2) jobs.forEach((j) => j("ok")); return { rows: [{ pid: 101, state: "active", wait_event_type: null, wait_event: null, blocking: [], xact_ms: "1" }, { pid: 202, state: "active", wait_event_type: null, wait_event: null, blocking: [], xact_ms: "1" }], rowCount: 2 }; } };
    const r = await i4Monitored(ctxWith((e) => void saved.push(JSON.parse(JSON.stringify(e))), log), worker(101, log, "a"), worker(202, log, "b"), mon, () => {
      log.push("work started");
      return new Promise<string>((res) => void jobs.push(res));
    }, { maxSamples: 50 }).then((x) => (log.push("I4 returned"), x));
    void r;
    expect(log.slice(0, 7)).toEqual(["a:begin", "b:begin", "a:owner", "b:owner", "evidence:i4-ownership", "work started", "work started"]);
    expect(saved[0]).toEqual({ kind: "i4-ownership", workers: [
      { site: "uk", session: "worker-a", pid: 101, backend_start: "2026-11-15 07:44:05.123456+00", xact_start: "2026-11-15 07:50:00.000001+00", transaction_timestamp: "2026-11-15 07:50:00.000001+00" },
      { site: "us", session: "worker-b", pid: 202, backend_start: "2026-11-15 07:44:05.123456+00", xact_start: "2026-11-15 07:50:00.000001+00", transaction_timestamp: "2026-11-15 07:50:00.000001+00" },
    ] });
    const sampleSaves = log.filter((l) => l === "evidence:i4-samples").length;
    expect(sampleSaves).toBe(polls);
    expect(log.lastIndexOf("evidence:i4-samples")).toBeLessThan(log.indexOf("I4 returned"));
    expect(I4_OWNER_SQL).not.toMatch(/application_name/);
  });

  it("an ownership persistence failure stops BEFORE any rebuild work", async () => {
    const log: string[] = [];
    let started = 0;
    await expect(i4Monitored(ctxWith(() => { throw new Error("ENOSPC"); }, log), worker(1, log, "a"), worker(2, log, "b"), { query: async () => ({ rows: [], rowCount: 0 }) }, () => { started++; return Promise.resolve(); })).rejects.toThrow("ENOSPC");
    expect(started).toBe(0);
  });

  it("a sample persistence failure is a sticky monitor failure; both jobs still settle; I4 fails", async () => {
    const log: string[] = [];
    let n = 0;
    const mon: Db = { query: async () => ({ rows: [{ pid: 1, state: "active", wait_event_type: null, wait_event: null, blocking: [], xact_ms: "1" }, { pid: 2, state: "active", wait_event_type: null, wait_event: null, blocking: [], xact_ms: "1" }], rowCount: 2 }) };
    const r = await i4Monitored(ctxWith((e) => { if (e.kind === "i4-samples" && ++n === 1) throw new Error("ENOSPC"); }, log), worker(1, log, "a"), worker(2, log, "b"), mon, () => new Promise((res) => setTimeout(() => res("ok"), 5)));
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/^uk: published; us: published; monitor: .*"monitorError":"monitor evidence persistence failed: ENOSPC"/);
  });

  it("I4 refuses to run without a durable evidence sink (no silent missing receipts)", async () => {
    const ctx = { ...ctxWith(() => undefined, []), evidence: undefined };
    await expect(i4Monitored(ctx, worker(1, [], "a"), worker(2, [], "b"), { query: async () => ({ rows: [], rowCount: 0 }) }, () => Promise.resolve())).rejects.toThrow(/I4 needs durable evidence persistence/);
  });
});

describe("T13B2b-22: I5's victim through the watch", () => {
  const victimDb = () => new FakePg({ respond: (q) => (q.startsWith("select pg_backend_pid()") ? [{ p: 9, t: "rp-victim" }] : []) });
  it("the victim's intentional 57P01 is expected (armed right before termination); the run is not failed", async () => {
    const s = setup({ make: victimDb });
    const victim = await s.open();
    const mon: Db = { query: async (q: string) => {
      if (q.includes("pg_terminate_backend")) { (s.clients[0] as FakePg).emit("error", terminated()); return { rows: [{ k: true }], rowCount: 1 }; }
      return { rows: [{ p: 9 }], rowCount: 1 };
    } };
    const cleanup: string[] = [];
    const k = await killOwnVictim(victim as never, mon, cleanup, { redact: (x) => x, sleep: async () => undefined, armExpected: s.watch.armExpected }, async () => undefined);
    expect(k.terminated).toBe(true);
    expect(s.watch.failed()).toBe(false);
    expect(s.errors).toEqual([]);
  });

  it("an UNEXPECTED reset of the victim before its termination is armed fails the run", async () => {
    const s = setup({ make: victimDb });
    const victim = await s.open();
    const cleanup: string[] = [];
    await killOwnVictim(victim as never, { query: async () => ({ rows: [{ k: false }], rowCount: 1 }) }, cleanup, { redact: (x) => x, sleep: async () => undefined, armExpected: s.watch.armExpected }, async () => { (s.clients[0] as FakePg).emit("error", reset()); });
    expect(s.watch.failed()).toBe(true);
    expect(s.errors[0]).toBe("connection failure (connection #1): read ECONNRESET [ECONNRESET]");
  });

  it("without arming, even a 57P01 is a failure (never a global exemption)", () => {
    const errors: string[] = [];
    const w: ConnectionWatch = newConnectionWatch(errors, (x) => x, () => undefined, () => undefined);
    const c = w.attach(new FakePg());
    c.emit("error", terminated());
    expect(w.failed()).toBe(true);
  });
});
