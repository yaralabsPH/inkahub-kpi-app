/**
 * Read-only installed-state inspection (offline). A PGlite database with the
 * REAL migrations 0037-0045 applied stands in for staging; a second fresh one
 * supplies the expected catalog. Nothing reaches a network database.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { reportingDb } from "./pg/harness";
import type { Db } from "../staging/reportingPublication";
import { INSTALLED_HISTORY } from "../staging/reportingWorkerHarness";
import {
  ALLOWED_SQL, BEGIN_RO, CONTRACT_SQL, EXPECTED_RECEIPTS, expectedFunctions, fileProblems, inspectInstalled, inspectionGuard, inspectionMarkdown, inspectionStatus,
  parseInspectArgs, receiptProblems, REVIEWED_LF, ROLLBACK, summarisePriorRun, type InspectDeps, type InspectionReport, type Row,
} from "../staging/reportingInstalledState";

const read = (p: string) => readFileSync(p, "utf8");
const TEXTS = Object.fromEntries(Object.entries(REVIEWED_LF).map(([m, p]) => [m, read(p.path)]));
const RECEIPTS = EXPECTED_RECEIPTS.map((e, i) => ({ version: e.version ?? `2026111720000${i}`, name: e.name }));

async function stagingLike(): Promise<PGlite> {
  const db = await reportingDb();
  await db.exec("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[])");
  for (const r of RECEIPTS) await db.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, array['x'])", [r.version, r.name]);
  return db;
}

/** A connection over PGlite that logs EVERY statement it receives (inside or outside the guard). */
function conn(db: PGlite, log: string[], fail?: (sql: string) => boolean) {
  let ended = false;
  const c: Db & { end(): Promise<void>; ended: () => boolean } = {
    query: async (sql, params) => {
      log.push(sql);
      if (fail?.(sql)) throw new Error("simulated query failure");
      const r = await db.query<Record<string, unknown>>(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    end: async () => void (ended = true),
    ended: () => ended,
  };
  return c;
}

let expectedDb: PGlite;
const expectedContracts = async (names: string[]) => (await expectedDb.query<Row>(CONTRACT_SQL, [names])).rows;

function deps(db: PGlite, log: string[], over: Partial<InspectDeps> = {}): InspectDeps & { saved: InspectionReport[] } {
  const saved: InspectionReport[] = [];
  return {
    revision: "test", read, open: async () => conn(db, log), expectedContracts, priorRuns: () => [],
    now: () => new Date("2026-11-18T00:00:00Z"), redact: (s) => s, save: (r) => saved.push(JSON.parse(JSON.stringify(r))), saved, ...over,
  };
}

const writes = (log: readonly string[]) => log.filter((s) => s !== BEGIN_RO && s !== ROLLBACK && !/^\s*select\b/i.test(s));

beforeAll(async () => {
  expectedDb = await reportingDb();
}, 120_000);
afterAll(async () => {
  await expectedDb.close();
});

describe("arguments", () => {
  it("accepts exactly --inspect-installed --sites=au,uk,us", () => {
    expect(parseInspectArgs(["--inspect-installed", "--sites=au,uk,us"]).ok).toBe(true);
  });
  it.each([
    [["--inspect-installed"]],
    [["--inspect-installed", "--sites=uk,us"]],
    [["--inspect-installed", "--sites=au,uk,us", "--worker-runtime"]],
    [["--inspect-installed", "--sites=au,uk,us", "--site=uk"]],
    [["--inspect-installed", "--inspect-installed", "--sites=au,uk,us"]],
    [["--inspect-installed", "--sites=au,uk,us", "--project=lkboboagiikvozvbcpvg"]],
  ])("refuses wrong, mixed or production flags before any connection (%#)", (argv) => {
    expect(parseInspectArgs(argv).ok).toBe(false);
  });
});

describe("pure identity checks", () => {
  it("pins the reviewed files exactly and rejects an edited one", () => {
    expect(fileProblems(TEXTS).problems).toEqual([]);
    expect(fileProblems({ ...TEXTS, "0044": TEXTS["0044"] + "\n-- edit" }).problems[0]).toMatch(/0044 file is not the reviewed one/);
    expect(fileProblems({ ...TEXTS, "0045": TEXTS["0045"].replace(/\r?\n/g, "\r\n") }).problems).toEqual([]); // a CRLF checkout is the same LF identity
    expect(fileProblems({ ...TEXTS, "0045": TEXTS["0045"].replace(/\r?\n/g, "\n") }).problems).toEqual([]);
  });
  it("requires every 0040-0045 receipt exactly once and refuses unexpected ones", () => {
    expect(receiptProblems(RECEIPTS)).toEqual([]);
    expect(receiptProblems(RECEIPTS.filter((r) => r.name !== "0044_reporting_reads")).join(";")).toMatch(/0 receipts for 0044_reporting_reads/);
    expect(receiptProblems([...RECEIPTS, { version: "x", name: "0045_reporting_predecessor_page" }]).join(";")).toMatch(/2 receipts for 0045/);
    expect(receiptProblems(RECEIPTS.map((r) => (r.name === INSTALLED_HISTORY[0].name ? { ...r, version: "1" } : r))).join(";")).toMatch(/0040/);
    expect(receiptProblems([...RECEIPTS, { version: "y", name: "0046_reporting_extra" }]).join(";")).toMatch(/unexpected 004x/);
  });
  it("covers the private 0044 helpers, not only the public entry points", () => {
    const names = expectedFunctions(TEXTS);
    expect(names).toContain("reporting_private.sel_report");
    expect(names).toContain("public.read_reporting_predecessor_page");
    expect(names).toContain("reporting_private.frozen_read_batch");
  });
  it("the guard refuses anything outside the read-only allowlist without sending it", async () => {
    const log: string[] = [];
    const g = inspectionGuard({ query: async (sql: string) => (log.push(sql), { rows: [], rowCount: 0 }) }, []);
    await expect(g.query("update reporting_private.control set capture_enabled = true")).rejects.toThrow(/allowlist/);
    await expect(g.query("select public.read_reporting_summary()")).rejects.toThrow(/allowlist/);
    expect(log).toEqual([]);
    for (const s of ALLOWED_SQL) expect(s === BEGIN_RO || s === ROLLBACK || /^\s*select\b/i.test(s)).toBe(true);
  });
  it("summarises prior run reports by exact bytes", () => {
    const b = Buffer.from("# Reporting worker staging evidence (worker-runtime)\n\n- project: x · site: uk · revision: abc\n\nSTATUS: FAILED – something\n");
    const s = summarisePriorRun("staging-results-reporting-worker-worker-runtime-1-aaaaaaaa.md", b);
    expect(s).toMatchObject({ mode: "worker-runtime", site: "uk", status: "STATUS: FAILED – something" });
    expect(s.sha256).toHaveLength(64);
  });
});

describe("inspection against PGlite with 0037-0045 installed", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await stagingLike();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it("collects completely with zero mutation, two read-only transactions, and reports COMPLETE with per-site readiness", async () => {
    const log: string[] = [];
    const d = deps(db, log);
    const r = await inspectInstalled(d);
    expect(r.errors).toEqual([]);
    expect(r.identityProblems).toEqual([]);
    expect(r.receiptProblems).toEqual([]);
    expect(r.collationProblems).toEqual([]);
    expect(r.drift).toEqual([]);
    expect(writes(log)).toEqual([]);
    expect(log.filter((s) => s === BEGIN_RO)).toHaveLength(2);
    expect(log.filter((s) => s === ROLLBACK)).toHaveLength(2);
    expect(r.readOnly).toMatchObject({ first: "on", fresh: "on", rolledBack: true, nonSelect: [] });
    expect(r.functions.every((f) => f.bodyMatch === "lf" || f.bodyMatch === "crlf")).toBe(true);
    expect(r.functions.length).toBe(expectedFunctions(TEXTS).length);
    expect(r.sites.map((s) => s.site)).toEqual(["au", "uk", "us"]);
    expect(inspectionStatus(r)).toBe("STATUS: COMPLETE");
    expect(inspectionMarkdown(r)).toMatch(/STATUS: COMPLETE\n$/);
    expect(d.saved.length).toBeGreaterThan(1); // durable before connecting and at the end
  }, 120_000);

  it("an ineligible site is COMPLETE with runtimeReady false and every failed R0 condition listed", async () => {
    const t = await stagingLike();
    try {
      await t.exec("UPDATE reporting_private.control SET capture_enabled = true WHERE singleton");
      const r = await inspectInstalled(deps(t, []));
      expect(inspectionStatus(r)).toBe("STATUS: COMPLETE");
      expect(r.runtimeReady).toBe(false);
      for (const s of r.sites) expect(s.failedR0.join(";")).toMatch(/capture is enabled/);
    } finally {
      await t.close();
    }
  }, 120_000);

  it.each([
    ["an ACL change", "GRANT EXECUTE ON FUNCTION public.read_reporting_generation(text, uuid) TO anon", /read_reporting_generation security differs/],
    ["a definer change", "ALTER FUNCTION reporting_private.utc_text(timestamptz) SECURITY DEFINER", /utc_text security differs/],
    ["a missing 0046 receipt", "DELETE FROM supabase_migrations.schema_migrations WHERE name = '0046_reporting_owner_inputs'", /0 receipts for 0046/],
    ["a duplicate 0045 receipt", "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('29991231000000', '0045_reporting_predecessor_page')", /2 receipts for 0045/],
    ["an absent 0046 function", "DROP FUNCTION public.reporting_owner_input_version()", /reporting_owner_input_version found 0 times/],
    ["an authenticated grant on a 0046 function", "GRANT EXECUTE ON FUNCTION public.reporting_owner_input_version() TO authenticated", /reporting_owner_input_version security differs/],
    ["an authenticated grant on a 0046 table", "GRANT SELECT ON reporting_private.owner_inputs TO authenticated", /table owner_inputs access differs/],
    ["an altered 0046 body", "CREATE OR REPLACE FUNCTION public.reporting_owner_input_version() RETURNS TABLE (version integer) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$ select 2 $$", /reporting_owner_input_version body is not the reviewed/],
    ["an extra overload", "CREATE FUNCTION reporting_private.safe_count(p integer) RETURNS bigint LANGUAGE sql AS $$ select 1::bigint $$", /safe_count found 2 times/],
    ["an absent function", "DROP FUNCTION reporting_private.utc_text(timestamptz) CASCADE", /utc_text found 0 times/],
    ["a volatility change", "ALTER FUNCTION reporting_private.safe_items(numeric) VOLATILE", /safe_items volatility differs/],
  ])("FAILS on %s and still writes nothing", async (_what, sql, re) => {
    const t = await stagingLike();
    try {
      await t.exec(sql);
      const log: string[] = [];
      const r = await inspectInstalled(deps(t, log));
      expect(inspectionStatus(r)).toMatch(/^STATUS: FAILED/);
      expect([...r.identityProblems, ...r.receiptProblems].join(";")).toMatch(re);
      expect(writes(log)).toEqual([]);
    } finally {
      await t.close();
    }
  }, 120_000);

  it("the staging exception: ABSENT 0044/0045 receipts are accepted and labelled when every effective check holds", async () => {
    const t = await stagingLike();
    try {
      await t.exec("DELETE FROM supabase_migrations.schema_migrations WHERE name IN ('0044_reporting_reads', '0045_reporting_predecessor_page')");
      const log: string[] = [];
      const r = await inspectInstalled(deps(t, log));
      expect(inspectionStatus(r)).toBe("STATUS: COMPLETE");
      expect(r.receiptProblems).toEqual([]);
      expect(r.rawReceiptFindings).toHaveLength(2); // the raw findings are kept, not suppressed
      expect(r.acceptedReceiptFindings).toEqual(r.rawReceiptFindings);
      expect(inspectionMarkdown(r)).toMatch(/Accepted receipt findings \(staging exception[^\n]*\n\n- migration history has 0 receipts for 0044_reporting_reads/);
      expect(writes(log)).toEqual([]);
    } finally {
      await t.close();
    }
  }, 120_000);

  it("the exception is void when anything else fails: an absent 0045 receipt beside an authenticated grant blocks", async () => {
    const t = await stagingLike();
    try {
      await t.exec("DELETE FROM supabase_migrations.schema_migrations WHERE name = '0045_reporting_predecessor_page'; GRANT EXECUTE ON FUNCTION public.read_reporting_predecessor_page(uuid, bigint, uuid, timestamptz, text, timestamptz, text, integer) TO authenticated");
      const r = await inspectInstalled(deps(t, []));
      expect(inspectionStatus(r)).toMatch(/^STATUS: FAILED/);
      expect(r.acceptedReceiptFindings).toEqual([]);
      expect(r.receiptProblems.join(";")).toMatch(/0 receipts for 0045/);
      expect(r.runtimeReady).toBe(false);
    } finally {
      await t.close();
    }
  }, 120_000);

  /** Rewrite one function's installed prosrc md5 as the catalog reports it (an altered body). */
  const bodyAs = (log: string[], fn: string, md5: (lf: string, crlf: string) => string) => async () => {
    const c = conn(db, log);
    return {
      ...c,
      query: async (sql: string, params?: unknown[]) => {
        const r = await c.query(sql, params);
        if (sql !== CONTRACT_SQL) return r;
        return { ...r, rows: r.rows.map((x) => (`${String(x.schema)}.${String(x.name)}` === fn ? { ...x, body_md5: md5(String(x.body_md5), String(x.body_md5)) } : x)) };
      },
    };
  };

  it("FAILS on an altered body", async () => {
    const r = await inspectInstalled(deps(db, [], { open: bodyAs([], "public.read_reporting_predecessor_page", () => "0".repeat(32)) }));
    expect(r.identityProblems.join(";")).toMatch(/read_reporting_predecessor_page body is not the reviewed local one/);
    expect(inspectionStatus(r)).toMatch(/^STATUS: FAILED/);
  }, 120_000);

  it("accepts only the exact LF or CRLF variant and records which matched", async () => {
    const r = await inspectInstalled(deps(db, []));
    const m = new Set(r.functions.map((f) => f.bodyMatch));
    expect([...m].every((x) => x === "lf" || x === "crlf")).toBe(true);
    // a trimmed/normalised body (neither variant) is refused
    const trimmed = await inspectInstalled(deps(db, [], { open: bodyAs([], "reporting_private.utc_text", () => "f".repeat(32)) }));
    expect(trimmed.identityProblems.join(";")).toMatch(/utc_text body is not the reviewed local one/);
  }, 120_000);

  it("FAILS on a collation invariant failure", async () => {
    const log: string[] = [];
    const d = deps(db, log, {
      open: async () => {
        const c = conn(db, log);
        return { ...c, query: async (sql: string, params?: unknown[]) => (sql.includes("equality_agrees") ? { rows: [{ columns: ["x"], key_collation: '"C"', default_deterministic: true, equality_agrees: false }], rowCount: 1 } : c.query(sql, params)) };
      },
    });
    const r = await inspectInstalled(d);
    expect(r.collationProblems.length).toBeGreaterThan(0);
    expect(inspectionStatus(r)).toMatch(/^STATUS: FAILED/);
  }, 120_000);

  it("FAILS on fresh-snapshot drift and changes nothing to resolve it", async () => {
    const t = await stagingLike();
    let opens = 0;
    const log: string[] = [];
    const d = deps(t, log, {
      open: async () => {
        opens++;
        if (opens === 2) await t.exec("UPDATE reporting_private.site_state SET heartbeat_at = '2026-01-01T00:00:00Z' WHERE site = 'uk'"); // another actor, between the snapshots
        return conn(t, log);
      },
    });
    try {
      const r = await inspectInstalled(d);
      expect(r.drift.join(";")).toMatch(/state/);
      expect(inspectionStatus(r)).toMatch(/^STATUS: FAILED/);
      expect(r.sites.some((x) => x.eligible)).toBe(true); // a site was eligible on the first snapshot ...
      expect(r.runtimeReady).toBe(false); // ... but drift makes the inspection, and so readiness, fail
      expect(writes(log)).toEqual([]);
    } finally {
      await t.close();
    }
  }, 120_000);

  it("a query failure rolls back and closes, records one failure, and never retries", async () => {
    const log: string[] = [];
    const conns: Array<ReturnType<typeof conn>> = [];
    const d = deps(db, log, {
      open: async () => {
        const c = conn(db, log, (s) => s.includes("schema_migrations"));
        conns.push(c);
        return c;
      },
    });
    const r = await inspectInstalled(d);
    expect(r.errors.join(";")).toMatch(/simulated query failure/);
    expect(conns).toHaveLength(1); // no retry, no second connection
    expect(conns[0].ended()).toBe(true);
    expect(log.at(-1)).toBe(ROLLBACK);
    expect(writes(log)).toEqual([]);
    expect(inspectionStatus(r)).toMatch(/^STATUS: FAILED/);
  }, 120_000);

  it("refuses before connecting when a local file is not the reviewed one", async () => {
    let opened = false;
    const r = await inspectInstalled(deps(db, [], { read: (p) => (p === REVIEWED_LF["0043"].path ? read(p) + "\n" : read(p)), open: async () => ((opened = true), conn(db, [])) }));
    expect(opened).toBe(false);
    expect(inspectionStatus(r)).toMatch(/0043 file is not the reviewed one/);
  });
});
