/**
 * `npm run staging:item-counting` — run the whole item-counting staging gate
 * in one go and write staging-results-item-counting.md.
 *
 * STAGING ONLY. Reads settings ONLY from .env.staging.local in the repo root
 * (git-ignored, never committed). Refuses to run unless the database URL
 * belongs to the staging project.
 *
 *   1. Runs supabase/staging/item-counting/01-sites.sql and 02-volume.sql
 *      (skipped with --measure-only), then 03-query-evidence.sql, statement
 *      by statement, capturing every result.
 *   2. Times the real one-call loader as the owner test user, then the
 *      manager, and records the manager's membership phase
 *      (denied-before / all-sites / denied-after) in
 *      staging-results-item-counting.phases.json.
 *   3. Checks that every expected result is present, correct and within
 *      target (see itemCountingEvidence.ts).
 *   4. Writes the report, ending with "STATUS: COMPLETE" or
 *      "STATUS: FAILED – <reason>", and exits non-zero on failure.
 *
 * Before any SQL it signs in the five test users (owner, manager, staff,
 * kiosk, cs) and passes each REAL session's claims to 03 as bound parameters
 * (never written anywhere), so RLS costs what it costs through the API.
 *
 * `--policy-parity=before|after [--arrangement=standard|owner-kiosk-without-uk]`
 * instead captures/compares what every role can see around migration 0036
 * (staging-results-item-counting.policy-parity.json + its own report); it
 * times nothing and records no manager phase. These are history now.
 *
 * `--policy-parity=cases` (Task 4 M6 amendment) collects the four acceptance
 * cases in one rolled-back transaction with the pre-0036 SELECT policies
 * restored inside a nested savepoint, then checks restoration with a fresh
 * statement. It must be run on its own (no other flags).
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
  STAGING_CUTOFF,
  STAGING_REF,
  assertStagingSupabaseUrl,
  type MeasureProgress,
} from "./measure-item-counting";
import {
  MANAGER_PHASES,
  SQL_FILES,
  type FileRun,
  type GateMode,
  type ManagerPhase,
  type PhaseRecord,
} from "./itemCountingEvidence";
import { runGate, type GateIO } from "./itemCountingGate";
import { buildReport, type GateState } from "./itemCountingReport";
import { claimsSetting } from "./generate-query-evidence";
import { signInClaims, SESSION_ROLES, type SessionRole } from "./stagingSessions";
import { randomUUID } from "node:crypto";
import { collectParitySnapshot } from "./policyParityRun";
import { casesModeArgProblems } from "./itemCountingParityCases";
import { runCasesMode } from "./caseParityMode";
import { collectWriteCompat } from "./writeCompatRun";
import { checkSet, compareSets, STEPS } from "./writeCompat";
import {
  ARRANGEMENTS,

  checkSnapshot,
  compareSnapshots,
  redactSecrets,
  type Arrangement,
  type ParityArtifact,
} from "./itemCountingPolicyParity";

const ENV_FILE = ".env.staging.local";
const REPORT_FILE = "staging-results-item-counting.md";
const REPORT_TMP = "staging-results-item-counting.tmp.md";
const SQL_DIR = "supabase/staging/item-counting/";
/** Manager membership phases recorded across runs (git-ignored, no secrets). */
const PHASES_FILE = "staging-results-item-counting.phases.json";
/** Policy parity snapshots/comparisons (git-ignored; synthetic row ids and catalog text only). */
const PARITY_FILE = "staging-results-item-counting.policy-parity.json";
const PARITY_REPORT = "staging-results-item-counting-policy-parity.md";
/** Write-path/digest compatibility report (`--write-compat`; git-ignored). */
const WRITE_COMPAT_REPORT = "staging-results-item-counting-write-compat.md";

