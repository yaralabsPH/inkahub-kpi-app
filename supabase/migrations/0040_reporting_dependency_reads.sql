-- 0040_reporting_dependency_reads.sql
--
-- item-counting amendment, Task 14 (DRAFT, not applied). Bounded, read-only,
-- service-only reads of ONE frozen batch view for the TypeScript materializer
-- (api/_lib/production-reporting-materialize.ts):
--   refresh: the base mirror (source_current) overlaid with the batch's frozen
--            images/tombstones (batch_events)
--   rebuild: the frozen candidate (source_candidate)
-- Installed 0037/0038/0039 are unchanged. Nothing here counts, classifies,
-- selects ranges or writes data: every function only validates the batch
-- (control-before-site locks, fence, lease, drift, FROZEN state) and returns
-- bounded pages: at most 1,000 rows and 1 MiB of images per call, keyset
-- ordered (bytewise, COLLATE "C"), never OFFSET, never a full-history response.
-- An oversized single image fails visibly. Timeouts are not changed.
--
-- New indexes are on reporting objects only: a worker's stream keyset on the
-- base mirror and on the candidate, and bytewise owner keysets on the candidate.

BEGIN;

CREATE INDEX source_current_staff_time ON reporting_private.source_current (site, staff_id, event_created_at, event_id COLLATE "C");
CREATE INDEX source_candidate_staff_time ON reporting_private.source_candidate (batch_id, site, staff_id, event_created_at, event_id COLLATE "C");
CREATE INDEX source_candidate_owner_order ON reporting_private.source_candidate (batch_id, site, order_key COLLATE "C");
CREATE INDEX source_candidate_owner_event ON reporting_private.source_candidate (batch_id, site, event_id COLLATE "C") WHERE coalesce(order_key, '') = '';

-- The batch every read is for: locked/validated like every batch mutation, and FROZEN.
CREATE FUNCTION reporting_private.frozen_read_batch(p_batch uuid, p_fence bigint)
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
  IF b.state <> 'frozen' OR b.source_cutoff IS NULL THEN
    RAISE EXCEPTION 'reporting batch % is %; dependency reads need a frozen batch', p_batch, b.state;
  END IF;
  RETURN b;
END
$fn$;

