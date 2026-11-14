-- 0038_reporting_jobs.sql
--
-- item-counting amendment, Task 13 (DRAFT, not applied). Part A: activation
-- fence, capture control transition, per-site acknowledgement receipts, the
-- single-statement batch freeze and job status. Part B1: batch identity and
-- drift checks, the resumable candidate rebuild (begin/copy/freeze) and lease
-- renewal/takeover/abandon. Part B2a: work planning/sealing, bounded claims
-- (serialized-response bound) and single/bulk chunk staging of FIVE result
-- arrays (the fifth, source_issue_facts, is T11-4's selected-source warning
-- family) with exact hash/envelope/structure/ownership/source-binding checks.
-- Part B2b: atomic publication (generation, owner replacement across all five
-- families, daily groups, mirror and retained source versions, per-site
-- receipts, no-change and lost-response replay).
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
  -- Candidates are locked in change-id order and rows held by a concurrent
  -- publication are SKIPPED (left for a later idempotent pass), so two sites
  -- publishing a shared move at once never deadlock.
  WITH ready AS (
    SELECT c.change_id
      FROM reporting_private.changes c
     WHERE c.acknowledged_at IS NULL
       AND (c.old_site = p_site OR c.new_site = p_site)
     ORDER BY c.change_id
       FOR UPDATE OF c SKIP LOCKED
  ), done AS (
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
      FROM ready r
     WHERE c.change_id = r.change_id
       AND c.acknowledged_at IS NULL
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
               active_generation_id uuid, active_batch_id uuid, active_batch_state text, active_batch_kind text, lease_fence bigint, lease_expires_at timestamptz,
               heartbeat_at timestamptz, last_verified_cutoff timestamptz, pending_changes bigint, oldest_pending_captured_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT s.site, s.processor_enabled, s.read_mode, c.capture_enabled, c.capture_epoch, s.source_epoch,
         s.active_generation_id, s.active_batch_id,
         (SELECT b.state FROM reporting_private.batches b WHERE b.batch_id = s.active_batch_id),
         (SELECT b.kind FROM reporting_private.batches b WHERE b.batch_id = s.active_batch_id),
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
RETURNS TABLE (batch_id uuid, lease_fence bigint, lease_expires_at timestamptz, state text, returned_work bigint,
               kind text, base_generation_id uuid, rule_version text, capture_epoch bigint, source_cutoff timestamptz,
               rebuild_progress jsonb)
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
  -- Everything a replacement worker with no memory needs to continue (T13B1-1):
  -- identity plus saved rebuild progress (bounded metadata; no source payloads).
  RETURN QUERY SELECT p_batch, v_new, v_lease, b.state, v_back, b.kind, b.base_generation_id, b.rule_version, b.capture_epoch, b.source_cutoff,
    CASE WHEN b.kind = 'rebuild' THEN pg_catalog.jsonb_build_object(
      'afterEventId', b.rebuild_cursor -> 'after',
      'complete', coalesce((b.rebuild_cursor ->> 'complete')::boolean, false),
      'pages', coalesce((b.rebuild_cursor ->> 'pages')::bigint, 0),
      'rows', coalesce((b.rebuild_cursor ->> 'rows')::bigint, 0),
      'bytes', coalesce((b.rebuild_cursor ->> 'bytes')::bigint, 0)) END;
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
-- 3c. Task 13 Part B2a: work planning/sealing, bounded claims, chunk staging
-- ---------------------------------------------------------------------------

-- Additive metadata only (nullable columns; 0037's definitions are unchanged).
ALTER TABLE reporting_private.batches
  ADD COLUMN sealed_at timestamptz,
  ADD COLUMN sealed_work_count integer CHECK (sealed_work_count IS NULL OR sealed_work_count >= 0),
  ADD COLUMN sealed_manifest_hash text CHECK (sealed_manifest_hash IS NULL OR sealed_manifest_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT batches_seal_all_or_none CHECK ((sealed_at IS NULL) = (sealed_work_count IS NULL) AND (sealed_at IS NULL) = (sealed_manifest_hash IS NULL));
ALTER TABLE reporting_private.partition_work
  ADD COLUMN expected_chunk_count integer CHECK (expected_chunk_count IS NULL OR expected_chunk_count >= 1),
  ADD COLUMN expected_result_digest text CHECK (expected_result_digest IS NULL OR expected_result_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT partition_work_expected_pair CHECK ((expected_chunk_count IS NULL) = (expected_result_digest IS NULL));
-- Production date computed by TypeScript (site zone, 04:00) at materialization.
ALTER TABLE reporting_private.event_facts ADD COLUMN production_date date;

-- T11-4: the fifth staged family. A malformed-identity source row (whitespace-
-- only id; an empty id fails the read) keeps its RAW selectors, so it still
-- selects the four evidence families, and carries the shared-TypeScript issue
-- that is reported only when the row is selected. It adds no Items, Orders,
-- timing or parent presence. Versioned exactly like the other result tables.
CREATE TABLE reporting_private.source_issue_facts (
  site             text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  audience_kind    text        NOT NULL CHECK (audience_kind IN ('site', 'self')),
  audience_staff   uuid,
  event_id         text        NOT NULL CHECK (event_id <> ''),
  valid_from_seq   bigint      NOT NULL CHECK (valid_from_seq >= 1),
  valid_to_seq     bigint,
  event_type       text        NOT NULL CHECK (event_type <> ''),
  created_at       timestamptz NOT NULL,
  staff_id         uuid,
  raw_order        text,
  parent_event_id  text,
  issue_kind       text        NOT NULL CHECK (issue_kind IN ('invalid_event', 'unclassified_sku', 'invalid_quantity', 'unresolved_parent', 'missing_completion_detail', 'ambiguous_repeat')),
  issue_detail     text,
  rule_version     text        NOT NULL CHECK (rule_version <> ''),
  -- Trusted owner (set by publication from the work descriptor; new table, so required).
  partition_kind   text        NOT NULL CHECK (partition_kind IN ('order', 'event')),
  partition_key    text        NOT NULL,
  CHECK ((audience_kind = 'site') = (audience_staff IS NULL)),
  CHECK (valid_to_seq IS NULL OR valid_to_seq > valid_from_seq),
  CHECK (audience_kind = 'site' OR staff_id = audience_staff),
  UNIQUE NULLS NOT DISTINCT (site, audience_kind, audience_staff, event_id, valid_from_seq)
);
CREATE INDEX source_issue_facts_current_time ON reporting_private.source_issue_facts (site, audience_kind, audience_staff, created_at, event_id) WHERE valid_to_seq IS NULL;
CREATE INDEX source_issue_facts_validity ON reporting_private.source_issue_facts (site, audience_kind, audience_staff, valid_from_seq, valid_to_seq);
CREATE INDEX source_issue_facts_raw_order ON reporting_private.source_issue_facts (site, audience_kind, audience_staff, raw_order);
CREATE INDEX source_issue_facts_parent ON reporting_private.source_issue_facts (site, audience_kind, audience_staff, parent_event_id) WHERE parent_event_id IS NOT NULL;
ALTER TABLE reporting_private.source_issue_facts ENABLE ROW LEVEL SECURITY;

-- No work is added to a sealed batch, and a descriptor's identity never changes.
CREATE FUNCTION reporting_private.partition_work_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM reporting_private.batches b WHERE b.batch_id = NEW.batch_id AND b.sealed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'reporting batch % is sealed; no work can be added', NEW.batch_id;
    END IF;
  ELSIF NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.audience_kind IS DISTINCT FROM OLD.audience_kind
     OR NEW.audience_staff IS DISTINCT FROM OLD.audience_staff OR NEW.partition_kind IS DISTINCT FROM OLD.partition_kind
     OR NEW.partition_key IS DISTINCT FROM OLD.partition_key OR NEW.input_hash IS DISTINCT FROM OLD.input_hash THEN
    RAISE EXCEPTION 'partition work % descriptor is immutable', OLD.work_id;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER partition_work_guard BEFORE INSERT OR UPDATE ON reporting_private.partition_work
  FOR EACH ROW EXECUTE FUNCTION reporting_private.partition_work_guard();

-- The batch's frozen view of one event: a rebuild's candidate; a refresh's
-- frozen replacement (NULL image = tombstone), else the published mirror.
CREATE FUNCTION reporting_private.frozen_image(p_batch uuid, p_event_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b   record;
  img jsonb;
BEGIN
  SELECT x.batch_id, x.site, x.kind INTO b FROM reporting_private.batches x WHERE x.batch_id = p_batch;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF b.kind = 'rebuild' THEN
    SELECT sc.image INTO img FROM reporting_private.source_candidate sc WHERE sc.batch_id = p_batch AND sc.site = b.site AND sc.event_id = p_event_id;
    RETURN img;
  END IF;
  SELECT be.image INTO img FROM reporting_private.batch_events be WHERE be.batch_id = p_batch AND be.site = b.site AND be.event_id = p_event_id;
  IF FOUND THEN RETURN img; END IF;
  SELECT s.image INTO img FROM reporting_private.source_current s WHERE s.site = b.site AND s.event_id = p_event_id;
  RETURN img;
END
$fn$;

-- The owning partition of a source image: its trimmed nonblank order, else its event id.
CREATE FUNCTION reporting_private.owner_partition(p_image jsonb)
RETURNS TABLE (partition_kind text, partition_key text)
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT CASE WHEN coalesce(reporting_private.order_key(p_image ->> 'order_number'), '') <> '' THEN 'order' ELSE 'event' END,
         CASE WHEN coalesce(reporting_private.order_key(p_image ->> 'order_number'), '') <> '' THEN reporting_private.order_key(p_image ->> 'order_number') ELSE p_image ->> 'id' END
$fn$;

-- SHA-256 manifest over the batch's saved descriptors (byte-for-byte equal to
-- reportingManifestHash in api/_lib/reporting-stage.ts): one JSON array line
-- per work [audienceKind, audienceStaff|null, partitionKind, partitionKey,
-- inputHash], ordered by audience kind, staff (NULL first), partition kind,
-- partition key (bytewise, COLLATE "C"), joined by \n, no trailing newline.
CREATE FUNCTION reporting_private.work_manifest(p_batch uuid)
RETURNS TABLE (work_count integer, manifest_hash text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT count(*)::integer,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(string_agg(
           '[' || pg_catalog.to_json(w.audience_kind)::text || ',' || coalesce(pg_catalog.to_json(w.audience_staff::text)::text, 'null') || ','
               || pg_catalog.to_json(w.partition_kind)::text || ',' || pg_catalog.to_json(w.partition_key)::text || ',' || pg_catalog.to_json(w.input_hash)::text || ']',
           E'\n' ORDER BY w.audience_kind COLLATE "C", w.audience_staff::text COLLATE "C" NULLS FIRST, w.partition_kind COLLATE "C", w.partition_key COLLATE "C"), ''), 'UTF8')), 'hex')
    FROM reporting_private.partition_work w
   WHERE w.batch_id = p_batch
$fn$;

-- Save at most 1,000 descriptors (1 MiB) for a frozen, unsealed batch.
-- Identical replay is a no-op; a conflicting descriptor (same audience and
-- partition, different input hash) fails the whole call.
CREATE FUNCTION public.plan_reporting_work(p_batch uuid, p_fence bigint, p_items jsonb)
RETURNS TABLE (inserted integer, replayed integer, planned_total integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b          reporting_private.batches;
  v_bad      text;
  v_inserted integer;
  v_total    integer;
BEGIN
  b := reporting_private.lock_batch(p_batch, p_fence, true);
  IF b.state <> 'frozen' THEN RAISE EXCEPTION 'reporting batch % is % (planning needs a frozen batch)', p_batch, b.state; END IF;
  IF b.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'reporting batch % is sealed; no work can be added', p_batch; END IF;
  IF p_items IS NULL OR pg_catalog.jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'plan_reporting_work: items must be an array'; END IF;
  IF pg_catalog.jsonb_array_length(p_items) > 1000 THEN RAISE EXCEPTION 'plan_reporting_work: at most 1000 descriptors per call'; END IF;
  IF pg_catalog.octet_length(p_items::text) > 1048576 THEN RAISE EXCEPTION 'plan_reporting_work: request over 1 MiB'; END IF;

  -- Exact descriptor shape: the first problem, in input order.
  SELECT 'descriptor ' || x.ord || ': ' || x.problem INTO v_bad
    FROM (
      SELECT e.ord, CASE
               WHEN pg_catalog.jsonb_typeof(e.v) <> 'object' THEN 'not an object'
               WHEN (SELECT string_agg(k, ',' ORDER BY k COLLATE "C") FROM pg_catalog.jsonb_object_keys(e.v) AS k) IS DISTINCT FROM 'audienceKind,audienceStaff,inputHash,partitionKey,partitionKind' THEN 'unexpected keys'
               WHEN pg_catalog.jsonb_typeof(e.v -> 'audienceKind') <> 'string' OR e.v ->> 'audienceKind' NOT IN ('site', 'self') THEN 'bad audienceKind'
               WHEN pg_catalog.jsonb_typeof(e.v -> 'audienceStaff') NOT IN ('null', 'string') THEN 'bad audienceStaff'
               WHEN (e.v ->> 'audienceKind' = 'site') <> (pg_catalog.jsonb_typeof(e.v -> 'audienceStaff') = 'null') THEN 'audienceStaff must be null exactly for the site audience'
               WHEN pg_catalog.jsonb_typeof(e.v -> 'audienceStaff') = 'string' AND (e.v ->> 'audienceStaff') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN 'bad audienceStaff'
               WHEN pg_catalog.jsonb_typeof(e.v -> 'partitionKind') <> 'string' OR e.v ->> 'partitionKind' NOT IN ('order', 'event') THEN 'bad partitionKind'
               WHEN pg_catalog.jsonb_typeof(e.v -> 'partitionKey') <> 'string' OR e.v ->> 'partitionKey' = '' THEN 'bad partitionKey'
               WHEN e.v ->> 'partitionKind' = 'order' AND reporting_private.order_key(e.v ->> 'partitionKey') IS DISTINCT FROM e.v ->> 'partitionKey' THEN 'order partition key is not a trimmed order key'
               WHEN pg_catalog.octet_length(pg_catalog.to_json(e.v ->> 'partitionKey')::text) > 1048576 - 512 THEN 'partitionKey too large for one claim response'
               WHEN pg_catalog.jsonb_typeof(e.v -> 'inputHash') <> 'string' OR e.v ->> 'inputHash' !~ '^[0-9a-f]{64}$' THEN 'bad inputHash'
             END AS problem
        FROM pg_catalog.jsonb_array_elements(p_items) WITH ORDINALITY AS e(v, ord)) x
   WHERE x.problem IS NOT NULL
   ORDER BY x.ord
   LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'plan_reporting_work: %', v_bad; END IF;

  -- Conflicts: inside this call, or against saved work.
  WITH items AS (
    SELECT e.v ->> 'audienceKind' AS ak, (e.v ->> 'audienceStaff')::uuid AS st, e.v ->> 'partitionKind' AS pk, e.v ->> 'partitionKey' AS key, e.v ->> 'inputHash' AS h
      FROM pg_catalog.jsonb_array_elements(p_items) AS e(v)
  )
  SELECT 'conflicting descriptor for ' || i.ak || '/' || coalesce(i.st::text, '-') || '/' || i.pk || '/' || i.key INTO v_bad
    FROM items i
   WHERE EXISTS (SELECT 1 FROM items j WHERE j.ak = i.ak AND j.st IS NOT DISTINCT FROM i.st AND j.pk = i.pk AND j.key = i.key AND j.h <> i.h)
      OR EXISTS (SELECT 1 FROM reporting_private.partition_work w
                  WHERE w.batch_id = p_batch AND w.audience_kind = i.ak AND w.audience_staff IS NOT DISTINCT FROM i.st
                    AND w.partition_kind = i.pk AND w.partition_key = i.key AND w.input_hash <> i.h)
   LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'plan_reporting_work: %', v_bad; END IF;

  WITH items AS (
    SELECT DISTINCT e.v ->> 'audienceKind' AS ak, (e.v ->> 'audienceStaff')::uuid AS st, e.v ->> 'partitionKind' AS pk, e.v ->> 'partitionKey' AS key, e.v ->> 'inputHash' AS h
      FROM pg_catalog.jsonb_array_elements(p_items) AS e(v)
  ), ins AS (
    INSERT INTO reporting_private.partition_work (batch_id, audience_kind, audience_staff, partition_kind, partition_key, input_hash)
    SELECT p_batch, i.ak, i.st, i.pk, i.key, i.h FROM items i
    ON CONFLICT (batch_id, audience_kind, audience_staff, partition_kind, partition_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_inserted FROM ins;
  SELECT count(*)::integer INTO v_total FROM reporting_private.partition_work w WHERE w.batch_id = p_batch;
  RETURN QUERY SELECT v_inserted, pg_catalog.jsonb_array_length(p_items) - v_inserted, v_total;
END
$fn$;

-- Seal: the exact saved count and manifest must match the worker's; then no
-- more work. An identical re-seal is a no-op; a different one fails.
CREATE FUNCTION public.seal_reporting_work(p_batch uuid, p_fence bigint, p_expected_count integer, p_manifest_hash text)
RETURNS TABLE (batch_id uuid, work_count integer, manifest_hash text, sealed_at timestamptz, replay boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b       reporting_private.batches;
  m       record;
  v_now   timestamptz := now();
BEGIN
  b := reporting_private.lock_batch(p_batch, p_fence, true);
  IF b.state <> 'frozen' THEN RAISE EXCEPTION 'reporting batch % is % (sealing needs a frozen batch)', p_batch, b.state; END IF;
  IF p_expected_count IS NULL OR p_expected_count < 0 OR p_manifest_hash IS NULL OR p_manifest_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'seal_reporting_work: expected count and a SHA-256 manifest hash are required';
  END IF;
  IF b.sealed_at IS NOT NULL THEN
    IF b.sealed_work_count = p_expected_count AND b.sealed_manifest_hash = p_manifest_hash THEN
      RETURN QUERY SELECT p_batch, b.sealed_work_count, b.sealed_manifest_hash, b.sealed_at, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'reporting batch % is already sealed with a different manifest', p_batch;
  END IF;
  SELECT * INTO m FROM reporting_private.work_manifest(p_batch);
  IF m.work_count <> p_expected_count THEN
    RAISE EXCEPTION 'seal_reporting_work: % saved descriptors, expected %', m.work_count, p_expected_count;
  END IF;
  IF m.manifest_hash <> p_manifest_hash THEN
    RAISE EXCEPTION 'seal_reporting_work: manifest hash mismatch';
  END IF;
  UPDATE reporting_private.batches x
     SET sealed_at = v_now, sealed_work_count = m.work_count, sealed_manifest_hash = m.manifest_hash, updated_at = now()
   WHERE x.batch_id = p_batch;
  RETURN QUERY SELECT p_batch, m.work_count, m.manifest_hash, v_now, false;
END
$fn$;

-- Claim a bounded list (1..1000 descriptors) of pending work of a sealed
-- frozen batch under this fence. The bound is the SERIALIZED response
-- (T13B2a-3): each returned row is measured as its json_build_object text —
-- JSON-escaped values, quoted keys and " : "/", " separators, an upper bound
-- of PostgREST's compact row JSON — plus 4 bytes of list separator, plus 2
-- for the brackets; the claimed prefix stays within 1 MiB. Rows that do not
-- fit stay pending for the next claim (never leased and not returned); a
-- first row that cannot fit alone fails visibly (planning already refuses
-- such keys). work_id is returned as text so JavaScript never rounds it.
CREATE FUNCTION public.claim_reporting_work(p_batch uuid, p_fence bigint, p_limit integer DEFAULT 100)
RETURNS TABLE (work_id text, audience_kind text, audience_staff uuid, partition_kind text, partition_key text, input_hash text,
               expected_chunk_count integer, staged_chunks integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b        reporting_private.batches;
  v_ids    bigint[];
  v_picked integer;
  v_first  bigint;
BEGIN
  b := reporting_private.lock_batch(p_batch, p_fence, true);
  IF b.state <> 'frozen' OR b.sealed_at IS NULL THEN RAISE EXCEPTION 'reporting batch % is not a sealed frozen batch', p_batch; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'claim_reporting_work: limit must be 1..1000'; END IF;
  WITH picked AS (
    SELECT w.work_id
      FROM reporting_private.partition_work w
     WHERE w.batch_id = p_batch AND w.state = 'pending'
     ORDER BY w.work_id
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  ), sized AS (
    SELECT w.work_id,
           2 + sum(4 + pg_catalog.octet_length(pg_catalog.json_build_object(
                 'work_id', w.work_id::text, 'audience_kind', w.audience_kind, 'audience_staff', w.audience_staff,
                 'partition_kind', w.partition_kind, 'partition_key', w.partition_key, 'input_hash', w.input_hash,
                 'expected_chunk_count', w.expected_chunk_count,
                 'staged_chunks', (SELECT count(*)::integer FROM reporting_private.partition_results r WHERE r.work_id = w.work_id))::text))
               OVER (ORDER BY w.work_id ROWS UNBOUNDED PRECEDING) AS run
      FROM reporting_private.partition_work w JOIN picked p ON p.work_id = w.work_id
  )
  SELECT coalesce(array_agg(z.work_id ORDER BY z.work_id) FILTER (WHERE z.run <= 1048576), '{}'::bigint[]), count(*)::integer, min(z.work_id)
    INTO v_ids, v_picked, v_first
    FROM sized z;
  IF v_picked > 0 AND pg_catalog.cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'claim_reporting_work: work % does not fit one 1 MiB claim response', v_first;
  END IF;
  UPDATE reporting_private.partition_work w SET state = 'leased', lease_fence = p_fence WHERE w.work_id = ANY (v_ids);
  RETURN QUERY
  SELECT w.work_id::text, w.audience_kind, w.audience_staff, w.partition_kind, w.partition_key, w.input_hash, w.expected_chunk_count,
         (SELECT count(*)::integer FROM reporting_private.partition_results r WHERE r.work_id = w.work_id)
    FROM reporting_private.partition_work w
   WHERE w.work_id = ANY (v_ids)
   ORDER BY w.work_id;
END
$fn$;

-- Validate one staged chunk against its work and the frozen view, store it,
-- and complete the work when every chunk is present with the declared digest.
-- Internal: callers have already locked the batch at p_fence.
CREATE FUNCTION reporting_private.stage_one(p_batch uuid, p_fence bigint, p_partition text, p_chunk jsonb)
RETURNS TABLE (work_id text, chunk_no integer, stored boolean, done boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  w       reporting_private.partition_work;
  v_id    bigint;
  v_no    integer;
  v_count integer;
  v_hash  text;
  v_dig   text;
  v_text  text;
  v_rows  jsonb;
  v_prev  text;
  v_bad   text;
  v_have  integer;
  v_all   text;
BEGIN
  IF p_partition IS NULL OR p_partition !~ '^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'stage: partition must be a positive decimal work id'; END IF;
  v_id := p_partition::bigint;
  SELECT * INTO w FROM reporting_private.partition_work x WHERE x.work_id = v_id FOR UPDATE;
  IF NOT FOUND OR w.batch_id <> p_batch THEN RAISE EXCEPTION 'stage: work % does not belong to batch %', p_partition, p_batch; END IF;

  -- Envelope: exact keys and types, at most 1 MiB.
  IF p_chunk IS NULL OR pg_catalog.jsonb_typeof(p_chunk) <> 'object' THEN RAISE EXCEPTION 'stage: chunk must be an object'; END IF;
  IF pg_catalog.octet_length(p_chunk::text) > 1048576 THEN RAISE EXCEPTION 'stage: chunk envelope over 1 MiB'; END IF;
  IF (SELECT string_agg(k, ',' ORDER BY k COLLATE "C") FROM pg_catalog.jsonb_object_keys(p_chunk) AS k) IS DISTINCT FROM 'canonicalRows,chunkCount,chunkHash,chunkNo,resultDigest' THEN
    RAISE EXCEPTION 'stage: chunk envelope has unexpected keys';
  END IF;
  IF pg_catalog.jsonb_typeof(p_chunk -> 'chunkNo') <> 'number' OR (p_chunk ->> 'chunkNo') !~ '^(0|[1-9][0-9]{0,8})$'
     OR pg_catalog.jsonb_typeof(p_chunk -> 'chunkCount') <> 'number' OR (p_chunk ->> 'chunkCount') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'stage: chunkNo/chunkCount must be non-negative/positive integers';
  END IF;
  v_no := (p_chunk ->> 'chunkNo')::integer;
  v_count := (p_chunk ->> 'chunkCount')::integer;
  IF v_no >= v_count THEN RAISE EXCEPTION 'stage: chunkNo % is outside chunkCount %', v_no, v_count; END IF;
  IF pg_catalog.jsonb_typeof(p_chunk -> 'chunkHash') <> 'string' OR (p_chunk ->> 'chunkHash') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(p_chunk -> 'resultDigest') <> 'string' OR (p_chunk ->> 'resultDigest') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(p_chunk -> 'canonicalRows') <> 'string' THEN
    RAISE EXCEPTION 'stage: chunkHash/resultDigest must be SHA-256 hex and canonicalRows a string';
  END IF;
  v_hash := p_chunk ->> 'chunkHash';
  v_dig := p_chunk ->> 'resultDigest';
  v_text := p_chunk ->> 'canonicalRows';
  -- The hash covers the EXACT UTF-8 bytes JavaScript's canonicalJson produced (not jsonb::text).
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_text, 'UTF8')), 'hex') <> v_hash THEN
    RAISE EXCEPTION 'stage: chunkHash does not match canonicalRows';
  END IF;

  -- Work-level consistency (count and digest are fixed by the first chunk).
  IF w.expected_chunk_count IS NOT NULL AND (w.expected_chunk_count <> v_count OR w.expected_result_digest <> v_dig) THEN
    RAISE EXCEPTION 'stage: work % chunkCount/resultDigest differ from its saved ones', p_partition;
  END IF;
  -- Identical replay is a no-op (also after completion); different content fails.
  SELECT r.chunk_hash INTO v_prev FROM reporting_private.partition_results r WHERE r.work_id = v_id AND r.chunk_no = v_no;
  IF FOUND THEN
    IF v_prev = v_hash THEN
      RETURN QUERY SELECT p_partition, v_no, false, w.state = 'done';
      RETURN;
    END IF;
    RAISE EXCEPTION 'stage: chunk % of work % was already saved with different content', v_no, p_partition;
  END IF;
  IF w.state = 'done' THEN RAISE EXCEPTION 'stage: work % is complete; chunk % is not part of it', p_partition, v_no; END IF;
  IF w.state <> 'leased' OR w.lease_fence IS DISTINCT FROM p_fence THEN
    RAISE EXCEPTION 'stage: work % is not claimed under fence %', p_partition, p_fence;
  END IF;

  -- Rows: exactly the five arrays, at most 1,000 rows in all.
  BEGIN
    v_rows := v_text::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'stage: canonicalRows is not JSON';
  END;
  IF pg_catalog.jsonb_typeof(v_rows) <> 'object'
     OR (SELECT string_agg(k, ',' ORDER BY k COLLATE "C") FROM pg_catalog.jsonb_object_keys(v_rows) AS k) IS DISTINCT FROM 'cancel_edges,event_facts,order_occurrences,source_issue_facts,timing_facts'
     OR pg_catalog.jsonb_typeof(v_rows -> 'event_facts') <> 'array' OR pg_catalog.jsonb_typeof(v_rows -> 'cancel_edges') <> 'array'
     OR pg_catalog.jsonb_typeof(v_rows -> 'order_occurrences') <> 'array' OR pg_catalog.jsonb_typeof(v_rows -> 'timing_facts') <> 'array'
     OR pg_catalog.jsonb_typeof(v_rows -> 'source_issue_facts') <> 'array' THEN
    RAISE EXCEPTION 'stage: canonicalRows must hold exactly the arrays event_facts, cancel_edges, order_occurrences, timing_facts, source_issue_facts';
  END IF;
  IF pg_catalog.jsonb_array_length(v_rows -> 'event_facts') + pg_catalog.jsonb_array_length(v_rows -> 'cancel_edges')
     + pg_catalog.jsonb_array_length(v_rows -> 'order_occurrences') + pg_catalog.jsonb_array_length(v_rows -> 'timing_facts')
     + pg_catalog.jsonb_array_length(v_rows -> 'source_issue_facts') > 1000 THEN
    RAISE EXCEPTION 'stage: more than 1000 rows in one chunk';
  END IF;

  v_bad := reporting_private.check_staged_rows(p_batch, w, v_rows);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'stage: work %: %', p_partition, v_bad; END IF;

  INSERT INTO reporting_private.partition_results (work_id, chunk_no, chunk, chunk_hash) VALUES (v_id, v_no, v_rows, v_hash);
  IF w.expected_chunk_count IS NULL THEN
    UPDATE reporting_private.partition_work x SET expected_chunk_count = v_count, expected_result_digest = v_dig WHERE x.work_id = v_id;
  END IF;

  SELECT count(*)::integer, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(string_agg(r.chunk_hash, E'\n' ORDER BY r.chunk_no), 'UTF8')), 'hex')
    INTO v_have, v_all
    FROM reporting_private.partition_results r WHERE r.work_id = v_id;
  IF v_have = v_count THEN
    IF v_all <> v_dig THEN RAISE EXCEPTION 'stage: work % resultDigest does not match its chunks', p_partition; END IF;
    UPDATE reporting_private.partition_work x
       SET state = 'done', chunk_count = v_count, result_digest = v_dig, completed_at = now()
     WHERE x.work_id = v_id;
    RETURN QUERY SELECT p_partition, v_no, true, true;
    RETURN;
  END IF;
  RETURN QUERY SELECT p_partition, v_no, true, false;
END
$fn$;

-- Structural validation of one staged row (T13B2a-1): every required field,
-- JSON type, enum, range and relational rule of its table, checked BEFORE a
-- chunk is saved (a composite parse does not enforce NOT NULL/CHECK). A date
-- must be a real proleptic-Gregorian day in years 0001-9999 (month, day, leap
-- year), checked arithmetically and then by make_date, so none fails at publish.
-- Generated from the same column spec as resultRowProblem in
-- api/_lib/reporting-stage.ts; messages are identical. Returns NULL or the first problem.
CREATE FUNCTION reporting_private.staged_row_problem(p_table text, v jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT CASE p_table
    WHEN 'event_facts' THEN CASE
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'event_id'), 'missing') <> 'string' OR (v ->> 'event_id') = '') THEN 'event_facts.event_id must be a non-empty string'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'event_type'), 'missing') <> 'string' OR (v ->> 'event_type') NOT IN ('line_verified', 'completed', 'dispatched', 'cancelled')) THEN 'event_facts.event_type must be one of line_verified, completed, dispatched, cancelled'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'created_at'), 'missing') <> 'string' OR (v ->> 'created_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$') THEN 'event_facts.created_at must be an ISO-8601 timestamp'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'staff_id'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'staff_id'), 'missing') <> 'string' OR (v ->> 'staff_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN 'event_facts.staff_id must be a lowercase uuid or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'department'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'department'), 'missing') <> 'string') THEN 'event_facts.department must be a string or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'raw_order'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'raw_order'), 'missing') <> 'string') THEN 'event_facts.raw_order must be a string or null'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'order_key'), 'missing') <> 'string') THEN 'event_facts.order_key must be a string'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'case_id'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'case_id'), 'missing') <> 'string') THEN 'event_facts.case_id must be a string or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'parent_event_id'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'parent_event_id'), 'missing') <> 'string') THEN 'event_facts.parent_event_id must be a string or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'sku'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'sku'), 'missing') <> 'string') THEN 'event_facts.sku must be a string or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'quantity'), 'missing') <> 'null' AND (CASE WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'quantity'), 'missing') <> 'number' OR (v ->> 'quantity') !~ '^-?[0-9]{1,10}$' THEN true ELSE (v ->> 'quantity')::bigint NOT BETWEEN -2147483648 AND 2147483647 END) THEN 'event_facts.quantity must be a 32-bit integer or null'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'role'), 'missing') <> 'string' OR (v ->> 'role') NOT IN ('verification', 'terminal', 'cancellation', 'invalid')) THEN 'event_facts.role must be one of verification, terminal, cancellation, invalid'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'work_type'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'work_type'), 'missing') <> 'string' OR (v ->> 'work_type') NOT IN ('a0_framed', 'framed', 'unframed', 'dispatch')) THEN 'event_facts.work_type must be one of a0_framed, framed, unframed, dispatch or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'invalid_detail'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'invalid_detail'), 'missing') <> 'string') THEN 'event_facts.invalid_detail must be a string or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'line_key'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'line_key'), 'missing') <> 'string') THEN 'event_facts.line_key must be a string or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'item_status'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'item_status'), 'missing') <> 'string' OR (v ->> 'item_status') NOT IN ('counted', 'excluded', 'unclassified')) THEN 'event_facts.item_status must be one of counted, excluded, unclassified or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'items'), 'missing') <> 'null' AND (CASE WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'items'), 'missing') <> 'number' OR (v ->> 'items') !~ '^[0-9]{1,16}$' THEN true ELSE (v ->> 'items')::bigint > 9007199254740991 END) THEN 'event_facts.items must be a non-negative safe integer or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'product_kind'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'product_kind'), 'missing') <> 'string' OR (v ->> 'product_kind') NOT IN ('eligible', 'excluded', 'unclassified')) THEN 'event_facts.product_kind must be one of eligible, excluded, unclassified or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'item_issue_kind'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'item_issue_kind'), 'missing') <> 'string' OR (v ->> 'item_issue_kind') NOT IN ('unclassified_sku', 'invalid_quantity')) THEN 'event_facts.item_issue_kind must be one of unclassified_sku, invalid_quantity or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'item_issue_detail'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'item_issue_detail'), 'missing') <> 'string') THEN 'event_facts.item_issue_detail must be a string or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'timing_stream'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'timing_stream'), 'missing') <> 'boolean') THEN 'event_facts.timing_stream must be a boolean or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'timing_weight'), 'missing') <> 'null' AND (CASE WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'timing_weight'), 'missing') <> 'number' THEN true ELSE (v -> 'timing_weight')::numeric < 0 END) THEN 'event_facts.timing_weight must be a non-negative number or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'production_date'), 'missing') <> 'null' AND (CASE WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'production_date'), 'missing') <> 'string' OR (v ->> 'production_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN true WHEN pg_catalog.substr((v ->> 'production_date'), 1, 4)::integer < 1 OR pg_catalog.substr((v ->> 'production_date'), 6, 2)::integer NOT BETWEEN 1 AND 12 OR pg_catalog.substr((v ->> 'production_date'), 9, 2)::integer < 1 OR pg_catalog.substr((v ->> 'production_date'), 9, 2)::integer > CASE WHEN pg_catalog.substr((v ->> 'production_date'), 6, 2)::integer = 2 THEN CASE WHEN (pg_catalog.substr((v ->> 'production_date'), 1, 4)::integer % 4 = 0 AND pg_catalog.substr((v ->> 'production_date'), 1, 4)::integer % 100 <> 0) OR pg_catalog.substr((v ->> 'production_date'), 1, 4)::integer % 400 = 0 THEN 29 ELSE 28 END WHEN pg_catalog.substr((v ->> 'production_date'), 6, 2)::integer IN (4, 6, 9, 11) THEN 30 ELSE 31 END THEN true ELSE pg_catalog.make_date(pg_catalog.substr((v ->> 'production_date'), 1, 4)::integer, pg_catalog.substr((v ->> 'production_date'), 6, 2)::integer, pg_catalog.substr((v ->> 'production_date'), 9, 2)::integer) IS NULL END) THEN 'event_facts.production_date must be a YYYY-MM-DD date or null'
      WHEN (v ->> 'role' = 'verification') <> (pg_catalog.jsonb_typeof(v -> 'item_status') <> 'null' AND pg_catalog.jsonb_typeof(v -> 'items') <> 'null' AND pg_catalog.jsonb_typeof(v -> 'product_kind') <> 'null' AND pg_catalog.jsonb_typeof(v -> 'line_key') <> 'null' AND pg_catalog.jsonb_typeof(v -> 'timing_stream') <> 'null' AND pg_catalog.jsonb_typeof(v -> 'timing_weight') <> 'null') THEN 'event_facts: role verification needs exactly item_status, items, product_kind, line_key, timing_stream and timing_weight'
      WHEN (v ->> 'role' = 'invalid') <> (pg_catalog.jsonb_typeof(v -> 'invalid_detail') <> 'null') THEN 'event_facts: invalid_detail is required exactly for role invalid'
    END
    WHEN 'cancel_edges' THEN CASE
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'cancel_event_id'), 'missing') <> 'string' OR (v ->> 'cancel_event_id') = '') THEN 'cancel_edges.cancel_event_id must be a non-empty string'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'parent_event_id'), 'missing') <> 'string' OR (v ->> 'parent_event_id') = '') THEN 'cancel_edges.parent_event_id must be a non-empty string'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'is_self'), 'missing') <> 'boolean') THEN 'cancel_edges.is_self must be a boolean'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'parent_role'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'parent_role'), 'missing') <> 'string' OR (v ->> 'parent_role') NOT IN ('verification', 'terminal', 'cancellation', 'invalid')) THEN 'cancel_edges.parent_role must be one of verification, terminal, cancellation, invalid or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'parent_created_at'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'parent_created_at'), 'missing') <> 'string' OR (v ->> 'parent_created_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$') THEN 'cancel_edges.parent_created_at must be an ISO-8601 timestamp or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'pair'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'pair'), 'missing') <> 'string' OR (v ->> 'pair') NOT IN ('valid', 'mismatch', 'case_differs')) THEN 'cancel_edges.pair must be one of valid, mismatch, case_differs or null'
      WHEN (pg_catalog.jsonb_typeof(v -> 'parent_role') = 'null') <> (pg_catalog.jsonb_typeof(v -> 'parent_created_at') = 'null') THEN 'cancel_edges: parent_role and parent_created_at are both set or both null'
      WHEN (pg_catalog.jsonb_typeof(v -> 'pair') <> 'null') <> coalesce(v ->> 'parent_role' IN ('verification', 'terminal'), false) THEN 'cancel_edges: pair is required exactly for a verification or terminal parent'
    END
    WHEN 'order_occurrences' THEN CASE
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'terminal_event_id'), 'missing') <> 'string' OR (v ->> 'terminal_event_id') = '') THEN 'order_occurrences.terminal_event_id must be a non-empty string'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'order_key'), 'missing') <> 'string' OR (v ->> 'order_key') = '') THEN 'order_occurrences.order_key must be a non-empty string'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'raw_order'), 'missing') <> 'string') THEN 'order_occurrences.raw_order must be a string'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'case_id'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'case_id'), 'missing') <> 'string') THEN 'order_occurrences.case_id must be a string or null'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'work_type'), 'missing') <> 'string' OR (v ->> 'work_type') NOT IN ('a0_framed', 'framed', 'unframed', 'dispatch')) THEN 'order_occurrences.work_type must be one of a0_framed, framed, unframed, dispatch'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'staff_id'), 'missing') <> 'string' OR (v ->> 'staff_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN 'order_occurrences.staff_id must be a lowercase uuid'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'occurred_at'), 'missing') <> 'string' OR (v ->> 'occurred_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$') THEN 'order_occurrences.occurred_at must be an ISO-8601 timestamp'
    END
    WHEN 'timing_facts' THEN CASE
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'event_id'), 'missing') <> 'string' OR (v ->> 'event_id') = '') THEN 'timing_facts.event_id must be a non-empty string'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'staff_id'), 'missing') <> 'string' OR (v ->> 'staff_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN 'timing_facts.staff_id must be a lowercase uuid'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'work_type'), 'missing') <> 'string' OR (v ->> 'work_type') NOT IN ('a0_framed', 'framed', 'unframed', 'dispatch')) THEN 'timing_facts.work_type must be one of a0_framed, framed, unframed, dispatch'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'occurred_at'), 'missing') <> 'string' OR (v ->> 'occurred_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$') THEN 'timing_facts.occurred_at must be an ISO-8601 timestamp'
      WHEN (CASE WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'weight'), 'missing') <> 'number' THEN true ELSE (v -> 'weight')::numeric < 0 END) THEN 'timing_facts.weight must be a non-negative number'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'prev_all_event_id'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'prev_all_event_id'), 'missing') <> 'string' OR (v ->> 'prev_all_event_id') = '') THEN 'timing_facts.prev_all_event_id must be a non-empty string or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'prev_same_type_event_id'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'prev_same_type_event_id'), 'missing') <> 'string' OR (v ->> 'prev_same_type_event_id') = '') THEN 'timing_facts.prev_same_type_event_id must be a non-empty string or null'
    END
    WHEN 'source_issue_facts' THEN CASE
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'event_id'), 'missing') <> 'string' OR (v ->> 'event_id') = '') THEN 'source_issue_facts.event_id must be a non-empty string'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'event_type'), 'missing') <> 'string' OR (v ->> 'event_type') = '') THEN 'source_issue_facts.event_type must be a non-empty string'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'created_at'), 'missing') <> 'string' OR (v ->> 'created_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$') THEN 'source_issue_facts.created_at must be an ISO-8601 timestamp'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'staff_id'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'staff_id'), 'missing') <> 'string' OR (v ->> 'staff_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN 'source_issue_facts.staff_id must be a lowercase uuid or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'raw_order'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'raw_order'), 'missing') <> 'string') THEN 'source_issue_facts.raw_order must be a string or null'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'parent_event_id'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'parent_event_id'), 'missing') <> 'string') THEN 'source_issue_facts.parent_event_id must be a string or null'
      WHEN (coalesce(pg_catalog.jsonb_typeof(v -> 'issue_kind'), 'missing') <> 'string' OR (v ->> 'issue_kind') NOT IN ('invalid_event', 'unclassified_sku', 'invalid_quantity', 'unresolved_parent', 'missing_completion_detail', 'ambiguous_repeat')) THEN 'source_issue_facts.issue_kind must be one of invalid_event, unclassified_sku, invalid_quantity, unresolved_parent, missing_completion_detail, ambiguous_repeat'
      WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'issue_detail'), 'missing') <> 'null' AND (coalesce(pg_catalog.jsonb_typeof(v -> 'issue_detail'), 'missing') <> 'string') THEN 'source_issue_facts.issue_detail must be a string or null'
    END
    ELSE 'unknown result table ' || coalesce(p_table, '') END
