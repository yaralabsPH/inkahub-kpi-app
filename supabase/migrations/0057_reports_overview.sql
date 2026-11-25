-- 0057_reports_overview.sql
--
-- F8 Reports v2 (append-only after installed 0056; 0048-0051 stay reserved for F3).
--
-- One published-period overview for a trusted audience chosen by the server:
-- totals, a daily trend, people and HISTORICAL business departments, over
-- exactly ONE retained generation. It adds no counting rule and no snapshot
-- pipeline:
--
--   * reporting_private.checked_generation validates site/audience/window/work
--     type and returns the generation sequence (unchanged from 0044);
--   * reporting_private.sel_eval supplies every selected fact with F1's
--     effective / reversed / qualification state (unchanged from 0044);
--   * Items and Orders use exactly sel_totals' rules: effective verifications
--     credit counted Items; non-reversed terminals whose qualification is not
--     excluded_only are Orders, distinct by (order_key, case_id) over the WHOLE
--     group, never a sum of daily or sub-group values;
--   * the business department is the F5 snapshot recorded on the event image in
--     reporting_private.source_versions visible at the SAME sequence
--     (valid_from_seq <= seq < valid_to_seq). Only status 'assigned' carries a
--     department; anything else (legacy, unassigned, errors) is Unknown. The
--     person's CURRENT assignment is never read.
--
-- Bounds: at most 731 production dates; people and departments refuse (never
-- truncate) above p_group_limit (1..1000). Reads only; nothing is written.
-- Every function: SECURITY INVOKER, empty search_path, execute for service_role only.

BEGIN;

