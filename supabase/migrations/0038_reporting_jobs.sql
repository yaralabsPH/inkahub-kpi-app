-- 0038_reporting_jobs.sql
--
-- item-counting amendment, Task 13 (DRAFT, not applied). Part A: activation
-- fence, capture control transition, per-site acknowledgement receipts, the
-- single-statement batch freeze and job status. Part B1: batch identity and
-- drift checks, the resumable candidate rebuild (begin/copy/freeze) and lease
-- renewal/takeover/abandon. Part B2 (planning/sealing, chunks, publication)
-- is added to THIS draft at the next checkpoint.
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
  v_drift  text;
  v_base   record;
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

  -- An already-active batch: a drifted one is invalidated (never returned as
  -- usable); a valid live one is busy (no duplicate worker); a valid expired one
  -- is returned unchanged (reused) so its owner can resume_reporting_batch.
  SELECT b.* INTO v_active FROM reporting_private.batches b
   WHERE b.site = p_site AND b.state IN ('active', 'frozen', 'publishing') FOR UPDATE;
  IF FOUND THEN
    v_drift := reporting_private.batch_drift(v_active.batch_id);
    IF v_drift IS NULL AND v_active.lease_expires_at > now() THEN
      RAISE EXCEPTION 'reporting batch % for % is busy until %', v_active.batch_id, p_site, v_active.lease_expires_at;
    ELSIF v_drift IS NULL THEN
      RETURN QUERY SELECT v_active.batch_id, v_active.lease_fence, v_active.base_generation_id, v_active.capture_epoch,
        v_active.rule_version, v_active.source_cutoff, v_active.state,
        (SELECT count(*) FROM reporting_private.batch_changes bc WHERE bc.batch_id = v_active.batch_id),
        (SELECT count(*) FROM reporting_private.batch_events be WHERE be.batch_id = v_active.batch_id), true;
      RETURN;
    END IF;
    UPDATE reporting_private.batches b
       SET state = 'failed', failure_kind = pg_catalog.left('invalidated: ' || v_drift, 200),
           source_cutoff = coalesce(b.source_cutoff, now()), updated_at = now()
     WHERE b.batch_id = v_active.batch_id;
    UPDATE reporting_private.site_state s SET active_batch_id = NULL, updated_at = now() WHERE s.site = p_site;
  END IF;

  IF NOT v_site.processor_enabled THEN
    RAISE EXCEPTION 'reporting processor is disabled for %', p_site;
  END IF;
  IF NOT v_ctl.capture_enabled THEN
    RAISE EXCEPTION 'reporting capture is disabled; refresh cannot prove continuity';
  END IF;
  -- The real base: a complete published generation of THIS site at the current
  -- rule and capture epoch, and a continuous source epoch.
  SELECT g.* INTO v_base FROM reporting_private.generations g WHERE g.generation_id = v_site.active_generation_id;
  IF v_site.active_generation_id IS NULL OR NOT FOUND OR v_base.site <> p_site OR v_base.state <> 'published' OR NOT v_base.complete
     OR v_base.rule_version <> v_ctl.rule_version OR v_base.capture_epoch <> v_ctl.capture_epoch
     OR v_site.source_epoch IS DISTINCT FROM v_ctl.capture_epoch THEN
    RAISE EXCEPTION 'site % has no continuous published base at rule % and capture epoch %; a rebuild is required', p_site, v_ctl.rule_version, v_ctl.capture_epoch;
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
-- 3b. Task 13 Part B1: batch identity, candidate rebuild, lease recovery
-- ---------------------------------------------------------------------------

