-- 0047_packaging_auto_pick.sql
--
-- F4 box-auto-pick (docs/specs/box-auto-pick.md).
--
-- Adds, and only adds:
--   packaging_settings       per-site mode: 'scan' (default, old behaviour) or 'auto'
--   packaging_rule_sets      versioned, immutable-once-active packaging rules
--   packaging_picks          one packaging record per (site, order, packing point, shipment)
--   packaging_pick_changes   append-only audit of every apply / override / retry
--   a unique partial index on ledger for the new 'pkg:' source keys
--   functions that do every write, each checking caller, site and role
--
-- Nothing existing is altered: no change to production_events, products,
-- ledger columns, deduct_inventory_for_event, or any existing policy or grant.
-- The previous app version ignores all of this and keeps the box-scan path.
--
-- Stock for a pick moves only by (target - posted), under a per-pick advisory
-- lock, so retries, double taps, replays and two devices deduct once.
--
-- NUMBER IS PROVISIONAL: 0034-0046 belong to feature/item-counting. Renumber
-- before applying if another feature has taken 0047. Not applied anywhere by
-- an agent; CJ applies to staging, then production.
--
-- Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS packaging_settings (
  location         TEXT        PRIMARY KEY REFERENCES locations(key) ON DELETE RESTRICT,
  mode             TEXT        NOT NULL DEFAULT 'scan' CHECK (mode IN ('scan', 'auto')),
  mode_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE packaging_settings IS
  'F4: per-site packaging mode. No row or mode=scan means the old box-scan behaviour.';

CREATE TABLE IF NOT EXISTS packaging_rule_sets (
  location      TEXT        NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id            TEXT        NOT NULL,
  version       INTEGER     NOT NULL CHECK (version > 0),
  status        TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  body          JSONB       NOT NULL,
  note          TEXT        NOT NULL DEFAULT '',
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_by  UUID,
  activated_at  TIMESTAMPTZ,
  PRIMARY KEY (location, id),
  UNIQUE (location, version)
);

COMMENT ON TABLE packaging_rule_sets IS
  'F4: versioned packaging rules (catalogue, rules, examples). Only drafts are editable; active and retired versions never change.';

CREATE UNIQUE INDEX IF NOT EXISTS packaging_rule_sets_one_active
  ON packaging_rule_sets (location) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS packaging_picks (
  location          TEXT        NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id                TEXT        NOT NULL,
  order_number      TEXT        NOT NULL CHECK (length(order_number) > 0),
  packing_point     TEXT        NOT NULL CHECK (packing_point IN ('a0_framed', 'unframed', 'dispatch')),
  shipment_key      TEXT        NOT NULL CHECK (length(shipment_key) > 0),
  state             TEXT        NOT NULL CHECK (state IN ('auto', 'overridden', 'unresolved', 'legacy_scan')),
  stock_state       TEXT        NOT NULL DEFAULT 'posted' CHECK (stock_state IN ('posted', 'short', 'unposted')),
  rule_set_id       TEXT,
  rule_set_version  INTEGER,
  input_snapshot    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  predicted         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  target            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  posted            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  revision          INTEGER     NOT NULL DEFAULT 1,
  post_seq          INTEGER     NOT NULL DEFAULT 0,
  source_event_id   TEXT,
  staff_id          UUID,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location, id),
  UNIQUE (location, order_number, packing_point, shipment_key)
);

COMMENT ON TABLE packaging_picks IS
  'F4: packaging for one shipment. predicted = what the rules said, target = what should be consumed, posted = what the ledger already reflects (product id -> qty).';

CREATE INDEX IF NOT EXISTS packaging_picks_created_idx
  ON packaging_picks (location, created_at DESC);
CREATE INDEX IF NOT EXISTS packaging_picks_attention_idx
  ON packaging_picks (location, created_at DESC)
  WHERE state = 'unresolved' OR stock_state <> 'posted';

