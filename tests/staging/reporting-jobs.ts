/**
 * Task 13 staging runner: activation-fence interleavings (Part A).
 * STAGING ONLY (ybrzhrgfrnvtcwymjdrq); requires migration 0038 applied.
 *
 *   npm run staging:reporting-jobs -- --fence
 *   npm run staging:reporting-jobs -- --rehearse-migration --sites=A,B [--max-pages=N]
 *   npm run staging:reporting-jobs -- --check-installed --sites=A,B [--max-pages=N]
 *   npm run staging:reporting-jobs -- --interleavings --sites=A,B [--max-pages=N]
 *   npm run staging:reporting-jobs -- --rehearse-rebuild-repair --sites=uk,us [--max-pages=N]   (T13B2b-19 0039 rollback rehearsal; reportingRebuildRepair.ts)
 *   npm run staging:reporting-jobs -- --rehearse-dependency-reads --sites=uk,us [--max-pages=N]  (T14S1 0040+0041 rollback rehearsal; reportingDependencyRehearsal.ts)
 *   npm run staging:reporting-jobs -- --diagnose-dependency-plans --sites=uk,us [--max-pages=N]  (T14S3 access-path diagnostic; reportingDependencyPlans.ts)
 *   npm run staging:reporting-jobs -- --diagnose-access-paths --sites=uk,us [--max-pages=N]  (Task 14 0042 follow-up; reportingDependencyPlans.ts)
 *   npm run staging:reporting-jobs -- --explain-source-versions --site=uk [--max-pages=N]   (plan-only I4 diagnostic; reportingPlanDiagnostic.ts)
 *   npm run staging:reporting-jobs -- --rehearse-worker-state --site=X   (Task 15 0043 rollback rehearsal; reportingWorkerHarness.ts)
 *   npm run staging:reporting-jobs -- --worker-runtime --site=X [--pace-calls=N] [--max-invocations=N] [--max-lease-wait-ms=N]   (Task 15 post-install runtime gate; reportingWorkerScenario.ts)
 *
 * The last three are Task 13 Part B2b's publication evidence
 * (tests/staging/reportingPublication.ts): the full 0038 draft applied inside
 * ONE always-rolled-back transaction, the same flow against an installed
 * 0038, and multi-connection lock/fault checks. None of them commits.
 *
 * Several real connections. Every source write is rolled back. Capture
 * toggles go through public.set_reporting_capture as service_role and are
 * COMMITTED (each advances the epoch), each with a receipt saved BEFORE its
 * COMMIT. The coordinator (reportingFenceRun.ts) stops at the first failed
 * scenario and ALWAYS returns capture to its starting on/off state on a fresh
 * connection. Every client is guarded (frozen staging target at every query)
 * and marker-checked; a fresh guarded full-state audit (only this run's
 * confirmed epoch increments allowed) verifies restoration after success and
 * failure. No timeout is overridden except a scenario's own
 * transaction-local lock_timeout where the scenario is about lock waits.
 * Report: staging-results-reporting-fence-<start>-<id>.md (git-ignored).
 * Batch receipt/publication interleavings are added with Part B.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { signInClaims, SESSION_ROLES, type SessionRole } from "./stagingSessions";
import { assertStagingSupabaseUrl } from "./measure-item-counting";
import { redactSecrets } from "./itemCountingPolicyParity";
import { become } from "./writeCompatRun";
import { CATALOG_SQL, newConnectionWatch, openGuardedClient, REPORTING_SCHEMA, runCaptureLifecycle, stagingTarget, type ConnectionWatch, type ReportingCatalog, type StagingTarget } from "./reportingCapture";
import { capLimit, fenceMarkdown, fenceStatus, newFenceReport, type FenceObservation } from "./reportingFence";
import { fenceF2, ownedToggle, runFence, type ReceiptIO } from "./reportingFenceRun";
import { catalog } from "./policyParityRun";
import { catalogLevel, checkCatalog, finalReport, initialReport } from "./reportingCapture";
import { committedAllowance, newOwnership, runCommitted, type Ownership } from "./reportingCommitted";
import { runPlanDiagnostic } from "./reportingPlanDiagnostic";
import { rehearseRebuildRepair } from "./reportingRebuildRepair";
import { rehearseDependencyReads } from "./reportingDependencyRehearsal";
import { diagnoseAccessPaths, diagnoseDependencyPlans } from "./reportingDependencyPlans";
import { HISTORY_SQL, MIGRATION_0043, newWorkerReport, parseWorkerArgs, rehearseWorkerState, sha256Lf, WORKER_FLAGS, workerMarkdown, workerStatus } from "./reportingWorkerHarness";
import { newRuntimeOwnership } from "./reportingWorkerRuntime";
import { auditRuntime, cleanupRuntime, newRuntimeEvidence, runWorkerRuntime, type RuntimeCtx } from "./reportingWorkerScenario";
import { serviceRpcClient } from "./serviceRpc";
import {
  compareFullState,
  durableEvidence,
  fullState,
  ROLLBACK_ONLY,
  MIGRATION_0038,
  migrationBody,
  newPublicationReport,
  parsePublicationArgs,
  publicationMarkdown,
  publicationStatus,
  runInterleavings,
  runPublicationFlow,
  sha256File,
  type Db,
  type FullState,
  type Observation,
} from "./reportingPublication";

const ENV_FILE = ".env.staging.local";

function readSettings(): Record<string, string> {
  if (!existsSync(ENV_FILE)) throw new Error(`${ENV_FILE} not found in the repo root.`);
  const v: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) v[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  for (const k of ["STAGING_DB_URL", "STAGING_SUPABASE_URL", "STAGING_SUPABASE_ANON_KEY"]) if (!v[k]) throw new Error(`${ENV_FILE} is missing ${k}`);
  return v;
}

async function markerCheck(client: pg.Client): Promise<void> {
  const r = await client.query(
    "select (select count(*) from public.locations where key = 'staging')::int as loc, (select count(*) from auth.users where email like '%@inka-staging.test')::int as users",
  );
  if (r.rows[0]?.loc !== 1 || !(r.rows[0]?.users >= 5)) throw new Error("Refusing to run: this database is not the staging project (no staging location/test users).");
}

async function openGuarded(raw: string, target: StagingTarget, watch: ConnectionWatch): Promise<pg.Client> {
  const url = new URL(raw);
  for (const k of [...url.searchParams.keys()]) if (k.startsWith("ssl")) url.searchParams.delete(k);
  return openGuardedClient(() => new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false }, application_name: "reporting-fence-staging-check" }), target, markerCheck, redactSecrets, watch);
}

const errText = (e: unknown) => {
  const code = (e as { code?: string }).code;
  return code ? `error ${code}` : `error ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INS = (id: string) =>
  `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id)
   values ('au', '${id}', $1::uuid, 'framed', 'RJ-FENCE', 'INKA-KAN0566-A4-FB', 1, 'line_verified', 'rj-station', 'fence check', '2026-11-11T05:00:00Z', null, null)`;

interface Ctx {
  open: () => Promise<pg.Client>;
  claims: Record<string, string>;
  staff: string;
  /** The run's receipt store (report.captureTransitions / report.errors / save). */
  receipts: ReceiptIO;
}

