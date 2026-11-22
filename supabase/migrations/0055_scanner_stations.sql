-- 0055_scanner_stations.sql
--
-- F6 shared scanner stations (docs/specs/scanner-stations.md).
--
-- Adds, and only adds:
--   scanner_requests   one receipt per badge activation / framing commit request
--   scanner_receivers  one current health row per caller / site / receiver
--   scanner_activate_badge   owner/manager/kiosk: badge -> person, clock in once per site workday
--   scanner_commit_framing   owner/manager/kiosk: one atomic framing save for one order
--   scanner_heartbeat        owner/manager/kiosk: upsert the receiver's health row
--   production_events_c6_scanner_guard  BEFORE INSERT trigger: classic framing
--                            credit for an order the shared scanners already
--                            saved is refused (same per-order lock)
--   ledger_prod_order_idx    finds an order's earlier deductions by product
--   private helpers (no client grants)
--
-- And replaces deduct_inventory_for_event (same signature, same JSON result
-- keys, same routing/skip rules) so that it:
--   * authorizes the caller, the event and its site (it had no check);
--   * takes the same per-site/order advisory lock as scanner_commit_framing,
--     so the classic station, the shared station and retries are serialized
--     per order;
--   * re-checks the ledger under that lock, resolving product code/id
--     aliases so one product is charged at most once per order;
--   * processes products in a stable order (no row-lock deadlocks).
-- No unique index is added on old ledger keys: history is never cleaned up.
--
-- The replaced deduction also loses PUBLIC/anon EXECUTE (it now refuses
-- unauthenticated calls anyway). Nothing else existing is altered: no table,
-- column, policy or other grant of an earlier migration changes; F4 (0047)
-- and F5 (0052-0054) are called, never edited. The previous app version
-- keeps working: it never calls the new functions, and the replaced
-- deduction answers it with the same JSON keys for every authorized call.
-- Behaviour differences of the deduction, all on the safe side: the lines
-- of one call are summed per product and written as one row (the app already
-- sends one line per code); a product already charged for the order under
-- ANY alias (code in any case, or id) is skipped, where 0031 only matched
-- the identical spelling; new ledger keys use the product's own code (0031
-- used the supplied spelling).
--
-- Not applied by an agent. Codex/CJ apply it to staging only.
-- Requires 0047 and 0052-0054. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scanner_requests (
  location       TEXT        NOT NULL REFERENCES public.locations(key) ON DELETE RESTRICT,
  request_id     UUID        NOT NULL,
  kind           TEXT        NOT NULL CHECK (kind IN ('activate', 'commit')),
  caller         UUID        NOT NULL,
  receiver_id    TEXT        NOT NULL,
  scanner_id     TEXT        NOT NULL,
  staff_id       UUID,
  order_number   TEXT,
  payload_hash   TEXT        NOT NULL CHECK (length(payload_hash) = 64),
  outcome        TEXT        NOT NULL CHECK (outcome IN ('activated', 'saved')),
  result         JSONB       NOT NULL,
  scanned_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location, request_id),
  CHECK ((kind = 'commit') = (order_number IS NOT NULL))
);

COMMENT ON TABLE public.scanner_requests IS
  'F6: receipts. A retried request with the same id and payload gets the stored answer; a changed payload is refused. Written only by the scanner_* functions.';

-- Backstop for exactly-once: at most one saved shared-scanner commit per order.
CREATE UNIQUE INDEX IF NOT EXISTS scanner_requests_one_commit_per_order
  ON public.scanner_requests (location, order_number)
  WHERE kind = 'commit' AND outcome = 'saved';

