-- F5 departments: remove the committed synthetic fixtures made by
-- 01-fixtures.sql and the two-session script.
--
-- STAGING ONLY. It deletes ONLY rows that belong to the synthetic "F5X"
-- people (ids f5710000-...) and departments ("F5X ..."), and events whose id
-- starts with 'f5x-' at location 'staging'. Nothing else is touched, and no
-- item-counting (F1) object or record is changed.
--
-- Run as the database operator (the client roles have no delete rights on
-- these tables, by design). It reports what it removed and ends by proving
-- nothing synthetic is left. If anything unexpected would be deleted it stops.

BEGIN;

DO $$
DECLARE
  v_people uuid[] := ARRAY[
    'f5710000-0000-4000-8000-0000000000f1', 'f5710000-0000-4000-8000-0000000000f2',
    'f5710000-0000-4000-8000-0000000000d2', 'f5710000-0000-4000-8000-000000000001',
    'f5710000-0000-4000-8000-000000000002']::uuid[];
  v_depts  uuid[];
  n_events int; n_audit int; n_requests int; n_assign int; n_names int; n_depts int; n_profiles int; n_users int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') THEN
    RAISE EXCEPTION 'F5 cleanup: no location "staging" in this database. Refusing to run: staging only.';
  END IF;

  SELECT coalesce(array_agg(id), '{}') INTO v_depts FROM public.business_departments WHERE normalized_name LIKE 'f5x %';

  -- Safety: a synthetic department must not have a real person in it.
  IF EXISTS (SELECT 1 FROM public.person_department_assignments a
              WHERE a.department_id = ANY (v_depts) AND NOT (a.person_id = ANY (v_people))) THEN
    RAISE EXCEPTION 'F5 cleanup: a non-synthetic person has history in an "F5X" department. Nothing was deleted; investigate first.';
  END IF;
  -- Safety: a synthetic person must not have real (non f5x-) events.
  IF EXISTS (SELECT 1 FROM public.production_events e WHERE e.staff_id = ANY (v_people) AND e.id NOT LIKE 'f5x-%') THEN
    RAISE EXCEPTION 'F5 cleanup: a synthetic person has events that are not "f5x-" events. Nothing was deleted; investigate first.';
  END IF;

  DELETE FROM public.production_events WHERE location = 'staging' AND id LIKE 'f5x-%' AND staff_id = ANY (v_people);
  GET DIAGNOSTICS n_events = ROW_COUNT;
  DELETE FROM public.department_audit
   WHERE actor_id = ANY (v_people) OR person_id = ANY (v_people) OR department_id = ANY (v_depts);
  GET DIAGNOSTICS n_audit = ROW_COUNT;
  DELETE FROM public.department_requests WHERE actor_id = ANY (v_people);
  GET DIAGNOSTICS n_requests = ROW_COUNT;
  DELETE FROM public.person_department_assignments WHERE person_id = ANY (v_people) OR department_id = ANY (v_depts);
  GET DIAGNOSTICS n_assign = ROW_COUNT;
  DELETE FROM public.business_department_names WHERE department_id = ANY (v_depts);
  GET DIAGNOSTICS n_names = ROW_COUNT;
  DELETE FROM public.business_departments WHERE id = ANY (v_depts);
  GET DIAGNOSTICS n_depts = ROW_COUNT;
  -- Assignments are gone already, so the profile trigger has nothing to close.
  DELETE FROM public.user_locations WHERE user_id = ANY (v_people);
  DELETE FROM public.profiles WHERE user_id = ANY (v_people);
  GET DIAGNOSTICS n_profiles = ROW_COUNT;
  DELETE FROM auth.users WHERE id = ANY (v_people);
  GET DIAGNOSTICS n_users = ROW_COUNT;

  RAISE NOTICE 'F5 cleanup removed: % events, % audit rows, % receipts, % assignments, % name rows, % departments, % profiles, % auth users',
    n_events, n_audit, n_requests, n_assign, n_names, n_depts, n_profiles, n_users;

  IF EXISTS (SELECT 1 FROM public.business_departments WHERE normalized_name LIKE 'f5x %')
     OR EXISTS (SELECT 1 FROM public.profiles WHERE user_id = ANY (v_people))
     OR EXISTS (SELECT 1 FROM auth.users WHERE id = ANY (v_people))
     OR EXISTS (SELECT 1 FROM public.production_events WHERE id LIKE 'f5x-%' AND location = 'staging') THEN
    RAISE EXCEPTION 'F5 cleanup: synthetic rows remain. Rolled back.';
  END IF;
  RAISE NOTICE 'F5 cleanup: no synthetic F5X rows remain.';
END $$;

COMMIT;

-- State left behind: the switch, and the three F5 event triggers enabled.
SELECT enabled, version FROM public.department_snapshot_control;
SELECT tgname, tgenabled FROM pg_trigger
 WHERE tgname IN ('production_events_f5_10_sanitize', 'production_events_f5_20_resolve',
                  'production_events_f5_10_freeze', 'profiles_f5_10_close_assignment')
 ORDER BY tgname;
