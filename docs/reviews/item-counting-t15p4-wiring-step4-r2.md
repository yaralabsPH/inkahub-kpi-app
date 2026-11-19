# Review: item-counting — T15P-4d wiring step 4, round 2

- Slug: `item-counting` · Branch: `feature/item-counting` · Reviewed commit: `dffdbc8ea94a73849cb0c0c9ef436338a5399a47`
- Reviewer: planner (GPT-6 Astra) · Date: 2026-11-19
- Verdict: **changes required**. Exact commit-call sizing, live reload counts and between-checkpoint renewal are improvements. The worker still double-charges paid serialization, omits CPU and source-read costs from fresh-path admission, and can repeatedly park without durable progress. Required recovery/hash boundary evidence is also incomplete.

Line references below are to the reviewed commit, also checkout HEAD. Read both commits (`dffdbc8` and first version `b35e989`), the round-1 review and appended coder response, and surrounding reader/materializer/journal code. This is an intermediate step-4 review, not feature or release acceptance.

## Checked against

- [ ] Full feature spec acceptance: outside this intermediate checkpoint; no completion claimed.
- [x] Step-4 plan and self-review correction (`docs/plans/item-counting.md:6531`, `:6538`), cumulative admission contract (`:5792`), and repair log (`:6698`). Remaining deviations are below.
- [x] Every round-1 Must-fix and Should-fix item in `docs/reviews/item-counting-t15p4-wiring-step4.md`, including the coder response at `:110`.
- [x] Scope-review Must-fix 2 (`docs/reviews/item-counting-t15p4-scope.md:63`).
- [x] AGENTS.md guardrails, `docs/ARCHITECTURE.md`, and every section of `docs/HARDENING.md`.
- [x] Roadmap F1 and cross-cutting decisions: counting, historical attribution and production isolation remain unchanged.
- [ ] Complete type-check/test/build/CI gate: independent focused run had one timeout; isolated retry passed. Wider gate remains coder-reported, not independently certified.

## Round-1 disposition

| Round-1 item | Status | Evidence and remaining issue |
| --- | --- | --- |
| Must-fix 1 — false three-call commit bound | **Partly resolved** | `READ_UNIT_RPCS` is removed. `ownerPageCalls` uses the actual packing rules (`api/_lib/reporting-worker-state.ts:452`), and the worker admits that count before `journal.commit` (`api/_lib/production-reporting-worker.ts:469`). Independent escaped/multibyte probes below confirm the count. However, the commit's fresh path excludes the source read and processing required to recreate its page; separate read and commit verdicts do not prove the complete fresh path fits. The committed multi-call test uses an oversized synthetic source page and an ample deadline (`tests/api/reporting-worker.test.ts:1166`). See remaining Must-fix 1 and 3. |
| Must-fix 2 — CPU separation and once-only preparation | **Partly resolved** | `processCpuMs` excludes elapsed I/O/sleep (`worker.ts:714`); descriptor CPU is separate (`:482`, `:487`), and first-unit CPU is explicitly 1,000 ms (`:712`). The counter-clock descriptor assertion is at `tests/api/reporting-worker.test.ts:1092`. But paid serialization is charged again to current remaining time (`worker.ts:469–471`); source-read CPU, light preparation and reading-snapshot reconstruction are not fully measured; process-wide spans can include other owners. See remaining Must-fix 1 and 2. |
| Must-fix 3 — current durable-position prerequisites | **Partly resolved** | Successful page/hash checkpoints now update reload counts (`worker.ts:473`, `:495`), and the live-count/restart tests exercise growth (`tests/api/reporting-worker.test.ts:1045`, `:1252`). Excluding already-completed open/discard RPCs from a subsequent restart is correct. Reconstruction CPU still uses an unjustified cumulative serialization proxy (`worker.ts:474`); pending-discard and partially hashed paths are explicitly untested (`round-1 review:119`). See remaining Must-fix 2 and 3. |
| Must-fix 4 — transient versus intrinsic capacity; expired preparation | **Partly resolved** | The idle override is gone (`worker.ts:419–425`). Admission calls `beat`, not the deadline guard, before classification (`:414`), so the specific over-budget recovery case reaches capacity. Tests cover transient-delayed/short runs and CPU+wall recovery exhaustion (`tests/api/reporting-worker.test.ts:1189`, `:1217`, `:1230`). Those repairs are accepted. The broader progress-or-capacity contract remains broken: the serialization and source-CPU probes below each return three unchanged-position pending results in standard, uninterrupted invocations. These are remaining costing defects, not a request to restore the idle override. |
| Must-fix 5 — worker boundary and renewal inside the unit | **Partly resolved** | The guarded client runs `pageGuard` before each page-write/hash RPC (`worker.ts:397`, `:452`, `:493`); `pageGuard` retains its post-renewal deadline check (`:593–597`). The read test now exercises park/renew/commit/resume (`tests/api/reporting-worker.test.ts:1113`); the multi-call test checks `checkpoint, renew, checkpoint` (`:1166`). The 5,000/6,000-ms thresholds include the explicit 1,000-ms first-unit CPU allowance, explaining their difference from the plan's zero-CPU 4,000/5,000 example. Hash-boundary and actual deadline-crossing-renewal tests required in round 1 are still absent. See remaining Must-fix 3. |
| Should-fix 1 — observation versus final action | **Resolved** | Verdict and `action` are derived together and used without the old override (`worker.ts:419–425`). Tests assert run/park/fail consistency (`tests/api/reporting-worker.test.ts:1074`, `:1141`, `:1243`). This resolves the reported pending-observation/capacity-action disagreement; it does not make the underlying cost estimate correct. |

