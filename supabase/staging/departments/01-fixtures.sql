-- F5 departments: committed synthetic fixtures for the two-session script.
--
-- STAGING ONLY. Unlike 02-assertions.sql this COMMITS, because two database
-- sessions can only see each other's committed rows. Remove everything again
-- with 09-cleanup.sql when the window ends.
--
-- Creates (all synthetic, ids f5710000-..., names "F5X ..."):
--   F5X Owner 1, F5X Owner 2 (owner), F5X Kiosk (kiosk),
--   F5X Person 1, F5X Person 2 (staff)            all at location 'staging'
--   departments "F5X Department A" and "F5X Department B"
--   F5X Person 1 assigned to A
-- These accounts have no password and cannot sign in; the scripts act as them
-- by setting the request claims.
--
-- Safe to re-run: it does nothing if the fixtures are already there.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') THEN
    RAISE EXCEPTION 'F5 fixtures: no location "staging" in this database. Refusing to run: staging only.';
  END IF;
  IF to_regprocedure('public.department_admin(text, uuid, uuid, uuid, text, bigint, uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'F5 fixtures: migrations 0052-0054 are not applied.';
  END IF;
END $$;

DO $$
DECLARE
  v_ids   uuid[] := ARRAY[
    'f5710000-0000-4000-8000-0000000000f1', 'f5710000-0000-4000-8000-0000000000f2',
    'f5710000-0000-4000-8000-0000000000d2', 'f5710000-0000-4000-8000-000000000001',
    'f5710000-0000-4000-8000-000000000002']::uuid[];
  v_names text[] := ARRAY['F5X Owner 1', 'F5X Owner 2', 'F5X Kiosk', 'F5X Person 1', 'F5X Person 2'];
  v_roles text[] := ARRAY['owner', 'owner', 'kiosk', 'staff', 'staff'];
  v_owner uuid := 'f5710000-0000-4000-8000-0000000000f1';
  v_p1    uuid := 'f5710000-0000-4000-8000-000000000001';
  v_a     uuid;
  v_ver   bigint;
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_ids, 1) LOOP
    INSERT INTO auth.users (id, email) VALUES (v_ids[i], 'f5x-' || i || '@inka-staging.test') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.profiles (user_id, display_name, role) VALUES (v_ids[i], v_names[i], v_roles[i])
      ON CONFLICT (user_id) DO NOTHING;
    INSERT INTO public.user_locations (user_id, location) VALUES (v_ids[i], 'staging') ON CONFLICT DO NOTHING;
  END LOOP;

  -- Act as F5X Owner 1 for the rest of this transaction.
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  IF NOT EXISTS (SELECT 1 FROM public.business_departments WHERE normalized_name = 'f5x department a') THEN
    PERFORM public.department_admin('create', gen_random_uuid(), NULL, NULL, 'F5X Department A', NULL, NULL, 'F5 staging fixture');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.business_departments WHERE normalized_name = 'f5x department b') THEN
    PERFORM public.department_admin('create', gen_random_uuid(), NULL, NULL, 'F5X Department B', NULL, NULL, 'F5 staging fixture');
  END IF;

  SELECT id, version INTO v_a, v_ver FROM public.business_departments WHERE normalized_name = 'f5x department a';
  IF NOT EXISTS (SELECT 1 FROM public.person_department_assignments WHERE person_id = v_p1 AND valid_to IS NULL) THEN
    PERFORM public.department_admin('assign', gen_random_uuid(), v_a, v_p1, NULL, v_ver, NULL, 'F5 staging fixture');
  END IF;
END $$;

COMMIT;

-- What now exists (ids are needed by 05-session-a.sql / 05-session-b.sql).
SELECT d.name, d.id, d.version,
       (SELECT count(*) FROM public.person_department_assignments a WHERE a.department_id = d.id AND a.valid_to IS NULL) AS members
  FROM public.business_departments d WHERE d.normalized_name LIKE 'f5x %' ORDER BY d.name;
SELECT p.display_name, p.user_id, p.role, a.id AS open_assignment_id
  FROM public.profiles p
  LEFT JOIN public.person_department_assignments a ON a.person_id = p.user_id AND a.valid_to IS NULL
 WHERE p.display_name LIKE 'F5X %' ORDER BY p.display_name;
SELECT enabled, version, tracking_started_at FROM public.department_snapshot_control;
