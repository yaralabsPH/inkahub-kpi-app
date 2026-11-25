import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./sqlStatements";

const texts = (sql: string) => splitSqlStatements(sql).map((s) => s.text);

describe("splitSqlStatements", () => {
  it("splits on top-level semicolons and drops comment-only tails", () => {
    expect(texts("select 1;\nselect 2;\n-- done\n")).toEqual(["select 1", "select 2"]);
  });

  it("ignores semicolons in strings, identifiers and comments", () => {
    const sql = `select 'a;b', 'it''s;' as "x;y"; -- c;d\n/* e; /* nested; */ f; */ select 3;`;
    expect(texts(sql)).toEqual([`select 'a;b', 'it''s;' as "x;y"`, "-- c;d\n/* e; /* nested; */ f; */ select 3"]);
  });

  it("keeps DO $$ ... $$ and tagged dollar bodies whole", () => {
    const sql = "do $$ begin raise notice 'x'; perform 1; end $$;\nselect $q$a;b$q$;";
    expect(texts(sql)).toEqual(["do $$ begin raise notice 'x'; perform 1; end $$", "select $q$a;b$q$"]);
  });

  it("handles E'' escapes and does not treat $1 parameters as dollar quotes", () => {
    expect(texts("select E'a\\';b';select $1;")).toEqual(["select E'a\\';b'", "select $1"]);
  });

  it("reports the line and label of the first code", () => {
    const [a, b] = splitSqlStatements("-- header\n\nbegin;\n\n-- note\ncommit;");
    expect([a.line, a.label, b.line, b.label]).toEqual([3, "begin", 6, "commit"]);
  });

  it("rejects unterminated input instead of guessing", () => {
    expect(() => splitSqlStatements("select 'oops;")).toThrow(/Unterminated/);
    expect(() => splitSqlStatements("do $$ begin")).toThrow(/Unterminated/);
  });

  it("splits the item-counting staging scripts into the expected statements", () => {
    const dir = "supabase/staging/item-counting/";
    const labels = (f: string) => splitSqlStatements(readFileSync(dir + f, "utf8")).map((s) => s.label.split(/\s+/)[0].toLowerCase());
    expect(labels("01-sites.sql")).toEqual(["begin", "do", "insert", "insert", "insert", "insert", "insert", "insert", "select", "commit"]);
    expect(labels("02-volume.sql")).toEqual(["begin", "do", "insert", "insert", "select", "commit"]);
    const q = splitSqlStatements(readFileSync(dir + "03-query-evidence.sql", "utf8"));
    const first = q.map((s) => s.label.split(/\s+/)[0].toLowerCase());
    expect(first[0]).toBe("begin");
    expect(first.at(-1)).toBe("rollback");
    expect(first).not.toContain("commit");
    // 2 roles x 6 scopes x (3 call runs + 1 body) labelled plans.
    const gates = q.filter((s) => /^explain \(analyze, buffers\) select 'gate:(call|body):\w+:[\w-]+:\d+' as gate,/.test(s.label));
    expect(gates).toHaveLength(48);
    expect(new Set(gates.map((s) => s.label.split("gate:")[1])).size).toBe(48);
  });

  it("03 changes nothing and applies the API role's own time limit after every role switch", () => {
    const sql = readFileSync("supabase/staging/item-counting/03-query-evidence.sql", "utf8").replace(/\r\n/g, "\n");
    const stmts = splitSqlStatements(sql);
    expect(stmts.at(-1)!.label).toBe("rollback");
    expect(sql).not.toMatch(/\banalyze\s+public\./i);
    expect(sql).not.toMatch(/\balter\s+(role|database|system|table|function)\b/i);
    expect(sql).not.toMatch(/\b(insert|update|delete)\s+(into\s+)?public\./i);
    // Never a hard-coded timeout: only the catalog-driven SET LOCAL inside the DO block.
    expect(sql).not.toMatch(/set\s+(local\s+)?statement_timeout\s*(=|to)\s*'?\d/i);
    const labels = stmts.map((s) => s.label.toLowerCase());
    const roleSwitches = labels.flatMap((l, i) => (l === "set local role authenticated" ? [i] : []));
    expect(roleSwitches).toHaveLength(4);
    for (const i of roleSwitches) {
      expect(stmts[i + 1].text).toMatch(/where r\.rolname = 'authenticated' and c like 'statement_timeout=%'/);
      expect(stmts[i + 1].text).toMatch(/execute format\('set local statement_timeout = %L'/);
      expect(stmts[i + 2].text).toMatch(/as effective_timeout_ms/);
    }
    // 36 real PostgREST-shape statements, each converting the whole wrapped body to text.
    const text = stmts.filter((s) => /AS gate,\s+octet_length\(\(coalesce\(json_agg\(_postgrest_t\.pgrst_scalar\) -> 0, 'null'::json\)\)::text\)/.test(s.text));
    expect(text).toHaveLength(36);
    for (const s of text) expect(s.text).toMatch(/json_to_record\(pgrst_payload\.json_data\)/);
  });

  it("03 switches identity only with the runner's real-session claims (no minimal-claims fallback)", () => {
    const sql = readFileSync("supabase/staging/item-counting/03-query-evidence.sql", "utf8").replace(/\r\n/g, "\n");
    expect(sql).not.toMatch(/json_build_object\(\s*'sub'/);
    const setters = [...sql.matchAll(/set_config\('request\.jwt\.claims', current_setting\('inka_staging\.jwt_(\w+)'\), true\)/g)].map((m) => m[1]);
    expect(setters).toEqual(["owner", "manager", "staff", "owner"]);
    // current_setting without missing_ok: standalone SQL without the runner's claims fails instead of reading nothing.
    expect(sql).not.toMatch(/current_setting\('inka_staging\.jwt_\w+', true\)/);
    expect((sql.match(/as claims_for,/g) ?? []).length).toBe(4);
    expect((sql.match(/as policy_catalog,/g) ?? []).length).toBe(1);
  });

  it("03-query-evidence.sql is current with migrations 0035 and the measured cases", async () => {
    const { buildQueryEvidenceSql } = await import("./generate-query-evidence");
    const onDisk = readFileSync("supabase/staging/item-counting/03-query-evidence.sql", "utf8").replace(/\r\n/g, "\n");
    expect(onDisk, "regenerate with: npx vite-node tests/staging/generate-query-evidence.ts --write").toBe(buildQueryEvidenceSql());
  });
});
