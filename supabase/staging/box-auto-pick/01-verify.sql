-- F4 box-auto-pick: database verification.
--
-- STAGING ONLY. Never run against production.
-- Requires migration 0047_packaging_auto_pick.sql to be applied first.
--
-- Everything runs inside one transaction that ends with ROLLBACK, so no row
-- survives: synthetic products, events, rule sets, picks and ledger rows are
-- all discarded. It impersonates existing staging users (by role) only by
-- setting the request JWT claims for this transaction.
--
-- Pass = the final notice "F4 verify: ALL CHECKS PASSED". Any failure raises
-- an exception naming the check.

BEGIN;

CREATE TEMP TABLE f4t (k TEXT PRIMARY KEY, v TEXT) ON COMMIT DROP;

-- Become a user (or nobody, with NULL) for the rest of the transaction.
CREATE FUNCTION pg_temp.f4_as(p_uid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), true);
  PERFORM set_config(
    'request.jwt.claims',
    CASE WHEN p_uid IS NULL THEN '' ELSE jsonb_build_object('sub', p_uid, 'role', 'authenticated')::text END,
    true
  );
END $$;

-- Run a statement that must fail with a message containing p_code.
CREATE FUNCTION pg_temp.f4_refused(p_check TEXT, p_sql TEXT, p_code TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF position(p_code IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'F4 verify FAILED [%]: expected "%", got "%"', p_check, p_code, SQLERRM;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'F4 verify FAILED [%]: statement was not refused (expected "%")', p_check, p_code;
END $$;

CREATE FUNCTION pg_temp.f4_true(p_check TEXT, p_ok BOOLEAN) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'F4 verify FAILED [%]', p_check;
  END IF;
END $$;

CREATE FUNCTION pg_temp.f4_get(p_k TEXT) RETURNS TEXT LANGUAGE sql AS $$ SELECT v FROM f4t WHERE k = p_k $$;

CREATE FUNCTION pg_temp.f4_on_hand(p_id TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT current_on_hand FROM products WHERE location = pg_temp.f4_get('loc') AND id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: existing users by role, synthetic everything else
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_loc   TEXT;
  v_owner UUID;
  v_kiosk UUID;
  v_staff UUID;
BEGIN
  SELECT p.user_id, ul.location INTO v_owner, v_loc
  FROM   profiles p JOIN user_locations ul ON ul.user_id = p.user_id
  WHERE  p.role IN ('owner', 'manager')
  ORDER  BY (p.role = 'owner') DESC, ul.location
  LIMIT  1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F4 verify: staging needs an owner or manager with access to a site';
  END IF;

  SELECT p.user_id INTO v_kiosk
  FROM   profiles p JOIN user_locations ul ON ul.user_id = p.user_id
  WHERE  p.role = 'kiosk' AND ul.location = v_loc LIMIT 1;
  SELECT p.user_id INTO v_staff
  FROM   profiles p JOIN user_locations ul ON ul.user_id = p.user_id
  WHERE  p.role = 'staff' AND ul.location = v_loc LIMIT 1;

  INSERT INTO f4t VALUES ('loc', v_loc), ('owner', v_owner::text), ('kiosk', v_kiosk::text), ('staff', v_staff::text);

  INSERT INTO products (location, id, code, supplier, current_on_hand) VALUES
    (v_loc, 'f4t-box-a', 'F4T-BOX-A', 'f4-test', 10),
    (v_loc, 'f4t-box-b', 'F4T-BOX-B', 'f4-test', 10),
    (v_loc, 'f4t-box-c', 'F4T-BOX-C', 'f4-test', 0),
    (v_loc, 'f4t-other', 'F4T-OTHER', 'f4-test', 10);

  -- Synthetic completion events (order numbers that cannot be real).
  INSERT INTO production_events (location, id, staff_id, department, order_number, event_type, cs_case_id) VALUES
    (v_loc, 'f4t-ev1',  v_owner, 'dispatch',  'F4T-1001', 'dispatched',    NULL),
    (v_loc, 'f4t-ev1b', v_owner, 'dispatch',  'F4T-1001', 'dispatched',    NULL),
    (v_loc, 'f4t-ev2',  v_owner, 'dispatch',  'F4T-1002', 'dispatched',    NULL),
    (v_loc, 'f4t-ev3',  v_owner, 'a0_framed', 'F4T-1003', 'completed',     NULL),
    (v_loc, 'f4t-ev4',  v_owner, 'dispatch',  'F4T-1004', 'dispatched',    NULL),
    (v_loc, 'f4t-ev5',  v_owner, 'dispatch',  'F4T-1001', 'dispatched',    'f4t-case'),
    (v_loc, 'f4t-ev6',  v_owner, 'framed',    'F4T-1005', 'completed',     NULL),
    (v_loc, 'f4t-ev7',  v_owner, 'dispatch',  'F4T-1006', 'line_verified', NULL),
    (v_loc, 'f4t-ev8',  v_owner, 'a0_framed', 'F4T-1001', 'completed',     NULL);

  RAISE NOTICE 'F4 verify: site %, kiosk user %, staff user %', v_loc,
    CASE WHEN v_kiosk IS NULL THEN 'none (kiosk checks skipped)' ELSE 'found' END,
    CASE WHEN v_staff IS NULL THEN 'none (staff checks skipped)' ELSE 'found' END;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Grants: nothing for anon, helpers internal, no direct table writes
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'packaging_save_rule_set(text,text,jsonb,text)',
    'packaging_activate_rule_set(text,text)',
    'packaging_set_mode(text,text)',
    'packaging_apply(text,text,text,text,boolean,jsonb,jsonb,jsonb)',
    'packaging_override(text,text,text,integer,jsonb,text,uuid)',
    'packaging_retry(text,text,text)'
  ] LOOP
    PERFORM pg_temp.f4_true('anon cannot execute ' || f, NOT has_function_privilege('anon', f, 'EXECUTE'));
    PERFORM pg_temp.f4_true('authenticated can execute ' || f, has_function_privilege('authenticated', f, 'EXECUTE'));
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'packaging_reconcile_(text,text)',
    'packaging_check_quantities_(text,jsonb,text[],text)',
    'packaging_allowed_products_(text,text)',
    'packaging_lock_(text,text,text,text)'
  ] LOOP
    PERFORM pg_temp.f4_true('authenticated cannot execute ' || f, NOT has_function_privilege('authenticated', f, 'EXECUTE'));
    PERFORM pg_temp.f4_true('anon cannot execute ' || f, NOT has_function_privilege('anon', f, 'EXECUTE'));
  END LOOP;
  FOREACH f IN ARRAY ARRAY['packaging_settings', 'packaging_rule_sets', 'packaging_picks', 'packaging_pick_changes'] LOOP
    PERFORM pg_temp.f4_true(f || ' readable', has_table_privilege('authenticated', f, 'SELECT'));
    PERFORM pg_temp.f4_true(f || ' not writable', NOT has_table_privilege('authenticated', f, 'INSERT')
      AND NOT has_table_privilege('authenticated', f, 'UPDATE') AND NOT has_table_privilege('authenticated', f, 'DELETE'));
    PERFORM pg_temp.f4_true(f || ' closed to anon', NOT has_table_privilege('anon', f, 'SELECT'));
    PERFORM pg_temp.f4_true(f || ' has RLS', (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || f)::regclass));
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Rules and mode: roles, drafts, activation gate, immutability
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_loc   TEXT := pg_temp.f4_get('loc');
  v_owner UUID := pg_temp.f4_get('owner')::uuid;
  v_kiosk UUID := pg_temp.f4_get('kiosk')::uuid;
  v_body  JSONB := jsonb_build_object(
    'schema_version', 1,
    'catalogue', jsonb_build_array(
      jsonb_build_object('key', 'A', 'product_id', 'f4t-box-a', 'label', 'Test box A'),
      jsonb_build_object('key', 'B', 'product_id', 'f4t-box-b', 'label', 'Test box B'),
      jsonb_build_object('key', 'C', 'product_id', 'f4t-box-c', 'label', 'Test box C')),
    'rules', '[]'::jsonb,
    'examples', '[]'::jsonb);
  v_rs    JSONB;
  v_id    TEXT;
