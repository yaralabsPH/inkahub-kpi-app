# T15P-4d wiring step 4 — simplification scope decision

Date: 2026-11-19. Role: PLANNER. Decision: **AMEND AND ACCEPT**, under CJ's explicit decision to replace measured-CPU admission and authorize one review of the redesigned step 4.

This file amends [plan wiring step 4 and its implementation logs](../plans/item-counting.md) and supersedes conflicting CPU-admission requirements in earlier scope decisions and reviews. It is a scope decision, not an implementation pass, a fourth repair round of the old model, or acceptance of T15P-4d. The coder may implement the bounded redesign below without another scope confirmation. There is **one** authorized review of that implementation; a failed review returns to CJ, not another automatic loop.

Read AGENTS.md, ARCHITECTURE.md, ROADMAP.md, HARDENING.md, the wiring scope decisions, [round 3](item-counting-t15p4-wiring-step4-r3.md), step 4 and subsequent logs, and the relevant worker, reader, journal and admission tests. The architecture document describes the recovered baseline; the current executable worker supplies the wiring details. No application changes or executable verification are claimed by this decision.

## 1. Disposition of the five proposals

| Proposal | Decision | Reason against HARDENING.md |
| --- | --- | --- |
| 1. Call-count-only capacity | **Accept with arithmetic and counting amendments below.** | Sections 1, 5 and 6: removes process-CPU attribution as a source of false permanent refusal. Counts describe a deterministic admission policy, not proof of actual runtime. The fresh commit must include its source reread; retry attempts and an earlier large page must not inflate the minimum fresh path. |
| 2. Invocation-local wall estimates for parking | **Amend.** Keep per-owner, per-kind completed-unit maxima and the 1,000-ms initial allowance, renamed to describe wall time. | Sections 1 and 5: elapsed time includes the work the CPU spans missed. The proposal deliberately adds RPC allowances to an inclusive elapsed sample; that is conservative padding, not disjoint cost accounting. It may only park, never establish capacity. Do not charge already-paid sizing again at commit admission. Cooperative guards cannot promise preemption of an arbitrarily slow synchronous operation or in-flight RPC. |
| 3. Observed no-progress backstop | **Amend substantially; use one strictly qualified fresh attempt, without persisted strike state.** | Sections 1, 5 and 6: “no earlier durable work” alone is insufficient, and requiring a unit admission misses recovery/descriptor starvation before admission. Define freshness, substantive progress, error precedence and recovery as in section 4. This is an observed failure of this run, not proof that the input can never fit. |
| 4. Remove CPU machinery | **Accept.** | Sections 5 and 7: remove unneeded ownership machinery and its duplicated reconstruction work; it is not reliable evidence for a capacity decision. Preserve validation and actual reconstruction. Keep process CPU measurement only where an existing 4e measurement consumer needs it, completely disconnected from control flow. |
| 5. Preserve accepted behavior and limits | **Accept, subject to the explicit replacements here.** | All hardening sections: retain fencing, replay, atomic page advancement, recovery, limits, renewal phase and publication isolation. Change only the CPU-dependent policy and the bounded fresh-attempt scheduling needed to make its replacement testable. No limit increase or idle override. |

Alternatives considered: a fourth span-accounting repair retains the demonstrated attribution problem and is rejected. Two consecutive failed fresh attempts would reduce sensitivity to one slow run, but cannot prove intrinsic incapacity either; it adds a durable counter, identity/reset rules, fencing, ambiguous-response handling and protocol/release work. It is not needed for the operational diagnosis selected here and is **out of scope**.

## 2. Exact capacity rule

Use the existing constants: `WORKER_BUDGET_MS = 240_000`, `HEARTBEAT_MS = 30_000`, `ADMISSION_RPC_MS = 1_000`, `ADMISSION_RESERVE_MS = 2_000`. Capacity always compares with the standard 240,000-ms budget, including when a test requests a shorter invocation.

