# F9 Frame timing specification

Add a compact Frame timing section to Reports, grouped by frame type/size and method. Show sample counts, timed and untimed pieces, and coverage. Reuse F8 authorization, generation, filters and request lifecycle, plus existing source_versions. Pin each timing request to the overview's displayed generationId so the two sections cannot silently use different cutoffs. No capture or stock changes. Use additive0058 SQL/API as needed; F1 classification and effective verification semantics remain authoritative. UN, gift cards, accessories and manually attributed framers are excluded.

## Scan-gap method

One F6 scan can write several verification rows at one instant. Group trusted shared-station rows by the strict scn-request prefix; classic verification events are separate captures. Build the complete worker/site/production-day stream across scanners BEFORE applying department or work-type filters. Use effective, uncancelled framing/A0 verifications. Positive gaps up to30 minutes count; first captures and zero, negative or larger gaps do not. A clock-out or clock-in between scans breaks the chain. A non-frame production scan also breaks the framing chain: do not skip an intervening UN/accessory verification and attribute that unrelated work to the next frame. No gap crosses the site's04:00 production-day boundary.

Allocate a capture's gap proportionally across its counted frame pieces. Example:3 minutes for lines with2 and1 pieces gives2 and1 minutes. Show normal work and rework separately. The label explains these are scan-gap measurements, not stopwatch timing.

## Max-method fallback

Owners can enter positive size weights for the selected site in Settings. Defaults are blank: do not invent Max's numbers. Save immutable per-site versions with optimistic concurrency, and display the selected version alongside estimates. A selected version is an assumption applied to this report, not a claim it was historically in force.

The productive budget is405/450 of verified closed attendance minutes, capped at450 attendance minutes per shift for this first release (no guessed overtime). Accept only well-formed clock-in/out pairs wholly inside one production day; ambiguous, missing or cross-day attendance makes estimates unavailable. Malformed or future clock times beyond the pinned publication cutoff cannot supply attendance. Subtract measured minutes from the SAME complete worker/shift; clamp the remainder at zero. Allocate the remainder only across unmeasured framed pieces in proportion to quantity times size weight. Any missing required weight makes the whole remaining allocation unavailable, so a partial denominator cannot inflate results. Compute the full shift before report filters.

Example:450 attendance minutes gives405 productive minutes. With60 measured minutes,345 remain. One unmeasured A1 at weight2 and one A2 at weight1 receive230 and115 estimated minutes. The60 measured minutes remain separate. A225-minute shift has202.5 productive minutes. Never blend measured and estimated averages.

## Verification and implementation

Test shared capture grouping, per-worker cross-scanner streams, exact30-minute threshold, clock/day breaks, cancellations, UN/manual exclusions, sets/quantities and unchanged gaps under filters. Test partial attendance, missing weights, no estimate without attendance, measured-time subtraction, version conflicts/role guards and CSV method labels.

Tasks: pure reference math plus SQL tests; immutable owner weight settings and authorization; compact Reports section and CSV labels, full gate and release notes. Keep the implementation practical. Root owns real staging fixtures, cleanup, deployment and browser checks. Missing real weights and physical scanner commissioning remain explicitly documented.

## Authority, delivery and constraints

CJ explicitly delegates the next three features and routine implementation choices to Codex and Claude; this is the roadmap's F9 after F1/F8. No approval question or /loop. Claude is sole app writer; Codex owns plans/review/staging. Use existing UI primitives and table/CSV patterns. No dependency or capture/inventory rewrite.

Hardening: F8 server authorization applies on every timing request; staff only own stream, current memberships constrain sites, CS only explicit Reports permission, kiosk denied. Only owner can read/write weight configuration management; report consumers receive version + assumptions without privileged configuration metadata. Use immutable weight versions, positive finite bounded values, duplicate/unknown size validation and optimistic version check to avoid lost updates. Security-definer RPCs need explicit role checks and revoked public/anon execution. Source snapshots at the selected published generation, never present-day staff department assignment.

Bounded server work over selected dates plus the attendance/timing context needed for those dates; browser receives aggregated rows. Max731 production dates and explicit exceptional-cardinality failure. Show unavailable timing, missing weights and attendance coverage instead of treating absence as zero. Legacy data lacking capture metadata remains classic-event behavior and is labelled accordingly. Estimates are assumptions, never payroll or precise stopwatch claims.

Dexie retains its current local report behavior; advanced published timing requires Supabase. Release additive0058 only to isolated staging and Preview after local gates + real SQL rollback fixtures/API/UI checks. Root handles application of SQL, role fixtures, deployment and cleanup. Previous Preview remains rollback; do not delete weight history or existing generations. No production connection or migration edits.
