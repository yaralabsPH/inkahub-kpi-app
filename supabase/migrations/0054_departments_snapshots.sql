-- 0054_departments_snapshots.sql
--
-- F5 departments, part 3 of 3: the department snapshot on each new event.
--
-- Adds eleven nullable columns to production_events and three triggers, so
-- that every NEW event keeps the business department its worker belonged to
-- at the time. Moving or renaming later never changes an event already saved.
--
--   production_events_f5_10_sanitize  BEFORE INSERT  always runs first; throws
--                                     away anything the client sent in the
--                                     new columns and stamps receipt time
--   production_events_f5_20_resolve   BEFORE INSERT  looks up the assignment
--                                     in force at the event's time
--   production_events_f5_10_freeze    BEFORE UPDATE  keeps the saved snapshot
--                                     exactly as it was
--
-- Postgres fires same-event triggers in name order, so sanitize (f5_10) runs
-- before resolve (f5_20). Any other trigger on this table is left alone,
-- including the item-counting capture trigger, which is AFTER and so sees the
-- finished row once.
--
-- What does NOT happen here:
--   * No existing row is updated or backfilled. Rows saved before this
--     migration keep all eleven columns NULL for ever ("legacy").
--   * production_events.department (the work type) is untouched; routing is
--     unchanged.
--   * No existing column, default, constraint, policy or grant is changed.
--     Old app versions keep inserting exactly as before.
--   * The lookup can never stop a scan from being saved: any problem in it is
--     recorded on the row as a status and the insert continues.
--
-- Snapshots start OFF (0052 seeds department_snapshot_control.enabled =
-- false): until an owner switches them on, new events are saved with status
-- "disabled" and no department.
--
-- Locking note for the person applying this: ADD COLUMN and CREATE INDEX take
-- a short lock on production_events. Apply at a quiet time.
--
-- Requires 0052 and 0053. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- The eleven columns. All nullable, no defaults, no foreign keys: a missing
-- or failed lookup must never reject an otherwise valid scan.
-- ---------------------------------------------------------------------------

ALTER TABLE public.production_events
  ADD COLUMN IF NOT EXISTS business_department_id              uuid,
  ADD COLUMN IF NOT EXISTS business_department_name            text,
  ADD COLUMN IF NOT EXISTS business_department_assignment_id   uuid,
  ADD COLUMN IF NOT EXISTS business_department_name_version_id uuid,
  ADD COLUMN IF NOT EXISTS business_department_status          text,
  ADD COLUMN IF NOT EXISTS department_snapshot_version         smallint,
  ADD COLUMN IF NOT EXISTS department_occurred_at              timestamptz,
  ADD COLUMN IF NOT EXISTS department_received_at              timestamptz,
  ADD COLUMN IF NOT EXISTS department_resolution_instant       timestamptz,
  ADD COLUMN IF NOT EXISTS department_time_status              text,
  ADD COLUMN IF NOT EXISTS department_resolved_at              timestamptz;

COMMENT ON COLUMN public.production_events.business_department_id IS
  'F5: business department (team) the worker belonged to at the event time. NOT the work type in "department". Set by the database only.';
COMMENT ON COLUMN public.production_events.business_department_name IS
  'F5: that department''s name at the event time. A later rename does not change it.';
COMMENT ON COLUMN public.production_events.business_department_assignment_id IS
  'F5: the person_department_assignments row that was in force.';
COMMENT ON COLUMN public.production_events.business_department_name_version_id IS
  'F5: the business_department_names row that was in force.';
COMMENT ON COLUMN public.production_events.business_department_status IS
  'F5: assigned | unassigned | before_tracking | invalid_time | resolution_busy | resolution_error | disabled | control_missing | resolver_unavailable. NULL = legacy row saved before F5, never resolved. Only "assigned" carries a department.';
COMMENT ON COLUMN public.production_events.department_snapshot_version IS
  'F5: version of this snapshot contract (1).';
COMMENT ON COLUMN public.production_events.department_occurred_at IS
  'F5: created_at exactly as reported when the row was inserted, even if suspect.';
COMMENT ON COLUMN public.production_events.department_received_at IS
  'F5: database clock when the row arrived. Cannot be set by a client.';
