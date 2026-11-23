-- 0060_make_milestones.sql
--
-- F11 Automation progress (append-only after 0059; 0048-0051 stay reserved for F3).
-- Additive only: three tables and three service-only functions. No change to
-- printing, scanning, inventory or the F10 tables' shape; attached milestones
-- are written through F10's public.ingest_order_timeline as source 'make'.
--
-- One authenticated report per Make part arrives as an envelope (stage,
-- occurrenceId, happenedAt, batchId, membershipVersion, members). The API
-- supplies site/shop/scope from the authenticated connector scope only.
--
-- 1. make_milestone_occurrences: immutable original envelopes, unique per
--    (site, shop, occurrence_id). Same id + same canonical content =
--    duplicate (harmless retry); different content = conflict, nothing written.
-- 2. make_milestone_members: Part 1 ("submitted") defines the membership of
--    ONE (batch, membership_version): stable member keys with their display
--    order-number aliases. A second occurrence cannot redefine that version.
--    Part 2 ("files_found") maps member keys to immutable Shopify order ids.
--    Identity fields never change; status records resolution: unresolved,
--    resolved, or fail-closed ambiguous / site_conflict / alias_conflict /
--    mapping_conflict (sticky).
-- 3. make_milestone_refs: each envelope's successful subset (member keys of the
--    SAME batch/version). pending until the member resolves; attached once the
--    milestone is written to the order timeline; not_member / blocked fail
--    closed. Nothing is ever attached to a guessed or arbitrary order.
-- Resolution runs inside the same transaction as each envelope, so events that
-- arrive before their membership or mapping attach atomically when it arrives.
-- An existing canonical order routed to another site is never reassigned or
-- attached; an unrouted order is routed once to the scope's site (F10 spec:
-- explicit Make membership may supply the location).

BEGIN;

