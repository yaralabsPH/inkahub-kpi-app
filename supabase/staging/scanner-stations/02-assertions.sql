-- F6 shared scanner stations: database assertions (single session).
--
-- STAGING ONLY. Never run against production. Refuses to start unless the
-- database has a location with key 'staging'. Requires 0047, 0052-0055.
--
-- Everything runs in ONE transaction that ends with ROLLBACK: nothing is
-- kept. It creates synthetic people (ids f6700000-...), badges F67E000n,
-- products "f6t-*", a temporary active rule set and orders 109670nn. While it
-- runs, the staging site's packaging mode is set to auto and any active rule
-- set is retired (both rolled back).
--
-- Pass = final notice "F6 verify: ALL CHECKS PASSED (N cases ...)". Any
-- failure raises "F6 verify FAILED [<case>] ..." naming the case.
--
-- Two-session races (classic vs shared, same-request retries) are in
-- 05-session-a.sql / 05-session-b.sql.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') THEN
    RAISE EXCEPTION 'F6 verify: no location "staging" in this database. Refusing to run: staging only.';
  END IF;
END $$;

CREATE TEMP TABLE f6t_cases (name text PRIMARY KEY) ON COMMIT DROP;

CREATE FUNCTION pg_temp.f6_ok(p_case text, p_ok boolean, p_detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'F6 verify FAILED [%] %', p_case, coalesce(p_detail, '');
  END IF;
  INSERT INTO f6t_cases (name) VALUES (p_case);
END $$;

-- Run one statement as a database role + signed-in user (NULL = nobody).
-- Returns {"state": SQLSTATE, "message", "value"}; 00000 = success.
CREATE FUNCTION pg_temp.f6_call(p_uid uuid, p_dbrole text, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
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

CREATE FUNCTION pg_temp.f6_must(p_case text, p_uid uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  r jsonb := pg_temp.f6_call(p_uid, 'authenticated', p_sql);
BEGIN
  PERFORM pg_temp.f6_ok(p_case, r ->> 'state' = '00000', format('expected success, got %s %s', r ->> 'state', r ->> 'message'));
  RETURN (r ->> 'value')::jsonb;
END $$;

CREATE FUNCTION pg_temp.f6_refused(p_case text, p_uid uuid, p_dbrole text, p_sql text, p_state text, p_message text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r jsonb := pg_temp.f6_call(p_uid, p_dbrole, p_sql);
BEGIN
  PERFORM pg_temp.f6_ok(p_case,
    r ->> 'state' = p_state AND (p_message IS NULL OR position(p_message IN r ->> 'message') > 0),
    format('expected %s %s, got %s %s (value %s)', p_state, coalesce(p_message, ''), r ->> 'state', r ->> 'message', r ->> 'value'));
END $$;

-- The expected caller defaults to whoever runs the statement (auth.uid());
-- the caller_mismatch cases pass someone else explicitly.
CREATE FUNCTION pg_temp.f6_activate_sql(p_req uuid, p_badge text, p_scanner text DEFAULT 'S1', p_expect uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.scanner_activate_badge(%L, %L, %L, %L, %L, %s)::text', 'staging', p_req, 'f6t-wall', p_scanner, p_badge,
                CASE WHEN p_expect IS NULL THEN 'auth.uid()' ELSE quote_literal(p_expect) || '::uuid' END)
$$;

CREATE FUNCTION pg_temp.f6_commit_sql(p_req uuid, p_staff uuid, p_badge text, p_order text, p_at timestamptz,
                                      p_lines jsonb, p_comps jsonb DEFAULT '[]', p_pack jsonb DEFAULT NULL, p_expect uuid DEFAULT NULL)
RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.scanner_commit_framing(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %s)::text',
                'staging', p_req, 'f6t-wall', 'S1', p_staff, p_badge, p_order, p_at, p_lines, p_comps, p_pack,
                CASE WHEN p_expect IS NULL THEN 'auth.uid()' ELSE quote_literal(p_expect) || '::uuid' END)
$$;

CREATE FUNCTION pg_temp.f6_deduct_sql(p_event text, p_lines jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.deduct_inventory_for_event(%L, %L)::text', p_event, p_lines)
$$;

CREATE FUNCTION pg_temp.f6_on_hand(p_id text) RETURNS numeric LANGUAGE sql AS $$
  SELECT current_on_hand FROM public.products WHERE location = 'staging' AND id = p_id
$$;

CREATE FUNCTION pg_temp.f6_events(p_order text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.production_events WHERE location = 'staging' AND order_number = p_order
$$;

CREATE FUNCTION pg_temp.f6_ledger(p_order text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.ledger
  WHERE location = 'staging' AND (source_id LIKE 'prod:order_' || p_order || ':%' OR note LIKE '%#' || p_order || '%')
$$;

-- ===========================================================================
-- Fixtures (all rolled back)
-- ===========================================================================
DO $$
DECLARE
  v_other text := (SELECT key FROM public.locations WHERE key <> 'staging' ORDER BY key LIMIT 1);
  v_ids   uuid[] := ARRAY[
    'f6700000-0000-4000-8000-0000000000f1', 'f6700000-0000-4000-8000-0000000000d1', 'f6700000-0000-4000-8000-0000000000d2',
    'f6700000-0000-4000-8000-0000000000e1', 'f6700000-0000-4000-8000-0000000000c1', 'f6700000-0000-4000-8000-0000000000d3',
    'f6700000-0000-4000-8000-000000000001', 'f6700000-0000-4000-8000-000000000002', 'f6700000-0000-4000-8000-000000000003',
    'f6700000-0000-4000-8000-000000000004']::uuid[];
  v_names text[] := ARRAY['F6T Owner','F6T Manager','F6T Kiosk','F6T Staff','F6T CS','F6T Kiosk Other','F6T Person 1','F6T Person 2','F6T Person 3','F6T Person 4'];
  v_roles text[] := ARRAY['owner','manager','kiosk','staff','cs','kiosk','staff','staff','staff','staff'];
  v_version int;
BEGIN
  IF v_other IS NULL THEN RAISE EXCEPTION 'F6 verify: needs a second location besides staging'; END IF;
  IF EXISTS (SELECT 1 FROM public.staff_barcodes WHERE barcode LIKE 'F67E000_' OR barcode LIKE '1096799_')
     OR EXISTS (SELECT 1 FROM public.production_events WHERE location = 'staging' AND order_number LIKE '109670__')
     OR EXISTS (SELECT 1 FROM public.ledger WHERE location = 'staging' AND source_id LIKE 'prod:order_109670%')
     OR EXISTS (SELECT 1 FROM public.products WHERE location = 'staging' AND id LIKE 'f6t-%') THEN
    RAISE EXCEPTION 'F6 verify: synthetic ids already in use on staging; investigate before running';
  END IF;

  FOR i IN 1 .. array_length(v_ids, 1) LOOP
    INSERT INTO auth.users (id, email) VALUES (v_ids[i], 'f6t-' || i || '@inka-staging.test');
    INSERT INTO public.profiles (user_id, display_name, role) VALUES (v_ids[i], v_names[i], v_roles[i])
      ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role;
    IF i NOT IN (6, 9) THEN
      INSERT INTO public.user_locations (user_id, location) VALUES (v_ids[i], 'staging') ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  -- Kiosk Other and Person 3 belong to another site only.
  INSERT INTO public.user_locations (user_id, location) VALUES (v_ids[6], v_other), (v_ids[9], v_other) ON CONFLICT DO NOTHING;

  INSERT INTO public.staff_barcodes (location, barcode, user_id, display_name, active) VALUES
    ('staging', 'F67E0001', v_ids[7], 'F6T Person 1', true),
    ('staging', 'F67E0002', v_ids[8], 'F6T Person 2', true),
    ('staging', 'F67E0003', v_ids[9], 'F6T Person 3', true),
    ('staging', 'F67E0004', v_ids[10], 'F6T Person 4', false),
    ('staging', '10967991', v_ids[10], 'F6T Person 4', false);
  -- A badge that exists only at another site (numeric, order-shaped).
  INSERT INTO public.staff_barcodes (location, barcode, user_id, display_name, active) VALUES
    (v_other, '10967992', v_ids[9], 'F6T Person 3', true),
    (v_other, 'F67E0005', v_ids[9], 'F6T Person 3', true);
  -- Manager can see both sites (for the ambiguous-event case).
  INSERT INTO public.user_locations (user_id, location) VALUES (v_ids[2], v_other) ON CONFLICT DO NOTHING;

  INSERT INTO public.products (location, id, code, supplier, product_type, current_on_hand) VALUES
    ('staging', 'f6t-a0b',  'F6T-A0B',  'F6T', 'product', 10),
    ('staging', 'f6t-hook', 'F6T-HOOK', 'F6T', 'product', 10),
    ('staging', 'f6t-box',  'F6T-BOX',  'F6T', 'packaging', 5),
    ('staging', 'f6t-low',  'F6T-LOW',  'F6T', 'product', 0);

  INSERT INTO public.packaging_settings (location, mode) VALUES ('staging', 'auto')
    ON CONFLICT (location) DO UPDATE SET mode = 'auto';
  UPDATE public.packaging_rule_sets SET status = 'retired' WHERE location = 'staging' AND status = 'active';
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM public.packaging_rule_sets WHERE location = 'staging';
  INSERT INTO public.packaging_rule_sets (location, id, version, status, body) VALUES ('staging', 'f6t-rs', v_version, 'active',
    jsonb_build_object('schema_version', 1,
      'catalogue', jsonb_build_array(jsonb_build_object('key', 'F6TBOX', 'product_id', 'f6t-box', 'label', 'F6T box', 'packing_points', jsonb_build_array('a0_framed'))),
      'rules', '[]'::jsonb, 'examples', '[]'::jsonb));
END $$;

CREATE TEMP TABLE f6t_ids ON COMMIT DROP AS SELECT
  'f6700000-0000-4000-8000-0000000000f1'::uuid AS owner, 'f6700000-0000-4000-8000-0000000000d1'::uuid AS manager,
  'f6700000-0000-4000-8000-0000000000d2'::uuid AS kiosk, 'f6700000-0000-4000-8000-0000000000e1'::uuid AS staff,
  'f6700000-0000-4000-8000-0000000000c1'::uuid AS cs,    'f6700000-0000-4000-8000-0000000000d3'::uuid AS kiosk_other,
  'f6700000-0000-4000-8000-000000000001'::uuid AS p1,    'f6700000-0000-4000-8000-000000000002'::uuid AS p2,
  'f6700000-0000-4000-8000-000000000003'::uuid AS p3,    'f6700000-0000-4000-8000-000000000004'::uuid AS p4,
  (SELECT version FROM public.packaging_rule_sets WHERE location = 'staging' AND id = 'f6t-rs') AS rs_version;

-- ===========================================================================
-- A. Privileges
-- ===========================================================================
DO $$
DECLARE
  i f6t_ids%ROWTYPE;
  v_line jsonb := '[{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]';
BEGIN
  SELECT * INTO i FROM f6t_ids;
  PERFORM pg_temp.f6_refused('A01 anon cannot activate', NULL, 'anon', pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0001'), '42501');
  PERFORM pg_temp.f6_refused('A02 anon cannot commit', NULL, 'anon',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967001', now(), v_line), '42501');
  PERFORM pg_temp.f6_refused('A03 anon cannot heartbeat', NULL, 'anon',
    $q$SELECT public.scanner_heartbeat('staging','w','',NULL,0,0)::text$q$, '42501');
  PERFORM pg_temp.f6_refused('A04 anon cannot call the legacy deduction', NULL, 'anon', pg_temp.f6_deduct_sql('x', '[]'), '42501');
  PERFORM pg_temp.f6_refused('A05 staff cannot activate', i.staff, 'authenticated', pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0001'), 'P0001', 'scanner: forbidden_role');
  PERFORM pg_temp.f6_refused('A06 cs cannot commit', i.cs, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967001', now(), v_line), 'P0001', 'scanner: forbidden_role');
  PERFORM pg_temp.f6_refused('A07 kiosk of another site cannot operate here', i.kiosk_other, 'authenticated',
    pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0001'), 'P0001', 'scanner: forbidden_location');
  PERFORM pg_temp.f6_refused('A08 signed-out caller refused', NULL, 'authenticated', pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0001'), 'P0001', 'scanner: not_authenticated');
  PERFORM pg_temp.f6_refused('A09 helpers are not callable', i.kiosk, 'authenticated',
    $q$SELECT public.production_deduct_locked_('staging','x','10967001','a0_framed','completed','[]')::text$q$, '42501');
  PERFORM pg_temp.f6_refused('A10 helpers are not callable (lock)', i.kiosk, 'authenticated',
    $q$SELECT public.production_order_lock_('staging','10967001')::text$q$, '42501');
  PERFORM pg_temp.f6_refused('A11 no direct receipt writes', i.owner, 'authenticated',
    $q$INSERT INTO public.scanner_requests (location, request_id, kind, caller, receiver_id, scanner_id, payload_hash, outcome, result)
       VALUES ('staging', gen_random_uuid(), 'activate', auth.uid(), 'w', 'S1', repeat('0', 64), 'activated', '{}') RETURNING 'x'$q$, '42501');
  PERFORM pg_temp.f6_refused('A12 no direct health writes', i.owner, 'authenticated',
    $q$INSERT INTO public.scanner_receivers (location, caller, receiver_id, heartbeat_at) VALUES ('staging', auth.uid(), 'w', now()) RETURNING 'x'$q$, '42501');
  PERFORM pg_temp.f6_ok('A13 every 0055 function pins search_path and the RPCs are definer',
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND p.proname IN ('scanner_activate_badge','scanner_commit_framing','scanner_heartbeat','deduct_inventory_for_event',
                                    'scanner_require_operator_','production_order_lock_','production_deduct_locked_','scanner_workday_start_',
                                    'scanner_site_zone_','scanner_hash_','scanner_guard_classic_credit_')
                  AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))
    AND (SELECT bool_and(prosecdef) FROM pg_proc WHERE proname IN ('scanner_activate_badge','scanner_commit_framing','scanner_heartbeat','deduct_inventory_for_event')));
END $$;

-- ===========================================================================
-- B. Badge activation and clock-in
-- ===========================================================================
DO $$
DECLARE
  i  f6t_ids%ROWTYPE;
  r  jsonb;
  r2 jsonb;
  q  uuid := gen_random_uuid();
  v_n bigint;
BEGIN
  SELECT * INTO i FROM f6t_ids;
  r := pg_temp.f6_must('B01 unknown badge', i.kiosk, pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E00FF'));
  PERFORM pg_temp.f6_ok('B01 unknown badge answers unknown_badge', r = '{"status":"unknown_badge"}'::jsonb, r::text);
  r := pg_temp.f6_must('B02 inactive badge', i.kiosk, pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0004'));
  PERFORM pg_temp.f6_ok('B02 a revoked badge is known but unusable', r = '{"status":"unusable_badge"}'::jsonb, r::text);
  r := pg_temp.f6_must('B02b numeric inactive badge', i.kiosk, pg_temp.f6_activate_sql(gen_random_uuid(), '10967991'));
  PERFORM pg_temp.f6_ok('B02b an order-shaped inactive badge is unusable, never unknown (no order fallback)', r = '{"status":"unusable_badge"}'::jsonb, r::text);
  r := pg_temp.f6_must('B02c other-site badge', i.kiosk, pg_temp.f6_activate_sql(gen_random_uuid(), '10967992'));
  PERFORM pg_temp.f6_ok('B02c an order-shaped badge of another site is unusable and discloses nothing', r = '{"status":"unusable_badge"}'::jsonb, r::text);
  r := pg_temp.f6_must('B02d other-site hex badge', i.kiosk, pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0005'));
  PERFORM pg_temp.f6_ok('B02d a hex badge of another site is unusable', r = '{"status":"unusable_badge"}'::jsonb, r::text);
  PERFORM pg_temp.f6_refused('B02e activation for another account', i.kiosk, 'authenticated',
    pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0001', 'S1', i.manager), 'P0001', 'scanner: caller_mismatch');
  PERFORM pg_temp.f6_ok('B02e ...wrote nothing', NOT EXISTS (SELECT 1 FROM public.production_events WHERE location = 'staging' AND staff_id = i.p1));
  PERFORM pg_temp.f6_refused('B03 person not at this site', i.kiosk, 'authenticated', pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0003'), 'P0001', 'scanner: person_not_at_site');

  r := pg_temp.f6_must('B04 activate person 1', i.kiosk, pg_temp.f6_activate_sql(q, 'f67e0001'));
  PERFORM pg_temp.f6_ok('B04 returns only id and name, and clocks in',
    r = jsonb_build_object('status','activated','person_id',i.p1,'display_name','F6T Person 1','clocked_in',true), r::text);
  SELECT count(*) INTO v_n FROM public.production_events WHERE location = 'staging' AND staff_id = i.p1 AND event_type = 'clock_in';
  PERFORM pg_temp.f6_ok('B05 exactly one clock_in, stable id, server time',
    v_n = 1 AND EXISTS (SELECT 1 FROM public.production_events WHERE location = 'staging' AND staff_id = i.p1 AND event_type = 'clock_in'
                          AND id = 'scn-' || replace(q::text, '-', '') || '-ci' AND created_at = now() AND order_number IS NULL));

  r2 := pg_temp.f6_must('B06 replay', i.kiosk, pg_temp.f6_activate_sql(q, 'F67E0001'));
  PERFORM pg_temp.f6_ok('B06 lost-response replay returns the same answer', r2 = r || '{"replayed":true}'::jsonb, r2::text);
  PERFORM pg_temp.f6_refused('B07 same request, other badge', i.kiosk, 'authenticated', pg_temp.f6_activate_sql(q, 'F67E0002'), 'P0001', 'scanner: request_conflict');
  PERFORM pg_temp.f6_refused('B08 same request, other caller', i.manager, 'authenticated', pg_temp.f6_activate_sql(q, 'F67E0001'), 'P0001', 'scanner: request_conflict');
  PERFORM pg_temp.f6_refused('B09 role check precedes replay', i.staff, 'authenticated', pg_temp.f6_activate_sql(q, 'F67E0001'), 'P0001', 'scanner: forbidden_role');

  r := pg_temp.f6_must('B10 second scanner, same person', i.kiosk, pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0001', 'S2'));
  PERFORM pg_temp.f6_ok('B10 switching scanners does not clock in twice', r ->> 'clocked_in' = 'false', r::text);
  SELECT count(*) INTO v_n FROM public.production_events WHERE location = 'staging' AND staff_id = i.p1 AND event_type = 'clock_in';
  PERFORM pg_temp.f6_ok('B11 still one clock_in', v_n = 1);

  INSERT INTO public.production_events (location, id, staff_id, department, event_type, created_at)
  VALUES ('staging', 'f6t-co-1', i.p1, 'framed', 'clock_out', now());
  r := pg_temp.f6_must('B12 after clock out', i.kiosk, pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0001'));
  PERFORM pg_temp.f6_ok('B12 a clocked-out person is clocked in again', r ->> 'clocked_in' = 'true', r::text);

  PERFORM pg_temp.f6_refused('B13 bad badge shape', i.kiosk, 'authenticated', pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E000'), 'P0001', 'scanner: invalid_input');
  PERFORM pg_temp.f6_refused('B14 bad scanner id', i.kiosk, 'authenticated', pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0001', 's1'), 'P0001', 'scanner: invalid_input');

  -- Site workday boundary (04:00 site-local, server UTC).
  PERFORM pg_temp.f6_ok('B15 AU 03:59 local belongs to the previous workday',
    public.scanner_workday_start_('au', '2026-11-22T16:59:00Z') = '2026-11-21T17:00:00Z'
    AND public.scanner_workday_start_('au', '2026-11-22T17:00:00Z') = '2026-11-22T17:00:00Z');
  PERFORM pg_temp.f6_ok('B16 UK (GMT) and staging (UTC) boundaries',
    public.scanner_workday_start_('uk', '2026-11-22T03:59:00Z') = '2026-11-21T04:00:00Z'
    AND public.scanner_workday_start_('staging', '2026-11-22T04:00:00Z') = '2026-11-22T04:00:00Z'
    AND public.scanner_workday_start_('us', '2026-07-01T08:59:00Z') = '2026-06-30T09:00:00Z');
END $$;

-- ===========================================================================
-- C. Regular framed commit, replay, conflict, already recorded, F5 snapshot
-- ===========================================================================
DO $$
DECLARE
  i  f6t_ids%ROWTYPE;
  q  uuid := gen_random_uuid();
  t  timestamptz := now() - interval '3 minutes';
  v_lines jsonb := '[{"sku":"INKA-S3ABC0002-A3-FN","quantity":1,"work_type":"framed"},{"sku":"INKA-ABC0001-A2-FB","quantity":2,"work_type":"framed"}]';
  r  jsonb;
  r2 jsonb;
  v_ledger_before bigint := (SELECT count(*) FROM public.ledger WHERE location = 'staging');
BEGIN
  SELECT * INTO i FROM f6t_ids;
  r := pg_temp.f6_must('C01 save framed order', i.kiosk, pg_temp.f6_commit_sql(q, i.p1, 'F67E0001', '10967001', t, v_lines));
  PERFORM pg_temp.f6_ok('C01 saved with pieces = qty x set size', r ->> 'status' = 'saved' AND (r ->> 'pieces')::int = 5
    AND r -> 'deduction' = 'null'::jsonb AND r -> 'work_types' = '["framed"]'::jsonb, r::text);
  PERFORM pg_temp.f6_ok('C02 one line_verified per SKU with raw quantity, one completed, original time, bound person',
    (SELECT count(*) FROM public.production_events WHERE location = 'staging' AND order_number = '10967001') = 3
    AND EXISTS (SELECT 1 FROM public.production_events WHERE location = 'staging' AND order_number = '10967001' AND event_type = 'line_verified'
                AND line_sku = 'INKA-ABC0001-A2-FB' AND line_quantity = 2 AND department = 'framed' AND staff_id = i.p1
                AND created_at = t AND station_id = 'shared:f6t-wall:S1' AND cs_case_id IS NULL)
    AND EXISTS (SELECT 1 FROM public.production_events WHERE location = 'staging' AND order_number = '10967001' AND event_type = 'line_verified'
                AND line_sku = 'INKA-S3ABC0002-A3-FN' AND line_quantity = 1)
    AND EXISTS (SELECT 1 FROM public.production_events WHERE location = 'staging' AND order_number = '10967001' AND event_type = 'completed'
                AND line_sku IS NULL AND line_quantity = 3 AND department = 'framed' AND id = 'scn-' || replace(q::text, '-', '') || '-c-framed'));
  PERFORM pg_temp.f6_ok('C03 regular framed deducts nothing (dispatch does)',
    (SELECT count(*) FROM public.ledger WHERE location = 'staging') = v_ledger_before);
  PERFORM pg_temp.f6_ok('C04 F5 triggers saw the original time and the bound person',
    NOT EXISTS (SELECT 1 FROM public.production_events WHERE location = 'staging' AND order_number = '10967001'
                AND (department_occurred_at IS DISTINCT FROM t OR business_department_status IS NULL
                     OR business_department_status = 'resolver_unavailable' OR department_received_at IS NULL)));

  r2 := pg_temp.f6_must('C05 replay', i.kiosk, pg_temp.f6_commit_sql(q, i.p1, 'F67E0001', '10967001', t, v_lines));
  PERFORM pg_temp.f6_ok('C05 replay answers the receipt, writes nothing', r2 = r || '{"replayed":true}'::jsonb
    AND pg_temp.f6_events('10967001') = 3, r2::text);
  -- Same lines in another order and spelling: the server hash is canonical.
  r2 := pg_temp.f6_must('C06 canonical replay', i.kiosk, pg_temp.f6_commit_sql(q, i.p1, 'f67e0001', '10967001', t,
    '[{"work_type":"framed","sku":"INKA-ABC0001-A2-FB","quantity":2.0},{"quantity":1,"sku":"INKA-S3ABC0002-A3-FN","work_type":"framed"}]'));
  PERFORM pg_temp.f6_ok('C06 reordered keys/lines replay the same request', r2 ->> 'replayed' = 'true', r2::text);
  PERFORM pg_temp.f6_refused('C07 changed payload under the same request', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(q, i.p1, 'F67E0001', '10967001', t, '[{"sku":"INKA-ABC0001-A2-FB","quantity":3,"work_type":"framed"}]'),
    'P0001', 'scanner: request_conflict');
  PERFORM pg_temp.f6_refused('C07b the same request replayed by another account for the original', i.manager, 'authenticated',
    pg_temp.f6_commit_sql(q, i.p1, 'F67E0001', '10967001', t, v_lines, '[]', NULL, i.kiosk), 'P0001', 'scanner: caller_mismatch');
  PERFORM pg_temp.f6_refused('C07c a queued job of one account sent under another', i.manager, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967017', now(), v_lines, '[]', NULL, i.kiosk), 'P0001', 'scanner: caller_mismatch');
  PERFORM pg_temp.f6_ok('C07c ...wrote nothing', pg_temp.f6_events('10967017') = 0);
  PERFORM pg_temp.f6_refused('C08 changed person under the same request', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(q, i.p2, 'F67E0002', '10967001', t, v_lines), 'P0001', 'scanner: request_conflict');
  PERFORM pg_temp.f6_refused('C09 changed scan time under the same request', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(q, i.p1, 'F67E0001', '10967001', t + interval '1 second', v_lines), 'P0001', 'scanner: request_conflict');

  r2 := pg_temp.f6_must('C10 new request, same order', i.kiosk, pg_temp.f6_commit_sql(gen_random_uuid(), i.p2, 'F67E0002', '10967001', now(), v_lines));
  PERFORM pg_temp.f6_ok('C10 second save of the order is already_recorded and adds nothing',
    r2 ->> 'status' = 'already_recorded' AND pg_temp.f6_events('10967001') = 3, r2::text);
  PERFORM pg_temp.f6_ok('C11 one receipt for the order',
    (SELECT count(*) FROM public.scanner_requests WHERE location = 'staging' AND order_number = '10967001') = 1);
  PERFORM pg_temp.f6_ok('C12 manager can read the receipt; kiosk cannot',
    (pg_temp.f6_call(i.manager, 'authenticated', $q$SELECT count(*)::text FROM public.scanner_requests WHERE order_number = '10967001'$q$) ->> 'value') = '1'
    AND (pg_temp.f6_call(i.kiosk, 'authenticated', $q$SELECT count(*)::text FROM public.scanner_requests$q$) ->> 'value') = '0');
END $$;

-- ===========================================================================
-- D. A0 commit: components, F4 packaging, aliases with the classic path
-- ===========================================================================
DO $$
DECLARE
  i  f6t_ids%ROWTYPE;
  q  uuid := gen_random_uuid();
  v_lines jsonb := '[{"sku":"INKA-ABC0001-A0-FB","quantity":2,"work_type":"a0_framed"},{"sku":"INKA-ABC0003-A1-FW","quantity":1,"work_type":"framed"}]';
  v_comps jsonb := '[{"code":"F6T-A0B","qty":2},{"code":"F6T-HOOK","qty":1}]';
  v_pack  jsonb;
  r  jsonb;
BEGIN
  SELECT * INTO i FROM f6t_ids;
  v_pack := jsonb_build_object('rule_set_id', 'f6t-rs', 'rule_set_version', i.rs_version, 'resolved', true,
    'predicted', '{"f6t-box":1}'::jsonb, 'target', '{"f6t-box":1}'::jsonb, 'snapshot', '{"packing_point":"a0_framed"}'::jsonb);
  r := pg_temp.f6_must('D01 save mixed A0 order', i.kiosk, pg_temp.f6_commit_sql(q, i.p1, 'F67E0001', '10967002', now(), v_lines, v_comps, v_pack));
  PERFORM pg_temp.f6_ok('D01 saved with both work types', r ->> 'status' = 'saved' AND r -> 'work_types' = '["a0_framed","framed"]'::jsonb
    AND (r -> 'deduction' ->> 'deducted')::int = 2 AND r ->> 'packaging_pick' IS NOT NULL, r::text);
  PERFORM pg_temp.f6_ok('D02 events: 2 verified + 2 completed',
    (SELECT count(*) FROM public.production_events WHERE location = 'staging' AND order_number = '10967002' AND event_type = 'line_verified') = 2
    AND (SELECT count(*) FROM public.production_events WHERE location = 'staging' AND order_number = '10967002' AND event_type = 'completed') = 2);
  PERFORM pg_temp.f6_ok('D03 components deducted once under canonical keys on the A0 completion',
    pg_temp.f6_on_hand('f6t-a0b') = 8 AND pg_temp.f6_on_hand('f6t-hook') = 9
    AND EXISTS (SELECT 1 FROM public.ledger WHERE location = 'staging' AND source_id = 'prod:order_10967002:F6T-A0B' AND delta = -2
                AND parent_event_id = 'scn-' || replace(q::text, '-', '') || '-c-a0_framed' AND reason = 'sale'));
  PERFORM pg_temp.f6_ok('D04 F4 pick applied inside the same transaction',
    pg_temp.f6_on_hand('f6t-box') = 4
    AND EXISTS (SELECT 1 FROM public.packaging_picks WHERE location = 'staging' AND order_number = '10967002' AND packing_point = 'a0_framed'
                AND state = 'auto' AND stock_state = 'posted' AND posted = '{"f6t-box":1}'::jsonb AND staff_id = i.p1)
    AND EXISTS (SELECT 1 FROM public.packaging_pick_changes WHERE location = 'staging' AND request_id = 'scn:' || q::text));

  -- Classic dispatch later sends the same products by other spellings: no second charge.
  INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, created_at)
  VALUES ('staging', 'f6t-dispatch-2', i.p2, 'dispatch', '10967002', 'dispatched', now());
  r := pg_temp.f6_must('D05 classic dispatch deduction', i.kiosk, pg_temp.f6_deduct_sql('f6t-dispatch-2',
    '[{"code":"f6t-a0b","qty":2},{"code":"f6t-hook","qty":1}]'));
  PERFORM pg_temp.f6_ok('D05 aliases (lower-case code, id) are recognised: nothing charged twice',
    (r ->> 'deducted')::int = 0 AND (r ->> 'skipped_idempotent')::int = 2
    AND pg_temp.f6_on_hand('f6t-a0b') = 8 AND pg_temp.f6_on_hand('f6t-hook') = 9, r::text);
  PERFORM pg_temp.f6_ok('D06 legacy result keeps the 0031 keys',
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k)
      = ARRAY['deducted','department','event_id','event_type','missing_codes','negative_codes','order_number','skipped_idempotent','status'], r::text);
END $$;

-- ===========================================================================
-- E. All or nothing
-- ===========================================================================
DO $$
DECLARE
  i  f6t_ids%ROWTYPE;
  v_lines jsonb := '[{"sku":"INKA-ABC0001-A0-FB","quantity":1,"work_type":"a0_framed"}]';
  v_pack  jsonb;
  v_box   numeric := pg_temp.f6_on_hand('f6t-box');
  v_a0b   numeric := pg_temp.f6_on_hand('f6t-a0b');
  v_ok    jsonb;
  r       jsonb;
BEGIN
  SELECT * INTO i FROM f6t_ids;
  v_pack := jsonb_build_object('rule_set_id', 'f6t-rs', 'rule_set_version', i.rs_version, 'resolved', true,
    'predicted', '{"f6t-box":1}'::jsonb, 'target', '{"f6t-box":1}'::jsonb, 'snapshot', '{}'::jsonb);
  PERFORM pg_temp.f6_refused('E01 missing stock code rolls back everything', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967003', now(), v_lines, '[{"code":"F6T-NOPE","qty":1}]', v_pack),
    'P0001', 'scanner: missing_stock_code');
  PERFORM pg_temp.f6_refused('E02 target differs from prediction', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967003', now(), v_lines, '[{"code":"F6T-A0B","qty":1}]',
      v_pack || '{"target":{"f6t-box":2}}'), 'P0001', 'scanner: packaging_invalid');
  PERFORM pg_temp.f6_refused('E03 unknown rule set', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967003', now(), v_lines, '[{"code":"F6T-A0B","qty":1}]',
      v_pack || '{"rule_set_id":"f6t-none"}'), 'P0001', 'scanner: packaging_invalid');
  PERFORM pg_temp.f6_refused('E04 rule-set version mismatch', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967003', now(), v_lines, '[{"code":"F6T-A0B","qty":1}]',
      v_pack || jsonb_build_object('rule_set_version', i.rs_version + 7)), 'P0001', 'scanner: packaging_invalid');
  PERFORM pg_temp.f6_refused('E05 packaging item not in the catalogue (F4 check inside)', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967003', now(), v_lines, '[{"code":"F6T-A0B","qty":1}]',
      v_pack || '{"predicted":{"f6t-hook":1},"target":{"f6t-hook":1}}'), 'P0001', 'packaging: not_in_catalogue');
  PERFORM pg_temp.f6_refused('E06 unresolved packaging refused', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967003', now(), v_lines, '[{"code":"F6T-A0B","qty":1}]',
      v_pack || '{"resolved":false}'), 'P0001', 'scanner: packaging_invalid');
  UPDATE public.packaging_settings SET mode = 'scan' WHERE location = 'staging';
  PERFORM pg_temp.f6_refused('E07 site not in automatic mode', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967003', now(), v_lines, '[{"code":"F6T-A0B","qty":1}]', v_pack),
    'P0001', 'scanner: packaging_not_auto');
  UPDATE public.packaging_settings SET mode = 'auto' WHERE location = 'staging';
  PERFORM pg_temp.f6_ok('E08 nothing at all was written for the refused order',
    pg_temp.f6_events('10967003') = 0 AND pg_temp.f6_ledger('10967003') = 0
    AND NOT EXISTS (SELECT 1 FROM public.packaging_picks WHERE location = 'staging' AND order_number = '10967003')
    AND NOT EXISTS (SELECT 1 FROM public.scanner_requests WHERE location = 'staging' AND order_number = '10967003')
    AND pg_temp.f6_on_hand('f6t-box') = v_box AND pg_temp.f6_on_hand('f6t-a0b') = v_a0b);

  -- Stock floor: either the schema refuses (CHECK current_on_hand >= 0, as in
  -- 0001) and everything rolls back, or negative stock is reported.
  v_ok := pg_temp.f6_call(i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967004', now(), v_lines, '[{"code":"F6T-LOW","qty":1}]', v_pack));
  IF v_ok ->> 'state' = '23514' THEN
    PERFORM pg_temp.f6_ok('E09 stock floor refusal rolls everything back',
      pg_temp.f6_events('10967004') = 0 AND pg_temp.f6_ledger('10967004') = 0 AND pg_temp.f6_on_hand('f6t-low') = 0);
  ELSE
    r := (v_ok ->> 'value')::jsonb;
    PERFORM pg_temp.f6_ok('E09 negative stock is saved and reported', v_ok ->> 'state' = '00000' AND r -> 'negative_codes' ? 'F6T-LOW', v_ok::text);
  END IF;
END $$;

-- ===========================================================================
-- F. Input bounds (each refused with invalid_input, nothing written)
-- ===========================================================================
DO $$
DECLARE
  i f6t_ids%ROWTYPE;
  c record;
  v_pack jsonb;
BEGIN
  SELECT * INTO i FROM f6t_ids;
  v_pack := jsonb_build_object('rule_set_id', 'f6t-rs', 'rule_set_version', i.rs_version, 'resolved', true,
    'predicted', '{"f6t-box":1}'::jsonb, 'target', '{"f6t-box":1}'::jsonb, 'snapshot', '{}'::jsonb);
  FOR c IN SELECT * FROM (VALUES
    ('F01 unframed line',        '10967005', now(), '[{"sku":"INKA-ABC0001-A2-UN","quantity":1,"work_type":"framed"}]'::jsonb, '[]'::jsonb, NULL::jsonb),
    ('F02 canvas line',          '10967005', now(), '[{"sku":"INKA-ABC0001-A2-SC","quantity":1,"work_type":"framed"}]', '[]', NULL),
    ('F03 work type mismatch',   '10967005', now(), '[{"sku":"INKA-ABC0001-A0-FB","quantity":1,"work_type":"framed"}]', '[]', NULL),
    ('F04 duplicate SKU',        '10967005', now(), '[{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"},{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]', '[]', NULL),
    ('F05 zero quantity',        '10967005', now(), '[{"sku":"INKA-ABC0001-A2-FB","quantity":0,"work_type":"framed"}]', '[]', NULL),
    ('F06 fractional quantity',  '10967005', now(), '[{"sku":"INKA-ABC0001-A2-FB","quantity":1.5,"work_type":"framed"}]', '[]', NULL),
    ('F07 huge quantity',        '10967005', now(), '[{"sku":"INKA-ABC0001-A2-FB","quantity":101,"work_type":"framed"}]', '[]', NULL),
    ('F08 string quantity',      '10967005', now(), '[{"sku":"INKA-ABC0001-A2-FB","quantity":"1","work_type":"framed"}]', '[]', NULL),
    ('F09 missing key',          '10967005', now(), '[{"sku":"INKA-ABC0001-A2-FB","quantity":1}]', '[]', NULL),
    ('F10 extra key',            '10967005', now(), '[{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed","x":1}]', '[]', NULL),
    ('F11 no lines',             '10967005', now(), '[]', '[]', NULL),
    ('F12 single gallery wall',  '10967005', now(), '[{"sku":"INKA-ABC0001-GW-FB","quantity":1,"work_type":"framed"}]', '[]', NULL),
    ('F13 future scan time',     '10967005', now() + interval '1 minute', '[{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]', '[]', NULL),
    ('F14 too-old scan time',    '10967005', now() - interval '15 days', '[{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]', '[]', NULL),
    ('F15 bad order shape',      '1096700',  now(), '[{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]', '[]', NULL),
    ('F16 components without A0','10967005', now(), '[{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]', '[{"code":"F6T-A0B","qty":1}]', NULL),
    ('F17 packaging without A0', '10967005', now(), '[{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]', '[]', v_pack),
    ('F18 A0 without packaging', '10967005', now(), '[{"sku":"INKA-ABC0001-A0-FB","quantity":1,"work_type":"a0_framed"}]', '[{"code":"F6T-A0B","qty":1}]', NULL),
    ('F19 A0 without components','10967005', now(), '[{"sku":"INKA-ABC0001-A0-FB","quantity":1,"work_type":"a0_framed"}]', '[]', v_pack),
    ('F20 duplicate component',  '10967005', now(), '[{"sku":"INKA-ABC0001-A0-FB","quantity":1,"work_type":"a0_framed"}]', '[{"code":"F6T-A0B","qty":1},{"code":"f6t-a0b","qty":1}]', v_pack),
    ('F21 lines not an array',   '10967005', now(), '{"sku":"INKA-ABC0001-A2-FB"}', '[]', NULL)
  ) AS t(name, ord, at, lines, comps, pack) LOOP
    PERFORM pg_temp.f6_refused(c.name, i.kiosk, 'authenticated',
      pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', c.ord, c.at, c.lines, c.comps, c.pack), 'P0001', 'scanner: invalid_input');
  END LOOP;
  PERFORM pg_temp.f6_ok('F22 nothing written for refused inputs', pg_temp.f6_events('10967005') = 0);
END $$;

-- ===========================================================================
-- G. Person, badge and case checks at commit time
-- ===========================================================================
DO $$
DECLARE
  i f6t_ids%ROWTYPE;
  v_line jsonb := '[{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]';
BEGIN
  SELECT * INTO i FROM f6t_ids;
  PERFORM pg_temp.f6_refused('G01 revoked badge cannot rebind a queued scan', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p4, 'F67E0004', '10967006', now(), v_line), 'P0001', 'scanner: badge_inactive');
  PERFORM pg_temp.f6_refused('G02 badge of another person', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p2, 'F67E0001', '10967006', now(), v_line), 'P0001', 'scanner: badge_inactive');
  PERFORM pg_temp.f6_refused('G03 person removed from the site', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p3, 'F67E0003', '10967006', now(), v_line), 'P0001', 'scanner: person_not_at_site');
  UPDATE public.staff_barcodes SET active = false WHERE location = 'staging' AND barcode = 'F67E0002';
  PERFORM pg_temp.f6_refused('G04 badge revoked after the scan was queued', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p2, 'F67E0002', '10967006', now() - interval '2 hours', v_line), 'P0001', 'scanner: badge_inactive');
  UPDATE public.staff_barcodes SET active = true WHERE location = 'staging' AND barcode = 'F67E0002';
  INSERT INTO public.cs_cases (location, id, status, issue_type, order_number) VALUES ('staging', 'f6t-case-1', 'query', 'damaged', '10967006');
  PERFORM pg_temp.f6_refused('G05 open replacement case goes to classic', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p2, 'F67E0002', '10967006', now(), v_line), 'P0001', 'scanner: open_case');
  UPDATE public.cs_cases SET status = 'closed' WHERE location = 'staging' AND id = 'f6t-case-1';
  PERFORM pg_temp.f6_ok('G06 a closed case does not block',
    (pg_temp.f6_must('G06 closed case', i.kiosk, pg_temp.f6_commit_sql(gen_random_uuid(), i.p2, 'F67E0002', '10967006', now(), v_line)) ->> 'status') = 'saved');
  PERFORM pg_temp.f6_ok('G07 owner and manager may also operate',
    (pg_temp.f6_must('G07 owner', i.owner, pg_temp.f6_commit_sql(gen_random_uuid(), i.p2, 'F67E0002', '10967007', now(), v_line)) ->> 'status') = 'saved'
    AND (pg_temp.f6_must('G07 manager', i.manager, pg_temp.f6_activate_sql(gen_random_uuid(), 'F67E0002')) ->> 'status') = 'activated');
END $$;

-- ===========================================================================
-- H. Prior and partial work
-- ===========================================================================
DO $$
DECLARE
  i f6t_ids%ROWTYPE;
  v_line jsonb := '[{"sku":"INKA-ABC0001-A2-FB","quantity":1,"work_type":"framed"}]';
  r jsonb;
BEGIN
  SELECT * INTO i FROM f6t_ids;
  -- A classic partial verification at Framed.
  INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, created_at)
  VALUES ('staging', 'f6t-v-8', i.p2, 'framed', '10967008', 'INKA-ABC0001-A2-FB', 1, 'line_verified', now() - interval '1 hour');
  r := pg_temp.f6_must('H01 partial work', i.kiosk, pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967008', now(), v_line));
  PERFORM pg_temp.f6_ok('H01 partial prior work is reported, never extra credit',
    r ->> 'status' = 'already_recorded' AND pg_temp.f6_events('10967008') = 1, r::text);
  -- The verification was undone on the classic station: now it may be saved.
  INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, parent_event_id, created_at)
  VALUES ('staging', 'f6t-x-8', i.p2, 'framed', '10967008', 'cancelled', 'f6t-v-8', now() - interval '50 minutes');
  r := pg_temp.f6_must('H02 after undo', i.kiosk, pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967008', now(), v_line));
  PERFORM pg_temp.f6_ok('H02 an undone verification does not block', r ->> 'status' = 'saved', r::text);
  -- Already dispatched.
  INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, created_at)
  VALUES ('staging', 'f6t-d-9', i.p2, 'dispatch', '10967009', 'dispatched', now() - interval '1 hour');
  r := pg_temp.f6_must('H03 dispatched', i.kiosk, pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967009', now(), v_line));
  PERFORM pg_temp.f6_ok('H03 a dispatched order is already recorded', r ->> 'status' = 'already_recorded', r::text);
  -- Work at an untouched work type (Unframed) does not block framed credit.
  INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, created_at)
  VALUES ('staging', 'f6t-u-10', i.p2, 'unframed', '10967010', 'completed', now() - interval '1 hour');
  r := pg_temp.f6_must('H04 other work type', i.kiosk, pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967010', now(), v_line));
  PERFORM pg_temp.f6_ok('H04 unframed work elsewhere does not block framed credit', r ->> 'status' = 'saved', r::text);
  -- Stock already charged for the A0 parts without a completion event: refuse, roll back.
  INSERT INTO public.ledger (location, id, product_id, delta, reason, source_id, note)
  VALUES ('staging', 'f6t-led-11', 'f6t-a0b', -1, 'sale', 'prod:order_10967011:f6t-a0b', 'f6t');
  PERFORM pg_temp.f6_refused('H05 stock already charged for the order', i.kiosk, 'authenticated',
    pg_temp.f6_commit_sql(gen_random_uuid(), i.p1, 'F67E0001', '10967011', now(),
      '[{"sku":"INKA-ABC0001-A0-FB","quantity":1,"work_type":"a0_framed"}]', '[{"code":"F6T-A0B","qty":1}]',
      jsonb_build_object('rule_set_id', 'f6t-rs', 'rule_set_version', i.rs_version, 'resolved', true,
        'predicted', '{"f6t-box":1}'::jsonb, 'target', '{"f6t-box":1}'::jsonb, 'snapshot', '{}'::jsonb)),
    'P0001', 'scanner: already_charged');
  PERFORM pg_temp.f6_ok('H06 ...and wrote nothing', pg_temp.f6_events('10967011') = 0
    AND NOT EXISTS (SELECT 1 FROM public.packaging_picks WHERE location = 'staging' AND order_number = '10967011'));
END $$;

-- ===========================================================================
-- J. Legacy deduction: authorization, unchanged routing, idempotency
-- ===========================================================================
DO $$
DECLARE
  i f6t_ids%ROWTYPE;
  r jsonb;
  v_a0b numeric;
BEGIN
  SELECT * INTO i FROM f6t_ids;
  INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, created_at, cs_case_id) VALUES
    ('staging', 'f6t-j-1', i.p1,    'a0_framed', '10967012', 'completed', now(), NULL),
    ('staging', 'f6t-j-2', i.staff, 'a0_framed', '10967013', 'completed', now(), NULL),
    ('staging', 'f6t-j-3', i.p1,    'a0_framed', '10967014', 'started',   now(), NULL),
    ('staging', 'f6t-j-4', i.p1,    'a0_framed', '10967015', 'completed', now(), 'f6t-case-x');
  PERFORM pg_temp.f6_refused('J01 staff cannot deduct for another person''s event', i.staff, 'authenticated',
    pg_temp.f6_deduct_sql('f6t-j-1', '[{"code":"F6T-A0B","qty":1}]'), '42501', 'forbidden_role');
  PERFORM pg_temp.f6_refused('J02 another site''s caller cannot see the event', i.kiosk_other, 'authenticated',
    pg_temp.f6_deduct_sql('f6t-j-1', '[{"code":"F6T-A0B","qty":1}]'), 'P0001', 'not found');
  PERFORM pg_temp.f6_refused('J03 signed-out caller', NULL, 'authenticated', pg_temp.f6_deduct_sql('f6t-j-1', '[]'), '42501', 'not_authenticated');
  v_a0b := pg_temp.f6_on_hand('f6t-a0b');
  r := pg_temp.f6_must('J04 staff on own event', i.staff, pg_temp.f6_deduct_sql('f6t-j-2', '[{"code":"F6T-A0B","qty":1},{"code":"F6T-NOPE","qty":1},{"code":"","qty":1},{"code":"F6T-HOOK","qty":0}]'));
  PERFORM pg_temp.f6_ok('J04 own event deducts; missing reported; blanks/zero skipped (as 0031)',
    r ->> 'status' = 'ok' AND (r ->> 'deducted')::int = 1 AND r -> 'missing_codes' = '["F6T-NOPE"]'::jsonb
    AND pg_temp.f6_on_hand('f6t-a0b') = v_a0b - 1, r::text);
  r := pg_temp.f6_must('J05 retry', i.staff, pg_temp.f6_deduct_sql('f6t-j-2', '[{"code":"F6T-A0B","qty":1}]'));
  PERFORM pg_temp.f6_ok('J05 a retried request charges nothing', (r ->> 'deducted')::int = 0 AND (r ->> 'skipped_idempotent')::int = 1
    AND pg_temp.f6_on_hand('f6t-a0b') = v_a0b - 1, r::text);
  r := pg_temp.f6_must('J06 non-terminal', i.kiosk, pg_temp.f6_deduct_sql('f6t-j-3', '[{"code":"F6T-A0B","qty":1}]'));
  PERFORM pg_temp.f6_ok('J06 non-terminal event skipped as before', r = '{"status":"skipped_event_type","event_type":"started"}'::jsonb, r::text);
  r := pg_temp.f6_must('J07 case', i.kiosk, pg_temp.f6_deduct_sql('f6t-j-4', '[{"code":"F6T-A0B","qty":1}]'));
  PERFORM pg_temp.f6_ok('J07 case-tagged event skipped as before', r ->> 'status' = 'skipped_cs_case', r::text);
  PERFORM pg_temp.f6_refused('J08 unknown event', i.kiosk, 'authenticated', pg_temp.f6_deduct_sql('f6t-none', '[]'), 'P0001', 'not found');
  -- An old row written with the supplied spelling is honoured for the canonical code.
  INSERT INTO public.ledger (location, id, product_id, delta, reason, source_id, note)
  VALUES ('staging', 'f6t-led-16', 'f6t-hook', -1, 'sale', 'prod:order_10967012:inka-hook-OLD', 'f6t');
  INSERT INTO public.ledger (location, id, product_id, delta, reason, source_id, note)
  VALUES ('staging', 'f6t-led-17', 'f6t-hook', -1, 'sale', 'prod:order_10967012:f6t-hook', 'f6t');
  r := pg_temp.f6_must('J09 alias', i.kiosk, pg_temp.f6_deduct_sql('f6t-j-1', '[{"code":"F6T-HOOK","qty":1}]'));
  PERFORM pg_temp.f6_ok('J09 a prior charge under the product id blocks the code', (r ->> 'skipped_idempotent')::int = 1 AND (r ->> 'deducted')::int = 0, r::text);
  r := pg_temp.f6_must('J10 sum per product', i.kiosk, pg_temp.f6_deduct_sql('f6t-j-1', '[{"code":"F6T-A0B","qty":1},{"code":"f6t-a0b","qty":2}]'));
  PERFORM pg_temp.f6_ok('J10 two spellings of one product in one call: one row, summed',
    (r ->> 'deducted')::int = 1
    AND (SELECT delta FROM public.ledger WHERE location = 'staging' AND source_id = 'prod:order_10967012:F6T-A0B') = -3, r::text);
END $$;

DO $$
DECLARE
  i f6t_ids%ROWTYPE;
  r jsonb;
  v_other text := (SELECT key FROM public.locations WHERE key <> 'staging' ORDER BY key LIMIT 1);
  v_a0b numeric;
  v_hook numeric;
BEGIN
  SELECT * INTO i FROM f6t_ids;
  INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, created_at) VALUES
    ('staging', 'f6t-amb', i.p1, 'a0_framed', '10967018', 'completed', now()),
    (v_other,   'f6t-amb', i.p1, 'a0_framed', '10967018', 'completed', now()),
    ('staging', 'f6t-j-19', i.p1, 'a0_framed', '10967019', 'completed', now());
  v_a0b := pg_temp.f6_on_hand('f6t-a0b');
  PERFORM pg_temp.f6_refused('J11 the same event id at two visible sites is refused, not guessed', i.manager, 'authenticated',
    pg_temp.f6_deduct_sql('f6t-amb', '[{"code":"F6T-A0B","qty":1}]'), 'P0001', 'ambiguous_event');
  r := pg_temp.f6_must('J12 one visible site', i.kiosk, pg_temp.f6_deduct_sql('f6t-amb', '[{"code":"F6T-A0B","qty":1}]'));
  PERFORM pg_temp.f6_ok('J12 a caller who sees only one of them is unaffected', (r ->> 'deducted')::int = 1
    AND pg_temp.f6_on_hand('f6t-a0b') = v_a0b - 1, r::text);
  -- 0031 stored whatever spelling it was given.
  INSERT INTO public.ledger (location, id, product_id, delta, reason, source_id, note) VALUES
    ('staging', 'f6t-led-19a', 'f6t-a0b',  -1, 'sale', 'prod:order_10967019:f6T-a0B', 'f6t'),
    ('staging', 'f6t-led-19b', 'f6t-hook', -1, 'sale', 'prod:order_10967019:Some-Old-Hook-Alias', 'f6t');
  v_a0b := pg_temp.f6_on_hand('f6t-a0b');
  v_hook := pg_temp.f6_on_hand('f6t-hook');
  r := pg_temp.f6_must('J13 mixed-case and foreign aliases', i.kiosk, pg_temp.f6_deduct_sql('f6t-j-19',
    '[{"code":"F6T-A0B","qty":1},{"code":"f6t-hook","qty":1}]'));
  PERFORM pg_temp.f6_ok('J13 earlier rows in any spelling block a second charge (product identity)',
    (r ->> 'skipped_idempotent')::int = 2 AND (r ->> 'deducted')::int = 0
    AND pg_temp.f6_on_hand('f6t-a0b') = v_a0b AND pg_temp.f6_on_hand('f6t-hook') = v_hook, r::text);
  PERFORM pg_temp.f6_ok('J14 the order-source lookup is indexed by site, order and product',
    EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'ledger' AND indexname = 'ledger_prod_order_idx'));
END $$;

-- ===========================================================================
-- M. Classic credit guard (same per-order lock as the shared commit)
-- ===========================================================================
DO $$
DECLARE
  i f6t_ids%ROWTYPE;
  v_before bigint := pg_temp.f6_events('10967001');
  v_n bigint;
BEGIN
  SELECT * INTO i FROM f6t_ids;
  -- 10967001: Framed work saved by the shared scanners in section C.
  PERFORM pg_temp.f6_refused('M01 classic verification after a shared save is refused', i.kiosk, 'authenticated',
    $q$INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type)
       VALUES ('staging', 'f6t-m-1', 'f6700000-0000-4000-8000-000000000002', 'framed', '10967001', 'INKA-ABC0001-A2-FB', 2, 'line_verified') RETURNING 'x'$q$,
    'P0001', 'scanner: already_saved_by_shared_scanner');
  PERFORM pg_temp.f6_refused('M02 classic completion after a shared save is refused', i.kiosk, 'authenticated',
    $q$INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type)
       VALUES ('staging', 'f6t-m-2', 'f6700000-0000-4000-8000-000000000002', 'framed', '10967001', 'completed') RETURNING 'x'$q$,
    'P0001', 'scanner: already_saved_by_shared_scanner');
  PERFORM pg_temp.f6_ok('M03 no extra credit row', pg_temp.f6_events('10967001') = v_before);
  -- Still allowed on that order: dispatch after framing, CS replacement, brackets, undo, other work types.
  PERFORM pg_temp.f6_must('M04 dispatch after framing', i.kiosk,
    $q$WITH x AS (INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type)
       VALUES ('staging', 'f6t-m-4', 'f6700000-0000-4000-8000-000000000002', 'dispatch', '10967001', 'dispatched') RETURNING 1) SELECT '{}' FROM x$q$);
  PERFORM pg_temp.f6_must('M05 explicit CS replacement credit', i.kiosk,
    $q$WITH x AS (INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, cs_case_id)
       VALUES ('staging', 'f6t-m-5', 'f6700000-0000-4000-8000-000000000002', 'framed', '10967001', 'INKA-ABC0001-A2-FB', 1, 'line_verified', 'f6t-case-r') RETURNING 1) SELECT '{}' FROM x$q$);
  PERFORM pg_temp.f6_must('M06 started bracket', i.kiosk,
    $q$WITH x AS (INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type)
       VALUES ('staging', 'f6t-m-6', 'f6700000-0000-4000-8000-000000000002', 'framed', '10967001', 'started') RETURNING 1) SELECT '{}' FROM x$q$);
  PERFORM pg_temp.f6_must('M07 A0 work type the shared save did not credit', i.kiosk,
    $q$WITH x AS (INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type)
       VALUES ('staging', 'f6t-m-7', 'f6700000-0000-4000-8000-000000000002', 'a0_framed', '10967001', 'completed') RETURNING 1) SELECT '{}' FROM x$q$);
  PERFORM pg_temp.f6_must('M08 an order the shared scanners never saved', i.kiosk,
    $q$WITH x AS (INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type)
       VALUES ('staging', 'f6t-m-8', 'f6700000-0000-4000-8000-000000000002', 'framed', '10967020', 'completed') RETURNING 1) SELECT '{}' FROM x$q$);
  SELECT count(*) INTO v_n FROM public.production_events WHERE location = 'staging' AND id LIKE 'f6t-m-%';
  PERFORM pg_temp.f6_ok('M09 exactly the five allowed rows exist', v_n = 5, v_n::text);