COMMENT ON COLUMN public.production_events.department_resolution_instant IS
  'F5: the instant used to look up the assignment (reported time, or receipt time when the reported time was up to 5 seconds ahead). NULL when no lookup was possible.';
COMMENT ON COLUMN public.production_events.department_time_status IS
  'F5: reported | future_clamped | reported_old | invalid_time. Independent of business_department_status. reported_old (more than 5 minutes behind receipt) is a warning, not a refusal.';
COMMENT ON COLUMN public.production_events.department_resolved_at IS
  'F5: database clock when the lookup was attempted (also set when switched off or failed). NULL when only the sanitize trigger ran.';

-- For the operator health queries: recent events by receipt time. Legacy rows
-- (NULL receipt time) are not indexed.
CREATE INDEX IF NOT EXISTS production_events_department_received_idx
  ON public.production_events (department_received_at, location, id)
  WHERE department_received_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- classify_time: the one place the clock rules live.
--   O = reported time (created_at), S = receipt time (database clock)
--     O missing / not finite, or O - S > 5 seconds  -> invalid_time, no instant
--     0 < O - S <= 5 seconds                        -> future_clamped, use S
--     S - O > 5 minutes                             -> reported_old,  use O
--     otherwise (including O = S)                   -> reported,      use O
-- An event cannot really have happened after the database received it, so a
-- slightly fast tablet clock is resolved at receipt time and marked.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION departments_private.classify_time(
  p_occurred_at timestamptz,
  p_received_at timestamptz
)
RETURNS TABLE (time_status text, resolution_instant timestamptz)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF p_occurred_at IS NULL OR p_received_at IS NULL
     OR NOT isfinite(p_occurred_at) OR NOT isfinite(p_received_at)
     OR p_occurred_at - p_received_at > interval '5 seconds' THEN
    time_status := 'invalid_time';
    resolution_instant := NULL;
  ELSIF p_occurred_at > p_received_at THEN
    time_status := 'future_clamped';
    resolution_instant := p_received_at;
  ELSIF p_received_at - p_occurred_at > interval '5 minutes' THEN
    time_status := 'reported_old';
    resolution_instant := p_occurred_at;
  ELSE
    time_status := 'reported';
    resolution_instant := p_occurred_at;
  END IF;
  RETURN NEXT;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- sanitize_event (BEFORE INSERT, first).
-- Independent of everything else: reads no table, calls no helper, and so
-- keeps working when the resolver is switched off for repair. Whatever the
-- client sent in the F5 columns is discarded.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION departments_private.sanitize_event()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $fn$
BEGIN
  NEW.business_department_id              := NULL;
  NEW.business_department_name            := NULL;
  NEW.business_department_assignment_id   := NULL;
  NEW.business_department_name_version_id := NULL;
  -- If the resolver does not run after this, the row says so.
  NEW.business_department_status          := 'resolver_unavailable';
  NEW.department_snapshot_version         := 1;
  NEW.department_occurred_at              := NEW.created_at;
  NEW.department_received_at              := clock_timestamp();
  NEW.department_resolution_instant       := NULL;
  NEW.department_time_status              := NULL;
  NEW.department_resolved_at              := NULL;
  RETURN NEW;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- resolve_event (BEFORE INSERT, second).
--
-- Looks up by the CREDITED worker (NEW.staff_id), never by the logged-in
-- account: a kiosk login saves events for whoever scanned their badge.
--
-- Never waits for an owner who is editing departments: it tries a shared lock
-- (494749, 5) and, if an edit is in progress, saves "resolution_busy".
-- After the lock is held, the lookup is a new statement, so under READ
-- COMMITTED it sees every change committed before that point.
--
-- Everything optional sits inside one guarded block. If any of it fails, the
-- row is saved with "resolution_error" and no department. Errors outside this
-- function (permissions, constraints, other triggers, cancellation) are not
-- caught here.
--
-- Runs as departments_resolver, which can read only the department tables.
-- ---------------------------------------------------------------------------

-- On a re-run this function already belongs to departments_resolver, so the
-- migration role needs to act as that role to replace it. The membership is
-- removed again at the end of this migration.
GRANT departments_resolver TO CURRENT_USER;

