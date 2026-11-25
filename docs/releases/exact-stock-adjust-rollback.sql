-- ROLLBACK for 0063_exact_stock_adjust.sql (CJ runs this only if needed).
-- Restores the 0002 definitions of adjust_on_hand and cascade_bom_step
-- (results floored at zero). Function bodies copied verbatim from
-- 0002_rpc.sql. CREATE OR REPLACE keeps owner and grants. Rolling back does
-- not change any stock already recorded.

BEGIN;

CREATE OR REPLACE FUNCTION public.adjust_on_hand(
  p_location         TEXT,
  p_product_id       TEXT,
  p_delta            NUMERIC,
  p_reason           TEXT,
  p_source_id        TEXT DEFAULT NULL,
  p_parent_event_id  TEXT DEFAULT NULL,
  p_note             TEXT DEFAULT ''
) RETURNS TABLE(rows_touched INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product        products%ROWTYPE;
  v_before         NUMERIC;
  v_after          NUMERIC;
  v_actual_delta   NUMERIC;
  v_ledger_id      TEXT;
  v_component      JSONB;
  v_rows_touched   INT := 0;
  v_cascade_root   TEXT;
BEGIN
  -- Authorization check — RPC functions with SECURITY DEFINER bypass RLS,
  -- so we have to re-verify the caller can access the location.
  IF NOT can_access_location(p_location) THEN
    RAISE EXCEPTION 'No access to location %', p_location
      USING ERRCODE = '42501';
  END IF;

  IF p_delta IS NULL OR p_delta = 0 THEN
    RETURN QUERY SELECT 0;
    RETURN;
  END IF;

  -- Lock + read the parent row.
  SELECT * INTO v_product
    FROM products
   WHERE location = p_location AND id = p_product_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Product doesn't exist — no-op (matches DexieRepo behavior).
    RETURN QUERY SELECT 0;
    RETURN;
  END IF;

  v_before := COALESCE(v_product.current_on_hand, 0);
  v_after  := GREATEST(v_before - p_delta, 0);
  v_actual_delta := v_after - v_before;  -- signed, natural direction

  IF v_actual_delta = 0 THEN
    -- Floor-at-zero clamp swallowed the change, or input was a no-op.
    RETURN QUERY SELECT 0;
    RETURN;
  END IF;

  -- Apply the parent update.
  UPDATE products
     SET current_on_hand = v_after
   WHERE location = p_location AND id = p_product_id;

  -- Generate a sortable ledger id (unix-ms + random suffix).
  v_ledger_id := (extract(epoch from now()) * 1000)::bigint::text
              || '-'
              || substr(md5(random()::text), 1, 6);

  INSERT INTO ledger (location, id, ts, product_id, delta, reason,
                      source_id, parent_event_id, note)
  VALUES (p_location, v_ledger_id, now(), p_product_id, v_actual_delta,
          p_reason, p_source_id, p_parent_event_id, p_note);

  v_rows_touched := 1;

  -- BOM cascade — only on sales (and their reversal). Same rule as the
  -- DexieRepo: shipments/manual/stocktake/transfer don't cascade.
  IF p_reason = 'sale'
     AND v_product.components IS NOT NULL
     AND jsonb_typeof(v_product.components) = 'array'
     AND jsonb_array_length(v_product.components) > 0
  THEN
    v_cascade_root := COALESCE(p_source_id,
      'cascade:' || p_product_id || ':' || (extract(epoch from now()) * 1000)::bigint::text);

    FOR v_component IN
      SELECT * FROM jsonb_array_elements(v_product.components)
    LOOP
      v_rows_touched := v_rows_touched + cascade_bom_step(
        p_location,
        (v_component->>'child_product_id')::text,
        p_delta * (v_component->>'qty_per_unit')::numeric,
        v_cascade_root,
        v_product.code,
        1   -- depth
      );
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_rows_touched;
END;
$$;


-- ----------------------------------------------------------------------------
-- cascade_bom_step (internal helper used by adjust_on_hand)
-- ----------------------------------------------------------------------------
-- Recursive single-step deduction during a BOM cascade. Hard depth cap of 8
-- — well past any realistic recipe but prevents infinite loops if data
-- somehow contains a cycle that bypassed the client-side upsert guard.

CREATE OR REPLACE FUNCTION public.cascade_bom_step(
  p_location         TEXT,
  p_child_product_id TEXT,
  p_child_delta      NUMERIC,
  p_parent_event_id  TEXT,
  p_parent_code      TEXT,
  p_depth            INT
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_child         products%ROWTYPE;
  v_before        NUMERIC;
  v_after         NUMERIC;
  v_actual_delta  NUMERIC;
  v_ledger_id     TEXT;
  v_grand         JSONB;
  v_rows          INT := 0;
BEGIN
  IF p_depth > 8 OR p_child_delta = 0 OR p_child_delta IS NULL THEN
    RETURN 0;
  END IF;

  SELECT * INTO v_child
    FROM products
   WHERE location = p_location AND id = p_child_product_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  v_before := COALESCE(v_child.current_on_hand, 0);
  v_after  := GREATEST(v_before - p_child_delta, 0);
  v_actual_delta := v_after - v_before;

  IF v_actual_delta = 0 THEN
    RETURN 0;
  END IF;

  UPDATE products
     SET current_on_hand = v_after
   WHERE location = p_location AND id = p_child_product_id;

  v_ledger_id := (extract(epoch from now()) * 1000)::bigint::text
              || '-'
              || substr(md5(random()::text), 1, 6);

  INSERT INTO ledger (location, id, ts, product_id, delta, reason,
                      source_id, parent_event_id, note)
  VALUES (p_location, v_ledger_id, now(), p_child_product_id, v_actual_delta,
          'bom',
          p_parent_event_id || ':bom:' || v_child.code,
          p_parent_event_id,
          'BOM cascade from ' || p_parent_code);

  v_rows := 1;

  -- Recurse if this child has components.
  IF v_child.components IS NOT NULL
     AND jsonb_typeof(v_child.components) = 'array'
     AND jsonb_array_length(v_child.components) > 0
  THEN
    FOR v_grand IN
      SELECT * FROM jsonb_array_elements(v_child.components)
    LOOP
      v_rows := v_rows + cascade_bom_step(
        p_location,
        (v_grand->>'child_product_id')::text,
        p_child_delta * (v_grand->>'qty_per_unit')::numeric,
        p_parent_event_id,
        v_child.code,
        p_depth + 1
      );
    END LOOP;
  END IF;

  RETURN v_rows;
END;
$$;

COMMIT;
