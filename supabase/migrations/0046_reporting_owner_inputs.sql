-- 0046: durable owner-input continuation (Task 15, T15P-4). OFFLINE DRAFT.
-- Planner contract: docs/plans/item-counting.md — coder proposal r5 with the
-- r6 replacements and the r6 planner review's binding conditions.
-- Additive only: private tables, private gates/helpers and service-only
-- SECURITY INVOKER RPCs with an empty search_path. Nothing here reads or
-- writes source capture, inventory or published generations.
--
-- An owner's consumed evidence is journaled as reduced events (the exact text
-- the worker serializes), each split into one or more pieces by one maximal
-- rule (escaped JSON literal <= 196,608 bytes). A durable source page commits
-- atomically: pending pieces may arrive over several calls; the page's final
-- call assembles, validates and commits them together with the next state.

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------

CREATE TABLE reporting_private.owner_inputs (
  handle                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id                 uuid        NOT NULL REFERENCES reporting_private.batches (batch_id),
  partition_kind           text        NOT NULL CHECK (partition_kind IN ('order', 'event')),
  partition_key            text        NOT NULL CHECK (partition_key <> ''),
  site                     text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  source_cutoff            timestamptz NOT NULL,
  rule_version             text        NOT NULL CHECK (rule_version <> ''),
  format_version           smallint    NOT NULL DEFAULT 1 CHECK (format_version = 1),
  purpose                  text        NOT NULL CHECK (purpose IN ('plan', 'stage')),
  phase                    text        NOT NULL DEFAULT 'reading' CHECK (phase IN ('reading', 'hashing', 'complete')),
  seq                      bigint      NOT NULL DEFAULT 0 CHECK (seq >= 0),
  state                    jsonb       NOT NULL,
  members_count            integer     CHECK (members_count BETWEEN 0 AND 50000),
  event_count              integer     NOT NULL DEFAULT 0 CHECK (event_count BETWEEN 0 AND 50000),
  pending_events           integer     NOT NULL DEFAULT 0 CHECK (pending_events BETWEEN 0 AND 1000),
  pending_pieces           integer     NOT NULL DEFAULT 0 CHECK (pending_pieces BETWEEN 0 AND 1033),
  pending_escaped_bytes    bigint      NOT NULL DEFAULT 0 CHECK (pending_escaped_bytes BETWEEN 0 AND 6303744),
  audiences                jsonb,
  hashes_done              integer     NOT NULL DEFAULT 0 CHECK (hashes_done BETWEEN 0 AND 1000),
  input_hashes             jsonb       NOT NULL DEFAULT '[]',
  load_pages               integer     NOT NULL DEFAULT 0,
  page_rows                integer     NOT NULL DEFAULT 0,
  page_bytes               integer     NOT NULL DEFAULT 0,
  reload_calls             integer     NOT NULL DEFAULT 2,
  prov_pages               integer     NOT NULL DEFAULT 0,
  prov_rows                integer     NOT NULL DEFAULT 0,
  prov_bytes               integer     NOT NULL DEFAULT 0,
  provisional_reload_calls integer     NOT NULL DEFAULT 2,
  heavy_proven             boolean     NOT NULL DEFAULT false,
  last_payload_md5         text        CHECK (last_payload_md5 ~ '^[0-9a-f]{32}$'),
  last_result              jsonb,
  last_writer_fence        bigint      NOT NULL CHECK (last_writer_fence >= 1),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, partition_kind, partition_key),
  CHECK (phase = 'reading' OR (members_count IS NOT NULL AND audiences IS NOT NULL AND pending_events = 0 AND pending_pieces = 0)),
  CHECK (phase <> 'complete' OR hashes_done = pg_catalog.jsonb_array_length(audiences)),
  CHECK (reload_calls = load_pages + 2 AND provisional_reload_calls = prov_pages + 2)
);
CREATE INDEX owner_inputs_keyset ON reporting_private.owner_inputs (batch_id, partition_kind COLLATE "C", partition_key COLLATE "C");
CREATE INDEX owner_inputs_site_batch ON reporting_private.owner_inputs (site, batch_id, handle);

CREATE TABLE reporting_private.owner_input_events (
  handle           bigint  NOT NULL REFERENCES reporting_private.owner_inputs (handle),
  ord              integer NOT NULL CHECK (ord BETWEEN 1 AND 51000),
  event_id         text    NOT NULL CHECK (event_id <> ''),
  pieces           integer NOT NULL CHECK (pieces BETWEEN 1 AND 33),
  text_bytes       integer NOT NULL CHECK (text_bytes BETWEEN 1 AND 1048576),
  text_sha256      text    NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  src_at           text    NOT NULL,
  stream_candidate boolean NOT NULL,
  staff_id         text,
  parent_id        text,
  department       text,
  committed        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (handle, ord),
  UNIQUE (handle, event_id)
);
CREATE INDEX owner_input_events_parent ON reporting_private.owner_input_events (handle, parent_id COLLATE "C") WHERE parent_id IS NOT NULL;

CREATE TABLE reporting_private.owner_input_pieces (
  handle     bigint  NOT NULL,
  ord        integer NOT NULL,
  piece_no   integer NOT NULL CHECK (piece_no BETWEEN 0 AND 32),
  piece      text    NOT NULL CHECK (piece <> ''),
  row_bytes  integer NOT NULL CHECK (row_bytes BETWEEN 1 AND 1048574),
  committed  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (handle, ord, piece_no),
  FOREIGN KEY (handle, ord) REFERENCES reporting_private.owner_input_events (handle, ord)
);
CREATE INDEX owner_input_pieces_pending ON reporting_private.owner_input_pieces (handle) WHERE NOT committed;

ALTER TABLE reporting_private.owner_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.owner_input_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_private.owner_input_pieces ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Private helpers
-- ---------------------------------------------------------------------------

