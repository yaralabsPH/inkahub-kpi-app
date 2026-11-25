-- 0058_frame_timing.sql
--
-- F9 Frame timing (append-only after 0057; 0048-0051 stay reserved for F3).
--
-- 1. public.frame_timing_weight_versions: immutable per-site size-weight
--    versions for the Max-method estimate. Defaults are NONE (no row): nothing
--    is invented. Rows are never updated or deleted; a save inserts the next
--    version only when the caller saw the current one (optimistic concurrency).
--    No direct table access for app roles: owners use the two RPCs below
--    (SECURITY DEFINER, owner role from public.profiles, never user metadata).
-- 2. public.read_frame_timing_rows: service-only. The verification and clock
--    rows of ONE pinned generation (checked_generation), for a server-chosen
--    audience, for whole production days: verifications from sel_eval (F1
--    effective state, timing_weight pieces, rework) with the event's recorded
--    F5 department from source_versions at the SAME sequence; clock events
--    from the same source_versions images. The API computes the complete
--    worker/day streams from these rows before any filter. Refuses (never
--    truncates) above p_row_limit; at most 731 dates. Writes nothing.

BEGIN;

CREATE TABLE public.frame_timing_weight_versions (
  site        text        NOT NULL CHECK (site IN ('au', 'uk', 'us')),
  version     integer     NOT NULL CHECK (version >= 1),
  weights     jsonb       NOT NULL CHECK (pg_catalog.jsonb_typeof(weights) = 'object'),
  created_by  uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (site, version)
);
ALTER TABLE public.frame_timing_weight_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.frame_timing_weight_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.frame_timing_weight_versions TO service_role;

-- Immutable: no UPDATE or DELETE, even for privileged callers through the API.
CREATE FUNCTION public.frame_timing_weights_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  RAISE EXCEPTION 'frame timing weight versions are immutable';
END
$fn$;
CREATE TRIGGER frame_timing_weight_versions_immutable BEFORE UPDATE OR DELETE ON public.frame_timing_weight_versions
  FOR EACH ROW EXECUTE FUNCTION public.frame_timing_weights_immutable();
REVOKE ALL ON FUNCTION public.frame_timing_weights_immutable() FROM PUBLIC, anon, authenticated;

-- The signed-in owner, or an error (role from profiles only).
CREATE FUNCTION public.frame_timing_require_owner()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_role text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501'; END IF;
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.user_id = v_uid;
  IF v_role IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'owner_only' USING ERRCODE = '42501'; END IF;
  RETURN v_uid;
END
$fn$;
REVOKE ALL ON FUNCTION public.frame_timing_require_owner() FROM PUBLIC, anon, authenticated;

