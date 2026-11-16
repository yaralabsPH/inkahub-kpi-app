-- 0043_reporting_worker_state.sql
--
-- item-counting amendment, Task 15 (DRAFT, not applied). Append-only:
-- 0037-0041 are unchanged; 0042 stays reserved for an evidence-backed Task 14
-- access-path correction; 0044 is Task 16's reads.
--
-- Durable, fenced worker state so a scheduled invocation can stop at its
-- 240-second budget and the next one resumes WITHOUT re-enumerating the
-- completed part of a batch, and so a seal is backed by an exact, independent
-- proof of completeness:
--
--   worker_progress  one row per batch: enumeration cursor (refresh: the last
--                    changed-key id; rebuild: the last owner keyset), whether
--                    enumeration is complete, and owner/descriptor counters.
--   worker_owners    every discovered owner (order/event partition) with its
--                    old self audiences (base-image staff needing an empty
--                    replacement) and, once planned, its descriptor count.
--   worker_runs      redacted per-invocation log (outcome, counts, failure
--                    kind, duration); 30-day retention.
--
-- Discoveries are saved ATOMICALLY with the cursor advance
-- (save_reporting_enumeration): a crash before the checkpoint replays that
-- bounded unit; an identical replay of an applied checkpoint is a no-op; any
-- other cursor is refused. Planning an owner (plan_reporting_owner) saves its
-- descriptors through the existing plan_reporting_work and marks the owner
-- planned with its exact count in the same transaction. verify_reporting_plan
-- proves, before the existing count/hash seal, that enumeration is complete,
-- every discovered owner is planned, and partition_work holds EXACTLY each
-- owner's declared descriptors (no missing, extra or orphan work).
-- list_reporting_work_descriptors is the bounded saved-descriptor traversal in
-- manifest order, so the worker computes the seal hash without holding the
-- batch in memory.
--
-- Operator/recovery: set_reporting_site_mode (read mode + processor, per site),
-- record_reporting_run, cleanup_reporting_history (superseded generations
-- expire after their seven-day expires_at; closed fact/version rows no
-- retained generation can see; 30-day redacted run log and worker state of
-- finished batches). Cleanup never touches source rows, the change journal,
-- receipts, active/leased/unpublished batches or any retained generation.
--
-- Every function: SECURITY INVOKER, empty search_path, fully qualified,
-- execute granted only to service_role. Every batch mutation goes through
-- reporting_private.lock_batch (control share lock before the site row, fence,
-- live lease, drift). Responses are at most 1,000 rows and 1 MiB (whole JSON
-- row accounting as in 0041). Nothing is classified or counted here.

BEGIN;

CREATE TABLE reporting_private.worker_progress (
  batch_id             uuid        PRIMARY KEY REFERENCES reporting_private.batches (batch_id),
  enum_cursor          jsonb       CHECK (enum_cursor IS NULL OR (pg_catalog.jsonb_typeof(enum_cursor) = 'object' AND pg_catalog.octet_length(enum_cursor::text) <= 8192)),
  enum_complete        boolean     NOT NULL DEFAULT false,
  owners_discovered    integer     NOT NULL DEFAULT 0 CHECK (owners_discovered >= 0),
  owners_planned       integer     NOT NULL DEFAULT 0 CHECK (owners_planned >= 0),
  descriptors_planned  integer     NOT NULL DEFAULT 0 CHECK (descriptors_planned >= 0),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (owners_planned <= owners_discovered),
  CHECK (NOT enum_complete OR enum_cursor IS NOT NULL)
);

CREATE TABLE reporting_private.worker_owners (
  batch_id          uuid        NOT NULL REFERENCES reporting_private.batches (batch_id),
  partition_kind    text        NOT NULL CHECK (partition_kind IN ('order', 'event')),
  partition_key     text        NOT NULL CHECK (partition_key <> ''),
  old_staff         uuid[]      NOT NULL DEFAULT '{}' CHECK (pg_catalog.cardinality(old_staff) <= 1000),
  descriptor_count  integer     CHECK (descriptor_count IS NULL OR (descriptor_count >= 1 AND descriptor_count <= 1000)),
  planned_at        timestamptz,
  PRIMARY KEY (batch_id, partition_kind, partition_key),
  CHECK ((descriptor_count IS NULL) = (planned_at IS NULL))
);
CREATE INDEX worker_owners_keyset ON reporting_private.worker_owners (batch_id, partition_kind COLLATE "C", partition_key COLLATE "C");
CREATE INDEX worker_owners_unplanned ON reporting_private.worker_owners (batch_id, partition_kind COLLATE "C", partition_key COLLATE "C") WHERE planned_at IS NULL;

