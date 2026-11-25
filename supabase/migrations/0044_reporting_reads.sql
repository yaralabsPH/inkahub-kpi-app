-- 0044_reporting_reads.sql
--
-- item-counting amendment, Task 16 (DRAFT, not applied). Append-only; 0042 stays
-- reserved for an evidence-backed Task 14 access-path correction.
--
-- Published report reads over the classified facts of exactly ONE generation
-- (a version row is visible to generation g when valid_from_seq <= g.seq and
-- (valid_to_seq IS NULL OR valid_to_seq > g.seq)), for exactly one trusted
-- audience chosen by the server. SQL only combines saved rule outputs and
-- their identity/range membership, mirroring the Task 11 TypeScript reference
-- (selectFactFamilies / evaluateSelection / referenceSummary):
--
--   sel_facts / sel_issues   the four evidence families over facts + source issues
--   sel_eval                 per selected fact: effective (verification not cancelled by a
--                            VALID edge whose parent is selected and not later), reversed
--                            terminal, qualification from selected original verifications
--                            of the same group at or before the terminal
--   sel_anchored             coverage issues/notes anchored to their fact, in reference order
--   sel_totals               range totals, by work type, by production date, coverage counts
--
-- Every function: SECURITY INVOKER, empty search_path, fully qualified,
-- execute granted only to service_role. Nothing is written.

BEGIN;

