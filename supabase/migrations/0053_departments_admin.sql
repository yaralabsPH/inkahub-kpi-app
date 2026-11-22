-- 0053_departments_admin.sql
--
-- F5 departments, part 2 of 3: owner administration and profile removal.
--
-- Adds three functions an owner calls from the app, and one trigger:
--
--   public.department_admin(...)                 create / rename / archive /
--                                                restore a department, and
--                                                assign / correct a person's
--                                                home department
--   public.department_set_snapshot_enabled(...)  the event-snapshot switch
--   public.department_owner_page(...)            paged owner-only reads
--   profiles_f5_10_close_assignment              when a profile is deleted,
--                                                close that person's open
--                                                assignment in the same
--                                                transaction
--
-- Rules every change follows:
--   * Caller must be signed in AND have the owner role, checked on every
--     call, including a replayed request.
--   * All changes take one exclusive lock (494749, 5), wait at most 2 seconds
--     for it, and only then choose "now" as the effective time. Nothing can be
--     backdated or scheduled.
--   * The change, its audit row and its receipt commit together or not at all.
--   * Nothing here reads or writes production_events.
--
-- Expand-only: new functions and one new trigger on profiles. No existing
-- object is changed. Requires 0052. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by any client role)
-- ---------------------------------------------------------------------------

-- The signed-in owner's id, or an error. Never trusts user metadata or
-- navigation access: only the role stored in profiles.
CREATE OR REPLACE FUNCTION departments_private.require_owner()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_role  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.user_id = v_actor;
  IF v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'owner_only' USING ERRCODE = '42501';
  END IF;
  RETURN v_actor;
END;
$fn$;

