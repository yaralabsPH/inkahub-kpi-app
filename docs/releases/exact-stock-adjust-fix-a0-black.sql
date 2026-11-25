-- LIVE DATA CORRECTION (CJ runs this, once, AFTER 0063 is applied).
-- A0-Black at location 'default': the 2026-11-25 test return restocked 1 unit
-- onto -12, but the old zero floor recorded +12 and left on-hand at 0.
-- True on-hand with that 1-unit restock is -11. This moves 0 -> -11 and writes
-- a matching ledger row, so on-hand still equals the sum of the ledger.
-- Guarded: does nothing (raises) unless live is exactly in that state.
-- Afterwards, deleting test return #123 takes it back to -12 (with 0063).

BEGIN;

DO $$
DECLARE v_on_hand NUMERIC;
BEGIN
  SELECT current_on_hand INTO v_on_hand
    FROM products WHERE location = 'default' AND id = 'sku-1qivhw1i' AND code = 'A0-Black'
    FOR UPDATE;
  IF v_on_hand IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Not applied: A0-Black (default) on-hand is %, expected 0', v_on_hand;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger WHERE location = 'default' AND id = '1795564960661-6fe1e5'
                   AND product_id = 'sku-1qivhw1i' AND delta = 12) THEN
    RAISE EXCEPTION 'Not applied: the +12 return ledger row was not found';
  END IF;
  IF EXISTS (SELECT 1 FROM ledger WHERE source_id = 'fix:0063:a0-black-default') THEN
    RAISE EXCEPTION 'Not applied: correction already recorded';
  END IF;

  UPDATE products SET current_on_hand = -11
   WHERE location = 'default' AND id = 'sku-1qivhw1i';

  INSERT INTO ledger (location, id, ts, product_id, delta, reason, source_id, parent_event_id, note)
  VALUES ('default',
          (extract(epoch from now()) * 1000)::bigint::text || '-fix063',
          now(), 'sku-1qivhw1i', -11, 'manual',
          'fix:0063:a0-black-default',
          'cs-return:1795564428024-dguobx',
          'Correction: return restock of 1 onto -12 was floored to 0 (+12); true change +1 (see 0063)');

  RAISE NOTICE 'A0-Black (default) corrected: 0 -> -11';
END $$;

COMMIT;
