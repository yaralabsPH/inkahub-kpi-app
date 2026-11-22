-- 0045_reporting_predecessor_page.sql
--
-- item-counting amendment, Task 15 scale contingency (DRAFT, not applied).
-- Append-only: 0037-0044 stay byte-identical. Adds ONE read-only function;
-- nothing else is created, replaced, dropped or written.
--
-- Evidence (hosted US rerun at bebedcb, 2026-11-17): one full 240 s worker
-- budget planned 139 of 16,060 owners (549 RPCs). Each owner's predecessor walk
-- still costs several sequential round trips per worker stream page: the page
-- (read_reporting_staff_stream), the children of the lines the walk is certain
-- to consume (read_reporting_children, plus the empty probe that ends them) and
-- the first stop candidate's own children.
--
-- public.read_reporting_predecessor_page returns, for ONE frozen batch and ONE
-- worker, the stream page strictly BEFORE (p_at, p_at_event_id) exactly as
-- 0042's read_reporting_staff_stream 'before' (same three frozen-view branches,
-- descending (created_at, event_id COLLATE "C"), at most p_limit lines), and
-- after each line its frozen children exactly as 0041's read_reporting_children
-- (same three branches, ascending event_id COLLATE "C") ONLY for the lines the
-- caller's walk is certain to consume:
--   * a line_verified line in the certain range: created_at > p_certain_at, or
--     created_at = p_certain_at and event_id >= p_certain_event_id bytewise
--     (p_certain_event_id NULL = instant only; p_certain_at NULL = no range).
--     The range is a prefix of the descending page (a keyset bound);
--   * the FIRST line_verified line of the page outside that range (the next
--     possible stop line, which the walk always consumes before it can stop).
--   No other line's children are read: nothing beyond the first possible stop
--   line, no lookahead. The caller decides which of the returned lines are
--   stream candidates; a non-candidate's children are ignored by it.
--
-- Rows (row_kind, event_id, image), in walk order:
--   'line'       a stream line whose children are NOT included
--   'line_kids'  a stream line whose children follow as 'child' rows
--   'child'      a child of the nearest preceding 'line_kids' row
--   'end'        last row, event_id/image NULL: the page is complete (every
--                line up to p_limit or the stream end, and every included
--                line's children). Without it the response was cut by a
--                bound; the caller continues from the last returned row.
-- Bounds: at most 1,000 rows including 'end'; the complete response (every
-- row as JSON plus separators and brackets) at most 1 MiB, accounted as 0041
-- does; a single row above 1 MiB is an error. Same frozen_read_batch (lock,
-- fence, lease, frozen state), same parameter checks. SECURITY INVOKER, empty
-- search_path, fully qualified, execute granted only to service_role.

BEGIN;

CREATE FUNCTION public.read_reporting_predecessor_page(p_batch uuid, p_fence bigint, p_staff uuid, p_at timestamptz, p_at_event_id text, p_certain_at timestamptz, p_certain_event_id text, p_limit integer DEFAULT 200)
RETURNS TABLE (row_kind text, event_id text, image jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b       reporting_private.batches;
  r       record;
  k       record;
  v_bytes bigint := 2; -- the response array's brackets
  v_size  bigint;
  v_rows  integer := 0;
  v_open  boolean := true; -- the first line_verified line outside the certain range is still to come
  v_kids  boolean;
  v_room  integer;
  v_end   bigint;
BEGIN
  b := reporting_private.frozen_read_batch(p_batch, p_fence);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000'; END IF;
  IF p_staff IS NULL OR p_at IS NULL OR p_at_event_id IS NULL THEN RAISE EXCEPTION 'p_staff, p_at and p_at_event_id are required'; END IF;
  IF p_certain_at IS NULL AND p_certain_event_id IS NOT NULL THEN RAISE EXCEPTION 'p_certain_event_id needs p_certain_at'; END IF;
  FOR r IN
    WITH m AS (
      -- exactly the three 'before' branches of 0042 read_reporting_staff_stream
      (SELECT be.event_id, be.image, (be.image ->> 'created_at')::timestamptz AS at
         FROM reporting_private.batch_events be
        WHERE b.kind = 'refresh' AND be.batch_id = b.batch_id AND be.site = b.site AND be.image IS NOT NULL
          AND (be.image ->> 'staff_id') = p_staff::text
          AND ((be.image ->> 'created_at')::timestamptz, be.event_id COLLATE "C") < (p_at, p_at_event_id COLLATE "C")
        ORDER BY (be.image ->> 'created_at')::timestamptz DESC, be.event_id COLLATE "C" DESC
        LIMIT p_limit)
      UNION ALL
      (SELECT s.event_id, s.image, s.event_created_at
         FROM reporting_private.source_current s
        WHERE b.kind = 'refresh' AND s.site = b.site AND s.staff_id = p_staff
          AND (s.event_created_at, s.event_id COLLATE "C") < (p_at, p_at_event_id COLLATE "C")
          AND NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = b.batch_id AND be.site = b.site AND be.event_id = s.event_id)
        ORDER BY s.event_created_at DESC, s.event_id COLLATE "C" DESC
        LIMIT p_limit)
      UNION ALL
      (SELECT sc.event_id, sc.image, sc.event_created_at
         FROM reporting_private.source_candidate sc
        WHERE b.kind = 'rebuild' AND sc.batch_id = b.batch_id AND sc.site = b.site AND sc.staff_id = p_staff
          AND (sc.event_created_at, sc.event_id COLLATE "C") < (p_at, p_at_event_id COLLATE "C")
        ORDER BY sc.event_created_at DESC, sc.event_id COLLATE "C" DESC
        LIMIT p_limit)
    )
    SELECT m.event_id, m.image, m.at FROM m
     WHERE (m.at, m.event_id COLLATE "C") < (p_at, p_at_event_id COLLATE "C")
     ORDER BY m.at DESC, m.event_id COLLATE "C" DESC
     LIMIT p_limit
  LOOP
    v_kids := false;
    IF (r.image ->> 'event_type') = 'line_verified' THEN
      IF p_certain_at IS NOT NULL AND (r.at > p_certain_at
           OR (p_certain_event_id IS NOT NULL AND r.at = p_certain_at AND r.event_id COLLATE "C" >= p_certain_event_id COLLATE "C")) THEN
        v_kids := true;
      ELSIF v_open THEN
        v_kids := true;
        v_open := false;
      END IF;
    END IF;
    IF v_rows >= 1000 THEN RETURN; END IF; -- cut: the caller continues from the last returned row
    -- The COMPLETE returned row as JSON (field names, ids, image; jsonb text is never smaller than compact JSON) plus its separator.
    v_size := pg_catalog.octet_length(pg_catalog.jsonb_build_object('row_kind', CASE WHEN v_kids THEN 'line_kids' ELSE 'line' END, 'event_id', r.event_id, 'image', r.image)::text) + 1;
    IF v_bytes + v_size > 1048576 THEN
      IF v_rows = 0 THEN RAISE EXCEPTION 'one response row (%) is larger than 1 MiB', r.event_id; END IF;
      RETURN;
    END IF;
    v_bytes := v_bytes + v_size;
    v_rows := v_rows + 1;
    row_kind := CASE WHEN v_kids THEN 'line_kids' ELSE 'line' END; event_id := r.event_id; image := r.image;
    RETURN NEXT;
    IF v_kids THEN
      v_room := 1000 - v_rows;
      IF v_room < 1 THEN RETURN; END IF; -- cut before this line's children: the caller reads them itself
      FOR k IN
        WITH c AS (
          -- exactly the three branches of 0041 read_reporting_children, for this ONE parent
          SELECT be.event_id, be.image
            FROM reporting_private.batch_events be
           WHERE b.kind = 'refresh' AND be.batch_id = b.batch_id AND be.site = b.site AND be.image IS NOT NULL
             AND (be.image ->> 'parent_event_id') = r.event_id
          UNION ALL
          SELECT s.event_id, s.image
            FROM reporting_private.source_current s
           WHERE b.kind = 'refresh' AND s.site = b.site AND s.parent_event_id = r.event_id
             AND NOT EXISTS (SELECT 1 FROM reporting_private.batch_events be WHERE be.batch_id = b.batch_id AND be.site = b.site AND be.event_id = s.event_id)
          UNION ALL
          SELECT sc.event_id, sc.image
            FROM reporting_private.source_candidate sc
           WHERE b.kind = 'rebuild' AND sc.batch_id = b.batch_id AND sc.site = b.site AND sc.parent_event_id = r.event_id
        )
        SELECT c.event_id, c.image FROM c ORDER BY c.event_id COLLATE "C" LIMIT v_room + 1
      LOOP
        IF v_rows >= 1000 THEN RETURN; END IF; -- more children than room: cut inside them
        v_size := pg_catalog.octet_length(pg_catalog.jsonb_build_object('row_kind', 'child', 'event_id', k.event_id, 'image', k.image)::text) + 1;
        IF v_bytes + v_size > 1048576 THEN RETURN; END IF;
        v_bytes := v_bytes + v_size;
        v_rows := v_rows + 1;
        row_kind := 'child'; event_id := k.event_id; image := k.image;
        RETURN NEXT;
      END LOOP;
    END IF;
  END LOOP;
  -- Every line of the page and every included line's children were returned: say so (if the marker itself fits).
  v_end := pg_catalog.octet_length(pg_catalog.jsonb_build_object('row_kind', 'end', 'event_id', NULL, 'image', NULL)::text) + 1;
  IF v_rows < 1000 AND v_bytes + v_end <= 1048576 THEN
    row_kind := 'end'; event_id := NULL; image := NULL;
    RETURN NEXT;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.read_reporting_predecessor_page(uuid, bigint, uuid, timestamptz, text, timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_reporting_predecessor_page(uuid, bigint, uuid, timestamptz, text, timestamptz, text, integer) TO service_role;

COMMIT;
