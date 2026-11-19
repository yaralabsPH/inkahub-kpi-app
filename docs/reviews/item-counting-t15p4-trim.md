# Item counting: minimum path to the first staging run

Date: 2026-11-19. Scope decision for CJ and the coder; offline implementation only.

## Decision and precedence

CJ has approved finishing quickly, fixing only Must-fix 1 and 3 of `item-counting-t15p4-wiring-step4-simplified.md`, and waiving Must-fix 2, 4 and 5. The plan records those fixes and the waiver. **Wiring step 4 is complete under that waiver. Do not reopen it.**

This decision replaces the remaining T15P-4d wiring steps 5–7, part 4e / wiring step 8, and conflicting pre-staging evidence/review requirements in `docs/plans/item-counting.md` and earlier reviews. Completed work and existing regression assertions remain. A deferred test is not a completed test; a passing first staging run is not production-release approval.

The shortest safe route is: finish durable staging and publication housekeeping, prove one representative continuation plus count preservation, prepare the existing staging runner for 0046, run the final local gate, then have **one consolidated planner review**. CJ then installs the reviewed draft and runs staging. No review between coder tasks, mutation campaign, new persistence design, dependency, or timeout increase.

Non-negotiable: no lost or duplicate credit, no incomplete publication, recoverable interrupted writes, exact audience/site binding, RLS and secret isolation, and reversible enablement. Keep the existing 240,000 ms worker budget, 2,000 ms reserve, 360-second lease, 30-second heartbeat, activation limits, 120-call reload ceiling, 50,000 distinct-input cap, audience cap, and row/byte limits. Do not change counting, canonical hashes, source events, stock or ledger behavior to satisfy a test.

Agents remain offline: no hosted connections, production access (including reads), push, merge, deploy, or hosted SQL. `0046_reporting_owner_inputs.sql` remains a draft until **CJ** applies the exact reviewed bytes to staging. Existing migrations stay immutable. The planner writes only this file and makes no commit. The coder retains existing local-commit authority on `feature/item-counting`.

## Remaining steps: keep, defer, drop

### Wiring step 5 — KEEP, reduced to one worker-driven atomic-page proof

Reason: a crash between consuming input and saving its cursor can silently omit or duplicate credit.

- In `tests/reporting/reportingOwnerContinuation.test.ts` or the already-authorized `tests/reporting/pg/walk-resume.test.ts`, drive the actual worker over the existing complete multi-line 0045 fixture. Force durable activation using the established test seam; retain production page/row limits. Assert the whole consumed page advances one atomic checkpoint and included complete children cause no redundant child read.
- Two interruption positions only: stop before that checkpoint commits, and lose the reply after it commits. Start a fresh worker after simulated lease expiry. Before-write recovery rereads the uncommitted page; after-write recovery uses the persisted cursor and does not reread it. Both finish with identical descriptors, hashes and result rows to the uninterrupted fixture; no generation appears while work is incomplete.
- Implementation: wire/fix only the worker-to-existing-journal boundary if this exposes a defect. Existing helper proofs need no rewrite. If these assertions already pass through the worker, record that result instead of manufacturing a failing test.

**DEFER:** crash injection at every cursor/phase, the full cut/stop-lookahead allowance matrix, another line-without-included-children fixture, and the extra Unicode certain-bound campaign. Existing tests and conservative fallback stay; these additional proofs do not gate the first staging run.

### Wiring step 6 — KEEP, durable staging and missing-chunk reuse

Reason: `stage()` still uses `materializeOwnerGroup` and uploads all chunks. Planning continuation alone cannot prevent repeated staging reads or ensure practical crash/resume progress.

Minimal tests in `tests/api/reporting-worker.test.ts`, using the existing SQL continuation tests for protocol semantics:

