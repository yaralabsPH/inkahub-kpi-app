/**
 * Offline PostgreSQL (PGlite, dev-only) for reporting SQL tests.
 *
 * Bootstraps only what the reporting migrations reference outside
 * reporting_private — the Supabase roles (anon, authenticated,
 * service_role), auth.users, public.locations and public.production_events
 * as of migration 0030 (columns, checks, primary key, RLS on) — then applies
 * the REAL migration files 0037+ unchanged, in number order. Nothing here
 * reaches a network database. PGlite is a single in-process PostgreSQL; it
 * proves SQL semantics and parity, not staging performance, roles in a
 * hosted cluster, or PostgREST behaviour.
 */
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

export const BOOTSTRAP = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE public.locations (key text PRIMARY KEY);
INSERT INTO public.locations (key) VALUES ('au'), ('uk'), ('us'), ('staging');
CREATE TABLE public.production_events (
  location        text        NOT NULL REFERENCES public.locations(key) ON DELETE RESTRICT,
  id              text        NOT NULL,
  staff_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  department      text        NOT NULL CHECK (department IN ('a0_framed','framed','unframed','dispatch')),
  order_number    text,
  line_sku        text,
  line_quantity   integer     CHECK (line_quantity IS NULL OR line_quantity > 0),
  event_type      text        NOT NULL CHECK (event_type IN ('started','completed','cancelled','dispatched','line_verified','clock_in','clock_out')),
  station_id      text,
  note            text        NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  cs_case_id      text,
  parent_event_id text,
  PRIMARY KEY (location, id),
  CONSTRAINT production_events_order_number_check CHECK ((event_type IN ('clock_in','clock_out') AND order_number IS NULL) OR (event_type NOT IN ('clock_in','clock_out') AND order_number IS NOT NULL AND length(order_number) > 0))
);
ALTER TABLE public.production_events ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON public.production_events TO service_role;
`;

export function reportingMigrations(from = "0037"): Array<{ name: string; sql: string }> {
  return readdirSync("supabase/migrations")
    .filter((n) => /^\d{4}_.*\.sql$/.test(n) && n >= from)
    .sort()
    .map((name) => ({ name, sql: readFileSync(`supabase/migrations/${name}`, "utf8") }));
}

/** A fresh database with the bootstrap and every reporting migration from 0037 applied. */
export async function reportingDb(opts: { through?: string } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  for (const m of reportingMigrations()) {
    if (opts.through && m.name > opts.through) break;
    try {
      await db.exec(m.sql);
    } catch (e) {
      throw new Error(`${m.name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return db;
}