-- Trim, collapse runs of spaces to one, keep the casing. Tabs, line breaks
-- and other control characters are refused, not collapsed. 1 to 80 characters.
CREATE OR REPLACE FUNCTION departments_private.normalize_name(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_name text;
BEGIN
  IF p_raw IS NULL THEN
    RAISE EXCEPTION 'name_required' USING ERRCODE = '22023';
  END IF;
  IF p_raw ~ '[\u0001-\u001F\u007F-\u009F\u2028\u2029]' THEN
    RAISE EXCEPTION 'name_has_control_characters' USING ERRCODE = '22023';
  END IF;
  v_name := btrim(regexp_replace(p_raw, '[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+', ' ', 'g'), ' ');
  IF char_length(v_name) < 1 THEN
    RAISE EXCEPTION 'name_required' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'name_too_long' USING ERRCODE = '22023';
  END IF;
  RETURN v_name;
END;
$fn$;

-- Take the one F5 admin lock, waiting at most 2 seconds. A timeout raises
-- SQLSTATE 55P03, which the app treats as "try again".
CREATE OR REPLACE FUNCTION departments_private.lock_exclusive()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_previous text := current_setting('lock_timeout');
BEGIN
  -- Each statement must see what other owners have already committed.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'department changes need READ COMMITTED isolation' USING ERRCODE = '25001';
  END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  PERFORM pg_advisory_xact_lock(494749, 5);
  PERFORM set_config('lock_timeout', v_previous, true);
END;
$fn$;

CREATE OR REPLACE FUNCTION departments_private.payload_hash(p_payload jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
  SELECT encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
$fn$;

CREATE OR REPLACE FUNCTION departments_private.mutation_result(
  p_request_id uuid, p_outcome text, p_effective_at timestamptz,
  p_department_id uuid, p_department_version bigint, p_assignment_id uuid, p_control_version bigint
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
  SELECT jsonb_build_object(
    'request_id',         p_request_id,
    'outcome',            p_outcome,
    'effective_at',       p_effective_at,
    'department_id',      p_department_id,
    -- bigint as a decimal string so the browser never rounds it
    'department_version', p_department_version::text,
    'assignment_id',      p_assignment_id,
    'control_version',    p_control_version::text
  );
$fn$;

-- ---------------------------------------------------------------------------
-- public.department_admin
--
-- p_operation: create | rename | archive | restore | assign | correct
--   create   p_name
--   rename   p_department_id, p_name, p_expected_version
--   archive  p_department_id, p_expected_version
--   restore  p_department_id, p_expected_version
--   assign   p_person_id, p_department_id (target), p_expected_version (of the
--            target), p_expected_assignment_id (the person's current open
--            assignment, or NULL for "has no home")
--   correct  as assign, plus a non-blank p_reason
-- Arguments an operation does not use must be NULL.
--
-- Errors: 42501 not an owner; 22023 bad input or request id reused with a
-- different payload; 40001 someone else changed it first (refresh);
-- 55P03 lock wait timed out (retry the same request); 23505 name taken;
-- P0001 'department_has_members' when archiving a department with people.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.department_admin(
  p_operation text,
  p_request_id uuid,
  p_department_id uuid,
  p_person_id uuid,
  p_name text,
  p_expected_version bigint,
  p_expected_assignment_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_actor      uuid;
  v_name       text;
  v_reason     text;
  v_hash       text;
  v_receipt    public.department_requests%ROWTYPE;
  v_now        timestamptz;
  v_dept       public.business_departments%ROWTYPE;
  v_open       public.person_department_assignments%ROWTYPE;
  v_has_open   boolean;
  v_open_name  public.business_department_names%ROWTYPE;
  v_new_id     uuid;
  v_version    bigint;
  v_audit_op   text;
  v_result     jsonb;
BEGIN
  v_actor := departments_private.require_owner();

  -- ---- validate the request shape (before the lock; cheap and stateless) --
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '22023';
  END IF;
  IF p_operation IS NULL OR p_operation NOT IN ('create','rename','archive','restore','assign','correct') THEN
    RAISE EXCEPTION 'unknown_operation' USING ERRCODE = '22023';
  END IF;
  v_reason := btrim(coalesce(p_reason, ''));
  IF char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason_too_long' USING ERRCODE = '22023';
  END IF;
  IF p_operation = 'correct' AND v_reason = '' THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
  END IF;

  IF p_operation IN ('create','rename') THEN
    v_name := departments_private.normalize_name(p_name);
  ELSIF p_name IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected_name' USING ERRCODE = '22023';
  END IF;

  IF p_operation = 'create' THEN
    IF p_department_id IS NOT NULL OR p_expected_version IS NOT NULL THEN
      RAISE EXCEPTION 'unexpected_department' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_department_id IS NULL THEN
      RAISE EXCEPTION 'department_required' USING ERRCODE = '22023';
    END IF;
    IF p_expected_version IS NULL OR p_expected_version < 1 THEN
      RAISE EXCEPTION 'expected_version_required' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_operation IN ('assign','correct') THEN
    IF p_person_id IS NULL THEN
      RAISE EXCEPTION 'person_required' USING ERRCODE = '22023';
    END IF;
  ELSIF p_person_id IS NOT NULL OR p_expected_assignment_id IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected_person' USING ERRCODE = '22023';
  END IF;

  v_hash := departments_private.payload_hash(jsonb_build_object(
    'operation', p_operation, 'department_id', p_department_id, 'person_id', p_person_id,
    'name', v_name, 'expected_version', p_expected_version,
    'expected_assignment_id', p_expected_assignment_id, 'reason', v_reason));

  -- ---- serialize with every other department change -----------------------
  PERFORM departments_private.lock_exclusive();

  -- A retry of a request that already succeeded returns its stored result,
  -- before any "someone changed it" check (the caller's version is stale
  -- precisely because their own first attempt worked).
  SELECT r.* INTO v_receipt FROM public.department_requests r
   WHERE r.actor_id = v_actor AND r.request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.payload_hash = v_hash THEN
      RETURN v_receipt.result;
    END IF;
    RAISE EXCEPTION 'request_id_reused' USING ERRCODE = '22023';
  END IF;

  -- "Now", chosen only after the lock is held.
  v_now := clock_timestamp();

  IF p_operation <> 'create' THEN
    SELECT d.* INTO v_dept FROM public.business_departments d WHERE d.id = p_department_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'department_not_found' USING ERRCODE = '22023';
    END IF;
    IF v_dept.version <> p_expected_version THEN
      RAISE EXCEPTION 'department_changed' USING ERRCODE = '40001';
    END IF;
  END IF;

  -- ------------------------------------------------------------------ create
  IF p_operation = 'create' THEN
    IF EXISTS (SELECT 1 FROM public.business_departments d WHERE d.normalized_name = lower(v_name)) THEN
      RAISE EXCEPTION 'department_name_taken' USING ERRCODE = '23505';
    END IF;
    INSERT INTO public.business_departments
      (name, normalized_name, archived_at, version, created_at, updated_at, created_by, updated_by)
    VALUES (v_name, lower(v_name), NULL, 1, v_now, v_now, v_actor, v_actor)
    RETURNING id INTO v_new_id;
    INSERT INTO public.business_department_names
      (department_id, name, valid_from, valid_to, created_at, created_by, request_id)
    VALUES (v_new_id, v_name, v_now, NULL, v_now, v_actor, p_request_id);
    INSERT INTO public.department_audit
      (request_id, operation, actor_id, department_id, recorded_at, effective_at, before_data, after_data, reason)
    VALUES (p_request_id, 'create', v_actor, v_new_id, v_now, v_now, NULL,
            jsonb_build_object('name', v_name, 'version', 1), v_reason);
    v_result := departments_private.mutation_result(p_request_id, 'applied', v_now, v_new_id, 1, NULL, NULL);

  -- ------------------------------------------------------------------ rename
  ELSIF p_operation = 'rename' THEN
    IF v_dept.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'department_archived' USING ERRCODE = '22023';
    END IF;
    IF v_dept.name = v_name THEN
      v_result := departments_private.mutation_result(p_request_id, 'noop', NULL, v_dept.id, v_dept.version, NULL, NULL);
    ELSE
      IF EXISTS (SELECT 1 FROM public.business_departments d
                  WHERE d.normalized_name = lower(v_name) AND d.id <> v_dept.id) THEN
        RAISE EXCEPTION 'department_name_taken' USING ERRCODE = '23505';
      END IF;
      SELECT n.* INTO v_open_name FROM public.business_department_names n
       WHERE n.department_id = v_dept.id AND n.valid_to IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'department_name_history_missing' USING ERRCODE = 'XX000';
      END IF;
      IF v_now <= v_open_name.valid_from THEN
        -- Never a zero-length interval and never an invented future time.
        RAISE EXCEPTION 'too_soon_retry' USING ERRCODE = '40001';
      END IF;
      UPDATE public.business_department_names n
         SET valid_to = v_now, closed_at = v_now, closed_by = v_actor, closed_request_id = p_request_id
       WHERE n.id = v_open_name.id;
      INSERT INTO public.business_department_names
        (department_id, name, valid_from, valid_to, created_at, created_by, request_id)
      VALUES (v_dept.id, v_name, v_now, NULL, v_now, v_actor, p_request_id);
      v_version := v_dept.version + 1;
      UPDATE public.business_departments d
         SET name = v_name, normalized_name = lower(v_name), version = v_version,
             updated_at = v_now, updated_by = v_actor
       WHERE d.id = v_dept.id;
      INSERT INTO public.department_audit
        (request_id, operation, actor_id, department_id, recorded_at, effective_at, before_data, after_data, reason)
      VALUES (p_request_id, 'rename', v_actor, v_dept.id, v_now, v_now,
              jsonb_build_object('name', v_dept.name, 'version', v_dept.version),
              jsonb_build_object('name', v_name, 'version', v_version), v_reason);
      v_result := departments_private.mutation_result(p_request_id, 'applied', v_now, v_dept.id, v_version, NULL, NULL);
    END IF;

  -- ----------------------------------------------------------------- archive
  ELSIF p_operation = 'archive' THEN
    IF v_dept.archived_at IS NOT NULL THEN
      v_result := departments_private.mutation_result(p_request_id, 'noop', NULL, v_dept.id, v_dept.version, NULL, NULL);
    ELSE
      -- Includes any assignment left open by a half-finished member removal.
      IF EXISTS (SELECT 1 FROM public.person_department_assignments a
                  WHERE a.department_id = v_dept.id AND a.valid_to IS NULL) THEN
        RAISE EXCEPTION 'department_has_members' USING ERRCODE = 'P0001';
      END IF;
      v_version := v_dept.version + 1;
      UPDATE public.business_departments d
         SET archived_at = v_now, version = v_version, updated_at = v_now, updated_by = v_actor
       WHERE d.id = v_dept.id;
      INSERT INTO public.department_audit
        (request_id, operation, actor_id, department_id, recorded_at, effective_at, before_data, after_data, reason)
      VALUES (p_request_id, 'archive', v_actor, v_dept.id, v_now, v_now,
              jsonb_build_object('archived', false, 'version', v_dept.version),
              jsonb_build_object('archived', true, 'version', v_version), v_reason);
      v_result := departments_private.mutation_result(p_request_id, 'applied', v_now, v_dept.id, v_version, NULL, NULL);
    END IF;

  -- ----------------------------------------------------------------- restore
  ELSIF p_operation = 'restore' THEN
    IF v_dept.archived_at IS NULL THEN
      v_result := departments_private.mutation_result(p_request_id, 'noop', NULL, v_dept.id, v_dept.version, NULL, NULL);
    ELSE
      -- Restores availability only. Nobody is put back into the department.
      v_version := v_dept.version + 1;
      UPDATE public.business_departments d
         SET archived_at = NULL, version = v_version, updated_at = v_now, updated_by = v_actor
       WHERE d.id = v_dept.id;
      INSERT INTO public.department_audit
        (request_id, operation, actor_id, department_id, recorded_at, effective_at, before_data, after_data, reason)
      VALUES (p_request_id, 'restore', v_actor, v_dept.id, v_now, v_now,
              jsonb_build_object('archived', true, 'version', v_dept.version),
              jsonb_build_object('archived', false, 'version', v_version), v_reason);
      v_result := departments_private.mutation_result(p_request_id, 'applied', v_now, v_dept.id, v_version, NULL, NULL);
    END IF;

  -- -------------------------------------------------------- assign / correct
  ELSE
    IF v_dept.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'department_archived' USING ERRCODE = '22023';
    END IF;
    -- Only someone currently on the team can be given a home. Checked under
    -- the same lock the profile-removal trigger takes, so a removal and an
    -- assignment cannot cross.
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = p_person_id) THEN
      RAISE EXCEPTION 'person_not_on_team' USING ERRCODE = '22023';
    END IF;

    SELECT a.* INTO v_open FROM public.person_department_assignments a
     WHERE a.person_id = p_person_id AND a.valid_to IS NULL;
    v_has_open := FOUND;

    IF (CASE WHEN v_has_open THEN v_open.id END) IS DISTINCT FROM p_expected_assignment_id THEN
      RAISE EXCEPTION 'assignment_changed' USING ERRCODE = '40001';
    END IF;

    IF v_has_open AND v_open.department_id = v_dept.id THEN
      -- Already there: no zero-length interval, no audit row.
      v_result := departments_private.mutation_result(p_request_id, 'noop', NULL, v_dept.id, v_dept.version, v_open.id, NULL);
    ELSE
      IF v_has_open THEN
        IF v_now <= v_open.valid_from THEN
          RAISE EXCEPTION 'too_soon_retry' USING ERRCODE = '40001';
        END IF;
        UPDATE public.person_department_assignments a
           SET valid_to = v_now, closed_at = v_now, closed_by = v_actor, closed_request_id = p_request_id
         WHERE a.id = v_open.id;
      END IF;
      INSERT INTO public.person_department_assignments
        (person_id, department_id, valid_from, valid_to, created_at, created_by, reason, request_id)
      VALUES (p_person_id, v_dept.id, v_now, NULL, v_now, v_actor, v_reason, p_request_id)
      RETURNING id INTO v_new_id;

      v_audit_op := CASE WHEN p_operation = 'correct' THEN 'correct'
                         WHEN v_has_open THEN 'transfer'
                         ELSE 'assign' END;
      INSERT INTO public.department_audit
        (request_id, operation, actor_id, department_id, person_id, assignment_id,
         recorded_at, effective_at, before_data, after_data, reason)
      VALUES (p_request_id, v_audit_op, v_actor, v_dept.id, p_person_id, v_new_id, v_now, v_now,
              CASE WHEN v_has_open THEN jsonb_build_object(
                'assignment_id', v_open.id, 'department_id', v_open.department_id, 'valid_from', v_open.valid_from) END,
              jsonb_build_object('assignment_id', v_new_id, 'department_id', v_dept.id, 'valid_from', v_now),
              v_reason);
      v_result := departments_private.mutation_result(p_request_id, 'applied', v_now, v_dept.id, v_dept.version, v_new_id, NULL);
    END IF;
  END IF;

  INSERT INTO public.department_requests (actor_id, request_id, payload_hash, result, created_at)
  VALUES (v_actor, p_request_id, v_hash, v_result, v_now);
  RETURN v_result;
END;
$fn$;

COMMENT ON FUNCTION public.department_admin(text, uuid, uuid, uuid, text, bigint, uuid, text) IS
  'F5: owner-only department and home-assignment changes. Effective now, audited, idempotent per (owner, request id).';

-- ---------------------------------------------------------------------------
-- public.department_set_snapshot_enabled: the kill switch.
-- OFF: new events are saved with status "disabled" and no department.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.department_set_snapshot_enabled(
  p_request_id uuid,
  p_enabled boolean,
  p_expected_version bigint,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_actor   uuid;
  v_reason  text;
  v_hash    text;
  v_receipt public.department_requests%ROWTYPE;
  v_now     timestamptz;
  v_control public.department_snapshot_control%ROWTYPE;
  v_version bigint;
  v_result  jsonb;
BEGIN
  v_actor := departments_private.require_owner();

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '22023';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled_required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'expected_version_required' USING ERRCODE = '22023';
  END IF;
  v_reason := btrim(coalesce(p_reason, ''));
  IF v_reason = '' THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason_too_long' USING ERRCODE = '22023';
  END IF;

  v_hash := departments_private.payload_hash(jsonb_build_object(
    'operation', 'control', 'enabled', p_enabled, 'expected_version', p_expected_version, 'reason', v_reason));

  PERFORM departments_private.lock_exclusive();

  SELECT r.* INTO v_receipt FROM public.department_requests r
   WHERE r.actor_id = v_actor AND r.request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.payload_hash = v_hash THEN
      RETURN v_receipt.result;
    END IF;
    RAISE EXCEPTION 'request_id_reused' USING ERRCODE = '22023';
  END IF;

  v_now := clock_timestamp();

  SELECT c.* INTO v_control FROM public.department_snapshot_control c WHERE c.singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control_missing' USING ERRCODE = 'XX000';
  END IF;
  IF v_control.version <> p_expected_version THEN
    RAISE EXCEPTION 'control_changed' USING ERRCODE = '40001';
  END IF;

  IF v_control.enabled = p_enabled THEN
    v_result := departments_private.mutation_result(p_request_id, 'noop', NULL, NULL, NULL, NULL, v_control.version);
  ELSE
    v_version := v_control.version + 1;
    UPDATE public.department_snapshot_control c
       SET enabled = p_enabled, version = v_version, updated_at = v_now, updated_by = v_actor
     WHERE c.singleton;
    INSERT INTO public.department_audit
      (request_id, operation, actor_id, recorded_at, effective_at, before_data, after_data, reason)
    VALUES (p_request_id, 'control', v_actor, v_now, v_now,
            jsonb_build_object('enabled', v_control.enabled, 'version', v_control.version),
            jsonb_build_object('enabled', p_enabled, 'version', v_version), v_reason);
    v_result := departments_private.mutation_result(p_request_id, 'applied', v_now, NULL, NULL, NULL, v_version);
  END IF;

  INSERT INTO public.department_requests (actor_id, request_id, payload_hash, result, created_at)
  VALUES (v_actor, p_request_id, v_hash, v_result, v_now);
  RETURN v_result;
END;
$fn$;

COMMENT ON FUNCTION public.department_set_snapshot_enabled(uuid, boolean, bigint, text) IS
  'F5: owner-only switch for event department snapshots. Audited and idempotent.';

-- ---------------------------------------------------------------------------
-- public.department_owner_page: paged owner-only reads.
--
-- p_kind                 p_subject_id      order                 cursor keys
--   departments_active   NULL              id                    id
--   departments_archived NULL              id                    id
--   people               NULL              person id             id
--   members              department id     person id             id
--   history              person id         valid_from desc, id   valid_from, id
--   audit                NULL              recorded_at desc, id  recorded_at, id
--
-- Returns {"rows": [...], "next_cursor": {...} | null}. p_limit is 1..100.
-- "people" lists every current profile, with or without a home; it never
-- guesses who is a worker. No rates, emails or roles are returned.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.department_owner_page(
  p_kind text,
  p_subject_id uuid,
  p_cursor jsonb,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_rows     jsonb;
  v_last     jsonb;
  v_next     jsonb := NULL;
  v_after_id uuid;
  v_after_ts timestamptz;
  v_archived boolean;
BEGIN
  PERFORM departments_private.require_owner();

  IF p_kind IS NULL OR p_kind NOT IN
     ('departments_active','departments_archived','people','members','history','audit') THEN
    RAISE EXCEPTION 'unknown_page_kind' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'limit_out_of_range' USING ERRCODE = '22023';
  END IF;
  IF p_kind IN ('members','history') THEN
    IF p_subject_id IS NULL THEN
      RAISE EXCEPTION 'subject_required' USING ERRCODE = '22023';
    END IF;
  ELSIF p_subject_id IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected_subject' USING ERRCODE = '22023';
  END IF;

  -- The cursor is whatever this function returned as next_cursor. Anything
  -- else is refused rather than guessed at.
  IF p_cursor IS NOT NULL AND p_cursor <> 'null'::jsonb THEN
    BEGIN
      IF jsonb_typeof(p_cursor) <> 'object' THEN
        RAISE EXCEPTION 'cursor_not_object';
      END IF;
      v_after_id := (p_cursor ->> 'id')::uuid;
      IF v_after_id IS NULL THEN
        RAISE EXCEPTION 'cursor_without_id';
      END IF;
      IF p_kind = 'history' THEN
        v_after_ts := (p_cursor ->> 'valid_from')::timestamptz;
      ELSIF p_kind = 'audit' THEN
        v_after_ts := (p_cursor ->> 'recorded_at')::timestamptz;
      END IF;
      IF p_kind IN ('history','audit') AND v_after_ts IS NULL THEN
        RAISE EXCEPTION 'cursor_without_time';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_cursor' USING ERRCODE = '22023';
    END;
  END IF;

  IF p_kind IN ('departments_active','departments_archived') THEN
    v_archived := (p_kind = 'departments_archived');
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) INTO v_rows
      FROM (
        SELECT d.id, d.name, d.version::text AS version, d.archived_at, d.created_at, d.updated_at,
               (SELECT count(*)::int FROM public.person_department_assignments a
                 WHERE a.department_id = d.id AND a.valid_to IS NULL) AS member_count
          FROM public.business_departments d
         WHERE (d.archived_at IS NOT NULL) = v_archived
           AND (v_after_id IS NULL OR d.id > v_after_id)
         ORDER BY d.id
         LIMIT p_limit + 1
      ) x;

  ELSIF p_kind = 'people' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.person_id), '[]'::jsonb) INTO v_rows
      FROM (
        SELECT p.user_id AS person_id, p.display_name, a.id AS assignment_id,
               a.department_id, d.name AS department_name, a.valid_from
          FROM public.profiles p
          LEFT JOIN public.person_department_assignments a
                 ON a.person_id = p.user_id AND a.valid_to IS NULL
          LEFT JOIN public.business_departments d ON d.id = a.department_id
         WHERE (v_after_id IS NULL OR p.user_id > v_after_id)
         ORDER BY p.user_id
         LIMIT p_limit + 1
      ) x;

  ELSIF p_kind = 'members' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.person_id), '[]'::jsonb) INTO v_rows
      FROM (
        SELECT a.person_id, p.display_name, a.id AS assignment_id,
               a.department_id, d.name AS department_name, a.valid_from
          FROM public.person_department_assignments a
          JOIN public.business_departments d ON d.id = a.department_id
          LEFT JOIN public.profiles p ON p.user_id = a.person_id
         WHERE a.department_id = p_subject_id AND a.valid_to IS NULL
           AND (v_after_id IS NULL OR a.person_id > v_after_id)
         ORDER BY a.person_id
         LIMIT p_limit + 1
      ) x;

  ELSIF p_kind = 'history' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.valid_from DESC, x.id DESC), '[]'::jsonb) INTO v_rows
      FROM (
        SELECT a.id, a.person_id, a.department_id,
               -- the department's name when this assignment began
               (SELECT n.name FROM public.business_department_names n
                 WHERE n.department_id = a.department_id
                   AND n.valid_from <= a.valid_from
                   AND (n.valid_to IS NULL OR a.valid_from < n.valid_to)) AS department_name,
               a.valid_from, a.valid_to, a.reason, a.created_by, a.closed_by
          FROM public.person_department_assignments a
         WHERE a.person_id = p_subject_id
           AND (v_after_ts IS NULL OR (a.valid_from, a.id) < (v_after_ts, v_after_id))
         ORDER BY a.valid_from DESC, a.id DESC
         LIMIT p_limit + 1
      ) x;

  ELSE -- audit
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.recorded_at DESC, x.id DESC), '[]'::jsonb) INTO v_rows
      FROM (
        SELECT u.id, u.request_id, u.operation, u.actor_id, pa.display_name AS actor_name,
               u.department_id, u.person_id, pp.display_name AS person_name, u.assignment_id,
               u.recorded_at, u.effective_at, u.before_data, u.after_data, u.reason
          FROM public.department_audit u
          LEFT JOIN public.profiles pa ON pa.user_id = u.actor_id
          LEFT JOIN public.profiles pp ON pp.user_id = u.person_id
         WHERE (v_after_ts IS NULL OR (u.recorded_at, u.id) < (v_after_ts, v_after_id))
         ORDER BY u.recorded_at DESC, u.id DESC
         LIMIT p_limit + 1
      ) x;
  END IF;

  -- One extra row was fetched to learn whether another page exists.
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_last := v_rows -> (p_limit - 1);
    v_next := CASE p_kind
      WHEN 'people'  THEN jsonb_build_object('id', v_last -> 'person_id')
      WHEN 'members' THEN jsonb_build_object('id', v_last -> 'person_id')
      WHEN 'history' THEN jsonb_build_object('valid_from', v_last -> 'valid_from', 'id', v_last -> 'id')
      WHEN 'audit'   THEN jsonb_build_object('recorded_at', v_last -> 'recorded_at', 'id', v_last -> 'id')
      ELSE jsonb_build_object('id', v_last -> 'id')
    END;
  END IF;

  RETURN jsonb_build_object('rows', v_rows, 'next_cursor', v_next);
