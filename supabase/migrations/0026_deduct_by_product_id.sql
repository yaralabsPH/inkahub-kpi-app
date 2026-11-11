-- 0026_deduct_by_product_id.sql
--
-- Extend deduct_inventory_for_event so each line's "code" field can be
-- EITHER a catalogue code (e.g. "A0-Double") OR a product id (e.g.
-- "sku-xniriygn"). The auto-assigned mail tubes from the Unframed
-- station are passed by product id; user-defined package codes still
-- resolve by code.
--
-- Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION deduct_inventory_for_event(
  p_event_id  TEXT,
  p_lines     JSONB  -- [{"code": "A2-Natural" or "sku-xniriygn", "qty": 6}, ...]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_location          TEXT;
  v_dept              TEXT;
  v_event_type        TEXT;
  v_order_number      TEXT;
  v_cs_case_id        TEXT;
  v_line              JSONB;
  v_code              TEXT;
  v_qty               NUMERIC;
  v_product_id        TEXT;
  v_source_id         TEXT;
  v_deducted_count    INTEGER := 0;
  v_skipped_count     INTEGER := 0;
  v_missing           TEXT[] := ARRAY[]::TEXT[];
  v_ledger_id         TEXT;
BEGIN
  SELECT location, department, event_type, order_number, cs_case_id
  INTO   v_location, v_dept, v_event_type, v_order_number, v_cs_case_id
  FROM   production_events
  WHERE  id = p_event_id;

  IF v_location IS NULL THEN
    RAISE EXCEPTION 'production_event % not found', p_event_id;
  END IF;

  IF v_cs_case_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'skipped_cs_case', 'event_id', p_event_id, 'cs_case_id', v_cs_case_id
    );
  END IF;

  IF v_event_type NOT IN ('completed', 'dispatched') THEN
    RETURN jsonb_build_object('status', 'skipped_event_type', 'event_type', v_event_type);
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_code := v_line->>'code';
    v_qty  := COALESCE((v_line->>'qty')::NUMERIC, 0);

    IF v_qty <= 0 OR v_code IS NULL OR v_code = '' THEN
      CONTINUE;
    END IF;

    -- Look up by code (case-insensitive) OR by product id (exact match)
    SELECT id INTO v_product_id
    FROM   products
    WHERE  location = v_location
       AND (lower(code) = lower(v_code) OR id = v_code)
    LIMIT  1;

    IF v_product_id IS NULL THEN
      v_missing := array_append(v_missing, v_code);
      CONTINUE;
    END IF;

    v_source_id := 'prod:' || p_event_id || ':' || v_code;
    IF EXISTS (
      SELECT 1 FROM ledger
      WHERE location = v_location AND source_id = v_source_id
    ) THEN
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    UPDATE products
    SET    current_on_hand = current_on_hand - v_qty
    WHERE  location = v_location AND id = v_product_id;

    v_ledger_id := 'led-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
    INSERT INTO ledger
      (location, id, product_id, delta, reason, source_id, parent_event_id, note)
    VALUES
      (v_location, v_ledger_id, v_product_id, -v_qty,
       'sale', v_source_id, p_event_id,
       'Auto-deduct from ' || v_dept || ' ' || v_event_type ||
       ' on order #' || v_order_number);

    v_deducted_count := v_deducted_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'status',             'ok',
    'event_id',           p_event_id,
    'order_number',       v_order_number,
    'department',         v_dept,
    'event_type',         v_event_type,
    'deducted',           v_deducted_count,
    'skipped_idempotent', v_skipped_count,
    'missing_codes',      v_missing
  );
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;