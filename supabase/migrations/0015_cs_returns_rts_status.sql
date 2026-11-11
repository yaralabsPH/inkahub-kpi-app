-- ============================================================================
-- 0015_cs_returns_rts_status.sql
-- ============================================================================
-- MOVE THIS FILE TO: supabase/migrations/0015_cs_returns_rts_status.sql
--
-- Adds 'rts' (Returned to Sender) as a new status for customer returns.
--
-- Semantics:
--   - 'rts' means the carrier has returned the outbound package because
--     it couldn't be delivered (wrong address, refused, customer moved, etc).
--   - The item is physically back at the warehouse but the team needs to
--     assess what to do next (resend, refund, restock).
--   - Inventory restock works the same as 'received' — lines with
--     restock=true credit on_hand when parent reaches either 'received'
--     OR 'rts' status. Defaults to restock=false so the team must
--     consciously tick to restock.
--
-- Safe to re-run.
-- ============================================================================

ALTER TABLE cs_returns DROP CONSTRAINT IF EXISTS cs_returns_status_check;
ALTER TABLE cs_returns ADD CONSTRAINT cs_returns_status_check
  CHECK (status IN ('new','received','rts','closed'));

NOTIFY pgrst, 'reload schema';
