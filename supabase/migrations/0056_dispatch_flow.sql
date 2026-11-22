-- 0056_dispatch_flow.sql
--
-- F7 dispatch flow (docs/specs/dispatch-flow.md), on top of F6 (0055).
--
-- Adds, and only adds:
--   dispatch_requests            receipts for dispatch badge sign-ins and
--                                dispatch saves (own table: F6's
--                                scanner_requests and its checks/index stay
--                                exactly as installed)
--   dispatch_framer_attributions one immutable row per dispatch event and
--                                framed SKU: who framed it, measured ("scan")
--                                or asserted by the dispatcher ("manual")
--   scanner_activate_dispatch    owner/manager/kiosk: badge -> person; a new
--                                clock-in (once per site workday, same lock
--                                and rule as F6) is recorded as dispatch work
--   scanner_dispatch_evidence    owner/manager/kiosk: the framing evidence for
--                                one order's framed SKUs (same reader as the
--                                commit, so preview and save agree)
--   scanner_dispatch_people      owner/manager/kiosk: active badge holders of
--                                the site (id + name only) for the picker
--   scanner_commit_dispatch      owner/manager/kiosk: one atomic dispatch save
--                                for one order: dispatched event, dispatch
--                                stock (F6's locked deduction), F4 packaging,
--                                attribution rows and receipt, all or nothing
--   private helpers (no client grants)
--
-- Nothing existing is altered: no table, column, constraint, index, policy,
-- trigger, function or grant of 0001-0055 changes. F6's framing commit, its
-- receipts and the classic credit guard (c6) are untouched: the guard only
-- concerns framing credit, so a framing receipt never prevents a dispatch,
-- and duplicate framing credit stays blocked. The previous app version keeps
-- working: it never calls these functions.
--
-- Manual attribution creates NO production event (no line_verified,
-- started or completed row, no time, no framing credit).
--
-- Not applied by an agent. Codex/CJ apply it to staging only.
-- Requires 0047 and 0052-0055. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.dispatch_requests (
  location       TEXT        NOT NULL REFERENCES public.locations(key) ON DELETE RESTRICT,
  request_id     UUID        NOT NULL,
  kind           TEXT        NOT NULL CHECK (kind IN ('activate', 'dispatch')),
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
  CHECK ((kind = 'dispatch') = (order_number IS NOT NULL))
);

COMMENT ON TABLE public.dispatch_requests IS
  'F7: dispatch receipts. A retried request with the same id and payload gets the stored answer; a changed payload is refused. Written only by the scanner_*_dispatch functions.';

-- Backstop for exactly-once: at most one saved shared-scanner dispatch per order.
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_requests_one_dispatch_per_order
  ON public.dispatch_requests (location, order_number)
  WHERE kind = 'dispatch' AND outcome = 'saved';

CREATE TABLE IF NOT EXISTS public.dispatch_framer_attributions (
  location            TEXT        NOT NULL REFERENCES public.locations(key) ON DELETE RESTRICT,
  id                  TEXT        NOT NULL,
  request_id          UUID        NOT NULL,
  dispatch_event_id   TEXT        NOT NULL,
  order_number        TEXT        NOT NULL,
  sku                 TEXT        NOT NULL,
  work_type           TEXT        NOT NULL CHECK (work_type IN ('framed', 'a0_framed')),
  quantity            INTEGER     NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  source              TEXT        NOT NULL CHECK (source IN ('scan', 'manual')),
  person_id           UUID        NOT NULL,
  display_name        TEXT        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  verified_event_id   TEXT,
  completed_event_id  TEXT,
  dispatcher_id       UUID        NOT NULL,
  recorded_by         UUID        NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location, id),
  UNIQUE (location, dispatch_event_id, sku),
  -- A measured row names both events; a manual row names none.
  CHECK ((source = 'scan') = (verified_event_id IS NOT NULL)),
  CHECK ((source = 'scan') = (completed_event_id IS NOT NULL))
);

