/** Shared offline fixtures for the Task 15 runtime harness tests (not a test file: importing it registers no suite). */
import type { PGlite } from "@electric-sql/pglite";
import { fullState, type Db } from "../../staging/reportingPublication";

export const W1 = "11111111-1111-4111-8111-111111111111";
export const pgDb = (db: PGlite): Db => ({ query: async (sql, params) => { const r = await db.query<Record<string, unknown>>(sql, params as unknown[]); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; } });
export async function seed(db: PGlite, n: number) {
  await db.query("insert into auth.users (id, email) values ($1, 'a@x') on conflict do nothing", [W1]);
  await db.query(
    `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at)
     select 'uk', 's' || lpad(g::text, 5, '0'), $1, 'framed', case when g % 20 = 0 then null else 'SR-' || (g % 40) end, case when g % 20 = 0 then null else 'INKA-KAN0566-A4-FB' end,
            case when g % 20 = 0 then null else 1 end, case when g % 20 = 0 then 'clock_in' else 'line_verified' end, 's', '', timestamptz '2026-03-01' + g * interval '1 minute'
       from generate_series(1, $2::int) g`, [W1, n]);
}
/**
 * Realistic shape for whole-site worker scenarios: an order's lines are
 * CLUSTERED in time (25 consecutive lines per order) with a clock-in per
 * cluster. `seed` spreads every order across the whole worker stream, which
 * makes each order owner's predecessor walk read the entire stream (one
 * children RPC per line) — fine for small parity tests, pathological for
 * repeated full rebuilds.
 */
export async function seedClustered(db: PGlite, n: number) {
  await db.query("insert into auth.users (id, email) values ($1, 'a@x') on conflict do nothing", [W1]);
  await db.query(
    `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at)
     select 'uk', 'k' || lpad(g::text, 5, '0'), $1, 'framed', case when g % 26 = 0 then null else 'CL-' || (g / 26) end, case when g % 26 = 0 then null else 'INKA-KAN0566-A4-FB' end,
            case when g % 26 = 0 then null else 1 end, case when g % 26 = 0 then 'clock_in' else 'line_verified' end, 's', '', timestamptz '2026-03-01' + g * interval '1 minute'
       from generate_series(1, $2::int) g`, [W1, n]);
}
const SURFACES = [["source:production_events", "select count(*)::text || ':' || md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' order by md5(to_jsonb(t)::text)), '')) as h from public.production_events t"]] as const;
export const smallState = (c: Db) => fullState(c, SURFACES);
