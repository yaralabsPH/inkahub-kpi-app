-- 0012_production.sql
--
-- Order Submission / Production tracking. Five new tables:
--
--   staff_barcodes        — lanyard token → user mapping (multiple per user
--                           OK; `active` flags the current one)
--   staff_rates           — per-user hourly rate for cost calculations
--   production_events     — append-only event log (started / completed /
--                           cancelled / dispatched); per-line for the
--                           three framing departments, per-order for
--                           dispatch
--   production_size_effort — size-weighted volume scoring
--   production_benchmarks — estimated-time targets per SKU+department
--
-- All tables share the same per-location + RLS pattern used elsewhere
-- (can_access_location for SELECT; manager-or-higher for writes on
--  rates + benchmarks; per-staff insert-own for events).
--
-- Safe to re-run.

BEGIN;

-- ============================================================
-- staff_barcodes
-- ============================================================
CREATE TABLE IF NOT EXISTS staff_barcodes (
  location      TEXT        NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  barcode       TEXT        NOT NULL,
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  TEXT        NOT NULL,
  active        BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  PRIMARY KEY (location, barcode)
);

COMMENT ON TABLE staff_barcodes IS
  'Lanyard barcode tokens for production-team identity. One user can have multiple (replacement after loss); `active` flags the current one. Lookup hot path: by barcode value within a location.';

CREATE INDEX IF NOT EXISTS staff_barcodes_user_idx
  ON staff_barcodes (location, user_id, active);

ALTER TABLE staff_barcodes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_barcodes_read   ON staff_barcodes;
DROP POLICY IF EXISTS staff_barcodes_write  ON staff_barcodes;
CREATE POLICY staff_barcodes_read  ON staff_barcodes FOR SELECT
  USING (can_access_location(location));
CREATE POLICY staff_barcodes_write ON staff_barcodes FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

-- ============================================================
-- staff_rates
-- ============================================================
CREATE TABLE IF NOT EXISTS staff_rates (
  location      TEXT          NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  user_id       UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hourly_rate   NUMERIC(10,2) NOT NULL CHECK (hourly_rate >= 0),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by    UUID          REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (location, user_id)
);

COMMENT ON TABLE staff_rates IS
  'Per-user hourly rate driving the labour component of cost-per-frame. Missing rate = labour cost treated as 0 + UI flag.';

ALTER TABLE staff_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_rates_read  ON staff_rates;
DROP POLICY IF EXISTS staff_rates_write ON staff_rates;
-- Each user can read their own rate; managers can read everyone's.
CREATE POLICY staff_rates_read ON staff_rates FOR SELECT
  USING (
    can_access_location(location)
    AND (user_id = auth.uid() OR is_manager_or_higher())
  );
CREATE POLICY staff_rates_write ON staff_rates FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

-- ============================================================
-- production_events
-- ============================================================
CREATE TABLE IF NOT EXISTS production_events (
  location       TEXT        NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id             TEXT        NOT NULL,
  staff_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  department     TEXT        NOT NULL
                              CHECK (department IN ('a0_framed','framed','unframed','dispatch')),
  order_number   TEXT        NOT NULL CHECK (length(order_number) > 0),
  line_sku       TEXT,
  line_quantity  INTEGER     CHECK (line_quantity IS NULL OR line_quantity > 0),
  event_type     TEXT        NOT NULL
                              CHECK (event_type IN ('started','completed','cancelled','dispatched')),
  station_id     TEXT,
  note           TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location, id)
);

COMMENT ON TABLE production_events IS
  'Append-only production event log. Time deltas computed from start/complete pairs at query time. Dispatch events are per-order (line_sku is NULL); framing events are per-line.';