COMMENT ON TABLE public.dispatch_framer_attributions IS
  'F7: who framed each framed SKU of a shared-scanner dispatch. source=scan: measured (verifying + completing event ids). source=manual: asserted by the dispatcher; no framing event, time or credit exists for it. Immutable; written only by scanner_commit_dispatch.';

CREATE INDEX IF NOT EXISTS dispatch_framer_attributions_order_idx
  ON public.dispatch_framer_attributions (location, order_number);

-- Immutable: no update ever (the commit only inserts; there are no client writes).
CREATE OR REPLACE FUNCTION public.dispatch_attribution_immutable_()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'scanner: attribution_immutable' USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE TRIGGER dispatch_framer_attributions_immutable
  BEFORE UPDATE ON public.dispatch_framer_attributions
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_attribution_immutable_();

ALTER TABLE public.dispatch_requests            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_framer_attributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dispatch_requests_select ON public.dispatch_requests;
CREATE POLICY dispatch_requests_select ON public.dispatch_requests FOR SELECT
  USING (can_access_location(location) AND is_manager_or_higher());

-- The Reports roles (owner/manager) at their sites. Kiosks read only what a
-- dispatch needs, through scanner_dispatch_evidence.
DROP POLICY IF EXISTS dispatch_framer_attributions_select ON public.dispatch_framer_attributions;
CREATE POLICY dispatch_framer_attributions_select ON public.dispatch_framer_attributions FOR SELECT
  USING (can_access_location(location) AND is_manager_or_higher());

REVOKE ALL ON public.dispatch_requests, public.dispatch_framer_attributions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.dispatch_requests, public.dispatch_framer_attributions TO authenticated;

-- ---------------------------------------------------------------------------
-- Private helpers
-- ---------------------------------------------------------------------------

-- The name shown for a person at a site: their badge name (active first),
-- else their profile name.
CREATE OR REPLACE FUNCTION public.dispatch_person_name_(p_location TEXT, p_person UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT b.display_name FROM staff_barcodes b
      WHERE b.location = p_location AND b.user_id = p_person
      ORDER BY b.active DESC, b.barcode LIMIT 1),
    (SELECT pr.display_name FROM profiles pr WHERE pr.user_id = p_person),
    'Unknown person');
$$;