CREATE TABLE IF NOT EXISTS packaging_pick_changes (
  location     TEXT        NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id           TEXT        NOT NULL,
  pick_id      TEXT        NOT NULL,
  revision     INTEGER     NOT NULL,
  request_id   TEXT        NOT NULL CHECK (length(request_id) BETWEEN 8 AND 120),
  kind         TEXT        NOT NULL CHECK (kind IN ('apply', 'override', 'retry')),
  actor        UUID,
  staff_id     UUID,
  reason       TEXT        NOT NULL DEFAULT '',
  before       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  after        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  deltas       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  result       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location, id),
  UNIQUE (location, request_id)
);

COMMENT ON TABLE packaging_pick_changes IS
  'F4: append-only audit. deltas = extra consumption per product (positive = taken from stock, negative = returned).';

CREATE INDEX IF NOT EXISTS packaging_pick_changes_pick_idx
  ON packaging_pick_changes (location, pick_id, created_at);

-- Backstop for exactly-once: one ledger row per packaging posting. Only the
-- new 'pkg:' keys are covered, so no existing row is checked or affected.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_pkg_source_unique
  ON ledger (location, source_id) WHERE source_id LIKE 'pkg:%';

-- ---------------------------------------------------------------------------
-- RLS: read with site access; no direct writes (functions only)
-- ---------------------------------------------------------------------------

ALTER TABLE packaging_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE packaging_rule_sets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE packaging_picks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE packaging_pick_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS packaging_settings_select ON packaging_settings;
CREATE POLICY packaging_settings_select ON packaging_settings FOR SELECT
  USING (can_access_location(location));

DROP POLICY IF EXISTS packaging_rule_sets_select ON packaging_rule_sets;
CREATE POLICY packaging_rule_sets_select ON packaging_rule_sets FOR SELECT
  USING (can_access_location(location));

DROP POLICY IF EXISTS packaging_picks_select ON packaging_picks;
CREATE POLICY packaging_picks_select ON packaging_picks FOR SELECT
  USING (can_access_location(location));

DROP POLICY IF EXISTS packaging_pick_changes_select ON packaging_pick_changes;
CREATE POLICY packaging_pick_changes_select ON packaging_pick_changes FOR SELECT
  USING (can_access_location(location));

REVOKE ALL ON packaging_settings, packaging_rule_sets, packaging_picks, packaging_pick_changes
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON packaging_settings, packaging_rule_sets, packaging_picks, packaging_pick_changes
  TO authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------

-- Caller must be signed in and have access to the site.
CREATE OR REPLACE FUNCTION packaging_require_site_(p_location TEXT)
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
    RAISE EXCEPTION 'packaging: not_authenticated' USING ERRCODE = 'P0001';
  END IF;
  IF p_location IS NULL OR NOT can_access_location(p_location) THEN
    RAISE EXCEPTION 'packaging: forbidden_location' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_uid;
END;
$$;

-- Product ids a pick at this site may use: the catalogue of the given rule
-- set plus the catalogue of the currently active rule set.
CREATE OR REPLACE FUNCTION packaging_allowed_products_(p_location TEXT, p_rule_set_id TEXT)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT c.item->>'product_id'), ARRAY[]::TEXT[])
  FROM   packaging_rule_sets rs
  CROSS  JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(rs.body->'catalogue') = 'array' THEN rs.body->'catalogue' ELSE '[]'::jsonb END
         ) AS c(item)
  WHERE  rs.location = p_location
    AND  rs.status IN ('active', 'retired')
    AND  (rs.id = p_rule_set_id OR rs.status = 'active')
    AND  c.item->>'product_id' IS NOT NULL;
$$;

