-- 0018_supplier_settings_and_payment_terms.sql
--
-- Per-supplier payment terms (owner-only) + per-shipment override.
--
-- payment_terms_days = number of days from order_placed_date to invoice due.
-- 0 = COD. 30 = NET30. Custom integers supported (NET45 etc.).
--
-- Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS supplier_settings (
  location           TEXT        NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  supplier_name      TEXT        NOT NULL,
  payment_terms_days INT         CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0),
  default_currency   TEXT        NOT NULL DEFAULT 'AUD',
  notes              TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (location, supplier_name)
);

COMMENT ON TABLE supplier_settings IS
  'Per-supplier configuration: payment terms (used to auto-compute invoice due dates), default currency, free-form notes. Owner-only RLS. Suppliers are sourced from the unique supplier names in the products table; this table holds the editable overlay.';

ALTER TABLE supplier_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supplier_settings_owner_all ON supplier_settings;
CREATE POLICY supplier_settings_owner_all ON supplier_settings FOR ALL
  USING (can_access_location(location) AND is_owner())
  WITH CHECK (can_access_location(location) AND is_owner());

-- Per-shipment override on the existing accounts table.
ALTER TABLE shipment_accounts
  ADD COLUMN IF NOT EXISTS payment_terms_days INT
  CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0);

COMMENT ON COLUMN shipment_accounts.payment_terms_days IS
  'Per-shipment override. NULL = fall back to supplier_settings.payment_terms_days.';

-- updated_at auto-bump on supplier_settings.
CREATE OR REPLACE FUNCTION supplier_settings_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  NEW.updated_by = auth.uid();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplier_settings_touch_trg ON supplier_settings;
CREATE TRIGGER supplier_settings_touch_trg
  BEFORE UPDATE ON supplier_settings
  FOR EACH ROW
  EXECUTE FUNCTION supplier_settings_touch();

COMMIT;

NOTIFY pgrst, 'reload schema';