/**
 * Task 13 Part B2b staging runner (tests/staging/reportingPublication.ts and
 * its modes in tests/staging/reporting-jobs.ts), without a database: argument
 * guards, migration-body stripping, savepoint/rollback discipline, error
 * fidelity, status/cleanup accounting, the fixture's expected daily answer,
 * and source-text guards (nothing commits, no timeout is changed).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPORTING_RULE_VERSION } from "../../src/lib/domain/productionReporting";
import { projectReportingPartition } from "../../src/lib/domain/productionReportingProjection";
import { RESULT_TABLES, resultRowProblem } from "../../api/_lib/reporting-stage";
import { rowsByOwner } from "../fixtures/reporting-rows";
import {
  compareFullState,
  STATE_QUERIES,
  isTransactionControl,
  leadingKeywords,
  killOwnVictim,
  ROLLBACK_ONLY,
  type FullState,
  expectEqual,
  fixtureRows,
  migrationBody,
  MIGRATION_0038,
  newPublicationReport,
  parsePublicationArgs,
  publicationMarkdown,
  publicationStatus,
  reducerDaily,
  refused,
  rpc,
  step,
  withConnections,
  WS_ID,
  type Db,
  type FlowCtx,
  type Observation,
} from "../staging/reportingPublication";

const STAFF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fakeDb(fail: (sql: string) => Error | null = () => null) {
  const sent: string[] = [];
  let aborted = false;
  const db: Db & { end(): Promise<void> } = {
    async query(sql: string) {
      sent.push(sql);
      if (aborted && !/^rollback/i.test(sql)) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      if (/^rollback to savepoint/i.test(sql)) aborted = false;
      const e = fail(sql);
      if (e) {
        aborted = true;
        throw e;
      }
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    async end() {},
  };
  return { db, sent };
}
function ctxFor(obs: Observation[]): FlowCtx {
  return {
    sites: ["uk", "au"], maxPages: 5, staff: STAFF,
    as: async (c, service) => void (await c.query(service ? "set local role service_role" : "reset role")),
    record: (o) => obs.push(o), redact: (s) => s, now: () => 0,
  };
}

describe("arguments and the migration body", () => {
  it("needs exactly one mode and two different supported sites; bounds the copy page cap", () => {
    expect(parsePublicationArgs(["--rehearse-migration", "--sites=uk,au"])).toMatchObject({ mode: "rehearse-migration", sites: ["uk", "au"], maxPages: 200, problems: [] });
    expect(parsePublicationArgs(["--check-installed", "--sites=us,uk", "--max-pages=50"]).maxPages).toBe(50);
    for (const bad of [[], ["--rehearse-migration"], ["--rehearse-migration", "--check-installed", "--sites=uk,au"], ["--interleavings", "--sites=uk,uk"], ["--interleavings", "--sites=uk,staging"], ["--interleavings", "--sites=uk,au", "--max-pages=0"], ["--interleavings", "--sites=uk,au", "--commit"]]) {
      expect(parsePublicationArgs(bad).mode, bad.join(" ")).toBeNull();
    }
  });

  it("strips exactly the draft's own BEGIN/COMMIT and refuses any other transaction control", () => {
    const body = migrationBody(readFileSync(MIGRATION_0038, "utf8"));
    expect(body.length).toBeGreaterThan(100);
    for (const s of body) expect(s.replace(/--[^\n]*/g, " ").trim()).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK)\b/i);
    expect(() => migrationBody("CREATE TABLE x (a int);")).toThrow(/one BEGIN … COMMIT/);
    expect(() => migrationBody("BEGIN;\nCREATE TABLE x (a int);\nCOMMIT;\nCREATE TABLE y (a int);\nCOMMIT;")).toThrow(/transaction control inside/);
    expect(() => migrationBody("BEGIN;\nSAVEPOINT s;\nCOMMIT;")).toThrow(/transaction control inside/);
    expect(migrationBody("BEGIN;\nCREATE TABLE x (a int);\nCOMMIT;")).toHaveLength(1);
  });
});