$fn$;

-- Row shape, trusted-metadata exclusion, structural validity (staged_row_problem)
-- and binding to the frozen view (T13B2a-2): every RAW source field a row
-- carries must equal its primary frozen source image; derived fields (role,
-- work type, items, pair, ...) stay TypeScript's. Ownership: the frozen
-- image's owner partition and, for a self audience, its own rows. A parent or
-- predecessor reference must agree with the frozen view as the audience sees it.
-- Returns NULL when every row is valid, else the first problem.
CREATE FUNCTION reporting_private.check_staged_rows(p_batch uuid, p_work reporting_private.partition_work, p_rows jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  b      record;
  r      record;
  img    jsonb;
  ref    jsonb;
  own    record;
  v_keys text;
  v_id   text;
  v_at   text;
  v_bad  text;
  v_ref  text;
  v_vis  boolean;
  v_pre  text;
BEGIN
  SELECT x.site, x.source_cutoff INTO b FROM reporting_private.batches x WHERE x.batch_id = p_batch;
  FOR r IN
    SELECT t.tbl, e.v, e.ord
      FROM (VALUES ('event_facts'), ('cancel_edges'), ('order_occurrences'), ('timing_facts'), ('source_issue_facts')) AS t(tbl)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(p_rows -> t.tbl) WITH ORDINALITY AS e(v, ord)
  LOOP
    v_pre := r.tbl || '[' || r.ord::text || ']';
    IF pg_catalog.jsonb_typeof(r.v) <> 'object' THEN RETURN v_pre || ' is not an object'; END IF;
    SELECT string_agg(k, ',' ORDER BY k COLLATE "C") INTO v_keys FROM pg_catalog.jsonb_object_keys(r.v) AS k;
    IF v_keys IS DISTINCT FROM (SELECT string_agg(c, ',' ORDER BY c COLLATE "C") FROM pg_catalog.unnest(pg_catalog.string_to_array(
         CASE r.tbl
           WHEN 'event_facts' THEN 'case_id,created_at,department,event_id,event_type,invalid_detail,item_issue_detail,item_issue_kind,item_status,items,line_key,order_key,parent_event_id,product_kind,production_date,quantity,raw_order,role,sku,staff_id,timing_stream,timing_weight,work_type'
           WHEN 'cancel_edges' THEN 'cancel_event_id,is_self,pair,parent_created_at,parent_event_id,parent_role'
           WHEN 'order_occurrences' THEN 'case_id,occurred_at,order_key,raw_order,staff_id,terminal_event_id,work_type'
           WHEN 'timing_facts' THEN 'event_id,occurred_at,prev_all_event_id,prev_same_type_event_id,staff_id,weight,work_type'
           ELSE 'created_at,event_id,event_type,issue_detail,issue_kind,parent_event_id,raw_order,staff_id' END, ',')) AS c) THEN
      RETURN v_pre || ' has unexpected keys (site, audience, partition, rule and validity are set by the server)';
    END IF;
    -- Required fields, JSON types, enums, ranges and relational rules (T13B2a-1).
    v_bad := reporting_private.staged_row_problem(r.tbl, r.v);
    IF v_bad IS NOT NULL THEN RETURN v_pre || ': ' || v_bad; END IF;

    v_id := CASE r.tbl WHEN 'cancel_edges' THEN r.v ->> 'cancel_event_id' WHEN 'order_occurrences' THEN r.v ->> 'terminal_event_id' ELSE r.v ->> 'event_id' END;
    img := reporting_private.frozen_image(p_batch, v_id);
    IF img IS NULL THEN RETURN v_pre || ' event ' || v_id || ' is not in the frozen view'; END IF;
    SELECT * INTO own FROM reporting_private.owner_partition(img);
    IF own.partition_kind <> p_work.partition_kind OR own.partition_key <> p_work.partition_key THEN
      RETURN v_pre || ' event ' || v_id || ' belongs to partition ' || own.partition_kind || '/' || own.partition_key || ', not ' || p_work.partition_kind || '/' || p_work.partition_key;
    END IF;
    IF p_work.audience_kind = 'self' AND (img ->> 'staff_id') IS DISTINCT FROM p_work.audience_staff::text THEN
      RETURN v_pre || ' event ' || v_id || ' is not the self audience''s own row';
    END IF;
    -- A whitespace-only id is a source issue, never an ordinary fact (and vice versa).
    IF (r.tbl = 'source_issue_facts') <> (coalesce(reporting_private.order_key(v_id), '') = '') THEN
      RETURN v_pre || ' event ' || v_id || CASE WHEN r.tbl = 'source_issue_facts' THEN ' has a valid identity; it is not a source issue' ELSE ' has a malformed identity; it belongs in source_issue_facts' END;
    END IF;
    IF (img ->> 'created_at')::timestamptz > b.source_cutoff THEN RETURN v_pre || ' is after the batch cutoff'; END IF;

    -- Raw fields bound to the primary frozen source (T13B2a-2).
    v_at := CASE WHEN r.tbl IN ('order_occurrences', 'timing_facts') THEN r.v ->> 'occurred_at' ELSE NULL END;
    IF r.tbl IN ('event_facts', 'source_issue_facts') THEN
      IF (r.v ->> 'event_type') IS DISTINCT FROM (img ->> 'event_type') THEN RETURN v_pre || ' event_type differs from the frozen source'; END IF;
      IF (r.v ->> 'created_at')::timestamptz IS DISTINCT FROM (img ->> 'created_at')::timestamptz THEN RETURN v_pre || ' created_at differs from the frozen source'; END IF;
      IF (r.v ->> 'staff_id') IS DISTINCT FROM (img ->> 'staff_id') THEN RETURN v_pre || ' staff_id differs from the frozen source'; END IF;
      IF (r.v ->> 'raw_order') IS DISTINCT FROM (img ->> 'order_number') THEN RETURN v_pre || ' raw_order differs from the frozen source'; END IF;
      IF (r.v ->> 'parent_event_id') IS DISTINCT FROM (img ->> 'parent_event_id') THEN RETURN v_pre || ' parent_event_id differs from the frozen source'; END IF;
    END IF;
    IF r.tbl = 'event_facts' THEN
      IF (r.v ->> 'department') IS DISTINCT FROM (img ->> 'department') THEN RETURN v_pre || ' department differs from the frozen source'; END IF;
      IF (r.v ->> 'case_id') IS DISTINCT FROM (img ->> 'cs_case_id') THEN RETURN v_pre || ' case_id differs from the frozen source'; END IF;
      IF (r.v ->> 'sku') IS DISTINCT FROM (img ->> 'line_sku') THEN RETURN v_pre || ' sku differs from the frozen source'; END IF;
      IF (r.v -> 'quantity') IS DISTINCT FROM coalesce(img -> 'line_quantity', 'null'::jsonb) THEN RETURN v_pre || ' quantity differs from the frozen source'; END IF;
      IF (r.v ->> 'order_key') IS DISTINCT FROM coalesce(reporting_private.order_key(r.v ->> 'raw_order'), '') THEN RETURN v_pre || ' order_key is not the trimmed raw order'; END IF;
    ELSIF r.tbl = 'cancel_edges' THEN
      IF (img ->> 'event_type') IS DISTINCT FROM 'cancelled' THEN RETURN v_pre || ' event ' || v_id || ' is not a cancellation in the frozen source'; END IF;
      IF (r.v ->> 'parent_event_id') IS DISTINCT FROM (img ->> 'parent_event_id') THEN RETURN v_pre || ' parent differs from the frozen cancellation'; END IF;
      IF (r.v -> 'is_self') IS DISTINCT FROM pg_catalog.to_jsonb((img ->> 'parent_event_id') = v_id) THEN RETURN v_pre || ' is_self differs from the frozen cancellation'; END IF;
      -- Parent existence as the reducer sees it: a nonblank, due, count-type event visible to the audience.
      -- (An ignored `started` row or a malformed identity is NOT a parent, whatever the selection selected.)
      v_ref := r.v ->> 'parent_event_id';
      ref := CASE WHEN coalesce(reporting_private.order_key(v_ref), '') = '' THEN NULL ELSE reporting_private.frozen_image(p_batch, v_ref) END;
      v_vis := ref IS NOT NULL AND (ref ->> 'event_type') IN ('line_verified', 'completed', 'dispatched', 'cancelled')
               AND (ref ->> 'created_at')::timestamptz <= b.source_cutoff
               AND (p_work.audience_kind = 'site' OR (ref ->> 'staff_id') IS NOT DISTINCT FROM p_work.audience_staff::text);
      IF (pg_catalog.jsonb_typeof(r.v -> 'parent_role') <> 'null') <> v_vis THEN RETURN v_pre || ' parent existence differs from the frozen view'; END IF;
      IF v_vis AND (r.v ->> 'parent_created_at')::timestamptz IS DISTINCT FROM (ref ->> 'created_at')::timestamptz THEN RETURN v_pre || ' parent_created_at differs from the frozen parent'; END IF;
    ELSIF r.tbl = 'order_occurrences' THEN
      IF (img ->> 'event_type') NOT IN ('completed', 'dispatched') THEN RETURN v_pre || ' event ' || v_id || ' is not a terminal in the frozen source'; END IF;
      IF (r.v ->> 'raw_order') IS DISTINCT FROM (img ->> 'order_number') THEN RETURN v_pre || ' raw_order differs from the frozen source'; END IF;
      IF (r.v ->> 'order_key') IS DISTINCT FROM reporting_private.order_key(r.v ->> 'raw_order') THEN RETURN v_pre || ' order_key is not the trimmed raw order'; END IF;
      IF (r.v ->> 'case_id') IS DISTINCT FROM (img ->> 'cs_case_id') THEN RETURN v_pre || ' case_id differs from the frozen source'; END IF;
      IF (r.v ->> 'staff_id') IS DISTINCT FROM (img ->> 'staff_id') THEN RETURN v_pre || ' staff_id differs from the frozen source'; END IF;
      IF v_at::timestamptz IS DISTINCT FROM (img ->> 'created_at')::timestamptz THEN RETURN v_pre || ' occurred_at differs from the frozen source'; END IF;
    ELSIF r.tbl = 'timing_facts' THEN
      IF (img ->> 'event_type') IS DISTINCT FROM 'line_verified' THEN RETURN v_pre || ' event ' || v_id || ' is not a verification in the frozen source'; END IF;
      IF (r.v ->> 'staff_id') IS DISTINCT FROM (img ->> 'staff_id') THEN RETURN v_pre || ' staff_id differs from the frozen source'; END IF;
      IF v_at::timestamptz IS DISTINCT FROM (img ->> 'created_at')::timestamptz THEN RETURN v_pre || ' occurred_at differs from the frozen source'; END IF;
      -- Predecessors: earlier (or same-instant) due verifications of the same worker, visible to the audience.
      FOREACH v_ref IN ARRAY ARRAY[r.v ->> 'prev_all_event_id', r.v ->> 'prev_same_type_event_id'] LOOP
        CONTINUE WHEN v_ref IS NULL;
        ref := CASE WHEN coalesce(reporting_private.order_key(v_ref), '') = '' THEN NULL ELSE reporting_private.frozen_image(p_batch, v_ref) END;
        IF ref IS NULL OR (ref ->> 'event_type') IS DISTINCT FROM 'line_verified' OR (ref ->> 'staff_id') IS DISTINCT FROM (img ->> 'staff_id')
           OR (ref ->> 'created_at')::timestamptz > (img ->> 'created_at')::timestamptz OR v_ref = v_id THEN
          RETURN v_pre || ' predecessor ' || v_ref || ' is not an earlier verification by the same worker in the frozen view';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN NULL;
END
$fn$;

-- Single-work staging (retries/tests) and bounded bulk staging: at most 100
-- {partition, chunk} entries and 1 MiB per request; all succeed or none do.
CREATE FUNCTION public.stage_reporting_result(p_batch uuid, p_fence bigint, p_partition text, p_chunk jsonb)
RETURNS TABLE (work_id text, chunk_no integer, stored boolean, done boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b reporting_private.batches;
BEGIN
  b := reporting_private.lock_batch(p_batch, p_fence, true);
  IF b.state <> 'frozen' OR b.sealed_at IS NULL THEN RAISE EXCEPTION 'reporting batch % is not a sealed frozen batch', p_batch; END IF;
  RETURN QUERY SELECT * FROM reporting_private.stage_one(p_batch, p_fence, p_partition, p_chunk);
END
$fn$;

CREATE FUNCTION public.stage_reporting_results(p_batch uuid, p_fence bigint, p_results jsonb)
RETURNS TABLE (work_id text, chunk_no integer, stored boolean, done boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b reporting_private.batches;
  e record;
BEGIN
  b := reporting_private.lock_batch(p_batch, p_fence, true);
  IF b.state <> 'frozen' OR b.sealed_at IS NULL THEN RAISE EXCEPTION 'reporting batch % is not a sealed frozen batch', p_batch; END IF;
  IF p_results IS NULL OR pg_catalog.jsonb_typeof(p_results) <> 'array' THEN RAISE EXCEPTION 'stage_reporting_results: results must be an array'; END IF;
  IF pg_catalog.jsonb_array_length(p_results) > 100 THEN RAISE EXCEPTION 'stage_reporting_results: at most 100 entries per request'; END IF;
  IF pg_catalog.octet_length(p_results::text) > 1048576 THEN RAISE EXCEPTION 'stage_reporting_results: request over 1 MiB'; END IF;
  FOR e IN SELECT x.v, x.ord FROM pg_catalog.jsonb_array_elements(p_results) WITH ORDINALITY AS x(v, ord) ORDER BY x.ord LOOP
    IF pg_catalog.jsonb_typeof(e.v) <> 'object'
       OR (SELECT string_agg(k, ',' ORDER BY k COLLATE "C") FROM pg_catalog.jsonb_object_keys(e.v) AS k) IS DISTINCT FROM 'chunk,partition'
       OR pg_catalog.jsonb_typeof(e.v -> 'partition') <> 'string' THEN
      RAISE EXCEPTION 'stage_reporting_results: entry % must be exactly {partition, chunk}', e.ord;
    END IF;
    -- Any failure raises and rolls back every entry of this request.
    RETURN QUERY SELECT * FROM reporting_private.stage_one(p_batch, p_fence, e.v ->> 'partition', e.v -> 'chunk');
  END LOOP;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 3d. Task 13 Part B2b: atomic publication
-- ---------------------------------------------------------------------------

-- Trusted owner columns on 0037's fact tables (expand-only: nullable, both or
-- neither). Publication always sets them from the work descriptor; a payload
-- can never set them (exact staged keys). A fact belongs to exactly one
-- (partition kind, key) per audience; replacement closes by owner.
ALTER TABLE reporting_private.event_facts
  ADD COLUMN partition_kind text CHECK (partition_kind IS NULL OR partition_kind IN ('order', 'event')),
  ADD COLUMN partition_key text,
  ADD CONSTRAINT event_facts_owner_pair CHECK ((partition_kind IS NULL) = (partition_key IS NULL));
ALTER TABLE reporting_private.cancel_edges
  ADD COLUMN partition_kind text CHECK (partition_kind IS NULL OR partition_kind IN ('order', 'event')),
  ADD COLUMN partition_key text,
  ADD CONSTRAINT cancel_edges_owner_pair CHECK ((partition_kind IS NULL) = (partition_key IS NULL));
ALTER TABLE reporting_private.order_occurrences
  ADD COLUMN partition_kind text CHECK (partition_kind IS NULL OR partition_kind IN ('order', 'event')),
  ADD COLUMN partition_key text,
  ADD CONSTRAINT order_occurrences_owner_pair CHECK ((partition_kind IS NULL) = (partition_key IS NULL));
ALTER TABLE reporting_private.timing_facts
  ADD COLUMN partition_kind text CHECK (partition_kind IS NULL OR partition_kind IN ('order', 'event')),
  ADD COLUMN partition_key text,
  ADD CONSTRAINT timing_facts_owner_pair CHECK ((partition_kind IS NULL) = (partition_key IS NULL));
CREATE INDEX event_facts_owner ON reporting_private.event_facts (site, audience_kind, audience_staff, partition_kind, partition_key) WHERE valid_to_seq IS NULL;
CREATE INDEX cancel_edges_owner ON reporting_private.cancel_edges (site, audience_kind, audience_staff, partition_kind, partition_key) WHERE valid_to_seq IS NULL;
CREATE INDEX order_occurrences_owner ON reporting_private.order_occurrences (site, audience_kind, audience_staff, partition_kind, partition_key) WHERE valid_to_seq IS NULL;
CREATE INDEX timing_facts_owner ON reporting_private.timing_facts (site, audience_kind, audience_staff, partition_kind, partition_key) WHERE valid_to_seq IS NULL;
CREATE INDEX source_issue_facts_owner ON reporting_private.source_issue_facts (site, audience_kind, audience_staff, partition_kind, partition_key) WHERE valid_to_seq IS NULL;
-- What one publication retired / installed (daily-group recompute and integrity checks).
CREATE INDEX event_facts_retired ON reporting_private.event_facts (site, valid_to_seq) WHERE valid_to_seq IS NOT NULL;
CREATE INDEX event_facts_installed ON reporting_private.event_facts (site, valid_from_seq);
CREATE INDEX cancel_edges_retired ON reporting_private.cancel_edges (site, valid_to_seq) WHERE valid_to_seq IS NOT NULL;
CREATE INDEX cancel_edges_installed ON reporting_private.cancel_edges (site, valid_from_seq);
CREATE INDEX cancel_edges_current_cancel ON reporting_private.cancel_edges (site, audience_kind, audience_staff, cancel_event_id) WHERE valid_to_seq IS NULL;
CREATE INDEX order_occurrences_installed ON reporting_private.order_occurrences (site, valid_from_seq);
CREATE INDEX order_occurrences_current_terminal ON reporting_private.order_occurrences (site, audience_kind, audience_staff, terminal_event_id) WHERE valid_to_seq IS NULL;
CREATE INDEX timing_facts_installed ON reporting_private.timing_facts (site, valid_from_seq);
CREATE INDEX timing_facts_current_event ON reporting_private.timing_facts (site, audience_kind, audience_staff, event_id) WHERE valid_to_seq IS NULL;
CREATE INDEX source_issue_facts_installed ON reporting_private.source_issue_facts (site, valid_from_seq);
CREATE INDEX source_issue_facts_current_event ON reporting_private.source_issue_facts (site, audience_kind, audience_staff, event_id) WHERE valid_to_seq IS NULL;
CREATE INDEX daily_totals_current ON reporting_private.daily_totals (site, audience_kind, audience_staff, production_date, staff_id, work_type, rework) WHERE valid_to_seq IS NULL;

-- The generation a published batch produced (lost-response replay returns it).
ALTER TABLE reporting_private.batches
  ADD COLUMN published_generation_id uuid REFERENCES reporting_private.generations (generation_id),
  ADD CONSTRAINT batches_published_generation CHECK ((state = 'published') = (published_generation_id IS NOT NULL));

-- Retained raw source images by generation interval (seven-day raw-export
-- snapshots, including note, station, non-count and future rows). Old
-- exports read these, never the mutable source_current.
CREATE TABLE reporting_private.source_versions (
  site            text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  event_id        text        NOT NULL,
  valid_from_seq  bigint      NOT NULL CHECK (valid_from_seq >= 1),
  valid_to_seq    bigint,
  image           jsonb       NOT NULL,
  CHECK (valid_to_seq IS NULL OR valid_to_seq > valid_from_seq),
  CHECK (image ->> 'location' = site AND image ->> 'id' = event_id),
  PRIMARY KEY (site, event_id, valid_from_seq)
);
CREATE UNIQUE INDEX source_versions_current ON reporting_private.source_versions (site, event_id) WHERE valid_to_seq IS NULL;
CREATE INDEX source_versions_validity ON reporting_private.source_versions (site, valid_from_seq, valid_to_seq);
ALTER TABLE reporting_private.source_versions ENABLE ROW LEVEL SECURITY;

-- Deterministic SHA-256 reconciliation fingerprint of a sealed batch's
-- publication (byte-for-byte equal to publicationFingerprint in
-- api/_lib/reporting-publish.ts): the UTF-8 lines
--   item-counting-publication-v1, site, kind, rule version, capture epoch,
--   source cutoff in integer microseconds since the Unix epoch, sealed
--   manifest hash, then every work's result digest in manifest order,
-- joined by \n (no trailing newline). No time zone or DateStyle dependence.
CREATE FUNCTION reporting_private.publication_fingerprint(p_batch uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           'item-counting-publication-v1' || E'\n' || b.site || E'\n' || b.kind || E'\n' || b.rule_version || E'\n' || b.capture_epoch::text || E'\n'
           || (pg_catalog.extract(epoch FROM b.source_cutoff) * 1000000)::bigint::text || E'\n' || b.sealed_manifest_hash
           || coalesce((SELECT string_agg(E'\n' || w.result_digest, '' ORDER BY w.audience_kind COLLATE "C", w.audience_staff::text COLLATE "C" NULLS FIRST, w.partition_kind COLLATE "C", w.partition_key COLLATE "C")
                          FROM reporting_private.partition_work w WHERE w.batch_id = b.batch_id), ''),
           'UTF8')), 'hex')
    FROM reporting_private.batches b
   WHERE b.batch_id = p_batch