-- Trimmed order key used by the private mirrors' order indexes. It trims
-- EXACTLY the characters JavaScript's String.prototype.trim removes (ES
-- WhiteSpace + LineTerminator: tab, LF, VT, FF, CR, space, NBSP, U+1680,
-- U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, BOM), so an indexed
-- lookup by order key finds every row the shared TypeScript evidenceOrderKey
-- groups together. A test proves the set equal over every BMP code point.
CREATE FUNCTION reporting_private.order_key(p_order text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT pg_catalog.btrim(p_order, E' \t\n\u000B\f\r\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF')
$fn$;

-- Why a batch may no longer be used (NULL = still valid). Callers already hold
-- the control share lock and the site row lock.
CREATE FUNCTION reporting_private.batch_drift(p_batch uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b record;
  c record;
  s record;
  g record;
BEGIN
  SELECT * INTO b FROM reporting_private.batches x WHERE x.batch_id = p_batch;
  IF NOT FOUND THEN RETURN 'batch not found'; END IF;
  SELECT * INTO c FROM reporting_private.control x WHERE x.singleton;
  SELECT * INTO s FROM reporting_private.site_state x WHERE x.site = b.site;
  IF NOT c.capture_enabled THEN RETURN 'capture is disabled'; END IF;
  IF b.capture_epoch <> c.capture_epoch THEN RETURN 'capture epoch changed'; END IF;
  IF b.rule_version <> c.rule_version THEN RETURN 'rule version changed'; END IF;
  IF s.active_batch_id IS DISTINCT FROM b.batch_id THEN RETURN 'not the site''s active batch'; END IF;
  IF b.base_generation_id IS DISTINCT FROM s.active_generation_id THEN RETURN 'published base changed'; END IF;
  IF b.base_generation_id IS NOT NULL THEN
    SELECT * INTO g FROM reporting_private.generations x WHERE x.generation_id = b.base_generation_id;
    IF NOT FOUND OR g.site <> b.site OR g.state <> 'published' OR NOT g.complete THEN
      RETURN 'base is not a complete published generation of this site';
    END IF;
    -- A refresh continues its base; a rebuild may replace an older rule/epoch base.
    IF b.kind = 'refresh' AND (g.rule_version <> c.rule_version OR g.capture_epoch <> c.capture_epoch) THEN
      RETURN 'refresh base is not at the current rule and capture epoch';
    END IF;
  ELSIF b.kind = 'refresh' THEN
    RETURN 'refresh has no published base';
  END IF;
  RETURN NULL;
END
$fn$;

-- Lock and validate a batch for a mutation: control share lock, then the site
-- row, then the batch row; the batch must be the site's valid active batch at
-- exactly this fence (and, when p_live, under an unexpired lease).
CREATE FUNCTION reporting_private.lock_batch(p_batch uuid, p_fence bigint, p_live boolean)
RETURNS reporting_private.batches
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_site  text;
  v_fence bigint;
  b       reporting_private.batches;
  v_drift text;
BEGIN
  PERFORM 1 FROM reporting_private.control c WHERE c.singleton FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reporting control row is missing'; END IF;
  SELECT x.site INTO v_site FROM reporting_private.batches x WHERE x.batch_id = p_batch;
  IF NOT FOUND THEN RAISE EXCEPTION 'reporting batch % not found', p_batch; END IF;
  SELECT s.lease_fence INTO v_fence FROM reporting_private.site_state s WHERE s.site = v_site FOR UPDATE;
  SELECT * INTO b FROM reporting_private.batches x WHERE x.batch_id = p_batch FOR UPDATE;
  IF b.state NOT IN ('active', 'frozen', 'publishing') THEN
    RAISE EXCEPTION 'reporting batch % is %', p_batch, b.state;
  END IF;
  v_drift := reporting_private.batch_drift(p_batch);
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'reporting batch % is no longer valid: %', p_batch, v_drift;
  END IF;
  IF p_fence IS NULL OR b.lease_fence <> p_fence OR v_fence <> p_fence THEN
    RAISE EXCEPTION 'reporting batch % fence % is obsolete (current %)', p_batch, p_fence, v_fence;
  END IF;
  IF p_live AND (b.lease_expires_at IS NULL OR b.lease_expires_at <= now()) THEN
    RAISE EXCEPTION 'reporting batch % lease expired', p_batch;
  END IF;
  RETURN b;
END
$fn$;

-- Private candidate mirror for a rebuild. Rows are written only while their
-- batch is an ACTIVE rebuild (copy pages and the freeze overlay); afterwards
-- the candidate is immutable, and only deletable once the batch is finished.
CREATE TABLE reporting_private.source_candidate (
  batch_id         uuid        NOT NULL REFERENCES reporting_private.batches (batch_id),
  site             text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  event_id         text        NOT NULL,
  image            jsonb       NOT NULL,
  event_created_at timestamptz NOT NULL,
  order_key        text,
  parent_event_id  text,
  staff_id         uuid,
  PRIMARY KEY (batch_id, site, event_id),
  CHECK (image ->> 'location' = site AND image ->> 'id' = event_id)
);
CREATE INDEX source_candidate_order ON reporting_private.source_candidate (batch_id, site, order_key);
CREATE INDEX source_candidate_parent ON reporting_private.source_candidate (batch_id, site, parent_event_id) WHERE parent_event_id IS NOT NULL;
CREATE INDEX source_candidate_time ON reporting_private.source_candidate (batch_id, site, event_created_at, event_id);
ALTER TABLE reporting_private.source_candidate ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION reporting_private.source_candidate_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_batch uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.batch_id ELSE NEW.batch_id END;
  v_state text;
  v_kind  text;
BEGIN
  SELECT b.state, b.kind INTO v_state, v_kind FROM reporting_private.batches b WHERE b.batch_id = v_batch;
  IF TG_OP = 'UPDATE' AND NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
    RAISE EXCEPTION 'source_candidate rows cannot move between batches';
  END IF;
  IF v_kind = 'rebuild' AND v_state = 'active' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' AND v_state IN ('published', 'failed', 'abandoned') THEN
    RETURN OLD; -- retention cleanup of a finished rebuild
  END IF;
  RAISE EXCEPTION 'source_candidate of batch % is immutable (state %)', v_batch, v_state;
END
$fn$;
CREATE TRIGGER source_candidate_guard BEFORE INSERT OR UPDATE OR DELETE ON reporting_private.source_candidate
  FOR EACH ROW EXECUTE FUNCTION reporting_private.source_candidate_guard();

-- Reserve the site's sole batch for a rebuild (first backfill, or a rule/epoch
-- rebuild). Capture must be on before any copying. A drifted active batch is
-- invalidated; a valid live one is busy; a valid expired one must be resumed
-- or explicitly abandoned, never silently replaced.
CREATE FUNCTION public.begin_reporting_rebuild(p_site text)
RETURNS TABLE (batch_id uuid, lease_fence bigint, base_generation_id uuid, capture_epoch bigint, rule_version text, state text, lease_expires_at timestamptz)
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
  v_drift  text;
  v_base   record;
  v_batch  uuid;
  v_fence  bigint;
  v_lease  timestamptz := now() + interval '360 seconds';
BEGIN
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN
    RAISE EXCEPTION 'begin_reporting_rebuild: unsupported site %', p_site;
  END IF;
  SELECT c.capture_epoch, c.capture_enabled, c.rule_version INTO v_ctl
    FROM reporting_private.control c WHERE c.singleton FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reporting control row is missing'; END IF;
  SELECT s.* INTO v_site FROM reporting_private.site_state s WHERE s.site = p_site FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'site_state row for % is missing', p_site; END IF;
  IF NOT v_ctl.capture_enabled THEN
    RAISE EXCEPTION 'reporting capture must be enabled before a rebuild starts';
  END IF;
  IF NOT v_site.processor_enabled THEN
    RAISE EXCEPTION 'reporting processor is disabled for %', p_site;
  END IF;

  SELECT b.* INTO v_active FROM reporting_private.batches b
   WHERE b.site = p_site AND b.state IN ('active', 'frozen', 'publishing') FOR UPDATE;
  IF FOUND THEN
    v_drift := reporting_private.batch_drift(v_active.batch_id);
    IF v_drift IS NULL AND v_active.lease_expires_at > now() THEN
      RAISE EXCEPTION 'reporting batch % for % is busy until %', v_active.batch_id, p_site, v_active.lease_expires_at;
    ELSIF v_drift IS NULL THEN
      RAISE EXCEPTION 'reporting batch % for % has an expired lease; resume or abandon it first', v_active.batch_id, p_site;
    END IF;
    UPDATE reporting_private.batches b
       SET state = 'failed', failure_kind = pg_catalog.left('invalidated: ' || v_drift, 200),
           source_cutoff = coalesce(b.source_cutoff, now()), updated_at = now()
     WHERE b.batch_id = v_active.batch_id;
    UPDATE reporting_private.site_state s SET active_batch_id = NULL, updated_at = now() WHERE s.site = p_site;
    v_site.active_batch_id := NULL;
  END IF;

  -- The base pointer must stay the unchanged published base (or none yet).
  IF v_site.active_generation_id IS NOT NULL THEN
    SELECT g.* INTO v_base FROM reporting_private.generations g WHERE g.generation_id = v_site.active_generation_id;
    IF NOT FOUND OR v_base.site <> p_site OR v_base.state <> 'published' OR NOT v_base.complete THEN
      RAISE EXCEPTION 'site % active generation is not a complete published generation', p_site;
    END IF;
  END IF;

  v_fence := v_site.lease_fence + 1;
  INSERT INTO reporting_private.batches (site, kind, base_generation_id, rule_version, capture_epoch, source_cutoff, state, lease_fence, lease_expires_at, rebuild_cursor)
  VALUES (p_site, 'rebuild', v_site.active_generation_id, v_ctl.rule_version, v_ctl.capture_epoch, NULL, 'active', v_fence, v_lease,
          pg_catalog.jsonb_build_object('after', NULL, 'pages', 0, 'rows', 0, 'bytes', 0, 'complete', false))
  RETURNING batches.batch_id INTO v_batch;
  UPDATE reporting_private.site_state s
     SET active_batch_id = v_batch, lease_fence = v_fence, lease_expires_at = v_lease, heartbeat_at = now(), updated_at = now()
   WHERE s.site = p_site;
  RETURN QUERY SELECT v_batch, v_fence, v_site.active_generation_id, v_ctl.capture_epoch, v_ctl.rule_version, 'active'::text, v_lease;
END
$fn$;

-- Copy the next keyset page of this site's source into the candidate. The
-- function owns the read and the write (callers never supply images): at most
-- 1,000 rows and 1 MiB of images, ordered by event id; a byte-bounded page
-- ends at its actual last row; a single row over 1 MiB fails visibly; the
-- copy is complete only after a true end-of-source read. The requested cursor
-- must equal the persisted cursor (next page) or the last saved request
-- (identical replay: the saved response is returned, nothing is copied).
CREATE FUNCTION public.copy_reporting_source_page(p_batch uuid, p_fence bigint, p_after_event_id text)
RETURNS TABLE (rows_copied integer, bytes_copied bigint, after_event_id text, next_after_event_id text, page_checksum text,
               complete boolean, pages bigint, total_rows bigint, replay boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b          reporting_private.batches;
  v_cur      jsonb;
  v_last     jsonb;
  v_rows     integer;
  v_bytes    bigint;
  v_fetched  integer;
  v_next     text;
  v_sum      text;
  v_first    bigint;
  v_complete boolean;
  v_resp     jsonb;
BEGIN
  b := reporting_private.lock_batch(p_batch, p_fence, true);
  IF b.kind <> 'rebuild' OR b.state <> 'active' THEN
    RAISE EXCEPTION 'reporting batch % is not an active rebuild', p_batch;
  END IF;
  v_cur := b.rebuild_cursor;
  v_last := v_cur -> 'last';
  -- Identical replay of the last saved request (e.g. a lost response). The
  -- persisted cursor has moved past it, or the copy completed on it: a final
  -- EMPTY page (empty site, or an exact multiple of 1,000 rows) leaves the
  -- cursor where it was, and its retry must still replay, not fail.
  IF v_last IS NOT NULL AND (v_last ->> 'after') IS NOT DISTINCT FROM p_after_event_id
     AND ((v_cur ->> 'after') IS DISTINCT FROM p_after_event_id OR (v_cur ->> 'complete')::boolean) THEN
    v_resp := v_last -> 'response';
    RETURN QUERY SELECT (v_resp ->> 'rows')::integer, (v_resp ->> 'bytes')::bigint, p_after_event_id, v_resp ->> 'next',
      v_resp ->> 'checksum', (v_resp ->> 'complete')::boolean, (v_cur ->> 'pages')::bigint, (v_cur ->> 'rows')::bigint, true;
    RETURN;
  END IF;
  IF (v_cur ->> 'complete')::boolean THEN
    RAISE EXCEPTION 'reporting rebuild % copy is already complete', p_batch;
  END IF;
  IF (v_cur ->> 'after') IS DISTINCT FROM p_after_event_id THEN
    RAISE EXCEPTION 'reporting rebuild % cursor mismatch: requested %, persisted %', p_batch, p_after_event_id, v_cur ->> 'after';
  END IF;

  WITH page AS (
    SELECT pe.id, pg_catalog.to_jsonb(pe) AS img
      FROM public.production_events pe
     WHERE pe.location = b.site AND (p_after_event_id IS NULL OR pe.id > p_after_event_id)
     ORDER BY pe.id
     LIMIT 1000
  ), sized AS (
    SELECT p.id, p.img, pg_catalog.octet_length(p.img::text)::bigint AS bytes,
           sum(pg_catalog.octet_length(p.img::text)) OVER (ORDER BY p.id ROWS UNBOUNDED PRECEDING) AS run
      FROM page p
  ), kept AS (
    SELECT s.id, s.img, s.bytes FROM sized s WHERE s.run <= 1048576
  ), ins AS (
    INSERT INTO reporting_private.source_candidate (batch_id, site, event_id, image, event_created_at, order_key, parent_event_id, staff_id)
    SELECT b.batch_id, b.site, k.id, k.img, (k.img ->> 'created_at')::timestamptz, reporting_private.order_key(k.img ->> 'order_number'),
           k.img ->> 'parent_event_id', (k.img ->> 'staff_id')::uuid
      FROM kept k
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins)::integer,
         (SELECT coalesce(sum(k.bytes), 0) FROM kept k),
         (SELECT count(*) FROM sized)::integer,
         (SELECT k.id FROM kept k ORDER BY k.id DESC LIMIT 1),
         (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(string_agg(k.id || E'\t' || k.img::text, E'\n' ORDER BY k.id), ''), 'UTF8')), 'hex') FROM kept k),
         (SELECT s.bytes FROM sized s ORDER BY s.id LIMIT 1)
    INTO v_rows, v_bytes, v_fetched, v_next, v_sum, v_first;

  IF v_fetched > 0 AND v_rows = 0 THEN
    RAISE EXCEPTION 'source row after % at % is % bytes, over the 1 MiB page limit', p_after_event_id, b.site, v_first;
  END IF;
  v_complete := v_fetched < 1000 AND v_rows = v_fetched;
  v_resp := pg_catalog.jsonb_build_object('rows', v_rows, 'bytes', v_bytes, 'next', coalesce(v_next, p_after_event_id), 'checksum', v_sum, 'complete', v_complete);
  UPDATE reporting_private.batches x
     SET rebuild_cursor = pg_catalog.jsonb_build_object(
           'after', coalesce(v_next, p_after_event_id),
           'pages', (v_cur ->> 'pages')::bigint + 1,
           'rows', (v_cur ->> 'rows')::bigint + v_rows,
           'bytes', (v_cur ->> 'bytes')::bigint + v_bytes,
           'complete', v_complete,
           'last', pg_catalog.jsonb_build_object('after', p_after_event_id, 'response', v_resp)),
         updated_at = now()
   WHERE x.batch_id = p_batch;
  RETURN QUERY SELECT v_rows, v_bytes, p_after_event_id, coalesce(v_next, p_after_event_id), v_sum, v_complete,
    (v_cur ->> 'pages')::bigint + 1, (v_cur ->> 'rows')::bigint + v_rows, false;
