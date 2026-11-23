# Order timeline commissioning

> Implement with actual Claude Code; Codex plans, reviews and performs authorized staging operations. Use executing-plans for the implementation. This is a continuation of the approved F10/F11 scope, not a new feature bundle.

**Goal:** Connect usable source refresh, establish the order-location rule, and verify framing through delivery in the isolated Preview.

**Spec:** `docs/specs/order-timeline.md` and `docs/specs/make-milestones.md`. CJ's latest instruction is “Do these for me” after the remaining routing, source connection and full-journey checks were explained. Existing autonomous staging authorization applies. No lateness or speed classifications.

## Current facts (23 November 2026)

- App baseline `e216051` and documentation `ed2b60f`; PR20 remains a draft. Existing synthetic AU printing test accepted all five Make milestones, including replay and role checks. It did not commission real Shopify ingestion or framing/shipping/delivery completion.
- New staging Supabase is **rsfdqkjasiozmbdtgquv**, Free, organization Inka Arthouse 2. All 55 historical migrations were installed as one baseline, `20261123091131_fresh_staging_baseline_0001_to_0060`. Do not replay the original migration directory blindly.
- Never access the paid production Supabase project **lkboboagiikvozvbcpvg**, deploy production, or change the three live Make systems. Old staging **ybrzhrgfrnvtcwymjdrq** is not this task's database. No billing changes.
- `reconcileOrder` already provides owner-only, bounded source copying: one order's app events plus a read-only Shopify query. The UI's current Refresh only reloads stored facts; it never calls reconciliation.
- Current Shopify adapter records individual fulfillments, not whole-order shipment/delivery proof. App completed events record work-type framing, not proof that every required item was framed. Do not silently promote either to complete.
- Actual Make Shopify connection **5589973** has read_orders/read_all_orders, location and fulfillment-order read scopes. A bounded read-only query succeeded using API 2026-10. Shared shop is **inka-arthouse.myshopify.com**. Observed non-legacy locations: Airport West `62727487650` (AU), RETURNS PILE `82551767261` (AU), UK Warehouse `95746949341` (GB). Do not map returns stock to a production team. Legacy locations were not included; no general US location rule has been proven.
- Both AU and UK assigned fulfillment locations appeared in the sample. Some successful fulfillments have inTransitAt, while the shown recent samples have deliveredAt=null. Do not substitute updatedAt for carrier delivery time.
- The actual printing blueprints do not derive site from a Shopify field. Related original rollout documentation explicitly says: “Production site comes from the dedicated form/chain, not shipping country. International destinations remain allowed.” Sources: `C:/Users/cjgom/OneDrive/Documents/ChatGPT/JARRAH - INKA/docs/site-rollout.md:41` and `docs/site-rollout-20260929.md:75`.
- An asynchronous business question is pending: does CJ mean customer delivery country, Shopify assigned warehouse, or the AU/UK/US printing form? This blocks choosing general routing, not the source-refresh UI work. Existing source-qualified Make membership remains valid evidence; never use a worker's selected site to assign Shopify orders.
- Actual Claude check at approximately 18:58 Shanghai returned a 5-hour usage limit, resetting **19:50**, with no credits. Do not bypass normal permissions or the quota. Resume after reset.

## Focused implementation

### 1. Make source refresh usable (independent of the routing answer)

Files: `src/components/OrderTimelineCard.tsx`, `src/pages/Reports.tsx`, `tests/production/order-timeline-ui.test.tsx`, existing API tests only if behavior changes.

- [x] Add an owner-only **Refresh sources** action for the currently looked-up order; pass the trusted role from Reports. Preserve ordinary stored-data Refresh for readers.
- [x] Call the existing POST `{action:"reconcile", site, orderNumber}` with the current Supabase session, then reload the same timeline on success. No new endpoint, dependency, cron or repository interface.
- [x] Prevent concurrent submissions; show a concise loading/error/result message. `not_configured`, `not_found`, routing disagreement and partial source failure must not look like full synchronization. If app evidence was copied before Shopify failed, preserve it and say the refresh was incomplete.
- [x] Bind asynchronous results to user scope, site and order. A late response after switching scope must neither paint an old message nor reload another order. Unauthorized API requests must still be denied server-side.
- [x] Focused tests for owner/non-owner rendering, POST and reload, failure, double-click and stale-response behavior. Commit before returning to Codex review.

### 2. Resolve and commission routing

Files if needed: `api/_lib/shopify-webhooks.ts`, its existing API tests and release documentation. Preview-only environment configuration is an operations task.

