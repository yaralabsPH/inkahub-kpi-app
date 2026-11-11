-- 0029_clock_in_out_events.sql
--
-- Add 'clock_in' and 'clock_out' to the allowed production_events.event_type
-- values so workers can explicitly sign in and out at the production kiosk.
-- The shift window for cost/labour reporting becomes clock_in.created_at ->
-- clock_out.created_at (or last event timestamp + 2hr-inactivity rule if
-- the worker forgot to sign out).
--
-- Safe to re-run.

BEGIN;

ALTER TABLE production_events
  DROP CONSTRAINT IF EXISTS production_events_event_type_check;

ALTER TABLE production_events
  ADD CONSTRAINT production_events_event_type_check
  CHECK (event_type IN (
    'started',
    'completed',
    'cancelled',
    'dispatched',
    'line_verified',
    'clock_in',
    'clock_out'
  ));

NOTIFY pgrst, 'reload schema';

COMMIT;