-- Contract count safety: Items above Number.MAX_SAFE_INTEGER are the overflow state (null, never a
-- rounded number); an Orders/count aggregate above it is an explicit error (no rounding, no clipping).
CREATE FUNCTION reporting_private.safe_items(p numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT CASE WHEN p IS NULL THEN NULL WHEN p < 0 OR p > 9007199254740991 OR p <> pg_catalog.trunc(p) THEN NULL ELSE p END
$fn$;
CREATE FUNCTION reporting_private.safe_count(p bigint)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF p IS NULL OR p < 0 OR p > 9007199254740991 THEN RAISE EXCEPTION 'report count % is outside the exact safe-integer range', p; END IF;
  RETURN p;
END
$fn$;

-- The four families (window rows, pre-window qualification verifications and cancelled
-- parents, post-window cancellations of window targets) over facts UNION source issues.
CREATE FUNCTION reporting_private.sel_rows(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz)
RETURNS TABLE (source text, event_id text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH f AS (
    SELECT e.event_id, e.event_type, e.created_at AS t, e.raw_order, e.parent_event_id AS pid, 'fact'::text AS source
      FROM reporting_private.event_facts e
     WHERE e.site = p_site AND e.audience_kind = p_ak AND e.audience_staff IS NOT DISTINCT FROM p_staff
       AND e.valid_from_seq <= p_seq AND (e.valid_to_seq IS NULL OR e.valid_to_seq > p_seq)
    UNION ALL
    SELECT i.event_id, i.event_type, i.created_at, i.raw_order, i.parent_event_id, 'issue'
      FROM reporting_private.source_issue_facts i
     WHERE i.site = p_site AND i.audience_kind = p_ak AND i.audience_staff IS NOT DISTINCT FROM p_staff
       AND i.valid_from_seq <= p_seq AND (i.valid_to_seq IS NULL OR i.valid_to_seq > p_seq)
  ), win AS (
    SELECT * FROM f WHERE f.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled') AND f.t >= p_start AND f.t < p_end
  )
  SELECT f.source, f.event_id FROM f
   WHERE (f.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled') AND f.t >= p_start AND f.t < p_end)
      OR (f.t < p_start AND (
            (f.event_type = 'line_verified' AND f.raw_order IS NOT NULL
               AND f.raw_order IN (SELECT w.raw_order FROM win w WHERE w.event_type IN ('completed', 'dispatched') AND w.raw_order IS NOT NULL AND pg_catalog.btrim(w.raw_order) <> ''))
         OR f.event_id IN (SELECT w.pid FROM win w WHERE w.event_type = 'cancelled' AND w.pid IS NOT NULL AND w.pid <> '')))
      OR (f.t >= p_end AND f.event_type = 'cancelled' AND f.pid IS NOT NULL
          AND f.pid IN (SELECT w.event_id FROM win w WHERE w.event_type IN ('line_verified', 'completed', 'dispatched')))
$fn$;

-- The production date of an instant at a site: local wall clock (IANA zone), days start at 04:00
-- (productionDateAt in src/lib/domain/productionPeriods.ts). Stored facts carry it only on verifications.
CREATE FUNCTION reporting_private.production_date_at(p_site text, p_at timestamptz)
RETURNS date
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT ((p_at AT TIME ZONE CASE p_site WHEN 'au' THEN 'Australia/Sydney' WHEN 'uk' THEN 'Europe/London' WHEN 'us' THEN 'America/Chicago' END) - interval '4 hours')::date
$fn$;

-- Selected facts with their selection-dependent state.
CREATE FUNCTION reporting_private.sel_eval(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz)
RETURNS TABLE (event_id text, role text, event_type text, created_at timestamptz, production_date date, staff_id uuid, department text, work_type text,
               order_key text, raw_order text, case_id text, line_key text, items bigint, item_status text, product_kind text,
               item_issue_kind text, item_issue_detail text, invalid_detail text, sku text, timing_stream boolean, timing_weight numeric,
               effective boolean, reversed boolean, qualification text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH s AS (
    SELECT e.* FROM reporting_private.event_facts e
     WHERE e.site = p_site AND e.audience_kind = p_ak AND e.audience_staff IS NOT DISTINCT FROM p_staff
       AND e.valid_from_seq <= p_seq AND (e.valid_to_seq IS NULL OR e.valid_to_seq > p_seq)
       AND e.event_id IN (SELECT r.event_id FROM reporting_private.sel_rows(p_site, p_ak, p_staff, p_seq, p_start, p_end) r WHERE r.source = 'fact')
  ), valid AS (
    -- A cancellation cancels its parent only through a VALID edge whose parent is SELECTED, a verification or
    -- terminal, and not later than the cancellation.
    SELECT p.event_id AS parent_id, p.role AS parent_role
      FROM s c
      JOIN reporting_private.cancel_edges x
        ON x.site = p_site AND x.audience_kind = p_ak AND x.audience_staff IS NOT DISTINCT FROM p_staff
       AND x.valid_from_seq <= p_seq AND (x.valid_to_seq IS NULL OR x.valid_to_seq > p_seq) AND x.cancel_event_id = c.event_id
      JOIN s p ON p.event_id = x.parent_event_id
     WHERE c.role = 'cancellation' AND NOT x.is_self AND p.role IN ('verification', 'terminal') AND p.created_at <= c.created_at AND x.pair = 'valid'
  )
  SELECT s.event_id, s.role, s.event_type, s.created_at, coalesce(s.production_date, reporting_private.production_date_at(p_site, s.created_at)), s.staff_id, s.department, s.work_type, s.order_key, s.raw_order, s.case_id, s.line_key,
         s.items, s.item_status, s.product_kind, s.item_issue_kind, s.item_issue_detail, s.invalid_detail, s.sku, s.timing_stream, s.timing_weight,
         s.role = 'verification' AND NOT EXISTS (SELECT 1 FROM valid v WHERE v.parent_id = s.event_id AND v.parent_role = 'verification'),
         s.role = 'terminal' AND EXISTS (SELECT 1 FROM valid v WHERE v.parent_id = s.event_id AND v.parent_role = 'terminal'),
         CASE WHEN s.role = 'terminal' THEN (
           SELECT CASE WHEN count(*) FILTER (WHERE v.product_kind = 'eligible') > 0 THEN 'eligible'
                       WHEN count(*) FILTER (WHERE v.product_kind IS DISTINCT FROM 'eligible' AND v.product_kind IS DISTINCT FROM 'excluded') > 0 THEN 'uncertain'
                       WHEN count(*) FILTER (WHERE v.product_kind = 'excluded') > 0 THEN 'excluded_only'
                       ELSE 'missing' END
             FROM s v
            WHERE v.role = 'verification' AND v.order_key = s.order_key AND v.work_type IS NOT DISTINCT FROM s.work_type
              AND v.case_id IS NOT DISTINCT FROM s.case_id AND v.created_at <= s.created_at) END
    FROM s
$fn$;

-- Coverage issues and notes, each anchored to its fact (in-scope filtering uses created_at/staff/work_type),
-- in the reference's order; source issues (selected malformed rows) are reported for the whole selection.
CREATE FUNCTION reporting_private.sel_anchored(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz)
RETURNS TABLE (ord integer, kind text, name text, event_id text, detail text, work_type text, created_at timestamptz, staff_id uuid, scoped boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH ev AS (SELECT * FROM reporting_private.sel_eval(p_site, p_ak, p_staff, p_seq, p_start, p_end)),
  edges AS (
    SELECT c.event_id, c.department, c.created_at, c.staff_id,
           CASE WHEN x.is_self THEN 'self-referencing cancellation'
                WHEN p.event_id IS NULL THEN 'parent not found'
                WHEN p.role NOT IN ('verification', 'terminal') THEN 'unsupported parent type'
                WHEN p.created_at > c.created_at THEN 'parent is later than cancellation'
                WHEN x.pair = 'valid' THEN NULL
                WHEN x.pair = 'mismatch' THEN 'cancellation does not match parent order/work type'
                WHEN x.pair = 'case_differs' THEN 'cancellation case differs from parent'
                ELSE 'unsupported parent type' END AS reason
      FROM ev c
      JOIN reporting_private.cancel_edges x
        ON x.site = p_site AND x.audience_kind = p_ak AND x.audience_staff IS NOT DISTINCT FROM p_staff
       AND x.valid_from_seq <= p_seq AND (x.valid_to_seq IS NULL OR x.valid_to_seq > p_seq) AND x.cancel_event_id = c.event_id
      LEFT JOIN ev p ON p.event_id = x.parent_event_id
     WHERE c.role = 'cancellation'
  ), repeats AS (
    SELECT v.event_id, v.work_type, v.created_at, v.staff_id, count(*) OVER (PARTITION BY v.order_key, v.work_type, v.case_id, v.line_key) AS n
      FROM ev v WHERE v.role = 'verification' AND v.effective
  )
  SELECT 0, 'issue', i.issue_kind, i.event_id, i.issue_detail, NULL::text, i.created_at, i.staff_id, false
    FROM reporting_private.source_issue_facts i
   WHERE i.site = p_site AND i.audience_kind = p_ak AND i.audience_staff IS NOT DISTINCT FROM p_staff
     AND i.valid_from_seq <= p_seq AND (i.valid_to_seq IS NULL OR i.valid_to_seq > p_seq)
     AND i.event_id IN (SELECT r.event_id FROM reporting_private.sel_rows(p_site, p_ak, p_staff, p_seq, p_start, p_end) r WHERE r.source = 'issue')
  UNION ALL SELECT 1, 'issue', 'invalid_event', f.event_id, f.invalid_detail, f.work_type, f.created_at, f.staff_id, true FROM ev f WHERE f.role = 'invalid'
  UNION ALL SELECT 2, 'issue', 'unresolved_parent', e.event_id, e.reason, CASE WHEN e.department IN ('a0_framed', 'framed', 'unframed', 'dispatch') THEN e.department END, e.created_at, e.staff_id, true
              FROM edges e WHERE e.reason IS NOT NULL
  UNION ALL SELECT 3, 'note', 'corrected_verification', v.event_id, NULL, v.work_type, v.created_at, v.staff_id, true FROM ev v WHERE v.role = 'verification' AND NOT v.effective
  UNION ALL SELECT 4, 'note', 'reversed_terminal', t.event_id, NULL, t.work_type, t.created_at, t.staff_id, true FROM ev t WHERE t.reversed
  UNION ALL SELECT 5, 'note', 'expected_exclusion', v.event_id, NULL, v.work_type, v.created_at, v.staff_id, true FROM ev v WHERE v.role = 'verification' AND v.item_status = 'excluded'
  UNION ALL SELECT 6, 'issue', v.item_issue_kind, v.event_id, v.item_issue_detail, v.work_type, v.created_at, v.staff_id, true FROM ev v WHERE v.role = 'verification' AND v.item_issue_kind IS NOT NULL
  UNION ALL SELECT 7, 'issue', 'missing_completion_detail', t.event_id, CASE t.qualification WHEN 'missing' THEN 'no line detail' ELSE 'only unclassified lines' END, t.work_type, t.created_at, t.staff_id, true
              FROM ev t WHERE t.role = 'terminal' AND NOT t.reversed AND t.qualification IN ('missing', 'uncertain')
  UNION ALL SELECT 8, 'note', 'excluded_only_completion', t.event_id, NULL, t.work_type, t.created_at, t.staff_id, true FROM ev t WHERE t.role = 'terminal' AND NOT t.reversed AND t.qualification = 'excluded_only'
  UNION ALL SELECT 9, 'issue', 'ambiguous_repeat', r.event_id, r.n || ' verifications of the same line', r.work_type, r.created_at, r.staff_id, true FROM repeats r WHERE r.n >= 2
$fn$;

-- Range totals for one selection and display scope (range, optional staff and work types).
-- Items are exact numeric sums (null = overflow past 2^53 - 1); Orders are exact distinct identities.
CREATE FUNCTION reporting_private.sel_totals(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz,
                                             p_scope_start timestamptz, p_scope_end timestamptz, p_staff_ids uuid[], p_work_types text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH ev AS (SELECT * FROM reporting_private.sel_eval(p_site, p_ak, p_staff, p_seq, p_start, p_end)),
  credit AS (
    SELECT v.work_type, v.staff_id, v.production_date, v.case_id IS NOT NULL AS rework, CASE WHEN v.item_status = 'counted' THEN v.items ELSE 0 END::numeric AS items
      FROM ev v
     WHERE v.role = 'verification' AND v.effective AND v.created_at >= p_scope_start AND v.created_at < p_scope_end
       AND (p_staff_ids IS NULL OR v.staff_id = ANY (p_staff_ids)) AND (p_work_types IS NULL OR v.work_type = ANY (p_work_types))
  ), orders AS (
    SELECT t.work_type, t.staff_id, t.production_date, t.case_id IS NOT NULL AS rework, t.order_key, t.case_id
      FROM ev t
     WHERE t.role = 'terminal' AND NOT t.reversed AND t.qualification <> 'excluded_only' AND t.created_at >= p_scope_start AND t.created_at < p_scope_end
       AND (p_staff_ids IS NULL OR t.staff_id = ANY (p_staff_ids)) AND (p_work_types IS NULL OR t.work_type = ANY (p_work_types))
  ), cov AS (
    SELECT DISTINCT ON (a.kind, a.name, a.event_id) a.*
      FROM reporting_private.sel_anchored(p_site, p_ak, p_staff, p_seq, p_start, p_end) a
     WHERE NOT a.scoped OR (a.created_at >= p_scope_start AND a.created_at < p_scope_end
                            AND (p_staff_ids IS NULL OR a.staff_id = ANY (p_staff_ids)) AND (p_work_types IS NULL OR a.work_type = ANY (p_work_types)))
     ORDER BY a.kind, a.name, a.event_id, a.ord
  ), grp AS (
    SELECT g.rework,
           (SELECT sum(c.items) FROM credit c WHERE c.rework = g.rework) AS items,
           reporting_private.safe_count((SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.rework = g.rework)) AS orders
      FROM (VALUES (false), (true)) g(rework)
  ), items_of AS (
    SELECT bool_or(coalesce(g.items, 0) > 9007199254740991) AS overflow FROM grp g
  )
  SELECT pg_catalog.jsonb_build_object(
    'totals', (SELECT pg_catalog.jsonb_object_agg(CASE WHEN g.rework THEN 'rework' ELSE 'normal' END,
                 pg_catalog.jsonb_build_object('items', CASE WHEN coalesce(g.items, 0) > 9007199254740991 THEN NULL ELSE coalesce(g.items, 0) END, 'orders', g.orders)) FROM grp g),
    'byWorkType', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('workType', w.wt, 'totals', pg_catalog.jsonb_build_object(
                     'normal', pg_catalog.jsonb_build_object('items', reporting_private.safe_items(coalesce((SELECT sum(c.items) FROM credit c WHERE c.work_type = w.wt AND NOT c.rework), 0)), 'orders', reporting_private.safe_count((SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.work_type = w.wt AND NOT o.rework))),
                     'rework', pg_catalog.jsonb_build_object('items', reporting_private.safe_items(coalesce((SELECT sum(c.items) FROM credit c WHERE c.work_type = w.wt AND c.rework), 0)), 'orders', reporting_private.safe_count((SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.work_type = w.wt AND o.rework)))))
                     ORDER BY w.n)
                     FROM (VALUES (1, 'a0_framed'), (2, 'framed'), (3, 'unframed'), (4, 'dispatch')) w(n, wt)),
    'daily', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productionDate', d.production_date, 'totals', pg_catalog.jsonb_build_object(
                     'normal', pg_catalog.jsonb_build_object('items', reporting_private.safe_items(coalesce((SELECT sum(c.items) FROM credit c WHERE c.production_date = d.production_date AND NOT c.rework), 0)), 'orders', reporting_private.safe_count((SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.production_date = d.production_date AND NOT o.rework))),
                     'rework', pg_catalog.jsonb_build_object('items', reporting_private.safe_items(coalesce((SELECT sum(c.items) FROM credit c WHERE c.production_date = d.production_date AND c.rework), 0)), 'orders', reporting_private.safe_count((SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.production_date = d.production_date AND o.rework)))))
                     ORDER BY d.production_date), '[]'::jsonb)
                FROM (SELECT DISTINCT c.production_date FROM credit c UNION SELECT DISTINCT o.production_date FROM orders o) d),
    'coverage', pg_catalog.jsonb_build_object(
       'issueCounts', (SELECT pg_catalog.jsonb_object_agg(k.k, reporting_private.safe_count((SELECT count(*) FROM cov c WHERE c.kind = 'issue' AND c.name = k.k)))
                         FROM pg_catalog.unnest(ARRAY['invalid_event', 'unclassified_sku', 'invalid_quantity', 'unresolved_parent', 'missing_completion_detail', 'ambiguous_repeat']) k(k)),
       'notes', (SELECT pg_catalog.jsonb_object_agg(k.k, reporting_private.safe_count((SELECT count(*) FROM reporting_private.sel_anchored(p_site, p_ak, p_staff, p_seq, p_start, p_end) a
                         WHERE a.kind = 'note' AND a.name = k.k AND a.created_at >= p_scope_start AND a.created_at < p_scope_end
                           AND (p_staff_ids IS NULL OR a.staff_id = ANY (p_staff_ids)) AND (p_work_types IS NULL OR a.work_type = ANY (p_work_types)))))
                   FROM pg_catalog.unnest(ARRAY['expected_exclusion', 'corrected_verification', 'reversed_terminal', 'excluded_only_completion']) k(k)),
       'issueRows', reporting_private.safe_count((SELECT count(*) FROM cov c WHERE c.kind = 'issue')),
       'overflow', (SELECT i.overflow FROM items_of i)))