/** Committed control transition through the service-only RPC, as service_role, with a receipt saved before COMMIT. */
async function toggle(ctx: Ctx, enabled: boolean, restoring = false): Promise<number> {
  return ownedToggle({ ...ctx.receipts, as: (c) => become(c as pg.Client, "service_role", ctx.claims) }, enabled, restoring);
}

/** The connection's effective lock_timeout in ms (0 = none); never changed by the runner. */
async function existingLockMs(c: pg.Client): Promise<number> {
  return Number((await c.query("select setting::bigint as ms from pg_catalog.pg_settings where name = 'lock_timeout'")).rows[0].ms);
}

/** Set a scenario-local lock limit that never loosens the existing one. */
async function setLocalLockLimit(c: pg.Client, wantMs: number): Promise<{ existing: number; used: number }> {
  const existing = await existingLockMs(c);
  const used = capLimit(wantMs, existing);
  if (used !== existing) await c.query("select set_config('lock_timeout', $1, true)", [`${used}ms`]);
  return { existing, used };
}

async function controlState(c: pg.Client): Promise<{ epoch: number; enabled: boolean }> {
  const r = await c.query(`select capture_epoch, capture_enabled from ${REPORTING_SCHEMA}.control where singleton`);
  return { epoch: Number(r.rows[0].capture_epoch), enabled: Boolean(r.rows[0].capture_enabled) };
}

async function waitingOnLock(monitor: pg.Client, pid: number): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const r = await monitor.query("select wait_event_type from pg_catalog.pg_stat_activity where pid = $1", [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return true;
    await sleep(100);
  }
  return false;
}