CREATE TABLE public.make_milestone_occurrences (
  site               text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  shop               text        NOT NULL CHECK (shop ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  occurrence_id      text        NOT NULL CHECK (occurrence_id ~ '^[A-Za-z0-9._:#/-]{1,120}$'),
  scope              text        NOT NULL CHECK (pg_catalog.length(scope) BETWEEN 1 AND 64),
  stage              text        NOT NULL CHECK (stage IN ('submitted', 'files_found', 'planned', 'images_ready', 'packing_slips_ready')),
  happened_at        timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT pg_catalog.now(),
  batch_id           text        NOT NULL CHECK (batch_id ~ '^[A-Za-z0-9._:#/-]{1,100}$'),
  membership_version integer     NOT NULL CHECK (membership_version BETWEEN 1 AND 1000000),
  content            jsonb       NOT NULL,
  PRIMARY KEY (site, shop, occurrence_id)
);
CREATE INDEX make_milestone_occurrences_batch ON public.make_milestone_occurrences (site, shop, batch_id, membership_version);

CREATE TABLE public.make_milestone_members (
  site               text    NOT NULL,
  shop               text    NOT NULL,
  batch_id           text    NOT NULL,
  membership_version integer NOT NULL,
  member_key         text    NOT NULL CHECK (member_key ~ '^[A-Za-z0-9._:#/-]{1,64}$'),
  order_number       text    NOT NULL CHECK (pg_catalog.length(order_number) BETWEEN 1 AND 64),
  defined_by         text    NOT NULL,
  shopify_order_id   text    CHECK (shopify_order_id IS NULL OR shopify_order_id ~ '^[0-9]{1,20}$'),
  status             text    NOT NULL DEFAULT 'unresolved'
                             CHECK (status IN ('unresolved', 'resolved', 'ambiguous', 'site_conflict', 'alias_conflict', 'mapping_conflict')),
  PRIMARY KEY (site, shop, batch_id, membership_version, member_key),
  FOREIGN KEY (site, shop, defined_by) REFERENCES public.make_milestone_occurrences (site, shop, occurrence_id) ON DELETE RESTRICT
);

CREATE TABLE public.make_milestone_refs (
  site             text NOT NULL,
  shop             text NOT NULL,
  occurrence_id    text NOT NULL,
  member_key       text NOT NULL CHECK (member_key ~ '^[A-Za-z0-9._:#/-]{1,64}$'),
  shopify_order_id text CHECK (shopify_order_id IS NULL OR shopify_order_id ~ '^[0-9]{1,20}$'),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached', 'not_member', 'blocked')),
  PRIMARY KEY (site, shop, occurrence_id, member_key),
  FOREIGN KEY (site, shop, occurrence_id) REFERENCES public.make_milestone_occurrences (site, shop, occurrence_id) ON DELETE RESTRICT
);

ALTER TABLE public.make_milestone_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.make_milestone_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.make_milestone_refs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.make_milestone_occurrences FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.make_milestone_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.make_milestone_refs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.make_milestone_occurrences TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.make_milestone_members TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.make_milestone_refs TO service_role;

-- Occurrences never change; member identity fields never change (only status and a first mapping).
CREATE FUNCTION public.make_milestone_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' OR TG_TABLE_NAME = 'make_milestone_occurrences' THEN
    RAISE EXCEPTION 'make milestone history is immutable';
  END IF;
  IF TG_TABLE_NAME = 'make_milestone_members' THEN
    IF NEW.site <> OLD.site OR NEW.shop <> OLD.shop OR NEW.batch_id <> OLD.batch_id OR NEW.membership_version <> OLD.membership_version
       OR NEW.member_key <> OLD.member_key OR NEW.order_number <> OLD.order_number OR NEW.defined_by <> OLD.defined_by
       OR (OLD.shopify_order_id IS NOT NULL AND NEW.shopify_order_id IS DISTINCT FROM OLD.shopify_order_id) THEN
      RAISE EXCEPTION 'make milestone membership identity is immutable';
    END IF;
  ELSIF NEW.site <> OLD.site OR NEW.shop <> OLD.shop OR NEW.occurrence_id <> OLD.occurrence_id OR NEW.member_key <> OLD.member_key
        OR NEW.shopify_order_id IS DISTINCT FROM OLD.shopify_order_id THEN
    RAISE EXCEPTION 'make milestone references are immutable';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER make_milestone_occurrences_guard BEFORE UPDATE OR DELETE ON public.make_milestone_occurrences FOR EACH ROW EXECUTE FUNCTION public.make_milestone_guard();
CREATE TRIGGER make_milestone_members_guard BEFORE UPDATE OR DELETE ON public.make_milestone_members FOR EACH ROW EXECUTE FUNCTION public.make_milestone_guard();
CREATE TRIGGER make_milestone_refs_guard BEFORE UPDATE OR DELETE ON public.make_milestone_refs FOR EACH ROW EXECUTE FUNCTION public.make_milestone_guard();
REVOKE ALL ON FUNCTION public.make_milestone_guard() FROM PUBLIC, anon, authenticated;

-- Resolve one (batch, version) inside the caller's transaction. Internal (service only).
CREATE FUNCTION public.make_milestone_resolve(p_site text, p_shop text, p_batch text, p_version integer)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  mem  public.make_milestone_members;
  o    public.order_timeline_orders;
  v_ev jsonb;
  v_r  jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.make_milestone_members m
                  WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version) THEN
    RETURN; -- membership not known yet: every reference stays pending (durable)
  END IF;

  -- a successful subset may only name members of the SAME batch/version
  UPDATE public.make_milestone_refs r SET status = 'not_member'
    FROM public.make_milestone_occurrences oc
   WHERE r.site = oc.site AND r.shop = oc.shop AND r.occurrence_id = oc.occurrence_id
     AND oc.site = p_site AND oc.shop = p_shop AND oc.batch_id = p_batch AND oc.membership_version = p_version
     AND r.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM public.make_milestone_members m
                      WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version AND m.member_key = r.member_key);

  -- explicit Part 2 mappings: every (member, order id) pair ever stated for this batch/version
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.make_pairs (member_key text, shopify_order_id text) ON COMMIT DROP;
  TRUNCATE pg_temp.make_pairs;
  INSERT INTO pg_temp.make_pairs
  SELECT DISTINCT r.member_key, r.shopify_order_id
    FROM public.make_milestone_refs r
    JOIN public.make_milestone_occurrences oc ON oc.site = r.site AND oc.shop = r.shop AND oc.occurrence_id = r.occurrence_id
   WHERE oc.site = p_site AND oc.shop = p_shop AND oc.batch_id = p_batch AND oc.membership_version = p_version
     AND r.shopify_order_id IS NOT NULL AND r.status <> 'not_member'
  UNION
  SELECT m.member_key, m.shopify_order_id FROM public.make_milestone_members m
   WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version AND m.shopify_order_id IS NOT NULL;

  -- one member stated with two order ids: mapping conflict (sticky; an existing mapping is kept)
  UPDATE public.make_milestone_members m SET status = 'mapping_conflict'
   WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version
     AND m.status IN ('unresolved', 'resolved')
     AND (SELECT count(DISTINCT p.shopify_order_id) FROM pg_temp.make_pairs p WHERE p.member_key = m.member_key) > 1;
  -- one order id stated for two members: ambiguous (sticky)
  UPDATE public.make_milestone_members m SET status = 'ambiguous'
   WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version
     AND m.status IN ('unresolved', 'resolved')
     AND EXISTS (SELECT 1 FROM pg_temp.make_pairs p JOIN pg_temp.make_pairs q ON q.shopify_order_id = p.shopify_order_id AND q.member_key <> p.member_key
                  WHERE p.member_key = m.member_key);
  -- single unambiguous mapping: recorded once
  UPDATE public.make_milestone_members m SET shopify_order_id = p.shopify_order_id
    FROM pg_temp.make_pairs p
   WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version
     AND m.status = 'unresolved' AND m.shopify_order_id IS NULL AND p.member_key = m.member_key;

  -- canonical order checks, then attach pending references of resolved members
  FOR mem IN SELECT * FROM public.make_milestone_members m
              WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version
                AND m.status IN ('unresolved', 'resolved') AND m.shopify_order_id IS NOT NULL
              ORDER BY m.member_key LOOP
    SELECT * INTO o FROM public.order_timeline_orders x WHERE x.shop = p_shop AND x.shopify_order_id = mem.shopify_order_id;
    IF FOUND AND o.site IS NOT NULL AND o.site <> p_site THEN
      UPDATE public.make_milestone_members m SET status = 'site_conflict'
       WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version AND m.member_key = mem.member_key;
      CONTINUE;
    END IF;
    IF FOUND AND o.order_number IS NOT NULL AND o.order_number <> mem.order_number THEN
      UPDATE public.make_milestone_members m SET status = 'alias_conflict'
       WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version AND m.member_key = mem.member_key;
      CONTINUE;
    END IF;
    IF mem.status <> 'resolved' THEN
      UPDATE public.make_milestone_members m SET status = 'resolved'
       WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version AND m.member_key = mem.member_key;
    END IF;
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'source', 'make', 'key', oc.occurrence_id || '|' || r.member_key, 'site', p_site, 'shop', p_shop,
             'shopifyOrderId', mem.shopify_order_id, 'orderNumber', mem.order_number,
             'stage', CASE oc.stage WHEN 'submitted' THEN 'make_submitted' WHEN 'files_found' THEN 'make_files_found' WHEN 'planned' THEN 'make_planned'
                                    WHEN 'images_ready' THEN 'make_images_ready' ELSE 'make_packing_ready' END,
             'kind', 'confirmed', 'happenedAt', public.order_timeline_utc(oc.happened_at), 'batchId', oc.batch_id)
             ORDER BY oc.happened_at, oc.occurrence_id), '[]'::jsonb)
      INTO v_ev
      FROM public.make_milestone_refs r
      JOIN public.make_milestone_occurrences oc ON oc.site = r.site AND oc.shop = r.shop AND oc.occurrence_id = r.occurrence_id
     WHERE oc.site = p_site AND oc.shop = p_shop AND oc.batch_id = p_batch AND oc.membership_version = p_version
       AND r.member_key = mem.member_key AND r.status = 'pending';
    IF pg_catalog.jsonb_array_length(v_ev) = 0 THEN CONTINUE; END IF;
    v_r := public.ingest_order_timeline(
      pg_catalog.jsonb_build_object('shop', p_shop, 'shopifyOrderId', mem.shopify_order_id, 'orderNumber', mem.order_number, 'site', p_site, 'routeReason', NULL),
      v_ev);
    -- a concurrent conflicting route or a changed fact: fail the whole envelope (never acknowledged)
    IF v_r ->> 'route' = 'conflict' OR (v_r ->> 'conflicts')::integer > 0 THEN
      RAISE EXCEPTION 'make_milestone: timeline state conflicts for member %', mem.member_key;
    END IF;
    UPDATE public.make_milestone_refs r SET status = 'attached'
      FROM public.make_milestone_occurrences oc
     WHERE r.site = oc.site AND r.shop = oc.shop AND r.occurrence_id = oc.occurrence_id
       AND oc.site = p_site AND oc.shop = p_shop AND oc.batch_id = p_batch AND oc.membership_version = p_version
       AND r.member_key = mem.member_key AND r.status = 'pending';
  END LOOP;

  -- references of fail-closed members are blocked (unresolved members stay pending)
  UPDATE public.make_milestone_refs r SET status = 'blocked'
    FROM public.make_milestone_occurrences oc, public.make_milestone_members m
   WHERE r.site = oc.site AND r.shop = oc.shop AND r.occurrence_id = oc.occurrence_id
     AND oc.site = p_site AND oc.shop = p_shop AND oc.batch_id = p_batch AND oc.membership_version = p_version
     AND m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version AND m.member_key = r.member_key
     AND m.status IN ('ambiguous', 'site_conflict', 'alias_conflict', 'mapping_conflict') AND r.status = 'pending';
