-- F5 departments: cost of the department lookup on each event insert.
--
-- STAGING ONLY. One transaction, ends with ROLLBACK: nothing is kept.
--
-- It builds synthetic history, then times event inserts twice:
--   A. with all three F5 triggers (the normal state)
--   B. with only the resolver trigger disabled (the emergency state)
-- and reports p50 / p95 per insert for both and the difference. The target is
-- an added p95 under 20 ms. It also prints the query plan of the lookup.
--
-- SIZE: set the three numbers in the first DO block.
--   Default (quick, safe in a shared window): 20 people x 500 intervals = 10,000
--   assignment rows and 1,000 timed inserts.
--   Release evidence: 100 people x 1,000 intervals = 100,000 rows. That larger
--   run, and "two years / three sites" of events, are NOT done by the default
--   and stay PENDING until someone runs and records them.
--
-- While it runs it holds locks other staging sessions may wait on (it toggles
-- one trigger on production_events inside the transaction). Run it alone, in
-- the reserved window. Timings on the shared staging project are indicative.

BEGIN;

CREATE TEMP TABLE f5p_config (people int, intervals int, inserts int) ON COMMIT DROP;
CREATE TEMP TABLE f5p_times (phase text, ms double precision) ON COMMIT DROP;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE key = 'staging') THEN
    RAISE EXCEPTION 'F5 performance: no location "staging" in this database. Refusing to run: staging only.';
  END IF;
  --                              people, intervals per person, timed inserts per phase
  INSERT INTO f5p_config VALUES (20,     500,                  1000);
END $$;

-- Synthetic history: each person alternates between two departments every
-- hour, going back <intervals> hours. Written directly by the operator
-- (owners cannot backdate; this is test set-up only).
DO $$
DECLARE
  c        f5p_config;
  v_now    timestamptz := date_trunc('second', clock_timestamp());
  v_owner  uuid := 'f5730000-0000-4000-8000-0000000000f1';
  v_a      uuid := gen_random_uuid();
  v_b      uuid := gen_random_uuid();
  v_start  timestamptz;
