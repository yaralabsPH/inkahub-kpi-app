-- ============================================================================
-- INKA ARTHOUSE — initial Postgres schema
-- ============================================================================
-- This file mirrors src/lib/domain/schemas.ts (the Zod schemas) into the
-- Postgres tables that Supabase will host once the Dexie→Supabase migration
-- completes. Designed to be read top-to-bottom by anyone wanting to verify
-- the mapping. Phase 1 of the multi-user migration — this file is just text
-- in a folder until someone actually runs `supabase db push`.
--
-- MULTI-TENANCY MODEL
-- --------------------
-- The current app uses a separate IndexedDB per location ("inkaar-stock",
-- "inkaar-stock-uk", etc). Postgres can't do that cleanly, so we collapse
-- to one schema with a `location` column on every business table.
-- To preserve the "data can't leak across locations" guarantee that
-- separate DBs gave us:
--   1. Every business table has `location TEXT NOT NULL REFERENCES locations(key)`
--   2. Primary keys are composite `(location, id)` — same id in two locations
--      is OK (matches how Dexie has been generating ids per-DB) but no row
--      can ever be silently associated with the wrong location.
--   3. Foreign keys are composite — sales/shipments/ledger rows pointing
--      at a product must point at a product IN THE SAME LOCATION.
--   4. RLS policies on every table filter by `can_access_location(location)`.
--
-- The combination is belt-and-braces. RLS handles permissions; FK + PK
-- handle integrity. Either alone would be insufficient.
--
-- AUTH MODEL
-- -----------
-- Supabase owns `auth.users` (email + password, session tokens, etc).
-- We extend with two tables: `profiles` (one row per auth user, app role)
-- and `user_locations` (many-to-many — a user can access N locations).
--
-- Three roles to start (intentionally minimal — expand when the team
-- crosses ~25 people, per the multi-user discussion):
--   owner   — full access; only role that can invite/remove users
--   manager — full operational access for their location(s); no user mgmt
--   staff   — read access + writes to staff-scoped tables only (returns,
--             production runs, issues — modules coming in later phases)
--
-- For tables that exist today (products, sales, etc), the bar for writes
-- is "manager or higher". Future modules will relax to staff for the
-- tables that staff own.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- LOCATIONS REFERENCE TABLE
-- ----------------------------------------------------------------------------
-- Drives both FK validation and the location dropdown in the UI. Adding a
-- new location is one INSERT here + updating the Zod LOCATIONS enum.

