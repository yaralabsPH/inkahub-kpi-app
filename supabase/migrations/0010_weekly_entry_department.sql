-- 0010_weekly_entry_department.sql
--
-- Split weekly_entries by department. Each iso_week_start can now have one
-- framed row and one unframed row per location. Existing rows are tagged
-- 'framed' so framed history (Sales Entry, dashboard, order builder) keeps
-- working unchanged.
--
-- Sales Entry, Dashboard, Order Builder and forecast surfaces filter by the
-- active app-state department. Unframed history starts empty — operator
-- re-enters or re-imports the data they care about.
--
-- Safe to re-run.

BEGIN;

-- 1) Add the column. NOT NULL with a default so existing rows are valid.
ALTER TABLE weekly_entries
  ADD COLUMN IF NOT EXISTS department TEXT NOT NULL DEFAULT 'framed'
  CHECK (department IN ('framed','unframed'));

COMMENT ON COLUMN weekly_entries.department IS
  'Which side of the business this entry belongs to. Framed and unframed each maintain their own weekly history.';

-- 2) Drop the old PK (location, iso_week_start) and rebuild including department.
--    Wrapped in a DO block so re-runs don't error on a missing constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'weekly_entries'::regclass
      AND contype  = 'p'
      AND conname  = 'weekly_entries_pkey'
  ) THEN
    -- Inspect the existing PK columns. If department isn't part of it, swap.
    IF NOT EXISTS (
      SELECT 1
      FROM   pg_index i
      JOIN   pg_attribute a
        ON   a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE  i.indrelid = 'weekly_entries'::regclass
        AND  i.indisprimary
        AND  a.attname  = 'department'
    ) THEN
      ALTER TABLE weekly_entries DROP CONSTRAINT weekly_entries_pkey;
      ALTER TABLE weekly_entries ADD CONSTRAINT weekly_entries_pkey
        PRIMARY KEY (location, department, iso_week_start);
    END IF;
  END IF;
END $$;

-- 3) Index for the common filter: by location + department, ordered by week.
CREATE INDEX IF NOT EXISTS weekly_entries_dept_idx
  ON weekly_entries (location, department, iso_week_start DESC);

-- 4) Refresh PostgREST schema cache.
NOTIFY pgrst, 'reload schema';

COMMIT;
