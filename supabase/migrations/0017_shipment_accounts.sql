-- 0017_shipment_accounts.sql
--
-- Delivered timestamp + accounts/invoice tracking on shipments.
--
-- New columns on shipments:
--   delivered_at  TIMESTAMPTZ  -- auto-set when status transitions to Delivered
--   delivered_by  UUID         -- auto-set by trigger from auth.uid()
--
-- New tables:
--   shipment_status_log    -- full status-transition audit log (manager+)
--   shipment_accounts      -- invoice / payment data (owner-only)
--
-- Safe to re-run.

BEGIN;

-- ============================================================
-- Columns on shipments
-- ============================================================
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN shipments.delivered_at IS
  'Timestamp when status was set to Delivered. Auto-managed by trigger.';
COMMENT ON COLUMN shipments.delivered_by IS
  'User who moved the shipment to Delivered. Auto-managed by trigger.';

-- ============================================================
-- shipment_status_log (audit)
-- ============================================================
CREATE TABLE IF NOT EXISTS shipment_status_log (
  id           TEXT        PRIMARY KEY,
  location     TEXT        NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  shipment_id  TEXT        NOT NULL,
  from_status  TEXT,
  to_status    TEXT        NOT NULL,
  changed_by   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (location, shipment_id) REFERENCES shipments(location, id) ON DELETE CASCADE
);

COMMENT ON TABLE shipment_status_log IS
  'Append-only audit log of every shipment status transition. Useful when an order is toggled in and out of Delivered to know which delivery date was the real one.';

CREATE INDEX IF NOT EXISTS shipment_status_log_lookup_idx
  ON shipment_status_log (location, shipment_id, changed_at DESC);

ALTER TABLE shipment_status_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shipment_status_log_read  ON shipment_status_log;
DROP POLICY IF EXISTS shipment_status_log_write ON shipment_status_log;
DROP POLICY IF EXISTS shipment_status_log_modify ON shipment_status_log;

-- Managers + owners can read the audit log; staff cannot.
CREATE POLICY shipment_status_log_read ON shipment_status_log FOR SELECT
  USING (can_access_location(location) AND is_manager_or_higher());

-- Inserts happen via SECURITY DEFINER trigger only; no direct inserts.
-- We still need an insert policy so the SECURITY DEFINER function can write
-- when running with caller privileges via NEW row context. Use is_owner OR
-- the trigger context. Simplest: allow inserts only via the trigger
-- function which runs as SECURITY DEFINER and bypasses RLS.

-- ============================================================
-- shipment_accounts (owner-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS shipment_accounts (
  location                 TEXT          NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  shipment_id              TEXT          NOT NULL,
  supplier_invoice_number  TEXT,
  invoice_amount           NUMERIC(12,2) CHECK (invoice_amount IS NULL OR invoice_amount >= 0),
  invoice_currency         TEXT          NOT NULL DEFAULT 'AUD',
  invoice_received_date    DATE,
  payment_status           TEXT          NOT NULL DEFAULT 'unpaid'
                                          CHECK (payment_status IN ('unpaid','paid','on_hold','pending_approval','disputed')),
  payment_date             DATE,
  payment_reference        TEXT,
  accounts_notes           TEXT,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by               UUID          REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (location, shipment_id),
  FOREIGN KEY (location, shipment_id) REFERENCES shipments(location, id) ON DELETE CASCADE
);

COMMENT ON TABLE shipment_accounts IS
  'Owner-only invoice + payment tracking for delivered shipments. Linked 1:1 to shipments. Kept in a separate table for strict owner-only RLS (column-level grants are not supported in Postgres RLS).';

CREATE INDEX IF NOT EXISTS shipment_accounts_status_idx
  ON shipment_accounts (location, payment_status, invoice_received_date);

ALTER TABLE shipment_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shipment_accounts_owner_all ON shipment_accounts;

CREATE POLICY shipment_accounts_owner_all ON shipment_accounts FOR ALL
  USING (can_access_location(location) AND is_owner())
  WITH CHECK (can_access_location(location) AND is_owner());

-- updated_at auto-bump
CREATE OR REPLACE FUNCTION shipment_accounts_touch_updated()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  NEW.updated_by = auth.uid();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shipment_accounts_touch ON shipment_accounts;
CREATE TRIGGER shipment_accounts_touch
  BEFORE UPDATE ON shipment_accounts
  FOR EACH ROW
  EXECUTE FUNCTION shipment_accounts_touch_updated();

-- ============================================================
-- Triggers on shipments: delivered_at meta + audit log
-- ============================================================

-- BEFORE UPDATE: auto-manage delivered_at + delivered_by on status changes.
CREATE OR REPLACE FUNCTION shipments_set_delivered_meta()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'Delivered' AND (OLD.status IS NULL OR OLD.status != 'Delivered') THEN
      NEW.delivered_at = now();
      NEW.delivered_by = auth.uid();
    ELSIF OLD.status = 'Delivered' AND NEW.status != 'Delivered' THEN
      NEW.delivered_at = NULL;
      NEW.delivered_by = NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shipments_set_delivered_meta_trg ON shipments;
CREATE TRIGGER shipments_set_delivered_meta_trg
  BEFORE UPDATE ON shipments
  FOR EACH ROW
  EXECUTE FUNCTION shipments_set_delivered_meta();

-- AFTER UPDATE: append a row to shipment_status_log on every status change.
-- SECURITY DEFINER bypasses RLS so the insert always succeeds.
CREATE OR REPLACE FUNCTION shipments_log_status_change()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO shipment_status_log (
      id, location, shipment_id, from_status, to_status, changed_by
    ) VALUES (
      gen_random_uuid()::text, NEW.location, NEW.id, OLD.status, NEW.status, auth.uid()
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shipments_log_status_change_trg ON shipments;
CREATE TRIGGER shipments_log_status_change_trg
  AFTER UPDATE ON shipments
  FOR EACH ROW
  EXECUTE FUNCTION shipments_log_status_change();

COMMIT;

NOTIFY pgrst, 'reload schema';