-- STAGING ONLY. Verifies 0063_exact_stock_adjust.sql against real Postgres.
-- Runs as a staging owner through the real can_access_location check, asserts
-- every case, then ROLLS BACK: it leaves no rows behind.
-- Usage (staging-2): supabase db query --remote=<staging ref> --yes -f verify.sql
-- Before 0063 it fails at check 1 (proves the test detects the zero floor).

BEGIN;

INSERT INTO products (location, id, code, supplier, current_on_hand, components) VALUES
  ('au', 'zz-exact-p1', 'ZZ-EXACT-P1', 'test', -12, '[]'),
  ('au', 'zz-exact-p2', 'ZZ-EXACT-P2', 'test',   1, '[]'),
  ('au', 'zz-exact-pc', 'ZZ-EXACT-PC', 'test',   1, '[]'),
  ('au', 'zz-exact-pb', 'ZZ-EXACT-PB', 'test',   0,
     '[{"child_product_id":"zz-exact-pc","qty_per_unit":2}]');

SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT id FROM auth.users WHERE email = 'owner@inka-staging.test'),
                    'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v NUMERIC; n INT; led NUMERIC; denied BOOLEAN := false;
  oh_before NUMERIC;
BEGIN
  -- 1. Addition onto negative stock is exact (live case: -12 + 1 = -11).
  PERFORM adjust_on_hand('au', 'zz-exact-p1', -1, 'return', 'zz:1', NULL, 'verify');
  SELECT current_on_hand INTO v FROM products WHERE location='au' AND id='zz-exact-p1';
  IF v <> -11 THEN RAISE EXCEPTION 'check 1 failed: expected -11, got %', v; END IF;
  SELECT delta INTO led FROM ledger WHERE location='au' AND source_id='zz:1';
  IF led <> 1 THEN RAISE EXCEPTION 'check 1 ledger: expected +1, got %', led; END IF;

  -- 2. Undo restores exactly.
  PERFORM adjust_on_hand('au', 'zz-exact-p1', 1, 'return', 'zz:2', NULL, 'verify');
  SELECT current_on_hand INTO v FROM products WHERE location='au' AND id='zz-exact-p1';
  IF v <> -12 THEN RAISE EXCEPTION 'check 2 failed: expected -12, got %', v; END IF;

  -- 3. Removal is exact and may go below zero (like dispatch).
  PERFORM adjust_on_hand('au', 'zz-exact-p2', 3, 'manual', 'zz:3', NULL, 'verify');
  SELECT current_on_hand INTO v FROM products WHERE location='au' AND id='zz-exact-p2';
  IF v <> -2 THEN RAISE EXCEPTION 'check 3 failed: expected -2, got %', v; END IF;
  SELECT delta INTO led FROM ledger WHERE location='au' AND source_id='zz:3';
  IF led <> -3 THEN RAISE EXCEPTION 'check 3 ledger: expected -3, got %', led; END IF;

  -- 4. Zero delta: no change, no ledger row.
  SELECT rows_touched INTO n FROM adjust_on_hand('au', 'zz-exact-p2', 0, 'manual', 'zz:4', NULL, 'verify');
  IF n <> 0 OR EXISTS (SELECT 1 FROM ledger WHERE location='au' AND source_id='zz:4') THEN
    RAISE EXCEPTION 'check 4 failed: zero delta touched rows';
  END IF;

  -- 5. Sale cascades through the BOM exactly (child 1 - 2*1 = -1) and reverses.
  SELECT rows_touched INTO n FROM adjust_on_hand('au', 'zz-exact-pb', 1, 'sale', 'zz:5', NULL, 'verify');
  IF n <> 2 THEN RAISE EXCEPTION 'check 5 failed: expected 2 rows touched, got %', n; END IF;
  SELECT current_on_hand INTO v FROM products WHERE location='au' AND id='zz-exact-pc';
  IF v <> -1 THEN RAISE EXCEPTION 'check 5 child: expected -1, got %', v; END IF;
  SELECT delta INTO led FROM ledger WHERE location='au' AND product_id='zz-exact-pc' AND reason='bom';
  IF led <> -2 THEN RAISE EXCEPTION 'check 5 bom ledger: expected -2, got %', led; END IF;
  PERFORM adjust_on_hand('au', 'zz-exact-pb', -1, 'sale', 'zz:5r', NULL, 'verify');
  SELECT current_on_hand INTO v FROM products WHERE location='au' AND id='zz-exact-pc';
  IF v <> 1 THEN RAISE EXCEPTION 'check 5 reversal: expected child 1, got %', v; END IF;
  SELECT current_on_hand INTO v FROM products WHERE location='au' AND id='zz-exact-pb';
  IF v <> 0 THEN RAISE EXCEPTION 'check 5 reversal: expected parent 0, got %', v; END IF;

  -- 6. Missing product is still a silent no-op.
  SELECT rows_touched INTO n FROM adjust_on_hand('au', 'zz-exact-missing', -5, 'manual', 'zz:6', NULL, 'verify');
  IF n <> 0 THEN RAISE EXCEPTION 'check 6 failed: missing product touched rows'; END IF;

  -- 7. Location check still enforced.
  BEGIN
    PERFORM adjust_on_hand('zz-no-such-location', 'zz-exact-p1', -1, 'manual', 'zz:7', NULL, 'verify');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'check 7 failed: other location was not denied'; END IF;

  -- 8. Shipment delivery path (0014) credits exactly onto negative stock.
  SELECT current_on_hand INTO oh_before FROM products WHERE location='au' AND id='zz-exact-p1';
  PERFORM adjust_on_hand('au', 'zz-exact-p1', -10, 'shipment', 'zz:8', NULL, 'verify');
  SELECT current_on_hand INTO v FROM products WHERE location='au' AND id='zz-exact-p1';
  IF v <> oh_before + 10 THEN RAISE EXCEPTION 'check 8 failed: expected %, got %', oh_before + 10, v; END IF;

  RAISE NOTICE 'exact-stock-adjust: all 8 checks passed';
END $$;

RESET ROLE;
SELECT 'exact-stock-adjust: all 8 checks passed' AS result;
ROLLBACK;