describe("flow primitives", () => {
  it("refused(): savepoint, observe the database error, roll back to the savepoint; a success is NOT a pass", async () => {
    const obs: Observation[] = [];
    const { db, sent } = fakeDb((sql) => (sql.startsWith("select bad") ? Object.assign(new Error("stage: work 3: event_facts[1]: event_facts.role must be one of verification"), { code: "P0001" }) : null));
    await refused(db, ctxFor(obs), "X", "null role", /role must be one of/, () => rpc(db, ctxFor(obs), "select bad", []));
    await refused(db, ctxFor(obs), "Y", "should fail", /anything/, () => rpc(db, ctxFor(obs), "select good", []));
    expect(obs.map((o) => [o.id, o.ok])).toEqual([["X", true], ["Y", false]]);
    expect(obs[0].result).toBe("P0001 stage: work 3: event_facts[1]: event_facts.role must be one of verification");
    // After the failed RPC nothing else is sent before the savepoint rollback (the error is never masked).
    const i = sent.indexOf("select bad");
    expect(sent[i + 1]).toBe("rollback to savepoint rp_probe");
    expect(sent.filter((s) => s === "savepoint rp_probe")).toHaveLength(2);
    expect(sent.filter((s) => s === "release savepoint rp_probe")).toHaveLength(2);
  });

  it("step(): records success, records the failure and stops the flow; expectEqual compares exactly", async () => {
    const obs: Observation[] = [];
    const ctx = ctxFor(obs);
    expect(await step(fakeDb().db, ctx, "A", "ok", async () => 5, (n) => `n=${n}`)).toBe(5);
    await expect(step(fakeDb().db, ctx, "B", "boom", async () => { throw new Error("x"); })).rejects.toThrow(/B failed/);
    expect(expectEqual(ctx, "C", "eq", { a: 1 }, { a: 1 })).toBe(true);
    expect(expectEqual(ctx, "D", "ne", [1], [2])).toBe(false);
    expect(obs.map((o) => [o.id, o.ok, o.result])).toEqual([["A", true, "n=5"], ["B", false, "x"], ["C", true, '{"a":1}'], ["D", false, "[1]"]]);
  });

  it("withConnections(): every connection is rolled back and ended; every cleanup failure is kept; the scenario error still surfaces", async () => {
    const ended: number[] = [];
    let n = 0;
    const open = async () => {
      const id = ++n;
      return { query: async (sql: string) => { if (sql === "rollback" && id === 2) throw new Error("socket closed"); return { rows: [], rowCount: 0 }; }, end: async () => { ended.push(id); if (id === 3) throw new Error("end failed"); } };
    };
    const cleanup: string[] = [];
    await expect(withConnections({ open }, 3, async () => { throw new Error("scenario failed"); }, cleanup)).rejects.toThrow("scenario failed");
    expect(ended).toEqual([1, 2, 3]);
    expect(cleanup).toEqual(["scenario connection rollback: socket closed", "scenario connection disconnect: end failed"]);
  });
});

describe("report and status", () => {
  const base = () => {
    const r = newPublicationReport("rehearse-migration", ["uk", "au"], "abc1234", "2026-11-15T00:00:00Z", "f".repeat(64));
    r.observations.push({ id: "P2", what: "publish", expected: "succeeds", result: "ok", ok: true, ms: 3 });
    r.finishedAt = "2026-11-15T00:01:00Z";
    r.restorationVerified = true;
    return r;
  };
  it("COMPLETE only with every observation ok, no error or cleanup failure and a verified restoration; exactly one STATUS line ends the report", () => {
    expect(publicationStatus(base())).toBe("STATUS: COMPLETE");
    const md = publicationMarkdown(base());
    expect(md.trimEnd().split("\n").at(-1)).toBe("STATUS: COMPLETE");
    expect(md.match(/^STATUS: /gm)).toHaveLength(1);
    expect(md).toContain("0038 draft SHA-256: ffff");
    const bad = base();
    bad.observations.push({ id: "B2a-1b", what: "calendar", expected: "refused", result: "succeeded (expected a refusal)", ok: false, ms: 1 });
    expect(publicationStatus(bad)).toMatch(/^STATUS: FAILED – B2a-1b calendar/);
    const cl = base();
    cl.cleanup.push("scenario connection disconnect: end failed");
    expect(publicationStatus(cl)).toMatch(/^STATUS: FAILED – cleanup failed: scenario connection disconnect/);
    const nr = base();
    nr.restorationVerified = null;
    expect(publicationStatus(nr)).toMatch(/restoration not verified/);
    const empty = base();
    empty.observations = [];
    expect(publicationStatus(empty)).toMatch(/no observation was recorded/);
  });
});