CREATE OR REPLACE FUNCTION departments_private.resolve_event()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_time_status text;
  v_instant     timestamptz;
  v_enabled     boolean;
  v_tracking    timestamptz;
  v_matches     integer;
  v_row         record;
BEGIN
  NEW.department_resolved_at := clock_timestamp();

  BEGIN
    -- The receipt time comes from the sanitize trigger. Without it there is
    -- nothing trustworthy to resolve against.
    IF NEW.department_received_at IS NULL THEN
      RAISE EXCEPTION 'receipt time missing';
    END IF;

    SELECT c.time_status, c.resolution_instant INTO v_time_status, v_instant
      FROM departments_private.classify_time(NEW.department_occurred_at, NEW.department_received_at) c;
    NEW.department_time_status        := v_time_status;
    NEW.department_resolution_instant := v_instant;

    SELECT c.enabled, c.tracking_started_at INTO v_enabled, v_tracking
      FROM public.department_snapshot_control c WHERE c.singleton;
    IF NOT FOUND THEN
      NEW.business_department_status := 'control_missing';
      RETURN NEW;
    END IF;
    IF NOT v_enabled THEN
      NEW.business_department_status := 'disabled';
      RETURN NEW;
    END IF;

    IF v_time_status = 'invalid_time' THEN
      NEW.business_department_status := 'invalid_time';
      RETURN NEW;
    END IF;
    IF v_instant < v_tracking THEN
      NEW.business_department_status := 'before_tracking';
      RETURN NEW;
    END IF;

    -- Under any other isolation level the lookup below could read stale data.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      NEW.business_department_status := 'resolution_error';
      RETURN NEW;
    END IF;

    IF NOT pg_try_advisory_xact_lock_shared(494749, 5) THEN
      NEW.business_department_status := 'resolution_busy';
      RETURN NEW;
    END IF;

    -- The switch may have been turned off while we were getting here.
    SELECT c.enabled INTO v_enabled
      FROM public.department_snapshot_control c WHERE c.singleton;
    IF NOT FOUND THEN
      NEW.business_department_status := 'control_missing';
      RETURN NEW;
    END IF;
    IF NOT v_enabled THEN
      NEW.business_department_status := 'disabled';
      RETURN NEW;
    END IF;

    -- Assignment and name in force at the instant, in one statement.
    v_matches := 0;
    FOR v_row IN
      SELECT a.id AS assignment_id, a.department_id, d.archived_at,
             n.id AS name_version_id, n.name
        FROM public.person_department_assignments a
        LEFT JOIN public.business_departments d ON d.id = a.department_id
        LEFT JOIN public.business_department_names n
               ON n.department_id = a.department_id
              AND n.valid_from <= v_instant
              AND (n.valid_to IS NULL OR v_instant < n.valid_to)
       WHERE a.person_id = NEW.staff_id
         AND a.valid_from <= v_instant
         AND (a.valid_to IS NULL OR v_instant < a.valid_to)
       LIMIT 2
    LOOP
      v_matches := v_matches + 1;
      IF v_matches = 1 THEN
        IF v_row.name_version_id IS NULL OR v_row.name IS NULL
           -- an assignment can never run into a time its department is archived
           OR (v_row.archived_at IS NOT NULL AND v_instant >= v_row.archived_at) THEN
          NEW.business_department_status := 'resolution_error';
        ELSE
          NEW.business_department_id              := v_row.department_id;
          NEW.business_department_name            := v_row.name;
          NEW.business_department_assignment_id   := v_row.assignment_id;
          NEW.business_department_name_version_id := v_row.name_version_id;
          NEW.business_department_status          := 'assigned';
        END IF;
      END IF;
    END LOOP;

    IF v_matches = 0 THEN
      NEW.business_department_status := 'unassigned';
    ELSIF v_matches > 1 THEN
      -- Overlapping history should be impossible; never pick one.
      NEW.business_department_id              := NULL;
      NEW.business_department_name            := NULL;
      NEW.business_department_assignment_id   := NULL;
      NEW.business_department_name_version_id := NULL;
      NEW.business_department_status          := 'resolution_error';
    END IF;

  EXCEPTION WHEN OTHERS THEN
    NEW.business_department_id              := NULL;
    NEW.business_department_name            := NULL;
    NEW.business_department_assignment_id   := NULL;
    NEW.business_department_name_version_id := NULL;
    NEW.business_department_status          := 'resolution_error';
    BEGIN
      -- Fixed category and the event key only: no customer data.
      RAISE WARNING 'f5_departments resolution_error location=% id=% sqlstate=%', NEW.location, NEW.id, SQLSTATE;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- a logging problem must not reject the scan either
    END;
  END;

  RETURN NEW;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- freeze_event (BEFORE UPDATE).