-- Refresh: every changed or due key with its base image and its frozen image (NULL = tombstone).
CREATE FUNCTION public.read_reporting_changed_keys(p_batch uuid, p_fence bigint, p_after_event_id text, p_limit integer DEFAULT 1000)
RETURNS TABLE (event_id text, before_image jsonb, after_image jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 0;
  v_size  bigint;
BEGIN
  b := reporting_private.frozen_read_batch(p_batch, p_fence);
  IF b.kind <> 'refresh' THEN RAISE EXCEPTION 'read_reporting_changed_keys is a refresh read'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000'; END IF;
  FOR r IN
    SELECT be.event_id, sc.image AS before_image, be.image AS after_image
      FROM reporting_private.batch_events be
      LEFT JOIN reporting_private.source_current sc ON sc.site = b.site AND sc.event_id = be.event_id
     WHERE be.batch_id = b.batch_id AND be.site = b.site
       AND (p_after_event_id IS NULL OR be.event_id COLLATE "C" > p_after_event_id COLLATE "C")
     ORDER BY be.event_id COLLATE "C"
     LIMIT p_limit
  LOOP
    v_size := coalesce(pg_catalog.octet_length(r.before_image::text), 0) + coalesce(pg_catalog.octet_length(r.after_image::text), 0);
    IF v_size > 1048576 THEN RAISE EXCEPTION 'changed key % is larger than 1 MiB', r.event_id; END IF;
    v_bytes := v_bytes + v_size;
    EXIT WHEN v_bytes > 1048576;
    event_id := r.event_id; before_image := r.before_image; after_image := r.after_image;
    RETURN NEXT;
  END LOOP;
END
$fn$;

-- Rebuild: every owner partition of the frozen candidate ('event' owners (blank order) first, then 'order').
CREATE FUNCTION public.list_reporting_owners(p_batch uuid, p_fence bigint, p_after_kind text, p_after_key text, p_limit integer DEFAULT 1000)
RETURNS TABLE (partition_kind text, partition_key text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b     reporting_private.batches;
  v_n   integer := 0;
  v_got integer;
BEGIN
  b := reporting_private.frozen_read_batch(p_batch, p_fence);
  IF b.kind <> 'rebuild' THEN RAISE EXCEPTION 'list_reporting_owners is a rebuild read'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000'; END IF;
  IF p_after_kind IS NOT NULL AND p_after_kind NOT IN ('event', 'order') THEN RAISE EXCEPTION 'p_after_kind must be event or order'; END IF;
  IF p_after_kind IS NULL OR p_after_kind = 'event' THEN
    RETURN QUERY
      SELECT 'event'::text, sc.event_id
        FROM reporting_private.source_candidate sc
       WHERE sc.batch_id = b.batch_id AND sc.site = b.site AND coalesce(sc.order_key, '') = ''
         AND (p_after_kind IS NULL OR sc.event_id COLLATE "C" > p_after_key COLLATE "C")
       ORDER BY sc.event_id COLLATE "C"
       LIMIT p_limit;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    v_n := v_got;
    IF v_n >= p_limit THEN RETURN; END IF;
  END IF;
  RETURN QUERY
    SELECT DISTINCT 'order'::text, sc.order_key COLLATE "C"
      FROM reporting_private.source_candidate sc
     WHERE sc.batch_id = b.batch_id AND sc.site = b.site AND coalesce(sc.order_key, '') <> ''
       AND (p_after_kind IS DISTINCT FROM 'order' OR sc.order_key COLLATE "C" > p_after_key COLLATE "C")
     ORDER BY 2
     LIMIT p_limit - v_n;
END
$fn$;

-- Members of up to 100 owners ([kind, key] pairs), keyset (owner index, event id).
CREATE FUNCTION public.read_reporting_owner_members(p_batch uuid, p_fence bigint, p_owners jsonb, p_after_index integer, p_after_event_id text, p_limit integer DEFAULT 1000)
RETURNS TABLE (owner_index integer, event_id text, image jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 0;
  v_size  bigint;
BEGIN
  b := reporting_private.frozen_read_batch(p_batch, p_fence);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000'; END IF;
  IF pg_catalog.jsonb_typeof(p_owners) <> 'array' OR pg_catalog.jsonb_array_length(p_owners) < 1 OR pg_catalog.jsonb_array_length(p_owners) > 100 THEN
    RAISE EXCEPTION 'p_owners must be an array of 1..100 [kind, key] owners';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_owners) o(v)
              WHERE pg_catalog.jsonb_typeof(o.v) <> 'array' OR pg_catalog.jsonb_array_length(o.v) <> 2
                 OR (o.v ->> 0) NOT IN ('order', 'event') OR coalesce(o.v ->> 1, '') = '') THEN
    RAISE EXCEPTION 'every owner must be [order|event, nonblank key]';
  END IF;
  FOR r IN
    WITH o AS (
      SELECT (x.ord - 1)::integer AS idx, x.v ->> 0 AS kind, x.v ->> 1 AS key
        FROM pg_catalog.jsonb_array_elements(p_owners) WITH ORDINALITY AS x(v, ord)
    ), m AS (
      -- frozen images of the batch (refresh) that belong to an owner
      SELECT o.idx, be.event_id, be.image
        FROM o JOIN reporting_private.batch_events be ON be.batch_id = b.batch_id AND be.site = b.site AND be.image IS NOT NULL
       CROSS JOIN LATERAL reporting_private.owner_partition(be.image) op
       WHERE b.kind = 'refresh' AND op.partition_kind = o.kind AND op.partition_key = o.key
      UNION ALL
      -- base mirror rows not superseded by the batch (refresh)
      SELECT o.idx, s.event_id, s.image
        FROM o JOIN reporting_private.source_current s
          ON s.site = b.site
         AND ((o.kind = 'order' AND s.order_key = o.key) OR (o.kind = 'event' AND s.event_id = o.key AND coalesce(s.order_key, '') = ''))
       WHERE b.kind = 'refresh'
         AND NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = b.batch_id AND be.site = b.site AND be.event_id = s.event_id)
      UNION ALL
      -- the frozen candidate (rebuild)
      SELECT o.idx, sc.event_id, sc.image
        FROM o JOIN reporting_private.source_candidate sc
          ON sc.batch_id = b.batch_id AND sc.site = b.site
         AND ((o.kind = 'order' AND sc.order_key = o.key) OR (o.kind = 'event' AND sc.event_id = o.key AND coalesce(sc.order_key, '') = ''))
       WHERE b.kind = 'rebuild'
    )
    SELECT m.idx, m.event_id, m.image FROM m
     WHERE p_after_index IS NULL OR m.idx > p_after_index OR (m.idx = p_after_index AND m.event_id COLLATE "C" > p_after_event_id COLLATE "C")
     ORDER BY m.idx, m.event_id COLLATE "C"
     LIMIT p_limit
  LOOP
    v_size := pg_catalog.octet_length(r.image::text);
    IF v_size > 1048576 THEN RAISE EXCEPTION 'source event % is larger than 1 MiB', r.event_id; END IF;
    v_bytes := v_bytes + v_size;
    EXIT WHEN v_bytes > 1048576;
    owner_index := r.idx; event_id := r.event_id; image := r.image;
    RETURN NEXT;
  END LOOP;
