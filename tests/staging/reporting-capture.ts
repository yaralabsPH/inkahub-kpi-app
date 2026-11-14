/**
 * Task 12 staging runner: reporting capture, access and overhead checks.
 * STAGING ONLY (ybrzhrgfrnvtcwymjdrq). Every SQL phase is target-guarded
 * (URL ref + the staging-only `staging` location). Nothing is kept: each
 * phase runs in a transaction that is always ROLLED BACK.
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
 * Report: staging-results-reporting-capture-<mode>.md (git-ignored), ending
 * with exactly one STATUS line. Claims/credentials are never written.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import pg from "pg";
import { splitSqlStatements } from "./sqlStatements";
import { signInClaims, SESSION_ROLES, type SessionRole } from "./stagingSessions";
import { assertStagingSupabaseUrl, STAGING_REF } from "./measure-item-counting";
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
  checkConcurrency,
  checkSteps,
  overheadSummary,
  parseCaptureMode,
  REPORTING_SCHEMA,
  type CaptureReport,
  type OverheadSample,
  type ReportingCatalog,
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

function dbConfig(raw: string): pg.ClientConfig {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("STAGING_DB_URL is not a valid postgres:// URL.");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error("STAGING_DB_URL must start with postgresql://");
  if (!url.hostname.includes(STAGING_REF) && !decodeURIComponent(url.username).includes(STAGING_REF)) {
    throw new Error(`Refusing to run: the staging ref ${STAGING_REF} is not in the database host or user name.`);
  }
  for (const k of [...url.searchParams.keys()]) if (k.startsWith("ssl")) url.searchParams.delete(k);
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: false }, statement_timeout: 5 * 60_000, application_name: "reporting-capture-staging-check" };
}

/** Target guard before every phase: only the staging project has the `staging` location and its test users. */
async function guard(client: pg.Client): Promise<void> {
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

const errText = (e: unknown) => {
  const code = (e as { code?: string }).code;
  return code ? `error ${code}` : `error ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
};

async function runCaptureSteps(client: pg.Client, ids: { staff: string; manager: string }, claims: Record<string, string>, log: (l: string) => void): Promise<StepResult[]> {
  const out: StepResult[] = [];
  for (const s of CAPTURE_STEPS) {
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

async function main(): Promise<number> {
  const { mode, problems } = parseCaptureMode(process.argv.slice(2));
  if (!mode) {
    console.error(problems.join("\n"));
    return 2;
  }
  const out = `staging-results-reporting-capture-${mode}.md`;
  const report: CaptureReport = {
    mode,
    revision: (() => {
      try {
        return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return "unknown";
      }
    })(),
    startedAt: new Date().toISOString(),
    finishedAt: "",
    catalog: null,
    catalogProblems: [],
    steps: [],
    stepProblems: [],
    writeCompatProblems: [],
    writeCompatJournalRows: null,
    overhead: null,
    concurrency: null,
    concurrencyProblems: [],
    errors: [],
    restoration: null,
  };
  const save = () => {
    writeFileSync(`${out}.tmp`, captureMarkdown(report));
    renameSync(`${out}.tmp`, out);
  };
  const log = (l: string) => console.log(redactSecrets(l));
  save();
  const clients: pg.Client[] = [];
  try {
    const s = readSettings();
    assertStagingSupabaseUrl(s.STAGING_SUPABASE_URL);
    const cfg = dbConfig(s.STAGING_DB_URL);
    const logins = Object.fromEntries(SESSION_ROLES.map((r) => [r, { email: s[`STAGING_${r.toUpperCase()}_EMAIL`], password: s[`STAGING_${r.toUpperCase()}_PASSWORD`] }])) as Record<SessionRole, { email: string; password: string }>;
    const sessions = await signInClaims(s.STAGING_SUPABASE_URL, s.STAGING_SUPABASE_ANON_KEY, logins);
    const claims = sessions.text;
    const a = new pg.Client(cfg);
    clients.push(a);
    await a.connect();
    await guard(a);
    const idRows = await a.query("select split_part(email, '@', 1) as k, id::text as id from auth.users where email in ('staff@inka-staging.test', 'manager@inka-staging.test')");
    const ids = Object.fromEntries(idRows.rows.map((r) => [r.k, r.id])) as { staff: string; manager: string };
    if (!ids.staff || !ids.manager) throw new Error("staff/manager test users not found");
    const before = await readCatalog(a);

    if (mode === "concurrency") {
      if (!before) throw new Error("0037 is not installed; concurrency needs it installed and capture enabled");
      report.catalog = before;
      report.catalogProblems = checkCatalog(before);
      const b = new pg.Client(cfg);
      clients.push(b);
      await b.connect();
      await guard(b);
      await a.query("begin");
      await b.query("begin");
      try {
        await a.query("set local lock_timeout = '3s'");
        await b.query("set local lock_timeout = '3s'");
        await become(a, "staff", claims);
        const ins = (id: string) =>
          `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, cs_case_id, parent_event_id)
           values ('au', '${id}', $1::uuid, 'framed', 'RC-CC', 'INKA-KAN0566-A4-FB', 1, 'line_verified', 'rc-station', 'concurrency', '2026-11-11T04:00:00Z', null, null)`;
        const tA = performance.now();
        await a.query(ins("rc-cc-a"), [ids.staff]);
        await become(b, "staff", claims);
        const tB = performance.now();
        let secondError: string | null = null;
        let secondMs: number | null = null;
        try {
          await b.query(ins("rc-cc-b"), [ids.staff]);
          secondMs = Math.round(performance.now() - tB);
        } catch (e) {
          secondError = errText(e);
        }
        await b.query("reset role");
        const seen = secondError ? null : Number((await b.query("select count(*)::int as n from reporting_private.changes where new_event_id in ('rc-cc-a', 'rc-cc-b')")).rows[0].n);
        report.concurrency = { captureEnabledCommitted: !!before.control?.capture_enabled, firstHeldMs: Math.round(performance.now() - tA), secondMs, secondError, journalRowsSeenBySecond: seen };
        report.concurrencyProblems = checkConcurrency(report.concurrency);
        if (before.control?.capture_enabled && seen !== 1) report.concurrencyProblems.push(`second transaction sees ${seen} journal rows, expected exactly its own 1`);
      } finally {
        await b.query("rollback");
        await a.query("rollback");
      }
    } else {
      if (mode === "rehearse-migration" && before) throw new Error("0037 is already installed; use --check");
      if (mode === "check" && !before) throw new Error("0037 is not installed; use --rehearse-migration");
      await guard(a);
      await a.query("begin");
      try {
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
        try {
          const steps = await runSteps(a, ids, claims, log);
          report.writeCompatProblems = checkSet({ set: "post", policyHash: report.catalog?.sourcePolicyHash ?? "", policyProblems: [], steps });
          report.writeCompatJournalRows = Number((await a.query("select count(*)::int as n from reporting_private.changes where coalesce(new_event_id, old_event_id) like 'wc-%'")).rows[0].n);
          if (report.writeCompatJournalRows !== 0) report.writeCompatProblems.push(`${report.writeCompatJournalRows} journal rows for the staging-site write-compat events`);
        } finally {
          await a.query("rollback to savepoint rc_wc");
        }
        save();
        await a.query("savepoint rc_ov");
        try {
          report.overhead = overheadSummary(await measureOverhead(a, ids.staff, claims, log));
        } finally {
          await a.query("reset role");
          await a.query("rollback to savepoint rc_ov");
        }
      } finally {
        await a.query("rollback");
      }
    }
    // Fresh check after rollback: nothing kept.
    await guard(a);
    const after = await readCatalog(a);
    const left = Number((await a.query("select count(*)::int as n from public.production_events where id like 'rc-%'")).rows[0].n);
    const restoration =
      mode === "rehearse-migration"
        ? after === null && left === 0
          ? "0037 objects absent again and no rc- events kept"
          : `NOT RESTORED: schema ${after ? "still present" : "absent"}, ${left} rc- events`
        : left === 0 && JSON.stringify(after?.control) === JSON.stringify(before?.control) && JSON.stringify(after?.siteState) === JSON.stringify(before?.siteState)
          ? "control, site state unchanged and no rc- events kept"
          : `NOT RESTORED: ${left} rc- events; control ${JSON.stringify(after?.control)}`;
    report.restoration = restoration;
    if (restoration.startsWith("NOT RESTORED")) report.errors.push(restoration);
  } catch (e) {
    report.errors.push(redactSecrets(e instanceof Error ? e.message : String(e)));
  } finally {
    for (const c of clients) await c.end().catch(() => {});
    report.finishedAt = new Date().toISOString();
    save();
  }
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