-- A saved snapshot never changes: every F5 column is copied back from the old
-- row, including the all-NULL of a legacy row. Once a row has a snapshot, the
-- facts it was resolved from (who, when, where, which row) cannot be changed
-- either. Any other update is allowed as before. Nothing is re-resolved.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION departments_private.freeze_event()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $fn$
BEGIN
  NEW.business_department_id              := OLD.business_department_id;
  NEW.business_department_name            := OLD.business_department_name;
  NEW.business_department_assignment_id   := OLD.business_department_assignment_id;
  NEW.business_department_name_version_id := OLD.business_department_name_version_id;
  NEW.business_department_status          := OLD.business_department_status;
  NEW.department_snapshot_version         := OLD.department_snapshot_version;
  NEW.department_occurred_at              := OLD.department_occurred_at;
  NEW.department_received_at              := OLD.department_received_at;
  NEW.department_resolution_instant       := OLD.department_resolution_instant;
  NEW.department_time_status              := OLD.department_time_status;
  NEW.department_resolved_at              := OLD.department_resolved_at;

  IF OLD.business_department_status IS NOT NULL
     AND (NEW.staff_id   IS DISTINCT FROM OLD.staff_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.location   IS DISTINCT FROM OLD.location
       OR NEW.id         IS DISTINCT FROM OLD.id) THEN
    RAISE EXCEPTION 'department snapshot is frozen: staff_id, created_at, location and id of this event cannot be changed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Privileges and ownership.
-- No client role can call any of these directly. The resolver runs as
-- departments_resolver (created in 0052): it may read the department tables
-- and call classify_time, nothing more.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION departments_private.classify_time(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION departments_private.sanitize_event()                        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION departments_private.resolve_event()                         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION departments_private.freeze_event()                          FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION departments_private.classify_time(timestamptz, timestamptz) TO departments_resolver;

-- Hand the resolver function to departments_resolver. Changing the owner
-- needs the migration role to be able to act as the new owner (granted
-- above), and the new owner to hold CREATE on the schema, for a moment. Both
-- are taken away again before the migration commits.
--
-- The membership is NOT revoked here. Once the function belongs to
-- departments_resolver and nobody else may execute it, the migration role can
-- only attach it to a trigger through that membership (CREATE TRIGGER checks
-- EXECUTE on the function). So the revoke comes after the triggers, below.
GRANT CREATE ON SCHEMA departments_private TO departments_resolver;
ALTER FUNCTION departments_private.resolve_event() OWNER TO departments_resolver;
REVOKE CREATE ON SCHEMA departments_private FROM departments_resolver;

-- ---------------------------------------------------------------------------
-- Triggers. Names fix the firing order: f5_10 before f5_20.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS production_events_f5_10_sanitize ON public.production_events;
CREATE TRIGGER production_events_f5_10_sanitize
  BEFORE INSERT ON public.production_events
  FOR EACH ROW EXECUTE FUNCTION departments_private.sanitize_event();

DROP TRIGGER IF EXISTS production_events_f5_20_resolve ON public.production_events;
CREATE TRIGGER production_events_f5_20_resolve
  BEFORE INSERT ON public.production_events
  FOR EACH ROW EXECUTE FUNCTION departments_private.resolve_event();

DROP TRIGGER IF EXISTS production_events_f5_10_freeze ON public.production_events;
CREATE TRIGGER production_events_f5_10_freeze
  BEFORE UPDATE ON public.production_events
  FOR EACH ROW EXECUTE FUNCTION departments_private.freeze_event();

-- Last: give up the temporary membership taken before resolve_event was
-- created. After this the migration role can no longer execute or replace
-- that function, and no client role ever could.
REVOKE departments_resolver FROM CURRENT_USER;

COMMIT;

NOTIFY pgrst, 'reload schema';
