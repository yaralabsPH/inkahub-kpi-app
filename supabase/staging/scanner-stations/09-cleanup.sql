-- F6 shared scanner stations: remove the race fixtures (01-fixtures.sql).
--
-- STAGING ONLY. Deletes only the synthetic site "f6race" and the synthetic
-- f68000... accounts, then proves nothing is left. Safe to re-run.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') THEN
    RAISE EXCEPTION 'F6 cleanup: no location "staging" in this database. Refusing to run: staging only.';
  END IF;
END $$;

DELETE FROM public.scanner_requests       WHERE location = 'f6race';
DELETE FROM public.scanner_receivers      WHERE location = 'f6race';
DELETE FROM public.packaging_pick_changes WHERE location = 'f6race';
DELETE FROM public.packaging_picks        WHERE location = 'f6race';
DELETE FROM public.packaging_rule_sets    WHERE location = 'f6race';
DELETE FROM public.packaging_settings     WHERE location = 'f6race';
DELETE FROM public.ledger                 WHERE location = 'f6race';
DELETE FROM public.production_events      WHERE location = 'f6race';
DELETE FROM public.products               WHERE location = 'f6race';
DELETE FROM public.staff_barcodes         WHERE location = 'f6race';
DELETE FROM public.user_locations         WHERE location = 'f6race' OR user_id::text LIKE 'f6800000-%';
DELETE FROM public.profiles               WHERE user_id::text LIKE 'f6800000-%';
DELETE FROM auth.users                    WHERE id::text LIKE 'f6800000-%';
DELETE FROM public.locations              WHERE key = 'f6race';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.locations WHERE key = 'f6race')
     OR EXISTS (SELECT 1 FROM auth.users WHERE id::text LIKE 'f6800000-%')
     OR EXISTS (SELECT 1 FROM public.production_events WHERE location = 'f6race') THEN
    RAISE EXCEPTION 'F6 cleanup: synthetic rows remain';
  END IF;
  RAISE NOTICE 'F6 cleanup: done, nothing left';
END $$;

COMMIT;
