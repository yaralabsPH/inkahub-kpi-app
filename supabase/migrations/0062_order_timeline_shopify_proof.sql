-- 0062_order_timeline_shopify_proof.sql — F10 Task 3b: bounded current-source whole-order shipment/delivery proof.
--
-- The proof itself is computed in the API from ONE read-only Shopify snapshot (see wholeOrderProof in
-- api/_lib/shopify-webhooks.ts). This migration only makes applying it safe:
--
-- * public.order_timeline_proof_state: one row per immutable Shopify identity (shop, shopify_order_id) holding
--   a generation counter (the fence), the proof revision, the canonical proof hash and the two ACTIVE evidence
--   keys. Only identity, counters, a hash and pointers: no customer data. Service-only (RLS on, no browser
--   privileges).
-- * order_timeline_proof_begin(shop, id): increments the generation BEFORE the proof snapshot is fetched and
--   returns it as the ticket. Creates the identity stub if needed (as ingestion does).
-- * order_timeline_proof_apply(shop, id, ticket, order, evidence, proof): under the identity row lock. A ticket
--   that is not the current generation changes NOTHING (returns proof 'stale'). Otherwise, in one transaction:
--   base Shopify facts are ingested (0059 ingest), then the proof transitions:
--     - same canonical hash as the active proof: unchanged (duplicate, no evidence);
--     - otherwise any active whole-shipped/whole-delivered keys are retracted at THIS transaction's time (the
--       first observation of the change; never backdated), and a present proof is appended under fresh
--       immutable revision keys 'order:<id>:whole-shipped:r<N>' / 'order:<id>:whole-delivered:r<N>'.
--       A -> unknown -> A therefore gets a new revision; a withdrawn key is never reused.
--   A proof is only accepted while the order is routed and this ingestion reported no route conflict;
--   otherwise it is treated as absent (conservative downgrade). Proof null = latest refresh found no proof
--   (or failed): withdraws an active proof, adds nothing when already empty.
-- * ingest_order_timeline_webhook(order, evidence): the webhook path. Ingests base facts and, atomically,
--   increments the generation (so any refresh fetched before it is stale) and withdraws an active proof.
--   Webhooks never create, promote or resurrect proof; repeated webhooks on empty state add no evidence.
--
-- All functions: SECURITY INVOKER, empty search_path, EXECUTE for service_role only. Bounded: one identity per
-- call, the 200-record ingest limit applies to every batch.
-- Rollback: stop calling these functions (previous API deployment). The table and evidence are additive and
-- immutable evidence is retained. Not applied by an agent; Codex/CJ apply it to staging only.

BEGIN;

CREATE TABLE public.order_timeline_proof_state (
  shop             text    NOT NULL,
  shopify_order_id text    NOT NULL,
  generation       bigint  NOT NULL DEFAULT 0 CHECK (generation >= 0),
  proof_revision   integer NOT NULL DEFAULT 0 CHECK (proof_revision >= 0),
  proof_hash       text    CHECK (proof_hash IS NULL OR proof_hash ~ '^[0-9a-f]{64}$'),
  shipped_key      text    CHECK (shipped_key IS NULL OR pg_catalog.length(shipped_key) BETWEEN 1 AND 200),
  delivered_key    text    CHECK (delivered_key IS NULL OR pg_catalog.length(delivered_key) BETWEEN 1 AND 200),
  PRIMARY KEY (shop, shopify_order_id),
  FOREIGN KEY (shop, shopify_order_id) REFERENCES public.order_timeline_orders (shop, shopify_order_id) ON DELETE RESTRICT,
  CHECK ((proof_hash IS NULL) = (shipped_key IS NULL)),
  CHECK (delivered_key IS NULL OR shipped_key IS NOT NULL)
);
ALTER TABLE public.order_timeline_proof_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.order_timeline_proof_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.order_timeline_proof_state TO service_role;

-- Identity row (and its order stub), locked for the rest of the transaction.
CREATE FUNCTION public.order_timeline_proof_lock_(p_shop text, p_id text)
RETURNS public.order_timeline_proof_state
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  s public.order_timeline_proof_state;
BEGIN
  IF p_shop IS NULL OR p_shop !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' OR p_id IS NULL OR p_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'order timeline proof: invalid identity';
  END IF;
  INSERT INTO public.order_timeline_orders (shop, shopify_order_id, route_reason) VALUES (p_shop, p_id, 'awaiting order routing')
  ON CONFLICT (shop, shopify_order_id) DO NOTHING;
  INSERT INTO public.order_timeline_proof_state (shop, shopify_order_id) VALUES (p_shop, p_id)
  ON CONFLICT (shop, shopify_order_id) DO NOTHING;
  SELECT * INTO s FROM public.order_timeline_proof_state x WHERE x.shop = p_shop AND x.shopify_order_id = p_id FOR UPDATE;
  RETURN s;
END
$fn$;