BEGIN
  SELECT * INTO c FROM f5p_config;
  v_start := v_now - make_interval(hours => c.intervals + 24);

  INSERT INTO auth.users (id, email)
  SELECT ('f5730000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'f5p-' || g || '@inka-staging.test'
    FROM generate_series(1, c.people) g;

  INSERT INTO public.business_departments (id, name, normalized_name, created_at, updated_at, created_by, updated_by)
  VALUES (v_a, 'F5P Department A', 'f5p department a', v_start, v_start, v_owner, v_owner),
         (v_b, 'F5P Department B', 'f5p department b', v_start, v_start, v_owner, v_owner);
  -- One name change per interval too, so the name lookup has the same depth.
  INSERT INTO public.business_department_names (department_id, name, valid_from, valid_to, created_at, created_by, request_id)
  SELECT d.id, d.label || ' v' || g,
         v_start + make_interval(hours => g - 1),
         CASE WHEN g = c.intervals + 24 THEN NULL ELSE v_start + make_interval(hours => g) END,
         v_start, v_owner, gen_random_uuid()
    FROM (VALUES (v_a, 'F5P Department A'), (v_b, 'F5P Department B')) AS d(id, label),
         generate_series(1, c.intervals + 24) g;

  INSERT INTO public.person_department_assignments (person_id, department_id, valid_from, valid_to, created_at, created_by, request_id)
  SELECT ('f5730000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid,
         CASE WHEN g % 2 = 0 THEN v_a ELSE v_b END,
         v_now - make_interval(hours => c.intervals - g + 1),
         CASE WHEN g = c.intervals THEN NULL ELSE v_now - make_interval(hours => c.intervals - g) END,
         v_start, v_owner, gen_random_uuid()
    FROM generate_series(1, c.people) p, generate_series(1, c.intervals) g;

  -- Tracking must start before the synthetic history, and snapshots must be on.
  BEGIN
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.department_snapshot_control SET tracking_started_at = v_start - interval '1 day', enabled = true;
    PERFORM set_config('session_replication_role', 'origin', true);
  EXCEPTION WHEN OTHERS THEN
    ALTER TABLE public.department_snapshot_control DISABLE TRIGGER department_snapshot_control_guard;
    UPDATE public.department_snapshot_control SET tracking_started_at = v_start - interval '1 day', enabled = true;
    ALTER TABLE public.department_snapshot_control ENABLE TRIGGER department_snapshot_control_guard;
  END;

  ANALYZE public.person_department_assignments;
  ANALYZE public.business_department_names;

  RAISE NOTICE 'F5 performance: % people x % intervals = % assignment rows, % name rows',
    c.people, c.intervals, c.people * c.intervals, 2 * (c.intervals + 24);
END $$;

-- One timed batch of inserts at random people and random instants in the history.
CREATE FUNCTION pg_temp.f5p_batch(p_phase text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  c      f5p_config;
  v_t0   timestamptz;
  v_now  timestamptz := clock_timestamp();
  i      int;
BEGIN
  SELECT * INTO c FROM f5p_config;
  FOR i IN 1 .. c.inserts LOOP
    v_t0 := clock_timestamp();
    INSERT INTO public.production_events (location, id, staff_id, department, order_number, event_type, note, created_at)
    VALUES ('staging', 'f5p-' || p_phase || '-' || i,
            ('f5730000-0000-4000-8000-' || lpad((1 + (i % c.people))::text, 12, '0'))::uuid,
            'dispatch', 'F5P-1', 'completed', 'f5 performance',
            v_now - make_interval(secs => (i * 7919) % (c.intervals * 3600)));
    INSERT INTO f5p_times VALUES (p_phase, extract(epoch FROM clock_timestamp() - v_t0) * 1000);
  END LOOP;
END $$;

-- Warm-up (not reported), then phase A: all F5 triggers.
SELECT pg_temp.f5p_batch('warmup');
SELECT pg_temp.f5p_batch('with_resolver');

-- Phase B: resolver disabled only (sanitize and freeze stay on).
ALTER TABLE public.production_events DISABLE TRIGGER production_events_f5_20_resolve;
SELECT pg_temp.f5p_batch('without_resolver');
ALTER TABLE public.production_events ENABLE TRIGGER production_events_f5_20_resolve;

-- Every timed insert with the resolver on must have been attributed.
DO $$
DECLARE
  v_bad int;
  v_all int;
BEGIN
  SELECT count(*) FILTER (WHERE business_department_status <> 'assigned'), count(*) INTO v_bad, v_all
    FROM public.production_events WHERE location = 'staging' AND id LIKE 'f5p-with_resolver-%';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'F5 performance FAILED: % of % timed inserts were not "assigned"', v_bad, v_all;
  END IF;
END $$;

-- The lookup's plan for one person at one past instant (must use the
-- person index, not scan the table).
EXPLAIN (ANALYZE, BUFFERS)
SELECT a.id, a.department_id, d.archived_at, n.id, n.name
  FROM public.person_department_assignments a
  LEFT JOIN public.business_departments d ON d.id = a.department_id
  LEFT JOIN public.business_department_names n
         ON n.department_id = a.department_id
        AND n.valid_from <= now() - interval '100 hours'
        AND (n.valid_to IS NULL OR now() - interval '100 hours' < n.valid_to)
 WHERE a.person_id = 'f5730000-0000-4000-8000-000000000001'
   AND a.valid_from <= now() - interval '100 hours'
   AND (a.valid_to IS NULL OR now() - interval '100 hours' < a.valid_to)
 LIMIT 2;

-- Result. "added" = with resolver minus without.
WITH s AS (
  SELECT phase, count(*) AS inserts,
         percentile_cont(0.5)  WITHIN GROUP (ORDER BY ms) AS p50_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95_ms,
         max(ms) AS max_ms
    FROM f5p_times WHERE phase <> 'warmup' GROUP BY phase
)
SELECT (SELECT people * intervals FROM f5p_config) AS assignment_rows,
       w.inserts,
       round(w.p50_ms::numeric, 3) AS p50_with_ms,    round(o.p50_ms::numeric, 3) AS p50_without_ms,
       round(w.p95_ms::numeric, 3) AS p95_with_ms,    round(o.p95_ms::numeric, 3) AS p95_without_ms,
       round((w.p95_ms - o.p95_ms)::numeric, 3) AS p95_added_ms,
       CASE WHEN w.p95_ms - o.p95_ms < 20 THEN 'within the 20 ms target' ELSE 'TARGET MISSED' END AS verdict
  FROM s w, s o
 WHERE w.phase = 'with_resolver' AND o.phase = 'without_resolver';

ROLLBACK;