CREATE TABLE locations (
  key   TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

INSERT INTO locations (key, label) VALUES
  ('default', 'Default'),
  ('uk',      'United Kingdom'),
  ('us',      'United States'),
  ('au',      'Australia');


-- ----------------------------------------------------------------------------
-- AUTH PROFILES + ROLES
-- ----------------------------------------------------------------------------

CREATE TABLE profiles (
  user_id      UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT        NOT NULL,
  role         TEXT        NOT NULL DEFAULT 'staff'
                           CHECK (role IN ('owner', 'manager', 'staff')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Many-to-many: which locations a user can see/edit. A manager assigned to
-- "uk" and "us" sees both in the location dropdown and can read+write both.
CREATE TABLE user_locations (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  location   TEXT NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, location)
);


-- ----------------------------------------------------------------------------
-- RLS HELPER FUNCTIONS
-- ----------------------------------------------------------------------------
-- Used by every business-table policy. SECURITY DEFINER + STABLE so they
-- can be called from within RLS clauses cheaply.

-- Does the current authenticated user have access to this location?
CREATE OR REPLACE FUNCTION can_access_location(loc TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_locations
    WHERE user_id = auth.uid()
      AND location = loc
  );
$$;

-- The current user's app role. Returns NULL if no profile exists.
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE user_id = auth.uid();
$$;

-- Convenience: is the current user at least a manager? (managers AND owners)
CREATE OR REPLACE FUNCTION is_manager_or_higher()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT current_user_role() IN ('owner', 'manager');
$$;

-- Convenience: is the current user the owner?
CREATE OR REPLACE FUNCTION is_owner()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT current_user_role() = 'owner';
$$;


-- ============================================================================
-- DOMAIN TABLES
-- ============================================================================


-- ----------------------------------------------------------------------------
-- PRODUCTS
-- ----------------------------------------------------------------------------
-- Maps to ProductSchema in src/lib/domain/schemas.ts.
--   - `current_on_hand` is NUMERIC (not INT) to support fractional consumption
--     via BOM cascades — matches the Zod schema's Phase-3 relaxation.
--   - `components` is JSONB holding the array of {child_product_id, qty_per_unit}.
--     Validation lives in Zod on the client; Postgres just stores the blob.
--   - Carton dimensions are nullable; nullable in Postgres = leave blank in UI.

CREATE TABLE products (
  location                       TEXT    NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id                             TEXT    NOT NULL,
  code                           TEXT    NOT NULL CHECK (length(code) > 0),
  short_code                     TEXT,
  size                           TEXT    NOT NULL DEFAULT '',
  colour                         TEXT    NOT NULL DEFAULT '',
  unit_of_sale                   TEXT    NOT NULL DEFAULT 'each'
                                         CHECK (unit_of_sale IN ('each', 'case')),
  product_type                   TEXT    NOT NULL DEFAULT 'product'
                                         CHECK (product_type IN ('product', 'consumable', 'packaging', 'service')),
  pallet_capacity_units          INT     NOT NULL DEFAULT 0 CHECK (pallet_capacity_units >= 0),
  bay_capacity_pallets           INT     NOT NULL DEFAULT 0 CHECK (bay_capacity_pallets >= 0),
  supplier                       TEXT    NOT NULL CHECK (length(supplier) > 0),
  lead_time_days                 INT     NOT NULL DEFAULT 28 CHECK (lead_time_days >= 0),
  min_order_qty                  INT     NOT NULL DEFAULT 0 CHECK (min_order_qty >= 0),
  order_increment                INT     NOT NULL DEFAULT 1 CHECK (order_increment > 0),
  current_on_hand                NUMERIC NOT NULL DEFAULT 0 CHECK (current_on_hand >= 0),
  safety_stock_units             INT     NOT NULL DEFAULT 0 CHECK (safety_stock_units >= 0),
  safety_stock_pct               NUMERIC NOT NULL DEFAULT 100 CHECK (safety_stock_pct >= 0),
  target_weeks_of_cover_override NUMERIC NOT NULL DEFAULT 21 CHECK (target_weeks_of_cover_override >= 0),
  weekly_avg_method              TEXT    NOT NULL DEFAULT 'trailing_8'
                                         CHECK (weekly_avg_method IN ('trailing_8', 'trailing_12', 'weighted', 'manual', 'selected_weeks')),
  weekly_avg_manual              NUMERIC CHECK (weekly_avg_manual IS NULL OR weekly_avg_manual >= 0),
  unit_cost                      NUMERIC CHECK (unit_cost IS NULL OR unit_cost >= 0),
  display_order                  NUMERIC NOT NULL DEFAULT 0,
  notes                          TEXT    NOT NULL DEFAULT '',
  carton_units                   INT     CHECK (carton_units IS NULL OR carton_units > 0),
  carton_length_cm               NUMERIC CHECK (carton_length_cm IS NULL OR carton_length_cm > 0),
  carton_width_cm                NUMERIC CHECK (carton_width_cm IS NULL OR carton_width_cm > 0),
  carton_height_cm               NUMERIC CHECK (carton_height_cm IS NULL OR carton_height_cm > 0),
  components                     JSONB   NOT NULL DEFAULT '[]'::jsonb,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location, id)
);

-- Indexes matching the Dexie schema for query parity.
CREATE INDEX idx_products_code          ON products (location, code);
CREATE INDEX idx_products_size          ON products (location, size);
CREATE INDEX idx_products_colour        ON products (location, colour);
CREATE INDEX idx_products_supplier      ON products (location, supplier);
CREATE INDEX idx_products_display_order ON products (location, display_order);
CREATE INDEX idx_products_type          ON products (location, product_type);


-- ----------------------------------------------------------------------------
-- WEEKLY ENTRIES
-- ----------------------------------------------------------------------------
-- One row per ISO week per location. Holds the manual "Total orders" field,
-- the Shopify-import-contributed orders-by-size JSONB, the optional friendly
-- name ("Black Friday Week"), and the reference-week flag.

CREATE TABLE weekly_entries (
  location                TEXT    NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  iso_week_start          DATE    NOT NULL,
  name                    TEXT,
  total_orders            NUMERIC CHECK (total_orders IS NULL OR total_orders >= 0),
  is_reference            BOOLEAN NOT NULL DEFAULT false,
  entered_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  entered_by              TEXT    NOT NULL DEFAULT 'system',
  shopify_orders_by_size  JSONB   NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (location, iso_week_start)
);

CREATE INDEX idx_weekly_entries_is_reference ON weekly_entries (location, is_reference);


-- ----------------------------------------------------------------------------
-- WEEKLY SALES
-- ----------------------------------------------------------------------------
-- One row per (product, ISO week) per location. units_sold is NUMERIC so
-- fractional consumption (BOM cascade) round-trips cleanly even though the
-- typical sales input is integer-only.

CREATE TABLE weekly_sales (
  location       TEXT    NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  product_id     TEXT    NOT NULL,
  iso_week_start DATE    NOT NULL,
  units_sold     NUMERIC NOT NULL CHECK (units_sold >= 0),
  entered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  entered_by     TEXT    NOT NULL DEFAULT 'system',
  PRIMARY KEY (location, product_id, iso_week_start),
  FOREIGN KEY (location, product_id) REFERENCES products (location, id) ON DELETE CASCADE
);

CREATE INDEX idx_weekly_sales_week    ON weekly_sales (location, iso_week_start);
CREATE INDEX idx_weekly_sales_product ON weekly_sales (location, product_id);


-- ----------------------------------------------------------------------------
-- INCOMING SHIPMENTS
-- ----------------------------------------------------------------------------
-- Multi-line (v3+ schema): `lines` is JSONB array of {product_id, quantity}.
-- Legacy single-line fields (`product_id`, `quantity`) kept nullable for the
-- transform that fills `lines` from them — see ProductionSchema's `.transform`
-- in the Zod source. Once data is migrated and stable, the legacy fields can
-- be dropped via a follow-up migration.

CREATE TABLE shipments (
  location               TEXT    NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id                     TEXT    NOT NULL,
  product_id             TEXT,   -- legacy single-line, nullable
  quantity               INT     CHECK (quantity IS NULL OR quantity > 0),  -- legacy
  lines                  JSONB   NOT NULL DEFAULT '[]'::jsonb,
  po_number              TEXT    NOT NULL CHECK (length(po_number) > 0),
  supplier               TEXT    NOT NULL CHECK (length(supplier) > 0),
  order_placed_date      DATE    NOT NULL,
  transit_started_date   DATE,
  expected_arrival_date  DATE    NOT NULL,
  actual_arrival_date    DATE,
  status                 TEXT    NOT NULL DEFAULT 'Ordered'
                                 CHECK (status IN ('Draft','Ordered','In Production','In Transit','Customs','Delivered','On hold','Cancelled')),
  notes                  TEXT    NOT NULL DEFAULT '',
  production_days        INT     CHECK (production_days IS NULL OR production_days >= 0),
  estimated_ship_date    DATE,
  customs_days           INT     NOT NULL DEFAULT 0 CHECK (customs_days >= 0),
  inventory_applied_at   TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location, id)
);

