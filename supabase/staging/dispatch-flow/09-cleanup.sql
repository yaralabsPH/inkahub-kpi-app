-- F7 dispatch flow: remove the race fixtures (01-fixtures.sql).
--
-- STAGING ONLY. Deletes only the synthetic site "f7race" and the synthetic
-- f78000... accounts, then proves nothing is left. Safe to re-run.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') THEN
    RAISE EXCEPTION 'F7 cleanup: no location "staging" in this database. Refusing to run: staging only.';
  END IF;
END $$;

DELETE FROM public.dispatch_framer_attributions WHERE location = 'f7race';
DELETE FROM public.dispatch_requests            WHERE location = 'f7race';
DELETE FROM public.scanner_requests             WHERE location = 'f7race';
DELETE FROM public.scanner_receivers            WHERE location = 'f7race';
DELETE FROM public.packaging_pick_changes       WHERE location = 'f7race';
DELETE FROM public.packaging_picks              WHERE location = 'f7race';
DELETE FROM public.packaging_rule_sets          WHERE location = 'f7race';
DELETE FROM public.packaging_settings           WHERE location = 'f7race';
DELETE FROM public.ledger                       WHERE location = 'f7race';
DELETE FROM public.production_events            WHERE location = 'f7race';
DELETE FROM public.products                     WHERE location = 'f7race';
DELETE FROM public.staff_barcodes               WHERE location = 'f7race';
DELETE FROM public.user_locations               WHERE location = 'f7race' OR user_id::text LIKE 'f7800000-%';
DELETE FROM public.profiles                     WHERE user_id::text LIKE 'f7800000-%';
DELETE FROM auth.users                          WHERE id::text LIKE 'f7800000-%';
DELETE FROM public.locations                    WHERE key = 'f7race';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.locations WHERE key = 'f7race')
     OR EXISTS (SELECT 1 FROM auth.users WHERE id::text LIKE 'f7800000-%')
     OR EXISTS (SELECT 1 FROM public.production_events WHERE location = 'f7race')
     OR EXISTS (SELECT 1 FROM public.dispatch_framer_attributions WHERE location = 'f7race') THEN
    RAISE EXCEPTION 'F7 cleanup: synthetic rows remain';
  END IF;
  RAISE NOTICE 'F7 cleanup: done, nothing left';
END $$;

COMMIT;
