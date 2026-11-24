# Review: bulk release stack — round 1

- Slug: `release-stack` · Branch: `feature/staging-fixes` (PR #22) · Reviewed commit: `95da008f2a297acbcd2badd557cc02101e590fe1`
- Reviewer: planner (GPT-6 Astra)
- Date: 2026-11-24
- Verdict: **changes required**

The stack passes Linux CI, but is not ready for an unrestricted bulk production release. Two packaging retry defects need correction, and the exact database upgrade, reporting capacity/refresh, and full old-app rollback need release evidence. The SQL is structurally additive, with deliberate policy/function/trigger replacements; that does **not** establish that running every file against a busy live database is safe.

## Checked against

- [x] Relevant spec acceptance criteria and subsequent review/commissioning decisions; unresolved acceptance is identified below.
- [x] Plan tasks and release records reviewed for cumulative dependencies; **not all production gates are complete**.
- [x] AGENTS.md guardrails: both backends, append-only migrations, RLS/grants, secrets, whitelist, inventory math and dependency rationale.
- [x] `docs/HARDENING.md`, every question (matrix below).
- [x] `docs/ROADMAP.md` decisions, including later approved limitations. F3 and F12 are not delivered by this tree; F10 is the approved durations-only scope, not lateness reporting.
- [x] Verification commands attempted locally; exact-commit Linux CI independently checked. Existing tests pass there; missing regression cases are Must-fix 1–2.
- [x] `docs/ARCHITECTURE.md` and `docs/RELEASING.md`, especially old-code compatibility and rollback.

### Scope and evidence boundaries

The requested local `main...HEAD` comparison is **449 files, 117,051 insertions, 2,390 deletions**, based on local `main`/merge-base `57b89d2bec371c2aca66c2098fa2e57c7e3d73a7`. Local `main` is behind the recorded remote main `8519ac9a9af66167903107d5ad8fb7a65e0278a9`: the comparison includes the already-merged order-display PR #9. GitHub PR metadata and CI were read on this review date; no fetch, merge, commit, push, deployment, database connection or SQL execution was performed.

**PR #12 is not in this stack.** GitHub identifies it as `feature/f3-artwork-thumbnails`; its head is not an ancestor of this HEAD. Do not include it merely because the request names PRs 10–21. This review covers #7, #10, #13, #11, and #14–#22. The separate Team redesign is also not included. New migration allocation remains 0034–0047 and 0052–0062.

This is a cumulative static review with focused executable packaging reproductions and existing CI/staging evidence, not a line-by-line certification of 117,000 added lines or an executed production upgrade. Historical acceptance records are distinguished from current commissioning: the replacement staging database works for timeline tests, but has no F1 publication.

## Must-fix

### 1. Preserve packaging retries across expired sessions and account changes

`src/lib/repository/supabase/orderPackaging.ts:115`, `src/lib/state/packagingSubmit.ts:41`, `src/lib/hooks/useOrderPackaging.ts:138` — an expired JWT (`PGRST301`) falls through to `rejected/server_error`; draining treats every non-network result as `done` and removes the request. A focused read-only reproduction using the actual TypeScript modules and a fake expired-JWT RPC changed pending requests **1 → 0**. Signing in again could complete that stock deduction, but its retry payload is gone. Draining also traverses the device-wide queue, not just work belonging to the current account/site; a different account's permission refusal can discard pending work.

Retain authentication/configuration interruptions and uncertain responses, pause for the appropriate session, and scope delivery to the captured account/site. Only discard a request on a genuinely settled result; retain actionable failure evidence for a permanent rejection. Test token expiry, sign-out/account switch, and retry with the original request ID, asserting exactly one stock deduction. This is a blocker for automatic packaging activation; shipping it dormant would require an explicit reduced release scope with all sites kept in scan mode.

### 2. Do not claim a packaging request is durable when it is only in memory

`src/lib/state/packagingOutbox.ts:81` returns success when persistent storage is unavailable. `createPackagingOutbox(null).enqueue(...)` returned **true** in the focused reproduction; a new instance after simulated reload had **zero** pending requests. `packagingSubmit.ts:31` therefore reports “queued” without the reload guarantee in `docs/specs/box-auto-pick.md:225`. Furthermore, `packagingSubmit.ts:23` sends before persisting, leaving the first uncertain request vulnerable to a page close.

Persist the captured request before the first send, keep its ID until settlement, and report an explicit recoverable storage failure if persistence cannot be guaranteed. Add unavailable/quota-failed storage and reload-during-send regressions. The manager attention list is useful recovery evidence, but is not equivalent to keeping the original request. Same activation restriction as Must-fix 1.

### 3. Rehearse the literal ordered upgrade and old app against it

`supabase/migrations/0054_departments_snapshots.sql:48` and `:86`, `0047_packaging_auto_pick.sql:126`, `0055_scanner_stations.sql:181` — three nonconcurrent index builds touch live event/ledger tables. In 0054, the column-addition lock is held through the index build and the rest of the transaction. Do not call this an unmeasured “brief” lock. Also confirm PostgreSQL **16+** (`docs/plans/item-counting.md:374`), the 0036 policy names, production grants/roles, `btree_gist` placement, actual stock constraints and existing migration history before any production step.

The fresh staging baseline includes restricted grants outside the individual numbered-file history (`docs/releases/make-milestones.md:32–34`). It does not prove the literal upgrade from the deployed schema. Supply an ordered staging rehearsal using the exact committed files on a reconciled schema with representative, sanitized volume and the actual migration role. Record file hashes, lock duration, disk headroom, failure/resume behavior, effective ACLs, and old-version smoke results. Use stop-on-error, bounded operator lock/statement timeouts, and atomic execution for 0046. Preserve installed migrations; any repair must be append-only, with a reviewed approach if it must precede an otherwise failing file. Do not use the consolidated staging baseline or replay 0001–0033 on production.

### 4. Close the F1/F8/F9 operational gate and restore Pro refresh scheduling

`docs/releases/morning-2026-11-23.md:25` records initial AU publication exhausting disk after a timeout retry. This is **historical evidence**, not a claim that current staging is down. The replacement staging environment explicitly keeps F1 capture/processors off with no published summary (`docs/releases/make-milestones.md:29–35`, `docs/releases/order-timeline.md:72`). Timeline success does not qualify reporting publication, incremental refresh, capture overhead, or two-year capacity.

Before exposing published reports, prove a complete initial publication and an incremental change/retry cycle against representative data, legacy/shared-rule parity, role-filtered summary/detail/CSV/dry digest, F5/F6/F7 capture composition, and bounded storage/latency. Record measured disk/WAL headroom and cleanup behavior. Include the outstanding large F5 benchmark and F9 clock-read latency. Never repeat the earlier “increase timeout and hope” bootstrap.

`vercel.json:13` contains only daily digests. The project is Pro per CJ, so restore the three refresh cron entries shown below and correct the Hobby assumption. Keep processors off and read mode `legacy` until each site passes publication checks. A dormant-code release is possible only if explicitly accepted as such; it would not deliver functioning F8/F9 summaries to staff.

### 5. Make the bulk-release boundary and rollback target concrete

`docs/RELEASING.md:43` assumes each merge deploys production; doing that for every ancestor would expose unreviewed intermediate combinations. Use the dependency order below **with production auto-promotion held**, then promote one final verified Production-configured build. Exclude PR #12. Before merging, record the current live deployment/SHA, Production environment checklist, backup/recovery point, SQL application manifest, rollout switches and rollback drill results.

The existing “App rollback: safe” wording at `docs/RELEASING.md:217` is qualified by its own duplicate-packaging warning at `:219`. Full old-app-on-new-schema stock/CS/shipment smoke is still distinct from the recorded old Preview startup/badge checks (`docs/reviews/departments-ui-acceptance.md:19`, `scanner-stations-r3.md:9`). Execute the full drill, including new-version writes before rollback, queue draining and duplicate attempts. Record the accepted packaging exception and recovery procedure rather than promising unconditional inventory parity. The exact procedure is below.

## Should-fix

1. **Reconcile release documentation.** `docs/releases/departments.md` still starts “not yet reviewed” and contains pending tables despite later acceptance; dispatch notes say 0056 is not installed; item-counting notes describe 0042 as potentially absent and Hobby hosting. Preserve historical evidence but add one authoritative current status/manifest linking superseding reviews. Add the missing reporting/timeline environment names to `.env.example`; its digest anon-fallback comment is stale.
2. **Keep operational limitations visible.** F4 corrected packaging is net in Reports but gross in the daily digest (`docs/RELEASING.md:233`); F9 estimates apply current weights to historical periods and refuse incomplete clocks; timeline covers recorded orders only. These accepted limitations must be in the operator handoff, not represented as complete historical truth.
3. **Track remaining inherited risks separately.** `docs/ARCHITECTURE.md` documents existing CS return sign/closure, multi-request stock, and backup limitations. The repository adapters are unchanged here; this review does not certify those old flows. Use the required release smoke to detect regressions and keep their remediation scoped separately. The dashboard's hidden Supabase browser-backup banner does not prove that database backups exist.
4. **Make migration hash tests portable later.** Compare committed LF bytes or normalize only in an explicitly defined hash-test convention. Do not edit historical migrations or weaken immutability checks to silence Windows failures.

## Migration audit: live-data safety and numbering

**Answer to (1): structurally expand-compatible, but not approved for a blind live “one go.”** No existing table/column drop, rename, type conversion, `ALTER COLUMN SET NOT NULL`, or deployment-time production-data backfill was found. NOT NULL/PK/CHECK constraints define newly created tables; 0038 adds nullable columns/constraints to reporting tables introduced in this same stack, and 0054 adds eleven nullable, default-less event columns. Existing events are not filled retrospectively. Rebuilding historical reports is a separate, potentially very expensive operator action, not part of migration application.

There are real policy replacements, function replacements, new source-table triggers and blocking indexes. Ordinary index builds block writers; ALTER TABLE generally takes an ACCESS EXCLUSIVE lock held to transaction end. A partial index still scans its source table even when few rows qualify. See PostgreSQL's [index-build rules](https://www.postgresql.org/docs/15/sql-createindex.html) and [locking rules](https://www.postgresql.org/docs/15/explicit-locking.html). “One release window” must mean ordered, verified steps with abort points, not an unattended concatenation or one long outer transaction.

All paths in this inventory are under `supabase/migrations/`:

| Number / file | Changes, locks, compatibility |
|---|---|
| 0034 `load_production_evidence.sql` | New read-only invoker RPC, authenticated/service execute, existing event RLS. No data rewrite. |
| 0035 `load_production_evidence_v2.sql` | Separately named compact RPC; v1 retained. |
| 0036 `production_events_select_initplans.sql` | Drops/recreates the two event SELECT policies transactionally with equivalent membership/role predicates. No visibility gap; verify actual policy names/definitions. Policy DDL needs a table lock. |
| 0037 `reporting_storage.sql` | Private reporting schema, 15 new tables/indexes, restricted capture role and event journal trigger; capture initially off. PostgreSQL16+ prerequisite. Trigger installation briefly conflicts with writers; no history backfill. |
| 0038 `reporting_jobs.sql` | Three new private tables, nullable additions/checks to new reporting tables, job/publication functions; replaces capture function with control locking. Supported event writes touch reporting control even while capture is off. |
| 0039 `reporting_rebuild_insert.sql` | Same-contract publication function replacement fixing conflict-arbiter handling. No migration-time rebuild. |
| 0040 `reporting_dependency_reads.sql` | Four ordinary indexes on the new reporting storage plus six bounded readers. These tables are empty on a first contiguous install with workers off; if already populated, index builds also block their writers. |
| 0041 `reporting_dependency_read_bounds.sql` | Replaces six readers with complete-response bounds; same SQL return declarations. |
| 0042 `reporting_access_paths.sql` | Replaces two readers for keyed access; adds no indexes. It exists and is required, despite older notes. |
| 0043 `reporting_worker_state.sql` | Five private state/support tables and service-only continuation, mode and derived-history cleanup functions. No production-row cleanup at deployment. |
| 0044 `reporting_reads.sql` | Service-only generation-pinned report readers/helpers. |
| 0045 `reporting_predecessor_page.sql` | Additional bounded reader; earlier functions retained. |
| 0046 `reporting_owner_inputs.sql` | Three private continuation tables and service-only functions. **No file-level BEGIN/COMMIT**: the runner must provide atomicity. |
| 0047 `packaging_auto_pick.sql` | Four site-scoped tables, checked mutations, scan-mode default. **Ordinary partial UNIQUE index `ledger_pkg_source_unique` on live ledger**; preflight conflicting qualifying rows. No conversion of old packaging rows during install. |
| 0052 `departments.sql` | Six new tables, exclusion/history constraints and narrow resolver role. Requires `btree_gist` in `extensions` (wrong existing placement aborts). Tracking initially off; no roster/history backfill. |
| 0053 `departments_admin.sql` | Owner-checked administration and profile-delete assignment-close trigger. Profile deletes now take department locks and may require retry. |
| 0054 `departments_snapshots.sql` | **Eleven nullable event columns + ordinary partial `production_events_department_received_idx` in one transaction**. Largest live-table lock concern. Sanitize/resolve/freeze triggers; old rows remain NULL. New rows have immutable identity fields even when tracking is off. |
| 0055 `scanner_stations.sql` | Two tables, checked scanner RPCs, classic/shared credit guard, and replacement legacy deduction function. **Ordinary `ledger_prod_order_idx` on live ledger**. New trigger can refuse classic duplicate framing after a shared save. |
| 0056 `dispatch_flow.sql` | Two tables, checked dispatch functions, immutable framer attribution and classic/shared dispatch guard. Trigger installation needs a short write-conflicting lock; old duplicate dispatch can now be refused. |
| 0057 `reports_overview.sql` | New service-only functions; no live-table rewrite. |
| 0058 `frame_timing.sql` | New immutable weight-version table, owner-checked configuration and service-only reads. No invented defaults. |
| 0059 `order_timeline.sql` | Two service-only RLS tables and ingest/read/reconcile functions. No production-events trigger or historical backfill. |
| 0060 `make_milestones.sql` | Three service-only RLS tables and transactional milestone functions; no stock mutations. |
| 0061 `order_timeline_scanner_proof.sql` | Replaces app reconciliation with scanner proof/retractions; same signature/JSONB return. Only appends evidence when called. |
| 0062 `order_timeline_shopify_proof.sql` | One service-only RLS state table and generation-fenced proof/webhook RPCs; existing APIs retained. |

### Existing RPC returns and behavior

No replacement changes the declared argument or SQL RETURNS shape. This does not mean behavior is identical:

- **0055 is the only replacement of an RPC already on the reviewed main baseline:** `deduct_inventory_for_event(text,jsonb)`. It retains the JSONB status/result keys, but now checks caller/site/event access, refuses ambiguous event IDs, serializes by order and aggregates aliases by product identity. Thus unauthorized calls now fail and duplicate/alias counters can differ. These are intentional safety changes requiring old-client smoke, not a column/return-shape contract break.
- Within the new stack, 0039 replaces `publish_reporting_batch`; 0041 replaces six 0040 readers (`changed_keys`, `owners`, `owner_members`, `events_by_id`, `children`, `staff_stream`); 0042 replaces owner-members/staff-stream again. Signatures/return columns stay the same, but byte bounds may shorten a page or reject an oversized row.
- 0061 replaces `reconcile_order_timeline_app`: same JSONB response contract, additional validated full-framing evidence and withdrawals. 0038 replaces a trigger function, not an app-return DTO. 0035 deliberately introduces a separate v2 name.

### RLS and grants

All **47 new tables** explicitly enable RLS. Reporting internals are in a restricted private schema, with service-only public readers and a narrowly privileged capture role; the API must derive the audience from authenticated identity. Packaging reads require site access, while mutation functions check role/site. Departments administration is owner-only with a restricted resolver role. Scanner/dispatch writes go through checked functions; receipts/attributions do not permit arbitrary browser writes. Timing weights have owner-checked functions and immutable history. Timeline/Make tables and ingestion functions deny anon/authenticated access and admit the service path.

These source checks are positive, but hosted default grants, role membership and function ownership must be verified on the exact upgraded schema. Test anon plus owner, manager, staff, kiosk and CS with real JWTs, including cross-site denial; do not infer authorization from hidden navigation.

**Answer to (2):** 25 unique new numbers, **no collisions and no unexplained gaps** through 0062. 0027 is the known recovery gap; **0048, 0049, 0050 and 0051 are reserved for F3 and absent from this release**. Never fabricate placeholder migrations. If production has an unexpected number/object already installed, stop and reconcile it. Future F3 work needs a deliberate migration-history strategy once 0052+ are installed.

## Production configuration and Pro cron changes

**Answer to (3):** verify the following in **Vercel Production before the final build/merge can deploy**. This review did not read secret values or establish whether any are currently absent. Keep Preview pointed at staging with separate secrets and safe recipients. Conflicting `SUPABASE_URL` and `VITE_SUPABASE_URL` are dangerous because handlers use different precedence: both must identify the same intended project.

| Variable | Requirement |
|---|---|
| `VITE_BACKEND=supabase` | Production backend selection. |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Correct production browser URL/public key. Only public credentials belong under VITE. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Server URL/public-auth key; existing handlers allow VITE fallbacks, but explicit matching values avoid split configuration. |
| `SUPABASE_SERVICE_ROLE_KEY` | Required server-only key for reporting/timeline. Digest no longer falls back to anon. |
| `CRON_SECRET` | Required nonblank random bearer secret for daily digest and refresh. Already required by S1 on main; preserve/verify it. |
| `REPORTING_OPERATOR_SECRET` | Required to commission/recover reporting; **must differ from CRON_SECRET**. Operator endpoint rejects equal values. |
| `REPORTING_CURSOR_SECRET` | Required stable random server-only signing secret for detail pages/CSV and paginated summaries; otherwise `CONFIG`/500 (`api/_lib/production-reporting.ts:265,286`). This is easy to miss in the release notes. |
| `REPORT_RECIPIENT`, `RESEND_API_KEY`, `FROM_EMAIL` | Valid destination, server sending key and intended verified sender. Set FROM_EMAIL explicitly rather than relying on the development fallback. |
| `REPORT_RECIPIENT_ALLOWLIST` | Optional; explicitly set intended override recipients or leave empty to deny overrides. |
| `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` | Existing lookup credentials; also needed for owner timeline refresh. Validate read scopes/access to the requested order history. |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Preserve if OAuth install/reinstall endpoints are used; not an additional requirement for an already-installed token. |
| `DROPBOX_ACCESS_TOKEN`, `DROPBOX_IMAGE_FOLDER` | Existing artwork lookup configuration; verify token validity. No F3 converter/storage secrets belong to this release. |
| `ORDER_TIMELINE_INGEST` | Leave off/unset until commissioned; `on` enables Make/webhook ingestion and Shopify reconciliation. Reads remain available. Env changes require a new deployment to take effect. |
| `ORDER_TIMELINE_ROUTING` | Valid version-1 allowlisted shop/country JSON before owner Shopify refresh or webhooks are enabled. Use CJ's reviewed full country map, not the three-country illustrative example. Missing countries stay unrouted. |
| `SHOPIFY_WEBHOOK_SECRET` | Required **if automatic webhooks are commissioned**; use the matching signing secret. Not required for owner-only manual refresh. No production subscriptions were commissioned in the recorded acceptance. |
| `MAKE_MILESTONE_SCOPES` | Required **if live Make reporting is commissioned**: one fixed site/shop scope and dedicated random secret of at least 32 characters per pipeline. Do not deploy synthetic staging scopes or reuse the cancellation token. |
| `VITE_STATION_UI` | Optional build-time station-screen default; decide deliberately alongside device settings. Not a secret or a shared-scanner commissioning substitute. |

Keep the three existing digest schedules and both `maxDuration: 300` declarations. Add these objects to `vercel.json`'s `crons` array:

```json
{"path":"/api/reports/refresh-summaries?site=au","schedule":"0,15,30,45 * * * *"}
{"path":"/api/reports/refresh-summaries?site=uk","schedule":"1,16,31,46 * * * *"}
{"path":"/api/reports/refresh-summaries?site=us","schedule":"2,17,32,47 * * * *"}
```

This is 288 refresh invocations/day plus three digests. Pro supports these intervals; no upgrade is needed on CJ's stated plan. Confirm the deployed Node functions actually have 300 seconds for the worker's 240-second budget. A Preview never runs Vercel crons automatically: exercise the protected endpoint manually there, then observe genuine production scheduler calls after release. [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [duration configuration](https://vercel.com/docs/functions/configuring-functions/duration), [cron operation and secret handling](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

Make/Shopify commissioning is separate from shipping dormant handlers. Live Make reporters must be terminal side branches or placed after all required writes/handoffs, with Ignore handling and no downstream dependency. Existing acceptance covers isolated AU clones, not production AU/UK/US. F12 Slack print confirmation is absent; there is no new Slack secret to configure for this tree.

## Safe merge, activation and rollback sequence

**Answer to (4):** verified PR dependency order is:

| Order | PR | Branch |
|---|---|---|
| 1 | #7 | `feature/item-counting` |
| 2 | #10 | `feature/station-screen-redesign` |
| 3 | #13 | `feature/box-auto-pick` |
| 4 | #11 | `feature/departments` |
| 5 | #14 | `feature/scanner-stations` |
| 6 | #15 | `feature/dispatch-flow` |
| 7 | #16 | `feature/item-counting-integration` (joins #7 into the F4–F7 chain) |
| 8 | #17 | `feature/reports-v2` |
| 9 | #18 | `feature/frame-timing` |
| 10 | #19 | `feature/order-timeline` |
| 11 | #20 | `feature/make-milestones` |
| 12 | #21 | `feature/order-timeline-commissioning` |
| 13 | #22 | `feature/staging-fixes` |

#7 and the #10→#13→#11→#14→#15 chain are independent until #16; the table is one safe topological ordering, **not numeric PR order**. Retarget children to main after their parents land and inspect the resulting diff/CI. Preserve ancestry with merge commits; blindly squash/rebase-merging every stacked child can reintroduce already-landed work or conflicts. If main has moved, review that integration and test the resulting tree again. A single dedicated release PR containing the final integrated tree is also possible, but it must explicitly supersede ancestors; merely merging #22 into its current base does not release to main.

### CJ's release steps after these findings are cleared

1. Freeze the final release manifest and hold automatic Production promotion while ancestors are merged. Retain one final candidate; do not let intermediate main builds reach staff. Record the current production deployment, SHA, built environment and cron definitions as the rollback target. Both known main baselines already include S1 digest protection; verify the actual target does too.
2. Complete the exact staging upgrade and role/rollback/capacity gates. Verify Production configuration, recoverable Supabase backup, disk/WAL headroom, migration-role privileges and schema/history parity. Preview must stay on staging; a preview build containing staging VITE values must not be moved onto the production domain as-is.
3. In a quiet, announced window away from shift starts and digest runs, CJ applies **0034–0047, then 0052–0062**, in numeric order, stopping on the first error. Keep file transaction boundaries, wrap 0046 atomically, and record each committed result/hash. If a file fails, the earlier committed expansions remain; leave the old app live and diagnose rather than replaying all files or restoring a backup automatically. Keep capture/processors/tracking off and packaging in scan mode during installation.
4. Complete the held merges and run CI on the final main tree. Build with Production values; inspect effective function durations and six cron entries, then promote that single candidate. Run the release smoke and monitor logs for at least 30 minutes. CJ tags the release as in RELEASING.
5. Commission features separately: approved real roster before F5 tracking; approved box rules/examples before automatic packaging; actual scanner prefix/suffix/range/interleaving/audio/wake-lock before receiver rollout. Keep classic stations available.
6. For reporting, enable capture once (global epoch change), then enable processors/rebuild each site until **published**; prove parity/freshness before setting that site's readMode to `summary`. Keep legacy reads meanwhile. Check the next scheduled refresh and all three real scheduled digests; a manual 200 does not prove scheduling. Set a storage/cleanup monitoring owner.
7. Enable timeline/Make integrations only with the correct production routing/scopes and their own acceptance. Automatic webhooks require signed raw-body deployed acceptance and subscription setup; do not silently subscribe or modify live Make pipelines as part of the app merge.

### Exact app-rollback story

1. **Stop admitting new shared work and preserve queues.** While the new app is available, settle or record every scanner/dispatch/packaging pending or uncertain request with its original ID. Do not clear browser storage or submit those orders manually because their first result is unknown. Record orders already auto-packaged/shared-dispatched so staff do not repeat them on the old UI.
2. **Use switches before replacing the app.** Set each reporting site to `readMode: "legacy"`, `processorEnabled: false` via the protected operator endpoint; stop active reporting work through the supported status/lease procedure. Set packaging to “Scan the box,” turn F5 tracking off if its behavior is implicated, and return receivers to classic after their queue is accounted for. Stopping a processor does not disable the source capture trigger. If capture itself is causing write failures or disk growth, use `disable-capture` deliberately: it changes the global epoch and requires all sites to rebuild before summary reads resume. A broken DB/control path needs the separately reviewed emergency runbook; Vercel rollback cannot repair it.
3. **Stop auxiliary ingestion.** Disable production reporter/subscription delivery where commissioned. Changing `ORDER_TIMELINE_INGEST` in Vercel settings alone does not alter an already-built deployment; redeploy to pick it up, or roll back to the verified pre-timeline deployment. Account for requests already in flight and old deployment URLs; printing must continue independently.
4. **CJ performs Instant Rollback to the recorded previous production deployment.** This restores that deployment's code, built environment and cron configuration; it does **not** revert Supabase. Do not rebuild old code blindly with new settings and call that the same rollback. Check login, clock events, fresh-order completion/deduction, Shopify lookup, shipments/CS/returns, Reports/Welcome and the protected digest. [Vercel rollback behavior](https://vercel.com/docs/instant-rollback).
5. **Leave all migrations and business records installed.** Old code ignores additive tables/columns, but the 0036 policies, capture/control dependency, F5 identity freeze, authorized deduction and F6/F7 duplicate guards remain. Existing shared-completed orders can be refused by the old UI rather than saved again. Known F4 exception: 0055 recognizes `prod:` deductions, not `pkg:` packaging history; re-completing an auto-packaged order on the old build can deduct another box. This exception was accepted in `docs/specs/box-auto-pick.md:494`; prevent those replays and reconcile any `prod:`/`pkg:` overlap with an audited stock adjustment. Do not delete ledger history.
6. **Fix git forward without an accidental redeploy.** CJ opens a reviewed rollback PR restoring application/configuration to the recorded pre-release tree, while retaining append-only migrations and evidence. With this stack, reverting only #22 does not undo the release, and reverting all merges wholesale would delete migration files. Test the rollback tree, merge under the held promotion process, and keep main aligned with live. Re-enable features only after the follow-up fix is verified.
7. **Database restore is a last resort**, with CJ accepting loss/reconciliation of writes since the backup. Browser JSON backup is incomplete and is not a database rollback. There is no safe automatic down-migration path promised by this release.

## HARDENING.md — every question

“Checked” below means inspected, not that every hosted gate has passed.

| Checklist question | Assessment / release requirement |
|---|---|
| 1: network/provider slow or down; visibility/loss | Scanner jobs retain uncertainty; reporting marks unavailable/stale; timeline errors do not drive production. F4 durability/auth failures are Must-fix 1–2. Make lost reports remain explicitly missing. |
| 1: retry/idempotency | Scanner/dispatch/packaging receipts and order locks, generation fencing and milestone occurrence keys exist; SQL race/replay evidence is recorded. Preserve request IDs; digest manual reruns can intentionally send another email. |
| 1: two people/devices at once | F5 optimistic versions/exclusion locks and F6/F7 order/clock locks have separate-connection staging evidence. Recheck composed capture-on stack and real scanner interleaving. |
| 1: unknown barcode/malformed/missing SKU/cancelled/wrong site | Strict scanner parser and complete-order checks, site authorization and timeline routing conflicts are covered. PR22 missing-stock warning is unit-tested but its real missing-item staging case was not run; include it. |
| 1: failure UX and recovery | Blocked/pending scanner jobs, Retry, packaging attention, stale reports and unavailable timing are explicit. Expired-session packaging currently loses Retry. |
| 2: person/department attribution | Per-scanner captured identity, immutable F5 snapshots and scan/manual F7 attribution; original caller/site queue ownership must also cover F4. |
| 2: shared counts | F1 shared reducer covers named core reports/counters/digest and set/UN/rework rules; older side-card exclusions remain documented. Verify published/legacy parity before activation. |
| 2: historical correctness | Department names/assignments and generation-pinned facts retained; no F5 retroactive attribution. F9 current-weight historical estimate assumption is disclosed. |
| 2: UTC/site time | Source timestamps are zoned/UTC and F1 uses site 04:00 production days with DST tests; fixed UTC cron times are intentional. Include AU/UK/US boundary cases in smoke. |
| 2: manual/inferred labels | F7 manual attribution and F9 measured/estimated are distinct; timeline full/partial and provenance remain explicit. No F12 inferred printed milestone is shipped. |
| 3: endpoint authentication/input | Reporting verifies JWT/membership/audience; operator/cron bearers are distinct; timeline owner reconcile, HMAC webhook and scoped Make paths validate input. Hosted raw-body webhook acceptance remains uncommissioned. |
| 3: new-table RLS/roles | All 47 new tables enable RLS; restrictive grants/checked functions reviewed. Exact upgraded-schema JWT/ACL acceptance still required. |
| 3: secrets location/logs | New secrets are server env, no new VITE secret exposure found; redacted reporting logging and removal of public whoami are positive. No credentials inspected or copied. |
| 3: cost/spam/data exposure | Auth and input/row bounds reduce exposure; real scheduler budget, bootstrap disk, token ownership and monitoring remain gates. Report role scope is derived server-side, not trusted from client selectors. |
| 4: expansion/old code | Structural compatibility holds with the explicit trigger/RPC/packaging exceptions above; full post-write rollback rehearsal is required. |
| 4: shop-floor off switch | F4 site mode, F5 tracking, receiver classic mode and reporting site controls exist. Timeline env gate requires deployment; preserve queues before switching. |
| 4: exact release order | SQL, secrets, merges, promotion, per-site activation and external commissioning are specified above; CJ executes them. |
| 4: staging per role | Require owner, manager, staff, kiosk, CS, plus anon/cross-site denial, and both old/new app flows on upgraded schema. Earlier partial acceptances are not a full final-stack pass. |
| 5: months-of-events queries | F1 preaggregates/pins generations; 0040/42 improve access paths; F8/9 impose bounds. F9 clock source scan and bootstrap require hosted measurements. |
| 5: external API per item | Existing artwork per-line calls use caches; F3 durable thumbnails are excluded. Scanner/timeline lookup is order-based, bounded, and read-only. |
| 5: two years/three sites | **Not established** by tiny fresh staging or offline fixtures; requires capacity/capture/refresh evidence, especially after the historical disk incident. |
| 6: detect breakage | Receiver health, packaging attention, report cutoff/staleness/run status, timeline conflict/missing-source logs and Vercel logs exist. Assign an operator to inspect them and the first real scheduled runs. |
| 6: manual fallback | Classic/scan path, legacy reads and explicit blocked-job handling; never rescan uncertain jobs as new work. Make/Shopify reporting remains optional to printing. |
| 6: ongoing maintenance | Reporting cleanup/retained generations, disk/WAL growth, token expiry, scopes/subscriptions, stale receivers and unresolved packaging need ownership. |
| 7: pure logic tests | Linux CI passes counting, routing, periods, timing, parser, rule and proof tests; new storage/auth regressions still needed. |
| 7: inventory/credit/money tests | Existing F4 reconcile and F6/F7 old/new SQL races protect the major changes; F4 retry loss and rollback cross-mode stock reconciliation remain gaps. |

## Other AGENTS.md guardrails

- `Repository.ts`, `DexieRepo.ts` and `SupabaseRepo.ts` are unchanged in the cumulative diff. Direct Supabase production/reporting additions have documented backend exclusions; no new shared-interface method lacks a Dexie implementation. Dexie is not evidence for production RLS or scanner acceptance.
- Migration diff is additions only. No tracked `.env*` beyond `.env.example` was added; new source/test/docs paths fit the root whitelist. Pre-existing untracked `supabase/.temp/` was not touched.
- New `pg`/`@types/pg` and pinned `@electric-sql/pglite` are dev-only, justified in `docs/plans/item-counting.md:1615` and `:2870`; no new browser runtime dependency is introduced by this stack.
- No production testing, SQL, merge, deployment or git state change was performed for this review. The only authored file is this review; requested compiler/build commands may create ignored build artifacts.

## Verification results

| Check | Result |
|---|---|
| `npx tsc -b` | PowerShell initially blocked the `.ps1` shim; equivalent `npx.cmd tsc -b` **passed**, exit 0. |
| `npm run test -- --run` | Retried through `npm.cmd` after the same shim issue; **could not start tests** because esbuild received `Access is denied` reading an ancestor directory and failed to resolve Vite config in this sandbox. Not a test assertion failure. |
| `npm run build` | `npm.cmd run build` completed its TypeScript stage, then **failed loading Vite config** with the same esbuild ancestor-directory permission error. No claim of a local build pass. |
| Exact HEAD Linux CI | Independently retrieved [run 45400163796](https://github.com/yaralabsPH/inkahub-kpi-app/actions/runs/45400163796), job `check` 138466328095: **success** for `95da008`. Frontend, digest and API type checks, tests, build and append-only check all passed. Log: **3,390 tests / 142 files**, build completed in 7.13 s. |
| Known six Windows migration-hash failures | Accepted as the supplied CRLF checkout issue and judged on green Linux CI. They were **not reproduced by this local attempt**, because test startup failed earlier. No migration bytes were changed. |
| Focused packaging reproductions | Read-only actual-module/fake-RPC checks reproduced expired-JWT queue removal and false durable enqueue without storage. No persistent fixture or app edit. |
| Hosted upgrade / full rollback / final role smoke | Not run in this review; required evidence is listed above. Older F5–F7 acceptance and newer timeline acceptance are credited only for their recorded scope. |

CI success establishes the automated gate, not operational readiness. Re-review the targeted fixes and the consolidated release evidence before changing this verdict to approved.

## Nitpicks

None; release safety takes priority over cosmetic cleanup.

## Coder response

Round 1, coder, 2026-11-24. Must-fix 1 and 2 are fixed in code; 3, 4 and 5 are release work that is not done yet.

- **Must-fix 1 (packaging retries lost on expired session / device-wide drain): fixed.** A session problem (PGRST301/302, JWT expired, `packaging: not_authenticated`) is now classified as no usable answer, so the request stays queued (`orderPackaging.ts` `isSessionProblem`). Each queued request records the account that captured it; `drain` sends only entries of the signed-in account and the current site, and skips the rest without removing them. With an unknown account nothing is sent. A settled refusal moves to a rejected list with its reason instead of vanishing. Tests: expired session keeps the request and the later send uses the same request id once; another account cannot send or discard; unknown account sends nothing; refusal is recorded.
- **Must-fix 2 (false durable queue): fixed.** `enqueue` returns true only when the request is stored on the device (false with no storage, a failed write, or a full queue; the request is still held in memory for the page). `submitPackagingApply` now stores the request BEFORE the first send and removes it only when the server settles it. If the answer is unclear and the request could not be stored, the result is `failed` with an explicit message, never `queued`. Tests: store-before-send is visible to a fresh page during the send; no-storage never reports queued.
- **Not done (release work, CJ and coder together):** 3 ordered upgrade rehearsal on a reconciled staging schema, 4 reporting publication/capacity proof and restore the three refresh crons in `vercel.json`, 5 written release boundary with held promotion and rollback drill. Should-fix items are not started.
- Evidence: `npx tsc -b` clean, `npm run build` passes, full test run 3395 pass; the same 6 Windows line-ending hash tests fail locally (CI on Linux is the check).

STATUS: COMPLETE