END $$;

-- ===========================================================================
-- K. Health row
-- ===========================================================================
DO $$
DECLARE
  i f6t_ids%ROWTYPE;
BEGIN
  SELECT * INTO i FROM f6t_ids;
  PERFORM pg_temp.f6_must('K01 heartbeat', i.kiosk, $q$SELECT public.scanner_heartbeat('staging','f6t-wall','Wall 1','2026-11-22T00:00:00Z',3,1)::text$q$);
  PERFORM pg_temp.f6_must('K02 heartbeat again', i.kiosk, $q$SELECT public.scanner_heartbeat('staging','f6t-wall','Wall 1',NULL,0,0)::text$q$);
  PERFORM pg_temp.f6_ok('K03 one current row per caller/site/receiver; last scan never goes backwards',
    (SELECT count(*) FROM public.scanner_receivers WHERE location = 'staging' AND receiver_id = 'f6t-wall') = 1
    AND (SELECT last_scan_at FROM public.scanner_receivers WHERE location = 'staging' AND receiver_id = 'f6t-wall') = '2026-11-22T00:00:00Z'
    AND (SELECT queue_count FROM public.scanner_receivers WHERE location = 'staging' AND receiver_id = 'f6t-wall') = 0);
  PERFORM pg_temp.f6_refused('K04 staff cannot heartbeat', i.staff, 'authenticated',
    $q$SELECT public.scanner_heartbeat('staging','f6t-wall','',NULL,0,0)::text$q$, 'P0001', 'scanner: forbidden_role');
  PERFORM pg_temp.f6_refused('K05 bounded', i.kiosk, 'authenticated',
    $q$SELECT public.scanner_heartbeat('staging','f6t-wall','',NULL,-1,0)::text$q$, 'P0001', 'scanner: invalid_input');
  PERFORM pg_temp.f6_ok('K06 manager sees the row; kiosk and staff do not',
    (pg_temp.f6_call(i.manager, 'authenticated', $q$SELECT count(*)::text FROM public.scanner_receivers WHERE receiver_id = 'f6t-wall'$q$) ->> 'value') = '1'
    AND (pg_temp.f6_call(i.kiosk, 'authenticated', $q$SELECT count(*)::text FROM public.scanner_receivers$q$) ->> 'value') = '0'
    AND (pg_temp.f6_call(i.staff, 'authenticated', $q$SELECT count(*)::text FROM public.scanner_receivers$q$) ->> 'value') = '0');