1. **Complete-journal reuse:** claimed durable work recovers the complete plan journal once through the read gate, uses the returned input without another event reload/source walk, and makes no journal write or purpose upgrade. Compute only the claimed audience at a time; verify its input hash against the claimed descriptor. A mismatch fails with zero publication. Completed one-chunk work is absent from the next claim.
2. **Interrupted upload and sparse reuse:** use three legal chunks, with chunks 0 and 2 already stored with matching hashes. Discovery terminates, only chunk 1 is uploaded, and publication occurs once all work is complete. In the same fixture's recovery variant, lose the reply after a non-final upload commits and stop; takeover discovers that chunk and does not upload it again. A stored hash mismatch fails visibly without overwriting it or publishing.
3. **Stage activation/recovery:** an incomplete plan journal adopted by a sealed stage request upgrades to `stage` only on its first write, resumes the saved cursor, and completes. A stage journal cannot be adopted by planning. A claimed owner without a journal retains the light path and activates the existing durable path if necessary. Preserve the full saved old-self audience set, not merely whichever self works happen to be in this claim page.
4. **Stage budget stop:** one fitting audience unit runs; the same unit with insufficient remaining time parks before discovery/upload, retains work, and completes on a fresh invocation. Check before each discovery/upload RPC, including after renewal. An incomplete chunk set never permits publication.

Implementation: pass the existing routing into `stage()`, reuse `recoverOwnerJournal(..., "stage")`, `durableOwnerInput`, `audienceWork`, `readStagedChunks`, `buildChunks` and existing stage RPCs. A small shared owner-read helper inside the authorized worker file is allowed; no new subsystem. Reuse complete journals directly; do not rerun the light attempt before recovering a known durable input. Keep only one durable owner and one audience's output in memory at a time. Check saved chunk number/hash against locally generated chunks, then upload missing chunks in bounded requests.

Use step 4's **counted-call admission and observed wall allowance**, not the superseded CPU model or `admitDurableUnit`. Admit discovery plus at least the first missing upload as a unit, including unpaid prerequisites and heartbeat/reserve. Before discovery, the known generated chunk count gives a conservative bound; actual discovery of `s` stored chunks takes `floor(s / 1000) + 1` calls. Guard subsequent uploads individually. Claims, work IDs and chunk hashes remain the idempotency identities.

**DEFER:** the separate 0/1/999/1000/1001 discovery matrix and exhaustive sparse combinations. The empty case occurs on the ordinary path; the three-chunk case proves selective replay. Keep the real pagination loop and its limits.

### Wiring step 7 — KEEP, one bounded release and safe failure reporting

Reason: housekeeping must neither turn a committed publication into a failed job nor delete unfinished evidence.

- Test successful publication followed by `releaseOwnerInputs` success, `more=true`, or failure. The generation/result remains published in all three; failure produces an allowlisted housekeeping warning/count, never database text, owner keys, event payloads or credentials. Release never runs before publication on that path.
- Make **at most one bounded release pass per invocation**, only if a call fits the remaining budget. `more=true` means work remains for a later publication or explicit cleanup; do not loop until drained. Add the same bounded pass to explicit cleanup so quiet sites can be serviced. Retain existing SQL refusal of unpublished/active journals and existing retained-generation tests. A cleanup failure is visible, with evidence left intact.
- Reuse the existing failure-kind tests; add only missing worker assertions for `owner_input_too_heavy`, `owner_input_capacity` and `owner_input_purpose`: retained journal, no publish, safe run arguments/problems. Use one parameterized fixture, not order/event duplicates. Keep the repaired no-progress/run-log sentinel regression unchanged.

**DEFER:** full retention-age/cleanup-concurrency matrices and automated abandoned-journal lifecycle work. First staging retains failed/abandoned evidence deliberately; CJ must not delete it to obtain a clean run. Storage monitoring remains required before ongoing operation.

### Part 4e / wiring step 8 — KEEP a small acceptance check; DEFER the campaigns

Reason: prove the reported never-finishing owner now finishes and that the audience seam preserves business results.

- **KEEP one representative PG-LONG case:** the existing 300-cancellation owner with one-row child pages, fresh worker instances, 1,000 ms simulated latency on every RPC, unchanged 240-second budget. Run uninterrupted and with one stop during durable planning plus one lost non-final stage-upload reply. Reuse step 6's upload fixture if PG-LONG produces only one chunk per work; do not inflate its rows just to get more chunks. Publication must finish within the existing overall **20-invocation ceiling**; unfinished work must retain a resumable position, and subsequent uninterrupted work must advance rather than restart from the beginning. Record total calls, invocation count and final parity. No exact per-call trace target.
- **KEEP one small independent correctness fixture:** two current workers plus a non-member old-self audience, a set quantity (2 × S2 = 4 Items), a completion (1 Order), cancellation context, and an empty replacement for the old self. Extend an existing small fixture to include a timing contribution and a source issue. Hand-author expected audience membership and rows for `event_facts`, `cancel_edges`, `order_occurrences`, `timing_facts`, `source_issue_facts`; derive expected input hashes from explicitly listed canonical inputs, not `audienceWork`/`ownerWorksFromInput`. Assert resumed publication matches these and the old-self replacement clears old credit. Existing shared counting/projector functions remain the implementation, not the oracle.
- **KEEP existing** cap refusal, role, journal validation, replay/fence, cut-page, timing, old/new credit, and migration-pinning regressions. No wholesale rewriting of their assertions.

