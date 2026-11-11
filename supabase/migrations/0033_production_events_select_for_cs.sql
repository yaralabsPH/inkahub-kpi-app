-- 0033_production_events_select_for_cs.sql
--
-- Widen the production_events SELECT policy so CS users (and any future
-- non-staff role) can read team-wide production events. Without this,
-- the policy uses is_kiosk_or_higher() which excludes cs - so Reports /
-- Welcome team-wide stats come back filtered to staff_id = auth.uid()
-- and look empty for them.
--
-- Replacement policy: staff role still restricted to their own events.
-- Anyone with role owner / manager / cs / kiosk can read all events at
-- locations they have access to.
--
-- Safe to re-run.

BEGIN;

DROP POLICY IF EXISTS production_events_select ON production_events;

CREATE POLICY production_events_select ON production_events
  FOR SELECT
  USING (
    can_access_location(location)
    AND (
      staff_id = auth.uid()
      OR current_user_role() IN ('owner', 'manager', 'cs', 'kiosk')
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;