-- Retract the active proof keys (if any) at this transaction's time and clear them. Returns ingest counts.
CREATE FUNCTION public.order_timeline_proof_withdraw_(s public.order_timeline_proof_state)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_num  text;
  v_list jsonb := '[]'::jsonb;
  v_at   text := public.order_timeline_utc(pg_catalog.now());
BEGIN
  IF s.shipped_key IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('accepted', 0, 'duplicates', 0, 'conflicts', 0);
  END IF;
  SELECT o.order_number INTO v_num FROM public.order_timeline_orders o WHERE o.shop = s.shop AND o.shopify_order_id = s.shopify_order_id;
  v_list := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'source', 'shopify', 'key', s.shipped_key || ':withdrawn', 'site', NULL, 'shop', s.shop, 'shopifyOrderId', s.shopify_order_id,
    'orderNumber', v_num, 'stage', 'shipped', 'kind', 'confirmed', 'happenedAt', v_at, 'retractsKey', s.shipped_key));
  IF s.delivered_key IS NOT NULL THEN
    v_list := v_list || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'source', 'shopify', 'key', s.delivered_key || ':withdrawn', 'site', NULL, 'shop', s.shop, 'shopifyOrderId', s.shopify_order_id,
      'orderNumber', v_num, 'stage', 'delivered', 'kind', 'confirmed', 'happenedAt', v_at, 'retractsKey', s.delivered_key));
  END IF;
  UPDATE public.order_timeline_proof_state x SET proof_hash = NULL, shipped_key = NULL, delivered_key = NULL
   WHERE x.shop = s.shop AND x.shopify_order_id = s.shopify_order_id;
  RETURN public.ingest_order_timeline(NULL, v_list);
END
$fn$;

CREATE FUNCTION public.order_timeline_proof_begin(p_shop text, p_shopify_order_id text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  s     public.order_timeline_proof_state := public.order_timeline_proof_lock_(p_shop, p_shopify_order_id);
  v_gen bigint;
BEGIN
  UPDATE public.order_timeline_proof_state x SET generation = x.generation + 1
   WHERE x.shop = s.shop AND x.shopify_order_id = s.shopify_order_id
   RETURNING x.generation INTO v_gen;
  RETURN v_gen;
END
$fn$;

CREATE FUNCTION public.order_timeline_proof_apply(p_shop text, p_shopify_order_id text, p_ticket bigint, p_order jsonb, p_evidence jsonb, p_proof jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  s       public.order_timeline_proof_state := public.order_timeline_proof_lock_(p_shop, p_shopify_order_id);
  v_base  jsonb;
  v_proof jsonb := p_proof;
  v_site  text;
  v_w     jsonb;
  v_add   jsonb;
  v_list  jsonb;
  v_rev   integer;
  v_skey  text;
  v_dkey  text;
  v_state text;
  v_num   text;
  e       jsonb;
BEGIN
  IF p_ticket IS NULL OR s.generation <> p_ticket THEN
    RETURN pg_catalog.jsonb_build_object('accepted', 0, 'duplicates', 0, 'conflicts', 0, 'route', 'none', 'proof', 'stale');
  END IF;
  -- base facts must all belong to this identity (never another order)
  IF p_order IS NOT NULL AND (p_order ->> 'shop' IS DISTINCT FROM p_shop OR p_order ->> 'shopifyOrderId' IS DISTINCT FROM p_shopify_order_id) THEN
    RAISE EXCEPTION 'order timeline proof: order identity mismatch';
  END IF;
  IF p_evidence IS NULL OR pg_catalog.jsonb_typeof(p_evidence) <> 'array' THEN RAISE EXCEPTION 'order timeline proof: evidence must be an array'; END IF;
  FOR e IN SELECT x.value FROM pg_catalog.jsonb_array_elements(p_evidence) x LOOP
    IF e ->> 'source' IS DISTINCT FROM 'shopify' OR e ->> 'shop' IS DISTINCT FROM p_shop OR e ->> 'shopifyOrderId' IS DISTINCT FROM p_shopify_order_id THEN
      RAISE EXCEPTION 'order timeline proof: evidence identity mismatch';
    END IF;
  END LOOP;
  v_base := public.ingest_order_timeline(p_order, p_evidence);

  IF v_proof IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(v_proof) <> 'object' OR coalesce(v_proof ->> 'hash', '') !~ '^[0-9a-f]{64}$'
       OR coalesce(v_proof ->> 'shippedAt', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
       OR (v_proof ? 'deliveredAt' AND pg_catalog.jsonb_typeof(v_proof -> 'deliveredAt') <> 'null'
           AND coalesce(v_proof ->> 'deliveredAt', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$') THEN
      RAISE EXCEPTION 'order timeline proof: malformed proof';
    END IF;
    -- a whole proof only for a routed order whose routing this read did not contradict
    SELECT o.site, o.order_number INTO v_site, v_num FROM public.order_timeline_orders o WHERE o.shop = p_shop AND o.shopify_order_id = p_shopify_order_id;
    IF v_site IS NULL OR v_base ->> 'route' = 'conflict' THEN v_proof := NULL; END IF;
  END IF;

  IF v_proof IS NOT NULL AND s.proof_hash = v_proof ->> 'hash' THEN
    v_state := 'unchanged';
    v_w := pg_catalog.jsonb_build_object('accepted', 0, 'duplicates', 0, 'conflicts', 0);
  ELSE
    v_state := CASE WHEN s.shipped_key IS NULL THEN 'none' ELSE 'withdrawn' END;
    v_w := public.order_timeline_proof_withdraw_(s);
    IF v_proof IS NOT NULL THEN
      v_rev := s.proof_revision + 1;
      v_skey := 'order:' || p_shopify_order_id || ':whole-shipped:r' || v_rev;
      v_dkey := CASE WHEN pg_catalog.jsonb_typeof(v_proof -> 'deliveredAt') = 'string' THEN 'order:' || p_shopify_order_id || ':whole-delivered:r' || v_rev END;
      v_list := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'source', 'shopify', 'key', v_skey, 'site', NULL, 'shop', p_shop, 'shopifyOrderId', p_shopify_order_id, 'orderNumber', v_num,
        'stage', 'shipped', 'kind', 'confirmed', 'happenedAt', v_proof ->> 'shippedAt', 'fulfillmentComplete', true));
      IF v_dkey IS NOT NULL THEN
        v_list := v_list || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'source', 'shopify', 'key', v_dkey, 'site', NULL, 'shop', p_shop, 'shopifyOrderId', p_shopify_order_id, 'orderNumber', v_num,
          'stage', 'delivered', 'kind', 'confirmed', 'happenedAt', v_proof ->> 'deliveredAt', 'fulfillmentComplete', true));
      END IF;
      v_add := public.ingest_order_timeline(NULL, v_list);
      IF (v_add ->> 'accepted')::integer <> pg_catalog.jsonb_array_length(v_list) THEN
        RAISE EXCEPTION 'order timeline proof: revision key already used';
      END IF;
      UPDATE public.order_timeline_proof_state x SET proof_revision = v_rev, proof_hash = v_proof ->> 'hash', shipped_key = v_skey, delivered_key = v_dkey
       WHERE x.shop = p_shop AND x.shopify_order_id = p_shopify_order_id;
      v_w := pg_catalog.jsonb_build_object('accepted', (v_w ->> 'accepted')::integer + (v_add ->> 'accepted')::integer,
               'duplicates', (v_w ->> 'duplicates')::integer, 'conflicts', (v_w ->> 'conflicts')::integer);
      v_state := 'proven';
    END IF;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'accepted', (v_base ->> 'accepted')::integer + (v_w ->> 'accepted')::integer,
    'duplicates', (v_base ->> 'duplicates')::integer + (v_w ->> 'duplicates')::integer,
    'conflicts', (v_base ->> 'conflicts')::integer + (v_w ->> 'conflicts')::integer,
    'route', v_base ->> 'route', 'proof', v_state);
