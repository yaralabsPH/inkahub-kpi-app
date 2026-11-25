import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { reportingDb } from "../reporting/pg/harness";

// scanner-wall-redesign: 0064 is one additive partial index whose predicate
// matches load_production_evidence_v2's main read (site, event types, time).
const SQL = readFileSync("supabase/migrations/0064_scanner_wall_count_window_index.sql", "utf8");
const code = SQL.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

describe("0064 scanner wall index", () => {
  it("creates only one non-unique index on production_events (location, created_at) for the counted event types", () => {
    const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements).toEqual([
      "CREATE INDEX IF NOT EXISTS production_events_count_window_idx ON public.production_events (location, created_at) " +
        "WHERE event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')",
    ]);
    expect(code).not.toMatch(/\b(DROP|ALTER|GRANT|REVOKE|POLICY|FUNCTION|UPDATE|DELETE|INSERT|UNIQUE)\b/i);
  });

  it("matches the evidence read's own filter", () => {
    const rpc = readFileSync("supabase/migrations/0035_load_production_evidence_v2.sql", "utf8");
    expect(rpc).toContain("pe.location = p_site");
    expect(rpc).toContain("pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')");
    expect(rpc).toContain("pe.created_at >= p_start_utc");
  });

  it("applies cleanly (and again) to the app's production_events and is usable for a site-day read", async () => {
    const db: PGlite = await reportingDb();
    await db.exec(SQL);
    await db.exec(SQL); // IF NOT EXISTS: re-runnable
    const idx = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'production_events_count_window_idx'",
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0].indexdef).toMatch(/ON public\.production_events USING btree \(location, created_at\) WHERE/);
    await db.exec("SET enable_seqscan = off");
    const plan = await db.query<{ "QUERY PLAN": string }>(
      "EXPLAIN SELECT id FROM public.production_events WHERE location = 'au' AND event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled') " +
        "AND created_at >= '2026-11-24T13:00:00Z' AND created_at < '2026-11-25T13:00:00Z'",
    );
    expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("production_events_count_window_idx");
    await db.close();
  });
});