END
$fn$;
REVOKE ALL ON FUNCTION public.make_milestone_resolve(text, text, text, integer) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.make_milestone_counts(p_site text, p_shop text, p_occurrence text, p_batch text, p_version integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $fn$
  SELECT pg_catalog.jsonb_build_object(
    'attached', (SELECT count(*) FROM public.make_milestone_refs r WHERE r.site = p_site AND r.shop = p_shop AND r.occurrence_id = p_occurrence AND r.status = 'attached'),
    'pending', (SELECT count(*) FROM public.make_milestone_refs r WHERE r.site = p_site AND r.shop = p_shop AND r.occurrence_id = p_occurrence AND r.status = 'pending'),
    'blocked', (SELECT count(*) FROM public.make_milestone_refs r WHERE r.site = p_site AND r.shop = p_shop AND r.occurrence_id = p_occurrence AND r.status = 'blocked'),
    'notMember', (SELECT count(*) FROM public.make_milestone_refs r WHERE r.site = p_site AND r.shop = p_shop AND r.occurrence_id = p_occurrence AND r.status = 'not_member'),
    'resolved', (SELECT count(*) FROM public.make_milestone_members m WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version AND m.status = 'resolved'),
    'unresolved', (SELECT count(*) FROM public.make_milestone_members m WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version AND m.status = 'unresolved'),
    'conflicted', (SELECT count(*) FROM public.make_milestone_members m WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch AND m.membership_version = p_version
                     AND m.status IN ('ambiguous', 'site_conflict', 'alias_conflict', 'mapping_conflict')))
$fn$;
REVOKE ALL ON FUNCTION public.make_milestone_counts(text, text, text, text, integer) FROM PUBLIC, anon, authenticated;

-- Service-only. Site/shop/scope come from the API's authenticated connector scope, never from the envelope.
-- Returns {result: accepted|duplicate|conflict, reason, members: counts}. A conflict writes nothing.
-- Any invalid record raises and rolls back the whole envelope.
CREATE FUNCTION public.ingest_make_milestone(p_site text, p_shop text, p_scope text, p_envelope jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_stage   text := p_envelope ->> 'stage';
  v_occ     text := p_envelope ->> 'occurrenceId';
  v_batch   text := p_envelope ->> 'batchId';
  v_ver     integer;
  v_at      timestamptz;
  v_members jsonb := p_envelope -> 'members';
  v_content jsonb;
  prev      public.make_milestone_occurrences;
  m         jsonb;
BEGIN
  IF p_envelope IS NULL OR pg_catalog.jsonb_typeof(p_envelope) <> 'object' THEN RAISE EXCEPTION 'ingest_make_milestone: envelope must be an object'; END IF;
  IF coalesce(p_envelope ->> 'happenedAt', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN
    RAISE EXCEPTION 'ingest_make_milestone: happenedAt must be an explicit UTC/offset instant';
  END IF;
  v_at := (p_envelope ->> 'happenedAt')::timestamptz;
  v_ver := (p_envelope ->> 'membershipVersion')::integer;
  IF v_members IS NULL OR pg_catalog.jsonb_typeof(v_members) <> 'array' OR pg_catalog.jsonb_array_length(v_members) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'ingest_make_milestone: members must be an array of 1..500';
  END IF;
  IF (SELECT count(DISTINCT x.value ->> 'memberKey') FROM pg_catalog.jsonb_array_elements(v_members) x) <> pg_catalog.jsonb_array_length(v_members)
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_members) x WHERE x.value ->> 'memberKey' IS NULL) THEN
    RAISE EXCEPTION 'ingest_make_milestone: member keys must be present and unique';
  END IF;
  -- stage-specific member shapes
  FOR m IN SELECT x.value FROM pg_catalog.jsonb_array_elements(v_members) x LOOP
    IF v_stage = 'submitted' AND (m ->> 'orderNumber' IS NULL OR m ? 'shopifyOrderId') THEN
      RAISE EXCEPTION 'ingest_make_milestone: submitted members need memberKey and orderNumber only';
    ELSIF v_stage = 'files_found' AND (m ->> 'shopifyOrderId' IS NULL OR m ? 'orderNumber') THEN
      RAISE EXCEPTION 'ingest_make_milestone: files_found members need memberKey and shopifyOrderId';
    ELSIF v_stage IN ('planned', 'images_ready', 'packing_slips_ready') AND (m ? 'orderNumber' OR m ? 'shopifyOrderId') THEN
      RAISE EXCEPTION 'ingest_make_milestone: % members carry memberKey only', v_stage;
    END IF;
  END LOOP;
  v_content := pg_catalog.jsonb_build_object('stage', v_stage, 'happenedAt', public.order_timeline_utc(v_at), 'batchId', v_batch, 'membershipVersion', v_ver,
    'members', (SELECT pg_catalog.jsonb_agg(x.value ORDER BY x.value ->> 'memberKey') FROM pg_catalog.jsonb_array_elements(v_members) x));

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('make-milestone|' || p_site || '|' || p_shop || '|' || coalesce(v_batch, '')));
  SELECT * INTO prev FROM public.make_milestone_occurrences x WHERE x.site = p_site AND x.shop = p_shop AND x.occurrence_id = v_occ;
  IF FOUND THEN
    IF prev.content = v_content THEN
      RETURN pg_catalog.jsonb_build_object('result', 'duplicate', 'reason', NULL, 'members', public.make_milestone_counts(p_site, p_shop, v_occ, prev.batch_id, prev.membership_version));
    END IF;
    RETURN pg_catalog.jsonb_build_object('result', 'conflict', 'reason', 'occurrence already recorded with different content', 'members', NULL);
  END IF;
  IF v_stage = 'submitted' AND EXISTS (SELECT 1 FROM public.make_milestone_members x
                                        WHERE x.site = p_site AND x.shop = p_shop AND x.batch_id = v_batch AND x.membership_version = v_ver) THEN
    RETURN pg_catalog.jsonb_build_object('result', 'conflict', 'reason', 'membership version already defined by another occurrence', 'members', NULL);
  END IF;

  INSERT INTO public.make_milestone_occurrences (site, shop, occurrence_id, scope, stage, happened_at, batch_id, membership_version, content)
  VALUES (p_site, p_shop, v_occ, p_scope, v_stage, v_at, v_batch, v_ver, v_content);
  IF v_stage = 'submitted' THEN
    INSERT INTO public.make_milestone_members (site, shop, batch_id, membership_version, member_key, order_number, defined_by)
    SELECT p_site, p_shop, v_batch, v_ver, x.value ->> 'memberKey', pg_catalog.regexp_replace(pg_catalog.btrim(x.value ->> 'orderNumber'), '^#', ''), v_occ
      FROM pg_catalog.jsonb_array_elements(v_members) x;
  END IF;
  INSERT INTO public.make_milestone_refs (site, shop, occurrence_id, member_key, shopify_order_id)
  SELECT p_site, p_shop, v_occ, x.value ->> 'memberKey', x.value ->> 'shopifyOrderId' FROM pg_catalog.jsonb_array_elements(v_members) x;

  PERFORM public.make_milestone_resolve(p_site, p_shop, v_batch, v_ver);
  RETURN pg_catalog.jsonb_build_object('result', 'accepted', 'reason', NULL, 'members', public.make_milestone_counts(p_site, p_shop, v_occ, v_batch, v_ver));
