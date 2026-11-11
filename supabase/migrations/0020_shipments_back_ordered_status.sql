-- 0020_shipments_back_ordered_status.sql
--
-- Add 'Back-Ordered' to the shipments.status CHECK constraint so the new
-- kanban column can save rows.
--
-- Safe to re-run.

BEGIN;

ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_status_check;

ALTER TABLE shipments
  ADD CONSTRAINT shipments_status_check
  CHECK (status IN (
    'Draft',
    'Ordered',
    'Back-Ordered',
    'In Production',
    'In Transit',
    'Customs',
    'Delivered',
    'On hold',
    'Cancelled'
  ));

COMMIT;

NOTIFY pgrst, 'reload schema';