-- 0038_reporting_jobs.sql
--
-- item-counting amendment, Task 13 (PART A — DRAFT, not applied): activation
-- fence, capture control transition, per-site acknowledgement receipts, the
-- single-statement batch freeze and job status. Claim/stage/publish and the
-- rebuild/backfill flow are added to THIS draft after the planner answers the
-- Task 13 Open questions (they are not part of Part A).
--
-- Expand-only. 0034–0037 are not edited. Source table, source policies,
-- helpers, grants and every timeout are unchanged.
--
-- Activation fence (plan: "Activation fence and cross-site acknowledgement"):
--   * The capture trigger function now reads the singleton control row
--     FOR SHARE (also while capture is disabled) and keeps that shared lock
--     until the source transaction ends. Ordinary writers share it; they never
--     lock site_state or a counter. A control UPDATE waits for every
--     pre-toggle source transaction; a waiting READ COMMITTED writer then sees
--     the new row; an older REPEATABLE READ/SERIALIZABLE snapshot fails with a
--     serialization error instead of acknowledging an untracked write.
--     (FOR KEY SHARE would not conflict with the control UPDATE.)
--   * Locking reads need an UPDATE privilege, so reporting_capture gets
--     UPDATE(updated_at) on control only, plus a control UPDATE policy
--     USING (singleton) WITH CHECK (false): the lock is allowed, a real update
--     is refused. No other privilege, ownership, BYPASSRLS or membership.
--   * public.set_reporting_capture(p_enabled) (service-only, SECURITY
--     INVOKER, search_path ''): only the brief control transition, under a
--     transaction-local lock_timeout of at most 3 s (a stricter existing limit
--     is kept). A timeout raises and the transition rolls back.
--   * Batch mutations take the control shared lock BEFORE the site_state row
--     lock and recheck epoch/rule/base/fence.
--
-- Per-site receipts:
--   * A change is pending for site S when S is one of its supported old/new
--     sites, it is not globally acknowledged, and no PUBLISHED batch of S has
--     it in batch_changes. Each site's receipt is independent; an AU→UK move
--     stays pending for UK after AU publishes, and vice versa.
--   * changes.batch_id is never an exclusive claim. It is set only together
--     with acknowledged_at, to the batch whose publication completed the last
--     missing receipt (informational).
--   * acknowledged_at is set only when every distinct supported old/new site
--     has a published receipt. The pass is idempotent; concurrent publications
--     may leave it for a later pass (begin and publish both run it).
--   * No allocated maximum change ID is ever used as a cursor.
--
-- Apply: CJ only (or the planner on CJ's instruction), staging first, as ONE
-- transaction, after 0037. Plain CREATE except the deliberate CREATE OR
-- REPLACE of the existing capture function (its owner, ACL and trigger are
-- unchanged; replacing it needs the owner's privileges, so the migration role
-- holds INHERIT membership in reporting_capture only for that statement).
--
-- Rollback (a NEW migration, only if needed): restore 0037's capture body
-- (same CREATE OR REPLACE path, plain SELECT without FOR SHARE), drop the
-- policy control_capture_lock, revoke UPDATE(updated_at) from
-- reporting_capture, drop the functions added here.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Capture function: control row read FOR SHARE
-- ---------------------------------------------------------------------------

GRANT UPDATE (updated_at) ON reporting_private.control TO reporting_capture;
CREATE POLICY control_capture_lock ON reporting_private.control
  FOR UPDATE TO reporting_capture USING (singleton) WITH CHECK (false);

GRANT reporting_capture TO CURRENT_USER WITH INHERIT TRUE, SET FALSE;
CREATE OR REPLACE FUNCTION reporting_private.capture_production_event_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_epoch     bigint;
  v_enabled   boolean;
  v_supported boolean;
BEGIN
  -- Explicit branches: OLD is never read on INSERT, nor NEW on DELETE.
  IF TG_OP = 'INSERT' THEN
    v_supported := NEW.location IN ('au', 'uk', 'us');
  ELSIF TG_OP = 'DELETE' THEN
    v_supported := OLD.location IN ('au', 'uk', 'us');
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD IS NOT DISTINCT FROM NEW THEN
      RETURN NULL; -- identical row: no report-relevant change
    END IF;
    v_supported := OLD.location IN ('au', 'uk', 'us') OR NEW.location IN ('au', 'uk', 'us');
  ELSE
    RAISE EXCEPTION 'reporting capture: unexpected operation %', TG_OP;
  END IF;
  IF NOT v_supported THEN
    RETURN NULL; -- no supported site on either side
  END IF;
  -- Activation fence: a shared row lock held until this source transaction ends.
  SELECT c.capture_epoch, c.capture_enabled INTO v_epoch, v_enabled
    FROM reporting_private.control c WHERE c.singleton
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reporting capture control row is missing; source write refused';
  END IF;
  IF NOT v_enabled THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO reporting_private.changes (capture_epoch, op, new_site, new_event_id, new_image)
    VALUES (v_epoch, 'INSERT', NEW.location, NEW.id, pg_catalog.to_jsonb(NEW));
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO reporting_private.changes (capture_epoch, op, old_site, old_event_id, old_image, new_site, new_event_id, new_image)
    VALUES (v_epoch, 'UPDATE', OLD.location, OLD.id, pg_catalog.to_jsonb(OLD), NEW.location, NEW.id, pg_catalog.to_jsonb(NEW));
  ELSE
    INSERT INTO reporting_private.changes (capture_epoch, op, old_site, old_event_id, old_image)
    VALUES (v_epoch, 'DELETE', OLD.location, OLD.id, pg_catalog.to_jsonb(OLD));
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE reporting_capture FROM CURRENT_USER;

-- ---------------------------------------------------------------------------
-- 2. Per-site receipts and global acknowledgement (internal helpers)
-- ---------------------------------------------------------------------------

CREATE INDEX batches_site_state ON reporting_private.batches (site, state);

-- Changes still pending for one site (STABLE SQL: inside a caller's statement
-- it uses that statement's snapshot, so a freeze sees one consistent set).
CREATE FUNCTION reporting_private.site_pending_changes(p_site text)
RETURNS SETOF bigint
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT c.change_id
    FROM reporting_private.changes c
   WHERE c.acknowledged_at IS NULL
     AND (c.old_site = p_site OR c.new_site = p_site)
     AND p_site IN ('au', 'uk', 'us')
     AND NOT EXISTS (
       SELECT 1
         FROM reporting_private.batch_changes bc
         JOIN reporting_private.batches b ON b.batch_id = bc.batch_id
        WHERE bc.change_id = c.change_id
          AND b.site = p_site
          AND b.state = 'published')
$fn$;

-- Idempotent: acknowledge every change touching p_site whose EVERY distinct
-- supported old/new site already has a published receipt. Returns the count.
-- p_batch = the publishing batch, or NULL for a delayed pass (begin).
CREATE FUNCTION reporting_private.acknowledge_received_changes(p_site text, p_batch uuid)
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH done AS (
    UPDATE reporting_private.changes c
       SET acknowledged_at = now(),
           -- the completing batch, or (delayed pass) this change's latest published receipt
           batch_id = coalesce(p_batch, (
             SELECT bc.batch_id
               FROM reporting_private.batch_changes bc
               JOIN reporting_private.batches b ON b.batch_id = bc.batch_id
              WHERE bc.change_id = c.change_id AND b.state = 'published'
              ORDER BY b.updated_at DESC, b.batch_id
              LIMIT 1))
     WHERE c.acknowledged_at IS NULL
       AND (c.old_site = p_site OR c.new_site = p_site)
       AND NOT EXISTS (
         SELECT 1
           FROM (VALUES (c.old_site), (c.new_site)) AS s(site)
          WHERE s.site IN ('au', 'uk', 'us')
            AND NOT EXISTS (
              SELECT 1
                FROM reporting_private.batch_changes bc
                JOIN reporting_private.batches b ON b.batch_id = bc.batch_id
               WHERE bc.change_id = c.change_id
                 AND b.site = s.site
                 AND b.state = 'published'))
    RETURNING 1)
  SELECT count(*) FROM done
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Service-only RPCs (public schema so the trusted server can call them)
-- ---------------------------------------------------------------------------

-- Brief control transition. Any change of capture_enabled advances the epoch
-- (0037 control_guard). Never writes source rows.
CREATE FUNCTION public.set_reporting_capture(p_enabled boolean)
RETURNS TABLE (capture_epoch bigint, capture_enabled boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_lock_ms bigint;
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'set_reporting_capture: p_enabled must be true or false';
  END IF;
  -- At most 3 s, keeping a stricter existing limit (0 means no limit).
  SELECT s.setting::bigint INTO v_lock_ms FROM pg_catalog.pg_settings s WHERE s.name = 'lock_timeout';
  IF v_lock_ms = 0 OR v_lock_ms > 3000 THEN
    PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  END IF;
  UPDATE reporting_private.control c
     SET capture_enabled = p_enabled
   WHERE c.singleton AND c.capture_enabled IS DISTINCT FROM p_enabled;
  RETURN QUERY
    SELECT c.capture_epoch, c.capture_enabled FROM reporting_private.control c WHERE c.singleton;
END
$fn$;

-- Open (or return) the site's single active REFRESH batch and freeze its
-- input in ONE data-modifying statement: the exact pending change set for the
-- site, plus the current source image (or a tombstone) of every affected key
-- of this site, plus due future keys from the mirror. Membership and images
-- come from that one statement's snapshot; a change committing later stays
-- pending even if its id is smaller. No LIMIT; a timeout leaves no claim.
CREATE FUNCTION public.begin_reporting_batch(p_site text)
RETURNS TABLE (batch_id uuid, lease_fence bigint, base_generation_id uuid, capture_epoch bigint, rule_version text,
               source_cutoff timestamptz, state text, change_count bigint, event_count bigint, reused boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_ctl    record;
  v_site   record;
  v_active record;
  v_batch  uuid;
  v_fence  bigint;
  v_cutoff timestamptz := now();
  v_changes bigint;
  v_events  bigint;
BEGIN
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN
    RAISE EXCEPTION 'begin_reporting_batch: unsupported site %', p_site;
  END IF;
  -- Fence order: control shared lock first, then the site's metadata row.
  SELECT c.capture_epoch, c.capture_enabled, c.rule_version INTO v_ctl
    FROM reporting_private.control c WHERE c.singleton FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reporting control row is missing'; END IF;
  SELECT s.* INTO v_site FROM reporting_private.site_state s WHERE s.site = p_site FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'site_state row for % is missing', p_site; END IF;

  -- An already-active batch is returned as is (no second batch, no new fence).
  SELECT b.* INTO v_active FROM reporting_private.batches b
   WHERE b.site = p_site AND b.state IN ('active', 'frozen', 'publishing');
  IF FOUND THEN
    RETURN QUERY SELECT v_active.batch_id, v_active.lease_fence, v_active.base_generation_id, v_active.capture_epoch,
      v_active.rule_version, v_active.source_cutoff, v_active.state,
      (SELECT count(*) FROM reporting_private.batch_changes bc WHERE bc.batch_id = v_active.batch_id),
      (SELECT count(*) FROM reporting_private.batch_events be WHERE be.batch_id = v_active.batch_id), true;
    RETURN;
  END IF;

  IF NOT v_site.processor_enabled THEN
    RAISE EXCEPTION 'reporting processor is disabled for %', p_site;
  END IF;
  IF NOT v_ctl.capture_enabled THEN
    RAISE EXCEPTION 'reporting capture is disabled; refresh cannot prove continuity';
  END IF;
  IF v_site.active_generation_id IS NULL OR v_site.source_epoch IS DISTINCT FROM v_ctl.capture_epoch THEN
    RAISE EXCEPTION 'site % has no continuous published base at capture epoch %; a rebuild is required', p_site, v_ctl.capture_epoch;
  END IF;

  -- Delayed global acknowledgements from earlier concurrent publications.
  PERFORM reporting_private.acknowledge_received_changes(p_site, NULL::uuid);

  v_fence := v_site.lease_fence + 1;
  INSERT INTO reporting_private.batches (site, kind, base_generation_id, rule_version, capture_epoch, source_cutoff, state, lease_fence, lease_expires_at)
  VALUES (p_site, 'refresh', v_site.active_generation_id, v_ctl.rule_version, v_ctl.capture_epoch, v_cutoff, 'frozen', v_fence, now() + interval '360 seconds')
  RETURNING batches.batch_id INTO v_batch;
  UPDATE reporting_private.site_state s
     SET active_batch_id = v_batch, lease_fence = v_fence, lease_expires_at = now() + interval '360 seconds', heartbeat_at = now(), updated_at = now()
   WHERE s.site = p_site;

  -- THE freeze: one statement, one snapshot.
  WITH members AS (
    SELECT p.change_id FROM reporting_private.site_pending_changes(p_site) AS p(change_id)
  ), ins_members AS (
    INSERT INTO reporting_private.batch_changes (batch_id, change_id)
    SELECT v_batch, m.change_id FROM members m
    RETURNING change_id
  ), keys AS (
    SELECT c.old_event_id AS event_id FROM reporting_private.changes c JOIN members m ON m.change_id = c.change_id WHERE c.old_site = p_site
    UNION
    SELECT c.new_event_id FROM reporting_private.changes c JOIN members m ON m.change_id = c.change_id WHERE c.new_site = p_site
    UNION
    SELECT sc.event_id FROM reporting_private.source_current sc
     WHERE sc.site = p_site AND sc.event_created_at > coalesce(v_site.last_verified_cutoff, '-infinity'::timestamptz) AND sc.event_created_at <= v_cutoff
  ), ins_events AS (
    INSERT INTO reporting_private.batch_events (batch_id, site, event_id, image)
    SELECT v_batch, p_site, k.event_id, pg_catalog.to_jsonb(pe)
      FROM keys k
      LEFT JOIN public.production_events pe ON pe.location = p_site AND pe.id = k.event_id
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins_members), (SELECT count(*) FROM ins_events) INTO v_changes, v_events;

  RETURN QUERY SELECT v_batch, v_fence, v_site.active_generation_id, v_ctl.capture_epoch, v_ctl.rule_version, v_cutoff, 'frozen'::text, v_changes, v_events, false;
END
$fn$;

-- Server-side job metadata for one site (no source payloads, no secrets).
CREATE FUNCTION public.get_reporting_job_status(p_site text)
RETURNS TABLE (site text, processor_enabled boolean, read_mode text, capture_enabled boolean, capture_epoch bigint, source_epoch bigint,
               active_generation_id uuid, active_batch_id uuid, active_batch_state text, lease_fence bigint, lease_expires_at timestamptz,
               heartbeat_at timestamptz, last_verified_cutoff timestamptz, pending_changes bigint, oldest_pending_captured_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT s.site, s.processor_enabled, s.read_mode, c.capture_enabled, c.capture_epoch, s.source_epoch,
         s.active_generation_id, s.active_batch_id,
         (SELECT b.state FROM reporting_private.batches b WHERE b.batch_id = s.active_batch_id),
         s.lease_fence, s.lease_expires_at, s.heartbeat_at, s.last_verified_cutoff,
         (SELECT count(*) FROM reporting_private.site_pending_changes(p_site)),
         (SELECT min(ch.captured_at) FROM reporting_private.changes ch
           WHERE ch.change_id IN (SELECT p.change_id FROM reporting_private.site_pending_changes(p_site) AS p(change_id)))
    FROM reporting_private.site_state s
    CROSS JOIN reporting_private.control c
   WHERE s.site = p_site AND c.singleton
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Privileges: service-only
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION reporting_private.site_pending_changes(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.acknowledge_received_changes(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.site_pending_changes(text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.acknowledge_received_changes(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.set_reporting_capture(boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_reporting_batch(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_reporting_job_status(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_reporting_capture(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_reporting_batch(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_reporting_job_status(text) TO service_role;

COMMIT;
