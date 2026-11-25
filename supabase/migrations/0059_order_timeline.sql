-- 0059_order_timeline.sql
--
-- F10 Order timeline (append-only after 0058; 0048-0051 stay reserved for F3).
-- Additive only: two new tables and four service-only functions. No trigger on
-- production_events, no backfill, no change to scanning/inventory paths, and no
-- dependency on the F1 reporting generations.
--
-- 1. public.order_timeline_orders: one row per Shopify order (shop + immutable
--    order id). `site` is the ROUTED site from the verified order-location
--    predicate, set ONCE (NULL while unrouted, with a reason). A later
--    different site is counted as a route conflict and never reassigns the
--    order. The order number is an alias within a site, never a key.
-- 2. public.order_timeline_evidence: immutable source occurrences, unique per
--    (source, occurrence_key). Shopify evidence never carries a site (it comes
--    only from the routing above); app/make evidence carries its own explicit
--    site. Same key + same content = duplicate; different content = conflict;
--    the original is kept. No customer data columns exist. A retraction row
--    (retracts_key) revokes one exact earlier occurrence of the same source
--    from its own time; history is never edited.
-- 3. ingest_order_timeline: atomic (one call = one transaction) service-only
--    acceptance of an optional order identity and at most 200 occurrences.
-- 4. read_order_timeline / read_order_flow: bounded, indexed service-only reads
--    that refuse (never truncate) above their limits.
-- 5. reconcile_order_timeline_app: bounded explicit copy of ONE order's
--    recorded app framing/dispatch events for one site (idempotent).
-- Browser roles get no table or function access; the API authorizes callers.

BEGIN;