BEGIN
  PERFORM pg_temp.f4_as(NULL);
  PERFORM pg_temp.f4_refused('anonymous save', format('SELECT packaging_save_rule_set(%L, NULL, %L::jsonb, %L)', v_loc, v_body, ''), 'not_authenticated');
  PERFORM pg_temp.f4_as(gen_random_uuid());
  PERFORM pg_temp.f4_refused('stranger save', format('SELECT packaging_save_rule_set(%L, NULL, %L::jsonb, %L)', v_loc, v_body, ''), 'forbidden_location');
  IF v_kiosk IS NOT NULL THEN
    PERFORM pg_temp.f4_as(v_kiosk);
    PERFORM pg_temp.f4_refused('kiosk save', format('SELECT packaging_save_rule_set(%L, NULL, %L::jsonb, %L)', v_loc, v_body, ''), 'forbidden_role');
    PERFORM pg_temp.f4_refused('kiosk set mode', format('SELECT packaging_set_mode(%L, %L)', v_loc, 'scan'), 'forbidden_role');
  END IF;

  PERFORM pg_temp.f4_as(v_owner);
  PERFORM pg_temp.f4_refused('bad body', format('SELECT packaging_save_rule_set(%L, NULL, %L::jsonb, %L)', v_loc, '{"schema_version":2}', ''), 'invalid_rule_set');
  PERFORM pg_temp.f4_refused('unknown product',
    format('SELECT packaging_save_rule_set(%L, NULL, %L::jsonb, %L)', v_loc,
      jsonb_set(v_body, '{catalogue,0,product_id}', '"f4t-nope"'), ''), 'unknown_product');

  v_rs := packaging_save_rule_set(v_loc, NULL, v_body, 'verify draft');
  v_id := v_rs->>'id';
  PERFORM pg_temp.f4_true('draft created', v_rs->>'status' = 'draft');

  PERFORM pg_temp.f4_refused('activate without examples', format('SELECT packaging_activate_rule_set(%L, %L)', v_loc, v_id), 'no_examples');

  v_body := jsonb_set(v_body, '{examples}', jsonb_build_array(jsonb_build_object(
    'id', 'e1', 'packing_point', 'dispatch',
    'contents', jsonb_build_array(jsonb_build_object('kind', 'framed', 'size', 'A1', 'pieces', 1)),
    'expect', 'unresolved')));
  v_rs := packaging_save_rule_set(v_loc, v_id, v_body, 'verify draft with example');
  PERFORM pg_temp.f4_true('draft updated in place', v_rs->>'id' = v_id AND jsonb_array_length(v_rs->'body'->'examples') = 1);

  -- Auto mode needs an active rule set. (Skipped if staging already has one.)
  IF NOT EXISTS (SELECT 1 FROM packaging_rule_sets WHERE location = v_loc AND status = 'active') THEN
    PERFORM pg_temp.f4_refused('auto without active rules', format('SELECT packaging_set_mode(%L, %L)', v_loc, 'auto'), 'no_active_rule_set');
  END IF;
  PERFORM pg_temp.f4_refused('bad mode', format('SELECT packaging_set_mode(%L, %L)', v_loc, 'magic'), 'invalid_mode');

  v_rs := packaging_activate_rule_set(v_loc, v_id);
  PERFORM pg_temp.f4_true('activated', v_rs->>'status' = 'active');
  PERFORM pg_temp.f4_true('exactly one active', (SELECT count(*) = 1 FROM packaging_rule_sets WHERE location = v_loc AND status = 'active'));
  PERFORM pg_temp.f4_refused('edit active', format('SELECT packaging_save_rule_set(%L, %L, %L::jsonb, %L)', v_loc, v_id, v_body, ''), 'not_a_draft');
  PERFORM pg_temp.f4_refused('activate twice', format('SELECT packaging_activate_rule_set(%L, %L)', v_loc, v_id), 'not_a_draft');

  PERFORM pg_temp.f4_true('mode auto', packaging_set_mode(v_loc, 'auto')->>'mode' = 'auto');
  PERFORM pg_temp.f4_true('mode scan', packaging_set_mode(v_loc, 'scan')->>'mode' = 'scan');

  INSERT INTO f4t VALUES ('rs', v_id);