| Additional evidence | Disposition and reason |
| --- | --- |
| PG-LONG exact 3-uninterrupted / 5-combined-crash targets and the old 649-call comparison | **DEFER** until after staging; the older accounting model is not a correctness target. The 20-invocation liveness ceiling remains. |
| PG-CUT new full-worker trace and exact 1/2-invocation target | **DEFER**; existing cut/fallback regressions remain, one long-owner stress case is enough now. |
| Production-framed 119/121 reload traversal construction | **DEFER**; keep the enforced 120 limit and existing refusal tests, without constructing another near-limit workload. |
| 50,000/50,001 full durable restart matrix, including restart at 49,999 | **DEFER**; keep current cap enforcement and existing boundary tests. |
| 999 self + site success, 1,000 self + site refusal at full worker scale | **DEFER**; keep audience-cap checks and small old-self correctness coverage. |
| Exhaustive independent canonical-hash/five-family/window matrices | **DEFER**; retain the small independent fixture above and existing parity suites. |
| Further small-page, near-1-MiB, Unicode, three-simultaneous-activation and every-phase crash stress fixtures | **DEFER**; keep existing tests, add no second stress campaign. |
| Sampled peak-memory/CPU profiling, transport-byte breakdowns and speedup comparison | **DEFER** until observing the staging run; record available runtime counts/durations now, make no capacity/speedup claim. Bounded storage/requests remain mandatory. |
| Mutation campaigns and mutation-kill quotas | **DROP** as acceptance gates; direct failing regressions plus the common gate are sufficient. |
| Impossible production-input arithmetic/capacity probes, retry-accounting campaign and extra step-4 seam/visibility evidence covered by CJ's waiver | **DROP** from the remaining scope; do not reintroduce waived Must-fix 2, 4 or 5 under a new name. Keep already-written tests. |

### Other work before staging

- **KEEP T15P-2's fresh AU eligibility and preservation of UK/US evidence.** The dated inspection selected AU; it did not prove AU is still clean. Never erase retained data or silently switch sites to pass R0.
- **KEEP the necessary T15P-3 runner maintenance:** verify installed 0046, encode only the already-accepted staging-specific missing-receipt exception for 0044/0045, and fail readiness on incomplete inspection or drift. The current inspector ends at 0045 and otherwise rejects the historical missing receipts; merely giving CJ its old command is not a usable handoff.
- **KEEP a narrow extension of the existing runtime R0/R6 checks** for 0046 identity, RLS/ACLs and six client identities (anon plus owner/manager/staff/kiosk/cs), and 0046 journal ownership in the final audit. Reuse the existing fresh connections, role/session helpers, baseline and cleanup. `reportingWorkerRuntime.ts` already attributes the three owner-input tables by site; retain those checks and ensure run-site journals also belong to recorded batches. No generic harness redesign.
- **DEFER other inspection presentation improvements**, new preserved-baseline modes, larger fixture generators and extra release-tooling work. If AU is no longer eligible, report the exact preflight failure; do not create a reset mode opportunistically.
- **DEFER outstanding Tasks 16–20 hosted acceptance, browser/dry-digest checks and two-/five-year, three-site, 20-reader, 10× peak performance campaigns until after the first worker staging run.** Already implemented app/read paths and their regressions stay. They are not prerequisites for this isolated worker rehearsal. Outstanding security/rollback or real count failures still block enabling the affected app path; this trim does not certify production scale or close those tasks.
- **DROP per-step planner reviews and repeated unchanged full-gate/mutation runs.** One final reviewed implementation is the handoff. Hosted CI is CJ's later push/PR step, not a reason for an agent to push or delay an isolated staging rehearsal after the local gate.

## Exact ordered coder task list

Use these three tasks in order, one writer. Within each, add the named failing behavior test before its implementation; already-passing retained proofs need no artificial red state. Run focused tests while working. Run the common gate once on the final combined tree; its results cover all three tasks. Preserve real failures and fix their cause, without raising timeouts or weakening expected counts. Append checkboxes/log entries referencing this decision in the active plan; do not rewrite the historical waiver.