describe("the fixture and its expected daily answer", () => {
  it("projects to valid staged rows in three owners (RP-1 with the whitespace-id source issue, event rp-x1, RP-M)", () => {
    const events = fixtureRows(STAFF).map((x) => ({ ...x, location: "uk", cs_case_id: null })) as never[];
    const r = projectReportingPartition({ site: "uk", audience: { kind: "site" }, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: "2026-11-15T00:00:00Z", events });
    const owners = [...rowsByOwner(r).values()];
    expect(owners.map((o) => `${o.owner.partitionKind}:${o.owner.partitionKey}`).sort()).toEqual(["event:rp-x1", "order:RP-1", "order:RP-9", "order:RP-M"]);
    // T13B2b-2: all five families are non-empty in the fixture.
    const all = (t: (typeof RESULT_TABLES)[number]) => owners.flatMap((o) => o.rows[t]);
    for (const t of RESULT_TABLES) expect(all(t).length, t).toBeGreaterThan(0);
    expect(all("order_occurrences").map((x) => x.terminal_event_id).sort()).toEqual(["rp-t1", "rp-t9"]);
    expect(all("timing_facts").map((x) => x.event_id).sort()).toEqual(["rp-m1", "rp-v1", "rp-v5", "rp-v9"]); // rp-v2 (hook) is not a timing-stream line; rp-v3 is cancelled
    const rp1 = owners.find((o) => o.owner.partitionKey === "RP-1")!.rows;
    expect(rp1.source_issue_facts.map((x) => x.event_id)).toEqual([WS_ID]);
    expect(rp1.cancel_edges).toMatchObject([{ cancel_event_id: "rp-c3", parent_event_id: "rp-v3", parent_role: "verification", pair: "valid" }]);
    for (const o of owners) for (const t of RESULT_TABLES) for (const row of o.rows[t]) expect(resultRowProblem(t, row), `${t} ${String(row.event_id ?? row.cancel_event_id)}`).toBeNull();
  });

  it("reducer daily: excluded and unclassified lines are lines with zero Items; the cancelled line is gone", () => {
    const events = fixtureRows(STAFF).map((x) => ({ ...x, location: "uk", cs_case_id: null })) as never[];
    // v1 (2) + m1 (1) + v9 (1) counted; v2 excluded and v5 unclassified are lines with 0 Items; v3 cancelled;
    // x1 (blank order) is an INVALID verification, not a line; the whitespace-id row is a source issue.
    expect(reducerDaily("uk", events, "2026-11-15T00:00:00Z", null)).toEqual([`2026-01-12|${STAFF}|framed|false|4|5`]);
    expect(reducerDaily("uk", events, "2026-11-15T00:00:00Z", STAFF)).toEqual([`2026-01-12|${STAFF}|framed|false|4|5`]);
    expect(reducerDaily("uk", events, "2026-11-15T00:00:00Z", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toEqual([]);
  });
});

describe("source guards", () => {
  const MOD = readFileSync("tests/staging/reportingPublication.ts", "utf8");
  const RUNNER = readFileSync("tests/staging/reporting-jobs.ts", "utf8");
  const pub = RUNNER.slice(RUNNER.indexOf("async function publicationMain"), RUNNER.indexOf("async function main()"));
  it("nothing in the publication evidence commits, changes a timeout or opens an unguarded client", () => {
    for (const src of [MOD, pub]) {
      expect(src).not.toMatch(/\.query\(\s*["'`]\s*(commit|end)\b/i);
      expect(src).not.toMatch(/set (local |session )?(statement_timeout|lock_timeout|idle_in_transaction)|set_config\('(statement|lock|idle)/i);
      expect(src).not.toMatch(/new pg\.Client\(/);
    }
    expect(pub).toContain("await main.query(\"begin\");");
    expect(pub).toContain("await main.query(\"rollback\");");
    expect(pub).toMatch(/runCaptureLifecycle\(report, \{/);
    expect(pub).toContain('if (mode === "rehearse-migration" && installed) throw new Error("0038 is already installed; use --check-installed");');
    expect(pub).toContain("return compareFullState(before, await fullState(fresh), allow).map((d) => `baseline differs after the run: ${d}`);");
    expect(pub).toContain('const allow = mode === "committed-interleavings" && own ? committedAllowance(own) : ROLLBACK_ONLY;');
  });
  it("T13B2b-4: the full-state fingerprint covers every promised surface", () => {
    const keys = STATE_QUERIES.map(([k]) => k);
    expect(keys).toEqual(["source:production_events", "stock:products", "ledger", "memberships:user_locations", "memberships:profiles", "catalog:functions", "catalog:relations", "catalog:columns", "catalog:constraints", "catalog:indexes", "catalog:policies", "catalog:triggers", "catalog:schemas-roles"]);
    const sql = Object.fromEntries(STATE_QUERIES);
    // Full row images, not counts or ids.
    for (const k of ["source:production_events", "stock:products", "ledger", "memberships:user_locations", "memberships:profiles"]) expect(sql[k], k).toContain("md5(to_jsonb(t)::text)");
    expect(sql["catalog:functions"]).toContain("md5(p.prosrc)");
    expect(sql["catalog:functions"]).toContain("p.proacl::text");
    expect(sql["catalog:relations"]).toContain("c.relacl::text");
    expect(sql["catalog:columns"]).toContain("a.attacl::text");
  });
  it("the flow covers every reviewed regression and publication property", () => {
    for (const id of ["B2a-1a", "B2a-1b", "B2a-1c", "B2a-2a", "B2a-2b", "B2a-2c", "B2a-0", "B2a-3a", "B2a-3b", "B2a-3c", "B2a-r", "P0", "P2b", "P2c", "P2d", "P2e", "P3a", "P3b", "F6", "F7", "F8a", "F9a", "F9b", "F9c", "F9d", "F9e", "F9f", "X3a", "X3b", "N2a", "P2f", "P2g", "F9g", "F9h", "F9i", "F9j"]) expect(MOD, id).toContain(`"${id}"`);
    const COMMITTED = readFileSync("tests/staging/reportingCommitted.ts", "utf8");
    for (const id of ["C0", "A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "D0", "D1", "D2", "D3"]) expect(COMMITTED, id).toContain(`"${id}"`);
    for (const id of ["I0", "I1", "I2", "I3", "I4", "I5"]) expect(MOD, id).toContain(`run("${id}"`);
  });
});

// ---------------------------------------------------------------------------
// T13B2b fixes: actual-helper fault injection
// ---------------------------------------------------------------------------

import { runCaptureLifecycle, initialReport, finalReport } from "../staging/reportingCapture";
import { cleanup, cleanupPlan, committedAllowance, newOwnership, preflightProblems, runCommitted, type Conn, type PreflightSnapshot } from "../staging/reportingCommitted";

describe("T13B2b-3: report persistence never skips cleanup or the fresh audit", () => {
  it("a save that throws after cleanup still lets the auditor open, keeps the failure and the run FAILED (actual lifecycle)", async () => {
    const events: string[] = [];
    let n = 0;
    const report = newPublicationReport("check-installed", ["uk", "au"], "x", "t", "f".repeat(64));
    report.observations.push({ id: "P2", what: "p", expected: "e", result: "r", ok: true, ms: 0 });
    const stderr: string[] = [];
    await runCaptureLifecycle(report, {
      open: async () => {
        const id = ++n;
        events.push(`open ${id}`);
        return { query: async (sql: string) => void events.push(`${id}: ${sql}`), end: async () => void events.push(`end ${id}`) };
      },
      body: async () => undefined,
      audit: async () => (events.push("AUDIT"), []),
      save: () => {
        throw new Error("disk full");
      },
      now: () => "t2",
      redact: (s) => s,
      stderr: (t) => void stderr.push(t),
    });
    expect(events).toEqual(["open 1", "1: rollback", "end 1", "open 2", "AUDIT", "end 2"]);
    expect(report.restorationVerified).toBe(true);
    expect(report.errors).toEqual(["report persistence failed (after cleanup): disk full", "report persistence failed (final): disk full"]);
    expect(stderr).toHaveLength(2);
    expect(publicationStatus(report)).toMatch(/^STATUS: FAILED – report persistence failed/);
  });

  it("an output file that cannot be created refuses the database connection; a failed final write prints the report to stderr and fails", () => {
    const err: string[] = [];
    expect(initialReport(() => { throw new Error("EACCES"); }, (t) => void err.push(t))).toBe(false);
    expect(err[0]).toMatch(/refusing to connect: the report file cannot be written: EACCES/);
    const errors: string[] = [];
    const out: string[] = [];
    expect(finalReport(() => { throw new Error("EIO"); }, () => "REPORT TEXT", errors, (t) => void out.push(t))).toBe(false);
    expect(errors).toEqual(["report persistence failed (after the run): EIO"]);
    expect(out).toEqual(["REPORT TEXT"]);
    const runner = readFileSync("tests/staging/reporting-jobs.ts", "utf8");
    // Every mode writes its report before connecting.
    expect(runner.match(/if \(!initialReport\(save\)\) return 1;/g)).toHaveLength(2);
    expect(readFileSync("tests/staging/reporting-capture.ts", "utf8")).toContain("if (!initialReport(save)) return 1;");
  });
});

describe("T13B2b-5: transaction control is classified on executable tokens", () => {
  it("leading line and NESTED block comments cannot hide BEGIN/COMMIT/ROLLBACK", () => {
    expect(() => migrationBody("BEGIN; /* leading block comment */ COMMIT; SELECT 1; COMMIT;")).toThrow(/transaction control inside/);
    expect(() => migrationBody("BEGIN;\n/* a /* nested */ comment */ ROLLBACK;\nSELECT 1;\nCOMMIT;")).toThrow(/transaction control inside/);
    expect(() => migrationBody("BEGIN;\n-- note\n  end;\nCOMMIT;")).toThrow(/transaction control inside/);
    expect(() => migrationBody("BEGIN;\nPREPARE TRANSACTION 'x';\nCOMMIT;")).toThrow(/transaction control inside/);
    expect(() => migrationBody("/* header */ BEGIN; SELECT 1; /* c */ COMMIT")).not.toThrow();
    expect(leadingKeywords("/* a /* b */ c */ -- x\n  commit prepared 'x'")).toEqual(["COMMIT", "PREPARED"]);
    // Inside a quoted function body the words are not the statement's verb.
    expect(isTransactionControl("CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN COMMIT; END $fn$")).toBe(false);
    expect(isTransactionControl("PREPARE q AS SELECT 1")).toBe(false);
    expect(isTransactionControl("SELECT 'COMMIT'")).toBe(false);
  });
});

describe("T13B2b-6: the killed victim", () => {
  const ctx = { redact: (s: string) => s, sleep: async () => undefined };
  const mon = (k: boolean) => ({ query: async (sql: string) => ({ rows: sql.includes("pg_terminate_backend") ? (k ? [{ k: true }] : []) : [], rowCount: 1 }) });
  const victim = (endError: Error | null, events: unknown[] = []) => {
    let onError: ((e: unknown) => void) | null = null;
    return {
      on: (_: string, fn: (e: unknown) => void) => void (onError = fn),
      query: async (sql: string) => {
        if (sql.includes("pg_backend_pid")) return { rows: [{ p: 4242 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      end: async () => {
        for (const e of events) onError?.(e);
        if (endError) throw endError;
      },
    };
  };
  it("the expected 57P01 notice is evidence; an unexpected disconnect failure or error event FAILS cleanup", async () => {
    const ok: string[] = [];
    const term = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
    expect(await killOwnVictim(victim(null, [term]), mon(true), ok, ctx, async () => undefined)).toEqual({ terminated: true, expected: 1 });
    expect(ok).toEqual([]);
    const bad: string[] = [];
    await killOwnVictim(victim(new Error("socket hang up"), [new Error("ECONNRESET")]), mon(true), bad, ctx, async () => undefined);
    expect(bad).toEqual(["victim connection error: ECONNRESET", "victim connection disconnect: socket hang up"]);
  });
  it("only the session this invocation tagged can be terminated", async () => {
    const sent: Array<[string, unknown[]]> = [];
    const m = { query: async (sql: string, params: unknown[] = []) => (sent.push([sql, params]), { rows: [], rowCount: 0 }) };
    const r = await killOwnVictim(victim(null), m, [], ctx, async () => undefined);
    expect(r.terminated).toBe(false);
    expect(sent[0][0]).toMatch(/pg_terminate_backend\(a\.pid\) as k from pg_catalog\.pg_stat_activity a where a\.pid = \$1 and a\.application_name = \$2/);
    expect(sent[0][1][0]).toBe(4242);
    expect(String(sent[0][1][1])).toMatch(/^rp-victim-[0-9a-f]+$/);
  });
});

describe("T13B2b-4: full-state comparison", () => {
  const state = (over: Partial<FullState> = {}): FullState => ({
    surfaces: { "source:production_events": "10:aa", "catalog:functions": "f1" },
    privateTables: { batches: "0:x", changes: "0:y" },
    control: { capture_epoch: "3", capture_enabled: false, rule_version: "v1", updated_at: "t" },
    siteState: [{ site: "uk", processor_enabled: false, lease_fence: "4", lease_expires_at: null, updated_at: "u" }],
    ...over,
  });
  it("rollback-only allows nothing; 0038 left behind after a rehearsal shows up in the catalog and private tables", () => {
    expect(compareFullState(state(), state())).toEqual([]);
    const after = state({ surfaces: { "source:production_events": "10:aa", "catalog:functions": "f2" }, privateTables: { batches: "0:x", changes: "0:y", source_versions: "0:z" } });
    expect(compareFullState(state(), after, ROLLBACK_ONLY)).toEqual(["catalog:functions differs (f1 -> f2)", "reporting_private.source_versions differs (absent -> 0:z)"]);
    expect(compareFullState(state(), state({ surfaces: { "source:production_events": "10:ab", "catalog:functions": "f1" } }))).toEqual(["source:production_events differs (10:aa -> 10:ab)"]);
  });
  it("the committed allowance accepts exactly the declared epoch increments and the run sites' lease bookkeeping; nothing else", () => {
    const own = newOwnership(["uk", "au"], "r1");
    own.captureToggles = 2;
    const allow = committedAllowance(own);
    const after = state({ control: { capture_epoch: "5", capture_enabled: false, rule_version: "v1", updated_at: "t2" }, siteState: [{ site: "uk", processor_enabled: false, lease_fence: "9", lease_expires_at: "x", updated_at: "u2" }] });
    expect(compareFullState(state(), after, allow)).toEqual([]);
    expect(compareFullState(state(), state({ control: { capture_epoch: "4", capture_enabled: false, rule_version: "v1", updated_at: "t2" } }), allow)).toEqual(["capture_epoch is 4, expected exactly 5 (3 + 2)"]);
    const ctl5 = { capture_epoch: "5", capture_enabled: false, rule_version: "v1", updated_at: "t2" };
    expect(compareFullState(state(), state({ control: ctl5, siteState: [{ site: "uk", processor_enabled: true, lease_fence: "4", lease_expires_at: null, updated_at: "u" }] }), allow)).toEqual(["site_state uk.processor_enabled is true, was false"]);
    expect(compareFullState(state(), state({ control: ctl5, siteState: [{ site: "uk", processor_enabled: false, lease_fence: "3", lease_expires_at: null, updated_at: "u" }] }), allow)).toEqual(["site_state uk.lease_fence went backwards"]);
    // Rollback-only modes accept none of it.
    expect(compareFullState(state(), after, ROLLBACK_ONLY).length).toBeGreaterThan(0);
  });
});

describe("committed harness (prepared, not run)", () => {
  const iso: PreflightSnapshot = {
    installed: true, captureEnabled: false, activeBatchesAnywhere: 0, fixtureCollisions: 0,
    sites: ["au", "uk"].map((site) => ({ site, processor: false, readMode: "legacy", generation: null, activeBatch: null, derivedRows: 0, batches: 0, generations: 0, pendingChanges: 0 })),
  };
  it("preflight refuses every non-isolated starting state", () => {
    expect(preflightProblems(iso, ["uk", "au"])).toEqual([]);
    const cases: Array<[Partial<PreflightSnapshot> | ((p: PreflightSnapshot) => void), RegExp]> = [
      [{ installed: false }, /not installed/],
      [{ captureEnabled: true }, /capture is enabled/],
      [{ activeBatchesAnywhere: 1 }, /active; refuse/],
      [{ fixtureCollisions: 1 }, /fixture prefix/],
      [(p) => void (p.sites[1].generation = "g"), /published generation exists/],
      [(p) => void (p.sites[1].derivedRows = 3), /isolated restore is impossible/],
      [(p) => void (p.sites[0].pendingChanges = 1), /unacknowledged journal/],
      [(p) => void (p.sites[0].processor = true), /processor is already enabled/],
      [(p) => void (p.sites[0].readMode = "shadow"), /not legacy/],
    ];
    for (const [c, re] of cases) {
      const p: PreflightSnapshot = JSON.parse(JSON.stringify(iso));
      if (typeof c === "function") c(p);
      else Object.assign(p, c);
      expect(preflightProblems(p, ["uk", "au"]).join("; "), re.source).toMatch(re);
    }
  });

  it("every cleanup statement is scoped to this run's exact sites and ids/sequences; no unscoped delete; dependency order", () => {
    const own = newOwnership(["uk", "au"], "abcd1234");
    own.fixtureIds = ["rc-abcd1234-low"];
    own.batches = ["b1", "b2"];
    own.generations = ["g1", "g2"];
    own.generationSeqs = ["11", "12"];
    own.original = { captureEnabled: false, sites: [{ site: "uk", processor: false, generation: null, sourceEpoch: null, lastVerifiedCutoff: null }] };
    const plan = cleanupPlan(own, ["901", "902"]);
    for (const st of plan) {
      expect(st.sql, st.label).toMatch(/\bwhere\b/i);
      expect(st.sql, st.label).not.toMatch(/disable trigger|session_replication_role|truncate/i);
      if (/^delete/i.test(st.sql)) expect(st.sql, st.label).toMatch(/= any\(\$\d+::(text|bigint|uuid)\[\]\)|generation_id = \$1::uuid/);
    }
    const order = plan.map((st) => st.label);
    const at = (needle: string) => order.findIndex((l) => l.includes(needle));
    expect(at("event_facts")).toBeLessThan(at("mirror"));
    expect(at("mirror")).toBeLessThan(at("restore uk"));
    expect(at("restore uk")).toBeLessThan(at("generation g2"));
    expect(at("batch_changes")).toBeLessThan(at("journal rows"));
    expect(at("journal rows")).toBeLessThan(at("this run's batches"));
    expect(at("this run's batches")).toBeLessThan(at("generation g2"));
    expect(at("generation g2")).toBeLessThan(at("generation g1")); // newest first
    expect(plan.at(-1)!.sql).toBe("delete from public.production_events where id = any($1::text[]) and location = any($2::text[]) and id like $3");
    expect(plan.at(-1)!.params).toEqual([["rc-abcd1234-low"], ["uk", "au"], "rc-abcd1234-%"]);
    // Note (3): an entangled batch protects EVERYTHING that depends on the run's generations.
    const kept = cleanupPlan(own, ["901"], { retainBatches: ["b2"] });
    expect(kept.find((st) => st.label === "delete this run's batches")!.params).toEqual([["b1"]]);
    expect(kept.some((st) => /generation|mirror|_facts|cancel_edges|daily_totals|source_versions|order_occurrences/.test(st.label) && st.label.startsWith("delete"))).toBe(false);
    expect(kept.find((st) => st.label.startsWith("restore uk"))!.sql).toBe("update reporting_private.site_state set processor_enabled = $2 where site = $1");
    expect(kept.find((st) => st.label.startsWith("delete this run's journal"))!.params).toEqual([["901"], ["b2"]]);
    // A site whose active batch belongs to someone else is not touched at all.
    expect(cleanupPlan(own, [], { externalActiveSites: ["uk"] }).some((st) => st.label.startsWith("restore uk"))).toBe(false);
    // Even without retention, the metadata reset only applies while the site's active batch is this run's (or none).
    expect(plan.find((st) => st.label === "restore uk site metadata")!.sql).toContain("and (active_batch_id is null or active_batch_id = any($6::uuid[]))");
  });

  function fakeConn(log: string[], fail: (sql: string) => boolean = () => false): Conn {
    return {
      query: async (sql: string) => {
        log.push(sql.replace(/\s+/g, " ").slice(0, 60));
        if (fail(sql)) throw new Error(`injected: ${sql.slice(0, 20)}`);
        if (sql.startsWith("select current_user")) return { rows: [{ u: "service_role", claims: '{"role":"service_role"}' }], rowCount: 1 };
        if (sql.includes("json_build_object(\n  'installed'") || sql.startsWith("select json_build_object(")) return { rows: [{ j: iso }], rowCount: 1 };
        if (sql.includes("select site, processor_enabled, active_generation_id::text as g")) return { rows: [{ site: "uk", processor_enabled: false, g: null, e: null, c: null }, { site: "au", processor_enabled: false, g: null, e: null, c: null }], rowCount: 2 };
        if (sql.includes("array_agg(change_id::text)")) return { rows: [{ ids: [] }], rowCount: 1 };
        if (sql.includes("count(*)::int as n from reporting_private.changes ch")) return { rows: [{ batches: [], n: 0 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      end: async () => undefined,
    };
  }

  it("ownership is saved BEFORE the first commit; a failed save stops the run with nothing committed, and cleanup still runs", async () => {
    const log: string[] = [];
    const obs: Observation[] = [];
    const own = newOwnership(["uk", "au"], "r2");
    const cleanupFailures: string[] = [];
    await expect(
      runCommitted({ sites: ["uk", "au"], staff: "s", maxPages: 1, open: async () => fakeConn(log), as: async () => undefined, record: (o) => void obs.push(o), save: () => { throw new Error("disk full"); }, redact: (s) => s, now: () => 0 }, own, cleanupFailures),
    ).rejects.toThrow("disk full");
    expect(log.some((l) => /^commit\b/i.test(l) || /set_reporting_capture/.test(l))).toBe(false);
    expect(obs.map((o) => [o.id, o.ok])).toEqual([["C0", true]]);
  });

  it("when a scenario fails mid-run, cleanup restores capture, deletes only owned rows, keeps going past a failing step and records it", async () => {
    const log: string[] = [];
    const own = newOwnership(["uk", "au"], "r3");
    own.original = { captureEnabled: false, sites: [{ site: "uk", processor: false, generation: null, sourceEpoch: null, lastVerifiedCutoff: null }] };
    own.batches = ["b1"];
    own.generations = ["g1"];
    own.generationSeqs = ["7"];
    const failures: string[] = [];
    const conn = fakeConn(log, (sql) => sql.includes("delete from reporting_private.cancel_edges"));
    const q = conn.query;
    conn.query = async (sql: string, params?: unknown[]) => (sql.includes("select capture_enabled from reporting_private.control") ? { rows: [{ capture_enabled: true }], rowCount: 1 } : q(sql, params));
    await cleanup(conn, { as: async () => undefined, redact: (s) => s, save: () => undefined }, own, failures);
    expect(own.captureToggles).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^delete this run's cancel_edges rows: injected: delete from/);
    expect(log.some((l) => l.includes("delete from reporting_private.timing_facts"))).toBe(true); // continued after the failure
    expect(log.some((l) => l.includes("delete from public.production_events where id = any"))).toBe(true);
  });

  it("the harness is a separate, explicit mode; the rollback-only modes never commit", () => {
    expect(parsePublicationArgs(["--committed-interleavings", "--sites=uk,au"]).mode).toBe("committed-interleavings");
    const mod = readFileSync("tests/staging/reportingCommitted.ts", "utf8");
    expect(mod).toContain('await c.query("commit");');
    expect(mod).not.toMatch(/disable trigger|session_replication_role|truncate|statement_timeout|lock_timeout\s*=/i);
    expect(readFileSync("tests/staging/reportingPublication.ts", "utf8")).not.toMatch(/\.query\(\s*["'`]\s*commit/i);
  });
});

describe("committed harness: early-review notes", () => {
  it("note (1): each committed service RPC is its own transaction, proves service_role and rolls back on failure", async () => {
    const { serviceCall } = await import("../staging/reportingCommitted");
    const log: string[] = [];
    const db = (who: { u: string; claims: string }, fail = false) => ({
      query: async (sql: string) => {
        log.push(sql);
        if (sql.startsWith("select current_user")) return { rows: [who], rowCount: 1 };
        if (fail && sql.startsWith("select * from public.x")) throw new Error("db refused");
        return { rows: [{ ok: true }], rowCount: 1 };
      },
    });
    const as = async (c: { query(s: string): Promise<unknown> }, service: boolean) => void (await c.query(service ? "set local role service_role" : "reset role"));
    const call = serviceCall(as as never);
    expect(await call(db({ u: "service_role", claims: '{"role":"service_role"}' }), "select * from public.x()", [])).toEqual([{ ok: true }]);
    expect(log).toEqual(["begin", "set local role service_role", "select current_user as u, current_setting('request.jwt.claims', true) as claims", "select * from public.x()", "commit"]);
    log.length = 0;
    await expect(call(db({ u: "postgres", claims: "" }), "select * from public.x()", [])).rejects.toThrow(/not running as service_role \(current_user postgres/);
    expect(log.at(-1)).toBe("rollback");
    expect(log).not.toContain("select * from public.x()");
    log.length = 0;
    await expect(call(db({ u: "service_role", claims: '{"role":"service_role"}' }, true), "select * from public.x()", [])).rejects.toThrow("db refused");
    expect(log.at(-1)).toBe("rollback");
    // The committed flow never sends a bare service RPC: it always goes through the transactional call.
    const mod = readFileSync("tests/staging/reportingCommitted.ts", "utf8");
    expect(mod).toContain("call: serviceCall(ctx.as)");
    expect(mod).not.toMatch(/await ctx\.as\(main, true\)/);
  });

  it("note (2): an unexpected rollback failure during disconnect is kept even when end() succeeds", async () => {
    const failures: string[] = [];
    const own = newOwnership(["uk", "au"], "r4");
    let opened = 0;
    const conn = (): Conn => ({
      query: async (sql: string) => {
        if (sql.startsWith("select json_build_object(")) return { rows: [{ j: { installed: false, captureEnabled: false, activeBatchesAnywhere: 0, sites: [], fixtureCollisions: 0 } }], rowCount: 1 };
        if (sql === "rollback") throw new Error("connection lost");
        return { rows: [], rowCount: 0 };
      },
      end: async () => undefined,
    });
    await runCommitted({ sites: ["uk", "au"], staff: "s", maxPages: 1, open: async () => (opened++, conn()), as: async () => undefined, record: () => undefined, save: () => undefined, redact: (s) => s, now: () => 0 }, own, failures);
    expect(opened).toBe(1);
    expect(failures).toEqual(["rollback: connection lost"]);
  });
});

describe("note (1) behaviour: the committed flow's service RPCs each run in their own proven transaction", () => {
  it("set_reporting_capture is wrapped in begin -> role -> current_user proof -> call -> commit, and processors the same", async () => {
    const iso: PreflightSnapshot = {
      installed: true, captureEnabled: false, activeBatchesAnywhere: 0, fixtureCollisions: 0,
      sites: ["au", "uk"].map((site) => ({ site, processor: false, readMode: "legacy", generation: null, activeBatch: null, derivedRows: 0, batches: 0, generations: 0, pendingChanges: 0 })),
    };
    const log: string[] = [];
    const conn: Conn = {
      query: async (sql: string) => {
        log.push(sql.replace(/\s+/g, " ").trim().slice(0, 200));
        if (sql.startsWith("select json_build_object(")) return { rows: [{ j: iso }], rowCount: 1 };
        if (sql.startsWith("select current_user")) return { rows: [{ u: "service_role", claims: '{"role":"service_role"}' }], rowCount: 1 };
        if (sql.includes("select site, processor_enabled, active_generation_id::text as g")) return { rows: [{ site: "au", processor_enabled: false, g: null, e: null, c: null }, { site: "uk", processor_enabled: false, g: null, e: null, c: null }], rowCount: 2 };
        if (sql.includes("begin_reporting_rebuild")) throw new Error("stop the scenario here");
        if (sql.includes("array_agg(change_id::text)")) return { rows: [{ ids: [] }], rowCount: 1 };
        if (sql.includes("reporting_private.changes ch")) return { rows: [{ batches: [], n: 0 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      end: async () => undefined,
    };
    const own = newOwnership(["uk", "au"], "r5");
    await expect(
      runCommitted({ sites: ["uk", "au"], staff: "s", maxPages: 1, open: async () => conn, as: async (c, service) => void (await c.query(service ? "set local role service_role" : "reset role")), record: () => undefined, save: () => undefined, redact: (s) => s, now: () => 0 }, own, []),
    ).rejects.toThrow("stop the scenario here");
    const i = log.indexOf("select * from public.set_reporting_capture(true)");
    expect(i).toBeGreaterThan(2);
    expect(log.slice(i - 3, i + 2)).toEqual(["begin", "set local role service_role", "select current_user as u, current_setting('request.jwt.claims', true) as claims", "select * from public.set_reporting_capture(true)", "commit"]);
    const j = log.findIndex((l) => l.startsWith("update reporting_private.site_state set processor_enabled = true"));
    expect(log.slice(j - 3, j)).toEqual(["begin", "set local role service_role", "select current_user as u, current_setting('request.jwt.claims', true) as claims"]);
    expect(log[j + 1]).toBe("commit");
    // The failed rebuild RPC was rolled back (no aborted state or role leaks), and cleanup's capture restore is transactional too.
    const k = log.findIndex((l) => l.includes("begin_reporting_rebuild"));
    expect(log[k + 1]).toBe("rollback");
  });
});