**Reserve arithmetic:** the current `withRenewals(workMs, sinceBeatMs)` already returns work plus its fixed-point renewal allowance **plus the reserve**. Retain that contract. Do not add another reserve as the proposal's notation would do. In this document, `C(x, s) = withRenewals(x, s)`.

For the next progress boundary:

```text
F = FIXED_PREREQUISITE_RPCS + this owner's fresh light activation calls + lookup
R = exact reload calls for the currently committed journal
U = calls for the next fresh unit, including its committing call(s)
freshMs = C((F + R + U) * ADMISSION_RPC_MS, 0)
capacity iff freshMs > WORKER_BUDGET_MS
```

Derive these fields in the worker and expose them to tests; do not hand-feed a total to simulate integrated evidence.

- `FIXED_PREREQUISITE_RPCS` remains the five restart calls (version, status, resume, progress, owner page). Other owners, earlier copy/enumeration and unrelated retries are not this owner's fresh prerequisite path. An actually required additional prerequisite cannot silently disappear from the count.
- Keep the activation watch and its retry/limit accounting. Distinguish that watch's attempted-call count from the no-failure fresh replay count used for capacity: transient duplicates are not unavoidable fresh calls. Count the owner's actual logical light path, not process-wide reader traffic. Tests must demonstrate this distinction. An activation threshold or malformed input still follows its own existing rule.
- `R` uses the committed journal's current exact reload count and the existing 120-call heavy gate. Refresh it after progress; never repeatedly charge an already-completed open or discard. Preserve lookup-before-heavy-refusal/discard/reload. Open/discard that are actually still required for an unperformed recovery must be accounted once in that recovery's current work; a future clean committed restart does not redo them.
- Before a source read, `READ_LEG_RPCS = 2` is the minimum one-read/one-checkpoint path, **not knowledge of that unread page's exact packing**. It can prove that even the minimum is over budget; a fitting minimum does not authorize an unknown multi-call commit. Do not use the largest previous page as a minimum-capacity proof for the next page.
- After `ownerJournal.pageCalls(pg)` gives the exact commit count `N`, repeat the decision **before the first piece/page checkpoint RPC**. Fresh `U = 1 + N`; current unpaid calls are `N`. The source reread belongs to the fresh path even though it is already paid in this invocation. No piece upload may begin on the strength of the preliminary two-call estimate alone.
- An unfinished hash unit uses `HASH_UNIT_RPCS = 2` (header plus hash checkpoint). A known-complete journal must not be failed for a nonexistent next checkpoint; retain its completion/reuse path.
- Validate finite non-negative durations, safe-integer non-negative counts, phase and arithmetic results. No CPU value, observed wall estimate, current remaining time or other owner's measurements may enter `freshMs` or produce `owner_input_capacity`.

Capacity refusal retains evidence and blocks publication. “Before any RPC” means before **any RPC belonging to the refused unit**, including every commit piece. Already necessary version/acquisition/lookup/reload calls cannot be retroactively avoided when they supplied the count. A standalone over-budget admission check must have zero RPC side effects. The integration evidence must list the prerequisite prefix separately rather than claim a zero-call invocation.

## 3. Exact parking and clock rule

Take a due renewal before admission, then sample the clock again. Admission must use the actual phase since that renewal and actual remaining invocation time. A renewal that exhausts the available time must prevent the following source/journal/hash RPC.

Maintain two completed-sample maxima **per owner and per invocation**, initially absent:

- Read+commit leg: start immediately before the admitted source operation and finish after its final acknowledged page commit. Include decoding, materialization, sizing, writer packing, transport serialization, all waits/retries and intervening renewals. No successful read alone is a completed sample.
- Hash unit: start before the admitted header/hash operation and finish after its acknowledged checkpoint. Include the whole operation, including intervening waits/retries and renewals.

