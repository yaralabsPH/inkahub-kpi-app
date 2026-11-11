-- 0011_shipment_archive.sql
--
-- Adds an `archived` flag to shipments. Archived shipments stay in the
-- database (still searchable, still cross-referenced from ledger / order
-- builder), but they're hidden from the default Kanban + List views on
-- the Shipments page. A "Show archived" toggle on the page brings them
-- back.
--
-- Default false so existing rows stay active. Operator archives a row
-- once it's in a terminal state (Delivered or Cancelled) and they're
-- done with it.
--
-- Safe to re-run.

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN shipments.archived IS
  'When true, the shipment is hidden from the default Shipments page views. Toggle off to re-activate.';

-- Filter by (location, archived) is the hot path — every page load.
CREATE INDEX IF NOT EXISTS shipments_archived_idx
  ON shipments (location, archived) WHERE archived = false;

NOTIFY pgrst, 'reload schema';
