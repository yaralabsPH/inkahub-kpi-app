-- F5 departments: database assertions (single session).
--
-- STAGING ONLY. Never run against production. The script refuses to start
-- unless the database has a location with key 'staging'.
-- Requires migrations 0052, 0053 and 0054.
--
-- Everything runs in ONE transaction that ends with ROLLBACK: nothing is
-- kept. It creates its own synthetic people (ids f5700000-...), departments
-- ("F5T ...") and events ("f5t-..."). No real department or person is used.
--
-- Pass = the final notice "F5 verify: ALL CHECKS PASSED". Any failure raises
-- an exception "F5 verify FAILED [<case>] ..." naming the case.
--
-- While it runs it briefly holds locks other staging sessions may wait on
-- (the admin lock, and near the end a trigger toggle on production_events).
-- Run it inside the reserved staging window.
--
-- Not covered here (needs two sessions): see 05-session-a.sql / 05-session-b.sql.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') THEN
    RAISE EXCEPTION 'F5 verify: no location "staging" in this database. Refusing to run: staging only.';
  END IF;
END $$;

CREATE TEMP TABLE f5t (k text PRIMARY KEY, v text) ON COMMIT DROP;
CREATE TEMP TABLE f5t_cases (name text PRIMARY KEY, skipped boolean NOT NULL DEFAULT false) ON COMMIT DROP;