-- A quantities object is { "<product id>": <whole number 1..20> }, at most 10
-- entries, every product in the allowed list and present at the site.
CREATE OR REPLACE FUNCTION packaging_check_quantities_(
  p_location TEXT,
  p_q        JSONB,
  p_allowed  TEXT[],
  p_what     TEXT
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
  v_val JSONB;
  v_n   NUMERIC;
BEGIN
  IF p_q IS NULL OR jsonb_typeof(p_q) <> 'object' THEN
    RAISE EXCEPTION 'packaging: invalid_quantities: % must be an object', p_what USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_q)) > 10 THEN
    RAISE EXCEPTION 'packaging: invalid_quantities: % has more than 10 items', p_what USING ERRCODE = 'P0001';
  END IF;
  FOR v_key, v_val IN SELECT key, value FROM jsonb_each(p_q) LOOP
    IF jsonb_typeof(v_val) <> 'number' THEN
      RAISE EXCEPTION 'packaging: invalid_quantities: % quantity for % is not a number', p_what, v_key USING ERRCODE = 'P0001';
    END IF;
    v_n := (v_val #>> '{}')::NUMERIC;
    IF v_n <> trunc(v_n) OR v_n < 1 OR v_n > 20 THEN
      RAISE EXCEPTION 'packaging: invalid_quantities: % quantity for % must be a whole number from 1 to 20', p_what, v_key USING ERRCODE = 'P0001';
    END IF;
    IF NOT (v_key = ANY (p_allowed)) THEN
      RAISE EXCEPTION 'packaging: not_in_catalogue: %', v_key USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM products WHERE location = p_location AND id = v_key) THEN
      RAISE EXCEPTION 'packaging: unknown_product: %', v_key USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$$;