-- Framed lines: the F6 grammar ({sku, quantity, work_type}, A0 -> a0_framed,
-- A1-A4/GW sets -> framed), at most 50, distinct. Returns them canonical
-- (sorted by SKU) or raises invalid_input. An empty array is valid here.
CREATE OR REPLACE FUNCTION public.dispatch_canonical_lines_(p_lines JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_bad INTEGER;
  v_out JSONB;
BEGIN
  IF NOT COALESCE(jsonb_typeof(p_lines) = 'array' AND jsonb_array_length(p_lines) <= 50, false) THEN
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
  SELECT COALESCE(jsonb_agg(jsonb_build_object('sku', e.value->>'sku', 'quantity', (e.value->>'quantity')::NUMERIC::INTEGER,
                                               'work_type', e.value->>'work_type') ORDER BY e.value->>'sku'), '[]'::jsonb)
  INTO v_out
  FROM jsonb_array_elements(p_lines) e;
  RETURN v_out;
END;
$$;

-- Framing evidence for an order's framed SKUs. Caller has authorized the
-- site (and, when committing, holds the order lock).
--
-- Per required {sku, quantity, work_type}: a VALID PAIR is
--   an uncancelled line_verified L (no cancelled row with parent = L) of that
--   work type and SKU (case-insensitive), not CS replacement work, with
--   line_quantity >= the required quantity,
--   AND a completed C of the same work type by the SAME person, not CS work,
--   with C.created_at >= L.created_at (F6 writes both at the same instant;
--   event ids are never compared),
--   AND no attempt boundary between them: no whole-order (no SKU) or
--   same-SKU cancelled row of that work type without a parent, at a time in
--   [L.created_at, C.created_at].
-- status: measured (valid pairs of exactly one person; the latest L and its
-- first C are reported), missing (none), conflict (several people).
-- Bounded: more than 1000 events on the order raises evidence_overflow
-- instead of reading a truncated history.
CREATE OR REPLACE FUNCTION public.dispatch_framing_evidence_(p_location TEXT, p_order TEXT, p_lines JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n   INTEGER;
  v_out JSONB;
BEGIN
  SELECT count(*) INTO v_n
  FROM (SELECT 1 FROM production_events e WHERE e.location = p_location AND e.order_number = p_order LIMIT 1001) s;
  IF v_n > 1000 THEN
    RAISE EXCEPTION 'scanner: evidence_overflow' USING ERRCODE = 'P0001';
  END IF;

  WITH req AS (
    SELECT e.value->>'sku' AS sku, (e.value->>'quantity')::INTEGER AS qty, e.value->>'work_type' AS wt
    FROM   jsonb_array_elements(p_lines) e
  ),
  ev AS (
    SELECT e.id, e.staff_id, e.department, upper(btrim(e.line_sku)) AS sku, e.line_quantity,
           e.event_type, e.created_at, e.cs_case_id, e.parent_event_id
    FROM   production_events e
    WHERE  e.location = p_location AND e.order_number = p_order
  ),
  pairs AS (
    SELECT r.sku, v.staff_id, v.id AS vid, v.created_at AS vat,
           (SELECT c.id FROM ev c
            WHERE  c.event_type = 'completed' AND c.department = r.wt AND c.staff_id = v.staff_id
              AND  c.cs_case_id IS NULL AND c.created_at >= v.created_at
              AND  NOT EXISTS (
                     SELECT 1 FROM ev x
                     WHERE  x.event_type = 'cancelled' AND x.department = r.wt AND x.parent_event_id IS NULL
                       AND  (x.sku IS NULL OR x.sku = r.sku)
                       AND  x.created_at >= v.created_at AND x.created_at <= c.created_at)
            ORDER  BY c.created_at, c.id
            LIMIT  1) AS cid
    FROM   req r
    JOIN   ev v ON v.event_type = 'line_verified' AND v.department = r.wt AND v.sku = r.sku
                AND v.cs_case_id IS NULL AND COALESCE(v.line_quantity, 0) >= r.qty
    WHERE  NOT EXISTS (SELECT 1 FROM ev c WHERE c.event_type = 'cancelled' AND c.parent_event_id = v.id)
  ),
  valid AS (SELECT * FROM pairs WHERE cid IS NOT NULL)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'sku',                r.sku,
           'status',             CASE k.people WHEN 0 THEN 'missing' WHEN 1 THEN 'measured' ELSE 'conflict' END,
           'person_id',          CASE WHEN k.people = 1 THEN b.staff_id END,
           'display_name',       CASE WHEN k.people = 1 THEN dispatch_person_name_(p_location, b.staff_id) END,
           'verified_event_id',  CASE WHEN k.people = 1 THEN b.vid END,
           'completed_event_id', CASE WHEN k.people = 1 THEN b.cid END) ORDER BY r.sku), '[]'::jsonb)
  INTO   v_out
  FROM   req r
  CROSS  JOIN LATERAL (SELECT count(DISTINCT staff_id) AS people FROM valid WHERE valid.sku = r.sku) k
  LEFT   JOIN LATERAL (SELECT * FROM valid WHERE valid.sku = r.sku ORDER BY vat DESC, vid DESC LIMIT 1) b ON true;

  RETURN v_out;
END;
$$;

-- Active badge holder who is a member of the site, or NULL.
CREATE OR REPLACE FUNCTION public.dispatch_active_person_name_(p_location TEXT, p_person UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.display_name
  FROM   staff_barcodes b
  WHERE  b.location = p_location AND b.user_id = p_person AND b.active
    AND  EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = p_person AND ul.location = p_location)
  ORDER  BY b.barcode
  LIMIT  1;
$$;

-- ---------------------------------------------------------------------------
-- Dispatch badge activation
-- ---------------------------------------------------------------------------