const ARGS = process.argv.slice(2);
const WRITE_COMPAT = ARGS.includes("--write-compat");
const MODE: GateMode = ARGS.includes("--measure-only") ? "measure-only" : "full";
const PHASE_ARG = ARGS.find((a) => a.startsWith("--manager-phase="))?.split("=")[1] as ManagerPhase | undefined;
if (PHASE_ARG !== undefined && !MANAGER_PHASES.includes(PHASE_ARG)) {
  console.error(`--manager-phase must be one of ${MANAGER_PHASES.join(", ")}`);
  process.exit(2);
}
const PARITY_ARG = ARGS.find((a) => a.startsWith("--policy-parity="))?.split("=")[1] as "before" | "after" | "cases" | undefined;
if (PARITY_ARG !== undefined && PARITY_ARG !== "before" && PARITY_ARG !== "after" && PARITY_ARG !== "cases") {
  console.error("--policy-parity must be cases (or the historical before/after)");
  process.exit(2);
}
if (PARITY_ARG === "cases") {
  const refused = casesModeArgProblems(ARGS);
  if (refused.length) {
    for (const r of refused) console.error(r);
    process.exit(2);
  }
}
/** Cancels a running four-case collection; it still rolls back and records FAILED. */
const CASES_ABORT = new AbortController();
/** Parity and write-compat runs never touch the performance report. */
const ALTERNATE_MODE = !!(PARITY_ARG || WRITE_COMPAT);
const ARRANGEMENT = (ARGS.find((a) => a.startsWith("--arrangement="))?.split("=")[1] ?? "standard") as Arrangement;
if (!ARRANGEMENTS.includes(ARRANGEMENT)) {
  console.error(`--arrangement must be one of ${ARRANGEMENTS.join(", ")}`);
  process.exit(2);
}

function readParity(): ParityArtifact | null {
  try {
    const raw = JSON.parse(readFileSync(PARITY_FILE, "utf8")) as ParityArtifact;
    return Array.isArray(raw.snapshots) && Array.isArray(raw.comparisons) ? raw : null;
  } catch {
    return null;
  }
}

function readPhases(): PhaseRecord[] {
  try {
    const raw = JSON.parse(readFileSync(PHASES_FILE, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as PhaseRecord[]).filter((r) => MANAGER_PHASES.includes(r.phase)) : [];
  } catch {
    return [];
  }
}

const REQUIRED = [
  "STAGING_DB_URL",
  "STAGING_SUPABASE_URL",
  "STAGING_SUPABASE_ANON_KEY",
  "STAGING_OWNER_EMAIL",
  "STAGING_OWNER_PASSWORD",
  "STAGING_MANAGER_EMAIL",
  "STAGING_MANAGER_PASSWORD",
  "STAGING_STAFF_EMAIL",
  "STAGING_STAFF_PASSWORD",
  "STAGING_KIOSK_EMAIL",
  "STAGING_KIOSK_PASSWORD",
  "STAGING_CS_EMAIL",
  "STAGING_CS_PASSWORD",
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
  mode: MODE,
  runs: [],
  managerPhase: null,
  phaseRecords: readPhases(),
  claimsSources: {},
  parity: readParity(),
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
      return `${where} · run ${p.run}/${p.runs} · ${mmss(p.elapsedMs)} · ${p.stage} · ${(p.rawBytes / 1_048_576).toFixed(1)} MB received`;
    case "run-done":
      return `${where} · run ${p.run}/${p.runs} done in ${p.elapsedMs} ms · ${p.rows === null ? "?" : p.rows.toLocaleString("en")} rows validated`;
    case "case-done":
      return `${where} · finished (median paired total ${p.elapsedMs} ms)`;
  }
}