-- The maximal piece bound: one piece's escaped JSON string literal (quotes included).
CREATE FUNCTION reporting_private.oi_escaped_len(p text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT pg_catalog.octet_length(pg_catalog.to_jsonb(p)::text)
$fn$;

-- Conservative accounted bytes of one event-loader row (jsonb::text adds a space after ':' and ',').
CREATE FUNCTION reporting_private.oi_row_bytes(p_ord integer, p_piece_no integer, p_pieces integer, p_event_id text, p_text_bytes integer, p_sha text, p_piece text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT pg_catalog.octet_length(pg_catalog.jsonb_build_object(
    'ord', p_ord, 'piece_no', p_piece_no, 'pieces', p_pieces, 'event_id', p_event_id,
    'text_bytes', p_text_bytes, 'text_sha256', p_sha, 'piece', p_piece, 'eof', false)::text)
$fn$;

-- The one greedy packer (<= 1,000 rows and <= 1,048,576 bytes per page, brackets and separators included).
CREATE FUNCTION reporting_private.oi_pack(p_pages integer, p_rows integer, p_bytes integer, p_row integer, OUT pages integer, OUT rows integer, OUT bytes integer)
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF p_rows = 0 OR p_rows >= 1000 OR p_bytes + 1 + p_row > 1048576 THEN
    pages := p_pages + 1; rows := 1; bytes := 2 + p_row;
  ELSE
    pages := p_pages; rows := p_rows + 1; bytes := p_bytes + 1 + p_row;
  END IF;
END
$fn$;

-- JavaScript String.prototype.trim() whitespace: empty after trimming WhiteSpace and LineTerminator code points.
CREATE FUNCTION reporting_private.oi_js_blank(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT p ~ E'^[\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$'
$fn$;

CREATE FUNCTION reporting_private.oi_is_int(v jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT pg_catalog.jsonb_typeof(v) = 'number' AND (v #>> '{}') ~ '^[0-9]{1,9}$'
$fn$;

-- Decimal-text bigint argument in [p_min, 9223372036854775807].
CREATE FUNCTION reporting_private.oi_bigint(p text, p_min bigint, p_what text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE v numeric;
BEGIN
  IF p IS NULL OR p !~ '^(0|[1-9][0-9]{0,18})$' THEN RAISE EXCEPTION 'owner_input_args: % must be decimal text', p_what; END IF;
  v := p::numeric;
  IF v < p_min OR v > 9223372036854775807 THEN RAISE EXCEPTION 'owner_input_args: % is out of range', p_what; END IF;
  RETURN v::bigint;
END
$fn$;

-- Gates (lock order control -> site -> batch via lock_batch; fence and live lease checked there).
CREATE FUNCTION reporting_private.oi_read_gate(p_batch uuid, p_fence bigint)
RETURNS reporting_private.batches
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE b reporting_private.batches;
BEGIN
  b := reporting_private.lock_batch(p_batch, p_fence, true);
  IF b.state <> 'frozen' THEN RAISE EXCEPTION 'owner_input_args: reporting batch % is %; owner inputs need a frozen batch', p_batch, b.state; END IF;
  RETURN b;
END
$fn$;

-- Write gate for a purpose: plan = frozen and unsealed (worker_batch); stage = frozen and sealed.
CREATE FUNCTION reporting_private.oi_write_gate(p_batch uuid, p_fence bigint, p_purpose text)
RETURNS reporting_private.batches
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE b reporting_private.batches;
BEGIN
  IF p_purpose = 'plan' THEN RETURN reporting_private.worker_batch(p_batch, p_fence, true); END IF;
  IF p_purpose <> 'stage' THEN RAISE EXCEPTION 'owner_input_args: purpose must be plan or stage'; END IF;
  b := reporting_private.oi_read_gate(p_batch, p_fence);
  IF b.sealed_at IS NULL THEN RAISE EXCEPTION 'owner_input_transition: stage writes need a sealed batch'; END IF;
  RETURN b;
END
$fn$;

-- The header of a handle that belongs to the batch (binding re-checked), locked or not.
CREATE FUNCTION reporting_private.oi_header(p_batch reporting_private.batches, p_handle bigint, p_lock boolean)
RETURNS reporting_private.owner_inputs
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE h reporting_private.owner_inputs;
BEGIN
  IF p_lock THEN SELECT * INTO h FROM reporting_private.owner_inputs x WHERE x.handle = p_handle FOR UPDATE;
  ELSE SELECT * INTO h FROM reporting_private.owner_inputs x WHERE x.handle = p_handle; END IF;
  IF NOT FOUND OR h.batch_id <> p_batch.batch_id THEN RAISE EXCEPTION 'owner_input_args: owner input % does not belong to batch %', p_handle, p_batch.batch_id; END IF;
  IF h.format_version <> 1 THEN RAISE EXCEPTION 'owner_input_format: unsupported format %', h.format_version; END IF;
  IF h.site <> p_batch.site OR h.source_cutoff <> p_batch.source_cutoff OR h.rule_version <> p_batch.rule_version THEN
    RAISE EXCEPTION 'owner_input_binding: owner input % no longer matches batch %', p_handle, p_batch.batch_id;
  END IF;
  RETURN h;
END
$fn$;

-- Committed member ids in bytewise order, as buildOwnerInput's frozen member set.
CREATE FUNCTION reporting_private.oi_member_ids(p_handle bigint, p_members integer)
RETURNS TABLE (event_id text, staff_id text, parent_id text, department text, stream_candidate boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT e.event_id, e.staff_id, e.parent_id, e.department, e.stream_candidate
    FROM reporting_private.owner_input_events e
   WHERE e.handle = p_handle AND e.committed AND e.ord <= p_members
   ORDER BY e.event_id COLLATE "C"
$fn$;

-- The frozen parent list: parents of members that are not members themselves, bytewise.
CREATE FUNCTION reporting_private.oi_parent_ids(p_handle bigint, p_members integer)
RETURNS TABLE (n integer, parent_id text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT (pg_catalog.row_number() OVER (ORDER BY q.parent_id COLLATE "C"))::integer - 1, q.parent_id
    FROM (SELECT DISTINCT m.parent_id FROM reporting_private.oi_member_ids(p_handle, p_members) m
           WHERE m.parent_id IS NOT NULL AND m.parent_id <> ''
             AND NOT EXISTS (SELECT 1 FROM reporting_private.oi_member_ids(p_handle, p_members) x WHERE x.event_id = m.parent_id)) q
$fn$;

-- Walk workers: staff of stream-candidate members, bytewise; with each worker's initial need.
CREATE FUNCTION reporting_private.oi_workers(p_handle bigint, p_members integer)
RETURNS TABLE (n integer, staff text, need jsonb)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT (pg_catalog.row_number() OVER (ORDER BY w.staff COLLATE "C"))::integer - 1, w.staff,
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t COLLATE "C") FROM (
            SELECT '*'::text AS t UNION
            SELECT m.department FROM reporting_private.oi_member_ids(p_handle, p_members) m
             WHERE m.stream_candidate AND m.staff_id = w.staff AND m.department IS NOT NULL) z)
    FROM (SELECT DISTINCT m.staff_id AS staff FROM reporting_private.oi_member_ids(p_handle, p_members) m WHERE m.stream_candidate) w
$fn$;

-- A sorted copy of a JSON string array (for need-set comparisons).
CREATE FUNCTION reporting_private.oi_sorted(p jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT coalesce(pg_catalog.jsonb_agg(d.x ORDER BY d.x COLLATE "C"), '[]'::jsonb) FROM (SELECT DISTINCT t.x FROM pg_catalog.jsonb_array_elements_text(p) t(x)) d
$fn$;

-- One committed event of the journal (NULL row when absent).
CREATE FUNCTION reporting_private.oi_event(p_handle bigint, p_ord integer)
RETURNS reporting_private.owner_input_events
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT e.* FROM reporting_private.owner_input_events e WHERE e.handle = p_handle AND e.ord = p_ord AND e.committed
$fn$;

-- Shape of one state (the r5 state union); raises owner_input_invalid.
CREATE FUNCTION reporting_private.oi_check_shape(s jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE st text; o jsonb; l jsonb;
BEGIN
  IF (pg_catalog.jsonb_typeof(s) <> 'object' OR s -> 'v' IS DISTINCT FROM '1'::jsonb) IS NOT FALSE THEN RAISE EXCEPTION 'owner_input_invalid: state must be an object with v 1'; END IF;
  st := s ->> 'step';
  IF st = 'members' THEN
    o := s -> 'm';
    IF ((SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(s) k) IS DISTINCT FROM ARRAY['m', 'step', 'v']
       OR pg_catalog.jsonb_typeof(o) <> 'object' OR (SELECT pg_catalog.array_agg(k) FROM pg_catalog.jsonb_object_keys(o) k) IS DISTINCT FROM ARRAY['afterOrd']
       OR NOT (o -> 'afterOrd' = 'null'::jsonb OR reporting_private.oi_is_int(o -> 'afterOrd'))) IS NOT FALSE THEN RAISE EXCEPTION 'owner_input_invalid: bad members state'; END IF;
  ELSIF st IN ('parents', 'children') THEN
    o := s -> CASE st WHEN 'parents' THEN 'p' ELSE 'c' END;
    IF ((SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(s) k) IS DISTINCT FROM ARRAY[CASE st WHEN 'parents' THEN 'p' ELSE 'c' END, 'step', 'v']
       OR pg_catalog.jsonb_typeof(o) <> 'object' OR (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(o) k) IS DISTINCT FROM ARRAY['afterOrd', 'group']
       OR NOT reporting_private.oi_is_int(o -> 'group')
       OR NOT (o -> 'afterOrd' = 'null'::jsonb OR reporting_private.oi_is_int(o -> 'afterOrd'))) IS NOT FALSE THEN RAISE EXCEPTION 'owner_input_invalid: bad % state', st; END IF;
  ELSIF st = 'walk' THEN
    o := s -> 'w';
    IF ((SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(s) k) IS DISTINCT FROM ARRAY['step', 'v', 'w']
       OR pg_catalog.jsonb_typeof(o) <> 'object'
       OR (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(o) k) IS DISTINCT FROM ARRAY['cursorOrd', 'line', 'need', 'stopAt', 'worker']
       OR NOT reporting_private.oi_is_int(o -> 'worker')
       OR NOT (o -> 'cursorOrd' = 'null'::jsonb OR reporting_private.oi_is_int(o -> 'cursorOrd'))
       OR NOT (o -> 'stopAt' = 'null'::jsonb OR (pg_catalog.jsonb_typeof(o -> 'stopAt') = 'string' AND (o ->> 'stopAt') ~ '^-?[0-9]{1,20}$'))
       OR pg_catalog.jsonb_typeof(o -> 'need') <> 'array'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(o -> 'need') e(x) WHERE NOT (x #>> '{}' IN ('*', 'a0_framed', 'framed', 'unframed', 'dispatch')) OR pg_catalog.jsonb_typeof(x) <> 'string')) IS NOT FALSE THEN
      RAISE EXCEPTION 'owner_input_invalid: bad walk state';
    END IF;
    l := o -> 'line';
    IF l <> 'null'::jsonb THEN
      IF (pg_catalog.jsonb_typeof(l) <> 'object' OR (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(l) k) IS DISTINCT FROM ARRAY['afterKidOrd', 'effective', 'ord', 'phase']
         OR NOT reporting_private.oi_is_int(l -> 'ord')
         OR NOT (l -> 'afterKidOrd' = 'null'::jsonb OR reporting_private.oi_is_int(l -> 'afterKidOrd'))
         OR NOT ((l ->> 'phase' = 'kids' AND l -> 'effective' = 'null'::jsonb) OR (l ->> 'phase' = 'done' AND pg_catalog.jsonb_typeof(l -> 'effective') = 'boolean'))) IS NOT FALSE THEN
        RAISE EXCEPTION 'owner_input_invalid: bad pending line';
      END IF;
    END IF;
  ELSIF st = 'done' THEN
    IF ((SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(s) k) IS DISTINCT FROM ARRAY['step', 'v']) IS NOT FALSE THEN RAISE EXCEPTION 'owner_input_invalid: bad done state'; END IF;
  ELSE
    RAISE EXCEPTION 'owner_input_invalid: unknown step %', pg_catalog.left(coalesce(st, '(null)'), 20);
  END IF;
  RETURN st;
END
$fn$;

-- One legal transition of the step graph (r6 R5, planner condition 2). Returns the new members_count.
CREATE FUNCTION reporting_private.oi_check_step(h reporting_private.owner_inputs, a jsonb, b jsonb, p_members integer)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  sa text := reporting_private.oi_check_shape(a);
  sb text := reporting_private.oi_check_shape(b);
  v_members integer := p_members;
  ga integer; gb integer; pg integer; cg integer; wc integer;
  e reporting_private.owner_input_events;
  ln reporting_private.owner_input_events;
  wa jsonb; wb jsonb; v_staff text; v_need jsonb;
BEGIN
  IF sa = 'members' AND sb = 'members' THEN
    IF b #> '{m,afterOrd}' <> 'null'::jsonb AND NOT EXISTS (
         SELECT 1 FROM reporting_private.owner_input_events x WHERE x.handle = h.handle AND x.committed AND x.ord = (b #>> '{m,afterOrd}')::integer) THEN
      RAISE EXCEPTION 'owner_input_invalid: the members cursor is not a committed member';
    END IF;
    RETURN v_members;
  END IF;
  IF sa = 'members' AND sb = 'parents' THEN
    IF v_members IS NOT NULL THEN RAISE EXCEPTION 'owner_input_transition: members_count is already set'; END IF;
    IF b -> 'p' <> '{"group": 0, "afterOrd": null}'::jsonb THEN RAISE EXCEPTION 'owner_input_transition: parents must start at group 0'; END IF;
    RETURN h.event_count;
  END IF;
  IF v_members IS NULL THEN RAISE EXCEPTION 'owner_input_transition: % before members are complete', sb; END IF;
  SELECT pg_catalog.count(*)::integer INTO pg FROM reporting_private.oi_parent_ids(h.handle, v_members);
  pg := (pg + 499) / 500;
  cg := (v_members + 999) / 1000;
  SELECT pg_catalog.count(*)::integer INTO wc FROM reporting_private.oi_workers(h.handle, v_members);
  IF sa = 'parents' AND sb = 'parents' THEN
    ga := (a #>> '{p,group}')::integer; gb := (b #>> '{p,group}')::integer;
    IF gb = ga THEN
      IF b #> '{p,afterOrd}' = 'null'::jsonb THEN RAISE EXCEPTION 'owner_input_transition: a parents page must advance its cursor'; END IF;
      e := reporting_private.oi_event(h.handle, (b #>> '{p,afterOrd}')::integer);
      IF e.event_id IS NULL OR NOT EXISTS (SELECT 1 FROM reporting_private.oi_parent_ids(h.handle, v_members) x WHERE x.parent_id = e.event_id AND x.n / 500 = ga) THEN
        RAISE EXCEPTION 'owner_input_invalid: the parents cursor is not a found parent of group %', ga;
      END IF;
      RETURN v_members;
    END IF;
    IF gb = ga + 1 AND gb < pg AND b #> '{p,afterOrd}' = 'null'::jsonb THEN RETURN v_members; END IF;
    RAISE EXCEPTION 'owner_input_transition: parents group % -> %', ga, gb;
  END IF;
  IF sa = 'parents' AND sb = 'children' THEN
    ga := (a #>> '{p,group}')::integer;
    IF NOT ((pg = 0 AND ga = 0) OR ga + 1 = pg) THEN RAISE EXCEPTION 'owner_input_transition: parent groups remain unread'; END IF;
    IF b -> 'c' <> '{"group": 0, "afterOrd": null}'::jsonb THEN RAISE EXCEPTION 'owner_input_transition: children must start at group 0'; END IF;
    RETURN v_members;
  END IF;
  IF sa = 'children' AND sb = 'children' THEN
    ga := (a #>> '{c,group}')::integer; gb := (b #>> '{c,group}')::integer;
    IF gb = ga THEN
      IF b #> '{c,afterOrd}' = 'null'::jsonb THEN RAISE EXCEPTION 'owner_input_transition: a children page must advance its cursor'; END IF;
      e := reporting_private.oi_event(h.handle, (b #>> '{c,afterOrd}')::integer);
      IF e.event_id IS NULL OR e.parent_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM (SELECT m.event_id, (pg_catalog.row_number() OVER (ORDER BY m.event_id COLLATE "C") - 1) AS n FROM reporting_private.oi_member_ids(h.handle, v_members) m) q
            WHERE q.event_id = e.parent_id AND q.n / 1000 = ga) THEN
        RAISE EXCEPTION 'owner_input_invalid: the children cursor is not a child of a member in group %', ga;
      END IF;
      RETURN v_members;
    END IF;
    IF gb = ga + 1 AND gb < cg AND b #> '{c,afterOrd}' = 'null'::jsonb THEN RETURN v_members; END IF;
    RAISE EXCEPTION 'owner_input_transition: children group % -> %', ga, gb;
  END IF;
  IF sa = 'children' AND sb IN ('walk', 'done') THEN
    ga := (a #>> '{c,group}')::integer;
    IF NOT ((cg = 0 AND ga = 0) OR ga + 1 = cg) THEN RAISE EXCEPTION 'owner_input_transition: child groups remain unread'; END IF;
    IF sb = 'done' THEN
      IF wc <> 0 THEN RAISE EXCEPTION 'owner_input_transition: walk workers remain'; END IF;
      RETURN v_members;
    END IF;
    IF wc = 0 THEN RAISE EXCEPTION 'owner_input_transition: there is no walk worker'; END IF;
    SELECT w.need INTO v_need FROM reporting_private.oi_workers(h.handle, v_members) w WHERE w.n = 0;
    IF b -> 'w' <> pg_catalog.jsonb_build_object('worker', 0, 'cursorOrd', NULL, 'stopAt', NULL, 'need', v_need, 'line', NULL)
       AND NOT (b #> '{w,worker}' = '0'::jsonb AND b #> '{w,cursorOrd}' = 'null'::jsonb AND b #> '{w,stopAt}' = 'null'::jsonb AND b #> '{w,line}' = 'null'::jsonb
                AND reporting_private.oi_sorted(b #> '{w,need}') = v_need) THEN
      RAISE EXCEPTION 'owner_input_transition: the first walk worker is not initialised as buildOwnerInput';
    END IF;
    RETURN v_members;
  END IF;
  IF sa = 'walk' THEN
    wa := a -> 'w';
    SELECT w.staff INTO v_staff FROM reporting_private.oi_workers(h.handle, v_members) w WHERE w.n = (wa ->> 'worker')::integer;
    IF v_staff IS NULL THEN RAISE EXCEPTION 'owner_input_invalid: walk worker out of range'; END IF;
    IF sb = 'done' THEN
      IF wa -> 'line' <> 'null'::jsonb OR (wa ->> 'worker')::integer + 1 <> wc THEN RAISE EXCEPTION 'owner_input_transition: the walk is not finished'; END IF;
      RETURN v_members;
    END IF;
    IF sb <> 'walk' THEN RAISE EXCEPTION 'owner_input_transition: walk -> %', sb; END IF;
    wb := b -> 'w';
    IF (wb ->> 'worker')::integer = (wa ->> 'worker')::integer + 1 THEN
      IF wa -> 'line' <> 'null'::jsonb OR (wb ->> 'worker')::integer >= wc THEN RAISE EXCEPTION 'owner_input_transition: next worker'; END IF;
      SELECT w.need INTO v_need FROM reporting_private.oi_workers(h.handle, v_members) w WHERE w.n = (wb ->> 'worker')::integer;
      IF NOT (wb -> 'cursorOrd' = 'null'::jsonb AND wb -> 'stopAt' = 'null'::jsonb AND wb -> 'line' = 'null'::jsonb AND reporting_private.oi_sorted(wb -> 'need') = v_need) THEN
        RAISE EXCEPTION 'owner_input_transition: the next walk worker is not initialised as buildOwnerInput';
      END IF;
      RETURN v_members;
    END IF;
    IF (wb ->> 'worker') <> (wa ->> 'worker') THEN RAISE EXCEPTION 'owner_input_transition: walk worker jump'; END IF;
    IF wa -> 'line' = 'null'::jsonb AND wb -> 'line' = 'null'::jsonb THEN
      -- a consumed non-candidate advances the cursor
      IF wb -> 'stopAt' <> wa -> 'stopAt' OR wb -> 'need' <> wa -> 'need' OR wb -> 'cursorOrd' = 'null'::jsonb THEN RAISE EXCEPTION 'owner_input_transition: non-candidate step'; END IF;
      e := reporting_private.oi_event(h.handle, (wb ->> 'cursorOrd')::integer);
      IF e.event_id IS NULL OR e.staff_id IS DISTINCT FROM v_staff THEN RAISE EXCEPTION 'owner_input_invalid: the walk cursor is not this worker''s event'; END IF;
      IF e.stream_candidate IS NOT FALSE THEN RAISE EXCEPTION 'owner_input_transition: a stream candidate is consumed only through a pending line'; END IF;
      RETURN v_members;
    END IF;
    IF wa -> 'line' = 'null'::jsonb THEN
      ln := reporting_private.oi_event(h.handle, (wb #>> '{line,ord}')::integer);
      IF NOT (wb #> '{line,phase}' = '"kids"'::jsonb AND wb #> '{line,afterKidOrd}' = 'null'::jsonb AND wb -> 'cursorOrd' = wa -> 'cursorOrd' AND wb -> 'stopAt' = wa -> 'stopAt' AND wb -> 'need' = wa -> 'need') THEN
        RAISE EXCEPTION 'owner_input_transition: a new pending line must start its kids';
      END IF;
      IF ln.event_id IS NULL OR ln.staff_id IS DISTINCT FROM v_staff OR NOT ln.stream_candidate THEN RAISE EXCEPTION 'owner_input_invalid: the pending line is not a stream candidate of this worker'; END IF;
      RETURN v_members;
    END IF;
    ln := reporting_private.oi_event(h.handle, (wa #>> '{line,ord}')::integer);
    IF wa #> '{line,phase}' = '"kids"'::jsonb THEN
      IF wb -> 'line' = 'null'::jsonb OR wb #> '{line,ord}' <> wa #> '{line,ord}' OR wb -> 'cursorOrd' <> wa -> 'cursorOrd' OR wb -> 'stopAt' <> wa -> 'stopAt' OR wb -> 'need' <> wa -> 'need' THEN
        RAISE EXCEPTION 'owner_input_transition: an unfinished line cannot be replaced';
      END IF;
      IF wb #> '{line,afterKidOrd}' <> 'null'::jsonb THEN
        e := reporting_private.oi_event(h.handle, (wb #>> '{line,afterKidOrd}')::integer);
        IF e.event_id IS NULL OR e.parent_id IS DISTINCT FROM ln.event_id THEN RAISE EXCEPTION 'owner_input_invalid: the kid cursor is not a child of the pending line'; END IF;
      END IF;
      IF wb #> '{line,phase}' = '"done"'::jsonb AND wb #> '{line,afterKidOrd}' <> wa #> '{line,afterKidOrd}' THEN RAISE EXCEPTION 'owner_input_transition: a line finishes without a new kid page'; END IF;
      RETURN v_members;
    END IF;
    -- a done line clears into the cursor; the stop rule may set stopAt / shrink need
    IF wb -> 'line' <> 'null'::jsonb OR (wb ->> 'cursorOrd') IS DISTINCT FROM (wa #>> '{line,ord}') THEN RAISE EXCEPTION 'owner_input_transition: a done line must move the cursor to itself'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(wb -> 'need') x WHERE NOT (wa -> 'need') ? x) THEN RAISE EXCEPTION 'owner_input_transition: need cannot grow'; END IF;
    IF wa -> 'stopAt' <> 'null'::jsonb AND wb -> 'stopAt' <> wa -> 'stopAt' THEN RAISE EXCEPTION 'owner_input_transition: stopAt is fixed once set'; END IF;
    RETURN v_members;
  END IF;
  RAISE EXCEPTION 'owner_input_transition: % -> %', sa, sb;
END
$fn$;

-- Insert one batch of piece entries (pending), strictly in (ord, piece_no) order. Updates the header row variable.
CREATE FUNCTION reporting_private.oi_insert_pieces(h reporting_private.owner_inputs, p_pieces jsonb)
RETURNS reporting_private.owner_inputs
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  x jsonb; m jsonb; v_ord integer; v_no integer; v_piece text; v_esc integer; v_prev text;
  cur reporting_private.owner_input_events; v_have integer; v_rb integer; v_pk record;
BEGIN
  IF p_pieces IS NULL OR pg_catalog.jsonb_typeof(p_pieces) <> 'array' THEN RAISE EXCEPTION 'owner_input_invalid: pieces must be an array'; END IF;
  FOR x IN SELECT e FROM pg_catalog.jsonb_array_elements(p_pieces) WITH ORDINALITY t(e, i) ORDER BY i LOOP
    IF pg_catalog.jsonb_typeof(x) <> 'array' OR pg_catalog.jsonb_array_length(x) NOT IN (3, 4)
       OR NOT reporting_private.oi_is_int(x -> 0) OR NOT reporting_private.oi_is_int(x -> 1) OR pg_catalog.jsonb_typeof(x -> 2) <> 'string' THEN
      RAISE EXCEPTION 'owner_input_invalid: a piece entry is [ord, piece_no, piece] or [ord, 0, piece, meta]';
    END IF;
    v_ord := (x ->> 0)::integer; v_no := (x ->> 1)::integer; v_piece := x ->> 2;
    IF v_piece = '' THEN RAISE EXCEPTION 'owner_input_invalid: empty piece'; END IF;
    v_esc := reporting_private.oi_escaped_len(v_piece);
    IF v_esc > 196608 THEN RAISE EXCEPTION 'owner_input_invalid: piece escaped literal is % bytes (max 196608)', v_esc; END IF;
    SELECT * INTO cur FROM reporting_private.owner_input_events e WHERE e.handle = h.handle AND NOT e.committed ORDER BY e.ord DESC LIMIT 1;
    IF cur.ord IS NOT NULL THEN SELECT pg_catalog.count(*)::integer INTO v_have FROM reporting_private.owner_input_pieces p WHERE p.handle = h.handle AND p.ord = cur.ord; END IF;
    IF v_no = 0 THEN
      IF cur.ord IS NOT NULL AND v_have < cur.pieces THEN RAISE EXCEPTION 'owner_input_invalid: event % is missing pieces before the next event', cur.ord; END IF;
      IF v_ord <> h.event_count + h.pending_events + 1 THEN RAISE EXCEPTION 'owner_input_invalid: new ordinal % is not contiguous (expected %)', v_ord, h.event_count + h.pending_events + 1; END IF;
      IF h.pending_events >= 1000 THEN RAISE EXCEPTION 'owner_input_invalid: more than 1000 pending events'; END IF;
      IF h.event_count + h.pending_events + 1 > 50000 THEN RAISE EXCEPTION 'owner_input_invalid: more than 50000 events'; END IF;
      IF pg_catalog.jsonb_array_length(x) <> 4 THEN RAISE EXCEPTION 'owner_input_invalid: the first piece carries the event metadata'; END IF;
      m := x -> 3;
      IF pg_catalog.jsonb_typeof(m) <> 'object'
         OR (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(m) k) IS DISTINCT FROM ARRAY['event_id', 'pieces', 'src_at', 'stream_candidate', 'text_bytes', 'text_sha256']
         OR pg_catalog.jsonb_typeof(m -> 'event_id') <> 'string' OR (m ->> 'event_id') = ''
         OR NOT reporting_private.oi_is_int(m -> 'pieces') OR (m ->> 'pieces')::integer NOT BETWEEN 1 AND 33
         OR NOT reporting_private.oi_is_int(m -> 'text_bytes') OR (m ->> 'text_bytes')::integer NOT BETWEEN 1 AND 1048576
         OR pg_catalog.jsonb_typeof(m -> 'text_sha256') <> 'string' OR (m ->> 'text_sha256') !~ '^[0-9a-f]{64}$'
         OR pg_catalog.jsonb_typeof(m -> 'src_at') <> 'string' OR pg_catalog.jsonb_typeof(m -> 'stream_candidate') <> 'boolean' THEN
        RAISE EXCEPTION 'owner_input_invalid: bad event metadata';
      END IF;
      IF (SELECT coalesce(pg_catalog.sum(e.text_bytes), 0) FROM reporting_private.owner_input_events e WHERE e.handle = h.handle AND NOT e.committed)
         + (m ->> 'text_bytes')::integer > 1048576 THEN
        RAISE EXCEPTION 'owner_input_invalid: the pending events exceed 1048576 text bytes (one source response)';
      END IF;
      IF EXISTS (SELECT 1 FROM reporting_private.owner_input_events e WHERE e.handle = h.handle AND e.event_id = m ->> 'event_id') THEN
        RAISE EXCEPTION 'owner_input_invalid: event id is already in the journal';
      END IF;
      INSERT INTO reporting_private.owner_input_events (handle, ord, event_id, pieces, text_bytes, text_sha256, src_at, stream_candidate, committed)
      VALUES (h.handle, v_ord, m ->> 'event_id', (m ->> 'pieces')::integer, (m ->> 'text_bytes')::integer, m ->> 'text_sha256', m ->> 'src_at', (m ->> 'stream_candidate')::boolean, false);
      h.pending_events := h.pending_events + 1;
      v_rb := reporting_private.oi_row_bytes(v_ord, 0, (m ->> 'pieces')::integer, m ->> 'event_id', (m ->> 'text_bytes')::integer, m ->> 'text_sha256', v_piece);
    ELSE
      IF cur.ord IS NULL OR v_ord <> cur.ord OR v_no <> v_have OR v_no >= cur.pieces OR pg_catalog.jsonb_array_length(x) <> 3 THEN
        RAISE EXCEPTION 'owner_input_invalid: piece %/% is not the next expected piece', v_ord, v_no;
      END IF;
      -- maximality of the previous piece: it could not take this piece's first code point
      SELECT p.piece INTO v_prev FROM reporting_private.owner_input_pieces p WHERE p.handle = h.handle AND p.ord = v_ord AND p.piece_no = v_no - 1;
      IF reporting_private.oi_escaped_len(v_prev || pg_catalog.left(v_piece, 1)) <= 196608 THEN
        RAISE EXCEPTION 'owner_input_invalid: piece %/% is not maximal', v_ord, v_no - 1;
      END IF;
      v_rb := reporting_private.oi_row_bytes(v_ord, v_no, NULL, NULL, NULL, NULL, v_piece);
    END IF;
    IF h.pending_pieces + 1 > 1033 OR h.pending_escaped_bytes + v_esc > 6303744 THEN RAISE EXCEPTION 'owner_input_invalid: the pending page exceeds its piece or byte bound'; END IF;
    INSERT INTO reporting_private.owner_input_pieces (handle, ord, piece_no, piece, row_bytes, committed) VALUES (h.handle, v_ord, v_no, v_piece, v_rb, false);
    h.pending_pieces := h.pending_pieces + 1;
    h.pending_escaped_bytes := h.pending_escaped_bytes + v_esc;
    SELECT * INTO v_pk FROM reporting_private.oi_pack(h.prov_pages, h.prov_rows, h.prov_bytes, v_rb);
    h.prov_pages := v_pk.pages; h.prov_rows := v_pk.rows; h.prov_bytes := v_pk.bytes;
    h.provisional_reload_calls := h.prov_pages + 2;
    IF h.provisional_reload_calls > 120 THEN h.heavy_proven := true; END IF;
  END LOOP;
  RETURN h;
END
$fn$;

-- Assemble and validate every pending event, then commit them (the page's final call).
CREATE FUNCTION reporting_private.oi_commit_pending(h reporting_private.owner_inputs)
RETURNS reporting_private.owner_inputs
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  e reporting_private.owner_input_events; v_text text; v_n integer; v_last text; ev jsonb; v_ok boolean; v_at timestamptz;
BEGIN
  FOR e IN SELECT * FROM reporting_private.owner_input_events x WHERE x.handle = h.handle AND NOT x.committed ORDER BY x.ord LOOP
    SELECT pg_catalog.count(*)::integer, pg_catalog.string_agg(p.piece, '' ORDER BY p.piece_no) INTO v_n, v_text
      FROM reporting_private.owner_input_pieces p WHERE p.handle = h.handle AND p.ord = e.ord;
    IF v_n <> e.pieces THEN RAISE EXCEPTION 'owner_input_invalid: event % has % of % pieces', e.ord, v_n, e.pieces; END IF;
    IF pg_catalog.octet_length(v_text) <> e.text_bytes THEN RAISE EXCEPTION 'owner_input_invalid: event % text length differs', e.ord; END IF;
    IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_text, 'UTF8')), 'hex') <> e.text_sha256 THEN RAISE EXCEPTION 'owner_input_invalid: event % text digest differs', e.ord; END IF;
    BEGIN
      ev := v_text::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'owner_input_invalid: event % is not JSON', e.ord;
    END;
    IF pg_catalog.jsonb_typeof(ev) <> 'object'
       OR (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(ev) k)
          IS DISTINCT FROM ARRAY['created_at', 'cs_case_id', 'department', 'event_type', 'id', 'line_quantity', 'line_sku', 'location', 'order_number', 'parent_event_id', 'staff_id'] THEN
      RAISE EXCEPTION 'owner_input_invalid: event % does not have exactly the 11 evidence fields', e.ord;
    END IF;
    IF ev ->> 'id' IS DISTINCT FROM e.event_id OR ev ->> 'location' IS DISTINCT FROM h.site OR ev ->> 'created_at' IS DISTINCT FROM e.src_at
       OR pg_catalog.jsonb_typeof(ev -> 'event_type') <> 'string' OR pg_catalog.jsonb_typeof(ev -> 'created_at') <> 'string' THEN
      RAISE EXCEPTION 'owner_input_invalid: event % identity, site or time differs from its metadata', e.ord;
    END IF;
    FOREACH v_last IN ARRAY ARRAY['staff_id', 'department', 'order_number', 'line_sku', 'parent_event_id', 'cs_case_id'] LOOP
      IF pg_catalog.jsonb_typeof(ev -> v_last) NOT IN ('string', 'null') THEN RAISE EXCEPTION 'owner_input_invalid: event % field % must be text or null', e.ord, v_last; END IF;
    END LOOP;
    -- the stream-candidate flag (adapter-computed streamLine) is re-checked where SQL can be exact
    IF e.stream_candidate THEN
      -- planner amendment to condition 2: independent checks only; SKU/Date.parse classification stays in TypeScript
      v_ok := pg_catalog.jsonb_typeof(ev -> 'event_type') = 'string' AND ev ->> 'event_type' = 'line_verified'
          AND pg_catalog.jsonb_typeof(ev -> 'id') = 'string' AND NOT reporting_private.oi_js_blank(ev ->> 'id')
          AND pg_catalog.jsonb_typeof(ev -> 'location') = 'string' AND NOT reporting_private.oi_js_blank(ev ->> 'location')
          AND pg_catalog.jsonb_typeof(ev -> 'staff_id') = 'string' AND NOT reporting_private.oi_js_blank(ev ->> 'staff_id')
          AND pg_catalog.jsonb_typeof(ev -> 'order_number') = 'string' AND NOT reporting_private.oi_js_blank(ev ->> 'order_number')
          AND pg_catalog.jsonb_typeof(ev -> 'department') = 'string' AND ev ->> 'department' IN ('a0_framed', 'framed', 'unframed', 'dispatch')
          AND pg_catalog.jsonb_typeof(ev -> 'line_sku') = 'string' AND ev ->> 'line_sku' <> '';
      IF v_ok AND (ev ->> 'created_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN
        BEGIN
          v_at := (ev ->> 'created_at')::timestamptz;
          v_ok := v_at <= h.source_cutoff;
        EXCEPTION WHEN others THEN NULL;
        END;
      END IF;
      IF v_ok IS NOT TRUE THEN RAISE EXCEPTION 'owner_input_invalid: event % cannot be a stream candidate', e.ord; END IF;
    END IF;
    UPDATE reporting_private.owner_input_events x
       SET committed = true, staff_id = ev ->> 'staff_id', parent_id = ev ->> 'parent_event_id', department = ev ->> 'department'
     WHERE x.handle = h.handle AND x.ord = e.ord;
  END LOOP;
  UPDATE reporting_private.owner_input_pieces p SET committed = true WHERE p.handle = h.handle AND NOT p.committed;
  h.event_count := h.event_count + h.pending_events;
  h.pending_events := 0; h.pending_pieces := 0; h.pending_escaped_bytes := 0;
  h.load_pages := h.prov_pages; h.page_rows := h.prov_rows; h.page_bytes := h.prov_bytes;
  h.reload_calls := h.load_pages + 2;
  RETURN h;
END
$fn$;

-- ---------------------------------------------------------------------------
-- Public RPCs (service-only)
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.reporting_owner_input_version()
RETURNS TABLE (version integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT 1
$fn$;

CREATE FUNCTION public.open_reporting_owner_input(p_batch uuid, p_fence bigint, p_kind text, p_key text, p_purpose text)
RETURNS TABLE (handle text, created boolean, phase text, seq text, reload_calls integer, provisional_reload_calls integer, heavy_proven boolean, pending_events integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b reporting_private.batches; h reporting_private.owner_inputs; v_new boolean := false;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('order', 'event') OR p_key IS NULL OR p_key = '' THEN RAISE EXCEPTION 'owner_input_args: bad owner'; END IF;
  b := reporting_private.oi_write_gate(p_batch, p_fence, p_purpose);
  IF NOT EXISTS (SELECT 1 FROM reporting_private.worker_owners o WHERE o.batch_id = p_batch AND o.partition_kind = p_kind AND o.partition_key = p_key) THEN
    RAISE EXCEPTION 'owner_input_args: owner was not discovered for batch %', p_batch;
  END IF;
  IF p_purpose = 'stage' AND NOT EXISTS (SELECT 1 FROM reporting_private.partition_work w WHERE w.batch_id = p_batch AND w.partition_kind = p_kind AND w.partition_key = p_key) THEN
    RAISE EXCEPTION 'owner_input_args: owner has no sealed work in batch %', p_batch;
  END IF;
  SELECT * INTO h FROM reporting_private.owner_inputs x WHERE x.batch_id = p_batch AND x.partition_kind = p_kind AND x.partition_key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO reporting_private.owner_inputs (batch_id, partition_kind, partition_key, site, source_cutoff, rule_version, purpose, state, last_writer_fence)
    VALUES (p_batch, p_kind, p_key, b.site, b.source_cutoff, b.rule_version, p_purpose, '{"v": 1, "step": "members", "m": {"afterOrd": null}}'::jsonb, p_fence)
    RETURNING * INTO h;
    v_new := true;
  ELSE
    h := reporting_private.oi_header(b, h.handle, true);
  END IF;
  RETURN QUERY SELECT h.handle::text, v_new, h.phase, h.seq::text, h.reload_calls, h.provisional_reload_calls, h.heavy_proven, h.pending_events;
END
$fn$;

CREATE FUNCTION public.lookup_reporting_owner_inputs(p_batch uuid, p_fence bigint, p_owners jsonb)
RETURNS TABLE (idx integer, handle text, phase text, seq text, purpose text, reload_calls integer, provisional_reload_calls integer, heavy_proven boolean, pending_events integer, old_staff_count integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE b reporting_private.batches;
BEGIN
  IF (p_owners IS NULL OR pg_catalog.jsonb_typeof(p_owners) <> 'array' OR pg_catalog.jsonb_array_length(p_owners) NOT BETWEEN 1 AND 100
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_owners) e(v)
                 WHERE (pg_catalog.jsonb_typeof(v) <> 'array' OR pg_catalog.jsonb_array_length(v) <> 2
                    OR pg_catalog.jsonb_typeof(v -> 0) IS DISTINCT FROM 'string' OR v ->> 0 NOT IN ('order', 'event')
                    OR pg_catalog.jsonb_typeof(v -> 1) IS DISTINCT FROM 'string' OR v ->> 1 = '') IS NOT FALSE)) IS NOT FALSE THEN
    RAISE EXCEPTION 'owner_input_args: 1..100 [kind, key] owners are required';
  END IF;
  b := reporting_private.oi_read_gate(p_batch, p_fence);
  RETURN QUERY
  SELECT (t.i - 1)::integer, x.handle::text, x.phase, x.seq::text, x.purpose, x.reload_calls, x.provisional_reload_calls, x.heavy_proven, x.pending_events,
         coalesce((SELECT pg_catalog.cardinality(o.old_staff) FROM reporting_private.worker_owners o WHERE o.batch_id = p_batch AND o.partition_kind = t.v ->> 0 AND o.partition_key = t.v ->> 1), 0)::integer
    FROM pg_catalog.jsonb_array_elements(p_owners) WITH ORDINALITY t(v, i)
    LEFT JOIN reporting_private.owner_inputs x ON x.batch_id = p_batch AND x.partition_kind = t.v ->> 0 AND x.partition_key = t.v ->> 1
   ORDER BY t.i;
END
$fn$;

CREATE FUNCTION public.read_reporting_owner_old_staff(p_batch uuid, p_fence bigint, p_kind text, p_key text, p_after uuid DEFAULT NULL, p_limit integer DEFAULT 1000)
RETURNS TABLE (staff uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE b reporting_private.batches;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'owner_input_args: p_limit must be 1..1000'; END IF;
  b := reporting_private.oi_read_gate(p_batch, p_fence);
  IF NOT EXISTS (SELECT 1 FROM reporting_private.worker_owners o WHERE o.batch_id = p_batch AND o.partition_kind = p_kind AND o.partition_key = p_key) THEN
    RAISE EXCEPTION 'owner_input_args: owner was not discovered for batch %', p_batch;
  END IF;
  RETURN QUERY SELECT s.staff FROM reporting_private.worker_owners o, pg_catalog.unnest(o.old_staff) s(staff)
                WHERE o.batch_id = p_batch AND o.partition_kind = p_kind AND o.partition_key = p_key AND (p_after IS NULL OR s.staff > p_after)
                ORDER BY s.staff LIMIT p_limit;
END
$fn$;

CREATE FUNCTION public.load_reporting_owner_input_header(p_batch uuid, p_fence bigint, p_handle text)
RETURNS TABLE (phase text, purpose text, seq text, state jsonb, members_count integer, event_count integer, pending_events integer, pending_pieces integer,
               audiences jsonb, hashes_done integer, input_hashes jsonb, reload_calls integer, provisional_reload_calls integer, heavy_proven boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE b reporting_private.batches; h reporting_private.owner_inputs;
BEGIN
  b := reporting_private.oi_read_gate(p_batch, p_fence);
  h := reporting_private.oi_header(b, reporting_private.oi_bigint(p_handle, 1, 'p_handle'), false);
  RETURN QUERY SELECT h.phase, h.purpose, h.seq::text, h.state, h.members_count, h.event_count, h.pending_events, h.pending_pieces,
                      h.audiences, h.hashes_done, h.input_hashes, h.reload_calls, h.provisional_reload_calls, h.heavy_proven;
END
$fn$;

-- Committed pieces after (p_after_ord, p_after_piece), packed exactly as the maintained packer; a lone eof row ends.
CREATE FUNCTION public.load_reporting_owner_input_events(p_batch uuid, p_fence bigint, p_handle text, p_seq text, p_after_ord integer DEFAULT 0, p_after_piece integer DEFAULT -1)
RETURNS TABLE (ord integer, piece_no integer, pieces integer, event_id text, text_bytes integer, text_sha256 text, piece text, eof boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b reporting_private.batches; h reporting_private.owner_inputs; r record; v_rows integer := 0; v_bytes integer := 2; v_any boolean := false;
BEGIN
  IF p_after_ord IS NULL OR p_after_ord < 0 OR p_after_piece IS NULL OR p_after_piece < -1 THEN RAISE EXCEPTION 'owner_input_args: bad event cursor'; END IF;
  b := reporting_private.oi_read_gate(p_batch, p_fence);
  h := reporting_private.oi_header(b, reporting_private.oi_bigint(p_handle, 1, 'p_handle'), false);
  IF h.seq <> reporting_private.oi_bigint(p_seq, 0, 'p_seq') THEN RAISE EXCEPTION 'owner_input_snapshot: the journal advanced to seq %', h.seq; END IF;
  FOR r IN SELECT p.ord, p.piece_no, p.piece, p.row_bytes, e.pieces, e.event_id, e.text_bytes, e.text_sha256
             FROM reporting_private.owner_input_pieces p JOIN reporting_private.owner_input_events e ON e.handle = p.handle AND e.ord = p.ord
            WHERE p.handle = h.handle AND p.committed AND (p.ord, p.piece_no) > (p_after_ord, p_after_piece)
            ORDER BY p.ord, p.piece_no LOOP
    EXIT WHEN v_rows >= 1000 OR (v_rows > 0 AND v_bytes + 1 + r.row_bytes > 1048576);
    v_bytes := v_bytes + CASE WHEN v_rows > 0 THEN 1 ELSE 0 END + r.row_bytes;
    v_rows := v_rows + 1;
    v_any := true;
    RETURN QUERY SELECT r.ord, r.piece_no,
                        CASE WHEN r.piece_no = 0 THEN r.pieces END, CASE WHEN r.piece_no = 0 THEN r.event_id END,
                        CASE WHEN r.piece_no = 0 THEN r.text_bytes END, CASE WHEN r.piece_no = 0 THEN r.text_sha256 END,
                        r.piece, false;
  END LOOP;
  IF NOT v_any THEN RETURN QUERY SELECT NULL::integer, NULL::integer, NULL::integer, NULL::text, NULL::integer, NULL::text, NULL::text, true; END IF;
END
$fn$;

CREATE FUNCTION public.checkpoint_reporting_owner_input(p_batch uuid, p_fence bigint, p_handle text, p_expected_seq text, p_payload jsonb)
RETURNS TABLE (seq text, event_count integer, pending_events integer, pending_pieces integer, reload_calls integer, provisional_reload_calls integer, heavy boolean, replay boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  b reporting_private.batches; h reporting_private.owner_inputs; v_handle bigint; v_expected bigint; v_md5 text; v_kind text;
  v_purpose text; v_steps jsonb; s jsonb; v_prev jsonb; v_members integer; v_aud jsonb; v_exp jsonb; x jsonb; v_i integer; v_bad text;
BEGIN
  v_handle := reporting_private.oi_bigint(p_handle, 1, 'p_handle');
  v_expected := reporting_private.oi_bigint(p_expected_seq, 0, 'p_expected_seq');
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'owner_input_invalid: payload must be an object'; END IF;
  v_kind := p_payload ->> 'kind';
  IF v_kind IS NULL OR v_kind NOT IN ('pieces', 'page', 'discard_pending', 'hash') THEN RAISE EXCEPTION 'owner_input_invalid: unknown payload kind'; END IF;
  -- purpose from the batch's seal state (unsealed -> plan, sealed -> stage); the gate checks fence and lease
  b := reporting_private.oi_read_gate(p_batch, p_fence);
  v_purpose := CASE WHEN b.sealed_at IS NULL THEN 'plan' ELSE 'stage' END;
  b := reporting_private.oi_write_gate(p_batch, p_fence, v_purpose);
  h := reporting_private.oi_header(b, v_handle, true);
  v_md5 := pg_catalog.md5(p_payload::text);
  -- identical replay of the last applied call (also of the final hash call of a complete journal)
  IF h.seq = v_expected + 1 AND h.last_payload_md5 = v_md5 AND h.last_result IS NOT NULL THEN
    RETURN QUERY SELECT h.last_result ->> 'seq', (h.last_result ->> 'event_count')::integer, (h.last_result ->> 'pending_events')::integer,
                        (h.last_result ->> 'pending_pieces')::integer, (h.last_result ->> 'reload_calls')::integer,
                        (h.last_result ->> 'provisional_reload_calls')::integer, (h.last_result ->> 'heavy')::boolean, true;
    RETURN;
  END IF;
  IF h.phase = 'complete' THEN RAISE EXCEPTION 'owner_input_transition: a complete journal is immutable'; END IF;
  IF h.seq <> v_expected THEN RAISE EXCEPTION 'owner_input_conflict: expected seq %, found %', v_expected, h.seq; END IF;
  IF h.heavy_proven THEN RAISE EXCEPTION 'owner_input_transition: the journal is proven too heavy; no further writes'; END IF;
  IF h.purpose = 'plan' AND v_purpose = 'stage' THEN h.purpose := 'stage'; END IF;   -- the single legal upgrade, under the stage gate
  IF h.purpose = 'stage' AND v_purpose = 'plan' THEN RAISE EXCEPTION 'owner_input_transition: a stage journal on an unsealed batch'; END IF;

  IF v_kind IN ('pieces', 'page', 'discard_pending') AND h.phase <> 'reading' THEN RAISE EXCEPTION 'owner_input_transition: % needs phase reading', v_kind; END IF;

  IF v_kind = 'pieces' THEN
    IF ((SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(p_payload) k) IS DISTINCT FROM ARRAY['kind', 'pieces']
        OR pg_catalog.jsonb_typeof(p_payload -> 'pieces') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_payload -> 'pieces') < 1) IS NOT FALSE THEN
      RAISE EXCEPTION 'owner_input_invalid: a pieces payload is {kind, pieces[1..]}';
    END IF;
    h := reporting_private.oi_insert_pieces(h, p_payload -> 'pieces');
  ELSIF v_kind = 'page' THEN
    IF (EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) k WHERE k NOT IN ('kind', 'pieces', 'steps', 'members_count'))
       OR pg_catalog.jsonb_typeof(p_payload -> 'steps') IS DISTINCT FROM 'array'
       OR (p_payload ? 'pieces' AND pg_catalog.jsonb_typeof(p_payload -> 'pieces') IS DISTINCT FROM 'array')
       OR (p_payload ? 'members_count' AND NOT reporting_private.oi_is_int(p_payload -> 'members_count'))
       OR pg_catalog.jsonb_array_length(p_payload -> 'steps') < 1
       OR pg_catalog.jsonb_array_length(p_payload -> 'steps') > 1100) IS NOT FALSE THEN
      RAISE EXCEPTION 'owner_input_invalid: a page payload is {kind, pieces?, steps[1..1100], members_count?}';
    END IF;
    IF p_payload ? 'pieces' THEN h := reporting_private.oi_insert_pieces(h, p_payload -> 'pieces'); END IF;
    IF NOT h.heavy_proven THEN
      h := reporting_private.oi_commit_pending(h);
      v_prev := h.state;
      v_members := h.members_count;
      FOR s IN SELECT e FROM pg_catalog.jsonb_array_elements(p_payload -> 'steps') WITH ORDINALITY t(e, i) ORDER BY i LOOP
        v_members := reporting_private.oi_check_step(h, v_prev, s, v_members);
        v_prev := s;
      END LOOP;
      IF p_payload ? 'members_count' AND (p_payload -> 'members_count') IS DISTINCT FROM pg_catalog.to_jsonb(v_members) THEN
        RAISE EXCEPTION 'owner_input_invalid: members_count does not match the journal';
      END IF;
      h.members_count := v_members;
      h.state := v_prev;
    END IF;
  ELSIF v_kind = 'discard_pending' THEN
    IF p_payload <> '{"kind": "discard_pending"}'::jsonb THEN RAISE EXCEPTION 'owner_input_invalid: discard_pending has no fields'; END IF;
    DELETE FROM reporting_private.owner_input_pieces p WHERE p.handle = h.handle AND NOT p.committed;
    DELETE FROM reporting_private.owner_input_events e WHERE e.handle = h.handle AND NOT e.committed;
    h.pending_events := 0; h.pending_pieces := 0; h.pending_escaped_bytes := 0;
    h.prov_pages := h.load_pages; h.prov_rows := h.page_rows; h.prov_bytes := h.page_bytes; h.provisional_reload_calls := h.reload_calls;
  ELSE -- hash
    IF h.state <> '{"v": 1, "step": "done"}'::jsonb OR h.pending_events <> 0 THEN RAISE EXCEPTION 'owner_input_transition: hashing needs a finished input'; END IF;
    IF h.phase = 'reading' THEN
      IF NOT p_payload ? 'audiences' THEN RAISE EXCEPTION 'owner_input_invalid: the first hash call carries the audience list'; END IF;
      -- the exact audience set: site + distinct member staff + every worker_owners.old_staff, self bytewise
      SELECT pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('audienceKind', 'site', 'audienceStaff', NULL))
             || coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('audienceKind', 'self', 'audienceStaff', z.s) ORDER BY z.s COLLATE "C"), '[]'::jsonb)
        INTO v_exp
        FROM (SELECT m.staff_id AS s FROM reporting_private.oi_member_ids(h.handle, h.members_count) m WHERE m.staff_id IS NOT NULL AND m.staff_id <> ''
              UNION
              SELECT u::text FROM reporting_private.worker_owners o, pg_catalog.unnest(o.old_staff) u
               WHERE o.batch_id = h.batch_id AND o.partition_kind = h.partition_kind AND o.partition_key = h.partition_key) z;
      IF pg_catalog.jsonb_array_length(v_exp) > 1000 THEN RAISE EXCEPTION 'owner_input_invalid: more than 1000 descriptors for one owner'; END IF;
      IF (p_payload -> 'audiences') IS DISTINCT FROM v_exp THEN RAISE EXCEPTION 'owner_input_invalid: the audience list is not the required set'; END IF;
      h.audiences := v_exp;
      h.phase := 'hashing';
    ELSIF p_payload ? 'audiences' THEN
      RAISE EXCEPTION 'owner_input_invalid: audiences are set only once';
    END IF;
    IF (EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) k WHERE k NOT IN ('kind', 'audiences', 'hashes'))
       OR pg_catalog.jsonb_typeof(p_payload -> 'hashes') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_payload -> 'hashes') NOT BETWEEN 1 AND 100
       OR h.hashes_done + pg_catalog.jsonb_array_length(p_payload -> 'hashes') > pg_catalog.jsonb_array_length(h.audiences)) IS NOT FALSE THEN
      RAISE EXCEPTION 'owner_input_invalid: hashes must be the next 1..100 audiences';
    END IF;
    v_i := h.hashes_done;
    FOR x IN SELECT e FROM pg_catalog.jsonb_array_elements(p_payload -> 'hashes') WITH ORDINALITY t(e, i) ORDER BY i LOOP
      v_aud := h.audiences -> v_i;
      IF (pg_catalog.jsonb_typeof(x) <> 'object' OR (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(x) k) IS DISTINCT FROM ARRAY['audienceKind', 'audienceStaff', 'inputHash']
         OR x -> 'audienceKind' IS DISTINCT FROM v_aud -> 'audienceKind' OR x -> 'audienceStaff' IS DISTINCT FROM v_aud -> 'audienceStaff'
         OR pg_catalog.jsonb_typeof(x -> 'inputHash') IS DISTINCT FROM 'string' OR (x ->> 'inputHash') !~ '^[0-9a-f]{64}$') IS NOT FALSE THEN
        RAISE EXCEPTION 'owner_input_invalid: hash % is not the next audience', v_i;
      END IF;
      SELECT w.input_hash INTO v_bad FROM reporting_private.partition_work w
       WHERE w.batch_id = h.batch_id AND w.partition_kind = h.partition_kind AND w.partition_key = h.partition_key
         AND w.audience_kind = x ->> 'audienceKind' AND w.audience_staff IS NOT DISTINCT FROM (x ->> 'audienceStaff')::uuid;
      IF FOUND AND v_bad <> x ->> 'inputHash' THEN RAISE EXCEPTION 'owner_input_invalid: hash % differs from the sealed work', v_i; END IF;
      v_i := v_i + 1;
    END LOOP;
    h.input_hashes := h.input_hashes || (p_payload -> 'hashes');
    h.hashes_done := v_i;
    IF v_i = pg_catalog.jsonb_array_length(h.audiences) THEN h.phase := 'complete'; END IF;
  END IF;

  h.seq := h.seq + 1;
  h.last_payload_md5 := v_md5;
  h.last_writer_fence := p_fence;
  h.last_result := pg_catalog.jsonb_build_object('seq', h.seq::text, 'event_count', h.event_count, 'pending_events', h.pending_events, 'pending_pieces', h.pending_pieces,
                                                 'reload_calls', h.reload_calls, 'provisional_reload_calls', h.provisional_reload_calls, 'heavy', h.heavy_proven);
  UPDATE reporting_private.owner_inputs x SET
    purpose = h.purpose, phase = h.phase, seq = h.seq, state = h.state, members_count = h.members_count, event_count = h.event_count,
    pending_events = h.pending_events, pending_pieces = h.pending_pieces, pending_escaped_bytes = h.pending_escaped_bytes,
    audiences = h.audiences, hashes_done = h.hashes_done, input_hashes = h.input_hashes,
    load_pages = h.load_pages, page_rows = h.page_rows, page_bytes = h.page_bytes, reload_calls = h.reload_calls,
    prov_pages = h.prov_pages, prov_rows = h.prov_rows, prov_bytes = h.prov_bytes, provisional_reload_calls = h.provisional_reload_calls,
    heavy_proven = h.heavy_proven, last_payload_md5 = h.last_payload_md5, last_result = h.last_result, last_writer_fence = h.last_writer_fence, updated_at = now()
   WHERE x.handle = h.handle;
  RETURN QUERY SELECT h.seq::text, h.event_count, h.pending_events, h.pending_pieces, h.reload_calls, h.provisional_reload_calls, h.heavy_proven, false;
END
$fn$;

CREATE FUNCTION public.read_reporting_staged_chunks(p_batch uuid, p_fence bigint, p_work_ids text[], p_after_work text DEFAULT NULL, p_after_chunk integer DEFAULT NULL, p_limit integer DEFAULT 1000)
RETURNS TABLE (work_id text, chunk_no integer, chunk_hash text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE b reporting_private.batches; v_ids bigint[]; v_after bigint;
BEGIN
  IF p_work_ids IS NULL OR pg_catalog.cardinality(p_work_ids) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'owner_input_args: 1..100 work ids are required'; END IF;
  IF (p_after_work IS NULL) <> (p_after_chunk IS NULL) OR (p_after_chunk IS NOT NULL AND p_after_chunk < 0) THEN RAISE EXCEPTION 'owner_input_args: the chunk cursor is paired and nonnegative'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'owner_input_args: p_limit must be 1..1000'; END IF;
  SELECT pg_catalog.array_agg(reporting_private.oi_bigint(x, 1, 'work id')) INTO v_ids FROM pg_catalog.unnest(p_work_ids) x;
  IF (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(v_ids) x) <> pg_catalog.cardinality(v_ids) THEN RAISE EXCEPTION 'owner_input_args: duplicate work id'; END IF;
  v_after := CASE WHEN p_after_work IS NULL THEN NULL ELSE reporting_private.oi_bigint(p_after_work, 1, 'p_after_work') END;
  b := reporting_private.oi_read_gate(p_batch, p_fence);
  IF b.sealed_at IS NULL THEN RAISE EXCEPTION 'owner_input_args: staged chunks are read from a sealed batch'; END IF;
  IF (SELECT pg_catalog.count(*) FROM reporting_private.partition_work w WHERE w.batch_id = p_batch AND w.work_id = ANY (v_ids)) <> pg_catalog.cardinality(v_ids) THEN
    RAISE EXCEPTION 'owner_input_args: a work id is not in batch %', p_batch;
  END IF;
  RETURN QUERY SELECT r.work_id::text, r.chunk_no, r.chunk_hash FROM reporting_private.partition_results r
                WHERE r.work_id = ANY (v_ids) AND (v_after IS NULL OR (r.work_id, r.chunk_no) > (v_after, p_after_chunk))
                ORDER BY r.work_id, r.chunk_no LIMIT p_limit;
END
$fn$;

-- Published-journal housekeeping: bounded candidates (20) and locks; one aggregate deletion budget.
CREATE FUNCTION public.release_reporting_owner_inputs(p_site text, p_limit integer DEFAULT 5000)
RETURNS TABLE (deleted integer, more boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_left integer; v_n integer; c record; v_del integer := 0;
BEGIN
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN RAISE EXCEPTION 'owner_input_args: unsupported site'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'owner_input_args: p_limit must be 1..10000'; END IF;
  PERFORM 1 FROM reporting_private.control x WHERE x.singleton FOR SHARE;
  PERFORM 1 FROM reporting_private.site_state s WHERE s.site = p_site FOR UPDATE;
  v_left := p_limit;
  PERFORM 1 FROM reporting_private.batches b
   WHERE b.batch_id IN (SELECT q.batch_id FROM (
           SELECT x.batch_id FROM reporting_private.owner_inputs x
             JOIN reporting_private.batches b2 ON b2.batch_id = x.batch_id AND b2.site = p_site AND b2.state = 'published'
             JOIN reporting_private.generations g ON g.generation_id = b2.published_generation_id AND g.site = p_site AND g.state IN ('published', 'superseded', 'expired')
            WHERE x.site = p_site ORDER BY x.site, x.batch_id, x.handle LIMIT 20) q)
   ORDER BY b.batch_id FOR UPDATE;
  FOR c IN SELECT x.handle FROM reporting_private.owner_inputs x
             JOIN reporting_private.batches b ON b.batch_id = x.batch_id AND b.site = p_site AND b.state = 'published'
             JOIN reporting_private.generations g ON g.generation_id = b.published_generation_id AND g.site = p_site AND g.state IN ('published', 'superseded', 'expired')
            WHERE x.site = p_site ORDER BY x.site, x.batch_id, x.handle LIMIT 20 LOOP
    EXIT WHEN v_left <= 0;
    DELETE FROM reporting_private.owner_input_pieces p WHERE (p.handle, p.ord, p.piece_no) IN (
      SELECT y.handle, y.ord, y.piece_no FROM reporting_private.owner_input_pieces y WHERE y.handle = c.handle ORDER BY y.ord, y.piece_no LIMIT v_left);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    EXIT WHEN v_left <= 0;
    IF NOT EXISTS (SELECT 1 FROM reporting_private.owner_input_pieces y WHERE y.handle = c.handle) THEN
      DELETE FROM reporting_private.owner_input_events e WHERE (e.handle, e.ord) IN (
        SELECT y.handle, y.ord FROM reporting_private.owner_input_events y WHERE y.handle = c.handle ORDER BY y.ord LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    EXIT WHEN v_left <= 0;
    IF NOT EXISTS (SELECT 1 FROM reporting_private.owner_input_events y WHERE y.handle = c.handle) THEN
      DELETE FROM reporting_private.owner_inputs x WHERE x.handle = c.handle;
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_del, EXISTS (
    SELECT 1 FROM reporting_private.owner_inputs x
      JOIN reporting_private.batches b ON b.batch_id = x.batch_id AND b.site = p_site AND b.state = 'published'
      JOIN reporting_private.generations g ON g.generation_id = b.published_generation_id AND g.site = p_site AND g.state IN ('published', 'superseded', 'expired')
     WHERE x.site = p_site LIMIT 1);
END
$fn$;

-- ---------------------------------------------------------------------------
-- Grants: tables and every function service-only
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE reporting_private.owner_inputs, reporting_private.owner_input_events, reporting_private.owner_input_pieces FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reporting_private.owner_inputs, reporting_private.owner_input_events, reporting_private.owner_input_pieces TO service_role;

REVOKE ALL ON FUNCTION reporting_private.oi_escaped_len(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_row_bytes(integer, integer, integer, text, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_pack(integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_js_blank(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_is_int(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_bigint(text, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_read_gate(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_write_gate(uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_header(reporting_private.batches, bigint, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_member_ids(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_parent_ids(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_workers(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_sorted(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_event(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_check_shape(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_check_step(reporting_private.owner_inputs, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_insert_pieces(reporting_private.owner_inputs, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reporting_private.oi_commit_pending(reporting_private.owner_inputs) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reporting_owner_input_version() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_reporting_owner_input(uuid, bigint, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lookup_reporting_owner_inputs(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_reporting_owner_old_staff(uuid, bigint, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_reporting_owner_input_header(uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_reporting_owner_input_events(uuid, bigint, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkpoint_reporting_owner_input(uuid, bigint, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_reporting_staged_chunks(uuid, bigint, text[], text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_reporting_owner_inputs(text, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION reporting_private.oi_escaped_len(text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_row_bytes(integer, integer, integer, text, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_pack(integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_js_blank(text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_is_int(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_bigint(text, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_read_gate(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_write_gate(uuid, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_header(reporting_private.batches, bigint, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_member_ids(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_parent_ids(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_workers(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_sorted(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_event(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_check_shape(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_check_step(reporting_private.owner_inputs, jsonb, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_insert_pieces(reporting_private.owner_inputs, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION reporting_private.oi_commit_pending(reporting_private.owner_inputs) TO service_role;
GRANT EXECUTE ON FUNCTION public.reporting_owner_input_version() TO service_role;
GRANT EXECUTE ON FUNCTION public.open_reporting_owner_input(uuid, bigint, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.lookup_reporting_owner_inputs(uuid, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_reporting_owner_old_staff(uuid, bigint, text, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_reporting_owner_input_header(uuid, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_reporting_owner_input_events(uuid, bigint, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_reporting_owner_input(uuid, bigint, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_reporting_staged_chunks(uuid, bigint, text[], text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_reporting_owner_inputs(text, integer) TO service_role;
