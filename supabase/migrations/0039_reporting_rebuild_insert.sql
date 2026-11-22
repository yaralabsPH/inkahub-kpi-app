-- 0039_reporting_rebuild_insert.sql
--
-- item-counting amendment, Task 13 B2b repair T13B2b-19 (DRAFT, not applied).
-- Append-only: installed 0037 and 0038 stay byte-identical.
--
-- publish_reporting_batch(uuid, bigint) is replaced with its exact 0038
-- definition except ONE statement: the rebuild branch's source_versions
-- INSERT no longer anti-joins source_versions against itself
-- (AND NOT EXISTS ... v.valid_to_seq IS NULL). The existing partial unique
-- index source_versions_current (site, event_id) WHERE valid_to_seq IS NULL
-- is the explicit conflict arbiter instead:
--   ON CONFLICT (site, event_id) WHERE valid_to_seq IS NULL DO NOTHING
-- Only a conflict on THAT index is skipped; every other constraint failure
-- (primary key, checks) still raises.
--
-- Semantics are unchanged under the site lock and the frozen candidate: the
-- preceding UPDATE still closes every current version whose image is absent
-- from or changed in the candidate, so a remaining current version is
-- exactly an unchanged image (kept, original interval); changed and new
-- images get the new sequence; absent images stay closed. The refresh
-- branch, fences, receipts, replay, SECURITY INVOKER, search_path and
-- privileges are unchanged (CREATE OR REPLACE keeps owner and privileges).
--
-- Rollback: a later reviewed append-only migration re-creates 0038's
-- definition. No data change is needed either way.

BEGIN;

CREATE OR REPLACE FUNCTION public.publish_reporting_batch(p_batch uuid, p_fence bigint)
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
    ON CONFLICT (site, event_id) WHERE valid_to_seq IS NULL DO NOTHING;
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

COMMIT;
