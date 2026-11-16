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
           (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.rework = g.rework) AS orders
      FROM (VALUES (false), (true)) g(rework)
  ), items_of AS (
    SELECT bool_or(coalesce(g.items, 0) > 9007199254740991) AS overflow FROM grp g
  )
  SELECT pg_catalog.jsonb_build_object(
    'totals', (SELECT pg_catalog.jsonb_object_agg(CASE WHEN g.rework THEN 'rework' ELSE 'normal' END,
                 pg_catalog.jsonb_build_object('items', CASE WHEN coalesce(g.items, 0) > 9007199254740991 THEN NULL ELSE coalesce(g.items, 0) END, 'orders', g.orders)) FROM grp g),
    'byWorkType', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('workType', w.wt, 'totals', pg_catalog.jsonb_build_object(
                     'normal', pg_catalog.jsonb_build_object('items', coalesce((SELECT sum(c.items) FROM credit c WHERE c.work_type = w.wt AND NOT c.rework), 0), 'orders', (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.work_type = w.wt AND NOT o.rework)),
                     'rework', pg_catalog.jsonb_build_object('items', coalesce((SELECT sum(c.items) FROM credit c WHERE c.work_type = w.wt AND c.rework), 0), 'orders', (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.work_type = w.wt AND o.rework))))
                     ORDER BY w.n)
                     FROM (VALUES (1, 'a0_framed'), (2, 'framed'), (3, 'unframed'), (4, 'dispatch')) w(n, wt)),
    'daily', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productionDate', d.production_date, 'totals', pg_catalog.jsonb_build_object(
                     'normal', pg_catalog.jsonb_build_object('items', coalesce((SELECT sum(c.items) FROM credit c WHERE c.production_date = d.production_date AND NOT c.rework), 0), 'orders', (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.production_date = d.production_date AND NOT o.rework)),
                     'rework', pg_catalog.jsonb_build_object('items', coalesce((SELECT sum(c.items) FROM credit c WHERE c.production_date = d.production_date AND c.rework), 0), 'orders', (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.production_date = d.production_date AND o.rework))))
                     ORDER BY d.production_date), '[]'::jsonb)
                FROM (SELECT DISTINCT c.production_date FROM credit c UNION SELECT DISTINCT o.production_date FROM orders o) d),
    'coverage', pg_catalog.jsonb_build_object(
       'issueCounts', (SELECT pg_catalog.jsonb_object_agg(k.k, (SELECT count(*) FROM cov c WHERE c.kind = 'issue' AND c.name = k.k))
                         FROM pg_catalog.unnest(ARRAY['invalid_event', 'unclassified_sku', 'invalid_quantity', 'unresolved_parent', 'missing_completion_detail', 'ambiguous_repeat']) k(k)),
       'notes', (SELECT pg_catalog.jsonb_object_agg(k.k, (SELECT count(*) FROM reporting_private.sel_anchored(p_site, p_ak, p_staff, p_seq, p_start, p_end) a
                         WHERE a.kind = 'note' AND a.name = k.k AND a.created_at >= p_scope_start AND a.created_at < p_scope_end
                           AND (p_staff_ids IS NULL OR a.staff_id = ANY (p_staff_ids)) AND (p_work_types IS NULL OR a.work_type = ANY (p_work_types))))
                   FROM pg_catalog.unnest(ARRAY['expected_exclusion', 'corrected_verification', 'reversed_terminal', 'excluded_only_completion']) k(k)),
       'issueRows', (SELECT count(*) FROM cov c WHERE c.kind = 'issue'),
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
RETURNS TABLE (event_id text, staff_id uuid, work_type text, order_key text, sku text, weight numeric, started_ms bigint, completed_ms bigint, duration_min numeric)
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
       AND e.created_at >= p_scope_start AND e.created_at < p_scope_end AND (p_work_type IS NULL OR e.work_type = p_work_type)
  ), s AS (
    SELECT v.*, pg_catalog.lag(v.ms) OVER (PARTITION BY v.staff_id ORDER BY v.created_at, reporting_private.utf16_key(v.event_id)) AS prev_ms FROM v
  )
  SELECT s.event_id, s.staff_id, s.work_type, s.order_key, s.sku, s.timing_weight, coalesce(s.prev_ms, s.ms), s.ms,
         CASE WHEN s.prev_ms IS NOT NULL AND s.ms - s.prev_ms > 0 AND s.ms - s.prev_ms <= 30 * 60000 AND s.timing_weight > 0
              THEN (s.ms - s.prev_ms)::numeric / 60000 ELSE 0 END
    FROM s
