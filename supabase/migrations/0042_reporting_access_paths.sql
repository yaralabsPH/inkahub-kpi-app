-- 0042_reporting_access_paths.sql
--
-- item-counting amendment, Task 14 access-path repair (DRAFT, not applied).
-- Append-only: installed 0037-0039 and the unapplied 0040/0041/0043/0044 drafts
-- stay byte-identical. 0042 was reserved for this evidence-backed correction.
--
-- Evidence (T14S3 staging diagnostic at revision 2c37f2a, rolled back):
--   owner members (rebuild): the one OR join over both owner kinds used the
--     owner index only on (batch_id, site), scanning all 42,343 candidates per
--     owner (84,679 rows removed by the join filter) for 7 result rows;
--   staff stream (both batch kinds): the outer direction-CASE ORDER BY over the
--     union read and sorted every row of the worker (~29,930) to return 1,000.
--
-- Two of the six dependency reads are replaced (same signature, same RETURNS
-- TABLE; CREATE OR REPLACE keeps owner and privileges):
--   read_reporting_owner_members  the rebuild candidate is read by PER-OWNER
--     keyed lookups (LATERAL): an order owner by order_key = key
--     (source_candidate_order), an event owner by event_id = key with a blank
--     order (the primary key), each bounded to the page after the keyset. The
--     refresh overlay and base-mirror branches are unchanged.
--   read_reporting_staff_stream  each of the six branches (overlay, base mirror,
--     candidate x after/before) has its own branch-local direction filter,
--     ORDER BY and LIMIT p_limit BEFORE the merge; the final merge sorts at most
--     three pages. The base-mirror and candidate branches match the staff_time
--     indexes (site|batch,site, staff_id, event_created_at, event_id "C") and can
--     stop near one page. The batch_events overlay branch has only its primary
--     key (batch_id, site, event_id): it still filters and sorts the JSON
--     staff_id/created_at of the whole frozen overlay of the batch before its
--     LIMIT. It is NOT claimed bounded; it stays a measured hosted gate (the
--     0042 plan diagnostic reports its scanned rows). No index is added here.
--     Overlay exclusion of the base mirror (replacements and tombstones) is
--     unchanged.
--   Owner equality keeps the default collation of 0041 (order_key = key,
--   event_id = key); only the keyset comparisons are bytewise, as in 0041.
-- Everything else is exactly 0041: frozen_read_batch (lock_batch: control-
-- before-site locks, fence, lease, drift), parameter checks, owner ordinality,
-- bytewise (COLLATE "C") keyset order, <= 1,000 rows, the complete-response
-- <= 1 MiB accounting, SECURITY INVOKER, empty search_path, service-only
-- grants. No index, table, timeout or other function changes. Nothing is
-- classified, counted or written.

