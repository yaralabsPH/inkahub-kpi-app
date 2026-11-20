/**
 * Task 12: private reporting storage and the durable source journal.
 *
 * No database runs in unit tests, so this file proves two things:
 *  1. the migration TEXT has exactly the designed shape (one transaction,
 *     expand-only, RLS everywhere, only the two internal capture policies,
 *     no client grants, a SECURITY DEFINER capture function with a fixed
 *     search path, no dynamic SQL, no swallowed failure, no lock or state-row
 *     contention, capture/processor off by default);
 *  2. the staging runner's checks accept the designed catalog/results and
 *     reject every deviation (wrong grants, an extra policy, a client role
 *     membership, a failed capture step, a missing overhead measurement).
 * The real transactional behavior (commit/rollback together, failure aborts
 * the save, ACL denial, write paths/stock unchanged, overhead, concurrency)
 * is proven on staging by `npm run staging:reporting-capture`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../staging/sqlStatements";
import {
  CAPTURE_ROLE,
  CAPTURE_STEPS,
  CAPTURE_TRIGGER,
  captureMarkdown,
  captureStatus,
  checkCatalog,
  checkConcurrency,
  checkSteps,
  expectedTablePrivs,
  newCaptureReport,
  INSTALLED_0036_POLICY_HASH,
  overheadSummary,
  parseCaptureMode,
  REPORTING_FUNCTIONS,
  REPORTING_TABLES,
  type CaptureReport,
  type ReportingCatalog,
  type StepResult,
} from "../staging/reportingCapture";

const FILE = "supabase/migrations/0037_reporting_storage.sql";
const sql = readFileSync(FILE, "utf8");
const statements = splitSqlStatements(sql);
const code = (s: string) => s.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const codes = statements.map((s) => code(s.text));
const body = (fn: string) => {
  const st = codes.find((c) => c.startsWith(`CREATE FUNCTION reporting_private.${fn}()`));
  if (!st) throw new Error(`function ${fn} not found`);
  return st;
};

describe("0037 migration text", () => {
  it("is the next unused number and the only 0037", () => {
    const names = readdirSync("supabase/migrations").filter((n) => /^\d{4}_/.test(n)).sort();
    expect(names.filter((n) => n.startsWith("0037_"))).toEqual(["0037_reporting_storage.sql"]);
    const at = names.indexOf("0037_reporting_storage.sql");
    expect(names[at - 1]).toBe("0036_production_events_select_initplans.sql");
  });

  it("is ONE transaction with no IF NOT EXISTS / OR REPLACE shortcuts", () => {
    expect(codes[0]).toBe("BEGIN");
    expect(codes.at(-1)).toBe("COMMIT");
    expect(codes.filter((c) => c === "BEGIN" || c === "COMMIT")).toHaveLength(2);
    expect(code(sql)).not.toMatch(/IF NOT EXISTS|OR REPLACE|IF EXISTS/i);
  });

  it("is expand-only: the source table only gains the one trigger; nothing existing is altered, dropped or regranted", () => {
    const touchesPublic = codes.filter((c) => /\bpublic\.(?!production_events\b)|ON public\.|TO public\b/i.test(c));
    expect(touchesPublic).toEqual([expect.stringMatching(/^CREATE TRIGGER production_events_reporting_capture AFTER INSERT OR UPDATE OR DELETE ON public\.production_events FOR EACH ROW EXECUTE FUNCTION reporting_private\.capture_production_event_change\(\)$/)]);
    for (const c of codes) {
      expect(c).not.toMatch(/^(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
      expect(c).not.toMatch(/^ALTER (TABLE|POLICY|ROLE|DEFAULT PRIVILEGES|DATABASE)\b(?! reporting_private\.)/i);
      expect(c).not.toMatch(/statement_timeout|lock_timeout|(?<!NO)BYPASSRLS/i);
    }
    expect(codes.filter((c) => /^ALTER TABLE/i.test(c)).every((c) => /^ALTER TABLE reporting_private\.\w+ ENABLE ROW LEVEL SECURITY$/.test(c))).toBe(true);
  });

  it("creates exactly the designed tables, each with RLS enabled", () => {
    const tables = codes.map((c) => /^CREATE TABLE reporting_private\.(\w+)/.exec(c)?.[1]).filter(Boolean).sort();
    expect(tables).toEqual([...REPORTING_TABLES]);
    const rls = codes.map((c) => /^ALTER TABLE reporting_private\.(\w+) ENABLE ROW LEVEL SECURITY$/.exec(c)?.[1]).filter(Boolean).sort();
    expect(rls).toEqual([...REPORTING_TABLES]);
  });

  it("adds only the two internal capture policies, both addressed to reporting_capture", () => {
    const policies = codes.filter((c) => /^CREATE POLICY/.test(c));
    expect(policies).toEqual([
      "CREATE POLICY control_capture_select ON reporting_private.control FOR SELECT TO reporting_capture USING (singleton)",
      "CREATE POLICY changes_capture_insert ON reporting_private.changes FOR INSERT TO reporting_capture WITH CHECK (acknowledged_at IS NULL AND batch_id IS NULL)",
    ]);
  });

  it("grants nothing to PUBLIC, anon or authenticated, and only the narrow set to reporting_capture", () => {
    const grants = codes.filter((c) => /^GRANT /.test(c));
    for (const g of grants) expect(g).not.toMatch(/\b(anon|authenticated|PUBLIC)\b/);
    const toCapture = grants.filter((g) => /TO reporting_capture$/.test(g));
    expect(toCapture).toEqual([
      "GRANT USAGE ON SCHEMA reporting_private TO reporting_capture",
      "GRANT SELECT ON reporting_private.control TO reporting_capture",
      "GRANT INSERT ON reporting_private.changes TO reporting_capture",
      "GRANT USAGE ON SEQUENCE reporting_private.changes_change_id_seq TO reporting_capture",
      "GRANT CREATE ON SCHEMA reporting_private TO reporting_capture",
    ]);
    // CREATE is only for the ownership transfer: granted, used, revoked, in that order.
    const i = (re: RegExp) => codes.findIndex((c) => re.test(c));
    const grantCreate = i(/^GRANT CREATE ON SCHEMA reporting_private TO reporting_capture$/);
    const alterOwner = i(/^ALTER FUNCTION reporting_private\.capture_production_event_change\(\) OWNER TO reporting_capture$/);
    const revokeCreate = i(/^REVOKE CREATE ON SCHEMA reporting_private FROM reporting_capture$/);
    expect(grantCreate).toBeGreaterThan(0);
    expect(alterOwner).toBeGreaterThan(grantCreate);
    expect(revokeCreate).toBeGreaterThan(alterOwner);
    expect(i(/^REVOKE reporting_capture FROM CURRENT_USER$/)).toBeGreaterThan(alterOwner);
    // The role is never granted to anyone but the migration role (temporarily, without INHERIT).
    expect(codes.filter((c) => /^GRANT reporting_capture TO/.test(c))).toEqual(["GRANT reporting_capture TO CURRENT_USER WITH INHERIT FALSE, SET TRUE"]);
    expect(codes).toContain("REVOKE ALL ON SCHEMA reporting_private FROM PUBLIC");
    expect(codes).toContain("REVOKE ALL ON SCHEMA reporting_private FROM anon, authenticated");
    expect(codes).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA reporting_private FROM PUBLIC, anon, authenticated");
    expect(codes).toContain("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reporting_private FROM PUBLIC, anon, authenticated, service_role");
    expect(codes).toContain("REVOKE ALL ON FUNCTION reporting_private.capture_production_event_change() FROM PUBLIC, anon, authenticated, service_role");
    expect(codes).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA reporting_private TO service_role");
  });

  it("T12-1: function ACL and the source trigger come BEFORE the ownership hand-over; temporary privileges are revoked LAST", () => {
    const i = (re: RegExp) => codes.findIndex((c) => re.test(c));
    const revokeFn = i(/^REVOKE ALL ON FUNCTION reporting_private\.capture_production_event_change\(\) FROM PUBLIC, anon, authenticated, service_role$/);
    const trigger = i(/^CREATE TRIGGER production_events_reporting_capture /);
    const grantMember = i(/^GRANT reporting_capture TO CURRENT_USER WITH INHERIT FALSE, SET TRUE$/);
    const grantCreate = i(/^GRANT CREATE ON SCHEMA reporting_private TO reporting_capture$/);
    const alterOwner = i(/^ALTER FUNCTION reporting_private\.capture_production_event_change\(\) OWNER TO reporting_capture$/);
    for (const x of [revokeFn, trigger, grantMember, grantCreate, alterOwner]) expect(x).toBeGreaterThan(0);
    expect(revokeFn).toBeLessThan(alterOwner);
    expect(trigger).toBeLessThan(alterOwner);
    expect(grantMember).toBeGreaterThan(trigger);
    expect(grantCreate).toBeGreaterThan(trigger);
    // The last statements before COMMIT: owner change, then the two temporary-privilege revocations.
    expect(codes.slice(-4)).toEqual([
      "ALTER FUNCTION reporting_private.capture_production_event_change() OWNER TO reporting_capture",
      "REVOKE CREATE ON SCHEMA reporting_private FROM reporting_capture",
      "REVOKE reporting_capture FROM CURRENT_USER",
      "COMMIT",
    ]);
    // Nothing after the hand-over needs the migration role to own or execute the function.
    for (const c of codes.slice(alterOwner + 1)) expect(c).not.toMatch(/capture_production_event_change|CREATE TRIGGER/);
  });

  it("creates the capture role non-login, non-inheriting, without BYPASSRLS or other privileges", () => {
    expect(codes).toContain("CREATE ROLE reporting_capture NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  });

  it("the capture function: SECURITY DEFINER, empty search path, local insert only, failure not swallowed, no contention", () => {
    const fn = body("capture_production_event_change");
    expect(fn).toMatch(/LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/);
    expect(fn).not.toMatch(/\bEXECUTE\b|\bformat\s*\(|\bEXCEPTION\s+WHEN\b/i);
    expect(fn).not.toMatch(/\bFOR (UPDATE|SHARE|NO KEY UPDATE)\b|\bLOCK\b|pg_advisory|site_state|dblink|http|pg_notify/i);
    expect(fn.match(/INSERT INTO reporting_private\.(\w+)/g)?.every((m) => m.endsWith(".changes"))).toBe(true);
    expect(fn.match(/FROM reporting_private\.(\w+)/g)).toEqual(["FROM reporting_private.control"]);
    expect(fn).toMatch(/RAISE EXCEPTION 'reporting capture control row is missing; source write refused'/);
    expect(fn).toMatch(/IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL;/);
    for (const site of ["'au'", "'uk'", "'us'"]) expect(fn).toContain(site);
    expect(fn).not.toContain("'staging'");
    expect(fn).toMatch(/pg_catalog\.to_jsonb\(NEW\)/);
    expect(fn).toMatch(/pg_catalog\.to_jsonb\(OLD\)/);
  });

  it("guards are SECURITY INVOKER with a fixed search path", () => {
    for (const g of ["control_guard", "generations_guard"]) expect(body(g)).toMatch(/LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''/);
    expect(body("control_guard")).toMatch(/NEW\.capture_enabled IS DISTINCT FROM OLD\.capture_enabled AND NEW\.capture_epoch = OLD\.capture_epoch THEN NEW\.capture_epoch := OLD\.capture_epoch \+ 1/);
    expect(body("control_guard")).toMatch(/cannot decrease/);
    expect(body("generations_guard")).toMatch(/identity is immutable/);
    expect(REPORTING_FUNCTIONS).toHaveLength(3);
  });

  it("capture and processors start off; every site reads legacy", () => {
    const control = codes.find((c) => c.startsWith("CREATE TABLE reporting_private.control"))!;
    expect(control).toMatch(/capture_enabled boolean NOT NULL DEFAULT false/);
    const site = codes.find((c) => c.startsWith("CREATE TABLE reporting_private.site_state"))!;
    expect(site).toMatch(/processor_enabled boolean NOT NULL DEFAULT false/);
    expect(site).toMatch(/read_mode text NOT NULL DEFAULT 'legacy'/);
    expect(codes).toContain("INSERT INTO reporting_private.site_state (site) VALUES ('au'), ('uk'), ('us')");
    expect(codes).toContain("INSERT INTO reporting_private.control (singleton) VALUES (true)");
  });

  it("keys and constraints: one active batch and one published generation per site, audience shape, non-negative counts", () => {
    expect(codes).toContain("CREATE UNIQUE INDEX batches_one_active_per_site ON reporting_private.batches (site) WHERE state IN ('active', 'frozen', 'publishing')");
    expect(codes).toContain("CREATE UNIQUE INDEX generations_one_published_per_site ON reporting_private.generations (site) WHERE state = 'published'");
    for (const t of ["partition_work", "event_facts", "cancel_edges", "order_occurrences", "daily_totals", "timing_facts"]) {
      const def = codes.find((c) => c.startsWith(`CREATE TABLE reporting_private.${t} `))!;
      expect(def, t).toContain("CHECK ((audience_kind = 'site') = (audience_staff IS NULL))");
      expect(def, t).toMatch(/UNIQUE NULLS NOT DISTINCT \(/);
    }
    const daily = codes.find((c) => c.startsWith("CREATE TABLE reporting_private.daily_totals"))!;
    expect(daily).toMatch(/items bigint CHECK \(items IS NULL OR \(items >= 0 AND items <= 9007199254740991\)\)/);
    expect(daily).toMatch(/line_count integer NOT NULL CHECK \(line_count >= 0\)/);
    const changes = codes.find((c) => c.startsWith("CREATE TABLE reporting_private.changes"))!;
    expect(changes).toMatch(/CHECK \(old_site IN \('au', 'uk', 'us'\) OR new_site IN \('au', 'uk', 'us'\)\)/);
    expect(changes).toMatch(/capture_xact xid8 NOT NULL DEFAULT pg_current_xact_id\(\)/);
    // A change ID is a row identity, never a high-water mark: no sequence-position column or cursor on changes.
    expect(changes).not.toMatch(/high_water|cursor/i);
    // Results reference work by surrogate id (a composite FK over nullable audience_staff would skip site rows).
    expect(codes.find((c) => c.startsWith("CREATE TABLE reporting_private.partition_results"))).toMatch(/work_id bigint NOT NULL REFERENCES reporting_private\.partition_work \(work_id\)/);
  });
});

// ---------------------------------------------------------------------------
// Runner checks: designed state passes, every deviation fails
// ---------------------------------------------------------------------------

function goodCatalog(): ReportingCatalog {
  const roles = ["anon", "authenticated", "service_role", CAPTURE_ROLE];
  return {
    schema: "reporting_private",
    tables: REPORTING_TABLES.map((t) => ({ t, rls: true, owner: "postgres" })),
    functions: [
      { f: "capture_production_event_change", owner: CAPTURE_ROLE, secdef: true, config: ['search_path=""'], dynamic: false },
      { f: "control_guard", owner: "postgres", secdef: false, config: ['search_path=""'], dynamic: false },
      { f: "generations_guard", owner: "postgres", secdef: false, config: ['search_path=""'], dynamic: false },
    ],
    policies: [
      { t: "changes", p: "changes_capture_insert", cmd: "INSERT", roles: [CAPTURE_ROLE], permissive: "PERMISSIVE" },
      { t: "control", p: "control_capture_select", cmd: "SELECT", roles: [CAPTURE_ROLE], permissive: "PERMISSIVE" },
    ],
    role: { login: false, inherit: false, super: false, bypass: false, createrole: false, createdb: false, replication: false },
    memberOf: [],
    members: [{ member: "postgres", inherit: false }],
    triggers: [{ n: CAPTURE_TRIGGER, def: "CREATE TRIGGER production_events_reporting_capture AFTER INSERT OR DELETE OR UPDATE ON public.production_events FOR EACH ROW EXECUTE FUNCTION reporting_private.capture_production_event_change()" }],
    schemaPrivs: roles.map((role) => ({ role, usage: role === "service_role" || role === CAPTURE_ROLE, create: false })),
    tablePrivs: roles.flatMap((role) => REPORTING_TABLES.map((t) => ({ role, t, privs: expectedTablePrivs(role, t) }))),
    functionExec: ["anon", "authenticated", "service_role"].flatMap((role) => REPORTING_FUNCTIONS.map((f) => ({ role, f, x: false }))),
    publicAcl: [{ o: "schema", public: false }],
    exposed: "session_preload_libraries=supautils;pgrst.db_schemas=public,graphql_public",
    control: { capture_epoch: 1, capture_enabled: false, rule_version: "item-counting-summary-v1" },
    siteState: ["au", "uk", "us"].map((site) => ({ site, processor: false, mode: "legacy" })),
    sourcePolicyHash: INSTALLED_0036_POLICY_HASH,
  };
}

describe("staging catalog check", () => {
  it("accepts exactly the designed access model", () => {
    expect(checkCatalog(goodCatalog())).toEqual([]);
  });

  const mutations: Array<[string, (c: ReportingCatalog) => void, RegExp]> = [
    ["schema missing", (c) => void (c.schema = null), /not installed/],
    ["RLS off", (c) => void (c.tables![0].rls = false), /RLS is off/],
    ["capture role owns a table", (c) => void (c.tables![3].owner = CAPTURE_ROLE), /owns table/],
    ["client policy added", (c) => void c.policies!.push({ t: "changes", p: "staff_read", cmd: "SELECT", roles: ["authenticated"], permissive: "PERMISSIVE" }), /policies are/],
    ["policy for PUBLIC", (c) => void (c.policies![0].roles = ["public"]), /policies are/],
    ["capture role can log in", (c) => void (c.role!.login = true), /has login/],
    ["capture role bypasses RLS", (c) => void (c.role!.bypass = true), /has bypass/],
    ["capture role inherits a privileged role", (c) => void c.memberOf.push("postgres"), /is a member of postgres/],
    ["capture role granted to authenticated", (c) => void c.members.push({ member: "authenticated", inherit: true }), /client role authenticated/],
    ["capture function owned by postgres", (c) => void (c.functions![0].owner = "postgres"), /owned by postgres/],
    ["capture function not SECURITY DEFINER", (c) => void (c.functions![0].secdef = false), /not SECURITY DEFINER/],
    ["mutable search path", (c) => void (c.functions![0].config = null), /search_path/],
    ["dynamic SQL", (c) => void (c.functions![0].dynamic = true), /dynamic SQL/],
    ["second trigger on production_events", (c) => void c.triggers.push({ n: "other", def: "x" }), /triggers are/],
    ["authenticated can read the journal", (c) => void (c.tablePrivs.find((t) => t.role === "authenticated" && t.t === "changes")!.privs = "SELECT"), /authenticated on changes/],
    ["anon has schema usage", (c) => void (c.schemaPrivs.find((s) => s.role === "anon")!.usage = true), /anon schema USAGE/],
    ["capture role can update control", (c) => void (c.tablePrivs.find((t) => t.role === CAPTURE_ROLE && t.t === "control")!.privs = "SELECT,UPDATE"), /reporting_capture on control/],
    ["capture role keeps CREATE", (c) => void (c.schemaPrivs.find((s) => s.role === CAPTURE_ROLE)!.create = true), /CREATE on reporting_private/],
    ["service_role can run the capture function", (c) => void (c.functionExec[0].x = true), /can execute/],
    ["PUBLIC acl", (c) => void (c.publicAcl[0].public = true), /PUBLIC holds/],
    ["exposed through the Data API", (c) => void (c.exposed = "pgrst.db_schemas=public,reporting_private"), /exposed schemas/],
    ["source policies changed", (c) => void (c.sourcePolicyHash = "0".repeat(64)), /policy hash/],
    ["site state rows wrong", (c) => void c.siteState!.pop(), /site_state/],
  ];
  for (const [name, mutate, want] of mutations) {
    it(`rejects: ${name}`, () => {
      const c = goodCatalog();
      mutate(c);
      expect(checkCatalog(c).join("\n")).toMatch(want);
    });
  }
});

function goodSteps(): StepResult[] {
  return CAPTURE_STEPS.map((s) => ({ id: s.id, actor: s.actor, what: s.what, result: typeof s.expect === "string" ? s.expect : s.id === "c01" ? "advanced" : "?", ms: 1 }));
}

describe("staging capture step checks", () => {
  it("cover every required behavior", () => {
    const ids = CAPTURE_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const what = CAPTURE_STEPS.map((s) => s.what).join("\n");
    for (const needle of [/rolled back takes its journal row/, /privilege revoked\) -> the save fails/, /control row missing/, /old and new order\/person\/time/, /move.*au -> uk/, /deletes it/, /no-op/, /no invented deduplication/, /unsupported staging site/, /disables capture: epoch advances/, /no longer continuous/, /second active batch/, /immutable/, /calls the capture function/]) {
      expect(what).toMatch(needle);
    }
    // Every client role is denied every direct access.
    for (const a of ["anon", "staff", "kiosk", "cs", "manager", "owner"]) {
      expect(CAPTURE_STEPS.filter((s) => s.actor === a && s.id.startsWith("d") && s.expect === "error 42501").length, a).toBe(5);
    }
  });

  it("accept the designed results and reject any deviation", () => {
    expect(checkSteps(goodSteps())).toEqual([]);
    const lost = goodSteps().map((r) => (r.id === "c16" ? { ...r, result: "0:1" } : r));
    expect(checkSteps(lost).join()).toMatch(/c16/);
    const swallowed = goodSteps().map((r) => (r.id === "c17" ? { ...r, result: "1" } : r));
    expect(checkSteps(swallowed).join()).toMatch(/c17/);
    const leaked = goodSteps().map((r) => (r.id === "d21" ? { ...r, result: "3" } : r));
    expect(checkSteps(leaked).join()).toMatch(/d21/);
    expect(checkSteps(goodSteps().filter((r) => r.id !== "c09")).join()).toMatch(/c09.*did not run/);
  });
});

describe("runner modes, overhead, concurrency and status", () => {
  it("accepts exactly one known mode", () => {
    expect(parseCaptureMode(["--check"]).mode).toBe("check");
    expect(parseCaptureMode(["--rehearse-migration"]).mode).toBe("rehearse-migration");
    expect(parseCaptureMode([]).mode).toBeNull();
    expect(parseCaptureMode(["--check", "--concurrency"]).mode).toBeNull();
    expect(parseCaptureMode(["--check", "--apply"]).problems.join()).toMatch(/unknown flag --apply/);
  });

  it("summarizes overhead per row from alternating rounds", () => {
    const s = overheadSummary([
      { capture: false, rows: 200, ms: 100 },
      { capture: true, rows: 200, ms: 120 },
      { capture: false, rows: 200, ms: 110 },
      { capture: true, rows: 200, ms: 140 },
      { capture: false, rows: 200, ms: 90 },
      { capture: true, rows: 200, ms: 130 },
    ]);
    expect(s).toMatchObject({ offPerRowMs: 0.5, onPerRowMs: 0.65, rounds: 3 });
    expect(s.deltaPerRowMs).toBeCloseTo(0.15, 10);
  });

  it("concurrency evidence needs capture enabled and no waiting/error", () => {
    expect(checkConcurrency({ captureEnabledCommitted: true, firstHeldMs: 50, secondMs: 20, secondError: null, journalRowsSeenBySecond: 1 })).toEqual([]);
    expect(checkConcurrency({ captureEnabledCommitted: false, firstHeldMs: 50, secondMs: 20, secondError: null, journalRowsSeenBySecond: 0 }).join()).toMatch(/not enabled/);
    expect(checkConcurrency({ captureEnabledCommitted: true, firstHeldMs: 3100, secondMs: null, secondError: "error 55P03", journalRowsSeenBySecond: null }).join()).toMatch(/55P03/);
  });

  it("reports COMPLETE only when every part passed, and always ends with one STATUS line", () => {
    const base: CaptureReport = {
      ...newCaptureReport("check", "abc", "t0"),
      finishedAt: "t1", catalog: goodCatalog(), steps: goodSteps(), writeCompatJournalRows: 0, overhead: { offPerRowMs: 0.5, onPerRowMs: 0.6, deltaPerRowMs: 0.1, ratio: 1.2, rounds: 3 },
      restorationVerified: true, restoration: "verified by a fresh audit after cleanup",
    };
    expect(captureStatus(base)).toBe("STATUS: COMPLETE");
    expect(captureStatus({ ...base, finishedAt: "" })).toMatch(/^STATUS: FAILED – run not finished/);
    expect(captureStatus({ ...base, overhead: null })).toMatch(/overhead was not measured/);
    expect(captureStatus({ ...base, writeCompatProblems: ["post: step s06 gave x"] })).toMatch(/s06/);
    const md = captureMarkdown(base);
    expect(md.trimEnd().split("\n").at(-1)).toBe("STATUS: COMPLETE");
    expect(md.match(/^STATUS: /gm)).toHaveLength(1);
    expect(md).not.toMatch(/eyJ|password|STAGING_DB_URL/);
  });
});
