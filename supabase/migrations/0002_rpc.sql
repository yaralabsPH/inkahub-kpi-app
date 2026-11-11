-- ============================================================================
-- INKA ARTHOUSE — RPC functions for atomic inventory operations
-- ============================================================================
-- DexieRepo can wrap inventory updates and ledger inserts in one transaction
-- because IndexedDB transactions are zone-scoped. Supabase calls are HTTP
-- requests from the browser — there's no equivalent. We solve this by
-- wrapping the atomicity-critical sequences in Postgres functions and
-- exposing them via PostgREST RPC. Each function = one atomic operation.
--
-- The client (SupabaseRepo.ts) calls these via supabase.rpc("name", args).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- adjust_on_hand
-- ----------------------------------------------------------------------------
-- Atomic equivalent of DexieRepo.adjustOnHand. Steps:
--   1. Lock the product row, compute new on-hand (floor at zero).
--   2. If a change occurred, UPDATE products.current_on_hand.
--   3. Insert a ledger row with the actual delta (not the requested one
--      — the floor-at-zero clamp may reduce it).
--   4. If reason='sale' and the product has components, walk the BOM
--      recursively and adjust each child the same way, tagging each
--      child row with parent_event_id linking back to the root sale.
--   5. Return total rows changed for caller diagnostics.
--
-- Permissions: SECURITY DEFINER so it can read products/ledger even
-- with RLS enabled, but the caller still has to pass the location they
-- legitimately have access to (we re-check via auth.uid()).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION adjust_on_hand(
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

CREATE OR REPLACE FUNCTION cascade_bom_step(
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


-- ----------------------------------------------------------------------------
-- Grant execute to authenticated users — anyone logged in can call these
-- RPCs, and the function bodies check `can_access_location` themselves so
-- the location-isolation guarantee is preserved.
-- ----------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION adjust_on_hand(TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT)
  TO authenticated;
GRANT EXECUTE ON FUNCTION cascade_bom_step(TEXT, TEXT, NUMERIC, TEXT, TEXT, INT)
  TO authenticated;
