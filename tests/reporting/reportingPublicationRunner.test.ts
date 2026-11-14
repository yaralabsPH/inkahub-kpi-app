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
  BASELINE_SQL,
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
    expect(owners.map((o) => `${o.owner.partitionKind}:${o.owner.partitionKey}`).sort()).toEqual(["event:rp-x1", "order:RP-1", "order:RP-M"]);
    const rp1 = owners.find((o) => o.owner.partitionKey === "RP-1")!.rows;
    expect(rp1.source_issue_facts.map((x) => x.event_id)).toEqual([WS_ID]);
    expect(rp1.cancel_edges).toMatchObject([{ cancel_event_id: "rp-c3", parent_event_id: "rp-v3", parent_role: "verification", pair: "valid" }]);
    for (const o of owners) for (const t of RESULT_TABLES) for (const row of o.rows[t]) expect(resultRowProblem(t, row), `${t} ${String(row.event_id ?? row.cancel_event_id)}`).toBeNull();
  });

  it("reducer daily: excluded and unclassified lines are lines with zero Items; the cancelled line is gone", () => {
    const events = fixtureRows(STAFF).map((x) => ({ ...x, location: "uk", cs_case_id: null })) as never[];
    // v1 (2) + m1 (1) counted; v2 excluded and v5 unclassified are lines with 0 Items; v3 cancelled;
    // x1 (blank order) is an INVALID verification, not a line; the whitespace-id row is a source issue.
    expect(reducerDaily("uk", events, "2026-11-15T00:00:00Z", null)).toEqual([`2026-01-12|${STAFF}|framed|false|3|4`]);
    expect(reducerDaily("uk", events, "2026-11-15T00:00:00Z", STAFF)).toEqual([`2026-01-12|${STAFF}|framed|false|3|4`]);
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
    expect(pub).toContain("return after === before ? [] : [`baseline differs after rollback");
  });
  it("the baseline covers control, site state, every reporting row family, fixtures and source fingerprints", () => {
    for (const k of ["'control'", "'sites'", "'changes'", "'batches'", "'generations'", "'event_facts'", "'daily'", "'mirror'", "'fixtures'", "md5(string_agg(id"]) expect(BASELINE_SQL).toContain(k);
  });
  it("the flow covers every reviewed regression and publication property", () => {
    for (const id of ["B2a-1a", "B2a-1b", "B2a-1c", "B2a-2a", "B2a-2b", "B2a-2c", "B2a-0", "B2a-3a", "B2a-3b", "B2a-3c", "B2a-r", "P0", "P2b", "P2c", "P2d", "P2e", "P3a", "P3b", "F6", "F7", "F8a", "F9a", "F9b", "F9c", "F9d", "F9e", "F9f", "X3a", "X3b", "N2a"]) expect(MOD, id).toContain(`"${id}"`);
    for (const id of ["I0", "I1", "I2", "I3", "I4", "I5"]) expect(MOD, id).toContain(`run("${id}"`);
  });
});
