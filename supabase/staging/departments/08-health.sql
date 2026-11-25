-- F5 departments: operator health queries. READ-ONLY.
--
-- For staging now, and for production at activation and in the first 30
-- minutes (run by CJ). There is no health screen in the app in F5; this is it.
--
-- If a query fails, the answer is "unavailable", NOT "no problems".
-- All times are UTC. Each query looks at the last 24 hours by the time the
-- database RECEIVED the event, and uses the index
-- production_events_department_received_idx.

-- 1. The switch.
SELECT clock_timestamp() AS queried_at, enabled, version, tracking_started_at, updated_at, updated_by
  FROM public.department_snapshot_control;
-- No row at all = "control_missing": new events are saved without a department.

-- 2. Are the triggers in place and enabled? (O = enabled, D = disabled)
SELECT tgname, tgenabled FROM pg_trigger
 WHERE tgname IN ('production_events_f5_10_sanitize', 'production_events_f5_20_resolve',
                  'production_events_f5_10_freeze', 'profiles_f5_10_close_assignment')
 ORDER BY tgname;

-- 3. Last 24 hours: how new events were attributed, per site.
--    Healthy when ON: mostly "assigned"; "unassigned" = people without a home.
--    Investigate: resolution_error, resolution_busy (should be rare and brief),
--    control_missing, resolver_unavailable, invalid_time.
SELECT location, business_department_status AS status, count(*) AS events,
       min(department_received_at) AS first_received, max(department_received_at) AS last_received
  FROM public.production_events
 WHERE department_received_at >= now() - interval '24 hours'
 GROUP BY location, business_department_status
 ORDER BY location, events DESC;

-- 4. Last 24 hours: clock warnings, counted separately from attribution and
--    INCLUDING events that were assigned.
--    future_clamped = a tablet clock is ahead by up to 5 seconds (credited at receipt time)
--    reported_old   = reported more than 5 minutes before it arrived (credited at the
--                     reported time; if a tablet clock is wrong this can credit an older home)
--    invalid_time   = reported more than 5 seconds ahead: no department
SELECT location,
       count(*)                                                                                                    AS events,
       count(*) FILTER (WHERE department_time_status = 'future_clamped')                                           AS future_clamped,
       count(*) FILTER (WHERE department_time_status = 'reported_old')                                             AS reported_old,
       count(*) FILTER (WHERE department_time_status = 'invalid_time')                                             AS invalid_time,
       count(*) FILTER (WHERE department_time_status = 'future_clamped' AND business_department_status = 'assigned') AS clamped_assigned,
       count(*) FILTER (WHERE department_time_status = 'reported_old'   AND business_department_status = 'assigned') AS old_assigned,
       max(department_occurred_at - department_received_at) FILTER (WHERE department_occurred_at > department_received_at) AS furthest_ahead,
       max(department_received_at - department_occurred_at) FILTER (WHERE department_time_status = 'reported_old')         AS furthest_behind
  FROM public.production_events
 WHERE department_received_at >= now() - interval '24 hours'
 GROUP BY location
 ORDER BY location;

-- 5. The most recent event that was assigned (proof the lookup works right now).
SELECT location, id, event_type, business_department_name, department_received_at
  FROM public.production_events
 WHERE department_received_at >= now() - interval '24 hours' AND business_department_status = 'assigned'
 ORDER BY department_received_at DESC, location, id
 LIMIT 1;

-- 6. Recent events that were NOT cleanly attributed, newest first, 100 at a time.
--    For the next page, add:  AND (department_received_at, location, id) < (<last received>, '<last location>', '<last id>')
--    Columns are the event key and the timing facts only: no customer data.
SELECT location, id, event_type, staff_id, business_department_status AS status, department_time_status AS time_status,
       department_occurred_at AS reported_o, department_received_at AS received_s,
       department_resolution_instant AS resolved_at_instant
  FROM public.production_events
 WHERE department_received_at >= now() - interval '24 hours'
   AND (business_department_status <> 'assigned' OR department_time_status IN ('future_clamped', 'reported_old', 'invalid_time'))
 ORDER BY department_received_at DESC, location DESC, id DESC
 LIMIT 100;

-- 7. Current accounts without a home department. This counts ACCOUNTS (shared
--    kiosk logins included), not "workers": check it against the roster.
SELECT count(*) AS accounts_without_home
  FROM public.profiles p
 WHERE NOT EXISTS (SELECT 1 FROM public.person_department_assignments a WHERE a.person_id = p.user_id AND a.valid_to IS NULL);

-- 8. History sizes (to watch growth over time).
SELECT (SELECT count(*) FROM public.business_departments)          AS departments,
       (SELECT count(*) FROM public.business_department_names)     AS name_intervals,
       (SELECT count(*) FROM public.person_department_assignments) AS assignment_intervals,
       (SELECT count(*) FROM public.department_audit)              AS audit_rows,
       (SELECT count(*) FROM public.department_requests)           AS receipts;

-- 9. Consistency: these must all be zero.
SELECT
  (SELECT count(*) FROM public.production_events
    WHERE department_received_at >= now() - interval '24 hours'
      AND business_department_status = 'assigned'
      AND (business_department_id IS NULL OR business_department_name IS NULL
           OR business_department_assignment_id IS NULL OR business_department_name_version_id IS NULL)) AS assigned_missing_a_reference,
  (SELECT count(*) FROM public.production_events
    WHERE department_received_at >= now() - interval '24 hours'
      AND business_department_status <> 'assigned'
      AND (business_department_id IS NOT NULL OR business_department_name IS NOT NULL
           OR business_department_assignment_id IS NOT NULL OR business_department_name_version_id IS NOT NULL)) AS unassigned_with_a_reference,
  (SELECT count(*) FROM public.business_departments d
    WHERE (SELECT count(*) FROM public.business_department_names n WHERE n.department_id = d.id AND n.valid_to IS NULL) <> 1) AS departments_without_one_open_name,
  (SELECT count(*) FROM public.person_department_assignments a
     JOIN public.business_departments d ON d.id = a.department_id
    WHERE a.valid_to IS NULL AND d.archived_at IS NOT NULL) AS open_assignments_in_archived_departments;
