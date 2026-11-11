-- 0009_cs_returns.sql
--
-- Customer-return tracking. Parallel to cs_cases (outbound replacements)
-- but for inbound flow: a customer is sending something back to us, and
-- we need to track expected drop-off, what's coming back, and refund
-- status.
--
-- Kanban states: new → received → closed.
--   new      — customer notified us, hasn't dropped off yet
--   received — item is physically back at our warehouse
--   closed   — process complete (refund issued / no-refund decided / etc.)
--
-- Inventory model: each return LINE has a `restock` boolean. When a line
-- has restock=true AND its parent return's status is 'received', the qty
-- is credited back to on_hand via the ledger with reason='return'.
-- Unticking restock, or moving the return back out of 'received', reverses
-- the credit. The `inventory_credited` boolean on each line tracks whether
-- the credit has been applied, so repeated saves stay idempotent.
--
-- Default restock=false — most returns are damaged / unknown condition.
-- CS staff tick the toggle only when they confirm the item is resaleable.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS cs_returns (
  location               TEXT        NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id                     TEXT        NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  status                 TEXT        NOT NULL DEFAULT 'new'
                                     CHECK (status IN ('new','received','closed')),
  order_number           TEXT        NOT NULL CHECK (length(order_number) > 0),
  shopify_order_url      TEXT,
  customer_name          TEXT,
  customer_email         TEXT,
  expected_return_date   DATE,
  refund_expected        BOOLEAN     NOT NULL DEFAULT true,
  refund_received        BOOLEAN     NOT NULL DEFAULT false,
  notes                  TEXT        NOT NULL DEFAULT '',
  received_at            TIMESTAMPTZ,
  closed_at              TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location, id)
);

COMMENT ON TABLE cs_returns IS
  'Customer returns — inbound items being sent back to us. Sibling table to cs_cases (outbound replacements). Workflow: new → received → closed.';

CREATE TABLE IF NOT EXISTS cs_return_lines (
  location              TEXT    NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id                    TEXT    NOT NULL,
  return_id             TEXT    NOT NULL,
  product_id            TEXT    NOT NULL,
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  /** When true, this line is intended to be restocked back into inventory
      when the parent return reaches 'received' status. */
  restock               BOOLEAN NOT NULL DEFAULT false,
  /** Idempotency flag: true once the qty has been credited to on_hand via
      the ledger. Repeated saves use this to compute the correct delta and
      avoid double-credit. */
  inventory_credited    BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (location, id),
  FOREIGN KEY (location, return_id) REFERENCES cs_returns (location, id) ON DELETE CASCADE,
  FOREIGN KEY (location, product_id) REFERENCES products  (location, id) ON DELETE RESTRICT
);

COMMENT ON TABLE cs_return_lines IS
  'Line items being returned by the customer. Composite FK to cs_returns. Cascade-delete with the parent return.';

-- ---- Indexes ----
CREATE INDEX IF NOT EXISTS cs_returns_status_idx       ON cs_returns      (location, status);
CREATE INDEX IF NOT EXISTS cs_returns_created_idx      ON cs_returns      (location, created_at DESC);
CREATE INDEX IF NOT EXISTS cs_return_lines_return_idx  ON cs_return_lines (location, return_id);

-- ---- RLS ----
-- Same pattern as cs_cases: read + write gated on location access only.
-- We deliberately do NOT require manager-or-higher for writes because CS
-- staff need to log returns as customers contact them.
ALTER TABLE cs_returns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_return_lines  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cs_returns_read   ON cs_returns;
DROP POLICY IF EXISTS cs_returns_insert ON cs_returns;
DROP POLICY IF EXISTS cs_returns_update ON cs_returns;
DROP POLICY IF EXISTS cs_returns_delete ON cs_returns;
CREATE POLICY cs_returns_read   ON cs_returns FOR SELECT USING       (can_access_location(location));
CREATE POLICY cs_returns_insert ON cs_returns FOR INSERT WITH CHECK  (can_access_location(location));
CREATE POLICY cs_returns_update ON cs_returns FOR UPDATE USING       (can_access_location(location));
CREATE POLICY cs_returns_delete ON cs_returns FOR DELETE USING       (can_access_location(location));

DROP POLICY IF EXISTS cs_return_lines_read   ON cs_return_lines;
DROP POLICY IF EXISTS cs_return_lines_insert ON cs_return_lines;
DROP POLICY IF EXISTS cs_return_lines_update ON cs_return_lines;
DROP POLICY IF EXISTS cs_return_lines_delete ON cs_return_lines;
CREATE POLICY cs_return_lines_read   ON cs_return_lines FOR SELECT USING       (can_access_location(location));
CREATE POLICY cs_return_lines_insert ON cs_return_lines FOR INSERT WITH CHECK  (can_access_location(location));
CREATE POLICY cs_return_lines_update ON cs_return_lines FOR UPDATE USING       (can_access_location(location));
CREATE POLICY cs_return_lines_delete ON cs_return_lines FOR DELETE USING       (can_access_location(location));

-- ---- Extend the ledger reason enum to include 'return' ----
-- Lines that restock-back-to-inventory write a ledger row with reason='return'.
-- Reuses the same pattern we used for 'replacement' in 0006.
ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_reason_check;
ALTER TABLE ledger ADD CONSTRAINT ledger_reason_check
  CHECK (reason IN (
    'sale','shipment','usage','manual','stocktake','transfer',
    'initial','import','bom','replacement','return'
  ));

-- Tell PostgREST to refresh its schema cache.
NOTIFY pgrst, 'reload schema';