END
$fn$;

-- Frozen images of up to 1,000 event ids (absent ids return no row), keyset by event id.
CREATE FUNCTION public.read_reporting_events_by_id(p_batch uuid, p_fence bigint, p_ids text[])
RETURNS TABLE (event_id text, image jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 0;
  v_size  bigint;
BEGIN
  b := reporting_private.frozen_read_batch(p_batch, p_fence);
  IF p_ids IS NULL OR pg_catalog.cardinality(p_ids) < 1 OR pg_catalog.cardinality(p_ids) > 1000 THEN RAISE EXCEPTION 'p_ids must hold 1..1000 ids'; END IF;
  FOR r IN
    WITH ids AS (SELECT DISTINCT i AS id FROM pg_catalog.unnest(p_ids) AS u(i) WHERE i IS NOT NULL), m AS (
      SELECT be.event_id, be.image FROM ids JOIN reporting_private.batch_events be ON be.batch_id = b.batch_id AND be.site = b.site AND be.event_id = ids.id
       WHERE b.kind = 'refresh' AND be.image IS NOT NULL
      UNION ALL
      SELECT s.event_id, s.image FROM ids JOIN reporting_private.source_current s ON s.site = b.site AND s.event_id = ids.id
       WHERE b.kind = 'refresh'
         AND NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = b.batch_id AND be.site = b.site AND be.event_id = s.event_id)
      UNION ALL
      SELECT sc.event_id, sc.image FROM ids JOIN reporting_private.source_candidate sc ON sc.batch_id = b.batch_id AND sc.site = b.site AND sc.event_id = ids.id
       WHERE b.kind = 'rebuild'
    )
    SELECT m.event_id, m.image FROM m ORDER BY m.event_id COLLATE "C"
  LOOP
    v_size := pg_catalog.octet_length(r.image::text);
    IF v_size > 1048576 THEN RAISE EXCEPTION 'source event % is larger than 1 MiB', r.event_id; END IF;
    v_bytes := v_bytes + v_size;
    EXIT WHEN v_bytes > 1048576;
    event_id := r.event_id; image := r.image;
    RETURN NEXT;
  END LOOP;
END
$fn$;

-- Inverse children: frozen events whose parent_event_id is one of up to 1,000 ids, keyset (parent id, event id).
CREATE FUNCTION public.read_reporting_children(p_batch uuid, p_fence bigint, p_parent_ids text[], p_after_parent_id text, p_after_event_id text, p_limit integer DEFAULT 1000)
RETURNS TABLE (parent_event_id text, event_id text, image jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 0;
  v_size  bigint;
BEGIN
  b := reporting_private.frozen_read_batch(p_batch, p_fence);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000'; END IF;
  IF p_parent_ids IS NULL OR pg_catalog.cardinality(p_parent_ids) < 1 OR pg_catalog.cardinality(p_parent_ids) > 1000 THEN RAISE EXCEPTION 'p_parent_ids must hold 1..1000 ids'; END IF;
  FOR r IN
    WITH m AS (
      SELECT be.image ->> 'parent_event_id' AS parent_id, be.event_id, be.image
        FROM reporting_private.batch_events be
       WHERE b.kind = 'refresh' AND be.batch_id = b.batch_id AND be.site = b.site AND be.image IS NOT NULL
         AND (be.image ->> 'parent_event_id') = ANY (p_parent_ids)
      UNION ALL
      SELECT s.parent_event_id, s.event_id, s.image
        FROM reporting_private.source_current s
       WHERE b.kind = 'refresh' AND s.site = b.site AND s.parent_event_id = ANY (p_parent_ids)
         AND NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = b.batch_id AND be.site = b.site AND be.event_id = s.event_id)
      UNION ALL
      SELECT sc.parent_event_id, sc.event_id, sc.image
        FROM reporting_private.source_candidate sc
       WHERE b.kind = 'rebuild' AND sc.batch_id = b.batch_id AND sc.site = b.site AND sc.parent_event_id = ANY (p_parent_ids)
    )
    SELECT m.parent_id, m.event_id, m.image FROM m
     WHERE p_after_parent_id IS NULL
        OR m.parent_id COLLATE "C" > p_after_parent_id COLLATE "C"
        OR (m.parent_id = p_after_parent_id AND m.event_id COLLATE "C" > p_after_event_id COLLATE "C")
     ORDER BY m.parent_id COLLATE "C", m.event_id COLLATE "C"
     LIMIT p_limit
  LOOP
    v_size := pg_catalog.octet_length(r.image::text);
    IF v_size > 1048576 THEN RAISE EXCEPTION 'source event % is larger than 1 MiB', r.event_id; END IF;
    v_bytes := v_bytes + v_size;
    EXIT WHEN v_bytes > 1048576;
    parent_event_id := r.parent_id; event_id := r.event_id; image := r.image;
    RETURN NEXT;
  END LOOP;
