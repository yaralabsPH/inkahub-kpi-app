/**
 * Task 12 staging runner: reporting capture, access and overhead checks.
 * STAGING ONLY (ybrzhrgfrnvtcwymjdrq).
 *
 *   npm run staging:reporting-capture -- --rehearse-migration
 *       0037 not installed: apply it INSIDE the rolled-back transaction, then
 *       run every catalog/capture/write/overhead check against it.
 *   npm run staging:reporting-capture -- --check
 *       0037 installed (CJ/planner applied it): the same checks.
 *   npm run staging:reporting-capture -- --concurrency
 *       0037 installed and capture enabled (operator step): two concurrent
 *       source transactions must not wait on each other.
 *
 * Safety (review T12-2..T12-4):
 *   - every client is wrapped so EACH query first asserts the frozen staging
 *     target (local check, no SQL; works in an aborted transaction), plus a
 *     staging-marker SQL check at the start of each connection;
 *   - no session timeout is overridden; the existing settings are recorded;
 *   - each phase is one transaction that is always rolled back; a FRESH
 *     guarded audit then verifies what was kept, after success and failure;
 *   - each invocation writes its own run-specific report (never overwrites a
 *     previous one), ending with exactly one STATUS line. Claims/credentials
 *     are never written.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { splitSqlStatements } from "./sqlStatements";
import { signInClaims, SESSION_ROLES, type SessionRole } from "./stagingSessions";
import { assertStagingSupabaseUrl } from "./measure-item-counting";
import { redactSecrets } from "./itemCountingPolicyParity";
import { catalog } from "./policyParityRun";
import { become, runSteps } from "./writeCompatRun";
import { checkSet } from "./writeCompat";
import {
  CAPTURE_STEPS,
  CATALOG_SQL,
  captureMarkdown,
  captureStatus,
  checkCatalog,
  checkSteps,
  compareSnapshots,
  finalReport,
  initialReport,
  concurrencyProbe,
  openGuardedClient,
  newCaptureReport,
  overheadSummary,
  parseCaptureMode,
  REPORTING_SCHEMA,
  runCaptureLifecycle,
  runOutputName,
  stagingTarget,
  type CaptureMode,
  type CaptureReport,
  type OverheadSample,
  type ReportingCatalog,
  type StagingTarget,
  type StateSnapshot,
  type StepResult,
} from "./reportingCapture";

const ENV_FILE = ".env.staging.local";
const MIGRATION = "supabase/migrations/0037_reporting_storage.sql";
const OVERHEAD_ROWS = 200;
const OVERHEAD_ROUNDS = 3;

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

/** The ONLY place a database client is created: guarded, no timeout override. */
async function openGuarded(raw: string, target: StagingTarget): Promise<pg.Client> {
  const url = new URL(raw);
  for (const k of [...url.searchParams.keys()]) if (k.startsWith("ssl")) url.searchParams.delete(k);
  // Connect/marker failures end the allocated client before rethrowing (no hang).
  return openGuardedClient(() => new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false }, application_name: "reporting-capture-staging-check" }), target, markerCheck, redactSecrets);
}

/** Staging marker: only the staging project has the `staging` location and its test users. */
async function markerCheck(client: pg.Client): Promise<void> {
  const r = await client.query(
    "select (select count(*) from public.locations where key = 'staging')::int as loc, (select count(*) from auth.users where email like '%@inka-staging.test')::int as users",
  );
  if (r.rows[0]?.loc !== 1 || !(r.rows[0]?.users >= 5)) throw new Error("Refusing to run: this database is not the staging project (no staging location/test users).");
}

async function readCatalog(client: pg.Client): Promise<ReportingCatalog | null> {
  const has = await client.query(`select exists (select 1 from pg_catalog.pg_namespace where nspname = '${REPORTING_SCHEMA}') as x`);
  if (!has.rows[0]?.x) return null;
  const c = (await client.query(CATALOG_SQL)).rows[0].j as ReportingCatalog;
  c.sourcePolicyHash = (await catalog(client)).policyHash;
  return c;
}

const FIXTURE_SQL = `select concat_ws(';',
    'rc-events=' || (select count(*) from public.production_events where id like 'rc-%'),
    'wc-events=' || (select count(*) from public.production_events where id like 'wc-%'),
    'rc-products=' || (select count(*) from public.products where id like 'rc-sup-%'),
    'test-ledger=' || (select count(*) from public.ledger where parent_event_id like 'rc-%' or parent_event_id like 'wc-%'),
    'staging-stock=' || coalesce((select string_agg(id || ':' || current_on_hand::text, ',' order by id) from public.products where location = 'staging'), ''),
    'au-stock=' || coalesce((select md5(string_agg(id || ':' || current_on_hand::text, ',' order by id)) from public.products where location = 'au'), '')
  ) as s`;

