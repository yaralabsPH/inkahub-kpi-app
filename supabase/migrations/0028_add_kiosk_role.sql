-- 0028_add_kiosk_role.sql
--
-- Add a new profile role 'kiosk' that sits between 'staff' and 'manager'.
-- Purpose: shared kiosk logins (one Production account on every tablet,
-- workers scan in via lanyard). Grants the minimum extra power required
-- to make scanner-attributed event writes work, and nothing else.
--
-- Safe to re-run.

BEGIN;

-- 1. Allow 'kiosk' as a valid profile role.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD  CONSTRAINT profiles_role_check
  CHECK (role IN ('owner', 'manager', 'staff', 'kiosk'));

-- 2. Helper: kiosk OR higher. Used by the production_events policies so a
--    kiosk login can record events on behalf of any scanned worker WITHOUT
--    inheriting manager's other write powers.
CREATE OR REPLACE FUNCTION is_kiosk_or_higher()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT current_user_role() IN ('owner', 'manager', 'kiosk');
$$;

-- 3. INSERT policy: a kiosk operator can insert events for any staff_id
--    at their location. Workers self-inserting still works (future), and
--    manager/owner still works (they pass is_kiosk_or_higher).
DROP POLICY IF EXISTS production_events_insert ON production_events;
CREATE POLICY production_events_insert ON production_events FOR INSERT
  WITH CHECK (
    can_access_location(location)
    AND (
      staff_id = auth.uid()       -- self-insert
      OR is_kiosk_or_higher()     -- kiosk operator inserts for scanned staff
    )
  );

-- 4. SELECT policy: kiosk can read events at the station (needed to render
--    today's verified lines, the live order state, etc.). UPDATE/DELETE
--    remain manager+ only so events can't be silently rewritten from a
--    kiosk.
DROP POLICY IF EXISTS production_events_select ON production_events;
CREATE POLICY production_events_select ON production_events FOR SELECT
  USING (
    can_access_location(location)
    AND (
      staff_id = auth.uid()
      OR is_kiosk_or_higher()
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;