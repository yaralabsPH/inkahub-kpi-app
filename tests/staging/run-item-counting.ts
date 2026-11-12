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
 * Credentials are never printed or written to the report.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import pg from "pg";
import { splitSqlStatements } from "./sqlStatements";
import { measureItemCounting, measureTable, STAGING_REF, assertStagingSupabaseUrl } from "./measure-item-counting";
import {
  checkItemCountingEvidence,
  overTarget,
  statusLine,
  SQL_FILES,
  type FileRun,
  type MeasureOutcome,
  type StatementResult,
} from "./itemCountingEvidence";

const ENV_FILE = ".env.staging.local";
const REPORT_FILE = "staging-results-item-counting.md";
const SQL_DIR = "supabase/staging/item-counting/";
const MAX_ROWS_SHOWN = 500;

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

function cell(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function resultMarkdown(r: StatementResult): string {
  const head = `#### Statement ${r.index} · line ${r.line} · \`${r.label.replace(/`/g, "'")}\`\n\n` +
    `command: ${r.command ?? "–"} · rows: ${r.rowCount ?? r.rows.length} · ${r.ms} ms` +
    (r.error ? `\n\n**ERROR:** ${r.error}` : "") +
    (r.notices.length ? `\n\nnotices: ${r.notices.join("; ")}` : "");
  if (r.command === "EXPLAIN") {
    return `${head}\n\n\`\`\`\n${r.rows.map((row) => String(Object.values(row)[0])).join("\n")}\n\`\`\``;
  }
  if (!r.rows.length || !r.fields.length) return head;
  const shown = r.rows.slice(0, MAX_ROWS_SHOWN);
  const table = [
    `| ${r.fields.join(" | ")} |`,
    `| ${r.fields.map(() => "---").join(" | ")} |`,
    ...shown.map((row) => `| ${r.fields.map((f) => cell(row[f])).join(" | ")} |`),
  ].join("\n");
  const more = r.rows.length > shown.length ? `\n\n(${r.rows.length - shown.length} more rows not shown)` : "";
  return `${head}\n\n${table}${more}`;
}

async function runSqlFile(client: pg.Client, file: string, notices: string[]): Promise<FileRun> {
  const statements = splitSqlStatements(readFileSync(SQL_DIR + file, "utf8"));
  const run: FileRun = { file, statements: statements.length, results: [] };
  console.log(`\n${file}: ${statements.length} statements`);
  for (const s of statements) {
    notices.length = 0;
    const t0 = performance.now();
    try {
      const res = await client.query(s.text);
      run.results.push({
        index: s.index,
        line: s.line,
        label: s.label,
        command: res.command ?? null,
        rowCount: res.rowCount ?? null,
        fields: (res.fields ?? []).map((f) => f.name),
        rows: res.rows ?? [],
        notices: [...notices],
        ms: Math.round(performance.now() - t0),
        error: null,
      });
      console.log(`  ${s.index}. ${res.command ?? "?"} ${res.rowCount ?? ""} (${Math.round(performance.now() - t0)} ms) ${s.label.slice(0, 60)}`);
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
  return run;
}

function gitRevision(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const runs: FileRun[] = [];
  const measures: { owner: MeasureOutcome; manager: MeasureOutcome } = { owner: undefined, manager: undefined };
  let fatal: string | null = null;

  try {
    const settings = readSettings();
    const dbConfig = stagingDbConfig(settings.STAGING_DB_URL);
    assertStagingSupabaseUrl(settings.STAGING_SUPABASE_URL);
    const repeat = Math.max(1, Number(settings.STAGING_RUNS ?? 3) || 3);

    const client = new pg.Client(dbConfig);
    const notices: string[] = [];
    client.on("notice", (n) => notices.push(n.message ?? String(n)));
    await client.connect();
    try {
      for (const file of SQL_FILES) {
        const run = await runSqlFile(client, file, notices);
        runs.push(run);
        if (run.results.some((r) => r.error) || run.results.length !== run.statements) break;
      }
    } finally {
      await client.end();
    }

    const sqlOk = runs.length === SQL_FILES.length && runs.every((r) => !r.results.some((x) => x.error));
    if (sqlOk) {
      for (const who of ["owner", "manager"] as const) {
        console.log(`\nMeasuring as ${who}…`);
        try {
          measures[who] = await measureItemCounting({
            supabaseUrl: settings.STAGING_SUPABASE_URL,
            anonKey: settings.STAGING_SUPABASE_ANON_KEY,
            email: who === "owner" ? settings.STAGING_OWNER_EMAIL : settings.STAGING_MANAGER_EMAIL,
            password: who === "owner" ? settings.STAGING_OWNER_PASSWORD : settings.STAGING_MANAGER_PASSWORD,
            runs: repeat,
          });
        } catch (e) {
          measures[who] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
    }
  } catch (e) {
    fatal = e instanceof Error ? e.message : String(e);
  }

  const problems = fatal ? [fatal, ...checkItemCountingEvidence(runs, measures)] : checkItemCountingEvidence(runs, measures);
  const slow = overTarget(measures);
  const status = statusLine(problems);

  const parts: string[] = [
    "# item-counting · staging gate results",
    "",
    `- project: ${STAGING_REF} (staging)`,
    `- code revision: ${gitRevision()}`,
    `- started: ${startedAt} · finished: ${new Date().toISOString()}`,
    "- generated by `npm run staging:item-counting`; credentials are not recorded",
  ];
  for (const run of runs) {
    parts.push("", `## ${run.file} (${run.results.length} of ${run.statements} statements)`, "");
    for (const r of run.results) parts.push(resultMarkdown(r), "");
  }
  for (const who of ["owner", "manager"] as const) {
    const m = measures[who];
    parts.push("", `## Loader measurements as ${who}`, "");
    if (!m) parts.push("Not run.");
    else if ("error" in m) parts.push(`**FAILED:** ${m.error}`);
    else parts.push(measureTable(m));
  }
  parts.push("", "## Checks", "");
  parts.push(problems.length ? problems.map((p) => `- MISSING/WRONG: ${p}`).join("\n") : "- Every expected result is present and non-empty.");
  parts.push("", "## Latency targets (one day ≤ 2,000 ms, three months ≤ 10,000 ms)", "");
  parts.push(
    problems.length
      ? "- Not assessed: evidence is incomplete."
      : slow.length
        ? `${slow.map((s) => `- OVER TARGET: ${s}`).join("\n")}\n\nEvidence is complete but targets were missed: the coder records this as an Open question in the plan and does not start Task 5.`
        : "- All cases within target.",
  );
  parts.push("", status, "");
  writeFileSync(REPORT_FILE, parts.join("\n"), "utf8");

  console.log(`\nWrote ${REPORT_FILE}`);
  if (slow.length && !problems.length) console.log(`${slow.length} case(s) over latency target.`);
  console.log(status);
  return problems.length ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);
