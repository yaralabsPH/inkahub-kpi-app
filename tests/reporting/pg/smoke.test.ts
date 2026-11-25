import { describe, expect, it } from "vitest";
import { reportingDb } from "./harness";

describe("PGlite harness", () => {
  it("applies 0037+ unchanged", async () => {
    const db = await reportingDb();
    const r = await db.query<{ n: number }>("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','reporting_private') and p.proname like '%reporting%'");
    expect(r.rows[0].n).toBeGreaterThan(20);
    await db.close();
  }, 120_000);
});