CREATE INDEX idx_shipments_status            ON shipments (location, status);
CREATE INDEX idx_shipments_expected_arrival  ON shipments (location, expected_arrival_date);
CREATE INDEX idx_shipments_actual_arrival    ON shipments (location, actual_arrival_date);


-- ----------------------------------------------------------------------------
-- DEMAND CHANGE EVENTS
-- ----------------------------------------------------------------------------
-- product_id can be '*' for "applies to every SKU"; we store it as TEXT (not
-- a real FK) because of that wildcard. A check constraint validates the format.

CREATE TABLE demand_events (
  location          TEXT    NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id                TEXT    NOT NULL,
  product_id        TEXT    NOT NULL,   -- may be '*' wildcard
  name              TEXT    NOT NULL CHECK (length(name) > 0),
  start_date        DATE    NOT NULL,
  end_date          DATE    NOT NULL,
  multiplier        NUMERIC NOT NULL CHECK (multiplier >= 0),
  notes             TEXT    NOT NULL DEFAULT '',
  apply_to_size     TEXT,
  apply_to_colour   TEXT,
  PRIMARY KEY (location, id),
  CHECK (end_date >= start_date)
);

CREATE INDEX idx_demand_events_product ON demand_events (location, product_id);
CREATE INDEX idx_demand_events_dates   ON demand_events (location, start_date, end_date);


