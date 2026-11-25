# F8 Reports v2 — release notes (staging only)

Branch `feature/reports-v2`, stacked on `feature/item-counting-integration`.
Nothing here is applied, pushed or deployed by the coder.

## What ships

- `supabase/migrations/0057_reports_overview.sql` (additive, reads only):
  `reporting_private.ov_pair`, `reporting_private.ov_rows`,
  `public.read_reports_overview`. Execute granted to `service_role` only.
  Reuses 0044 `checked_generation`/`sel_eval`; departments come from
  `source_versions` at the same generation sequence (F5 snapshot, `assigned`
  only; else Unknown). ≤731 production dates; >1000 people or departments is
  refused (TOO_LARGE), never truncated.
- `GET /api/reports/overview` (route 11). Verified JWT + current profile and
  memberships; kiosk 403; CS needs explicit `reports` nav; staff forced to
  their own work (another person = 403); sites without a published summary
  answer `READ_MODE_LEGACY`/`UNAVAILABLE` — no raw-history fallback.
- Reports page: "Production summary" card (day / week / month / custom,
  person, work type, recorded department, daily trend, people, departments,
  summary CSV, cutoff + version + freshness). Owner/manager also keep the
  unchanged detailed view (F7 raw CSV, order lookup, F4 cards). Staff/CS get
  the summary only; kiosk sees a refusal.
- Staff role default navigation now includes Reports (explicit `allowed_nav`
  overrides still win).

## Prerequisites (root, staging `ybrzhrgfrnvtcwymjdrq` only)

1. Apply 0057 after the installed 0034–0047/0052–0056 (0048–0051 stay free).
2. Rollback-transaction checks: grants (authenticated denied), a pinned older
   generation keeps its recorded department after a newer publication, a
   moved/renamed department fixture, staff self-only, bounds.
3. A site shows figures only when its read mode is `summary` and a complete
   generation exists. AU is legacy today, so the card reads "not ready" until
   the operator switches it; that is expected, not a failure.
4. Preview: owner, manager (assigned / unassigned site), staff (own only;
   forged `staffId` 403), CS with and without Reports nav, kiosk refused.
5. Hobby: no new crons; freshness shows `delayed`/`outdated` honestly.

## Rollback

Restore the previous Preview. 0057 only adds functions; the old app never
calls them. Staff nav default reverts with the app.

## Limitations

- The legacy detailed view and the F1 `/api/reports/summary` still follow
  their previous rules (e.g. an explicit `reports` override on a kiosk
  account is honoured there); only the new summary refuses kiosk outright.
- Person names in the summary come from `staff_barcodes`; a person without
  a badge row shows a short id.
- Performance is proven offline (PGlite, 2,400 events), not on staging data.