-- Reporting hot paths.
CREATE INDEX IF NOT EXISTS production_events_staff_idx
  ON production_events (location, staff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS production_events_order_idx
  ON production_events (location, order_number);
CREATE INDEX IF NOT EXISTS production_events_dept_idx
  ON production_events (location, department, created_at DESC);
CREATE INDEX IF NOT EXISTS production_events_sku_idx
  ON production_events (location, line_sku);

ALTER TABLE production_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS production_events_read   ON production_events;
DROP POLICY IF EXISTS production_events_insert ON production_events;
DROP POLICY IF EXISTS production_events_update ON production_events;
DROP POLICY IF EXISTS production_events_delete ON production_events;
-- Workers can read their own events. Managers see everything.
CREATE POLICY production_events_read ON production_events FOR SELECT
  USING (
    can_access_location(location)
    AND (staff_id = auth.uid() OR is_manager_or_higher())
  );
-- Any authenticated user with location access can INSERT their own events
-- (production_events is append-only — that's how staff log their work).
CREATE POLICY production_events_insert ON production_events FOR INSERT
  WITH CHECK (
    can_access_location(location)
    AND staff_id = auth.uid()
  );
-- Updates / deletes restricted to managers (mistake correction).
CREATE POLICY production_events_update ON production_events FOR UPDATE
  USING (can_access_location(location) AND is_manager_or_higher());
CREATE POLICY production_events_delete ON production_events FOR DELETE
  USING (can_access_location(location) AND is_manager_or_higher());

-- ============================================================
-- production_size_effort
-- ============================================================
CREATE TABLE IF NOT EXISTS production_size_effort (
  location      TEXT          NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  size          TEXT          NOT NULL,
  effort_score  NUMERIC(6,2)  NOT NULL CHECK (effort_score > 0),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (location, size)
);

COMMENT ON TABLE production_size_effort IS
  'Size-weighted volume multipliers. effort = sum(count × score). Hand-seeded initially; auto-recomputable from observed medians once data accrues.';

ALTER TABLE production_size_effort ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS production_size_effort_read  ON production_size_effort;
DROP POLICY IF EXISTS production_size_effort_write ON production_size_effort;
CREATE POLICY production_size_effort_read  ON production_size_effort FOR SELECT
  USING (can_access_location(location));
CREATE POLICY production_size_effort_write ON production_size_effort FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

-- Seed the initial values per location. Hand-picked starting point that
-- the operator can refine in Settings → Production Benchmarks.
INSERT INTO production_size_effort (location, size, effort_score)
SELECT key, sizes.size, sizes.score
FROM   locations,
       (VALUES ('A0', 2.5), ('A1', 1.5), ('A2', 1.0), ('A3', 0.7), ('A4', 0.5))
       AS sizes(size, score)
ON CONFLICT (location, size) DO NOTHING;

-- ============================================================
-- production_benchmarks
-- ============================================================
CREATE TABLE IF NOT EXISTS production_benchmarks (
  location           TEXT          NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  product_id         TEXT          NOT NULL,
  department         TEXT          NOT NULL
                                    CHECK (department IN ('a0_framed','framed','unframed','dispatch')),
  estimated_minutes  NUMERIC(6,2)  NOT NULL CHECK (estimated_minutes > 0),
  source             TEXT          NOT NULL DEFAULT 'admin'
                                    CHECK (source IN ('admin','rolling_median')),
  sample_size        INTEGER       NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (location, product_id, department),
  FOREIGN KEY (location, product_id) REFERENCES products (location, id) ON DELETE CASCADE
);

COMMENT ON TABLE production_benchmarks IS
  'Estimated time targets per SKU + department. Drives the estimated-vs-actual feedback chip workers see when completing a line.';

ALTER TABLE production_benchmarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS production_benchmarks_read  ON production_benchmarks;
DROP POLICY IF EXISTS production_benchmarks_write ON production_benchmarks;
CREATE POLICY production_benchmarks_read  ON production_benchmarks FOR SELECT
  USING (can_access_location(location));
CREATE POLICY production_benchmarks_write ON production_benchmarks FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

-- ============================================================
-- Add 'order_submission' to the allowed nav keys discovered in the app.
-- The profiles.allowed_nav array doesn't have a strict schema check (it's
-- TEXT[]), so no DB change needed — just a hint for the code-side enum
-- update which lives in schemas.ts (NAV_KEYS).
-- ============================================================

COMMIT;

NOTIFY pgrst, 'reload schema';