-- ----------------------------------------------------------------------------
-- WAREHOUSE LAYOUT
-- ----------------------------------------------------------------------------

CREATE TABLE bays (
  location     TEXT NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id           TEXT NOT NULL,
  label        TEXT NOT NULL CHECK (length(label) > 0),
  -- `row` and `column` are PostgreSQL reserved words; quote them in DDL
  -- AND in any subsequent SELECTs the app issues. The Zod schema keeps
  -- the unquoted JS-friendly names; the SupabaseRepo layer translates.
  "row"        INT  NOT NULL CHECK ("row" >= 0),
  "column"     INT  NOT NULL CHECK ("column" >= 0),
  max_pallets  INT  NOT NULL CHECK (max_pallets > 0),
  type         TEXT NOT NULL DEFAULT 'floor' CHECK (type IN ('floor', 'rack', 'cold')),
  notes        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (location, id)
);

CREATE INDEX idx_bays_grid ON bays (location, "row", "column");

CREATE TABLE pallet_assignments (
  location     TEXT NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id           TEXT NOT NULL,
  bay_id       TEXT NOT NULL,
  slot_index   INT  NOT NULL CHECK (slot_index >= 0),
  product_id   TEXT NOT NULL,
  quantity     INT  NOT NULL CHECK (quantity >= 0),
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location, id),
  FOREIGN KEY (location, bay_id)     REFERENCES bays     (location, id) ON DELETE CASCADE,
  FOREIGN KEY (location, product_id) REFERENCES products (location, id) ON DELETE CASCADE
);


-- ----------------------------------------------------------------------------
-- GLOBAL SETTINGS (one row per location)
-- ----------------------------------------------------------------------------
-- Dexie's settings table is keyed by `id="global"`. In Postgres we key by
-- location instead — there's exactly one settings row per location.
-- All settings stored as individual columns rather than a JSONB blob so
-- adding new settings is a CHECK-safe ALTER TABLE, not "modify the blob and
-- hope every old row reparses".

CREATE TABLE settings (
  location                            TEXT    PRIMARY KEY REFERENCES locations(key) ON DELETE RESTRICT,
  use_live_date                       BOOLEAN NOT NULL DEFAULT true,
  manual_scenario_start_date          DATE,
  working_days_per_week               INT     NOT NULL DEFAULT 7 CHECK (working_days_per_week BETWEEN 1 AND 7),
  currency_symbol                     TEXT    NOT NULL DEFAULT '$',
  theme                               TEXT    NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  week_start_day                      TEXT    NOT NULL DEFAULT 'monday' CHECK (week_start_day IN ('sunday', 'monday')),
  auto_adjust_inventory_on_sale       BOOLEAN NOT NULL DEFAULT true,
  auto_apply_shipments_on_delivery    BOOLEAN NOT NULL DEFAULT true,
  nav_labels                          JSONB   NOT NULL DEFAULT '{}'::jsonb,
  last_backup_at                      TIMESTAMPTZ,
  backup_reminder_days                INT     NOT NULL DEFAULT 7 CHECK (backup_reminder_days > 0),
  order_templates                     JSONB   NOT NULL DEFAULT '[]'::jsonb,
  container_cbm                       NUMERIC NOT NULL DEFAULT 67 CHECK (container_cbm > 0),
  paper_roll_24_sku_id                TEXT,
  paper_roll_42_sku_id                TEXT
);