/** Run a scenario on n fresh guarded clients; every client is rolled back and ended, and every cleanup failure is reported. */
export async function withClients<T>(ctx: Pick<Ctx, "open">, n: number, fn: (cs: pg.Client[]) => Promise<T>): Promise<T> {
  const cs: pg.Client[] = [];
  let result: T | undefined;
  let failure: unknown = null;
  try {
    for (let i = 0; i < n; i++) cs.push(await ctx.open());
    result = await fn(cs);
  } catch (e) {
    failure = e;
  }
  const cleanup: string[] = [];
  for (const c of cs) {
    await c.query("rollback").catch((e) => cleanup.push(`rollback: ${e instanceof Error ? e.message : String(e)}`));
    await c.end().catch((e) => cleanup.push(`disconnect: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (failure || cleanup.length) {
    const first = failure ? (failure instanceof Error ? failure.message : String(failure)) : "";
    throw new Error([first, ...cleanup.map((x) => `cleanup failed: scenario connection ${x}`)].filter(Boolean).join("; "));
  }
  return result as T;
}

async function f1(ctx: Ctx): Promise<FenceObservation> {
  await toggle(ctx, true);
  return withClients(ctx, 2, async ([a, b]) => {
    await a.query("begin");
    await become(a, "staff", ctx.claims);
    await a.query(INS("rj-f1-a"), [ctx.staff]);
    await b.query("begin");
    const limit = await setLocalLockLimit(b, 3000);
    await become(b, "staff", ctx.claims);
    const t = performance.now();
    try {
      await b.query(INS("rj-f1-b"), [ctx.staff]);
      return { id: "F1", existingLockMs: limit.existing, writerLimitMs: limit.used, secondWriterMs: Math.round(performance.now() - t), secondWriterError: null };
    } catch (e) {
      return { id: "F1", existingLockMs: limit.existing, writerLimitMs: limit.used, secondWriterMs: null, secondWriterError: errText(e) };
    }
  });
}

/** F2 lives in reportingFenceRun.ts (fenceF2) so its whole lifecycle is tested without a database. */
async function f2(ctx: Ctx): Promise<FenceObservation> {
  return fenceF2({
    open: ctx.open,
    become: (c, role) => become(c as pg.Client, role, ctx.claims),
    waitingOnLock: (mon, pid) => waitingOnLock(mon as pg.Client, pid),
    toggle: (on) => toggle(ctx, on),
    receipts: ctx.receipts,
    insertSql: INS,
    staff: ctx.staff,
  });
}

async function f3(ctx: Ctx): Promise<FenceObservation> {
  await toggle(ctx, false);
  return withClients(ctx, 1, async ([e]) => {
    await e.query("begin isolation level repeatable read");
    await e.query("select 1 from public.locations limit 1"); // the snapshot is taken here
    await toggle(ctx, true);
    await become(e, "staff", ctx.claims);
    try {
      await e.query(INS("rj-f3-e"), [ctx.staff]);
      return { id: "F3", oldSnapshotError: null };
    } catch (err) {
      return { id: "F3", oldSnapshotError: errText(err) };
    }
  });
}

async function f4(ctx: Ctx): Promise<FenceObservation> {
  const start = await toggle(ctx, true);
  const epochAfterDisable = await toggle(ctx, false);
  const epochAfterEnable = await toggle(ctx, true);
  return withClients(ctx, 1, async ([w]) => {
    await w.query("begin");
    await become(w, "staff", ctx.claims);
    await w.query(INS("rj-f4-w"), [ctx.staff]);
    await w.query("reset role");
    const j = await w.query(`select count(*)::int as n, max(capture_epoch) as e from ${REPORTING_SCHEMA}.changes where new_event_id = 'rj-f4-w'`);
    return { id: "F4", epochBefore: start, epochAfterDisable, epochAfterEnable, journalRows: Number(j.rows[0].n), journalEpoch: j.rows[0].e === null ? null : Number(j.rows[0].e) };
  });
}

async function f5(ctx: Ctx): Promise<FenceObservation> {
  return withClients(ctx, 3, async ([a, c, mon]) => {
    const before = await controlState(mon);
    await a.query("begin");
    await become(a, "staff", ctx.claims);
    await a.query(INS("rj-f5-a"), [ctx.staff]); // holds the control share lock
    const existing = await existingLockMs(c);
    const defaultLimitMs = capLimit(3000, existing); // what set_reporting_capture applies
    const attempt = async (stricter: boolean) => {
      await c.query("begin");
      if (stricter) await setLocalLockLimit(c, 1000);
      await become(c, "service_role", ctx.claims);
      const t = performance.now();
      try {
        await c.query("select capture_epoch from public.set_reporting_capture($1)", [!before.enabled]);
        return { error: null as string | null, ms: Math.round(performance.now() - t) };
      } catch (e) {
        return { error: errText(e), ms: Math.round(performance.now() - t) };
      } finally {
        await c.query("rollback");
      }
    };
    const d = await attempt(false);
    const s = await attempt(true);
    await a.query("rollback");
    const after = await controlState(mon);
    return {
      id: "F5", existingLockMs: existing, defaultLimitMs, timeoutError: d.error, timeoutMs: d.ms, stricterLimitMs: capLimit(1000, existing),
      stricterError: s.error, stricterMs: s.ms, controlUnchanged: after.epoch === before.epoch && after.enabled === before.enabled,
    };
  });
}

async function f6(ctx: Ctx): Promise<FenceObservation> {
  return withClients(ctx, 1, async ([p]) => {
    await p.query("begin");
    await p.query("grant reporting_capture to current_user with inherit false, set true"); // rolled back below
    await p.query("set local role reporting_capture");
    const lock = await p.query(`select capture_epoch from ${REPORTING_SCHEMA}.control where singleton for share`);
    const tryUpdate = async (sql: string) => {
      await p.query("savepoint f6");
      try {
        await p.query(sql);
        await p.query("release savepoint f6");
        return null;
      } catch (e) {
        await p.query("rollback to savepoint f6");
        return errText(e);
      }
    };
    const updateUpdatedAtError = await tryUpdate(`update ${REPORTING_SCHEMA}.control set updated_at = now() where singleton`);
    const updateEnabledError = await tryUpdate(`update ${REPORTING_SCHEMA}.control set capture_enabled = not capture_enabled where singleton`);
    await p.query("rollback");
    return { id: "F6", lockRows: lock.rowCount, updateUpdatedAtError, updateEnabledError };
  });
}

/** Part B2b: publication rehearsal / installed flow / interleavings. Every transaction is rolled back. */
async function publicationMain(argv: string[]): Promise<number> {
  const { mode, sites, maxPages, problems } = parsePublicationArgs(argv);
  if (!mode || !sites) {
    console.error(problems.join("; "));
    return 2;
  }
  const revision = (() => {
    try {
      return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "unknown";
    }
  })();
  const report = newPublicationReport(mode, sites, revision, new Date().toISOString(), sha256File(MIGRATION_0038));
  const runId = randomBytes(4).toString("hex");
  const out = `staging-results-reporting-publication-${mode}-${report.startedAt.replace(/[^0-9TZ]/g, "")}-${runId}.md`;
  if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
  const save = () => {
    writeFileSync(`${out}.tmp`, publicationMarkdown(report));
    renameSync(`${out}.tmp`, out);
  };
  // T13B2b-22: one run-scoped connection watch; its errors are the report's errors (the final status store).
  const watch = newConnectionWatch(report.errors, redactSecrets, save);
  // T13B2b-23: a failed evidence save latches the watch (all next normal SQL refused) before it rethrows.
  const evidence = durableEvidence(report.evidence, save, watch, () => ({ run: runId, report: out, at: new Date().toISOString() }), redactSecrets);
  if (!initialReport(save)) return 1;
  console.log(`report: ${out}`);
  let open: () => Promise<pg.Client>;
  let claims: Record<string, string>;
  try {
    const s = readSettings();
    assertStagingSupabaseUrl(s.STAGING_SUPABASE_URL);
    const target = stagingTarget(s.STAGING_DB_URL);
    // The read-only baseline smoke never needs a session: no sign-in, no claims.
    if (mode === "baseline-smoke") claims = {};
    else {
      const logins = Object.fromEntries(SESSION_ROLES.map((r) => [r, { email: s[`STAGING_${r.toUpperCase()}_EMAIL`], password: s[`STAGING_${r.toUpperCase()}_PASSWORD`] }])) as Record<SessionRole, { email: string; password: string }>;
      claims = (await signInClaims(s.STAGING_SUPABASE_URL, s.STAGING_SUPABASE_ANON_KEY, logins)).text;
    }
    open = () => openGuarded(s.STAGING_DB_URL, target, watch);
  } catch (e) {
    report.errors.push(redactSecrets(e instanceof Error ? e.message : String(e)));
    report.finishedAt = new Date().toISOString();
    save();
    console.log(publicationStatus(report));
    return 1;
  }
  const record = (o: Observation) => {
    report.observations.push(o);
    console.log(redactSecrets(`${o.ok ? "ok " : "NO "} ${o.id} ${o.what}: ${o.result}`));
    save();
  };
  const as = async (c: Db, service: boolean) => {
    if (service) await become(c as pg.Client, "service_role", claims);
    else await c.query("reset role");
  };
  let before: FullState | null = null;
  let own: Ownership | null = null;
  await runCaptureLifecycle(report, {
    open,
    watch,
    now: () => new Date().toISOString(),
    redact: redactSecrets,
    save,
    body: async (main) => {
      const st = await main.query("select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt, current_setting('idle_in_transaction_session_timeout') as it");
      report.settings = `statement_timeout=${st.rows[0].st}, lock_timeout=${st.rows[0].lt}, idle_in_transaction_session_timeout=${st.rows[0].it}`;
      const staff = String((await main.query("select id::text as id from auth.users where email = 'staff@inka-staging.test'")).rows[0]?.id ?? "");
      if (!staff) throw new Error("staff test user not found");
      const installed = Boolean((await main.query("select exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'publish_reporting_batch') as x")).rows[0]?.x);
      if (mode === "rehearse-migration" && installed) throw new Error("0038 is already installed; use --check-installed");
      if (mode !== "rehearse-migration" && mode !== "baseline-smoke" && !installed) throw new Error("0038 is not installed; use --rehearse-migration");
      before = await fullState(main);
      if (mode === "baseline-smoke") {
        // T13B2b-8: bounded READ-ONLY check that the full baseline can be taken (no transaction, no write, no migration);
        // the lifecycle's fresh audit then proves nothing changed.
        const surfaces = Object.keys(before.surfaces).length + Object.keys(before.privateTables).length;
        record({ id: "S0", what: `full-state baseline captured (${surfaces} surfaces, 0038 ${installed ? "installed" : "absent"})`, expected: "every surface query succeeds", result: "ok", ok: true, ms: 0 });
        return;
      }
      if (mode === "committed-interleavings") {
        // Prepared under the plan's approved harness; COMMITS only its documented, owned state and always cleans up.
        own = newOwnership(sites);
        report.ownership = own as unknown as Record<string, unknown>;
        await runCommitted({ sites, staff, maxPages, open, as, record, save, redact: redactSecrets, now: () => performance.now(), enterCleanup: () => void watch.phase("cleanup") }, own, report.cleanup);
        return;
      }
      if (mode === "rehearse-rebuild-repair") {
        // T13B2b-19: 0039 applied and proven inside ONE always-rolled-back transaction; the audit below allows ZERO changes.
        await rehearseRebuildRepair(main, { sites, maxPages, staff, as, record, redact: redactSecrets, now: () => performance.now(), emit: (ev) => { report.repair = ev as unknown as Record<string, unknown>; save(); } });
        return;
      }
      if (mode === "rehearse-dependency-reads") {
        // T14S1: 0040 + 0041 applied and exercised inside ONE always-rolled-back transaction; the audit below allows ZERO changes.
        await rehearseDependencyReads(main, { sites, maxPages, staff, as, record, redact: redactSecrets, now: () => performance.now(), emit: (ev) => { report.dependency = ev as unknown as Record<string, unknown>; save(); } });
        return;
      }
      if (mode === "diagnose-dependency-plans") {
        // T14S3: exact allowlisted SELECTs under EXPLAIN ANALYZE inside ONE always-rolled-back transaction; the audit below allows ZERO changes.
        await diagnoseDependencyPlans(main, { sites, maxPages, staff, as, record, redact: redactSecrets, now: () => performance.now(), emit: (ev) => { report.dependencyPlans = ev as unknown as Record<string, unknown>; save(); } });
        return;
      }
      if (mode === "diagnose-access-paths") {
        // Task 14 0042 follow-up: 0040 + 0041 + 0042 inside ONE always-rolled-back transaction; the audit below allows ZERO changes.
        await diagnoseAccessPaths(main, { sites, maxPages, staff, as, record, redact: redactSecrets, now: () => performance.now(), emit: (ev) => { report.accessPaths = ev as unknown as Record<string, unknown>; save(); } });
        return;
      }
      if (mode === "explain-source-versions") {
        // B2b I4 diagnostic: plan only, one transaction that always rolls back; the audit below allows ZERO changes.
        await runPlanDiagnostic(main, { site: sites[0], maxPages, as, record, redact: redactSecrets, now: () => performance.now(), emit: (d) => { report.diagnostic = d as unknown as Record<string, unknown>; save(); } });
        return;
      }
      if (mode === "interleavings") {
        await runInterleavings({ sites, staff, open, as, record, redact: redactSecrets, now: () => performance.now(), sleep: async (ms) => void (await sleep(ms)), maxPages, evidence, armTermination: watch.armTermination }, report.cleanup);
        return;
      }
      await main.query("begin");
      if (mode === "rehearse-migration") {
        const body = migrationBody(readFileSync(MIGRATION_0038, "utf8"));
        for (const sql of body) await main.query(sql);
        report.statementsApplied = body.length;
        save();
      }
      const cat = (await main.query(CATALOG_SQL)).rows[0].j as ReportingCatalog;
      cat.sourcePolicyHash = (await catalog(main)).policyHash;
      report.catalogProblems = [...(catalogLevel(cat) === "0038" ? [] : ["catalog is not at the 0038 level"]), ...checkCatalog(cat)];
      save();
      await runPublicationFlow(main, { sites, maxPages, staff, as, record, redact: redactSecrets, now: () => performance.now() });
      await main.query("rollback");
    },
    audit: async (fresh) => {
      if (!before) throw new Error("no starting baseline was taken, so nothing can be compared");
      // Every surface (payloads, stock, ledger, memberships, catalog/ACL, all private rows, control, site state) must be identical,
      // except, for the committed harness only, its declared epoch increments and the run sites' lease bookkeeping.
      const allow = mode === "committed-interleavings" && own ? committedAllowance(own) : ROLLBACK_ONLY;
      return compareFullState(before, await fullState(fresh), allow).map((d) => `baseline differs after the run: ${d}`);
    },
  });
  finalReport(save, () => publicationMarkdown(report), report.errors);
  const status = publicationStatus(report);
  console.log(status);
  return status === "STATUS: COMPLETE" ? 0 : 1;
}

/** Task 15 harness: same guarded lifecycle (target guard per query, marker per connection, redaction, immutable report, unconditional disconnect + fresh audit). */
async function workerMain(argv: string[]): Promise<number> {
  const args = parseWorkerArgs(argv);
  if (!args.mode || !args.site || args.problems.length) {
    console.error(args.problems.join("; "));
    return 2;
  }
  const { mode, site } = args;
  const revision = (() => {
    try {
      return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "unknown";
    }
  })();
  const report = newWorkerReport(mode, site, revision, new Date().toISOString(), sha256Lf(readFileSync(MIGRATION_0043, "utf8")));
  const out = `staging-results-reporting-worker-${mode}-${report.startedAt.replace(/[^0-9TZ]/g, "")}-${randomBytes(4).toString("hex")}.md`;
  if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
  const save = () => {
    writeFileSync(`${out}.tmp`, workerMarkdown(report));
    renameSync(`${out}.tmp`, out);
  };
  const watch = newConnectionWatch(report.errors, redactSecrets, save);
  if (!initialReport(save)) return 1;
  console.log(`report: ${out}`);
  let open: () => Promise<pg.Client>;
  try {
    const s = readSettings();
    assertStagingSupabaseUrl(s.STAGING_SUPABASE_URL);
    const target = stagingTarget(s.STAGING_DB_URL);
    open = () => openGuarded(s.STAGING_DB_URL, target, watch);
  } catch (e) {
    report.errors.push(redactSecrets(e instanceof Error ? e.message : String(e)));
    report.finishedAt = new Date().toISOString();
    save();
    console.log(workerStatus(report));
    return 1;
  }
  const record = (o: Observation) => {
    report.observations.push(o);
    console.log(redactSecrets(`${o.ok ? "ok " : "NO "} ${o.id} ${o.what}: ${o.result}`));
    save();
  };
  // No timeout is set or loosened: service_role gets only its claims and role; authenticated only its role (refusal checks).
  const asRole = async (c: Db, role: "postgres" | "service_role" | "authenticated") => {
    await c.query("reset role");
    if (role === "service_role") {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await c.query("set local role service_role");
    } else if (role === "authenticated") await c.query("set local role authenticated");
  };
  let before: FullState | null = null;
  // --worker-runtime ownership/evidence: in the report (saved) before the first commit.
  const own = newRuntimeOwnership(site, randomBytes(4).toString("hex"));
  const rev = newRuntimeEvidence();
  if (mode === "worker-runtime") report.ownership = own as unknown as Record<string, unknown>;
  const runtimeCtx = (staff: string): RuntimeCtx => ({
    site, staff, record, redact: redactSecrets, asRole,
    open: () => open(),
    rpcClient: (c, opts) => serviceRpcClient(c, opts),
    // The run's OWN capture transition: control locked FOR UPDATE, receipt persisted BEFORE COMMIT (same helper as the fence runner).
    toggle: (enabled, restoring = false) => ownedToggle({ transitions: own.captureTransitions, save, errors: report.errors, open: () => open(), redact: redactSecrets, as: (c) => become(c as pg.Client, "service_role", {}) }, enabled, restoring),
    history: async (c) => (await c.query(HISTORY_SQL)).rows,
    state: (c) => fullState(c),
    // A REAL bounded wait: the lease row is only read, never edited.
    awaitLeaseExpiry: async (s) => {
      const t0 = Date.now();
      for (;;) {
        const c = await open();
        let left: number | null;
        try {
          const r = (await c.query("select (extract(epoch from (lease_expires_at - now())) * 1000)::bigint as ms from reporting_private.site_state where site = $1 and active_batch_id is not null", [s])).rows[0];
          left = r?.ms == null ? null : Number(r.ms);
        } finally {
          await c.end();
        }
        if (left === null || left < 0) return Date.now() - t0;
        if (Date.now() - t0 + left > args.maxLeaseWaitMs) throw new Error(`the ${s} lease needs ${left} ms more; over --max-lease-wait-ms=${args.maxLeaseWaitMs}`);
        await sleep(Math.min(left + 1500, 30_000));
      }
    },
    save, now: () => Date.now(), sleep: async (ms) => void (await sleep(ms)),
    limits: { paceCalls: args.paceCalls, maxInvocations: args.maxInvocations },
    enterCleanup: () => void watch.phase("cleanup"),
  });
  await runCaptureLifecycle(report, {
    open,
    watch,
    now: () => new Date().toISOString(),
    redact: redactSecrets,
    save,
    body: async (main) => {
      const st = await main.query("select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt, current_setting('idle_in_transaction_session_timeout') as it");
      report.settings = `statement_timeout=${st.rows[0].st}, lock_timeout=${st.rows[0].lt}, idle_in_transaction_session_timeout=${st.rows[0].it}`;
      before = await fullState(main);
      if (mode === "worker-runtime") report.evidence = rev as unknown as Record<string, unknown>;
      if (mode === "rehearse-worker-state") {
        await rehearseWorkerState(main, {
          site, asRole, record, redact: redactSecrets, now: () => performance.now(),
          history: async (c) => (await c.query(HISTORY_SQL)).rows,
          emit: (ev) => { report.evidence = ev as unknown as Record<string, unknown>; save(); },
        });
        return;
      }
      // --worker-runtime: COMMITS only its declared, owned state; cleanup ALWAYS runs before the fresh audit.
      const staff = String((await main.query("select id::text as id from auth.users where email = 'staff@inka-staging.test'")).rows[0]?.id ?? "");
      if (!staff) throw new Error("staff test user not found");
      try {
        await runWorkerRuntime(main, runtimeCtx(staff), own, rev);
      } finally {
        await cleanupRuntime(runtimeCtx(staff), own, report.cleanup);
      }
    },
    audit: async (fresh) => {
      if (mode === "worker-runtime") {
        if (!own.committedAnything) {
          // refused before the first commit: nothing may differ at all
          if (!rev.before) throw new Error("no starting baseline was taken, so nothing can be compared");
          return compareFullState(rev.before, await fullState(fresh), ROLLBACK_ONLY).map((d) => `baseline differs after the run: ${d}`);
        }
        const a = await auditRuntime(fresh, { state: (c) => fullState(c) }, own, rev);
        report.evidence = { ...(report.evidence ?? {}), finalState: a.finalState };
        return a.problems;
      }
      if (!before) throw new Error("no starting baseline was taken, so nothing can be compared");
      return compareFullState(before, await fullState(fresh), ROLLBACK_ONLY).map((d) => `baseline differs after the run: ${d}`);
    },
  });
  finalReport(save, () => workerMarkdown(report), report.errors);
  const status = workerStatus(report);
  console.log(status);
  return status === "STATUS: COMPLETE" ? 0 : 1;
}

async function main(): Promise<number> {
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  if (flags.some((f) => (WORKER_FLAGS as readonly string[]).includes(f))) return workerMain(flags);
  if (flags.some((f) => f === "--baseline-smoke" || f === "--rehearse-migration" || f === "--check-installed" || f === "--interleavings" || f === "--committed-interleavings" || f === "--explain-source-versions" || f === "--rehearse-rebuild-repair" || f === "--rehearse-dependency-reads" || f === "--diagnose-dependency-plans" || f === "--diagnose-access-paths")) return publicationMain(flags);
  if (flags.join(" ") !== "--fence") {
    console.error("usage: npm run staging:reporting-jobs -- --fence | --rehearse-migration|--check-installed|--interleavings --sites=A,B [--max-pages=N] | --explain-source-versions --site=X [--max-pages=N] | --rehearse-rebuild-repair --sites=A,B [--max-pages=N] | --rehearse-dependency-reads --sites=A,B [--max-pages=N] | --diagnose-dependency-plans --sites=A,B [--max-pages=N] | --diagnose-access-paths --sites=A,B [--max-pages=N]");
    return 2;
  }
  const revision = (() => {
    try {
      return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "unknown";
    }
  })();
  const report = newFenceReport(revision, new Date().toISOString());
  const out = `staging-results-reporting-fence-${report.startedAt.replace(/[^0-9TZ]/g, "")}-${randomBytes(4).toString("hex")}.md`;
  if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
  const save = () => {
    writeFileSync(`${out}.tmp`, fenceMarkdown(report));
    renameSync(`${out}.tmp`, out);
  };
  const watch = newConnectionWatch(report.errors, redactSecrets, save); // T13B2b-22
  if (!initialReport(save)) return 1;
  console.log(`report: ${out}`);
  let ctx: Ctx;
  const receipts: ReceiptIO = {
    transitions: report.captureTransitions,
    errors: report.errors,
    save,
    open: () => ctx.open(),
    redact: redactSecrets,
  };
  try {
    const s = readSettings();
    assertStagingSupabaseUrl(s.STAGING_SUPABASE_URL);
    const target = stagingTarget(s.STAGING_DB_URL);
    const logins = Object.fromEntries(SESSION_ROLES.map((r) => [r, { email: s[`STAGING_${r.toUpperCase()}_EMAIL`], password: s[`STAGING_${r.toUpperCase()}_PASSWORD`] }])) as Record<SessionRole, { email: string; password: string }>;
    const claims = (await signInClaims(s.STAGING_SUPABASE_URL, s.STAGING_SUPABASE_ANON_KEY, logins)).text;
    ctx = { open: () => openGuarded(s.STAGING_DB_URL, target, watch), claims, staff: "", receipts };
  } catch (e) {
    report.errors.push(redactSecrets(e instanceof Error ? e.message : String(e)));
    report.finishedAt = new Date().toISOString();
    save();
    console.log(fenceStatus(report));
    return 1;
  }
  const scenarios = ([["F1", f1], ["F2", f2], ["F3", f3], ["F4", f4], ["F5", f5], ["F6", f6]] as const).map(([id, f]) => ({ id, run: () => f(ctx) }));
  await runFence(report, {
    watch,
    open: ctx.open,
    now: () => new Date().toISOString(),
    redact: redactSecrets,
    save,
    prepare: async (main) => {
      const st = await main.query("select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt, current_setting('idle_in_transaction_session_timeout') as it");
      report.settings = `statement_timeout=${st.rows[0].st}, lock_timeout=${st.rows[0].lt}, idle_in_transaction_session_timeout=${st.rows[0].it}`;
      const has = await main.query("select exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'set_reporting_capture') as x");
      if (!has.rows[0]?.x) throw new Error("0038 is not installed; the fence checks need it applied");
      ctx.staff = String((await main.query("select id::text as id from auth.users where email = 'staff@inka-staging.test'")).rows[0]?.id ?? "");
      if (!ctx.staff) throw new Error("staff test user not found");
    },
    scenarios,
    restore: async (enabled) => void (await toggle(ctx, enabled, true)),
    fullState: (c) => fullState(c),
    controlState: (c) => controlState(c as pg.Client),
  });
  finalReport(save, () => fenceMarkdown(report), report.errors);
  const status = fenceStatus(report);
  console.log(status);
  return status === "STATUS: COMPLETE" ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(redactSecrets(e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  },
);
