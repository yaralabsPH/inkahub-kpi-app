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
import { durableEvidence, I4_OWNER_SQL, I5_TERMINATE_SQL, I5_VICTIM_IDENTITY_SQL, i4Monitored, killOwnVictim, monitorBackends, newPublicationReport, publicationStatus, withConnections, zeroWorkRebuild, type Db, type InterleaveCtx } from "../staging/reportingPublication";

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

// ---------------------------------------------------------------------------
// T13B2b-23: a failed evidence save stops ALL normal work (also workers in progress)
// ---------------------------------------------------------------------------

describe("T13B2b-23: evidence persistence failure latches the run and gates every next statement", () => {
  /** A worker that holds its copy page until released, then would continue with freeze/seal/publish. */
  function rig(failKind: "i4-samples" | "i4-ownership") {
    const errors: string[] = [];
    const store: Array<Record<string, unknown>> = [];
    const holds: Array<() => void> = [];
    let savingFails = false;
    let releaseScheduled = false;
    const save = () => {
      const last = store.at(-1);
      // Deterministic: a sample save fails only once BOTH workers are held at an already-issued copy query.
      if (savingFails || (last?.kind === failKind && (failKind === "i4-ownership" || holds.length >= 2))) {
        savingFails = true;
        if (!releaseScheduled) {
          releaseScheduled = true;
          setTimeout(() => holds.splice(0).forEach((r) => r()), 5); // the outstanding queries complete AFTER the failed save
        }
        throw new Error("ENOSPC: no space left on device");
      }
    };
    const watch = newConnectionWatch(errors, (x) => x, () => undefined, () => undefined);
    const evidence = durableEvidence(store, save, watch, () => ({ run: "r1" }));
    const make = (n: number) => new FakePg({
      respond: (q) => {
        if (q === I4_OWNER_SQL) return [{ pid: 100 + n, backend_start: "2026-11-15 08:00:00.000001+00", xact_start: "2026-11-15 08:01:00.000002+00", transaction_timestamp: "2026-11-15 08:01:00.000002+00" }];
        if (q.includes("begin_reporting_rebuild")) return [{ batch_id: `b${n}`, lease_fence: 1 }];
        if (q.includes("copy_reporting_source_page")) return [{ complete: true, pages: 1, total_rows: 10 }]; // the worker would then freeze
        if (q.includes("pg_stat_activity")) return [{ pid: 101, state: "active", wait_event_type: null, wait_event: null, blocking: [], xact_ms: "1" }, { pid: 102, state: "active", wait_event_type: null, wait_event: null, blocking: [], xact_ms: "1" }];
        return [];
      },
    });
    const clients: FakePg[] = [];
    const open = async () => openGuardedClient(() => {
      const c = make(clients.length);
      // Hold every worker's copy page (an already-issued query) until the failed save has happened.
      const q = c.query.bind(c);
      c.query = ((sql: string, p?: unknown[]) => (sql.includes("copy_reporting_source_page") ? ((r) => new Promise((res) => holds.push(() => res(r))))(q(sql, p)) : q(sql, p))) as never;
      clients.push(c);
      return c;
    }, TARGET, marker, (s) => s, watch);
    const ctx: InterleaveCtx = {
      sites: ["uk", "us"], staff: "s", evidence, armTermination: watch.armTermination, open: open as never, as: async () => undefined, record: () => undefined, redact: (x) => x,
      now: () => 0, sleep: () => new Promise<void>((r) => setTimeout(r, 0)), maxPages: 5,
    };
    return { errors, store, watch, clients, ctx, open };
  }
  const later = (c: FakePg) => c.sent.filter((q) => /freeze_reporting_rebuild|seal_reporting_work|publish_reporting_batch/.test(q) || (q.includes("copy_reporting_source_page") && c.sent.filter((x) => x.includes("copy_reporting_source_page")).indexOf(q) > 0));

  it("a monitor-sample save fails while both workers are held at issued queries: the queries settle, NO freeze/seal/publish reaches either raw client, both jobs settle, FAILED with rollback/disconnect/fresh audit", async () => {
    const r = rig("i4-samples");
    const report = newPublicationReport("interleavings", ["uk", "us"], "rev", "t0", "sha");
    report.errors = r.errors;
    let i4: { ok: boolean; result: string } | null = null;
    let audited = false;
    await runCaptureLifecycle(report, {
      open: r.open as never,
      watch: r.watch,
      body: async () => {
        i4 = await withConnections(r.ctx, 3, async ([a, b, mon]) => i4Monitored(r.ctx, a, b, mon, (c, site) => zeroWorkRebuild(c, r.ctx, site)), report.cleanup);
      },
      audit: async () => ((audited = true), []),
      save: () => undefined,
      now: () => "t1",
      redact: (x) => x,
      stderr: () => undefined,
    });
    const workers = r.clients.slice(1, 3); // #1 main, #2/#3 workers, #4 monitor, #5 auditor
    for (const w of workers) {
      expect(w.sent.filter((q) => q.includes("copy_reporting_source_page"))).toHaveLength(1); // the held, already-issued query only
      expect(later(w)).toEqual([]);
      expect(w.sent.at(-1)).toBe("rollback"); // explicit cleanup still allowed
      expect(w.ended).toBe(true);
    }
    expect(i4!.ok).toBe(false);
    expect(i4!.result).toMatch(/^uk: run stopped after a connection failure; refusing new work \(evidence persistence failed \(i4-samples\): ENOSPC.*\); us: run stopped after a connection failure/);
    expect(r.errors[0]).toBe("evidence persistence failed (i4-samples): ENOSPC: no space left on device");
    expect(audited).toBe(true);
    expect(r.clients.at(-1)!.sent.length).toBeGreaterThan(0); // the fresh auditor opened (marker) in the cleanup phase
    report.observations.push({ id: "I4", what: "", expected: "", result: "", ok: false, ms: 0 });
    expect(publicationStatus(report)).toMatch(/^STATUS: FAILED – evidence persistence failed \(i4-samples\)/);
  });

  it("the pre-work ownership save failure: no rebuild SQL at all, the run is latched", async () => {
    const r = rig("i4-ownership");
    const a = await r.open();
    const b = await r.open();
    const mon = await r.open();
    await expect(i4Monitored(r.ctx, a as never, b as never, mon as never, (c, site) => zeroWorkRebuild(c, r.ctx, site))).rejects.toThrow("ENOSPC");
    for (const c of r.clients) expect(c.sent.some((q) => q.includes("begin_reporting_rebuild"))).toBe(false);
    expect(r.watch.failed()).toBe(true);
  });

  it("durableEvidence latches BEFORE rethrowing and does not persist again; a passing save does not latch", () => {
    const errors: string[] = [];
    const w = newConnectionWatch(errors, (x) => x, () => { throw new Error("must not be called"); }, () => undefined);
    const store: Array<Record<string, unknown>> = [];
    let ok = true;
    const ev = durableEvidence(store, () => { if (!ok) throw new Error("EIO"); }, w, () => ({ run: "r" }));
    ev({ kind: "a" });
    expect(w.failed()).toBe(false);
    ok = false;
    expect(() => ev({ kind: "b" })).toThrow("EIO");
    expect(errors).toEqual(["evidence persistence failed (b): EIO"]);
    expect(store.map((x) => x.kind)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// T13B2b-24: the pinned, receipted, intentional I5 termination
// ---------------------------------------------------------------------------

describe("T13B2b-24: the intentional I5 termination", () => {
  const follow = () => new Error("Connection terminated unexpectedly");
  const ID = { pid: 4242, backend_start: "2026-11-15 08:00:00.123456+00", xact_start: "2026-11-15 08:05:00.654321+00" };
  type Opt = { identity?: Record<string, unknown> | null; receipt?: Array<Record<string, unknown>>; during?: (v: FakePg) => void; atEnd?: Error[]; failAt?: "work" | "identity" | "kill"; saveFailsAt?: string };
  async function run(o: Opt = {}) {
    const errors: string[] = [];
    const store: Array<Record<string, unknown>> = [];
    const log: string[] = [];
    const watch = newConnectionWatch(errors, (x) => x, () => undefined, () => undefined);
    const evidence = durableEvidence(store, () => { const k = String(store.at(-1)?.kind); log.push(`save:${k}`); if (o.saveFailsAt === k) throw new Error("ENOSPC"); }, watch, () => ({ run: "r1" }));
    const v = new FakePg({
      respond: (q) => {
        log.push(`victim:${q === I5_VICTIM_IDENTITY_SQL ? "identity" : q}`);
        if (q === I5_VICTIM_IDENTITY_SQL) {
          if (o.failAt === "identity") return new Error("identity query failed");
          return o.identity === null ? [] : [o.identity ?? { ...ID, explicit_tx: true }];
        }
        return [];
      },
    });
    // pg end(): the terminated victim's error events fire, then end resolves
    v.end = async () => { v.ended = true; for (const e of o.atEnd ?? []) v.emit("error", e); };
    const victim = await openGuardedClient(() => v, TARGET, marker, (s) => s, watch);
    const kills: Array<{ q: string; p?: unknown[] }> = [];
    const mon: Db = { query: async (q: string, p?: unknown[]) => {
      if (q === I5_TERMINATE_SQL) {
        kills.push({ q, p });
        log.push("kill");
        if (o.failAt === "kill") throw new Error("monitor lost");
        o.during?.(v); // the installed-pg events can arrive BEFORE the kill response resolves
        const rows = o.receipt ?? [{ ...ID, k: true }];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    } };
    const cleanup: string[] = [];
    let thrown: unknown = null;
    let res: { terminated: boolean; expected: number } | null = null;
    try {
      res = await killOwnVictim(victim as never, mon, cleanup, { redact: (x) => x, sleep: async () => undefined, evidence, armTermination: watch.armTermination }, async () => {
        log.push("work");
        if (o.failAt === "work") throw new Error("rebuild failed");
        await victim.query("begin");
      });
    } catch (e) {
      thrown = e;
    }
    return { errors, store, log, watch, kills, cleanup, res, thrown, v };
  }
  const installedPgSequence = (v: FakePg) => { v.emit("error", terminated()); v.emit("error", follow()); };

  it("the installed-pg sequence (57P01, then the no-code follow-on) arriving BEFORE the kill response, with a matching receipt: expected, not a failure", async () => {
    const t = await run({ during: installedPgSequence });
    expect(t.res).toEqual({ terminated: true, expected: 2 });
    expect(t.watch.failed()).toBe(false);
    expect(t.errors).toEqual([]);
    expect(t.cleanup).toEqual([]);
    expect(t.v.ended).toBe(true);
  });

  it("the sequence at disconnect after the kill (events after the receipt) is also expected", async () => {
    const t = await run({ atEnd: [terminated(), follow()] });
    expect(t.res).toEqual({ terminated: true, expected: 2 });
    expect(t.watch.failed()).toBe(false);
  });

  it("identity is read INSIDE the open transaction AFTER work, persisted BEFORE the kill; the kill binds pid + backend_start + xact_start; the receipt is persisted", async () => {
    const t = await run({ during: installedPgSequence });
    const order = t.log.filter((l) => l === "work" || l === "victim:identity" || l.startsWith("save:") || l === "kill");
    expect(order).toEqual(["work", "victim:identity", "save:i5-victim-ownership", "kill", "save:i5-termination"]);
    expect(t.log.indexOf("victim:begin")).toBeLessThan(t.log.indexOf("victim:identity"));
    expect(t.kills).toEqual([{ q: I5_TERMINATE_SQL, p: [ID.pid, ID.backend_start, ID.xact_start] }]);
    expect(t.store[0]).toEqual({ run: "r1", kind: "i5-victim-ownership", scenario: "I5", victim: ID });
    expect(t.store[1]).toMatchObject({ kind: "i5-termination", requested: ID, receipt: [{ ...ID, k: true }], terminated: true });
  });

  const receiptFails: Array<[string, Array<Record<string, unknown>>]> = [
    ["false (k=false)", [{ ...ID, k: false }]],
    ["no matching row", []],
    ["another pid", [{ ...ID, pid: 4243, k: true }]],
    ["another backend_start", [{ ...ID, backend_start: "2026-11-15 08:00:00.123457+00", k: true }]],
    ["another xact_start", [{ ...ID, xact_start: "2026-11-15 09:00:00+00", k: true }]],
    ["two rows", [{ ...ID, k: true }, { ...ID, k: true }]],
  ];
  for (const [name, receipt] of receiptFails) {
    it(`a ${name} receipt fails I5 AND turns the provisional expected events into a sticky run failure`, async () => {
      const t = await run({ receipt, during: installedPgSequence });
      expect(t.res?.terminated).toBe(false);
      expect(t.watch.failed()).toBe(true);
      expect(t.errors.join("\n")).toMatch(/terminating connection due to administrator command \[57P01\] — expected only with a successful matching kill receipt, which is missing/);
    });
  }

  it("the follow-on BEFORE any 57P01 is unexpected", async () => {
    const t = await run({ during: (v) => { v.emit("error", follow()); v.emit("error", terminated()); } });
    expect(t.watch.failed()).toBe(true);
    expect(t.errors[0]).toBe("connection failure (connection #1): Connection terminated unexpectedly");
    expect(t.cleanup).toEqual(["victim connection error: Connection terminated unexpectedly"]);
  });

  it("a coded or differently worded follow-on, an ECONNRESET, or a 57P01 on another client are unexpected", async () => {
    const coded = Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
    for (const e of [coded, new Error("Connection terminated"), reset()]) {
      const t = await run({ during: (v) => { v.emit("error", terminated()); v.emit("error", e); } });
      expect(t.watch.failed(), e.message).toBe(true);
    }
    const errors: string[] = [];
    const w = newConnectionWatch(errors, (x) => x, () => undefined, () => undefined);
    const victim = w.attach(new FakePg());
    const other = w.attach(new FakePg());
    w.armTermination(victim);
    other.emit("error", terminated());
    expect(errors).toEqual(["connection failure (connection #2): terminating connection due to administrator command [57P01]"]);
  });

  it("missing or non-transactional identity is refused BEFORE any kill; nothing is armed", async () => {
    for (const identity of [null, { ...ID, explicit_tx: false }, { ...ID, xact_start: null, explicit_tx: true }, { ...ID, backend_start: null, explicit_tx: true }]) {
      const t = await run({ identity });
      expect(String((t.thrown as Error)?.message)).toMatch(/I5 victim: no open explicit transaction identity after work/);
      expect(t.kills).toEqual([]);
      expect(t.v.ended).toBe(true);
    }
  });

  it("failures during work / identity / ownership save / kill: no kill (or no receipt), the victim is still disconnected, and nothing is silently expected", async () => {
    for (const failAt of ["work", "identity", "kill"] as const) {
      const t = await run({ failAt, during: installedPgSequence });
      expect(t.thrown, failAt).toBeTruthy();
      expect(t.v.ended, failAt).toBe(true);
      if (failAt !== "kill") expect(t.kills, failAt).toEqual([]);
    }
    const s = await run({ saveFailsAt: "i5-victim-ownership" });
    expect(String((s.thrown as Error).message)).toBe("ENOSPC");
    expect(s.kills).toEqual([]); // never killed without a persisted ownership receipt
    expect(s.watch.failed()).toBe(true);
    const r = await run({ saveFailsAt: "i5-termination", during: installedPgSequence });
    expect(r.watch.failed()).toBe(true); // receipt not persisted: the provisional events are failures too
    expect(r.errors.join("\n")).toMatch(/which is missing/);
  });

  it("I5 refuses to run without a durable evidence sink or the run's watch", async () => {
    const v = new FakePg();
    await expect(killOwnVictim(v as never, { query: async () => ({ rows: [], rowCount: 0 }) }, [], { redact: (x) => x, sleep: async () => undefined }, async () => undefined)).rejects.toThrow(/needs durable evidence and the run's connection watch/);
  });

  it("classification is centralized: two listeners asking about the same event get one decision and one state advance", () => {
    const errors: string[] = [];
    const w = newConnectionWatch(errors, (x) => x, () => undefined, () => undefined);
    const c = w.attach(new FakePg());
    const armed = w.armTermination(c);
    const e57 = terminated();
    expect(armed.classify(e57)).toBe("expected");
    expect(armed.classify(e57)).toBe("expected");
    expect(armed.expected()).toBe(1);
    const f = follow();
    expect(armed.classify(f)).toBe("expected");
    expect(armed.classify(f)).toBe("expected");
    expect(armed.expected()).toBe(2);
    expect(() => w.armTermination(c)).toThrow(/already armed/);
    expect(() => w.armTermination(new FakePg())).toThrow(/does not own/);
  });

  it("without arming, even a 57P01 is a failure (never a global exemption)", () => {
    const errors: string[] = [];
    const w: ConnectionWatch = newConnectionWatch(errors, (x) => x, () => undefined, () => undefined);
    const c = w.attach(new FakePg());
    c.emit("error", terminated());
    expect(w.failed()).toBe(true);
  });
});