-- Post (target - posted) for one pick. Caller holds the pick's advisory lock.
-- Returns { "deltas": {product: n}, "stock_state": "...", "unposted": [..], "negative": [..] }.
CREATE OR REPLACE FUNCTION packaging_reconcile_(p_location TEXT, p_pick_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pick       packaging_picks%ROWTYPE;
  v_posted     JSONB;
  v_deltas     JSONB := '{}'::jsonb;
  v_unposted   TEXT[] := ARRAY[]::TEXT[];
  v_negative   TEXT[] := ARRAY[]::TEXT[];
  v_pid        TEXT;
  v_d          INTEGER;
  v_new        INTEGER;
  v_on_hand    NUMERIC;
  v_seq        INTEGER;
  v_state      TEXT;
BEGIN
  SELECT * INTO v_pick
  FROM   packaging_picks
  WHERE  location = p_location AND id = p_pick_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packaging: pick_not_found' USING ERRCODE = 'P0001';
  END IF;

  v_posted := v_pick.posted;
  v_seq    := v_pick.post_seq + 1;

  -- Fixed product order so two reconciles can never deadlock on product rows.
  FOR v_pid IN
    SELECT k FROM (
      SELECT jsonb_object_keys(v_pick.target) AS k
      UNION
      SELECT jsonb_object_keys(v_pick.posted)
    ) keys ORDER BY k
  LOOP
    v_d := COALESCE((v_pick.target->>v_pid)::NUMERIC, 0)::INTEGER
         - COALESCE((v_pick.posted->>v_pid)::NUMERIC, 0)::INTEGER;
    CONTINUE WHEN v_d = 0;

    BEGIN
      UPDATE products
      SET    current_on_hand = current_on_hand - v_d
      WHERE  location = p_location AND id = v_pid
      RETURNING current_on_hand INTO v_on_hand;

      IF NOT FOUND THEN
        -- Product no longer exists at the site: leave it unposted, visibly.
        v_unposted := array_append(v_unposted, v_pid);
      ELSE
        INSERT INTO ledger (location, id, product_id, delta, reason, source_id, parent_event_id, note)
        VALUES (
          p_location,
          'led-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20),
          v_pid,
          -v_d,
          'sale',
          'pkg:' || p_pick_id || ':' || v_seq || ':' || v_pid,
          NULL,
          'Packaging ' || CASE WHEN v_d > 0 THEN 'used' ELSE 'returned' END ||
            ' at ' || v_pick.packing_point || ' for order #' || v_pick.order_number
        );

        v_new := COALESCE((v_posted->>v_pid)::NUMERIC, 0)::INTEGER + v_d;
        IF v_new > 0 THEN
          v_posted := jsonb_set(v_posted, ARRAY[v_pid], to_jsonb(v_new), true);
        ELSE
          v_posted := v_posted - v_pid;
        END IF;
        v_deltas := v_deltas || jsonb_build_object(v_pid, v_d);
        IF v_on_hand < 0 AND v_d > 0 THEN
          v_negative := array_append(v_negative, v_pid);
        END IF;
      END IF;
    EXCEPTION WHEN check_violation THEN
      -- The schema refused the stock level (on-hand floor). The sub-block's
      -- changes are rolled back; keep the quantity unposted for a later retry.
      v_unposted := array_append(v_unposted, v_pid);
    END;
  END LOOP;

  v_state := CASE
    WHEN array_length(v_unposted, 1) > 0 THEN 'unposted'
    WHEN array_length(v_negative, 1) > 0 THEN 'short'
    WHEN v_pick.stock_state = 'short' AND v_deltas = '{}'::jsonb THEN 'short'
    ELSE 'posted'
  END;

  UPDATE packaging_picks
  SET    posted      = v_posted,
         post_seq    = CASE WHEN v_deltas = '{}'::jsonb THEN post_seq ELSE v_seq END,
         stock_state = v_state,
         updated_at  = now()
  WHERE  location = p_location AND id = p_pick_id;

  RETURN jsonb_build_object(
    'deltas',      v_deltas,
    'stock_state', v_state,
    'unposted',    to_jsonb(v_unposted),
    'negative',    to_jsonb(v_negative)
  );
END;
$$;

CREATE OR REPLACE FUNCTION packaging_pick_json_(p_location TEXT, p_pick_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT to_jsonb(p) FROM packaging_picks p WHERE p.location = p_location AND p.id = p_pick_id;
$$;

CREATE OR REPLACE FUNCTION packaging_lock_(p_location TEXT, p_order TEXT, p_point TEXT, p_shipment TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_advisory_xact_lock(
    hashtextextended('packaging|' || p_location || '|' || p_order || '|' || p_point || '|' || p_shipment, 0)
  );
$$;

-- ---------------------------------------------------------------------------
-- Rules and mode (owner or manager)
-- ---------------------------------------------------------------------------

-- Create a draft (p_id NULL) or update an existing draft.
CREATE OR REPLACE FUNCTION packaging_save_rule_set(
  p_location TEXT,
  p_id       TEXT,
  p_body     JSONB,
  p_note     TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := packaging_require_site_(p_location);
  v_missing TEXT;
  v_id      TEXT := p_id;
  v_version INTEGER;
BEGIN
  IF NOT is_manager_or_higher() THEN
    RAISE EXCEPTION 'packaging: forbidden_role' USING ERRCODE = 'P0001';
  END IF;
  IF p_body IS NULL
     OR jsonb_typeof(p_body) <> 'object'
     OR (p_body->>'schema_version') IS DISTINCT FROM '1'
     OR jsonb_typeof(p_body->'catalogue') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_body->'rules')     IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_body->'examples')  IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'packaging: invalid_rule_set' USING ERRCODE = 'P0001';
  END IF;
  IF pg_column_size(p_body) > 262144 THEN
    RAISE EXCEPTION 'packaging: invalid_rule_set: too large' USING ERRCODE = 'P0001';
  END IF;

  SELECT c.item->>'product_id' INTO v_missing
  FROM   jsonb_array_elements(p_body->'catalogue') AS c(item)
  WHERE  NOT EXISTS (
           SELECT 1 FROM products pr
           WHERE pr.location = p_location AND pr.id = c.item->>'product_id'
         )
  LIMIT  1;
  IF FOUND THEN
    RAISE EXCEPTION 'packaging: unknown_product: %', COALESCE(v_missing, '(missing product_id)') USING ERRCODE = 'P0001';
  END IF;

  -- Serialise version numbering per site.
  PERFORM pg_advisory_xact_lock(hashtextextended('packaging-rules|' || p_location, 0));

  IF v_id IS NULL THEN
    SELECT COALESCE(max(version), 0) + 1 INTO v_version
    FROM   packaging_rule_sets WHERE location = p_location;
    v_id := 'prs-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
    INSERT INTO packaging_rule_sets (location, id, version, status, body, note, created_by)
    VALUES (p_location, v_id, v_version, 'draft', p_body, COALESCE(left(p_note, 500), ''), v_uid);
  ELSE
    UPDATE packaging_rule_sets
    SET    body = p_body, note = COALESCE(left(p_note, 500), ''), updated_at = now()
    WHERE  location = p_location AND id = v_id AND status = 'draft';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'packaging: not_a_draft' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN (SELECT to_jsonb(rs) FROM packaging_rule_sets rs WHERE rs.location = p_location AND rs.id = v_id);
END;
$$;

-- Make a draft the active version; the previous active one is retired.
-- The app runs every stored example before calling this; the server requires
-- that at least one example exists.
CREATE OR REPLACE FUNCTION packaging_activate_rule_set(p_location TEXT, p_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := packaging_require_site_(p_location);
  v_body JSONB;
BEGIN
  IF NOT is_manager_or_higher() THEN
    RAISE EXCEPTION 'packaging: forbidden_role' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('packaging-rules|' || p_location, 0));

  SELECT body INTO v_body
  FROM   packaging_rule_sets
  WHERE  location = p_location AND id = p_id AND status = 'draft'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packaging: not_a_draft' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(v_body->'examples') < 1 THEN
    RAISE EXCEPTION 'packaging: no_examples' USING ERRCODE = 'P0001';
  END IF;

  UPDATE packaging_rule_sets
  SET    status = 'retired', updated_at = now()
  WHERE  location = p_location AND status = 'active';

  UPDATE packaging_rule_sets
  SET    status = 'active', activated_by = v_uid, activated_at = now(), updated_at = now()
  WHERE  location = p_location AND id = p_id;

  RETURN (SELECT to_jsonb(rs) FROM packaging_rule_sets rs WHERE rs.location = p_location AND rs.id = p_id);
END;
$$;

CREATE OR REPLACE FUNCTION packaging_set_mode(p_location TEXT, p_mode TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := packaging_require_site_(p_location);
BEGIN
  IF NOT is_manager_or_higher() THEN
    RAISE EXCEPTION 'packaging: forbidden_role' USING ERRCODE = 'P0001';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('scan', 'auto') THEN
    RAISE EXCEPTION 'packaging: invalid_mode' USING ERRCODE = 'P0001';
  END IF;
  IF p_mode = 'auto' AND NOT EXISTS (
       SELECT 1 FROM packaging_rule_sets WHERE location = p_location AND status = 'active'
     ) THEN
    RAISE EXCEPTION 'packaging: no_active_rule_set' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO packaging_settings (location, mode, mode_changed_at, updated_by, updated_at)
  VALUES (p_location, p_mode, now(), v_uid, now())
  ON CONFLICT (location) DO UPDATE
    SET mode_changed_at = CASE WHEN packaging_settings.mode = EXCLUDED.mode
                               THEN packaging_settings.mode_changed_at ELSE now() END,
        mode            = EXCLUDED.mode,
        updated_by      = EXCLUDED.updated_by,
        updated_at      = now();

  RETURN (SELECT to_jsonb(s) FROM packaging_settings s WHERE s.location = p_location);
END;
$$;

-- ---------------------------------------------------------------------------
-- Apply: create the pick for a saved completion event and post its stock
-- ---------------------------------------------------------------------------

-- p_resolved = false with an empty target records an 'unresolved' pick
-- (nothing deducted, flagged for follow-up).
CREATE OR REPLACE FUNCTION packaging_apply(
  p_location        TEXT,
  p_request_id      TEXT,
  p_event_id        TEXT,
  p_rule_set_id     TEXT,
  p_resolved        BOOLEAN,
  p_predicted       JSONB,
  p_target          JSONB,
  p_input_snapshot  JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := packaging_require_site_(p_location);
  v_event     production_events%ROWTYPE;
  v_shipment  TEXT;
  v_version   INTEGER;
  v_allowed   TEXT[];
  v_pick_id   TEXT;
  v_existing  TEXT;
  v_prev      JSONB;
  v_legacy    JSONB;
  v_state     TEXT;
  v_target    JSONB := COALESCE(p_target, '{}'::jsonb);
  v_predicted JSONB := COALESCE(p_predicted, '{}'::jsonb);
  v_rec       JSONB;
  v_result    JSONB;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 8 AND 120 THEN
    RAISE EXCEPTION 'packaging: invalid_request_id' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_event
  FROM   production_events
  WHERE  location = p_location AND id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packaging: event_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_event.event_type NOT IN ('completed', 'dispatched') THEN
    RAISE EXCEPTION 'packaging: event_not_terminal' USING ERRCODE = 'P0001';
  END IF;
  IF v_event.department NOT IN ('a0_framed', 'unframed', 'dispatch') THEN
    RAISE EXCEPTION 'packaging: not_a_packing_point' USING ERRCODE = 'P0001';
  END IF;
  -- Same rule as the production_events insert policy (0028).
  IF NOT (v_event.staff_id = v_uid OR is_kiosk_or_higher()) THEN
    RAISE EXCEPTION 'packaging: forbidden_role' USING ERRCODE = 'P0001';
  END IF;

  v_shipment := CASE WHEN v_event.cs_case_id IS NULL OR v_event.cs_case_id = ''
                     THEN 'orig' ELSE 'cs:' || v_event.cs_case_id END;

  SELECT version INTO v_version
  FROM   packaging_rule_sets
  WHERE  location = p_location AND id = p_rule_set_id AND status IN ('active', 'retired');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packaging: rule_set_not_found' USING ERRCODE = 'P0001';
  END IF;

  v_allowed := packaging_allowed_products_(p_location, p_rule_set_id);
  PERFORM packaging_check_quantities_(p_location, v_predicted, v_allowed, 'predicted');
  PERFORM packaging_check_quantities_(p_location, v_target,    v_allowed, 'target');
  IF p_input_snapshot IS NOT NULL AND pg_column_size(p_input_snapshot) > 32768 THEN
    RAISE EXCEPTION 'packaging: snapshot_too_large' USING ERRCODE = 'P0001';
  END IF;

  PERFORM packaging_lock_(p_location, v_event.order_number, v_event.department, v_shipment);

  -- Replay of the same request: return what we answered the first time.
  SELECT result INTO v_prev
  FROM   packaging_pick_changes
  WHERE  location = p_location AND request_id = p_request_id;
  IF FOUND THEN
    RETURN v_prev || jsonb_build_object('replayed', true);
  END IF;

  -- The shipment already has a pick (second device, or the order completed
  -- again): nothing more is deducted.
  SELECT id INTO v_existing
  FROM   packaging_picks
  WHERE  location = p_location AND order_number = v_event.order_number
    AND  packing_point = v_event.department AND shipment_key = v_shipment;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_applied',
      'pick',   packaging_pick_json_(p_location, v_existing)
    );
  END IF;

  -- Adopt packaging the old scan path already deducted for this order at
  -- this station, so it is not deducted a second time. The old keys are
  -- "prod:order_<n>:<code or id as scanned>".
  v_legacy := '{}'::jsonb;
  IF v_shipment = 'orig' THEN
    SELECT COALESCE(jsonb_object_agg(q.product_id, q.qty), '{}'::jsonb) INTO v_legacy
    FROM (
      SELECT l.product_id, (-sum(l.delta))::INTEGER AS qty
      FROM   ledger l
      JOIN   products pr ON pr.location = l.location AND pr.id = l.product_id
      JOIN   production_events e ON e.location = l.location AND e.id = l.parent_event_id
      WHERE  l.location = p_location
        AND  l.product_id = ANY (v_allowed)
        AND  l.source_id IN ('prod:order_' || v_event.order_number || ':' || pr.code,
                             'prod:order_' || v_event.order_number || ':' || pr.id)
        AND  e.department = v_event.department
      GROUP  BY l.product_id
      HAVING -sum(l.delta) >= 1
    ) q;
  END IF;

  IF v_legacy <> '{}'::jsonb THEN
    v_state  := 'legacy_scan';
    v_target := v_legacy;
  ELSIF NOT COALESCE(p_resolved, false) AND v_target = '{}'::jsonb THEN
    v_state := 'unresolved';
  ELSIF v_target IS DISTINCT FROM v_predicted OR NOT COALESCE(p_resolved, false) THEN
    v_state := 'overridden';
  ELSE
    v_state := 'auto';
  END IF;

  v_pick_id := 'pkp-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
  INSERT INTO packaging_picks (
    location, id, order_number, packing_point, shipment_key, state,
    rule_set_id, rule_set_version, input_snapshot, predicted, target, posted,
    source_event_id, staff_id, created_by
  ) VALUES (
    p_location, v_pick_id, v_event.order_number, v_event.department, v_shipment, v_state,
    p_rule_set_id, v_version, COALESCE(p_input_snapshot, '{}'::jsonb), v_predicted, v_target, v_legacy,
    p_event_id, v_event.staff_id, v_uid
  );

  v_rec := packaging_reconcile_(p_location, v_pick_id);

  v_result := jsonb_build_object(
    'status',   'applied',
    'pick',     packaging_pick_json_(p_location, v_pick_id),
    'deltas',   v_rec->'deltas',
    'unposted', v_rec->'unposted',
    'negative', v_rec->'negative'
  );

  INSERT INTO packaging_pick_changes (
    location, id, pick_id, revision, request_id, kind, actor, staff_id, reason,
    before, after, deltas, result
  ) VALUES (
    p_location, 'pkc-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
    v_pick_id, 1, p_request_id, 'apply', v_uid, v_event.staff_id, '',
    '{}'::jsonb, v_target, v_rec->'deltas', v_result
  );

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Override: change what a pick consumed; stock moves by the difference
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION packaging_override(
  p_location           TEXT,
  p_request_id         TEXT,
  p_pick_id            TEXT,
  p_expected_revision  INTEGER,
  p_target             JSONB,
  p_reason             TEXT,
  p_staff_id           UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := packaging_require_site_(p_location);
  v_pick    packaging_picks%ROWTYPE;
  v_prev    JSONB;
  v_target  JSONB := COALESCE(p_target, '{}'::jsonb);
  v_reason  TEXT := btrim(COALESCE(p_reason, ''));
  v_rec     JSONB;
  v_result  JSONB;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 8 AND 120 THEN
    RAISE EXCEPTION 'packaging: invalid_request_id' USING ERRCODE = 'P0001';
  END IF;
  IF NOT ((p_staff_id IS NOT NULL AND p_staff_id = v_uid) OR is_kiosk_or_higher()) THEN
    RAISE EXCEPTION 'packaging: forbidden_role' USING ERRCODE = 'P0001';
  END IF;
  IF length(v_reason) < 1 OR length(v_reason) > 300 THEN
    RAISE EXCEPTION 'packaging: reason_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_pick FROM packaging_picks WHERE location = p_location AND id = p_pick_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packaging: pick_not_found' USING ERRCODE = 'P0001';
  END IF;

  PERFORM packaging_lock_(p_location, v_pick.order_number, v_pick.packing_point, v_pick.shipment_key);

  SELECT result INTO v_prev
  FROM   packaging_pick_changes
  WHERE  location = p_location AND request_id = p_request_id;
  IF FOUND THEN
    RETURN v_prev || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_pick
  FROM   packaging_picks
  WHERE  location = p_location AND id = p_pick_id
  FOR UPDATE;

  IF p_expected_revision IS NULL OR v_pick.revision <> p_expected_revision THEN
    RETURN jsonb_build_object('status', 'conflict', 'pick', to_jsonb(v_pick));
  END IF;

  PERFORM packaging_check_quantities_(
    p_location, v_target, packaging_allowed_products_(p_location, v_pick.rule_set_id), 'target'
  );

  IF v_target = v_pick.target THEN
    RETURN jsonb_build_object('status', 'unchanged', 'pick', to_jsonb(v_pick));
  END IF;

  UPDATE packaging_picks
  SET    target = v_target, state = 'overridden', revision = revision + 1, updated_at = now()
  WHERE  location = p_location AND id = p_pick_id;

  v_rec := packaging_reconcile_(p_location, p_pick_id);

  v_result := jsonb_build_object(
    'status',   'overridden',
    'pick',     packaging_pick_json_(p_location, p_pick_id),
    'deltas',   v_rec->'deltas',
    'unposted', v_rec->'unposted',
    'negative', v_rec->'negative'
  );

  INSERT INTO packaging_pick_changes (
    location, id, pick_id, revision, request_id, kind, actor, staff_id, reason,
    before, after, deltas, result
  ) VALUES (
    p_location, 'pkc-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
    p_pick_id, v_pick.revision + 1, p_request_id, 'override', v_uid, p_staff_id, v_reason,
    v_pick.target, v_target, v_rec->'deltas', v_result
  );

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Retry: post whatever is still unposted on a pick (manager or owner)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION packaging_retry(p_location TEXT, p_request_id TEXT, p_pick_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := packaging_require_site_(p_location);
  v_pick   packaging_picks%ROWTYPE;
  v_prev   JSONB;
  v_rec    JSONB;
  v_result JSONB;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 8 AND 120 THEN
    RAISE EXCEPTION 'packaging: invalid_request_id' USING ERRCODE = 'P0001';
  END IF;
  IF NOT is_manager_or_higher() THEN
    RAISE EXCEPTION 'packaging: forbidden_role' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_pick FROM packaging_picks WHERE location = p_location AND id = p_pick_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'packaging: pick_not_found' USING ERRCODE = 'P0001';
  END IF;

  PERFORM packaging_lock_(p_location, v_pick.order_number, v_pick.packing_point, v_pick.shipment_key);

  SELECT result INTO v_prev
  FROM   packaging_pick_changes
  WHERE  location = p_location AND request_id = p_request_id;
  IF FOUND THEN
    RETURN v_prev || jsonb_build_object('replayed', true);
  END IF;

  v_rec := packaging_reconcile_(p_location, p_pick_id);

  v_result := jsonb_build_object(
    'status',   'retried',
    'pick',     packaging_pick_json_(p_location, p_pick_id),
    'deltas',   v_rec->'deltas',
    'unposted', v_rec->'unposted',
    'negative', v_rec->'negative'
  );

  INSERT INTO packaging_pick_changes (
    location, id, pick_id, revision, request_id, kind, actor, staff_id, reason,
    before, after, deltas, result
  ) VALUES (
    p_location, 'pkc-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
    p_pick_id, v_pick.revision, p_request_id, 'retry', v_uid, NULL, '',
    v_pick.target, v_pick.target, v_rec->'deltas', v_result
  );

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: nothing for anon or PUBLIC; helpers are internal only
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION packaging_require_site_(TEXT)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION packaging_allowed_products_(TEXT, TEXT)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION packaging_check_quantities_(TEXT, JSONB, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION packaging_reconcile_(TEXT, TEXT)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION packaging_pick_json_(TEXT, TEXT)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION packaging_lock_(TEXT, TEXT, TEXT, TEXT)                FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION packaging_save_rule_set(TEXT, TEXT, JSONB, TEXT)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION packaging_activate_rule_set(TEXT, TEXT)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION packaging_set_mode(TEXT, TEXT)                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION packaging_apply(TEXT, TEXT, TEXT, TEXT, BOOLEAN, JSONB, JSONB, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION packaging_override(TEXT, TEXT, TEXT, INTEGER, JSONB, TEXT, UUID)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION packaging_retry(TEXT, TEXT, TEXT)                      FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION packaging_save_rule_set(TEXT, TEXT, JSONB, TEXT)       TO authenticated;
GRANT EXECUTE ON FUNCTION packaging_activate_rule_set(TEXT, TEXT)                TO authenticated;
GRANT EXECUTE ON FUNCTION packaging_set_mode(TEXT, TEXT)                         TO authenticated;
GRANT EXECUTE ON FUNCTION packaging_apply(TEXT, TEXT, TEXT, TEXT, BOOLEAN, JSONB, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION packaging_override(TEXT, TEXT, TEXT, INTEGER, JSONB, TEXT, UUID)      TO authenticated;
GRANT EXECUTE ON FUNCTION packaging_retry(TEXT, TEXT, TEXT)                      TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