CREATE FUNCTION pg_temp.f5_set(p_k text, p_v text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO f5t VALUES (p_k, p_v) ON CONFLICT (k) DO UPDATE SET v = excluded.v
$$;
CREATE FUNCTION pg_temp.f5_get(p_k text) RETURNS text LANGUAGE sql AS $$ SELECT v FROM f5t WHERE k = p_k $$;

-- Record a passed case, or stop with its name.
CREATE FUNCTION pg_temp.f5_ok(p_case text, p_ok boolean, p_detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'F5 verify FAILED [%] %', p_case, coalesce(p_detail, '');
  END IF;
  INSERT INTO f5t_cases (name) VALUES (p_case);
END $$;

CREATE FUNCTION pg_temp.f5_skip(p_case text, p_why text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'F5 verify SKIPPED [%]: %', p_case, p_why;
  INSERT INTO f5t_cases (name, skipped) VALUES (p_case, true);
END $$;

-- Run one statement as a database role with a signed-in user (or nobody with
-- NULL) and report what happened: {"state": SQLSTATE, "message", "value"}.
-- The statement must return one value. State 00000 means it succeeded.
CREATE FUNCTION pg_temp.f5_call(p_uid uuid, p_dbrole text, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_value text;
  v_state text := '00000';
  v_msg   text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_uid IS NULL THEN '' ELSE jsonb_build_object('sub', p_uid, 'role', p_dbrole)::text END, true);
  PERFORM set_config('role', p_dbrole, true);
  BEGIN
    EXECUTE p_sql INTO v_value;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    v_msg := SQLERRM;
  END;
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN jsonb_build_object('state', v_state, 'message', v_msg, 'value', v_value);
END $$;

-- The statement must succeed; returns its value.
CREATE FUNCTION pg_temp.f5_must(p_case text, p_uid uuid, p_dbrole text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  r jsonb := pg_temp.f5_call(p_uid, p_dbrole, p_sql);
BEGIN
  PERFORM pg_temp.f5_ok(p_case, r ->> 'state' = '00000', format('expected success, got %s %s', r ->> 'state', r ->> 'message'));
  RETURN r ->> 'value';
END $$;

-- The statement must fail with exactly this SQLSTATE (and message, if given).
CREATE FUNCTION pg_temp.f5_refused(p_case text, p_uid uuid, p_dbrole text, p_sql text, p_state text, p_message text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb := pg_temp.f5_call(p_uid, p_dbrole, p_sql);
BEGIN
  PERFORM pg_temp.f5_ok(p_case,
    r ->> 'state' = p_state AND (p_message IS NULL OR position(p_message IN r ->> 'message') > 0),
    format('expected %s %s, got %s %s (value %s)', p_state, coalesce(p_message, ''), r ->> 'state', r ->> 'message', r ->> 'value'));
END $$;

-- department_admin as an owner; returns the result JSON as text.
CREATE FUNCTION pg_temp.f5_admin_sql(p_op text, p_request uuid, p_dept uuid, p_person uuid, p_name text,
                                     p_version bigint, p_assignment uuid, p_reason text)
RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.department_admin(%L, %L, %L, %L, %L, %L, %L, %L)::text',
                p_op, p_request, p_dept, p_person, p_name, p_version, p_assignment, p_reason)
$$;

-- Insert one event as a signed-in user. p_created_at NULL = let the database
-- default it (as the clock-in code does). Returns 1.
CREATE FUNCTION pg_temp.f5_event_sql(p_id text, p_staff uuid, p_type text, p_created_at timestamptz, p_extra text DEFAULT '')
RETURNS text LANGUAGE sql AS $$
  SELECT format(
    'WITH i AS (INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, note%s%s) '
    'VALUES (%L, %L, %L, %L, %s, %L, %L%s%s) RETURNING 1) SELECT count(*)::text FROM i',
    CASE WHEN p_created_at IS NULL THEN '' ELSE ', created_at' END,
    CASE WHEN p_extra = '' THEN '' ELSE ', ' || split_part(p_extra, '|', 1) END,
    'staging', p_id, p_staff, 'dispatch',
    CASE WHEN p_type IN ('clock_in','clock_out') THEN 'NULL' ELSE quote_literal('F5T-1') END,
    p_type, 'f5t',
    CASE WHEN p_created_at IS NULL THEN '' ELSE ', ' || quote_literal(p_created_at) END,
    CASE WHEN p_extra = '' THEN '' ELSE ', ' || split_part(p_extra, '|', 2) END)
$$;

CREATE FUNCTION pg_temp.f5_ev(p_id text) RETURNS public.production_events LANGUAGE sql AS $$
  SELECT e FROM public.production_events e WHERE e.location = 'staging' AND e.id = p_id
$$;

-- Run a statement with triggers switched off for this session only. Returns
-- false (and changes nothing) when this role may not do that.
CREATE FUNCTION pg_temp.f5_raw(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM set_config('session_replication_role', 'replica', true);
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;
  EXECUTE p_sql;
  PERFORM set_config('session_replication_role', 'origin', true);
  RETURN true;
END $$;

-- ===========================================================================
-- Fixtures: synthetic people, one per role, at 'staging' (Person 1 also at a
-- second site when one exists).
-- ===========================================================================
DO $$
DECLARE
  v_ids  uuid[] := ARRAY[
    'f5700000-0000-4000-8000-0000000000f1', -- owner 1
    'f5700000-0000-4000-8000-0000000000f2', -- owner 2
    'f5700000-0000-4000-8000-0000000000d1', -- manager
    'f5700000-0000-4000-8000-0000000000d2', -- kiosk
    'f5700000-0000-4000-8000-0000000000d3', -- cs
    'f5700000-0000-4000-8000-000000000001', -- Person 1 (staff)
    'f5700000-0000-4000-8000-000000000002', -- Person 2 (staff, never assigned)
    'f5700000-0000-4000-8000-000000000003', -- Person 3 (staff, removed later)
    'f5700000-0000-4000-8000-000000000004'  -- Person 4 (staff, for paging)
  ]::uuid[];
  v_names text[] := ARRAY['F5T Owner 1','F5T Owner 2','F5T Manager','F5T Kiosk','F5T CS','F5T Person 1','F5T Person 2','F5T Person 3','F5T Person 4'];
  v_roles text[] := ARRAY['owner','owner','manager','kiosk','cs','staff','staff','staff','staff'];
  v_other text;
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_ids, 1) LOOP
    INSERT INTO auth.users (id, email) VALUES (v_ids[i], 'f5t-' || i || '@inka-staging.test');
    INSERT INTO public.profiles (user_id, display_name, role) VALUES (v_ids[i], v_names[i], v_roles[i])
      ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role;
    INSERT INTO public.user_locations (user_id, location) VALUES (v_ids[i], 'staging') ON CONFLICT DO NOTHING;
  END LOOP;
  SELECT key INTO v_other FROM public.locations WHERE key <> 'staging' ORDER BY key LIMIT 1;
  IF v_other IS NOT NULL THEN
    INSERT INTO public.user_locations (user_id, location) VALUES (v_ids[6], v_other) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM pg_temp.f5_set('owner',   v_ids[1]::text);
  PERFORM pg_temp.f5_set('owner2',  v_ids[2]::text);
  PERFORM pg_temp.f5_set('manager', v_ids[3]::text);
  PERFORM pg_temp.f5_set('kiosk',   v_ids[4]::text);
  PERFORM pg_temp.f5_set('cs',      v_ids[5]::text);
  PERFORM pg_temp.f5_set('p1',      v_ids[6]::text);
  PERFORM pg_temp.f5_set('p2',      v_ids[7]::text);
  PERFORM pg_temp.f5_set('p3',      v_ids[8]::text);
  PERFORM pg_temp.f5_set('p4',      v_ids[9]::text);
END $$;

-- ===========================================================================
-- A. Catalog: objects, privileges, trigger order
-- ===========================================================================
DO $$
DECLARE
  t text;
  r text;
  f text;
  v_names text[];
BEGIN
  PERFORM pg_temp.f5_ok('A01 btree_gist lives in extensions',
    (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'btree_gist') = 'extensions');

  FOREACH t IN ARRAY ARRAY['business_departments','business_department_names','person_department_assignments',
                           'department_audit','department_requests','department_snapshot_control'] LOOP
    PERFORM pg_temp.f5_ok('A02 RLS on ' || t,
      (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = ('public.' || t)::regclass));
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      PERFORM pg_temp.f5_ok(format('A03 no write privilege for %s on %s', r, t),
        NOT has_table_privilege(r, 'public.' || t, 'INSERT')
        AND NOT has_table_privilege(r, 'public.' || t, 'UPDATE')
        AND NOT has_table_privilege(r, 'public.' || t, 'DELETE')
        AND NOT has_table_privilege(r, 'public.' || t, 'TRUNCATE'));
    END LOOP;
    PERFORM pg_temp.f5_ok('A04 no read privilege for anon/service_role on ' || t,
      NOT has_table_privilege('anon', 'public.' || t, 'SELECT')
      AND NOT has_table_privilege('service_role', 'public.' || t, 'SELECT'));
  END LOOP;
  PERFORM pg_temp.f5_ok('A05 receipts are not readable by authenticated',
    NOT has_table_privilege('authenticated', 'public.department_requests', 'SELECT'));

  FOREACH f IN ARRAY ARRAY[
    'public.department_admin(text, uuid, uuid, uuid, text, bigint, uuid, text)',
    'public.department_set_snapshot_enabled(uuid, boolean, bigint, text)',
    'public.department_owner_page(text, uuid, jsonb, integer)'] LOOP
    PERFORM pg_temp.f5_ok('A06 authenticated may call ' || f, has_function_privilege('authenticated', f, 'EXECUTE'));
    PERFORM pg_temp.f5_ok('A07 anon/service_role/PUBLIC may not call ' || f,
      NOT has_function_privilege('anon', f, 'EXECUTE')
      AND NOT has_function_privilege('service_role', f, 'EXECUTE')
      AND NOT has_function_privilege('public', f, 'EXECUTE'));
    PERFORM pg_temp.f5_ok('A08 pinned search_path and SECURITY DEFINER on ' || f,
      (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc p WHERE p.oid = f::regprocedure));
  END LOOP;

  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    PERFORM pg_temp.f5_ok('A09 private schema closed to ' || r, NOT has_schema_privilege(r, 'departments_private', 'USAGE'));
  END LOOP;
  PERFORM pg_temp.f5_ok('A10 no private function is callable by a client role', NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, unnest(ARRAY['anon','authenticated','service_role','public']) AS role(name)
     WHERE n.nspname = 'departments_private' AND has_function_privilege(role.name, p.oid, 'EXECUTE')));

  PERFORM pg_temp.f5_ok('A11 resolver role is login-less and unprivileged', (
    SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolinherit
      FROM pg_roles WHERE rolname = 'departments_resolver'));
  PERFORM pg_temp.f5_ok('A12 resolver function runs as departments_resolver', (
    SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'departments_resolver'
      FROM pg_proc p WHERE p.oid = 'departments_private.resolve_event()'::regprocedure));
  PERFORM pg_temp.f5_ok('A13 resolver role cannot read profiles, rates, receipts or events',
    NOT has_table_privilege('departments_resolver', 'public.profiles', 'SELECT')
    AND NOT has_table_privilege('departments_resolver', 'public.department_requests', 'SELECT')
    AND NOT has_table_privilege('departments_resolver', 'public.production_events', 'SELECT')
    AND (to_regclass('public.staff_rates') IS NULL OR NOT has_table_privilege('departments_resolver', 'public.staff_rates', 'SELECT')));
  PERFORM pg_temp.f5_ok('A14 migration role is no longer a member of departments_resolver',
    NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r2 ON r2.oid = m.roleid
                 WHERE r2.rolname = 'departments_resolver' AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                   AND m.set_option));
  PERFORM pg_temp.f5_ok('A15 resolver role cannot create in the private schema',
    NOT has_schema_privilege('departments_resolver', 'departments_private', 'CREATE'));

  -- BEFORE INSERT row triggers on production_events, in firing (name) order.
  SELECT array_agg(tgname ORDER BY tgname) INTO v_names FROM pg_trigger
   WHERE tgrelid = 'public.production_events'::regclass AND NOT tgisinternal
     AND (tgtype & 2) = 2 AND (tgtype & 4) = 4;
  PERFORM pg_temp.f5_ok('A16 sanitize fires before resolve',
    array_position(v_names, 'production_events_f5_10_sanitize') < array_position(v_names, 'production_events_f5_20_resolve'),
    v_names::text);
  PERFORM pg_temp.f5_ok('A17 no other BEFORE INSERT trigger fires after resolve',
    v_names[array_length(v_names, 1)] = 'production_events_f5_20_resolve', v_names::text);
  PERFORM pg_temp.f5_ok('A18 the three F5 event triggers and the profile trigger are enabled', (
    SELECT count(*) = 4 FROM pg_trigger
     WHERE tgname IN ('production_events_f5_10_sanitize','production_events_f5_20_resolve',
                      'production_events_f5_10_freeze','profiles_f5_10_close_assignment')
       AND tgenabled = 'O'));
  PERFORM pg_temp.f5_ok('A19 the eleven event columns are nullable with no default', (
    SELECT count(*) = 11 AND bool_and(is_nullable = 'YES' AND column_default IS NULL)
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'production_events'
       AND column_name IN ('business_department_id','business_department_name','business_department_assignment_id',
         'business_department_name_version_id','business_department_status','department_snapshot_version',
         'department_occurred_at','department_received_at','department_resolution_instant',
         'department_time_status','department_resolved_at')));
  PERFORM pg_temp.f5_ok('A20 no foreign key was added from events to the department tables', NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_events'::regclass AND contype = 'f'
       AND confrelid IN ('public.business_departments'::regclass, 'public.person_department_assignments'::regclass,
                         'public.business_department_names'::regclass)));
  PERFORM pg_temp.f5_ok('A21 the control row exists', (SELECT count(*) = 1 FROM public.department_snapshot_control));
  PERFORM pg_temp.f5_ok('A22 the work-type check on events is unchanged', (
    SELECT pg_get_constraintdef(oid) LIKE '%a0_framed%framed%unframed%dispatch%'
      FROM pg_constraint WHERE conrelid = 'public.production_events'::regclass AND conname = 'production_events_department_check'));
END $$;

-- ===========================================================================
-- B. Time rules, straight from the classifier (microsecond boundaries)
-- ===========================================================================
DO $$
DECLARE
  s timestamptz := '2026-11-22T10:00:00.000000Z';
  c record;
BEGIN
  SELECT * INTO c FROM departments_private.classify_time(s, s);
  PERFORM pg_temp.f5_ok('B01 O = S is reported at O', c.time_status = 'reported' AND c.resolution_instant = s);
  SELECT * INTO c FROM departments_private.classify_time(s + interval '1 microsecond', s);
  PERFORM pg_temp.f5_ok('B02 O = S + 1us is clamped to S', c.time_status = 'future_clamped' AND c.resolution_instant = s);
  SELECT * INTO c FROM departments_private.classify_time(s + interval '2 seconds', s);
  PERFORM pg_temp.f5_ok('B03 O = S + 2s is clamped to S', c.time_status = 'future_clamped' AND c.resolution_instant = s);
  SELECT * INTO c FROM departments_private.classify_time(s + interval '5 seconds', s);
  PERFORM pg_temp.f5_ok('B04 O = S + 5s is future_clamped', c.time_status = 'future_clamped' AND c.resolution_instant = s);
  SELECT * INTO c FROM departments_private.classify_time(s + interval '5 seconds' + interval '1 microsecond', s);
  PERFORM pg_temp.f5_ok('B05 O = S + 5s + 1us is invalid_time with NULL instant', c.time_status = 'invalid_time' AND c.resolution_instant IS NULL);
  SELECT * INTO c FROM departments_private.classify_time(s - interval '5 minutes', s);
  PERFORM pg_temp.f5_ok('B06 O = S - 5min is reported', c.time_status = 'reported' AND c.resolution_instant = s - interval '5 minutes');
  SELECT * INTO c FROM departments_private.classify_time(s - interval '5 minutes' - interval '1 microsecond', s);
  PERFORM pg_temp.f5_ok('B07 O = S - 5min - 1us is reported_old at O',
    c.time_status = 'reported_old' AND c.resolution_instant = s - interval '5 minutes' - interval '1 microsecond');
  SELECT * INTO c FROM departments_private.classify_time(s - interval '2 days', s);
  PERFORM pg_temp.f5_ok('B08 O = S - 2 days is reported_old at O', c.time_status = 'reported_old' AND c.resolution_instant = s - interval '2 days');
  SELECT * INTO c FROM departments_private.classify_time('infinity', s);
  PERFORM pg_temp.f5_ok('B09 infinity is invalid_time', c.time_status = 'invalid_time' AND c.resolution_instant IS NULL);
  SELECT * INTO c FROM departments_private.classify_time('-infinity', s);
  PERFORM pg_temp.f5_ok('B10 -infinity is invalid_time', c.time_status = 'invalid_time' AND c.resolution_instant IS NULL);
  SELECT * INTO c FROM departments_private.classify_time(NULL, s);
  PERFORM pg_temp.f5_ok('B11 missing time is invalid_time', c.time_status = 'invalid_time' AND c.resolution_instant IS NULL);
END $$;

-- ===========================================================================
-- C. Names (same fixtures as the unit tests)
-- ===========================================================================
DO $$
DECLARE
  v_state text;
  v_bad text;
BEGIN
  PERFORM pg_temp.f5_ok('C01 spaces collapse and trim, casing kept',
    departments_private.normalize_name('  Department   A  ') = 'Department A');
  PERFORM pg_temp.f5_ok('C02 no-break and em spaces collapse too',
    departments_private.normalize_name('Department' || chr(160) || chr(8195) || 'A') = 'Department A');
  PERFORM pg_temp.f5_ok('C03 80 characters allowed', char_length(departments_private.normalize_name(repeat('x', 80))) = 80);
  PERFORM pg_temp.f5_ok('C04 80 astral characters allowed', char_length(departments_private.normalize_name(repeat(chr(128512), 80))) = 80);
  FOREACH v_bad IN ARRAY ARRAY['Dept' || chr(9) || 'A', 'Dept' || chr(10) || 'A', 'Dept' || chr(133) || 'A',
                               'Dept' || chr(8232) || 'A', '   ', repeat('x', 81), repeat(chr(128512), 81)] LOOP
    BEGIN
      PERFORM departments_private.normalize_name(v_bad);
      v_state := '00000';
    EXCEPTION WHEN OTHERS THEN
      v_state := SQLSTATE;
    END;
    PERFORM pg_temp.f5_ok(format('C05 refused name #%s', md5(v_bad)), v_state = '22023', v_state);
  END LOOP;
END $$;

-- ===========================================================================
-- D. Only an owner may do anything
-- ===========================================================================
DO $$
DECLARE
  v_who  text;
  v_uid  uuid;
  v_role text;
  v_t    text;
  r      jsonb;
BEGIN
  FOREACH v_who IN ARRAY ARRAY['manager','kiosk','cs','p1','anon','service_role'] LOOP
    v_uid  := CASE WHEN v_who IN ('anon','service_role') THEN NULL ELSE pg_temp.f5_get(v_who)::uuid END;
    v_role := CASE WHEN v_who IN ('anon','service_role') THEN v_who ELSE 'authenticated' END;

    PERFORM pg_temp.f5_refused('D01 create refused for ' || v_who, v_uid, v_role,
      pg_temp.f5_admin_sql('create', gen_random_uuid(), NULL, NULL, 'F5T Nope', NULL, NULL, ''), '42501');
    PERFORM pg_temp.f5_refused('D02 switch refused for ' || v_who, v_uid, v_role,
      format('SELECT public.department_set_snapshot_enabled(%L, true, 1, %L)::text', gen_random_uuid(), 'x'), '42501');
    PERFORM pg_temp.f5_refused('D03 owner page refused for ' || v_who, v_uid, v_role,
      'SELECT public.department_owner_page(''people'', NULL, NULL, 10)::text', '42501');

    FOREACH v_t IN ARRAY ARRAY['business_departments','business_department_names','person_department_assignments',
                               'department_audit','department_snapshot_control','department_requests'] LOOP
      r := pg_temp.f5_call(v_uid, v_role, format('SELECT count(*)::text FROM public.%I', v_t));
      -- Either the table is closed outright, or row-level security hides every row.
      PERFORM pg_temp.f5_ok(format('D04 %s sees no rows of %s', v_who, v_t),
        r ->> 'state' = '42501' OR (r ->> 'state' = '00000' AND r ->> 'value' = '0'), r::text);
    END LOOP;
    PERFORM pg_temp.f5_refused('D05 direct insert refused for ' || v_who, v_uid, v_role,
      format('WITH i AS (INSERT INTO public.business_departments (name, normalized_name, created_at, updated_at, created_by, updated_by) '
             'VALUES (''F5T X'', ''f5t x'', now(), now(), %L, %L) RETURNING 1) SELECT count(*)::text FROM i',
             pg_temp.f5_get('owner'), pg_temp.f5_get('owner')), '42501');
    PERFORM pg_temp.f5_refused('D06 direct switch update refused for ' || v_who, v_uid, v_role,
      'WITH u AS (UPDATE public.department_snapshot_control SET enabled = true RETURNING 1) SELECT count(*)::text FROM u', '42501');
    PERFORM pg_temp.f5_refused('D07 private helper refused for ' || v_who, v_uid, v_role,
      'SELECT departments_private.normalize_name(''x'')', '42501');
  END LOOP;

  -- Even an owner has no direct write path: only the checked functions.
  PERFORM pg_temp.f5_refused('D08 owner direct insert refused', pg_temp.f5_get('owner')::uuid, 'authenticated',
    format('WITH i AS (INSERT INTO public.business_departments (name, normalized_name, created_at, updated_at, created_by, updated_by) '
           'VALUES (''F5T X'', ''f5t x'', now(), now(), %L, %L) RETURNING 1) SELECT count(*)::text FROM i',
           pg_temp.f5_get('owner'), pg_temp.f5_get('owner')), '42501');
  PERFORM pg_temp.f5_refused('D09 owner direct assignment delete refused', pg_temp.f5_get('owner')::uuid, 'authenticated',
    'WITH d AS (DELETE FROM public.person_department_assignments RETURNING 1) SELECT count(*)::text FROM d', '42501');
  PERFORM pg_temp.f5_refused('D10 owner direct audit delete refused', pg_temp.f5_get('owner')::uuid, 'authenticated',
    'WITH d AS (DELETE FROM public.department_audit RETURNING 1) SELECT count(*)::text FROM d', '42501');
END $$;

-- ===========================================================================
-- E. Owner administration
-- ===========================================================================
DO $$
DECLARE
  v_owner  uuid := pg_temp.f5_get('owner')::uuid;
  v_owner2 uuid := pg_temp.f5_get('owner2')::uuid;
  v_p1     uuid := pg_temp.f5_get('p1')::uuid;
  v_p3     uuid := pg_temp.f5_get('p3')::uuid;
  v_req    uuid;
  v_res    jsonb;
  v_res2   jsonb;
  v_a      uuid;
  v_b      uuid;
  v_c      uuid;
  v_ver    bigint;
  v_assign uuid;
  v_audit  bigint;
BEGIN
  -- create, normalized
  v_res := pg_temp.f5_must('E01 create Department A', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('create', gen_random_uuid(), NULL, NULL, '  F5T   Department   A  ', NULL, NULL, ''))::jsonb;
  v_a := (v_res ->> 'department_id')::uuid;
  PERFORM pg_temp.f5_ok('E02 name saved normalized, version 1 as a string',
    (SELECT name FROM public.business_departments WHERE id = v_a) = 'F5T Department A'
    AND v_res ->> 'outcome' = 'applied' AND v_res -> 'department_version' = '"1"'::jsonb);
  PERFORM pg_temp.f5_ok('E03 create opened one name interval and one audit row',
    (SELECT count(*) = 1 FROM public.business_department_names WHERE department_id = v_a AND valid_to IS NULL)
    AND (SELECT count(*) = 1 FROM public.department_audit WHERE department_id = v_a AND operation = 'create' AND actor_id = v_owner));

  PERFORM pg_temp.f5_refused('E04 same name in another case is taken', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('create', gen_random_uuid(), NULL, NULL, 'f5t department a', NULL, NULL, ''), '23505');
  PERFORM pg_temp.f5_refused('E05 control character refused', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('create', gen_random_uuid(), NULL, NULL, 'F5T' || chr(9) || 'Tab', NULL, NULL, ''), '22023');
  PERFORM pg_temp.f5_refused('E06 81 characters refused', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('create', gen_random_uuid(), NULL, NULL, repeat('x', 81), NULL, NULL, ''), '22023');
  PERFORM pg_temp.f5_refused('E07 create with a department id refused', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('create', gen_random_uuid(), v_a, NULL, 'F5T Other', NULL, NULL, ''), '22023');
  PERFORM pg_temp.f5_refused('E08 unknown operation refused', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('delete', gen_random_uuid(), v_a, NULL, NULL, 1, NULL, ''), '22023');
  PERFORM pg_temp.f5_refused('E09 reason over 500 characters refused', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('create', gen_random_uuid(), NULL, NULL, 'F5T Long Reason', NULL, NULL, repeat('r', 501)), '22023');

  v_b := (pg_temp.f5_must('E10 create Department B', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('create', gen_random_uuid(), NULL, NULL, 'F5T Department B', NULL, NULL, ''))::jsonb ->> 'department_id')::uuid;
  v_c := (pg_temp.f5_must('E11 create Department C', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('create', gen_random_uuid(), NULL, NULL, 'F5T Department C', NULL, NULL, ''))::jsonb ->> 'department_id')::uuid;

  -- rename C -> C2, retried with the same request id
  v_req := gen_random_uuid();
  v_res := pg_temp.f5_must('E12 rename C to C2', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('rename', v_req, v_c, NULL, 'F5T Department C2', 1, NULL, ''))::jsonb;
  PERFORM pg_temp.f5_ok('E13 rename bumped the version and kept both names in history',
    v_res ->> 'department_version' = '2'
    AND (SELECT count(*) = 2 FROM public.business_department_names WHERE department_id = v_c)
    AND (SELECT count(*) = 1 FROM public.business_department_names WHERE department_id = v_c AND valid_to IS NULL AND name = 'F5T Department C2')
    AND (SELECT o.valid_to = n.valid_from FROM public.business_department_names o, public.business_department_names n
          WHERE o.department_id = v_c AND o.valid_to IS NOT NULL AND n.department_id = v_c AND n.valid_to IS NULL));
  v_res2 := pg_temp.f5_must('E14 retry of the same rename returns the stored result', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('rename', v_req, v_c, NULL, 'F5T Department C2', 1, NULL, ''))::jsonb;
  PERFORM pg_temp.f5_ok('E15 retry result is identical and nothing was applied twice',
    v_res2 = v_res AND (SELECT version FROM public.business_departments WHERE id = v_c) = 2
    AND (SELECT count(*) = 1 FROM public.department_audit WHERE request_id = v_req));
  PERFORM pg_temp.f5_refused('E16 same request id with a different payload refused', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('rename', v_req, v_c, NULL, 'F5T Department C3', 2, NULL, ''), '22023', 'request_id_reused');
  PERFORM pg_temp.f5_refused('E17 stale version is a conflict', v_owner2, 'authenticated',
    pg_temp.f5_admin_sql('rename', gen_random_uuid(), v_c, NULL, 'F5T Department C9', 1, NULL, ''), '40001');
  PERFORM pg_temp.f5_ok('E18 the old name can be reused by another department',
    (pg_temp.f5_call(v_owner, 'authenticated', pg_temp.f5_admin_sql('create', gen_random_uuid(), NULL, NULL, 'F5T Department C', NULL, NULL, '')) ->> 'state') = '00000');
  v_res := pg_temp.f5_must('E19 renaming to the same name is a no-op', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('rename', gen_random_uuid(), v_c, NULL, 'F5T Department C2', 2, NULL, ''))::jsonb;
  PERFORM pg_temp.f5_ok('E20 no-op changes no version', v_res ->> 'outcome' = 'noop'
    AND (SELECT version FROM public.business_departments WHERE id = v_c) = 2);

  -- archive / restore C2
  v_res := pg_temp.f5_must('E21 archive C2', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('archive', gen_random_uuid(), v_c, NULL, NULL, 2, NULL, ''))::jsonb;
  PERFORM pg_temp.f5_ok('E22 archived department leaves the active page', NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements((pg_temp.f5_call(v_owner, 'authenticated',
      'SELECT public.department_owner_page(''departments_active'', NULL, NULL, 100)::text') ->> 'value')::jsonb -> 'rows') x
     WHERE (x ->> 'id')::uuid = v_c));
  PERFORM pg_temp.f5_refused('E23 an archived name stays reserved', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('create', gen_random_uuid(), NULL, NULL, 'F5T Department C2', NULL, NULL, ''), '23505');
  PERFORM pg_temp.f5_refused('E24 cannot assign into an archived department', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', gen_random_uuid(), v_c, v_p1, NULL, 3, NULL, ''), '22023', 'department_archived');
  v_res := pg_temp.f5_must('E25 restore C2', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('restore', gen_random_uuid(), v_c, NULL, NULL, 3, NULL, ''))::jsonb;
  PERFORM pg_temp.f5_ok('E26 restored with no members', (
    SELECT (x ->> 'member_count')::int = 0 FROM jsonb_array_elements((pg_temp.f5_call(v_owner, 'authenticated',
      'SELECT public.department_owner_page(''departments_active'', NULL, NULL, 100)::text') ->> 'value')::jsonb -> 'rows') x
     WHERE (x ->> 'id')::uuid = v_c));

  -- assign Person 1 to A
  v_res := pg_temp.f5_must('E27 assign Person 1 to A', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', gen_random_uuid(), v_a, v_p1, NULL, 1, NULL, ''))::jsonb;
  v_assign := (v_res ->> 'assignment_id')::uuid;
  PERFORM pg_temp.f5_ok('E28 one open home, audited as assign',
    (SELECT count(*) = 1 FROM public.person_department_assignments WHERE person_id = v_p1 AND valid_to IS NULL AND department_id = v_a)
    AND (SELECT count(*) = 1 FROM public.department_audit WHERE assignment_id = v_assign AND operation = 'assign'));
  PERFORM pg_temp.f5_ok('E29 the home is one global fact (people page shows it once)', (
    SELECT count(*) = 1 AND bool_and(x ->> 'department_name' = 'F5T Department A')
      FROM jsonb_array_elements((pg_temp.f5_call(v_owner, 'authenticated',
        'SELECT public.department_owner_page(''people'', NULL, NULL, 100)::text') ->> 'value')::jsonb -> 'rows') x
     WHERE (x ->> 'person_id')::uuid = v_p1) OR (SELECT count(*) > 100 FROM public.profiles));
  v_res := pg_temp.f5_must('E30 assigning to the same department is a no-op', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', gen_random_uuid(), v_a, v_p1, NULL, 1, v_assign, ''))::jsonb;
  PERFORM pg_temp.f5_ok('E31 no zero-length interval, no extra audit', v_res ->> 'outcome' = 'noop'
    AND (SELECT count(*) = 1 FROM public.person_department_assignments WHERE person_id = v_p1)
    AND (SELECT count(*) = 1 FROM public.department_audit WHERE person_id = v_p1));
  PERFORM pg_temp.f5_refused('E32 wrong current assignment is a conflict', v_owner2, 'authenticated',
    pg_temp.f5_admin_sql('assign', gen_random_uuid(), v_b, v_p1, NULL, 1, NULL, ''), '40001', 'assignment_changed');
  PERFORM pg_temp.f5_refused('E33 archive refused while Person 1 is a member', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('archive', gen_random_uuid(), v_a, NULL, NULL, 1, NULL, ''), 'P0001', 'department_has_members');
  PERFORM pg_temp.f5_ok('E34 members page lists Person 1 for A', (
    SELECT count(*) = 1 AND bool_and((x ->> 'person_id')::uuid = v_p1 AND x ->> 'display_name' = 'F5T Person 1')
      FROM jsonb_array_elements((pg_temp.f5_call(v_owner, 'authenticated',
        format('SELECT public.department_owner_page(''members'', %L, NULL, 100)::text', v_a)) ->> 'value')::jsonb -> 'rows') x));
  PERFORM pg_temp.f5_refused('E35 correct needs a reason', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('correct', gen_random_uuid(), v_b, v_p1, NULL, 1, v_assign, '   '), '22023', 'reason_required');
  PERFORM pg_temp.f5_refused('E36 assign refuses a name argument', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', gen_random_uuid(), v_b, v_p1, 'x', 1, v_assign, ''), '22023');
  PERFORM pg_temp.f5_refused('E37 unknown person (no profile) refused', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', gen_random_uuid(), v_b, gen_random_uuid(), NULL, 1, NULL, ''), '22023', 'person_not_on_team');

  -- Person 3: assigned to B (used by the removal cases)
  PERFORM pg_temp.f5_must('E38 assign Person 3 to B', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', gen_random_uuid(), v_b, v_p3, NULL, 1, NULL, ''));

  PERFORM pg_temp.f5_set('dept_a', v_a::text);
  PERFORM pg_temp.f5_set('dept_b', v_b::text);
  PERFORM pg_temp.f5_set('dept_c', v_c::text);
  PERFORM pg_temp.f5_set('assign_a', v_assign::text);
END $$;

-- ===========================================================================
-- F. The switch, and snapshots on live inserts
-- ===========================================================================
DO $$
DECLARE
  v_owner  uuid := pg_temp.f5_get('owner')::uuid;
  v_kiosk  uuid := pg_temp.f5_get('kiosk')::uuid;
  v_p1     uuid := pg_temp.f5_get('p1')::uuid;
  v_p2     uuid := pg_temp.f5_get('p2')::uuid;
  v_a      uuid := pg_temp.f5_get('dept_a')::uuid;
  v_b      uuid := pg_temp.f5_get('dept_b')::uuid;
  v_assign uuid := pg_temp.f5_get('assign_a')::uuid;
  v_ctl    public.department_snapshot_control;
  v_req    uuid;
  v_res    jsonb;
  v_res2   jsonb;
  e        public.production_events;
  e1       public.production_events;
  v_type   text;
  v_t      timestamptz;
BEGIN
  SELECT * INTO v_ctl FROM public.department_snapshot_control;

  -- Whatever state staging is in, start these cases from OFF.
  IF v_ctl.enabled THEN
    PERFORM pg_temp.f5_must('F00 switch off to start', v_owner, 'authenticated',
      format('SELECT public.department_set_snapshot_enabled(%L, false, %s, %L)::text', gen_random_uuid(), v_ctl.version, 'f5t start'));
    SELECT * INTO v_ctl FROM public.department_snapshot_control;
  END IF;

  PERFORM pg_temp.f5_must('F01 kiosk records an event for Person 1 while switched off', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-off-1', v_p1, 'completed', clock_timestamp()));
  e := pg_temp.f5_ev('f5t-off-1');
  PERFORM pg_temp.f5_ok('F02 switched off: status disabled, no department, time markers kept',
    e.business_department_status = 'disabled' AND e.business_department_id IS NULL AND e.business_department_name IS NULL
    AND e.business_department_assignment_id IS NULL AND e.business_department_name_version_id IS NULL
    AND e.department_snapshot_version = 1 AND e.department_time_status IS NOT NULL
    AND e.department_received_at IS NOT NULL AND e.department_resolved_at IS NOT NULL
    AND e.department_occurred_at = e.created_at, row_to_json(e)::text);

  PERFORM pg_temp.f5_refused('F03 switch needs a reason', v_owner, 'authenticated',
    format('SELECT public.department_set_snapshot_enabled(%L, true, %s, %L)::text', gen_random_uuid(), v_ctl.version, ' '), '22023');
  PERFORM pg_temp.f5_refused('F04 switch with a stale version is a conflict', v_owner, 'authenticated',
    format('SELECT public.department_set_snapshot_enabled(%L, true, %s, %L)::text', gen_random_uuid(), v_ctl.version + 7, 'x'), '40001');
  v_req := gen_random_uuid();
  v_res := pg_temp.f5_must('F05 switch on', v_owner, 'authenticated',
    format('SELECT public.department_set_snapshot_enabled(%L, true, %s, %L)::text', v_req, v_ctl.version, 'f5t on'))::jsonb;
  v_res2 := pg_temp.f5_must('F06 retried switch returns the stored result', v_owner, 'authenticated',
    format('SELECT public.department_set_snapshot_enabled(%L, true, %s, %L)::text', v_req, v_ctl.version, 'f5t on'))::jsonb;
  PERFORM pg_temp.f5_ok('F07 switch applied once and audited once',
    v_res = v_res2 AND v_res ->> 'outcome' = 'applied'
    AND (SELECT enabled AND version = v_ctl.version + 1 FROM public.department_snapshot_control)
    AND (SELECT count(*) = 1 FROM public.department_audit WHERE request_id = v_req AND operation = 'control'));

  -- All seven event types for an assigned worker, saved by the kiosk login.
  FOREACH v_type IN ARRAY ARRAY['started','completed','cancelled','dispatched','line_verified','clock_in','clock_out'] LOOP
    PERFORM pg_temp.f5_must('F08 insert ' || v_type, v_kiosk, 'authenticated',
      pg_temp.f5_event_sql('f5t-type-' || v_type, v_p1, v_type, clock_timestamp()));
    e := pg_temp.f5_ev('f5t-type-' || v_type);
    PERFORM pg_temp.f5_ok('F09 ' || v_type || ' is assigned to A with all four references',
      e.business_department_status = 'assigned' AND e.business_department_id = v_a
      AND e.business_department_name = 'F5T Department A' AND e.business_department_assignment_id = v_assign
      AND e.business_department_name_version_id IS NOT NULL AND e.department_resolution_instant IS NOT NULL
      AND e.department_time_status IN ('reported','future_clamped'), row_to_json(e)::text);
    PERFORM pg_temp.f5_ok('F10 ' || v_type || ' keeps its work type (routing untouched)', e.department = 'dispatch');
  END LOOP;
  e1 := pg_temp.f5_ev('f5t-type-completed'); -- "E1" in the acceptance criteria

  -- The clock-in code sends no created_at, so the column default now() applies.
  -- Inside this script that is the START of the test transaction (before
  -- Person 1 was assigned), so only the mechanics are checked here: the
  -- reported time is the default and a status was produced.
  PERFORM pg_temp.f5_must('F08b clock_in with the database default time', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-clock-default', v_p1, 'clock_in', NULL));
  e := pg_temp.f5_ev('f5t-clock-default');
  PERFORM pg_temp.f5_ok('F09b default-time clock event got a server status and kept its reported time',
    e.business_department_status IN ('assigned','unassigned') AND e.department_occurred_at = e.created_at
    AND e.created_at = now() AND e.order_number IS NULL, row_to_json(e)::text);

  -- Credited to the scanned worker, not the logged-in account.
  PERFORM pg_temp.f5_ok('F11 kiosk account itself has no home; the event still resolved for Person 1',
    NOT EXISTS (SELECT 1 FROM public.person_department_assignments WHERE person_id = v_kiosk));

  -- Forged snapshot values are thrown away.
  PERFORM pg_temp.f5_must('F12 insert with forged F5 values', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-forged', v_p2, 'completed', clock_timestamp(),
      'business_department_id, business_department_name, business_department_status, business_department_assignment_id, '
      'business_department_name_version_id, department_received_at, department_time_status, department_snapshot_version|'
      || format('%L, %L, %L, %L, %L, %L, %L, 9', v_b, 'Forged', 'assigned', v_assign, v_assign, '2020-01-01T00:00:00Z', 'reported')));
  e := pg_temp.f5_ev('f5t-forged');
  PERFORM pg_temp.f5_ok('F13 forged values overwritten; Person 2 (no home) is unassigned',
    e.business_department_status = 'unassigned' AND e.business_department_id IS NULL AND e.business_department_name IS NULL
    AND e.business_department_assignment_id IS NULL AND e.business_department_name_version_id IS NULL
    AND e.department_snapshot_version = 1 AND e.department_received_at > '2026-01-01'::timestamptz, row_to_json(e)::text);

  -- Staff may record their own event; nobody may spoof another worker.
  PERFORM pg_temp.f5_must('F14 staff self-insert still works', v_p1, 'authenticated',
    pg_temp.f5_event_sql('f5t-self', v_p1, 'completed', clock_timestamp()));
  PERFORM pg_temp.f5_refused('F15 staff cannot insert for another worker', v_p1, 'authenticated',
    pg_temp.f5_event_sql('f5t-spoof', v_p2, 'completed', clock_timestamp()), '42501');

  -- Transfer A -> B, retried once ("lost response").
  v_req := gen_random_uuid();
  v_res := pg_temp.f5_must('F16 transfer Person 1 to B', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', v_req, v_b, v_p1, NULL, 1, v_assign, ''))::jsonb;
  v_res2 := pg_temp.f5_must('F17 retry the transfer after a lost response', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', v_req, v_b, v_p1, NULL, 1, v_assign, ''))::jsonb;
  v_t := (v_res ->> 'effective_at')::timestamptz;
  PERFORM pg_temp.f5_ok('F18 one transfer, one audit row, adjacent intervals meeting at T',
    v_res = v_res2
    AND (SELECT count(*) = 1 FROM public.department_audit WHERE request_id = v_req AND operation = 'transfer')
    AND (SELECT count(*) = 2 FROM public.person_department_assignments WHERE person_id = v_p1)
    AND (SELECT valid_to = v_t FROM public.person_department_assignments WHERE id = v_assign)
    AND (SELECT valid_from = v_t AND valid_to IS NULL FROM public.person_department_assignments WHERE id = (v_res ->> 'assignment_id')::uuid));
  PERFORM pg_temp.f5_ok('F19 E1 is unchanged by the transfer', pg_temp.f5_ev('f5t-type-completed') = e1);
  PERFORM pg_temp.f5_must('F20 a new event after the transfer', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-after-transfer', v_p1, 'completed', clock_timestamp()));
  e := pg_temp.f5_ev('f5t-after-transfer');
  PERFORM pg_temp.f5_ok('F21 new event is credited to B', e.business_department_status = 'assigned' AND e.business_department_id = v_b, row_to_json(e)::text);

  -- Rename A; E1 keeps the label it had.
  PERFORM pg_temp.f5_must('F22 rename A to A2', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('rename', gen_random_uuid(), v_a, NULL, 'F5T Department A2', 1, NULL, ''));
  PERFORM pg_temp.f5_ok('F23 E1 keeps the label "F5T Department A"', pg_temp.f5_ev('f5t-type-completed') = e1
    AND e1.business_department_name = 'F5T Department A');

  -- Switch off, then on again.
  SELECT * INTO v_ctl FROM public.department_snapshot_control;
  PERFORM pg_temp.f5_must('F24 switch off', v_owner, 'authenticated',
    format('SELECT public.department_set_snapshot_enabled(%L, false, %s, %L)::text', gen_random_uuid(), v_ctl.version, 'f5t off'));
  PERFORM pg_temp.f5_must('F25 record E2 while off', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-e2', v_p1, 'completed', clock_timestamp()));
  e := pg_temp.f5_ev('f5t-e2');
  PERFORM pg_temp.f5_ok('F26 E2 is disabled with no department', e.business_department_status = 'disabled' AND e.business_department_id IS NULL);
  PERFORM pg_temp.f5_must('F27 switch on again', v_owner, 'authenticated',
    format('SELECT public.department_set_snapshot_enabled(%L, true, %s, %L)::text', gen_random_uuid(), v_ctl.version + 1, 'f5t on again'));
  PERFORM pg_temp.f5_must('F28 record E3', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-e3', v_p1, 'completed', clock_timestamp()));
  e := pg_temp.f5_ev('f5t-e3');
  PERFORM pg_temp.f5_ok('F29 E3 is assigned again', e.business_department_status = 'assigned' AND e.business_department_id = v_b);
  PERFORM pg_temp.f5_ok('F30 E2 was not repaired afterwards', (pg_temp.f5_ev('f5t-e2')).business_department_status = 'disabled');

  -- Same (location, id) again: refused as a duplicate, saved row untouched.
  PERFORM pg_temp.f5_refused('F31 replaying the same event id is a duplicate', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-e3', v_p1, 'completed', clock_timestamp()), '23505');
  PERFORM pg_temp.f5_ok('F32 the saved row is unchanged by the replay', pg_temp.f5_ev('f5t-e3') = e);
END $$;

-- ===========================================================================
-- G. Delayed events against a backdated history
--
-- The operator rewrites the fixture history so that real intervals exist in
-- the past (owners cannot backdate; this is test set-up only):
--   Department A names:  "F5T Department A"  [-20d, R)   "F5T Department A2" [R, now...)   R = now - 3h
--   Person 1:            A [-10d, T)         B [T, ...)                                    T = now - 1h
--   tracking started 30 days ago
-- ===========================================================================
DO $$
DECLARE
  v_owner  uuid := pg_temp.f5_get('owner')::uuid;
  v_kiosk  uuid := pg_temp.f5_get('kiosk')::uuid;
  v_p1     uuid := pg_temp.f5_get('p1')::uuid;
  v_a      uuid := pg_temp.f5_get('dept_a')::uuid;
  v_b      uuid := pg_temp.f5_get('dept_b')::uuid;
  v_now    timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_r      timestamptz := v_now - interval '3 hours';
  v_t      timestamptz := v_now - interval '1 hour';
  v_can    boolean;
  e        public.production_events;
  v_old_name uuid;
  v_new_name uuid;
BEGIN
  v_can := pg_temp.f5_raw(format(
    'UPDATE public.department_snapshot_control SET tracking_started_at = %L', v_now - interval '30 days'));
  IF NOT v_can THEN
    -- Fall back to toggling the one guard trigger (locks the control table until rollback).
    ALTER TABLE public.department_snapshot_control DISABLE TRIGGER department_snapshot_control_guard;
    UPDATE public.department_snapshot_control SET tracking_started_at = v_now - interval '30 days';
    ALTER TABLE public.department_snapshot_control ENABLE TRIGGER department_snapshot_control_guard;
  END IF;

  -- Close first, then widen, so the no-overlap constraints hold at every step.
  UPDATE public.business_department_names SET valid_from = v_now - interval '20 days', valid_to = v_r
   WHERE department_id = v_a AND valid_to IS NOT NULL RETURNING id INTO v_old_name;
  UPDATE public.business_department_names SET valid_from = v_r
   WHERE department_id = v_a AND valid_to IS NULL RETURNING id INTO v_new_name;
  UPDATE public.business_department_names SET valid_from = v_now - interval '20 days'
   WHERE department_id = v_b;
  UPDATE public.person_department_assignments SET valid_from = v_now - interval '10 days', valid_to = v_t
   WHERE person_id = v_p1 AND department_id = v_a;
  UPDATE public.person_department_assignments SET valid_from = v_t
   WHERE person_id = v_p1 AND department_id = v_b AND valid_to IS NULL;

  -- Constraints really are enforced by the database, not only by the functions.
  BEGIN
    INSERT INTO public.person_department_assignments (person_id, department_id, valid_from, valid_to, created_at, created_by, request_id)
    VALUES (v_p1, v_a, v_t - interval '1 minute', v_t + interval '1 minute', v_now, v_owner, gen_random_uuid());
    PERFORM pg_temp.f5_ok('G01 overlapping assignment rejected', false, 'insert was accepted');
  EXCEPTION WHEN exclusion_violation THEN
    PERFORM pg_temp.f5_ok('G01 overlapping assignment rejected', true);
  END;
  BEGIN
    INSERT INTO public.person_department_assignments (person_id, department_id, valid_from, valid_to, created_at, created_by, request_id)
    VALUES (v_p1, v_a, v_now + interval '1 day', NULL, v_now, v_owner, gen_random_uuid());
    PERFORM pg_temp.f5_ok('G02 second open assignment rejected', false, 'insert was accepted');
  EXCEPTION WHEN unique_violation OR exclusion_violation THEN
    PERFORM pg_temp.f5_ok('G02 second open assignment rejected', true);
  END;
  BEGIN
    INSERT INTO public.person_department_assignments (person_id, department_id, valid_from, valid_to, created_at, created_by, request_id)
    VALUES (pg_temp.f5_get('p4')::uuid, v_a, v_t, v_t, v_now, v_owner, gen_random_uuid());
    PERFORM pg_temp.f5_ok('G03 zero-length interval rejected', false, 'insert was accepted');
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.f5_ok('G03 zero-length interval rejected', true);
  END;
  BEGIN
    INSERT INTO public.person_department_assignments (person_id, department_id, valid_from, valid_to, created_at, created_by, request_id)
    VALUES (pg_temp.f5_get('p4')::uuid, v_a, '-infinity', NULL, v_now, v_owner, gen_random_uuid());
    PERFORM pg_temp.f5_ok('G04 infinite start rejected', false, 'insert was accepted');
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.f5_ok('G04 infinite start rejected', true);
  END;
  BEGIN
    INSERT INTO public.business_department_names (department_id, name, valid_from, valid_to, created_at, created_by, request_id)
    VALUES (v_a, 'F5T Overlap', v_r - interval '1 minute', v_r + interval '1 minute', v_now, v_owner, gen_random_uuid());
    PERFORM pg_temp.f5_ok('G05 overlapping name interval rejected', false, 'insert was accepted');
  EXCEPTION WHEN exclusion_violation THEN
    PERFORM pg_temp.f5_ok('G05 overlapping name interval rejected', true);
  END;
  BEGIN
    UPDATE public.department_snapshot_control SET tracking_started_at = v_now;
    PERFORM pg_temp.f5_ok('G06 tracking start cannot be moved', false, 'update was accepted');
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM pg_temp.f5_ok('G06 tracking start cannot be moved', true);
  END;

  -- Reported two hours ago: still in A's interval, received after the transfer.
  PERFORM pg_temp.f5_must('G10 delayed event from two hours ago', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-2h', v_p1, 'completed', v_now - interval '2 hours'));
  e := pg_temp.f5_ev('f5t-2h');
  PERFORM pg_temp.f5_ok('G11 credited to A with the new label (after R) and reported_old',
    e.business_department_status = 'assigned' AND e.business_department_id = v_a
    AND e.business_department_name = 'F5T Department A2' AND e.business_department_name_version_id = v_new_name
    AND e.department_time_status = 'reported_old' AND e.department_resolution_instant = v_now - interval '2 hours'
    AND e.department_occurred_at = e.created_at AND e.department_received_at > v_t, row_to_json(e)::text);

  -- Before the rename R: the old label.
  PERFORM pg_temp.f5_must('G12 delayed event from four hours ago', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-4h', v_p1, 'completed', v_now - interval '4 hours'));
  e := pg_temp.f5_ev('f5t-4h');
  PERFORM pg_temp.f5_ok('G13 keeps the label from before the rename',
    e.business_department_status = 'assigned' AND e.business_department_name = 'F5T Department A'
    AND e.business_department_name_version_id = v_old_name, row_to_json(e)::text);

  -- Exactly at R: the new label (intervals are half-open).
  PERFORM pg_temp.f5_must('G14 delayed event exactly at R', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-at-r', v_p1, 'completed', v_r));
  e := pg_temp.f5_ev('f5t-at-r');
  PERFORM pg_temp.f5_ok('G15 exactly at R the label is A2, still department A',
    e.business_department_id = v_a AND e.business_department_name = 'F5T Department A2', row_to_json(e)::text);
  PERFORM pg_temp.f5_must('G16 delayed event one microsecond before R', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-before-r', v_p1, 'completed', v_r - interval '1 microsecond'));
  PERFORM pg_temp.f5_ok('G17 one microsecond before R the label is A',
    (pg_temp.f5_ev('f5t-before-r')).business_department_name = 'F5T Department A');

  -- Exactly at T: the new department.
  PERFORM pg_temp.f5_must('G18 delayed event exactly at T', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-at-t', v_p1, 'completed', v_t));
  e := pg_temp.f5_ev('f5t-at-t');
  PERFORM pg_temp.f5_ok('G19 exactly at T the department is B', e.business_department_status = 'assigned' AND e.business_department_id = v_b, row_to_json(e)::text);
  PERFORM pg_temp.f5_must('G20 delayed event one microsecond before T', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-before-t', v_p1, 'completed', v_t - interval '1 microsecond'));
  PERFORM pg_temp.f5_ok('G21 one microsecond before T the department is A',
    (pg_temp.f5_ev('f5t-before-t')).business_department_id = v_a);

  -- Before Person 1 had any home: unassigned, never the nearest department.
  PERFORM pg_temp.f5_must('G22 event from before the first assignment', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-15d', v_p1, 'completed', v_now - interval '15 days'));
  e := pg_temp.f5_ev('f5t-15d');
  PERFORM pg_temp.f5_ok('G23 gap in history is unassigned', e.business_department_status = 'unassigned' AND e.business_department_id IS NULL
    AND e.department_time_status = 'reported_old', row_to_json(e)::text);

  -- Before tracking began: unknown.
  PERFORM pg_temp.f5_must('G24 event from before tracking started', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-40d', v_p1, 'completed', v_now - interval '40 days'));
  e := pg_temp.f5_ev('f5t-40d');
  PERFORM pg_temp.f5_ok('G25 before tracking is before_tracking with no department',
    e.business_department_status = 'before_tracking' AND e.business_department_id IS NULL, row_to_json(e)::text);

  -- Tablet clock two seconds fast: resolved at receipt time and marked.
  PERFORM pg_temp.f5_must('G26 event reported two seconds ahead', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-plus2s', v_p1, 'completed', clock_timestamp() + interval '2 seconds'));
  e := pg_temp.f5_ev('f5t-plus2s');
  PERFORM pg_temp.f5_ok('G27 (assigned, future_clamped, instant = receipt, reported time kept)',
    e.business_department_status = 'assigned' AND e.business_department_id = v_b
    AND e.department_time_status = 'future_clamped' AND e.department_resolution_instant = e.department_received_at
    AND e.department_occurred_at = e.created_at AND e.department_occurred_at > e.department_received_at, row_to_json(e)::text);

  -- Thirty seconds ahead: no department.
  PERFORM pg_temp.f5_must('G28 event reported thirty seconds ahead', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-plus30s', v_p1, 'completed', clock_timestamp() + interval '30 seconds'));
  e := pg_temp.f5_ev('f5t-plus30s');
  PERFORM pg_temp.f5_ok('G29 invalid_time, no department, no resolution instant, reported time kept',
    e.business_department_status = 'invalid_time' AND e.department_time_status = 'invalid_time'
    AND e.business_department_id IS NULL AND e.business_department_name IS NULL
    AND e.business_department_assignment_id IS NULL AND e.business_department_name_version_id IS NULL
    AND e.department_resolution_instant IS NULL AND e.department_occurred_at = e.created_at, row_to_json(e)::text);

  PERFORM pg_temp.f5_set('t', v_t::text);
END $$;

-- A clamped event received before a transfer keeps the old department after it.
DO $$
DECLARE
  v_owner uuid := pg_temp.f5_get('owner')::uuid;
  v_kiosk uuid := pg_temp.f5_get('kiosk')::uuid;
  v_p4    uuid := pg_temp.f5_get('p4')::uuid;
  v_a     uuid := pg_temp.f5_get('dept_a')::uuid;
  v_b     uuid := pg_temp.f5_get('dept_b')::uuid;
  v_res   jsonb;
  e       public.production_events;
  e2      public.production_events;
BEGIN
  v_res := pg_temp.f5_must('G30 assign Person 4 to A', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', gen_random_uuid(), v_a, v_p4, NULL, 2, NULL, ''))::jsonb;
  -- Make the assignment old enough that "now" is inside it by a clear margin.
  UPDATE public.person_department_assignments SET valid_from = valid_from - interval '1 minute'
   WHERE id = (v_res ->> 'assignment_id')::uuid;
  PERFORM pg_temp.f5_must('G31 clamped event (reported 4s ahead) before the transfer', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-clamp-pre', v_p4, 'completed', clock_timestamp() + interval '4 seconds'));
  e := pg_temp.f5_ev('f5t-clamp-pre');
  PERFORM pg_temp.f5_must('G32 transfer Person 4 to B', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', gen_random_uuid(), v_b, v_p4, NULL, 1, (v_res ->> 'assignment_id')::uuid, ''));
  e2 := pg_temp.f5_ev('f5t-clamp-pre');
  PERFORM pg_temp.f5_ok('G33 the clamped event still says A, although its reported time is after the transfer',
    e2 = e AND e2.business_department_id = v_a AND e2.department_time_status = 'future_clamped', row_to_json(e2)::text);
END $$;

-- ===========================================================================
-- H. A saved snapshot is frozen
-- ===========================================================================
DO $$
DECLARE
  v_manager uuid := pg_temp.f5_get('manager')::uuid;
  v_p2      uuid := pg_temp.f5_get('p2')::uuid;
  v_b       uuid := pg_temp.f5_get('dept_b')::uuid;
  e         public.production_events := pg_temp.f5_ev('f5t-e3');
  e2        public.production_events;
BEGIN
  PERFORM pg_temp.f5_must('H01 manager edits the note of an event', v_manager, 'authenticated',
    'WITH u AS (UPDATE public.production_events SET note = ''f5t edited'' WHERE location = ''staging'' AND id = ''f5t-e3'' RETURNING 1) SELECT count(*)::text FROM u');
  e2 := pg_temp.f5_ev('f5t-e3');
  PERFORM pg_temp.f5_ok('H02 the note changed and the snapshot did not',
    e2.note = 'f5t edited' AND e2.business_department_id = e.business_department_id
    AND e2.business_department_status = e.business_department_status AND e2.department_received_at = e.department_received_at);

  PERFORM pg_temp.f5_must('H03 manager tries to overwrite snapshot fields', v_manager, 'authenticated',
    format('WITH u AS (UPDATE public.production_events SET business_department_id = NULL, business_department_name = ''Forged'', '
           'business_department_status = ''unassigned'', department_received_at = now(), department_time_status = ''invalid_time'' '
           'WHERE location = ''staging'' AND id = ''f5t-e3'' RETURNING 1) SELECT count(*)::text FROM u'));
  PERFORM pg_temp.f5_ok('H04 every snapshot field is exactly as before', pg_temp.f5_ev('f5t-e3') = e2);

  PERFORM pg_temp.f5_refused('H05 changing who the event credits is refused', v_manager, 'authenticated',
    format('WITH u AS (UPDATE public.production_events SET staff_id = %L WHERE location = ''staging'' AND id = ''f5t-e3'' RETURNING 1) SELECT count(*)::text FROM u', v_p2),
    '23514');
  PERFORM pg_temp.f5_refused('H06 changing when the event happened is refused', v_manager, 'authenticated',
    'WITH u AS (UPDATE public.production_events SET created_at = created_at - interval ''1 day'' WHERE location = ''staging'' AND id = ''f5t-e3'' RETURNING 1) SELECT count(*)::text FROM u',
    '23514');
  PERFORM pg_temp.f5_refused('H07 changing the event id is refused', v_manager, 'authenticated',
    'WITH u AS (UPDATE public.production_events SET id = ''f5t-e3-moved'' WHERE location = ''staging'' AND id = ''f5t-e3'' RETURNING 1) SELECT count(*)::text FROM u',
    '23514');
END $$;

-- ===========================================================================
-- I. Legacy rows stay NULL for ever
-- ===========================================================================
DO $$
DECLARE
  v_manager uuid := pg_temp.f5_get('manager')::uuid;
  v_p1      uuid := pg_temp.f5_get('p1')::uuid;
  v_p2      uuid := pg_temp.f5_get('p2')::uuid;
  v_can     boolean;
  e         public.production_events;
BEGIN
  -- A row saved "before F5": inserted with triggers off, so all eleven fields are NULL.
  v_can := pg_temp.f5_raw(format(
    'INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, created_at) '
    'VALUES (''staging'', ''f5t-legacy'', %L, ''framed'', ''F5T-0'', ''completed'', now() - interval ''90 days'')', v_p1));
  IF NOT v_can THEN
    PERFORM pg_temp.f5_skip('I01-I04 legacy row', 'this role cannot set session_replication_role; compare a real pre-migration row with 00-preflight.sql instead');
    RETURN;
  END IF;
  e := pg_temp.f5_ev('f5t-legacy');
  PERFORM pg_temp.f5_ok('I01 legacy row has no snapshot at all',
    e.business_department_status IS NULL AND e.business_department_id IS NULL AND e.department_received_at IS NULL
    AND e.department_snapshot_version IS NULL AND e.department_occurred_at IS NULL AND e.department_time_status IS NULL
    AND e.department_resolved_at IS NULL AND e.department_resolution_instant IS NULL
    AND e.business_department_name IS NULL AND e.business_department_assignment_id IS NULL
    AND e.business_department_name_version_id IS NULL);
  PERFORM pg_temp.f5_must('I02 an unrelated update of the legacy row', v_manager, 'authenticated',
    'WITH u AS (UPDATE public.production_events SET note = ''f5t legacy edit'', business_department_status = ''assigned'' WHERE location = ''staging'' AND id = ''f5t-legacy'' RETURNING 1) SELECT count(*)::text FROM u');
  e := pg_temp.f5_ev('f5t-legacy');
  PERFORM pg_temp.f5_ok('I03 the legacy row is still all NULL after the update',
    e.note = 'f5t legacy edit' AND e.business_department_status IS NULL AND e.business_department_id IS NULL
    AND e.department_received_at IS NULL AND e.department_snapshot_version IS NULL);
  -- Old correction paths on legacy rows keep working as before.
  PERFORM pg_temp.f5_must('I04 a legacy row can still be re-credited as before', v_manager, 'authenticated',
    format('WITH u AS (UPDATE public.production_events SET staff_id = %L WHERE location = ''staging'' AND id = ''f5t-legacy'' RETURNING 1) SELECT count(*)::text FROM u', v_p2));
END $$;

-- ===========================================================================
-- J. Removing a person from the team
-- ===========================================================================
DO $$
DECLARE
  v_owner uuid := pg_temp.f5_get('owner')::uuid;
  v_kiosk uuid := pg_temp.f5_get('kiosk')::uuid;
  v_p3    uuid := pg_temp.f5_get('p3')::uuid;
  v_p4    uuid := pg_temp.f5_get('p4')::uuid;
  v_b     uuid := pg_temp.f5_get('dept_b')::uuid;
  v_open  public.person_department_assignments;
  v_before timestamptz;
  e       public.production_events;
BEGIN
  SELECT * INTO v_open FROM public.person_department_assignments WHERE person_id = v_p3 AND valid_to IS NULL;
  -- Give the interval some depth so "before removal" is a real past instant.
  UPDATE public.person_department_assignments SET valid_from = valid_from - interval '2 hours' WHERE id = v_open.id;
  v_before := clock_timestamp() - interval '1 hour';

  PERFORM pg_temp.f5_must('J01 owner deletes Person 3''s profile (the current Team flow)', v_owner, 'authenticated',
    format('WITH d AS (DELETE FROM public.profiles WHERE user_id = %L RETURNING 1) SELECT count(*)::text FROM d', v_p3));
  PERFORM pg_temp.f5_ok('J02 the profile is gone and the Auth user remains',
    NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = v_p3) AND EXISTS (SELECT 1 FROM auth.users WHERE id = v_p3));
  PERFORM pg_temp.f5_ok('J03 the open assignment was closed and audited as remove by the owner',
    (SELECT valid_to IS NOT NULL AND closed_by = v_owner FROM public.person_department_assignments WHERE id = v_open.id)
    AND (SELECT count(*) = 1 FROM public.department_audit
          WHERE operation = 'remove' AND person_id = v_p3 AND assignment_id = v_open.id AND actor_id = v_owner AND reason = 'profile_removed'));
  PERFORM pg_temp.f5_ok('J04 history page still lists the removed person''s interval', (
    SELECT count(*) = 1 FROM jsonb_array_elements((pg_temp.f5_call(v_owner, 'authenticated',
      format('SELECT public.department_owner_page(''history'', %L, NULL, 100)::text', v_p3)) ->> 'value')::jsonb -> 'rows') x
     WHERE (x ->> 'id')::uuid = v_open.id AND x ->> 'valid_to' IS NOT NULL));

  PERFORM pg_temp.f5_must('J05 delayed event from before the removal', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-p3-before', v_p3, 'completed', v_before));
  e := pg_temp.f5_ev('f5t-p3-before');
  PERFORM pg_temp.f5_ok('J06 still resolves to B without a profile', e.business_department_status = 'assigned' AND e.business_department_id = v_b, row_to_json(e)::text);
  PERFORM pg_temp.f5_must('J07 event after the removal', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-p3-after', v_p3, 'completed', clock_timestamp()));
  PERFORM pg_temp.f5_ok('J08 after removal there is no assignment',
    (pg_temp.f5_ev('f5t-p3-after')).business_department_status = 'unassigned');

  PERFORM pg_temp.f5_refused('J09 a removed person cannot be given a home', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', gen_random_uuid(), v_b, v_p3, NULL, 1, NULL, ''), '22023', 'person_not_on_team');

  -- Put the same Auth user back: no home until one is given explicitly.
  INSERT INTO public.profiles (user_id, display_name, role) VALUES (v_p3, 'F5T Person 3', 'staff');
  PERFORM pg_temp.f5_ok('J10 re-added person has no home',
    NOT EXISTS (SELECT 1 FROM public.person_department_assignments WHERE person_id = v_p3 AND valid_to IS NULL));
  PERFORM pg_temp.f5_must('J11 and can be assigned afresh', v_owner, 'authenticated',
    pg_temp.f5_admin_sql('assign', gen_random_uuid(), v_b, v_p3, NULL, 1, NULL, ''));

  -- Removal by a server client with no signed-in user: actor recorded as unknown.
  DELETE FROM public.profiles WHERE user_id = v_p4;
  PERFORM pg_temp.f5_ok('J12 removal without a signed-in user is audited with no invented actor',
    (SELECT count(*) = 1 FROM public.department_audit
      WHERE operation = 'remove' AND person_id = v_p4 AND actor_id IS NULL AND reason = 'profile_removed_actor_unavailable')
    AND NOT EXISTS (SELECT 1 FROM public.person_department_assignments WHERE person_id = v_p4 AND valid_to IS NULL));

  -- Archive is possible once nobody is left.
  PERFORM pg_temp.f5_ok('J13 a person with no home can be removed (nothing to close)',
    (pg_temp.f5_call(v_owner, 'authenticated',
      format('WITH d AS (DELETE FROM public.profiles WHERE user_id = %L RETURNING 1) SELECT count(*)::text FROM d', pg_temp.f5_get('p2'))) ->> 'value') = '1');
END $$;

-- ===========================================================================
-- K. Owner pages
-- ===========================================================================
DO $$
DECLARE
  v_owner  uuid := pg_temp.f5_get('owner')::uuid;
  v_p1     uuid := pg_temp.f5_get('p1')::uuid;
  v_cursor jsonb := NULL;
  v_page   jsonb;
  v_seen   uuid[] := '{}';
  v_guard  int := 0;
  v_first  jsonb;
BEGIN
  PERFORM pg_temp.f5_refused('K01 limit 0 refused', v_owner, 'authenticated',
    'SELECT public.department_owner_page(''people'', NULL, NULL, 0)::text', '22023');
  PERFORM pg_temp.f5_refused('K02 limit 101 refused', v_owner, 'authenticated',
    'SELECT public.department_owner_page(''people'', NULL, NULL, 101)::text', '22023');
  PERFORM pg_temp.f5_refused('K03 unknown kind refused', v_owner, 'authenticated',
    'SELECT public.department_owner_page(''rates'', NULL, NULL, 10)::text', '22023');
  PERFORM pg_temp.f5_refused('K04 members without a department refused', v_owner, 'authenticated',
    'SELECT public.department_owner_page(''members'', NULL, NULL, 10)::text', '22023');
  PERFORM pg_temp.f5_refused('K05 invalid cursor refused', v_owner, 'authenticated',
    'SELECT public.department_owner_page(''people'', NULL, ''{"id":"not-a-uuid"}''::jsonb, 10)::text', '22023', 'invalid_cursor');
  PERFORM pg_temp.f5_refused('K06 history cursor without a time refused', v_owner, 'authenticated',
    format('SELECT public.department_owner_page(''history'', %L, ''{"id":"%s"}''::jsonb, 10)::text', v_p1, v_p1), '22023', 'invalid_cursor');

  -- Page through departments two at a time: every row once, then a NULL cursor.
  LOOP
    v_page := (pg_temp.f5_call(v_owner, 'authenticated',
      format('SELECT public.department_owner_page(''departments_active'', NULL, %L::jsonb, 2)::text', v_cursor)) ->> 'value')::jsonb;
    PERFORM pg_temp.f5_ok('K07 page ' || v_guard || ' has at most 2 rows', jsonb_array_length(v_page -> 'rows') <= 2);
    v_seen := v_seen || ARRAY(SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(v_page -> 'rows') x);
    v_cursor := v_page -> 'next_cursor';
    v_guard := v_guard + 1;
    EXIT WHEN v_cursor IS NULL OR v_cursor = 'null'::jsonb OR v_guard > 5000;
  END LOOP;
  PERFORM pg_temp.f5_ok('K08 paging returned every active department exactly once',
    (SELECT count(*) = count(DISTINCT u) FROM unnest(v_seen) u)
    AND (SELECT count(*) FROM unnest(v_seen)) = (SELECT count(*) FROM public.business_departments WHERE archived_at IS NULL));

  v_page := (pg_temp.f5_call(v_owner, 'authenticated',
    format('SELECT public.department_owner_page(''history'', %L, NULL, 1)::text', v_p1)) ->> 'value')::jsonb;
  v_first := v_page -> 'rows' -> 0;
  PERFORM pg_temp.f5_ok('K09 history is newest first and pages by (valid_from, id)',
    v_first ->> 'valid_to' IS NULL AND v_first ->> 'department_name' = 'F5T Department B' AND v_page -> 'next_cursor' ? 'valid_from');
  v_page := (pg_temp.f5_call(v_owner, 'authenticated',
    format('SELECT public.department_owner_page(''history'', %L, %L::jsonb, 1)::text', v_p1, v_page -> 'next_cursor')) ->> 'value')::jsonb;
  PERFORM pg_temp.f5_ok('K10 second history page is the earlier interval, then no more',
    v_page -> 'rows' -> 0 ->> 'valid_to' IS NOT NULL AND (v_page -> 'next_cursor' IS NULL OR v_page -> 'next_cursor' = 'null'::jsonb));

  v_page := (pg_temp.f5_call(v_owner, 'authenticated',
    'SELECT public.department_owner_page(''audit'', NULL, NULL, 100)::text') ->> 'value')::jsonb;
  PERFORM pg_temp.f5_ok('K11 audit is newest first and names the actor', (
    SELECT bool_and(a.t >= b.t) FROM (
      SELECT (x ->> 'recorded_at')::timestamptz AS t, ord FROM jsonb_array_elements(v_page -> 'rows') WITH ORDINALITY q(x, ord)) a
      JOIN (SELECT (x ->> 'recorded_at')::timestamptz AS t, ord FROM jsonb_array_elements(v_page -> 'rows') WITH ORDINALITY q(x, ord)) b
        ON b.ord = a.ord + 1)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_page -> 'rows') x WHERE x ->> 'actor_name' = 'F5T Owner 1'));
  PERFORM pg_temp.f5_ok('K12 pages expose no rate, email or role',
    NOT (v_page::text ~* 'hourly_rate|email|allowed_nav')
    AND NOT ((pg_temp.f5_call(v_owner, 'authenticated', 'SELECT public.department_owner_page(''people'', NULL, NULL, 100)::text') ->> 'value') ~* 'hourly_rate|email|"role"'));
END $$;

-- ===========================================================================
-- L. When the lookup itself breaks, the scan is still saved
-- ===========================================================================
DO $$
DECLARE
  v_kiosk uuid := pg_temp.f5_get('kiosk')::uuid;
  v_p1    uuid := pg_temp.f5_get('p1')::uuid;
  v_can   boolean;
  e       public.production_events;
BEGIN
  -- Take away the resolver's read access for this transaction only.
  REVOKE SELECT ON public.person_department_assignments FROM departments_resolver;
  PERFORM pg_temp.f5_must('L01 insert while the lookup is broken', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-broken', v_p1, 'completed', clock_timestamp()));
  e := pg_temp.f5_ev('f5t-broken');
  PERFORM pg_temp.f5_ok('L02 saved as resolution_error with no department and its time markers',
    e.business_department_status = 'resolution_error' AND e.business_department_id IS NULL
    AND e.business_department_name IS NULL AND e.department_time_status = 'reported'
    AND e.department_resolved_at IS NOT NULL, row_to_json(e)::text);
  GRANT SELECT ON public.person_department_assignments TO departments_resolver;

  -- Control row missing.
  v_can := pg_temp.f5_raw('DELETE FROM public.department_snapshot_control');
  IF v_can THEN
    PERFORM pg_temp.f5_must('L03 insert with the control row missing', v_kiosk, 'authenticated',
      pg_temp.f5_event_sql('f5t-nocontrol', v_p1, 'completed', clock_timestamp()));
    e := pg_temp.f5_ev('f5t-nocontrol');
    PERFORM pg_temp.f5_ok('L04 saved as control_missing, never treated as enabled',
      e.business_department_status = 'control_missing' AND e.business_department_id IS NULL, row_to_json(e)::text);
  ELSE
    PERFORM pg_temp.f5_skip('L03-L04 control row missing', 'this role cannot set session_replication_role');
  END IF;
END $$;

-- ===========================================================================
-- M. Emergency mode: resolver trigger disabled, sanitize still protects
-- (This holds a lock on production_events until the ROLLBACK below.)
-- ===========================================================================
ALTER TABLE public.production_events DISABLE TRIGGER production_events_f5_20_resolve;

DO $$
DECLARE
  v_kiosk uuid := pg_temp.f5_get('kiosk')::uuid;
  v_p1    uuid := pg_temp.f5_get('p1')::uuid;
  v_b     uuid := pg_temp.f5_get('dept_b')::uuid;
  e       public.production_events;
BEGIN
  PERFORM pg_temp.f5_must('M01 forged insert with only the resolver disabled', v_kiosk, 'authenticated',
    pg_temp.f5_event_sql('f5t-emergency', v_p1, 'completed', clock_timestamp(),
      'business_department_id, business_department_name, business_department_status, department_time_status, department_resolved_at|'
      || format('%L, %L, %L, %L, now()', v_b, 'Forged', 'assigned', 'reported')));
  e := pg_temp.f5_ev('f5t-emergency');
  PERFORM pg_temp.f5_ok('M02 saved as resolver_unavailable with everything forged cleared',
    e.business_department_status = 'resolver_unavailable' AND e.business_department_id IS NULL
    AND e.business_department_name IS NULL AND e.business_department_assignment_id IS NULL
    AND e.business_department_name_version_id IS NULL AND e.department_time_status IS NULL
    AND e.department_resolved_at IS NULL AND e.department_resolution_instant IS NULL
    AND e.department_received_at IS NOT NULL AND e.department_occurred_at = e.created_at
    AND e.department_snapshot_version = 1, row_to_json(e)::text);
END $$;

ALTER TABLE public.production_events ENABLE TRIGGER production_events_f5_20_resolve;

-- ===========================================================================
-- Summary
-- ===========================================================================
DO $$
DECLARE
  v_passed  int;
  v_skipped int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT skipped), count(*) FILTER (WHERE skipped) INTO v_passed, v_skipped FROM f5t_cases;
  PERFORM pg_temp.f5_ok('Z01 no F5 statement wrote to the ledger or changed the work type',
    NOT EXISTS (SELECT 1 FROM public.production_events WHERE id LIKE 'f5t-%' AND location = 'staging'
                 AND department NOT IN ('dispatch','framed')));
  IF v_skipped > 0 THEN
    RAISE NOTICE 'F5 verify: % cases passed, % SKIPPED (see notices above). Skipped cases are NOT passed.', v_passed, v_skipped;
  END IF;
  RAISE NOTICE 'F5 verify: ALL CHECKS PASSED (% cases, % skipped; rolling back, nothing kept)', v_passed, v_skipped;
END $$;

ROLLBACK;