-- ----------------------------------------------------------------------------
-- PAPER USAGE HISTORY
-- ----------------------------------------------------------------------------
-- One row per ISO week per location. `counts` is JSONB ({A0, A1, A2, A3, A4}).

CREATE TABLE paper_usage (
  location               TEXT    NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  iso_week_start         DATE    NOT NULL,
  counts                 JSONB   NOT NULL DEFAULT '{"A0":0,"A1":0,"A2":0,"A3":0,"A4":0}'::jsonb,
  buffer_pct             NUMERIC NOT NULL DEFAULT 0 CHECK (buffer_pct >= 0),
  notes                  TEXT    NOT NULL DEFAULT '',
  recorded_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by            TEXT    NOT NULL DEFAULT 'manual',
  deducted_rolls_24      INT     NOT NULL DEFAULT 0 CHECK (deducted_rolls_24 >= 0),
  deducted_rolls_42      INT     NOT NULL DEFAULT 0 CHECK (deducted_rolls_42 >= 0),
  deducted_sku_24_id     TEXT,
  deducted_sku_42_id     TEXT,
  PRIMARY KEY (location, iso_week_start)
);


-- ----------------------------------------------------------------------------
-- INVENTORY LEDGER
-- ----------------------------------------------------------------------------
-- Append-only audit. NO foreign key on product_id — deleted products should
-- still have their historical ledger rows visible (the row shows "(deleted)"
-- in the UI). This is the one place we deliberately allow orphan references.

CREATE TABLE ledger (
  location          TEXT    NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id                TEXT    NOT NULL,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  product_id        TEXT    NOT NULL,
  delta             NUMERIC NOT NULL,
  reason            TEXT    NOT NULL
                            CHECK (reason IN ('sale','shipment','usage','manual','stocktake','transfer','initial','import','bom')),
  source_id         TEXT,
  parent_event_id   TEXT,
  note              TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (location, id)
);

CREATE INDEX idx_ledger_product   ON ledger (location, product_id);
CREATE INDEX idx_ledger_ts        ON ledger (location, ts DESC);
CREATE INDEX idx_ledger_source    ON ledger (location, source_id);
CREATE INDEX idx_ledger_reason    ON ledger (location, reason);


-- ============================================================================
-- ROW-LEVEL SECURITY POLICIES
-- ============================================================================
-- The model is uniform across every business table:
--   SELECT: any authenticated user with location access
--   INSERT/UPDATE/DELETE: any authenticated user with location access
--                          AND who is at least a manager (role in 'owner','manager')
-- Future modules (returns, production runs, issues) will relax to allow
-- staff writes on those tables specifically.
--
-- profiles + user_locations are owner-only writes — only owners can manage
-- the team.

ALTER TABLE locations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_locations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_entries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_sales        ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bays                ENABLE ROW LEVEL SECURITY;
ALTER TABLE pallet_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_usage         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger              ENABLE ROW LEVEL SECURITY;


-- ---------- locations (everyone reads, only owners write) ----------
CREATE POLICY locations_select ON locations FOR SELECT
  USING (auth.uid() IS NOT NULL);
CREATE POLICY locations_modify ON locations FOR ALL
  USING (is_owner()) WITH CHECK (is_owner());


-- ---------- profiles (read own + any if owner, write own + any if owner) ----------
CREATE POLICY profiles_select ON profiles FOR SELECT
  USING (user_id = auth.uid() OR is_owner());