CREATE FUNCTION reporting_private.ov_pair(p_items numeric, p_orders bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT pg_catalog.jsonb_build_object('items', reporting_private.safe_items(coalesce(p_items, 0)), 'orders', reporting_private.safe_count(coalesce(p_orders, 0)))
$fn$;

-- Credit (verification) and order (terminal) rows of one selection in the display window, with the
-- event's recorded business department. Filters: optional staff, work type and department
-- ('unknown' = no recorded assigned department, otherwise the recorded department id).
CREATE FUNCTION reporting_private.ov_rows(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz,
                                          p_filter_staff uuid, p_work_type text, p_department text)
RETURNS TABLE (kind text, staff_id uuid, production_date date, rework boolean, items numeric, order_key text, case_id text,
               dept_id text, dept_name text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH ev AS (
    SELECT * FROM reporting_private.sel_eval(p_site, p_ak, p_staff, p_seq, p_start, p_end)
  ), counted AS (
    SELECT e.*,
           CASE WHEN e.role = 'verification' THEN 'credit' ELSE 'order' END AS k
      FROM ev e
     WHERE e.created_at >= p_start AND e.created_at < p_end
       AND ((e.role = 'verification' AND e.effective)
         OR (e.role = 'terminal' AND NOT e.reversed AND e.qualification <> 'excluded_only'))
       AND (p_filter_staff IS NULL OR e.staff_id = p_filter_staff)
       AND (p_work_type IS NULL OR e.work_type = p_work_type)
  ), dept AS (
    SELECT c.*,
           CASE WHEN sv.image ->> 'business_department_status' = 'assigned' AND coalesce(sv.image ->> 'business_department_id', '') <> ''
                THEN sv.image ->> 'business_department_id' END AS d_id,
           CASE WHEN sv.image ->> 'business_department_status' = 'assigned' AND coalesce(sv.image ->> 'business_department_id', '') <> ''
                THEN sv.image ->> 'business_department_name' END AS d_name
      FROM counted c
      LEFT JOIN reporting_private.source_versions sv
        ON sv.site = p_site AND sv.event_id = c.event_id
       AND sv.valid_from_seq <= p_seq AND (sv.valid_to_seq IS NULL OR sv.valid_to_seq > p_seq)
  )
  SELECT d.k, d.staff_id, d.production_date, d.case_id IS NOT NULL,
         CASE WHEN d.k = 'credit' AND d.item_status = 'counted' THEN d.items ELSE 0 END::numeric,
         d.order_key, d.case_id, d.d_id, d.d_name, d.created_at
    FROM dept d
   WHERE p_department IS NULL
      OR (p_department = 'unknown' AND d.d_id IS NULL)
      OR d.d_id = p_department
$fn$;

CREATE FUNCTION public.read_reports_overview(p_site text, p_audience_kind text, p_audience_staff uuid, p_generation uuid,
                                             p_first_date date, p_last_date date, p_start timestamptz, p_end timestamptz,
                                             p_staff uuid, p_work_type text, p_department text, p_group_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_seq    bigint;
  v_people bigint;
  v_depts  bigint;
  v_out    jsonb;
BEGIN
  v_seq := reporting_private.checked_generation('read_reports_overview', p_site, p_audience_kind, p_audience_staff, p_generation,
                                                p_first_date, p_last_date, p_start, p_end, p_work_type);
  IF p_last_date - p_first_date + 1 > 731 THEN RAISE EXCEPTION 'read_reports_overview: at most 731 production dates'; END IF;
  IF p_group_limit IS NULL OR p_group_limit < 1 OR p_group_limit > 1000 THEN RAISE EXCEPTION 'read_reports_overview: group limit must be 1..1000'; END IF;
  IF p_department IS NOT NULL AND p_department <> 'unknown'
     AND p_department !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'read_reports_overview: unsupported department';
  END IF;

  WITH r AS MATERIALIZED (
    SELECT * FROM reporting_private.ov_rows(p_site, p_audience_kind, p_audience_staff, v_seq, p_start, p_end, p_staff, p_work_type, p_department)
  )
  SELECT (SELECT count(DISTINCT x.staff_id) FROM r x), (SELECT count(DISTINCT coalesce(x.dept_id, '')) FROM r x),
  pg_catalog.jsonb_build_object(
    'totals', pg_catalog.jsonb_build_object(
       'normal', reporting_private.ov_pair((SELECT sum(r.items) FROM r r WHERE r.kind = 'credit' AND NOT r.rework),
                                           (SELECT count(DISTINCT (r.order_key, r.case_id)) FROM r r WHERE r.kind = 'order' AND NOT r.rework)),
       'rework', reporting_private.ov_pair((SELECT sum(r.items) FROM r r WHERE r.kind = 'credit' AND r.rework),
                                           (SELECT count(DISTINCT (r.order_key, r.case_id)) FROM r r WHERE r.kind = 'order' AND r.rework))),
    'daily', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'productionDate', d.d::text,
                'normal', reporting_private.ov_pair(a.n_items, a.n_orders),
                'rework', reporting_private.ov_pair(a.r_items, a.r_orders))
                ORDER BY d.d), '[]'::jsonb)
                FROM (SELECT g.x::date AS d FROM pg_catalog.generate_series(p_first_date::timestamp, p_last_date::timestamp, interval '1 day') g(x)) d
                LEFT JOIN (SELECT r.production_date,
                                  sum(r.items) FILTER (WHERE r.kind = 'credit' AND NOT r.rework) AS n_items,
                                  count(DISTINCT (r.order_key, r.case_id)) FILTER (WHERE r.kind = 'order' AND NOT r.rework) AS n_orders,
                                  sum(r.items) FILTER (WHERE r.kind = 'credit' AND r.rework) AS r_items,
                                  count(DISTINCT (r.order_key, r.case_id)) FILTER (WHERE r.kind = 'order' AND r.rework) AS r_orders
                             FROM r r GROUP BY r.production_date) a ON a.production_date = d.d),
    'people', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'staffId', p.staff_id::text, 'normal', reporting_private.ov_pair(p.n_items, p.n_orders), 'rework', reporting_private.ov_pair(p.r_items, p.r_orders))
                 ORDER BY p.n_orders DESC, p.n_items DESC, p.staff_id::text), '[]'::jsonb)
                 FROM (SELECT r.staff_id,
                              sum(r.items) FILTER (WHERE r.kind = 'credit' AND NOT r.rework) AS n_items,
                              count(DISTINCT (r.order_key, r.case_id)) FILTER (WHERE r.kind = 'order' AND NOT r.rework) AS n_orders,
                              sum(r.items) FILTER (WHERE r.kind = 'credit' AND r.rework) AS r_items,
                              count(DISTINCT (r.order_key, r.case_id)) FILTER (WHERE r.kind = 'order' AND r.rework) AS r_orders
                         FROM r r GROUP BY r.staff_id) p),
    'departments', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'departmentId', q.dept_id,
                 -- every recorded name of this department in the period, most recently recorded first
                 'names', (SELECT coalesce(pg_catalog.jsonb_agg(n.dept_name ORDER BY n.last_at DESC, n.dept_name), '[]'::jsonb)
                             FROM (SELECT r.dept_name, max(r.created_at) AS last_at FROM r r
                                    WHERE r.dept_id IS NOT DISTINCT FROM q.dept_id AND r.dept_name IS NOT NULL GROUP BY r.dept_name) n),
                 'normal', reporting_private.ov_pair(q.n_items, q.n_orders), 'rework', reporting_private.ov_pair(q.r_items, q.r_orders))
                 ORDER BY q.dept_id IS NULL, q.n_orders DESC, q.n_items DESC, q.dept_id), '[]'::jsonb)
                 FROM (SELECT r.dept_id,
                              sum(r.items) FILTER (WHERE r.kind = 'credit' AND NOT r.rework) AS n_items,
                              count(DISTINCT (r.order_key, r.case_id)) FILTER (WHERE r.kind = 'order' AND NOT r.rework) AS n_orders,
                              sum(r.items) FILTER (WHERE r.kind = 'credit' AND r.rework) AS r_items,
                              count(DISTINCT (r.order_key, r.case_id)) FILTER (WHERE r.kind = 'order' AND r.rework) AS r_orders
                         FROM r r GROUP BY r.dept_id) q)
  ) INTO v_people, v_depts, v_out;
  -- Refuse, never truncate, exceptional cardinality.
  IF v_people > p_group_limit THEN RAISE EXCEPTION 'read_reports_overview: % people exceed the limit %', v_people, p_group_limit; END IF;
  IF v_depts > p_group_limit THEN RAISE EXCEPTION 'read_reports_overview: % departments exceed the limit %', v_depts, p_group_limit; END IF;
  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION reporting_private.ov_pair(numeric, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.ov_pair(numeric, bigint) TO service_role;
REVOKE ALL ON FUNCTION reporting_private.ov_rows(text, text, uuid, bigint, timestamptz, timestamptz, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.ov_rows(text, text, uuid, bigint, timestamptz, timestamptz, uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.read_reports_overview(text, text, uuid, uuid, date, date, timestamptz, timestamptz, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_reports_overview(text, text, uuid, uuid, date, date, timestamptz, timestamptz, uuid, text, text, integer) TO service_role;

COMMIT;