$fn$;

-- UTF-16 code-unit order (JavaScript string `<`): the projector's tie-break for equal microseconds.
CREATE FUNCTION reporting_private.utf16_key(p text)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  out bytea := ''::bytea;
  cp  integer;
  u   integer;
  i   integer;
BEGIN
  FOR i IN 1 .. pg_catalog.length(p) LOOP
    cp := pg_catalog.ascii(pg_catalog.substr(p, i, 1));
    IF cp < 65536 THEN
      out := out || pg_catalog.set_byte(pg_catalog.set_byte('\x0000'::bytea, 0, cp >> 8), 1, cp & 255);
    ELSE
      u := 55296 + ((cp - 65536) >> 10);
      out := out || pg_catalog.set_byte(pg_catalog.set_byte('\x0000'::bytea, 0, u >> 8), 1, u & 255);
      u := 56320 + ((cp - 65536) & 1023);
      out := out || pg_catalog.set_byte(pg_catalog.set_byte('\x0000'::bytea, 0, u >> 8), 1, u & 255);
    END IF;
  END LOOP;
  RETURN out;
END
$fn$;

-- Frame timing lines of one selection, range and work-type choice (null = all types), every worker
-- (callers narrow by staff AFTER the stream: a filtered-out worker still sets their own predecessor).
-- Mirrors referenceTimingLines: effective, in range by millisecond, stream SKU; the predecessor is the
-- previous line of the same worker in THIS selected stream; gaps > 0 and <= 30 min with weight > 0 are timed.
CREATE FUNCTION reporting_private.sel_timing(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz,
                                             p_scope_start timestamptz, p_scope_end timestamptz, p_work_type text)
RETURNS TABLE (event_id text, staff_id uuid, work_type text, order_key text, sku text, weight numeric, started_ms bigint, completed_ms bigint, duration_min numeric,
               started_at timestamptz, completed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH v AS (
    SELECT e.event_id, e.staff_id, e.work_type, e.order_key, e.sku, e.timing_weight, e.created_at,
           pg_catalog.floor(EXTRACT(epoch FROM e.created_at) * 1000)::bigint AS ms
      FROM reporting_private.sel_eval(p_site, p_ak, p_staff, p_seq, p_start, p_end) e
     WHERE e.role = 'verification' AND e.effective AND e.timing_stream
       -- "in range" by MILLISECOND, as the app's timing (Date.parse of the bounds); the selection itself stays exact (review T11-1)
       AND pg_catalog.floor(EXTRACT(epoch FROM e.created_at) * 1000) >= pg_catalog.floor(EXTRACT(epoch FROM p_scope_start) * 1000)
       AND pg_catalog.floor(EXTRACT(epoch FROM e.created_at) * 1000) < pg_catalog.floor(EXTRACT(epoch FROM p_scope_end) * 1000)
       AND (p_work_type IS NULL OR e.work_type = p_work_type)
  ), s AS (
    SELECT v.*, pg_catalog.lag(v.ms) OVER w AS prev_ms, pg_catalog.lag(v.created_at) OVER w AS prev_at
      FROM v WINDOW w AS (PARTITION BY v.staff_id ORDER BY v.created_at, reporting_private.utf16_key(v.event_id))
  )
  SELECT s.event_id, s.staff_id, s.work_type, s.order_key, s.sku, s.timing_weight, coalesce(s.prev_ms, s.ms), s.ms,
         CASE WHEN s.prev_ms IS NOT NULL AND s.ms - s.prev_ms > 0 AND s.ms - s.prev_ms <= 30 * 60000 AND s.timing_weight > 0
              THEN (s.ms - s.prev_ms)::numeric / 60000 ELSE 0 END,
         coalesce(s.prev_at, s.created_at), s.created_at
    FROM s
$fn$;

-- Every visible person of a Reports selection with EXACT raw aggregates (numeric Items, bigint Orders,
-- days worked from raw per-production-date credit). Items become the overflow null only at the JSON
-- output boundary; days worked, ordering and rates always use the raw values.
CREATE FUNCTION reporting_private.sel_board(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz, p_work_type text)
RETURNS TABLE (staff_id uuid, n_items numeric, n_orders bigint, r_items numeric, r_orders bigint, days_worked bigint, duration numeric, weight numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH ev AS (SELECT * FROM reporting_private.sel_eval(p_site, p_ak, p_staff, p_seq, p_start, p_end)),
  credit AS (
    SELECT v.staff_id, v.production_date, v.case_id IS NOT NULL AS rework, CASE WHEN v.item_status = 'counted' THEN v.items ELSE 0 END::numeric AS items
      FROM ev v
     WHERE v.role = 'verification' AND v.effective AND v.created_at >= p_start AND v.created_at < p_end AND (p_work_type IS NULL OR v.work_type = p_work_type)
  ), orders AS (
    SELECT t.staff_id, t.production_date, t.case_id IS NOT NULL AS rework, t.order_key, t.case_id
      FROM ev t
     WHERE t.role = 'terminal' AND NOT t.reversed AND t.qualification <> 'excluded_only' AND t.created_at >= p_start AND t.created_at < p_end
       AND (p_work_type IS NULL OR t.work_type = p_work_type)
  ), people AS (
    SELECT DISTINCT x.staff_id FROM (SELECT c.staff_id FROM credit c UNION SELECT o.staff_id FROM orders o) x
  ), pday AS (
    -- raw per person-day values (never the overflow null): an overflow-only day still counts as worked
    SELECT p.staff_id, d.production_date,
           coalesce((SELECT sum(c.items) FROM credit c WHERE c.staff_id = p.staff_id AND c.production_date = d.production_date), 0) AS items,
           (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.staff_id = p.staff_id AND o.production_date = d.production_date) AS orders
      FROM people p CROSS JOIN (SELECT DISTINCT c.production_date FROM credit c UNION SELECT o.production_date FROM orders o) d
  ), tt AS (
    SELECT t.staff_id, sum(t.duration_min) AS duration, coalesce(sum(t.weight) FILTER (WHERE t.duration_min > 0), 0) AS weight
      FROM reporting_private.sel_timing(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_start, p_end, p_work_type) t GROUP BY t.staff_id
  )
  SELECT p.staff_id,
         coalesce((SELECT sum(c.items) FROM credit c WHERE c.staff_id = p.staff_id AND NOT c.rework), 0),
         (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.staff_id = p.staff_id AND NOT o.rework),
         coalesce((SELECT sum(c.items) FROM credit c WHERE c.staff_id = p.staff_id AND c.rework), 0),
         (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.staff_id = p.staff_id AND o.rework),
         (SELECT count(*) FROM pday d WHERE d.staff_id = p.staff_id AND (d.items > 0 OR d.orders > 0)),
         coalesce(x.duration, 0), coalesce(x.weight, 0)
    FROM people p LEFT JOIN tt x ON x.staff_id = p.staff_id
$fn$;

-- One bounded page of the leaderboard (Orders desc, raw Items desc, staff id bytewise: a total order) and
-- the exact number of rows; p_offset continues the same ordering under the same pinned generation/filter.
CREATE FUNCTION reporting_private.sel_people_page(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz,
                                                  p_work_type text, p_offset bigint, p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH b AS (SELECT * FROM reporting_private.sel_board(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_work_type)),
  page AS (
    SELECT b.*, pg_catalog.row_number() OVER (ORDER BY b.n_orders DESC, b.n_items DESC, b.staff_id::text COLLATE "C") AS rn FROM b
  )
  SELECT pg_catalog.jsonb_build_object(
    'total', reporting_private.safe_count((SELECT count(*) FROM b)),
    'rows', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'staffId', p.staff_id,
               'normal', pg_catalog.jsonb_build_object('items', reporting_private.safe_items(p.n_items), 'orders', reporting_private.safe_count(p.n_orders)),
               'rework', pg_catalog.jsonb_build_object('items', reporting_private.safe_items(p.r_items), 'orders', reporting_private.safe_count(p.r_orders)),
               'daysWorked', reporting_private.safe_count(p.days_worked),
               'itemsPerDay', CASE WHEN p.days_worked > 0 THEN p.n_items / p.days_worked ELSE 0 END,
               'ordersPerDay', CASE WHEN p.days_worked > 0 THEN p.n_orders::numeric / p.days_worked ELSE 0 END,
               'timing', pg_catalog.jsonb_build_object('durationMin', p.duration, 'timedWeight', p.weight, 'avgMinPerUnit', CASE WHEN p.weight > 0 THEN p.duration / p.weight ELSE 0 END))
               ORDER BY p.rn)
             FROM page p WHERE p.rn > p_offset AND p.rn <= p_offset + p_limit), '[]'::jsonb))