$fn$;

-- The Reports view for one range (p_first_date..p_last_date = p_start..p_end) and display filters:
-- tiles (staff + work type), page coverage (everyone, work type), leaderboard of every visible person
-- (staff-days from per-production-date credit), timing totals per tile/person, per-SKU timing aggregates
-- (the server groups them by size/variant with the shared SKU parser), and the tile's daily series for
-- EVERY production date of the range (zero days included).
CREATE FUNCTION reporting_private.sel_report(p_site text, p_ak text, p_staff uuid, p_seq bigint, p_start timestamptz, p_end timestamptz,
                                             p_first_date date, p_last_date date, p_filter_staff uuid, p_work_type text)
RETURNS jsonb
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
    SELECT p.staff_id, d.production_date,
           coalesce((SELECT sum(c.items) FROM credit c WHERE c.staff_id = p.staff_id AND c.production_date = d.production_date), 0) AS items,
           (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.staff_id = p.staff_id AND o.production_date = d.production_date) AS orders
      FROM people p CROSS JOIN (SELECT DISTINCT c.production_date FROM credit c UNION SELECT o.production_date FROM orders o) d
  ), timing AS (
    SELECT * FROM reporting_private.sel_timing(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_start, p_end, p_work_type)
  ), tt AS (
    SELECT t.staff_id, sum(t.duration_min) AS duration, coalesce(sum(t.weight) FILTER (WHERE t.duration_min > 0), 0) AS weight FROM timing t GROUP BY t.staff_id
  ), board AS (
    SELECT p.staff_id,
           coalesce((SELECT sum(c.items) FROM credit c WHERE c.staff_id = p.staff_id AND NOT c.rework), 0) AS n_items,
           (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.staff_id = p.staff_id AND NOT o.rework) AS n_orders,
           coalesce((SELECT sum(c.items) FROM credit c WHERE c.staff_id = p.staff_id AND c.rework), 0) AS r_items,
           (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.staff_id = p.staff_id AND o.rework) AS r_orders,
           (SELECT count(*) FROM pday d WHERE d.staff_id = p.staff_id AND (d.items > 0 OR d.orders > 0)) AS days_worked
      FROM people p
  ), tiles AS (
    SELECT reporting_private.sel_totals(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_start, p_end,
             CASE WHEN p_filter_staff IS NULL THEN NULL ELSE ARRAY[p_filter_staff] END, CASE WHEN p_work_type IS NULL THEN NULL ELSE ARRAY[p_work_type] END) AS j
  ), everyone AS (
    SELECT reporting_private.sel_totals(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_start, p_end, NULL, CASE WHEN p_work_type IS NULL THEN NULL ELSE ARRAY[p_work_type] END) AS j
  ), staff_days AS (
    SELECT CASE WHEN p_filter_staff IS NULL THEN coalesce((SELECT sum(b.days_worked) FROM board b), 0)
                ELSE coalesce((SELECT b.days_worked FROM board b WHERE b.staff_id = p_filter_staff), 0) END AS n
  ), dates AS (
    SELECT d::date AS production_date FROM pg_catalog.generate_series(p_first_date::timestamp, p_last_date::timestamp, interval '1 day') d
  )
  SELECT pg_catalog.jsonb_build_object(
    'totals', (SELECT tl.j -> 'totals' FROM tiles tl),
    'byWorkType', (SELECT tl.j -> 'byWorkType' FROM tiles tl),
    'coverage', (SELECT e.j -> 'coverage' FROM everyone e),
    'tileCoverage', (SELECT tl.j -> 'coverage' FROM tiles tl),
    'activeStaff', (SELECT count(*) FROM people p WHERE p_filter_staff IS NULL OR p.staff_id = p_filter_staff),
    'staffDays', (SELECT s.n FROM staff_days s),
    'avgOrdersPerStaffDay', (SELECT CASE WHEN s.n > 0 THEN ((SELECT tl.j #>> '{totals,normal,orders}' FROM tiles tl)::numeric / s.n) ELSE 0 END FROM staff_days s),
    'timing', (SELECT pg_catalog.jsonb_build_object('durationMin', coalesce(sum(x.duration), 0), 'timedWeight', coalesce(sum(x.weight), 0),
                 'avgMinPerUnit', CASE WHEN coalesce(sum(x.weight), 0) > 0 THEN sum(x.duration) / sum(x.weight) ELSE 0 END)
                 FROM tt x WHERE p_filter_staff IS NULL OR x.staff_id = p_filter_staff),
    'people', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'staffId', b.staff_id, 'normal', pg_catalog.jsonb_build_object('items', b.n_items, 'orders', b.n_orders), 'rework', pg_catalog.jsonb_build_object('items', b.r_items, 'orders', b.r_orders),
                 'daysWorked', b.days_worked, 'itemsPerDay', CASE WHEN b.days_worked > 0 THEN b.n_items / b.days_worked ELSE 0 END,
                 'ordersPerDay', CASE WHEN b.days_worked > 0 THEN b.n_orders::numeric / b.days_worked ELSE 0 END,
                 'timing', pg_catalog.jsonb_build_object('durationMin', coalesce(x.duration, 0), 'timedWeight', coalesce(x.weight, 0),
                    'avgMinPerUnit', CASE WHEN coalesce(x.weight, 0) > 0 THEN x.duration / x.weight ELSE 0 END))
                 ORDER BY b.n_orders DESC, b.n_items DESC, b.staff_id::text COLLATE "C"), '[]'::jsonb)
                 FROM board b LEFT JOIN tt x ON x.staff_id = b.staff_id),
    'skuTiming', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('sku', g.sku, 'durationMin', g.duration, 'weight', g.weight) ORDER BY g.sku COLLATE "C"), '[]'::jsonb)
                    FROM (SELECT t.sku, sum(t.duration_min) AS duration, coalesce(sum(t.weight) FILTER (WHERE t.duration_min > 0), 0) AS weight
                            FROM timing t WHERE t.sku IS NOT NULL AND t.weight > 0 AND (p_filter_staff IS NULL OR t.staff_id = p_filter_staff) GROUP BY t.sku) g),
    'daily', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productionDate', d.production_date, 'totals', pg_catalog.jsonb_build_object(
                 'normal', pg_catalog.jsonb_build_object('items', coalesce((SELECT sum(c.items) FROM credit c WHERE c.production_date = d.production_date AND NOT c.rework AND (p_filter_staff IS NULL OR c.staff_id = p_filter_staff)), 0),
                                                         'orders', (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.production_date = d.production_date AND NOT o.rework AND (p_filter_staff IS NULL OR o.staff_id = p_filter_staff))),
                 'rework', pg_catalog.jsonb_build_object('items', coalesce((SELECT sum(c.items) FROM credit c WHERE c.production_date = d.production_date AND c.rework AND (p_filter_staff IS NULL OR c.staff_id = p_filter_staff)), 0),
                                                         'orders', (SELECT count(DISTINCT (o.order_key, o.case_id)) FROM orders o WHERE o.production_date = d.production_date AND o.rework AND (p_filter_staff IS NULL OR o.staff_id = p_filter_staff)))))
                 ORDER BY d.production_date) FROM dates d))