CREATE TABLE public.order_timeline_orders (
  shop             text        NOT NULL CHECK (shop ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  shopify_order_id text        NOT NULL CHECK (shopify_order_id ~ '^[0-9]{1,20}$'),
  site             text        CHECK (site IN ('au', 'uk', 'us')),
  order_number     text        CHECK (order_number IS NULL OR pg_catalog.length(order_number) BETWEEN 1 AND 64),
  route_reason     text        CHECK (route_reason IS NULL OR pg_catalog.length(route_reason) <= 200),
  route_conflicts  integer     NOT NULL DEFAULT 0 CHECK (route_conflicts >= 0),
  created_at       timestamptz NOT NULL DEFAULT pg_catalog.now(),
  routed_at        timestamptz,
  PRIMARY KEY (shop, shopify_order_id),
  CHECK ((site IS NULL) = (routed_at IS NULL))
);
CREATE INDEX order_timeline_orders_site_number ON public.order_timeline_orders (site, order_number) WHERE site IS NOT NULL;
CREATE INDEX order_timeline_orders_unrouted ON public.order_timeline_orders (created_at) WHERE site IS NULL;

CREATE TABLE public.order_timeline_evidence (
  source               text        NOT NULL CHECK (source IN ('shopify', 'app', 'make')),
  occurrence_key       text        NOT NULL CHECK (pg_catalog.length(occurrence_key) BETWEEN 1 AND 200),
  site                 text        CHECK (site IN ('au', 'uk', 'us')),
  shop                 text        CHECK (shop IS NULL OR shop ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  shopify_order_id     text        CHECK (shopify_order_id IS NULL OR shopify_order_id ~ '^[0-9]{1,20}$'),
  order_number         text        CHECK (order_number IS NULL OR pg_catalog.length(order_number) BETWEEN 1 AND 64),
  stage                text        NOT NULL CHECK (stage IN ('ordered', 'cancelled', 'framed', 'dispatched', 'shipped', 'delivered',
                                     'make_submitted', 'make_files_found', 'make_planned', 'make_images_ready', 'make_packing_ready')),
  kind                 text        NOT NULL CHECK (kind IN ('confirmed', 'reported', 'inferred')),
  happened_at          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT pg_catalog.now(),
  fulfillment_id       text        CHECK (fulfillment_id IS NULL OR pg_catalog.length(fulfillment_id) BETWEEN 1 AND 64),
  fulfillment_complete boolean,
  work_type            text        CHECK (work_type IS NULL OR pg_catalog.length(work_type) BETWEEN 1 AND 40),
  framing_complete     boolean,
  case_id              text        CHECK (case_id IS NULL OR pg_catalog.length(case_id) BETWEEN 1 AND 64),
  batch_id             text        CHECK (batch_id IS NULL OR pg_catalog.length(batch_id) BETWEEN 1 AND 100),
  -- a retraction revokes the SAME source's occurrence with this key from its own happened_at (e.g. a cancelled scan)
  retracts_key         text        CHECK (retracts_key IS NULL OR pg_catalog.length(retracts_key) BETWEEN 1 AND 200),
  PRIMARY KEY (source, occurrence_key),
  CHECK (retracts_key IS NULL OR retracts_key <> occurrence_key),
  CHECK ((shop IS NULL) = (shopify_order_id IS NULL)),
  CHECK (shopify_order_id IS NOT NULL OR order_number IS NOT NULL),
  -- Shopify site comes only from routing; app/make name their own site explicitly.
  CHECK ((source = 'shopify') = (site IS NULL)),
  CHECK (source <> 'shopify' OR shop IS NOT NULL),
  FOREIGN KEY (shop, shopify_order_id) REFERENCES public.order_timeline_orders (shop, shopify_order_id) ON DELETE RESTRICT
);
CREATE INDEX order_timeline_evidence_identity ON public.order_timeline_evidence (shop, shopify_order_id) WHERE shopify_order_id IS NOT NULL;
CREATE INDEX order_timeline_evidence_site_number ON public.order_timeline_evidence (site, order_number) WHERE site IS NOT NULL AND order_number IS NOT NULL;
CREATE INDEX order_timeline_evidence_ordered_at ON public.order_timeline_evidence (happened_at) WHERE source = 'shopify' AND stage = 'ordered';
CREATE INDEX order_timeline_evidence_received ON public.order_timeline_evidence (source, received_at);

ALTER TABLE public.order_timeline_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_timeline_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.order_timeline_orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.order_timeline_evidence FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.order_timeline_orders TO service_role;
GRANT SELECT, INSERT ON TABLE public.order_timeline_evidence TO service_role;

CREATE FUNCTION public.order_timeline_evidence_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  RAISE EXCEPTION 'order timeline evidence is immutable';
END
$fn$;
CREATE TRIGGER order_timeline_evidence_immutable BEFORE UPDATE OR DELETE ON public.order_timeline_evidence
  FOR EACH ROW EXECUTE FUNCTION public.order_timeline_evidence_immutable();
REVOKE ALL ON FUNCTION public.order_timeline_evidence_immutable() FROM PUBLIC, anon, authenticated;

-- UTC text with microseconds and an explicit Z (independent of reporting helpers).
CREATE FUNCTION public.order_timeline_utc(p timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$ SELECT pg_catalog.to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') $fn$;
REVOKE ALL ON FUNCTION public.order_timeline_utc(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_timeline_utc(timestamptz) TO service_role;

-- Service-only. p_order (optional): {shop, shopifyOrderId, orderNumber, site|null, routeReason|null}.
-- p_evidence: array (<= 200) of {source, key, site, shop, shopifyOrderId, orderNumber, stage, kind, happenedAt,
-- fulfillmentId, fulfillmentComplete, workType, framingComplete, caseId, batchId, retractsKey}. Any invalid record fails the
-- whole call (nothing is written). Returns counts and the routing outcome (none|routed|unrouted|unchanged|conflict).
CREATE FUNCTION public.ingest_order_timeline(p_order jsonb, p_evidence jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_route text := 'none';
  v_shop  text;
  v_id    text;
  v_site  text;
  v_num   text;
  r       public.order_timeline_orders;
  e       jsonb;
  n       public.order_timeline_evidence;
  prev    public.order_timeline_evidence;
  v_acc   integer := 0;
  v_dup   integer := 0;
  v_conf  integer := 0;
BEGIN
  IF p_evidence IS NULL OR pg_catalog.jsonb_typeof(p_evidence) <> 'array' OR pg_catalog.jsonb_array_length(p_evidence) > 200 THEN
    RAISE EXCEPTION 'ingest_order_timeline: evidence must be an array of at most 200 records';
  END IF;

  IF p_order IS NOT NULL AND pg_catalog.jsonb_typeof(p_order) <> 'null' THEN
    v_shop := p_order ->> 'shop';
    v_id := p_order ->> 'shopifyOrderId';
    v_site := p_order ->> 'site';
    v_num := p_order ->> 'orderNumber';
    IF v_shop IS NULL OR v_id IS NULL THEN RAISE EXCEPTION 'ingest_order_timeline: order identity requires shop and order id'; END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('order-timeline|' || v_shop || '|' || v_id));
    INSERT INTO public.order_timeline_orders (shop, shopify_order_id, site, order_number, route_reason, routed_at)
    VALUES (v_shop, v_id, v_site, v_num, CASE WHEN v_site IS NULL THEN coalesce(p_order ->> 'routeReason', 'unrouted') END,
            CASE WHEN v_site IS NOT NULL THEN pg_catalog.now() END)
    ON CONFLICT (shop, shopify_order_id) DO NOTHING;
    IF FOUND THEN
      v_route := CASE WHEN v_site IS NULL THEN 'unrouted' ELSE 'routed' END;
    ELSE
      SELECT * INTO r FROM public.order_timeline_orders o WHERE o.shop = v_shop AND o.shopify_order_id = v_id FOR UPDATE;
      v_route := 'unchanged';
      IF r.order_number IS NULL AND v_num IS NOT NULL THEN
        UPDATE public.order_timeline_orders o SET order_number = v_num WHERE o.shop = v_shop AND o.shopify_order_id = v_id;
      ELSIF v_num IS NOT NULL AND r.order_number <> v_num THEN
        v_route := 'conflict';
      END IF;
      IF r.site IS NULL AND v_site IS NOT NULL THEN
        UPDATE public.order_timeline_orders o SET site = v_site, routed_at = pg_catalog.now(), route_reason = NULL WHERE o.shop = v_shop AND o.shopify_order_id = v_id;
        IF v_route = 'unchanged' THEN v_route := 'routed'; END IF;
      ELSIF r.site IS NOT NULL AND v_site IS NOT NULL AND r.site <> v_site THEN
        v_route := 'conflict';
      ELSIF r.site IS NULL AND v_route = 'unchanged' THEN
        UPDATE public.order_timeline_orders o SET route_reason = coalesce(p_order ->> 'routeReason', o.route_reason) WHERE o.shop = v_shop AND o.shopify_order_id = v_id;
        v_route := 'unrouted';
      END IF;
      IF v_route = 'conflict' THEN
        UPDATE public.order_timeline_orders o SET route_conflicts = o.route_conflicts + 1 WHERE o.shop = v_shop AND o.shopify_order_id = v_id;
      END IF;
    END IF;
  END IF;

  FOR e IN SELECT x.value FROM pg_catalog.jsonb_array_elements(p_evidence) x LOOP
    IF pg_catalog.jsonb_typeof(e) <> 'object' THEN RAISE EXCEPTION 'ingest_order_timeline: each record must be an object'; END IF;
    IF coalesce(e ->> 'happenedAt', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN
      RAISE EXCEPTION 'ingest_order_timeline: happenedAt must be an explicit UTC/offset instant';
    END IF;
    n.source := e ->> 'source';
    n.occurrence_key := e ->> 'key';
    n.site := e ->> 'site';
    n.shop := e ->> 'shop';
    n.shopify_order_id := e ->> 'shopifyOrderId';
    n.order_number := e ->> 'orderNumber';
    n.stage := e ->> 'stage';
    n.kind := e ->> 'kind';
    n.happened_at := (e ->> 'happenedAt')::timestamptz;
    n.fulfillment_id := e ->> 'fulfillmentId';
    n.fulfillment_complete := (e ->> 'fulfillmentComplete')::boolean;
    n.work_type := e ->> 'workType';
    n.framing_complete := (e ->> 'framingComplete')::boolean;
    n.case_id := e ->> 'caseId';
    n.batch_id := e ->> 'batchId';
    n.retracts_key := e ->> 'retractsKey';
    IF n.shop IS NOT NULL AND n.shopify_order_id IS NOT NULL THEN
      -- a fact may arrive before its order: an unrouted identity stub waits for routing
      INSERT INTO public.order_timeline_orders (shop, shopify_order_id, route_reason) VALUES (n.shop, n.shopify_order_id, 'awaiting order routing')
      ON CONFLICT (shop, shopify_order_id) DO NOTHING;
    END IF;
    INSERT INTO public.order_timeline_evidence (source, occurrence_key, site, shop, shopify_order_id, order_number, stage, kind, happened_at,
                                                fulfillment_id, fulfillment_complete, work_type, framing_complete, case_id, batch_id, retracts_key)
    VALUES (n.source, n.occurrence_key, n.site, n.shop, n.shopify_order_id, n.order_number, n.stage, n.kind, n.happened_at,
            n.fulfillment_id, n.fulfillment_complete, n.work_type, n.framing_complete, n.case_id, n.batch_id, n.retracts_key)
    ON CONFLICT (source, occurrence_key) DO NOTHING;
    IF FOUND THEN
      v_acc := v_acc + 1;
    ELSE
      SELECT * INTO prev FROM public.order_timeline_evidence x WHERE x.source = n.source AND x.occurrence_key = n.occurrence_key;
      IF prev.site IS NOT DISTINCT FROM n.site AND prev.shop IS NOT DISTINCT FROM n.shop AND prev.shopify_order_id IS NOT DISTINCT FROM n.shopify_order_id
         AND prev.order_number IS NOT DISTINCT FROM n.order_number AND prev.stage = n.stage AND prev.kind = n.kind AND prev.happened_at = n.happened_at
         AND prev.fulfillment_id IS NOT DISTINCT FROM n.fulfillment_id AND prev.fulfillment_complete IS NOT DISTINCT FROM n.fulfillment_complete
         AND prev.work_type IS NOT DISTINCT FROM n.work_type AND prev.framing_complete IS NOT DISTINCT FROM n.framing_complete
         AND prev.case_id IS NOT DISTINCT FROM n.case_id AND prev.batch_id IS NOT DISTINCT FROM n.batch_id
         AND prev.retracts_key IS NOT DISTINCT FROM n.retracts_key THEN
        v_dup := v_dup + 1;
      ELSE
        v_conf := v_conf + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('accepted', v_acc, 'duplicates', v_dup, 'conflicts', v_conf, 'route', v_route);
END
$fn$;

-- Evidence rows as compact arrays:
-- [source, key, stage, kind, happenedAt, receivedAt, fulfillmentId, fulfillmentComplete, workType, framingComplete, caseId, batchId,
--  shop, shopifyOrderId, orderNumber, site, retractsKey]
CREATE FUNCTION public.order_timeline_row(x public.order_timeline_evidence)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT pg_catalog.jsonb_build_array(x.source, x.occurrence_key, x.stage, x.kind, public.order_timeline_utc(x.happened_at), public.order_timeline_utc(x.received_at),
    x.fulfillment_id, x.fulfillment_complete, x.work_type, x.framing_complete, x.case_id, x.batch_id, x.shop, x.shopify_order_id, x.order_number, x.site, x.retracts_key)
$fn$;
REVOKE ALL ON FUNCTION public.order_timeline_row(public.order_timeline_evidence) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_timeline_row(public.order_timeline_evidence) TO service_role;

-- Service-only: ONE order at one site by its order number. The routed identity (if any) plus its Shopify
-- evidence, and app/make evidence recorded for that site under that number (never another identity's or
-- another site's). Ambiguous numbers and more than p_limit rows are errors, never a partial history.
CREATE FUNCTION public.read_order_timeline(p_site text, p_order_number text, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_n    integer;
  v_shop text;
  v_id   text;
  v_cnt  bigint;
  v_rows jsonb;
BEGIN
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN RAISE EXCEPTION 'read_order_timeline: unsupported site'; END IF;
  IF p_order_number IS NULL OR pg_catalog.length(p_order_number) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'read_order_timeline: order number must be 1..64 characters'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 2000 THEN RAISE EXCEPTION 'read_order_timeline: limit must be 1..2000'; END IF;
  SELECT count(*), min(o.shop), min(o.shopify_order_id) INTO v_n, v_shop, v_id
    FROM (SELECT o.shop, o.shopify_order_id FROM public.order_timeline_orders o WHERE o.site = p_site AND o.order_number = p_order_number LIMIT 2) o;
  IF v_n > 1 THEN RAISE EXCEPTION 'read_order_timeline: ambiguous order number at this site'; END IF;
  WITH ev AS (
    SELECT x.* FROM public.order_timeline_evidence x
     WHERE v_n = 1 AND x.shop = v_shop AND x.shopify_order_id = v_id AND (x.site IS NULL OR x.site = p_site)
    UNION
    SELECT x.* FROM public.order_timeline_evidence x
     WHERE x.site = p_site AND x.order_number = p_order_number
       AND (x.shopify_order_id IS NULL OR (v_n = 1 AND x.shop = v_shop AND x.shopify_order_id = v_id))
  ), lim AS (SELECT count(*) AS c FROM (SELECT 1 FROM ev LIMIT p_limit + 1) z)
  SELECT lim.c, CASE WHEN lim.c > p_limit THEN NULL ELSE
           (SELECT coalesce(pg_catalog.jsonb_agg(public.order_timeline_row(ev) ORDER BY ev.happened_at, ev.source, ev.occurrence_key), '[]'::jsonb) FROM ev) END
    INTO v_cnt, v_rows FROM lim;
  IF v_cnt > p_limit THEN RAISE EXCEPTION 'read_order_timeline: more than % rows exceed the limit %', p_limit, p_limit; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'identity', CASE WHEN v_n = 1 THEN pg_catalog.jsonb_build_object('shop', v_shop, 'shopifyOrderId', v_id, 'orderNumber', p_order_number) END,
    'evidence', v_rows);
END
$fn$;

-- Service-only: the site's RECORDED orders with confirmed-or-not Shopify "ordered" evidence in [p_start, p_end)
-- (at most 93 days), with all of their evidence. Refuses above p_order_limit orders or p_row_limit rows.
-- Also returns per-source latest receipt (freshness) and the count of unrouted orders (capped at 10000).
CREATE FUNCTION public.read_order_flow(p_site text, p_start timestamptz, p_end timestamptz, p_order_limit integer, p_row_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_orders bigint;
  v_shops  text[];
  v_ids    text[];
  v_nums   text[];
  v_cnt    bigint;
  v_rows   jsonb;
BEGIN
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN RAISE EXCEPTION 'read_order_flow: unsupported site'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '93 days' THEN RAISE EXCEPTION 'read_order_flow: window must be 1 second to 93 days'; END IF;
  IF p_order_limit IS NULL OR p_order_limit < 1 OR p_order_limit > 5000 THEN RAISE EXCEPTION 'read_order_flow: order limit must be 1..5000'; END IF;
  IF p_row_limit IS NULL OR p_row_limit < 1 OR p_row_limit > 100000 THEN RAISE EXCEPTION 'read_order_flow: row limit must be 1..100000'; END IF;
  SELECT count(*), coalesce(array_agg(c.shop), '{}'), coalesce(array_agg(c.shopify_order_id), '{}'), coalesce(array_agg(c.order_number), '{}')
    INTO v_orders, v_shops, v_ids, v_nums
    FROM (SELECT DISTINCT o.shop, o.shopify_order_id, o.order_number
            FROM public.order_timeline_evidence x
            JOIN public.order_timeline_orders o ON o.shop = x.shop AND o.shopify_order_id = x.shopify_order_id
           WHERE x.source = 'shopify' AND x.stage = 'ordered' AND x.happened_at >= p_start AND x.happened_at < p_end AND o.site = p_site
           LIMIT p_order_limit + 1) c;
  IF v_orders > p_order_limit THEN RAISE EXCEPTION 'read_order_flow: more than % orders exceed the limit %', p_order_limit, p_order_limit; END IF;
  WITH cohort AS (
    SELECT u.shop, u.shopify_order_id, u.order_number FROM unnest(v_shops, v_ids, v_nums) AS u(shop, shopify_order_id, order_number)
  ), ev AS (
    SELECT x.* FROM public.order_timeline_evidence x JOIN cohort c ON x.shop = c.shop AND x.shopify_order_id = c.shopify_order_id
     WHERE x.site IS NULL OR x.site = p_site
    UNION
    SELECT x.* FROM public.order_timeline_evidence x JOIN cohort c ON x.order_number = c.order_number
     WHERE x.site = p_site AND x.shopify_order_id IS NULL
       -- app-only facts attach by number only when exactly ONE recorded order at this site (any date) uses it,
       -- the same rule as read_order_timeline
       AND (SELECT count(*) FROM (SELECT 1 FROM public.order_timeline_orders o2
                                   WHERE o2.site = p_site AND o2.order_number = c.order_number LIMIT 2) z) = 1
  ), lim AS (SELECT count(*) AS c FROM (SELECT 1 FROM ev LIMIT p_row_limit + 1) z)
  SELECT lim.c, CASE WHEN lim.c > p_row_limit THEN NULL ELSE
           (SELECT coalesce(pg_catalog.jsonb_agg(public.order_timeline_row(ev) ORDER BY ev.shopify_order_id, ev.happened_at, ev.source, ev.occurrence_key), '[]'::jsonb) FROM ev) END
    INTO v_cnt, v_rows FROM lim;
  IF v_cnt > p_row_limit THEN RAISE EXCEPTION 'read_order_flow: more than % rows exceed the limit %', p_row_limit, p_row_limit; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'orders', v_orders,
    'evidence', v_rows,
    'latestReceivedAt', pg_catalog.jsonb_build_object(
      'shopify', (SELECT public.order_timeline_utc(max(x.received_at)) FROM public.order_timeline_evidence x WHERE x.source = 'shopify'),
      'app', (SELECT public.order_timeline_utc(max(x.received_at)) FROM public.order_timeline_evidence x WHERE x.source = 'app'),
      'make', (SELECT public.order_timeline_utc(max(x.received_at)) FROM public.order_timeline_evidence x WHERE x.source = 'make')),
    'unroutedOrders', (SELECT count(*) FROM (SELECT 1 FROM public.order_timeline_orders o WHERE o.site IS NULL LIMIT 10000) u));
END
$fn$;

-- Service-only, explicit and bounded: copy ONE order's recorded app evidence for ONE site (event location =
-- p_site, never a reassignment). Completed framing work (framed / a0_framed) becomes per-work-type framed
-- evidence (never whole-order proof); dispatched becomes dispatched. A scan cancellation of one of those events
-- becomes a RETRACTION of that exact occurrence, timed at the cancellation, so a copy made before the cancel is
-- revoked by the next reconcile. One scan's cancellation is never an order cancellation.
-- Idempotent through occurrence keys "<site>/<event id>". Reads production_events only; writes nothing there.
CREATE FUNCTION public.reconcile_order_timeline_app(p_site text, p_order_number text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_n    bigint;
  v_list jsonb;
BEGIN
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN RAISE EXCEPTION 'reconcile_order_timeline_app: unsupported site'; END IF;
  IF p_order_number IS NULL OR pg_catalog.length(p_order_number) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'reconcile_order_timeline_app: order number must be 1..64 characters'; END IF;
  SELECT count(*) INTO v_n FROM (SELECT 1 FROM public.production_events pe WHERE pe.location = p_site AND pe.order_number = p_order_number LIMIT 501) z;
  IF v_n > 500 THEN RAISE EXCEPTION 'reconcile_order_timeline_app: more than 500 events exceed the limit 500'; END IF;
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
  RETURN public.ingest_order_timeline(NULL, v_list);
END
$fn$;

REVOKE ALL ON FUNCTION public.ingest_order_timeline(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_order_timeline(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_order_flow(text, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_order_timeline_app(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_order_timeline(jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_order_timeline(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_order_flow(text, timestamptz, timestamptz, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_order_timeline_app(text, text) TO service_role;

COMMIT;
