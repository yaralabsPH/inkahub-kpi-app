# F9 review: concrete corrections before staging

Reviewed ced73b2 backend; UI 4394df4 review ongoing. Actual Claude remains sole repository writer.

1. Shared capture identity must require the trusted shared station marker as well as strict scn-<32hex>-vNN. Current DTO/SQL omit station_id and captureKey groups any matching IDs. For a 09:00 classic scan and two 09:03 classic-station rows with matching scn IDs, current math reports two measured pieces at 1.5 min each; separate classic events should time only the first 09:03 piece at 3 min. Carry frozen station identity and include station in capture identity; test genuine shared multiline, classic lookalikes, and different shared stations.
2. 0058 materializes all source_versions images for a site/generation, including for one-day self reads, and JSON-aggregates the full stream before checking limit. Join verification images by event key and constrain clock rows by date/audience before materialization; limit candidates to row_limit+1 before large JSON aggregation. Preserve full person/day context before report filters, and refuse instead of truncate.
3. FrameTimingWeightsCard.tsx: conflict handling awaits a fresh read that may reject, while caller has no catch/finally after status=saving. A version conflict followed by network failure leaves Save disabled indefinitely. Convert reload failures into a recoverable error, and expose Reload/Retry for initial or conflict read failures. Focused failed-save/reload and successful retry test.

Small clarity correction if straightforward: coverage missingWeightSizes/shifts/malformedAttendanceDays currently comes from all workers before the staff filter; a selected person can display another person's missing-weight/incomplete-clock warning. Keep math based on whole streams, but scope explanatory coverage to the selected person, or explicitly label whole-period diagnostics.

Planner-approved small usability extension: allow an owner to clear all weights by appending an empty immutable version. Empty means estimates unavailable; it does not delete history or invent weights. This supports correcting a mistaken configuration and safely restoring blank staging defaults after UI checks. Keep optimistic concurrency and owner-only authorization; test empty-version read/save and unavailable estimates. Update spec/plan/release notes for this explicit extension. Root will copy final review/spec amendment when Claude hands back; until then this external instruction is the approval.

Other notes: Vercel UI confirmed existing Fluid Compute enabled; default duration blank with placeholder300. No hosting setting changed. Current vercel.json 300s overrides are refresh-summaries/reporting-admin (daily-digest uses default). Keep deployment Preview-only, 12 entrypoints.

Do not apply 0058 until review fixes and actual staging transaction/grant checks pass. 0057 already installed and immutable. 0058 not installed yet, so amend uninstalled0058 rather than adding0059.