END $$;

-- ---------------------------------------------------------------------------
-- 3. Apply: once per shipment, replay-safe
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_loc   TEXT := pg_temp.f4_get('loc');
  v_rs    TEXT := pg_temp.f4_get('rs');
  v_owner UUID := pg_temp.f4_get('owner')::uuid;
  v_staff UUID := pg_temp.f4_get('staff')::uuid;
  r       JSONB;
  v_pick  TEXT;
BEGIN
  PERFORM pg_temp.f4_as(NULL);
  PERFORM pg_temp.f4_refused('anonymous apply',
    format('SELECT packaging_apply(%L, %L, %L, %L, true, %L::jsonb, %L::jsonb, NULL)', v_loc, 'f4t-req-anon', 'f4t-ev1', v_rs, '{"f4t-box-a":1}', '{"f4t-box-a":1}'),
    'not_authenticated');
  PERFORM pg_temp.f4_as(gen_random_uuid());
  PERFORM pg_temp.f4_refused('other-site apply',
    format('SELECT packaging_apply(%L, %L, %L, %L, true, %L::jsonb, %L::jsonb, NULL)', v_loc, 'f4t-req-strg', 'f4t-ev1', v_rs, '{"f4t-box-a":1}', '{"f4t-box-a":1}'),
    'forbidden_location');
  IF v_staff IS NOT NULL THEN
    PERFORM pg_temp.f4_as(v_staff);
    PERFORM pg_temp.f4_refused('staff applying someone else''s event',
      format('SELECT packaging_apply(%L, %L, %L, %L, true, %L::jsonb, %L::jsonb, NULL)', v_loc, 'f4t-req-staf', 'f4t-ev1', v_rs, '{"f4t-box-a":1}', '{"f4t-box-a":1}'),
      'forbidden_role');
  END IF;

  PERFORM pg_temp.f4_as(v_owner);
  PERFORM pg_temp.f4_refused('missing event',
    format('SELECT packaging_apply(%L, %L, %L, %L, true, %L::jsonb, %L::jsonb, NULL)', v_loc, 'f4t-req-0000', 'f4t-nope', v_rs, '{}', '{}'), 'event_not_found');
  PERFORM pg_temp.f4_refused('framed is not a packing point',
    format('SELECT packaging_apply(%L, %L, %L, %L, true, %L::jsonb, %L::jsonb, NULL)', v_loc, 'f4t-req-0000', 'f4t-ev6', v_rs, '{}', '{}'), 'not_a_packing_point');
  PERFORM pg_temp.f4_refused('non-terminal event',
    format('SELECT packaging_apply(%L, %L, %L, %L, true, %L::jsonb, %L::jsonb, NULL)', v_loc, 'f4t-req-0000', 'f4t-ev7', v_rs, '{}', '{}'), 'event_not_terminal');
  PERFORM pg_temp.f4_refused('unknown rule set',
    format('SELECT packaging_apply(%L, %L, %L, %L, true, %L::jsonb, %L::jsonb, NULL)', v_loc, 'f4t-req-0000', 'f4t-ev1', 'prs-nope', '{}', '{}'), 'rule_set_not_found');
  PERFORM pg_temp.f4_refused('product outside the catalogue',
    format('SELECT packaging_apply(%L, %L, %L, %L, true, %L::jsonb, %L::jsonb, NULL)', v_loc, 'f4t-req-0000', 'f4t-ev1', v_rs, '{}', '{"f4t-other":1}'), 'not_in_catalogue');
  PERFORM pg_temp.f4_refused('quantity too large',
    format('SELECT packaging_apply(%L, %L, %L, %L, true, %L::jsonb, %L::jsonb, NULL)', v_loc, 'f4t-req-0000', 'f4t-ev1', v_rs, '{}', '{"f4t-box-a":21}'), 'invalid_quantities');
  PERFORM pg_temp.f4_refused('fractional quantity',
    format('SELECT packaging_apply(%L, %L, %L, %L, true, %L::jsonb, %L::jsonb, NULL)', v_loc, 'f4t-req-0000', 'f4t-ev1', v_rs, '{}', '{"f4t-box-a":1.5}'), 'invalid_quantities');
  PERFORM pg_temp.f4_refused('short request id',
    format('SELECT packaging_apply(%L, %L, %L, %L, true, %L::jsonb, %L::jsonb, NULL)', v_loc, 'x', 'f4t-ev1', v_rs, '{}', '{}'), 'invalid_request_id');
  PERFORM pg_temp.f4_true('refusals moved no stock', pg_temp.f4_on_hand('f4t-box-a') = 10);

  r := packaging_apply(v_loc, 'f4t-req-0001', 'f4t-ev1', v_rs, true, '{"f4t-box-a":1}', '{"f4t-box-a":1}', '{"note":"verify"}');
  v_pick := r->'pick'->>'id';
  PERFORM pg_temp.f4_true('applied', r->>'status' = 'applied' AND r->'pick'->>'state' = 'auto' AND r->'pick'->>'stock_state' = 'posted');
  PERFORM pg_temp.f4_true('applied: stock -1', pg_temp.f4_on_hand('f4t-box-a') = 9);
  PERFORM pg_temp.f4_true('applied: one pkg ledger row', (SELECT count(*) = 1 AND sum(delta) = -1 FROM ledger
    WHERE location = v_loc AND source_id LIKE 'pkg:' || v_pick || ':%' AND parent_event_id IS NULL AND reason = 'sale'));

  r := packaging_apply(v_loc, 'f4t-req-0001', 'f4t-ev1', v_rs, true, '{"f4t-box-a":1}', '{"f4t-box-a":1}', NULL);
  PERFORM pg_temp.f4_true('replay returns the first answer', r->>'status' = 'applied' AND (r->>'replayed')::boolean);
  r := packaging_apply(v_loc, 'f4t-req-0002', 'f4t-ev1', v_rs, true, '{"f4t-box-a":1}', '{"f4t-box-b":2}', NULL);
  PERFORM pg_temp.f4_true('second request, same event', r->>'status' = 'already_applied' AND r->'pick'->>'id' = v_pick);
  r := packaging_apply(v_loc, 'f4t-req-0003', 'f4t-ev1b', v_rs, true, '{"f4t-box-a":1}', '{"f4t-box-a":1}', NULL);
  PERFORM pg_temp.f4_true('order completed again', r->>'status' = 'already_applied' AND r->'pick'->>'id' = v_pick);
  PERFORM pg_temp.f4_true('still deducted once', pg_temp.f4_on_hand('f4t-box-a') = 9 AND pg_temp.f4_on_hand('f4t-box-b') = 10);
  PERFORM pg_temp.f4_true('one pick for the shipment', (SELECT count(*) = 1 FROM packaging_picks
    WHERE location = v_loc AND order_number = 'F4T-1001' AND packing_point = 'dispatch' AND shipment_key = 'orig'));

  -- Same order, other packing point and a CS replacement: separate picks.
  r := packaging_apply(v_loc, 'f4t-req-0004', 'f4t-ev8', v_rs, true, '{"f4t-box-b":1}', '{"f4t-box-b":1}', NULL);
  PERFORM pg_temp.f4_true('second packing point gets its own pick', r->>'status' = 'applied' AND r->'pick'->>'packing_point' = 'a0_framed');
  r := packaging_apply(v_loc, 'f4t-req-0005', 'f4t-ev5', v_rs, true, '{"f4t-box-b":1}', '{"f4t-box-b":1}', NULL);
  PERFORM pg_temp.f4_true('replacement gets its own pick', r->>'status' = 'applied' AND r->'pick'->>'shipment_key' = 'cs:f4t-case');
  PERFORM pg_temp.f4_true('two more boxes', pg_temp.f4_on_hand('f4t-box-b') = 8);

  -- Unresolved: nothing deducted.
  r := packaging_apply(v_loc, 'f4t-req-0006', 'f4t-ev2', v_rs, false, '{}', '{}', NULL);
  PERFORM pg_temp.f4_true('unresolved pick', r->'pick'->>'state' = 'unresolved' AND r->'deltas' = '{}'::jsonb);

  INSERT INTO f4t VALUES ('pick1', v_pick), ('pick2', r->'pick'->>'id');