CREATE TABLE reporting_private.worker_runs (
  run_id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site          text        CHECK (site IS NULL OR site IN ('au', 'uk', 'us')),
  mode          text        NOT NULL CHECK (mode IN ('refresh', 'rebuild', 'cleanup', 'operator')),
  action        text        NOT NULL CHECK (action ~ '^[a-z][a-z-]{0,39}$'),
  outcome       text        NOT NULL CHECK (outcome IN ('published', 'pending', 'busy', 'idle', 'failed', 'done')),
  batch_id      uuid,
  generation_id uuid,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL DEFAULT now(),
  duration_ms   integer     NOT NULL CHECK (duration_ms >= 0),
  counts        jsonb       NOT NULL DEFAULT '{}' CHECK (pg_catalog.jsonb_typeof(counts) = 'object' AND pg_catalog.octet_length(counts::text) <= 4096),
  failure_kind  text        CHECK (failure_kind IS NULL OR (pg_catalog.length(failure_kind) <= 200 AND failure_kind !~ '[\n\r]')),
  CHECK ((outcome = 'failed') = (failure_kind IS NOT NULL))
);
CREATE INDEX worker_runs_site_time ON reporting_private.worker_runs (site, started_at);

ALTER TABLE reporting_private.worker_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.worker_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.worker_runs ENABLE ROW LEVEL SECURITY;

-- The frozen batch a worker-state mutation is for (locked/validated like every batch mutation).
CREATE FUNCTION reporting_private.worker_batch(p_batch uuid, p_fence bigint, p_unsealed boolean)
RETURNS reporting_private.batches
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b reporting_private.batches;
BEGIN
  b := reporting_private.lock_batch(p_batch, p_fence, true);
  IF b.state <> 'frozen' THEN RAISE EXCEPTION 'reporting batch % is %; worker state needs a frozen batch', p_batch, b.state; END IF;
  IF p_unsealed AND b.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'reporting batch % is sealed; enumeration and planning are closed', p_batch; END IF;
  RETURN b;
END
$fn$;