-- Owner: the site's current version (version 0 and empty weights when none).
CREATE FUNCTION public.read_frame_timing_weights(p_site text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  r public.frame_timing_weight_versions;
BEGIN
  PERFORM public.frame_timing_require_owner();
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN RAISE EXCEPTION 'unsupported site'; END IF;
  SELECT * INTO r FROM public.frame_timing_weight_versions w WHERE w.site = p_site ORDER BY w.version DESC LIMIT 1;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('site', p_site, 'version', 0, 'weights', '{}'::jsonb, 'createdAt', NULL); END IF;
  RETURN pg_catalog.jsonb_build_object('site', p_site, 'version', r.version, 'weights', r.weights, 'createdAt', r.created_at);
END
$fn$;

-- Owner: save a new version. p_expected_version must be the current version (0 = none yet);
-- otherwise 'version_conflict' and nothing is written. Weights: known sizes only, positive finite <= 1000;
-- an empty object appends a cleared version (estimates unavailable) without deleting any history.
CREATE FUNCTION public.save_frame_timing_weights(p_site text, p_expected_version integer, p_weights jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid;
  v_cur integer;
  k     text;
  v     jsonb;
  r     public.frame_timing_weight_versions;
BEGIN
  v_uid := public.frame_timing_require_owner();
  IF p_site IS NULL OR p_site NOT IN ('au', 'uk', 'us') THEN RAISE EXCEPTION 'unsupported site'; END IF;
  -- '{}' is the explicit "cleared" version: estimates become unavailable; history is kept.
  IF p_weights IS NULL OR pg_catalog.jsonb_typeof(p_weights) <> 'object' THEN RAISE EXCEPTION 'invalid_weights: weights must be an object'; END IF;
  FOR k, v IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_weights) e LOOP
    IF k NOT IN ('A0', 'A1', 'A2', 'A3', 'A4', 'GW') THEN RAISE EXCEPTION 'invalid_weights: unknown size %', pg_catalog.left(k, 10); END IF;
    IF pg_catalog.jsonb_typeof(v) <> 'number' OR (v #>> '{}')::numeric <= 0 OR (v #>> '{}')::numeric > 1000 THEN
      RAISE EXCEPTION 'invalid_weights: weight for % must be a positive number up to 1000', k;
    END IF;
  END LOOP;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('frame-timing-weights|' || p_site));
  SELECT coalesce(max(w.version), 0) INTO v_cur FROM public.frame_timing_weight_versions w WHERE w.site = p_site;
  IF p_expected_version IS DISTINCT FROM v_cur THEN RAISE EXCEPTION 'version_conflict: current version is %', v_cur USING ERRCODE = '40001'; END IF;
  INSERT INTO public.frame_timing_weight_versions (site, version, weights, created_by) VALUES (p_site, v_cur + 1, p_weights, v_uid) RETURNING * INTO r;
  RETURN pg_catalog.jsonb_build_object('site', r.site, 'version', r.version, 'weights', r.weights, 'createdAt', r.created_at);
END
$fn$;

REVOKE ALL ON FUNCTION public.read_frame_timing_weights(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_frame_timing_weights(text, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.read_frame_timing_weights(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_frame_timing_weights(text, integer, jsonb) TO authenticated;

-- Service-only: the timing stream rows of one pinned generation and audience, plus the site's
-- current weight version (values and version only; no author metadata).
CREATE FUNCTION public.read_frame_timing_rows(p_site text, p_audience_kind text, p_audience_staff uuid, p_generation uuid,
                                              p_first_date date, p_last_date date, p_start timestamptz, p_end timestamptz, p_row_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_seq  bigint;
  v_n    bigint;
  v_rows jsonb;
  w      public.frame_timing_weight_versions;
BEGIN
  v_seq := reporting_private.checked_generation('read_frame_timing_rows', p_site, p_audience_kind, p_audience_staff, p_generation,
                                                p_first_date, p_last_date, p_start, p_end, NULL);
  IF p_last_date - p_first_date + 1 > 731 THEN RAISE EXCEPTION 'read_frame_timing_rows: at most 731 production dates'; END IF;
  IF p_row_limit IS NULL OR p_row_limit < 1 OR p_row_limit > 100000 THEN RAISE EXCEPTION 'read_frame_timing_rows: row limit must be 1..100000'; END IF;

  -- Bounded reads: verification images are looked up by event key (the source_versions primary key);
  -- clock images are filtered by type, production window and audience inside the scan, never
  -- materialized for the whole site. Candidates are counted up to p_row_limit + 1 BEFORE any JSON is
  -- built; above the limit the read refuses (never truncates). Whole person/day streams are kept:
  -- report filters are applied later by the server.
  WITH ver AS (
    SELECT e.event_id, e.staff_id, e.created_at, e.production_date, e.work_type, e.sku, coalesce(e.timing_weight, 0) AS pieces, e.effective, e.case_id IS NOT NULL AS rework
      FROM reporting_private.sel_eval(p_site, p_audience_kind, p_audience_staff, v_seq, p_start, p_end) e
     WHERE e.role = 'verification' AND e.created_at >= p_start AND e.created_at < p_end
  ), ver_img AS (
    SELECT r.*, i.image
      FROM ver r
      LEFT JOIN LATERAL (
        SELECT sv.image FROM reporting_private.source_versions sv
         WHERE sv.site = p_site AND sv.event_id = r.event_id AND sv.valid_from_seq <= v_seq AND (sv.valid_to_seq IS NULL OR sv.valid_to_seq > v_seq)
         LIMIT 1) i ON true
  ), clk AS (
    SELECT sv.event_id, (sv.image ->> 'staff_id')::uuid AS staff_id, (sv.image ->> 'created_at')::timestamptz AS created_at, sv.image ->> 'event_type' AS kind,
           sv.image ->> 'station_id' AS station_id
      FROM reporting_private.source_versions sv
     WHERE sv.site = p_site AND sv.valid_from_seq <= v_seq AND (sv.valid_to_seq IS NULL OR sv.valid_to_seq > v_seq)
       AND sv.image ->> 'event_type' IN ('clock_in', 'clock_out')
       AND (p_audience_kind = 'site' OR sv.image ->> 'staff_id' = p_audience_staff::text)
       AND (sv.image ->> 'created_at')::timestamptz >= p_start AND (sv.image ->> 'created_at')::timestamptz < p_end
  ), rows AS MATERIALIZED (
    SELECT r.event_id, r.staff_id, r.created_at, r.production_date, 'verify'::text AS kind, r.work_type, r.sku, r.pieces, r.effective, r.rework,
           CASE WHEN r.image ->> 'business_department_status' = 'assigned' AND coalesce(r.image ->> 'business_department_id', '') <> ''
                THEN r.image ->> 'business_department_id' END AS dept_id,
           r.image ->> 'station_id' AS station_id
      FROM ver_img r
    UNION ALL
    SELECT c.event_id, c.staff_id, c.created_at, reporting_private.production_date_at(p_site, c.created_at), c.kind, NULL, NULL, 0, true, false, NULL, c.station_id
      FROM clk c
  ), lim AS (
    SELECT count(*) AS n FROM (SELECT 1 FROM rows LIMIT p_row_limit + 1) x
  )
  SELECT lim.n,
         CASE WHEN lim.n > p_row_limit THEN NULL ELSE (
           SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                    x.event_id, x.staff_id::text, reporting_private.utc_text(x.created_at), x.production_date::text, x.kind, x.work_type, x.sku, x.pieces,
                    x.effective, x.rework, x.dept_id, x.station_id)
                    ORDER BY x.staff_id, x.created_at, x.event_id), '[]'::jsonb)
             FROM rows x) END
    INTO v_n, v_rows FROM lim;
  IF v_n > p_row_limit THEN RAISE EXCEPTION 'read_frame_timing_rows: more than % rows exceed the limit %', p_row_limit, p_row_limit; END IF;

  SELECT * INTO w FROM public.frame_timing_weight_versions fw WHERE fw.site = p_site ORDER BY fw.version DESC LIMIT 1;
  RETURN pg_catalog.jsonb_build_object('rows', v_rows,
    'weights', CASE WHEN w.version IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object('version', w.version, 'weights', w.weights) END);
END
$fn$;
REVOKE ALL ON FUNCTION public.read_frame_timing_rows(text, text, uuid, uuid, date, date, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_frame_timing_rows(text, text, uuid, uuid, date, date, timestamptz, timestamptz, integer) TO service_role;

COMMIT;
