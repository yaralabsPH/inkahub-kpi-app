-- 0008_cs_cases_query_status.sql
--
-- Renames the cs_cases "approved" status to "query".
--
-- Why: in practice CS never had an "approved-but-not-yet-shipped" state.
-- Cases either ship straight away or they need a follow-up question
-- ("can you send a photo?", "is the address correct?"). The new "query"
-- column captures that holding state instead.
--
-- Side effects:
--   1. CHECK constraint on cs_cases.status is updated:
--      ('new','approved','shipped','closed','denied')
--        → ('new','query','shipped','closed','denied')
--   2. Existing rows with status='approved' are migrated to status='query'.
--      (None expected on prod yet, but this is safe to run regardless.)
--   3. Column approved_at is renamed to queried_at — same semantics,
--      different label. All historic timestamps are preserved.
--   4. Inventory deduction rule is now: status='shipped' AND
--      tracking_number IS NOT NULL. The trigger lives in app code
--      (Dexie/Supabase repos), not in the DB — nothing to change here.
--
-- Safe to re-run.

BEGIN;

-- 1) Drop the old CHECK first. Critical: if we run the UPDATE while the old
--    constraint is still in force, Postgres rejects the row because 'query'
--    isn't in the allowed list yet.
ALTER TABLE cs_cases DROP CONSTRAINT IF EXISTS cs_cases_status_check;

-- 2) Migrate existing rows.
UPDATE cs_cases SET status = 'query' WHERE status = 'approved';

-- 3) Add the new CHECK with the renamed value.
ALTER TABLE cs_cases ADD CONSTRAINT cs_cases_status_check
  CHECK (status IN ('new','query','shipped','closed','denied'));

-- 3) Rename the timestamp column. Use the IF EXISTS guard so re-runs
--    don't blow up after the rename succeeded once.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cs_cases' AND column_name = 'approved_at'
  ) THEN
    ALTER TABLE cs_cases RENAME COLUMN approved_at TO queried_at;
  END IF;
END $$;

COMMENT ON COLUMN cs_cases.queried_at IS
  'Timestamp the case first moved into "query" status (waiting on info from customer or production). Optional.';

-- 4) Tell PostgREST to refresh its schema cache so the renamed column
--    and constraint are visible to the API immediately.
NOTIFY pgrst, 'reload schema';

COMMIT;
