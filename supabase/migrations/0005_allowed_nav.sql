-- ============================================================================
-- INKA ARTHOUSE — per-user sidebar access (allowed_nav)
-- ============================================================================
-- Adds a `allowed_nav` column to `profiles` that lets the owner restrict
-- which sidebar pages each user can see. The column holds an array of
-- NavKey strings (e.g. ['dashboard', 'movements']) or NULL.
--
-- Semantics:
--   - NULL       → use role defaults (owner/manager see everything,
--                  staff see only dashboard).
--   - []         → no pages beyond the always-allowed dashboard.
--   - ['a','b']  → exactly those pages, plus dashboard (auto-included).
--
-- Stored as TEXT[] rather than JSONB because:
--   - the values are simple strings,
--   - we want to query "users who have access to X" easily,
--   - TEXT[] is indexable with GIN if needed later.
-- ============================================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS allowed_nav TEXT[] DEFAULT NULL;

-- Optional comment so anyone exploring the schema understands the semantics.
COMMENT ON COLUMN profiles.allowed_nav IS
  'Sidebar pages this user can access. NULL = use role default (owner/manager see all, staff see dashboard only). Empty array = dashboard only. Stored as NavKey strings — see src/lib/domain/schemas.ts NAV_KEYS for the source of truth.';