$fn$;

-- Atomic publication of one sealed, fully staged batch (plan Part B items 3,
-- 4, 6, 8). ONE transaction: a failure or timeout leaves nothing behind.
--   * Lost-response replay: an already published batch returns ITS
--     generation (replay = true) when the batch and fence match; nothing is
--     written and no credit is reapplied. Another fence fails.
--   * Otherwise the batch must be the site's valid sealed frozen batch under
--     the live lease (lock_batch: control share lock, site row, batch row;
--     epoch/rule/base/fence), its manifest unchanged since seal, and every
--     work done with all chunks and its recomputed digest.
--   * One new generation (sequence S). Refresh: every current fact of every
--     planned (audience, owner partition) is closed at S, in all five
--     families, so an empty replacement removes old rows; rebuild: every
--     current fact of the site, every audience. Staged rows are installed at
--     S with trusted site/audience/owner/rule columns. Two current rows for
--     one event (an unplanned old owner) or a dated verification without
--     production_date fail the publication.
--   * Daily totals: every group touched by a retired or installed
--     verification, or by a changed cancellation edge's parent (rebuild: every
--     current group of the site), is closed and recomputed from the current
--     classified facts: effective Items = items of verifications with status
--     counted, not cancelled by a current valid edge (pair valid, verification
--     parent, not self, parent not later than the cancellation); line_count =
--     effective verified lines; Items above 2^53-1 are stored as overflow.
--     A group with no effective line is removed. Dates and classifications
--     come from TypeScript; SQL only sums them.
--   * Mirror and retained versions: refresh applies the frozen batch images
--     (tombstones delete); rebuild replaces the site with the frozen
--     candidate. A changed or deleted image closes its version at S.
--   * The previous published generation is superseded (seven-day expiry),
--     the new one published with its fingerprint, the batch marked published
--     (per-site receipts), the global acknowledgement pass run, and the site
--     metadata moved to the new generation and verified cutoff. read_mode is
--     never changed here.
CREATE FUNCTION public.publish_reporting_batch(p_batch uuid, p_fence bigint)
RETURNS TABLE (batch_id uuid, generation_id uuid, generation_seq text, site text, kind text, source_cutoff timestamptz,
               work_count integer, receipts bigint, acknowledged bigint, replay boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_site  text;
  v_prior reporting_private.batches;
  b       reporting_private.batches;
  m       record;
  v_bad   text;
  v_gen   uuid;
  v_seq   bigint;
  v_now   timestamptz := now();
  v_ack   bigint;
  v_rcpt  bigint;
  v_daily bigint;
BEGIN
  -- Lock order as every batch mutation: control share lock, site row, batch row.
  PERFORM 1 FROM reporting_private.control c WHERE c.singleton FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reporting control row is missing'; END IF;
  SELECT x.site INTO v_site FROM reporting_private.batches x WHERE x.batch_id = p_batch;
  IF NOT FOUND THEN RAISE EXCEPTION 'reporting batch % not found', p_batch; END IF;
  PERFORM 1 FROM reporting_private.site_state s WHERE s.site = v_site FOR UPDATE;
  SELECT * INTO v_prior FROM reporting_private.batches x WHERE x.batch_id = p_batch FOR UPDATE;

  -- Lost-response replay (also after a concurrent identical call committed first).
  IF v_prior.state = 'published' THEN
    IF p_fence IS NULL OR v_prior.lease_fence <> p_fence THEN
      RAISE EXCEPTION 'reporting batch % was published under another fence', p_batch;
    END IF;
    RETURN QUERY
      SELECT v_prior.batch_id, v_prior.published_generation_id, g.generation_seq::text, v_prior.site, v_prior.kind, v_prior.source_cutoff,
             v_prior.sealed_work_count, (SELECT count(*) FROM reporting_private.batch_changes bc WHERE bc.batch_id = p_batch), 0::bigint, true
        FROM reporting_private.generations g WHERE g.generation_id = v_prior.published_generation_id;
    RETURN;
  END IF;

  b := reporting_private.lock_batch(p_batch, p_fence, true);
  IF b.state <> 'frozen' OR b.sealed_at IS NULL THEN RAISE EXCEPTION 'reporting batch % is not a sealed frozen batch', p_batch; END IF;
  SELECT * INTO m FROM reporting_private.work_manifest(p_batch);
  IF m.work_count <> b.sealed_work_count OR m.manifest_hash <> b.sealed_manifest_hash THEN
    RAISE EXCEPTION 'publish: batch % work changed since it was sealed', p_batch;
  END IF;
  SELECT 'work ' || w.work_id::text || CASE WHEN w.state <> 'done' THEN ' is ' || w.state ELSE ' chunks/digest do not match its completion' END
    INTO v_bad
    FROM reporting_private.partition_work w
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS n, max(r.chunk_no) AS top,
             pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(string_agg(r.chunk_hash, E'\n' ORDER BY r.chunk_no), ''), 'UTF8')), 'hex') AS digest
        FROM reporting_private.partition_results r WHERE r.work_id = w.work_id) z ON true
   WHERE w.batch_id = p_batch
     AND (w.state <> 'done' OR z.n <> w.chunk_count OR z.top <> w.chunk_count - 1 OR z.digest <> w.result_digest)
   ORDER BY w.work_id
   LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'publish: batch % is incomplete: %', p_batch, v_bad; END IF;

  INSERT INTO reporting_private.generations (site, base_generation_id, rule_version, capture_epoch, source_cutoff, state)
  VALUES (b.site, b.base_generation_id, b.rule_version, b.capture_epoch, b.source_cutoff, 'building')
  RETURNING generations.generation_id, generations.generation_seq INTO v_gen, v_seq;

  -- Close: refresh by planned owner (empty replacements included); rebuild everything of the site.
  UPDATE reporting_private.event_facts f SET valid_to_seq = v_seq
   WHERE f.site = b.site AND f.valid_to_seq IS NULL
     AND (b.kind = 'rebuild' OR EXISTS (SELECT 1 FROM reporting_private.partition_work w WHERE w.batch_id = p_batch AND w.audience_kind = f.audience_kind
            AND w.audience_staff IS NOT DISTINCT FROM f.audience_staff AND w.partition_kind = f.partition_kind AND w.partition_key = f.partition_key));
  UPDATE reporting_private.cancel_edges f SET valid_to_seq = v_seq
   WHERE f.site = b.site AND f.valid_to_seq IS NULL
     AND (b.kind = 'rebuild' OR EXISTS (SELECT 1 FROM reporting_private.partition_work w WHERE w.batch_id = p_batch AND w.audience_kind = f.audience_kind
            AND w.audience_staff IS NOT DISTINCT FROM f.audience_staff AND w.partition_kind = f.partition_kind AND w.partition_key = f.partition_key));
  UPDATE reporting_private.order_occurrences f SET valid_to_seq = v_seq
   WHERE f.site = b.site AND f.valid_to_seq IS NULL
     AND (b.kind = 'rebuild' OR EXISTS (SELECT 1 FROM reporting_private.partition_work w WHERE w.batch_id = p_batch AND w.audience_kind = f.audience_kind
            AND w.audience_staff IS NOT DISTINCT FROM f.audience_staff AND w.partition_kind = f.partition_kind AND w.partition_key = f.partition_key));
  UPDATE reporting_private.timing_facts f SET valid_to_seq = v_seq
   WHERE f.site = b.site AND f.valid_to_seq IS NULL
     AND (b.kind = 'rebuild' OR EXISTS (SELECT 1 FROM reporting_private.partition_work w WHERE w.batch_id = p_batch AND w.audience_kind = f.audience_kind
            AND w.audience_staff IS NOT DISTINCT FROM f.audience_staff AND w.partition_kind = f.partition_kind AND w.partition_key = f.partition_key));
  UPDATE reporting_private.source_issue_facts f SET valid_to_seq = v_seq
   WHERE f.site = b.site AND f.valid_to_seq IS NULL
     AND (b.kind = 'rebuild' OR EXISTS (SELECT 1 FROM reporting_private.partition_work w WHERE w.batch_id = p_batch AND w.audience_kind = f.audience_kind
            AND w.audience_staff IS NOT DISTINCT FROM f.audience_staff AND w.partition_kind = f.partition_kind AND w.partition_key = f.partition_key));

  -- Install the staged rows at S; site/audience/owner/rule/validity come from trusted metadata only.
  INSERT INTO reporting_private.event_facts (site, audience_kind, audience_staff, event_id, valid_from_seq, event_type, created_at, staff_id, department,
              raw_order, order_key, case_id, parent_event_id, sku, quantity, role, work_type, invalid_detail, line_key, item_status, items, product_kind,
              item_issue_kind, item_issue_detail, timing_stream, timing_weight, rule_version, production_date, partition_kind, partition_key)
  SELECT b.site, w.audience_kind, w.audience_staff, x.event_id, v_seq, x.event_type, x.created_at, x.staff_id, x.department,
         x.raw_order, x.order_key, x.case_id, x.parent_event_id, x.sku, x.quantity, x.role, x.work_type, x.invalid_detail, x.line_key, x.item_status, x.items, x.product_kind,
         x.item_issue_kind, x.item_issue_detail, x.timing_stream, x.timing_weight, b.rule_version, x.production_date, w.partition_kind, w.partition_key
    FROM reporting_private.partition_work w
    JOIN reporting_private.partition_results r ON r.work_id = w.work_id
    CROSS JOIN LATERAL pg_catalog.jsonb_populate_recordset(NULL::reporting_private.event_facts, r.chunk -> 'event_facts') x
   WHERE w.batch_id = p_batch;
  INSERT INTO reporting_private.cancel_edges (site, audience_kind, audience_staff, cancel_event_id, parent_event_id, valid_from_seq, is_self, parent_role,
              parent_created_at, pair, partition_kind, partition_key)
  SELECT b.site, w.audience_kind, w.audience_staff, x.cancel_event_id, x.parent_event_id, v_seq, x.is_self, x.parent_role,
         x.parent_created_at, x.pair, w.partition_kind, w.partition_key
    FROM reporting_private.partition_work w
    JOIN reporting_private.partition_results r ON r.work_id = w.work_id
    CROSS JOIN LATERAL pg_catalog.jsonb_populate_recordset(NULL::reporting_private.cancel_edges, r.chunk -> 'cancel_edges') x
   WHERE w.batch_id = p_batch;
  INSERT INTO reporting_private.order_occurrences (site, audience_kind, audience_staff, terminal_event_id, valid_from_seq, order_key, raw_order, case_id,
              work_type, staff_id, occurred_at, partition_kind, partition_key)
  SELECT b.site, w.audience_kind, w.audience_staff, x.terminal_event_id, v_seq, x.order_key, x.raw_order, x.case_id,
         x.work_type, x.staff_id, x.occurred_at, w.partition_kind, w.partition_key
    FROM reporting_private.partition_work w
    JOIN reporting_private.partition_results r ON r.work_id = w.work_id
    CROSS JOIN LATERAL pg_catalog.jsonb_populate_recordset(NULL::reporting_private.order_occurrences, r.chunk -> 'order_occurrences') x
   WHERE w.batch_id = p_batch;
  INSERT INTO reporting_private.timing_facts (site, audience_kind, audience_staff, event_id, valid_from_seq, staff_id, work_type, occurred_at, weight,
              prev_all_event_id, prev_same_type_event_id, partition_kind, partition_key)
  SELECT b.site, w.audience_kind, w.audience_staff, x.event_id, v_seq, x.staff_id, x.work_type, x.occurred_at, x.weight,
         x.prev_all_event_id, x.prev_same_type_event_id, w.partition_kind, w.partition_key
    FROM reporting_private.partition_work w
    JOIN reporting_private.partition_results r ON r.work_id = w.work_id
    CROSS JOIN LATERAL pg_catalog.jsonb_populate_recordset(NULL::reporting_private.timing_facts, r.chunk -> 'timing_facts') x
   WHERE w.batch_id = p_batch;
  INSERT INTO reporting_private.source_issue_facts (site, audience_kind, audience_staff, event_id, valid_from_seq, event_type, created_at, staff_id,
              raw_order, parent_event_id, issue_kind, issue_detail, rule_version, partition_kind, partition_key)
  SELECT b.site, w.audience_kind, w.audience_staff, x.event_id, v_seq, x.event_type, x.created_at, x.staff_id,
         x.raw_order, x.parent_event_id, x.issue_kind, x.issue_detail, b.rule_version, w.partition_kind, w.partition_key
    FROM reporting_private.partition_work w
    JOIN reporting_private.partition_results r ON r.work_id = w.work_id
    CROSS JOIN LATERAL pg_catalog.jsonb_populate_recordset(NULL::reporting_private.source_issue_facts, r.chunk -> 'source_issue_facts') x
   WHERE w.batch_id = p_batch;

  -- Integrity: dated verifications; one current owner per event in every family.
  SELECT 'event_facts event ' || f.event_id || ' is a verification without production_date' INTO v_bad
    FROM reporting_private.event_facts f
   WHERE f.site = b.site AND f.valid_from_seq = v_seq AND f.role = 'verification' AND f.production_date IS NULL
   LIMIT 1;
  IF v_bad IS NULL THEN
    SELECT 'event_facts event ' || f.event_id || ' has another current row (an old owner was not planned)' INTO v_bad
      FROM reporting_private.event_facts f
     WHERE f.site = b.site AND f.valid_from_seq = v_seq
       AND EXISTS (SELECT 1 FROM reporting_private.event_facts o WHERE o.site = f.site AND o.audience_kind = f.audience_kind
                     AND o.audience_staff IS NOT DISTINCT FROM f.audience_staff AND o.event_id = f.event_id AND o.valid_to_seq IS NULL AND o.valid_from_seq <> v_seq)
     LIMIT 1;
  END IF;
  IF v_bad IS NULL THEN
    SELECT 'cancel_edges cancellation ' || f.cancel_event_id || ' has another current row (an old owner was not planned)' INTO v_bad
      FROM reporting_private.cancel_edges f
     WHERE f.site = b.site AND f.valid_from_seq = v_seq
       AND EXISTS (SELECT 1 FROM reporting_private.cancel_edges o WHERE o.site = f.site AND o.audience_kind = f.audience_kind
                     AND o.audience_staff IS NOT DISTINCT FROM f.audience_staff AND o.cancel_event_id = f.cancel_event_id AND o.valid_to_seq IS NULL AND o.valid_from_seq <> v_seq)
     LIMIT 1;
  END IF;
  IF v_bad IS NULL THEN
    SELECT 'order_occurrences terminal ' || f.terminal_event_id || ' has another current row (an old owner was not planned)' INTO v_bad
      FROM reporting_private.order_occurrences f
     WHERE f.site = b.site AND f.valid_from_seq = v_seq
       AND EXISTS (SELECT 1 FROM reporting_private.order_occurrences o WHERE o.site = f.site AND o.audience_kind = f.audience_kind
                     AND o.audience_staff IS NOT DISTINCT FROM f.audience_staff AND o.terminal_event_id = f.terminal_event_id AND o.valid_to_seq IS NULL AND o.valid_from_seq <> v_seq)
     LIMIT 1;
  END IF;
  IF v_bad IS NULL THEN
    SELECT 'timing_facts event ' || f.event_id || ' has another current row (an old owner was not planned)' INTO v_bad
      FROM reporting_private.timing_facts f
     WHERE f.site = b.site AND f.valid_from_seq = v_seq
       AND EXISTS (SELECT 1 FROM reporting_private.timing_facts o WHERE o.site = f.site AND o.audience_kind = f.audience_kind
                     AND o.audience_staff IS NOT DISTINCT FROM f.audience_staff AND o.event_id = f.event_id AND o.valid_to_seq IS NULL AND o.valid_from_seq <> v_seq)
     LIMIT 1;
  END IF;
  IF v_bad IS NULL THEN
    SELECT 'source_issue_facts event ' || f.event_id || ' has another current row (an old owner was not planned)' INTO v_bad
      FROM reporting_private.source_issue_facts f
     WHERE f.site = b.site AND f.valid_from_seq = v_seq
       AND EXISTS (SELECT 1 FROM reporting_private.source_issue_facts o WHERE o.site = f.site AND o.audience_kind = f.audience_kind
                     AND o.audience_staff IS NOT DISTINCT FROM f.audience_staff AND o.event_id = f.event_id AND o.valid_to_seq IS NULL AND o.valid_from_seq <> v_seq)
     LIMIT 1;
  END IF;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'publish: batch %: %', p_batch, v_bad; END IF;

  -- Daily totals: close and recompute every affected group from the current facts.
  WITH changed AS (
    SELECT f.audience_kind, f.audience_staff, f.production_date, f.staff_id, f.work_type, (f.case_id IS NOT NULL) AS rework
      FROM reporting_private.event_facts f
     WHERE f.site = b.site AND f.role = 'verification' AND f.production_date IS NOT NULL AND (f.valid_from_seq = v_seq OR f.valid_to_seq = v_seq)
    UNION
    SELECT p.audience_kind, p.audience_staff, p.production_date, p.staff_id, p.work_type, (p.case_id IS NOT NULL)
      FROM reporting_private.cancel_edges e
      JOIN reporting_private.event_facts p
        ON p.site = e.site AND p.audience_kind = e.audience_kind AND p.audience_staff IS NOT DISTINCT FROM e.audience_staff
       AND p.event_id = e.parent_event_id AND p.role = 'verification' AND p.valid_to_seq IS NULL AND p.production_date IS NOT NULL
     WHERE e.site = b.site AND (e.valid_from_seq = v_seq OR e.valid_to_seq = v_seq)
    UNION
    SELECT d.audience_kind, d.audience_staff, d.production_date, d.staff_id, d.work_type, d.rework
      FROM reporting_private.daily_totals d
     WHERE d.site = b.site AND d.valid_to_seq IS NULL AND b.kind = 'rebuild'
  ), closed AS (
    UPDATE reporting_private.daily_totals d SET valid_to_seq = v_seq
      FROM changed g
     WHERE d.site = b.site AND d.valid_to_seq IS NULL AND d.audience_kind = g.audience_kind AND d.audience_staff IS NOT DISTINCT FROM g.audience_staff
       AND d.production_date = g.production_date AND d.staff_id = g.staff_id AND d.work_type = g.work_type AND d.rework = g.rework
    RETURNING 1
  ), totals AS (
    SELECT g.audience_kind, g.audience_staff, g.production_date, g.staff_id, g.work_type, g.rework,
           count(*) AS lines, sum(CASE WHEN v.item_status = 'counted' THEN v.items ELSE 0 END)::numeric AS items
      FROM changed g
      JOIN reporting_private.event_facts v
        ON v.site = b.site AND v.valid_to_seq IS NULL AND v.role = 'verification' AND v.audience_kind = g.audience_kind
       AND v.audience_staff IS NOT DISTINCT FROM g.audience_staff AND v.production_date = g.production_date AND v.staff_id = g.staff_id
       AND v.work_type = g.work_type AND (v.case_id IS NOT NULL) = g.rework
     WHERE NOT EXISTS (
       SELECT 1
         FROM reporting_private.cancel_edges e
         JOIN reporting_private.event_facts c
           ON c.site = e.site AND c.audience_kind = e.audience_kind AND c.audience_staff IS NOT DISTINCT FROM e.audience_staff
          AND c.event_id = e.cancel_event_id AND c.role = 'cancellation' AND c.valid_to_seq IS NULL
        WHERE e.site = v.site AND e.audience_kind = v.audience_kind AND e.audience_staff IS NOT DISTINCT FROM v.audience_staff
          AND e.parent_event_id = v.event_id AND e.valid_to_seq IS NULL AND NOT e.is_self AND e.pair = 'valid'
          AND e.parent_role = 'verification' AND e.parent_created_at <= c.created_at)
     GROUP BY g.audience_kind, g.audience_staff, g.production_date, g.staff_id, g.work_type, g.rework
  ), ins AS (
    INSERT INTO reporting_private.daily_totals (site, audience_kind, audience_staff, production_date, staff_id, work_type, rework, valid_from_seq,
                items, items_overflow, line_count)
    SELECT b.site, t.audience_kind, t.audience_staff, t.production_date, t.staff_id, t.work_type, t.rework, v_seq,
           CASE WHEN t.items > 9007199254740991 THEN NULL ELSE t.items::bigint END, t.items > 9007199254740991, t.lines::integer
      FROM totals t
     WHERE t.lines > 0
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM closed) + (SELECT count(*) FROM ins) INTO v_daily;

  -- Mirror and retained source versions.
  IF b.kind = 'refresh' THEN
    UPDATE reporting_private.source_versions v SET valid_to_seq = v_seq
      FROM reporting_private.batch_events be
     WHERE be.batch_id = p_batch AND be.site = b.site AND v.site = b.site AND v.event_id = be.event_id
       AND v.valid_to_seq IS NULL AND v.image IS DISTINCT FROM be.image;
    INSERT INTO reporting_private.source_versions (site, event_id, valid_from_seq, image)
    SELECT b.site, be.event_id, v_seq, be.image
      FROM reporting_private.batch_events be
     WHERE be.batch_id = p_batch AND be.site = b.site AND be.image IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM reporting_private.source_versions v WHERE v.site = b.site AND v.event_id = be.event_id AND v.valid_to_seq IS NULL);
    DELETE FROM reporting_private.source_current sc
     USING reporting_private.batch_events be
     WHERE be.batch_id = p_batch AND be.site = b.site AND be.image IS NULL AND sc.site = b.site AND sc.event_id = be.event_id;
    INSERT INTO reporting_private.source_current (site, event_id, image, event_created_at, order_key, parent_event_id, staff_id, generation_id)
    SELECT b.site, be.event_id, be.image, (be.image ->> 'created_at')::timestamptz, reporting_private.order_key(be.image ->> 'order_number'),
           be.image ->> 'parent_event_id', (be.image ->> 'staff_id')::uuid, v_gen
      FROM reporting_private.batch_events be
     WHERE be.batch_id = p_batch AND be.site = b.site AND be.image IS NOT NULL
    ON CONFLICT (site, event_id) DO UPDATE
      SET image = EXCLUDED.image, event_created_at = EXCLUDED.event_created_at, order_key = EXCLUDED.order_key,
          parent_event_id = EXCLUDED.parent_event_id, staff_id = EXCLUDED.staff_id, generation_id = EXCLUDED.generation_id
      WHERE reporting_private.source_current.image IS DISTINCT FROM EXCLUDED.image;
  ELSE
    UPDATE reporting_private.source_versions v SET valid_to_seq = v_seq
     WHERE v.site = b.site AND v.valid_to_seq IS NULL
       AND NOT EXISTS (SELECT 1 FROM reporting_private.source_candidate c WHERE c.batch_id = p_batch AND c.site = b.site AND c.event_id = v.event_id AND c.image = v.image);
    INSERT INTO reporting_private.source_versions (site, event_id, valid_from_seq, image)
    SELECT b.site, c.event_id, v_seq, c.image
      FROM reporting_private.source_candidate c
     WHERE c.batch_id = p_batch AND c.site = b.site
       AND NOT EXISTS (SELECT 1 FROM reporting_private.source_versions v WHERE v.site = b.site AND v.event_id = c.event_id AND v.valid_to_seq IS NULL);
    DELETE FROM reporting_private.source_current sc
     WHERE sc.site = b.site
       AND NOT EXISTS (SELECT 1 FROM reporting_private.source_candidate c WHERE c.batch_id = p_batch AND c.site = b.site AND c.event_id = sc.event_id);
    INSERT INTO reporting_private.source_current (site, event_id, image, event_created_at, order_key, parent_event_id, staff_id, generation_id)
    SELECT b.site, c.event_id, c.image, c.event_created_at, c.order_key, c.parent_event_id, c.staff_id, v_gen
      FROM reporting_private.source_candidate c
     WHERE c.batch_id = p_batch AND c.site = b.site
    ON CONFLICT (site, event_id) DO UPDATE
      SET image = EXCLUDED.image, event_created_at = EXCLUDED.event_created_at, order_key = EXCLUDED.order_key,
          parent_event_id = EXCLUDED.parent_event_id, staff_id = EXCLUDED.staff_id, generation_id = EXCLUDED.generation_id
      WHERE reporting_private.source_current.image IS DISTINCT FROM EXCLUDED.image;
  END IF;

  -- Generations: supersede the previous published one, then publish (one published per site).
  UPDATE reporting_private.generations g
     SET state = 'superseded', superseded_at = v_now, expires_at = v_now + interval '7 days'
   WHERE g.site = b.site AND g.state = 'published';
  UPDATE reporting_private.generations g
     SET state = 'published', complete = true, verified_at = v_now, published_at = v_now,
         reconciliation_fingerprint = reporting_private.publication_fingerprint(p_batch)
   WHERE g.generation_id = v_gen;

  -- Per-site receipt, then the idempotent global acknowledgement pass.
  UPDATE reporting_private.batches x SET state = 'published', published_generation_id = v_gen, updated_at = now() WHERE x.batch_id = p_batch;
  SELECT count(*) INTO v_rcpt FROM reporting_private.batch_changes bc WHERE bc.batch_id = p_batch;
  v_ack := reporting_private.acknowledge_received_changes(b.site, p_batch);

  UPDATE reporting_private.site_state s
     SET active_generation_id = v_gen, source_epoch = b.capture_epoch, last_verified_cutoff = b.source_cutoff,
         active_batch_id = NULL, lease_expires_at = NULL, heartbeat_at = now(), updated_at = now()
   WHERE s.site = b.site;

  RETURN QUERY SELECT p_batch, v_gen, v_seq::text, b.site, b.kind, b.source_cutoff, b.sealed_work_count, v_rcpt, v_ack, false;
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