Here and below, `worker.ts` abbreviates `api/_lib/production-reporting-worker.ts`.

## Must-fix

1. **Separate work already paid from work still needed, while pricing the complete fresh path to the same durable boundary.**

   `api/_lib/production-reporting-worker.ts:469–471` serializes/sizes the page, measures that elapsed CPU, then passes the full measured amount as the commit's unpaid unit CPU. `admitDurableUnit` charges unit CPU to both fresh and current costs (`:743–748`). Current `remainingMs` already reflects that serialization. Cached event entries are reused by the commit (`api/_lib/reporting-worker-state.ts:611`, `:629`), so this is not a justified allowance for redoing the same event serialization. Packing and transport serialization that really remain need their own estimate.

   **Reproduced offline:** after enumeration, run the single activating owner first in three standard 240,000-ms invocations. Keep independent CPU/wall clocks, with source/RPC calls costing 1,000 ms. Charge 120,000 ms to the actual `pageCalls` measurement boundary, advancing CPU and wall together. Each invocation parks at its first commit with seq **0**, no pending pieces and no failure kind. Remaining time is **108,000 / 109,000 / 109,000 ms**; the commit path is `{ prerequisites: { rpcs: 9, cpuMs: 0 }, unit: { rpcs: 1, cpuMs: 120000 } }`. The serialization has already finished, and the one remaining checkpoint fits easily. Repeated unchanged pending is the opposite of the plan's `:6536` requirement.

   There is also an undercount on the fresh side. `READ_LEG_RPCS = 2` (`worker.ts:710`) is only a speculative minimum before the page is known. Once the exact commit is known, `admit("commit", calls, serializeMs)` still uses only recovery prerequisites (`:407`, `:415`). A fresh invocation cannot start with this uncommitted page in memory: it must repeat the source read, decoding and page processing. The measured processing cost at `:467` only feeds a later read estimate, not this commit's fresh path. Neither of the two separate verdicts establishes that their necessary combined work fits fresh.

   **Repair:** preserve exact pre-write commit admission and atomic cursor progress, but represent the fresh complete path and the current unpaid remainder separately. Include the source/reconstruction/processing/serialization that must be repeated fresh; exclude already-paid work from current remaining cost. Do not use an optimistic one-call checkpoint minimum to certify a known multi-call page. Do not restore the idle override or increase limits.

   **Required tests:** make the paid-serialization case advance its cursor; add a near-ceiling source-plus-multi-call-commit case whose pieces individually fit but whose complete fresh path does not, and require explicit capacity rather than repeated pending. For a path that fits fresh but not now, park before uploading any piece, then advance on the next standard invocation. Assert independent CPU/RPC accounting, reserve and retained evidence.