- [x] Incorporate CJ's answer if it arrives. Do not claim shipping country matches the printing site; the rollout notes explicitly contradict that as a universal rule.
- [ ] If fulfillment location is selected, inspect legacy locations and bounded order assignments, then add one tested extractor for the verified IDs. Missing, unmapped, multiple-site or truncated assignment lists stay unlinked. Never infer US from the absence of AU/UK.
- [ ] If delivery country is selected, use the existing country rule with an explicit, bounded mapping; unmapped countries remain unlinked. This is a reporting rule chosen by CJ, not a newly discovered printing rule.
- [ ] If printing form is selected, preserve source-qualified Make routing and add only the minimal explicit routing configuration needed to retain Shopify facts until verified Make membership arrives. No dummy country/tag rule and no cross-site reassignment.
- [ ] Keep Shopify read-only. Prefer the existing explicit reconciliation path for this release; a permanent automatic feed is not required to prove source refresh. Do not create Shopify subscriptions or modify live Make scenarios as a shortcut.

### 3. Prove the remaining journey without inventing completion

Files: existing adapters/tests and, only if necessary after Codex/Claude review, one additive migration after 0060. Read `docs/HARDENING.md`.

- [x] Claude first gives Codex a short recommendation for the smallest reliable complete-order proof using available source records. Do not implement a large event/backfill engine. Existing projection flags alone are not proof.
- [ ] For framing, inspect the existing saved scanner receipt and its full event list. A partial work-type completion or manually attributed framer must not become full framing. Honor cancellation and CS/replacement exclusions.
- [ ] For shipment/delivery, inspect complete bounded line-item/fulfillment coverage and source timestamps. A current fulfilled flag or one package arriving cannot prove the whole order's completion time. Missing carrier delivery time remains unknown. Keep immutable occurrences and retry/cancellation semantics intact.
- [ ] Implement only a reviewed, source-supported minimum; otherwise retain accurate partial/missing states and record the precise outstanding source requirement. Never seed invented production completion facts to make a test green.
- [ ] Test a clearly synthetic staging order through actual app framing/dispatch source paths and the timeline refresh. Use signed fixture/provider-adapter input for shipment/delivery without mutating a real Shopify order. Include partial delivery, retry and cancellation; distinguish synthetic proof from a bounded real-order read.

### 4. Review, Preview and acceptance

- [x] Codex reviews the actual diff. Run meaningful focused tests, API typecheck and build, then the required final gate once. No repeated broad checks without a new change or failure.
- [ ] Apply only newly reviewed SQL to **rsfdqkjasiozmbdtgquv**, if needed. Free staging has room; no cleanup or upgrade needed now.
- [x] Deploy only a new Preview from the reviewed commit. Pin all frontend/backend DB variables to new staging. Preserve production deployment and shared environment records. Use normal deployment-specific access, never a project-wide protection bypass.
- [ ] Verify the hosted source refresh and role denial, stored timestamps/durations, partial/missing behavior, duplicate handling, and actual Reports UI. If exercising Shopify HMAC, test the deployed raw-body path rather than assuming unit tests prove it.
- [ ] Finish with all temporary Make inspectors/copies inactive and queues empty; no real printing, notifications, Shopify mutations or production DB calls. Update release/review notes and a draft stacked PR. No main merge.

## Operations handoff

Private evidence and access files are outside git in `C:/Users/cjgom/dev/morning-20261123`. Never print credentials or raw blueprints containing tokens. See `timeline-commissioning-checkpoint.txt` for the current Preview and exact next steps.

New read-only inspector **8751146**, hook **4163345**, was created in staging folder 420656. One execution **914a0df592854784a787dc3d80f6a825** succeeded (two operations). Scheduled execution and later direct-response attempts did not produce a further run; two owned queued requests were archived and removed. Inspector is verified inactive, queue zero. Its read result is available as bounded saved search excerpts. Do not blindly rerun it or describe the failed direct response as collected full data. No live scenario was edited.

Rollback: previous Preview plus ingestion off; retain additive evidence. No production rollback is necessary because production is out of scope.

## Implementation log

- Initial checkpoint was planning/source discovery only. Task 1 is now implemented, reviewed and deployed as described below.
- Task 1: owner-only **Refresh sources** in `OrderTimelineCard` (role passed from Reports; stored-data Refresh kept for all readers) calls the existing POST reconcile, then reloads the same order. Pure `createSourceRefresher`/`describeReconcile` allow one request per identity, drop late answers after a user/site/order change, and report not_configured, not_found, unrouted, routing conflict, fact conflicts and `SHOPIFY_UNAVAILABLE` (app copy already committed) as incomplete; malformed answers as unknown. No API, endpoint, dependency or interface change; server owner denial was already tested in `tests/api/order-timeline.test.ts`.
- Task 1 review r1 (two P2s): `describeReconcile` now validates and reports `app.conflicts` (any conflict = partial; missing/invalid = unknown). `createSourceRefresher` keeps a per-identity in-flight lock released on settlement, separate from the displayed message; refreshing A again after A→B→A re-attaches to the running request instead of a second POST, while an old answer nobody re-asked for still neither paints nor reloads. Tests cover A-B-A with completed and rejected old requests.
- Task 1 review r2 (P2): restored the current-identity check after the session token resolves, so an intent abandoned by a user/site/order change before the POST sends nothing (no POST, reload or message); the lock is still released in `finally`, and re-asking after A-B-A still re-attaches with one POST. Regression test with a deferred token.

