-- 0031_order_based_idempotency.sql
--
-- Switch the deduction idempotency key from per-event to per-order. The
-- old key "prod:<event_id>:<code>" treated each event as a distinct
-- deduction surface, which means a mixed order that fires deductions at
-- BOTH a0_framed completion AND dispatch dispatched would deduct the
-- same line twice.
--
-- The new key "prod:order_<order_number>:<code>" makes (order, code)
-- the unique deduction surface. Implications:
--   - First terminal completion deducts. Any later one for the same
--     order + code skips with v_skipped_count++.
--   - Accidental double-Complete on the same order = no double-deduct.
--   - The (order_number, code) pair is the natural unit of "this line
--     has been billed against stock once".
--
-- Existing ledger rows (with old event-based source_ids) are left
-- untouched. New deductions written from here onwards use the new
-- pattern.
--
-- Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION deduct_inventory_for_event(
  p_event_id  TEXT,
  p_lines     JSONB
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
  v_new_on_hand       NUMERIC;
  v_deducted_count    INTEGER := 0;
  v_skipped_count     INTEGER := 0;
  v_missing           TEXT[] := ARRAY[]::TEXT[];
  v_negative          TEXT[] := ARRAY[]::TEXT[];
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
    RETURN jsonb_build_object('status', 'skipped_cs_case', 'event_id', p_event_id, 'cs_case_id', v_cs_case_id);
  END IF;

  IF v_event_type NOT IN ('completed', 'dispatched') THEN
    RETURN jsonb_build_object('status', 'skipped_event_type', 'event_type', v_event_type);
  END IF;

  IF v_order_number IS NULL OR v_order_number = '' THEN
    RETURN jsonb_build_object('status', 'skipped_no_order', 'event_id', p_event_id);
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_code := v_line->>'code';
    v_qty  := COALESCE((v_line->>'qty')::NUMERIC, 0);

    IF v_qty <= 0 OR v_code IS NULL OR v_code = '' THEN
      CONTINUE;
    END IF;

    SELECT id INTO v_product_id
    FROM   products
    WHERE  location = v_location
       AND (lower(code) = lower(v_code) OR id = v_code)
    LIMIT  1;

    IF v_product_id IS NULL THEN
      v_missing := array_append(v_missing, v_code);
      CONTINUE;
    END IF;

    -- NEW: per-order source_id. (order_number, code) is the unique
    -- deduction surface, not the event_id.
    v_source_id := 'prod:order_' || v_order_number || ':' || v_code;
    IF EXISTS (
      SELECT 1 FROM ledger
      WHERE location = v_location AND source_id = v_source_id
    ) THEN
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    UPDATE products
    SET    current_on_hand = current_on_hand - v_qty
    WHERE  location = v_location AND id = v_product_id
    RETURNING current_on_hand INTO v_new_on_hand;

    IF v_new_on_hand < 0 THEN
      v_negative := array_append(v_negative, v_code);
    END IF;

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
    'missing_codes',      v_missing,
    'negative_codes',     v_negative
  );
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;