Let `E` be the largest completed elapsed sample of that kind, or `FIRST_UNIT_WALL_MS = 1_000` if none exists. Rename `FIRST_UNIT_CPU_MS`; an explicitly observed zero is distinct from an absent sample. Samples reset on a new invocation and are never shared across owners. An incomplete attempt is failure evidence, not a completed-unit estimate.

At a new unit, park unless:

```text
remainingMs >= C(currentUnitRpcs * ADMISSION_RPC_MS + E, sinceBeatMs)
```

At exact commit admission use `N` unpaid calls and the same kind's conservative allowance `E`. **Do not add the current page's already-elapsed read/sizing duration again.** Continue the leg's stopwatch through the commit so the next leg gets a complete sample. The inclusive sample plus explicit RPC/renewal allowances is deliberately conservative and may park early; do not describe its components as exact, subtract transport durations to recreate CPU ownership, or turn this conservative estimate into capacity. A long completed sample can stop further work this invocation, but progress already exists and the next invocation starts without that sample.

All deadline, heartbeat, sample and freshness decisions use `env.now()` through the worker budget. No `Date.now()`, `performance.now()`, CPU clock, wall/CPU mixture or private reset of the deadline in these paths. Use a single sampled `now` for each decision's remaining/phase/diagnostic fields; resample after awaited renewal. Durations are non-negative and clock inputs finite. Use a nondecreasing invocation-local reading of `env.now()` (clamp backward readings to the previous value); a backward clock adjustment must not grant more budget or reset freshness. Keep UTC run timestamps separate from elapsed-duration calculations. Tests advance this clock deterministically; do not use busy loops or actual long sleeps.

Every source/journal/hash RPC retains its guard, including calls inside the real reader and a multi-call writer. For this durable path, check that the next nominal call plus reserve fits, take any due renewal, and check again before dispatch; bounded retries must re-enter the same guard. The current `b.need()` expiration-only check is not itself a reserve check. Do not alter retry delays, heartbeat interval or lease duration.

**Limit of the guarantee:** admission and guards reserve time under the declared allowances; they cannot interrupt an unbounded synchronous packing operation or cancel an already-started slow RPC. If such work returns after the guard boundary, start no further unit RPC and apply section 4. A fitting-path test must prove the actual reserve remains. An injected 250,000-ms overrun must prove detection and no subsequent work, not falsely claim that it physically retained 2,000 ms. Run-log persistence after such an overrun remains best effort. Hard process termination without reaching a guard is a later operational/runtime risk, not evidence the in-process backstop ran.

## 4. Fresh attempt and `owner_input_no_progress`

The proposed freshness test is rejected as written: zero earlier durable commits says nothing about time spent copying, enumerating, preparing another owner, waiting for its turn, or doing light work concurrently. It also permits an owner to make one page of progress and then misclassify a late second unit.

Implement this narrower, invocation-local rule:

1. Only a standard-budget invocation is eligible. Select its **first pending planning owner in the existing deterministic order** before starting any other owner's light/materialization work. For this first attempt, run that owner alone until its first substantive progress boundary, completion or park/failure. This small scheduling change in `plan`/`routedGroup` is authorized; subsequent owners may keep the existing bounded grouping. Do not launch peers first and call the eventual durable-turn winner fresh.
2. Before that owner's light path starts, the invocation must have done only the fixed restart prerequisites: no copy/enumeration/walk work, earlier owner processing, staging or other durable turn. Also require the observed elapsed startup time to be no greater than `C(FIXED_PREREQUISITE_RPCS * ADMISSION_RPC_MS, 0) - ADMISSION_RESERVE_MS`. Otherwise it is an ordinary remainder invocation. This gives “essentially full budget” a numeric test and excludes unusually slow global startup. Do not restart the clock at owner entry.
3. Mark eligibility before this owner's own preparation. Its light activation, lookup/open/discard/reload, validation/snapshot/map/sort reconstruction and descriptor preparation consume this same attempt's budget. They do **not** retroactively disqualify it for being expensive. The scope extends the backstop to budget exhaustion during this preparation, or a resulting first-unit admission park, after actual owner work has started. Otherwise removing reconstruction/descriptor CPU would just move the endless-pending hole before unit admission. A plain admission park in an ineligible invocation remains pending.
4. Snapshot the owner's semantic durable position on recovery and track actual progress. Progress means committed page/cursor/phase advancement or additional committed hashes (including completion), not merely a seq change, open, lease renewal, pending-piece upload, discard, reload, read or descriptor calculation. A page checkpoint that advances traversal with zero new events is progress. Pending pieces and discard seq churn do not defeat the backstop. Once substantive progress occurs, this invocation can only park normally for later budget exhaustion; it cannot emit no-progress for that owner.
5. If this eligible attempt actually performs owner preparation or starts its first read/hash path and a budget guard/admission then stops it with **no substantive progress**, return `failed`, exact kind `owner_input_no_progress`, retain all journal evidence, and block sealing/publication. This includes a park between source read and exact commit, post-admission writer packing/serialization, and between hash header and checkpoint. Recheck progress after a successful commit before converting any later timeout; a late acknowledged commit is progress.
6. Preserve error precedence: proven heavy/capacity/purpose/validation/fence failures retain their exact kinds. An unresolved transient error or exhausted retry returns the existing `Deferred`/pending result; ambiguous commit response loss is not proof of zero durable progress and follows fenced replay/recovery. Do not turn `Deferred`, lease loss or an arbitrary exception into no-progress. If successful retries merely consumed wall time before a later budget guard, the result may be no-progress on this qualified attempt: it describes the observed attempt, not the cause of its slowness.

`owner_input_no_progress` means **“this fresh attempt did not reach its first durable progress boundary within the guarded budget.”** It must never claim intrinsic/permanent incapacity, identify CPU as the cause, mark the journal heavy, abandon/delete the batch, or install a persistent refusal flag. Return it and record it through the existing run outcome/failure-kind/count fields. Preserve the existing ability to retry/resume the same batch and retained journal; a later normal invocation can progress and publish. No new automatic retry loop is authorized. Failure of the run-record write must not erase the returned diagnosis.

The first-owner scheduling rule makes this reachable: when a shortened/late invocation parks a pending owner, the next uninterrupted resume, with copy/enumeration already complete and earlier owners saved, must give that first pending owner the qualifying attempt. Show this in a multi-invocation test. Endless deferral caused by a persistently unavailable prerequisite remains a visible transient/infrastructure problem; it is not proof about owner capacity.

**No two-strike state.** One qualified attempt is sufficient for this recoverable operational failure. No new table, column, RPC, protocol version, migration or repurposed journal payload is authorized. In particular, do not edit 0046 for a counter just because it is an offline draft; existing migrations remain immutable and 0046 remains draft-only. If a future decision requests persisted strikes, it needs a separate append-only schema/protocol design, not a hidden field in strict journal state or a scan of diagnostic run logs.

## 5. Removal, diagnostics and allowed files

Remove `CpuMeter`, `CpuLedger`, `meteredReader`, light/durable meters, reader `io` hooks, CPU-derived reload/descriptor admission and the admission-only reconstruction pass. Remove `WorkerEnv.cpuNow`/`cpuProbe` and dead `reloadWork`/`lastEntries` plumbing when no independent consumer needs them. Preserve the real loader's piece validation, identity/ordinal/budget map rebuilding, canonical parsing/digests and hashing-recovery sort. Removing an estimate must not remove the operation it estimated.

Retain `processCpuMs` only for an actual 4e measurement consumer. It must not influence capacity, parking, freshness, failure classification or retry. Old CPU-field assertions may be replaced with the new contract; old recovery/correctness assertions may not be deleted with the meters.

