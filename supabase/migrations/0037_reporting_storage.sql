-- 0037_reporting_storage.sql
--
-- item-counting amendment, Task 12: private reporting storage and the
-- durable source-change journal.
--
-- Expand-only. Adds the private schema `reporting_private`, its tables,
-- one non-login internal role, three private trigger functions and ONE new
-- trigger on public.production_events. Does NOT change any existing table,
-- column, policy, helper, grant, default privilege, role setting, timeout,
-- 0034–0036 function, source row, ledger row or stock value.
--
-- Capture (`changes`):
--   * AFTER INSERT/UPDATE/DELETE FOR EACH ROW on public.production_events.
--     In the SAME transaction as the source write it inserts one journal row
--     with the old/new (site, id) keys and full old/new row images (every
--     column, including note and station_id). No remote call, KPI work,
--     per-site counter, row lock on a reporting state row, or table scan:
--     it reads the singleton control row and inserts one row.
--   * Only a supported old or new site (au, uk, us) creates work. A key move
--     is one row carrying both sides. An UPDATE that leaves the whole row
--     identical creates nothing.
--   * Any journal failure raises and aborts the source write: a save can
--     never be acknowledged without its journal row.
--   * Capture starts DISABLED (control.capture_enabled = false). Enabling it
--     is an operator/CJ staging step. Every change of capture_enabled
--     increments capture_epoch (control_guard), so a disabled interval can
--     never be resumed from a cursor: generations of an older epoch are not
--     continuous and need a rebuild.
--   * Processors start OFF and every site reads `legacy`.
--
-- Access (planner's internal capture-role clarification, 2026-11-14):
--   * PUBLIC, anon and authenticated get NOTHING in reporting_private
--     (schema, tables, sequences, functions). RLS is enabled on every table
--     with no client policy.
--   * service_role (the trusted server, BYPASSRLS on Supabase) gets USAGE and
--     table DML; it never executes the trigger functions directly.
--   * reporting_capture: NOLOGIN, NOINHERIT, no BYPASSRLS, no memberships,
--     owns only the capture trigger function (SECURITY DEFINER,
--     search_path = '', no dynamic SQL). Grants: schema USAGE, control
--     SELECT, changes INSERT, and USAGE on the change-id sequence. Two
--     command-specific policies addressed only to it: control SELECT and
--     changes INSERT. It owns no table and is granted to no client role.
--     Ownership transfer needs CREATE on the schema at ALTER time (the
--     migration role is not a superuser), so CREATE is granted and revoked
--     again inside this transaction.
--   * reporting_private must never be added to the Data API exposed schemas.
--
-- Apply: CJ only (or Astra/planner on CJ's instruction), staging first, as
-- ONE transaction. Plain CREATE (no IF NOT EXISTS / OR REPLACE): a collision
-- fails instead of silently reusing a different object.
--
-- Rollback (a NEW migration, only if needed; the app never depends on this
-- before Tasks 13–17 are enabled):
--   BEGIN;
--   DROP TRIGGER production_events_reporting_capture ON public.production_events;
--   DROP SCHEMA reporting_private CASCADE;
--   DROP ROLE reporting_capture;
--   COMMIT;
-- Dropping the trigger alone (first statement) stops capture immediately and
-- leaves source writes exactly as before 0037.

BEGIN;

CREATE ROLE reporting_capture NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
COMMENT ON ROLE reporting_capture IS 'item-counting reporting: non-login owner of the source-change capture trigger function only.';

CREATE SCHEMA reporting_private;
COMMENT ON SCHEMA reporting_private IS 'item-counting reporting: private derived storage. Server (service_role) only; never a Data API schema.';
REVOKE ALL ON SCHEMA reporting_private FROM PUBLIC;
REVOKE ALL ON SCHEMA reporting_private FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Control and per-site state
-- ---------------------------------------------------------------------------

CREATE TABLE reporting_private.control (
  singleton        boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  capture_epoch    bigint      NOT NULL DEFAULT 1 CHECK (capture_epoch >= 1),
  capture_enabled  boolean     NOT NULL DEFAULT false,
  rule_version     text        NOT NULL DEFAULT 'item-counting-summary-v1' CHECK (rule_version <> ''),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO reporting_private.control (singleton) VALUES (true);

CREATE TABLE reporting_private.generations (
  generation_id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_seq             bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  site                       text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  base_generation_id         uuid        REFERENCES reporting_private.generations (generation_id),
  rule_version               text        NOT NULL CHECK (rule_version <> ''),
  capture_epoch              bigint      NOT NULL CHECK (capture_epoch >= 1),
  source_cutoff              timestamptz NOT NULL,
  state                      text        NOT NULL DEFAULT 'building'
                                         CHECK (state IN ('building', 'published', 'superseded', 'expired', 'failed')),
  complete                   boolean     NOT NULL DEFAULT false,
  verified_at                timestamptz,
  published_at               timestamptz,
  superseded_at              timestamptz,
  expires_at                 timestamptz,
  reconciliation_fingerprint text        CHECK (reconciliation_fingerprint IS NULL OR reconciliation_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (state IN ('building', 'failed')
         OR (complete AND verified_at IS NOT NULL AND published_at IS NOT NULL AND reconciliation_fingerprint IS NOT NULL)),
  CHECK (state NOT IN ('superseded', 'expired') OR (superseded_at IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX generations_one_published_per_site ON reporting_private.generations (site) WHERE state = 'published';
CREATE INDEX generations_validity ON reporting_private.generations (site, state, expires_at);

CREATE TABLE reporting_private.batches (
  batch_id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  site                text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  kind                text        NOT NULL CHECK (kind IN ('refresh', 'rebuild')),
  base_generation_id  uuid        REFERENCES reporting_private.generations (generation_id),
  rule_version        text        NOT NULL CHECK (rule_version <> ''),
  capture_epoch       bigint      NOT NULL CHECK (capture_epoch >= 1),
  source_cutoff       timestamptz,
  state               text        NOT NULL DEFAULT 'active'
                                  CHECK (state IN ('active', 'frozen', 'publishing', 'published', 'failed', 'abandoned')),
  lease_fence         bigint      NOT NULL CHECK (lease_fence >= 0),
  lease_expires_at    timestamptz,
  rebuild_cursor      jsonb,
  failure_kind        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (state = 'active' OR source_cutoff IS NOT NULL)
);
-- One active batch per site.
CREATE UNIQUE INDEX batches_one_active_per_site ON reporting_private.batches (site) WHERE state IN ('active', 'frozen', 'publishing');

CREATE TABLE reporting_private.site_state (
  site                   text        PRIMARY KEY CHECK (site IN ('au', 'uk', 'us')),
  processor_enabled      boolean     NOT NULL DEFAULT false,
  read_mode              text        NOT NULL DEFAULT 'legacy' CHECK (read_mode IN ('legacy', 'shadow', 'summary')),
  source_epoch           bigint      CHECK (source_epoch IS NULL OR source_epoch >= 1),
  active_generation_id   uuid        REFERENCES reporting_private.generations (generation_id),
  active_batch_id        uuid        REFERENCES reporting_private.batches (batch_id),
  lease_fence            bigint      NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  lease_expires_at       timestamptz,
  heartbeat_at           timestamptz,
  last_verified_cutoff   timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (read_mode = 'legacy' OR active_generation_id IS NOT NULL)
);
INSERT INTO reporting_private.site_state (site) VALUES ('au'), ('uk'), ('us');

-- ---------------------------------------------------------------------------
-- Source-change journal and frozen batch inputs
-- ---------------------------------------------------------------------------

CREATE TABLE reporting_private.changes (
  change_id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  capture_epoch    bigint      NOT NULL CHECK (capture_epoch >= 1),
  op               text        NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  old_site         text,
  old_event_id     text,
  new_site         text,
  new_event_id     text,
  old_image        jsonb,
  new_image        jsonb,
  capture_xact     xid8        NOT NULL DEFAULT pg_current_xact_id(),
  captured_at      timestamptz NOT NULL DEFAULT now(),
  batch_id         uuid        REFERENCES reporting_private.batches (batch_id),
  acknowledged_at  timestamptz,
  CHECK ((op = 'INSERT') = (old_image IS NULL)),
  CHECK ((op = 'DELETE') = (new_image IS NULL)),
  CHECK ((old_image IS NULL) = (old_site IS NULL AND old_event_id IS NULL)),
  CHECK ((new_image IS NULL) = (new_site IS NULL AND new_event_id IS NULL)),
  CHECK (old_image IS NULL OR (old_image ->> 'location' = old_site AND old_image ->> 'id' = old_event_id)),
  CHECK (new_image IS NULL OR (new_image ->> 'location' = new_site AND new_image ->> 'id' = new_event_id)),
  CHECK (old_site IN ('au', 'uk', 'us') OR new_site IN ('au', 'uk', 'us')),
  CHECK (acknowledged_at IS NULL OR batch_id IS NOT NULL)
);
CREATE INDEX changes_unacknowledged_old ON reporting_private.changes (old_site, change_id) WHERE acknowledged_at IS NULL;
CREATE INDEX changes_unacknowledged_new ON reporting_private.changes (new_site, change_id) WHERE acknowledged_at IS NULL;
CREATE INDEX changes_batch ON reporting_private.changes (batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE reporting_private.batch_changes (
  batch_id   uuid   NOT NULL REFERENCES reporting_private.batches (batch_id),
  change_id  bigint NOT NULL REFERENCES reporting_private.changes (change_id),
  PRIMARY KEY (batch_id, change_id)
);
CREATE INDEX batch_changes_change ON reporting_private.batch_changes (change_id);

-- Frozen final image (or tombstone when image IS NULL) of every affected key, at one snapshot.
CREATE TABLE reporting_private.batch_events (
  batch_id   uuid  NOT NULL REFERENCES reporting_private.batches (batch_id),
  site       text  NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  event_id   text  NOT NULL,
  image      jsonb,
  PRIMARY KEY (batch_id, site, event_id),
  CHECK (image IS NULL OR (image ->> 'location' = site AND image ->> 'id' = event_id))
);

-- Rebuildable private mirror at the published source boundary (includes future events and raw export fields).
CREATE TABLE reporting_private.source_current (
  site             text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  event_id         text        NOT NULL,
  image            jsonb       NOT NULL,
  event_created_at timestamptz NOT NULL,
  order_key        text,
  parent_event_id  text,
  staff_id         uuid,
  generation_id    uuid        NOT NULL REFERENCES reporting_private.generations (generation_id),
  PRIMARY KEY (site, event_id),
  CHECK (image ->> 'location' = site AND image ->> 'id' = event_id)
);
CREATE INDEX source_current_order ON reporting_private.source_current (site, order_key);
CREATE INDEX source_current_parent ON reporting_private.source_current (site, parent_event_id) WHERE parent_event_id IS NOT NULL;
CREATE INDEX source_current_time ON reporting_private.source_current (site, event_created_at, event_id);

-- ---------------------------------------------------------------------------
-- Partition work and staged results
-- ---------------------------------------------------------------------------

CREATE TABLE reporting_private.partition_work (
  work_id         bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id        uuid    NOT NULL REFERENCES reporting_private.batches (batch_id),
  audience_kind   text    NOT NULL CHECK (audience_kind IN ('site', 'self')),
  audience_staff  uuid,
  partition_kind  text    NOT NULL CHECK (partition_kind IN ('order', 'event')),
  partition_key   text    NOT NULL,
  input_hash      text    NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  state           text    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'done', 'failed')),
  lease_fence     bigint  CHECK (lease_fence IS NULL OR lease_fence >= 0),
  chunk_count     integer CHECK (chunk_count IS NULL OR chunk_count >= 0),
  result_digest   text    CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
  completed_at    timestamptz,
  CHECK ((audience_kind = 'site') = (audience_staff IS NULL)),
  CHECK ((state = 'done') = (result_digest IS NOT NULL AND chunk_count IS NOT NULL AND completed_at IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (batch_id, audience_kind, audience_staff, partition_kind, partition_key)
);
CREATE INDEX partition_work_pending ON reporting_private.partition_work (batch_id, state) WHERE state IN ('pending', 'leased');

-- Results reference their work row by its surrogate id: a composite FK over the
-- nullable audience_staff would skip the check for site rows (MATCH SIMPLE).
CREATE TABLE reporting_private.partition_results (
  work_id     bigint  NOT NULL REFERENCES reporting_private.partition_work (work_id),
  chunk_no    integer NOT NULL CHECK (chunk_no >= 0),
  chunk       jsonb   NOT NULL,
  chunk_hash  text    NOT NULL CHECK (chunk_hash ~ '^[0-9a-f]{64}$'),
  CHECK (octet_length(chunk::text) <= 1048576),
  PRIMARY KEY (work_id, chunk_no)
);

-- ---------------------------------------------------------------------------
-- Versioned derived facts (validity by generation_seq interval)
-- ---------------------------------------------------------------------------

CREATE TABLE reporting_private.event_facts (
  site                    text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  audience_kind           text        NOT NULL CHECK (audience_kind IN ('site', 'self')),
  audience_staff          uuid,
  event_id                text        NOT NULL,
  valid_from_seq          bigint      NOT NULL CHECK (valid_from_seq >= 1),
  valid_to_seq            bigint,
  event_type              text        NOT NULL CHECK (event_type IN ('line_verified', 'completed', 'dispatched', 'cancelled')),
  created_at              timestamptz NOT NULL,
  staff_id                uuid,
  department              text,
  raw_order               text,
  order_key               text        NOT NULL,
  case_id                 text,
  parent_event_id         text,
  sku                     text,
  quantity                integer,
  role                    text        NOT NULL CHECK (role IN ('verification', 'terminal', 'cancellation', 'invalid')),
  work_type               text        CHECK (work_type IS NULL OR work_type IN ('a0_framed', 'framed', 'unframed', 'dispatch')),
  invalid_detail          text,
  line_key                text,
  item_status             text        CHECK (item_status IS NULL OR item_status IN ('counted', 'excluded', 'unclassified')),
  items                   bigint      CHECK (items IS NULL OR (items >= 0 AND items <= 9007199254740991)),
  product_kind            text        CHECK (product_kind IS NULL OR product_kind IN ('eligible', 'excluded', 'unclassified')),
  item_issue_kind         text        CHECK (item_issue_kind IS NULL OR item_issue_kind IN ('unclassified_sku', 'invalid_quantity')),
  item_issue_detail       text,
  timing_stream           boolean,
  timing_weight           numeric     CHECK (timing_weight IS NULL OR timing_weight >= 0),
  rule_version            text        NOT NULL CHECK (rule_version <> ''),
  CHECK ((audience_kind = 'site') = (audience_staff IS NULL)),
  CHECK (valid_to_seq IS NULL OR valid_to_seq > valid_from_seq),
  CHECK ((role = 'verification') = (item_status IS NOT NULL AND items IS NOT NULL AND product_kind IS NOT NULL AND line_key IS NOT NULL AND timing_stream IS NOT NULL AND timing_weight IS NOT NULL)),
  CHECK ((role = 'invalid') = (invalid_detail IS NOT NULL)),
  CHECK (audience_kind = 'site' OR staff_id = audience_staff),
  UNIQUE NULLS NOT DISTINCT (site, audience_kind, audience_staff, event_id, valid_from_seq)
);
CREATE INDEX event_facts_current_time ON reporting_private.event_facts (site, audience_kind, audience_staff, created_at, event_id) WHERE valid_to_seq IS NULL;
CREATE INDEX event_facts_validity ON reporting_private.event_facts (site, audience_kind, audience_staff, valid_from_seq, valid_to_seq);
CREATE INDEX event_facts_order ON reporting_private.event_facts (site, audience_kind, audience_staff, order_key);
CREATE INDEX event_facts_raw_order ON reporting_private.event_facts (site, audience_kind, audience_staff, raw_order);
CREATE INDEX event_facts_id ON reporting_private.event_facts (site, audience_kind, audience_staff, event_id);
CREATE INDEX event_facts_parent ON reporting_private.event_facts (site, audience_kind, audience_staff, parent_event_id) WHERE parent_event_id IS NOT NULL;
CREATE INDEX event_facts_timing ON reporting_private.event_facts (site, audience_kind, audience_staff, staff_id, created_at, event_id) WHERE timing_stream;

CREATE TABLE reporting_private.cancel_edges (
  site               text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  audience_kind      text        NOT NULL CHECK (audience_kind IN ('site', 'self')),
  audience_staff     uuid,
  cancel_event_id    text        NOT NULL,
  parent_event_id    text        NOT NULL,
  valid_from_seq     bigint      NOT NULL CHECK (valid_from_seq >= 1),
  valid_to_seq       bigint,
  is_self            boolean     NOT NULL,
  parent_role        text        CHECK (parent_role IS NULL OR parent_role IN ('verification', 'terminal', 'cancellation', 'invalid')),
  parent_created_at  timestamptz,
  pair               text        CHECK (pair IS NULL OR pair IN ('valid', 'mismatch', 'case_differs')),
  CHECK ((audience_kind = 'site') = (audience_staff IS NULL)),
  CHECK (valid_to_seq IS NULL OR valid_to_seq > valid_from_seq),
  CHECK ((parent_role IS NULL) = (parent_created_at IS NULL)),
  CHECK ((pair IS NOT NULL) = (parent_role IN ('verification', 'terminal'))),
  UNIQUE NULLS NOT DISTINCT (site, audience_kind, audience_staff, cancel_event_id, valid_from_seq)
);
CREATE INDEX cancel_edges_parent ON reporting_private.cancel_edges (site, audience_kind, audience_staff, parent_event_id);

CREATE TABLE reporting_private.order_occurrences (
  site               text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  audience_kind      text        NOT NULL CHECK (audience_kind IN ('site', 'self')),
  audience_staff     uuid,
  terminal_event_id  text        NOT NULL,
  valid_from_seq     bigint      NOT NULL CHECK (valid_from_seq >= 1),
  valid_to_seq       bigint,
  order_key          text        NOT NULL CHECK (order_key <> ''),
  raw_order          text        NOT NULL,
  case_id            text,
  work_type          text        NOT NULL CHECK (work_type IN ('a0_framed', 'framed', 'unframed', 'dispatch')),
  staff_id           uuid        NOT NULL,
  occurred_at        timestamptz NOT NULL,
  CHECK ((audience_kind = 'site') = (audience_staff IS NULL)),
  CHECK (valid_to_seq IS NULL OR valid_to_seq > valid_from_seq),
  UNIQUE NULLS NOT DISTINCT (site, audience_kind, audience_staff, terminal_event_id, valid_from_seq)
);
CREATE INDEX order_occurrences_order ON reporting_private.order_occurrences (site, audience_kind, audience_staff, order_key, occurred_at);
CREATE INDEX order_occurrences_staff ON reporting_private.order_occurrences (site, audience_kind, audience_staff, staff_id, work_type, occurred_at);

-- Additive effective Items per site/audience/production day/staff/work type/normal-or-rework.
-- (Daily distinct Orders are never stored as additive range totals.)
CREATE TABLE reporting_private.daily_totals (
  site             text    NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  audience_kind    text    NOT NULL CHECK (audience_kind IN ('site', 'self')),
  audience_staff   uuid,
  production_date  date    NOT NULL,
  staff_id         uuid    NOT NULL,
  work_type        text    NOT NULL CHECK (work_type IN ('a0_framed', 'framed', 'unframed', 'dispatch')),
  rework           boolean NOT NULL,
  valid_from_seq   bigint  NOT NULL CHECK (valid_from_seq >= 1),
  valid_to_seq     bigint,
  items            bigint  CHECK (items IS NULL OR (items >= 0 AND items <= 9007199254740991)),
  items_overflow   boolean NOT NULL DEFAULT false,
  line_count       integer NOT NULL CHECK (line_count >= 0),
  CHECK ((audience_kind = 'site') = (audience_staff IS NULL)),
  CHECK (valid_to_seq IS NULL OR valid_to_seq > valid_from_seq),
  CHECK (items_overflow = (items IS NULL)),
  UNIQUE NULLS NOT DISTINCT (site, audience_kind, audience_staff, production_date, staff_id, work_type, rework, valid_from_seq)
);
CREATE INDEX daily_totals_range ON reporting_private.daily_totals (site, audience_kind, audience_staff, production_date);

CREATE TABLE reporting_private.timing_facts (
  site                   text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  audience_kind          text        NOT NULL CHECK (audience_kind IN ('site', 'self')),
  audience_staff         uuid,
  event_id               text        NOT NULL,
  valid_from_seq         bigint      NOT NULL CHECK (valid_from_seq >= 1),
  valid_to_seq           bigint,
  staff_id               uuid        NOT NULL,
  work_type              text        NOT NULL CHECK (work_type IN ('a0_framed', 'framed', 'unframed', 'dispatch')),
  occurred_at            timestamptz NOT NULL,
  weight                 numeric     NOT NULL CHECK (weight >= 0),
  -- Full-history predecessors are index hints only; a range read uses its own selected stream.
  prev_all_event_id      text,
  prev_same_type_event_id text,
  CHECK ((audience_kind = 'site') = (audience_staff IS NULL)),
  CHECK (valid_to_seq IS NULL OR valid_to_seq > valid_from_seq),
  UNIQUE NULLS NOT DISTINCT (site, audience_kind, audience_staff, event_id, valid_from_seq)
);
CREATE INDEX timing_facts_stream ON reporting_private.timing_facts (site, audience_kind, audience_staff, staff_id, occurred_at, event_id);

-- ---------------------------------------------------------------------------
-- Guards (SECURITY INVOKER, fixed search path)
-- ---------------------------------------------------------------------------

-- Any change of capture_enabled starts a new epoch; epochs never go back.
CREATE FUNCTION reporting_private.control_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF NEW.capture_epoch < OLD.capture_epoch THEN
    RAISE EXCEPTION 'reporting capture_epoch cannot decrease (% -> %)', OLD.capture_epoch, NEW.capture_epoch;
  END IF;
  IF NEW.capture_enabled IS DISTINCT FROM OLD.capture_enabled AND NEW.capture_epoch = OLD.capture_epoch THEN
    NEW.capture_epoch := OLD.capture_epoch + 1;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;
CREATE TRIGGER control_guard BEFORE UPDATE ON reporting_private.control
  FOR EACH ROW EXECUTE FUNCTION reporting_private.control_guard();

-- A published/superseded/expired generation's identity is immutable; states only move forward.
CREATE FUNCTION reporting_private.generations_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF OLD.state IN ('published', 'superseded', 'expired') THEN
    IF NEW.site IS DISTINCT FROM OLD.site
       OR NEW.base_generation_id IS DISTINCT FROM OLD.base_generation_id
       OR NEW.rule_version IS DISTINCT FROM OLD.rule_version
       OR NEW.capture_epoch IS DISTINCT FROM OLD.capture_epoch
       OR NEW.source_cutoff IS DISTINCT FROM OLD.source_cutoff
       OR NEW.complete IS DISTINCT FROM OLD.complete
       OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
       OR NEW.published_at IS DISTINCT FROM OLD.published_at
       OR NEW.reconciliation_fingerprint IS DISTINCT FROM OLD.reconciliation_fingerprint
       OR NEW.generation_seq IS DISTINCT FROM OLD.generation_seq THEN
      RAISE EXCEPTION 'published generation % identity is immutable', OLD.generation_id;
    END IF;
    IF NOT ((OLD.state = NEW.state)
            OR (OLD.state = 'published' AND NEW.state = 'superseded')
            OR (OLD.state = 'superseded' AND NEW.state = 'expired')) THEN
      RAISE EXCEPTION 'generation % cannot move from % to %', OLD.generation_id, OLD.state, NEW.state;
    END IF;
  ELSIF OLD.state = 'failed' AND NEW.state IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'failed generation % stays failed', OLD.generation_id;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER generations_guard BEFORE UPDATE ON reporting_private.generations
  FOR EACH ROW EXECUTE FUNCTION reporting_private.generations_guard();

-- ---------------------------------------------------------------------------
-- Capture trigger function (SECURITY DEFINER, owned by reporting_capture)
-- ---------------------------------------------------------------------------

CREATE FUNCTION reporting_private.capture_production_event_change()
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
  SELECT c.capture_epoch, c.capture_enabled INTO v_epoch, v_enabled
    FROM reporting_private.control c WHERE c.singleton;
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

-- ---------------------------------------------------------------------------
-- Row level security: enabled everywhere; only the two internal capture policies
-- ---------------------------------------------------------------------------

ALTER TABLE reporting_private.control           ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.generations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.batches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.site_state        ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.changes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.batch_changes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.batch_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.source_current    ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.partition_work    ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.partition_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.event_facts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.cancel_edges      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.order_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.daily_totals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.timing_facts      ENABLE ROW LEVEL SECURITY;

CREATE POLICY control_capture_select ON reporting_private.control
  FOR SELECT TO reporting_capture USING (singleton);
CREATE POLICY changes_capture_insert ON reporting_private.changes
  FOR INSERT TO reporting_capture WITH CHECK (acknowledged_at IS NULL AND batch_id IS NULL);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA reporting_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA reporting_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reporting_private FROM PUBLIC, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA reporting_private TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA reporting_private TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA reporting_private TO service_role;

GRANT USAGE ON SCHEMA reporting_private TO reporting_capture;
GRANT SELECT ON reporting_private.control TO reporting_capture;
GRANT INSERT ON reporting_private.changes TO reporting_capture;
GRANT USAGE ON SEQUENCE reporting_private.changes_change_id_seq TO reporting_capture;

-- Nobody may run the capture function directly. Done while the migration role
-- still owns it (review T12-1): after the hand-over below it no longer could.
REVOKE ALL ON FUNCTION reporting_private.capture_production_event_change() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The one trigger on the source table (created while the migration role still
-- owns, and so can EXECUTE, the function)
-- ---------------------------------------------------------------------------

CREATE TRIGGER production_events_reporting_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.production_events
  FOR EACH ROW EXECUTE FUNCTION reporting_private.capture_production_event_change();

-- ---------------------------------------------------------------------------
-- LAST: hand the capture function to reporting_capture, then remove every
-- temporary privilege. ALTER ... OWNER needs the migration role (not a
-- superuser) to be able to SET ROLE to the new owner, and the new owner to
-- hold CREATE on the schema at that moment. The ownership change keeps the
-- ACL above (the new owner gets EXECUTE; PUBLIC/anon/authenticated/
-- service_role stay revoked). Nothing after these statements needs the
-- migration role to own or execute the function.
-- ---------------------------------------------------------------------------

GRANT reporting_capture TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT CREATE ON SCHEMA reporting_private TO reporting_capture;
ALTER FUNCTION reporting_private.capture_production_event_change() OWNER TO reporting_capture;
REVOKE CREATE ON SCHEMA reporting_private FROM reporting_capture;
REVOKE reporting_capture FROM CURRENT_USER;

COMMIT;
