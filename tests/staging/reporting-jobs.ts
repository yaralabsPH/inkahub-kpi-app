/**
 * Task 13 staging runner: activation-fence interleavings (Part A).
 * STAGING ONLY (ybrzhrgfrnvtcwymjdrq); requires migration 0038 applied.
 *
 *   npm run staging:reporting-jobs -- --fence
 *   npm run staging:reporting-jobs -- --rehearse-migration --sites=A,B [--max-pages=N]
 *   npm run staging:reporting-jobs -- --check-installed --sites=A,B [--max-pages=N]
 *   npm run staging:reporting-jobs -- --interleavings --sites=A,B [--max-pages=N]
 *
 * The last three are Task 13 Part B2b's publication evidence
 * (tests/staging/reportingPublication.ts): the full 0038 draft applied inside
 * ONE always-rolled-back transaction, the same flow against an installed
 * 0038, and multi-connection lock/fault checks. None of them commits.
 *
 * Several real connections. Every source write is rolled back. Capture
 * toggles go through public.set_reporting_capture as service_role and are
 * COMMITTED (each advances the epoch); capture is returned to its starting
 * on/off state at the end. Every client is guarded (frozen staging target at
 * every query) and marker-checked; a fresh guarded audit verifies restoration
 * after success and failure. No timeout is overridden except a scenario's own
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
import { CATALOG_SQL, openGuardedClient, REPORTING_SCHEMA, runCaptureLifecycle, stagingTarget, type ReportingCatalog, type StagingTarget } from "./reportingCapture";
import { capLimit, checkFence, fenceMarkdown, fenceStatus, launch, newFenceReport, type FenceObservation } from "./reportingFence";
import { catalog } from "./policyParityRun";
import { catalogLevel, checkCatalog } from "./reportingCapture";
import {
  BASELINE_SQL,
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

async function openGuarded(raw: string, target: StagingTarget): Promise<pg.Client> {
  const url = new URL(raw);
  for (const k of [...url.searchParams.keys()]) if (k.startsWith("ssl")) url.searchParams.delete(k);
  return openGuardedClient(() => new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false }, application_name: "reporting-fence-staging-check" }), target, markerCheck, redactSecrets);
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
}

/** Committed control transition through the service-only RPC, as service_role. */
async function toggle(ctx: Ctx, enabled: boolean): Promise<number> {
  const c = await ctx.open();
  try {
    await c.query("begin");
    await become(c, "service_role", ctx.claims);
    const r = await c.query("select capture_epoch from public.set_reporting_capture($1)", [enabled]);
    await c.query("commit");
    return Number(r.rows[0].capture_epoch);
  } finally {
    await c.end();
  }
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

async function f2(ctx: Ctx): Promise<FenceObservation> {
  const epochBefore = await toggle(ctx, false);
  return withClients(ctx, 4, async ([a, c, d, mon]) => {
    await a.query("begin");
    await become(a, "staff", ctx.claims);
    await a.query(INS("rj-f2-a"), [ctx.staff]); // disabled period: holds the control share lock, no journal
    const cPid = Number((await c.query("select pg_backend_pid() as p")).rows[0].p);
    await c.query("begin");
    await become(c, "service_role", ctx.claims);
    // T13A-1: observed at once, inspected (or rethrown) where awaited; polling failures still clean up.
    const enable = launch(c.query("select capture_epoch from public.set_reporting_capture(true)"));
    const toggleWaited = await waitingOnLock(mon, cPid);
    await a.query("rollback"); // the disabled-period write ends (nothing kept)
    const epochAfter = Number((await enable.result()).rows[0].capture_epoch);
    // The toggle is applied but NOT committed: a READ COMMITTED writer queues behind it.
    const dPid = Number((await d.query("select pg_backend_pid() as p")).rows[0].p);
    await d.query("begin");
    await become(d, "staff", ctx.claims);
    const write = launch(d.query(INS("rj-f2-d"), [ctx.staff]));
    const queuedWriterWaited = await waitingOnLock(mon, dPid);
    await c.query("commit");
    await write.result();
    await d.query("reset role");
    const j = await d.query(`select count(*)::int as n, max(capture_epoch) as e from ${REPORTING_SCHEMA}.changes where new_event_id = 'rj-f2-d'`);
    return { id: "F2", toggleWaited, queuedWriterWaited, epochBefore, epochAfter, journalRows: Number(j.rows[0].n), journalEpoch: j.rows[0].e === null ? null : Number(j.rows[0].e) };
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

interface Snap {
  catalog: ReportingCatalog | null;
  enabled: boolean;
  fixtures: string;
}
async function snapshot(c: pg.Client): Promise<Snap> {
  const cat = (await c.query(CATALOG_SQL)).rows[0].j as ReportingCatalog;
  const norm = JSON.parse(JSON.stringify(cat)) as ReportingCatalog & { control: Record<string, unknown> | null };
  const enabled = Boolean(cat.control?.capture_enabled);
  if (norm.control) norm.control = { ...norm.control, capture_epoch: null, updated_at: null } as never;
  const f = await c.query(
    `select concat_ws(';', 'rj-events=' || (select count(*) from public.production_events where id like 'rj-%'), 'rj-journal=' || (select count(*) from ${REPORTING_SCHEMA}.changes where coalesce(new_event_id, old_event_id) like 'rj-%')) as s`,
  );
  return { catalog: norm, enabled, fixtures: String(f.rows[0].s) };
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
  const out = `staging-results-reporting-publication-${mode}-${report.startedAt.replace(/[^0-9TZ]/g, "")}-${randomBytes(4).toString("hex")}.md`;
  if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
  const save = () => {
    writeFileSync(`${out}.tmp`, publicationMarkdown(report));
    renameSync(`${out}.tmp`, out);
  };
  save();
  console.log(`report: ${out}`);
  let open: () => Promise<pg.Client>;
  let claims: Record<string, string>;
  try {
    const s = readSettings();
    assertStagingSupabaseUrl(s.STAGING_SUPABASE_URL);
    const target = stagingTarget(s.STAGING_DB_URL);
    const logins = Object.fromEntries(SESSION_ROLES.map((r) => [r, { email: s[`STAGING_${r.toUpperCase()}_EMAIL`], password: s[`STAGING_${r.toUpperCase()}_PASSWORD`] }])) as Record<SessionRole, { email: string; password: string }>;
    claims = (await signInClaims(s.STAGING_SUPABASE_URL, s.STAGING_SUPABASE_ANON_KEY, logins)).text;
    open = () => openGuarded(s.STAGING_DB_URL, target);
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
  let before: string | null = null;
  await runCaptureLifecycle(report, {
    open,
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
      if (mode !== "rehearse-migration" && !installed) throw new Error("0038 is not installed; use --rehearse-migration");
      before = JSON.stringify((await main.query(BASELINE_SQL)).rows[0].j);
      if (mode === "interleavings") {
        await runInterleavings({ sites, staff, open, as, record, redact: redactSecrets, now: () => performance.now(), sleep: async (ms) => void (await sleep(ms)), maxPages }, report.cleanup);
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
      const after = JSON.stringify((await fresh.query(BASELINE_SQL)).rows[0].j);
      return after === before ? [] : [`baseline differs after rollback: before ${before.slice(0, 400)} after ${after.slice(0, 400)}`];
    },
  });
  save();
  const status = publicationStatus(report);
  console.log(status);
  return status === "STATUS: COMPLETE" ? 0 : 1;
}

async function main(): Promise<number> {
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  if (flags.some((f) => f === "--rehearse-migration" || f === "--check-installed" || f === "--interleavings")) return publicationMain(flags);
  if (flags.join(" ") !== "--fence") {
    console.error("usage: npm run staging:reporting-jobs -- --fence | --rehearse-migration|--check-installed|--interleavings --sites=A,B [--max-pages=N]");
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
  save();
  console.log(`report: ${out}`);
  let ctx: Ctx;
  try {
    const s = readSettings();
    assertStagingSupabaseUrl(s.STAGING_SUPABASE_URL);
    const target = stagingTarget(s.STAGING_DB_URL);
    const logins = Object.fromEntries(SESSION_ROLES.map((r) => [r, { email: s[`STAGING_${r.toUpperCase()}_EMAIL`], password: s[`STAGING_${r.toUpperCase()}_PASSWORD`] }])) as Record<SessionRole, { email: string; password: string }>;
    const claims = (await signInClaims(s.STAGING_SUPABASE_URL, s.STAGING_SUPABASE_ANON_KEY, logins)).text;
    ctx = { open: () => openGuarded(s.STAGING_DB_URL, target), claims, staff: "" };
  } catch (e) {
    report.errors.push(redactSecrets(e instanceof Error ? e.message : String(e)));
    report.finishedAt = new Date().toISOString();
    save();
    console.log(fenceStatus(report));
    return 1;
  }
  let before: Snap | null = null;
  await runCaptureLifecycle(report, {
    open: ctx.open,
    now: () => new Date().toISOString(),
    redact: redactSecrets,
    save,
    body: async (main) => {
      const st = await main.query("select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt, current_setting('idle_in_transaction_session_timeout') as it");
      report.settings = `statement_timeout=${st.rows[0].st}, lock_timeout=${st.rows[0].lt}, idle_in_transaction_session_timeout=${st.rows[0].it}`;
      const has = await main.query("select exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'set_reporting_capture') as x");
      if (!has.rows[0]?.x) throw new Error("0038 is not installed; the fence checks need it applied");
      ctx.staff = String((await main.query("select id::text as id from auth.users where email = 'staff@inka-staging.test'")).rows[0]?.id ?? "");
      if (!ctx.staff) throw new Error("staff test user not found");
      before = await snapshot(main);
      report.captureBefore = await controlState(main);
      for (const run of [f1, f2, f3, f4, f5, f6]) {
        let o: FenceObservation;
        try {
          o = await run(ctx);
        } catch (e) {
          o = { id: (["F1", "F2", "F3", "F4", "F5", "F6"] as const)[[f1, f2, f3, f4, f5, f6].indexOf(run)], error: redactSecrets(e instanceof Error ? e.message : String(e)) };
        }
        report.observations.push(o);
        save();
      }
      // Return capture to its starting on/off state (committed; advances the epoch if it differs).
      if ((await controlState(main)).enabled !== report.captureBefore.enabled) await toggle(ctx, report.captureBefore.enabled);
      report.captureAfter = await controlState(main);
      report.problems = checkFence(report.observations);
    },
    audit: async (fresh) => {
      if (!before) throw new Error("no starting snapshot was taken, so nothing can be compared");
      const after = await snapshot(fresh);
      const p: string[] = [];
      if (after.enabled !== before.enabled) p.push(`capture is ${after.enabled ? "enabled" : "disabled"}, was ${before.enabled ? "enabled" : "disabled"}`);
      if (JSON.stringify(after.catalog) !== JSON.stringify(before.catalog)) p.push("reporting schema/ACL/site state differ (epoch/updated_at excluded)");
      if (after.fixtures !== before.fixtures) p.push(`fixture state "${after.fixtures}" (before "${before.fixtures}")`);
      return p;
    },
  });
  save();
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
