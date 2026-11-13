-- 0035_load_production_evidence_v2.sql
--
-- item-counting Task 4 (v2 amendment): a compact version of 0034's one-call
-- evidence read. On staging, 0034's AU three-month call ran past the API's
-- unchanged 8 s `authenticated` statement_timeout. About 2 s of that was an
-- in-database sort and per-row repeated values.
--
-- Expand-only. Adds one read-only function and its grants. 0034 and its
-- function/grants stay as they are for old code. No table, column, index,
-- policy, RLS helper, role setting or existing grant changes. An app
-- rollback leaves both functions in place.
--
--   * Same signature, security (STABLE, SECURITY INVOKER, search_path=''),
--     four evidence families, fixed cutoff and invalid-input NULL as v1.
--   * Encoding v2:
--       {version:2, site, startUtc, endUtcExclusive, asOfUtc, complete:true,
--        rowCount, staffIds:[text], skus:[text],
--        rows:[[id, staff_ix, department, order_number, sku_ix, line_quantity,
--               event_type, created_at, parent_event_id, cs_case_id], ...]}
--     - no location per row (the envelope's site applies to every row);
--     - staff ids and SKUs are listed once, built only from the final
--       authorized evidence; rows hold zero-based indexes, or null for NULL;
--     - created_at stays PostgreSQL timestamptz text (all microseconds);
--     - NO ORDER BY anywhere: row and dictionary order are unspecified; the
--       client sorts once by exact (created_at, id).
--   * Each dictionary is frozen once as an array; its index mapping comes from
--     that same array (unnest WITH ORDINALITY) and is joined to rows, so values
--     and indexes can't disagree.
--
-- Apply: CJ only (or Astra on CJ's instruction), staging first, as one
-- transaction. CREATE FUNCTION (not CREATE OR REPLACE) fails if the name or
-- signature already exists.

BEGIN;

CREATE FUNCTION public.load_production_evidence_v2(
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
        SELECT pe.id, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = p_site
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= p_start_utc
          AND pe.created_at < p_end_utc_exclusive
          AND pe.created_at <= p_as_of_utc
      ),
      qualification AS (
        SELECT pe.id, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
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
        SELECT pe.id, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
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
        SELECT pe.id, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
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
      -- start, later rows at/after end: only qualification and parents can
      -- share a row, so only they are deduplicated.
      evidence AS MATERIALIZED (
        SELECT * FROM win
        UNION ALL SELECT * FROM later
        UNION ALL (SELECT * FROM qualification UNION SELECT * FROM parents)
      ),
      -- Dictionaries: frozen once from the final evidence; the index mapping
      -- comes from the same array.
      staff_list AS MATERIALIZED (
        SELECT COALESCE(pg_catalog.array_agg(d.staff_id), '{}'::uuid[]) AS a
        FROM (SELECT DISTINCT e.staff_id FROM evidence e WHERE e.staff_id IS NOT NULL) d
      ),
      sku_list AS MATERIALIZED (
        SELECT COALESCE(pg_catalog.array_agg(d.line_sku), '{}'::text[]) AS a
        FROM (SELECT DISTINCT e.line_sku FROM evidence e WHERE e.line_sku IS NOT NULL) d
      ),
      staff_map AS (
        SELECT u.v AS staff_id, (u.n - 1)::int AS i
        FROM staff_list, pg_catalog.unnest(staff_list.a) WITH ORDINALITY AS u(v, n)
      ),
      sku_map AS (
        SELECT u.v AS line_sku, (u.n - 1)::int AS i
        FROM sku_list, pg_catalog.unnest(sku_list.a) WITH ORDINALITY AS u(v, n)
      ),
      -- One pass over the evidence gives both the count and the rows.
      agg AS (
        SELECT pg_catalog.count(*) AS n,
               pg_catalog.json_agg(
                 pg_catalog.json_build_array(
                   e.id, sm.i, e.department, e.order_number, km.i, e.line_quantity,
                   e.event_type, e.created_at, e.parent_event_id, e.cs_case_id)) AS rows
        FROM evidence e
        LEFT JOIN staff_map sm ON sm.staff_id = e.staff_id
        LEFT JOIN sku_map km ON km.line_sku = e.line_sku
      )
      SELECT pg_catalog.json_build_object(
        'version', 2,
        'site', p_site,
        'startUtc', p_start_utc,
        'endUtcExclusive', p_end_utc_exclusive,
        'asOfUtc', p_as_of_utc,
        'complete', true,
        'rowCount', agg.n,
        'staffIds', (SELECT pg_catalog.to_json(staff_list.a) FROM staff_list),
        'skus', (SELECT pg_catalog.to_json(sku_list.a) FROM sku_list),
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
$fn$;

COMMENT ON FUNCTION public.load_production_evidence_v2(text, timestamptz, timestamptz, timestamptz) IS
  'item-counting evidence v2: one site''s window + qualification/parent/later-cancellation context under the caller''s RLS, compact (dictionaries, unsorted). Read-only; no counting.';

-- Only this new function's privileges. Browser users call it as
-- authenticated; the daily digest uses the service-role key. anon and PUBLIC
-- get nothing.
REVOKE ALL ON FUNCTION public.load_production_evidence_v2(text, timestamptz, timestamptz, timestamptz)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.load_production_evidence_v2(text, timestamptz, timestamptz, timestamptz)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