-- One enumeration checkpoint: the owners discovered by a bounded unit, saved
-- with the cursor advance in ONE transaction. p_owners is an array of at most
-- 1,000 [kind, key, [old self staff uuid, ...]] entries (at most 1 MiB).
CREATE FUNCTION public.save_reporting_enumeration(p_batch uuid, p_fence bigint, p_expected_cursor jsonb, p_next_cursor jsonb, p_owners jsonb, p_complete boolean)
RETURNS TABLE (owners_discovered integer, enum_cursor jsonb, enum_complete boolean, replay boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b         reporting_private.batches;
  p         reporting_private.worker_progress;
  v_bad     text;
  v_missing integer;
  v_new     integer;
BEGIN
  b := reporting_private.worker_batch(p_batch, p_fence, true);
  IF p_complete IS NULL THEN RAISE EXCEPTION 'save_reporting_enumeration: p_complete is required'; END IF;
  IF p_next_cursor IS NULL OR pg_catalog.jsonb_typeof(p_next_cursor) <> 'object' OR pg_catalog.octet_length(p_next_cursor::text) > 8192 THEN
    RAISE EXCEPTION 'save_reporting_enumeration: the next cursor must be an object of at most 8 KiB';
  END IF;
  IF p_expected_cursor IS NOT NULL AND pg_catalog.jsonb_typeof(p_expected_cursor) <> 'object' THEN
    RAISE EXCEPTION 'save_reporting_enumeration: the expected cursor must be null or an object';
  END IF;
  IF p_next_cursor IS NOT DISTINCT FROM p_expected_cursor THEN
    RAISE EXCEPTION 'save_reporting_enumeration: a checkpoint must advance the cursor';
  END IF;
  IF p_owners IS NULL OR pg_catalog.jsonb_typeof(p_owners) <> 'array' OR pg_catalog.jsonb_array_length(p_owners) > 1000 OR pg_catalog.octet_length(p_owners::text) > 1048576 THEN
    RAISE EXCEPTION 'save_reporting_enumeration: owners must be an array of at most 1000 entries and 1 MiB';
  END IF;
  SELECT 'owner ' || x.ord || ': ' || x.problem INTO v_bad
    FROM (
      SELECT e.ord, CASE
               WHEN pg_catalog.jsonb_typeof(e.v) <> 'array' OR pg_catalog.jsonb_array_length(e.v) <> 3 THEN 'not a [kind, key, staff] entry'
               WHEN pg_catalog.jsonb_typeof(e.v -> 0) <> 'string' OR e.v ->> 0 NOT IN ('order', 'event') THEN 'bad kind'
               WHEN pg_catalog.jsonb_typeof(e.v -> 1) <> 'string' OR e.v ->> 1 = '' THEN 'bad key'
               WHEN e.v ->> 0 = 'order' AND reporting_private.order_key(e.v ->> 1) IS DISTINCT FROM e.v ->> 1 THEN 'order key is not trimmed'
               WHEN pg_catalog.jsonb_typeof(e.v -> 2) <> 'array' OR pg_catalog.jsonb_array_length(e.v -> 2) > 1000 THEN 'bad staff list'
               WHEN EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(e.v -> 2) s(x)
                             WHERE pg_catalog.jsonb_typeof(s.x) <> 'string' OR (s.x #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN 'bad staff id'
             END AS problem
        FROM pg_catalog.jsonb_array_elements(p_owners) WITH ORDINALITY AS e(v, ord)) x
   WHERE x.problem IS NOT NULL
   ORDER BY x.ord
   LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'save_reporting_enumeration: %', v_bad; END IF;

  INSERT INTO reporting_private.worker_progress (batch_id) VALUES (p_batch) ON CONFLICT (batch_id) DO NOTHING;
  SELECT * INTO p FROM reporting_private.worker_progress w WHERE w.batch_id = p_batch FOR UPDATE;

  -- Identical replay of an applied checkpoint (its response was lost): nothing changes.
  IF p.enum_cursor IS NOT DISTINCT FROM p_next_cursor AND p.enum_complete = p_complete THEN
    SELECT count(*)::integer INTO v_missing
      FROM pg_catalog.jsonb_array_elements(p_owners) e(v)
     WHERE NOT EXISTS (
       SELECT 1 FROM reporting_private.worker_owners o
        WHERE o.batch_id = p_batch AND o.partition_kind = e.v ->> 0 AND o.partition_key = e.v ->> 1
          AND o.old_staff @> ARRAY(SELECT (s.x #>> '{}')::uuid FROM pg_catalog.jsonb_array_elements(e.v -> 2) s(x)));
    IF v_missing > 0 THEN RAISE EXCEPTION 'save_reporting_enumeration: the replayed checkpoint of batch % differs from the saved one', p_batch; END IF;
    RETURN QUERY SELECT p.owners_discovered, p.enum_cursor, p.enum_complete, true;
    RETURN;
  END IF;
  IF p.enum_complete THEN RAISE EXCEPTION 'save_reporting_enumeration: enumeration of batch % is already complete', p_batch; END IF;
  IF p.enum_cursor IS DISTINCT FROM p_expected_cursor THEN
    RAISE EXCEPTION 'save_reporting_enumeration: cursor mismatch for batch % (another worker advanced it, or the caller is stale)', p_batch;
  END IF;

  WITH given AS (
    SELECT e.v ->> 0 AS kind, e.v ->> 1 AS key, (s.x #>> '{}')::uuid AS staff
      FROM pg_catalog.jsonb_array_elements(p_owners) e(v)
      LEFT JOIN LATERAL pg_catalog.jsonb_array_elements(e.v -> 2) s(x) ON true
  ), owners AS (
    SELECT g.kind, g.key, coalesce(array_agg(DISTINCT g.staff ORDER BY g.staff) FILTER (WHERE g.staff IS NOT NULL), '{}'::uuid[]) AS staff
      FROM given g GROUP BY g.kind, g.key
  ), up AS (
    INSERT INTO reporting_private.worker_owners AS w (batch_id, partition_kind, partition_key, old_staff)
    SELECT p_batch, o.kind, o.key, o.staff FROM owners o
    ON CONFLICT (batch_id, partition_kind, partition_key) DO UPDATE
      SET old_staff = ARRAY(SELECT DISTINCT u FROM pg_catalog.unnest(w.old_staff || EXCLUDED.old_staff) u ORDER BY u)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted)::integer INTO v_new FROM up;

  UPDATE reporting_private.worker_progress w
     SET enum_cursor = p_next_cursor, enum_complete = p_complete, owners_discovered = w.owners_discovered + v_new, updated_at = now()
   WHERE w.batch_id = p_batch
   RETURNING * INTO p;
  RETURN QUERY SELECT p.owners_discovered, p.enum_cursor, p.enum_complete, false;
END
$fn$;

-- Where a replacement worker continues (no state yet: nothing done).
CREATE FUNCTION public.read_reporting_worker_progress(p_batch uuid, p_fence bigint)
RETURNS TABLE (enum_cursor jsonb, enum_complete boolean, owners_discovered integer, owners_planned integer, descriptors_planned integer, sealed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b reporting_private.batches;
  p reporting_private.worker_progress;
BEGIN
  b := reporting_private.worker_batch(p_batch, p_fence, false);
  SELECT * INTO p FROM reporting_private.worker_progress w WHERE w.batch_id = p_batch;
  RETURN QUERY SELECT p.enum_cursor, coalesce(p.enum_complete, false), coalesce(p.owners_discovered, 0), coalesce(p.owners_planned, 0), coalesce(p.descriptors_planned, 0), b.sealed_at IS NOT NULL;
END
$fn$;

-- A bounded page of discovered owners in (kind, key) bytewise order, optionally only the unplanned ones.
CREATE FUNCTION public.list_reporting_worker_owners(p_batch uuid, p_fence bigint, p_unplanned_only boolean, p_after_kind text, p_after_key text, p_limit integer DEFAULT 1000)
RETURNS TABLE (partition_kind text, partition_key text, old_staff uuid[], descriptor_count integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 2;
  v_size  bigint;
  v_rows  integer := 0;
BEGIN
  b := reporting_private.worker_batch(p_batch, p_fence, false);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000'; END IF;
  IF p_unplanned_only IS NULL THEN RAISE EXCEPTION 'p_unplanned_only is required'; END IF;
  IF (p_after_kind IS NULL) <> (p_after_key IS NULL) THEN RAISE EXCEPTION 'p_after_kind and p_after_key go together'; END IF;
  FOR r IN
    SELECT w.partition_kind AS kind, w.partition_key AS key, w.old_staff AS staff, w.descriptor_count AS n
      FROM reporting_private.worker_owners w
     WHERE w.batch_id = p_batch
       AND (NOT p_unplanned_only OR w.planned_at IS NULL)
       AND (p_after_kind IS NULL OR (w.partition_kind COLLATE "C", w.partition_key COLLATE "C") > (p_after_kind COLLATE "C", p_after_key COLLATE "C"))
     ORDER BY w.partition_kind COLLATE "C", w.partition_key COLLATE "C"
     LIMIT p_limit
  LOOP
    v_size := pg_catalog.octet_length(pg_catalog.jsonb_build_object('partition_kind', r.kind, 'partition_key', r.key, 'old_staff', r.staff, 'descriptor_count', r.n)::text) + 1;
    IF v_bytes + v_size > 1048576 THEN
      IF v_rows = 0 THEN RAISE EXCEPTION 'one response row (owner %) is larger than 1 MiB', pg_catalog.left(r.key, 64); END IF;
      EXIT;
    END IF;
    v_bytes := v_bytes + v_size;
    v_rows := v_rows + 1;
    partition_kind := r.kind; partition_key := r.key; old_staff := r.staff; descriptor_count := r.n;
    RETURN NEXT;
  END LOOP;
END
$fn$;

-- Plan ONE discovered owner: its descriptors (existing plan_reporting_work
-- checks: shape, conflicts, identical replay) and its planned mark with the
-- exact count, in one transaction. Exactly one site audience; every old self
-- audience must have a descriptor; nothing for another owner.
CREATE FUNCTION public.plan_reporting_owner(p_batch uuid, p_fence bigint, p_kind text, p_key text, p_items jsonb)
RETURNS TABLE (descriptor_count integer, replay boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b       reporting_private.batches;
  w       reporting_private.worker_owners;
  v_n     integer;
  v_saved integer;
  v_bad   text;
BEGIN
  b := reporting_private.worker_batch(p_batch, p_fence, true);
  IF NOT EXISTS (SELECT 1 FROM reporting_private.worker_progress x WHERE x.batch_id = p_batch AND x.enum_complete) THEN
    RAISE EXCEPTION 'plan_reporting_owner: enumeration of batch % is not complete', p_batch;
  END IF;
  SELECT * INTO w FROM reporting_private.worker_owners o WHERE o.batch_id = p_batch AND o.partition_kind = p_kind AND o.partition_key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_reporting_owner: owner %/% was not discovered for batch %', p_kind, pg_catalog.left(p_key, 64), p_batch; END IF;
  IF p_items IS NULL OR pg_catalog.jsonb_typeof(p_items) <> 'array' OR pg_catalog.jsonb_array_length(p_items) < 1 OR pg_catalog.jsonb_array_length(p_items) > 1000 THEN
    RAISE EXCEPTION 'plan_reporting_owner: 1..1000 descriptors are required';
  END IF;
  v_n := pg_catalog.jsonb_array_length(p_items);
  SELECT CASE
           WHEN EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_items) e(v) WHERE pg_catalog.jsonb_typeof(e.v) <> 'object' OR e.v ->> 'partitionKind' IS DISTINCT FROM p_kind OR e.v ->> 'partitionKey' IS DISTINCT FROM p_key) THEN 'a descriptor belongs to another owner'
           WHEN (SELECT count(*) FROM pg_catalog.jsonb_array_elements(p_items) e(v) WHERE e.v ->> 'audienceKind' = 'site') <> 1 THEN 'exactly one site descriptor is required'
           WHEN (SELECT count(DISTINCT coalesce(e.v ->> 'audienceStaff', '')) FROM pg_catalog.jsonb_array_elements(p_items) e(v)) <> v_n THEN 'a duplicate audience'
           WHEN EXISTS (SELECT 1 FROM pg_catalog.unnest(w.old_staff) s(staff)
                         WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_items) e(v) WHERE e.v ->> 'audienceKind' = 'self' AND e.v ->> 'audienceStaff' = s.staff::text)) THEN 'an old self audience has no descriptor'
         END INTO v_bad;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'plan_reporting_owner: %', v_bad; END IF;
  PERFORM 1 FROM public.plan_reporting_work(p_batch, p_fence, p_items);
  SELECT count(*)::integer INTO v_saved FROM reporting_private.partition_work x
   WHERE x.batch_id = p_batch AND x.partition_kind = p_kind AND x.partition_key = p_key;
  IF v_saved <> v_n THEN RAISE EXCEPTION 'plan_reporting_owner: owner %/% has % saved descriptors, % planned', p_kind, pg_catalog.left(p_key, 64), v_saved, v_n; END IF;
  IF w.planned_at IS NOT NULL THEN
    IF w.descriptor_count <> v_n THEN RAISE EXCEPTION 'plan_reporting_owner: owner %/% was planned with % descriptors', p_kind, pg_catalog.left(p_key, 64), w.descriptor_count; END IF;
    RETURN QUERY SELECT v_n, true;
    RETURN;
  END IF;
  UPDATE reporting_private.worker_owners o SET descriptor_count = v_n, planned_at = now()
   WHERE o.batch_id = p_batch AND o.partition_kind = p_kind AND o.partition_key = p_key;
  UPDATE reporting_private.worker_progress x
     SET owners_planned = x.owners_planned + 1, descriptors_planned = x.descriptors_planned + v_n, updated_at = now()
   WHERE x.batch_id = p_batch;
  RETURN QUERY SELECT v_n, false;
END
$fn$;

-- The exact completeness proof the seal needs (may be repeated after sealing).
CREATE FUNCTION public.verify_reporting_plan(p_batch uuid, p_fence bigint)
RETURNS TABLE (owners integer, descriptors integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b       reporting_private.batches;
  p       reporting_private.worker_progress;
  v_n     integer;
  v_owner integer;
  v_work  integer;
BEGIN
  b := reporting_private.worker_batch(p_batch, p_fence, false);
  SELECT * INTO p FROM reporting_private.worker_progress x WHERE x.batch_id = p_batch;
  IF NOT FOUND OR NOT p.enum_complete THEN RAISE EXCEPTION 'verify_reporting_plan: enumeration of batch % is not complete', p_batch; END IF;
  SELECT count(*)::integer, count(*) FILTER (WHERE o.planned_at IS NULL)::integer INTO v_owner, v_n
    FROM reporting_private.worker_owners o WHERE o.batch_id = p_batch;
  IF v_n > 0 THEN RAISE EXCEPTION 'verify_reporting_plan: % discovered owners are not planned', v_n; END IF;
  IF v_owner <> p.owners_discovered OR v_owner <> p.owners_planned THEN
    RAISE EXCEPTION 'verify_reporting_plan: owner counters disagree (% saved, % discovered, % planned)', v_owner, p.owners_discovered, p.owners_planned;
  END IF;
  -- Every saved work row belongs to a discovered owner, and each owner holds exactly its declared count.
  SELECT count(*)::integer INTO v_n
    FROM (SELECT x.partition_kind, x.partition_key, count(*) AS n FROM reporting_private.partition_work x WHERE x.batch_id = p_batch GROUP BY 1, 2) w
    FULL JOIN (SELECT o.partition_kind, o.partition_key, o.descriptor_count FROM reporting_private.worker_owners o WHERE o.batch_id = p_batch) d
      ON d.partition_kind = w.partition_kind AND d.partition_key = w.partition_key
   WHERE w.n IS DISTINCT FROM d.descriptor_count::bigint;
  IF v_n > 0 THEN RAISE EXCEPTION 'verify_reporting_plan: % owners have missing, extra or orphan work', v_n; END IF;
  SELECT count(*)::integer INTO v_work FROM reporting_private.partition_work x WHERE x.batch_id = p_batch;
  IF v_work <> p.descriptors_planned THEN RAISE EXCEPTION 'verify_reporting_plan: % saved descriptors, % planned', v_work, p.descriptors_planned; END IF;
  RETURN QUERY SELECT v_owner, v_work;
END
$fn$;

-- Bounded traversal of the saved descriptors in work_manifest order
-- (audience kind, staff NULL first, partition kind, partition key; bytewise).
-- p_after is null or [audienceKind, audienceStaff or "", partitionKind, partitionKey].
CREATE FUNCTION public.list_reporting_work_descriptors(p_batch uuid, p_fence bigint, p_after jsonb, p_limit integer DEFAULT 1000)
RETURNS TABLE (audience_kind text, audience_staff uuid, partition_kind text, partition_key text, input_hash text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 2;
  v_size  bigint;
  v_rows  integer := 0;
BEGIN
  b := reporting_private.worker_batch(p_batch, p_fence, false);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000'; END IF;
  IF p_after IS NOT NULL AND (pg_catalog.jsonb_typeof(p_after) <> 'array' OR pg_catalog.jsonb_array_length(p_after) <> 4
      OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_after) e(v) WHERE pg_catalog.jsonb_typeof(e.v) <> 'string')) THEN
    RAISE EXCEPTION 'p_after must be null or [audienceKind, audienceStaff or "", partitionKind, partitionKey]';
  END IF;
  FOR r IN
    SELECT w.audience_kind AS ak, w.audience_staff AS st, w.partition_kind AS pk, w.partition_key AS key, w.input_hash AS h
      FROM reporting_private.partition_work w
     WHERE w.batch_id = p_batch
       AND (p_after IS NULL OR (w.audience_kind COLLATE "C", coalesce(w.audience_staff::text, '') COLLATE "C", w.partition_kind COLLATE "C", w.partition_key COLLATE "C")
                             > ((p_after ->> 0) COLLATE "C", (p_after ->> 1) COLLATE "C", (p_after ->> 2) COLLATE "C", (p_after ->> 3) COLLATE "C"))
     ORDER BY w.audience_kind COLLATE "C", coalesce(w.audience_staff::text, '') COLLATE "C", w.partition_kind COLLATE "C", w.partition_key COLLATE "C"
     LIMIT p_limit
  LOOP
    v_size := pg_catalog.octet_length(pg_catalog.jsonb_build_object('audience_kind', r.ak, 'audience_staff', r.st, 'partition_kind', r.pk, 'partition_key', r.key, 'input_hash', r.h)::text) + 1;
    IF v_bytes + v_size > 1048576 THEN
      IF v_rows = 0 THEN RAISE EXCEPTION 'one response row (descriptor %) is larger than 1 MiB', pg_catalog.left(r.key, 64); END IF;
      EXIT;
    END IF;
    v_bytes := v_bytes + v_size;
    v_rows := v_rows + 1;
    audience_kind := r.ak; audience_staff := r.st; partition_kind := r.pk; partition_key := r.key; input_hash := r.h;
    RETURN NEXT;
  END LOOP;
END
$fn$;

-- Operator: one site's read mode and processor switch (CJ action through the
-- protected admin endpoint). summary/shadow need an active generation (0037 CHECK).
CREATE FUNCTION public.set_reporting_site_mode(p_site text, p_read_mode text, p_processor_enabled boolean)
RETURNS TABLE (site text, read_mode text, processor_enabled boolean, active_generation_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  s reporting_private.site_state;
BEGIN
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN RAISE EXCEPTION 'set_reporting_site_mode: unsupported site %', p_site; END IF;
  IF p_read_mode IS NOT NULL AND p_read_mode NOT IN ('legacy', 'shadow', 'summary') THEN RAISE EXCEPTION 'set_reporting_site_mode: read mode must be legacy, shadow or summary'; END IF;
  IF p_read_mode IS NULL AND p_processor_enabled IS NULL THEN RAISE EXCEPTION 'set_reporting_site_mode: nothing to change'; END IF;
  PERFORM 1 FROM reporting_private.control c WHERE c.singleton FOR SHARE;
  SELECT * INTO s FROM reporting_private.site_state x WHERE x.site = p_site FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'site_state row for % is missing', p_site; END IF;
  IF p_read_mode IN ('shadow', 'summary') AND s.active_generation_id IS NULL THEN
    RAISE EXCEPTION 'set_reporting_site_mode: % has no published generation; it can only read legacy', p_site;
  END IF;
  UPDATE reporting_private.site_state x
     SET read_mode = coalesce(p_read_mode, x.read_mode), processor_enabled = coalesce(p_processor_enabled, x.processor_enabled), updated_at = now()
   WHERE x.site = p_site
   RETURNING * INTO s;
  RETURN QUERY SELECT s.site, s.read_mode, s.processor_enabled, s.active_generation_id;
END
$fn$;

-- One redacted invocation record (no payloads, keys or tokens).
CREATE FUNCTION public.record_reporting_run(p_site text, p_mode text, p_action text, p_outcome text, p_batch uuid, p_generation uuid, p_started_at timestamptz, p_duration_ms integer, p_counts jsonb, p_failure_kind text)
RETURNS TABLE (run_id bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_id bigint;
BEGIN
  IF p_counts IS NOT NULL AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p_counts) e(k, v) WHERE pg_catalog.jsonb_typeof(e.v) NOT IN ('number', 'boolean', 'null')) THEN
    RAISE EXCEPTION 'record_reporting_run: counts hold numbers only';
  END IF;
  INSERT INTO reporting_private.worker_runs (site, mode, action, outcome, batch_id, generation_id, started_at, duration_ms, counts, failure_kind)
  VALUES (p_site, p_mode, p_action, p_outcome, p_batch, p_generation, p_started_at, p_duration_ms, coalesce(p_counts, '{}'::jsonb), p_failure_kind)
  RETURNING worker_runs.run_id INTO v_id;
  RETURN QUERY SELECT v_id;
END
$fn$;

-- Bounded retention pass for one site (repeat while more = true):
--  * superseded generations past expires_at (seven days) become expired (reads then return 410);
--  * closed fact/version rows that NO retained (published or superseded) generation of the site can see;
--  * the 30-day redacted run log and worker state of finished (published/abandoned/failed) batches.
-- The site row is locked briefly so cleanup never interleaves with a publication. Never touched:
-- source rows, the change journal and receipts, batches, work/results, current or retained versions.
CREATE FUNCTION public.cleanup_reporting_history(p_site text, p_limit integer DEFAULT 5000)
RETURNS TABLE (expired_generations integer, deleted_versions bigint, deleted_runs integer, deleted_worker_rows integer, more boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_min     bigint;
  v_exp     integer;
  v_n       bigint;
  v_del     bigint := 0;
  v_runs    integer;
  v_owners  integer;
  v_prog    integer;
  v_more    boolean := false;
BEGIN
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN RAISE EXCEPTION 'cleanup_reporting_history: unsupported site %', p_site; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN RAISE EXCEPTION 'cleanup_reporting_history: p_limit must be 1..10000'; END IF;
  PERFORM 1 FROM reporting_private.control c WHERE c.singleton FOR SHARE;
  PERFORM 1 FROM reporting_private.site_state s WHERE s.site = p_site FOR UPDATE;

  WITH x AS (
    UPDATE reporting_private.generations g SET state = 'expired'
     WHERE g.site = p_site AND g.state = 'superseded' AND g.expires_at <= now()
    RETURNING 1)
  SELECT count(*)::integer INTO v_exp FROM x;

  SELECT min(g.generation_seq) INTO v_min FROM reporting_private.generations g WHERE g.site = p_site AND g.state IN ('published', 'superseded');
  IF v_min IS NOT NULL THEN
    DELETE FROM reporting_private.event_facts t WHERE t.ctid IN (SELECT y.ctid FROM reporting_private.event_facts y WHERE y.site = p_site AND y.valid_to_seq IS NOT NULL AND y.valid_to_seq <= v_min LIMIT p_limit);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_more := v_more OR v_n >= p_limit;
    DELETE FROM reporting_private.cancel_edges t WHERE t.ctid IN (SELECT y.ctid FROM reporting_private.cancel_edges y WHERE y.site = p_site AND y.valid_to_seq IS NOT NULL AND y.valid_to_seq <= v_min LIMIT p_limit);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_more := v_more OR v_n >= p_limit;
    DELETE FROM reporting_private.order_occurrences t WHERE t.ctid IN (SELECT y.ctid FROM reporting_private.order_occurrences y WHERE y.site = p_site AND y.valid_to_seq IS NOT NULL AND y.valid_to_seq <= v_min LIMIT p_limit);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_more := v_more OR v_n >= p_limit;
    DELETE FROM reporting_private.daily_totals t WHERE t.ctid IN (SELECT y.ctid FROM reporting_private.daily_totals y WHERE y.site = p_site AND y.valid_to_seq IS NOT NULL AND y.valid_to_seq <= v_min LIMIT p_limit);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_more := v_more OR v_n >= p_limit;
    DELETE FROM reporting_private.timing_facts t WHERE t.ctid IN (SELECT y.ctid FROM reporting_private.timing_facts y WHERE y.site = p_site AND y.valid_to_seq IS NOT NULL AND y.valid_to_seq <= v_min LIMIT p_limit);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_more := v_more OR v_n >= p_limit;
    DELETE FROM reporting_private.source_issue_facts t WHERE t.ctid IN (SELECT y.ctid FROM reporting_private.source_issue_facts y WHERE y.site = p_site AND y.valid_to_seq IS NOT NULL AND y.valid_to_seq <= v_min LIMIT p_limit);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_more := v_more OR v_n >= p_limit;
    DELETE FROM reporting_private.source_versions t WHERE t.ctid IN (SELECT y.ctid FROM reporting_private.source_versions y WHERE y.site = p_site AND y.valid_to_seq IS NOT NULL AND y.valid_to_seq <= v_min LIMIT p_limit);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_more := v_more OR v_n >= p_limit;
  END IF;

  DELETE FROM reporting_private.worker_runs t WHERE t.ctid IN (SELECT y.ctid FROM reporting_private.worker_runs y WHERE y.site = p_site AND y.started_at < now() - interval '30 days' LIMIT p_limit);
  GET DIAGNOSTICS v_runs = ROW_COUNT; v_more := v_more OR v_runs >= p_limit;
  DELETE FROM reporting_private.worker_owners t WHERE t.ctid IN (
    SELECT y.ctid FROM reporting_private.worker_owners y JOIN reporting_private.batches b ON b.batch_id = y.batch_id
     WHERE b.site = p_site AND b.state IN ('published', 'abandoned', 'failed') AND b.updated_at < now() - interval '30 days' LIMIT p_limit);
  GET DIAGNOSTICS v_owners = ROW_COUNT; v_more := v_more OR v_owners >= p_limit;
  DELETE FROM reporting_private.worker_progress t WHERE t.ctid IN (
    SELECT y.ctid FROM reporting_private.worker_progress y JOIN reporting_private.batches b ON b.batch_id = y.batch_id
     WHERE b.site = p_site AND b.state IN ('published', 'abandoned', 'failed') AND b.updated_at < now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM reporting_private.worker_owners o WHERE o.batch_id = y.batch_id) LIMIT p_limit);
  GET DIAGNOSTICS v_prog = ROW_COUNT; v_more := v_more OR v_prog >= p_limit;
  RETURN QUERY SELECT v_exp, v_del, v_runs, v_owners + v_prog, v_more;
END
$fn$;

REVOKE ALL ON TABLE reporting_private.worker_progress FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE reporting_private.worker_owners FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE reporting_private.worker_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reporting_private.worker_progress TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reporting_private.worker_owners TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reporting_private.worker_runs TO service_role;

REVOKE ALL ON FUNCTION reporting_private.worker_batch(uuid, bigint, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.worker_batch(uuid, bigint, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.save_reporting_enumeration(uuid, bigint, jsonb, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_reporting_worker_progress(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_reporting_worker_owners(uuid, bigint, boolean, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plan_reporting_owner(uuid, bigint, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_reporting_plan(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_reporting_work_descriptors(uuid, bigint, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_reporting_site_mode(text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_reporting_run(text, text, text, text, uuid, uuid, timestamptz, integer, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_reporting_history(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_reporting_enumeration(uuid, bigint, jsonb, jsonb, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_reporting_worker_progress(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_reporting_worker_owners(uuid, bigint, boolean, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.plan_reporting_owner(uuid, bigint, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_reporting_plan(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_reporting_work_descriptors(uuid, bigint, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_reporting_site_mode(text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_reporting_run(text, text, text, text, uuid, uuid, timestamptz, integer, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_reporting_history(text, integer) TO service_role;

COMMIT;
