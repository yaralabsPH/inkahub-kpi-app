/**
 * Task 13 Part A: activation fence, capture transition, per-site receipts,
 * single-statement freeze and job status (migration 0038 draft) plus the
 * trusted-server wrappers in api/_lib/reporting-jobs.ts.
 *
 * Unit tests prove the migration TEXT and the receipt rules; real locking,
 * interleavings and privileges are proven on staging by
 * `npm run staging:reporting-jobs` after 0038 is applied.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../staging/sqlStatements";
import {
  acknowledgeable,
  beginReportingBatch,
  getReportingJobStatus,
  pendingForSite,
  ReportingJobError,
  setReportingCapture,
  supportedSites,
  type BatchRow,
  type JournalRow,
  type RpcClient,
} from "../../api/_lib/reporting-jobs";

const SQL = readFileSync("supabase/migrations/0038_reporting_jobs.sql", "utf8");
const code = (s: string) => s.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const codes = splitSqlStatements(SQL).map((s) => code(s.text));
const fn = (name: string) => codes.find((c) => new RegExp(`^CREATE (OR REPLACE )?FUNCTION ${name.replace(".", "\\.")}\\(`).test(c)) ?? "";

describe("0038 migration text (Part A)", () => {
  it("is the next number, one transaction, and 0037 stays exactly as installed on staging", () => {
    const names = readdirSync("supabase/migrations").filter((n) => /^\d{4}_/.test(n)).sort();
    // 0038 followed 0037; T13B2b-19 allocates 0039 next (plan: Task 14 = 0040, Task 16 = 0041).
    expect(names.slice(-3)).toEqual(["0037_reporting_storage.sql", "0038_reporting_jobs.sql", "0039_reporting_rebuild_insert.sql"]);
    expect(codes[0]).toBe("BEGIN");
    expect(codes.at(-1)).toBe("COMMIT");
    // The installed 0037 bytes (Task 12 staging evidence: SHA-256 531BB2C5…) are unchanged.
    const sha = createHash("sha256").update(readFileSync("supabase/migrations/0037_reporting_storage.sql")).digest("hex").toUpperCase();
    expect(sha).toBe("531BB2C5706B9AC4D73A7CA3DC74DEAD7E34A53160E57FE2971AAF061C6A6A4F");
  });

  it("does not touch source tables, source policies, client roles or timeouts", () => {
    for (const c of codes) {
      expect(c).not.toMatch(/^(DROP|TRUNCATE|DELETE|ALTER ROLE|ALTER DEFAULT)/i);
      if (/^ALTER TABLE/i.test(c)) {
        // Only RLS enabling and additive nullable columns/constraints on private tables
        // (an "IS NOT NULL" predicate inside a CHECK is not a NOT NULL column constraint).
        expect(c).toMatch(/^ALTER TABLE reporting_private\.\w+ (ENABLE ROW LEVEL SECURITY|ADD COLUMN .*)$/);
        expect(c).not.toMatch(/(?<!IS )NOT NULL|DROP|RENAME|ALTER COLUMN|TYPE /i);
      }
      expect(c).not.toMatch(/ON public\.(?!production_events\b)\w+ /);
      expect(c).not.toMatch(/statement_timeout|idle_in_transaction/i);
    }
    for (const g of codes.filter((c) => /^GRANT /.test(c))) expect(g).not.toMatch(/\b(anon|authenticated|PUBLIC)\b/);
    // Only these read the source table, and none of them writes it.
    const readers = codes.filter((c) => /production_events/.test(c) && !/^CREATE OR REPLACE FUNCTION reporting_private\.capture_production_event_change/.test(c));
    expect(readers.map((c) => /^CREATE FUNCTION (public\.\w+)/.exec(c)?.[1])).toEqual(["public.begin_reporting_batch", "public.copy_reporting_source_page", "public.freeze_reporting_rebuild"]);
    for (const c of readers) expect(c).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM) public\.production_events/);
  });

  it("activation fence: the capture function reads control FOR SHARE (not FOR KEY SHARE) before checking enabled", () => {
    const f = fn("reporting_private.capture_production_event_change");
    expect(f).toMatch(/^CREATE OR REPLACE FUNCTION/);
    expect(f).toMatch(/LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/);
    expect(f).toMatch(/FROM reporting_private\.control c WHERE c\.singleton FOR SHARE;/);
    expect(f).not.toMatch(/FOR KEY SHARE|FOR UPDATE|FOR NO KEY UPDATE|site_state|\bLOCK\b|EXCEPTION WHEN/i);
    expect(f.indexOf("FOR SHARE")).toBeLessThan(f.indexOf("IF NOT v_enabled"));
    expect(f.match(/INSERT INTO reporting_private\.(\w+)/g)?.every((m) => m.endsWith(".changes"))).toBe(true);
  });

  it("the capture role gets only UPDATE(updated_at) plus a lock-only policy; replacement needs owner privileges only briefly", () => {
    const grantsToCapture = codes.filter((c) => /TO reporting_capture\b/.test(c) && /^GRANT/.test(c));
    expect(grantsToCapture).toEqual(["GRANT UPDATE (updated_at) ON reporting_private.control TO reporting_capture"]);
    expect(codes).toContain("CREATE POLICY control_capture_lock ON reporting_private.control FOR UPDATE TO reporting_capture USING (singleton) WITH CHECK (false)");
    const i = (re: RegExp) => codes.findIndex((c) => re.test(c));
    const g = i(/^GRANT reporting_capture TO CURRENT_USER WITH INHERIT TRUE, SET FALSE$/);
    const r = i(/^CREATE OR REPLACE FUNCTION reporting_private\.capture_production_event_change/);
    const v = i(/^REVOKE reporting_capture FROM CURRENT_USER$/);
    expect(g).toBeGreaterThan(0);
    expect(r).toBe(g + 1);
    expect(v).toBe(r + 1);
    expect(codes.filter((c) => /^GRANT reporting_capture TO/.test(c))).toHaveLength(1);
  });

  it("set_reporting_capture: service-only, invoker, empty search path, lock timeout at most 3 s keeping a stricter one, no source writes", () => {
    const f = fn("public.set_reporting_capture");
    expect(f).toMatch(/SECURITY INVOKER SET search_path = ''/);
    expect(f).toMatch(/IF v_lock_ms = 0 OR v_lock_ms > 3000 THEN PERFORM pg_catalog\.set_config\('lock_timeout', '3s', true\);/);
    expect(f).not.toMatch(/production_events|EXCEPTION WHEN|statement_timeout/);
    expect(f).toMatch(/UPDATE reporting_private\.control c SET capture_enabled = p_enabled WHERE c\.singleton AND c\.capture_enabled IS DISTINCT FROM p_enabled;/);
    expect(codes).toContain("REVOKE ALL ON FUNCTION public.set_reporting_capture(boolean) FROM PUBLIC, anon, authenticated");
    expect(codes).toContain("GRANT EXECUTE ON FUNCTION public.set_reporting_capture(boolean) TO service_role");
  });

  it("begin_reporting_batch: control shared lock BEFORE the site row lock; one active batch reused; continuity checks; ONE freeze statement", () => {
    const f = fn("public.begin_reporting_batch");
    const ctl = f.indexOf("FROM reporting_private.control c WHERE c.singleton FOR SHARE");
    const site = f.indexOf("FROM reporting_private.site_state s WHERE s.site = p_site FOR UPDATE");
    expect(ctl).toBeGreaterThan(0);
    expect(site).toBeGreaterThan(ctl);
    expect(f).toMatch(/WHERE b\.site = p_site AND b\.state IN \('active', 'frozen', 'publishing'\)/);
    expect(f).toMatch(/v_site\.source_epoch IS DISTINCT FROM v_ctl\.capture_epoch THEN RAISE EXCEPTION .*a rebuild is required/);
    expect(f).toMatch(/IF NOT v_ctl\.capture_enabled THEN RAISE EXCEPTION/);
    // One WITH statement inserts both membership and images (one snapshot); no LIMIT, no max-id cursor.
    const freeze = f.slice(f.indexOf("WITH members AS"));
    expect(freeze).toMatch(/INSERT INTO reporting_private\.batch_changes .* INSERT INTO reporting_private\.batch_events/);
    expect(freeze.slice(0, freeze.indexOf(" INTO v_changes, v_events;"))).not.toMatch(/;/);
    expect(f).not.toMatch(/\bLIMIT\b|max\(\s*c?\.?change_id|change_id\s*>|change_id\s*</i);
    // Tombstones: a left join keeps keys whose source row is gone (image NULL).
    expect(freeze).toMatch(/LEFT JOIN public\.production_events pe ON pe\.location = p_site AND pe\.id = k\.event_id/);
    // Only this site's side of a move is frozen here; the other site freezes its own.
    expect(freeze).toMatch(/WHERE c\.old_site = p_site/);
    expect(freeze).toMatch(/WHERE c\.new_site = p_site/);
    // Due future keys from the mirror.
    expect(freeze).toMatch(/sc\.event_created_at > coalesce\(v_site\.last_verified_cutoff, '-infinity'::timestamptz\) AND sc\.event_created_at <= v_cutoff/);
  });

  it("receipts: pending excludes only THIS site's published receipts; acknowledgement needs every supported side; batch_id is never a claim", () => {
    const pending = fn("reporting_private.site_pending_changes");
    expect(pending).toMatch(/AND b\.site = p_site AND b\.state = 'published'/);
    expect(pending).not.toMatch(/batch_id IS NULL|(?<![a-z_])c\.batch_id/);
    const ack = fn("reporting_private.acknowledge_received_changes");
    expect(ack).toMatch(/FROM \(VALUES \(c\.old_site\), \(c\.new_site\)\) AS s\(site\) WHERE s\.site IN \('au', 'uk', 'us'\) AND NOT EXISTS/);
    expect(ack).toMatch(/SET acknowledged_at = now\(\), batch_id = coalesce\(p_batch,/);
    expect(fn("public.begin_reporting_batch")).toMatch(/PERFORM reporting_private\.acknowledge_received_changes\(p_site, NULL::uuid\);/);
  });

  it("every new function is service-only", () => {
    for (const f of ["public.begin_reporting_batch(text)", "public.get_reporting_job_status(text)", "public.set_reporting_capture(boolean)"]) {
      expect(codes).toContain(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC, anon, authenticated`);
      expect(codes).toContain(`GRANT EXECUTE ON FUNCTION ${f} TO service_role`);
    }
    for (const f of ["reporting_private.site_pending_changes(text)", "reporting_private.acknowledge_received_changes(text, uuid)"]) {
      expect(codes).toContain(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC, anon, authenticated`);
    }
    for (const name of ["public.set_reporting_capture", "public.begin_reporting_batch", "public.get_reporting_job_status", "reporting_private.site_pending_changes", "reporting_private.acknowledge_received_changes"]) {
      expect(fn(name), name).toMatch(/SECURITY INVOKER SET search_path = ''/);
      expect(fn(name), name).not.toMatch(/\bEXECUTE\b|format\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// Receipt rules (pure reference used to state the staging expectations)
// ---------------------------------------------------------------------------

describe("per-site receipts and global acknowledgement", () => {
  const move: JournalRow = { changeId: 7, oldSite: "au", newSite: "uk", acknowledged: false };
  const auOnly: JournalRow = { changeId: 8, oldSite: "au", newSite: "au", acknowledged: false };
  const toStaging: JournalRow = { changeId: 9, oldSite: "uk", newSite: "staging", acknowledged: false };
  const journal = [move, auOnly, toStaging];
  const pub = (batchId: string, site: string, ids: number[]): BatchRow => ({ batchId, site, state: "published", changeIds: ids });

  it("supported sides of a change", () => {
    expect(supportedSites(move)).toEqual(["au", "uk"]);
    expect(supportedSites(toStaging)).toEqual(["uk"]);
  });

  it("AU publishes first: the move stays pending for UK and is not acknowledged; UK then acknowledges it", () => {
    const b1 = [pub("a1", "au", [7, 8])];
    expect(pendingForSite("au", journal, b1)).toEqual([]);
    expect(pendingForSite("uk", journal, b1)).toEqual([7, 9]);
    expect(acknowledgeable("au", journal, b1)).toEqual([8]);
    const b2 = [...b1, pub("u1", "uk", [7, 9])];
    expect(acknowledgeable("uk", journal, b2)).toEqual([7, 9]);
  });

  it("UK publishes first: symmetric", () => {
    const b1 = [pub("u1", "uk", [7, 9])];
    expect(pendingForSite("au", journal, b1)).toEqual([7, 8]);
    expect(acknowledgeable("uk", journal, b1)).toEqual([9]);
    expect(acknowledgeable("au", journal, [...b1, pub("a1", "au", [7, 8])])).toEqual([7, 8]);
  });

  it("one side fails and restarts: a failed/abandoned batch is no receipt; the restarted batch re-freezes the same change", () => {
    const failed: BatchRow = { batchId: "a1", site: "au", state: "failed", changeIds: [7, 8] };
    expect(pendingForSite("au", journal, [failed])).toEqual([7, 8]);
    const restarted = [failed, pub("u1", "uk", [7, 9]), pub("a2", "au", [7, 8])];
    expect(acknowledgeable("au", journal, restarted)).toEqual([7, 8]);
  });

  it("an active (unpublished) batch of the OTHER site never hides a change from this site", () => {
    const activeUk: BatchRow = { batchId: "u1", site: "uk", state: "frozen", changeIds: [7, 9] };
    expect(pendingForSite("au", journal, [activeUk])).toEqual([7, 8]);
  });

  it("delayed global acknowledgement: two publications that did not see each other leave it for a later idempotent pass", () => {
    // Each publication evaluates acknowledgement without the other's (uncommitted) receipt.
    expect(acknowledgeable("au", journal, [pub("a1", "au", [7, 8])])).toEqual([8]);
    expect(acknowledgeable("uk", journal, [pub("u1", "uk", [7, 9])])).toEqual([9]);
    // A later pass (begin of either site) sees both receipts.
    const both = [pub("a1", "au", [7, 8]), pub("u1", "uk", [7, 9])];
    const after = journal.map((c) => ({ ...c, acknowledged: c.changeId !== 7 }));
    expect(acknowledgeable("au", after, both)).toEqual([7]);
    expect(acknowledgeable("au", journal.map((c) => ({ ...c, acknowledged: true })), both)).toEqual([]);
  });

  it("no maximum-id cursor: a smaller id committed later is still pending", () => {
    const late: JournalRow = { changeId: 3, oldSite: null, newSite: "au", acknowledged: false };
    expect(pendingForSite("au", [...journal, late], [pub("a1", "au", [7, 8])])).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// Wrappers: typed, validated, never guess
// ---------------------------------------------------------------------------

function fakeRpc(data: unknown, error: { message: string; code?: string } | null = null) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client: RpcClient = {
    rpc: async (f, args) => {
      calls.push([f, args]);
      return { data, error };
    },
  };
  return { client, calls };
}

describe("reporting-jobs wrappers", () => {
  it("setReportingCapture sends exactly p_enabled and returns the new epoch", async () => {
    const { client, calls } = fakeRpc([{ capture_epoch: "4", capture_enabled: true }]);
    expect(await setReportingCapture(client, true)).toEqual({ captureEpoch: 4, captureEnabled: true });
    expect(calls).toEqual([["set_reporting_capture", { p_enabled: true }]]);
    await expect(setReportingCapture(client, "yes" as never)).rejects.toThrow(ReportingJobError);
  });

  it("errors carry the database code (e.g. a 3 s lock timeout) and are never swallowed", async () => {
    const { client } = fakeRpc(null, { message: "canceling statement due to lock timeout", code: "55P03" });
    const err = await setReportingCapture(client, false).catch((e) => e);
    expect(err).toBeInstanceOf(ReportingJobError);
    expect(err.code).toBe("55P03");
  });

  it("beginReportingBatch validates the site before calling and the row shape after", async () => {
    const row = { batch_id: "b1", lease_fence: 5, base_generation_id: "g1", capture_epoch: 4, rule_version: "item-counting-summary-v1", source_cutoff: "2026-11-14T16:00:00Z", state: "frozen", change_count: 3, event_count: 2, reused: false };
    const { client, calls } = fakeRpc([row]);
    expect(await beginReportingBatch(client, "au")).toMatchObject({ batchId: "b1", leaseFence: 5, changeCount: 3, reused: false });
    expect(calls[0]).toEqual(["begin_reporting_batch", { p_site: "au" }]);
    await expect(beginReportingBatch(client, "staging" as never)).rejects.toThrow(/unsupported site/);
    expect(calls).toHaveLength(1);
    await expect(beginReportingBatch(fakeRpc([{ ...row, lease_fence: 1.5 }]).client, "au")).rejects.toThrow(/lease_fence/);
    await expect(beginReportingBatch(fakeRpc([]).client, "au")).rejects.toThrow(/unexpected shape/);
  });

  it("getReportingJobStatus refuses another site's row and unknown modes", async () => {
    const row = {
      site: "uk", processor_enabled: false, read_mode: "legacy", capture_enabled: false, capture_epoch: 3, source_epoch: null, active_generation_id: null,
      active_batch_id: null, active_batch_state: null, lease_fence: 0, lease_expires_at: null, heartbeat_at: null, last_verified_cutoff: null, pending_changes: 0, oldest_pending_captured_at: null,
    };
    expect(await getReportingJobStatus(fakeRpc([row]).client, "uk")).toMatchObject({ site: "uk", captureEpoch: 3, readMode: "legacy", pendingChanges: 0 });
    await expect(getReportingJobStatus(fakeRpc([row]).client, "au")).rejects.toThrow(/another site/);
    await expect(getReportingJobStatus(fakeRpc([{ ...row, read_mode: "fast" }]).client, "uk")).rejects.toThrow(/unknown read mode/);
  });

  it("the module holds no credentials or env access", () => {
    const src = readFileSync("api/_lib/reporting-jobs.ts", "utf8");
    expect(src).not.toMatch(/process\.env|SERVICE_ROLE|createClient|VITE_/);
  });
});

// ---------------------------------------------------------------------------
// Runner catalog expectations for 0038 (0037's evidence expectations unchanged)
// ---------------------------------------------------------------------------

import {
  CAPTURE_ROLE,
  CAPTURE_TRIGGER,
  catalogLevel,
  checkCatalog,
  expectedTablePrivs,
  INSTALLED_0036_POLICY_HASH,
  PUBLIC_RPCS_0038,
  REPORTING_FUNCTIONS,
  REPORTING_FUNCTIONS_0038,
  REPORTING_TABLES,
  REPORTING_TABLES_0038,
  REPORTING_TRIGGER_FUNCTIONS_0038,
  type ReportingCatalog,
} from "../staging/reportingCapture";

function catalog0038(): ReportingCatalog {
  const roles = ["anon", "authenticated", "service_role", CAPTURE_ROLE];
  const fns = [...REPORTING_FUNCTIONS, ...REPORTING_FUNCTIONS_0038, ...REPORTING_TRIGGER_FUNCTIONS_0038].sort();
  const tables = [...REPORTING_TABLES, ...REPORTING_TABLES_0038].sort();
  return {
    schema: "reporting_private",
    tables: tables.map((t) => ({ t, rls: true, owner: "postgres" })),
    functions: fns.map((f) => ({ f, owner: f === "capture_production_event_change" ? CAPTURE_ROLE : "postgres", secdef: f === "capture_production_event_change", config: ['search_path=""'], dynamic: false })),
    policies: [
      { t: "changes", p: "changes_capture_insert", cmd: "INSERT", roles: [CAPTURE_ROLE], permissive: "PERMISSIVE" },
      { t: "control", p: "control_capture_lock", cmd: "UPDATE", roles: [CAPTURE_ROLE], permissive: "PERMISSIVE" },
      { t: "control", p: "control_capture_select", cmd: "SELECT", roles: [CAPTURE_ROLE], permissive: "PERMISSIVE" },
    ],
    role: { login: false, inherit: false, super: false, bypass: false, createrole: false, createdb: false, replication: false },
    memberOf: [],
    members: [{ member: "postgres", inherit: false }],
    triggers: [{ n: CAPTURE_TRIGGER, def: "CREATE TRIGGER production_events_reporting_capture AFTER INSERT OR DELETE OR UPDATE ON public.production_events FOR EACH ROW EXECUTE FUNCTION reporting_private.capture_production_event_change()" }],
    schemaPrivs: roles.map((role) => ({ role, usage: role === "service_role" || role === CAPTURE_ROLE, create: false })),
    tablePrivs: roles.flatMap((role) => tables.map((t) => ({ role, t, privs: expectedTablePrivs(role, t) }))),
    functionExec: ["anon", "authenticated", "service_role"].flatMap((role) => fns.map((f) => ({ role, f, x: role === "service_role" && (REPORTING_FUNCTIONS_0038 as readonly string[]).includes(f) }))),
    publicAcl: [{ o: "schema", public: false }],
    exposed: "pgrst.db_schemas=public,graphql_public",
    controlColumnUpdate: ["updated_at"],
    publicRpcs: [...PUBLIC_RPCS_0038].map((f) => ({ f, owner: "postgres", secdef: false, config: ['search_path=""'], anon: false, auth: false, service: true, public: false })),
    control: { capture_epoch: 3, capture_enabled: false, rule_version: "item-counting-summary-v1" },
    siteState: ["au", "uk", "us"].map((site) => ({ site, processor: false, mode: "legacy" })),
    sourcePolicyHash: INSTALLED_0036_POLICY_HASH,
  };
}

describe("staging catalog check at 0038", () => {
  it("accepts exactly the 0038 access model", () => {
    const c = catalog0038();
    expect(catalogLevel(c)).toBe("0038");
    expect(checkCatalog(c)).toEqual([]);
  });

  const mutations: Array<[string, (c: ReportingCatalog) => void, RegExp]> = [
    ["partial install: lock policy only", (c) => { c.publicRpcs = []; c.controlColumnUpdate = []; }, /public reporting RPCs|control columns/],
    ["capture role may update capture_enabled", (c) => void c.controlColumnUpdate!.push("capture_enabled"), /control columns \[capture_enabled,updated_at\]/],
    ["capture role has table-level UPDATE", (c) => void (c.tablePrivs.find((t) => t.role === CAPTURE_ROLE && t.t === "control")!.privs = "SELECT,UPDATE"), /reporting_capture on control/],
    ["lock policy missing", (c) => void (c.policies = c.policies!.filter((p) => p.p !== "control_capture_lock")), /policies are/],
    ["RPC callable by authenticated", (c) => void (c.publicRpcs![0].auth = true), /executable by a client role/],
    ["RPC SECURITY DEFINER", (c) => void (c.publicRpcs![1].secdef = true), /must be SECURITY INVOKER/],
    ["RPC not callable by the server", (c) => void (c.publicRpcs![2].service = false), /not executable by service_role/],
    ["helper callable by anon", (c) => void (c.functionExec.find((f) => f.role === "anon" && f.f === "site_pending_changes")!.x = true), /anon can execute site_pending_changes/],
    ["helper not callable by the server", (c) => void (c.functionExec.find((f) => f.role === "service_role" && f.f === "acknowledge_received_changes")!.x = false), /service_role cannot execute acknowledge_received_changes/],
  ];
  for (const [name, mutate, want] of mutations) {
    it(`rejects: ${name}`, () => {
      const c = catalog0038();
      mutate(c);
      expect(checkCatalog(c).join("\n")).toMatch(want);
    });
  }
});

// ---------------------------------------------------------------------------
// Fence staging checks (pure) and runner structure
// ---------------------------------------------------------------------------

import { capLimit, checkFence, FENCE_SCENARIOS, fenceMarkdown, fenceStatus, launch, near, newFenceReport, type FenceObservation } from "../staging/reportingFence";

const FENCE_RUNNER = readFileSync("tests/staging/reporting-jobs.ts", "utf8");
const FENCE_RUN = readFileSync("tests/staging/reportingFenceRun.ts", "utf8");

function goodFence(): FenceObservation[] {
  return [
    { id: "F1", existingLockMs: 0, writerLimitMs: 3000, secondWriterMs: 40, secondWriterError: null },
    { id: "F2", toggleWaited: true, queuedWriterWaited: true, epochBefore: 4, epochAfter: 5, journalRows: 1, journalEpoch: 5 },
    { id: "F3", oldSnapshotError: "error 40001" },
    { id: "F4", epochBefore: 6, epochAfterDisable: 7, epochAfterEnable: 8, journalRows: 1, journalEpoch: 8 },
    { id: "F5", existingLockMs: 0, defaultLimitMs: 3000, timeoutError: "error 55P03", timeoutMs: 3010, stricterLimitMs: 1000, stricterError: "error 55P03", stricterMs: 1005, controlUnchanged: true },
    { id: "F6", lockRows: 1, updateUpdatedAtError: "error 42501", updateEnabledError: "error 42501" },
  ];
}

describe("activation fence checks", () => {
  it("cover every scenario the plan lists", () => {
    const what = FENCE_SCENARIOS.map((s) => s.what).join("\n");
    for (const re of [/two compatible source writers/, /waits for an uncommitted disabled-period write/, /READ COMMITTED writer queued/, /REPEATABLE READ writer whose snapshot predates/, /disable then re-enable/, /times out after at most 3 s/, /stricter existing limit/, /cannot update it/]) expect(what).toMatch(re);
    expect(checkFence(goodFence())).toEqual([]);
  });

  const breaks: Array<[string, (o: FenceObservation[]) => void, RegExp]> = [
    ["second writer waited/failed", (o) => void Object.assign(o[0], { secondWriterMs: null, secondWriterError: "error 55P03" }), /F1/],
    ["enable did not wait", (o) => void (o[1].toggleWaited = false), /F2: the enable did not wait/],
    ["queued writer missed the new row", (o) => void Object.assign(o[1], { journalRows: 0, journalEpoch: null }), /F2: queued writer journal rows 0/],
    ["old snapshot wrote untracked", (o) => void (o[2].oldSnapshotError = null), /F3: old-snapshot writer gave no error/],
    ["epoch not advanced per toggle", (o) => void (o[3].epochAfterEnable = 7), /F4: epochs/],
    ["timeout beyond 3 s", (o) => void (o[4].timeoutMs = 8000), /F5: toggle gave error 55P03 after 8000 ms/],
    ["stricter limit ignored", (o) => void (o[4].stricterMs = 3000), /F5: stricter toggle/],
    ["control changed by a timed-out toggle", (o) => void (o[4].controlUnchanged = false), /F5: control changed/],
    ["capture role could update", (o) => void (o[5].updateUpdatedAtError = null), /F6: UPDATE\(updated_at\)/],
    ["capture role could not lock", (o) => void (o[5].lockRows = 0), /F6: capture role FOR SHARE/],
    ["scenario missing", (o) => void o.pop(), /F6 did not run/],
    ["scenario error", (o) => void (o[0] = { id: "F1", error: "connect ECONNREFUSED" }), /F1 failed: connect ECONNREFUSED/],
  ];
  for (const [name, mutate, want] of breaks) {
    it(`rejects: ${name}`, () => {
      const o = goodFence().map((x) => ({ ...x }));
      mutate(o);
      expect(checkFence(o).join("\n")).toMatch(want);
    });
  }

  it("status needs a verified restoration and one STATUS line ends the report", () => {
    const r = newFenceReport("rev", "t0");
    r.observations = goodFence();
    r.finishedAt = "t1";
    expect(fenceStatus(r)).toBe("STATUS: FAILED – restoration not verified");
    r.restorationVerified = true;
    r.restoration = "verified by a fresh audit after cleanup";
    expect(fenceStatus(r)).toBe("STATUS: COMPLETE");
    const md = fenceMarkdown(r);
    expect(md.trimEnd().split("\n").at(-1)).toBe("STATUS: COMPLETE");
    expect(md.match(/^STATUS: /gm)).toHaveLength(1);
  });

  it("the runner is guarded, overrides no statement timeout, rolls back source writes and returns capture to its starting state", () => {
    expect(FENCE_RUNNER.match(/new pg\.Client\(/g)).toHaveLength(1);
    expect(FENCE_RUNNER).toMatch(/return openGuardedClient\(\(\) => new pg\.Client\(/);
    expect(FENCE_RUNNER).not.toMatch(/statement_timeout\s*:|set (local |session )?(statement_timeout|idle_in_transaction)/i);
    expect(FENCE_RUNNER).toMatch(/select capture_epoch from public\.set_reporting_capture\(\$1\)/);
    expect(FENCE_RUNNER).toMatch(/await become\(c, "service_role", ctx\.claims\)/);
    // T13B2b-16: restoration is the coordinator's unconditional step, through the receipt-carrying toggle.
    expect(FENCE_RUNNER).toMatch(/restore: async \(enabled\) => void \(await toggle\(ctx, enabled, true\)\),/);
    expect(FENCE_RUNNER).toMatch(/return ownedToggle\(\{ \.\.\.ctx\.receipts, as: \(c\) => become\(c as pg\.Client, "service_role", ctx\.claims\) \}, enabled, restoring\);/);
    // Only control toggles are committed, each through commitReceipt (toggle() via ownedToggle, and F2's held toggle); no source write is ever committed.
    expect(FENCE_RUNNER.match(/\.query\("commit"\)/g)).toBeNull();
    expect(FENCE_RUNNER.match(/commitReceipt\(/g)).toBeNull(); // toggle() commits inside ownedToggle; F2 inside fenceF2
    expect(FENCE_RUN.match(/await commitReceipt\(/g)).toHaveLength(2); // ownedToggle and fenceF2
    expect(FENCE_RUNNER).toMatch(/return fenceF2\(\{/);
    expect(FENCE_RUN).toMatch(/const r = await c\.query\("select capture_epoch from public\.set_reporting_capture\(\$1\)", \[enabled\]\);\r?\n\s+t = tentativeReceipt\(io, enabled, before, r\.rows\[0\]\?\.capture_epoch\);/);
    expect(FENCE_RUN).toMatch(/const receiptBefore = await lockForReceipt\(c, "share"\);\r?\n(\s*\/\/.*\r?\n)*\s+enable = launch\(c\.query\("select capture_epoch from public\.set_reporting_capture\(true\)"\)\);/); // F2: SHARE (its own UPDATE still waits), before the toggle
    expect(FENCE_RUN).toMatch(/receipt = tentativeReceipt\(d\.receipts, true, receiptBefore, epochAfter\);/);
    expect(FENCE_RUN).toMatch(/const queuedWriterWaited = await d\.waitingOnLock\(mon, dPid\);\r?\n\s+await commitReceipt\(c, receipt, cPid, d\.receipts\);/);
    expect(FENCE_RUNNER).toMatch(/cleanup failed: scenario connection/);
    expect(FENCE_RUNNER).toMatch(/await runFence\(report, \{/);
    expect(FENCE_RUN).toMatch(/await runCaptureLifecycle\(report, \{/);
  });
});

// ---------------------------------------------------------------------------
// Task 13 Part A focused review fixes (T13A-1..3)
// ---------------------------------------------------------------------------

import { captureStatus as captureStatus13, newCaptureReport, runCaptureLifecycle, type LifecycleClient } from "../staging/reportingCapture";

const flush = () => new Promise((r) => setTimeout(r, 30));

describe("T13A-1: launched queries are observed at once", () => {
  function watchUnhandled() {
    const seen: unknown[] = [];
    const on = (e: unknown) => void seen.push(e);
    process.on("unhandledRejection", on);
    return { seen, stop: () => void process.off("unhandledRejection", on) };
  }

  it("an early query failure raises no unhandledRejection and is rethrown, unchanged, where awaited", async () => {
    const w = watchUnhandled();
    try {
      const err = Object.assign(new Error("permission denied for function set_reporting_capture"), { code: "42501" });
      const q = launch(Promise.reject(err));
      await flush();
      expect(w.seen).toEqual([]);
      expect(q.settled()).toBe(true);
      await expect(q.result()).rejects.toBe(err);
      const ok = launch(Promise.resolve({ rows: [{ capture_epoch: 5 }] }));
      expect((await ok.result()).rows[0].capture_epoch).toBe(5);
    } finally {
      w.stop();
    }
  });

  it("a polling failure while a query is pending: the polling error surfaces, the pending rejection is observed, cleanup runs", async () => {
    const w = watchUnhandled();
    try {
      const queryErr = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      const pending = launch(new Promise((_, rej) => setTimeout(() => rej(queryErr), 20)));
      const cleaned: string[] = [];
      const pollFails = async (): Promise<boolean> => {
        throw new Error("monitor connection lost"); // e.g. waitingOnLock() failing
      };
      const scenario = async () => {
        try {
          await pollFails();
          await pending.result();
        } finally {
          cleaned.push("rollback", "end");
        }
      };
      await expect(scenario()).rejects.toThrow("monitor connection lost");
      expect(cleaned).toEqual(["rollback", "end"]);
      await flush();
      expect(w.seen).toEqual([]);
      expect(pending.settled()).toBe(true);
      await expect(pending.result()).rejects.toBe(queryErr);
    } finally {
      w.stop();
    }
  });

  it("the runner launches F2's toggle and queued write through launch() and inspects them where awaited", () => {
    expect(FENCE_RUN).toMatch(/enable = launch\(c\.query\("select capture_epoch from public\.set_reporting_capture\(true\)"\)\);/);
    expect(FENCE_RUN).toMatch(/write = launch\(w\.query\(d\.insertSql\("rj-f2-d"\), \[d\.staff\]\)\);/);
    expect(FENCE_RUN).toMatch(/await enable\.result\(\)/);
    expect(FENCE_RUN).toMatch(/await write\.result\(\)/);
    // No other query promise is held un-awaited in a variable.
    expect(FENCE_RUNNER).not.toMatch(/const \w+ = (?!await |launch\()[a-z]\.query\(/);
    expect(FENCE_RUN).not.toMatch(/(const \w+|\b(enable|write)) = (?!await |launch\()[a-z]\.query\(/);
  });
});

describe("T13A-2: an audit connection that cannot be closed fails the evidence", () => {
  it("records the cleanup failure and the run is FAILED even though the fresh audit passed", async () => {
    let opened = 0;
    const client = (endFails: boolean): LifecycleClient => ({
      query: async () => ({ rows: [] }),
      end: async () => {
        if (endFails) throw new Error("terminating connection due to administrator command");
      },
    });
    const report = newCaptureReport("check", "rev", "t0");
    report.overhead = { offPerRowMs: 0.5, onPerRowMs: 0.6, deltaPerRowMs: 0.1, ratio: 1.2, rounds: 3 };
    await runCaptureLifecycle(report, {
      open: async () => client(opened++ === 1),
      body: async () => {},
      audit: async () => [],
      save: () => {},
      now: () => "t1",
      redact: (x: string) => x,
    });
    expect(report.restorationVerified).toBe(true);
    expect(report.errors).toEqual(["cleanup failed: audit disconnect: terminating connection due to administrator command"]);
    expect(captureStatus13(report)).toMatch(/^STATUS: FAILED – cleanup failed: audit disconnect/);
  });
});

describe("T13A-3: scenario lock limits never loosen a stricter existing limit", () => {
  it("capLimit keeps a stricter existing limit and applies the scenario limit otherwise", () => {
    expect(capLimit(3000, 0)).toBe(3000);
    expect(capLimit(3000, 500)).toBe(500);
    expect(capLimit(1000, 500)).toBe(500);
    expect(capLimit(3000, 8000)).toBe(3000);
    expect(capLimit(1000, 2000)).toBe(1000);
    expect(capLimit(3000, undefined)).toBeNaN();
    expect(near(510, 500)).toBe(true);
    expect(near(3010, 500)).toBe(false);
    expect(near(300, 500)).toBe(false);
  });

  it("a 500 ms existing limit stays 500 ms and is assessed correctly", () => {
    const o = goodFence().map((x) => ({ ...x }));
    Object.assign(o[0], { existingLockMs: 500, writerLimitMs: 500, secondWriterMs: 40 });
    Object.assign(o[4], { existingLockMs: 500, defaultLimitMs: 500, timeoutMs: 512, stricterLimitMs: 500, stricterMs: 507 });
    expect(checkFence(o)).toEqual([]);
    const loosened = o.map((x) => ({ ...x }));
    Object.assign(loosened[0], { writerLimitMs: 3000 });
    expect(checkFence(loosened).join()).toMatch(/F1: writer limit 3000 ms does not respect the existing 500 ms/);
    const wrongAssessment = o.map((x) => ({ ...x }));
    Object.assign(wrongAssessment[4], { defaultLimitMs: 3000, timeoutMs: 3010 });
    expect(checkFence(wrongAssessment).join()).toMatch(/F5: function limit 3000 ms, expected 500 ms/);
    const early = o.map((x) => ({ ...x }));
    Object.assign(early[4], { timeoutMs: 100 });
    expect(checkFence(early).join()).toMatch(/F5: toggle gave error 55P03 after 100 ms \(expected 55P03 near 500 ms\)/);
  });

  it("the runner reads the existing limit, never hard-codes one, and records what it used", () => {
    expect(FENCE_RUNNER).not.toMatch(/set local lock_timeout/i);
    expect(FENCE_RUNNER).toMatch(/const limit = await setLocalLockLimit\(b, 3000\);/);
    expect(FENCE_RUNNER).toMatch(/if \(stricter\) await setLocalLockLimit\(c, 1000\);/);
    expect(FENCE_RUNNER).toMatch(/const defaultLimitMs = capLimit\(3000, existing\);/);
    expect(FENCE_RUNNER).toMatch(/if \(used !== existing\) await c\.query\("select set_config\('lock_timeout', \$1, true\)", \[`\$\{used\}ms`\]\);/);
  });
});
