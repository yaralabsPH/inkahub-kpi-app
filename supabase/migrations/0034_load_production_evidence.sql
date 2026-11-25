-- 0034_load_production_evidence.sql
--
-- item-counting Task 4: read one site's complete production evidence in ONE
-- call. It replaces about 2,000 sequential paged requests per three-month
-- load, measured on staging.
--
-- Expand-only. Adds one read-only function and its grants. No table, column,
-- index, policy, RLS helper, existing function or existing grant changes. Old
-- app code does not call it, so it keeps working, and an app rollback can
-- leave the function in place.
--
--   * SECURITY INVOKER: the caller's existing RLS on production_events decides
--     which rows are visible, exactly as with direct table reads.
--   * STABLE, one statement: the four evidence families come from one MVCC
--     snapshot.
--   * Returns ONE scalar json envelope (not SETOF), so PostgREST max-rows
--     cannot silently truncate the evidence. No LIMIT and no paging.
--   * No counting. Item/order rules stay in the TypeScript reducer.
--
-- Families (same as the old loader's Reader.readOnce):
--   1. window rows: line_verified/completed/dispatched/cancelled in
--      [start, end) and <= cutoff
--   2. before-window line_verified rows whose order number appears on a
--      window completed/dispatched row with a nonblank order number
--   3. before-window rows referenced by a window cancellation's
--      parent_event_id (any event type, so the reducer can report bad links)
--   4. cancellations at/after the window end (<= cutoff) whose parent is a
--      window line_verified/completed/dispatched row
-- Every family is the same site, under RLS, and created_at <= cutoff.
--
-- Encoding v1:
--   {version:1, site, startUtc, endUtcExclusive, asOfUtc, complete:true,
--    rowCount, rows:[[id, location, staff_id, department, order_number,
--    line_sku, line_quantity, event_type, created_at, parent_event_id,
--    cs_case_id], ...]}
--   ordered by (created_at, id). Invalid input returns null and scans nothing.
--
-- Apply: CJ only, staging first, as one transaction. CREATE FUNCTION (not
-- CREATE OR REPLACE) fails if the name/signature already exists.

BEGIN;

CREATE FUNCTION public.load_production_evidence(
  p_site text,
  p_start_utc timestamptz,
  p_end_utc_exclusive timestamptz,
  p_as_of_utc timestamptz
)
RETURNS json
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN p_site IS NULL OR pg_catalog.btrim(p_site) = ''
      OR p_start_utc IS NULL OR p_end_utc_exclusive IS NULL OR p_as_of_utc IS NULL
      OR NOT pg_catalog.isfinite(p_start_utc)
      OR NOT pg_catalog.isfinite(p_end_utc_exclusive)
      OR NOT pg_catalog.isfinite(p_as_of_utc)
      OR p_start_utc >= p_end_utc_exclusive
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = p_site
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= p_start_utc
          AND pe.created_at < p_end_utc_exclusive
          AND pe.created_at <= p_as_of_utc
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = p_site
          AND pe.event_type = 'line_verified'
          AND pe.created_at < p_start_utc
          AND pe.created_at <= p_as_of_utc
          AND pe.order_number IN (
            SELECT w.order_number FROM win w
            WHERE w.event_type IN ('completed', 'dispatched')
              AND w.order_number IS NOT NULL
              AND pg_catalog.btrim(w.order_number) <> ''
          )
      ),
      parents AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = p_site
          AND pe.created_at < p_start_utc
          AND pe.created_at <= p_as_of_utc
          AND pe.id IN (
            SELECT w.parent_event_id FROM win w
            WHERE w.event_type = 'cancelled'
              AND w.parent_event_id IS NOT NULL
              AND w.parent_event_id <> ''
          )
      ),
      later AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = p_site
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= p_end_utc_exclusive
          AND pe.created_at <= p_as_of_utc
          AND pe.parent_event_id IN (
            SELECT w.id FROM win w
            WHERE w.event_type IN ('line_verified', 'completed', 'dispatched')
          )
      ),
      -- Window rows are in [start, end), qualification and parents are before
      -- start, and later rows are at/after end, so only qualification and
      -- parents can share a row. Deduplicate just those, not the whole window.
      evidence AS (
        SELECT * FROM win
        UNION ALL SELECT * FROM later
        UNION ALL (SELECT * FROM qualification UNION SELECT * FROM parents)
      ),
      -- One pass over the evidence gives both the count and the rows.
      agg AS (
        SELECT pg_catalog.count(*) AS n,
               pg_catalog.json_agg(
                 pg_catalog.json_build_array(
                   e.id, e.location, e.staff_id, e.department, e.order_number, e.line_sku,
                   e.line_quantity, e.event_type, e.created_at, e.parent_event_id, e.cs_case_id)
                 ORDER BY e.created_at, e.id) AS rows
        FROM evidence e
      )
      SELECT pg_catalog.json_build_object(
        'version', 1,
        'site', p_site,
        'startUtc', p_start_utc,
        'endUtcExclusive', p_end_utc_exclusive,
        'asOfUtc', p_as_of_utc,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
$fn$;

COMMENT ON FUNCTION public.load_production_evidence(text, timestamptz, timestamptz, timestamptz) IS
  'item-counting evidence v1: one site''s window + qualification/parent/later-cancellation context under the caller''s RLS. Read-only; no counting.';

-- Only this new function's privileges. Browser users call it as
-- authenticated. The daily digest (api/reports/daily-digest.ts) uses the
-- service-role key, so service_role is granted explicitly. anon and PUBLIC
-- get nothing.
REVOKE ALL ON FUNCTION public.load_production_evidence(text, timestamptz, timestamptz, timestamptz)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.load_production_evidence(text, timestamptz, timestamptz, timestamptz)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