2. **Complete and justify CPU component ownership before using it to declare permanent capacity.**

   The new clock type fixes elapsed-I/O charging, but the measurement boundaries remain incomplete:

   - The source call finishes before `readEnd = cpuNow()` (`worker.ts:431–432`). Its synchronous response validation/reduction is omitted; the real reader performs work inside that call (`api/_lib/production-reporting-reader.ts:114–128`).
   - The recovery timer starts only after light-route activation (`worker.ts:438–446`). Light parsing, consumed-event accounting and preparation are repeated on a fresh attempt but are not included as CPU prerequisites.
   - `recoverOwnerJournal` returns before `durableOwnerInput` rebuilds its maps/budget from the reading snapshot (`api/_lib/production-reporting-materialize.ts:1223`, `:1523`). Work before the first wrapped read is outside the recovery timer and the read-to-commit timer.
   - `cost.reloadCpuMs += serializeMs` (`worker.ts:474`) is an estimate, not a measurement of reload parsing, reassembly, digests, sorting and state reconstruction. No evidence establishes that serialization time bounds or predicts those operations for the current phase/prefix. The next actual recovery replaces that estimate, so current and fresh invocations can classify the same position differently.
   - Recovery and hash measurements span awaits/retries (`worker.ts:445–449`, `:492–494`) while owners run through `Promise.allSettled` (`:398`). A process-wide counter includes concurrent owners and CPU spent handling retries/renewals; changing the clock does not isolate those components.

   **Reproduced offline:** inject 250,000 ms of synchronous source-processing CPU immediately before a durable member-page call returns, advancing CPU and wall together. Three standard uninterrupted invocations return **pending, seq 0**, with remaining time 0. Each final commit admission reports prerequisites `{ rpcs: 9, cpuMs: 0 }` and unit `{ rpcs: 1, cpuMs: 0 }`; none diagnoses capacity. The already-added over-budget *recovery* test does not cover this missing component.

   **Judgment on the stated process-CPU limit:** acceptable as a disclosed aggregate measurement or a conservative reason to park the current invocation, **not yet acceptable as proof that this owner cannot fit a fresh invocation**. Other light owners' CPU need not recur on the smallest path for the parked owner. Charging it to that owner's permanent capacity can falsely fail a processable batch. Round 1 explicitly prohibited rejecting an owner solely because an upper estimate is too large. Deferring this issue entirely to 4e does not close step 4.

   **Repair and evidence:** instrument synchronous components or provide separately measured, justified estimates with explicit ownership. Include light preparation, source decoding/reduction, reading reconstruction, descriptor work and remaining serialization; avoid charging retry/renewal/other-owner CPU again as intrinsic owner cost. Keep wall guards independent. Test each nonzero component, retry/renewal separation and concurrent light work, plus a near-ceiling success and genuine refusal. The current spy proves clock units; the per-read counter proves selected measurement boundaries, not complete component coverage. Retain representative CPU/memory sampling as an additional 4e obligation.

3. **Finish the required worker-level recovery and boundary cases; do not move these round-1 requirements to 4e without approval.**

   The coder explicitly leaves pending-discard, partially hashed and hash-boundary cases unexercised (`docs/reviews/item-counting-t15p4-wiring-step4.md:119`, `:125`). A shared formula/client is useful implementation evidence, but does not test phase-dependent inputs, saved hash offsets, retry/recovery or the next invocation's actual trace.

   - **Pending-discard:** seed an unfinished multi-call page, recover it, assert exactly the necessary discard/reload calls, compare the next admission's current-position prediction with a fresh invocation, and verify durable cursor progress. Excluding a discard *after it has succeeded* is correct; the test must establish that transition. The fake already has pending storage and discard behavior (`tests/api/reporting-worker.test.ts:59`, `:991`); its documented limits do not prevent testing orchestration.
   - **Partially hashed:** exercise more than 100 audiences, interrupt after a non-final hash checkpoint, resume the parked owner first, verify saved hash/seq progress, no durable source reread and no second evidence reload. `hashOwnerInputStep` handles distinct reading/hashing/complete branches (`api/_lib/reporting-worker-state.ts:664–695`); ordinary small-audience completion cannot substitute for this case. If the fake is inadequate for a particular assertion, identify the exact missing behavior and use the authorized local SQL harness; do not silently defer the integration proof.
   - **Hash boundary:** run the real header/checkpoint path at 29,500 ms with insufficient and sufficient time, assert ordered RPCs, renewal before checkpoint, the reserve, saved hash progress and fresh recovery. Add an actual renewal that crosses the invocation deadline and assert no following checkpoint/read. Keep the existing pure fixed-point tests (`tests/reporting/reportingOwnerInputState.test.ts:461`), but also make worker phase/guard mutations fail the worker tests.
   - **Valid multi-call source page:** `tests/api/reporting-worker.test.ts:1168` supplies two 700-KB rows in one memory-source page, exceeding the real 1-MiB response limit. This is useful for guard ordering, but it is not the requested reader-accepted boundary fixture; `:1177` also uses the full budget and `:1186` only asserts call order. Add the escaped/multibyte real-reader/writer cases and near-deadline all-or-nothing admission assertions from round 1.

   Scope-review Must-fix 2's phase arithmetic and ordinary read renewal are repaired. Its integration gate, expanded explicitly by round 1, is not fully closed. Keep production-framing 119/121, 50,000/50,001, audience-limit, independent-oracle and sampled-memory evidence in 4e as well; the requested tests here do not replace those later obligations.

## Should-fix

1. **Retain and investigate the additional focused-suite timeout without representing the independent gate as green.** The unmodified 65-test API file finished **64 passed, 1 failed**: `tests/api/reporting-worker.test.ts:754`, “a transient failure is retried after 30/60/120 s within the budget; beyond it the cycle is deferred (pending), never slept past the deadline”, timed out at its existing **5,000-ms** limit. It passed alone in **1,953 ms** without a timeout change. This is a different test from the first-test timeout recorded at `docs/plans/item-counting.md:6727`. Preserve both observations in the next coder gate; determine whether suite contention explains recurrence before making timing changes. No assertion failure or deterministic functional failure was established by this isolated retry.

