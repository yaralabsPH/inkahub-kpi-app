-- 0016_order_notes.sql
--
-- Free-form notes against orders. Created by any staff at the location
-- (e.g. a framer flags "customer asked to change colour, please cancel").
-- Visible to everyone at that location, can be marked resolved.
--
-- Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS order_notes (
  location            TEXT        NOT NULL REFERENCES locations(key) ON DELETE RESTRICT,
  id                  TEXT        NOT NULL,
  order_number        TEXT        NOT NULL CHECK (length(order_number) > 0),
  staff_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  staff_display_name  TEXT        NOT NULL,
  body                TEXT        NOT NULL CHECK (length(btrim(body)) > 0),
  resolved            BOOLEAN     NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ,
  resolved_by         UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (location, id)
);

COMMENT ON TABLE order_notes IS
  'Per-order free-form notes written by staff. Shown to the next person who scans the order. Read+write by anyone at the location; delete by managers.';

CREATE INDEX IF NOT EXISTS order_notes_lookup_idx
  ON order_notes (location, order_number, created_at DESC);

CREATE INDEX IF NOT EXISTS order_notes_unresolved_idx
  ON order_notes (location, order_number) WHERE resolved = false;

ALTER TABLE order_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_notes_read   ON order_notes;
DROP POLICY IF EXISTS order_notes_insert ON order_notes;
DROP POLICY IF EXISTS order_notes_update ON order_notes;
DROP POLICY IF EXISTS order_notes_delete ON order_notes;

-- Anyone with access to the location can read all notes for that location.
CREATE POLICY order_notes_read ON order_notes FOR SELECT
  USING (can_access_location(location));

-- Authenticated users can insert notes as themselves at their location.
CREATE POLICY order_notes_insert ON order_notes FOR INSERT
  WITH CHECK (can_access_location(location) AND staff_id = auth.uid());

-- Anyone at the location can mark a note resolved / reopen it (small team,
-- collaborative flow). If you want stricter control, swap to
-- `staff_id = auth.uid() OR is_manager_or_higher()` here.
CREATE POLICY order_notes_update ON order_notes FOR UPDATE
  USING (can_access_location(location))
  WITH CHECK (can_access_location(location));

-- Hard delete restricted to managers (mistake cleanup).
CREATE POLICY order_notes_delete ON order_notes FOR DELETE
  USING (can_access_location(location) AND is_manager_or_higher());

COMMIT;

NOTIFY pgrst, 'reload schema';