END
$fn$;

-- One page of a worker's frozen events strictly before/after (time, event id), ordered away from it.
CREATE FUNCTION public.read_reporting_staff_stream(p_batch uuid, p_fence bigint, p_staff uuid, p_direction text, p_at timestamptz, p_at_event_id text, p_limit integer DEFAULT 200)
RETURNS TABLE (event_id text, image jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 0;
  v_size  bigint;
BEGIN
  b := reporting_private.frozen_read_batch(p_batch, p_fence);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000'; END IF;
  IF p_staff IS NULL OR p_at IS NULL OR p_at_event_id IS NULL THEN RAISE EXCEPTION 'p_staff, p_at and p_at_event_id are required'; END IF;
  IF p_direction NOT IN ('before', 'after') THEN RAISE EXCEPTION 'p_direction must be before or after'; END IF;
  FOR r IN
    WITH m AS (
      SELECT be.event_id, be.image, (be.image ->> 'created_at')::timestamptz AS at
        FROM reporting_private.batch_events be
       WHERE b.kind = 'refresh' AND be.batch_id = b.batch_id AND be.site = b.site AND be.image IS NOT NULL
         AND (be.image ->> 'staff_id') = p_staff::text
      UNION ALL
      SELECT s.event_id, s.image, s.event_created_at
        FROM reporting_private.source_current s
       WHERE b.kind = 'refresh' AND s.site = b.site AND s.staff_id = p_staff
         AND ((p_direction = 'before' AND (s.event_created_at, s.event_id COLLATE "C") < (p_at, p_at_event_id COLLATE "C"))
           OR (p_direction = 'after' AND (s.event_created_at, s.event_id COLLATE "C") > (p_at, p_at_event_id COLLATE "C")))
         AND NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = b.batch_id AND be.site = b.site AND be.event_id = s.event_id)
      UNION ALL
      SELECT sc.event_id, sc.image, sc.event_created_at
        FROM reporting_private.source_candidate sc
       WHERE b.kind = 'rebuild' AND sc.batch_id = b.batch_id AND sc.site = b.site AND sc.staff_id = p_staff
         AND ((p_direction = 'before' AND (sc.event_created_at, sc.event_id COLLATE "C") < (p_at, p_at_event_id COLLATE "C"))
           OR (p_direction = 'after' AND (sc.event_created_at, sc.event_id COLLATE "C") > (p_at, p_at_event_id COLLATE "C")))
    )
    SELECT m.event_id, m.image FROM m
     WHERE (p_direction = 'before' AND (m.at, m.event_id COLLATE "C") < (p_at, p_at_event_id COLLATE "C"))
        OR (p_direction = 'after' AND (m.at, m.event_id COLLATE "C") > (p_at, p_at_event_id COLLATE "C"))
     ORDER BY CASE WHEN p_direction = 'after' THEN m.at END ASC, CASE WHEN p_direction = 'after' THEN m.event_id END COLLATE "C" ASC,
              CASE WHEN p_direction = 'before' THEN m.at END DESC, CASE WHEN p_direction = 'before' THEN m.event_id END COLLATE "C" DESC
     LIMIT p_limit
  LOOP
    v_size := pg_catalog.octet_length(r.image::text);
    IF v_size > 1048576 THEN RAISE EXCEPTION 'source event % is larger than 1 MiB', r.event_id; END IF;
    v_bytes := v_bytes + v_size;
    EXIT WHEN v_bytes > 1048576;
    event_id := r.event_id; image := r.image;
    RETURN NEXT;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION reporting_private.frozen_read_batch(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.frozen_read_batch(uuid, bigint) TO service_role;
REVOKE ALL ON FUNCTION public.read_reporting_changed_keys(uuid, bigint, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_reporting_owners(uuid, bigint, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_reporting_owner_members(uuid, bigint, jsonb, integer, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_reporting_events_by_id(uuid, bigint, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_reporting_children(uuid, bigint, text[], text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_reporting_staff_stream(uuid, bigint, uuid, text, timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_reporting_changed_keys(uuid, bigint, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_reporting_owners(uuid, bigint, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_reporting_owner_members(uuid, bigint, jsonb, integer, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_reporting_events_by_id(uuid, bigint, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_reporting_children(uuid, bigint, text[], text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_reporting_staff_stream(uuid, bigint, uuid, text, timestamptz, text, integer) TO service_role;

COMMIT;