-- Part B2a.
REVOKE ALL ON FUNCTION reporting_private.partition_work_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION reporting_private.frozen_image(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.owner_partition(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.work_manifest(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.stage_one(uuid, bigint, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.check_staged_rows(uuid, reporting_private.partition_work, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.staged_row_problem(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.frozen_image(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.owner_partition(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.work_manifest(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.stage_one(uuid, bigint, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.check_staged_rows(uuid, reporting_private.partition_work, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.staged_row_problem(text, jsonb) TO service_role;
REVOKE ALL ON TABLE reporting_private.source_issue_facts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reporting_private.source_issue_facts TO service_role;
REVOKE ALL ON FUNCTION public.plan_reporting_work(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seal_reporting_work(uuid, bigint, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_reporting_work(uuid, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stage_reporting_result(uuid, bigint, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stage_reporting_results(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_reporting_work(uuid, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.seal_reporting_work(uuid, bigint, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_reporting_work(uuid, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.stage_reporting_result(uuid, bigint, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.stage_reporting_results(uuid, bigint, jsonb) TO service_role;

-- Part B2b.
REVOKE ALL ON TABLE reporting_private.source_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reporting_private.source_versions TO service_role;
REVOKE ALL ON FUNCTION reporting_private.publication_fingerprint(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reporting_private.publication_fingerprint(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.publish_reporting_batch(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_reporting_batch(uuid, bigint) TO service_role;

COMMIT;