END
$fn$;

-- After a complete copy: ONE statement freezes every pending change of the
-- site with its final image/tombstone and overlays them on the candidate
-- (repairing inserts below the cursor, moves, updates and deletes made during
-- copying). Then the batch is frozen and its candidate becomes immutable.
CREATE FUNCTION public.freeze_reporting_rebuild(p_batch uuid, p_fence bigint)
RETURNS TABLE (batch_id uuid, source_cutoff timestamptz, change_count bigint, event_count bigint, upserted bigint, deleted bigint, candidate_rows bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b        reporting_private.batches;
  v_cutoff timestamptz := now();
  v_changes bigint;
  v_events  bigint;
  v_up      bigint;
  v_del     bigint;
BEGIN
  b := reporting_private.lock_batch(p_batch, p_fence, true);
  IF b.kind <> 'rebuild' OR b.state <> 'active' THEN
    RAISE EXCEPTION 'reporting batch % is not an active rebuild', p_batch;
  END IF;
  IF NOT coalesce((b.rebuild_cursor ->> 'complete')::boolean, false) THEN
    RAISE EXCEPTION 'reporting rebuild % copy is not complete', p_batch;
  END IF;

  WITH members AS (
    SELECT p.change_id FROM reporting_private.site_pending_changes(b.site) AS p(change_id)
  ), ins_members AS (
    INSERT INTO reporting_private.batch_changes (batch_id, change_id)
    SELECT b.batch_id, m.change_id FROM members m
    RETURNING change_id
  ), keys AS (
    SELECT c.old_event_id AS event_id FROM reporting_private.changes c JOIN members m ON m.change_id = c.change_id WHERE c.old_site = b.site
    UNION
    SELECT c.new_event_id FROM reporting_private.changes c JOIN members m ON m.change_id = c.change_id WHERE c.new_site = b.site
  ), imgs AS (
    SELECT k.event_id, pg_catalog.to_jsonb(pe) AS img
      FROM keys k
      LEFT JOIN public.production_events pe ON pe.location = b.site AND pe.id = k.event_id
  ), ins_events AS (
    INSERT INTO reporting_private.batch_events (batch_id, site, event_id, image)
    SELECT b.batch_id, b.site, i.event_id, i.img FROM imgs i
    RETURNING 1
  ), up AS (
    INSERT INTO reporting_private.source_candidate (batch_id, site, event_id, image, event_created_at, order_key, parent_event_id, staff_id)
    SELECT b.batch_id, b.site, i.event_id, i.img, (i.img ->> 'created_at')::timestamptz, reporting_private.order_key(i.img ->> 'order_number'),
           i.img ->> 'parent_event_id', (i.img ->> 'staff_id')::uuid
      FROM imgs i WHERE i.img IS NOT NULL
    ON CONFLICT (batch_id, site, event_id) DO UPDATE
      SET image = EXCLUDED.image, event_created_at = EXCLUDED.event_created_at, order_key = EXCLUDED.order_key,
          parent_event_id = EXCLUDED.parent_event_id, staff_id = EXCLUDED.staff_id
    RETURNING 1
  ), del AS (
    DELETE FROM reporting_private.source_candidate sc
     USING imgs i
     WHERE i.img IS NULL AND sc.batch_id = b.batch_id AND sc.site = b.site AND sc.event_id = i.event_id
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins_members), (SELECT count(*) FROM ins_events), (SELECT count(*) FROM up), (SELECT count(*) FROM del)
    INTO v_changes, v_events, v_up, v_del;

  UPDATE reporting_private.batches x SET state = 'frozen', source_cutoff = v_cutoff, updated_at = now() WHERE x.batch_id = p_batch;
  RETURN QUERY SELECT p_batch, v_cutoff, v_changes, v_events, v_up, v_del,
    (SELECT count(*) FROM reporting_private.source_candidate sc WHERE sc.batch_id = p_batch);
END
$fn$;

-- 30-second heartbeat: extend the CURRENT unexpired lease to 360 s; the fence is unchanged.
CREATE FUNCTION public.renew_reporting_lease(p_batch uuid, p_fence bigint)
RETURNS TABLE (batch_id uuid, lease_fence bigint, lease_expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b       reporting_private.batches;
  v_lease timestamptz := now() + interval '360 seconds';
BEGIN
  b := reporting_private.lock_batch(p_batch, p_fence, true);
  UPDATE reporting_private.batches x SET lease_expires_at = v_lease, updated_at = now() WHERE x.batch_id = p_batch;
  UPDATE reporting_private.site_state s SET lease_expires_at = v_lease, heartbeat_at = now(), updated_at = now() WHERE s.site = b.site;
  RETURN QUERY SELECT p_batch, b.lease_fence, v_lease;
END
$fn$;

-- Expired-lease takeover: atomically increment the site's monotonic fence and
-- give it to the SAME batch; unfinished leased work returns to pending and
-- verified staged chunks stay for identical replay. Frozen input is never
-- re-snapshotted; an invalid (drifted) batch is not revived; a live lease is busy.
CREATE FUNCTION public.resume_reporting_batch(p_batch uuid, p_expected_fence bigint)
RETURNS TABLE (batch_id uuid, lease_fence bigint, lease_expires_at timestamptz, state text, returned_work bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_site   text;
  v_sfence bigint;
  b        reporting_private.batches;
  v_drift  text;
  v_new    bigint;
  v_lease  timestamptz := now() + interval '360 seconds';
  v_back   bigint;
BEGIN
  PERFORM 1 FROM reporting_private.control c WHERE c.singleton FOR SHARE;
  SELECT x.site INTO v_site FROM reporting_private.batches x WHERE x.batch_id = p_batch;
  IF NOT FOUND THEN RAISE EXCEPTION 'reporting batch % not found', p_batch; END IF;
  SELECT s.lease_fence INTO v_sfence FROM reporting_private.site_state s WHERE s.site = v_site FOR UPDATE;
  SELECT * INTO b FROM reporting_private.batches x WHERE x.batch_id = p_batch FOR UPDATE;
  IF b.state NOT IN ('active', 'frozen', 'publishing') THEN
    RAISE EXCEPTION 'reporting batch % is % and cannot be resumed', p_batch, b.state;
  END IF;
  v_drift := reporting_private.batch_drift(p_batch);
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'reporting batch % cannot be resumed: %; abandon it', p_batch, v_drift;
  END IF;
  IF p_expected_fence IS NULL OR b.lease_fence <> p_expected_fence OR v_sfence <> p_expected_fence THEN
    RAISE EXCEPTION 'reporting batch % fence % is obsolete (current %)', p_batch, p_expected_fence, v_sfence;
  END IF;
  IF b.lease_expires_at IS NOT NULL AND b.lease_expires_at > now() THEN
    RAISE EXCEPTION 'reporting batch % is busy until %', p_batch, b.lease_expires_at;
  END IF;
  v_new := v_sfence + 1;
  UPDATE reporting_private.site_state s SET lease_fence = v_new, lease_expires_at = v_lease, heartbeat_at = now(), updated_at = now() WHERE s.site = v_site;
  UPDATE reporting_private.batches x SET lease_fence = v_new, lease_expires_at = v_lease, updated_at = now() WHERE x.batch_id = p_batch;
  WITH back AS (
    UPDATE reporting_private.partition_work w SET state = 'pending', lease_fence = NULL
     WHERE w.batch_id = p_batch AND w.state = 'leased'
    RETURNING 1)
  SELECT count(*) INTO v_back FROM back;
  RETURN QUERY SELECT p_batch, v_new, v_lease, b.state, v_back;
END
$fn$;

-- Explicit recovery: mark the site's batch abandoned (evidence kept; its
-- changes stay pending because no receipt is published). Allowed for an
-- expired or drifted batch at the current fence. An unfrozen batch records the
-- abandonment time as its cutoff only to satisfy 0037's state check.
CREATE FUNCTION public.abandon_reporting_batch(p_batch uuid, p_fence bigint, p_reason text)
RETURNS TABLE (batch_id uuid, state text, failure_kind text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_site   text;
  v_sfence bigint;
  b        reporting_private.batches;
  v_reason text;
BEGIN
  IF p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'abandon_reporting_batch needs a reason';
  END IF;
  v_reason := pg_catalog.left('abandoned: ' || pg_catalog.btrim(p_reason), 200);
  PERFORM 1 FROM reporting_private.control c WHERE c.singleton FOR SHARE;
  SELECT x.site INTO v_site FROM reporting_private.batches x WHERE x.batch_id = p_batch;
  IF NOT FOUND THEN RAISE EXCEPTION 'reporting batch % not found', p_batch; END IF;
  SELECT s.lease_fence INTO v_sfence FROM reporting_private.site_state s WHERE s.site = v_site FOR UPDATE;
  SELECT * INTO b FROM reporting_private.batches x WHERE x.batch_id = p_batch FOR UPDATE;
  IF b.state NOT IN ('active', 'frozen', 'publishing') THEN
    RAISE EXCEPTION 'reporting batch % is already %', p_batch, b.state;
  END IF;
  IF p_fence IS NULL OR b.lease_fence <> p_fence OR v_sfence <> p_fence THEN
    RAISE EXCEPTION 'reporting batch % fence % is obsolete (current %)', p_batch, p_fence, v_sfence;
  END IF;
  IF b.lease_expires_at > now() AND reporting_private.batch_drift(p_batch) IS NULL THEN
    RAISE EXCEPTION 'reporting batch % is live and valid until %; it can only be abandoned after expiry or invalidation', p_batch, b.lease_expires_at;
  END IF;
  UPDATE reporting_private.batches x
     SET state = 'abandoned', failure_kind = v_reason, source_cutoff = coalesce(x.source_cutoff, now()), updated_at = now()
   WHERE x.batch_id = p_batch;
  UPDATE reporting_private.site_state s SET active_batch_id = NULL, updated_at = now() WHERE s.site = v_site AND s.active_batch_id = p_batch;
  RETURN QUERY SELECT p_batch, 'abandoned'::text, v_reason;
END
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

-- Part B1.
REVOKE ALL ON TABLE reporting_private.source_candidate FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reporting_private.source_candidate TO service_role;
REVOKE ALL ON FUNCTION reporting_private.source_candidate_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION reporting_private.order_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.batch_drift(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.lock_batch(uuid, bigint, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.order_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.batch_drift(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.lock_batch(uuid, bigint, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.begin_reporting_rebuild(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.copy_reporting_source_page(uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.freeze_reporting_rebuild(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_reporting_lease(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resume_reporting_batch(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.abandon_reporting_batch(uuid, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_reporting_rebuild(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.copy_reporting_source_page(uuid, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.freeze_reporting_rebuild(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_reporting_lease(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.resume_reporting_batch(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.abandon_reporting_batch(uuid, bigint, text) TO service_role;

COMMIT;