$fn$;

-- One bounded page of the tile's daily series (EVERY production date of the range, zero days included)
-- and the exact number of dates.
CREATE FUNCTION reporting_private.sel_daily_page(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz,
                                                 p_first_date date, p_last_date date, p_filter_staff uuid, p_work_type text, p_offset bigint, p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH ev AS (SELECT * FROM reporting_private.sel_eval(p_site, p_ak, p_staff, p_seq, p_start, p_end)),
  dates AS (
    SELECT (p_first_date + (p_offset + i)::integer) AS production_date
      FROM pg_catalog.generate_series(0::bigint, (p_limit - 1)::bigint) i
     WHERE p_first_date + (p_offset + i)::integer <= p_last_date
  ), credit AS (
    SELECT v.production_date, v.case_id IS NOT NULL AS rework, CASE WHEN v.item_status = 'counted' THEN v.items ELSE 0 END::numeric AS items
      FROM ev v
     WHERE v.role = 'verification' AND v.effective AND v.created_at >= p_start AND v.created_at < p_end
       AND (p_work_type IS NULL OR v.work_type = p_work_type) AND (p_filter_staff IS NULL OR v.staff_id = p_filter_staff)
       AND v.production_date IN (SELECT d.production_date FROM dates d)
  ), orders AS (
    SELECT t.production_date, t.case_id IS NOT NULL AS rework, t.order_key, t.case_id
      FROM ev t
     WHERE t.role = 'terminal' AND NOT t.reversed AND t.qualification <> 'excluded_only' AND t.created_at >= p_start AND t.created_at < p_end
       AND (p_work_type IS NULL OR t.work_type = p_work_type) AND (p_filter_staff IS NULL OR t.staff_id = p_filter_staff)
       AND t.production_date IN (SELECT d.production_date FROM dates d)
  )
  SELECT pg_catalog.jsonb_build_object(
    'total', reporting_private.safe_count((p_last_date - p_first_date + 1)::bigint),
    'rows', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productionDate', d.production_date, 'totals', pg_catalog.jsonb_build_object(
               'normal', pg_catalog.jsonb_build_object('items', reporting_private.safe_items(coalesce((SELECT sum(c.items) FROM credit c WHERE c.production_date = d.production_date AND NOT c.rework), 0)),
                                                       'orders', reporting_private.safe_count((SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.production_date = d.production_date AND NOT o.rework))),
               'rework', pg_catalog.jsonb_build_object('items', reporting_private.safe_items(coalesce((SELECT sum(c.items) FROM credit c WHERE c.production_date = d.production_date AND c.rework), 0)),
                                                       'orders', reporting_private.safe_count((SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.production_date = d.production_date AND o.rework)))))
               ORDER BY d.production_date) FROM dates d), '[]'::jsonb))
$fn$;