## Verification and limits

All work was offline with installed dependencies. No database, hosted service, network lookup, credential or remote CI was used. Only this review file was written. No application/test/plan/migration file, git state, commit or push was changed.

- **Unmodified API suite:** 65 tests; **64 passed, 1 timed out**, exit 1; test time 70.39 s, total 73.29 s. File-free stdin Node invocation of `startVitest`, `config: false`, `watch: false`, `cache: false`, one worker, Vite `configFile: false`. This checks the selected tests, not the project's Vite configuration.
- **Isolated existing timeout test:** 1 passed, 64 skipped, exit 0; 1.95 s in tests. The original failed run remains failed evidence.
- **Review-only probes:** three added tests across two filtered runs, appended in memory through a Vite load hook; all completed with expected observations. Neither source files nor persisted tests were edited. Two probes deliberately assert the remaining defects; passing them is not acceptance. Their large deterministic CPU charges test accounting, not representative production performance, and do not consume 120/250 seconds of real CPU.
- **Exact packing probe:** both inputs were accepted by the real `rpcFrozenReader.pages.membersPage`, then passed through `eventEntries`, `ownerPageCalls` and a recording `writeOwnerPage` client. The escaped SKU (`'"'.repeat(520000)`) produced a **1,040,311-byte response**, **11 pieces**, and **4 checkpoint calls**, with payload sizes **983,298 / 983,103 / 114,282 / 81 bytes**. The multibyte SKU (260,000 U+1F642 characters) produced a **1,040,311-byte response**, **6 pieces**, and **1 call**, payload **1,040,632 bytes**. Exact predicted/actual call counts matched and every payload stayed within `REQUEST_BODY_BYTES`. These are compact response/payload measurements, not full HTTP-envelope, SQL or representative memory/performance evidence.
- **No independent full-suite, type-check, build or CI run.** The **80 files / 2421 tests, tsc, typecheck:digest and build** result at `docs/plans/item-counting.md:6728` remains coder-reported. Keep the API-inclusive `typecheck:digest` gate; ordinary `tsc -b` does not cover `api/`.

## Hardening, scope and next gate

| HARDENING section | Assessment |
| --- | --- |
| Failure modes | Transient/short-run pending and between-write renewal are improved. Remaining cost errors allow unchanged-position pending or unjustified capacity. Preserve fence checks, atomic page steps, lost-response replay and bounded Deferred behavior. |
| Data correctness | No counting, audience identity, canonical hash, attribution, UTC/site-time or inventory/ledger semantic changes. Existing parity tests remain useful; independent five-family/old-self evidence remains due in 4e. |
| Security | No endpoint/authentication/selector, RLS/grant or secret-boundary changes. Exercised capacity diagnostics remain kind/count-only with evidence retained and publication blocked. No hosted-security claim. |
| Release and rollback | No migration changed, dependency added or release authorized. Existing migrations remain immutable; 0046 remains an offline draft. CJ owns merge, SQL application and deployment. Preserve processor-disable/legacy-read and compatible prior-code rollback with additive schema/evidence retained. |
| Performance | Keep 240,000 ms, 30-second cadence, 2,000-ms reserve and existing source/request/reload limits. Exact checkpoint count is accepted; complete-path cost and CPU ownership remain blockers. No new performance target or limit is approved. |
| Operations | Pending must remain recoverable, and intrinsic refusal must be supported by the owner's fresh path. Retain run diagnostics/evidence; unchanged pending must not be counted as healthy durable progress. |
| Tests | Complete the required cases above and retain the exact timeout evidence. Run the authorized common offline gate after repairs; green helpers cannot substitute for worker recovery/boundary assertions. |

No Repository interface change needs a Dexie counterpart; no root whitelist change is involved. The implementation delta is confined to the worker, journal adapter, API tests and review/plan logs. Do not change scope, counting rules, limits or migration bytes to satisfy the tests. Record any additional file dependency or design obstacle under the active plan's open questions before expanding implementation.

Later separately authorized staging must still check the exact reviewed schema, service access and anon/owner/manager/staff/kiosk/cs denials, independent-session takeover/cleanup, old-code and retained-read compatibility, real transport/CPU/memory and rollback. Nothing in this review authorizes hosted execution.

Do not mark wiring step 4 complete. Correct the admission accounting, complete the outstanding worker evidence, update the coder log's claim that all five Must-fix items are fixed, and return for review. Steps 5–8 and later acceptance obligations are not waived.

## Nitpicks

None.

## Coder response

(Coder records repairs, exact verification and any open questions in the active plan under the existing workflow.)

STATUS: COMPLETE