1. **Finish staging and publication safety (steps 6 and 7).**
   - Files: `api/_lib/production-reporting-worker.ts`; only if needed, the already-authorized `production-reporting-materialize.ts`, `production-reporting-reader.ts` and `reporting-worker-state.ts` in `api/_lib/`; `tests/api/reporting-worker.test.ts` and existing owner-state/continuation tests.
   - DoD: the four step-6 cases and bounded-release/diagnostic cases above pass; known complete journals avoid a source reread; partial uploads resume; no incomplete publication or changed count/hash expectation. One local task commit and plan log entry. No review pause.
2. **Close the minimal continuation/count proof (step 5 and trimmed 4e).**
   - Files: `tests/reporting/reportingOwnerContinuation.test.ts`, `tests/reporting/reportingPageGuard.test.ts`, `tests/reporting/pg/walk-resume.test.ts`, `tests/reporting/reportingOwnerInputState.test.ts` as needed; production repairs only in task 1's scope. Prefer extending these tests to adding a new framework.
   - DoD: two atomic-page interruption positions, representative PG-LONG finite completion, selective stage recovery and small independent audience/five-family/count fixture pass. Record exact invocation counts and distinguish simulated latency/PGlite from hosted evidence. Existing substantive assertions remain. One local task commit and log entry. No review pause.
3. **Prepare CJ's staging handoff and run the final gate.**
   - Additional narrowly authorized files: `tests/staging/reportingInstalledState.ts`, `tests/staging/reportingWorkerScenario.ts`, `tests/staging/reportingWorkerRuntime.ts`, `tests/staging/reporting-jobs.ts`; their existing `tests/reporting/reportingInstalledState.test.ts`, `reportingWorkerScenario.test.ts`, `reportingWorkerRuntime.test.ts`. `reporting-jobs.ts` changes are limited to passing existing role claims/check results through the runner. No shared PGlite/service-RPC harness change or new CLI mode is needed.
   - Red tests: (a) absent/altered 0046 or an authenticated grant fails inspection/R0 before any mutation; (b) only absent 0044/0045 receipts on the fixed staging project may be accepted when **all** effective function/security checks pass, while a bad receipt/body or drift still fails and makes runtime readiness false; (c) R6 cannot complete with any missing/allowed client-role case, and the fresh audit fails on a journal tied to an unowned batch. Reuse the current valid-fixture/cleanup tests for the positive path.
   - Implementation: extend the existing identity/catalog queries and pinned local 0046 hash, record raw versus accepted receipt findings separately, and require the same effective identity checks in runtime R0. Include 0046 tables/indexes/functions/security in inspection, not just a version number. In R6, verify service access; use anon and the five existing staging identities for denial checks against the protocol version RPC and direct reads of each new private table. Catalog checks cover grants on every new function/table. Roll back every denial probe. Preserve R0b, stop-on-first-failure, ownership-before-write, all-sites baseline and fresh audit. Do not delete evidence or auto-apply SQL.
   - DoD: focused checks pass; final `npx tsc -b`, `npm run typecheck:digest`, `npm run test -- --run`, `npm run build` pass, plus the existing strict staging-runner check (`npx tsc --noEmit --strict --skipLibCheck --target ES2020 --module ESNext --moduleResolution bundler --types node tests/staging/reporting-jobs.ts tests/staging/reporting-capture.ts`). Use installed dependencies/offline settings; `.cmd` shims are acceptable on Windows. Record commands/results, exact code revision, unchanged 0037–0045 hashes, final draft 0046 SHA-256, covered/deferred cases and the commands below. One local task commit/log entry; handoff ends with exactly `STATUS: COMPLETE`, or `STATUS: FAILED – <specific reason>`.

No migration edit is anticipated. If a real schema defect is found, report it as an open question; do not alter an existing migration or invent a different protocol. Narrow trace/fake updates in the named tests are authorized for demonstrated new calls; count/parity expectations cannot be relaxed. A genuinely new file/design dependency is recorded with its concrete reason, not silently added.

**Ready for staging** means these three tasks, the final local gate and the single final review are complete with no unresolved correctness/security/data-loss/rollback blocker. It means the reviewed worker can be rehearsed by CJ; it does not mean the feature is released or the UI is fully accepted.

