-- 0041_reporting_dependency_read_bounds.sql
--
-- item-counting amendment, Task 14 repair T14R4 (DRAFT, not applied).
-- Append-only: installed 0037-0039 and the unapplied 0040 draft stay
-- byte-identical. Task 16 is allocated 0042.
--
-- The six 0040 dependency reads bounded only rows or image bytes. Each is
-- replaced (same signature, same RETURNS TABLE, CREATE OR REPLACE keeps owner
-- and privileges) so the COMPLETE response fits 1 MiB: the array brackets plus,
-- per returned row, its whole JSON object (field names, identifiers, keys,
-- images) as jsonb text, which is never smaller than the compact JSON on the
-- wire, plus a separator. The 1,000-row cap stays. A row that alone cannot fit
-- fails visibly; otherwise a page ends short and the caller continues from its
-- last keyset (only an empty page ends a read). Frozen overlay/candidate
-- semantics, frozen_read_batch (lock_batch: control-before-site locks, fence,
-- lease, drift), SECURITY INVOKER, empty search_path and service-only grants
-- are unchanged. Nothing is classified, counted or written.

BEGIN;

CREATE OR REPLACE FUNCTION public.read_reporting_changed_keys(p_batch uuid, p_fence bigint, p_after_event_id text, p_limit integer DEFAULT 1000)
RETURNS TABLE (event_id text, before_image jsonb, after_image jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 2; -- the response array's brackets
  v_size  bigint;
  v_rows  integer := 0;
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
    -- The COMPLETE returned row as JSON (field names, ids, image; jsonb text is never smaller than compact JSON) plus its separator.
    v_size := pg_catalog.octet_length(pg_catalog.jsonb_build_object('event_id', r.event_id, 'before_image', r.before_image, 'after_image', r.after_image)::text) + 1;
    IF v_bytes + v_size > 1048576 THEN
      IF v_rows = 0 THEN RAISE EXCEPTION 'one response row (%) is larger than 1 MiB', r.event_id; END IF;
      EXIT; -- a short page; the caller continues from the last returned keyset
    END IF;
    v_bytes := v_bytes + v_size;
    v_rows := v_rows + 1;
    event_id := r.event_id; before_image := r.before_image; after_image := r.after_image;
    RETURN NEXT;
  END LOOP;
END
$fn$;

CREATE OR REPLACE FUNCTION public.list_reporting_owners(p_batch uuid, p_fence bigint, p_after_kind text, p_after_key text, p_limit integer DEFAULT 1000)
RETURNS TABLE (partition_kind text, partition_key text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 2; -- the response array's brackets
  v_size  bigint;
  v_rows  integer := 0;
BEGIN
  b := reporting_private.frozen_read_batch(p_batch, p_fence);
  IF b.kind <> 'rebuild' THEN RAISE EXCEPTION 'list_reporting_owners is a rebuild read'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000'; END IF;
  IF p_after_kind IS NOT NULL AND p_after_kind NOT IN ('event', 'order') THEN RAISE EXCEPTION 'p_after_kind must be event or order'; END IF;
  FOR r IN
    SELECT x.kind, x.key FROM (
      (SELECT 'event'::text AS kind, sc.event_id AS key
         FROM reporting_private.source_candidate sc
        WHERE (p_after_kind IS NULL OR p_after_kind = 'event')
          AND sc.batch_id = b.batch_id AND sc.site = b.site AND coalesce(sc.order_key, '') = ''
          AND (p_after_kind IS NULL OR sc.event_id COLLATE "C" > p_after_key COLLATE "C")
        ORDER BY sc.event_id COLLATE "C"
        LIMIT p_limit)
      UNION ALL
      (SELECT DISTINCT 'order'::text AS kind, sc.order_key COLLATE "C" AS key
         FROM reporting_private.source_candidate sc
        WHERE sc.batch_id = b.batch_id AND sc.site = b.site AND coalesce(sc.order_key, '') <> ''
          AND (p_after_kind IS DISTINCT FROM 'order' OR sc.order_key COLLATE "C" > p_after_key COLLATE "C")
        ORDER BY 2
        LIMIT p_limit)
    ) x
    ORDER BY x.kind COLLATE "C", x.key COLLATE "C"
    LIMIT p_limit
  LOOP
    -- The COMPLETE returned row as JSON plus its separator (owner keys can be long or multibyte).
    v_size := pg_catalog.octet_length(pg_catalog.jsonb_build_object('partition_kind', r.kind, 'partition_key', r.key)::text) + 1;
    IF v_bytes + v_size > 1048576 THEN
      IF v_rows = 0 THEN RAISE EXCEPTION 'one response row (owner %) is larger than 1 MiB', pg_catalog.left(r.key, 64); END IF;
      EXIT; -- a short page; the caller continues from the last returned keyset
    END IF;
    v_bytes := v_bytes + v_size;
    v_rows := v_rows + 1;
    partition_kind := r.kind; partition_key := r.key;
    RETURN NEXT;
  END LOOP;
END
$fn$;

CREATE OR REPLACE FUNCTION public.read_reporting_owner_members(p_batch uuid, p_fence bigint, p_owners jsonb, p_after_index integer, p_after_event_id text, p_limit integer DEFAULT 1000)
RETURNS TABLE (owner_index integer, event_id text, image jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 2; -- the response array's brackets
  v_size  bigint;
  v_rows  integer := 0;
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
    -- The COMPLETE returned row as JSON (field names, ids, image; jsonb text is never smaller than compact JSON) plus its separator.
    v_size := pg_catalog.octet_length(pg_catalog.jsonb_build_object('owner_index', r.idx, 'event_id', r.event_id, 'image', r.image)::text) + 1;
    IF v_bytes + v_size > 1048576 THEN
      IF v_rows = 0 THEN RAISE EXCEPTION 'one response row (%) is larger than 1 MiB', r.event_id; END IF;
      EXIT; -- a short page; the caller continues from the last returned keyset
    END IF;
    v_bytes := v_bytes + v_size;
    v_rows := v_rows + 1;
    owner_index := r.idx; event_id := r.event_id; image := r.image;
    RETURN NEXT;
  END LOOP;
END
$fn$;

CREATE OR REPLACE FUNCTION public.read_reporting_events_by_id(p_batch uuid, p_fence bigint, p_ids text[])
RETURNS TABLE (event_id text, image jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 2; -- the response array's brackets
  v_size  bigint;
  v_rows  integer := 0;
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
    -- The COMPLETE returned row as JSON (field names, ids, image; jsonb text is never smaller than compact JSON) plus its separator.
    v_size := pg_catalog.octet_length(pg_catalog.jsonb_build_object('event_id', r.event_id, 'image', r.image)::text) + 1;
    IF v_bytes + v_size > 1048576 THEN
      IF v_rows = 0 THEN RAISE EXCEPTION 'one response row (%) is larger than 1 MiB', r.event_id; END IF;
      EXIT; -- a short page; the caller continues from the last returned keyset
    END IF;
    v_bytes := v_bytes + v_size;
    v_rows := v_rows + 1;
    event_id := r.event_id; image := r.image;
    RETURN NEXT;
  END LOOP;
END
$fn$;

CREATE OR REPLACE FUNCTION public.read_reporting_children(p_batch uuid, p_fence bigint, p_parent_ids text[], p_after_parent_id text, p_after_event_id text, p_limit integer DEFAULT 1000)
RETURNS TABLE (parent_event_id text, event_id text, image jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 2; -- the response array's brackets
  v_size  bigint;
  v_rows  integer := 0;
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
    -- The COMPLETE returned row as JSON (field names, ids, image; jsonb text is never smaller than compact JSON) plus its separator.
    v_size := pg_catalog.octet_length(pg_catalog.jsonb_build_object('parent_event_id', r.parent_id, 'event_id', r.event_id, 'image', r.image)::text) + 1;
    IF v_bytes + v_size > 1048576 THEN
      IF v_rows = 0 THEN RAISE EXCEPTION 'one response row (%) is larger than 1 MiB', r.event_id; END IF;
      EXIT; -- a short page; the caller continues from the last returned keyset
    END IF;
    v_bytes := v_bytes + v_size;
    v_rows := v_rows + 1;
    parent_event_id := r.parent_id; event_id := r.event_id; image := r.image;
    RETURN NEXT;
  END LOOP;
END
$fn$;

CREATE OR REPLACE FUNCTION public.read_reporting_staff_stream(p_batch uuid, p_fence bigint, p_staff uuid, p_direction text, p_at timestamptz, p_at_event_id text, p_limit integer DEFAULT 200)
RETURNS TABLE (event_id text, image jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  v_bytes bigint := 2; -- the response array's brackets
  v_size  bigint;
  v_rows  integer := 0;
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
    -- The COMPLETE returned row as JSON (field names, ids, image; jsonb text is never smaller than compact JSON) plus its separator.
    v_size := pg_catalog.octet_length(pg_catalog.jsonb_build_object('event_id', r.event_id, 'image', r.image)::text) + 1;
    IF v_bytes + v_size > 1048576 THEN
      IF v_rows = 0 THEN RAISE EXCEPTION 'one response row (%) is larger than 1 MiB', r.event_id; END IF;
      EXIT; -- a short page; the caller continues from the last returned keyset
    END IF;
    v_bytes := v_bytes + v_size;
    v_rows := v_rows + 1;
    event_id := r.event_id; image := r.image;
    RETURN NEXT;
  END LOOP;
END
$fn$;

COMMIT;
