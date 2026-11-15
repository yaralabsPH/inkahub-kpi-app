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
import { evidenceOrderKey } from "../../src/lib/domain/productionCounts";
import {
  compareFullState,
  STATE_QUERIES,
  isTransactionControl,
  leadingKeywords,
  I5_TERMINATE_SQL,
  I5_VICTIM_IDENTITY_SQL,
  ROLLBACK_ONLY,
  type FullState,
  expectEqual,
  fixtureRows,
  BLANK_ORDER,
  insertFixtures,
  productionEventAdmissibility,
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
import { BEGIN_GUARD_SQL, fxRow, guardBeginOwnership, cleanup, cleanupDecision, committedAllowance, DISCOVERY, expectedEpochIncrement, newOwnership, ownedCall, preflightProblems, runCommitted, type Conn, type Discovery, type PreflightSnapshot } from "../staging/reportingCommitted";
import type { Site } from "../staging/reportingPublication";

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

describe("T13B2b-24 (supersedes T13B2b-6's application_name tag): the victim's termination SQL", () => {
  it("the identity is read in the victim's OWN open explicit transaction; the kill binds pid AND backend_start AND xact_start; no application_name authority", () => {
    expect(I5_VICTIM_IDENTITY_SQL).toContain("a.pid = pg_catalog.pg_backend_pid()");
    expect(I5_VICTIM_IDENTITY_SQL).toContain("a.backend_start::text as backend_start");
    expect(I5_VICTIM_IDENTITY_SQL).toContain("a.xact_start::text as xact_start");
    expect(I5_VICTIM_IDENTITY_SQL).toContain("(pg_catalog.transaction_timestamp() < pg_catalog.statement_timestamp()) as explicit_tx");
    expect(I5_TERMINATE_SQL).toMatch(/pg_terminate_backend\(a\.pid\) as k from pg_catalog\.pg_stat_activity a where a\.pid = \$1 and a\.backend_start = \$2::timestamptz and a\.xact_start = \$3::timestamptz$/);
    expect(I5_TERMINATE_SQL).toMatch(/^select a\.pid, a\.backend_start::text as backend_start, a\.xact_start::text as xact_start, /); // the receipt returns the matched identity
    for (const q of [I5_VICTIM_IDENTITY_SQL, I5_TERMINATE_SQL]) expect(q).not.toMatch(/application_name/);
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
    own.captureTransitions = [{ enable: true, before: "3", after: "4", state: "confirmed" }, { enable: false, before: "4", after: "5", state: "confirmed" }];
    const allow = committedAllowance(own);
    const after = state({ control: { capture_epoch: "5", capture_enabled: false, rule_version: "v1", updated_at: "t2" }, siteState: [{ site: "uk", processor_enabled: false, lease_fence: "9", lease_expires_at: "x", updated_at: "u2" }] });
    expect(compareFullState(state(), after, allow)).toEqual([]);
    expect(compareFullState(state(), state({ control: { capture_epoch: "4", capture_enabled: false, rule_version: "v1", updated_at: "t2" } }), allow)).toEqual(["capture_epoch is 4, expected exactly 5 (3 + 2)"]);
    const ctl5 = { capture_epoch: "5", capture_enabled: false, rule_version: "v1", updated_at: "t2" };
    expect(compareFullState(state(), state({ control: ctl5, siteState: [{ site: "uk", processor_enabled: true, lease_fence: "4", lease_expires_at: null, updated_at: "u" }] }), allow)).toEqual(["site_state uk.processor_enabled is true, was false"]);
    expect(compareFullState(state(), state({ control: ctl5, siteState: [{ site: "uk", processor_enabled: false, lease_fence: "3", lease_expires_at: null, updated_at: "u" }] }), allow)).toEqual(["site_state uk.lease_fence went backwards"]);
    // An uncertain transition never widens the allowance.
    own.captureTransitions.push({ enable: true, before: "5", after: "6", state: "uncertain" });
    expect(committedAllowance(own).epochIncrement).toBe(2);
    // Rollback-only modes accept none of it.
    expect(compareFullState(state(), after, ROLLBACK_ONLY).length).toBeGreaterThan(0);
  });
});

describe("committed harness (prepared, not run)", () => {
  const iso: PreflightSnapshot = {
    installed: true, captureEnabled: false, captureEpoch: "3", activeBatchesAnywhere: 0, fixtureCollisions: 0,
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

  // An ownership with two confirmed batches/generations (uk then au) and an unrelated uncertain nothing.
  const owned = () => {
    const own = newOwnership(["uk", "au"], "abcd1234");
    own.fixtureIds = ["rc-abcd1234-low", "rc-abcd1234-m"];
    own.original = { captureEnabled: false, captureEpoch: "3", sites: [{ site: "uk", processor: false, generation: null, sourceEpoch: null, lastVerifiedCutoff: null }, { site: "au", processor: false, generation: null, sourceEpoch: null, lastVerifiedCutoff: null }] };
    own.identities = [
      { kind: "batch", id: "b1", seq: null, state: "confirmed" },
      { kind: "generation", id: "g1", seq: "11", state: "confirmed" },
      { kind: "batch", id: "b2", seq: null, state: "confirmed" },
      { kind: "generation", id: "g2", seq: "12", state: "confirmed" },
      { kind: "batch", id: "bx", seq: null, state: "absent" },
    ];
    return own;
  };
  const clean = (over: Partial<Discovery> = {}): Discovery => ({
    captureOff: true, ourChangeIds: ["901", "902"], externalJournal: 0, externalBatches: [], externalGenerations: [],
    sites: [{ site: "uk", activeGeneration: "g2", activeBatch: null }, { site: "au", activeGeneration: "g1", activeBatch: null }], ...over,
  });

  it("isolated discovery: every statement is scoped to the run's sites and EXACT confirmed identities / fixture ids; dependency order", () => {
    const { retainAll, steps } = cleanupDecision(owned(), clean());
    expect(retainAll).toBe(false);
    for (const st of steps) {
      expect(st.sql, st.label).toMatch(/\bwhere\b/i);
      expect(st.sql, st.label).not.toMatch(/disable trigger|session_replication_role|truncate|\blike\b/i);
      if (/^delete/i.test(st.sql)) expect(st.sql, st.label).toMatch(/= any\(\$\d+::(text|bigint|uuid)\[\]\)|generation_id = \$1::uuid/);
    }
    const at = (needle: string) => steps.findIndex((st) => st.label.includes(needle));
    expect(at("event_facts")).toBeLessThan(at("mirror"));
    expect(at("mirror")).toBeLessThan(at("restore uk"));
    expect(at("batch_changes")).toBeLessThan(at("journal rows"));
    expect(at("journal rows")).toBeLessThan(at("this run's batches"));
    expect(at("this run's batches")).toBeLessThan(at("generation g2"));
    expect(at("generation g2")).toBeLessThan(at("generation g1"));
    expect(steps.find((st) => st.label.startsWith("delete this run's event_facts"))!.params).toEqual([["uk", "au"], ["11", "12"]]);
    expect(steps.find((st) => st.label.startsWith("delete this run's batches"))!.params).toEqual([["b1", "b2"]]); // the absent bx is not touched
    expect(steps.find((st) => st.label.startsWith("delete this run's journal"))!.params).toEqual([["901", "902"]]);
    expect(steps.at(-1)!).toMatchObject({ sql: "delete from public.production_events where id = any($1::text[]) and location = any($2::text[])", params: [["rc-abcd1234-low", "rc-abcd1234-m"], ["uk", "au"]] });
    // A metadata reset applies only while the site still points at this run's batch/generation (or none).
    expect(steps.find((st) => st.label === "restore uk site metadata")!.sql).toContain("and (active_batch_id is null or active_batch_id = any($6::uuid[])) and (active_generation_id is null or active_generation_id = any($7::uuid[]))");
  });

  it("T13B2b-10: discovery failure, external journal/batch/generation, a foreign site pointer or an uncertain identity RETAIN everything", () => {
    const destructive = (steps: Array<{ sql: string }>) => steps.filter((st) => /^delete|active_generation_id = \$3/i.test(st.sql));
    const cases: Array<[string, Discovery | null, (o: ReturnType<typeof owned>) => void]> = [
      ["discovery failed", null, () => undefined],
      ["external journal", clean({ externalJournal: 1 }), () => undefined],
      ["external batch", clean({ externalBatches: ["bz"] }), () => undefined],
      ["external generation", clean({ externalGenerations: ["gz"] }), () => undefined],
      ["foreign active batch", clean({ sites: [{ site: "uk", activeGeneration: "g2", activeBatch: "bz" }, { site: "au", activeGeneration: "g1", activeBatch: null }] }), () => undefined],
      ["foreign published generation", clean({ sites: [{ site: "uk", activeGeneration: "gz", activeBatch: null }, { site: "au", activeGeneration: "g1", activeBatch: null }] }), () => undefined],
      ["uncertain identity", clean(), (o) => void o.identities.push({ kind: "generation", id: "g3", seq: "13", state: "uncertain" })],
      ["tentative identity", clean(), (o) => void o.identities.push({ kind: "batch", id: "b3", seq: null, state: "tentative" })],
    ];
    for (const [name, d, mutate] of cases) {
      const own = owned();
      mutate(own);
      const r = cleanupDecision(own, d);
      expect(r.retainAll, name).toBe(true);
      expect(r.reasons.length, name).toBeGreaterThan(0);
      expect(destructive(r.steps), name).toEqual([]);
    }
    // With a foreign active batch the run does not even restore that site's processor setting.
    const foreign = cleanupDecision(owned(), clean({ sites: [{ site: "uk", activeGeneration: "g2", activeBatch: "bz" }, { site: "au", activeGeneration: "g1", activeBatch: null }] }));
    expect(foreign.steps.map((st) => st.label)).toEqual(["restore au processor setting"]);
    expect(cleanupDecision(owned(), null).steps).toEqual([]);
  });

  it("T13B2b-11: capture not confirmed off keeps the fixture source rows", () => {
    const r = cleanupDecision(owned(), clean({ captureOff: false }));
    expect(r.steps.some((st) => st.sql.includes("public.production_events"))).toBe(false);
    expect(r.reasons).toEqual(["capture is not confirmed off: fixture source rows are kept"]);
  });

  it("journal ownership uses the EXACT fixture ids (both sides), never a prefix", () => {
    expect(DISCOVERY.ourChanges).toContain("(new_event_id = any($1::text[]) or old_event_id = any($1::text[])) and (new_event_id is null or new_event_id = any($1::text[])) and (old_event_id is null or old_event_id = any($1::text[]))");
    expect(DISCOVERY.ourChanges).not.toMatch(/\blike\b/i);
    expect(DISCOVERY.externalJournal).toContain("capture_epoch > $2::bigint and not (change_id = any($3::bigint[]))");
    expect(DISCOVERY.sites).toMatch(/for update$/);
  });

  // ---- execution with a scripted connection --------------------------------------------------------
  type Script = { log: string[]; conn: Conn; ends: number; rollbacks: number };
  function scripted(opts: { fail?: (sql: string) => Error | null; pid?: number; alive?: () => boolean; epochAfter?: string; pointer?: string | null; live?: string[] } = {}): Script {
    const s: Script = { log: [], conn: null as unknown as Conn, ends: 0, rollbacks: 0 };
    s.conn = {
      query: async (sql: string, params: unknown[] = []) => {
        s.log.push(sql.replace(/\s+/g, " ").trim().slice(0, 200));
        if (sql === "rollback") s.rollbacks++;
        const f = opts.fail?.(sql);
        if (f) throw f;
        if (sql.startsWith("select json_build_object(")) return { rows: [{ j: iso }], rowCount: 1 };
        if (sql.startsWith("select pg_backend_pid()")) return { rows: [{ p: opts.pid ?? 77 }], rowCount: 1 };
        if (sql.startsWith("select current_user")) return { rows: [{ u: "service_role", claims: '{"role":"service_role"}' }], rowCount: 1 };
        if (sql.includes("capture_epoch::text as e from reporting_private.control where singleton for update")) return { rows: [{ e: "3" }], rowCount: 1 };
        if (sql === BEGIN_GUARD_SQL.control) return { rows: [{ e: "3" }], rowCount: 1 };
        if (sql === BEGIN_GUARD_SQL.site) return { rows: [{ b: opts.pointer ?? null }], rowCount: 1 };
        if (sql === BEGIN_GUARD_SQL.batches) return { rows: (opts.live ?? []).map((b) => ({ b, state: "active" })), rowCount: (opts.live ?? []).length };
        if (sql.includes("public.set_reporting_capture")) return { rows: [{ capture_epoch: opts.epochAfter ?? "4", capture_enabled: params[0] }], rowCount: 1 };
        if (sql.includes("select site, processor_enabled, active_generation_id::text as g")) return { rows: [{ site: "au", processor_enabled: false, g: null, e: null, c: null }, { site: "uk", processor_enabled: false, g: null, e: null, c: null }], rowCount: 2 };
        if (sql.includes("pg_stat_activity where pid")) return { rows: [{ x: opts.alive?.() ?? false }], rowCount: 1 };
        if (sql.includes("select exists (select 1 from reporting_private.")) return { rows: [{ x: true }], rowCount: 1 };
        if (sql.includes("as ids from")) return { rows: [{ ids: [] }], rowCount: 1 };
        if (sql.includes("count(*)::int as n from reporting_private.changes")) return { rows: [{ n: 0 }], rowCount: 1 };
        if (sql.startsWith("select capture_enabled")) return { rows: [{ capture_enabled: false }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      end: async () => void s.ends++,
    };
    return s;
  }
  const ctxOf = (open: () => Promise<Conn>, save: () => void = () => undefined, record: (o: Observation) => void = () => undefined) => ({
    sites: ["uk", "au"] as [Site, Site], staff: STAFF, maxPages: 1, open, as: async (c: Db, service: boolean) => void (await c.query(service ? "set local role service_role" : "reset role")),
    record, save, redact: (x: string) => x, now: () => 0, sleep: async () => undefined,
  });

  it("T13B2b-12: identities are saved as TENTATIVE before COMMIT and confirmed after; a failed save commits nothing", async () => {
    const own = newOwnership(["uk", "au"], "r6");
    const s = scripted();
    const saves: string[] = [];
    const call = ownedCall({ ...ctxOf(async () => s.conn, () => void saves.push(JSON.stringify(own.identities.map((i) => i.state)))) }, own, []);
    s.conn.query = ((q) => async (sql: string, p?: unknown[]) => (sql.includes("begin_reporting_batch") ? { rows: [{ batch_id: "b9" }], rowCount: 1 } : q(sql, p)))(s.conn.query);
    await call(s.conn, "select * from public.begin_reporting_batch($1)", ["uk"]);
    expect(saves).toEqual(['["tentative"]', '["confirmed"]']);
    expect(s.log.slice(-1)).toEqual(["commit"]);
    const own2 = newOwnership(["uk", "au"], "r7");
    const s2 = scripted();
    s2.conn.query = ((q) => async (sql: string, p?: unknown[]) => (sql.includes("begin_reporting_batch") ? { rows: [{ batch_id: "b8" }], rowCount: 1 } : q(sql, p)))(s2.conn.query);
    await expect(ownedCall(ctxOf(async () => s2.conn, () => { throw new Error("disk full"); }), own2, []) (s2.conn, "select * from public.begin_reporting_batch($1)", ["uk"])).rejects.toThrow("disk full");
    expect(s2.log).not.toContain("commit");
    expect(s2.log.at(-1)).toBe("rollback");
    expect(own2.identities.map((i) => i.state)).toEqual(["absent"]);
  });

  it("T13B2b-12 + note: an uncertain COMMIT settles the ORIGINATING session; absence is concluded only once its backend is gone", async () => {
    // Backend still present: identities stay uncertain (never 'absent').
    const own = newOwnership(["uk", "au"], "r8");
    const s = scripted({ fail: (sql) => (sql === "commit" ? new Error("connection reset during commit") : null), alive: () => true });
    s.conn.query = ((q) => async (sql: string, p?: unknown[]) => (sql.includes("begin_reporting_batch") ? (s.log.push(sql), { rows: [{ batch_id: "b7" }], rowCount: 1 }) : q(sql, p)))(s.conn.query);
    const fresh = scripted({ alive: () => true });
    const failures: string[] = [];
    await expect(ownedCall(ctxOf(async () => fresh.conn), own, failures)(s.conn, "select * from public.begin_reporting_batch($1)", ["uk"])).rejects.toThrow("connection reset");
    expect(s.ends).toBe(1); // the originating session was closed first
    expect(own.identities.map((i) => i.state)).toEqual(["uncertain"]);
    expect(failures.join("; ")).toMatch(/originating session 77 is still present/);
    expect(fresh.log.filter((l) => l.includes("pg_stat_activity where pid"))).toHaveLength(25); // bounded wait
    // Backend gone: the exact id is resolved on a fresh connection.
    const own2 = newOwnership(["uk", "au"], "r9");
    const s2 = scripted({ fail: (sql) => (sql === "commit" ? new Error("lost") : null) });
    s2.conn.query = ((q) => async (sql: string, p?: unknown[]) => (sql.includes("begin_reporting_batch") ? { rows: [{ batch_id: "b6" }], rowCount: 1 } : q(sql, p)))(s2.conn.query);
    const fresh2 = scripted({ alive: () => false });
    await expect(ownedCall(ctxOf(async () => fresh2.conn), own2, [])(s2.conn, "select * from public.begin_reporting_batch($1)", ["uk"])).rejects.toThrow("lost");
    expect(own2.identities.map((i) => i.state)).toEqual(["confirmed"]);
    expect(fresh2.log.some((l) => l.includes("from reporting_private.batches where batch_id = $1::uuid"))).toBe(true);
  });

  it("note: the expected epoch is this run's own locked, receipted transitions; observed or uncertain deltas never widen it", async () => {
    const own = newOwnership(["uk", "au"], "ra");
    const s = scripted({ epochAfter: "4" });
    await ownedCall(ctxOf(async () => s.conn), own, [])(s.conn, "select * from public.set_reporting_capture($1)", [true]);
    const lock = s.log.indexOf("select capture_epoch::text as e from reporting_private.control where singleton for update");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(s.log.indexOf("select * from public.set_reporting_capture($1)"));
    expect(own.captureTransitions).toEqual([{ enable: true, before: "3", after: "4", state: "confirmed" }]);
    expect(expectedEpochIncrement(own)).toBe(1);
    // An uncertain transition is an explicit failure and adds nothing.
    const s2 = scripted({ epochAfter: "5", fail: (sql) => (sql === "commit" ? new Error("lost") : null) });
    const failures: string[] = [];
    await expect(ownedCall(ctxOf(async () => scripted().conn), own, failures)(s2.conn, "select * from public.set_reporting_capture($1)", [false])).rejects.toThrow("lost");
    expect(own.captureTransitions.at(-1)!.state).toBe("uncertain");
    expect(failures.join("; ")).toMatch(/uncertain commit; it is NOT added/);
    expect(expectedEpochIncrement(own)).toBe(1);
    expect(committedAllowance(own).epochIncrement).toBe(1);
    // The module never derives the allowance from an observed epoch.
    expect(readFileSync("tests/staging/reportingCommitted.ts", "utf8")).not.toMatch(/observeToggles|captureToggles/);
  });

  it("T13B2b-13: a preflight query or save failure BEFORE the first commit closes every session and runs no destructive cleanup", async () => {
    for (const [name, fail, save] of [
      ["preflight query", (sql: string) => (sql.startsWith("select json_build_object(") ? new Error("preflight boom") : null), () => undefined],
      ["ownership save", () => null, () => { throw new Error("disk full"); }],
    ] as const) {
      const s = scripted({ fail });
      const own = newOwnership(["uk", "au"], "rb");
      const failures: string[] = [];
      await expect(runCommitted(ctxOf(async () => s.conn, save), own, failures), name).rejects.toThrow();
      expect(s.rollbacks, name).toBeGreaterThanOrEqual(1);
      expect(s.ends, name).toBe(1);
      expect(own.committedAnything, name).toBe(false);
      expect(s.log.some((l) => /^delete|set_reporting_capture|^commit/.test(l)), name).toBe(false);
    }
  });

  it("T13B2b-11: an OPEN secondary writer (case A) is rolled back and closed BEFORE capture is restored; cleanup is one locked transaction", async () => {
    const order: string[] = [];
    let n = 0;
    let captureOn = false;
    const own = newOwnership(["uk", "au"], "rc");
    const failures: string[] = [];
    const open = async () => {
      const id = ++n;
      const s = scripted();
      const q = s.conn.query;
      s.conn.query = async (sql: string, p?: unknown[]) => {
        order.push(`${id}: ${sql.replace(/\s+/g, " ").trim()}`);
        if (sql.startsWith("select json_build_object(")) return q(sql, p); // PREFLIGHT_SQL also mentions publish_reporting_batch
        if (sql.includes("public.set_reporting_capture(")) captureOn = p?.[0] === true;
        if (sql.startsWith("select capture_enabled")) return { rows: [{ capture_enabled: captureOn }], rowCount: 1 };
        if (sql.includes("public.begin_reporting_rebuild(")) return { rows: [{ batch_id: `rb-${order.length}`, lease_fence: 1 }], rowCount: 1 };
        if (sql.includes("public.copy_reporting_source_page(")) return { rows: [{ complete: true, pages: 1, total_rows: 0, next_after_event_id: null }], rowCount: 1 };
        if (sql.includes("public.publish_reporting_batch(")) return { rows: [{ generation_id: `g-${order.length}`, generation_seq: String(order.length), replay: false }], rowCount: 1 };
        if (id === 1 && sql.includes("public.begin_reporting_batch(")) throw new Error("stop in case A");
        return q(sql, p);
      };
      const e = s.conn.end;
      s.conn.end = async () => (order.push(`${id}: END`), e());
      return s.conn;
    };
    await expect(runCommitted(ctxOf(open), own, failures)).rejects.toThrow("stop in case A");
    // Session 2 is case A's writer: begin + uncommitted insert were sent, then the run failed.
    expect(order.some((l) => l.startsWith("2: insert into public.production_events"))).toBe(true);
    const writerRollback = order.indexOf("2: rollback");
    const writerEnd = order.indexOf("2: END");
    const captureOff = order.findIndex((l, i) => i > writerRollback && l === "1: select * from public.set_reporting_capture($1)");
    const lock = order.indexOf("1: select 1 from reporting_private.control where singleton for share");
    expect(writerRollback).toBeGreaterThan(-1);
    expect(writerEnd).toBeGreaterThan(writerRollback);
    expect(captureOff).toBeGreaterThan(writerEnd);
    expect(lock).toBeGreaterThan(captureOff);
    expect(order[lock - 1]).toBe("1: begin");
    expect(order.slice(lock).some((l) => l === "1: commit")).toBe(true);
    expect(order.at(-1)).toBe("1: END");
    expect(own.captureTransitions.map((t) => [t.enable, t.state])).toEqual([[true, "confirmed"], [false, "confirmed"]]);
  });

  it("T13B2b-10: a failed delete rolls the WHOLE cleanup transaction back (nothing half-deleted) and is kept", async () => {
    const own = owned();
    own.identities = own.identities.filter((i) => i.state !== "absent");
    const s = scripted({ fail: (sql) => (sql.includes("delete from reporting_private.cancel_edges") ? new Error("injected") : null) });
    const failures: string[] = [];
    // Discovery returns the run's own pointers.
    const q = s.conn.query;
    s.conn.query = async (sql: string, p?: unknown[]) => (sql.includes("active_batch_id::text as b from reporting_private.site_state") ? { rows: [{ site: "au", g: "g1", b: null }, { site: "uk", g: "g2", b: null }], rowCount: 2 } : q(sql, p));
    await cleanup(s.conn, ctxOf(async () => scripted().conn), own, failures);
    const lock = s.log.indexOf("select 1 from reporting_private.control where singleton for share");
    expect(lock).toBeGreaterThan(-1);
    expect(s.log[lock - 1]).toBe("begin");
    const del = s.log.findIndex((l) => l.startsWith("delete from reporting_private.cancel_edges"));
    expect(s.log.slice(del + 1)).not.toContain("commit");
    expect(s.log.slice(del + 1)).toContain("rollback");
    expect(s.log.some((l) => l.startsWith("delete from reporting_private.timing_facts"))).toBe(false); // stopped, then rolled back
    expect(failures.join("; ")).toMatch(/cleanup transaction failed and was rolled back \(nothing deleted\): injected/);
  });

  it("T13B2b-10: a discovery failure is reported and retains everything (no delete is sent)", async () => {
    const own = owned();
    own.identities = own.identities.filter((i) => i.state !== "absent");
    const s = scripted({ fail: (sql) => (sql.includes("as ids from reporting_private.changes") ? new Error("discovery boom") : null) });
    const failures: string[] = [];
    await cleanup(s.conn, ctxOf(async () => scripted().conn), own, failures);
    expect(s.log.some((l) => l.startsWith("delete"))).toBe(false);
    expect(failures.join("; ")).toMatch(/dependency discovery failed; everything is retained: discovery boom/);
    expect(failures.join("; ")).toMatch(/retained: dependency discovery failed/);
  });

  it("the harness is a separate, explicit mode; the rollback-only modes never commit", () => {
    expect(parsePublicationArgs(["--committed-interleavings", "--sites=uk,au"]).mode).toBe("committed-interleavings");
    expect(parsePublicationArgs(["--baseline-smoke", "--sites=uk,au"]).mode).toBe("baseline-smoke");
    const mod = readFileSync("tests/staging/reportingCommitted.ts", "utf8");
    expect(mod).toContain('await c.query("commit");');
    expect(mod).not.toMatch(/disable trigger|session_replication_role|truncate|statement_timeout|lock_timeout\s*=/i);
    expect(readFileSync("tests/staging/reportingPublication.ts", "utf8")).not.toMatch(/\.query\(\s*["'`]\s*commit/i);
  });
});

// ---------------------------------------------------------------------------
// B2b round 2 (T13B2b-8/9) and early-review residuals
// ---------------------------------------------------------------------------

import { scopedImageDiff, STATE_QUERIES as STATE_Q, surface } from "../staging/reportingPublication";
import { noteIdentities, resolveIdentities } from "../staging/reportingCommitted";

describe("T13B2b-8: baseline catalog queries", () => {
  it("every catalog name/\"char\" column that is concatenated is cast to text (the staging failure was text || \"char\")", () => {
    const cols = "relkind|tgenabled|relname|nspname|proname|tgname|attname|conname|rolname|schemaname|tablename|policyname";
    for (const [name, sql] of STATE_Q) {
      expect(sql, name).not.toMatch(new RegExp(`(?<![\\w.])(?:[a-z]\\.)?(?:${cols})(?!::text)\\s*\\|\\|`));
      expect(sql, name).not.toMatch(new RegExp(`\\|\\|\\s*(?:[a-z]\\.)?(?:${cols})(?![\\w(])(?!::text)`));
      expect(sql, name).not.toMatch(/pg_get_userbyid\([a-z.]+\)(?!::text)/);
    }
    expect(Object.fromEntries(STATE_Q)["catalog:relations"]).toContain("c.relkind::text");
    expect(Object.fromEntries(STATE_Q)["catalog:triggers"]).toContain("t.tgenabled::text");
  });
  it("a failing surface is named and keeps the original error and SQLSTATE", async () => {
    const db = { query: async () => { throw Object.assign(new Error('operator is not unique: text || "char"'), { code: "42725" }); } };
    const e = await surface(db, "catalog:relations", "select 1").catch((x) => x);
    expect(e.message).toBe('baseline surface catalog:relations failed: 42725 operator is not unique: text || "char"');
    expect(e.code).toBe("42725");
    expect(e.cause.message).toBe('operator is not unique: text || "char"');
  });
  it("--baseline-smoke is read-only and signs nobody in", () => {
    const runner = readFileSync("tests/staging/reporting-jobs.ts", "utf8");
    expect(runner).toContain('if (mode === "baseline-smoke") claims = {};');
    const smoke = runner.slice(runner.indexOf('if (mode === "baseline-smoke") {'), runner.indexOf("return;", runner.indexOf('if (mode === "baseline-smoke") {')));
    expect(smoke).not.toMatch(/\.query\(|begin|insert|update|delete/i);
    expect(runner.indexOf('if (mode === "baseline-smoke") {')).toBeLessThan(runner.indexOf('      if (mode === "committed-interleavings") {'));
  });
});

describe("T13B2b-9: exact scoped image equality", () => {
  const row = (id: string, img = `{"id": "${id}"}`) => ({ event_id: id, image: img });
  const ok = { source: [row("rp-v1"), row("rp-v6")], mirror: [row("rp-v1"), row("rp-v6")], versions: [row("rp-v1"), row("rp-v6")] };
  it("equal sets pass; a missing current version (rp-v6), an extra, a mismatch or a duplicate each fail", () => {
    expect(scopedImageDiff(ok)).toEqual([]);
    expect(scopedImageDiff({ ...ok, versions: [row("rp-v1")] })).toEqual(["rp-v6 is in source but missing from versions", "rp-v6 is in mirror but missing from versions"]);
    expect(scopedImageDiff({ ...ok, mirror: [...ok.mirror, row("rp-x1")] })).toEqual(["rp-x1 is in mirror but not in source", "rp-x1 is in mirror but missing from versions"]);
    expect(scopedImageDiff({ ...ok, mirror: [row("rp-v1"), row("rp-v6", '{"id": "other"}')] })).toEqual(["rp-v6 differs between source and mirror", "rp-v6 differs between mirror and versions"]);
    expect(scopedImageDiff({ ...ok, versions: [...ok.versions, row("rp-v6")] })).toEqual(["versions has rp-v6 twice"]);
  });
  it("F9j uses the exact helper in both directions (not inner joins and counts)", () => {
    const mod = readFileSync("tests/staging/reportingPublication.ts", "utf8");
    expect(mod).toContain("{ problems: scopedImageDiff(sets), sourceRows: sets.source.length }, { problems: [], sourceRows: idsR.length - 4 }");
    expect(mod).not.toContain("FIXTURE_IMAGE_SQL");
  });
});

describe("early-review residuals", () => {
  it("(1) a REUSED batch this run does not own is refused BEFORE COMMIT; a known owned replay is allowed", async () => {
    const own = newOwnership(["uk", "au"], "rr");
    expect(() => noteIdentities(own, "select * from public.begin_reporting_batch($1)", [{ batch_id: "ext-1", reused: true }])).toThrow(/reused batch ext-1 that this run does not own/);
    expect(own.identities).toEqual([]);
    own.identities.push({ kind: "batch", id: "mine", seq: null, state: "confirmed" });
    expect(noteIdentities(own, "select * from public.begin_reporting_batch($1)", [{ batch_id: "mine", reused: true }])).toEqual([]);
    // Through the call: the refusal rolls back, nothing is committed or adopted.
    const log: string[] = [];
    const conn = {
      query: async (sql: string) => {
        log.push(sql);
        if (sql.startsWith("select current_user")) return { rows: [{ u: "service_role", claims: '{"role":"service_role"}' }], rowCount: 1 };
        if (sql.startsWith("select pg_backend_pid")) return { rows: [{ p: 1 }], rowCount: 1 };
        if (sql === BEGIN_GUARD_SQL.control || sql === BEGIN_GUARD_SQL.site) return { rows: [{ e: "3", b: null }], rowCount: 1 };
        if (sql.includes("begin_reporting_batch")) return { rows: [{ batch_id: "ext-2", reused: true }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      end: async () => undefined,
    };
    const own2 = newOwnership(["uk", "au"], "rs");
    await expect(ownedCall({ as: async () => undefined, save: () => undefined, open: async () => conn, redact: (s) => s }, own2, [])(conn, "select * from public.begin_reporting_batch($1)", ["uk"])).rejects.toThrow(/does not own/);
    expect(log).not.toContain("commit");
    expect(log.at(-1)).toBe("rollback");
    expect(own2.identities).toEqual([]);
  });

  it("(2) every resolution path keeps the origin receipt: cleanup's retry cannot conclude absence while the backend is present", async () => {
    const ids = [{ kind: "generation" as const, id: "g7", seq: "7", state: "uncertain" as const, origin: { pid: 77, settled: false } }];
    const lookups: string[] = [];
    let alive = true;
    const fresh = () => ({
      query: async (sql: string) => {
        if (sql.includes("pg_stat_activity")) return { rows: [{ x: alive }], rowCount: 1 };
        lookups.push(sql);
        return { rows: [{ x: false }], rowCount: 1 };
      },
      end: async () => undefined,
    });
    const failures: string[] = [];
    await resolveIdentities({ open: async () => fresh(), redact: (s) => s, sleep: async () => undefined }, ids, failures);
    expect(ids[0].state).toBe("uncertain");
    expect(lookups).toEqual([]); // no absence lookup while the backend is present
    expect(failures).toEqual(["originating session 77 of generation g7 is still present; it stays uncertain"]);
    alive = false;
    await resolveIdentities({ open: async () => fresh(), redact: (s) => s, sleep: async () => undefined }, ids, []);
    expect(ids[0]).toMatchObject({ state: "absent", origin: { pid: 77, settled: true } });
    expect(lookups).toHaveLength(1);
    // cleanup() resolves through the same function (no bare lookup path).
    const mod = readFileSync("tests/staging/reportingCommitted.ts", "utf8");
    expect(mod.match(/from reporting_private\.(batches|generations) where (batch_id|generation_id) = \$1::uuid\) as x/g)).toHaveLength(2);
  });

  it("(3) the capture prelock runs under the same 3 s transaction-local cap, keeping a stricter limit", async () => {
    for (const [existing, expectSet] of [["0", true], ["5000", true], ["1000", false], ["3000", false]] as const) {
      const log: string[] = [];
      const conn = {
        query: async (sql: string) => {
          log.push(sql);
          if (sql.includes("name = 'lock_timeout'")) return { rows: [{ ms: existing }], rowCount: 1 };
          if (sql.startsWith("select current_user")) return { rows: [{ u: "service_role", claims: '{"role":"service_role"}' }], rowCount: 1 };
          if (sql.startsWith("select pg_backend_pid")) return { rows: [{ p: 1 }], rowCount: 1 };
          if (sql.includes("for update")) return { rows: [{ e: "3" }], rowCount: 1 };
          if (sql.includes("set_reporting_capture")) return { rows: [{ capture_epoch: "4" }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        end: async () => undefined,
      };
      await ownedCall({ as: async () => undefined, save: () => undefined, open: async () => conn, redact: (s) => s }, newOwnership(["uk", "au"], "rt"), [])(conn, "select * from public.set_reporting_capture($1)", [true]);
      const set = log.indexOf("select set_config('lock_timeout', '3s', true)");
      const prelock = log.findIndex((l) => l.includes("for update"));
      expect(set > -1, existing).toBe(expectSet);
      if (expectSet) expect(set, existing).toBeLessThan(prelock);
      expect(log.findIndex((l) => l.includes("name = 'lock_timeout'")), existing).toBeLessThan(prelock);
    }
  });
});

describe("T13B2b-14: fixtures are admissible under the source constraints", () => {
  it("every runner fixture passes the 0012/0029/0030 constraints; rp-x1 keeps a trimmed-blank order and its event partition", () => {
    const rows = fixtureRows(STAFF);
    for (const site of ["uk", "us", "au"]) expect(rows.flatMap((x) => productionEventAdmissibility(x, site))).toEqual([]);
    const x1 = rows.find((x) => x.id === "rp-x1")!;
    expect(x1.order_number).toBe(BLANK_ORDER);
    expect(evidenceOrderKey(x1.order_number)).toBe("");
    // The variants the harness inserts later (rp-v6, rp-i2, rp-i3) and every committed-mode fixture.
    for (const id of ["rp-v6", "rp-i2", "rp-i3"]) expect(productionEventAdmissibility({ ...rows[0], id }, "uk")).toEqual([]);
    for (const k of ["low", "high", "b", "c", "m"]) expect(productionEventAdmissibility(fxRow(STAFF, `rc-abcd1234-${k}`, "RC-abcd1234-A", "2026-01-13T09:00:00Z"), "uk")).toEqual([]);
  });

  it("the OLD empty-string fixture fails the contract (the staging 23514), as do other constraint breaks", () => {
    const old = { ...fixtureRows(STAFF).find((x) => x.id === "rp-x1")!, order_number: "" };
    expect(productionEventAdmissibility(old, "uk")).toEqual(['rp-x1: order_number "" violates production_events_order_number_check']);
    const base = fixtureRows(STAFF)[0];
    expect(productionEventAdmissibility({ ...base, order_number: null }, "uk").join()).toMatch(/order_number_check/);
    expect(productionEventAdmissibility({ ...base, event_type: "clock_in", order_number: "RP-1" }, "uk").join()).toMatch(/order_number_check/);
    expect(productionEventAdmissibility({ ...base, event_type: "clock_in", order_number: null }, "uk")).toEqual([]);
    expect(productionEventAdmissibility({ ...base, department: "x" }, "uk").join()).toMatch(/department_check/);
    expect(productionEventAdmissibility({ ...base, event_type: "verified" }, "uk").join()).toMatch(/event_type_check/);
    expect(productionEventAdmissibility({ ...base, line_quantity: 0 }, "uk").join()).toMatch(/line_quantity_check/);
    expect(productionEventAdmissibility({ ...base, staff_id: "nope" }, "uk").join()).toMatch(/uuid/);
    expect(productionEventAdmissibility(base, "eu").join()).toMatch(/locations key/);
  });

  it("insertFixtures refuses an inadmissible row before sending any SQL", async () => {
    const sent: string[] = [];
    const c = { query: async (sql: string) => (sent.push(sql), { rows: [], rowCount: 0 }) } as unknown as Db;
    await expect(insertFixtures(c, "uk", [{ ...fixtureRows(STAFF)[0], order_number: "" }])).rejects.toThrow(/order_number_check/);
    expect(sent).toEqual([]);
    await insertFixtures(c, "uk", fixtureRows(STAFF));
    expect(sent).toHaveLength(fixtureRows(STAFF).length);
  });
});

describe("T13B2b-15: foreign live batches are refused under the begin RPC's own locks", () => {
  type Rec = { log: string[]; conn: Conn };
  function conn(state: { pointer: string | null; live: string[] }, beginRows: Array<Record<string, unknown>>): Rec {
    const r: Rec = { log: [], conn: null as unknown as Conn };
    r.conn = {
      query: async (sql: string) => {
        r.log.push(sql);
        if (sql.startsWith("select current_user")) return { rows: [{ u: "service_role", claims: '{"role":"service_role"}' }], rowCount: 1 };
        if (sql.startsWith("select pg_backend_pid")) return { rows: [{ p: 1 }], rowCount: 1 };
        if (sql === BEGIN_GUARD_SQL.control) return { rows: [{ e: "5" }], rowCount: 1 };
        if (sql === BEGIN_GUARD_SQL.site) return { rows: [{ b: state.pointer }], rowCount: 1 };
        if (sql === BEGIN_GUARD_SQL.batches) return { rows: state.live.map((b) => ({ b, state: "active" })), rowCount: state.live.length };
        if (/public\.begin_reporting_(batch|rebuild)\(/.test(sql)) {
          // The RPC's real effect on an epoch-drifted foreign batch: fail it, clear the pointer, return a NEW id.
          state.live = [];
          state.pointer = String(beginRows[0]?.batch_id ?? "");
          return { rows: beginRows, rowCount: beginRows.length };
        }
        return { rows: [], rowCount: 0 };
      },
      end: async () => undefined,
    };
    return r;
  }
  const ctx = (c: Conn) => ({ as: async () => undefined, save: () => undefined, open: async () => c, redact: (s: string) => s });

  for (const fn of ["begin_reporting_rebuild", "begin_reporting_batch"]) {
    it(`${fn}: an unknown epoch-drifted external batch is refused BEFORE the RPC (which would return a NEW id); state and pointer are untouched`, async () => {
      const state = { pointer: "ext-drifted", live: ["ext-drifted"] };
      const r = conn(state, [{ batch_id: "new-1", lease_fence: 2, reused: false }]);
      const own = newOwnership(["uk", "au"], "g1");
      await expect(ownedCall(ctx(r.conn), own, [])(r.conn, `select * from public.${fn}($1)`, ["uk"])).rejects.toThrow(/live batch\(es\) this run does not own \[ext-drifted\]/);
      expect(r.log.some((l) => l.includes(`public.${fn}(`))).toBe(false); // the RPC never ran
      expect(state).toEqual({ pointer: "ext-drifted", live: ["ext-drifted"] });
      expect(r.log).not.toContain("commit");
      expect(r.log.at(-1)).toBe("rollback");
      expect(own.identities).toEqual([]);
      // Lock order = the RPC's: control share, then site row, then the live batches; all before the RPC.
      const i = (q: string) => r.log.indexOf(q);
      expect(i(BEGIN_GUARD_SQL.control)).toBeGreaterThan(-1);
      expect(i(BEGIN_GUARD_SQL.control)).toBeLessThan(i(BEGIN_GUARD_SQL.site));
      expect(i(BEGIN_GUARD_SQL.site)).toBeLessThan(i(BEGIN_GUARD_SQL.batches));
    });
  }

  it("a foreign active POINTER alone (no live row) is refused too", async () => {
    const state = { pointer: "ext-ptr", live: [] as string[] };
    const r = conn(state, [{ batch_id: "new-2" }]);
    await expect(ownedCall(ctx(r.conn), newOwnership(["uk", "au"], "g2"), [])(r.conn, "select * from public.begin_reporting_rebuild($1)", ["uk"])).rejects.toThrow(/\[ext-ptr\]/);
    expect(state.pointer).toBe("ext-ptr");
  });

  it("a foreign live batch ROW alone (pointer already cleared) is refused too", async () => {
    const state = { pointer: null as string | null, live: ["ext-row"] };
    const r = conn(state, [{ batch_id: "new-4" }]);
    await expect(ownedCall(ctx(r.conn), newOwnership(["uk", "au"], "g6"), [])(r.conn, "select * from public.begin_reporting_batch($1)", ["uk"])).rejects.toThrow(/\[ext-row\]/);
    expect(state).toEqual({ pointer: null, live: ["ext-row"] });
  });

  it("a KNOWN-owned live batch is allowed through: the reused replay commits under the same transaction's locks", async () => {
    const state = { pointer: "mine-1", live: ["mine-1"] };
    const r = conn(state, [{ batch_id: "mine-1", lease_fence: 3, reused: true }]);
    const own = newOwnership(["uk", "au"], "g3");
    own.identities.push({ kind: "batch", id: "mine-1", seq: null, state: "confirmed" });
    const rows = await ownedCall(ctx(r.conn), own, [])(r.conn, "select * from public.begin_reporting_batch($1)", ["uk"]);
    expect(rows).toEqual([{ batch_id: "mine-1", lease_fence: 3, reused: true }]);
    expect(own.identities.map((i) => `${i.id}:${i.state}`)).toEqual(["mine-1:confirmed"]); // no duplicate identity
    const begin = r.log.indexOf("begin");
    const guard = r.log.indexOf(BEGIN_GUARD_SQL.control);
    const rpcAt = r.log.findIndex((l) => l.includes("public.begin_reporting_batch("));
    const commit = r.log.indexOf("commit");
    expect(begin).toBeLessThan(guard);
    expect(guard).toBeLessThan(rpcAt);
    expect(rpcAt).toBeLessThan(commit);
    expect(r.log.slice(begin, commit).filter((l) => l === "begin" || l === "commit" || l === "rollback")).toEqual(["begin"]); // one transaction: no gap between check and use
  });

  it("no live batch: begin proceeds and the NEW id is recorded tentative then confirmed", async () => {
    const r = conn({ pointer: null, live: [] }, [{ batch_id: "new-3", lease_fence: 1, reused: false }]);
    const own = newOwnership(["uk", "au"], "g4");
    await ownedCall(ctx(r.conn), own, [])(r.conn, "select * from public.begin_reporting_rebuild($1)", ["uk"]);
    expect(own.identities.map((i) => `${i.id}:${i.state}`)).toEqual(["new-3:confirmed"]);
  });

  it("a missing control or site row refuses (never treated as 'nothing active')", async () => {
    const mk = (drop: string) => ({ query: async (sql: string) => (sql === drop ? { rows: [], rowCount: 0 } : sql === BEGIN_GUARD_SQL.site ? { rows: [{ b: null }], rowCount: 1 } : { rows: [{ e: "1" }], rowCount: 1 }) }) as unknown as Db;
    const own = newOwnership(["uk", "au"], "g5");
    await expect(guardBeginOwnership(mk(BEGIN_GUARD_SQL.control), own, "uk")).rejects.toThrow(/control row is missing/);
    await expect(guardBeginOwnership(mk(BEGIN_GUARD_SQL.site), own, "uk")).rejects.toThrow(/site_state for uk is missing/);
    await expect(guardBeginOwnership(mk(""), own, undefined)).rejects.toThrow(/site argument is missing/);
  });

  it("the guard SQL takes the RPC's locks: control FOR SHARE, site FOR UPDATE, live batches FOR UPDATE", () => {
    expect(BEGIN_GUARD_SQL.control).toMatch(/from reporting_private\.control c where c\.singleton for share$/);
    expect(BEGIN_GUARD_SQL.site).toMatch(/from reporting_private\.site_state s where s\.site = \$1 for update$/);
    expect(BEGIN_GUARD_SQL.batches).toMatch(/b\.state in \('active', 'frozen', 'publishing'\).* for update$/);
  });
});