$fn$;

REVOKE ALL ON FUNCTION reporting_private.utf16_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.sel_timing(text, text, uuid, bigint, timestamptz, timestamptz, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.sel_report(text, text, uuid, bigint, timestamptz, timestamptz, date, date, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.utf16_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.sel_timing(text, text, uuid, bigint, timestamptz, timestamptz, timestamptz, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.sel_report(text, text, uuid, bigint, timestamptz, timestamptz, date, date, uuid, text) TO service_role;

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
                'normal', pg_catalog.jsonb_build_object('items', c.n_items, 'orders', c.n_orders), 'rework', pg_catalog.jsonb_build_object('items', c.r_items, 'orders', c.r_orders))
                ORDER BY c.d, c.g_wt, c.wt, c.g_who, c.who), '[]'::jsonb) FROM cells c),
    'coverage', reporting_private.sel_totals(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_start, p_end, NULL, NULL) -> 'coverage',
    'todayCoverage', reporting_private.sel_totals(p_site, p_ak, p_staff, p_seq, p_start, p_end, p_today_start, p_today_end, NULL, NULL) -> 'coverage')
$fn$;

REVOKE ALL ON FUNCTION reporting_private.sel_welcome(text, text, uuid, bigint, timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.sel_welcome(text, text, uuid, bigint, timestamptz, timestamptz, timestamptz, timestamptz) TO service_role;

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

COMMIT;
