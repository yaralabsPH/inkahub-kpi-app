-- F5 departments: composition with the item-counting (F1) capture trigger.
--
-- STAGING ONLY. One transaction, ends with ROLLBACK: nothing is kept, and no
-- F1 object, control row or trigger is changed. It only INSERTS and UPDATES
-- one synthetic event and reads what F1 captured for it inside this
-- transaction (the rollback discards those capture rows too).
--
-- What it proves when F1's trigger is installed AND its capture is enabled:
--   * one F5 insert produces exactly ONE captured INSERT row;
--   * the captured image already contains the FINAL F5 fields (the F5
--     triggers are BEFORE, F1's is AFTER);
--   * an ordinary update produces exactly one captured UPDATE row whose old
--     and new images carry identical F5 fields.
--
-- Otherwise it says which state it found and that the case is PENDING. A
-- pending case is not a pass. F1's own "control row missing" failure belongs
-- to F1's rehearsal; this script never removes or edits F1's control row.

BEGIN;

DO $$
DECLARE
  v_site     text;
  v_person   uuid := 'f5740000-0000-4000-8000-000000000001';
  v_enabled  boolean;
  v_inserts  int;
  v_updates  int;
  v_image    jsonb;
  v_old      jsonb;
  v_new      jsonb;
  e          public.production_events;
  k          text;
  v_keys     text[] := ARRAY['business_department_id','business_department_name','business_department_assignment_id',
    'business_department_name_version_id','business_department_status','department_snapshot_version',
    'department_occurred_at','department_received_at','department_resolution_instant',
    'department_time_status','department_resolved_at'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') THEN
    RAISE EXCEPTION 'F5 composition: no location "staging" in this database. Refusing to run: staging only.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.production_events'::regclass
                    AND tgname = 'production_events_reporting_capture' AND tgenabled = 'O') THEN
    RAISE NOTICE 'F5 composition: the F1 capture trigger is not installed (or not enabled) here. This is the "F5 alone" state. Combined case PENDING, not passed.';
    RETURN;
  END IF;
  IF to_regclass('reporting_private.control') IS NULL OR to_regclass('reporting_private.changes') IS NULL THEN
    RAISE NOTICE 'F5 composition: F1 tables not found or not readable by this role. Combined case PENDING, not passed.';
    RETURN;
  END IF;

  EXECUTE 'SELECT c.capture_enabled FROM reporting_private.control c WHERE c.singleton' INTO v_enabled;
  IF v_enabled IS NULL THEN
    RAISE NOTICE 'F5 composition: F1 control row is missing. Inserts at au/uk/us would be refused BY F1 (not by F5). Report to the F1 owner. Combined case PENDING, not passed.';
    RETURN;
  END IF;
  IF NOT v_enabled THEN
    RAISE NOTICE 'F5 composition: F1 capture is switched off (its own control). This is the "F1 disabled" state: F5 inserts are unaffected. Combined case PENDING, not passed.';
    RETURN;
  END IF;

  -- F1 captures only its supported sites.
  SELECT key INTO v_site FROM public.locations WHERE key IN ('au', 'uk', 'us') ORDER BY key LIMIT 1;
  IF v_site IS NULL THEN
    RAISE NOTICE 'F5 composition: no au/uk/us location on this database, so F1 captures nothing here. Combined case PENDING, not passed.';
    RETURN;
  END IF;

  INSERT INTO auth.users (id, email) VALUES (v_person, 'f5c-1@inka-staging.test');

  INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, note, created_at)
  VALUES (v_site, 'f5c-compose-1', v_person, 'dispatch', 'F5C-1', 'completed', 'f5 composition', clock_timestamp());
  SELECT * INTO e FROM public.production_events WHERE location = v_site AND id = 'f5c-compose-1';

  EXECUTE 'SELECT count(*), min(c.new_image::text)::jsonb FROM reporting_private.changes c
            WHERE c.op = ''INSERT'' AND c.new_site = $1 AND c.new_event_id = $2'
     INTO v_inserts, v_image USING v_site, 'f5c-compose-1';
  IF v_inserts <> 1 THEN
    RAISE EXCEPTION 'F5 composition FAILED: expected exactly 1 captured INSERT, found %', v_inserts;
  END IF;
  FOREACH k IN ARRAY v_keys LOOP
    IF NOT (v_image ? k) THEN
      RAISE EXCEPTION 'F5 composition FAILED: captured image has no key %', k;
    END IF;
    IF (v_image ->> k) IS DISTINCT FROM (to_jsonb(e) ->> k) THEN
      RAISE EXCEPTION 'F5 composition FAILED: captured % = %, saved row has %', k, v_image ->> k, to_jsonb(e) ->> k;
    END IF;
  END LOOP;
  IF e.business_department_status IS NULL THEN
    RAISE EXCEPTION 'F5 composition FAILED: the saved row has no F5 status';
  END IF;

  UPDATE public.production_events SET note = 'f5 composition edited' WHERE location = v_site AND id = 'f5c-compose-1';
  EXECUTE 'SELECT count(*), min(c.old_image::text)::jsonb, min(c.new_image::text)::jsonb FROM reporting_private.changes c
            WHERE c.op = ''UPDATE'' AND c.new_site = $1 AND c.new_event_id = $2'
     INTO v_updates, v_old, v_new USING v_site, 'f5c-compose-1';
  IF v_updates <> 1 THEN
    RAISE EXCEPTION 'F5 composition FAILED: expected exactly 1 captured UPDATE, found %', v_updates;
  END IF;
  FOREACH k IN ARRAY v_keys LOOP
    IF (v_old ->> k) IS DISTINCT FROM (v_new ->> k) THEN
      RAISE EXCEPTION 'F5 composition FAILED: an ordinary update changed % in the captured images', k;
    END IF;
  END LOOP;

  RAISE NOTICE 'F5 composition: PASSED at site % (1 captured INSERT with final F5 fields, status %; 1 captured UPDATE with unchanged F5 fields). Rolling back.',
    v_site, e.business_department_status;
END $$;

ROLLBACK;