END $$;

-- ---------------------------------------------------------------------------
-- 4. Override: stock moves by the difference only; audited; stale refused
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_loc   TEXT := pg_temp.f4_get('loc');
  v_owner UUID := pg_temp.f4_get('owner')::uuid;
  v_kiosk UUID := pg_temp.f4_get('kiosk')::uuid;
  v_staff UUID := pg_temp.f4_get('staff')::uuid;
  v_pick  TEXT := pg_temp.f4_get('pick1');
  v_pick2 TEXT := pg_temp.f4_get('pick2');
  r       JSONB;
BEGIN
  -- State before: box-a 9, box-b 8, pick1 target {a:1} revision 1.
  PERFORM pg_temp.f4_as(NULL);
  PERFORM pg_temp.f4_refused('anonymous override',
    format('SELECT packaging_override(%L, %L, %L, 1, %L::jsonb, %L, NULL)', v_loc, 'f4t-ovr-anon', v_pick, '{"f4t-box-b":1}', 'x'), 'not_authenticated');
  IF v_staff IS NOT NULL THEN
    PERFORM pg_temp.f4_as(v_staff);
    PERFORM pg_temp.f4_refused('staff override as someone else',
      format('SELECT packaging_override(%L, %L, %L, 1, %L::jsonb, %L, %L)', v_loc, 'f4t-ovr-staf', v_pick, '{"f4t-box-b":1}', 'x', v_owner), 'forbidden_role');
  END IF;

  PERFORM pg_temp.f4_as(COALESCE(v_kiosk, v_owner));
  PERFORM pg_temp.f4_refused('reason required',
    format('SELECT packaging_override(%L, %L, %L, 1, %L::jsonb, %L, NULL)', v_loc, 'f4t-ovr-0000', v_pick, '{"f4t-box-b":1}', '  '), 'reason_required');
  PERFORM pg_temp.f4_refused('override outside catalogue',
    format('SELECT packaging_override(%L, %L, %L, 1, %L::jsonb, %L, NULL)', v_loc, 'f4t-ovr-0000', v_pick, '{"f4t-other":1}', 'x'), 'not_in_catalogue');
  PERFORM pg_temp.f4_refused('override unknown pick',
    format('SELECT packaging_override(%L, %L, %L, 1, %L::jsonb, %L, NULL)', v_loc, 'f4t-ovr-0000', 'pkp-nope', '{"f4t-box-b":1}', 'x'), 'pick_not_found');

  r := packaging_override(v_loc, 'f4t-ovr-0001', v_pick, 1, '{"f4t-box-b":1}', 'Used a different box', NULL);
  PERFORM pg_temp.f4_true('swap', r->>'status' = 'overridden' AND r->'pick'->>'state' = 'overridden' AND (r->'pick'->>'revision')::int = 2);
  PERFORM pg_temp.f4_true('swap deltas', r->'deltas' = '{"f4t-box-a":-1,"f4t-box-b":1}'::jsonb);
  PERFORM pg_temp.f4_true('swap stock', pg_temp.f4_on_hand('f4t-box-a') = 10 AND pg_temp.f4_on_hand('f4t-box-b') = 7);
  PERFORM pg_temp.f4_true('swap audit', (SELECT count(*) = 1 FROM packaging_pick_changes
    WHERE location = v_loc AND pick_id = v_pick AND kind = 'override' AND reason = 'Used a different box'
      AND before = '{"f4t-box-a":1}'::jsonb AND after = '{"f4t-box-b":1}'::jsonb AND actor = COALESCE(v_kiosk, v_owner)));
  PERFORM pg_temp.f4_true('prediction kept', (SELECT predicted = '{"f4t-box-a":1}'::jsonb FROM packaging_picks WHERE location = v_loc AND id = v_pick));

  r := packaging_override(v_loc, 'f4t-ovr-0001', v_pick, 1, '{"f4t-box-b":1}', 'Used a different box', NULL);
  PERFORM pg_temp.f4_true('override replay', (r->>'replayed')::boolean AND pg_temp.f4_on_hand('f4t-box-b') = 7);

  r := packaging_override(v_loc, 'f4t-ovr-0002', v_pick, 1, '{"f4t-box-a":5}', 'stale screen', NULL);
  PERFORM pg_temp.f4_true('stale revision refused', r->>'status' = 'conflict' AND (r->'pick'->>'revision')::int = 2);
  PERFORM pg_temp.f4_true('conflict moved nothing', pg_temp.f4_on_hand('f4t-box-a') = 10 AND pg_temp.f4_on_hand('f4t-box-b') = 7);

  r := packaging_override(v_loc, 'f4t-ovr-0003', v_pick, 2, '{"f4t-box-b":3}', 'Needed three', NULL);
  PERFORM pg_temp.f4_true('quantity up', r->'deltas' = '{"f4t-box-b":2}'::jsonb AND pg_temp.f4_on_hand('f4t-box-b') = 5);
  r := packaging_override(v_loc, 'f4t-ovr-0004', v_pick, 3, '{"f4t-box-b":3}', 'same again', NULL);
  PERFORM pg_temp.f4_true('unchanged target', r->>'status' = 'unchanged' AND pg_temp.f4_on_hand('f4t-box-b') = 5);
  r := packaging_override(v_loc, 'f4t-ovr-0005', v_pick, 3, '{}', 'No box used', NULL);
  PERFORM pg_temp.f4_true('remove all', r->'deltas' = '{"f4t-box-b":-3}'::jsonb AND pg_temp.f4_on_hand('f4t-box-b') = 8);

  -- A flagged (unresolved) pick can be given a box later.
  r := packaging_override(v_loc, 'f4t-ovr-0006', v_pick2, 1, '{"f4t-box-a":1}', 'Picked by hand', NULL);
  PERFORM pg_temp.f4_true('unresolved then chosen', r->'pick'->>'state' = 'overridden' AND pg_temp.f4_on_hand('f4t-box-a') = 9);

  -- Ledger for pick1 nets to zero and never repeats a source key.
  PERFORM pg_temp.f4_true('pick1 ledger nets to zero', (SELECT COALESCE(sum(delta), 0) = 0 FROM ledger WHERE location = v_loc AND source_id LIKE 'pkg:' || v_pick || ':%'));
  PERFORM pg_temp.f4_true('no repeated pkg source key', NOT EXISTS (
    SELECT 1 FROM ledger WHERE location = v_loc AND source_id LIKE 'pkg:%' GROUP BY source_id HAVING count(*) > 1));
  PERFORM pg_temp.f4_refused('ledger unique index',
    format('INSERT INTO ledger (location, id, product_id, delta, reason, source_id) SELECT location, %L, product_id, delta, reason, source_id FROM ledger WHERE location = %L AND source_id LIKE %L LIMIT 1',
      'f4t-dup', v_loc, 'pkg:' || v_pick || ':%'),
    'ledger_pkg_source_unique');
