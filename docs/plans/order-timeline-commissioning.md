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

- [ ] Incorporate CJ's answer if it arrives. Do not claim shipping country matches the printing site; the rollout notes explicitly contradict that as a universal rule.
- [ ] If fulfillment location is selected, inspect legacy locations and bounded order assignments, then add one tested extractor for the verified IDs. Missing, unmapped, multiple-site or truncated assignment lists stay unlinked. Never infer US from the absence of AU/UK.
- [ ] If delivery country is selected, use the existing country rule with an explicit, bounded mapping; unmapped countries remain unlinked. This is a reporting rule chosen by CJ, not a newly discovered printing rule.
- [ ] If printing form is selected, preserve source-qualified Make routing and add only the minimal explicit routing configuration needed to retain Shopify facts until verified Make membership arrives. No dummy country/tag rule and no cross-site reassignment.
- [ ] Keep Shopify read-only. Prefer the existing explicit reconciliation path for this release; a permanent automatic feed is not required to prove source refresh. Do not create Shopify subscriptions or modify live Make scenarios as a shortcut.

### 3. Prove the remaining journey without inventing completion

Files: existing adapters/tests and, only if necessary after Codex/Claude review, one additive migration after 0060. Read `docs/HARDENING.md`.

- [ ] Claude first gives Codex a short recommendation for the smallest reliable complete-order proof using available source records. Do not implement a large event/backfill engine. Existing projection flags alone are not proof.
- [ ] For framing, inspect the existing saved scanner receipt and its full event list. A partial work-type completion or manually attributed framer must not become full framing. Honor cancellation and CS/replacement exclusions.
- [ ] For shipment/delivery, inspect complete bounded line-item/fulfillment coverage and source timestamps. A current fulfilled flag or one package arriving cannot prove the whole order's completion time. Missing carrier delivery time remains unknown. Keep immutable occurrences and retry/cancellation semantics intact.
- [ ] Implement only a reviewed, source-supported minimum; otherwise retain accurate partial/missing states and record the precise outstanding source requirement. Never seed invented production completion facts to make a test green.
- [ ] Test a clearly synthetic staging order through actual app framing/dispatch source paths and the timeline refresh. Use signed fixture/provider-adapter input for shipment/delivery without mutating a real Shopify order. Include partial delivery, retry and cancellation; distinguish synthetic proof from a bounded real-order read.

### 4. Review, Preview and acceptance

- [ ] Codex reviews the actual diff. Run meaningful focused tests, API typecheck and build, then the required final gate once. No repeated broad checks without a new change or failure.
- [ ] Apply only newly reviewed SQL to **rsfdqkjasiozmbdtgquv**, if needed. Free staging has room; no cleanup or upgrade needed now.
- [ ] Deploy only a new Preview from the reviewed commit. Pin all frontend/backend DB variables to new staging. Preserve production deployment and shared environment records. Use normal deployment-specific access, never a project-wide protection bypass.
- [ ] Verify the hosted source refresh and role denial, stored timestamps/durations, partial/missing behavior, duplicate handling, and actual Reports UI. If exercising Shopify HMAC, test the deployed raw-body path rather than assuming unit tests prove it.
- [ ] Finish with all temporary Make inspectors/copies inactive and queues empty; no real printing, notifications, Shopify mutations or production DB calls. Update release/review notes and a draft stacked PR. No main merge.

## Operations handoff

Private evidence and access files are outside git in `C:/Users/cjgom/dev/morning-20261123`. Never print credentials or raw blueprints containing tokens. See `timeline-commissioning-checkpoint.txt` for the current Preview and exact next steps.

New read-only inspector **8751146**, hook **4163345**, was created in staging folder 420656. One execution **914a0df592854784a787dc3d80f6a825** succeeded (two operations). Scheduled execution and later direct-response attempts did not produce a further run; two owned queued requests were archived and removed. Inspector is verified inactive, queue zero. Its read result is available as bounded saved search excerpts. Do not blindly rerun it or describe the failed direct response as collected full data. No live scenario was edited.

Rollback: previous Preview plus ingestion off; retain additive evidence. No production rollback is necessary because production is out of scope.

## Implementation log

- Planning/source discovery only. No new app code, SQL migration or deployment in this continuation yet.
- Task 1: owner-only **Refresh sources** in `OrderTimelineCard` (role passed from Reports; stored-data Refresh kept for all readers) calls the existing POST reconcile, then reloads the same order. Pure `createSourceRefresher`/`describeReconcile` allow one request per identity, drop late answers after a user/site/order change, and report not_configured, not_found, unrouted, routing conflict, fact conflicts and `SHOPIFY_UNAVAILABLE` (app copy already committed) as incomplete; malformed answers as unknown. No API, endpoint, dependency or interface change; server owner denial was already tested in `tests/api/order-timeline.test.ts`.
