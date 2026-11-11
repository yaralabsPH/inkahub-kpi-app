-- 0023_cs_case_lines_source.sql
--
-- Add two display-only columns to cs_case_lines:
--   source_shopify_sku - the Shopify variant SKU that drove this
--                        replacement (e.g. INKA-S2MEX0013-A1-FN)
--   source_title       - the Shopify product title (e.g. "Mexican Flower
--                        Market Prints")
--
-- These are pure provenance: the catalogue code on the line still drives
-- inventory deduction. Both are NULL for legacy rows and for lines added
-- via the manual SKU picker.
--
-- Additive, safe to re-run.

BEGIN;

ALTER TABLE cs_case_lines
  ADD COLUMN IF NOT EXISTS source_shopify_sku TEXT,
  ADD COLUMN IF NOT EXISTS source_title       TEXT;

COMMENT ON COLUMN cs_case_lines.source_shopify_sku IS
  'When the line was added via the Shopify-line + Add button, this is the variant SKU that was clicked. Display only.';
COMMENT ON COLUMN cs_case_lines.source_title IS
  'Shopify product title at the moment of + Add (e.g. "Mexican Flower Market Prints"). Display only.';

NOTIFY pgrst, 'reload schema';

COMMIT;