END;
$fn$;

COMMENT ON FUNCTION public.department_owner_page(text, uuid, jsonb, integer) IS
  'F5: owner-only paged reads of departments, people, members, assignment history and audit. Max 100 rows per page.';

-- ---------------------------------------------------------------------------
-- Profile removal: close the person's open home assignment at that moment.
--
-- Runs inside the same transaction as the profile DELETE: if this fails, the
-- profile is not deleted. The Auth user id and all history are kept, so a
-- delayed event from before the removal still resolves, and an event after it
-- has no assignment. Putting the same person back needs a fresh assignment.
--
-- When the deletion is done by a server client with no end-user login, the
-- actor is recorded as unknown rather than invented.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION departments_private.close_profile_assignment()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_now   timestamptz;
  v_open  public.person_department_assignments%ROWTYPE;
BEGIN
  PERFORM departments_private.lock_exclusive();
  v_now := clock_timestamp();

  SELECT a.* INTO v_open FROM public.person_department_assignments a
   WHERE a.person_id = OLD.user_id AND a.valid_to IS NULL;
  IF NOT FOUND THEN
    RETURN OLD; -- no home: nothing to close
  END IF;
  IF v_now <= v_open.valid_from THEN
    RAISE EXCEPTION 'too_soon_retry' USING ERRCODE = '40001';
  END IF;

  UPDATE public.person_department_assignments a
     SET valid_to = v_now, closed_at = v_now, closed_by = v_actor
   WHERE a.id = v_open.id;

  INSERT INTO public.department_audit
    (request_id, operation, actor_id, department_id, person_id, assignment_id,
     recorded_at, effective_at, before_data, after_data, reason)
  VALUES (NULL, 'remove', v_actor, v_open.department_id, OLD.user_id, v_open.id, v_now, v_now,
          jsonb_build_object('assignment_id', v_open.id, 'department_id', v_open.department_id,
                             'valid_from', v_open.valid_from),
          NULL,
          CASE WHEN v_actor IS NULL THEN 'profile_removed_actor_unavailable' ELSE 'profile_removed' END);
  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS profiles_f5_10_close_assignment ON public.profiles;
CREATE TRIGGER profiles_f5_10_close_assignment
  BEFORE DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION departments_private.close_profile_assignment();

-- ---------------------------------------------------------------------------
-- Privileges: nothing by default, then exactly three callable functions.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION departments_private.require_owner()                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION departments_private.normalize_name(text)           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION departments_private.lock_exclusive()               FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION departments_private.payload_hash(jsonb)            FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION departments_private.mutation_result(uuid, text, timestamptz, uuid, bigint, uuid, bigint)
                                                                          FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION departments_private.close_profile_assignment()     FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.department_admin(text, uuid, uuid, uuid, text, bigint, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.department_set_snapshot_enabled(uuid, boolean, bigint, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.department_owner_page(text, uuid, jsonb, integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.department_admin(text, uuid, uuid, uuid, text, bigint, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.department_set_snapshot_enabled(uuid, boolean, bigint, text)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.department_owner_page(text, uuid, jsonb, integer)                 TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