/** Real-session claims text per role (memory only), filled by main() before any SQL. */
let claimsText: Record<string, string> = {};

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
      if (file === "03-query-evidence.sql" && res.command === "BEGIN") {
        for (const [role, text] of Object.entries(claimsText)) {
          await client.query("select set_config($1, $2, true) is not null as ok", [claimsSetting(role), text]);
        }
        console.log(`     real-session claims supplied for ${Object.keys(claimsText).join(", ")} (values not shown)`);
      }
    } catch (e) {
      const message = redactSecrets(e instanceof Error ? e.message : String(e));
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
  if (PARITY_ARG === "cases") return runCaseParity();
  let settings: Settings | null = null;
  try {
    settings = readSettings();
    const dbConfig = stagingDbConfig(settings.STAGING_DB_URL);
    assertStagingSupabaseUrl(settings.STAGING_SUPABASE_URL);
    const s = settings;
    const repeat = Math.max(1, Number(s.STAGING_RUNS ?? 3) || 3);

    state.current = "signing in the five test users for real-session claims";
    // Alternate modes write only their own reports; the performance report is left as it was.
    if (!ALTERNATE_MODE) saveReport();
    const logins = Object.fromEntries(SESSION_ROLES.map((r) => {
      const up = r.toUpperCase() as Uppercase<SessionRole>;
      return [r, { email: s[`STAGING_${up}_EMAIL`], password: s[`STAGING_${up}_PASSWORD`] }];
    })) as Record<SessionRole, { email: string; password: string }>;
    const sessions = await signInClaims(s.STAGING_SUPABASE_URL, s.STAGING_SUPABASE_ANON_KEY, logins);
    claimsText = sessions.text;
    state.claimsSources = sessions.sources;
    for (const [role, c] of Object.entries(sessions.sources)) console.log(`  ${role}: real session claims ${c.bytes} bytes${c.problems.length ? ` · ${c.problems[0]}` : ""}`);

    if (PARITY_ARG === "before" || PARITY_ARG === "after") return await runParity(dbConfig, PARITY_ARG);
    if (WRITE_COMPAT) return await runWriteCompat(dbConfig);

    const io: GateIO = {
      async runSql(files) {
        state.current = "connecting to the staging database";
        saveReport();
        const client = new pg.Client(dbConfig);
        client.on("error", (e) => console.error(`  database connection error: ${redactSecrets(e.message)}`));
        const notices: string[] = [];
        client.on("notice", (n) => notices.push(n.message ?? String(n)));
        await client.connect();
        try {
          for (const file of files) {
            const run = await runSqlFile(client, file, notices);
            if (run.results.some((r) => r.error) || run.results.length !== run.statements) break;
          }
        } finally {
          await client.end();
        }
      },
      measure(who, onUpdate) {
        console.log(`\nMeasuring as ${who} (${repeat} run(s) per case)…`);
        return measureItemCounting({
          supabaseUrl: s.STAGING_SUPABASE_URL,
          anonKey: s.STAGING_SUPABASE_ANON_KEY,
          email: who === "owner" ? s.STAGING_OWNER_EMAIL : s.STAGING_MANAGER_EMAIL,
          password: who === "owner" ? s.STAGING_OWNER_PASSWORD : s.STAGING_MANAGER_PASSWORD,
          runs: repeat,
          asOfUtc: STAGING_CUTOFF,
          onUpdate,
          onProgress: (p) => {
            const line = progressLine(who, p);
            console.log(`  ${line}`);
            state.current = `measuring as ${who} · case ${p.caseIndex}/${p.caseCount} ${p.label}${p.run ? ` · run ${p.run}/${p.runs}` : ""}`;
            state.lastProgress = `${new Date().toISOString()} · ${line}`;
            saveReport();
          },
        });
      },
      save: () => void saveReport(),
      writePhases(records) {
        try {
          writeFileSync(PHASES_FILE, JSON.stringify(records, null, 2), "utf8");
        } catch (e) {
          console.error(`Could not write ${PHASES_FILE}: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      now: () => new Date().toISOString(),
      log: (line) => console.log(line),
    };
    await runGate(state, io, {
      mode: MODE,
      files: MODE === "full" ? SQL_FILES : (["03-query-evidence.sql"] as const),
      phaseArg: PHASE_ARG,
    });
  } catch (e) {
    if (ALTERNATE_MODE) {
      console.error(redactSecrets(e instanceof Error ? e.message : String(e)));
      console.log(`STATUS: FAILED – ${PARITY_ARG ? "policy parity" : "write compatibility"} run could not start`);
      return 1;
    }
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

/** `--policy-parity=before|after`: capture a snapshot; after compares with the latest before for the arrangement. */
async function runParity(dbConfig: pg.ClientConfig, mode: "before" | "after"): Promise<number> {
  const art: ParityArtifact = readParity() ?? { snapshots: [], comparisons: [] };
  const lines: string[] = [];
  const log = (l: string) => {
    console.log(`  ${l}`);
    lines.push(l);
  };
  console.log(`\nPolicy parity ${mode} · arrangement ${ARRANGEMENT}`);
  const client = new pg.Client(dbConfig);
  // A dropped connection becomes the failing query's error (reported), not an unhandled crash.
  client.on("error", (e) => console.error(`  database connection error: ${redactSecrets(e.message)}`));
  await client.connect();
  let problems: string[] = [];
  try {
    const snap = await collectParitySnapshot(client, { mode, arrangement: ARRANGEMENT, revision: state.revision, claimsText, log });
    for (const [role, c] of Object.entries(state.claimsSources)) {
      problems.push(...c.problems);
      if (snap.roles[role as SessionRole]?.claimsBytes !== c.bytes) problems.push(`${role}: SQL claims size differs from the session's`);
    }
    if (mode === "before") {
      problems.push(...checkSnapshot(snap));
      // Keep only the latest before-snapshot per arrangement (the baseline).
      art.snapshots = [...art.snapshots.filter((x) => !(x.mode === "before" && x.arrangement === ARRANGEMENT)), snap];
    } else {
      const before = [...art.snapshots].reverse().find((x) => x.mode === "before" && x.arrangement === ARRANGEMENT);
      if (!before) problems.push(`no before-snapshot for arrangement ${ARRANGEMENT}; run --policy-parity=before first (before applying 0036)`);
      else {
        const cmp = compareSnapshots(before, snap, new Date().toISOString());
        problems.push(...cmp.problems);
        // Claims problems count too: a comparison only passes when everything in this run passed.
        art.comparisons = [...art.comparisons.filter((c) => c.arrangement !== ARRANGEMENT), { ...cmp, problems: [...problems] }];
      }
    }
    writeFileSync(PARITY_FILE, JSON.stringify(art), "utf8");
  } catch (e) {
    problems.push(redactSecrets(e instanceof Error ? e.message : String(e)));
  } finally {
    await client.end().catch(() => {});
  }
  const status = problems.length ? `STATUS: FAILED – ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}` : "STATUS: COMPLETE";
  const md = [
    "# item-counting · policy parity (0036)", "",
    `- project: ${STAGING_REF} (staging) · code revision: ${state.revision}`,
    `- mode: ${mode} · arrangement: ${ARRANGEMENT} · finished: ${new Date().toISOString()}`,
    "- what each role can see, read as `authenticated` with RLS on, real-session claims and the catalog statement_timeout; values of claims are never recorded",
    "", "## Log", "", ...lines.map((l) => `- ${l}`),
    "", "## Real-session claims (sizes only)", "", ...Object.entries(state.claimsSources).map(([r, c]) => `- ${r}: ${c.bytes} bytes`),
    "", "## Checks", "", ...(problems.length ? problems.map((p) => `- MISSING/WRONG: ${p}`) : [mode === "before" ? "- Baseline complete (this alone does not satisfy Task 4)." : "- Identical visibility for every role and site; only the two SELECT policies changed."]),
    "", status, "",
  ].join("\n");
  writeFileSync(PARITY_REPORT, md, "utf8");
  console.log(`\nWrote ${PARITY_REPORT}`);
  console.log(status);
  return problems.length ? 1 : 0;
}

/** Write the parity artifact atomically (temp file, then rename). */
function writeParity(art: ParityArtifact): void {
  const tmp = `${PARITY_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(art), "utf8");
  renameSync(tmp, PARITY_FILE);
}

/**
 * `--policy-parity=cases`: the four M6 cases in one rolled-back transaction.
 * The new collection replaces any earlier one in the artifact, even when it
 * failed, so a failed run can never fall back to an older success.
 */
async function runCaseParity(): Promise<number> {
  console.log("\nPolicy parity · four cases (one transaction, rolled back; pre-0036 restored in a nested savepoint)");
  // The new attempt is marked pending in the artifact BEFORE settings, sign-in or connection can fail.
  let settings: Settings | null = null;
  const loadSettings = () => {
    if (!settings) {
      settings = readSettings();
      assertStagingSupabaseUrl(settings.STAGING_SUPABASE_URL);
    }
    return settings;
  };
  const { code, status } = await runCasesMode({
    readArtifact: readParity,
    writeArtifact: writeParity,
    writeReport: (md) => {
      const tmp = `${PARITY_REPORT}.tmp`;
      writeFileSync(tmp, md, "utf8");
      renameSync(tmp, PARITY_REPORT);
    },
    async signIn() {
      const s = loadSettings();
      const logins = Object.fromEntries(SESSION_ROLES.map((r) => {
        const up = r.toUpperCase() as Uppercase<SessionRole>;
        return [r, { email: s[`STAGING_${up}_EMAIL`], password: s[`STAGING_${up}_PASSWORD`] }];
      })) as Record<SessionRole, { email: string; password: string }>;
      const sessions = await signInClaims(s.STAGING_SUPABASE_URL, s.STAGING_SUPABASE_ANON_KEY, logins);
      for (const [role, c] of Object.entries(sessions.sources)) console.log(`  ${role}: real session claims ${c.bytes} bytes${c.problems.length ? ` · ${c.problems[0]}` : ""}`);
      return sessions;
    },
    async connect() {
      const client = new pg.Client(stagingDbConfig(loadSettings().STAGING_DB_URL));
      // A dropped connection becomes the failing query's error (reported), not an unhandled crash.
      client.on("error", (e) => console.error(`  database connection error: ${redactSecrets(e.message)}`));
      await client.connect();
      return client;
    },
    revision: state.revision,
    project: STAGING_REF,
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    log: (l) => console.log(`  ${l}`),
    signal: CASES_ABORT.signal,
    heartbeatMs: 10_000,
    redact: redactSecrets,
  });
  console.log(`\nWrote ${PARITY_REPORT}`);
  console.log(status);
  return code;
}

/** `--write-compat`: app write paths, digest and anon checks with 0036 and restored pre-0036 policies, all rolled back. */
async function runWriteCompat(dbConfig: pg.ClientConfig): Promise<number> {
  const lines: string[] = [];
  const log = (l: string) => {
    console.log(`  ${l}`);
    lines.push(l);
  };
  console.log("\nWrite-path compatibility (one transaction, rolled back)");
  const client = new pg.Client(dbConfig);
  client.on("error", (e) => console.error(`  database connection error: ${redactSecrets(e.message)}`));
  await client.connect();
  const problems: string[] = [];
  let table: string[] = [];
  try {
    for (const c of Object.values(state.claimsSources)) problems.push(...c.problems);
    const { post, pre } = await collectWriteCompat(client, { claimsText, parity: readParity(), log });
    problems.push(...checkSet(post), ...checkSet(pre), ...compareSets(post, pre));
    const preBy = new Map(pre.steps.map((x) => [x.id, x.result]));
    table = [
      "| Step | Actor | What | With 0036 | Pre-0036 policies |", "|---|---|---|---|---|",
      ...post.steps.map((x) => `| ${x.id} | ${x.actor} | ${STEPS.find((st) => st.id === x.id)?.what ?? ""} | ${x.result} | ${preBy.get(x.id) ?? "missing"} |`),
      "", `- policy hash with 0036: ${post.policyHash} · restored pre-0036: ${pre.policyHash}`,
    ];
    const after = await client.query("select count(*)::int as n from public.production_events where id like 'wc-%'");
    if (after.rows[0].n !== 0) problems.push(`${after.rows[0].n} write-compat rows remain after rollback`);
    else log("after rollback: no write-compat rows remain; stock, ledger and policies unchanged");
  } catch (e) {
    problems.push(redactSecrets(e instanceof Error ? e.message : String(e)));
  } finally {
    await client.end().catch(() => {});
  }
  const status = problems.length ? `STATUS: FAILED – ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}` : "STATUS: COMPLETE";
  const md = [
    "# item-counting · write-path and digest compatibility (0036)", "",
    `- project: ${STAGING_REF} (staging) · code revision: ${state.revision} · finished: ${new Date().toISOString()}`,
    "- the app's own capture, deduction, correction and Reports remove statements on `staging` fixtures, the digest's service-role read and anon rejection;",
    "  run with 0036 and again with the plan's pre-0036 rollback text, in one transaction that is rolled back (nothing is kept)",
    "", "## Results", "", ...table,
    "", "## Log", "", ...lines.map((l) => `- ${l}`),
    "", "## Checks", "", ...(problems.length ? problems.map((p) => `- MISSING/WRONG: ${p}`) : ["- Every step behaved as expected and identically with and without 0036."]),
    "", status, "",
  ].join("\n");
  writeFileSync(WRITE_COMPAT_REPORT, md, "utf8");
  console.log(`\nWrote ${WRITE_COMPAT_REPORT}`);
  console.log(status);
  return problems.length ? 1 : 0;
}

let stopping = false;
function stop(signal: string): void {
  if (stopping) process.exit(130);
  stopping = true;
  if (PARITY_ARG === "cases") {
    // Let the collector reach ROLLBACK and the fresh restoration check; it records FAILED (cancelled).
    // A second signal quits at once; the server then rolls the open transaction back.
    console.log(`\nStopping (${signal}): rolling back and checking restoration. Press again to quit immediately.`);
    CASES_ABORT.abort();
    return;
  }
  if (ALTERNATE_MODE) {
    console.log(`
Stopped (${signal}). STATUS: FAILED – stopped before completion`);
    process.exit(130);
  }
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
