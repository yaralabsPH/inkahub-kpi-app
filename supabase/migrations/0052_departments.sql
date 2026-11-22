-- 0052_departments.sql
--
-- F5 departments, part 1 of 3: storage and privileges.
--
-- Adds managed BUSINESS departments (the team a person belongs to) and the
-- history of who belonged where. This is separate from the routing work type
-- in production_events.department (a0_framed / framed / unframed / dispatch),
-- which this migration does not touch.
--
-- Expand-only. It creates new objects and nothing else: no existing table,
-- column, policy, grant, function or row is changed. No roster is seeded.
-- production_events is not read or written here. Old app versions are
-- unaffected.
--
-- Apply 0052, 0053 and 0054 in order. Event snapshots stay switched OFF
-- (department_snapshot_control.enabled = false) until an owner turns them on.
--
-- Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- Extension: btree_gist lets one exclusion constraint combine "same person"
-- (uuid equality) with "overlapping time range". Supabase keeps extensions in
-- the `extensions` schema. If it is already installed somewhere else we stop
-- with a clear message instead of moving it.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

DO $$
DECLARE
  v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'btree_gist';
  IF v_schema IS DISTINCT FROM 'extensions' THEN
    RAISE EXCEPTION 'F5 departments: btree_gist is installed in schema "%", expected "extensions". Not relocating it; resolve this before applying 0052.', v_schema;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Private schema for internal functions. No client role may use it.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS departments_private;
REVOKE ALL ON SCHEMA departments_private FROM PUBLIC;
REVOKE ALL ON SCHEMA departments_private FROM anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- business_departments: one row per department, current facts only.
-- Never deleted; archived instead. `version` goes up on every real change so
-- two owners editing at once cannot overwrite each other.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.business_departments (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  normalized_name text        NOT NULL,
  archived_at     timestamptz,
  version         bigint      NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  created_by      uuid        NOT NULL,
  updated_by      uuid        NOT NULL,
  CONSTRAINT business_departments_normalized_name_key UNIQUE (normalized_name),
  CONSTRAINT business_departments_normalized_matches CHECK (normalized_name = lower(name)),
  CONSTRAINT business_departments_archived_finite CHECK (archived_at IS NULL OR isfinite(archived_at))
);

COMMENT ON TABLE public.business_departments IS
  'F5: managed business departments (teams people belong to). Not the routing work type in production_events.department. Names are unique across active AND archived departments. Rows are never deleted.';

