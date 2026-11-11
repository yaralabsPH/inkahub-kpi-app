-- 0013_production_events_kiosk_policy.sql
--
-- The /production page runs as a kiosk: a logged-in manager (or other
-- privileged user) attends to the tablet, and individual workers scan
-- lanyards to identify themselves. Events get attributed to the SCANNED
-- staff_id, not the logged-in auth.uid(). The original 0012 INSERT
-- policy required staff_id = auth.uid(), which would block this flow
-- entirely.
--
-- Relax the policy so:
--   - A user can still insert their own events (staff_id = auth.uid()),
--     for the case where workers eventually have their own logins.
--   - A manager+ can insert events for ANY staff in their accessible
--     locations — that's the kiosk operator writing on behalf of the
--     scanned worker.
--
-- READ + UPDATE + DELETE policies unchanged.
--
-- Safe to re-run.

BEGIN;

DROP POLICY IF EXISTS production_events_insert ON production_events;

CREATE POLICY production_events_insert ON production_events FOR INSERT
  WITH CHECK (
    can_access_location(location)
    AND (
      staff_id = auth.uid()           -- self-insert (future, if workers log in)
      OR is_manager_or_higher()       -- kiosk operator inserts for any staff
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
