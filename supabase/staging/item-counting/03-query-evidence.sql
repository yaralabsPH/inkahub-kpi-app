-- item-counting · Task 4 staging gate · step 3 of 3: function, plan and expectation evidence
--
-- GENERATED from supabase/migrations/0034_load_production_evidence.sql and
-- tests/staging/measure-item-counting.ts (MEASURE_CASES, STAGING_CUTOFF).
-- STAGING ONLY. Read-only: everything runs inside a transaction that is
-- rolled back. Needs migration 0034 applied on staging first (CJ).
--
-- 1. Function signature, security, settings and grants from the catalogs.
-- 2. For the owner and manager test users (authenticated role, RLS on), for
--    each of the six scopes:
--      - EXPLAIN (ANALYZE, BUFFERS) of the function call, three labelled runs
--      - EXPLAIN (ANALYZE, BUFFERS) of the exact function body with the same
--        arguments (the call's plan hides the internals)
--      - an independent expectation: the four families written with EXISTS,
--        counted, compared with the function's rowCount
-- 3. Small fixtures: staff, an empty window and invalid input.
-- Fixed cutoff for every scope: 2026-11-12T00:00:00.000Z.
--
-- Labels: every EXPLAIN's first line selects 'gate:<kind>:<role>:<scope>:<run>' as gate.

begin;

-- function catalog evidence
select p.proname as fn_name,
       pg_get_function_identity_arguments(p.oid) as fn_args,
       pg_get_function_result(p.oid) as fn_result,
       l.lanname as fn_language,
       p.provolatile as fn_volatility,
       p.prosecdef as fn_security_definer,
       coalesce(array_to_string(p.proconfig, ','), '') as fn_config,
       md5(pg_get_functiondef(p.oid)) as fn_definition_md5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
where n.nspname = 'public' and p.proname = 'load_production_evidence';

-- function privileges
select r.grantee as fn_grantee,
       case when r.grantee = 'PUBLIC'
            then exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.oid = 'public.load_production_evidence(text, timestamptz, timestamptz, timestamptz)'::regprocedure
                           and a.grantee = 0 and a.privilege_type = 'EXECUTE')
            else has_function_privilege(r.grantee, 'public.load_production_evidence(text, timestamptz, timestamptz, timestamptz)', 'EXECUTE')
       end as can_execute
from (values ('PUBLIC'), ('anon'), ('authenticated'), ('service_role')) r(grantee);

select pg_size_pretty(pg_total_relation_size('public.production_events')) as total_size,
       (select count(*) from public.production_events) as rows;

analyze public.production_events;

reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'owner@inka-staging.test'),
                    'role', 'authenticated')::text, true) as become_owner;
set local role authenticated;

