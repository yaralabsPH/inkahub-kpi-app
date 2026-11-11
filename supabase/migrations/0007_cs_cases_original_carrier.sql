-- 0007_cs_cases_original_carrier.sql
--
-- Splits the cs_cases "carrier" concept in two:
--   * carrier            — the carrier used to send the REPLACEMENT parcel
--                          (already exists; pairs with tracking_number).
--   * original_carrier   — the carrier that delivered the ORIGINAL order
--                          (new; optional; captured for reporting only —
--                          "which carriers cause the most issues?").
--
-- These are independent: a customer might have received a damaged parcel via
-- DHL, and we send the replacement via Auspost. Reports can group by
-- original_carrier without dragging in our outbound carrier choice.
--
-- Safe to re-run.

ALTER TABLE cs_cases
  ADD COLUMN IF NOT EXISTS original_carrier TEXT;

COMMENT ON COLUMN cs_cases.original_carrier IS
  'Carrier that delivered the original order to the customer. Captured for CS reporting (which inbound carrier causes the most issues). Independent of cs_cases.carrier, which is the replacement parcel carrier.';

-- Tell PostgREST to reload its schema cache so the new column is visible to
-- the frontend immediately, without waiting for the periodic refresh.
NOTIFY pgrst, 'reload schema';