END $$;

-- ---------------------------------------------------------------------------
-- 5. Shortage: never blocks; flagged; retry posts once
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_loc   TEXT := pg_temp.f4_get('loc');
  v_rs    TEXT := pg_temp.f4_get('rs');
  v_owner UUID := pg_temp.f4_get('owner')::uuid;
  v_kiosk UUID := pg_temp.f4_get('kiosk')::uuid;
  r       JSONB;
  v_pick  TEXT;
  v_state TEXT;
BEGIN
  PERFORM pg_temp.f4_as(v_owner);
  r := packaging_apply(v_loc, 'f4t-req-0010', 'f4t-ev3', v_rs, true, '{"f4t-box-c":1}', '{"f4t-box-c":1}', NULL);
  v_pick  := r->'pick'->>'id';
  v_state := r->'pick'->>'stock_state';
  PERFORM pg_temp.f4_true('shortage did not fail', r->>'status' = 'applied');

  IF v_state = 'short' THEN
    -- This schema allows negative on-hand: posted, flagged.
    PERFORM pg_temp.f4_true('short: posted negative', pg_temp.f4_on_hand('f4t-box-c') = -1 AND r->'pick'->'posted' = '{"f4t-box-c":1}'::jsonb);
    RAISE NOTICE 'F4 verify: this schema allows negative on-hand (pick marked short)';
  ELSIF v_state = 'unposted' THEN
    -- This schema forbids negative on-hand: nothing posted, kept for retry.
    PERFORM pg_temp.f4_true('unposted: stock untouched', pg_temp.f4_on_hand('f4t-box-c') = 0 AND r->'pick'->'posted' = '{}'::jsonb);
    PERFORM pg_temp.f4_true('unposted: no ledger row', NOT EXISTS (SELECT 1 FROM ledger WHERE location = v_loc AND source_id LIKE 'pkg:' || v_pick || ':%'));
    RAISE NOTICE 'F4 verify: this schema forbids negative on-hand (pick left unposted)';
  ELSE
    RAISE EXCEPTION 'F4 verify FAILED [shortage state]: got %', v_state;
  END IF;

  IF v_kiosk IS NOT NULL THEN
    PERFORM pg_temp.f4_as(v_kiosk);
    PERFORM pg_temp.f4_refused('kiosk retry', format('SELECT packaging_retry(%L, %L, %L)', v_loc, 'f4t-rty-kios', v_pick), 'forbidden_role');
    PERFORM pg_temp.f4_as(v_owner);
  END IF;

  -- Stock arrives (+5), then a manager retries.
  UPDATE products SET current_on_hand = current_on_hand + 5 WHERE location = v_loc AND id = 'f4t-box-c';
  r := packaging_retry(v_loc, 'f4t-rty-0001', v_pick);
  PERFORM pg_temp.f4_true('after retry: consumed exactly one', pg_temp.f4_on_hand('f4t-box-c') = 4 AND r->'pick'->'posted' = '{"f4t-box-c":1}'::jsonb);
  r := packaging_retry(v_loc, 'f4t-rty-0002', v_pick);
  PERFORM pg_temp.f4_true('second retry moves nothing', pg_temp.f4_on_hand('f4t-box-c') = 4 AND r->'deltas' = '{}'::jsonb);
  PERFORM pg_temp.f4_true('one ledger row for the box', (SELECT count(*) = 1 AND sum(delta) = -1 FROM ledger WHERE location = v_loc AND source_id LIKE 'pkg:' || v_pick || ':%'));