- Task 1 accepted on 23 November: final app commit `cccb0b557d4b8e8a17b524e637c07ab674f34258`; independent review has no remaining material findings. 139 files / 3,319 tests and build pass; GitHub Actions run 45172058349 is green. No SQL change.
- New Preview `dpl_hkwZc8w3jWDqqeCoQ6J7ibonh9D4` is Ready at https://inka-arthouse-c7nv30kth-inka-arthouse-s-projects.vercel.app. Served bundle references only the new Free staging database, with no service-role key. Production deployment and shared env records remain unchanged.
- Hosted acceptance: 30/30 checks pass in the repeat-fixture path (owner reconcile, unauthenticated 401, four non-owner roles 403, exact source timestamps, partial framing, confirmed dispatch, six original non-app facts preserved, no duplicate evidence). Initial network failures mean the first insertion response is not retained as a completed acceptance run. The successful run verifies exactly two matching synthetic source rows and eight timeline facts. Browser click independently shows “0 new, 2 already recorded” and the honest Shopify-not-configured warning. See `docs/reviews/order-timeline-commissioning-r1.md`.
- Task 3 consultation: Claude recommends scanner-receipt coverage for framing and complete bounded line-item/fulfillment coverage plus actual carrier timestamps for shipment/delivery. This is a recommendation, not implemented proof. Classic events remain partial framing; shipped/delivered remain missing. No physical scanner, stock deduction or real Shopify write was tested.
- Remaining: CJ's routing answer (delivery country, assigned warehouse, or printing form), read-only Shopify commissioning, and reviewed whole-order framing/shipping/delivery proof. Task 4 hosted acceptance above covers Task 1 only; full-journey acceptance remains unchecked. No Make scenario was called or changed during this UI deployment continuation.

## Routing decision received, 23 November 2026

CJ chose order delivery country and whichever production site is nearest. This resolves Task 2's business question and supersedes all earlier "pending answer" entries above. Use the existing shipping_country map contract when sufficient. Codex/Claude will establish the actual facility locations or a defensible bounded country map before setting Preview-only configuration. Do not use a worker's selected site, assume missing-US means US, or change live printing form/chain behavior. Countries whose nearest production site cannot be established remain explicitly unrouted; no arbitrary catch-all. Actual Claude read-only consultation and read-only Shopify facility/coverage investigation are underway. No additional business approval is required for the already-authorized staging implementation.

## Approved implementation increment: scanner receipt framing

Codex approves Claude's Task 3a consultation under CJ's autonomous authorization. Implement one append-only `0061_order_timeline_scanner_proof.sql` (follow this repository's established numbered migration convention; never edit older files) replacing only `reconcile_order_timeline_app(text,text)`, plus relevant PGlite tests in `tests/reporting/pg/order-timeline.test.ts` and the harness migration list if needed. No new dependency or repository interface.

- [ ] Preserve all classic framing, dispatch and cancellation evidence from 0059 and existing service-only grants/security-invoker/search_path. The full input/output remains bounded; account for receipt facts/retractions within the ingest limit, failing explicitly before writing if exceeded.
- [ ] Read at most one saved commit receipt in `scanner_requests` for the exact site/order. Its nonempty unique `result.event_ids` must all resolve to normal original production events at that site/order, matching the receipt request, scan time and expected scanner event types; include at least one framing completed event and its per-line verified events. Reject empty/duplicate/malformed/missing ids, wrong-site/order, CS-tagged or non-framing records. Treat this as scanner-attested completeness, not a second Shopify check.
- [ ] Emit one confirmed full-framing record keyed `<site>/receipt:<request_id>` at `scanned_at` when the valid receipt's original events have not been cancelled. Do not inspect later CS case existence to erase valid original history. Classic/manual work stays partial.
- [ ] For cancellation of any receipt event, emit a same-source retraction of that receipt key at the actual cancellation timestamp, with a deterministic cancellation-based key. It works whether cancellation or proof was reconciled first; repeats are duplicates. Never invent a cancellation date.
- [ ] Tests exercise the real scanner commit path or equivalently valid saved receipt structure; confirmed framing, replay, partial classic/manual work, later CS case preserving history, replacement exclusion, wrong site/order, missing/malformed/duplicate/empty ids, per-line cancellation and no production/receipt mutations. Extend source bound tests if necessary.
- [ ] Run focused PGlite/API tests, type checks, build; commit and hand back for independent review. Codex then applies only this reviewed migration to Free staging rsfdqkjasiozmbdtgquv and exercises a clearly synthetic scanner fixture/cancellation/replay. Do not write or access live databases. Roll back to the previous Preview/function definition; additive evidence is retained.

Shipment/delivery consultation is NOT approved for implementation yet: cancelling an earlier contributor must invalidate its dependent later cover; changed contributing sets or delivery timestamps cannot reuse conflicting immutable keys; retractions must not be backdated to invented cancellation times. Resolve this narrowly before enabling whole-order shipment/delivery.