explain (analyze, buffers) select 'gate:call:owner:au-busy-day:1' as gate,
  public.load_production_evidence('au', '2026-09-14T18:00:00.000Z'::timestamptz, '2026-09-15T18:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:au-busy-day:2' as gate,
  public.load_production_evidence('au', '2026-09-14T18:00:00.000Z'::timestamptz, '2026-09-15T18:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:au-busy-day:3' as gate,
  public.load_production_evidence('au', '2026-09-14T18:00:00.000Z'::timestamptz, '2026-09-15T18:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:owner:au-busy-day:1' as gate, (
SELECT CASE
    WHEN 'au'::text IS NULL OR pg_catalog.btrim('au'::text) = ''
      OR '2026-09-14T18:00:00.000Z'::timestamptz IS NULL OR '2026-09-15T18:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-09-14T18:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-09-15T18:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-09-14T18:00:00.000Z'::timestamptz >= '2026-09-15T18:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'au'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-09-14T18:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-09-15T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'au'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-09-14T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'au'::text
          AND pe.created_at < '2026-09-14T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'au'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-09-15T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'au'::text,
        'startUtc', '2026-09-14T18:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-09-15T18:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'au' and pe.created_at >= '2026-09-14T18:00:00.000Z'::timestamptz and pe.created_at < '2026-09-15T18:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'au' and x.event_type = 'line_verified' and x.created_at < '2026-09-14T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'au' and x.created_at < '2026-09-14T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'au' and x.event_type = 'cancelled' and x.created_at >= '2026-09-15T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'owner' as role, 'au-busy-day' as scope,
  (public.load_production_evidence('au', '2026-09-14T18:00:00.000Z'::timestamptz, '2026-09-15T18:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

explain (analyze, buffers) select 'gate:call:owner:au-3-months:1' as gate,
  public.load_production_evidence('au', '2026-07-31T18:00:00.000Z'::timestamptz, '2026-10-31T17:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:au-3-months:2' as gate,
  public.load_production_evidence('au', '2026-07-31T18:00:00.000Z'::timestamptz, '2026-10-31T17:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:au-3-months:3' as gate,
  public.load_production_evidence('au', '2026-07-31T18:00:00.000Z'::timestamptz, '2026-10-31T17:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:owner:au-3-months:1' as gate, (
SELECT CASE
    WHEN 'au'::text IS NULL OR pg_catalog.btrim('au'::text) = ''
      OR '2026-07-31T18:00:00.000Z'::timestamptz IS NULL OR '2026-10-31T17:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-07-31T18:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-10-31T17:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-07-31T18:00:00.000Z'::timestamptz >= '2026-10-31T17:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'au'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-07-31T18:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-10-31T17:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'au'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-07-31T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'au'::text
          AND pe.created_at < '2026-07-31T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'au'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-10-31T17:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'au'::text,
        'startUtc', '2026-07-31T18:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-10-31T17:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'au' and pe.created_at >= '2026-07-31T18:00:00.000Z'::timestamptz and pe.created_at < '2026-10-31T17:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'au' and x.event_type = 'line_verified' and x.created_at < '2026-07-31T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'au' and x.created_at < '2026-07-31T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'au' and x.event_type = 'cancelled' and x.created_at >= '2026-10-31T17:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'owner' as role, 'au-3-months' as scope,
  (public.load_production_evidence('au', '2026-07-31T18:00:00.000Z'::timestamptz, '2026-10-31T17:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

explain (analyze, buffers) select 'gate:call:owner:uk-day:1' as gate,
  public.load_production_evidence('uk', '2026-03-29T03:00:00.000Z'::timestamptz, '2026-03-30T03:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:uk-day:2' as gate,
  public.load_production_evidence('uk', '2026-03-29T03:00:00.000Z'::timestamptz, '2026-03-30T03:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:uk-day:3' as gate,
  public.load_production_evidence('uk', '2026-03-29T03:00:00.000Z'::timestamptz, '2026-03-30T03:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:owner:uk-day:1' as gate, (
SELECT CASE
    WHEN 'uk'::text IS NULL OR pg_catalog.btrim('uk'::text) = ''
      OR '2026-03-29T03:00:00.000Z'::timestamptz IS NULL OR '2026-03-30T03:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-03-29T03:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-03-30T03:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-03-29T03:00:00.000Z'::timestamptz >= '2026-03-30T03:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'uk'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-03-29T03:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-03-30T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'uk'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-03-29T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'uk'::text
          AND pe.created_at < '2026-03-29T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'uk'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-03-30T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'uk'::text,
        'startUtc', '2026-03-29T03:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-03-30T03:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'uk' and pe.created_at >= '2026-03-29T03:00:00.000Z'::timestamptz and pe.created_at < '2026-03-30T03:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.event_type = 'line_verified' and x.created_at < '2026-03-29T03:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.created_at < '2026-03-29T03:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.event_type = 'cancelled' and x.created_at >= '2026-03-30T03:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'owner' as role, 'uk-day' as scope,
  (public.load_production_evidence('uk', '2026-03-29T03:00:00.000Z'::timestamptz, '2026-03-30T03:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

explain (analyze, buffers) select 'gate:call:owner:uk-3-months:1' as gate,
  public.load_production_evidence('uk', '2026-08-01T03:00:00.000Z'::timestamptz, '2026-11-01T04:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:uk-3-months:2' as gate,
  public.load_production_evidence('uk', '2026-08-01T03:00:00.000Z'::timestamptz, '2026-11-01T04:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:uk-3-months:3' as gate,
  public.load_production_evidence('uk', '2026-08-01T03:00:00.000Z'::timestamptz, '2026-11-01T04:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:owner:uk-3-months:1' as gate, (
SELECT CASE
    WHEN 'uk'::text IS NULL OR pg_catalog.btrim('uk'::text) = ''
      OR '2026-08-01T03:00:00.000Z'::timestamptz IS NULL OR '2026-11-01T04:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-08-01T03:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-01T04:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-08-01T03:00:00.000Z'::timestamptz >= '2026-11-01T04:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'uk'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-08-01T03:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-11-01T04:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'uk'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-08-01T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'uk'::text
          AND pe.created_at < '2026-08-01T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'uk'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-11-01T04:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'uk'::text,
        'startUtc', '2026-08-01T03:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-11-01T04:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'uk' and pe.created_at >= '2026-08-01T03:00:00.000Z'::timestamptz and pe.created_at < '2026-11-01T04:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.event_type = 'line_verified' and x.created_at < '2026-08-01T03:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.created_at < '2026-08-01T03:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.event_type = 'cancelled' and x.created_at >= '2026-11-01T04:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'owner' as role, 'uk-3-months' as scope,
  (public.load_production_evidence('uk', '2026-08-01T03:00:00.000Z'::timestamptz, '2026-11-01T04:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

explain (analyze, buffers) select 'gate:call:owner:us-day:1' as gate,
  public.load_production_evidence('us', '2026-03-08T09:00:00.000Z'::timestamptz, '2026-03-09T09:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:us-day:2' as gate,
  public.load_production_evidence('us', '2026-03-08T09:00:00.000Z'::timestamptz, '2026-03-09T09:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:us-day:3' as gate,
  public.load_production_evidence('us', '2026-03-08T09:00:00.000Z'::timestamptz, '2026-03-09T09:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:owner:us-day:1' as gate, (
SELECT CASE
    WHEN 'us'::text IS NULL OR pg_catalog.btrim('us'::text) = ''
      OR '2026-03-08T09:00:00.000Z'::timestamptz IS NULL OR '2026-03-09T09:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-03-08T09:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-03-09T09:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-03-08T09:00:00.000Z'::timestamptz >= '2026-03-09T09:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'us'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-03-08T09:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-03-09T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'us'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-03-08T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'us'::text
          AND pe.created_at < '2026-03-08T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'us'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-03-09T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'us'::text,
        'startUtc', '2026-03-08T09:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-03-09T09:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'us' and pe.created_at >= '2026-03-08T09:00:00.000Z'::timestamptz and pe.created_at < '2026-03-09T09:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'us' and x.event_type = 'line_verified' and x.created_at < '2026-03-08T09:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'us' and x.created_at < '2026-03-08T09:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'us' and x.event_type = 'cancelled' and x.created_at >= '2026-03-09T09:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'owner' as role, 'us-day' as scope,
  (public.load_production_evidence('us', '2026-03-08T09:00:00.000Z'::timestamptz, '2026-03-09T09:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

explain (analyze, buffers) select 'gate:call:owner:us-3-months:1' as gate,
  public.load_production_evidence('us', '2026-08-01T09:00:00.000Z'::timestamptz, '2026-11-01T10:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:us-3-months:2' as gate,
  public.load_production_evidence('us', '2026-08-01T09:00:00.000Z'::timestamptz, '2026-11-01T10:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:owner:us-3-months:3' as gate,
  public.load_production_evidence('us', '2026-08-01T09:00:00.000Z'::timestamptz, '2026-11-01T10:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:owner:us-3-months:1' as gate, (
SELECT CASE
    WHEN 'us'::text IS NULL OR pg_catalog.btrim('us'::text) = ''
      OR '2026-08-01T09:00:00.000Z'::timestamptz IS NULL OR '2026-11-01T10:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-08-01T09:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-01T10:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-08-01T09:00:00.000Z'::timestamptz >= '2026-11-01T10:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'us'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-08-01T09:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-11-01T10:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'us'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-08-01T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'us'::text
          AND pe.created_at < '2026-08-01T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'us'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-11-01T10:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'us'::text,
        'startUtc', '2026-08-01T09:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-11-01T10:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'us' and pe.created_at >= '2026-08-01T09:00:00.000Z'::timestamptz and pe.created_at < '2026-11-01T10:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'us' and x.event_type = 'line_verified' and x.created_at < '2026-08-01T09:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'us' and x.created_at < '2026-08-01T09:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'us' and x.event_type = 'cancelled' and x.created_at >= '2026-11-01T10:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'owner' as role, 'us-3-months' as scope,
  (public.load_production_evidence('us', '2026-08-01T09:00:00.000Z'::timestamptz, '2026-11-01T10:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'manager@inka-staging.test'),
                    'role', 'authenticated')::text, true) as become_manager;
set local role authenticated;

explain (analyze, buffers) select 'gate:call:manager:au-busy-day:1' as gate,
  public.load_production_evidence('au', '2026-09-14T18:00:00.000Z'::timestamptz, '2026-09-15T18:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:au-busy-day:2' as gate,
  public.load_production_evidence('au', '2026-09-14T18:00:00.000Z'::timestamptz, '2026-09-15T18:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:au-busy-day:3' as gate,
  public.load_production_evidence('au', '2026-09-14T18:00:00.000Z'::timestamptz, '2026-09-15T18:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:manager:au-busy-day:1' as gate, (
SELECT CASE
    WHEN 'au'::text IS NULL OR pg_catalog.btrim('au'::text) = ''
      OR '2026-09-14T18:00:00.000Z'::timestamptz IS NULL OR '2026-09-15T18:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-09-14T18:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-09-15T18:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-09-14T18:00:00.000Z'::timestamptz >= '2026-09-15T18:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'au'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-09-14T18:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-09-15T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'au'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-09-14T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'au'::text
          AND pe.created_at < '2026-09-14T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'au'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-09-15T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'au'::text,
        'startUtc', '2026-09-14T18:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-09-15T18:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'au' and pe.created_at >= '2026-09-14T18:00:00.000Z'::timestamptz and pe.created_at < '2026-09-15T18:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'au' and x.event_type = 'line_verified' and x.created_at < '2026-09-14T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'au' and x.created_at < '2026-09-14T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'au' and x.event_type = 'cancelled' and x.created_at >= '2026-09-15T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'manager' as role, 'au-busy-day' as scope,
  (public.load_production_evidence('au', '2026-09-14T18:00:00.000Z'::timestamptz, '2026-09-15T18:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

explain (analyze, buffers) select 'gate:call:manager:au-3-months:1' as gate,
  public.load_production_evidence('au', '2026-07-31T18:00:00.000Z'::timestamptz, '2026-10-31T17:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:au-3-months:2' as gate,
  public.load_production_evidence('au', '2026-07-31T18:00:00.000Z'::timestamptz, '2026-10-31T17:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:au-3-months:3' as gate,
  public.load_production_evidence('au', '2026-07-31T18:00:00.000Z'::timestamptz, '2026-10-31T17:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:manager:au-3-months:1' as gate, (
SELECT CASE
    WHEN 'au'::text IS NULL OR pg_catalog.btrim('au'::text) = ''
      OR '2026-07-31T18:00:00.000Z'::timestamptz IS NULL OR '2026-10-31T17:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-07-31T18:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-10-31T17:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-07-31T18:00:00.000Z'::timestamptz >= '2026-10-31T17:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'au'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-07-31T18:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-10-31T17:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'au'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-07-31T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'au'::text
          AND pe.created_at < '2026-07-31T18:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'au'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-10-31T17:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'au'::text,
        'startUtc', '2026-07-31T18:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-10-31T17:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'au' and pe.created_at >= '2026-07-31T18:00:00.000Z'::timestamptz and pe.created_at < '2026-10-31T17:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'au' and x.event_type = 'line_verified' and x.created_at < '2026-07-31T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'au' and x.created_at < '2026-07-31T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'au' and x.event_type = 'cancelled' and x.created_at >= '2026-10-31T17:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'manager' as role, 'au-3-months' as scope,
  (public.load_production_evidence('au', '2026-07-31T18:00:00.000Z'::timestamptz, '2026-10-31T17:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

explain (analyze, buffers) select 'gate:call:manager:uk-day:1' as gate,
  public.load_production_evidence('uk', '2026-03-29T03:00:00.000Z'::timestamptz, '2026-03-30T03:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:uk-day:2' as gate,
  public.load_production_evidence('uk', '2026-03-29T03:00:00.000Z'::timestamptz, '2026-03-30T03:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:uk-day:3' as gate,
  public.load_production_evidence('uk', '2026-03-29T03:00:00.000Z'::timestamptz, '2026-03-30T03:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:manager:uk-day:1' as gate, (
SELECT CASE
    WHEN 'uk'::text IS NULL OR pg_catalog.btrim('uk'::text) = ''
      OR '2026-03-29T03:00:00.000Z'::timestamptz IS NULL OR '2026-03-30T03:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-03-29T03:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-03-30T03:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-03-29T03:00:00.000Z'::timestamptz >= '2026-03-30T03:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'uk'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-03-29T03:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-03-30T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'uk'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-03-29T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'uk'::text
          AND pe.created_at < '2026-03-29T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'uk'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-03-30T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'uk'::text,
        'startUtc', '2026-03-29T03:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-03-30T03:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'uk' and pe.created_at >= '2026-03-29T03:00:00.000Z'::timestamptz and pe.created_at < '2026-03-30T03:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.event_type = 'line_verified' and x.created_at < '2026-03-29T03:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.created_at < '2026-03-29T03:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.event_type = 'cancelled' and x.created_at >= '2026-03-30T03:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'manager' as role, 'uk-day' as scope,
  (public.load_production_evidence('uk', '2026-03-29T03:00:00.000Z'::timestamptz, '2026-03-30T03:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

explain (analyze, buffers) select 'gate:call:manager:uk-3-months:1' as gate,
  public.load_production_evidence('uk', '2026-08-01T03:00:00.000Z'::timestamptz, '2026-11-01T04:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:uk-3-months:2' as gate,
  public.load_production_evidence('uk', '2026-08-01T03:00:00.000Z'::timestamptz, '2026-11-01T04:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:uk-3-months:3' as gate,
  public.load_production_evidence('uk', '2026-08-01T03:00:00.000Z'::timestamptz, '2026-11-01T04:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:manager:uk-3-months:1' as gate, (
SELECT CASE
    WHEN 'uk'::text IS NULL OR pg_catalog.btrim('uk'::text) = ''
      OR '2026-08-01T03:00:00.000Z'::timestamptz IS NULL OR '2026-11-01T04:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-08-01T03:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-01T04:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-08-01T03:00:00.000Z'::timestamptz >= '2026-11-01T04:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'uk'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-08-01T03:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-11-01T04:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'uk'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-08-01T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'uk'::text
          AND pe.created_at < '2026-08-01T03:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'uk'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-11-01T04:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'uk'::text,
        'startUtc', '2026-08-01T03:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-11-01T04:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'uk' and pe.created_at >= '2026-08-01T03:00:00.000Z'::timestamptz and pe.created_at < '2026-11-01T04:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.event_type = 'line_verified' and x.created_at < '2026-08-01T03:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.created_at < '2026-08-01T03:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'uk' and x.event_type = 'cancelled' and x.created_at >= '2026-11-01T04:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'manager' as role, 'uk-3-months' as scope,
  (public.load_production_evidence('uk', '2026-08-01T03:00:00.000Z'::timestamptz, '2026-11-01T04:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

explain (analyze, buffers) select 'gate:call:manager:us-day:1' as gate,
  public.load_production_evidence('us', '2026-03-08T09:00:00.000Z'::timestamptz, '2026-03-09T09:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:us-day:2' as gate,
  public.load_production_evidence('us', '2026-03-08T09:00:00.000Z'::timestamptz, '2026-03-09T09:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:us-day:3' as gate,
  public.load_production_evidence('us', '2026-03-08T09:00:00.000Z'::timestamptz, '2026-03-09T09:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:manager:us-day:1' as gate, (
SELECT CASE
    WHEN 'us'::text IS NULL OR pg_catalog.btrim('us'::text) = ''
      OR '2026-03-08T09:00:00.000Z'::timestamptz IS NULL OR '2026-03-09T09:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-03-08T09:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-03-09T09:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-03-08T09:00:00.000Z'::timestamptz >= '2026-03-09T09:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'us'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-03-08T09:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-03-09T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'us'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-03-08T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'us'::text
          AND pe.created_at < '2026-03-08T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'us'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-03-09T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'us'::text,
        'startUtc', '2026-03-08T09:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-03-09T09:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'us' and pe.created_at >= '2026-03-08T09:00:00.000Z'::timestamptz and pe.created_at < '2026-03-09T09:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'us' and x.event_type = 'line_verified' and x.created_at < '2026-03-08T09:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'us' and x.created_at < '2026-03-08T09:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'us' and x.event_type = 'cancelled' and x.created_at >= '2026-03-09T09:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'manager' as role, 'us-day' as scope,
  (public.load_production_evidence('us', '2026-03-08T09:00:00.000Z'::timestamptz, '2026-03-09T09:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

explain (analyze, buffers) select 'gate:call:manager:us-3-months:1' as gate,
  public.load_production_evidence('us', '2026-08-01T09:00:00.000Z'::timestamptz, '2026-11-01T10:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:us-3-months:2' as gate,
  public.load_production_evidence('us', '2026-08-01T09:00:00.000Z'::timestamptz, '2026-11-01T10:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:call:manager:us-3-months:3' as gate,
  public.load_production_evidence('us', '2026-08-01T09:00:00.000Z'::timestamptz, '2026-11-01T10:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz);

explain (analyze, buffers) select 'gate:body:manager:us-3-months:1' as gate, (
SELECT CASE
    WHEN 'us'::text IS NULL OR pg_catalog.btrim('us'::text) = ''
      OR '2026-08-01T09:00:00.000Z'::timestamptz IS NULL OR '2026-11-01T10:00:00.000Z'::timestamptz IS NULL OR '2026-11-12T00:00:00.000Z'::timestamptz IS NULL
      OR NOT pg_catalog.isfinite('2026-08-01T09:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-01T10:00:00.000Z'::timestamptz)
      OR NOT pg_catalog.isfinite('2026-11-12T00:00:00.000Z'::timestamptz)
      OR '2026-08-01T09:00:00.000Z'::timestamptz >= '2026-11-01T10:00:00.000Z'::timestamptz
    THEN NULL::json
    ELSE (
      WITH win AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'us'::text
          AND pe.event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')
          AND pe.created_at >= '2026-08-01T09:00:00.000Z'::timestamptz
          AND pe.created_at < '2026-11-01T10:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
      ),
      qualification AS (
        SELECT pe.id, pe.location, pe.staff_id, pe.department, pe.order_number, pe.line_sku,
               pe.line_quantity, pe.event_type, pe.created_at, pe.parent_event_id, pe.cs_case_id
        FROM public.production_events pe
        WHERE pe.location = 'us'::text
          AND pe.event_type = 'line_verified'
          AND pe.created_at < '2026-08-01T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'us'::text
          AND pe.created_at < '2026-08-01T09:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        WHERE pe.location = 'us'::text
          AND pe.event_type = 'cancelled'
          AND pe.parent_event_id IS NOT NULL
          AND pe.created_at >= '2026-11-01T10:00:00.000Z'::timestamptz
          AND pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
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
        'site', 'us'::text,
        'startUtc', '2026-08-01T09:00:00.000Z'::timestamptz,
        'endUtcExclusive', '2026-11-01T10:00:00.000Z'::timestamptz,
        'asOfUtc', '2026-11-12T00:00:00.000Z'::timestamptz,
        'complete', true,
        'rowCount', agg.n,
        'rows', COALESCE(agg.rows, '[]'::json)
      )
      FROM agg
    )
  END
) as evidence;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'us' and pe.created_at >= '2026-08-01T09:00:00.000Z'::timestamptz and pe.created_at < '2026-11-01T10:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'us' and x.event_type = 'line_verified' and x.created_at < '2026-08-01T09:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'us' and x.created_at < '2026-08-01T09:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'us' and x.event_type = 'cancelled' and x.created_at >= '2026-11-01T10:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'manager' as role, 'us-3-months' as scope,
  (public.load_production_evidence('us', '2026-08-01T09:00:00.000Z'::timestamptz, '2026-11-01T10:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'staff@inka-staging.test'),
                    'role', 'authenticated')::text, true) as become_staff;
set local role authenticated;

-- independent expectation (EXISTS form, not the function's IN form)
with w as (
  select pe.id, pe.event_type, pe.order_number, pe.parent_event_id from public.production_events pe
  where pe.location = 'au' and pe.created_at >= '2026-09-14T18:00:00.000Z'::timestamptz and pe.created_at < '2026-09-15T18:00:00.000Z'::timestamptz and pe.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz and pe.event_type in ('line_verified', 'completed', 'dispatched', 'cancelled')
), q as (
  select x.id from public.production_events x
  where x.location = 'au' and x.event_type = 'line_verified' and x.created_at < '2026-09-14T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('completed', 'dispatched')
                and coalesce(btrim(w.order_number), '') <> '' and w.order_number = x.order_number)
), p as (
  select x.id from public.production_events x
  where x.location = 'au' and x.created_at < '2026-09-14T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type = 'cancelled' and coalesce(w.parent_event_id, '') <> '' and w.parent_event_id = x.id)
), l as (
  select x.id from public.production_events x
  where x.location = 'au' and x.event_type = 'cancelled' and x.created_at >= '2026-09-15T18:00:00.000Z'::timestamptz and x.created_at <= '2026-11-12T00:00:00.000Z'::timestamptz
    and exists (select 1 from w where w.event_type in ('line_verified', 'completed', 'dispatched') and w.id = x.parent_event_id)
)
select 'staff' as role, 'au-busy-day' as scope,
  (public.load_production_evidence('au', '2026-09-14T18:00:00.000Z'::timestamptz, '2026-09-15T18:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as fn_row_count,
  (select count(*) from w) as window_rows,
  (select count(*) from q) as qualification_rows,
  (select count(*) from p) as parent_rows,
  (select count(*) from l) as later_rows,
  (select count(*) from (select id from w union select id from q union select id from p union select id from l) u) as independent_total;

reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email = 'owner@inka-staging.test'),
                    'role', 'authenticated')::text, true) as become_owner;
set local role authenticated;

-- empty window and invalid input
select (public.load_production_evidence('au', '2020-01-01T13:00:00.000Z'::timestamptz, '2020-01-02T13:00:00.000Z'::timestamptz, '2026-11-12T00:00:00.000Z'::timestamptz) ->> 'rowCount')::bigint as empty_window_row_count,
       public.load_production_evidence('au', '2026-09-15T00:00:00Z', '2026-09-14T00:00:00Z', '2026-11-12T00:00:00.000Z') is null as reversed_window_is_null,
       public.load_production_evidence(' ', '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z', '2026-11-12T00:00:00.000Z') is null as blank_site_is_null,
       public.load_production_evidence('au', 'infinity', '2026-09-15T00:00:00Z', '2026-11-12T00:00:00.000Z') is null as infinite_start_is_null;

rollback;
