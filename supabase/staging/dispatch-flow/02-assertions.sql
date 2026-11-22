-- F7 dispatch flow: database assertions (single session).
--
-- STAGING ONLY. Never run against production. Refuses to start unless the
-- database has a location with key 'staging'. Requires 0047, 0052-0056.
--
-- Everything runs in ONE transaction that ends with ROLLBACK: nothing is
-- kept. It creates synthetic people (ids f7700000-...), badges F77E000n,
-- products "f7t-*", a temporary active rule set and orders 109770nn. While it
-- runs, the staging site's packaging mode is set to auto and any active rule
-- set is retired (both rolled back).
--
-- Pass = final notice "F7 verify: ALL CHECKS PASSED (N cases ...)". Any
-- failure raises "F7 verify FAILED [<case>] ..." naming the case.
--
-- Two-session races are in 05-session-a.sql / 05-session-b.sql.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') THEN
    RAISE EXCEPTION 'F7 verify: no location "staging" in this database. Refusing to run: staging only.';
  END IF;
END $$;

CREATE TEMP TABLE f7t_cases (name text PRIMARY KEY) ON COMMIT DROP;

CREATE FUNCTION pg_temp.f7_ok(p_case text, p_ok boolean, p_detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'F7 verify FAILED [%] %', p_case, coalesce(p_detail, '');
  END IF;
  INSERT INTO f7t_cases (name) VALUES (p_case);
END $$;

-- Run one statement as a database role + signed-in user (NULL = nobody).
CREATE FUNCTION pg_temp.f7_call(p_uid uuid, p_dbrole text, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
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

CREATE FUNCTION pg_temp.f7_must(p_case text, p_uid uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  r jsonb := pg_temp.f7_call(p_uid, 'authenticated', p_sql);
BEGIN
  PERFORM pg_temp.f7_ok(p_case, r ->> 'state' = '00000', format('expected success, got %s %s', r ->> 'state', r ->> 'message'));
  RETURN (r ->> 'value')::jsonb;
END $$;

CREATE FUNCTION pg_temp.f7_refused(p_case text, p_uid uuid, p_dbrole text, p_sql text, p_state text, p_message text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb := pg_temp.f7_call(p_uid, p_dbrole, p_sql);
BEGIN
  PERFORM pg_temp.f7_ok(p_case,
    r ->> 'state' = p_state AND (p_message IS NULL OR position(p_message IN r ->> 'message') > 0),
    format('expected %s %s, got %s %s (value %s)', p_state, coalesce(p_message, ''), r ->> 'state', r ->> 'message', r ->> 'value'));
END $$;

-- Run one statement as the session's own (owner) role; returns the error text or ''.
CREATE FUNCTION pg_temp.f7_try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN '';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ' ' || SQLERRM;
END $$;

CREATE FUNCTION pg_temp.f7_expect(p_expect uuid) RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN p_expect IS NULL THEN 'auth.uid()' ELSE quote_literal(p_expect) || '::uuid' END
$$;

CREATE FUNCTION pg_temp.f7_activate_sql(p_req uuid, p_badge text, p_scanner text DEFAULT 'S1', p_expect uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.scanner_activate_dispatch(%L, %L, %L, %L, %L, %s)::text', 'staging', p_req, 'f7t-desk', p_scanner, p_badge, pg_temp.f7_expect(p_expect))
$$;

CREATE FUNCTION pg_temp.f7_evidence_sql(p_order text, p_lines jsonb, p_expect uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.scanner_dispatch_evidence(%L, %L, %L, %s)::text', 'staging', p_order, p_lines, pg_temp.f7_expect(p_expect))
$$;

CREATE FUNCTION pg_temp.f7_dispatch_sql(p_req uuid, p_staff uuid, p_badge text, p_order text, p_at timestamptz, p_items int,
                                        p_lines jsonb, p_comps jsonb DEFAULT '[]', p_pack jsonb DEFAULT NULL,
                                        p_choices jsonb DEFAULT '[]', p_expect uuid DEFAULT NULL)
RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.scanner_commit_dispatch(%L, %L, %L, %L, %L, %L, %L, %L, %s, %L, %L, %L, %L, %s)::text',
                'staging', p_req, 'f7t-desk', 'S1', p_staff, p_badge, p_order, p_at, p_items, p_lines, p_comps, p_pack,
                p_choices, pg_temp.f7_expect(p_expect))
$$;

-- Does this session hold the per-order advisory lock (production_order_lock_ key)?
CREATE FUNCTION pg_temp.f7_holds_order_lock(p_order text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_locks l,
           (SELECT hashtextextended('prod-order|staging|' || p_order, 0) AS k) h
    WHERE  l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted AND l.objsubid = 1
      AND  l.classid::text::bigint = ((h.k >> 32) & 4294967295)
      AND  l.objid::text::bigint = (h.k & 4294967295))
$$;

CREATE FUNCTION pg_temp.f7_on_hand(p_id text) RETURNS numeric LANGUAGE sql AS $$

  SELECT current_on_hand FROM public.products WHERE location = 'staging' AND id = p_id
$$;

-- Everything a dispatch can write for an order, as one comparable row.
CREATE FUNCTION pg_temp.f7_footprint(p_order text) RETURNS text LANGUAGE sql AS $$
  SELECT format('events=%s ledger=%s picks=%s attributions=%s receipts=%s',
    (SELECT count(*) FROM public.production_events WHERE location = 'staging' AND order_number = p_order),
    (SELECT count(*) FROM public.ledger WHERE location = 'staging' AND source_id LIKE 'prod:order_' || p_order || ':%'),
    (SELECT count(*) FROM public.packaging_picks WHERE location = 'staging' AND order_number = p_order),
    (SELECT count(*) FROM public.dispatch_framer_attributions WHERE location = 'staging' AND order_number = p_order),
    (SELECT count(*) FROM public.dispatch_requests WHERE location = 'staging' AND order_number = p_order))
$$;

-- A classic-style framing event (as the postgres owner; the classic app inserts directly).
CREATE FUNCTION pg_temp.f7_event(p_id text, p_staff uuid, p_dept text, p_order text, p_type text, p_sku text, p_qty int,
                                 p_at timestamptz, p_parent text DEFAULT NULL, p_cs text DEFAULT NULL, p_loc text DEFAULT 'staging')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type,
                                        station_id, note, created_at, parent_event_id, cs_case_id)
  VALUES (p_loc, p_id, p_staff, p_dept, p_order, p_sku, p_qty, p_type, 'f7t', 'F7 verify', p_at, p_parent, p_cs)
$$;

-- ===========================================================================
-- Fixtures (all rolled back)
-- ===========================================================================
DO $$
DECLARE
  v_other text := (SELECT key FROM public.locations WHERE key <> 'staging' ORDER BY key LIMIT 1);
  v_ids   uuid[] := ARRAY[
    'f7700000-0000-4000-8000-0000000000f1', 'f7700000-0000-4000-8000-0000000000d1', 'f7700000-0000-4000-8000-0000000000d2',
    'f7700000-0000-4000-8000-0000000000e1', 'f7700000-0000-4000-8000-0000000000c1', 'f7700000-0000-4000-8000-0000000000d3',
    'f7700000-0000-4000-8000-000000000001', 'f7700000-0000-4000-8000-000000000002', 'f7700000-0000-4000-8000-000000000003',
    'f7700000-0000-4000-8000-000000000004', 'f7700000-0000-4000-8000-000000000005']::uuid[];
  v_names text[] := ARRAY['F7T Owner','F7T Manager','F7T Kiosk','F7T Staff','F7T CS','F7T Kiosk Other',
                          'F7T Framer 1','F7T Framer 2','F7T Other Site','F7T Inactive','F7T Dispatcher'];
  v_roles text[] := ARRAY['owner','manager','kiosk','staff','cs','kiosk','staff','staff','staff','staff','staff'];
  v_version int;
BEGIN
  IF v_other IS NULL THEN RAISE EXCEPTION 'F7 verify: needs a second location besides staging'; END IF;
  IF EXISTS (SELECT 1 FROM public.staff_barcodes WHERE barcode LIKE 'F77E000_')
     OR EXISTS (SELECT 1 FROM public.production_events WHERE location = 'staging' AND order_number LIKE '109770__')
     OR EXISTS (SELECT 1 FROM public.ledger WHERE location = 'staging' AND source_id LIKE 'prod:order_109770%')
     OR EXISTS (SELECT 1 FROM public.products WHERE location = 'staging' AND id LIKE 'f7t-%') THEN
    RAISE EXCEPTION 'F7 verify: synthetic ids already in use on staging; investigate before running';
  END IF;

  FOR i IN 1 .. array_length(v_ids, 1) LOOP
    INSERT INTO auth.users (id, email) VALUES (v_ids[i], 'f7t-' || i || '@inka-staging.test');
    INSERT INTO public.profiles (user_id, display_name, role) VALUES (v_ids[i], v_names[i], v_roles[i])
      ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role;
    IF i NOT IN (6, 9) THEN
      INSERT INTO public.user_locations (user_id, location) VALUES (v_ids[i], 'staging') ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  INSERT INTO public.user_locations (user_id, location) VALUES (v_ids[6], v_other), (v_ids[9], v_other) ON CONFLICT DO NOTHING;

  INSERT INTO public.staff_barcodes (location, barcode, user_id, display_name, active) VALUES
    ('staging', 'F77E0001', v_ids[7],  'F7T Framer 1', true),
    ('staging', 'F77E0002', v_ids[8],  'F7T Framer 2', true),
    ('staging', 'F77E0004', v_ids[10], 'F7T Inactive', false),
    ('staging', 'F77E0005', v_ids[11], 'F7T Dispatcher', true);
  INSERT INTO public.staff_barcodes (location, barcode, user_id, display_name, active) VALUES
    (v_other, 'F77E0003', v_ids[9], 'F7T Other Site', true);

  INSERT INTO public.products (location, id, code, supplier, product_type, current_on_hand) VALUES
    ('staging', 'f7t-a2b',   'F7T-A2B',   'F7T', 'product', 20),
    ('staging', 'f7t-a0b',   'F7T-A0B',   'F7T', 'product', 20),
    ('staging', 'f7t-hook',  'F7T-HOOK',  'F7T', 'product', 20),
    ('staging', 'f7t-box',   'F7T-BOX',   'F7T', 'packaging', 20),
    ('staging', 'f7t-a0box', 'F7T-A0BOX', 'F7T', 'packaging', 20);

  INSERT INTO public.packaging_settings (location, mode) VALUES ('staging', 'auto')
    ON CONFLICT (location) DO UPDATE SET mode = 'auto';
  UPDATE public.packaging_rule_sets SET status = 'retired' WHERE location = 'staging' AND status = 'active';
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM public.packaging_rule_sets WHERE location = 'staging';
  INSERT INTO public.packaging_rule_sets (location, id, version, status, body) VALUES ('staging', 'f7t-rs', v_version, 'active',
    jsonb_build_object('schema_version', 1,
      'catalogue', jsonb_build_array(
        jsonb_build_object('key', 'F7TBOX', 'product_id', 'f7t-box', 'label', 'F7T box', 'packing_points', jsonb_build_array('dispatch')),
        jsonb_build_object('key', 'F7TA0BOX', 'product_id', 'f7t-a0box', 'label', 'F7T A0 box', 'packing_points', jsonb_build_array('a0_framed'))),
      'rules', '[]'::jsonb, 'examples', '[]'::jsonb));
END $$;

CREATE TEMP TABLE f7t_ids ON COMMIT DROP AS SELECT
  'f7700000-0000-4000-8000-0000000000f1'::uuid AS owner, 'f7700000-0000-4000-8000-0000000000d1'::uuid AS manager,
  'f7700000-0000-4000-8000-0000000000d2'::uuid AS kiosk, 'f7700000-0000-4000-8000-0000000000e1'::uuid AS staff,
  'f7700000-0000-4000-8000-0000000000c1'::uuid AS cs,    'f7700000-0000-4000-8000-0000000000d3'::uuid AS kiosk_other,
  'f7700000-0000-4000-8000-000000000001'::uuid AS f1,    'f7700000-0000-4000-8000-000000000002'::uuid AS f2,
  'f7700000-0000-4000-8000-000000000003'::uuid AS other_site, 'f7700000-0000-4000-8000-000000000004'::uuid AS inactive,
  'f7700000-0000-4000-8000-000000000005'::uuid AS disp,
  (SELECT version FROM public.packaging_rule_sets WHERE location = 'staging' AND id = 'f7t-rs') AS rs_version;

-- ===========================================================================
-- A. Privileges and roles
-- ===========================================================================
DO $$
DECLARE
  i f7t_ids%ROWTYPE;
  v_line jsonb := '[{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]';
BEGIN
  SELECT * INTO i FROM f7t_ids;
  PERFORM pg_temp.f7_refused('A01 anon cannot sign in for dispatch', NULL, 'anon', pg_temp.f7_activate_sql(gen_random_uuid(), 'F77E0005'), '42501');
  PERFORM pg_temp.f7_refused('A02 anon cannot read evidence', NULL, 'anon', pg_temp.f7_evidence_sql('10977001', v_line), '42501');
  PERFORM pg_temp.f7_refused('A03 anon cannot list people', NULL, 'anon', $q$SELECT public.scanner_dispatch_people('staging')::text$q$, '42501');
  PERFORM pg_temp.f7_refused('A04 anon cannot dispatch', NULL, 'anon',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977001', now(), 1, v_line), '42501');
  PERFORM pg_temp.f7_refused('A05 staff cannot dispatch', i.staff, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977001', now(), 1, v_line), 'P0001', 'scanner: forbidden_role');
  PERFORM pg_temp.f7_refused('A06 cs cannot read evidence', i.cs, 'authenticated', pg_temp.f7_evidence_sql('10977001', v_line), 'P0001', 'scanner: forbidden_role');
  PERFORM pg_temp.f7_refused('A07 staff cannot list people', i.staff, 'authenticated', $q$SELECT public.scanner_dispatch_people('staging')::text$q$, 'P0001', 'scanner: forbidden_role');
  PERFORM pg_temp.f7_refused('A08 kiosk of another site cannot dispatch here', i.kiosk_other, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977001', now(), 1, v_line), 'P0001', 'scanner: forbidden_location');
  PERFORM pg_temp.f7_refused('A09 commit as another account is refused (caller_mismatch)', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977001', now(), 1, v_line, '[]', NULL, '[]', i.manager), 'P0001', 'scanner: caller_mismatch');
  PERFORM pg_temp.f7_refused('A10 evidence as another account is refused', i.kiosk, 'authenticated',
    pg_temp.f7_evidence_sql('10977001', v_line, i.manager), 'P0001', 'scanner: caller_mismatch');
  PERFORM pg_temp.f7_refused('A11 activation as another account is refused', i.kiosk, 'authenticated',
    pg_temp.f7_activate_sql(gen_random_uuid(), 'F77E0005', 'S1', i.manager), 'P0001', 'scanner: caller_mismatch');
  PERFORM pg_temp.f7_refused('A12 the evidence reader is internal', i.kiosk, 'authenticated',
    format('SELECT public.dispatch_framing_evidence_(%L, %L, %L)::text', 'staging', '10977001', v_line), '42501');
  PERFORM pg_temp.f7_refused('A13 the person-name helper is internal', i.kiosk, 'authenticated',
    format('SELECT public.dispatch_active_person_name_(%L, %L)', 'staging', i.f1), '42501');
  PERFORM pg_temp.f7_refused('A14 no client insert of attributions', i.owner, 'authenticated',
    format($q$INSERT INTO public.dispatch_framer_attributions (location, id, request_id, dispatch_event_id, order_number, sku, work_type,
      quantity, source, person_id, display_name, dispatcher_id, recorded_by) VALUES ('staging','x',gen_random_uuid(),'e','10977001',
      'INKA-ABC0001-A2-FB','framed',1,'manual',%L,'n',%L,%L) RETURNING id$q$, i.f1, i.f1, i.owner), '42501');
  PERFORM pg_temp.f7_refused('A15 no client write of dispatch receipts', i.owner, 'authenticated',
    $q$DELETE FROM public.dispatch_requests RETURNING request_id::text$q$, '42501');
  PERFORM pg_temp.f7_ok('A16 people list: active members of the site only, ids and names',
    (pg_temp.f7_must('A16a kiosk lists people', i.kiosk, $q$SELECT public.scanner_dispatch_people('staging')::text$q$) -> 'people')
      @> jsonb_build_array(jsonb_build_object('person_id', i.f1, 'display_name', 'F7T Framer 1'))
    AND NOT (pg_temp.f7_must('A16b again', i.kiosk, $q$SELECT public.scanner_dispatch_people('staging')::text$q$)::text LIKE '%F7T Inactive%')
    AND NOT (pg_temp.f7_must('A16c again', i.kiosk, $q$SELECT public.scanner_dispatch_people('staging')::text$q$)::text LIKE '%F7T Other Site%')
    AND NOT (pg_temp.f7_must('A16d again', i.kiosk, $q$SELECT public.scanner_dispatch_people('staging')::text$q$) -> 'people' -> 0 ? 'barcode'));
END $$;

-- ===========================================================================
-- B. Dispatch badge sign-in
-- ===========================================================================
DO $$
DECLARE
  i f7t_ids%ROWTYPE;
  r jsonb;
  v_req uuid := gen_random_uuid();
  v_n int;
BEGIN
  SELECT * INTO i FROM f7t_ids;
  r := pg_temp.f7_must('B01 dispatcher signs in', i.kiosk, pg_temp.f7_activate_sql(v_req, 'F77E0005'));
  PERFORM pg_temp.f7_ok('B02 answer: person, name, clocked in, workday end',
    r ->> 'status' = 'activated' AND (r ->> 'person_id')::uuid = i.disp AND r ->> 'display_name' = 'F7T Dispatcher'
    AND (r ->> 'clocked_in')::boolean AND (r ->> 'workday_ends_at')::timestamptz > now()
    AND (r ->> 'workday_ends_at')::timestamptz <= now() + interval '25 hours', r::text);
  PERFORM pg_temp.f7_ok('B03 the new clock-in is dispatch work',
    (SELECT department FROM public.production_events WHERE location = 'staging' AND id = 'dsp-' || replace(v_req::text, '-', '') || '-ci') = 'dispatch');
  r := pg_temp.f7_must('B04 replay', i.kiosk, pg_temp.f7_activate_sql(v_req, 'F77E0005'));
  PERFORM pg_temp.f7_ok('B05 replay returns the stored answer', (r ->> 'replayed')::boolean AND (r ->> 'clocked_in')::boolean);
  r := pg_temp.f7_must('B06 second scanner, same workday', i.kiosk, pg_temp.f7_activate_sql(gen_random_uuid(), 'F77E0005', 'S2'));
  SELECT count(*) INTO v_n FROM public.production_events WHERE location = 'staging' AND staff_id = i.disp AND event_type = 'clock_in';
  PERFORM pg_temp.f7_ok('B07 one clock-in per person per workday', NOT (r ->> 'clocked_in')::boolean AND v_n = 1, format('%s clock-ins', v_n));
  -- Framer 1 already clocked in through a framing badge: dispatch sign-in never rewrites it.
  PERFORM pg_temp.f7_must('B08 framing sign-in first', i.kiosk,
    format('SELECT public.scanner_activate_badge(%L, %L, %L, %L, %L, auth.uid())::text', 'staging', gen_random_uuid(), 'f7t-wall', 'S1', 'F77E0001'));
  r := pg_temp.f7_must('B09 then dispatch sign-in', i.kiosk, pg_temp.f7_activate_sql(gen_random_uuid(), 'F77E0001'));
  PERFORM pg_temp.f7_ok('B10 no second clock-in; the framing clock-in is unchanged',
    NOT (r ->> 'clocked_in')::boolean
    AND (SELECT count(*) FROM public.production_events WHERE location = 'staging' AND staff_id = i.f1 AND event_type = 'clock_in') = 1
    AND (SELECT department FROM public.production_events WHERE location = 'staging' AND staff_id = i.f1 AND event_type = 'clock_in') = 'framed');
  r := pg_temp.f7_must('B11 unknown badge', i.kiosk, pg_temp.f7_activate_sql(gen_random_uuid(), 'F77EFFFF'));
  PERFORM pg_temp.f7_ok('B12 unknown badge', r ->> 'status' = 'unknown_badge');
  r := pg_temp.f7_must('B13 inactive badge', i.kiosk, pg_temp.f7_activate_sql(gen_random_uuid(), 'F77E0004'));
  PERFORM pg_temp.f7_ok('B14 inactive badge is unusable (never an order fallback)', r ->> 'status' = 'unusable_badge');
  r := pg_temp.f7_must('B15 other-site badge', i.kiosk, pg_temp.f7_activate_sql(gen_random_uuid(), 'F77E0003'));
  PERFORM pg_temp.f7_ok('B16 other-site badge is unusable', r ->> 'status' = 'unusable_badge');
  PERFORM pg_temp.f7_refused('B17 a request id the framing receipts already hold is refused', i.kiosk, 'authenticated',
    pg_temp.f7_activate_sql((SELECT request_id FROM public.scanner_requests WHERE location = 'staging' AND staff_id = i.f1 LIMIT 1), 'F77E0001'),
    'P0001', 'scanner: request_conflict');
  PERFORM pg_temp.f7_refused('B18 another account cannot replay my sign-in', i.manager, 'authenticated',
    pg_temp.f7_activate_sql(v_req, 'F77E0005'), 'P0001', 'scanner: request_conflict');
END $$;

-- ===========================================================================
-- C. Framing evidence (the one reader used by preview and commit)
-- ===========================================================================
DO $$
DECLARE
  i f7t_ids%ROWTYPE;
  L jsonb := '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]';
  t timestamptz := now() - interval '2 hours';
  e jsonb;
  v_other text := (SELECT key FROM public.locations WHERE key <> 'staging' ORDER BY key LIMIT 1);
BEGIN
  SELECT * INTO i FROM f7t_ids;

  -- C01: the F6 shape: verification and completion at the same instant; the
  -- completion id ("-c-") sorts BEFORE the verification id ("-v01").
  PERFORM pg_temp.f7_event('scn-f7c01-v01', i.f1, 'framed', '10977001', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('scn-f7c01-c-framed', i.f1, 'framed', '10977001', 'completed', NULL, 2, t);
  e := pg_temp.f7_must('C01 F6 same-instant ids', i.kiosk, pg_temp.f7_evidence_sql('10977001', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C01 measured: same person verified and completed (equal timestamps work)',
    e ->> 'status' = 'measured' AND (e ->> 'person_id')::uuid = i.f1 AND e ->> 'display_name' = 'F7T Framer 1'
    AND e ->> 'verified_event_id' = 'scn-f7c01-v01' AND e ->> 'completed_event_id' = 'scn-f7c01-c-framed', e::text);

  -- C02: verification alone.
  PERFORM pg_temp.f7_event('f7c02-v', i.f1, 'framed', '10977002', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  e := pg_temp.f7_must('C02', i.kiosk, pg_temp.f7_evidence_sql('10977002', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C02 a verification without completion is missing', e ->> 'status' = 'missing' AND e ->> 'person_id' IS NULL, e::text);

  -- C03: another person's completion.
  PERFORM pg_temp.f7_event('f7c03-v', i.f1, 'framed', '10977003', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c03-c', i.f2, 'framed', '10977003', 'completed', NULL, 2, t + interval '1 minute');
  e := pg_temp.f7_must('C03', i.kiosk, pg_temp.f7_evidence_sql('10977003', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C03 another person''s completion is insufficient', e ->> 'status' = 'missing', e::text);

  -- C04: verification undone (classic unverify: cancelled.parent_event_id = verification).
  PERFORM pg_temp.f7_event('f7c04-v', i.f1, 'framed', '10977004', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c04-x', i.f1, 'framed', '10977004', 'cancelled', 'INKA-ABC0001-A2-FB', 2, t + interval '1 minute', 'f7c04-v');
  PERFORM pg_temp.f7_event('f7c04-c', i.f1, 'framed', '10977004', 'completed', NULL, 2, t + interval '2 minutes');
  e := pg_temp.f7_must('C04', i.kiosk, pg_temp.f7_evidence_sql('10977004', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C04 a cancelled verification is missing', e ->> 'status' = 'missing', e::text);

  -- C05: whole-order scrap between verification and completion, then a new attempt.
  PERFORM pg_temp.f7_event('f7c05-v1', i.f1, 'framed', '10977005', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c05-x', i.f1, 'framed', '10977005', 'cancelled', NULL, NULL, t + interval '1 minute');
  PERFORM pg_temp.f7_event('f7c05-c1', i.f1, 'framed', '10977005', 'completed', NULL, 2, t + interval '2 minutes');
  e := pg_temp.f7_must('C05a', i.kiosk, pg_temp.f7_evidence_sql('10977005', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C05a a scrapped attempt is not evidence', e ->> 'status' = 'missing', e::text);
  PERFORM pg_temp.f7_event('f7c05-v2', i.f1, 'framed', '10977005', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t + interval '3 minutes');
  PERFORM pg_temp.f7_event('f7c05-c2', i.f1, 'framed', '10977005', 'completed', NULL, 2, t + interval '4 minutes');
  e := pg_temp.f7_must('C05b', i.kiosk, pg_temp.f7_evidence_sql('10977005', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C05b the next valid attempt is measured, with its own events',
    e ->> 'status' = 'measured' AND e ->> 'verified_event_id' = 'f7c05-v2' AND e ->> 'completed_event_id' = 'f7c05-c2', e::text);

  -- C06: two different people each have a valid pair.
  PERFORM pg_temp.f7_event('f7c06-v1', i.f1, 'framed', '10977006', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c06-c1', i.f1, 'framed', '10977006', 'completed', NULL, 2, t + interval '1 minute');
  PERFORM pg_temp.f7_event('f7c06-v2', i.f2, 'framed', '10977006', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t + interval '2 minutes');
  PERFORM pg_temp.f7_event('f7c06-c2', i.f2, 'framed', '10977006', 'completed', NULL, 2, t + interval '3 minutes');
  e := pg_temp.f7_must('C06', i.kiosk, pg_temp.f7_evidence_sql('10977006', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C06 several framers is a conflict, never a guess', e ->> 'status' = 'conflict' AND e ->> 'person_id' IS NULL, e::text);

  -- C07: the same records at another site.
  PERFORM pg_temp.f7_event('f7c07-v', i.other_site, 'framed', '10977007', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t, NULL, NULL, v_other);
  PERFORM pg_temp.f7_event('f7c07-c', i.other_site, 'framed', '10977007', 'completed', NULL, 2, t, NULL, NULL, v_other);
  e := pg_temp.f7_must('C07', i.kiosk, pg_temp.f7_evidence_sql('10977007', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C07 another site''s records are not evidence here', e ->> 'status' = 'missing', e::text);

  -- C08: a verification for less than the required quantity.
  PERFORM pg_temp.f7_event('f7c08-v', i.f1, 'framed', '10977008', 'line_verified', 'INKA-ABC0001-A2-FB', 1, t);
  PERFORM pg_temp.f7_event('f7c08-c', i.f1, 'framed', '10977008', 'completed', NULL, 1, t);
  e := pg_temp.f7_must('C08', i.kiosk, pg_temp.f7_evidence_sql('10977008', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C08 evidence must cover the quantity', e ->> 'status' = 'missing', e::text);

  -- C09: completion BEFORE the verification.
  PERFORM pg_temp.f7_event('f7c09-c', i.f1, 'framed', '10977009', 'completed', NULL, 2, t);
  PERFORM pg_temp.f7_event('f7c09-v', i.f1, 'framed', '10977009', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t + interval '1 minute');
  e := pg_temp.f7_must('C09', i.kiosk, pg_temp.f7_evidence_sql('10977009', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C09 a completion before the verification does not count', e ->> 'status' = 'missing', e::text);

  -- C10: replacement (CS) work, other SKU, other work type.
  PERFORM pg_temp.f7_event('f7c10-v', i.f1, 'framed', '10977010', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t, NULL, 'case-1');
  PERFORM pg_temp.f7_event('f7c10-c', i.f1, 'framed', '10977010', 'completed', NULL, 2, t, NULL, 'case-1');
  PERFORM pg_temp.f7_event('f7c10-v2', i.f1, 'framed', '10977010', 'line_verified', 'INKA-ABC0002-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c10-v3', i.f1, 'unframed', '10977010', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c10-c3', i.f1, 'unframed', '10977010', 'completed', NULL, 2, t);
  e := pg_temp.f7_must('C10', i.kiosk, pg_temp.f7_evidence_sql('10977010', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C10 CS work, other SKUs and other work types are not evidence', e ->> 'status' = 'missing', e::text);

  -- C11: classic lower-case SKU, completion later; A0 work type.
  PERFORM pg_temp.f7_event('f7c11-v', i.f2, 'framed', '10977011', 'line_verified', 'inka-abc0001-a2-fb', 2, t);
  PERFORM pg_temp.f7_event('f7c11-c', i.f2, 'framed', '10977011', 'completed', NULL, 3, t + interval '5 minutes');
  PERFORM pg_temp.f7_event('f7c11-va', i.f1, 'a0_framed', '10977011', 'line_verified', 'INKA-ABC0001-A0-FB', 1, t);
  PERFORM pg_temp.f7_event('f7c11-ca', i.f1, 'a0_framed', '10977011', 'completed', NULL, 1, t);
  e := pg_temp.f7_must('C11', i.kiosk, pg_temp.f7_evidence_sql('10977011',
         '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"},{"sku":"INKA-ABC0001-A0-FB","quantity":1,"work_type":"a0_framed"}]')) -> 'lines';
  PERFORM pg_temp.f7_ok('C11 per SKU: A0 by Framer 1, A2 (classic spelling) by Framer 2, sorted by SKU',
    e -> 0 ->> 'sku' = 'INKA-ABC0001-A0-FB' AND (e -> 0 ->> 'person_id')::uuid = i.f1
    AND e -> 1 ->> 'sku' = 'INKA-ABC0001-A2-FB' AND (e -> 1 ->> 'person_id')::uuid = i.f2 AND e -> 1 ->> 'status' = 'measured', e::text);

  -- C12: a same-SKU mid-progress cancel between verification and completion.
  PERFORM pg_temp.f7_event('f7c12-v', i.f1, 'framed', '10977012', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c12-x', i.f1, 'framed', '10977012', 'cancelled', 'INKA-ABC0001-A2-FB', 2, t + interval '1 minute');
  PERFORM pg_temp.f7_event('f7c12-c', i.f1, 'framed', '10977012', 'completed', NULL, 2, t + interval '2 minutes');
  e := pg_temp.f7_must('C12', i.kiosk, pg_temp.f7_evidence_sql('10977012', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C12 a same-SKU cancel inside the attempt breaks it', e ->> 'status' = 'missing', e::text);

  -- C13: more than 1000 events on one order: refused, never read truncated.
  INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, station_id, note, created_at)
  SELECT 'staging', 'f7c13-' || g, i.f1, 'framed', '10977013', 'started', 'f7t', 'F7 verify', t FROM generate_series(1, 1001) g;
  PERFORM pg_temp.f7_refused('C13 evidence overflow is a clear refusal', i.kiosk, 'authenticated',
    pg_temp.f7_evidence_sql('10977013', L), 'P0001', 'scanner: evidence_overflow');

  PERFORM pg_temp.f7_refused('C14 evidence input uses the F6 grammar', i.kiosk, 'authenticated',
    pg_temp.f7_evidence_sql('10977001', '[{"sku":"INKA-ABC0001-A2-UN","quantity":1,"work_type":"framed"}]'), 'P0001', 'scanner: invalid_input');
  PERFORM pg_temp.f7_ok('C15 empty line list is valid and answers nothing',
    pg_temp.f7_must('C15', i.kiosk, pg_temp.f7_evidence_sql('10977001', '[]')) -> 'lines' = '[]'::jsonb);

  -- C16: a whole-order scrap AFTER the completion ends that attempt.
  PERFORM pg_temp.f7_event('f7c16-v', i.f1, 'framed', '10977022', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c16-c', i.f1, 'framed', '10977022', 'completed', NULL, 2, t + interval '1 minute');
  e := pg_temp.f7_must('C16a', i.kiosk, pg_temp.f7_evidence_sql('10977022', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C16a measured before the scrap', e ->> 'status' = 'measured', e::text);
  PERFORM pg_temp.f7_event('f7c16-x', i.f2, 'framed', '10977022', 'cancelled', NULL, NULL, t + interval '2 minutes');
  e := pg_temp.f7_must('C16b', i.kiosk, pg_temp.f7_evidence_sql('10977022', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C16b a post-completion scrap makes it missing', e ->> 'status' = 'missing', e::text);
  PERFORM pg_temp.f7_event('f7c16-v2', i.f2, 'framed', '10977022', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t + interval '3 minutes');
  PERFORM pg_temp.f7_event('f7c16-c2', i.f2, 'framed', '10977022', 'completed', NULL, 2, t + interval '3 minutes');
  e := pg_temp.f7_must('C16c', i.kiosk, pg_temp.f7_evidence_sql('10977022', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C16c a new attempt after the scrap is measured (same-instant pair, other framer)',
    e ->> 'status' = 'measured' AND (e ->> 'person_id')::uuid = i.f2 AND e ->> 'verified_event_id' = 'f7c16-v2' AND e ->> 'completed_event_id' = 'f7c16-c2', e::text);

  -- C17: a same-SKU cancel after completion ends it; another SKU's cancel does not.
  PERFORM pg_temp.f7_event('f7c17-v', i.f1, 'framed', '10977023', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c17-c', i.f1, 'framed', '10977023', 'completed', NULL, 2, t);
  PERFORM pg_temp.f7_event('f7c17-x1', i.f1, 'framed', '10977023', 'cancelled', 'INKA-ABC0002-A2-FB', 1, t + interval '1 minute');
  e := pg_temp.f7_must('C17a', i.kiosk, pg_temp.f7_evidence_sql('10977023', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C17a a cancel of another SKU leaves it measured', e ->> 'status' = 'measured', e::text);
  PERFORM pg_temp.f7_event('f7c17-x2', i.f1, 'framed', '10977023', 'cancelled', 'inka-abc0001-a2-fb', 2, t + interval '2 minutes');
  e := pg_temp.f7_must('C17b', i.kiosk, pg_temp.f7_evidence_sql('10977023', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C17b a same-SKU cancel after completion makes it missing', e ->> 'status' = 'missing', e::text);

  -- C18: reopened at framing after the completion (a later started row).
  PERFORM pg_temp.f7_event('f7c18-s', i.f1, 'framed', '10977024', 'started', NULL, NULL, t - interval '1 minute');
  PERFORM pg_temp.f7_event('f7c18-v', i.f1, 'framed', '10977024', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c18-c', i.f1, 'framed', '10977024', 'completed', NULL, 2, t + interval '1 minute');
  e := pg_temp.f7_must('C18a', i.kiosk, pg_temp.f7_evidence_sql('10977024', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C18a the start of the same attempt does not matter', e ->> 'status' = 'measured', e::text);
  PERFORM pg_temp.f7_event('f7c18-s2', i.f2, 'framed', '10977024', 'started', NULL, NULL, t + interval '2 minutes');
  e := pg_temp.f7_must('C18b', i.kiosk, pg_temp.f7_evidence_sql('10977024', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C18b reopened after completion: missing', e ->> 'status' = 'missing', e::text);
  PERFORM pg_temp.f7_event('f7c18-c2', i.f1, 'framed', '10977024', 'completed', NULL, 2, t + interval '3 minutes');
  e := pg_temp.f7_must('C18c', i.kiosk, pg_temp.f7_evidence_sql('10977024', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C18c a later completion without a new verification does not revive the old one', e ->> 'status' = 'missing', e::text);
  PERFORM pg_temp.f7_event('f7c18-v3', i.f2, 'framed', '10977024', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t + interval '4 minutes');
  PERFORM pg_temp.f7_event('f7c18-c3', i.f2, 'framed', '10977024', 'completed', NULL, 2, t + interval '5 minutes');
  e := pg_temp.f7_must('C18d', i.kiosk, pg_temp.f7_evidence_sql('10977024', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C18d the pair of the reopened attempt is measured',
    e ->> 'status' = 'measured' AND e ->> 'verified_event_id' = 'f7c18-v3' AND e ->> 'completed_event_id' = 'f7c18-c3', e::text);

  -- C19: a completion row for ANOTHER SKU is not evidence; same SKU or whole order is.
  PERFORM pg_temp.f7_event('f7c19-v', i.f1, 'framed', '10977025', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c19-cb', i.f1, 'framed', '10977025', 'completed', 'INKA-ABC0002-A2-FB', 2, t + interval '1 minute');
  e := pg_temp.f7_must('C19a', i.kiosk, pg_temp.f7_evidence_sql('10977025', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C19a verification A + completion B is missing', e ->> 'status' = 'missing', e::text);
  PERFORM pg_temp.f7_event('f7c19-ca', i.f1, 'framed', '10977025', 'completed', 'INKA-ABC0001-A2-FB', 2, t + interval '2 minutes');
  e := pg_temp.f7_must('C19b', i.kiosk, pg_temp.f7_evidence_sql('10977025', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C19b a same-SKU completion is measured', e ->> 'status' = 'measured' AND e ->> 'completed_event_id' = 'f7c19-ca', e::text);

  -- C20: verification -> later start/reload -> completion: the verification
  -- belongs to the earlier attempt, so it needs a manual choice.
  PERFORM pg_temp.f7_event('f7c20-v', i.f1, 'framed', '10977026', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c20-s', i.f1, 'framed', '10977026', 'started', NULL, NULL, t + interval '1 minute');
  PERFORM pg_temp.f7_event('f7c20-c', i.f1, 'framed', '10977026', 'completed', NULL, 2, t + interval '2 minutes');
  e := pg_temp.f7_must('C20', i.kiosk, pg_temp.f7_evidence_sql('10977026', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C20 V -> S -> C is missing (start after the verification)', e ->> 'status' = 'missing', e::text);
  -- C21: start -> verification -> completion is one attempt; a start at the
  -- same instant as the verification is also the same attempt.
  PERFORM pg_temp.f7_event('f7c21-s', i.f1, 'framed', '10977027', 'started', NULL, NULL, t);
  PERFORM pg_temp.f7_event('f7c21-v', i.f1, 'framed', '10977027', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t + interval '1 minute');
  PERFORM pg_temp.f7_event('f7c21-c', i.f1, 'framed', '10977027', 'completed', NULL, 2, t + interval '2 minutes');
  e := pg_temp.f7_must('C21a', i.kiosk, pg_temp.f7_evidence_sql('10977027', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C21a S -> V -> C is measured', e ->> 'status' = 'measured' AND e ->> 'verified_event_id' = 'f7c21-v', e::text);
  PERFORM pg_temp.f7_event('f7c21-s2', i.f2, 'framed', '10977028', 'started', NULL, NULL, t);
  PERFORM pg_temp.f7_event('f7c21-v2', i.f2, 'framed', '10977028', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t);
  PERFORM pg_temp.f7_event('f7c21-c2', i.f2, 'framed', '10977028', 'completed', NULL, 2, t);
  e := pg_temp.f7_must('C21b', i.kiosk, pg_temp.f7_evidence_sql('10977028', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C21b start, verification and completion at one instant are measured', e ->> 'status' = 'measured', e::text);
  -- C01 (F6 same-instant V/C, no start) is re-checked after all of this.
  e := pg_temp.f7_must('C21c', i.kiosk, pg_temp.f7_evidence_sql('10977001', L)) -> 'lines' -> 0;
  PERFORM pg_temp.f7_ok('C21c F6 equal-time pair still measured', e ->> 'status' = 'measured' AND e ->> 'verified_event_id' = 'scn-f7c01-v01', e::text);

END $$;

-- ===========================================================================
-- D. Dispatch commit
-- ===========================================================================
DO $$
DECLARE
  i    f7t_ids%ROWTYPE;
  r    jsonb;
  t    timestamptz := now() - interval '1 hour';
  L    jsonb := '[{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]';
  C    jsonb := '[{"code":"F7T-A2B","qty":2}]';
  P    jsonb;
  v_req uuid := gen_random_uuid();
  v_before text;
  v_event text;
  v_a2 numeric;
BEGIN
  SELECT * INTO i FROM f7t_ids;
  P := jsonb_build_object('rule_set_id', 'f7t-rs', 'rule_set_version', i.rs_version, 'resolved', true,
                          'predicted', '{"f7t-box":1}'::jsonb, 'target', '{"f7t-box":1}'::jsonb, 'snapshot', '{}'::jsonb);

  -- D01-D04: measured framing (10977001, from C01), packaging, stock, replay.
  v_a2 := pg_temp.f7_on_hand('f7t-a2b');
  r := pg_temp.f7_must('D01 measured dispatch saves', i.kiosk, pg_temp.f7_dispatch_sql(v_req, i.disp, 'F77E0005', '10977001', t, 3, L, C, P));
  v_event := 'dsp-' || replace(v_req::text, '-', '') || '-d';
  PERFORM pg_temp.f7_ok('D01a answer names the measured framer',
    r ->> 'status' = 'saved' AND (r ->> 'items')::int = 3 AND r -> 'event_ids' = jsonb_build_array(v_event)
    AND r -> 'attributions' = jsonb_build_array(jsonb_build_object('sku', 'INKA-ABC0001-A2-FB', 'source', 'scan',
                                                 'person_id', i.f1, 'display_name', 'F7T Framer 1')), r::text);
  PERFORM pg_temp.f7_ok('D01b one dispatched event: dispatcher, dispatch dept, whole order, total items, scan time',
    EXISTS (SELECT 1 FROM public.production_events WHERE location = 'staging' AND id = v_event AND staff_id = i.disp
            AND department = 'dispatch' AND event_type = 'dispatched' AND line_sku IS NULL AND line_quantity = 3 AND created_at = t));
  PERFORM pg_temp.f7_ok('D01c stock: dispatch components once', pg_temp.f7_on_hand('f7t-a2b') = v_a2 - 2);
  PERFORM pg_temp.f7_ok('D01d F4: one Dispatch pick for the order, box taken',
    (SELECT count(*) FROM public.packaging_picks WHERE location = 'staging' AND order_number = '10977001' AND packing_point = 'dispatch') = 1
    AND pg_temp.f7_on_hand('f7t-box') = 19);
  PERFORM pg_temp.f7_ok('D01e attribution row: measured, event refs, dispatcher, caller',
    EXISTS (SELECT 1 FROM public.dispatch_framer_attributions WHERE location = 'staging' AND dispatch_event_id = v_event
            AND sku = 'INKA-ABC0001-A2-FB' AND source = 'scan' AND person_id = i.f1 AND verified_event_id = 'scn-f7c01-v01'
            AND completed_event_id = 'scn-f7c01-c-framed' AND dispatcher_id = i.disp AND recorded_by = i.kiosk AND quantity = 2));
  PERFORM pg_temp.f7_ok('D01f framer gets no new event from a dispatch',
    (SELECT count(*) FROM public.production_events WHERE location = 'staging' AND order_number = '10977001' AND staff_id = i.f1) = 2);
  v_before := pg_temp.f7_footprint('10977001');
  r := pg_temp.f7_must('D02 replay', i.kiosk, pg_temp.f7_dispatch_sql(v_req, i.disp, 'F77E0005', '10977001', t, 3, L, C, P));
  PERFORM pg_temp.f7_ok('D02 replay: stored answer, nothing written twice',
    (r ->> 'replayed')::boolean AND pg_temp.f7_footprint('10977001') = v_before AND pg_temp.f7_on_hand('f7t-a2b') = v_a2 - 2);
  PERFORM pg_temp.f7_refused('D03 same id, changed payload', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(v_req, i.disp, 'F77E0005', '10977001', t, 4, L, C, P), 'P0001', 'scanner: request_conflict');
  PERFORM pg_temp.f7_refused('D03b same id from another account', i.manager, 'authenticated',
    pg_temp.f7_dispatch_sql(v_req, i.disp, 'F77E0005', '10977001', t, 3, L, C, P), 'P0001', 'scanner: request_conflict');
  r := pg_temp.f7_must('D04 a second device dispatches the same order', i.kiosk,
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977001', t, 3, L, C, P));
  PERFORM pg_temp.f7_ok('D04 already dispatched: nothing more', r ->> 'status' = 'already_recorded'
    AND r ->> 'reason' = 'order already dispatched' AND pg_temp.f7_footprint('10977001') = v_before);

  -- D05: missing framing record, nobody chosen: nothing at all is written.
  v_before := pg_temp.f7_footprint('10977002');
  PERFORM pg_temp.f7_refused('D05 missing evidence without a choice', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977002', t, 2, L, C, P), 'P0001', 'scanner: framer_missing');
  PERFORM pg_temp.f7_ok('D05b all or nothing', pg_temp.f7_footprint('10977002') = v_before AND pg_temp.f7_on_hand('f7t-a2b') = v_a2 - 2);

  -- D06: manual choice: saved, labelled manual, no framing events invented.
  r := pg_temp.f7_must('D06 manual choice saves', i.kiosk, pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977002', t, 2, L, C, P,
         jsonb_build_array(jsonb_build_object('sku', 'INKA-ABC0001-A2-FB', 'person_id', i.f2))));
  PERFORM pg_temp.f7_ok('D06a answer says manual', r -> 'attributions' -> 0 ->> 'source' = 'manual'
    AND (r -> 'attributions' -> 0 ->> 'person_id')::uuid = i.f2 AND r -> 'attributions' -> 0 ->> 'display_name' = 'F7T Framer 2', r::text);
  PERFORM pg_temp.f7_ok('D06b manual row has no event refs',
    EXISTS (SELECT 1 FROM public.dispatch_framer_attributions WHERE location = 'staging' AND order_number = '10977002'
            AND source = 'manual' AND person_id = i.f2 AND verified_event_id IS NULL AND completed_event_id IS NULL));
  PERFORM pg_temp.f7_ok('D06c no line_verified/started/completed invented for anyone, nothing for the chosen framer',
    (SELECT count(*) FROM public.production_events WHERE location = 'staging' AND order_number = '10977002'
       AND event_type IN ('line_verified', 'started', 'completed')) = 1   -- C02's original verification only
    AND NOT EXISTS (SELECT 1 FROM public.production_events WHERE location = 'staging' AND staff_id = i.f2 AND order_number = '10977002'));

  -- D07: a chosen framer who is not an active member here.
  v_before := pg_temp.f7_footprint('10977003');
  PERFORM pg_temp.f7_refused('D07a inactive badge holder', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977003', t, 2, L, C, P,
      jsonb_build_array(jsonb_build_object('sku', 'INKA-ABC0001-A2-FB', 'person_id', i.inactive))), 'P0001', 'scanner: framer_inactive');
  PERFORM pg_temp.f7_refused('D07b other-site person', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977003', t, 2, L, C, P,
      jsonb_build_array(jsonb_build_object('sku', 'INKA-ABC0001-A2-FB', 'person_id', i.other_site))), 'P0001', 'scanner: framer_inactive');
  PERFORM pg_temp.f7_ok('D07c nothing written', pg_temp.f7_footprint('10977003') = v_before);

  -- D08: measured evidence arrived after the picker: it wins over the choice.
  PERFORM pg_temp.f7_event('f7d08-v', i.f1, 'framed', '10977014', 'line_verified', 'INKA-ABC0001-A2-FB', 2, t - interval '1 minute');
  PERFORM pg_temp.f7_event('f7d08-c', i.f1, 'framed', '10977014', 'completed', NULL, 2, t - interval '1 minute');
  r := pg_temp.f7_must('D08 choice made before the scan arrived', i.kiosk, pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977014', t, 2, L, C, P,
         jsonb_build_array(jsonb_build_object('sku', 'INKA-ABC0001-A2-FB', 'person_id', i.f2))));
  PERFORM pg_temp.f7_ok('D08 measured evidence is preferred', r -> 'attributions' -> 0 ->> 'source' = 'scan'
    AND (r -> 'attributions' -> 0 ->> 'person_id')::uuid = i.f1, r::text);

  -- D09: per-SKU mix: A0 measured (C11) and a second framed SKU manual.
  r := pg_temp.f7_must('D09 mixed per-SKU', i.kiosk, pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977011', t, 4,
         '[{"sku":"INKA-ABC0001-A0-FB","quantity":1,"work_type":"a0_framed"},{"sku":"INKA-ABC0009-A3-FW","quantity":1,"work_type":"framed"}]', '[]', P,
         jsonb_build_array(jsonb_build_object('sku', 'INKA-ABC0009-A3-FW', 'person_id', i.f2))));
  PERFORM pg_temp.f7_ok('D09 one row per SKU, each with its own source',
    r -> 'attributions' -> 0 ->> 'source' = 'scan' AND r -> 'attributions' -> 1 ->> 'source' = 'manual'
    AND (SELECT count(*) FROM public.dispatch_framer_attributions WHERE location = 'staging' AND order_number = '10977011') = 2, r::text);

  -- D10: unframed-only order: nothing to attribute, no packaging here.
  r := pg_temp.f7_must('D10 unframed-only order', i.kiosk, pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977015', t, 3, '[]'));
  PERFORM pg_temp.f7_ok('D10 saved with no attribution', r ->> 'status' = 'saved' AND r -> 'attributions' = '[]'::jsonb
    AND (SELECT count(*) FROM public.dispatch_framer_attributions WHERE location = 'staging' AND order_number = '10977015') = 0);

  -- D11: all-or-nothing on stock and packaging.
  v_before := pg_temp.f7_footprint('10977016');
  PERFORM pg_temp.f7_refused('D11a unknown stock code', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977016', t, 1, '[]', '[{"code":"F7T-NOPE","qty":1}]'),
    'P0001', 'scanner: missing_stock_code');
  PERFORM pg_temp.f7_refused('D11b unknown rule set', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977016', t, 1, '[]', '[]', P || '{"rule_set_id":"nope"}'),
    'P0001', 'scanner: packaging_invalid');
  PERFORM pg_temp.f7_refused('D11c box outside the rule set', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977016', t, 1, '[]', '[]',
      P || '{"predicted":{"f7t-hook":1},"target":{"f7t-hook":1}}'), 'P0001', 'packaging');
  PERFORM pg_temp.f7_refused('D11d manual + bad stock: the attribution rolls back too', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977016', t, 2, L, '[{"code":"F7T-NOPE","qty":1}]', P,
      jsonb_build_array(jsonb_build_object('sku', 'INKA-ABC0001-A2-FB', 'person_id', i.f2))), 'P0001', 'scanner: missing_stock_code');
  PERFORM pg_temp.f7_ok('D11e nothing written by any of them', pg_temp.f7_footprint('10977016') = v_before);
  UPDATE public.packaging_settings SET mode = 'scan' WHERE location = 'staging';
  PERFORM pg_temp.f7_refused('D11f packaging needs auto mode', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977016', t, 1, '[]', '[]', P), 'P0001', 'scanner: packaging_not_auto');
  UPDATE public.packaging_settings SET mode = 'auto' WHERE location = 'staging';
  PERFORM pg_temp.f7_ok('D11g still nothing written', pg_temp.f7_footprint('10977016') = v_before);

  -- D12: refusals before any write.
  PERFORM pg_temp.f7_refused('D12a inactive dispatcher badge', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.inactive, 'F77E0004', '10977016', t, 1, '[]'), 'P0001', 'scanner: badge_inactive');
  INSERT INTO public.cs_cases (location, id, status, issue_type, order_number) VALUES ('staging', 'f7t-case', 'new', 'damaged', '10977017');
  PERFORM pg_temp.f7_refused('D12b open replacement case', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977017', t, 1, '[]'), 'P0001', 'scanner: open_case');
  PERFORM pg_temp.f7_refused('D12c future scan time', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977016', now() + interval '1 minute', 1, '[]'), 'P0001', 'scanner: invalid_input');
  PERFORM pg_temp.f7_refused('D12d choice for a SKU not in the lines', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977016', t, 2, L, '[]', NULL,
      jsonb_build_array(jsonb_build_object('sku', 'INKA-XYZ0001-A2-FB', 'person_id', i.f2))), 'P0001', 'scanner: invalid_input');
  PERFORM pg_temp.f7_refused('D12e two choices for one SKU', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977016', t, 2, L, '[]', NULL,
      jsonb_build_array(jsonb_build_object('sku', 'INKA-ABC0001-A2-FB', 'person_id', i.f2), jsonb_build_object('sku', 'INKA-ABC0001-A2-FB', 'person_id', i.f1))),
    'P0001', 'scanner: invalid_input');
  PERFORM pg_temp.f7_refused('D12f items fewer than framed quantity', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977016', t, 1, L), 'P0001', 'scanner: invalid_input');
  PERFORM pg_temp.f7_refused('D12g null items', i.kiosk, 'authenticated',
    replace(pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977016', t, 1, '[]'), ', 1, ''[]''', ', NULL, ''[]'''), 'P0001', 'scanner: invalid_input');
  PERFORM pg_temp.f7_refused('D12h unframed SKU in framed lines', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977016', t, 1, '[{"sku":"INKA-ABC0001-A2-UN","quantity":1,"work_type":"framed"}]'),
    'P0001', 'scanner: invalid_input');
  PERFORM pg_temp.f7_refused('D12i a framing receipt id cannot be reused for a dispatch', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql((SELECT request_id FROM public.scanner_requests WHERE location = 'staging' LIMIT 1), i.disp, 'F77E0005', '10977016', t, 1, '[]'),
    'P0001', 'scanner: request_conflict');
  PERFORM pg_temp.f7_refused('D12j an activation receipt id cannot be reused for a dispatch', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql((SELECT request_id FROM public.dispatch_requests WHERE location = 'staging' AND kind = 'activate' LIMIT 1),
      i.disp, 'F77E0005', '10977016', t, 1, '[]'), 'P0001', 'scanner: request_conflict');
  PERFORM pg_temp.f7_ok('D12k nothing written', pg_temp.f7_footprint('10977016') = v_before
    AND pg_temp.f7_footprint('10977017') = 'events=0 ledger=0 picks=0 attributions=0 receipts=0');

  -- D13: an order the classic station already dispatched.
  PERFORM pg_temp.f7_event('f7d13-d', i.disp, 'dispatch', '10977018', 'dispatched', NULL, 1, t);
  r := pg_temp.f7_must('D13 classic dispatch first', i.kiosk, pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977018', t, 1, '[]'));
  PERFORM pg_temp.f7_ok('D13 already recorded, nothing added', r ->> 'status' = 'already_recorded'
    AND pg_temp.f7_footprint('10977018') = 'events=1 ledger=0 picks=0 attributions=0 receipts=0');

  -- D14: the attribution table is immutable, even for the owner of the table.
  PERFORM pg_temp.f7_ok('D14 attribution rows cannot be updated', pg_temp.f7_try($q$UPDATE public.dispatch_framer_attributions SET display_name = 'x' WHERE location = 'staging'$q$) LIKE '%attribution_immutable%');

  -- D15: regular framed lines need their Dispatch parcel in the request.
  v_before := pg_temp.f7_footprint('10977019');
  PERFORM pg_temp.f7_refused('D15a framed lines with SQL NULL packaging', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977019', t, 2, L, C, NULL,
      jsonb_build_array(jsonb_build_object('sku', 'INKA-ABC0001-A2-FB', 'person_id', i.f2))), 'P0001', 'scanner: packaging_required');
  PERFORM pg_temp.f7_refused('D15b framed lines with JSON null packaging', i.kiosk, 'authenticated',
    pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977019', t, 2, L, C, 'null'::jsonb,
      jsonb_build_array(jsonb_build_object('sku', 'INKA-ABC0001-A2-FB', 'person_id', i.f2))), 'P0001', 'scanner: packaging_required');
  PERFORM pg_temp.f7_ok('D15c nothing written, stock unchanged', pg_temp.f7_footprint('10977019') = v_before);
  r := pg_temp.f7_must('D15d A0-only order needs no Dispatch parcel', i.kiosk, pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977021', t, 1,
         '[{"sku":"INKA-ABC0001-A0-FB","quantity":1,"work_type":"a0_framed"}]', '[]', NULL,
         jsonb_build_array(jsonb_build_object('sku', 'INKA-ABC0001-A0-FB', 'person_id', i.f2))));
  PERFORM pg_temp.f7_ok('D15e A0-only saved without packaging', r ->> 'status' = 'saved' AND r -> 'packaging_pick' = 'null'::jsonb, r::text);

  -- D16: reports roles see attributions at their site; kiosks and staff do not.
  PERFORM pg_temp.f7_ok('D16a manager sees attributions',
    (pg_temp.f7_must('D16a', i.manager, $q$SELECT count(*)::text FROM public.dispatch_framer_attributions WHERE location = 'staging' AND order_number LIKE '109770%'$q$))::int >= 4);
  PERFORM pg_temp.f7_ok('D16b kiosk reads none directly',
    (pg_temp.f7_must('D16b', i.kiosk, $q$SELECT count(*)::text FROM public.dispatch_framer_attributions$q$))::int = 0);
  PERFORM pg_temp.f7_ok('D16c staff reads none',
    (pg_temp.f7_must('D16c', i.staff, $q$SELECT count(*)::text FROM public.dispatch_framer_attributions$q$))::int = 0);
  PERFORM pg_temp.f7_ok('D16d other-site kiosk reads none',
    (pg_temp.f7_must('D16d', i.kiosk_other, $q$SELECT count(*)::text FROM public.dispatch_requests$q$))::int = 0);
END $$;

-- ===========================================================================
-- G. Classic insert guard (c7): no duplicate dispatch credit; evidence-changing
--    framing rows take the order lock
-- ===========================================================================
DO $$
DECLARE
  i f7t_ids%ROWTYPE;
  v_a2 numeric;
BEGIN
  SELECT * INTO i FROM f7t_ids;
  v_a2 := pg_temp.f7_on_hand('f7t-a2b');
  -- 10977001 was dispatched by the shared scanners in D01.
  PERFORM pg_temp.f7_refused('G01 classic dispatch after a shared dispatch is refused (kiosk, as the app inserts it)', i.kiosk, 'authenticated',
    format($q$INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_quantity, event_type, station_id, note)
      VALUES ('staging', 'f7g01', %L, 'dispatch', '10977001', 3, 'dispatched', 'classic', 'F7') RETURNING id$q$, i.disp),
    'P0001', 'scanner: already_dispatched_by_shared_scanner');
  PERFORM pg_temp.f7_ok('G02 nothing was added; no stock moved',
    NOT EXISTS (SELECT 1 FROM public.production_events WHERE location = 'staging' AND id = 'f7g01') AND pg_temp.f7_on_hand('f7t-a2b') = v_a2);
  PERFORM pg_temp.f7_ok('G03 a CS replacement dispatch of the same order still passes', pg_temp.f7_try(format(
    $q$INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_quantity, event_type, station_id, note, cs_case_id)
       VALUES ('staging', 'f7g03', %L, 'dispatch', '10977001', 1, 'dispatched', 'classic', 'F7', 'case-g03')$q$, i.disp)) = '');
  PERFORM pg_temp.f7_ok('G04 an order the shared scanners never dispatched: classic dispatch unchanged', pg_temp.f7_try(format(
    $q$INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_quantity, event_type, station_id, note)
       VALUES ('staging', 'f7g04', %L, 'dispatch', '10977032', 1, 'dispatched', 'classic', 'F7')$q$, i.disp)) = '');
  PERFORM pg_temp.f7_ok('G05 order lock not yet held for 10977033/34/35',
    NOT pg_temp.f7_holds_order_lock('10977033') AND NOT pg_temp.f7_holds_order_lock('10977034') AND NOT pg_temp.f7_holds_order_lock('10977035'));
  PERFORM pg_temp.f7_event('f7g06', i.f1, 'framed', '10977033', 'cancelled', NULL, NULL, now());
  PERFORM pg_temp.f7_event('f7g07', i.f1, 'a0_framed', '10977034', 'started', NULL, NULL, now());
  PERFORM pg_temp.f7_event('f7g08', i.f1, 'unframed', '10977035', 'started', NULL, NULL, now());
  PERFORM pg_temp.f7_ok('G06 a framing cancel / start takes the order lock (serialized with dispatch); other work does not',
    pg_temp.f7_holds_order_lock('10977033') AND pg_temp.f7_holds_order_lock('10977034') AND NOT pg_temp.f7_holds_order_lock('10977035'));
END $$;

-- ===========================================================================
-- E. Framing then dispatch, exactly once each; A0 never charged twice
-- ===========================================================================
DO $$
DECLARE
  i  f7t_ids%ROWTYPE;
  r  jsonb;
  t  timestamptz := now() - interval '30 minutes';
  P0 jsonb;
  P  jsonb;
  v_a0 numeric; v_hook numeric; v_a0box numeric; v_box numeric;
BEGIN
  SELECT * INTO i FROM f7t_ids;
  P0 := jsonb_build_object('rule_set_id', 'f7t-rs', 'rule_set_version', i.rs_version, 'resolved', true,
                           'predicted', '{"f7t-a0box":1}'::jsonb, 'target', '{"f7t-a0box":1}'::jsonb, 'snapshot', '{}'::jsonb);
  P  := jsonb_build_object('rule_set_id', 'f7t-rs', 'rule_set_version', i.rs_version, 'resolved', true,
                           'predicted', '{"f7t-box":1}'::jsonb, 'target', '{"f7t-box":1}'::jsonb, 'snapshot', '{}'::jsonb);

  -- The shared framing scanners save A0 + A2 for Framer 1 (F6 commit, A0 terminal).
  r := pg_temp.f7_must('E01 F6 framing save', i.kiosk,
    format('SELECT public.scanner_commit_framing(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, auth.uid())::text',
      'staging', gen_random_uuid(), 'f7t-wall', 'S1', i.f1, 'F77E0001', '10977020', t,
      '[{"sku":"INKA-ABC0001-A0-FB","quantity":1,"work_type":"a0_framed"},{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]',
      '[{"code":"F7T-A0B","qty":1},{"code":"F7T-HOOK","qty":1}]', P0));
  PERFORM pg_temp.f7_ok('E01 framing saved', r ->> 'status' = 'saved', r::text);
  v_a0 := pg_temp.f7_on_hand('f7t-a0b'); v_hook := pg_temp.f7_on_hand('f7t-hook');
  v_a0box := pg_temp.f7_on_hand('f7t-a0box'); v_box := pg_temp.f7_on_hand('f7t-box');

  -- Dispatch of the same order: the framing receipt does not block it.
  r := pg_temp.f7_must('E02 dispatch after shared framing', i.kiosk, pg_temp.f7_dispatch_sql(gen_random_uuid(), i.disp, 'F77E0005', '10977020', t + interval '5 minutes', 3,
         '[{"sku":"INKA-ABC0001-A0-FB","quantity":1,"work_type":"a0_framed"},{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]',
         '[{"code":"F7T-A2B","qty":1},{"code":"F7T-HOOK","qty":1}]', P));
  PERFORM pg_temp.f7_ok('E02a saved; both SKUs measured from the F6 events',
    r ->> 'status' = 'saved' AND r -> 'attributions' -> 0 ->> 'source' = 'scan' AND r -> 'attributions' -> 1 ->> 'source' = 'scan'
    AND (r -> 'attributions' -> 0 ->> 'person_id')::uuid = i.f1 AND (r -> 'attributions' -> 1 ->> 'person_id')::uuid = i.f1, r::text);
  PERFORM pg_temp.f7_ok('E02b A0 stock and A0 box untouched; the accessory already charged at A0 is skipped',
    pg_temp.f7_on_hand('f7t-a0b') = v_a0 AND pg_temp.f7_on_hand('f7t-a0box') = v_a0box AND pg_temp.f7_on_hand('f7t-hook') = v_hook
    AND (r -> 'deduction' ->> 'skipped_idempotent')::int = 1 AND (r -> 'deduction' ->> 'deducted')::int = 1);
  PERFORM pg_temp.f7_ok('E02c the Dispatch parcel is its own pick; the A0 pick is unchanged',
    pg_temp.f7_on_hand('f7t-box') = v_box - 1
    AND (SELECT count(*) FROM public.packaging_picks WHERE location = 'staging' AND order_number = '10977020' AND packing_point = 'a0_framed') = 1
    AND (SELECT count(*) FROM public.packaging_picks WHERE location = 'staging' AND order_number = '10977020' AND packing_point = 'dispatch') = 1);
  PERFORM pg_temp.f7_ok('E02d one framing receipt and one dispatch receipt for the order',
    (SELECT count(*) FROM public.scanner_requests WHERE location = 'staging' AND order_number = '10977020') = 1
    AND (SELECT count(*) FROM public.dispatch_requests WHERE location = 'staging' AND order_number = '10977020') = 1);
  -- Duplicate framing credit stays blocked after the dispatch (c6 guard unchanged).
  PERFORM pg_temp.f7_ok('E03 classic framing credit is still refused after the dispatch', pg_temp.f7_try(
    $q$INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note)
       VALUES ('staging', 'f7e03', 'f7700000-0000-4000-8000-000000000002', 'framed', '10977020', NULL, 1, 'completed', 'classic', 'F7')$q$)
    LIKE 'P0001%already_saved_by_shared_scanner%');
  PERFORM pg_temp.f7_ok('E04 unique backstop index exists',
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'dispatch_requests_one_dispatch_per_order'));
END $$;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM f7t_cases;
  RAISE NOTICE 'F7 verify: ALL CHECKS PASSED (% cases; rolling back, nothing kept)', n;
END $$;

ROLLBACK;
