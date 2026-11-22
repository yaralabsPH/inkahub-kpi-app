# Review: Item counting — single final review

- Slug: `item-counting` · Branch: `feature/item-counting`
- Reviewed range: `fa6cdae..3464d9fc9cf9a135f8ec9deb5da04c716544ff98`
- Commits: `b2e372a` (trim task 1), `7430a9e` (trim task 2), `3464d9f` (trim task 3).
- Reviewer: planner (Codex) · Date: 2026-11-19
- Verdict: **approved — ready for CJ's first worker staging test**.

This is the one consolidated review required by [the trim decision, Single final review scope](item-counting-t15p4-trim.md#single-final-review-scope). No demonstrated correctness, security, data-loss or rollback blocker was found in this range. Approval covers the isolated worker rehearsal, not production release, summary-mode enablement, or completion of Tasks 16–20. The non-blocking evidence and reporting limitations below are not additional staging gates.

## Checked against

- [x] Applicable worker/counting acceptance criteria in `docs/specs/item-counting.md`, subject to the trim's explicit staging scope.
- [x] The three trimmed tasks and their Implementation-log entries at the end of `docs/plans/item-counting.md`; scope differences are recorded below rather than treated as completed proofs.
- [x] `AGENTS.md`: planner boundary, append-only migrations, RLS, secrets, repository/backend scope, dependencies and root whitelist.
- [x] Every section of `docs/HARDENING.md`; findings and applicability below.
- [x] `docs/ARCHITECTURE.md` and `docs/ROADMAP.md`, including F1 and cross-cutting saved-credit/rollback decisions.
- [x] Changed tests and retained regression coverage inspected; coder's final combined-tree type-check, suite and build evidence accepted as instructed.

## Must-fix

None. No repair is required before CJ's first staging rehearsal under the trim's preparation and stop conditions.

## Should-fix

1. **Describe the small count proof precisely, and complete its narrow independent oracle in follow-on work.** `tests/reporting/reportingPageGuard.test.ts:685` / `:825` and the task-2 Implementation log do not supply the whole retained five-family/hash fixture. `parityProblems` compares mirror images plus daily Items/line counts; `reducerDaily`/`sqlDaily` do not compare Orders, timing, source-issue rows or input hashes. Moving `set-b` from W2 to W3 leaves W2's `set-c` member in SET-1, so W2 is not a non-member old-self audience and this does not prove an empty old-self replacement. The log's statement that the completion is checked through those daily totals overstates the assertion. Extend this one fixture with explicit canonical inputs, expected audience hashes and expected rows for the five named families, including a genuinely absent old worker, timing and a source issue; describe the current proof as Items/line parity until then. This is a coverage/documentation limitation, not a demonstrated wrong result: the production projector/hash rule is unchanged, retained materialization tests cover canonical site/self hashes and empty replacements, and continuation tests compare recovered input/works with the existing path. It does not block this isolated rehearsal.

2. **Make the inspection's readiness flag agree with its failure status.** `tests/staging/reportingInstalledState.ts:445–455` computes `runtimeReady` from site eligibility without incorporating fresh-snapshot drift, collection completeness or report errors. Thus a drifted inspection can say `runtimeReady: true` while correctly ending `STATUS: FAILED`. Include those conditions in readiness and assert false in the existing drift test. The documented handoff already requires exit 0, complete/no-drift evidence and `STATUS: COMPLETE` before running the worker; that authoritative gate still refuses the run, so this misleading auxiliary flag is non-blocking here.

3. **Align runtime R0's identity checks with the inspector before treating it as a standalone inspection replacement.** `tests/staging/reportingWorkerScenario.ts:119–145` checks dependencies and the 0043/0045/0046 catalogs, but does not inspect 0044 before accepting its absent receipt. It also lacks the inspector's full signature/volatility and index-validity checks. The task-3 claim of the “same” effective identity rule therefore needs qualification. Reuse the existing inspection identity checks in R0, without a new harness or CLI mode. For the approved workflow, the mandatory immediately preceding inspection checks 0040–0046 and CJ holds an exclusive staging window; runtime R0 is not permission to skip that inspection. No faulty installed schema or exposed role was observed offline.

## Nitpicks

1. The task-1 log calls the missing full-worker incomplete-plan-journal adoption test “Not done (per the trim)”; the trim retained that case. The implementation wires the existing recovery/continuation helpers, and the retained SQL/helper test covers plan-to-stage upgrade on the first sealed write and refusal of stage-to-plan adoption. Record this as helper-level evidence with a worker-level gap, not a trim-authorized deferral. Likewise, the new upload test stores chunks **0 and 1**, then sends **2**; it is selective interrupted-upload recovery, not the specified sparse **0 and 2** case. The membership-based implementation supports sparse discovery, but that exact example was not added.

2. The changed PG-LONG tests use 900,000/1,800,000 ms test timeouts where the previous test used 600,000 ms. Record that offline-test timeout change against the trim's no-timeout-increase wording. The worker's 240-second budget, reserve, lease/heartbeat and finite invocation ceiling were not raised; no production-capacity claim follows from these test timeouts.

## Review evidence and hardening

### Worker staging, counts and recovery

`production-reporting-worker.ts` is the only production file changed. Planning and staging share the existing routed owner reader, with phase-specific finishing. Known journaled owners bypass a repeated light/source walk, recover through the read gate and reuse the loaded input. Complete journals require no checkpoint or purpose upgrade. Durable turns serialize owners; staging projects only the claimed audience at a time through the existing `audienceWork`, checks its canonical input hash against the claimed descriptor, and does not rebuild the audience set from a truncated claim page. Previously planned old-self works remain claimable.

Staged-chunk discovery uses the real keyset loop. Every stored chunk number/hash must match the locally generated result before any missing chunks are sent. A mismatch fails without overwriting it. The new interrupted-upload test loses a committed non-final response, stops with no publication, then discovers the retained chunks and uploads only the missing chunk. Completed work is omitted by the existing claim protocol. Durable discovery/upload calls use the per-call guard, including the post-renewal time check; admission retains counted-call capacity and observed-wall parking. Owners without journals retain the existing coalesced light path; no new standalone light-to-stage activation proof is claimed.

Publication remains behind exact plan verification/sealing, completed claims and the existing atomic SQL publication. No count, canonicalization, source event, stock or ledger rule changed. Retained tests cover input/hash parity, audience isolation, old credit replacement, cap refusal, journal validation and replay/fencing. The new atomic 0045 worker test checks checkpoint-before-dependent-read, no redundant included-child read, a reread before commit and no reread after a committed reply is lost; incomplete runs assert no new generation. Its final assertions are daily parity, not direct equality of all five published row families. The Should-fix above records that distinction.

The log reports PG-LONG finishing with 300 cancellations, one-row child pages, fresh worker instances and 1,000 simulated ms on every RPC:

| Variant | Invocations | Calls |
| --- | ---: | ---: |
| Uninterrupted apart from budget stops | 4 | 759 |
| Lost committed checkpoint reply | 4 | 764 |
| Lost first staging-upload reply | 4 | 761 |

The tests enforce the existing 20-invocation ceiling and advancement of unfinished journal positions. The two lost-response variants are separate runs, not a combined crash campaign. Together with the non-final upload recovery test they provide the representative continuation evidence; exact old traces and additional campaigns are not required. These numbers are coder-recorded PGlite/simulated-clock results, not hosted measurements.

### Cleanup, security and rollback

After acknowledged publication the worker attempts at most one bounded journal release if a call fits. Release success, `more=true` and failure leave the generation published; failure produces an allowlisted kind/count rather than database text. Explicit cleanup also has one bounded release pass. Existing 0046 SQL restricts deletion to journals attached to published batches and qualifying generations, consumes an aggregate row budget and deletes pieces before events before headers. It does not delete active/unfinished/abandoned journals, source facts or published results. Failed cleanup remains visible; no automatic evidence reset was added.

0046 remains an unchanged **offline draft**: three private RLS tables, additive indexes/helpers and service-only invoker functions with empty search paths. Gates bind journal handles to the batch/site/cutoff/rule and current fence/lease; no client grant was added. The new inspector includes 0046 functions, tables, indexes and privileges, requires its receipt once, and labels raw versus accepted absent 0044/0045 receipts. Other receipt or effective-identity failures remain failures. The fixed staging-project guards remain in the runner.

R6 requires anon plus owner/manager/staff/kiosk/CS identities, checks service protocol access and denies each client the protocol RPC and direct reads of all three tables. Every denial probe rolls back. Actual staging claims stay in memory; tests use offline stand-ins. The added ownership check rejects run-site journals on batches outside the recorded run, while existing all-sites stable hashes preserve foreign data. No endpoint, credential, dependency, repository interface or Dexie contract changed. Shopify/Dropbox/Slack/Make/email are outside this rehearsal.

The runner retains ownership-before-write, stop-on-first-failure, safe cleanup and a fresh audit. Cleanup restores capture/processor/read settings and deletes only owned fixture source IDs; UK/US retained evidence is not a reset target. Rollback remains processor off plus `legacy`, with additive schema left installed. Capture disable changes the global epoch and requires fresh rebuilds before summary reuse. The rehearsal does not leave an app-ready generation. A later Preview rollback must retain S1/digest authentication.

### Hardening disposition

| Section | Review result |
| --- | --- |
| 1. Failure modes | Bounded retry, fenced takeover, committed-page/chunk reuse, visible pending/failure and no partial publication retained. No scanner/input workflow changed. |
| 2. Data correctness | Shared saved-event projection, site/self binding, exact instants and historical replacement unchanged; proof limits identified above. No current-profile substitution or invented quantities. |
| 3. Security | Service-only protocol/private storage, fixed staging guards, in-memory claims, rolled-back denial probes and safe post-publication diagnostics checked. No new public entry point. |
| 4. Release/rollback | Additive draft only; mandatory inspection then AU rehearsal; processor-off/legacy fallback and prior protected app remain available. CJ owns installation and release. |
| 5. Performance | Existing indexed reads, row/byte/input/audience/reload limits and one durable owner/audience retained. Representative finite progress is supported; two-/five-year, three-site and concurrency capacity is not certified. |
| 6. Operations | Run outcomes/counts and retained evidence remain visible; one bounded release plus explicit cleanup. Monitor journal growth and heavy/no-progress outcomes before sustained use. |
| 7. Tests | New recovery/housekeeping/inspection/role/audit tests and retained counting/credit/stock regressions inspected. Final gate accepted from the coder, with the precise limitations above. |

## Gate, waiver and deferral ledger

The task-3 Implementation log records the final combined tree: `npx tsc -b` exit 0; `npm run typecheck:digest` exit 0; strict staging-runner check exit 0; **80 files, 2459/2459 tests**; `npm run build` exit 0. The strict command is:

```text
npx tsc --noEmit --strict --skipLibCheck --target ES2020 --module ESNext --moduleResolution bundler --types node tests/staging/reporting-jobs.ts tests/staging/reporting-capture.ts
```

This review uses that evidence as instructed; it did not rerun the suite/build or claim a new gate. The earlier task-2 2447/2448 failure and subsequent 2448/2448 result remain recorded, with the original failure's cause unconfirmed. Hosted CI is not claimed.

Read-only review checks confirmed the exact branch/range, a clean starting tree, no migration delta from `fa6cdae`, clean `git diff --check`, and all nine 0037–0045 LF hashes matching their retained pins. Independently calculated draft 0046 LF SHA-256:

```text
4641d7cd4dd3ca48d0ccf5350584bb6c23efec6bac4c5a4e6c26d60b7b0b6141
```

CJ's step-4 waiver is preserved accurately: Must-fix 1 and 3 were fixed; 2 (retry-trigger accounting), 4 (impossible arithmetic inputs) and 5 (additional boundary/seam evidence) were waived, not declared tested. Step 4 remains complete under that waiver. This review does not reopen it.

The trim still records the deferred crash/cut/cap/audience/Unicode/retention/performance campaigns, hosted Tasks 16–20 and app/browser/dry-digest acceptance. Mutation quotas and repeated per-step reviews remain dropped. The narrower retained-proof delivery is explicitly distinguished above from those authorized deferrals; it is not relabelled as full five-family acceptance.

## CJ handoff

Follow the trim's preparation order on **staging `ybrzhrgfrnvtcwymjdrq` only**. CJ verifies/applies the exact draft 0046 once, preserves UK/US evidence, obtains a fresh eligible AU preflight and runs:

```powershell
npm.cmd run staging:reporting-jobs -- --inspect-installed --sites=au,uk,us
npm.cmd run staging:reporting-jobs -- --worker-runtime --site=au --pace-calls=4 --max-invocations=12 --max-lease-wait-ms=420000
```

The second command is conditional on the first's exit 0, complete/no-drift report, `STATUS: COMPLETE` and AU eligibility; the readiness boolean alone is insufficient. Require all R0–R7 observations, cleanup and fresh audit to pass. Preserve failures and stop on missing/failed evidence. No limit increase, site switch or evidence deletion is authorized. Preview/app acceptance and production release remain later CJ steps.

## Coder response

No blocking repair requested. Non-blocking follow-up items above are recorded without requiring another pre-staging review. This planner wrote only this file; no app code, SQL, hosted environment, commit, push, merge or deployment was performed.

STATUS: COMPLETE