-- As scanner_activate_badge (same role/site/caller checks before replay,
-- same unknown/unusable answers, same per-person clock lock and 04:00 site
-- workday rule), except: receipts are dispatch_requests kind 'activate'; a
-- NEW clock-in is a dispatch clock-in (dept 'dispatch'); an existing
-- clock-in of the workday (framing or dispatch) is never rewritten; the
-- answer adds workday_ends_at (next site 04:00).
CREATE OR REPLACE FUNCTION public.scanner_activate_dispatch(
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
  v_prev      dispatch_requests%ROWTYPE;
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
  -- One request id is one request, whichever receipt table holds it.
  IF EXISTS (SELECT 1 FROM scanner_requests r WHERE r.location = p_location AND r.request_id = p_request_id) THEN
    RAISE EXCEPTION 'scanner: request_conflict' USING ERRCODE = 'P0001';
  END IF;

  v_hash := scanner_hash_(jsonb_build_object('v', 1, 'kind', 'activate_dispatch', 'location', p_location,
              'receiver', p_receiver_id, 'scanner', p_scanner_id, 'badge', v_badge));

  SELECT * INTO v_prev FROM dispatch_requests WHERE location = p_location AND request_id = p_request_id;
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
    IF EXISTS (SELECT 1 FROM staff_barcodes b WHERE b.barcode = v_badge) THEN
      RETURN jsonb_build_object('status', 'unusable_badge');
    END IF;
    RETURN jsonb_build_object('status', 'unknown_badge');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = v_person AND ul.location = p_location) THEN
    RAISE EXCEPTION 'scanner: person_not_at_site' USING ERRCODE = 'P0001';
  END IF;

  -- The same per-person lock as F6 activation: one clock-in per person per
  -- site workday, whichever mode or scanner signs them in.
  PERFORM pg_advisory_xact_lock(hashtextextended('scanner-clock|' || p_location || '|' || v_person::text, 0));

  SELECT * INTO v_prev FROM dispatch_requests WHERE location = p_location AND request_id = p_request_id;
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
    VALUES (p_location, 'dsp-' || replace(p_request_id::text, '-', '') || '-ci', v_person, 'dispatch', NULL, 'clock_in',
            'shared:' || p_receiver_id || ':' || p_scanner_id, 'Sign in via shared dispatch scanner badge', now());
    v_clocked := true;
  END IF;

  v_result := jsonb_build_object(
    'status', 'activated', 'person_id', v_person, 'display_name', v_name, 'clocked_in', v_clocked,
    -- Next 04:00 site-local (DST-safe: the workday start of a moment ~30 h later).
    'workday_ends_at', to_char(scanner_workday_start_(p_location, v_start + interval '30 hours') AT TIME ZONE 'UTC',
                               'YYYY-MM-DD"T"HH24:MI:SS"Z"'));

  INSERT INTO dispatch_requests (location, request_id, kind, caller, receiver_id, scanner_id, staff_id, payload_hash, outcome, result)
  VALUES (p_location, p_request_id, 'activate', v_uid, p_receiver_id, p_scanner_id, v_person, v_hash, 'activated', v_result);

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Evidence preview and the picker's people
-- ---------------------------------------------------------------------------

-- Returns {status:"ok", lines:[{sku, status, person_id, display_name,
-- verified_event_id, completed_event_id}]} for exactly the given lines.
CREATE OR REPLACE FUNCTION public.scanner_dispatch_evidence(
  p_location      TEXT,
  p_order_number  TEXT,
  p_lines         JSONB,
  p_expected_caller UUID
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID := scanner_require_operator_(p_location);
  v_lines JSONB;
BEGIN
  IF p_expected_caller IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'scanner: caller_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF NOT COALESCE(p_order_number ~ '^10[0-9]{6}$', false) THEN
    RAISE EXCEPTION 'scanner: invalid_input' USING ERRCODE = 'P0001';
  END IF;
  v_lines := dispatch_canonical_lines_(p_lines);
  RETURN jsonb_build_object('status', 'ok', 'lines', dispatch_framing_evidence_(p_location, p_order_number, v_lines));
END;
$$;

-- Returns {status:"ok", people:[{person_id, display_name}]} sorted by name.
-- More than 500 raises people_overflow (never a silently cut list).
CREATE OR REPLACE FUNCTION public.scanner_dispatch_people(p_location TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := scanner_require_operator_(p_location);
  v_people JSONB;
  v_n      INTEGER;
BEGIN
  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object('person_id', q.user_id, 'display_name', q.display_name)
                                      ORDER BY lower(q.display_name), q.user_id), '[]'::jsonb)
  INTO   v_n, v_people
  FROM (
    SELECT DISTINCT ON (b.user_id) b.user_id, b.display_name
    FROM   staff_barcodes b
    WHERE  b.location = p_location AND b.active
      AND  EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = b.user_id AND ul.location = p_location)
    ORDER  BY b.user_id, b.barcode
    LIMIT  501
  ) q;
  IF v_n > 500 THEN
    RAISE EXCEPTION 'scanner: people_overflow' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'people', v_people);