`AdmissionRecord` retains owner identity for the **in-process test callback only**, unit, fresh call breakdown, current unpaid calls, wall estimate, sampled now/remaining/sinceBeat/budget, verdict and authoritative action. Add bounded freshness/progress/stop-reason observations as needed to prove the backstop. Never serialize the raw owner object into a production log. Returned problems, run arguments, new counters and any production diagnostics are allowlisted: failure/owner/unit kinds and numeric counts (or expressly labelled timing measurements for admission traces), never partition keys, event/order/staff IDs, journal handles, source rows, request payloads or raw RPC errors. The no-progress problem itself uses kind and counts only. The generic secret redactor is not a key scrubber.

Permitted implementation edits are confined to:

- `api/_lib/production-reporting-worker.ts`: new admission types/rules, bounded first-owner scheduling, guarded attempt tracking, failure kind and safe diagnostics.
- `api/_lib/production-reporting-reader.ts`: remove CPU-only hooks while preserving validation, activation callbacks and every per-RPC guard.
- `api/_lib/reporting-worker-state.ts`: remove unused CPU-estimation helpers/plumbing; expose existing acknowledged progress if needed, without changing checkpoint/replay semantics.
- `api/_lib/production-reporting-materialize.ts`: only a demonstrated seam adjustment needed to observe the existing progress boundary; no counting, traversal, activation-limit or hash redesign.
- `docs/plans/item-counting.md`: coder records this superseding decision, implementation evidence and precise timeout history; ticks step 4 only after its authorized review passes.

Permitted test edits:

| File | Bounded purpose |
| --- | --- |
| `tests/api/reporting-worker.test.ts` | Main integrated proof, faithful fake state, deterministic wall clock and boundary injections; real `rpcFrozenReader`/writer path coverage and first-owner scheduling. |
| `tests/reporting/reportingOwnerInputState.test.ts` | Replace CPU-capacity helper assertions with call-only capacity/wall-only parking, numeric validation, reserve and renewal-phase arithmetic. |
| `tests/reporting/reportingOwnerContinuation.test.ts` | Remove obsolete CPU-field expectations if any; retain/extend recovery, partial-hash, discard and progress evidence. |
| `tests/reporting/reportingPageGuard.test.ts` | Narrow guard/reserve and removed-hook regressions if required. |
| `tests/reporting/pg/walk-resume.test.ts`, `tests/reporting/pg/predecessor-page.test.ts` | Existing prior authorization only; substantive correctness assertions remain unchanged. |

No new shared harness, fixture-size, timeout, pacing-default, invocation-limit, endpoint, dependency, configuration or migration edit is granted. Other parity/e2e test files remain unchanged; a demonstrated additional dependency goes through stop-and-record with the exact failing assertion and minimal proposed edit. Do not change expected counts/hashes to accommodate this redesign.

## 6. Evidence required by the one implementation review

The coder must provide named tests, deterministic clocks, the derived admission/guard trace and actual journal position before/after. CPU-only injections and elapsed-time injections must be independent. No real waiting is needed. Required cases:

