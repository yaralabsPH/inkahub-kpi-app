-- 0022_production_verify.sql
--
-- Per-line verification + CS-Case-linked replacement work for the
-- Production page. Three changes:
--
--   1. event_type gains 'line_verified' - logged when a worker ticks
--      a line in their department's verification step.
--   2. cs_case_id column - non-null on events triggered by a CS Case
--      replacement workflow. Null for first-time work.
--   3. parent_event_id column - chains replacement work back to the
--      event it replaces. Null for original work.
--
-- Plus indexes for the kiosk's hot lookup paths.
--
-- All additions; nothing destructive. Existing rows continue to work.
-- Safe to re-run.

BEGIN;

-- ============================================================
-- Extend event_type CHECK to include 'line_verified'.
-- Drop + recreate is the standard Postgres pattern for CHECK changes.
-- ============================================================
ALTER TABLE production_events
  DROP CONSTRAINT IF EXISTS production_events_event_type_check;

ALTER TABLE production_events
  ADD CONSTRAINT production_events_event_type_check
  CHECK (event_type IN (
    'started',
    'completed',
    'cancelled',
    'dispatched',
    'line_verified'
  ));

-- ============================================================
-- CS Case link. NULL for normal first-time work; populated for
-- verification / replacement events triggered by an open CS Case.
-- ============================================================
ALTER TABLE production_events
  ADD COLUMN IF NOT EXISTS cs_case_id TEXT;

COMMENT ON COLUMN production_events.cs_case_id IS
  'When a CS Case drives the work (replacement / claim), every event for that work carries the case id. Null otherwise.';

-- Partial index - only events that have a case id, keeps the index tiny.
CREATE INDEX IF NOT EXISTS production_events_cs_case_idx
  ON production_events (location, cs_case_id)
  WHERE cs_case_id IS NOT NULL;

-- ============================================================
-- Replacement chain. parent_event_id points to the event this one
-- replaces (e.g. a reprint of a damaged item). Null for original work.
-- Chains can be N-deep (replacement of a replacement of a...).
-- ============================================================
ALTER TABLE production_events
  ADD COLUMN IF NOT EXISTS parent_event_id TEXT;

COMMENT ON COLUMN production_events.parent_event_id IS
  'Self-reference: the event this one replaces (reprint / customer-swap / etc). Null for original work. Walk the chain to reconstruct full rework history.';

CREATE INDEX IF NOT EXISTS production_events_parent_event_idx
  ON production_events (location, parent_event_id)
  WHERE parent_event_id IS NOT NULL;

-- ============================================================
-- Fast lookup: kiosk scan handler asks
--   "all events for (location, order_number, line_sku)"
-- to compute the per-line verification state. The existing
-- production_events_order_idx is on (location, order_number) only.
-- Adding line_sku gets us straight to the right row.
-- ============================================================
CREATE INDEX IF NOT EXISTS production_events_order_line_idx
  ON production_events (location, order_number, line_sku);

-- ============================================================
-- Tell PostgREST to pick up the new columns immediately so the
-- TypeScript client sees them without a manual restart.
-- ============================================================
NOTIFY pgrst, 'reload schema';

COMMIT;