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

  it("03-query-evidence.sql is current with migration 0034 and the measured cases", async () => {
    const { buildQueryEvidenceSql } = await import("./generate-query-evidence");
    const onDisk = readFileSync("supabase/staging/item-counting/03-query-evidence.sql", "utf8").replace(/\r\n/g, "\n");
    expect(onDisk, "regenerate with: npx vite-node tests/staging/generate-query-evidence.ts --write").toBe(buildQueryEvidenceSql());
  });
});