async function snapshot(client: pg.Client): Promise<StateSnapshot> {
  return {
    catalog: await readCatalog(client),
    roleExists: Boolean((await client.query("select exists (select 1 from pg_catalog.pg_roles where rolname = 'reporting_capture') as x")).rows[0]?.x),
    triggers: String((await client.query("select coalesce(string_agg(tgname, ',' order by tgname), '') as t from pg_catalog.pg_trigger where tgrelid = 'public.production_events'::regclass and not tgisinternal")).rows[0]?.t ?? ""),
    fixtures: String((await client.query(FIXTURE_SQL)).rows[0]?.s ?? ""),
  };
}

const errText = (e: unknown) => {
  const code = (e as { code?: string }).code;
  return code ? `error ${code}` : `error ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
};

async function runCaptureSteps(client: pg.Client, ids: { staff: string; manager: string }, claims: Record<string, string>, log: (l: string) => void): Promise<StepResult[]> {
  const out: StepResult[] = [];
  for (const s of CAPTURE_STEPS) {
    if (s.group === "begin") await client.query("savepoint rc_group");
    const t0 = performance.now();
    let result: string;
    await client.query("savepoint rc_step");
    try {
      for (const sql of s.setup ?? []) await client.query(sql);
      await become(client, s.actor, claims);
      const res = await client.query(s.sql, (s.params ?? []).map((k) => ids[k]));
      const row = res.rows[0] as Record<string, unknown> | undefined;
      result = row && "result" in row ? String(row.result ?? "") : String(res.rowCount ?? 0);
      await client.query("reset role");
      await client.query(s.isolated ? "rollback to savepoint rc_step" : "release savepoint rc_step");
    } catch (e) {
      result = errText(e);
      await client.query("rollback to savepoint rc_step");
      await client.query("reset role");
    }
    if (s.group === "end") await client.query("rollback to savepoint rc_group");
    const ms = Math.round(performance.now() - t0);
    log(`${s.id} ${s.actor} · ${s.what}: ${result}`);
    out.push({ id: s.id, actor: s.actor, what: s.what, result, ms });
  }
  return out;
}

async function measureOverhead(client: pg.Client, staff: string, claims: Record<string, string>, log: (l: string) => void): Promise<OverheadSample[]> {
  const samples: OverheadSample[] = [];
  for (let round = 0; round < OVERHEAD_ROUNDS; round++) {
    for (const capture of [false, true]) {
      await client.query("reset role");
      await client.query("update reporting_private.control set capture_enabled = $1 where singleton", [capture]);
      await become(client, "staff", claims);
      const t0 = performance.now();
      const r = await client.query(
        `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id)
         select 'au', 'rc-ov-' || $2::text || '-' || g, $1::uuid, 'framed', 'RC-OV', 'INKA-KAN0566-A4-FB', 1, 'line_verified', 'rc-station', 'overhead', '2026-11-11T03:00:00Z', null, null
           from generate_series(1, ${OVERHEAD_ROWS}) g`,
        [staff, `${round}-${capture ? "on" : "off"}`],
      );
      const ms = performance.now() - t0;
      await client.query("reset role");
      samples.push({ capture, rows: r.rowCount ?? 0, ms });
      log(`overhead round ${round + 1} capture ${capture ? "on" : "off"}: ${r.rowCount} rows in ${ms.toFixed(1)} ms`);
    }
  }
  return samples;
}

async function checksBody(a: pg.Client, mode: CaptureMode, report: CaptureReport, ids: { staff: string; manager: string }, claims: Record<string, string>, save: () => void, log: (l: string) => void): Promise<void> {
  await a.query("begin");
  if (mode === "rehearse-migration") {
    const body = splitSqlStatements(readFileSync(MIGRATION, "utf8"));
    if (body[0]?.label.trim().toUpperCase() !== "BEGIN" || body.at(-1)?.label.trim().toUpperCase() !== "COMMIT") throw new Error("0037 must be one BEGIN … COMMIT transaction");
    for (const st of body.slice(1, -1)) await a.query(st.text);
    log(`0037 applied inside the rolled-back transaction (${body.length - 2} statements)`);
  }
  report.catalog = await readCatalog(a);
  report.catalogProblems = report.catalog ? checkCatalog(report.catalog) : ["0037 objects are missing"];
  save();
  report.steps = await runCaptureSteps(a, ids, claims, log);
  report.stepProblems = checkSteps(report.steps);
  save();
  // Existing app write paths with capture enabled (staging site: trigger fires, no journal).
  await a.query("savepoint rc_wc");
  const steps = await runSteps(a, ids, claims, log);
  report.writeCompatProblems = checkSet({ set: "post", policyHash: report.catalog?.sourcePolicyHash ?? "", policyProblems: [], steps });
  report.writeCompatJournalRows = Number((await a.query("select count(*)::int as n from reporting_private.changes where coalesce(new_event_id, old_event_id) like 'wc-%'")).rows[0].n);
  if (report.writeCompatJournalRows !== 0) report.writeCompatProblems.push(`${report.writeCompatJournalRows} journal rows for the staging-site write-compat events`);
  await a.query("rollback to savepoint rc_wc");
  save();
  await a.query("savepoint rc_ov");
  report.overhead = overheadSummary(await measureOverhead(a, ids.staff, claims, log));
  await a.query("reset role");
  await a.query("rollback to savepoint rc_ov");
  await a.query("rollback");
}

async function main(): Promise<number> {
  const { mode, problems } = parseCaptureMode(process.argv.slice(2));
  if (!mode) {
    console.error(problems.join("\n"));
    return 2;
  }
  const revision = (() => {
    try {
      return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "unknown";
    }
  })();
  const report = newCaptureReport(mode, revision, new Date().toISOString());
  const out = runOutputName(mode, report.startedAt, randomBytes(4).toString("hex"));
  if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
  const save = () => {
    writeFileSync(`${out}.tmp`, captureMarkdown(report));
    renameSync(`${out}.tmp`, out);
  };
  const log = (l: string) => console.log(redactSecrets(l));
  if (!initialReport(save)) return 1;
  console.log(`report: ${out}`);

  let settings: Record<string, string>;
  let target: StagingTarget;
  let claims: Record<string, string>;
  try {
    settings = readSettings();
    assertStagingSupabaseUrl(settings.STAGING_SUPABASE_URL);
    target = stagingTarget(settings.STAGING_DB_URL);
    const logins = Object.fromEntries(SESSION_ROLES.map((r) => [r, { email: settings[`STAGING_${r.toUpperCase()}_EMAIL`], password: settings[`STAGING_${r.toUpperCase()}_PASSWORD`] }])) as Record<SessionRole, { email: string; password: string }>;
    claims = (await signInClaims(settings.STAGING_SUPABASE_URL, settings.STAGING_SUPABASE_ANON_KEY, logins)).text;
  } catch (e) {
    // Nothing was sent to the database; restoration is trivially unaffected but still unverified.
    report.errors.push(redactSecrets(e instanceof Error ? e.message : String(e)));
    report.finishedAt = new Date().toISOString();
    save();
    console.log(captureStatus(report));
    return 1;
  }
  const open = () => openGuarded(settings.STAGING_DB_URL, target);
  let before: StateSnapshot | null = null;

  await runCaptureLifecycle(report, {
    open,
    now: () => new Date().toISOString(),
    redact: redactSecrets,
    save,
    body: async (a) => {
      const s = await a.query("select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt, current_setting('idle_in_transaction_session_timeout') as it");
      report.settings = `statement_timeout=${s.rows[0].st}, lock_timeout=${s.rows[0].lt}, idle_in_transaction_session_timeout=${s.rows[0].it}`;
      const idRows = await a.query("select split_part(email, '@', 1) as k, id::text as id from auth.users where email in ('staff@inka-staging.test', 'manager@inka-staging.test')");
      const ids = Object.fromEntries(idRows.rows.map((r) => [r.k, r.id])) as { staff: string; manager: string };
      if (!ids.staff || !ids.manager) throw new Error("staff/manager test users not found");
      before = await snapshot(a);
      if (mode === "rehearse-migration" && before.catalog) throw new Error("0037 is already installed; use --check");
      if (mode === "check" && !before.catalog) throw new Error("0037 is not installed; use --rehearse-migration");
      if (mode === "concurrency") await concurrencyProbe(a, open, before, report, ids, claims, become, () => performance.now(), errText);
      else await checksBody(a, mode, report, ids, claims, save, log);
    },
    audit: async (fresh) => {
      if (!before) throw new Error("no starting snapshot was taken, so nothing can be compared");
      return compareSnapshots(before, await snapshot(fresh));
    },
  });
  finalReport(save, () => captureMarkdown(report), report.errors);
  const status = captureStatus(report);
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