1. **Contamination cannot produce capacity.** Reproduce round 3's retry-backoff and production-reader light-renewal cases, with `env.source` absent for the latter, plus other-owner work and hash retry. Inject unrelated process CPU while wall advances only by the specified delay; assert identical call-derived capacity inputs and no `owner_input_capacity`. Include the memory-source route separately. Prove the removed CPU source is never consulted by admission (a throwing spy is suitable); do not restore CPU hooks just to test their absence. Test transient attempt counts separately from fresh logical calls. Changed wall time may cause pending or a qualifying observational no-progress, never capacity.
2. **No endless unchanged pending from unpriced work.** Inject wall cost at the actual writer packing/transport boundary after `pageCalls` and after exact commit admission, not only at a removed `cpuProbe("serialized")` site. A standard fresh attempt that cannot reach its first boundary returns visible no-progress with retained journal and no publication. Repeat after a fresh process/resume to show no hidden in-memory strike dependency. Remove the injected cost and prove the same batch/journal can progress. Also cover preparation before first unit (reconstruction/map/sort and descriptors), and a hash-unit overrun.
3. **Freshness/progress negative controls.** The same delay in a shortened invocation, after copy/enumeration, after another owner, or after one committed page/hash yields ordinary pending. Pending pieces/discard-only seq changes do not count as progress. Acknowledged empty-page cursor advancement and late successful commit do. A late owner becomes the isolated first pending owner on the next normal resume. Completed-sample padding cannot repeatedly starve a first unit across invocations. Deferred transient failures, ambiguous commit loss, fence loss and clock rollback cannot create a false no-progress proof.
4. **Count-only over-budget refusal.** A boundary pair differing by one counted RPC proves `>` versus equality, includes fixed-point renewals and exactly one reserve, and refuses before any unit RPC. The integrated exact-commit case proves `1 + pageCalls` in the fresh path, `pageCalls` in the current remainder and zero partial uploads on refusal. Preserve the source reread even though already paid. If exceeding the budget is unreachable with legal production caps, label the oversized-count injection synthetic; do not enlarge limits to manufacture a valid page.
5. **Fitting path progresses with reserve.** With controlled fitting wall cost, assert actual seq/cursor/hash advancement and at least 2,000 ms remaining after the unit. Include paid sizing, nonzero later packing, a due renewal before admission, renewal between calls, and renewal crossing the remaining guard boundary. Recalculate the 29,500-ms read/hash boundary cases using the 1,000-ms initial wall allowance; do not silently reuse a zero-allowance example. At exact equality admission runs; one ms below parks. Verify complete per-kind maxima/reset behavior and no cross-owner estimate reuse.
6. **Existing accepted regressions stay green.** Keep discard exactly once, fresh recovery without source reread/second reload, 100-of-103 partial-hash resume, all-or-nothing pre-upload admission, boundary/heartbeat order, fencing and replay. Keep real reader/writer escaped, multibyte and astral legal near-1-MiB pages, exact packing-call equality and every payload limit. Retain synthetic 700-KB-row tests only for their stated planning claims; they are not production-valid source-page/publication evidence. Adapt CPU assertions and explicitly superseded capacity expectations only.
7. **Safe visibility.** Assert exact no-progress result and recorded failure kind, publication blocked, retained evidence, and key-free problems/run arguments for both order and event owners. Use recognizable secret/key/payload sentinels. Include run-log failure and recovery on a later invocation. Admission callbacks must not leak their raw owner into logs.

Run focused regressions first, then the plan's common offline gate: `npx tsc -b`, `npm run typecheck:digest`, `npm run test -- --run`, `npm run build`. The API-inclusive check is mandatory because ordinary `tsc -b` excludes `api/`. Record command, exit status, test counts and any setup limitation. No hosted CI is authorized; do not claim CI green from local output. Preserve meaningful mutation evidence for call-only capacity, exact pre-commit admission, fresh eligibility, progress detection and per-RPC guards; timeouts do not count as mutation kills.

## 7. Round-3 disposition and later gates

Round 3 has two numbered Must-fix items; the second has the two distinct components called 2a and 2b in the coder log. All three substantive blockers are addressed as follows:

| Round-3 item | Superseded part | Still required |
| --- | --- | --- |
| Must-fix 1 — post-admission packing | Requirement to estimate/attribute packing CPU or cache prepared requests as the repair. | Exercise the actual unpaid boundary; fitting work progresses, an eligible stopped first attempt is visibly no-progress, and no unit RPC begins without the guard. Endless unchanged pending under repeated eligible attempts remains a blocker. |
| Must-fix 2a — retry/renewal contamination | Meter suspension, ledger ownership and precise CPU-span repair. | Retry/renewal/other-owner and production-reader counterexamples cannot cause capacity; bounded retry, activation counting and heartbeat guards survive hook removal. |
| Must-fix 2b — incomplete reconstruction estimate | Predicted CPU components and predicted-versus-actual CPU reconstruction comparisons for admission. | Full validation/reconstruction remains; one reload, exact committed reload counts and real recovery through growing prefixes/reading-to-hashing remain tested. Expensive preparation cannot evade the amended fresh-attempt backstop. |
| Should-fix 1 — timeout-log precision | Nothing. | Retain the first API test's full-suite timeout and the separate round-2 transient-retry observation: **64/65 passed, one 5,000-ms timeout; isolated retry 1,953 ms**. Link [round 2's evidence](item-counting-t15p4-wiring-step4-r2.md) in the next coder log. Contention is unconfirmed; later passing runs do not erase either failure. No timeout increase is authorized. |

The resolved round-2 Must-fix 3 tests and scope-review renewal-phase repair remain accepted obligations, not reasons to remove their tests. Steps 5–7 and 4e remain separate: worker-driven atomic/crash proof, staging discovery/upload/claim admission, publication cleanup, PG-LONG/PG-CUT, production-framed 119/121 reload limits, 50,000/50,001, 999 self plus site/1,000 refusal, independent five-family/old-self oracle, cut/lookahead/Unicode cases and real CPU/peak-memory/transport measurements. CPU measurements still matter to 4e even though they no longer decide capacity. Measure the redesigned implementation; do not carry over the removed meter's overhead or claim a speedup without evidence.

## 8. Hardening, release and rollback

| HARDENING section | Binding answer |
| --- | --- |
| 1. Failure modes | Bounded transient retries and fenced replay remain; no-progress is a recoverable observed failed run with evidence retained. Slow startup/late turns remain pending. Unknown/ambiguous commits are not declared absent. No automatic abandonment or deletion. |
| 2. Data correctness | Counting, credit, history, canonical hashes, UTC/site-time and inventory/ledger behavior are unchanged. Freshness is scheduling metadata, not a new business fact. Existing parity/oracles remain required. |
| 3. Security | No endpoint/auth, role, RLS/grant or secret-boundary changes. No new table. Diagnostics use safe fields; raw owner-bearing admission records are test-only. No production credentials or data are needed. |
| 4. Release/rollback | No schema change for this decision. Existing migrations immutable; 0046 remains unapplied draft-only. CJ owns later release. Preserve processor-disable/legacy-read fallback and prior-code compatibility with evidence retained; no destructive rollback. |
| 5. Performance | Budgets, heartbeat, request/source/reload/audience limits stay fixed. Remove CPU-accounting work; serialize only the qualifying first-owner attempt as specified. Later performance targets remain binding, including any effect on batching. Cooperative reserve limitations are explicit. |
| 6. Operations | Capacity identifies a call-policy refusal; no-progress identifies a guarded fresh attempt that failed to advance. Neither silently publishes incomplete data. Existing failure visibility and resumable batch recovery remain the fallback; no new alerting/UI project is included. |
| 7. Tests | The integrated evidence in section 6 and the existing correctness/recovery gates are required. This scope document is not a substitute for them. |

Repository/Dexie changes are n/a: this is the existing server worker path, with no repository interface change. No new root path or dependency is introduced. Later separately authorized staging must cover the exact reviewed schema, service access and anon/owner/manager/staff/kiosk/cs denials, independent-session takeover and retained-read/old-code compatibility, real transport/CPU/memory behavior, processor-disable and rollback. That is a future acceptance plan, **not permission to run it now**.

All boundaries remain: offline only; no hosted environment or connection, push, merge, deploy or SQL application. This scope decision authorizes no migration edits or SQL execution. Existing isolated synthetic regression fixtures remain under their prior offline authority. This planner wrote only this file, ran no tests/build/SQL, and made no commit or state-changing git command. The completion status means the requested scope decision is complete; implementation and its one review remain outstanding.

STATUS: COMPLETE