CREATE TABLE IF NOT EXISTS public.scanner_receivers (
  location       TEXT        NOT NULL REFERENCES public.locations(key) ON DELETE RESTRICT,
  caller         UUID        NOT NULL,
  receiver_id    TEXT        NOT NULL CHECK (receiver_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  label          TEXT        NOT NULL DEFAULT '' CHECK (length(label) <= 60),
  heartbeat_at   TIMESTAMPTZ NOT NULL,
  last_scan_at   TIMESTAMPTZ,
  queue_count    INTEGER     NOT NULL DEFAULT 0 CHECK (queue_count BETWEEN 0 AND 100000),
  blocked_count  INTEGER     NOT NULL DEFAULT 0 CHECK (blocked_count BETWEEN 0 AND 100000),
  PRIMARY KEY (location, caller, receiver_id)
);

COMMENT ON TABLE public.scanner_receivers IS
  'F6: one current health row per caller/site/receiver page. No history, no worker data.';

ALTER TABLE public.scanner_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scanner_receivers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scanner_requests_select ON public.scanner_requests;
CREATE POLICY scanner_requests_select ON public.scanner_requests FOR SELECT
  USING (can_access_location(location) AND is_manager_or_higher());

DROP POLICY IF EXISTS scanner_receivers_select ON public.scanner_receivers;
CREATE POLICY scanner_receivers_select ON public.scanner_receivers FOR SELECT
  USING (can_access_location(location) AND is_manager_or_higher());

REVOKE ALL ON public.scanner_requests, public.scanner_receivers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.scanner_requests, public.scanner_receivers TO authenticated;

-- ---------------------------------------------------------------------------
-- Private helpers
-- ---------------------------------------------------------------------------

-- Signed in, member of the site, and owner/manager/kiosk.
CREATE OR REPLACE FUNCTION public.scanner_require_operator_(p_location TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'scanner: not_authenticated' USING ERRCODE = 'P0001';
  END IF;
  IF p_location IS NULL OR NOT can_access_location(p_location) THEN
    RAISE EXCEPTION 'scanner: forbidden_location' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(current_user_role(), '') NOT IN ('owner', 'manager', 'kiosk') THEN
    RAISE EXCEPTION 'scanner: forbidden_role' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_uid;
END;
$$;

-- Site zone (same table as the app's SITE_TIME_ZONES; other sites use UTC).
CREATE OR REPLACE FUNCTION public.scanner_site_zone_(p_location TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_location
    WHEN 'au' THEN 'Australia/Sydney'
    WHEN 'uk' THEN 'Europe/London'
    WHEN 'us' THEN 'America/Chicago'
    ELSE 'UTC'
  END;
$$;

-- Start of the site workday containing p_at: the most recent 04:00 site-local.
CREATE OR REPLACE FUNCTION public.scanner_workday_start_(p_location TEXT, p_at TIMESTAMPTZ)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT ((((p_at AT TIME ZONE z) - interval '4 hours')::date + time '04:00') AT TIME ZONE z)
  FROM (SELECT public.scanner_site_zone_(p_location) AS z) s;
$$;

CREATE OR REPLACE FUNCTION public.scanner_hash_(p JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT encode(sha256(convert_to(p::text, 'UTF8')), 'hex');
$$;

-- The per-site/order lock shared by the legacy deduction and the shared
-- commit. Packaging takes its own (0047) lock only after this one.
CREATE OR REPLACE FUNCTION public.production_order_lock_(p_location TEXT, p_order TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('prod-order|' || p_location || '|' || p_order, 0));
$$;

-- Prior order deductions by product identity, whatever spelling 0031 stored.
-- Takes a short write lock on ledger while it builds: apply at a quiet time.
CREATE INDEX IF NOT EXISTS ledger_prod_order_idx
  ON public.ledger (location, (split_part(source_id, ':', 2)), product_id)
  WHERE source_id LIKE 'prod:%';

-- Deduct order components for one terminal event. Caller holds the order
-- lock and has authorized the event. Same rules as 0031 except:
--   * a product is charged once per order: any prior "prod:order_<n>:..."
--     row for the same product id counts, whatever alias it was keyed by;
--   * products are aggregated and updated in id order.
-- New rows are keyed by the product's code (its id if it has no code), which
-- is also the key F4's legacy-packaging adoption looks for.
CREATE OR REPLACE FUNCTION public.production_deduct_locked_(
  p_location     TEXT,
  p_event_id     TEXT,
  p_order_number TEXT,
  p_dept         TEXT,
  p_event_type   TEXT,
  p_lines        JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix     TEXT := 'prod:order_' || p_order_number || ':';
  v_rec        RECORD;
  v_new        NUMERIC;
  v_deducted   INTEGER := 0;
  v_skipped    INTEGER := 0;
  v_missing    TEXT[] := ARRAY[]::TEXT[];
  v_negative   TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Codes that match no product at the site (reported, as before).
  SELECT COALESCE(array_agg(l.code ORDER BY l.ord), ARRAY[]::TEXT[]) INTO v_missing
  FROM (
    SELECT e.value->>'code' AS code, e.ordinality AS ord
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_lines) = 'array' THEN p_lines ELSE '[]'::jsonb END) WITH ORDINALITY e
    WHERE COALESCE(e.value->>'code', '') <> ''
      AND COALESCE((e.value->>'qty')::NUMERIC, 0) > 0
  ) l
  WHERE NOT EXISTS (
    SELECT 1 FROM products p
    WHERE p.location = p_location AND (lower(p.code) = lower(l.code) OR p.id = l.code)
  );

  FOR v_rec IN
    WITH lines AS (
      SELECT e.value->>'code' AS code, (e.value->>'qty')::NUMERIC AS qty
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_lines) = 'array' THEN p_lines ELSE '[]'::jsonb END) e
      WHERE COALESCE(e.value->>'code', '') <> ''
        AND COALESCE((e.value->>'qty')::NUMERIC, 0) > 0
    ),
    resolved AS (
      -- Same resolution as 0031: first product whose code (any case) or id matches.
      SELECT l.code, l.qty,
             (SELECT p.id FROM products p
              WHERE p.location = p_location AND (lower(p.code) = lower(l.code) OR p.id = l.code)
              ORDER BY (p.id = l.code) DESC, p.id
              LIMIT 1) AS product_id
      FROM lines l
    )
    SELECT r.product_id,
           sum(r.qty) AS qty,
           array_agg(DISTINCT r.code) AS aliases,
           (SELECT COALESCE(NULLIF(p.code, ''), p.id) FROM products p
             WHERE p.location = p_location AND p.id = r.product_id) AS key_code,
           (SELECT p.code FROM products p WHERE p.location = p_location AND p.id = r.product_id) AS code
    FROM resolved r
    WHERE r.product_id IS NOT NULL
    GROUP BY r.product_id
    ORDER BY r.product_id
  LOOP
    -- Any earlier "prod:order_<n>:<anything>" row for this PRODUCT counts,
    -- whatever spelling (any case, code or id) it was written with.
    -- Indexed by ledger_prod_order_idx (site, order part of the key, product).
    IF EXISTS (
      SELECT 1 FROM ledger lg
      WHERE lg.location = p_location
        AND lg.source_id LIKE 'prod:%'
        AND split_part(lg.source_id, ':', 2) = 'order_' || p_order_number
        AND left(lg.source_id, length(v_prefix)) = v_prefix
        AND lg.product_id = v_rec.product_id
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    UPDATE products
    SET    current_on_hand = current_on_hand - v_rec.qty
    WHERE  location = p_location AND id = v_rec.product_id
    RETURNING current_on_hand INTO v_new;

    IF v_new < 0 THEN
      v_negative := array_append(v_negative, v_rec.key_code);
    END IF;

    INSERT INTO ledger (location, id, product_id, delta, reason, source_id, parent_event_id, note)
    VALUES (
      p_location,
      'led-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20),
      v_rec.product_id,
      -v_rec.qty,
      'sale',
      v_prefix || v_rec.key_code,
      p_event_id,
      'Auto-deduct from ' || p_dept || ' ' || p_event_type || ' on order #' || p_order_number
    );
    v_deducted := v_deducted + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'deducted',           v_deducted,
    'skipped_idempotent', v_skipped,
    'missing_codes',      to_jsonb(v_missing),
    'negative_codes',     to_jsonb(v_negative)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Legacy deduction, now authorized and serialized per order
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.deduct_inventory_for_event(
  p_event_id  TEXT,
  p_lines     JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_event production_events%ROWTYPE;
  v_res   JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'deduct_inventory_for_event: not_authenticated' USING ERRCODE = '42501';
  END IF;

  -- Only events at a site the caller belongs to are visible here. The id is
  -- unique only per site: refuse to guess between two sites.
  IF (SELECT count(*) FROM production_events WHERE id = p_event_id AND can_access_location(location)) > 1 THEN
    RAISE EXCEPTION 'deduct_inventory_for_event: ambiguous_event %', p_event_id USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_event
  FROM   production_events
  WHERE  id = p_event_id AND can_access_location(location)
  ORDER  BY location
  LIMIT  1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'production_event % not found', p_event_id;
  END IF;

  -- Same rule as the production_events insert policy (0028) and packaging_apply.
  IF NOT (v_event.staff_id = v_uid OR is_kiosk_or_higher()) THEN
    RAISE EXCEPTION 'deduct_inventory_for_event: forbidden_role' USING ERRCODE = '42501';
  END IF;

  IF v_event.cs_case_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'skipped_cs_case', 'event_id', p_event_id, 'cs_case_id', v_event.cs_case_id);
  END IF;

  IF v_event.event_type NOT IN ('completed', 'dispatched') THEN
    RETURN jsonb_build_object('status', 'skipped_event_type', 'event_type', v_event.event_type);
  END IF;

  IF v_event.order_number IS NULL OR v_event.order_number = '' THEN
    RETURN jsonb_build_object('status', 'skipped_no_order', 'event_id', p_event_id);
  END IF;

  PERFORM production_order_lock_(v_event.location, v_event.order_number);

  v_res := production_deduct_locked_(
    v_event.location, p_event_id, v_event.order_number, v_event.department, v_event.event_type, p_lines);

  RETURN jsonb_build_object(
    'status',             'ok',
    'event_id',           p_event_id,
    'order_number',       v_event.order_number,
    'department',         v_event.department,
    'event_type',         v_event.event_type
  ) || v_res;
END;
$$;

-- ---------------------------------------------------------------------------
-- Badge activation
-- ---------------------------------------------------------------------------

-- Returns {status:"activated", person_id, display_name, clocked_in} or
-- {status:"unknown_badge"} (no badge with this value anywhere) or
-- {status:"unusable_badge"} (exists but inactive here, or only at another
-- site; nothing about it is disclosed). Only the person's id and name are
-- returned. p_expected_caller must be the signed-in account (checked before
-- replay or any write), so a queued request can never run as another account.
CREATE OR REPLACE FUNCTION public.scanner_activate_badge(
  p_location    TEXT,
  p_request_id  UUID,
  p_receiver_id TEXT,
  p_scanner_id  TEXT,
  p_badge       TEXT,
  p_expected_caller UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := scanner_require_operator_(p_location);  -- role checks precede replay
  v_badge     TEXT := upper(btrim(COALESCE(p_badge, '')));
  v_hash      TEXT;
  v_prev      scanner_requests%ROWTYPE;
  v_person    UUID;
  v_name      TEXT;
  v_start     TIMESTAMPTZ;
  v_last      TEXT;
  v_clocked   BOOLEAN := false;
  v_result    JSONB;
BEGIN
  IF NOT COALESCE(
       p_request_id IS NOT NULL
       AND p_receiver_id ~ '^[A-Za-z0-9_-]{1,32}$'
       AND p_scanner_id ~ '^[A-Z][A-Z0-9]{0,3}$'
       AND v_badge ~ '^[0-9A-F]{8}$',
       false) THEN
    RAISE EXCEPTION 'scanner: invalid_input' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_caller IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'scanner: caller_mismatch' USING ERRCODE = 'P0001';
  END IF;

  v_hash := scanner_hash_(jsonb_build_object('v', 1, 'kind', 'activate', 'location', p_location,
              'receiver', p_receiver_id, 'scanner', p_scanner_id, 'badge', v_badge));

  SELECT * INTO v_prev FROM scanner_requests WHERE location = p_location AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prev.kind <> 'activate' OR v_prev.caller <> v_uid OR v_prev.payload_hash <> v_hash THEN
      RAISE EXCEPTION 'scanner: request_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_prev.result || jsonb_build_object('replayed', true);
  END IF;

  SELECT b.user_id, b.display_name INTO v_person, v_name
  FROM   staff_barcodes b
  WHERE  b.location = p_location AND b.barcode = v_badge AND b.active;
  IF NOT FOUND THEN
    -- No side effect, so nothing is stored. A known badge that cannot be
    -- used here must never be read as an order for the previous person.
    IF EXISTS (SELECT 1 FROM staff_barcodes b WHERE b.barcode = v_badge) THEN
      RETURN jsonb_build_object('status', 'unusable_badge');
    END IF;
    RETURN jsonb_build_object('status', 'unknown_badge');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = v_person AND ul.location = p_location) THEN
    RAISE EXCEPTION 'scanner: person_not_at_site' USING ERRCODE = 'P0001';
  END IF;

  -- One clock-in per person per site workday, however many scanners or
  -- repeats: serialize on the person, then look.
  PERFORM pg_advisory_xact_lock(hashtextextended('scanner-clock|' || p_location || '|' || v_person::text, 0));

  -- A concurrent copy of this same request may have finished while we waited.
  SELECT * INTO v_prev FROM scanner_requests WHERE location = p_location AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prev.kind <> 'activate' OR v_prev.caller <> v_uid OR v_prev.payload_hash <> v_hash THEN
      RAISE EXCEPTION 'scanner: request_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_prev.result || jsonb_build_object('replayed', true);
  END IF;

  v_start := scanner_workday_start_(p_location, now());
  SELECT e.event_type INTO v_last
  FROM   production_events e
  WHERE  e.location = p_location AND e.staff_id = v_person
    AND  e.event_type IN ('clock_in', 'clock_out')
    AND  e.created_at >= v_start
  ORDER  BY e.created_at DESC, (e.event_type = 'clock_out') DESC, e.id DESC  -- a tie counts as clocked out
  LIMIT  1;

  IF v_last IS DISTINCT FROM 'clock_in' THEN
    INSERT INTO production_events (location, id, staff_id, department, order_number, event_type, station_id, note, created_at)
    VALUES (p_location, 'scn-' || replace(p_request_id::text, '-', '') || '-ci', v_person, 'framed', NULL, 'clock_in',
            'shared:' || p_receiver_id || ':' || p_scanner_id, 'Sign in via shared scanner badge', now());
    v_clocked := true;
  END IF;

  v_result := jsonb_build_object('status', 'activated', 'person_id', v_person, 'display_name', v_name, 'clocked_in', v_clocked);

  INSERT INTO scanner_requests (location, request_id, kind, caller, receiver_id, scanner_id, staff_id, payload_hash, outcome, result)
  VALUES (p_location, p_request_id, 'activate', v_uid, p_receiver_id, p_scanner_id, v_person, v_hash, 'activated', v_result);

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Framing commit
-- ---------------------------------------------------------------------------

-- One atomic save of every framed line of one order for one person:
-- line_verified per SKU, completed per work type, A0 component deduction and
-- F4 packaging. Any failure rolls everything back.
--
-- Returns {status:"saved", ...} (also on replay, with replayed:true) or
-- {status:"already_recorded", reason}. Refusals raise "scanner: <code>".
CREATE OR REPLACE FUNCTION public.scanner_commit_framing(
  p_location     TEXT,
  p_request_id   UUID,
  p_receiver_id  TEXT,
  p_scanner_id   TEXT,
  p_staff_id     UUID,
  p_badge        TEXT,
  p_order_number TEXT,
  p_scanned_at   TIMESTAMPTZ,
  p_lines        JSONB,
  p_components   JSONB,
  p_packaging    JSONB,
  p_expected_caller UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := scanner_require_operator_(p_location);  -- role checks precede replay
  v_badge      TEXT := upper(btrim(COALESCE(p_badge, '')));
  v_lines      JSONB;
  v_components JSONB;
  v_n_lines    INTEGER;
  v_bad        INTEGER;
  v_work_types TEXT[];
  v_has_a0     BOOLEAN;
  v_hash       TEXT;
  v_prev       scanner_requests%ROWTYPE;
  v_name       TEXT;
  v_prior      TEXT;
  v_station    TEXT := 'shared:' || p_receiver_id || ':' || p_scanner_id;
  v_rid        TEXT := replace(p_request_id::text, '-', '');
  v_event_ids  TEXT[] := ARRAY[]::TEXT[];
  v_a0_event   TEXT;
  v_wt         TEXT;
  v_deduct     JSONB := NULL;
  v_pack       JSONB := NULL;
  v_negative   TEXT[] := ARRAY[]::TEXT[];
  v_pieces     INTEGER;
  v_result     JSONB;
BEGIN
  -- 1. Bounded input. Lines are re-checked against the SKU grammar: only
  --    framed single/set prints, A0 -> a0_framed, A1-A4/GW sets -> framed.
  -- The request belongs to the account that scanned it: never run it as
  -- another one (checked before replay and before any write).
  IF p_expected_caller IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'scanner: caller_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- Each check is ONE null-safe expression evaluated left to right: a
  -- missing key or NULL makes it fail (COALESCE ... false), never pass.
  IF NOT COALESCE(
       p_request_id IS NOT NULL AND p_staff_id IS NOT NULL
       AND p_scanned_at IS NOT NULL AND isfinite(p_scanned_at)
       AND p_receiver_id ~ '^[A-Za-z0-9_-]{1,32}$'
       AND p_scanner_id ~ '^[A-Z][A-Z0-9]{0,3}$'
       AND v_badge ~ '^[0-9A-F]{8}$'
       AND p_order_number ~ '^10[0-9]{6}$'
       AND jsonb_typeof(p_lines) = 'array' AND jsonb_array_length(p_lines) BETWEEN 1 AND 50
       AND jsonb_typeof(p_components) = 'array' AND jsonb_array_length(p_components) <= 30
       AND (p_packaging IS NULL OR jsonb_typeof(p_packaging) IN ('object', 'null'))
       AND COALESCE(pg_column_size(p_packaging), 0) <= 32768,
       false) THEN
    RAISE EXCEPTION 'scanner: invalid_input' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(p_lines) e
  WHERE NOT COALESCE(
          jsonb_typeof(e.value) = 'object'
          AND (SELECT count(*) FROM jsonb_object_keys(e.value)) = 3
          AND jsonb_typeof(e.value->'sku') = 'string'
          AND jsonb_typeof(e.value->'quantity') = 'number'
          AND jsonb_typeof(e.value->'work_type') = 'string'
          AND (e.value->>'sku') ~ '^INKA-(S[0-9])?[A-Z]{2,3}[0-9]{4}-(A[0-4]|GW)-(FB|FW|FN)$'
          AND ((e.value->>'sku') !~ '-GW-' OR (e.value->>'sku') ~ '^INKA-S[0-9]')
          AND (e.value->>'quantity')::NUMERIC = trunc((e.value->>'quantity')::NUMERIC)
          AND (e.value->>'quantity')::NUMERIC BETWEEN 1 AND 100
          AND (e.value->>'work_type') = CASE WHEN (e.value->>'sku') ~ '-A0-' THEN 'a0_framed' ELSE 'framed' END,
          false);
  IF v_bad > 0 OR (SELECT count(DISTINCT e.value->>'sku') FROM jsonb_array_elements(p_lines) e) <> jsonb_array_length(p_lines) THEN
    RAISE EXCEPTION 'scanner: invalid_input' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(p_components) e
  WHERE NOT COALESCE(
          jsonb_typeof(e.value) = 'object'
          AND (SELECT count(*) FROM jsonb_object_keys(e.value)) = 2
          AND jsonb_typeof(e.value->'code') = 'string'
          AND jsonb_typeof(e.value->'qty') = 'number'
          AND length(e.value->>'code') BETWEEN 1 AND 120
          AND (e.value->>'qty')::NUMERIC = trunc((e.value->>'qty')::NUMERIC)
          AND (e.value->>'qty')::NUMERIC BETWEEN 1 AND 1000,
          false);
  IF v_bad > 0 OR (SELECT count(DISTINCT lower(e.value->>'code')) FROM jsonb_array_elements(p_components) e) <> jsonb_array_length(p_components) THEN
    RAISE EXCEPTION 'scanner: invalid_input' USING ERRCODE = 'P0001';
  END IF;

  -- Canonical order: lines by SKU, components by code.
  SELECT jsonb_agg(jsonb_build_object('sku', e.value->>'sku', 'quantity', (e.value->>'quantity')::NUMERIC::INTEGER,
                                      'work_type', e.value->>'work_type') ORDER BY e.value->>'sku'),
         array_agg(DISTINCT e.value->>'work_type')
  INTO   v_lines, v_work_types
  FROM   jsonb_array_elements(p_lines) e;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', e.value->>'code', 'qty', (e.value->>'qty')::NUMERIC::INTEGER) ORDER BY e.value->>'code'), '[]'::jsonb)
  INTO   v_components
  FROM   jsonb_array_elements(p_components) e;
  v_n_lines := jsonb_array_length(v_lines);
  v_has_a0 := 'a0_framed' = ANY (v_work_types);

  -- A0 is terminal here (components + packaging); regular framed deducts at dispatch.
  IF v_has_a0 <> (jsonb_array_length(v_components) > 0)
     OR v_has_a0 <> (p_packaging IS NOT NULL AND jsonb_typeof(p_packaging) = 'object') THEN
    RAISE EXCEPTION 'scanner: invalid_input' USING ERRCODE = 'P0001';
  END IF;

  -- 2. The server's own canonical hash of everything that will be written.
  v_hash := scanner_hash_(jsonb_build_object(
    'v', 1, 'kind', 'commit', 'location', p_location, 'receiver', p_receiver_id, 'scanner', p_scanner_id,
    'staff', p_staff_id, 'badge', v_badge, 'order', p_order_number,
    'scanned_at', to_char(p_scanned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'lines', v_lines, 'components', v_components,
    'packaging', CASE WHEN jsonb_typeof(p_packaging) = 'object' THEN p_packaging ELSE 'null'::jsonb END));

  -- 3. Serialize with every other writer of this order (classic deduction too).
  PERFORM production_order_lock_(p_location, p_order_number);

  -- 4. Replay: same request + same payload -> the stored answer.
  SELECT * INTO v_prev FROM scanner_requests WHERE location = p_location AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prev.kind <> 'commit' OR v_prev.caller <> v_uid OR v_prev.payload_hash <> v_hash THEN
      RAISE EXCEPTION 'scanner: request_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_prev.result || jsonb_build_object('replayed', true);
  END IF;

  -- 5. Time: never in the future (F5's 5 s rule), and a bounded queue age.
  IF p_scanned_at > now() + interval '5 seconds' OR p_scanned_at < now() - interval '14 days' THEN
    RAISE EXCEPTION 'scanner: invalid_input' USING ERRCODE = 'P0001';
  END IF;

  -- 6. The person: active badge here, still a member of the site.
  SELECT b.display_name INTO v_name
  FROM   staff_barcodes b
  WHERE  b.location = p_location AND b.barcode = v_badge AND b.user_id = p_staff_id AND b.active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scanner: badge_inactive' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = p_staff_id AND ul.location = p_location) THEN
    RAISE EXCEPTION 'scanner: person_not_at_site' USING ERRCODE = 'P0001';
  END IF;

  -- 7. Replacement work belongs to the classic flow.
  IF EXISTS (SELECT 1 FROM cs_cases c
             WHERE c.location = p_location AND c.order_number = p_order_number
               AND c.status IN ('new', 'query', 'approved')) THEN
    RAISE EXCEPTION 'scanner: open_case' USING ERRCODE = 'P0001';
  END IF;

  -- 8. Existing or partial work: report it, add nothing.
  SELECT CASE
           WHEN e.event_type = 'dispatched' THEN 'order already dispatched'
           WHEN e.event_type = 'completed' THEN e.department || ' already completed'
           ELSE e.department || ' line ' || COALESCE(e.line_sku, '') || ' already verified'
         END
  INTO   v_prior
  FROM   production_events e
  WHERE  e.location = p_location AND e.order_number = p_order_number
    AND  (e.event_type = 'dispatched'
          OR (e.department = ANY (v_work_types) AND e.event_type = 'completed')
          OR (e.department = ANY (v_work_types) AND e.event_type = 'line_verified'
              AND NOT EXISTS (SELECT 1 FROM production_events c
                              WHERE c.location = e.location AND c.parent_event_id = e.id
                                AND c.event_type = 'cancelled')))
  ORDER  BY e.created_at, e.id
  LIMIT  1;
  IF v_prior IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_recorded', 'reason', v_prior);
  END IF;

  -- 9. Events. Deterministic ids; created_at is the original scan time, so
  --    F5 resolves the department at that instant for the bound person.
  INSERT INTO production_events (location, id, staff_id, department, order_number, line_sku, line_quantity,
                                 event_type, station_id, note, created_at)
  SELECT p_location, 'scn-' || v_rid || '-v' || lpad(e.ordinality::text, 2, '0'), p_staff_id,
         e.value->>'work_type', p_order_number, e.value->>'sku', (e.value->>'quantity')::NUMERIC::INTEGER,
         'line_verified', v_station, 'Shared scanner', p_scanned_at
  FROM   jsonb_array_elements(v_lines) WITH ORDINALITY e;
  SELECT array_agg('scn-' || v_rid || '-v' || lpad(g::text, 2, '0') ORDER BY g) INTO v_event_ids
  FROM   generate_series(1, v_n_lines) g;

  FOREACH v_wt IN ARRAY (SELECT array_agg(w ORDER BY w) FROM unnest(v_work_types) w) LOOP
    INSERT INTO production_events (location, id, staff_id, department, order_number, line_sku, line_quantity,
                                   event_type, station_id, note, created_at)
    SELECT p_location, 'scn-' || v_rid || '-c-' || v_wt, p_staff_id, v_wt, p_order_number, NULL,
           sum((e.value->>'quantity')::NUMERIC::INTEGER), 'completed', v_station, 'Shared scanner', p_scanned_at
    FROM   jsonb_array_elements(v_lines) e
    WHERE  e.value->>'work_type' = v_wt;
    v_event_ids := v_event_ids || ('scn-' || v_rid || '-c-' || v_wt);
  END LOOP;

  -- 10. A0 terminal: components and packaging, all or nothing.
  IF v_has_a0 THEN
    v_a0_event := 'scn-' || v_rid || '-c-a0_framed';

    v_deduct := production_deduct_locked_(p_location, v_a0_event, p_order_number, 'a0_framed', 'completed', v_components);
    IF jsonb_array_length(v_deduct->'missing_codes') > 0 THEN
      RAISE EXCEPTION 'scanner: missing_stock_code: %', v_deduct->'missing_codes' USING ERRCODE = 'P0001';
    END IF;
    IF (v_deduct->>'skipped_idempotent')::INTEGER > 0 THEN
      RAISE EXCEPTION 'scanner: already_charged' USING ERRCODE = 'P0001';
    END IF;
    SELECT array_agg(x) INTO v_negative FROM jsonb_array_elements_text(v_deduct->'negative_codes') x;

    IF NOT EXISTS (SELECT 1 FROM packaging_settings s WHERE s.location = p_location AND s.mode = 'auto') THEN
      RAISE EXCEPTION 'scanner: packaging_not_auto' USING ERRCODE = 'P0001';
    END IF;
    IF NOT COALESCE(
         (SELECT count(*) FROM jsonb_object_keys(p_packaging)) = 6
         AND jsonb_typeof(p_packaging->'rule_set_id') = 'string'
         AND jsonb_typeof(p_packaging->'rule_set_version') = 'number'
         AND p_packaging->'resolved' = 'true'::jsonb
         AND jsonb_typeof(p_packaging->'predicted') = 'object'
         AND jsonb_typeof(p_packaging->'target') = 'object'
         AND jsonb_typeof(p_packaging->'snapshot') = 'object'
         AND p_packaging->'target' <> '{}'::jsonb
         AND p_packaging->'target' = p_packaging->'predicted'
         AND (p_packaging->>'rule_set_version')::NUMERIC = trunc((p_packaging->>'rule_set_version')::NUMERIC)
         AND EXISTS (SELECT 1 FROM packaging_rule_sets r
                     WHERE r.location = p_location AND r.id = p_packaging->>'rule_set_id'
                       AND r.version = (p_packaging->>'rule_set_version')::NUMERIC
                       AND r.status IN ('active', 'retired')),
         false) THEN
      RAISE EXCEPTION 'scanner: packaging_invalid' USING ERRCODE = 'P0001';
    END IF;

    v_pack := packaging_apply(p_location, 'scn:' || p_request_id::text, v_a0_event, p_packaging->>'rule_set_id',
                              true, p_packaging->'predicted', p_packaging->'target', p_packaging->'snapshot');
    IF v_pack->>'status' IS DISTINCT FROM 'applied' THEN
      RAISE EXCEPTION 'scanner: packaging_invalid: %', v_pack->>'status' USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_array_length(COALESCE(v_pack->'unposted', '[]'::jsonb)) > 0 THEN
      RAISE EXCEPTION 'scanner: packaging_unposted' USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(v_negative, ARRAY[]::TEXT[]) || COALESCE(array_agg(x), ARRAY[]::TEXT[]) INTO v_negative
    FROM jsonb_array_elements_text(COALESCE(v_pack->'negative', '[]'::jsonb)) x;
  END IF;

  SELECT sum((e.value->>'quantity')::NUMERIC::INTEGER * COALESCE(substring(e.value->>'sku' FROM '^INKA-S([0-9])')::INTEGER, 1))
  INTO   v_pieces
  FROM   jsonb_array_elements(v_lines) e;

  v_result := jsonb_build_object(
    'status',         'saved',
    'request_id',     p_request_id,
    'order_number',   p_order_number,
    'staff_id',       p_staff_id,
    'display_name',   v_name,
    'pieces',         v_pieces,
    'work_types',     to_jsonb(v_work_types),
    'event_ids',      to_jsonb(v_event_ids),
    'deduction',      v_deduct,
    'packaging_pick', CASE WHEN v_pack IS NULL THEN NULL ELSE v_pack->'pick'->'id' END,
    'negative_codes', to_jsonb(COALESCE(v_negative, ARRAY[]::TEXT[]))
  );

  -- 11. Receipt (the unique index backstops one saved commit per order).
  INSERT INTO scanner_requests (location, request_id, kind, caller, receiver_id, scanner_id, staff_id, order_number,
                                payload_hash, outcome, result, scanned_at)
  VALUES (p_location, p_request_id, 'commit', v_uid, p_receiver_id, p_scanner_id, p_staff_id, p_order_number,
          v_hash, 'saved', v_result, p_scanned_at);

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Classic credit guard
-- ---------------------------------------------------------------------------

-- Classic Production inserts framing credit (line_verified / completed at
-- Framed or A0 Framed) straight into production_events. This BEFORE INSERT
-- trigger takes the same per-order lock as scanner_commit_framing, so the two
-- paths are serialized, and refuses the classic row when a saved shared
-- commit already credited that work type for the order. Narrow on purpose:
-- dispatch, unframed, started/cancelled/clock rows, CS-case replacement rows
-- (cs_case_id set) and orders the shared scanners never saved are untouched.
-- The shared commit's own rows pass: its receipt is written after them.
-- Named "c6" so it runs before the F5 triggers ("f5_..."): a waiting classic
-- insert never holds F5's resolver lock while it waits for the order lock.
CREATE OR REPLACE FUNCTION public.scanner_guard_classic_credit_()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.event_type IN ('line_verified', 'completed')
     AND NEW.department IN ('framed', 'a0_framed')
     AND NEW.cs_case_id IS NULL
     AND NEW.order_number IS NOT NULL THEN
    PERFORM production_order_lock_(NEW.location, NEW.order_number);
    IF EXISTS (SELECT 1 FROM scanner_requests r
               WHERE r.location = NEW.location AND r.order_number = NEW.order_number
                 AND r.kind = 'commit' AND r.outcome = 'saved'
                 AND r.result -> 'work_types' ? NEW.department) THEN
      RAISE EXCEPTION 'scanner: already_saved_by_shared_scanner: % work on order #% was already saved by the shared scanners; nothing more is credited',
        NEW.department, NEW.order_number USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER production_events_c6_scanner_guard
  BEFORE INSERT ON public.production_events
  FOR EACH ROW EXECUTE FUNCTION public.scanner_guard_classic_credit_();

-- ---------------------------------------------------------------------------
-- Receiver heartbeat
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.scanner_heartbeat(
  p_location      TEXT,
  p_receiver_id   TEXT,
  p_label         TEXT,
  p_last_scan_at  TIMESTAMPTZ,
  p_queue_count   INTEGER,
  p_blocked_count INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := scanner_require_operator_(p_location);
BEGIN
  IF NOT COALESCE(
       p_receiver_id ~ '^[A-Za-z0-9_-]{1,32}$'
       AND length(COALESCE(p_label, '')) <= 60
       AND p_queue_count BETWEEN 0 AND 100000
       AND p_blocked_count BETWEEN 0 AND 100000
       AND (p_last_scan_at IS NULL OR (isfinite(p_last_scan_at) AND p_last_scan_at <= now() + interval '1 minute')),
       false) THEN
    RAISE EXCEPTION 'scanner: invalid_input' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO scanner_receivers AS r (location, caller, receiver_id, label, heartbeat_at, last_scan_at, queue_count, blocked_count)
  VALUES (p_location, v_uid, p_receiver_id, COALESCE(p_label, ''), now(), p_last_scan_at, p_queue_count, p_blocked_count)
  ON CONFLICT (location, caller, receiver_id) DO UPDATE
    SET label         = excluded.label,
        heartbeat_at  = excluded.heartbeat_at,
        last_scan_at  = GREATEST(r.last_scan_at, excluded.last_scan_at),
        queue_count   = excluded.queue_count,
        blocked_count = excluded.blocked_count;

  RETURN jsonb_build_object('status', 'ok');
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: nothing for anon or PUBLIC; helpers are internal only
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.scanner_require_operator_(TEXT)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scanner_site_zone_(TEXT)                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scanner_workday_start_(TEXT, TIMESTAMPTZ)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scanner_hash_(JSONB)                                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scanner_guard_classic_credit_()                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.production_order_lock_(TEXT, TEXT)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.production_deduct_locked_(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.scanner_activate_badge(TEXT, UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.scanner_commit_framing(TEXT, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB, JSONB, JSONB, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.scanner_heartbeat(TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER, INTEGER) FROM PUBLIC, anon;
-- The replaced deduction keeps the old callers (signed-in station accounts) and loses anon.
REVOKE ALL ON FUNCTION public.deduct_inventory_for_event(TEXT, JSONB)               FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.scanner_activate_badge(TEXT, UUID, TEXT, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.scanner_commit_framing(TEXT, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB, JSONB, JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.scanner_heartbeat(TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_inventory_for_event(TEXT, JSONB)               TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