## CJ's first staging test

### Preparation, in order

1. Use only staging project **`ybrzhrgfrnvtcwymjdrq`**. Production **`lkboboagiikvozvbcpvg`** is excluded, including reads. Take an exclusive staging window: no other worker, seed writer or scheduler. Retain earlier failed reports and the UK/US abandoned batches/candidates.
2. Use the final reviewed code revision and record the draft 0046 hash from the handoff. Existing schema through **0037–0045** is a prerequisite, not a command to replay the migration directory. In particular, 0044/0045 were previously found installed with missing receipts: verify their effective definitions/ACLs; do not reinstall them or fabricate receipts. If another prerequisite differs or is absent, stop for CJ's explicit reconciliation.
3. **CJ applies only `supabase/migrations/0046_reporting_owner_inputs.sql`**, once, to staging, after checking the review hash and additive/service-only contract. Record the actual installation receipt and hash. If already applied, verify identity instead of reapplying. No agent executes this step; no down migration is prepared.
4. Configure the existing ignored `.env.staging.local` with `STAGING_DB_URL`, `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY` for that project, and `STAGING_<ROLE>_EMAIL` / `STAGING_<ROLE>_PASSWORD` for OWNER, MANAGER, STAFF, KIOSK and CS. Retain the existing staging marker location and synthetic test users (`@inka-staging.test`, including `staff@inka-staging.test`). Credentials never enter the plan, report or git. Start with capture off, all processors off and read modes `legacy`, no active batch anywhere; **AU must pass the existing clean-site preflight**. Do not change UK/US retained rows to achieve this.
5. Run the updated read-only inspection, then inspect its report before the runtime command:

   ```powershell
   npm.cmd run staging:reporting-jobs -- --inspect-installed --sites=au,uk,us
   ```

   Require exit 0, final `STATUS: COMPLETE`, complete/no-drift collection, exact effective 0040–0046 identities/security, actual 0046 receipt, and **AU eligible**. UK/US may remain ineligible because their evidence is preserved. The accepted 0044/0045 receipt discrepancies must be explicitly labelled, not suppressed. Any other failure stops here.

### Worker invocation and checks

Run once, from the reviewed checkout:

```powershell
npm.cmd run staging:reporting-jobs -- --worker-runtime --site=au --pace-calls=4 --max-invocations=12 --max-lease-wait-ms=420000
```

This is the existing **direct-PostgreSQL service-role worker rehearsal**, with real committed per-RPC transactions; it requires no Vercel deployment and sends no email. It is not a PostgREST/serverless performance test. Its 12-invocation run-wide limit is unchanged and separate from the offline PG-LONG 20-invocation ceiling. Do not increase either limit to turn a failure into success.

| Check | Pass / fail |
| --- | --- |
| R0/R0b identity, isolation and baseline | Reviewed schema, AU eligible, no baseline drift; durable run ownership exists before writes. Wrong project, foreign active work or drift is FAIL before scenario mutations. |
| R1/R2 processor guard | Disabled refresh/rebuild create no batch; the runner enables only its declared capture/processor changes. Unexpected source/stock/ledger changes are FAIL. |
| R3 continuation/concurrency/replay | Paced copy is pending with saved progress; duplicate invocation is busy; a separate fresh connection waits for actual lease expiry and takes over with a higher fence. Lost publication reply replays the same generation; old fence is refused. Repeated unchanged pending until the limit, a second generation for replay, or any incomplete publication is FAIL. |
| R4/R5 exact counts | Source and mirror identity/images match; site and self daily totals equal the independent source reducer. The existing three inserts, update and delete are captured, acknowledged and reflected once. Any missing/extra row or wrong count is FAIL, even if the job says published. The small offline fixture supplies the independent five-family/old-self proof; this run is not falsely labelled that full matrix. |
| R6 roles and diagnostics | Service role can use 0046; anon and each owner/manager/staff/kiosk/cs session are denied the service-only protocol/private tables. All new function grants/RLS match the draft; exact run-log outcomes/counts contain no payloads/secrets. Permission success for a denied role, missing role evidence or leaked data is FAIL. |
| R7 and cleanup/audit | Capture disable invalidates continuity; re-enable needs rebuild; recovery publishes correctly. Cleanup restores capture off / processors off / legacy, removes only the run-owned source fixture rows, and leaves evidence retained. Source/stock/ledger/memberships and unowned UK/US data remain unchanged except explicitly recorded allowed metadata. Any unexplained difference or failed cleanup/audit is FAIL. |

