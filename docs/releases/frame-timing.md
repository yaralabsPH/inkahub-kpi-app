# F9 Frame timing — release notes (staging only)

Branch `feature/frame-timing`, stacked on `feature/reports-v2` (F8 fix
`240bf80`). Nothing here is applied, pushed or deployed by the coder.

## What ships

- `supabase/migrations/0058_frame_timing.sql` (additive; 0057 unchanged):
  - `public.frame_timing_weight_versions` — immutable per-site size weights
    (RLS on, no app-role grants, update/delete refused by trigger).
  - `public.read_frame_timing_weights(site)` / `public.save_frame_timing_weights(site, expected_version, weights)`
    — authenticated, SECURITY DEFINER, owner role from `profiles`; known sizes
    A0–A4/GW, positive ≤ 1000; a stale `expected_version` is `version_conflict`.
  - `public.read_frame_timing_rows(...)` — service only; verification and
    clock rows of the PINNED generation (checked_generation, sel_eval,
    source_versions departments), ≤ 731 dates, > 50,000 rows refused.
- `GET /api/reports/timing` (route 12): F8 authorization, `generationId`
  required (the summary's), 410 when that version is gone; streams timed on
  the server before filters; aggregates only.
- Reports: "Frame timing" under the summary — per frame size/variant,
  normal and CS/rework, measured (scan gap) and estimated (Max method)
  averages in separate columns, coverage and unavailable reasons, weights
  version, Timing CSV with both method labels.
- Settings (owner only): size weights for the selected site, blank until
  entered; each save is a new version.

## Prerequisites (root, staging `ybrzhrgfrnvtcwymjdrq` only)

1. Apply 0057 (if not yet) then 0058.
2. Rollback-transaction checks: authenticated cannot read the table or the
   stream RPC; manager/staff get `owner_only`; a stale save conflicts; an
   older version stays unchanged; a shared capture with several lines, a UN
   scan between frames, a clock pair of 450 min with measured + unmeasured
   pieces, a missing weight.
3. Weights: Max's real per-size numbers must be entered by an owner. Until
   then every estimate shows "unavailable"; nothing is invented.
4. Preview: owner/manager/staff/CS/kiosk as for F8; the timing section shows
   the same report version as the summary.

## Rollback

Restore the previous Preview. 0058 only adds a table and functions; the old
app does not call them. Weight history is kept; do not delete it.

## Limitations

- A "shift" is one clock-in/clock-out pair inside one production day; any
  unpaired, reversed, cross-day or post-cutoff clock event makes that day's
  estimates unavailable. Attendance is capped at 450 min per pair.
- Estimates use the site's CURRENT weight version for every period shown
  (an assumption applied to this report, not the version in force then).
- Legacy events without shared-scanner ids are timed as one capture each.
- The stream read scans the generation's `source_versions` for clock events;
  performance is proven offline only. Physical scanner commissioning remains
  separate.