-- The Reports view for one range (p_first_date..p_last_date = p_start..p_end) and display filters:
-- tiles (staff + work type), page coverage (everyone, work type), the FIRST bounded leaderboard and daily
-- pages with their exact row counts (continued by read_reporting_detail), staff-days from raw
-- per-production-date credit, timing totals per tile, and per-SKU timing aggregates (the server groups
-- them by size/variant with the shared SKU parser). Whole-range scalars never depend on the pages.
CREATE FUNCTION reporting_private.sel_report(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz,
                                             p_first_date date, p_last_date date, p_filter_staff uuid, p_work_type text,
                                             p_daily_limit integer, p_people_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH board AS (
    SELECT * FROM reporting_private.sel_board(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_work_type)
  ), timing AS (
    SELECT * FROM reporting_private.sel_timing(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_start, p_end, p_work_type)
  ), tt AS (
    SELECT t.staff_id, sum(t.duration_min) AS duration, coalesce(sum(t.weight) FILTER (WHERE t.duration_min > 0), 0) AS weight FROM timing t GROUP BY t.staff_id
  ), tiles AS (
    SELECT reporting_private.sel_totals(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_start, p_end,
             CASE WHEN p_filter_staff IS NULL THEN NULL ELSE ARRAY[p_filter_staff] END, CASE WHEN p_work_type IS NULL THEN NULL ELSE ARRAY[p_work_type] END) AS j
  ), everyone AS (
    SELECT reporting_private.sel_totals(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_start, p_end, NULL, CASE WHEN p_work_type IS NULL THEN NULL ELSE ARRAY[p_work_type] END) AS j
  ), staff_days AS (
    SELECT CASE WHEN p_filter_staff IS NULL THEN coalesce((SELECT sum(b.days_worked) FROM board b), 0)
                ELSE coalesce((SELECT b.days_worked FROM board b WHERE b.staff_id = p_filter_staff), 0) END AS n
  )
  SELECT pg_catalog.jsonb_build_object(
    'totals', (SELECT tl.j -> 'totals' FROM tiles tl),
    'byWorkType', (SELECT tl.j -> 'byWorkType' FROM tiles tl),
    'coverage', (SELECT e.j -> 'coverage' FROM everyone e),
    'tileCoverage', (SELECT tl.j -> 'coverage' FROM tiles tl),
    'activeStaff', reporting_private.safe_count((SELECT count(*) FROM board b WHERE p_filter_staff IS NULL OR b.staff_id = p_filter_staff)),
    'staffDays', reporting_private.safe_count((SELECT s.n FROM staff_days s)::bigint),
    'avgOrdersPerStaffDay', (SELECT CASE WHEN s.n > 0 THEN ((SELECT tl.j #>> '{totals,normal,orders}' FROM tiles tl)::numeric / s.n) ELSE 0 END FROM staff_days s),
    'timing', (SELECT pg_catalog.jsonb_build_object('durationMin', coalesce(sum(x.duration), 0), 'timedWeight', coalesce(sum(x.weight), 0),
                 'avgMinPerUnit', CASE WHEN coalesce(sum(x.weight), 0) > 0 THEN sum(x.duration) / sum(x.weight) ELSE 0 END)
                 FROM tt x WHERE p_filter_staff IS NULL OR x.staff_id = p_filter_staff),
    'people', reporting_private.sel_people_page(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_work_type, 0, p_people_limit),
    'skuTiming', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('sku', g.sku, 'durationMin', g.duration, 'weight', g.weight) ORDER BY g.sku COLLATE "C"), '[]'::jsonb)
                    FROM (SELECT t.sku, sum(t.duration_min) AS duration, coalesce(sum(t.weight) FILTER (WHERE t.duration_min > 0), 0) AS weight
                            FROM timing t WHERE t.sku IS NOT NULL AND t.weight > 0 AND (p_filter_staff IS NULL OR t.staff_id = p_filter_staff) GROUP BY t.sku) g),
    'daily', reporting_private.sel_daily_page(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_first_date, p_last_date, p_filter_staff, p_work_type, 0, p_daily_limit))
$fn$;

REVOKE ALL ON FUNCTION reporting_private.utf16_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.sel_timing(text, text, uuid, bigint, timestamptz, timestamptz, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.sel_board(text, text, uuid, bigint, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.sel_people_page(text, text, uuid, bigint, timestamptz, timestamptz, text, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.sel_daily_page(text, text, uuid, bigint, timestamptz, timestamptz, date, date, uuid, text, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.sel_report(text, text, uuid, bigint, timestamptz, timestamptz, date, date, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.utf16_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.sel_timing(text, text, uuid, bigint, timestamptz, timestamptz, timestamptz, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.sel_board(text, text, uuid, bigint, timestamptz, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.sel_people_page(text, text, uuid, bigint, timestamptz, timestamptz, text, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.sel_daily_page(text, text, uuid, bigint, timestamptz, timestamptz, date, date, uuid, text, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.sel_report(text, text, uuid, bigint, timestamptz, timestamptz, date, date, uuid, text, integer, integer) TO service_role;

-- Welcome cells over one selection (the Welcome range): per production date, (date), (date, work type),
-- (date, work type, person) and (date, person) normal/rework Items and distinct (order, case) Orders,
-- plus the whole selection's coverage. The server assembles cards, top worker, streak, most improved and
-- the sparkline from these cells with the existing Welcome rules.
CREATE FUNCTION reporting_private.sel_welcome(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz, p_today_start timestamptz, p_today_end timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH ev AS (SELECT * FROM reporting_private.sel_eval(p_site, p_ak, p_staff, p_seq, p_start, p_end)),
  x AS (
    SELECT v.production_date AS d, v.work_type AS wt, v.staff_id AS who, v.case_id IS NOT NULL AS rework,
           CASE WHEN v.item_status = 'counted' THEN v.items ELSE 0 END::numeric AS items, NULL::text AS okey, NULL::text AS ocase, false AS is_order
      FROM ev v WHERE v.role = 'verification' AND v.effective AND v.created_at >= p_start AND v.created_at < p_end
    UNION ALL
    SELECT t.production_date, t.work_type, t.staff_id, t.case_id IS NOT NULL, 0, t.order_key, t.case_id, true
      FROM ev t WHERE t.role = 'terminal' AND NOT t.reversed AND t.qualification <> 'excluded_only' AND t.created_at >= p_start AND t.created_at < p_end
  ), cells AS (
    SELECT x.d, x.wt, x.who, GROUPING(x.wt) AS g_wt, GROUPING(x.who) AS g_who,
           coalesce(sum(x.items) FILTER (WHERE NOT x.rework), 0) AS n_items,
           count(DISTINCT (x.okey, x.ocase)) FILTER (WHERE x.is_order AND NOT x.rework) AS n_orders,
           coalesce(sum(x.items) FILTER (WHERE x.rework), 0) AS r_items,
           count(DISTINCT (x.okey, x.ocase)) FILTER (WHERE x.is_order AND x.rework) AS r_orders
      FROM x
     GROUP BY GROUPING SETS ((x.d), (x.d, x.wt), (x.d, x.wt, x.who), (x.d, x.who))
  )
  SELECT pg_catalog.jsonb_build_object(
    'cells', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'date', c.d, 'workType', CASE WHEN c.g_wt = 0 THEN c.wt END, 'staffId', CASE WHEN c.g_who = 0 THEN c.who END,
                'normal', pg_catalog.jsonb_build_object('items', reporting_private.safe_items(c.n_items), 'orders', reporting_private.safe_count(c.n_orders)), 'rework', pg_catalog.jsonb_build_object('items', reporting_private.safe_items(c.r_items), 'orders', reporting_private.safe_count(c.r_orders)))
                ORDER BY c.d, c.g_wt, c.wt, c.g_who, c.who), '[]'::jsonb) FROM cells c),
    'coverage', reporting_private.sel_totals(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_start, p_end, NULL, NULL) -> 'coverage',
    'todayCoverage', reporting_private.sel_totals(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_today_start, p_today_end, NULL, NULL) -> 'coverage')
$fn$;

REVOKE ALL ON FUNCTION reporting_private.sel_welcome(text, text, uuid, bigint, timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.sel_welcome(text, text, uuid, bigint, timestamptz, timestamptz, timestamptz, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION reporting_private.safe_items(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.safe_count(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.safe_items(numeric) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.safe_count(bigint) TO service_role;
REVOKE ALL ON FUNCTION reporting_private.production_date_at(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.production_date_at(text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION reporting_private.sel_rows(text, text, uuid, bigint, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.sel_eval(text, text, uuid, bigint, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.sel_anchored(text, text, uuid, bigint, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.sel_totals(text, text, uuid, bigint, timestamptz, timestamptz, timestamptz, timestamptz, uuid[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.sel_rows(text, text, uuid, bigint, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.sel_eval(text, text, uuid, bigint, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.sel_anchored(text, text, uuid, bigint, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.sel_totals(text, text, uuid, bigint, timestamptz, timestamptz, timestamptz, timestamptz, uuid[], text[]) TO service_role;

-- 04:00 local on a production date at a site, as an instant.
CREATE FUNCTION reporting_private.production_day_start(p_site text, p_date date)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT (p_date + time '04:00') AT TIME ZONE CASE p_site WHEN 'au' THEN 'Australia/Sydney' WHEN 'uk' THEN 'Europe/London' WHEN 'us' THEN 'America/Chicago' END
$fn$;

-- The site's active published generation (p_generation null) or the named one of that site, with the
-- site's CURRENT effective read mode. Times are exact UTC microsecond text.
CREATE FUNCTION public.read_reporting_generation(p_site text, p_generation uuid)
RETURNS TABLE (generation_id uuid, site text, state text, complete boolean, rule_version text, source_cutoff text, verified_at text, published_at text, expires_at text, read_mode text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT g.generation_id, g.site, g.state, g.complete, g.rule_version,
         pg_catalog.to_char(g.source_cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         pg_catalog.to_char(g.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         pg_catalog.to_char(g.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         pg_catalog.to_char(g.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         s.read_mode
    FROM reporting_private.generations g
    JOIN reporting_private.site_state s ON s.site = g.site
   WHERE g.site = p_site
     AND CASE WHEN p_generation IS NULL THEN g.state = 'published' ELSE g.generation_id = p_generation END
$fn$;

-- The one validation every public read shares: a supported site and work type, a well-formed trusted
-- audience, a nonempty date range whose window is exactly its production-day starts, and a retained
-- complete publication of that site. Returns that generation's sequence (the version-visibility seq).
CREATE FUNCTION reporting_private.checked_generation(p_fn text, p_site text, p_audience_kind text, p_audience_staff uuid, p_generation uuid,
                                                     p_first_date date, p_last_date date, p_start timestamptz, p_end timestamptz, p_work_type text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  g reporting_private.generations;
BEGIN
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN RAISE EXCEPTION '%: unsupported site', p_fn; END IF;
  IF p_audience_kind = 'site' THEN
    IF p_audience_staff IS NOT NULL THEN RAISE EXCEPTION '%: a site audience has no staff', p_fn; END IF;
  ELSIF p_audience_kind = 'self' THEN
    IF p_audience_staff IS NULL THEN RAISE EXCEPTION '%: a self audience needs its staff', p_fn; END IF;
  ELSE
    RAISE EXCEPTION '%: unsupported audience', p_fn;
  END IF;
  IF p_work_type IS NOT NULL AND p_work_type NOT IN ('a0_framed', 'framed', 'unframed', 'dispatch') THEN RAISE EXCEPTION '%: unsupported work type', p_fn; END IF;
  IF p_first_date IS NULL OR p_last_date IS NULL OR p_first_date > p_last_date THEN RAISE EXCEPTION '%: invalid date range', p_fn; END IF;
  IF p_start IS DISTINCT FROM reporting_private.production_day_start(p_site, p_first_date)
     OR p_end IS DISTINCT FROM reporting_private.production_day_start(p_site, p_last_date + 1) THEN
    RAISE EXCEPTION '%: the window does not match the production dates', p_fn;
  END IF;
  SELECT * INTO g FROM reporting_private.generations x WHERE x.generation_id = p_generation;
  IF NOT FOUND OR g.site <> p_site OR g.state NOT IN ('published', 'superseded') OR NOT g.complete THEN
    RAISE EXCEPTION '%: generation % is not a retained complete publication of %', p_fn, p_generation, p_site;
  END IF;
  RETURN g.generation_seq;
END
$fn$;

-- One published summary for a trusted audience (chosen by the server, never the client): the Reports
-- view parts and, for Welcome, the Welcome cells. Refuses anything malformed or not published/retained.
CREATE FUNCTION public.read_reporting_summary(p_site text, p_audience_kind text, p_audience_staff uuid, p_generation uuid,
                                              p_first_date date, p_last_date date, p_start timestamptz, p_end timestamptz,
                                              p_staff uuid, p_work_type text, p_view text, p_daily_limit integer, p_people_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_seq bigint;
BEGIN
  v_seq := reporting_private.checked_generation('read_reporting_summary', p_site, p_audience_kind, p_audience_staff, p_generation,
                                                p_first_date, p_last_date, p_start, p_end, p_work_type);
  IF p_view IS NULL OR p_view NOT IN ('reports', 'welcome') THEN RAISE EXCEPTION 'read_reporting_summary: unsupported view'; END IF;
  IF p_daily_limit IS NULL OR p_daily_limit < 1 OR p_daily_limit > 1000 OR p_people_limit IS NULL OR p_people_limit < 1 OR p_people_limit > 1000 THEN
    RAISE EXCEPTION 'read_reporting_summary: page limits must be 1..1000';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'report', reporting_private.sel_report(p_site, p_audience_kind, p_audience_staff, v_seq, p_start, p_end, p_first_date, p_last_date, p_staff, p_work_type,
                                           p_daily_limit, p_people_limit),
    'welcome', CASE WHEN p_view = 'welcome' THEN reporting_private.sel_welcome(p_site, p_audience_kind, p_audience_staff, v_seq, p_start, p_end,
                                                    reporting_private.production_day_start(p_site, p_last_date), p_end) END);
END
$fn$;

REVOKE ALL ON FUNCTION reporting_private.production_day_start(text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.production_day_start(text, date) TO service_role;
REVOKE ALL ON FUNCTION reporting_private.checked_generation(text, text, text, uuid, uuid, date, date, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.checked_generation(text, text, text, uuid, uuid, date, date, timestamptz, timestamptz, text) TO service_role;
REVOKE ALL ON FUNCTION public.read_reporting_generation(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_reporting_summary(text, text, uuid, uuid, date, date, timestamptz, timestamptz, uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_reporting_generation(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_reporting_summary(text, text, uuid, uuid, date, date, timestamptz, timestamptz, uuid, text, text, integer, integer) TO service_role;

-- Canonical exact UTC instant text for every DTO timestamp (six fractional digits, Z).
CREATE FUNCTION reporting_private.utc_text(p timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT pg_catalog.to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$fn$;

-- The `orders` detail: one row per overall order key (site|order[|case:id]) exactly as
-- summarizeProduction groups it, over the summary's selection (same evaluated facts) and display scope
-- (window, optional staff, optional work type applied to every CONTRIBUTING event): effective
-- verifications give verified lines and Items (counted only), qualifying non-reversed terminals give
-- completion. workTypes = the work types of the in-scope contributions, in work-type order; firstAtUtc /
-- lastAtUtc = the earliest / latest contributing event. Ascending UTF-16 order of the key (the app's
-- `<`), continued strictly after p_after; p_limit + 1 rows are read to decide `more`.
CREATE FUNCTION reporting_private.sel_detail_orders(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz,
                                                    p_filter_staff uuid, p_work_type text, p_order_key text, p_after text, p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH ev AS (SELECT * FROM reporting_private.sel_eval(p_site, p_ak, p_staff, p_seq, p_start, p_end)),
  contrib AS (
    SELECT v.order_key, v.case_id, v.work_type, v.staff_id, v.created_at, true AS verified, false AS completed,
           CASE WHEN v.item_status = 'counted' THEN v.items ELSE 0 END::numeric AS items
      FROM ev v
     WHERE v.role = 'verification' AND v.effective
    UNION ALL
    SELECT t.order_key, t.case_id, t.work_type, t.staff_id, t.created_at, false, true, 0::numeric
      FROM ev t
     WHERE t.role = 'terminal' AND NOT t.reversed AND t.qualification <> 'excluded_only'
  ), scoped AS (
    SELECT c.*, p_site || '|' || c.order_key || CASE WHEN c.case_id IS NULL THEN '' ELSE '|case:' || c.case_id END AS key
      FROM contrib c
     WHERE c.created_at >= p_start AND c.created_at < p_end AND c.order_key IS NOT NULL
       AND (p_filter_staff IS NULL OR c.staff_id = p_filter_staff)
       AND (p_work_type IS NULL OR c.work_type = p_work_type)
       AND (p_order_key IS NULL OR c.order_key = p_order_key)
  ), grp AS (
    SELECT s.key, min(s.order_key) AS order_key, min(s.case_id) AS case_id, min(s.created_at) AS first_at, max(s.created_at) AS last_at,
           pg_catalog.array_agg(DISTINCT s.work_type) FILTER (WHERE s.work_type IS NOT NULL) AS types,
           count(*) FILTER (WHERE s.verified) AS lines, sum(s.items) AS items, bool_or(s.completed) AS completed,
           reporting_private.utf16_key(s.key) AS ord
      FROM scoped s
     GROUP BY s.key
  ), page AS (
    SELECT g.* FROM grp g
     WHERE p_after IS NULL OR g.ord > reporting_private.utf16_key(p_after)
     ORDER BY g.ord
     LIMIT p_limit + 1
  ), shown AS (
    SELECT p.*, pg_catalog.row_number() OVER (ORDER BY p.ord) AS rn FROM page p
  )
  SELECT pg_catalog.jsonb_build_object(
    'rows', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'key', s.key, 'orderNumber', s.order_key, 'caseId', s.case_id, 'group', CASE WHEN s.case_id IS NULL THEN 'normal' ELSE 'rework' END,
               'firstAtUtc', reporting_private.utc_text(s.first_at), 'lastAtUtc', reporting_private.utc_text(s.last_at),
               'workTypes', coalesce((SELECT pg_catalog.jsonb_agg(w.wt ORDER BY w.ord)
                                        FROM pg_catalog.unnest(ARRAY['a0_framed', 'framed', 'unframed', 'dispatch']) WITH ORDINALITY AS w(wt, ord)
                                       WHERE w.wt = ANY (s.types)), '[]'::jsonb),
               'verifiedLines', reporting_private.safe_count(s.lines), 'items', reporting_private.safe_items(s.items), 'completed', s.completed)
               ORDER BY s.rn) FROM shown s WHERE s.rn <= p_limit), '[]'::jsonb),
    'last', (SELECT pg_catalog.to_jsonb(s.key) FROM shown s WHERE s.rn = least(p_limit, (SELECT count(*) FROM shown))),
    'more', (SELECT count(*) > p_limit FROM shown),
    'total_rows', reporting_private.safe_count((SELECT count(*) FROM grp)))
$fn$;

-- The `events` and `raw-export` details: the selection's own event stream for the pinned generation and
-- audience — every selected fact or source-issue row (the four relevant event types) whose instant is in
-- the window — with each event's retained source image AS OF that generation (source_versions visible at
-- its seq; never the live table or source_current). Display filters narrow it: staff (the event's
-- worker), work type (the stored classification; unclassified rows drop out) and the trimmed order.
-- Strict ascending (created_at, event id in UTF-16 order — the selection's own tie comparator), continued
-- strictly after p_after; exact total; p_limit + 1 rows read to decide `more`. Values are the raw saved
-- image values (quantity as its raw JSON value; blank text stays blank, null stays null).
CREATE FUNCTION reporting_private.sel_detail_events(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz,
                                                    p_filter_staff uuid, p_work_type text, p_order_key text, p_after_at timestamptz, p_after_id text,
                                                    p_limit integer, p_raw boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH sel AS (
    SELECT DISTINCT ON (x.event_id) x.event_id, x.created_at, x.staff_id, x.work_type, x.order_key
      FROM (
        SELECT e.event_id, e.created_at, e.staff_id, e.work_type, reporting_private.order_key(e.raw_order) AS order_key, 0 AS pref
          FROM reporting_private.event_facts e
         WHERE e.site = p_site AND e.audience_kind = p_ak AND e.audience_staff IS NOT DISTINCT FROM p_staff
           AND e.valid_from_seq <= p_seq AND (e.valid_to_seq IS NULL OR e.valid_to_seq > p_seq)
           AND e.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled') AND e.created_at >= p_start AND e.created_at < p_end
        UNION ALL
        SELECT i.event_id, i.created_at, i.staff_id, NULL::text, reporting_private.order_key(i.raw_order), 1
          FROM reporting_private.source_issue_facts i
         WHERE i.site = p_site AND i.audience_kind = p_ak AND i.audience_staff IS NOT DISTINCT FROM p_staff
           AND i.valid_from_seq <= p_seq AND (i.valid_to_seq IS NULL OR i.valid_to_seq > p_seq)
           AND i.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled') AND i.created_at >= p_start AND i.created_at < p_end
      ) x
     ORDER BY x.event_id, x.pref
  ), scoped AS (
    SELECT s.event_id, s.created_at, reporting_private.utf16_key(s.event_id) AS tie, v.image
      FROM sel s
      JOIN reporting_private.source_versions v
        ON v.site = p_site AND v.event_id = s.event_id AND v.valid_from_seq <= p_seq AND (v.valid_to_seq IS NULL OR v.valid_to_seq > p_seq)
     WHERE (p_filter_staff IS NULL OR s.staff_id = p_filter_staff)
       AND (p_work_type IS NULL OR s.work_type = p_work_type)
       AND (p_order_key IS NULL OR s.order_key = p_order_key)
  ), page AS (
    SELECT s.* FROM scoped s
     WHERE p_after_at IS NULL OR s.created_at > p_after_at OR (s.created_at = p_after_at AND s.tie > reporting_private.utf16_key(p_after_id))
     ORDER BY s.created_at, s.tie
     LIMIT p_limit + 1
  ), shown AS (
    SELECT p.*, pg_catalog.row_number() OVER (ORDER BY p.created_at, p.tie) AS rn FROM page p
  )
  SELECT pg_catalog.jsonb_build_object(
    'rows', coalesce((SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'id', s.event_id, 'staffId', s.image -> 'staff_id', 'department', s.image -> 'department', 'orderNumber', s.image -> 'order_number',
                 'sku', s.image -> 'line_sku', 'quantity', coalesce(s.image -> 'line_quantity', 'null'::jsonb), 'eventType', s.image -> 'event_type',
                 'createdAtUtc', reporting_private.utc_text(s.created_at), 'parentEventId', s.image -> 'parent_event_id', 'caseId', s.image -> 'cs_case_id')
               || CASE WHEN p_raw THEN pg_catalog.jsonb_build_object('note', s.image -> 'note', 'stationId', s.image -> 'station_id') ELSE '{}'::jsonb END
               ORDER BY s.rn) FROM shown s WHERE s.rn <= p_limit), '[]'::jsonb),
    'last', (SELECT pg_catalog.jsonb_build_array(reporting_private.utc_text(s.created_at), s.event_id) FROM shown s WHERE s.rn = least(p_limit, (SELECT count(*) FROM shown))),
    'more', (SELECT count(*) > p_limit FROM shown),
    'total_rows', reporting_private.safe_count((SELECT count(*) FROM scoped)))
$fn$;

-- The `coverage` detail: the summary's coverage ISSUES (never notes) as rows {kind, eventId, location,
-- detail}, from sel_anchored at the pinned generation: selected source issues stay selection-wide,
-- anchored issues obey the window, staff and work type; one row per (kind, event) by the same ord
-- precedence as the summary's counts. The order selector narrows to the trimmed order of the issue's
-- own stored row (its fact's raw order, or the source issue's raw order). Ascending (kind, event id) in
-- UTF-16 order (the app's comparator), continued strictly after p_after; exact total; limit + 1 read.
CREATE FUNCTION reporting_private.sel_detail_coverage(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz,
                                                      p_filter_staff uuid, p_work_type text, p_order_key text, p_after_kind text, p_after_id text, p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH cov AS (
    SELECT DISTINCT ON (a.name, a.event_id) a.name, a.event_id, a.detail, a.scoped
      FROM reporting_private.sel_anchored(p_site, p_ak, p_staff, p_seq, p_start, p_end) a
     WHERE a.kind = 'issue'
       AND (NOT a.scoped OR (a.created_at >= p_start AND a.created_at < p_end
                             AND (p_filter_staff IS NULL OR a.staff_id = p_filter_staff) AND (p_work_type IS NULL OR a.work_type = p_work_type)))
     ORDER BY a.name, a.event_id, a.ord
  ), scoped AS (
    SELECT c.*, reporting_private.utf16_key(c.name) AS k1, reporting_private.utf16_key(c.event_id) AS k2
      FROM cov c
     WHERE p_order_key IS NULL OR p_order_key = (
       CASE WHEN c.scoped THEN
         (SELECT reporting_private.order_key(e.raw_order) FROM reporting_private.event_facts e
           WHERE e.site = p_site AND e.audience_kind = p_ak AND e.audience_staff IS NOT DISTINCT FROM p_staff AND e.event_id = c.event_id
             AND e.valid_from_seq <= p_seq AND (e.valid_to_seq IS NULL OR e.valid_to_seq > p_seq))
       ELSE
         (SELECT reporting_private.order_key(i.raw_order) FROM reporting_private.source_issue_facts i
           WHERE i.site = p_site AND i.audience_kind = p_ak AND i.audience_staff IS NOT DISTINCT FROM p_staff AND i.event_id = c.event_id
             AND i.valid_from_seq <= p_seq AND (i.valid_to_seq IS NULL OR i.valid_to_seq > p_seq)
           LIMIT 1)
       END)
  ), page AS (
    SELECT s.* FROM scoped s
     WHERE p_after_kind IS NULL OR (s.k1, s.k2) > (reporting_private.utf16_key(p_after_kind), reporting_private.utf16_key(p_after_id))
     ORDER BY s.k1, s.k2
     LIMIT p_limit + 1
  ), shown AS (
    SELECT p.*, pg_catalog.row_number() OVER (ORDER BY p.k1, p.k2) AS rn FROM page p
  )
  SELECT pg_catalog.jsonb_build_object(
    'rows', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', s.name, 'eventId', s.event_id, 'location', p_site, 'detail', s.detail) ORDER BY s.rn)
                        FROM shown s WHERE s.rn <= p_limit), '[]'::jsonb),
    'last', (SELECT pg_catalog.jsonb_build_array(s.name, s.event_id) FROM shown s WHERE s.rn = least(p_limit, (SELECT count(*) FROM shown))),
    'more', (SELECT count(*) > p_limit FROM shown),
    'total_rows', reporting_private.safe_count((SELECT count(*) FROM scoped)))
$fn$;

-- The `timing` detail: the selection's effective timing stream (sel_timing at the pinned generation:
-- self isolation before selection; the work type narrows the stream BEFORE predecessors), narrowed
-- AFTER predecessors by staff and the trimmed order. Each line keeps the exact source instants of its
-- stream predecessor (or itself, first in range) and of itself; the duration is the existing
-- millisecond arithmetic. Ascending (completion instant, event id in UTF-16 order), continued strictly
-- after p_after; exact total; limit + 1 read.
CREATE FUNCTION reporting_private.sel_detail_timing(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz,
                                                    p_filter_staff uuid, p_work_type text, p_order_key text, p_after_at timestamptz, p_after_id text, p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH scoped AS (
    SELECT l.*, reporting_private.utf16_key(l.event_id) AS tie
      FROM reporting_private.sel_timing(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_start, p_end, p_work_type) l
     WHERE (p_filter_staff IS NULL OR l.staff_id = p_filter_staff)
       AND (p_order_key IS NULL OR l.order_key = p_order_key)
  ), page AS (
    SELECT s.* FROM scoped s
     WHERE p_after_at IS NULL OR s.completed_at > p_after_at OR (s.completed_at = p_after_at AND s.tie > reporting_private.utf16_key(p_after_id))
     ORDER BY s.completed_at, s.tie
     LIMIT p_limit + 1
  ), shown AS (
    SELECT p.*, pg_catalog.row_number() OVER (ORDER BY p.completed_at, p.tie) AS rn FROM page p
  )
  SELECT pg_catalog.jsonb_build_object(
    'rows', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'eventId', s.event_id, 'staffId', s.staff_id, 'workType', s.work_type, 'orderNumber', s.order_key, 'sku', s.sku, 'weight', s.weight,
               'startedAtUtc', reporting_private.utc_text(s.started_at), 'completedAtUtc', reporting_private.utc_text(s.completed_at), 'durationMin', s.duration_min)
               ORDER BY s.rn) FROM shown s WHERE s.rn <= p_limit), '[]'::jsonb),
    'last', (SELECT pg_catalog.jsonb_build_array(reporting_private.utc_text(s.completed_at), s.event_id) FROM shown s WHERE s.rn = least(p_limit, (SELECT count(*) FROM shown))),
    'more', (SELECT count(*) > p_limit FROM shown),
    'total_rows', reporting_private.safe_count((SELECT count(*) FROM scoped)))
$fn$;

-- One bounded detail page of ONE kind over the summary's exact selection (same generation, trusted
-- audience, window and staff/work-type filters): {rows, last, more, total_rows}. Rows are SQL-bounded
-- (overfetch one to decide `more`), total_rows is exact, and `last` is the continuation a signed cursor
-- carries back as p_after. days/people continue an OFFSET into the summary's own deterministic order
-- (production date; Orders desc, raw Items desc, staff id bytewise), so page 2 follows the summary's
-- first page with no gap or repeat. The remaining kinds are added with their keysets.
CREATE FUNCTION public.read_reporting_detail(p_site text, p_audience_kind text, p_audience_staff uuid, p_generation uuid,
                                             p_first_date date, p_last_date date, p_start timestamptz, p_end timestamptz,
                                             p_staff uuid, p_work_type text, p_kind text, p_order text, p_after jsonb, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_seq    bigint;
  v_offset bigint;
  v_page   jsonb;
  v_rows   jsonb;
  v_n      integer;
  v_total  bigint;
  v_at     timestamptz;
BEGIN
  v_seq := reporting_private.checked_generation('read_reporting_detail', p_site, p_audience_kind, p_audience_staff, p_generation,
                                                p_first_date, p_last_date, p_start, p_end, p_work_type);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'read_reporting_detail: p_limit must be 1..1000'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('days', 'people', 'orders', 'events', 'coverage', 'timing', 'raw-export') THEN
    RAISE EXCEPTION 'read_reporting_detail: unsupported kind';
  END IF;
  IF p_kind IN ('days', 'people') THEN
    IF p_order IS NOT NULL THEN RAISE EXCEPTION 'read_reporting_detail: an order selector does not apply to %', p_kind; END IF;
    -- the offset continuation: absent, or an exact non-negative safe integer (never text, fraction or tuple)
    IF p_after IS NULL OR p_after = 'null'::jsonb THEN
      v_offset := 0;
    ELSIF pg_catalog.jsonb_typeof(p_after) <> 'number' OR (p_after #>> '{}')::numeric <> pg_catalog.trunc((p_after #>> '{}')::numeric)
          OR (p_after #>> '{}')::numeric < 0 OR (p_after #>> '{}')::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'read_reporting_detail: the % continuation must be a non-negative integer offset', p_kind;
    ELSE
      v_offset := (p_after #>> '{}')::bigint;
    END IF;
    v_page := CASE p_kind
      WHEN 'days' THEN reporting_private.sel_daily_page(p_site, p_audience_kind, p_audience_staff, v_seq, p_start, p_end,
                                                        p_first_date, p_last_date, p_staff, p_work_type, v_offset, p_limit + 1)
      ELSE reporting_private.sel_people_page(p_site, p_audience_kind, p_audience_staff, v_seq, p_start, p_end, p_work_type, v_offset, p_limit + 1) END;
    v_total := (v_page ->> 'total')::bigint;
    SELECT coalesce(pg_catalog.jsonb_agg(x.e ORDER BY x.i), '[]'::jsonb), count(*)::integer INTO v_rows, v_n
      FROM pg_catalog.jsonb_array_elements(v_page -> 'rows') WITH ORDINALITY AS x(e, i)
     WHERE x.i <= p_limit;
    RETURN pg_catalog.jsonb_build_object(
      'rows', v_rows,
      'last', CASE WHEN v_n > 0 THEN pg_catalog.to_jsonb(v_offset + v_n) ELSE 'null'::jsonb END,
      'more', pg_catalog.jsonb_array_length(v_page -> 'rows') > p_limit,
      'total_rows', v_total);
  END IF;
  IF p_kind = 'orders' THEN
    -- keyset continuation: absent, or the previous page's last overall order key (a non-empty string)
    IF p_after IS NOT NULL AND p_after <> 'null'::jsonb AND (pg_catalog.jsonb_typeof(p_after) <> 'string' OR p_after #>> '{}' = '') THEN
      RAISE EXCEPTION 'read_reporting_detail: the orders continuation must be an order key';
    END IF;
    -- an order selector narrows to that order number (trimmed as order keys are); every other scope stays
    IF p_order IS NOT NULL AND coalesce(reporting_private.order_key(p_order), '') = '' THEN
      RAISE EXCEPTION 'read_reporting_detail: the order selector is blank';
    END IF;
    RETURN reporting_private.sel_detail_orders(p_site, p_audience_kind, p_audience_staff, v_seq, p_start, p_end, p_staff, p_work_type,
                                               reporting_private.order_key(p_order), CASE WHEN p_after IS NULL OR p_after = 'null'::jsonb THEN NULL ELSE p_after #>> '{}' END, p_limit);
  END IF;
  IF p_kind IN ('events', 'raw-export', 'timing') THEN
    -- keyset continuation: absent, or exactly [canonical UTC instant text, non-empty event id]
    IF p_after IS NOT NULL AND p_after <> 'null'::jsonb THEN
      IF pg_catalog.jsonb_typeof(p_after) <> 'array' OR pg_catalog.jsonb_array_length(p_after) <> 2
         OR pg_catalog.jsonb_typeof(p_after -> 0) <> 'string' OR pg_catalog.jsonb_typeof(p_after -> 1) <> 'string' OR p_after ->> 1 = ''
         OR (p_after ->> 0) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' THEN
        RAISE EXCEPTION 'read_reporting_detail: the % continuation must be [canonical UTC instant, event id]', p_kind;
      END IF;
      BEGIN
        v_at := (p_after ->> 0)::timestamptz;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'read_reporting_detail: the % continuation must be [canonical UTC instant, event id]', p_kind;
      END;
      IF reporting_private.utc_text(v_at) IS DISTINCT FROM p_after ->> 0 THEN
        RAISE EXCEPTION 'read_reporting_detail: the % continuation must be [canonical UTC instant, event id]', p_kind;
      END IF;
    END IF;
    IF p_order IS NOT NULL AND coalesce(reporting_private.order_key(p_order), '') = '' THEN
      RAISE EXCEPTION 'read_reporting_detail: the order selector is blank';
    END IF;
    IF p_kind = 'timing' THEN
      RETURN reporting_private.sel_detail_timing(p_site, p_audience_kind, p_audience_staff, v_seq, p_start, p_end, p_staff, p_work_type,
                                                 reporting_private.order_key(p_order), v_at, CASE WHEN v_at IS NULL THEN NULL ELSE p_after ->> 1 END, p_limit);
    END IF;
    RETURN reporting_private.sel_detail_events(p_site, p_audience_kind, p_audience_staff, v_seq, p_start, p_end, p_staff, p_work_type,
                                               reporting_private.order_key(p_order), v_at, CASE WHEN v_at IS NULL THEN NULL ELSE p_after ->> 1 END,
                                               p_limit, p_kind = 'raw-export');
  END IF;
  IF p_kind = 'coverage' THEN
    -- keyset continuation: absent, or exactly [non-empty issue kind, non-empty event id]
    IF p_after IS NOT NULL AND p_after <> 'null'::jsonb
       AND (pg_catalog.jsonb_typeof(p_after) <> 'array' OR pg_catalog.jsonb_array_length(p_after) <> 2
            OR pg_catalog.jsonb_typeof(p_after -> 0) <> 'string' OR pg_catalog.jsonb_typeof(p_after -> 1) <> 'string'
            OR p_after ->> 0 = '' OR p_after ->> 1 = '') THEN
      RAISE EXCEPTION 'read_reporting_detail: the coverage continuation must be [issue kind, event id]';
    END IF;
    IF p_order IS NOT NULL AND coalesce(reporting_private.order_key(p_order), '') = '' THEN
      RAISE EXCEPTION 'read_reporting_detail: the order selector is blank';
    END IF;
    RETURN reporting_private.sel_detail_coverage(p_site, p_audience_kind, p_audience_staff, v_seq, p_start, p_end, p_staff, p_work_type,
                                                 reporting_private.order_key(p_order),
                                                 CASE WHEN p_after IS NULL OR p_after = 'null'::jsonb THEN NULL ELSE p_after ->> 0 END,
                                                 CASE WHEN p_after IS NULL OR p_after = 'null'::jsonb THEN NULL ELSE p_after ->> 1 END, p_limit);
  END IF;
  RAISE EXCEPTION 'read_reporting_detail: kind % is not available yet', p_kind;
END
$fn$;

REVOKE ALL ON FUNCTION reporting_private.utc_text(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.sel_detail_orders(text, text, uuid, bigint, timestamptz, timestamptz, uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.utc_text(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.sel_detail_orders(text, text, uuid, bigint, timestamptz, timestamptz, uuid, text, text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION reporting_private.sel_detail_events(text, text, uuid, bigint, timestamptz, timestamptz, uuid, text, text, timestamptz, text, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.sel_detail_events(text, text, uuid, bigint, timestamptz, timestamptz, uuid, text, text, timestamptz, text, integer, boolean) TO service_role;
REVOKE ALL ON FUNCTION reporting_private.sel_detail_coverage(text, text, uuid, bigint, timestamptz, timestamptz, uuid, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.sel_detail_coverage(text, text, uuid, bigint, timestamptz, timestamptz, uuid, text, text, text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION reporting_private.sel_detail_timing(text, text, uuid, bigint, timestamptz, timestamptz, uuid, text, text, timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.sel_detail_timing(text, text, uuid, bigint, timestamptz, timestamptz, uuid, text, text, timestamptz, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.read_reporting_detail(text, text, uuid, uuid, date, date, timestamptz, timestamptz, uuid, text, text, text, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_reporting_detail(text, text, uuid, uuid, date, date, timestamptz, timestamptz, uuid, text, text, text, jsonb, integer) TO service_role;

COMMIT;
