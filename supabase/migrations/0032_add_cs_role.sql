-- 0032_add_cs_role.sql
--
-- Add 'cs' (customer service) as a fourth tier of profile role. CS team
-- members log in directly; their writes to cs_cases / cs_returns get
-- auto-attributed to their user_id, so the audit trail of "who logged
-- this replacement" is automatic.
--
-- Existing cs_cases / cs_returns RLS policies are already permissive on
-- can_access_location() so CS users can write them without further
-- policy changes. The is_cs_or_higher() helper is added for symmetry
-- and as defense-in-depth for any future policies that need to gate
-- by role.
--
-- Safe to re-run.

BEGIN;

-- 1. Allow 'cs' in the profile role check.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD  CONSTRAINT profiles_role_check
  CHECK (role IN ('owner', 'manager', 'staff', 'kiosk', 'cs'));

-- 2. Helper: at least CS (cs OR manager OR owner). Available for future
--    policies that want to gate writes to CS tables specifically.
CREATE OR REPLACE FUNCTION is_cs_or_higher()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT current_user_role() IN ('owner', 'manager', 'cs');
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;