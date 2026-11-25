-- ============================================================================
-- 0064_scanner_wall_count_window_index.sql
-- ============================================================================
-- scanner-wall-redesign: one additive, non-unique, partial index so the
-- existing load_production_evidence_v2 read for "today at this site" (the
-- scanner wall's per-person totals) uses an index on site + time instead of
-- scanning the site's whole event history as it grows.
--
-- Existing indexes cover person/time and department/time, not site/time.
-- The predicate matches the event types the evidence read counts.
--
-- What changes: one index. No table, column, function, policy, grant or
-- data change. Old app code keeps working unchanged (expand-only).
--
-- Lock: plain CREATE INDEX blocks writes to production_events while it
-- builds. Apply at a quiet time (no scanning/kiosk work), on staging first.
-- If the table is large, CJ may instead run the same statement by hand as
-- CREATE INDEX CONCURRENTLY (outside a transaction) and then record this
-- migration as applied; the resulting index is identical.
--
-- Staging checks: EXPLAIN the wall's evidence read for one AU production day
-- as the kiosk role and confirm it uses production_events_count_window_idx;
-- confirm Classic Production and Reports still load.
--
-- Rollback: DROP INDEX IF EXISTS public.production_events_count_window_idx;
-- (safe at any time; reads become slower, nothing else changes).
-- ============================================================================

CREATE INDEX IF NOT EXISTS production_events_count_window_idx
  ON public.production_events (location, created_at)
  WHERE event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled');
