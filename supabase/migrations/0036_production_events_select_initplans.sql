-- 0036_production_events_select_initplans.sql
--
-- item-counting Task 4 (policy amendment): rewrite ONLY the two SELECT
-- policies on public.production_events so their helper and auth.uid() calls
-- run once per statement instead of once per row. Visibility is unchanged
-- for every role.
--
-- Why: through the API, auth.uid() parses the caller's full JWT claims
-- (about 630 bytes) on every call, and the old predicates call it several
-- times per row. On staging, counting the 118,226 AU three-month rows cost
-- 5.18 s with realistic claims; the same rule evaluated once per statement
-- took 78 ms. That cost pushed the one-call evidence read past the
-- authenticated role's unchanged 8 s statement_timeout.
--
-- Same logic as before (0012 production_events_read, 0033
-- production_events_select):
--   * can_access_location(location) was EXISTS over the caller's own
--     user_locations rows. It is now `location = ANY (ARRAY(...))` over the
--     same rows, built once per statement. user_locations_select lets every
--     user read their own memberships; the explicit user_id filter keeps an
--     owner's wider membership visibility from granting other users' sites.
--     No subject or no memberships gives an empty array and no access, as
--     before.
--   * auth.uid(), is_manager_or_higher() and current_user_role() are
--     row-independent, so they are wrapped as scalar subqueries (init-plans).
--   * Both policies stay PERMISSIVE, FOR SELECT, TO PUBLIC (default), OR'ed.
-- Not changed: INSERT/UPDATE/DELETE policies, helper functions, other tables'
-- policies, grants, role settings, timeouts, 0034/0035 functions.
--
-- Apply: CJ only (or Astra on CJ's instruction), staging first, after the
-- before-parity baseline; production before the app deploy. One transaction,
-- so there is no moment without both policies. Plain DROP (no IF EXISTS) makes
-- a missing policy fail instead of silently creating a different set.
--
-- Rollback (a NEW migration, only if needed): restore the previous text
-- exactly:
--   BEGIN;
--   DROP POLICY production_events_read ON public.production_events;
--   DROP POLICY production_events_select ON public.production_events;
--   CREATE POLICY production_events_read ON public.production_events FOR SELECT
--     USING (can_access_location(location) AND (staff_id = auth.uid() OR is_manager_or_higher()));
--   CREATE POLICY production_events_select ON public.production_events FOR SELECT
--     USING (can_access_location(location)
--            AND (staff_id = auth.uid() OR current_user_role() IN ('owner', 'manager', 'cs', 'kiosk')));
--   COMMIT;

BEGIN;

DROP POLICY production_events_read ON public.production_events;
DROP POLICY production_events_select ON public.production_events;

CREATE POLICY production_events_read ON public.production_events FOR SELECT
  USING (
    location = ANY (ARRAY(
      SELECT ul.location FROM public.user_locations AS ul
      WHERE ul.user_id = (SELECT auth.uid())
    ))
    AND (staff_id = (SELECT auth.uid()) OR (SELECT public.is_manager_or_higher()))
  );

CREATE POLICY production_events_select ON public.production_events
  FOR SELECT
  USING (
    location = ANY (ARRAY(
      SELECT ul.location FROM public.user_locations AS ul
      WHERE ul.user_id = (SELECT auth.uid())
    ))
    AND (
      staff_id = (SELECT auth.uid())
      OR (SELECT public.current_user_role()) IN ('owner', 'manager', 'cs', 'kiosk')
    )
  );

COMMIT;
