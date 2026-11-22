-- F7 dispatch flow: fixtures for the two-session race scripts.
--
-- STAGING ONLY. Refuses to run unless the database has a location 'staging'.
-- COMMITS synthetic data so two sessions can see it. Remove it afterwards
-- with 09-cleanup.sql.
--
-- Everything lives in a separate synthetic site "f7race" so the real
-- staging site's packaging mode, rules, stock and people are not touched.
--
--   Kiosk A     f7800000-0000-4000-8000-0000000000d1   (session A)
--   Kiosk B     f7800000-0000-4000-8000-0000000000d2   (session B)
--   Framer 1    f7800000-0000-4000-8000-000000000001   badge F78E0001
--   Framer 2    f7800000-0000-4000-8000-000000000002   badge F78E0002
--   Dispatcher  f7800000-0000-4000-8000-000000000005   badge F78E0005
--   Products    f7r-a2b (code F7R-A2B, 100 on hand), f7r-box (F7R-BOX, 100)
--   Rule set    f7r-rs version 1 (active at f7race, Dispatch box), mode auto
--   Orders      10978001 .. 10978008; framing by Framer 1 already recorded
--               (verified + completed) on 01, 03, 04, 05, 06, 07 and 08,
--               none on 02.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') THEN
    RAISE EXCEPTION 'F7 fixtures: no location "staging" in this database. Refusing to run: staging only.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.locations WHERE key = 'f7race') THEN
    RAISE EXCEPTION 'F7 fixtures: site f7race already exists. Run 09-cleanup.sql first.';
  END IF;
END $$;

INSERT INTO public.locations (key, label) VALUES ('f7race', 'F7 race test (synthetic)');

INSERT INTO auth.users (id, email) VALUES
  ('f7800000-0000-4000-8000-0000000000d1', 'f7r-kiosk-a@inka-staging.test'),
  ('f7800000-0000-4000-8000-0000000000d2', 'f7r-kiosk-b@inka-staging.test'),
  ('f7800000-0000-4000-8000-000000000001', 'f7r-f1@inka-staging.test'),
  ('f7800000-0000-4000-8000-000000000002', 'f7r-f2@inka-staging.test'),
  ('f7800000-0000-4000-8000-000000000005', 'f7r-disp@inka-staging.test');
INSERT INTO public.profiles (user_id, display_name, role) VALUES
  ('f7800000-0000-4000-8000-0000000000d1', 'F7R Kiosk A', 'kiosk'),
  ('f7800000-0000-4000-8000-0000000000d2', 'F7R Kiosk B', 'kiosk'),
  ('f7800000-0000-4000-8000-000000000001', 'F7R Framer 1', 'staff'),
  ('f7800000-0000-4000-8000-000000000002', 'F7R Framer 2', 'staff'),
  ('f7800000-0000-4000-8000-000000000005', 'F7R Dispatcher', 'staff')
ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role;
INSERT INTO public.user_locations (user_id, location) VALUES
  ('f7800000-0000-4000-8000-0000000000d1', 'f7race'), ('f7800000-0000-4000-8000-0000000000d2', 'f7race'),
  ('f7800000-0000-4000-8000-000000000001', 'f7race'), ('f7800000-0000-4000-8000-000000000002', 'f7race'),
  ('f7800000-0000-4000-8000-000000000005', 'f7race');

INSERT INTO public.staff_barcodes (location, barcode, user_id, display_name, active) VALUES
  ('f7race', 'F78E0001', 'f7800000-0000-4000-8000-000000000001', 'F7R Framer 1', true),
  ('f7race', 'F78E0002', 'f7800000-0000-4000-8000-000000000002', 'F7R Framer 2', true),
  ('f7race', 'F78E0005', 'f7800000-0000-4000-8000-000000000005', 'F7R Dispatcher', true);

INSERT INTO public.products (location, id, code, supplier, product_type, current_on_hand) VALUES
  ('f7race', 'f7r-a2b', 'F7R-A2B', 'F7R', 'product', 100),
  ('f7race', 'f7r-box', 'F7R-BOX', 'F7R', 'packaging', 100);

INSERT INTO public.packaging_settings (location, mode) VALUES ('f7race', 'auto');
INSERT INTO public.packaging_rule_sets (location, id, version, status, body) VALUES ('f7race', 'f7r-rs', 1, 'active',
  '{"schema_version":1,"catalogue":[{"key":"F7RBOX","product_id":"f7r-box","label":"F7R box","packing_points":["dispatch"]}],"rules":[],"examples":[]}');

-- Recorded framing (classic shape: verification, then the completion) by Framer 1.
INSERT INTO public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at)
SELECT 'f7race', 'f7r-' || o || '-' || t.kind, 'f7800000-0000-4000-8000-000000000001', 'framed', o,
       CASE WHEN t.kind = 'v' THEN 'INKA-ABC0001-A2-FB' END, 2, t.type, 'f7r', 'F7 race fixture',
       now() - interval '1 hour' + CASE WHEN t.kind = 'c' THEN interval '5 minutes' ELSE interval '0' END
FROM unnest(ARRAY['10978001', '10978003', '10978004', '10978005', '10978006', '10978007', '10978008']) o

CROSS JOIN (VALUES ('v', 'line_verified'), ('c', 'completed')) t(kind, type);

SELECT 'F7 fixtures committed' AS result,
       (SELECT count(*) FROM public.user_locations WHERE location = 'f7race') AS members,
       (SELECT count(*) FROM public.production_events WHERE location = 'f7race') AS framing_events;

COMMIT;
