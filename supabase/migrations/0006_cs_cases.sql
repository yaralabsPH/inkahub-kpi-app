-- ============================================================================
-- INKA ARTHOUSE — CS Cases (replacements + complaints + customer issues)
-- ============================================================================
-- Replaces the existing Notion "New Replacements Database". Each row is one
-- customer-service intervention: damaged item, wrong item, delivery issue,
-- etc. Multi-line so a single case can resend more than one item.
--
-- Inventory tie-in: when status transitions to 'approved' with a tracking
-- number set, each case line decrements its product's `current_on_hand`
-- via the existing `adjust_on_hand` RPC with `reason: 'replacement'`. The
-- new reason value is added to the ledger CHECK constraint below.
--
-- RLS model: writes are gated on location access only (NOT
-- is_manager_or_higher) because CS staff are the primary users of this
-- module — they need to log + edit cases without manager intervention.
-- Approval-gating doesn't exist here per business decision: any
-- clarification questions go through Slack, not the system.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Extend the ledger reason enum to include 'replacement'
-- ----------------------------------------------------------------------------
-- Replacements show up in the audit trail (so "why did A1-Black drop by 5
-- last week" is answerable) but are tagged distinctly so revenue/forecast
-- reports can exclude them. Idempotent — uses a drop-and-recreate pattern.

ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_reason_check;
ALTER TABLE ledger ADD CONSTRAINT ledger_reason_check
  CHECK (reason IN (
    'sale', 'shipment', 'usage', 'manual', 'stocktake',
    'transfer', 'initial', 'import', 'bom', 'replacement'
  ));


-- ----------------------------------------------------------------------------
-- CS CASES (parent rows)
-- ----------------------------------------------------------------------------

CREATE TABLE cs_cases (
  location              TEXT        NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id                    TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Respondent: the user who first logged this case. Used for
  -- "who do I ping in Slack about this?" accountability. References
  -- auth.users so cascade-on-user-delete just nulls the FK rather than
  -- losing the case row.
  created_by_user_id    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Status workflow: new → approved → shipped → closed
  -- ('denied' is an off-ramp from 'new' or 'approved')
  status                TEXT        NOT NULL DEFAULT 'new'
                                    CHECK (status IN ('new', 'approved', 'shipped', 'closed', 'denied')),

  urgency               TEXT        NOT NULL DEFAULT 'medium'
                                    CHECK (urgency IN ('critical', 'high', 'medium', 'low')),

  -- Mirrors the Notion 'Issue' column values, normalised to snake_case.
  issue_type            TEXT        NOT NULL
                                    CHECK (issue_type IN ('damaged','incorrect_missing','delivery_issue','expedite','quality','other')),

  -- Routing hint: auto-derived from lines (all-framed → 'framed',
  -- all-unframed → 'unframed', mix → 'mixed'). Nullable in case CS hasn't
  -- added lines yet. App overrides this client-side when lines change.
  department            TEXT        CHECK (department IS NULL OR department IN ('framed', 'unframed', 'mixed')),

  -- Order context — order_number is the Shopify order number.
  -- shopify_order_url is the admin link (paste from Shopify directly).
  order_number          TEXT        NOT NULL CHECK (length(order_number) > 0),
  shopify_order_url     TEXT,
  date_ordered          DATE,

  -- Customer details (lean — can be filled by hand or pulled from
  -- Shopify Admin API in Phase 2).
  customer_name         TEXT,
  customer_email        TEXT,
  -- Default true: most cases the customer keeps the damaged/wrong item
  -- and we send a replacement. Flag false for the rare return-to-us case.
  customer_keeps_original BOOLEAN   NOT NULL DEFAULT true,

  -- Shipping back to customer (the replacement parcel).
  carrier               TEXT,
  tracking_number       TEXT,

  notes                 TEXT        NOT NULL DEFAULT '',

  -- File URLs in Supabase Storage. Auto-purged at 60 days by a
  -- scheduled job (set up in Phase 2). Stored as TEXT[] for indexability;
  -- empty array by default.
  attachments           TEXT[]      NOT NULL DEFAULT '{}',

  -- Timeline timestamps. NULL until the corresponding transition fires.
  approved_at           TIMESTAMPTZ,
  shipped_at            TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,

  -- Tracks whether the case has already triggered an inventory deduction.
  -- Prevents double-deduction if status is moved back and forward. The
  -- RPC layer will check + flip this atomically.
  inventory_deducted    BOOLEAN     NOT NULL DEFAULT false,

  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (location, id)
);

CREATE INDEX idx_cs_cases_status        ON cs_cases (location, status);
CREATE INDEX idx_cs_cases_created_at    ON cs_cases (location, created_at DESC);
CREATE INDEX idx_cs_cases_order_number  ON cs_cases (location, order_number);
CREATE INDEX idx_cs_cases_issue_type    ON cs_cases (location, issue_type);
CREATE INDEX idx_cs_cases_created_by    ON cs_cases (location, created_by_user_id);


-- ----------------------------------------------------------------------------
-- CS CASE LINES (line items being replaced)
-- ----------------------------------------------------------------------------
-- One row per (product, quantity) pair on a case. A case with "send 1 A1
-- framed + 1 A2 unframed" has two lines.

CREATE TABLE cs_case_lines (
  location    TEXT    NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id          TEXT    NOT NULL,
  case_id     TEXT    NOT NULL,
  product_id  TEXT    NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),

  PRIMARY KEY (location, id),
  FOREIGN KEY (location, case_id)    REFERENCES cs_cases (location, id) ON DELETE CASCADE,
  FOREIGN KEY (location, product_id) REFERENCES products (location, id) ON DELETE RESTRICT
);

CREATE INDEX idx_cs_case_lines_case    ON cs_case_lines (location, case_id);
CREATE INDEX idx_cs_case_lines_product ON cs_case_lines (location, product_id);


-- ----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- Per-location access only. Anyone with location access (including staff)
-- can read AND write — CS reps are the primary users; gating writes on
-- is_manager_or_higher would block their workflow.

ALTER TABLE cs_cases       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_case_lines  ENABLE ROW LEVEL SECURITY;

CREATE POLICY cs_cases_select ON cs_cases FOR SELECT
  USING (can_access_location(location));
CREATE POLICY cs_cases_modify ON cs_cases FOR ALL
  USING (can_access_location(location))
  WITH CHECK (can_access_location(location));

CREATE POLICY cs_case_lines_select ON cs_case_lines FOR SELECT
  USING (can_access_location(location));
CREATE POLICY cs_case_lines_modify ON cs_case_lines FOR ALL
  USING (can_access_location(location))
  WITH CHECK (can_access_location(location));


-- ----------------------------------------------------------------------------
-- Auto-update updated_at on cs_cases
-- ----------------------------------------------------------------------------

CREATE TRIGGER trg_cs_cases_touch_updated_at
  BEFORE UPDATE ON cs_cases
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ----------------------------------------------------------------------------
-- Grants — match the pattern used for the rest of the public schema
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON cs_cases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON cs_case_lines TO authenticated;
