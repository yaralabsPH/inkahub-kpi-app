/**
 * T14S3 guard, checked against REAL PostgreSQL (PGlite): for every candidate
 * EXPLAIN form, whenever PostgreSQL actually executes the explained DELETE,
 * executesExplain must say so (and the guard must refuse it).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { executesExplain } from "../../staging/reportingDependencyRehearsal";

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec("create table x (a int, \"select\" int); insert into x values (1, 1)");
});
afterAll(async () => db?.close());

const FORMS = [
  "EXPLAIN /* select */ ANALYZE DELETE FROM x",
  "EXPLAIN -- select\nANALYZE DELETE FROM x",
  "EXPLAIN /* a /* nested select */ b */ ANALYZE DELETE FROM x",
  "EXPLAIN /**/ANALYZE/**/DELETE FROM x",
  "EXPLAIN (/* select */ ANALYZE) DELETE FROM x",
  "EXPLAIN (FORMAT JSON, -- with\n ANALYZE) DELETE FROM x",
  "EXPLAIN (\"analyze\") DELETE FROM x",
  "EXPLAIN (ANALYZE true, VERBOSE) DELETE FROM x",
  "EXPLAIN ANALYSE VERBOSE DELETE FROM x",
  "/* lead */ EXPLAIN /* select */ ANALYZE DELETE FROM x",
  "EXPLAIN (ANALYZE false) DELETE FROM x",
  "EXPLAIN DELETE FROM x",
  "EXPLAIN (VERBOSE) DELETE FROM x",
  "EXPLAIN /* ANALYZE */ DELETE FROM x",
  "EXPLAIN -- ANALYZE\n DELETE FROM x",
  "EXPLAIN (VERBOSE) DELETE FROM x WHERE \"select\" = 1 /* analyze */",
];

describe("executesExplain agrees with PostgreSQL about execution", () => {
  for (const sql of FORMS) {
    it(JSON.stringify(sql), async () => {
      await db.exec("begin");
      let executed = false;
      try {
        await db.exec(sql);
        executed = (await db.query<{ n: number }>("select count(*)::int as n from x")).rows[0].n === 0;
      } finally {
        await db.exec("rollback");
      }
      if (executed) expect(executesExplain(sql)).toBe(true); // never a false negative
      // conservatively denied but not executing: only the explicit ANALYZE false form
      if (!executed && executesExplain(sql)) expect(sql).toMatch(/ANALYZE false/);
    });
  }
  it("the probe is real: some forms execute and some do not", async () => {
    let yes = 0, no = 0;
    for (const sql of FORMS) {
      await db.exec("begin");
      await db.exec(sql);
      ((await db.query<{ n: number }>("select count(*)::int as n from x")).rows[0].n === 0 ? yes++ : no++);
      await db.exec("rollback");
    }
    expect(yes).toBeGreaterThanOrEqual(9);
    expect(no).toBeGreaterThanOrEqual(5);
  });
});
