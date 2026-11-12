/**
 * `npm run staging:item-counting` — run the whole item-counting staging gate
 * in one go and write staging-results-item-counting.md.
 *
 * STAGING ONLY. Reads settings ONLY from .env.staging.local in the repo root
 * (git-ignored, never committed). Refuses to run unless the database URL
 * belongs to the staging project.
 *
 *   1. Runs supabase/staging/item-counting/01-sites.sql, 02-volume.sql and
 *      03-query-evidence.sql statement by statement, capturing every result.
 *   2. Times the real loader as the owner test user, then the manager.
 *   3. Checks that every expected result is present and non-empty.
 *   4. Writes the report, ending with "STATUS: COMPLETE" or
 *      "STATUS: FAILED – <reason>", and exits non-zero on failure.
 *
 * Progress: the console shows each step and a heartbeat every 10 s while a
 * load runs. The report is rewritten after every SQL statement, measured
 * case and heartbeat, so stopping the command (Ctrl+C) or killing it keeps
 * every finished result; an unfinished report always ends with FAILED.
 *
 * Credentials are never printed or written to the report.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import pg from "pg";
import { splitSqlStatements } from "./sqlStatements";
import {
  measureItemCounting,
  STAGING_REF,
  assertStagingSupabaseUrl,
  type MeasureProgress,
} from "./measure-item-counting";
import { SQL_FILES, type FileRun } from "./itemCountingEvidence";
import { buildReport, type GateState } from "./itemCountingReport";

const ENV_FILE = ".env.staging.local";
const REPORT_FILE = "staging-results-item-counting.md";
const REPORT_TMP = "staging-results-item-counting.tmp.md";
const SQL_DIR = "supabase/staging/item-counting/";

const REQUIRED = [
  "STAGING_DB_URL",
  "STAGING_SUPABASE_URL",
  "STAGING_SUPABASE_ANON_KEY",
  "STAGING_OWNER_EMAIL",
  "STAGING_OWNER_PASSWORD",
  "STAGING_MANAGER_EMAIL",
  "STAGING_MANAGER_PASSWORD",
] as const;
type Settings = Record<(typeof REQUIRED)[number], string> & { STAGING_RUNS?: string };

/** Settings come from the file only, never from the shell environment. */
function readSettings(): Settings {
  if (!existsSync(ENV_FILE)) throw new Error(`${ENV_FILE} not found in the repo root.`);
  const values: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    values[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  const missing = REQUIRED.filter((k) => !values[k]);
  if (missing.length) throw new Error(`${ENV_FILE} is missing: ${missing.join(", ")}`);
  return values as Settings;
}

/** The staging ref must be in the database host or user name, not just anywhere (e.g. the password). */
function stagingDbConfig(raw: string): pg.ClientConfig {
  if (!raw.includes(STAGING_REF)) throw new Error(`Refusing to run: STAGING_DB_URL does not contain ${STAGING_REF}.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("STAGING_DB_URL is not a valid postgres:// URL (URL-encode special characters in the password).");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error("STAGING_DB_URL must start with postgresql://");
  if (!url.hostname.includes(STAGING_REF) && !decodeURIComponent(url.username).includes(STAGING_REF)) {
    throw new Error(`Refusing to run: the staging ref ${STAGING_REF} is not in the database host or user name.`);
  }
  // TLS is set below; drop URL ssl options so they cannot override it.
  for (const k of [...url.searchParams.keys()]) if (k.startsWith("ssl")) url.searchParams.delete(k);
  return {
    connectionString: url.toString(),
    // Supabase's server certificate is not in Node's default CA store; the
    // connection is still encrypted, and the target is pinned by the ref check above.
    ssl: { rejectUnauthorized: false },
    statement_timeout: 15 * 60_000,
    application_name: "item-counting-staging-gate",
  };
}

function gitRevision(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

const state: GateState = {
  startedAt: new Date().toISOString(),
  revision: gitRevision(),
  runs: [],
  measures: { owner: undefined, manager: undefined },
  current: "reading settings",
  lastProgress: null,
  stopped: null,
  fatal: null,
  finishedAt: null,
};

/** Rewrite the report from the current state (write-then-rename, so a kill never leaves half a file). */
function saveReport(): ReturnType<typeof buildReport> {
  const report = buildReport(state);
  try {
    writeFileSync(REPORT_TMP, report.markdown, "utf8");
    renameSync(REPORT_TMP, REPORT_FILE);
  } catch (e) {
    console.error(`Could not write ${REPORT_FILE}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return report;
}

function mmss(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function progressLine(who: string, p: MeasureProgress): string {
  const where = `${who} · case ${p.caseIndex}/${p.caseCount} ${p.label}`;
  const target = p.serverCount === null ? "?" : p.serverCount.toLocaleString("en");
  switch (p.phase) {
    case "case-start":
      return `${where} · server counts ${target} in-window rows · ${p.runs} run(s)`;
    case "heartbeat":
      return `${where} · run ${p.run}/${p.runs} · ${mmss(p.elapsedMs)} · ${p.requests} requests · ${p.rowsRead.toLocaleString("en")} rows read (one pass ≈ ${target} + context; the loader reads twice)`;
    case "run-done":
      return `${where} · run ${p.run}/${p.runs} done in ${mmss(p.elapsedMs)} (${p.elapsedMs} ms) · ${p.requests} requests`;
    case "case-done":
      return `${where} · finished (median load ${p.elapsedMs} ms)`;
  }
}

async function runSqlFile(client: pg.Client, file: string, notices: string[]): Promise<FileRun> {
  const statements = splitSqlStatements(readFileSync(SQL_DIR + file, "utf8"));
  const run: FileRun = { file, statements: statements.length, results: [] };
  state.runs.push(run);
  console.log(`\n${file}: ${statements.length} statements`);
  for (const s of statements) {
    state.current = `${file} · statement ${s.index}/${statements.length} (line ${s.line})`;
    state.lastProgress = s.label.slice(0, 80);
    saveReport();
    notices.length = 0;
    const t0 = performance.now();
    try {
      const res = await client.query(s.text);
      const ms = Math.round(performance.now() - t0);
      run.results.push({
        index: s.index,
        line: s.line,
        label: s.label,
        command: res.command ?? null,
        rowCount: res.rowCount ?? null,
        fields: (res.fields ?? []).map((f) => f.name),
        rows: res.rows ?? [],
        notices: [...notices],
        ms,
        error: null,
      });
      console.log(`  ${s.index}. ${res.command ?? "?"} ${res.rowCount ?? ""} (${ms} ms) ${s.label.slice(0, 60)}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      run.results.push({
        index: s.index, line: s.line, label: s.label, command: null, rowCount: null,
        fields: [], rows: [], notices: [...notices], ms: Math.round(performance.now() - t0), error: message,
      });
      console.log(`  ${s.index}. ERROR ${message}`);
      try {
        await client.query("rollback");
      } catch {
        /* connection may already be gone */
      }
      break; // later statements depend on this one
    }
  }
  saveReport();
  return run;
}

async function main(): Promise<number> {
  try {
    const settings = readSettings();
    const dbConfig = stagingDbConfig(settings.STAGING_DB_URL);
    assertStagingSupabaseUrl(settings.STAGING_SUPABASE_URL);
    const repeat = Math.max(1, Number(settings.STAGING_RUNS ?? 3) || 3);

    state.current = "connecting to the staging database";
    saveReport();
    const client = new pg.Client(dbConfig);
    const notices: string[] = [];
    client.on("notice", (n) => notices.push(n.message ?? String(n)));
    await client.connect();
    try {
      for (const file of SQL_FILES) {
        const run = await runSqlFile(client, file, notices);
        if (run.results.some((r) => r.error) || run.results.length !== run.statements) break;
      }
    } finally {
      await client.end();
    }

    const sqlOk = state.runs.length === SQL_FILES.length && state.runs.every((r) => !r.results.some((x) => x.error));
    if (sqlOk) {
      for (const who of ["owner", "manager"] as const) {
        console.log(`\nMeasuring as ${who} (${repeat} run(s) per case)…`);
        state.current = `measuring as ${who} · signing in`;
        state.lastProgress = null;
        saveReport();
        try {
          state.measures[who] = await measureItemCounting({
            supabaseUrl: settings.STAGING_SUPABASE_URL,
            anonKey: settings.STAGING_SUPABASE_ANON_KEY,
            email: who === "owner" ? settings.STAGING_OWNER_EMAIL : settings.STAGING_MANAGER_EMAIL,
            password: who === "owner" ? settings.STAGING_OWNER_PASSWORD : settings.STAGING_MANAGER_PASSWORD,
            runs: repeat,
            onUpdate: (partial) => {
              state.measures[who] = partial;
              saveReport();
            },
            onProgress: (p) => {
              const line = progressLine(who, p);
              console.log(`  ${line}`);
              state.current = `measuring as ${who} · case ${p.caseIndex}/${p.caseCount} ${p.label}${p.run ? ` · run ${p.run}/${p.runs}` : ""}`;
              state.lastProgress = `${new Date().toISOString()} · ${line}`;
              saveReport();
            },
          });
        } catch (e) {
          // Keep any finished cases; record the failure for the rest.
          const message = e instanceof Error ? e.message : String(e);
          const partial = state.measures[who];
          if (partial && !("error" in partial) && partial.rows.length) state.fatal = `measurement as ${who} stopped: ${message}`;
          else state.measures[who] = { error: message };
        }
      }
    }
  } catch (e) {
    state.fatal = e instanceof Error ? e.message : String(e);
  }

  state.current = null;
  state.finishedAt = new Date().toISOString();
  const report = saveReport();
  console.log(`\nWrote ${REPORT_FILE}`);
  if (report.slow.length) console.log(`${report.slow.length} case(s) over latency target.`);
  console.log(report.status);
  return report.problems.length ? 1 : 0;
}

let stopping = false;
function stop(signal: string): void {
  if (stopping) process.exit(130);
  stopping = true;
  state.stopped = `${signal} received`;
  state.finishedAt = new Date().toISOString();
  const report = saveReport();
  console.log(`\nStopped (${signal}). Finished evidence is saved in ${REPORT_FILE}.`);
  console.log(report.status);
  process.exit(130);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGBREAK", () => stop("SIGBREAK"));

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);
