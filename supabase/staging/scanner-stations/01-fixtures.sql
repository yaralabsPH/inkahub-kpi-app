-- F6 shared scanner stations: fixtures for the two-session race scripts.
--
-- STAGING ONLY. Refuses to run unless the database has a location 'staging'.
-- COMMITS synthetic data so two sessions can see it. Remove it afterwards
-- with 09-cleanup.sql.
--
-- Everything lives in a separate synthetic site "f6race" so the real
-- staging site's packaging mode, rules, stock and people are not touched.
--
--   Kiosk A   f6800000-0000-4000-8000-0000000000d1   (session A)
--   Kiosk B   f6800000-0000-4000-8000-0000000000d2   (session B)
--   Person 1  f6800000-0000-4000-8000-000000000001   badge F68E0001
--   Person 2  f6800000-0000-4000-8000-000000000002   badge F68E0002
--   Products  f6r-a0b (code F6R-A0B, 100 on hand), f6r-box (F6R-BOX, 100)
--   Rule set  f6r-rs version 1 (active at f6race), mode auto at f6race
--   Orders    10968001 .. 10968005

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') THEN
    RAISE EXCEPTION 'F6 fixtures: no location "staging" in this database. Refusing to run: staging only.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.locations WHERE key = 'f6race') THEN
    RAISE EXCEPTION 'F6 fixtures: site f6race already exists. Run 09-cleanup.sql first.';
  END IF;
END $$;

INSERT INTO public.locations (key, label) VALUES ('f6race', 'F6 race test (synthetic)');

INSERT INTO auth.users (id, email) VALUES
  ('f6800000-0000-4000-8000-0000000000d1', 'f6r-kiosk-a@inka-staging.test'),
  ('f6800000-0000-4000-8000-0000000000d2', 'f6r-kiosk-b@inka-staging.test'),
  ('f6800000-0000-4000-8000-000000000001', 'f6r-p1@inka-staging.test'),
  ('f6800000-0000-4000-8000-000000000002', 'f6r-p2@inka-staging.test');
INSERT INTO public.profiles (user_id, display_name, role) VALUES
  ('f6800000-0000-4000-8000-0000000000d1', 'F6R Kiosk A', 'kiosk'),
  ('f6800000-0000-4000-8000-0000000000d2', 'F6R Kiosk B', 'kiosk'),
  ('f6800000-0000-4000-8000-000000000001', 'F6R Person 1', 'staff'),
  ('f6800000-0000-4000-8000-000000000002', 'F6R Person 2', 'staff')
ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role;
INSERT INTO public.user_locations (user_id, location) VALUES
  ('f6800000-0000-4000-8000-0000000000d1', 'f6race'), ('f6800000-0000-4000-8000-0000000000d2', 'f6race'),
  ('f6800000-0000-4000-8000-000000000001', 'f6race'), ('f6800000-0000-4000-8000-000000000002', 'f6race');

INSERT INTO public.staff_barcodes (location, barcode, user_id, display_name, active) VALUES
  ('f6race', 'F68E0001', 'f6800000-0000-4000-8000-000000000001', 'F6R Person 1', true),
  ('f6race', 'F68E0002', 'f6800000-0000-4000-8000-000000000002', 'F6R Person 2', true);

INSERT INTO public.products (location, id, code, supplier, product_type, current_on_hand) VALUES
  ('f6race', 'f6r-a0b', 'F6R-A0B', 'F6R', 'product', 100),
  ('f6race', 'f6r-box', 'F6R-BOX', 'F6R', 'packaging', 100);

INSERT INTO public.packaging_settings (location, mode) VALUES ('f6race', 'auto');
INSERT INTO public.packaging_rule_sets (location, id, version, status, body) VALUES ('f6race', 'f6r-rs', 1, 'active',
  '{"schema_version":1,"catalogue":[{"key":"F6RBOX","product_id":"f6r-box","label":"F6R box","packing_points":["a0_framed"]}],"rules":[],"examples":[]}');

SELECT 'F6 fixtures committed' AS result,
       (SELECT count(*) FROM public.user_locations WHERE location = 'f6race') AS members,
       (SELECT count(*) FROM public.products WHERE location = 'f6race') AS products;

COMMIT;