END
$fn$;

-- Service-only: one batch's membership and occurrences for one connector site/shop (unresolved stays visible).
CREATE FUNCTION public.read_make_batch(p_site text, p_shop text, p_batch_id text, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_n bigint;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 2000 THEN RAISE EXCEPTION 'read_make_batch: limit must be 1..2000'; END IF;
  SELECT count(*) INTO v_n FROM (SELECT 1 FROM public.make_milestone_members m WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch_id LIMIT p_limit + 1) z;
  IF v_n > p_limit THEN RAISE EXCEPTION 'read_make_batch: more than % members exceed the limit %', p_limit, p_limit; END IF;
  SELECT count(*) INTO v_n FROM (SELECT 1 FROM public.make_milestone_occurrences o WHERE o.site = p_site AND o.shop = p_shop AND o.batch_id = p_batch_id LIMIT p_limit + 1) z;
  IF v_n > p_limit THEN RAISE EXCEPTION 'read_make_batch: more than % occurrences exceed the limit %', p_limit, p_limit; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'batchId', p_batch_id,
    'members', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('membershipVersion', m.membership_version, 'memberKey', m.member_key,
                  'orderNumber', m.order_number, 'shopifyOrderId', m.shopify_order_id, 'status', m.status) ORDER BY m.membership_version, m.member_key), '[]'::jsonb)
                  FROM public.make_milestone_members m WHERE m.site = p_site AND m.shop = p_shop AND m.batch_id = p_batch_id),
    'occurrences', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('occurrenceId', o.occurrence_id, 'stage', o.stage,
                  'membershipVersion', o.membership_version, 'happenedAt', public.order_timeline_utc(o.happened_at), 'receivedAt', public.order_timeline_utc(o.received_at),
                  'members', public.make_milestone_counts(p_site, p_shop, o.occurrence_id, o.batch_id, o.membership_version)) ORDER BY o.happened_at, o.occurrence_id), '[]'::jsonb)
                  FROM public.make_milestone_occurrences o WHERE o.site = p_site AND o.shop = p_shop AND o.batch_id = p_batch_id));
END
$fn$;

REVOKE ALL ON FUNCTION public.ingest_make_milestone(text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_make_batch(text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.make_milestone_resolve(text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.make_milestone_counts(text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_make_milestone(text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_make_batch(text, text, text, integer) TO service_role;

COMMIT;
