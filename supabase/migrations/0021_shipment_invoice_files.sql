-- 0021_shipment_invoice_files.sql
--
-- Invoice attachments for shipments. One row in this table per uploaded
-- file; the actual file bytes live in the `shipment-invoices` Storage
-- bucket (created manually in the Supabase Dashboard - see install README).
--
-- File path inside the bucket is `{location}/{shipment_id}/{file_id}_{name}`
-- so RLS can be enforced at the path level if needed in future.
--
-- Owner-only RLS on both the table and the Storage bucket. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS shipment_invoice_files (
  id              TEXT        PRIMARY KEY,
  location        TEXT        NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  shipment_id     TEXT        NOT NULL,
  file_path       TEXT        NOT NULL,
  original_name   TEXT        NOT NULL,
  mime_type       TEXT,
  file_size       INTEGER     CHECK (file_size IS NULL OR file_size >= 0),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  FOREIGN KEY (location, shipment_id) REFERENCES shipments(location, id) ON DELETE CASCADE
);

COMMENT ON TABLE shipment_invoice_files IS
  'Metadata for invoice files attached to shipments. Actual file bytes in shipment-invoices Storage bucket. Owner-only.';

CREATE INDEX IF NOT EXISTS shipment_invoice_files_lookup_idx
  ON shipment_invoice_files (location, shipment_id, uploaded_at DESC);

ALTER TABLE shipment_invoice_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shipment_invoice_files_owner_all ON shipment_invoice_files;
CREATE POLICY shipment_invoice_files_owner_all ON shipment_invoice_files FOR ALL
  USING (can_access_location(location) AND is_owner())
  WITH CHECK (can_access_location(location) AND is_owner());

-- ============================================================
-- Storage RLS for the shipment-invoices bucket
-- ============================================================
-- These policies allow only owners to read / write / delete objects in
-- the bucket. The bucket itself must be created via the Supabase Dashboard
-- (see install instructions). Safe to re-run.

DROP POLICY IF EXISTS shipment_invoices_owner_select ON storage.objects;
DROP POLICY IF EXISTS shipment_invoices_owner_insert ON storage.objects;
DROP POLICY IF EXISTS shipment_invoices_owner_update ON storage.objects;
DROP POLICY IF EXISTS shipment_invoices_owner_delete ON storage.objects;

CREATE POLICY shipment_invoices_owner_select ON storage.objects FOR SELECT
  USING (bucket_id = 'shipment-invoices' AND is_owner());

CREATE POLICY shipment_invoices_owner_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'shipment-invoices' AND is_owner());

CREATE POLICY shipment_invoices_owner_update ON storage.objects FOR UPDATE
  USING (bucket_id = 'shipment-invoices' AND is_owner());

CREATE POLICY shipment_invoices_owner_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'shipment-invoices' AND is_owner());

COMMIT;

NOTIFY pgrst, 'reload schema';