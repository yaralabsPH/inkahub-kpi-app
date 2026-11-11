-- 0030_clock_events_no_order.sql
--
-- clock_in / clock_out events have no order context. Relax
-- production_events.order_number so:
--   - clock_in / clock_out rows can leave it NULL
--   - all other event types still require a non-empty order_number
--
-- Safe to re-run.

BEGIN;

-- 1. Drop the strict NOT NULL + length check.
ALTER TABLE production_events
  ALTER COLUMN order_number DROP NOT NULL;

ALTER TABLE production_events
  DROP CONSTRAINT IF EXISTS production_events_order_number_check;

-- 2. Re-add as a conditional: required + non-empty for order events,
--    must be NULL for clock events (sanity guard).
ALTER TABLE production_events
  ADD CONSTRAINT production_events_order_number_check
  CHECK (
    (event_type IN ('clock_in', 'clock_out') AND order_number IS NULL)
    OR
    (event_type NOT IN ('clock_in', 'clock_out')
     AND order_number IS NOT NULL
     AND length(order_number) > 0)
  );

NOTIFY pgrst, 'reload schema';

COMMIT;