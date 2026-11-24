# Review: bulk release stack — round 3 (final)

- Slug: `release-stack` · Branch: `feature/staging-fixes` · PR: [#22](https://github.com/yaralabsPH/inkahub-kpi-app/pull/22)
- Reviewed commit: `5ff0668d4723754443a48111baeab196c4f8bb1c`
- Comparison baseline: `origin/main` at `8519ac9a9af66167903107d5ad8fb7a65e0278a9`; focused changes since round 2 / `ced4258`.
- Reviewer: planner (Codex)
- Date: 2026-11-25
- Verdict: approved (with conditions)

**Approved for the DORMANT release only.** R2-1's code defect is resolved and R2-2's safety corrections are present. No further code change is required for this restricted release by this review. CJ must close the release conditions below before proceeding, especially **G7 browser smoke on Preview `inka-arthouse-g1on6rg21`, green candidate/final-main CI, and selection and validation of a safe rollback target**. This is conditional G6 approval in the final allowed review round, not a claim that G7 or deployment has happened.

**G4 is not passed and is not required for this dormant release.** Global capture stays off, all AU/UK/US processors stay off, and all three sites stay in legacy read mode with no publication. Published reporting commissioning remains unapproved. Do not enable capture, start a rebuild, seed a generation or change to shadow/summary to complete the smoke test.

## Checked against

- [x] Round-1/round-2 findings and acceptance boundaries, including the round-2 coder response.
- [x] Bulk release plan, rehearsal and applicable feature acceptance; unfinished commissioning and CJ acceptance remain explicitly open.
- [x] AGENTS.md guardrails: both backends, append-only migrations, RLS, secrets, whitelist, inventory tests, dependencies and human-only release actions.
- [x] `docs/HARDENING.md`, every question; matrix below.
- [x] `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, and release/rollback requirements in `docs/RELEASING.md`.
- [x] New regression coverage inspected and independently exercised offline; requested checks attempted. Local restrictions, green exact-HEAD Linux CI and recorded hosted acceptance are distinguished below.

### Scope and evidence boundaries

Same cumulative stack and exclusions as [round 1](release-stack-r1.md) and [round 2](release-stack-r2.md): **#7, #10, #13, #11, #14, #15, #16, #17, #18, #19, #20, #21, #22**. Exclude #12/F3 (0048–0051 remain reserved), the separate Team redesign/#8, the separate UI redesign, and F12. F10 retains its previously accepted durations-only scope; this review adds no scope or activation approval.

`f7240d1` changes two reporting modules, regression tests and release instructions. `22015bc` records deployed-Preview API acceptance; `5ff0668` records the coder response. A fresh diff confirms that **only documentation changed after `f7240d1`**. The Preview at that code commit therefore covers the reviewed application code, subject to CJ confirming its actual deployment/configuration on release day.

This is a focused final release review carrying forward the cumulative findings, not a fresh line-by-line certification of the whole stack. The G3 ordered-upgrade and G5 new-write/old-call database rehearsal remain accepted with round 2's limits: synthetic staging data, SQL-call evidence rather than browser acceptance, and measured staging intervals rather than a maximum live lock wait. The recorded live build `79a0031`, deployment `dpl_4r1s2fBXEdhNdUzooNN4BNHaWyZf`, and absence of Vercel Git integration are coder observations for CJ to reconfirm. PR #6 digest authentication and #9 order display are already on main but also reach live in this release unless CJ first deploys the safe rollback candidate described below.

I inspected source/tests/docs, ran local checks and an in-memory PGlite verification, checked GitHub through its connector, and recomputed manifest hashes from committed bytes. I did not connect to either hosted database, inspect secret values, run a hosted smoke test, send email, change app code, commit, push, merge, deploy or apply live SQL. Only this review is authored; requested compiler/build commands may emit ignored compiler artifacts. Existing untracked `supabase/.temp/` was left untouched.

## Must-fix

**None remaining in code for the dormant scope.** The following release-day conditions are mandatory gates, not waived tests. A failed condition stops the release; this verdict does not authorize a workaround or feature activation.

### R2-1 — resolved in code; final browser acceptance stays with CJ

`api/_lib/production-reporting.ts:221` now distinguishes a missing unpinned generation from a missing pinned version. Only the former asks `PublishedReader.siteReadMode(site)`. An authoritative legacy/shadow result produces the explicit `READ_MODE_LEGACY`/`READ_MODE_SHADOW` signal; summary without a publication remains `503 UNAVAILABLE`. A missing pin remains `410 GENERATION_EXPIRED` without consulting the mode or silently replacing the pin.

`api/_lib/production-reporting-rpc.ts:53` uses the existing `get_reporting_job_status` RPC. `0038_reporting_jobs.sql:351` reads the site's state independently of generations and joins the singleton control row; `:1995`/`:1998` revoke PUBLIC/anon/authenticated execution and grant service-role execution. **No migration was added or altered.** The adapter requires exactly one row, the requested site and a recognized mode. Missing/duplicate/wrong-site/unknown-mode results and RPC error responses fail closed. The shared RPC wrapper retains the response-size bound. Unexpected thrown errors also remain errors, never legacy authorization.

Authentication and authorization still precede reporting reads. HTTP handlers verify the bearer token with Supabase and read current profile/membership under the caller JWT. `audienceFor` or `authorizeOverview` then checks site/nav/role/person before `resolveGeneration`, so the service-only mode lookup does not expose a new browser RPC or bypass the caller's audience. The controller still selects legacy only for the two explicit mode codes, not arbitrary 503s. Staff/CS do not acquire the full-team legacy Reports tree through this change.

| Caller / consumer | Dormant result and boundary |
|---|---|
| Summary, Reports and Welcome (`production-reporting.ts:263`, `summary.ts`) | Authorized unpinned requests return 503 `READ_MODE_LEGACY`; `PublishedViewController` selects `legacy`, and `rawRangeFor` releases the existing evidence-read range. Only permitted page trees mount those reads. Unauthorized callers cannot obtain the signal. |
| Detail / published pagination and CSV (`production-reporting.ts:294`, `detail.ts`) | A generation is required. A well-formed missing pin returns 410 before mode lookup; invalid requests fail validation, and membership/nav are checked before generation/data reads. The dormant page uses its existing legacy CSV, not a manufactured published detail stream. |
| Overview (`reports-overview.ts:45`, `overview.ts`) | `authorizeOverview` precedes resolution, including kiosk denial, CS Reports permission and staff self-only scope. Unpinned dormancy returns `READ_MODE_LEGACY`; `useReportsOverview` deliberately renders `not_ready` with no figures or raw-data fallback. Owner/manager can still use the separate legacy Reports section. |
| Frame timing (`frame-timing.ts:62`, `timing.ts`) | Requires the overview's UUID generation pin and the same authorization. Missing pin input is 400; a nonexistent pin is 410, with no timing-row read. `ReportsOverview.tsx:216` mounts timing only when overview data exists, so no timing request is needed in the normal dormant UI. F9 remains unavailable. |
| Daily digest (`daily-digest.ts:683`, `:820`) | **Not a direct `resolveGeneration` caller.** Its existing, authenticated path reads `getReportingJobStatus` first and explicitly selects legacy/shadow evidence with one cutoff. Summary mode requires a complete, current published generation and refuses missing/incomplete/stale data before workbook/email. Missing/unreadable state fails the request, not into legacy. This patch does not change that path. |

`tests/reporting/pg/dormant-legacy.test.ts` contributes **12 tests**: fresh dormant state; AU/UK/US × Reports/Welcome through actual SQL/RPC adapter, API error body, controller and page range; operator and constraint refusal of publication-free summary/shadow; cross-site denial; missing pin; deleted site state. The harness currently applies all applicable reporting migrations from 0037 onward, not merely the 0037–0046 range named in the test comment. It is in-process PostgreSQL, not hosted PostgREST or a rendered browser. The alleged “foreign pin” case in the coder response is actually a nonexistent UUID; the important no-fallback/410 assertion is valid. Summary-without-publication and explicit shadow/error behavior are additionally covered in `tests/api/reporting-reads.test.ts`.

Fresh reviewer execution loaded the actual TypeScript modules in memory and used the real reporting schema/`pgRpc` service-role adapter. All three sites passed summary → browser-controller legacy → non-null raw range, overview legacy, detail/timing pinned 410, and **all four readers' denied membership before any RPC**. Additional adapter checks passed missing/duplicate/wrong-site/unknown-mode/RPC-error refusals, summary-without-publication 503, explicit shadow mode and deleted real site-state 503. This supplements the suite; it does not replace JWT/role/browser acceptance.

The rehearsal's section 2c records Preview `inka-arthouse-g1on6rg21` (`f7240d1`, staging-2, default region): owner/staff summary requests for Reports/Welcome on all three sites changed from `UNAVAILABLE` to `READ_MODE_LEGACY`, and AU overview also returned the mode signal. This is useful deployed API evidence, not proof that staff now see legacy Reports counts. **Owner/manager legacy counts and CSV, applicable Welcome views, role denial and dry digest remain G7 browser/operator checks.**

### R2-2 — safety corrections accepted, with explicit operator precedence

The two release documents now correctly record the new-app legacy-path defect and distinguish it from old-app SQL smoke; state all three dormant controls; require separately planner-approved capacity/region/storage work before reporting commissioning; describe disabled refresh as HTTP 500 `processor_disabled` with approximately 288 invocation/log attempts per day; assign CJ monitoring and monthly run-log size checks; and include the pre-digest-auth rollback exposure and safer-build alternative.

Some older wording remains stale: bulk-plan header/source commit and G6 state; G1's blanket “fixed”; the old G3 measurement paragraph and “longest write block” shorthand; and release step 1 calling `79a0031` “the rollback target.” These do not override this final review. **The rollback safeguard in step 0 and the explicit choice below take precedence over the old target shorthand.** G1's unresolved recovery cases remain activation blockers, recorded staging timing does not bound live lock waits, and G6 is now conditional round-3 approval. The documented Preview API result is not a completed G7 browser pass. CJ's release record must use these qualified meanings.

## CJ's complete release conditions

### Before live SQL, merges or bulk deployment

1. **Close G7 on Preview `inka-arthouse-g1on6rg21` against staging-2.** Confirm it serves `f7240d1`'s application code (unchanged at reviewed HEAD), with capture off, processors off, read mode legacy and no publication. Keep Preview isolated from production, with its own secrets and safe recipient. Record owner/manager/staff/kiosk/CS login, allowed navigation and role/account switching; anonymous and cross-site denials; no stale account/site data. Specifically verify owner/manager Reports legacy counts and CSV, applicable Welcome counts across AU/UK/US and production-day boundaries, and authenticated `dry=1` digest output without sending mail. Staff/CS Reports may show published “not ready”; they must not receive the owner/manager legacy whole-team tree, and kiosk Reports stays denied. Check F8/F9 unavailability explicitly rather than marking them delivered.
2. **Complete the rest of the browser smoke.** Inspect console errors; Dashboard for owner, Settings in Supabase for applicable roles and Dexie without an auth provider; kiosk clock in/out exactly once per scan; classic production verification/completion/dispatch and same-request retry deducting once; missing-stock warning; Order box focus/scanner behavior; Shopify/artwork lookup; shipments and CS case/return saves with their expected stock effects. Reconcile uncertain/pending browser requests before account/build/mode changes. G3/G5 database scripts and Preview API calls do not close these browser checks. Record pass/fail evidence; stop on a regression.
3. **CI must be green for the release candidate and final merged main.** Exact-HEAD PR #22 CI completed successfully during this review: 143 files / 3,413 tests, all type checks, build and append-only check. Reconfirm the candidate checks on release day, recheck child PR diffs/checks as the stack is retargeted, and await final-main CI before deployment. This successful stacked-PR run does not replace final-main CI. If code changes after this review, this verdict does not silently cover it.
4. **Choose and validate the rollback deployment before starting.** Reconfirm current live deployment/SHA and Vercel Git/auto-promotion settings. Prefer a separately smoke-tested deployment of `8519ac9` (digest-auth + order-display main, no new migrations) as a small prior release, then record its deployment ID as the bulk rollback target. That prior deployment requires its own correct Production configuration and digest-auth/smoke checks. Alternatively, retaining `79a0031` requires a verified block of unauthenticated external digest access on **every applicable deployment URL before rollback**. `CRON_SECRET` or paused crons cannot protect code that ignores the secret. Merely noting the old deployment ID is not a completed rollback choice. Validate the selected target against the upgraded staging schema and the applicable role/application flows; G5 is database-call evidence, not a complete browser/queued-request drill for every possible target.
5. **Establish recovery and preflight.** Record a real Supabase backup/recovery point, recovery owner, and current free disk/WAL headroom; browser JSON export is incomplete. Retain G3/G5 evidence and the 25-file manifest. Reconfirm schema/history drift, PostgreSQL 16+, migration-role capability, expected 0036 policy names, extension availability/placement, actual stock constraints, effective grants and absence of conflicting packaging ledger keys. Stop on unexplained drift or installed objects. Announce a quiet release window away from shift starts/digests; CJ performs all live SQL, merges, deployment and rollback. Keep old code serving until the upgrade/final build are ready, and prevent intermediate stack combinations reaching staff.

### Production configuration, before building/deploying

| Setting | Required condition |
|---|---|
| `VITE_BACKEND`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | `supabase`, intended live project, correct public anon key. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Same live project as the browser; no staging/live mix. The service key remains server-only. |
| `CRON_SECRET` | Nonblank random server secret before digest-auth reaches live; verify digest and refresh authorization. |
| `REPORTING_OPERATOR_SECRET` | Nonblank, distinct from `CRON_SECRET`, restricted to CJ. Its presence is not commissioning permission. |
| `REPORTING_CURSOR_SECRET` | Stable server-only signing secret configured for paging/CSV paths; no publication is required to configure it. |
| `REPORT_RECIPIENT`, `RESEND_API_KEY`, `FROM_EMAIL` | Explicit intended production recipient, valid provider key and sender. |
| `REPORT_RECIPIENT_ALLOWLIST` | Intended override list, or empty/unset to forbid overrides. Use authenticated `dry=1` for acceptance, not a send as a health check. |
| `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `DROPBOX_ACCESS_TOKEN`, `DROPBOX_IMAGE_FOLDER` | Intended existing lookup/artwork configuration; verify these independently of dormant ingestion. |
| `ORDER_TIMELINE_INGEST`, `ORDER_TIMELINE_ROUTING`, `SHOPIFY_WEBHOOK_SECRET`, `MAKE_MILESTONE_SCOPES` | Leave unset. No live webhook subscriptions, Make edits, F3 backfill or Slack/F12 setup. |

Deploy one final **Production-configured** build. Do not promote a staging-configured artifact on the assumption that its settings are automatically safe; verify the resulting deployment's project, secrets, function settings and crons. Preview remains staging-only.

### SQL, switches, merge and deployment

6. **Install only the 25 manifest files, one at a time:** 0034–0047, then 0052–0062, matching committed-LF SHA-256 values. Do not fill 0027/0048–0051, replay 0001–0033, use a consolidated baseline, or run staging reset/seed/assertion scripts on live. Set `lock_timeout = '10s'` and `statement_timeout = '600s'` for each file's session, as rehearsed. Preserve existing transaction boundaries and execute **0046 atomically** with an explicit wrapper or verified single transaction. No whole-stack outer transaction or autocommitted splitting. Record each file/hash and successful commit before advancing. On error, stop, determine committed/rolled-back state and diagnose with old code still live; no blind replay or timeout increases. Repairs remain append-only and reviewed. Do not use the rehearsal shell runner as an unattended production stop-on-error executor; round 2 documented its exit-status limitation.
7. **Verify effective ACLs/RLS and dormant control state after installation.** Preserve the singleton control row and AU/UK/US site rows. Global `capture_enabled=false`; every `processor_enabled=false`; every `read_mode='legacy'`; no generation or active publication work. No enable-capture, rebuild, processor activation, shadow/summary mode or dummy publication. Do not disable safety triggers. G4 stays failed/deferred until a separate planner-approved capacity, region, storage and acceptance project succeeds.
8. **Keep shop-floor switches off.** Packaging remains scan mode at every site, F5 tracking off, all receivers classic; no F6/F7 shared activation. Inspect and reconcile existing queues with original request IDs—scan mode alone does not stop a previously queued packaging drain. Never clear storage or blindly rescan unknown outcomes. F4 activation additionally needs the unresolved uncertainty/account/storage recovery work and Max's validated rules/examples; F5 needs the real roster; F6/F7 need real hardware/interleaving/queue acceptance. Timeline/Make remain dormant with no external automation changes.
9. **Merge the dependency stack with merge commits:** #7 → #10 → #13 → #11 → #14 → #15 → #16 → #17 → #18 → #19 → #20 → #21 → #22. Retarget/check each child after its parent; no squash/rebase of stacked children; exclude #12/#8. Reconfirm the recorded lack of Git integration, or hold automatic promotion if integration now exists. Wait for final-main CI and explicitly deploy only the final verified build. Merging alone must not expose half the stack.
10. **Verify function settings and all six cron entries.** Refresh and reporting-admin limits are 300 seconds. Digest schedules: AU `55 13 * * *`, UK `55 22 * * *`, US `55 4 * * *`; refresh schedules: AU `0,15,30,45 * * * *`, UK `1,16,31,46 * * * *`, US `2,17,32,47 * * * *`. Disabled refresh is expected to return HTTP 500 `processor_disabled`, after protocol/status reads and an attempted run-log write, with no batch/copy/materialization/publication. Other errors (401, missing configuration, database/protocol failures) are real failures. Do not enable processors to quiet expected 500s. Verify no source-candidate, owner-input or capture-journal growth.
11. **Observe the release.** Repeat production smoke read-only where possible; CJ supervises any real-order test and checks exactly one inventory movement. Watch logs and stock/scan complaints for at least 30 minutes and confirm the next actual scheduled digest for **each** site in logs/inbox. CJ owns disabled-cron monitoring, approximately 288 daily invocation/log attempts, monthly run-log size checks and deliberate retention maintenance; disabled runs do not run cleanup. Assign/record recovery, queue, token/secret and missing-data follow-up ownership. Record deployment/SHA, migration outcomes, switches, smoke results and release tag through CJ's normal process.

### Rollback and operator handoff

12. **Rollback preserves data and request identity.** Reconcile queued/uncertain original requests before replacing code. Switch implicated shop-floor behavior off and keep reporting legacy/off/off. If capture was accidentally enabled, processor-off alone does not stop journal growth: CJ uses the deliberate capture-disable procedure and records the epoch change. Use only the validated target from condition 4, with old digest exposure blocked if applicable. A rollback restores that deployment's code/configuration; it does not roll back Supabase or retrofit later dashboard env changes into the old artifact. Reverify target crons/auth after switching.
13. **Leave migrations and business records installed.** New duplicate protections can reject old callers. Prevent re-completion of previously auto-packaged orders under old code; inspect `pkg:`/`prod:` overlap and use an audited stock adjustment for a second-box deduction, never delete ledger history. Fix application code forward through a reviewed change while retaining migrations; reverting #22 alone does not undo this stack. Database restore is last resort and requires explicit reconciliation of intervening real writes.
14. **Communicate the retained limits.** F1 recalculates historical totals, including unframed/set items. Published F8/F9 reporting is unavailable while dormant, including staff/CS published Reports; preserve role restrictions. Corrected packaging is net in Reports but gross in the digest. Later F9 estimates use current weights for historical periods and refuse incomplete clock evidence. Timeline describes recorded evidence/orders, not a complete historical census; F3/F12/Team redesign are not delivered. None of these limitations permits invented attribution, silent fallback or relaxed access checks.

## HARDENING.md — every question

Checked means reviewed within the dormant boundary, not that outstanding browser/commissioning gates passed.

| Item | Result / retained condition |
|---|---|
| 1 — Network/provider slow/down, worker visibility and loss | RPC/status failure remains an error, not permission for legacy reads. Shopify/Dropbox errors must remain visible; printing does not depend on dormant ingestion. Packaging uncertain/storage recovery remains an F4 activation gate. |
| 1 — Retry/idempotency | R2 changes reads only. Existing SQL receipts/order locks and G5 support write replay; original request IDs must survive uncertainty. Digest sends are intentionally repeatable, so acceptance uses dry mode. |
| 1 — Concurrent people/devices | No new locking/write behavior. F5–F7 concurrency evidence carries forward; actual shared-scanner interleaving and capture-on composition remain unapproved activation work. |
| 1 — Bad input/barcode/SKU/cancellation/site | Existing strict validators and site authorization remain; all four reporting readers reject denied membership before RPC in the fresh offline check. G7 must exercise missing-stock and scanner failures. |
| 1 — Failure UX/recovery | Explicit legacy mode now restores the authorized legacy path; arbitrary 503 does not. Overview displays not-ready; timing/detail never invent a generation. Preserve queues; rejected packaging storage is not itself a worker-visible recovery flow. |
| 2 — Correct person/department | No attribution changes. Staff self-scope, owner/manager-only legacy Reports and snapshot/history boundaries remain. Role switching is G7; tracking/shared modes stay off. |
| 2 — Shared counts/orders/items/sets | Legacy selection again reaches the shared F1 evidence/counting path. New regression proves selection, not rendered numerical parity; CJ checks synthetic counts/CSV/digest. Historical totals change intentionally. |
| 2 — History after settings changes | Existing immutable snapshots/versioned reporting remain; no retroactive department fill. Current-weight historical timing qualification remains for later activation. |
| 2 — UTC and site time | Existing production-day/DST logic unchanged. G7 covers AU/UK/US boundaries; release schedules are fixed UTC and must be checked as listed. |
| 2 — Manual/inferred versus measured | Existing F7 manual attribution and F9 method labels/refusal remain. Dormancy does not manufacture metrics; timeline provenance remains explicit and F12 is excluded. |
| 3 — Endpoint authentication/input | Bearer JWT/profile/membership before reporting data; audience/person checks before mode lookup. Digest's distinct CRON_SECRET guard precedes all work. No new endpoint or public status-RPC grant. |
| 3 — RLS/roles | Existing service-only status RPC reused; no SQL changed. G3 effective-grant evidence carries forward; CJ still verifies final role/anon/cross-site behavior and production ACLs. |
| 3 — Server secrets/logs | No new secret or dependency added by R2. Mode lookup returns only a mode to trusted server logic; service/operator/cursor/provider keys remain server-only. No secret values inspected here. |
| 3 — Cost/spam/data exposure | Read bounds and auth remain. Disabled refresh still costs invocations/log rows; CJ owns retention. Old rollback target's public digest must be blocked or replaced by a safe target. |
| 4 — Expansion/previous app compatibility | Fresh diff: 25 migration additions only against origin/main; no edits/deletions. G3/G5 support old-call compatibility with stated stock/queue exceptions. No new migration for this fix. |
| 4 — Off switches | Reporting off/off/legacy, packaging scan, tracking off, classic receivers and dormant ingestion are mandatory. Processor-off does not disable capture; queues require explicit reconciliation. |
| 4 — Exact release sequence | Conditions above specify settings, backup, target, SQL order/timeouts/atomicity, abort, merge and final deploy. CJ alone executes live changes. |
| 4 — Staging per role | G7 remains open on the named Preview. Owner/staff API acceptance is not manager/kiosk/CS browser evidence. Selected rollback build needs applicable browser acceptance too. |
| 5 — Months of events/indexes/preaggregation | Existing indexed/bounded readers remain. New missing-generation lookup reads metadata and pending-change status; dormant capture creates no new pending journal. Legacy response time still needs final application observation. |
| 5 — External API per item | No new per-item provider calls. Existing lookup/artwork caching limits remain; F3 permanent thumbnails are excluded. |
| 5 — Two years/three sites | Not proved. G4 failed before full first publication and remains a commissioning blocker, not a prerequisite for this restricted dormant release. No unlimited legacy-capacity claim. |
| 6 — Detect production breakage | Distinguish explicit legacy/not-ready and expected processor_disabled from missing state/auth/database failures. Check logs, UI warnings, growth and each site's next scheduled digest. |
| 6 — Manual fallback | Classic stations/box scans and permitted legacy reports remain day-one paths; preserve uncertain requests and original IDs. No capture/summary workaround. |
| 6 — Maintenance | CJ owns disabled run logs/retention; assign disk/WAL/token/queue follow-up. Cleanup is deliberate and abandoned publication space is not necessarily immediately reclaimed. No live webhook maintenance starts here. |
| 7 — Logic/edge tests | Real-schema 12-test dormant regression and extended API cases pass in fix-commit Linux CI. Fresh offline checks independently cover caller behavior/auth ordering. Local full suite/build are sandbox-blocked; final CI/G7 remain gates. |
| 7 — Inventory/credit/money | R2 has no inventory mutation changes. Existing F4–F7 tests/G5 evidence carry forward with activation restrictions; G7 checks classic retries and stock effects. Inherited CS sign/closure and multi-request risks are not certified fixed. |

## Other AGENTS.md guardrails

- `Repository.ts`, `DexieRepo.ts` and `SupabaseRepo.ts` are unchanged against `origin/main`; no interface addition is missing a backend. Reporting remains documented Supabase-only work. Dexie Settings smoke remains required.
- Fresh migration audit: **25 additions only**, 0034–0047 and 0052–0062. All **25/25 SHA-256 hashes** match the manifest using committed Git blob bytes. No R2 migration, historical rewrite or reserved-number reuse.
- No new dependency/configuration or app-code change after `f7240d1`; existing stack dependency rationale and whitelist review carry forward. The review path is within the tracked docs whitelist.
- The no-commit instruction overrides the usual task-commit handoff. No git state-changing command was run; plan checkboxes and other files are not edited by this review.

## Verification results

Windows `.cmd` shims execute the requested npm/npx scripts without changing their arguments.

| Check | Fresh result |
|---|---|
| `npx tsc -b` | `npx.cmd tsc -b`: passed, exit 0. |
| `npm run typecheck:api` | Passed, exit 0. |
| `npm run typecheck:digest` | Passed, exit 0; this also covers the changed reporting server modules. |
| `npm run test -- --run` | Could not start assertions, exit 1: esbuild ancestor-directory access denied, then cannot load `vite.config.ts`. No full local test-pass claim. |
| `npm run build` | TypeScript completed; Vite config loading failed, exit 1, same sandbox denial for generated `vite.config.js`. No local bundle-pass claim. |
| `gh pr checks 22` | Attempted; blocked by sandbox outbound socket permissions. `gh pr view` failed similarly. Used read-only GitHub connector instead. |
| PR identity | Connector independently confirms PR #22 head `5ff0668d4723754443a48111baeab196c4f8bb1c`, base `feature/order-timeline-commissioning`, open/unmerged. |
| Exact-HEAD CI | [Run 45434396012](https://github.com/yaralabsPH/inkahub-kpi-app/actions/runs/45434396012), job 138588141806: initially running, then independently confirmed **success** before finalizing this review. Logs show **143 files / 3,413 tests passed**, dormant-legacy 12/12, reporting-reads 209/209, all three type checks, build (8.66 s) and append-only check passed. This checks the stacked PR base; the separate fresh migration audit above also compares against origin/main. Final merged-main CI remains CJ's gate. |
| Same-code fix CI | [Run 45433683267](https://github.com/yaralabsPH/inkahub-kpi-app/actions/runs/45433683267) for `f7240d18eb7ec41bfdfd325f35e93ede7f058ffa`: independently retrieved successful job/steps/logs. **143 files / 3,413 tests pass**, including dormant-legacy 12/12 and reporting-reads 209/209; all three type checks, build (6.67 s) and append-only check pass. Later commits change docs only. |
| Known Windows hash failures | Coder reports six CRLF-dependent failures; this invocation stopped before assertions, so it did not reproduce them. Linux committed-LF CI is the authority. Do not rewrite migrations or weaken immutability. |
| Independent offline check | Passed, exit 0: actual reporting modules + real in-memory schema/service-role RPC + browser controller; all-site caller/authorization and fail-closed cases described above. No hosted database or files created. |
| Manifest / diff | 25/25 committed-byte hashes match; migrations additions-only; repository interface/adapters unchanged; no app-code difference from tested fix to reviewed HEAD. |
| Hosted acceptance | Reviewed coder-recorded section 2c API results. G7 rendered browser/count/CSV/dry-digest acceptance and chosen rollback target validation remain CJ's responsibility. |

## Should-fix

1. Carry forward the F4 activation blockers: configuration/malformed-success uncertainty handling, visible rejected recovery, null-owner/new-entry handling, mid-drain account changes and failed-storage/reload behavior. Keep original IDs until a settled outcome. Scan-only dormant approval does not close these.
2. Normalize future rehearsal tooling to preserve process/pipeline exit codes, distinguish assertions from diagnostic rows and end evidence with the required terminal status. Keep reset/seed/drill tooling staging-only.
3. Reconcile historical gate/source/measurement wording in the next operator record using this review's precedence. The optional successful idle-cron response remains deferred; operate the current 500/log behavior accurately.
4. Track portable migration hashing and the inherited CS stock-sign/closure, multi-request mutation, row-cap and incomplete browser-backup risks separately. No new waiver or claim that these are fixed.

## Nitpicks

None that affect dormant release readiness.

## Coder response

No further coder fix is requested for the dormant boundary. CJ records G7, candidate/final-main CI, selected rollback deployment/protection and release-day outcomes before proceeding. This final review's status certifies completion of the review, not completion of those human gates or permission to commission reporting.

STATUS: COMPLETE
