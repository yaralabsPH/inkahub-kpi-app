-- 0019_payment_terms_eom.sql
--
-- Adds payment_terms_eom flag to supplier_settings + shipment_accounts so
-- "NET30 EOM" style terms (= end of order month + N days) can be expressed.
-- Default false; existing rows behave as before.
--
-- Safe to re-run.

BEGIN;

ALTER TABLE supplier_settings
  ADD COLUMN IF NOT EXISTS payment_terms_eom BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE shipment_accounts
  ADD COLUMN IF NOT EXISTS payment_terms_eom BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN supplier_settings.payment_terms_eom IS
  'When true, due date = end-of-month(order_placed_date) + payment_terms_days.';
COMMENT ON COLUMN shipment_accounts.payment_terms_eom IS
  'Per-shipment override of supplier_settings.payment_terms_eom.';

COMMIT;
NOTIFY pgrst, 'reload schema';