END;
$$;

-- ---------------------------------------------------------------------------
-- Dispatch commit
-- ---------------------------------------------------------------------------

-- One atomic dispatch of one order by one dispatcher: the dispatched event,
-- dispatch-terminal stock (F6's locked deduction), the F4 Dispatch parcel,
-- one attribution row per framed SKU, and the receipt. Any failure rolls
-- everything back.
--
-- p_lines    the order's framed SKUs (F6 grammar, may be empty)
-- p_items    total ordered items (the dispatched event's line_quantity, as classic)
-- p_choices  [{sku, person_id}]: the dispatcher's assertion for SKUs without
--            measured evidence. Evidence is re-read under the order lock:
--            measured evidence that arrived meanwhile wins over a choice.
--
-- Returns {status:"saved", ...} (also on replay, with replayed:true) or
-- {status:"already_recorded", reason}. Refusals raise "scanner: <code>".
CREATE OR REPLACE FUNCTION public.scanner_commit_dispatch(
  p_location     TEXT,
  p_request_id   UUID,
  p_receiver_id  TEXT,
  p_scanner_id   TEXT,
  p_staff_id     UUID,
  p_badge        TEXT,
  p_order_number TEXT,
  p_scanned_at   TIMESTAMPTZ,
  p_items        INTEGER,
  p_lines        JSONB,
  p_components   JSONB,
  p_packaging    JSONB,
  p_choices      JSONB,
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
  v_choices    JSONB;
  v_bad        INTEGER;
  v_hash       TEXT;
  v_prev       dispatch_requests%ROWTYPE;
  v_name       TEXT;
  v_prior      TEXT;
  v_station    TEXT := 'shared:' || p_receiver_id || ':' || p_scanner_id;
  v_rid        TEXT := replace(p_request_id::text, '-', '');
  v_event      TEXT := 'dsp-' || replace(p_request_id::text, '-', '') || '-d';
  v_evidence   JSONB;
  v_ev         JSONB;
  v_line       JSONB;
  v_choice     UUID;
  v_who        TEXT;
  v_attr       JSONB := '[]'::jsonb;
  v_n          INTEGER := 0;
  v_deduct     JSONB := NULL;
  v_pack       JSONB := NULL;
  v_negative   TEXT[] := ARRAY[]::TEXT[];
  v_result     JSONB;
BEGIN
  IF p_expected_caller IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'scanner: caller_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- 1. Bounded input (null-safe: a missing key or NULL fails, never passes).
  IF NOT COALESCE(
       p_request_id IS NOT NULL AND p_staff_id IS NOT NULL
       AND p_scanned_at IS NOT NULL AND isfinite(p_scanned_at)
       AND p_receiver_id ~ '^[A-Za-z0-9_-]{1,32}$'
       AND p_scanner_id ~ '^[A-Z][A-Z0-9]{0,3}$'
       AND v_badge ~ '^[0-9A-F]{8}$'
       AND p_order_number ~ '^10[0-9]{6}$'
       AND p_items BETWEEN 1 AND 5000
       AND jsonb_typeof(p_components) = 'array' AND jsonb_array_length(p_components) <= 30
       AND jsonb_typeof(p_choices) = 'array' AND jsonb_array_length(p_choices) <= 50
       AND (p_packaging IS NULL OR jsonb_typeof(p_packaging) IN ('object', 'null'))
       AND COALESCE(pg_column_size(p_packaging), 0) <= 32768,
       false) THEN
    RAISE EXCEPTION 'scanner: invalid_input' USING ERRCODE = 'P0001';
  END IF;
  v_lines := dispatch_canonical_lines_(p_lines);
  IF (SELECT COALESCE(sum((e.value->>'quantity')::INTEGER), 0) FROM jsonb_array_elements(v_lines) e) > p_items THEN
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

  -- Choices: one per SKU, only for SKUs of this order's framed lines.
  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(p_choices) e
  WHERE NOT COALESCE(
          jsonb_typeof(e.value) = 'object'
          AND (SELECT count(*) FROM jsonb_object_keys(e.value)) = 2
          AND jsonb_typeof(e.value->'sku') = 'string'
          AND jsonb_typeof(e.value->'person_id') = 'string'
          AND (e.value->>'person_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) l WHERE l.value->>'sku' = e.value->>'sku'),
          false);
  IF v_bad > 0 OR (SELECT count(DISTINCT e.value->>'sku') FROM jsonb_array_elements(p_choices) e) <> jsonb_array_length(p_choices) THEN
    RAISE EXCEPTION 'scanner: invalid_input' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', e.value->>'code', 'qty', (e.value->>'qty')::NUMERIC::INTEGER) ORDER BY e.value->>'code'), '[]'::jsonb)
  INTO   v_components
  FROM   jsonb_array_elements(p_components) e;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('sku', e.value->>'sku', 'person_id', e.value->>'person_id') ORDER BY e.value->>'sku'), '[]'::jsonb)
  INTO   v_choices
  FROM   jsonb_array_elements(p_choices) e;

  -- 2. The server's own canonical hash of the request.
  v_hash := scanner_hash_(jsonb_build_object(
    'v', 1, 'kind', 'dispatch', 'location', p_location, 'receiver', p_receiver_id, 'scanner', p_scanner_id,
    'staff', p_staff_id, 'badge', v_badge, 'order', p_order_number,
    'scanned_at', to_char(p_scanned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'items', p_items, 'lines', v_lines, 'components', v_components, 'choices', v_choices,
    'packaging', CASE WHEN jsonb_typeof(p_packaging) = 'object' THEN p_packaging ELSE 'null'::jsonb END));

  -- 3. Serialize with every other writer of this order: F6 framing commits,
  --    classic framing credit (c6 guard), the legacy deduction, and other
  --    dispatches. Measured evidence is therefore final while we hold it.
  PERFORM production_order_lock_(p_location, p_order_number);

  -- 4. Replay: same request + same payload -> the stored answer.
  IF EXISTS (SELECT 1 FROM scanner_requests r WHERE r.location = p_location AND r.request_id = p_request_id) THEN
    RAISE EXCEPTION 'scanner: request_conflict' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_prev FROM dispatch_requests WHERE location = p_location AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prev.kind <> 'dispatch' OR v_prev.caller <> v_uid OR v_prev.payload_hash <> v_hash THEN
      RAISE EXCEPTION 'scanner: request_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_prev.result || jsonb_build_object('replayed', true);
  END IF;

  -- 5. Time: never in the future, and a bounded queue age (as F6).
  IF p_scanned_at > now() + interval '5 seconds' OR p_scanned_at < now() - interval '14 days' THEN
    RAISE EXCEPTION 'scanner: invalid_input' USING ERRCODE = 'P0001';
  END IF;

  -- 6. The dispatcher: active badge here, still a member of the site.
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

  -- 8. Already dispatched (classic or shared), or dispatch work recorded:
  --    report it, add nothing.
  SELECT CASE WHEN e.event_type = 'dispatched' THEN 'order already dispatched'
              ELSE 'dispatch work already recorded' END
  INTO   v_prior
  FROM   production_events e
  WHERE  e.location = p_location AND e.order_number = p_order_number
    AND  (e.event_type = 'dispatched'
          OR (e.department = 'dispatch' AND e.event_type IN ('completed', 'line_verified')
              AND NOT EXISTS (SELECT 1 FROM production_events c
                              WHERE c.location = e.location AND c.parent_event_id = e.id
                                AND c.event_type = 'cancelled')))
  ORDER  BY e.created_at, e.id
  LIMIT  1;
  IF v_prior IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_recorded', 'reason', v_prior);
  END IF;

  -- 9. Who framed each SKU, re-read under the lock. Measured wins; else the
  --    dispatcher's choice, if that person is still an active member here;
  --    else nothing is saved.
  v_evidence := dispatch_framing_evidence_(p_location, p_order_number, v_lines);
  FOR v_line IN SELECT e.value FROM jsonb_array_elements(v_lines) e ORDER BY e.value->>'sku' LOOP
    SELECT x.value INTO v_ev FROM jsonb_array_elements(v_evidence) x WHERE x.value->>'sku' = v_line->>'sku';
    v_n := v_n + 1;
    IF v_ev->>'status' = 'measured' THEN
      v_attr := v_attr || jsonb_build_object(
        'sku', v_line->>'sku', 'work_type', v_line->>'work_type', 'quantity', (v_line->>'quantity')::INTEGER,
        'source', 'scan', 'person_id', v_ev->>'person_id', 'display_name', v_ev->>'display_name',
        'verified_event_id', v_ev->>'verified_event_id', 'completed_event_id', v_ev->>'completed_event_id');
      CONTINUE;
    END IF;
    SELECT (c.value->>'person_id')::UUID INTO v_choice FROM jsonb_array_elements(v_choices) c WHERE c.value->>'sku' = v_line->>'sku';
    IF NOT FOUND OR v_choice IS NULL THEN
      RAISE EXCEPTION 'scanner: framer_missing: %', v_line->>'sku' USING ERRCODE = 'P0001';
    END IF;
    v_who := dispatch_active_person_name_(p_location, v_choice);
    IF v_who IS NULL THEN
      RAISE EXCEPTION 'scanner: framer_inactive: %', v_line->>'sku' USING ERRCODE = 'P0001';
    END IF;
    v_attr := v_attr || jsonb_build_object(
      'sku', v_line->>'sku', 'work_type', v_line->>'work_type', 'quantity', (v_line->>'quantity')::INTEGER,
      'source', 'manual', 'person_id', v_choice, 'display_name', v_who,
      'verified_event_id', NULL, 'completed_event_id', NULL);
    v_choice := NULL;
  END LOOP;

  -- 10. The dispatched event, as the classic dispatch completion writes it:
  --     whole order, total items, the dispatcher's own work. created_at is
  --     the original scan time.
  INSERT INTO production_events (location, id, staff_id, department, order_number, line_sku, line_quantity,
                                 event_type, station_id, note, created_at)
  VALUES (p_location, v_event, p_staff_id, 'dispatch', p_order_number, NULL, p_items,
          'dispatched', v_station, 'Shared scanner dispatch', p_scanned_at);

  -- 11. Dispatch-terminal stock. Anything already charged for the order
  --     (e.g. an accessory shipped from the A0 bench) is skipped by the
  --     ledger check, never charged twice. An unknown code refuses the save.
  IF jsonb_array_length(v_components) > 0 THEN
    v_deduct := production_deduct_locked_(p_location, v_event, p_order_number, 'dispatch', 'dispatched', v_components);
    IF jsonb_array_length(v_deduct->'missing_codes') > 0 THEN
      RAISE EXCEPTION 'scanner: missing_stock_code: %', v_deduct->'missing_codes' USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(array_agg(x), ARRAY[]::TEXT[]) INTO v_negative FROM jsonb_array_elements_text(v_deduct->'negative_codes') x;
  END IF;

  -- 12. F4: the Dispatch parcel (packing point = the event's department).
  --     The A0 parcel is a different pick; this never charges it.
  IF jsonb_typeof(p_packaging) = 'object' THEN
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
    v_pack := packaging_apply(p_location, 'dsp:' || p_request_id::text, v_event, p_packaging->>'rule_set_id',
                              true, p_packaging->'predicted', p_packaging->'target', p_packaging->'snapshot');
    IF v_pack->>'status' IS DISTINCT FROM 'applied' THEN
      RAISE EXCEPTION 'scanner: packaging_invalid: %', v_pack->>'status' USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_array_length(COALESCE(v_pack->'unposted', '[]'::jsonb)) > 0 THEN
      RAISE EXCEPTION 'scanner: packaging_unposted' USING ERRCODE = 'P0001';
    END IF;
    SELECT v_negative || COALESCE(array_agg(x), ARRAY[]::TEXT[]) INTO v_negative
    FROM jsonb_array_elements_text(COALESCE(v_pack->'negative', '[]'::jsonb)) x;
  END IF;

  -- 13. Attribution rows: one per framed SKU, immutable.
  INSERT INTO dispatch_framer_attributions (location, id, request_id, dispatch_event_id, order_number, sku, work_type, quantity,
                                            source, person_id, display_name, verified_event_id, completed_event_id,
                                            dispatcher_id, recorded_by)
  SELECT p_location, 'dfa-' || v_rid || '-' || lpad(a.ordinality::text, 2, '0'), p_request_id, v_event, p_order_number,
         a.value->>'sku', a.value->>'work_type', (a.value->>'quantity')::INTEGER,
         a.value->>'source', (a.value->>'person_id')::UUID, a.value->>'display_name',
         a.value->>'verified_event_id', a.value->>'completed_event_id', p_staff_id, v_uid
  FROM   jsonb_array_elements(v_attr) WITH ORDINALITY a;

  v_result := jsonb_build_object(
    'status',         'saved',
    'request_id',     p_request_id,
    'order_number',   p_order_number,
    'staff_id',       p_staff_id,
    'display_name',   v_name,
    'items',          p_items,
    'event_ids',      jsonb_build_array(v_event),
    'attributions',   (SELECT COALESCE(jsonb_agg(jsonb_build_object('sku', a.value->>'sku', 'source', a.value->>'source',
                                                                    'person_id', a.value->>'person_id', 'display_name', a.value->>'display_name')
                                                 ORDER BY a.value->>'sku'), '[]'::jsonb)
                       FROM jsonb_array_elements(v_attr) a),
    'deduction',      v_deduct,
    'packaging_pick', CASE WHEN v_pack IS NULL THEN NULL ELSE v_pack->'pick'->'id' END,
    'negative_codes', to_jsonb(v_negative)
  );

  -- 14. Receipt (the unique index backstops one saved dispatch per order).
  INSERT INTO dispatch_requests (location, request_id, kind, caller, receiver_id, scanner_id, staff_id, order_number,
                                 payload_hash, outcome, result, scanned_at)
  VALUES (p_location, p_request_id, 'dispatch', v_uid, p_receiver_id, p_scanner_id, p_staff_id, p_order_number,
          v_hash, 'saved', v_result, p_scanned_at);

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: nothing for anon or PUBLIC; helpers are internal only
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.dispatch_attribution_immutable_()                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispatch_person_name_(TEXT, UUID)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispatch_canonical_lines_(JSONB)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispatch_framing_evidence_(TEXT, TEXT, JSONB)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispatch_active_person_name_(TEXT, UUID)                FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.scanner_activate_dispatch(TEXT, UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.scanner_dispatch_evidence(TEXT, TEXT, JSONB, UUID)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.scanner_dispatch_people(TEXT)                                 FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.scanner_commit_dispatch(TEXT, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, INTEGER, JSONB, JSONB, JSONB, JSONB, UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.scanner_activate_dispatch(TEXT, UUID, TEXT, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.scanner_dispatch_evidence(TEXT, TEXT, JSONB, UUID)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.scanner_dispatch_people(TEXT)                                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.scanner_commit_dispatch(TEXT, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, INTEGER, JSONB, JSONB, JSONB, JSONB, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