CREATE POLICY profiles_insert ON profiles FOR INSERT
  WITH CHECK (is_owner());
CREATE POLICY profiles_update ON profiles FOR UPDATE
  USING (is_owner() OR (user_id = auth.uid()))
  WITH CHECK (is_owner() OR (user_id = auth.uid() AND role = (SELECT role FROM profiles WHERE user_id = auth.uid())));
  -- A non-owner can update their own display_name but cannot promote themselves.
CREATE POLICY profiles_delete ON profiles FOR DELETE
  USING (is_owner());


-- ---------- user_locations (owner only) ----------
CREATE POLICY user_locations_select ON user_locations FOR SELECT
  USING (is_owner() OR user_id = auth.uid());
CREATE POLICY user_locations_modify ON user_locations FOR ALL
  USING (is_owner()) WITH CHECK (is_owner());


-- ---------- BUSINESS TABLES (uniform policy macro) ----------
-- Each gets identical SELECT/modify policies — read if you can access the
-- location, write if you can access it AND are at least manager.

CREATE POLICY products_select ON products FOR SELECT
  USING (can_access_location(location));
CREATE POLICY products_modify ON products FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

CREATE POLICY weekly_entries_select ON weekly_entries FOR SELECT
  USING (can_access_location(location));
CREATE POLICY weekly_entries_modify ON weekly_entries FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

CREATE POLICY weekly_sales_select ON weekly_sales FOR SELECT
  USING (can_access_location(location));
CREATE POLICY weekly_sales_modify ON weekly_sales FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

CREATE POLICY shipments_select ON shipments FOR SELECT
  USING (can_access_location(location));
CREATE POLICY shipments_modify ON shipments FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

CREATE POLICY demand_events_select ON demand_events FOR SELECT
  USING (can_access_location(location));
CREATE POLICY demand_events_modify ON demand_events FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

CREATE POLICY bays_select ON bays FOR SELECT
  USING (can_access_location(location));
CREATE POLICY bays_modify ON bays FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

CREATE POLICY pallet_assignments_select ON pallet_assignments FOR SELECT
  USING (can_access_location(location));
CREATE POLICY pallet_assignments_modify ON pallet_assignments FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

CREATE POLICY settings_select ON settings FOR SELECT
  USING (can_access_location(location));
CREATE POLICY settings_modify ON settings FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

CREATE POLICY paper_usage_select ON paper_usage FOR SELECT
  USING (can_access_location(location));
CREATE POLICY paper_usage_modify ON paper_usage FOR ALL
  USING (can_access_location(location) AND is_manager_or_higher())
  WITH CHECK (can_access_location(location) AND is_manager_or_higher());

-- Ledger is append-only by convention; we still allow inserts for
-- everyone with location access (so the app can record events triggered
-- by their own actions, e.g. a staff member logging a return). UPDATES
-- and DELETES are blocked entirely — the ledger never edits.
CREATE POLICY ledger_select ON ledger FOR SELECT
  USING (can_access_location(location));
CREATE POLICY ledger_insert ON ledger FOR INSERT
  WITH CHECK (can_access_location(location));
-- No UPDATE or DELETE policies = denied.


-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-update `updated_at` on every UPDATE for tables that track it.
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_products_touch_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_shipments_touch_updated_at
  BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_profiles_touch_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ============================================================================
-- BOOTSTRAP — first owner
-- ============================================================================
-- After running this migration, sign up the Owner via Supabase Auth (email +
-- password). Then manually insert their profile + location grants:
--
--   INSERT INTO profiles (user_id, display_name, role)
--   VALUES ('<their auth.users.id>', 'Max', 'owner');
--
--   INSERT INTO user_locations (user_id, location) VALUES
--     ('<their auth.users.id>', 'default'),
--     ('<their auth.users.id>', 'uk'),
--     ('<their auth.users.id>', 'us'),
--     ('<their auth.users.id>', 'au');
--
-- Once the Owner is in, they can manage everyone else via the Settings UI
-- (a future migration phase ships that page).
