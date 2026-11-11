-- ============================================================================
-- INKA ARTHOUSE — schema-level grants for the authenticated role
-- ============================================================================
-- Postgres permissions are layered:
--   - RLS policies control WHICH ROWS a role can see (we set those up in
--     0001_init.sql).
--   - GRANTs control whether the role can open the table AT ALL.
--
-- Supabase's "Automatically expose new tables" project option is supposed
-- to handle the GRANTs for us, but it doesn't always fire for tables
-- created via SQL migrations (only for ones created via the Table Editor
-- UI). So we do it explicitly here. Idempotent — safe to re-run.
-- ============================================================================

GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- Default privileges for any FUTURE tables / functions in the public
-- schema. Means we never have to remember to re-run these grants for
-- migrations that add new tables.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO authenticated;