END $$;

-- ===========================================================================
-- L. Backstop index and plans
-- ===========================================================================
DO $$
DECLARE
  v_state text := '00000';
BEGIN
  BEGIN
    INSERT INTO public.scanner_requests (location, request_id, kind, caller, receiver_id, scanner_id, order_number, payload_hash, outcome, result)
    VALUES ('staging', gen_random_uuid(), 'commit', 'f6700000-0000-4000-8000-0000000000d2', 'w', 'S1', '10967001', repeat('a', 64), 'saved', '{}');
  EXCEPTION WHEN unique_violation THEN
    v_state := SQLSTATE;
  END;
  PERFORM pg_temp.f6_ok('L01 at most one saved commit per order (unique backstop)', v_state = '23505', v_state);
  PERFORM pg_temp.f6_ok('L02 the order lookups are indexed',
    EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'production_events' AND indexdef LIKE '%(location, order_number%')
    AND EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'ledger' AND indexdef LIKE '%(location, source_id)%')
    AND EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'scanner_requests' AND indexname = 'scanner_requests_one_commit_per_order'));
END $$;

-- ===========================================================================
-- Summary
-- ===========================================================================
DO $$
DECLARE
  v_passed int := (SELECT count(*) FROM f6t_cases);
BEGIN
  RAISE NOTICE 'F6 verify: ALL CHECKS PASSED (% cases; rolling back, nothing kept)', v_passed;
END $$;

ROLLBACK;
