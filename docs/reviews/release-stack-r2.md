# Review: bulk release stack — round 2

- Slug: `release-stack` · Branch: `feature/staging-fixes` (PR #22)
- Reviewed commit: `78f514dc8e6f64e28a9ca4da34e44170765cbd47`
- Comparison: `origin/main` at `8519ac9a9af66167903107d5ad8fb7a65e0278a9`
- Reviewer: planner (GPT-6 Astra)
- Date: 2026-11-24
- Verdict: changes required

**The stack is not approved for the proposed dormant release at this commit.** Keeping reporting capture and processors off avoids the failed publication workload, but does not preserve the new app's legacy Reports/Welcome path on a database with no published generation. A fresh installation returns `503 UNAVAILABLE`, and the browser consequently never starts its legacy evidence read. This is a release blocker, independently reproduced below. Do not enable reporting or manufacture a publication to work around it.

The ordered-upgrade and database rollback evidence materially improve readiness. Exact-commit Linux CI is green: **3,401 tests in 142 files**, all three type checks, build and migration check passed. Neither that evidence nor the old-app database smoke covers the newly identified dormant-read regression. Reporting publication remains a separate, unapproved commissioning project; G4 has not passed.

## Checked against

- [x] Relevant acceptance criteria and round-1 findings, including the coder response; individual dispositions below.
- [x] Plan tasks and release records; G4 and final application acceptance are explicitly incomplete.
- [x] AGENTS.md guardrails: backend contract, append-only migrations, RLS, secrets, whitelist, inventory tests, dependencies and human-only release actions.
- [x] `docs/HARDENING.md`, every question; matrix below.
- [x] `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` and `docs/RELEASING.md`.
- [x] Requested verification commands executed; local limitations and independently retrieved Linux CI results distinguished below.

### Scope and evidence boundaries

This covers #7, #10, #13, #11, #14, #15, #16, #17, #18, #19, #20, #21 and #22. **PR #12 is excluded**, as are the separate Team redesign and F12. F3's 0048–0051 remain reserved. The direct `origin/main`-to-HEAD diff is 458 files, 117,732 insertions and 2,304 deletions. Unlike round 1's local-main comparison, this uses the requested remote-main baseline. It is a cumulative release review, with focused inspection of changes since `95da008`, not a fresh line-by-line certification of the entire stack.

The rehearsal records live code as `79a0031`, verified by the coder against the deployment's source, and live deployment as `dpl_4r1s2fBXEdhNdUzooNN4BNHaWyZf`. Thus already-merged PR #6 (digest authentication) and #9 (order display) also reach production for the first time in this release. The record says the Vercel project has no Git connection: **merging does not deploy**. These are reviewed operator observations, not a new inspection of Vercel or live by this reviewer. CJ must reconfirm them on release day.

I inspected the rehearsal scripts and narrative, verified all 25 manifest hashes against committed Git blob bytes, ran local checks and in-memory reproductions, and retrieved GitHub CI evidence. I did not connect to either hosted database, execute the staging scripts, test against production, change app code, commit, push, merge or deploy. Hosted outcomes below are credited to the coder's recorded rehearsal, with its limits stated.

## Must-fix

### R2-1. Make legacy mode work before the first publication

`supabase/migrations/0044_reporting_reads.sql:544`, `api/_lib/production-reporting-rpc.ts:29`, `api/_lib/production-reporting.ts:214`, `src/lib/hooks/usePublishedProduction.ts:83`, `src/lib/domain/productionPublishedView.ts:32`.

The dormant installation has a site-state row with `read_mode='legacy'` and **no generation**. `read_reporting_generation` selects from `generations` joined to `site_state`; it returns zero rows. `parseGeneration` returns null. `resolveGeneration` immediately throws `UNAVAILABLE`, before the later `readMode` check can return `READ_MODE_LEGACY`. The controller only selects its legacy state for `READ_MODE_LEGACY`/`READ_MODE_SHADOW`; generic `UNAVAILABLE` produces `status='error'`. `rawRangeFor` then returns null. Both `Reports.tsx:309` and `Welcome.tsx:108` use that gate, so their core legacy figures do not load.

Fresh, offline evidence using the existing PGlite harness and the real 0037–0046 reporting migrations:

| Site | Processor | Capture | Read mode | Actual `resolveGeneration` result |
|---|---|---|---|---|
| AU | false | false | legacy | 503 `UNAVAILABLE` |
| UK | false | false | legacy | 503 `UNAVAILABLE` |
| US | false | false | legacy | 503 `UNAVAILABLE` |

A second reproduction connected the actual summary handler, RPC adapter, `PublishedViewController` and page adapter, with authenticated owner fixtures and the SQL-equivalent empty generation response. For **both** `view=reports` and `view=welcome`, the result was HTTP 503 `UNAVAILABLE`, controller `error`, source `published`, raw range **null**. These reproductions wrote no files and contacted no hosted service.

**Required correction:** after authentication and site/audience authorization, resolve the site's authoritative read mode independently of generation existence. An explicitly legacy site must select the existing legacy path even when it has never published. Preserve fail-closed behavior for missing/invalid site state, unauthorized access, database errors, and missing/incomplete publications in summary mode. Do not turn every 503 into a browser fallback, enable capture, or insert a dummy generation. If SQL changes are needed, append a migration; do not edit 0044.

**Required acceptance:** an integration regression with the real empty-generation schema, authorized API response and browser controller, covering AU/UK/US; summary-mode unavailable and unauthorized/cross-site cases must still fail closed. Then show the corrected final Preview's owner/manager Reports and applicable roles' Welcome loading real synthetic legacy counts with capture off, processors off and no published generation. Also check legacy CSV and dry digest. The digest already checks site status before publication at `daily-digest.ts:820`; it is a useful working comparison, not proof that the browser path works.

### R2-2. Correct the release contract and rollback safeguards

`docs/releases/bulk-release-plan.md:83`, `:134`, `:148`; `docs/releases/release-rehearsal-2026-11-24.md:129`; `docs/RELEASING.md:165`.

Before approval, the authoritative bulk handoff must incorporate these concrete corrections:

1. Remove the assertion that old-app smoke establishes that the new legacy Reports/Welcome paths are unchanged and safe. Record R2-1 and its eventual final-build acceptance. Old SQL calls do not exercise the new API/controller selection.
2. State all three dormant controls together: **global capture off, every site's processor off, every site's read mode legacy**. The day-one table currently omits processors. Replace the routine later “enable capture, rebuild” recipe with an explicit **planner-approved commissioning prerequisite**. G4's failed capacity result is not a gate that can be cleared merely by waiting until after release.
3. Describe refresh crons accurately: they do no publication work while processors are disabled, but they are not silent successful no-ops. They perform reads, attempt a run-log insert and return HTTP 500 `processor_disabled`. Name the monitoring/retention owner and distinguish this expected disabled result from actual configuration/database errors. A small guarded-idle code change would be reasonable, but is not required merely to stop publication; accurate operations instructions are required.
4. Carry the **pre-digest-auth rollback exposure** into the bulk rollback procedure. The identified target `79a0031` has an unauthenticated digest with recipient override. `CRON_SECRET` does not protect that old code. Before using this target, CJ must have a verified way to block unauthenticated external access to that endpoint, including applicable deployment URLs, or use a separately validated safe rollback build. Prefer fixing forward where practicable. Existing `docs/RELEASING.md:165` already requires this; the new bulk procedure must not omit it or promise protected-digest behavior after rollback.

Keep G6 unapproved and G7 open until the corrected build and required role smoke are reviewed. These are the remaining dormant-release blockers; full G4 publication/capacity repair is **not** demanded as part of a correctly implemented dormant release.

## Round-1 disposition

“Resolved” here is scoped to the named defect/evidence, not permission to activate a feature.

| Round-1 item | Disposition | Evidence and remaining boundary |
|---|---|---|
| Must-fix 1 — packaging auth/account retry loss | **Partially resolved** | `774d69e` retains PGRST301/302 and recognized session failures; drain supplies current site and skips entries owned by another account. New tests cover expiry, later same-ID delivery, account/site separation and no signed-in account. My actual-module reproduction retains the expired-JWT entry. However missing-function/configuration errors and malformed success responses still become settled rejections (`orderPackaging.ts:138–148`), and drain removes them from pending. Reproduction: pending 1→0 for both PGRST202 and malformed `{status:'applied'}`. `listRejected` has no production UI consumer. Null/absent owners are allowed through the compatibility path, and ownership is read once per drain, not bound to every RPC's current session. Do not certify the entire round-1 “uncertain answer/account switch” requirement as closed. These remain F4 activation work; keep every site in scan mode for this release. |
| Must-fix 2 — false durable queue/send-before-store | **Resolved for the reported defects** | `packagingOutbox.ts:114` now returns false without storage or after a failed write; `packagingSubmit.ts:37` attempts persistence before RPC. Quota/no-storage return an explicit failed result rather than “queued”; tests exercise fresh-page visibility during send and no-storage failure. This is conditional durability: line 38 still sends when `stored=false`, so reload during that send is not guaranteed recoverable. The first-send refusal is shown immediately rather than archived. Do not claim guaranteed offline delivery on a device with failed storage; qualify that before F4 activation. |
| Must-fix 3 — literal ordered upgrade and old-app compatibility | **Resolved for database rehearsal; release-day preconditions remain** | Rehearsal §§1.1–1.5 records reconciled pre-0034 schema/ACL fingerprints, synthetic live-sized data, postgres execution, all 25 files with bounded timeouts, +5 MB installation growth, timeout/replay drills, effective grants and old-call smoke. All manifest hashes independently match HEAD. This is substantial new evidence, not the earlier consolidated baseline. It does not measure busy-production contention or replace final browser/JWT smoke. See evidence qualifications below. |
| Must-fix 4 — reporting commissioning and refresh scheduling | **Partially resolved** | `206ea68` restores all three staggered 15-minute refresh crons and updates the schedule test. G4 is explicitly **not passed**; first publication never completed. Its throughput/storage findings justify deferring capture/publication, not enabling them. The dormant alternative additionally needs R2-1. Processor-off semantics are verified below. |
| Must-fix 5 — release boundary and rollback | **Partially resolved** | Bulk manifest, dependency order, exact recorded live deployment/code, no-Git-connection observation and new-write/old-call drills now exist. The second-box edge and audited correction are documented. G5 is database-call replay, not a browser deployment/queue drill; G7 remains open. The concrete old target also restores the public digest, omitted from the bulk rollback instructions: R2-2. |
| Should-fix 1 — reconcile docs/env names | **Partially resolved** | `c85cebc`/`30eb6e5` add a consolidated plan and correct `.env.example` server keys, operator/cursor secrets and dormant timeline names. Older feature notes and the round-1 coder response remain historical; the bulk plan itself still says G3 timing is unmeasured after recording it as done, and references an earlier source commit. Treat this review plus the rehearsal as current evidence, not every old “pending”/Hobby statement. R2-2 covers safety-relevant corrections. |
| Should-fix 2 — visible operational limitations | **Partially resolved** | Bulk plan discloses F1 historical count changes and the rollback box edge; G4 failure is explicit. It still omits the complete operator limitations: packaging Reports net/digest gross, F9 current weights applied to historical estimates and incomplete-clock refusal, timeline recorded-order coverage. These are retained below and must accompany later activation. |
| Should-fix 3 — inherited risks separate | **Partially resolved** | Old-call smoke adds useful stock/shipment/case/return compatibility evidence; repository adapters remain unchanged. It does not test all return stock-sign/closure transitions or prove full backup/restore. Retain the architecture risk backlog and obtain a real database recovery point; do not infer safety from the hidden browser-backup banner. |
| Should-fix 4 — portable migration hashes | **Open, nonblocking follow-up** | No hash-test portability change was made. Raw-checkout byte hashes remain sensitive to Windows CRLF. Linux CI is the authority for these known six failures; preserve migration immutability. All 25 committed-LF manifest hashes match independently. |

## New code and evidence review

### Packaging and local Settings

`774d69e` is a meaningful improvement: it adds no dependency or schema change, stores the request before its first RPC attempt, scopes normal drain delivery and preserves the original idempotency key. Unit tests exercise the new storage/auth paths; database replay is separately supported by F4 assertions and the G5 drill. It does not prove all account-transition, malformed-response or storage-failure recovery cases. A rejected-list entry is not itself a worker-visible recovery flow. The live build predates F4, so no production F4 queue migration should be necessary, but existing browser queues must be inspected if any candidate build was used on a station. Scan mode does not cancel old entries: `useOrderPackaging.ts:138–155` drains on mount/interval regardless of mode.

`78f514d` changes only the two packaging cards' auth access: `PackagingRulesCard.tsx:45` and `PackagingAttentionCard.tsx:110` use `useAuthOptional()?.profile ?? null` before their backend/role guards. `AuthProvider.tsx` defines this as a non-throwing `useContext`. In Dexie, the card returns null without constructing its Supabase inner component; with a Supabase provider, the existing role check is retained. Hook order remains unconditional at the wrapper level. Static review supports this narrowly scoped crash fix; final Dexie Settings and Supabase owner/non-manager render checks are still appropriate. It does not fix or conceal R2-1.

### G3 and G5: what the files establish

The rehearsal records fingerprint agreement for public columns, constraints, indexes, function bodies/security/configuration/ownership, policies, triggers, table/schema/default ACLs and extensions, with function ACL ordering differences explicitly reconciled. It records live PostgreSQL 17.6, staging 17.12, `postgres` CREATEROLE, expected production-event policy names, no conflicting `pkg:%` ledger rows, and `btree_gist` installed into `extensions` by the upgrade. The 10-fingerprint script covers those categories; this is a reconciled application-schema fingerprint, not a byte-identical whole managed Supabase installation.

Recorded synthetic volume is 114,011 events, 35,132 ledger rows, 209 products and the associated synthetic users/badges/sales/layout/shipments. No live business rows were copied. Staging was 66 MB before and 71 MB after migration installation; live was recorded as 78 MB. The file-time table totals about 0.66 seconds: 0047 37 ms, 0054 44 ms, 0055 123 ms. These are server-side file intervals on that staging run, useful bounds on its transaction duration, **not a promise that a busy live writer waits at most 123 ms**. Locks may wait up to the configured timeout, and live resource/concurrency conditions differ.

The narrative records F4–F7 assertion scripts completing, with sentinels after their final rollback, and old app database calls passing. `50-old-app-smoke.sql` switches to authenticated with synthetic JWT claims and exercises event insertion, deduction/replay, shipment credit/reverse/delete, case/return inserts, manual stock adjustment, owner settings/badges/sales and clock reads. The “9/9” shorthand is not nine browser flows: the script emits ten result rows, one unconditionally true and nine boolean assessments, plus standalone SELECT output. It is not full CS return lifecycle or browser acceptance. G5's two scripts exercise new shared/classic-auto writes, same-ID retry, old duplicate guards and the `pkg:`/`prod:` second-box overlap. Some result rows deliberately log `true` with diagnostic text, so the observed details, not only a green boolean count, matter.

Two evidence-tool limitations should be retained:

- `run-ordered-upgrade.sh:8,29–30` has `set -u` but no pipeline exit-status handling; it detects one JSON error substring. A CLI timeout/non-JSON failure could be printed as “ok.” Its recorded successful server timing rows support this completed rehearsal, but **do not reuse it as a production stop-on-error runner**. It explicitly refuses the live ref. CJ's production procedure must inspect each SQL result and committed state before advancing.
- The rehearsal Markdown and runner output do not end in the AGENTS.md handoff status line. Normalize the next evidence handoff to that protocol; missing output/status is not permission for an automated loop to infer a pass or rerun. This review supplies its own status for completion of the review only.

### G4 and the exact meaning of dormant

The capacity record is internally consistent with the code's sequential RPC/checkpoint work: 15,087 AU owners; default-region calls completing 348/408 owners; same-region light work improving to 2,070; heavy work falling to 64/63/55 per four-minute call. About 2,900 owners completed before stopping. Recorded database growth was 74.5→329 MB, with 119 MB source candidates, 71 MB input pieces and 60 MB input events, before 20% of AU. Abandon/cleanup did not immediately release that space. These are measured staging findings, not a precise production completion-time forecast. No complete first publication, incremental refresh cycle, full three-site/two-year capacity proof or capture-on composed acceptance was achieved. The record says staging ended with capture off, processors off, all sites legacy and no publication; this review did not query its current state.

Source verification of the dormant controls:

| Control | Actual behavior |
|---|---|
| Capture off | 0037 defaults false. The replacement capture trigger in `0038_reporting_jobs.sql:101–108` still reads and takes a shared lock on the control row, then returns before journaling when disabled. No source-copy/journal growth, but not zero trigger work; a missing control row still refuses the source write. Preserve that row and its grants. |
| Processor off | `production-reporting-worker.ts:850` checks the owner-input protocol, then `acquire` reads status and rejects at line 259 **before** starting/resuming a batch. No copy, materialization, staging or publication follows. SQL begin/rebuild functions also check processor/capture controls. |
| Refresh cron | `vercel.json` has three digest plus three refresh entries. With a healthy fully migrated database and valid secret, disabled refresh calls protocol/status and `record_reporting_run`, produces `state='failed', failureKind='processor_disabled'`, and the handler returns 500 (`refresh-summaries.ts:44`). An actual-module fake-RPC reproduction observed exactly those three calls and zero materialized owners. Across three sites this schedules 288 invocation/log attempts per day. Retention is implemented in explicit cleanup, not automatically run by this disabled branch. Do not call this “doing nothing” or enable processors to silence the errors. |
| Legacy reads | Database defaults are correct; digest branches on site status. **New browser Reports/Welcome fail before first publication: R2-1.** F8/F9 published overview/timing are intentionally not commissioned. Staff/CS do not get the owner's legacy whole-team Reports tree (`Reports.tsx:188–240`); communicate their unavailable published view rather than granting broad data access as a workaround. |

Later reporting planner work must address repeated owner-input storage, RPC latency/region placement, heavy-owner progress, lease/duty cycle, abandoned-data retention/reclamation, explicit disk/WAL budgets and operator observability. Require a complete first publication plus incremental update/retry, role-filtered summary/detail/CSV/dry-digest parity, F5/F6/F7 capture composition, F5 volume and F9 clock-read latency, and two-year/three-site measurements before commissioning. Regional placement alone does not resolve the demonstrated heavy-owner/storage problem.

## CJ's release-day conditions after the Must-fix items are closed

This is the required checklist for a later dormant-release approval, **not authorization to release this HEAD**.

### Before the release window

1. Obtain the corrected-code re-review and green CI for that exact candidate and final merged main. Close G7 on the final staging Preview, with capture/processor off and no publication. Record owner, manager, staff, kiosk and CS login/nav/access; anon and cross-site denial; kiosk clock in/out exactly once; classic completion/dispatch and retry deducting once; missing-product warning; Shopify lookup; shipments; CS case/return saves and stock effects; Settings in both backends; Dashboard/Welcome/Reports loading with console inspection; CSV and authenticated dry digest. Test role/account switching. Do not use a production database for these tests.
2. Reconfirm the live deployment/code and absence of Git integration. Record the rollback target, an actual Supabase backup/recovery point, recovery ownership and verified disk/WAL headroom. Browser JSON backup is not a full backup. Document/test the pre-auth-digest rollback protection from R2-2. Retain the rehearsal evidence and exact SQL manifest.
3. Announce a quiet window away from shift starts and digest schedules. CJ alone performs live SQL, merges, deployment and any rollback. Leave old code serving until the upgrade and final build are ready; do not expose intermediate stack combinations.

### Production environment, before building/deploying

| Variables | Required condition |
|---|---|
| `VITE_BACKEND`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | `supabase`, intended live project and its public anon key. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Server values for the **same** live project; no staging key/URL mix. Service key never in a `VITE_*` value. |
| `CRON_SECRET` | Nonblank random server secret before deployment: digest authentication reaches live for the first time. Check both digest and refresh invocation auth. |
| `REPORTING_OPERATOR_SECRET` | Nonblank, distinct from `CRON_SECRET`, restricted to CJ/operator use. Configuring it does not authorize commissioning. |
| `REPORTING_CURSOR_SECRET` | Stable random server secret for signed report cursors; configure now. It is not a feature flag and is not needed to manufacture a publication. The docs' blanket “every report returns 500 without it” is broader than the code: cursor-bearing/paging paths require it. |
| `REPORT_RECIPIENT`, `RESEND_API_KEY`, `FROM_EMAIL` | Explicit intended production recipient, valid provider key and sender; no throwaway Preview inbox. |
| `REPORT_RECIPIENT_ALLOWLIST` | Explicit intended override list, or empty/unset to disallow overrides. Never use a manual send as a harmless health check; use authenticated `dry=1`. |
| `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` | Existing intended shop/read access for order lookup; verify lookup independently of dormant timeline ingestion. |
| `DROPBOX_ACCESS_TOKEN`, `DROPBOX_IMAGE_FOLDER` | Existing artwork lookup configuration; no F3 webhook/backfill activation. |
| `ORDER_TIMELINE_INGEST`, `ORDER_TIMELINE_ROUTING`, `SHOPIFY_WEBHOOK_SECRET`, `MAKE_MILESTONE_SCOPES` | **Leave unset** for this release. No live Make edits, Shopify webhook subscriptions or Slack/F12 setup as part of the stack release. |

Preview must retain staging URLs/keys, its own secrets and safe recipients. Deploy one final **Production-configured** build. If promoting a Preview, account for the new production build and verify its resulting configuration; promotion is not proof that the already-tested Preview artifact is unchanged. Vercel documents that Preview promotion rebuilds with Production variables. [Vercel promotion documentation](https://vercel.com/docs/deployments/promote-preview-to-production).

### SQL, switches, merge and deployment

1. Reconfirm the preflight schema/history, PostgreSQL 16+, role capability, expected 0036 policies, extension placement/availability, actual stock constraint, grants and absence of conflicting packaging ledger keys. Stop on unexplained installed objects/numbers or drift. The rehearsal's read-only live observations do not freeze production until release day.
2. Apply **0034–0047, then 0052–0062**, exactly the 25 committed files whose hashes match the bulk manifest, one at a time. Do not fill 0027 or 0048–0051; do not replay 0001–0033, staging reset/seed/assertion scripts, or a consolidated baseline. Use `SET lock_timeout = '10s'; SET statement_timeout = '600s';` for each file's session, matching the ordered rehearsal. The separate lock drill used 3s; it does not change the production manifest's 10s choice.
3. Preserve each file's transaction boundaries. **0046 must be atomic**, either an explicit wrapper or a verified single transaction execution. Do not concatenate the entire release into one outer transaction or let a runner split 0046 into autocommitted statements. Record each file/hash/commit outcome. On failure, stop, determine rollback/commit state and diagnose with the old app still live; do not blindly replay successful files or raise timeouts. Any repair is append-only and reviewed.
4. Verify effective RLS/grants and the three site-state rows after installation. **Capture remains false globally; processorEnabled remains false and readMode legacy for AU, UK and US.** No `enable-capture`, no processor activation, no rebuild, no summary/shadow mode, no seeded generation. No publication commissioning on release day. Preserve reporting control rows; do not disable safety triggers to make a smoke test pass.
5. Keep **all sites packaging scan**, F5 tracking off and receivers in classic mode; no shared-scanner/dispatch activation. Inspect/account for any existing pending queues before mode/account/build changes. Never clear browser storage or rescan an uncertain request as new work. Later F4 activation needs the remaining retry cases resolved and Max's validated rules/examples; F5 needs the roster; F6/F7 need actual hardware and queue acceptance. The dormant verdict would not approve those activations.
6. Merge in dependency order **#7, #10, #13, #11, #14, #15, #16, #17, #18, #19, #20, #21, #22**, retargeting/checking children with merge commits as the bulk plan specifies, excluding #12. Wait for final main CI. With no Git connection, merging alone changes no production deployment; reconfirm that before each release. Explicitly deploy/promote only the final verified Production build.
7. Confirm the effective two reporting function limits of 300 seconds and all six cron entries: digest AU `55 13 * * *`, UK `55 22 * * *`, US `55 4 * * *`; refresh AU `0,15,30,45 * * * *`, UK `1,16,31,46 * * * *`, US `2,17,32,47 * * * *`. Observe the expected disabled-worker result without enabling it. Check that no batches/source candidates/owner journals are being created.
8. Repeat the production smoke read-only where possible; CJ supervises any real-order check and verifies exactly one movement. Monitor logs and stock/scan complaints for at least 30 minutes, and confirm the next actual scheduled digest for each site in logs/inbox. Name the operator for disabled cron logs/retention, database growth, secrets and missing-data/queue follow-up. Record release evidence and tag through CJ's normal process.

### Rollback and operator limitations

Preserve and reconcile queued/uncertain original request IDs before replacing the app. Switch implicated shop-floor behavior off; keep reporting legacy/off/off. Capture is independent of processor state: if it was accidentally enabled, stopping processors does not stop journal growth; CJ must use the deliberate capture-disable procedure and record the epoch change. Block the old target's unauthenticated digest exposure **before** rollback. Rollback restores the old deployment's code/configuration, not Supabase; changed dashboard env values do not retrofit that artifact. [Vercel Instant Rollback](https://vercel.com/docs/instant-rollback).

Leave all migrations and business records installed. Shared duplicates may be refused by the new database even under old UI. Classic auto-packaged orders can take a second box if re-completed with the old code: prevent re-completion, inspect `pkg:`/`prod:` overlap and use an audited stock adjustment without deleting ledger history. Fix application code forward in git while retaining migration files; reverting #22 alone does not undo this stack. A database restore is a last resort with explicit reconciliation of intervening writes.

Tell operators that F1 changes historical totals, including unframed/set counts; F8/F9 published features are unavailable until commissioned; corrected packaging is net in Reports but gross in the digest; F9 historical estimates use current weights and refuse incomplete clock evidence; timeline covers recorded evidence/orders, not a complete historical census. F3 and F12 are not delivered. These limitations do not justify silent fallback, invented attribution or disabling access checks.

## HARDENING.md — every question

“Checked” is not a claim that the open acceptance gates passed.

| Item | Review result / remaining requirement |
|---|---|
| 1 — Network/provider down or slow; visibility and loss | Existing scanner uncertainty/pending states and packaging warnings remain. Expired-token packaging is improved; incomplete uncertainty/storage recovery remains an activation gate. Shopify/Dropbox failure must stay visible; timeline/Make ingestion stays off and never blocks printing. Dormant reporting UI currently fails: R2-1. |
| 1 — Retry/idempotency | Original request IDs and SQL receipts/order locks protect replay; F4–F7 assertions and G5 support inventory behavior. Browser tests cover the repaired expiry path, not every session race. Digest reruns can send another email intentionally. |
| 1 — Concurrent people/devices | Existing F5 version/history locks and F6/F7 serialization/race evidence carry forward; new patch changes no SQL locking. Final shared hardware/interleaving and capture-on composition remain outside dormant approval. |
| 1 — Bad barcode/input/SKU/cancellation/site | Strict scanner parsing, complete-order checks and site/RLS restrictions remain; missing-stock warning needs final application smoke. Do not confuse malformed server success with a definitive failed packaging write. |
| 1 — Failure UX/recovery | Queues/Retry/attention and missing-data states exist. Archived drain rejections have no production UI consumer. Do not clear storage/rescan uncertain orders. Legacy reporting recovery is broken until R2-1. |
| 2 — Correct person/department | F5 immutable snapshots and F6 captured scanner identity/F7 attribution remain; auth-scoped packaging is improved with null-owner/mid-drain limitations. Tracking/shared modes stay off. |
| 2 — Shared counts/orders/items/sets | F1 shared rule is used by the intended report/counter/digest paths, with existing edge tests. Historical counts change. Dormant browser selection must reach that rule; published/legacy parity remains commissioning acceptance. |
| 2 — Historical correctness after settings changes | Department snapshot/history and versioned reporting remain; no retroactive department fill. F9 current-weight historical estimation is explicitly qualified. |
| 2 — UTC/site time | UTC source times and shared site production-day/DST tests remain. Fixed UTC schedules are specified above; final AU/UK/US boundary smoke required. |
| 2 — Manual/inferred versus measured | F7 manual framer and F9 measured/estimated labels remain; incomplete clocks refuse results. Timeline provenance/full-partial distinction remains; F12 inference is not shipped. |
| 3 — Endpoint auth/input | Verified current reporting auth derives profile/site/nav server-side; scheduler/operator secrets are distinct, commands strict. No new endpoint in these fixes. Preserve authorization before the R2-1 mode lookup. Timeline/Make remain gated; automatic signed-webhook acceptance is deferred. |
| 3 — RLS/roles | Migration source remains append-only with RLS/restricted grants; G3 records effective private-schema/anon/service grants and authenticated-role checks. Final owner/manager/staff/kiosk/CS/anon/cross-site HTTP acceptance is still G7, not implied by navigation. |
| 3 — Server-only secrets/logs | `.env.example` adds names/placeholders only; no new secret exposure found. Service/operator/cursor/provider secrets must stay server-side; no secret values were inspected/copied here. |
| 3 — Cost/spam/data exposure | Protected endpoints and bounded readers remain. Disabled refresh still costs invocations and log rows; full publication has failed capacity. Old rollback target reopens email/data exposure without external protection: R2-2. |
| 4 — Expansion/old app on new schema | 25 migration additions, unchanged since R1; same declared existing RPC returns. Policy/function/trigger changes still affect old callers. G3/G5 substantiate database compatibility with the documented duplicate-box exception, not unrestricted rollback safety. |
| 4 — Feature off switches | Packaging scan, tracking off, classic receivers and reporting controls exist. Reporting off stops publication but not all metadata work; its legacy read switch needs R2-1. Ingestion env changes require a new deployment or rollback to take effect. |
| 4 — Exact operator release sequence | Environment/migration/order/abort/deployment instructions above; bulk plan needs R2-2. No live SQL/merge/deploy by agents. |
| 4 — Staging per role | G7 remains open. Final corrected new build and old rollback candidate need the applicable role/application checks; SQL JWT-claim replay and an available Preview URL are not completed browser smoke. |
| 5 — Months of events/indexes/preaggregation | Existing keyed indexes and bounded report readers remain. Dormant legacy reads still use source evidence; measure final application latency. Published aggregation cannot be commissioned on the G4 evidence. |
| 5 — External API per item | No extra per-item provider request introduced by the two code fixes. Existing artwork cache/order lookup limitations persist; F3 durable-thumbnail work is excluded. |
| 5 — Two years/three sites | **Not proved.** G4 failed even before a complete first AU publication. Dormant scope defers the new worker capacity obligation; it does not certify unlimited legacy query capacity. |
| 6 — Detect production breakage | Vercel logs, queue/stock warnings, receiver health and missing-data states exist. Separate expected `processor_disabled` from real failures; inspect every site's scheduled digest and growth. R2-1 must not be mislabeled expected dormancy. |
| 6 — Manual shop-floor fallback | Classic stations/box scans remain the day-one path. Preserve unknown outcomes and original IDs; no blind rescan. Legacy reports require the identified fix. Printing stays independent of dormant integrations. |
| 6 — Maintenance | Assign disk/WAL/log-retention/token/queue owners. Disabled refresh does not invoke retention; abandoned publication space is not immediately reclaimed. No webhook subscription maintenance starts until separately commissioned. |
| 7 — Pure logic/edge tests | Exact-head Linux CI: 3,401 passing tests. New packaging auth/storage regressions are present. Missing empty-publication legacy regression is demonstrated by R2-1; add it across real SQL/API/controller boundaries. |
| 7 — Inventory/credit/money old and new tests | F4 rule/reconciliation tests, F6/F7 assertions and G5 replay/deduction checks provide evidence. Full account/storage recovery and final browser smoke remain; inherited CS sign/closure and multi-request risks are not certified fixed. |

## Other AGENTS.md guardrails

- `Repository.ts`, `DexieRepo.ts` and `SupabaseRepo.ts` are unchanged against `origin/main`; no shared interface addition is missing a backend implementation. Supabase-only production/reporting scope is documented. The optional-auth change repairs a Dexie wrapper without claiming full feature parity.
- Migration diff against `origin/main` is **25 additions only**, 0034–0047 and 0052–0062. No existing file modification/deletion, destructive migration or new migration in the R2 fixes. All 25 manifest SHA-256 values match committed LF bytes. Add any needed correction as a new reviewed migration, including its staging and rollback consequences.
- New paths fit the `.gitignore` whitelist; only `.env.example` is tracked among changed env files. Pre-existing untracked `supabase/.temp/` was left untouched. No new dependencies in `774d69e`/`78f514d`; the stack's dev-only `pg`/types/PGlite additions retain their item-counting plan rationale.
- The rehearsal's reset/seed/drill scripts are destructive or mutating **staging utilities**, not production migrations. Their existence does not authorize agents to apply live SQL. The reviewer used only offline in-memory SQL.
- Only this review was authored. Requested compiler/build attempts can generate ignored compiler artifacts. No git state-changing commands or production operations were performed; no task commit was made, as explicitly instructed.

## Verification results

Commands used the Windows `.cmd` shims for npm/npx; the requested scripts/arguments were unchanged.

| Check | Fresh result |
|---|---|
| `npx tsc -b` | `npx.cmd tsc -b`: **passed**, exit 0. |
| `npm run test -- --run` | **Could not start**, exit 1: esbuild `Cannot read directory "../../../../..": Access is denied`, then cannot resolve/load `vite.config.ts`. No local test assertions ran. |
| `npm run build` | TypeScript stage completed; Vite **failed to load config**, exit 1, same ancestor-directory denial (`vite.config.js` after compilation). No local bundle-pass claim. |
| `npm run typecheck:digest` | **Passed**, exit 0. |
| `npm run typecheck:api` | **Passed**, exit 0. |
| Exact-head Linux CI | Independently retrieved [run 45428660883](https://github.com/yaralabsPH/inkahub-kpi-app/actions/runs/45428660883), job 138567558178, associated with `78f514d`: **success**. All three type checks, **142 files / 3,401 tests**, build (7.13 s), and append-only check passed. Existing Browserslist/XLSX/chunk-size warnings remain. PR CI checks immutability against its stacked base; this review additionally checked additions-only against `origin/main`. |
| Six known Windows CRLF migration-hash failures | Pre-existing coder-reported failures; **not reproduced by this invocation**, which stopped before tests. Raw-file hash assertions are checkout-sensitive; Linux CI with committed LF bytes is the authority. Do not rewrite migrations or weaken immutability to make Windows green. |
| Manifest | **25/25** committed-blob hashes match bulk-release manifest; no mismatches. |
| Dormant mode regression | Real in-memory reporting SQL returns zero generation rows for all three fresh legacy sites; actual API/controller reproduction gives 503 `UNAVAILABLE` and disables legacy data loading for Reports and Welcome. **Blocker reproduced.** |
| Disabled worker | Actual worker/fake RPC: protocol read, status read, run-log write only; failed `processor_disabled`, zero materialized owners. Handler maps that result to 500. |
| Packaging follow-up | Actual-module/fake RPC retains expired-JWT request. Missing-RPC and malformed-success responses remove it from pending into rejected storage; no production rejected-list UI consumer exists. |
| Hosted rehearsal / browser smoke | Reviewed recorded G3/G5 and failed G4 evidence; not rerun or independently observed here. G7 remains outstanding. |

## Should-fix

1. **F4 activation blockers:** finish the uncertainty/recoverable-configuration classification and worker-visible rejected recovery described in the round-1 disposition. Cover unowned new entries, an account change during a multi-entry drain, and failed storage before first send/reload. Keep the original ID until the outcome is truly settled. The current scan-only release boundary may defer this work; enabling automatic packaging may not.
2. **Rehearsal tooling:** preserve CLI/pipeline failure codes, require evidence of each committed completion and the AGENTS.md terminal status, and make logged observations versus assertions explicit. Keep it staging-only. This is not a reason to discard the documented successful timing rows, but it prevents false future success reports.
3. **Documentation/operations:** reconcile stale G3/source-commit/feature status text and carry all accepted limitations into the operator handoff. Consider returning an explicit successful disabled/idle result before worker work, with a regression proving no batch or journal mutation; until then use the actual 500/log behavior documented here and maintain its retention.
4. **Portable hashes and inherited risks:** track CRLF portability separately without changing committed migrations. Keep CS return signs/closure, multi-request writes, historical row caps and incomplete browser backup on their existing remediation backlog.

## Nitpicks

None. The two Must-fix items and final dormant-mode acceptance take priority.

## Coder response

(Coder fills this in after fixing. Record the R2-1 regression and corrected final-build evidence, the R2-2 release-document changes, exact CI commit, and which commissioning gates remain blocked. Do not change G4 to passed or G6 to approved on the strength of this review's completion status.)

STATUS: COMPLETE
