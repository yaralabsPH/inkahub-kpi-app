-- ============================================================================
-- INKA ARTHOUSE — atomic shipment inventory RPCs
-- ============================================================================
-- MOVE THIS FILE TO: stock-app/supabase/migrations/0014_shipment_inventory_rpcs.sql
-- (Claude couldn't write into the subdirectory directly — EPERM. Drop it in
-- the migrations folder yourself, then run in Supabase SQL Editor.)
-- ============================================================================
-- Closes the duplicate-credit race in SupabaseRepo.upsertShipment:
--   Old flow (RACY):
--     1. client reads prev shipment row (sees inventory_applied_at = null)
--     2. client calls adjust_on_hand for each line (credits stock)
--     3. client upserts shipment with inventory_applied_at = now()
--   Two concurrent saves (double-click) both observe applied=null at step 1,
--   both fire credits at step 2, both win race-of-writes at step 3 →
--   double credit, single applied_at flag.
--
-- New flow:
--   1. client calls reverse_shipment_delivery (if transitioning OUT of Delivered)
--   2. client upserts shipment row (DOES NOT modify inventory_applied_at — RPCs
--      are the sole writer of this column)
--   3. client calls apply_shipment_delivery (if new status is Delivered)
-- Both RPCs SELECT ... FOR UPDATE the shipment row, check the flag, and
-- update credit+flag in one atomic transaction. Concurrent calls serialize
-- on the row lock; idempotent — a second call sees the flag already set
-- and returns 'noop'.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- apply_shipment_delivery
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apply_shipment_delivery(
  p_location    TEXT,
  p_shipment_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ship           shipments%ROWTYPE;
  v_line           JSONB;
  v_lines_credited INT := 0;
BEGIN
  IF NOT can_access_location(p_location) THEN
    RAISE EXCEPTION 'No access to location %', p_location
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ship
    FROM shipments
   WHERE location = p_location AND id = p_shipment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'noop', 'reason', 'shipment_not_found');
  END IF;

  IF v_ship.inventory_applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('action', 'noop', 'reason', 'already_applied');
  END IF;

  IF v_ship.status <> 'Delivered' THEN
    RETURN jsonb_build_object('action', 'noop', 'reason', 'not_delivered');
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_ship.lines)
  LOOP
    PERFORM adjust_on_hand(
      p_location,
      (v_line->>'product_id')::text,
      -((v_line->>'quantity')::numeric),
      'shipment',
      'shipment:' || p_shipment_id || ':' || (v_line->>'product_id')::text,
      'shipment:' || p_shipment_id,
      'Delivered: ' || v_ship.po_number
    );
    v_lines_credited := v_lines_credited + 1;
  END LOOP;

  UPDATE shipments
     SET inventory_applied_at = now()
   WHERE location = p_location AND id = p_shipment_id;

  RETURN jsonb_build_object(
    'action', 'credited',
    'lines',  v_lines_credited
  );
END;
$$;


-- ----------------------------------------------------------------------------
-- reverse_shipment_delivery
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reverse_shipment_delivery(
  p_location    TEXT,
  p_shipment_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ship           shipments%ROWTYPE;
  v_line           JSONB;
  v_lines_reversed INT := 0;
BEGIN
  IF NOT can_access_location(p_location) THEN
    RAISE EXCEPTION 'No access to location %', p_location
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ship
    FROM shipments
   WHERE location = p_location AND id = p_shipment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'noop', 'reason', 'shipment_not_found');
  END IF;

  IF v_ship.inventory_applied_at IS NULL THEN
    RETURN jsonb_build_object('action', 'noop', 'reason', 'not_applied');
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_ship.lines)
  LOOP
    PERFORM adjust_on_hand(
      p_location,
      (v_line->>'product_id')::text,
      ((v_line->>'quantity')::numeric),
      'shipment',
      'shipment:' || p_shipment_id || ':' || (v_line->>'product_id')::text || ':reverse',
      'shipment:' || p_shipment_id,
      'Reverse of Delivered: ' || v_ship.po_number
    );
    v_lines_reversed := v_lines_reversed + 1;
  END LOOP;

  UPDATE shipments
     SET inventory_applied_at = NULL
   WHERE location = p_location AND id = p_shipment_id;

  RETURN jsonb_build_object(
    'action', 'reversed',
    'lines',  v_lines_reversed
  );
END;
$$;


-- ----------------------------------------------------------------------------
-- delete_shipment_atomic
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delete_shipment_atomic(
  p_location    TEXT,
  p_shipment_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ship           shipments%ROWTYPE;
  v_line           JSONB;
  v_lines_reversed INT := 0;
BEGIN
  IF NOT can_access_location(p_location) THEN
    RAISE EXCEPTION 'No access to location %', p_location
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ship
    FROM shipments
   WHERE location = p_location AND id = p_shipment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'noop', 'reason', 'shipment_not_found');
  END IF;

  IF v_ship.inventory_applied_at IS NOT NULL THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(v_ship.lines)
    LOOP
      PERFORM adjust_on_hand(
        p_location,
        (v_line->>'product_id')::text,
        ((v_line->>'quantity')::numeric),
        'shipment',
        'shipment:' || p_shipment_id || ':' || (v_line->>'product_id')::text || ':delete',
        'shipment:' || p_shipment_id,
        'Shipment ' || v_ship.po_number || ' deleted — credit reversed'
      );
      v_lines_reversed := v_lines_reversed + 1;
    END LOOP;
  END IF;

  DELETE FROM shipments
   WHERE location = p_location AND id = p_shipment_id;

  RETURN jsonb_build_object(
    'action', 'deleted',
    'lines_reversed', v_lines_reversed
  );
END;
$$;


-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION apply_shipment_delivery(TEXT, TEXT)   TO authenticated;
GRANT EXECUTE ON FUNCTION reverse_shipment_delivery(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_shipment_atomic(TEXT, TEXT)    TO authenticated;
