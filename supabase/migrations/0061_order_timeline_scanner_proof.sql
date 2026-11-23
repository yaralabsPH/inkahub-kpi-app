-- 0061_order_timeline_scanner_proof.sql — F10 Task 3a: scanner-attested full framing.
--
-- Replaces ONLY public.reconcile_order_timeline_app(text, text) (same signature, same service-only grants,
-- SECURITY INVOKER, empty search_path). Everything 0059 copied is still copied unchanged: per-work-type framed
-- evidence from completed framed/a0_framed events, dispatched evidence, and retractions for their cancellations.
--
-- Added: at most ONE saved F6 shared-scanner commit receipt (public.scanner_requests, kind 'commit', outcome
-- 'saved', at most one per site/order by 0055's unique index) for the exact site and order number.
--   * The receipt proves full framing only when its result is well formed (status 'saved', its own request id
--     and order number, a non-empty array of at most 52 unique string event ids) and EVERY listed id resolves to
--     an original event written by that commit: same site and order, no CS case, the receipt's staff, station
--     'shared:<receiver>:<scanner>' and scan time, department framed/a0_framed, ids 'scn-<request>-vNN' being
--     line_verified per-line events and 'scn-<request>-c-<work type>' being completed events, with at least one
--     of each and the completed work types equal to the per-line work types.
--     This is scanner-attested completeness (the F6 client builds a commit only from a complete Shopify order);
--     it is not a second Shopify check.
--   * Then one confirmed full-framing record is emitted: key '<site>/receipt:<request_id>', stage framed,
--     framingComplete true, at the receipt's scanned_at. Only if none of the listed events has a cancellation.
--   * Every cancellation (event_type 'cancelled', same site) of any listed event emits a same-source retraction
--     of that key: key '<site>/receipt-cancel:<request_id>:<cancellation id>', at the cancellation's own
--     created_at. Retractions apply whichever was reconciled first; repeats are duplicates. No date is invented.
--   * Later CS cases are not inspected: replacement work carries its own cs_case_id and is excluded by the
--     timeline projection, so it never erases original history. Classic/manual framing never carries
--     framingComplete and stays partial.
-- The whole call stays bounded: the 500-event source limit is unchanged and the combined occurrences must fit
-- the ingest limit of 200, failing explicitly ("exceed the limit") before anything is written.
-- Reads production_events and scanner_requests only; writes nothing there.
--
-- Rollback: re-run the reconcile_order_timeline_app definition from 0059 (CREATE OR REPLACE with that body).
-- Evidence already recorded is immutable and retained; without this function no new proof is emitted.
-- Not applied by an agent. Codex/CJ apply it to staging only.

BEGIN;

CREATE OR REPLACE FUNCTION public.reconcile_order_timeline_app(p_site text, p_order_number text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_n       bigint;
  v_list    jsonb;
  v_cnt     integer;
  v_rec     public.scanner_requests;
  v_ids     text[];
  v_prefix  text;
  v_key     text;
  v_valid   boolean := false;
  v_cancels jsonb := '[]'::jsonb;
  v_proof   jsonb := '[]'::jsonb;
BEGIN
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN RAISE EXCEPTION 'reconcile_order_timeline_app: unsupported site'; END IF;
  IF p_order_number IS NULL OR pg_catalog.length(p_order_number) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'reconcile_order_timeline_app: order number must be 1..64 characters'; END IF;
  SELECT count(*) INTO v_n FROM (SELECT 1 FROM public.production_events pe WHERE pe.location = p_site AND pe.order_number = p_order_number LIMIT 501) z;
  IF v_n > 500 THEN RAISE EXCEPTION 'reconcile_order_timeline_app: more than 500 events exceed the limit 500'; END IF;

  -- 0059, unchanged: per-work-type framed and dispatched copies plus retractions for their cancellations
  WITH facts AS (
    SELECT pe.location, pe.id, pe.order_number, pe.created_at, pe.cs_case_id,
           CASE WHEN pe.event_type = 'dispatched' THEN 'dispatched' ELSE 'framed' END AS stage,
           CASE WHEN pe.event_type = 'completed' THEN pe.department END AS work_type
      FROM public.production_events pe
     WHERE pe.location = p_site AND pe.order_number = p_order_number
       AND ((pe.event_type = 'completed' AND pe.department IN ('framed', 'a0_framed')) OR pe.event_type = 'dispatched')
  ), items AS (
    SELECT f.created_at AS at, f.id AS sort_id, pg_catalog.jsonb_build_object(
             'source', 'app', 'key', f.location || '/' || f.id, 'site', f.location, 'shop', NULL, 'shopifyOrderId', NULL,
             'orderNumber', f.order_number, 'stage', f.stage, 'kind', 'confirmed', 'happenedAt', public.order_timeline_utc(f.created_at),
             'workType', f.work_type, 'caseId', f.cs_case_id) AS item
      FROM facts f
    UNION ALL
    SELECT c.created_at, c.id, pg_catalog.jsonb_build_object(
             'source', 'app', 'key', c.location || '/' || c.id, 'site', c.location, 'shop', NULL, 'shopifyOrderId', NULL,
             'orderNumber', f.order_number, 'stage', f.stage, 'kind', 'confirmed', 'happenedAt', public.order_timeline_utc(c.created_at),
             'caseId', f.cs_case_id, 'retractsKey', f.location || '/' || f.id)
      FROM public.production_events c
      JOIN facts f ON f.location = c.location AND f.id = c.parent_event_id
     WHERE c.location = p_site AND c.event_type = 'cancelled'
  )
  SELECT coalesce(pg_catalog.jsonb_agg(i.item ORDER BY i.at, i.sort_id), '[]'::jsonb) INTO v_list FROM items i;

  -- 0061: at most one saved commit receipt for this exact site and order
  SELECT count(*) INTO v_cnt FROM (
    SELECT 1 FROM public.scanner_requests r
     WHERE r.location = p_site AND r.order_number = p_order_number AND r.kind = 'commit' AND r.outcome = 'saved' LIMIT 2) z;
  IF v_cnt = 1 THEN
    SELECT r.* INTO v_rec FROM public.scanner_requests r
     WHERE r.location = p_site AND r.order_number = p_order_number AND r.kind = 'commit' AND r.outcome = 'saved';
    v_key := p_site || '/receipt:' || v_rec.request_id::text;
    v_prefix := 'scn-' || pg_catalog.replace(v_rec.request_id::text, '-', '') || '-';

    -- the listed ids, only when they are a non-empty bounded array of strings
    IF pg_catalog.jsonb_typeof(v_rec.result) = 'object'
       AND pg_catalog.jsonb_typeof(v_rec.result -> 'event_ids') = 'array'
       AND pg_catalog.jsonb_array_length(v_rec.result -> 'event_ids') BETWEEN 1 AND 52
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_rec.result -> 'event_ids') x WHERE pg_catalog.jsonb_typeof(x.value) <> 'string') THEN
      SELECT pg_catalog.array_agg(x.value) INTO v_ids FROM pg_catalog.jsonb_array_elements_text(v_rec.result -> 'event_ids') x;
    END IF;

    IF v_ids IS NOT NULL THEN
      v_valid := coalesce(
        (SELECT count(DISTINCT u) FROM pg_catalog.unnest(v_ids) u) = pg_catalog.cardinality(v_ids)
        AND v_rec.result ->> 'status' = 'saved'
        AND v_rec.result ->> 'request_id' = v_rec.request_id::text
        AND v_rec.result ->> 'order_number' = p_order_number
        AND v_rec.scanned_at IS NOT NULL
        AND v_rec.staff_id IS NOT NULL
        -- every listed id is an original event this commit wrote (unique ids + primary key => exact match)
        AND (SELECT count(*) FROM public.production_events pe
              WHERE pe.location = p_site AND pe.id = ANY (v_ids)
                AND pe.order_number = p_order_number AND pe.cs_case_id IS NULL
                AND pe.created_at = v_rec.scanned_at AND pe.staff_id = v_rec.staff_id
                AND pe.station_id = 'shared:' || v_rec.receiver_id || ':' || v_rec.scanner_id
                AND pe.department IN ('framed', 'a0_framed')
                AND ((pe.id ~ ('^' || v_prefix || 'v[0-9]{2}$') AND pe.event_type = 'line_verified' AND pe.line_sku IS NOT NULL)
                  OR (pe.id = v_prefix || 'c-' || pe.department AND pe.event_type = 'completed' AND pe.line_sku IS NULL))
            ) = pg_catalog.cardinality(v_ids)
        -- at least one completion and one per-line event, and completions cover exactly the per-line work types
        AND (SELECT pg_catalog.array_agg(DISTINCT pe.department ORDER BY pe.department) FROM public.production_events pe
              WHERE pe.location = p_site AND pe.id = ANY (v_ids) AND pe.event_type = 'completed')
          = (SELECT pg_catalog.array_agg(DISTINCT pe.department ORDER BY pe.department) FROM public.production_events pe
              WHERE pe.location = p_site AND pe.id = ANY (v_ids) AND pe.event_type = 'line_verified'),
        false);

      -- a cancellation of any listed event retracts the proof, at the cancellation's own time
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'source', 'app', 'key', p_site || '/receipt-cancel:' || v_rec.request_id::text || ':' || c.id, 'site', p_site,
               'shop', NULL, 'shopifyOrderId', NULL, 'orderNumber', p_order_number, 'stage', 'framed', 'kind', 'confirmed',
               'happenedAt', public.order_timeline_utc(c.created_at), 'retractsKey', v_key) ORDER BY c.created_at, c.id), '[]'::jsonb)
        INTO v_cancels
        FROM public.production_events c
       WHERE c.location = p_site AND c.event_type = 'cancelled' AND c.parent_event_id = ANY (v_ids);

      IF v_valid AND v_cancels = '[]'::jsonb THEN
        v_proof := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'source', 'app', 'key', v_key, 'site', p_site, 'shop', NULL, 'shopifyOrderId', NULL, 'orderNumber', p_order_number,
          'stage', 'framed', 'kind', 'confirmed', 'happenedAt', public.order_timeline_utc(v_rec.scanned_at), 'framingComplete', true));
      END IF;
    END IF;
  END IF;

  v_list := v_list || v_cancels || v_proof;
  IF pg_catalog.jsonb_array_length(v_list) > 200 THEN
    RAISE EXCEPTION 'reconcile_order_timeline_app: more than 200 occurrences exceed the limit 200';
  END IF;
  RETURN public.ingest_order_timeline(NULL, v_list);
END
$fn$;

-- The function runs as its caller (service_role); it now reads receipts.
GRANT SELECT ON public.scanner_requests TO service_role;

REVOKE ALL ON FUNCTION public.reconcile_order_timeline_app(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_order_timeline_app(text, text) TO service_role;

COMMIT;