BEGIN;

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
      -- the frozen candidate (rebuild): PER-OWNER keyed lookups, each bounded to the page after the keyset
      SELECT o.idx, c.event_id, c.image
        FROM o CROSS JOIN LATERAL (
          SELECT u.event_id, u.image FROM (
            SELECT sc.event_id, sc.image
              FROM reporting_private.source_candidate sc
             WHERE o.kind = 'order' AND sc.batch_id = b.batch_id AND sc.site = b.site AND sc.order_key = o.key
               AND (p_after_index IS NULL OR o.idx > p_after_index OR sc.event_id COLLATE "C" > p_after_event_id COLLATE "C")
            UNION ALL
            SELECT sc.event_id, sc.image
              FROM reporting_private.source_candidate sc
             WHERE o.kind = 'event' AND sc.batch_id = b.batch_id AND sc.site = b.site AND sc.event_id = o.key AND coalesce(sc.order_key, '') = ''
               AND (p_after_index IS NULL OR o.idx > p_after_index OR sc.event_id COLLATE "C" > p_after_event_id COLLATE "C")
          ) u
           ORDER BY u.event_id COLLATE "C"
           LIMIT p_limit
        ) c
       WHERE b.kind = 'rebuild' AND (p_after_index IS NULL OR o.idx >= p_after_index)
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
      -- after: each branch is the first page strictly after the position, in index order
      (SELECT be.event_id, be.image, (be.image ->> 'created_at')::timestamptz AS at
         FROM reporting_private.batch_events be
        WHERE p_direction = 'after' AND b.kind = 'refresh' AND be.batch_id = b.batch_id AND be.site = b.site AND be.image IS NOT NULL
          AND (be.image ->> 'staff_id') = p_staff::text
          AND ((be.image ->> 'created_at')::timestamptz, be.event_id COLLATE "C") > (p_at, p_at_event_id COLLATE "C")
        ORDER BY (be.image ->> 'created_at')::timestamptz, be.event_id COLLATE "C"
        LIMIT p_limit)
      UNION ALL
      (SELECT s.event_id, s.image, s.event_created_at
         FROM reporting_private.source_current s
        WHERE p_direction = 'after' AND b.kind = 'refresh' AND s.site = b.site AND s.staff_id = p_staff
          AND (s.event_created_at, s.event_id COLLATE "C") > (p_at, p_at_event_id COLLATE "C")
          AND NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = b.batch_id AND be.site = b.site AND be.event_id = s.event_id)
        ORDER BY s.event_created_at, s.event_id COLLATE "C"
        LIMIT p_limit)
      UNION ALL
      (SELECT sc.event_id, sc.image, sc.event_created_at
         FROM reporting_private.source_candidate sc
        WHERE p_direction = 'after' AND b.kind = 'rebuild' AND sc.batch_id = b.batch_id AND sc.site = b.site AND sc.staff_id = p_staff
          AND (sc.event_created_at, sc.event_id COLLATE "C") > (p_at, p_at_event_id COLLATE "C")
        ORDER BY sc.event_created_at, sc.event_id COLLATE "C"
        LIMIT p_limit)
      UNION ALL
      -- before: each branch is the first page strictly before the position, in descending index order
      (SELECT be.event_id, be.image, (be.image ->> 'created_at')::timestamptz AS at
         FROM reporting_private.batch_events be
        WHERE p_direction = 'before' AND b.kind = 'refresh' AND be.batch_id = b.batch_id AND be.site = b.site AND be.image IS NOT NULL
          AND (be.image ->> 'staff_id') = p_staff::text
          AND ((be.image ->> 'created_at')::timestamptz, be.event_id COLLATE "C") < (p_at, p_at_event_id COLLATE "C")
        ORDER BY (be.image ->> 'created_at')::timestamptz DESC, be.event_id COLLATE "C" DESC
        LIMIT p_limit)
      UNION ALL
      (SELECT s.event_id, s.image, s.event_created_at
         FROM reporting_private.source_current s
        WHERE p_direction = 'before' AND b.kind = 'refresh' AND s.site = b.site AND s.staff_id = p_staff
          AND (s.event_created_at, s.event_id COLLATE "C") < (p_at, p_at_event_id COLLATE "C")
          AND NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = b.batch_id AND be.site = b.site AND be.event_id = s.event_id)
        ORDER BY s.event_created_at DESC, s.event_id COLLATE "C" DESC
        LIMIT p_limit)
      UNION ALL
      (SELECT sc.event_id, sc.image, sc.event_created_at
         FROM reporting_private.source_candidate sc
        WHERE p_direction = 'before' AND b.kind = 'rebuild' AND sc.batch_id = b.batch_id AND sc.site = b.site AND sc.staff_id = p_staff
          AND (sc.event_created_at, sc.event_id COLLATE "C") < (p_at, p_at_event_id COLLATE "C")
        ORDER BY sc.event_created_at DESC, sc.event_id COLLATE "C" DESC
        LIMIT p_limit)
    )
    -- the merge of at most three bounded pages
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

-- CREATE OR REPLACE keeps the owner and privileges; restated so the effective ACL is explicit.
REVOKE ALL ON FUNCTION public.read_reporting_owner_members(uuid, bigint, jsonb, integer, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_reporting_staff_stream(uuid, bigint, uuid, text, timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_reporting_owner_members(uuid, bigint, jsonb, integer, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_reporting_staff_stream(uuid, bigint, uuid, text, timestamptz, text, integer) TO service_role;

COMMIT;