-- ---------------------------------------------------------------------------
-- business_department_names: every name a department has had, with the time
-- range it applied. A rename closes the open row and opens a new one at the
-- same instant, so an old event can keep the label it had at the time.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.business_department_names (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id     uuid        NOT NULL REFERENCES public.business_departments(id) ON DELETE RESTRICT,
  name              text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  valid_from        timestamptz NOT NULL,
  valid_to          timestamptz,
  created_at        timestamptz NOT NULL,
  created_by        uuid        NOT NULL,
  request_id        uuid        NOT NULL,
  closed_at         timestamptz,
  closed_by         uuid,
  closed_request_id uuid,
  CONSTRAINT business_department_names_interval CHECK (
    isfinite(valid_from) AND (valid_to IS NULL OR (isfinite(valid_to) AND valid_to > valid_from))
  ),
  -- Half-open [valid_from, valid_to): two names for one department can never
  -- apply at the same instant, even under concurrent writes.
  CONSTRAINT business_department_names_no_overlap EXCLUDE USING gist (
    department_id extensions.gist_uuid_ops WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS business_department_names_one_open
  ON public.business_department_names (department_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS business_department_names_lookup_idx
  ON public.business_department_names (department_id, valid_from, id);

COMMENT ON TABLE public.business_department_names IS
  'F5: name history per department, half-open UTC intervals [valid_from, valid_to). Only the closing fields of a row are ever updated.';

-- ---------------------------------------------------------------------------
-- person_department_assignments: a person''s home department over time.
-- person_id is the Auth user id (the stable identity that survives removal
-- from the team); deliberately NOT a reference to profiles.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.person_department_assignments (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  department_id     uuid        NOT NULL REFERENCES public.business_departments(id) ON DELETE RESTRICT,
  valid_from        timestamptz NOT NULL,
  valid_to          timestamptz,
  created_at        timestamptz NOT NULL,
  created_by        uuid        NOT NULL,
  closed_at         timestamptz,
  closed_by         uuid,
  reason            text        NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  request_id        uuid        NOT NULL,
  closed_request_id uuid,
  CONSTRAINT person_department_assignments_interval CHECK (
    isfinite(valid_from) AND (valid_to IS NULL OR (isfinite(valid_to) AND valid_to > valid_from))
  ),
  -- One home department per person at any instant, across every site.
  CONSTRAINT person_department_assignments_no_overlap EXCLUDE USING gist (
    person_id extensions.gist_uuid_ops WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS person_department_assignments_one_open
  ON public.person_department_assignments (person_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS person_department_assignments_department_idx
  ON public.person_department_assignments (department_id, valid_to, person_id);
CREATE INDEX IF NOT EXISTS person_department_assignments_person_idx
  ON public.person_department_assignments (person_id, valid_from, id);

COMMENT ON TABLE public.person_department_assignments IS
  'F5: home-department history per person (Auth user id), half-open UTC intervals. One open row per person. Only closing fields are ever updated; rows are never deleted or replaced.';

-- ---------------------------------------------------------------------------
-- department_audit: append-only record of every change. Department facts
-- only: no rates, emails, credentials or profile dumps.
-- actor_id is NULL only for a profile removal done without an end-user login
-- (see reason 'profile_removed_actor_unavailable').
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.department_audit (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    uuid,
  operation     text        NOT NULL CHECK (operation IN
                  ('create','rename','archive','restore','assign','transfer','correct','remove','control')),
  actor_id      uuid,
  department_id uuid,
  person_id     uuid,
  assignment_id uuid,
  recorded_at   timestamptz NOT NULL,
  effective_at  timestamptz NOT NULL,
  before_data   jsonb,
  after_data    jsonb,
  reason        text        NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500)
);

CREATE INDEX IF NOT EXISTS department_audit_recorded_idx
  ON public.department_audit (recorded_at, id);
CREATE INDEX IF NOT EXISTS department_audit_person_idx
  ON public.department_audit (person_id, recorded_at, id);

COMMENT ON TABLE public.department_audit IS
  'F5: append-only audit of department and assignment changes. Written only by the admin functions and the profile-removal trigger.';

-- ---------------------------------------------------------------------------
-- department_requests: one receipt per (owner, request id). A retried request
-- returns the stored result instead of applying the change twice.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.department_requests (
  actor_id     uuid        NOT NULL,
  request_id   uuid        NOT NULL,
  payload_hash text        NOT NULL,
  result       jsonb       NOT NULL,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (actor_id, request_id)
);

COMMENT ON TABLE public.department_requests IS
  'F5: idempotency receipts for owner admin requests. Same request id + same payload returns the stored result; a different payload is refused.';

-- ---------------------------------------------------------------------------
-- department_snapshot_control: the one-row switch for event snapshots.
-- Starts OFF. tracking_started_at is fixed by this migration and never moves.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.department_snapshot_control (
  singleton           boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled             boolean     NOT NULL DEFAULT false,
  tracking_started_at timestamptz NOT NULL,
  version             bigint      NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at          timestamptz NOT NULL,
  updated_by          uuid
);

COMMENT ON TABLE public.department_snapshot_control IS
  'F5: single-row switch. enabled=false means new events are saved with status "disabled" and no department. A missing row is "control_missing", never treated as enabled.';

INSERT INTO public.department_snapshot_control (singleton, enabled, tracking_started_at, version, updated_at)
VALUES (true, false, clock_timestamp(), 1, clock_timestamp())
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION departments_private.guard_control()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'department_snapshot_control cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.tracking_started_at IS DISTINCT FROM OLD.tracking_started_at THEN
    RAISE EXCEPTION 'tracking_started_at is fixed and cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS department_snapshot_control_guard ON public.department_snapshot_control;
CREATE TRIGGER department_snapshot_control_guard
  BEFORE UPDATE OR DELETE ON public.department_snapshot_control
  FOR EACH ROW EXECUTE FUNCTION departments_private.guard_control();

-- ---------------------------------------------------------------------------
-- departments_resolver: a login-less role with the least it needs to look up
-- an assignment while an event is being saved (0054). It can read the four
-- tables below and nothing else: no profiles, rates, receipts or events.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'departments_resolver') THEN
    CREATE ROLE departments_resolver
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO departments_resolver;
GRANT USAGE ON SCHEMA departments_private TO departments_resolver;

-- ---------------------------------------------------------------------------
-- Privileges. Start from nothing, then grant the minimum.
--   * No client role gets INSERT/UPDATE/DELETE on any new table, not even an
--     owner: every change goes through the checked functions in 0053.
--   * Owners may read (row-level policy below). Nobody else reads anything.
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE
  public.business_departments,
  public.business_department_names,
  public.person_department_assignments,
  public.department_audit,
  public.department_requests,
  public.department_snapshot_control
FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION departments_private.guard_control() FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
  public.business_departments,
  public.business_department_names,
  public.person_department_assignments,
  public.department_audit,
  public.department_snapshot_control
TO authenticated;

GRANT SELECT ON TABLE
  public.business_departments,
  public.business_department_names,
  public.person_department_assignments,
  public.department_snapshot_control
TO departments_resolver;

ALTER TABLE public.business_departments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_department_names     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person_department_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_audit              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_requests           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_snapshot_control   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_departments_owner_read          ON public.business_departments;
DROP POLICY IF EXISTS business_department_names_owner_read     ON public.business_department_names;
DROP POLICY IF EXISTS person_department_assignments_owner_read ON public.person_department_assignments;
DROP POLICY IF EXISTS department_audit_owner_read              ON public.department_audit;
DROP POLICY IF EXISTS department_snapshot_control_owner_read   ON public.department_snapshot_control;

CREATE POLICY business_departments_owner_read ON public.business_departments
  FOR SELECT TO authenticated USING (public.is_owner());
CREATE POLICY business_department_names_owner_read ON public.business_department_names
  FOR SELECT TO authenticated USING (public.is_owner());
CREATE POLICY person_department_assignments_owner_read ON public.person_department_assignments
  FOR SELECT TO authenticated USING (public.is_owner());
CREATE POLICY department_audit_owner_read ON public.department_audit
  FOR SELECT TO authenticated USING (public.is_owner());
CREATE POLICY department_snapshot_control_owner_read ON public.department_snapshot_control
  FOR SELECT TO authenticated USING (public.is_owner());
-- department_requests: no policy and no grant. Receipts are internal.

DROP POLICY IF EXISTS business_departments_resolver_read          ON public.business_departments;
DROP POLICY IF EXISTS business_department_names_resolver_read     ON public.business_department_names;
DROP POLICY IF EXISTS person_department_assignments_resolver_read ON public.person_department_assignments;
DROP POLICY IF EXISTS department_snapshot_control_resolver_read   ON public.department_snapshot_control;

CREATE POLICY business_departments_resolver_read ON public.business_departments
  FOR SELECT TO departments_resolver USING (true);
CREATE POLICY business_department_names_resolver_read ON public.business_department_names
  FOR SELECT TO departments_resolver USING (true);
CREATE POLICY person_department_assignments_resolver_read ON public.person_department_assignments
  FOR SELECT TO departments_resolver USING (true);
CREATE POLICY department_snapshot_control_resolver_read ON public.department_snapshot_control
  FOR SELECT TO departments_resolver USING (true);

COMMIT;

NOTIFY pgrst, 'reload schema';