END
$fn$;

CREATE FUNCTION public.ingest_order_timeline_webhook(p_order jsonb, p_evidence jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_shop text := p_order ->> 'shop';
  v_id   text := p_order ->> 'shopifyOrderId';
  s      public.order_timeline_proof_state;
  v_base jsonb;
  v_w    jsonb;
BEGIN
  IF p_order IS NULL OR pg_catalog.jsonb_typeof(p_order) <> 'object' THEN RAISE EXCEPTION 'order timeline webhook: order identity required'; END IF;
  s := public.order_timeline_proof_lock_(v_shop, v_id);
  v_base := public.ingest_order_timeline(p_order, p_evidence);
  -- fence: any refresh that fetched before this webhook is now stale
  UPDATE public.order_timeline_proof_state x SET generation = x.generation + 1 WHERE x.shop = v_shop AND x.shopify_order_id = v_id;
  v_w := public.order_timeline_proof_withdraw_(s);
  RETURN pg_catalog.jsonb_build_object(
    'accepted', (v_base ->> 'accepted')::integer + (v_w ->> 'accepted')::integer,
    'duplicates', (v_base ->> 'duplicates')::integer + (v_w ->> 'duplicates')::integer,
    'conflicts', (v_base ->> 'conflicts')::integer + (v_w ->> 'conflicts')::integer,
    'route', v_base ->> 'route', 'proofWithdrawn', s.shipped_key IS NOT NULL);
END
$fn$;

REVOKE ALL ON FUNCTION public.order_timeline_proof_lock_(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_timeline_proof_withdraw_(public.order_timeline_proof_state) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_timeline_proof_begin(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_timeline_proof_apply(text, text, bigint, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingest_order_timeline_webhook(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_timeline_proof_lock_(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_timeline_proof_withdraw_(public.order_timeline_proof_state) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_timeline_proof_begin(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_timeline_proof_apply(text, text, bigint, jsonb, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_order_timeline_webhook(jsonb, jsonb) TO service_role;

COMMIT;