Overall pass requires **every existing required R0–R7 observation**, cleanup and fresh independent-connection audit to pass, exit 0 and exactly `STATUS: COMPLETE` at the report's end. Save the report path/hash and revision. Missing output/status is failure. A failing scenario stops later scenarios but still runs safe cleanup/audit; report the exact cause, without an unchanged automatic rerun or deleting state. If no owner activates on the ordinary AU dataset, say so: durable long-owner progress was proved offline, not by this hosted run.

The harness deliberately restores `legacy`/processor-off and retains derived evidence. It **does not leave an app-ready generation** after capture restoration. Do not switch this rehearsal's generation straight to summary mode.

### Preview/app follow-on and rollback

After the first worker run passes, CJ may prepare the separate app test: deploy the reviewed revision to **Preview only**, configure `VITE_BACKEND=supabase` and staging URL/anon key, server `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and distinct staging-only `CRON_SECRET` / `REPORTING_OPERATOR_SECRET`. Verify the configured function duration supports the existing 300-second maximum; do not lengthen it. Set digest recipients/allowlist to CJ's test inbox and use `dry=1` only. No Shopify/Dropbox/Slack/Make change is required for this worker test; do not install production tokens. Scheduled jobs stay disabled during controlled testing.

Use the protected operator endpoint's `status`, `enable-capture`, `set-mode` (AU processor on, reads `shadow`) and `rebuild` actions to establish a **new current-epoch** generation; resume pending work only after lease expiry, then compare counts before enabling AU `summary`. This requires its own explicit controlled staging state, not bypassing the now-ineligible clean-site harness. Per-role app checks (permitted owner/manager site views, staff self-only, kiosk/CS current permissions, anonymous denial), set/UN/cancellation counts, dry digest, retained reads and previous-app compatibility belong to this follow-on. Existing security/rollback failures cannot be deferred past enabling the affected view. No new offline campaign or planner review is required merely to start the first worker rehearsal.

Rollback for either staging phase: stop invocation/scheduling, set each affected site's `processorEnabled=false` and `readMode="legacy"` through CJ's protected operator controls, and verify those settings from a fresh connection. The first harness also restores its original capture state. Outside that harness, disable capture only when necessary: it changes the epoch **globally** and requires a rebuild at every site before summary reuse. Do not edit a lease to speed recovery. If a process dies, use its saved ownership report with the existing CJ-run `--recover-worker-run --site=au --report=<exact interrupted runtime report filename>`; never guess ownership or use a successful report as a reset command. If ownership is uncertain, retain the rows and stop.

Leave 0046 and all pre-existing schema in place; no DROP, restore-over-live-data, receipt repair or deletion of failed/foreign journals. If Preview code must roll back, use the previous compatible deployment **with digest-auth/S1 intact** and verify legacy reads and source capture still work. An app rollback is not a database rollback. Production SQL, deployment, merge and final release remain CJ's later actions under `docs/RELEASING.md`.

## Single final review scope

**ONE planner review after all remaining coder work above is done, not one per step.** Review the final worker staging/release paths, the small retained proofs, 0046's existing additive/service-only contract, the narrow harness delta and final coder gate evidence. Check exact published counts/audience hashes, lost-response/partial-upload recovery, no premature publication, safe cleanup, secret/role/project boundaries and legacy rollback. Confirm the waiver and deferral ledger are recorded accurately.

**Must-fix only for demonstrated real correctness, security, data-loss or rollback problems. Everything else is Should-fix or Nitpick and does not block.** Missing evidence blocks only when it leaves one of the concrete retained safety obligations above unproved. Do not demand impossible inputs, an exhaustive matrix, a mutation kill, exact old call traces or waived step-4 evidence. Use the coder's final test/build evidence; do not repeat the full suite/build simply for review. Any real blocker gets one concrete repair request against this scope, not another design/evidence campaign. Until repaired, the affected staging action stays blocked; CJ owns any further scope decision.

## HARDENING.md answers for the trimmed plan

| Checklist | Answer / retained evidence |
| --- | --- |
| 1: network/Supabase outage or slowness | Existing bounded retry, deadline/renewal guards, visible pending/failed kinds and retained journals; stage stop/resume tests. No partial generation. Shopify/Dropbox/Slack/Make are n/a to this server-only continuation change. |
| 1: retries and simultaneous work | Natural batch/work/chunk/sequence identities, matching-hash reuse, fenced writes and busy live leases. Offline lost-page/upload proof; hosted independent-connection takeover and publication replay. |
| 1: bad input, cancelled/foreign orders | Existing validation, site/owner/frozen-snapshot binding, cancellation rules and caps stay. Malformed data cannot be silently skipped into a complete generation. Scanner parsing is unchanged/n/a. |
| 1: failure visibility/recovery | Safe failure kinds/run counts, retained prior published data and explicit pending/stale state; resume or CJ's ownership-based recovery. Never convert an error into zero counts. |
| 2: attribution and shared counting | Same shared classifier/projector, saved staff/work-type facts and site/self filtering. Small independent set/order/cancellation/old-self proof plus existing count/credit regressions and R4/R5 equality. |
| 2: history and later settings changes | Frozen input and retained versions remain authoritative; empty old-self replacement removes obsolete credit. No rewrite of saved source history or current-profile substitution. |
| 2: times and inferred/manual values | UTC exact instants, site zones and 04:00 production-day rules unchanged. No new inferred/manual quantity; existing source-issue/coverage distinctions remain. New timezone matrices are unnecessary for this delta. |
| 3: auth/input validation | Existing auth-first cron/operator/API validators remain. No new endpoint. Protocol checks precede work; only service calls can mutate reporting state. |
| 3: RLS/roles | Three 0046 private tables retain RLS/no client grants; functions remain invoker/empty search path/service-only. Local existing SQL tests plus installed catalog and six client-identity checks in staging. |
| 3: secrets and abuse | Server-only credentials; ignored staging env; allowlisted diagnostics; fixed staging guards and bounded jobs. No email or third-party calls in the worker rehearsal. |
| 4: schema/previous app | 0046 adds private objects; 0037–0045 immutable. No source schema contraction. Legacy/previous compatible app stays usable; verify app compatibility before summary enablement/release. |
| 4: switch-off and release sequence | Processor off plus legacy reads without deploying; global capture-epoch implications explicit. CJ verifies prerequisites, applies only reviewed 0046 to staging, inspects, rehearses, then separately sets up Preview/current-epoch data. |
| 4: staging per role/rollback | R6 covers anon and all five roles; read permissions/UI follow-on before affected summary enablement. Fresh audit, evidence retention, owned recovery and no down migration protect rollback. |
| 5: history scans/indexing | Existing indexed frozen keysets, bounded pages, per-owner journal and preaggregated reads retained; completed journal reused, no all-history staging restart. |
| 5: external API per item | N/a: this worker reads reporting data; no new external per-item call or dependency. |
| 5: two years/three sites | Not certified by this trim. One liveness case and AU runtime first; existing limits refuse oversize visibly. Broader scale/latency acceptance is deferred until after staging, not claimed passed or waived for production. |
| 6: detection/manual fallback | Job outcomes, last cutoff/backlog/staleness and safe housekeeping warning remain; CJ can stop processors/use legacy shop-floor reads. No new alerting subsystem required. |
| 6: ongoing maintenance | Monitor pending/no-progress/heavy failures and owner-journal growth; bounded explicit cleanup handles published journals. Failed/abandoned journals retained. Full retention profiling and runtime/cost monitoring remain follow-on work before sustained operation. No new subscriptions/tokens. |
| 7: logic and money/credit tests | Retain shared counting, inventory/ledger and old/new credit tests; add only the concrete stage/crash/audience regressions listed above. Final frontend/API/staging types, suite and build gate. No stock/ledger implementation change. |
| Repository/Dexie, dependencies, root whitelist | N/a: no Repository interface/backend contract or root path addition; worker remains server-side Supabase-specific. No dependency is added. |

## Evidence for this decision

Read AGENTS.md, ARCHITECTURE.md, ROADMAP.md (F1 and cross-cutting decisions), HARDENING.md, release guidance, the active plan/waiver and prior scope/review files. Inspected the actual worker's planning/staging/publication paths, journal helpers and draft 0046, existing continuation/SQL tests, installed-state/runtime runner and ownership/audit code. This is a scope decision from source inspection. The recorded 80-file / 2,438-test gate is coder-reported prior evidence, not a new run by this planner. No test suite, build, SQL, hosted connection or state-changing git command was run for this decision.

STATUS: COMPLETE