END $$;

-- ---------------------------------------------------------------------------
-- 6. Old scan path already deducted: adopt, do not deduct again
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_loc   TEXT := pg_temp.f4_get('loc');
  v_rs    TEXT := pg_temp.f4_get('rs');
  r       JSONB;
  v_a     NUMERIC := pg_temp.f4_on_hand('f4t-box-a');
  v_b     NUMERIC := pg_temp.f4_on_hand('f4t-box-b');
BEGIN
  -- What deduct_inventory_for_event (0031) writes for a scanned box.
  INSERT INTO ledger (location, id, product_id, delta, reason, source_id, parent_event_id, note)
  VALUES (v_loc, 'f4t-led-legacy', 'f4t-box-a', -1, 'sale', 'prod:order_F4T-1004:F4T-BOX-A', 'f4t-ev4', 'synthetic legacy scan');

  r := packaging_apply(v_loc, 'f4t-req-0020', 'f4t-ev4', v_rs, true, '{"f4t-box-b":1}', '{"f4t-box-b":1}', NULL);
  PERFORM pg_temp.f4_true('legacy adopted', r->'pick'->>'state' = 'legacy_scan'
    AND r->'pick'->'target' = '{"f4t-box-a":1}'::jsonb AND r->'pick'->'posted' = '{"f4t-box-a":1}'::jsonb AND r->'deltas' = '{}'::jsonb);
  PERFORM pg_temp.f4_true('legacy: no second deduction', pg_temp.f4_on_hand('f4t-box-a') = v_a AND pg_temp.f4_on_hand('f4t-box-b') = v_b);
END $$;

DO $$ BEGIN RAISE NOTICE 'F4 verify: ALL CHECKS PASSED (rolling back, nothing kept)'; END $$;

ROLLBACK;
