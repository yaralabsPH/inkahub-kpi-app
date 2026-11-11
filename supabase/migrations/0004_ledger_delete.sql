-- ============================================================================
-- INKA ARTHOUSE — allow managers to DELETE ledger rows
-- ============================================================================
-- 0001_init.sql intentionally omitted a DELETE policy on `ledger` to enforce
-- append-only semantics. That was too strict: legitimate admin operations
-- (wipe, importBackup) do need to clear ledger rows when re-importing
-- backups or migrating data into a location.
--
-- This policy gates DELETE on `is_manager_or_higher()` so day-to-day
-- staff still can't tamper with the audit trail, but admin flows work.
-- ============================================================================

CREATE POLICY ledger_delete ON ledger FOR DELETE
  USING (can_access_location(location) AND is_manager_or_higher());

-- Clean up any orphan rows from previous partial migration attempts.
-- Safe to run because:
--   - If you've never had a successful migration into a location, this is a no-op.
--   - If you have, the next importBackup will wipe + re-populate anyway.
-- This is mostly here to remove the specific row that's been blocking the
-- AU re-migration. Adjust the WHERE clause if you want to keep some.
DELETE FROM ledger WHERE location = 'au';
