# Review: item-counting — T15P-4d wiring step 4

- Slug: `item-counting` · Branch: `feature/item-counting` · Reviewed commit: `b35e98987754ee2272a911e30dd625a433f2f749`
- Reviewer: planner (GPT-6 Astra) · Date: 2026-11-19
- Verdict: **changes required**. The live phase/remaining-time accessors and standard fresh-budget comparison are correct, but the derived costs, no-progress classification and worker-level renewal proof do not satisfy step 4.

Line references are to the reviewed commit, which was also checkout HEAD. Inspected `git show b35e989` and the surrounding worker, reader, materializer, journal adapter and test fake. The commit changes only the worker, API tests and plan log. This is an intermediate wiring review, not full feature or release acceptance.

## Checked against

- [ ] Full feature spec acceptance: not claimed at this intermediate checkpoint.
- [x] Wiring preflight TDD step 4 and its self-review correction (`docs/plans/item-counting.md:6531`, `:6538`), binding cumulative-admission condition (`:5792`), and step-4 coder log (`:6672`). Findings below prevent completion.
- [x] Scope-review Must-fix 2 (`docs/reviews/item-counting-t15p4-scope.md`) and the findings, limits and coder response in `docs/reviews/item-counting-t15p4-wiring-step3.md`.
- [x] AGENTS.md guardrails, `docs/ARCHITECTURE.md`, and every section of `docs/HARDENING.md`.
- [x] Roadmap F1 decisions: no change to shared counting, historical recomputation, set multiplication or exclusions.
- [ ] Complete type-check/test/build/CI gate: the focused API suite passed independently; the coder's wider gate is reported evidence only.

## Must-fix

1. **The proposed three-call commit bound is false for a valid escaped source response.** `api/_lib/production-reporting-worker.ts:669` documents the bound and `:674` sets `READ_UNIT_RPCS = 1 + 3`; `:411` uses it for every read admission. A source response fitting 1 MiB does not imply that its journal entries fit two request bodies. Event text is JSON-escaped again inside piece strings, metadata is added, and the greedy packer cannot split an entry merely to fill the remaining request space (`api/_lib/reporting-worker-state.ts:297`, `:317`, `:438`).

   **Reproduced offline through the real reader and writer:** one member response containing a normal evidence row with `line_sku = '"'.repeat(520000)` is **1,040,321 bytes**, below 1,048,576, and is accepted by `rpcFrozenReader.pages.membersPage`. Its reduced event produces **11 pieces**. `writeOwnerPage` sends **`pieces, pieces, pieces, page`**: four checkpoint RPCs, hence **five** RPCs including the source read, while admission prices four. The probe used the real serializer/packer and a recording RPC stub; it did not assert SQL behavior. This is a byte-accounting counterexample, not a representative performance fixture or a proposal to permit a new event format.

   Replace the bound with a proved envelope covering escaping, metadata, packing fragmentation and step/request overhead, or derive the exact legal commit path once the page is available while preserving atomic cursor progress and bounded recovery. A conservative pre-read allowance is a reasonable technique only when proved; the present design choice is **not approved**. Also distinguish a safe upper bound for scheduling from the smallest legal path used to diagnose capacity: an overestimate alone must not reject an owner that can make progress.

   **Required evidence:** reader-accepted near-limit escaped and multibyte payloads passed through the actual `eventEntries`/`writeOwnerPage` path, with every request's bytes and actual calls checked independently of `READ_UNIT_RPCS`. Drive a multi-call page through the worker near its deadline and verify complete-unit admission, reserve, no unfinished-page upload/discard loop, and resumed cursor progress. Keep source/request limits and migration bytes unchanged.

2. **Separate CPU from RPC/renewal/retry time and charge preparation exactly once.** At `api/_lib/production-reporting-worker.ts:392`, the default `cpuNow` is `performance.now()`, an elapsed-time clock. The recovery measurement spans `await recoverOwnerJournal` (`:429–434`), so it includes lookup/open/discard/load network waits that `prereq.rpcs` also prices. The unit measurement spans successive admissions (`:407–410`), including source/checkpoint waits, the next guard's renewal, and potentially retry backoff and other concurrent work. This is not a CPU measurement. Descriptor preparation at `:450–456` is added to prerequisites, but it also lies inside the last read-to-first-hash interval and is charged again in `unitCpuMs`. The maximum earlier unit span then carries those costs into later, possibly much smaller, units.

   A deterministic elapsed-clock probe with only 1,000-ms source/RPC ticks produced `prerequisites.cpuMs = 4000` for the four recovery RPCs and `unit.cpuMs = 2000` for a source/checkpoint pair, in addition to their RPC allowances. That proves the double charging without a wall-clock benchmark. Conversely, the first unit starts with CPU zero, and light-route parsing/preparation and reading-snapshot reconstruction are not measured as separate fresh prerequisites. The all-zero clock at `tests/api/reporting-worker.test.ts:1044` cannot detect these errors; the 250,000-ms counter at `:1082` only exercises a supplied number.

   Instrument the relevant synchronous parsing/reassembly/digest/sort, reduction, projection/hash and serialization segments, excluding awaited I/O/backoff, or use a justified separately measured estimate with explicit component ownership. Keep actual wall-time guards independently. Account for preparation once, and provide an explicit first-unit estimate rather than treating lack of prior observations as proof of zero cost. Do not repair this by widening the budget or removing legitimate CPU costs.

   **Required tests:** independent I/O and CPU clocks; network-only delay must not become CPU, descriptor CPU must be charged once, retry/renewal time must not contaminate a future unit's CPU, and nonzero first-unit/reconstruction/serialization CPU must affect admission. Include a near-ceiling successful path and a genuine capacity refusal, with safe diagnostics and retained evidence.

3. **Recompute the fresh prerequisite path for the current durable position.** `api/_lib/production-reporting-worker.ts:433` fills `prereq.rpcs` only during initial recovery. The commit wrapper at `:441` advances the journal but never updates that estimate. Thus every later read/hash admission still prices the original empty or smaller journal, including an open/discard that has already been completed, rather than the reload and preparation a fresh invocation would perform at the current position. `tests/api/reporting-worker.test.ts:1051–1056` actually requires the initial reload count of two to remain constant across all admissions.

   **Reproduced with the existing synthetic pagination:** a fresh 1,200-event owner has ten prerequisite RPCs at its first read (five fixed, one light attempt, lookup, open, header plus EOF). At its hash admission, the worker still reports ten, although the committed journal now requires **five reload calls**. A fresh continuation of that same position needs twelve RPCs under this fixture (five fixed, one light attempt, lookup and five reloads), with no second open. The synthetic packer is sufficient to expose staleness; it is not production 119/121 evidence. Reconstruction CPU is stale for the same reason.

   Derive the path from the current persisted phase/prefix and actual restart route, using the checkpoint/header accounting and justified CPU estimates. Keep paid prerequisites excluded from the current invocation's remaining cost, while including the correct reconstruction in the fresh-fit test. A scalar five-call baseline is acceptable for the ordinary frozen, enumerated resume route; it is not a substitute for the other phase-dependent legs. The present planning route receives old staff in `listWorkerOwners` (`api/_lib/reporting-worker-state.ts:117–127`), so do not invent extra old-staff RPCs here. Charge them when a path actually uses the paginated old-staff reader.

   **Required tests:** new, resumed-reading, pending-discard and partially hashed journals; grow the committed prefix across a reload-page boundary and inspect the next admission; then resume in a fresh invocation and compare the predicted prerequisite components with its actual trace. Include the resumed owner first and assert durable seq/cursor/hash progress. Retain the production-framing boundary work required by 4e rather than treating this fake as its replacement.

4. **Do not equate one idle invocation's lack of time with permanent capacity, and cover the deadline-expired path.** `api/_lib/production-reporting-worker.ts:419` changes a helper verdict of `pending` into `owner_input_capacity` solely because `committed === 0 && !workDone(counts)`. That says nothing about whether a fresh uninterrupted 240,000-ms invocation can progress. It contradicts the explicit transient/pending distinction at `docs/plans/item-counting.md:5797`. The new eight-second test (`tests/api/reporting-worker.test.ts:1093–1108`) codifies the contradiction: it acknowledges that a standard fresh run fits, then expects capacity because this invocation was shorter.

   **Reproduced with a standard 240,000-ms invocation:** after copy/enumeration had already completed, inject three transient version responses with 7,400 ms of deterministic latency each, retain the ordinary `[30000, 60000, 120000]` backoff, and then succeed. The first durable admission has **5,100 ms left**, returns `pending`, and prices fresh progress at **15,000 ms**. The worker nevertheless returns `failed / owner_input_capacity`, with the problem string saying “15000 ms of 240000 ms”. The next uninterrupted invocation publishes the same fixture. This is a false capacity diagnosis caused by transient delay, not an intrinsically unprocessable owner.

   The opposite failure is also possible: `admit` first calls `routing.guard()` at `:407`. If recovery/preparation has already exhausted the deadline, `b.need()` throws before either capacity or the idle rule runs. A probe charging 250,000 ms of deterministic elapsed recovery/preparation time through both clocks returned **three consecutive `pending` results with journal seq `5` unchanged**. The committed capacity test advances only `cpuNow`, not `env.now`, so it misses this bypass.

   Preserve pending/deferred for a fitting fresh path after transient delay, other work or a shortened invocation. Diagnose capacity from the correctly costed fresh path, and arrange recovery/preparation admission or post-measurement classification so an intrinsically over-budget prerequisite cannot evade that decision through an earlier generic timeout. Prove progress or capacity in a **fresh uninterrupted standard invocation**; do not infer it from global counters or solve it with larger limits. Update the idle test and coder log to match that contract.

   **Required tests:** transient delay then normal fresh recovery, a short-deadline pending control, and a genuine over-budget recovery/preparation case where CPU and wall time advance together. The latter must not repeat pending at the same durable position; the transient case must never acquire a capacity/heavy diagnosis.

5. **Complete the worker-level 29,500-ms renewal/deadline proof and execute the renewal inside the admitted unit.** `tests/api/reporting-worker.test.ts:1066–1074` invokes only the pure exported `admissionAt` helper with a hand-built path. It does not run `runReportingCycle`, start a source/header RPC, renew a lease, commit, inspect pending pieces or preserve a reserve. The worker does not call `admissionAt`; it calls `admitDurableUnit` directly at `api/_lib/production-reporting-worker.ts:415`. The nearby derived-path test proves phase forwarding on an ample-budget fixture, not the required boundary behavior.

   There is a concrete missing renewal behind that coverage gap. `routing.guard()` at `:407` correctly does nothing at 29,500 ms. The subsequent journal commit (`:441`, `api/_lib/reporting-worker-state.ts:438–444`) and hash header/checkpoint pair (`worker.ts:459`, `reporting-worker-state.ts:665–669`) have no intervening budget/heartbeat hook. **Worker probe:** admission at phase 29,500 ms, with each RPC costing 1,000 ms, produced `load_reporting_owner_input_header` at 30,500, `checkpoint_reporting_owner_input` at 31,500, and only then `renew_reporting_lease` at 32,500 during subsequent planning. Admission budgets a renewal, but this execution does not perform it before the checkpoint as required by scope-review Must-fix 2. This is a cadence/contract defect; the probe does not claim that the longer database lease expired.

   Thread the existing heartbeat/deadline policy through the actual multi-RPC durable unit, retaining its atomic checkpoint/replay behavior and the post-renewal deadline check. Handle retries consistently with the existing bounded Deferred behavior. Keep the phase-aware arithmetic and the standard fresh budget.

   **Required worker tests:** at 29,500 ms, insufficient remaining time parks before starting the unit with no pending pieces or cursor advance; sufficient time performs the due renewal at the intended RPC boundary, commits and preserves 2,000 ms. Exercise the actual read/checkpoint path and hash path; if a proved conservative pre-read bound changes the read threshold, record that distinction rather than claiming a two-RPC helper proves it. Assert ordered calls, saved progress, the next invocation's recovery and an actual deadline-crossing renewal. Retain the existing pure fixed-point test for a renewal whose own cost crosses another boundary. A mutation at the worker's phase argument or renewal hook must fail these worker assertions, independently of helper tests.

## Should-fix

1. **Make admission observations distinguish the estimate verdict from the worker's final action.** `api/_lib/production-reporting-worker.ts:416` emits `onAdmission` before the idle override at `:419`. Consequently the current observation says `pending` while the worker fails capacity; the test at `tests/api/reporting-worker.test.ts:1105–1106` explicitly demonstrates this. After repairing Must-fix 4, keep one authoritative decision or label estimate and final disposition separately, with a safe reason. This is useful for the later cost/progress traces; it must not expose owner keys in production diagnostics or let observation callbacks alter scheduling.

## Assessment of the requested design choices

- **Derived `AdmissionPath`: partially wired, not accepted.** Five fixed calls match the ordinary resumed planning route; light attempts and initial lookup/open/discard/reload calls are represented, and `prerequisitesPaid: true` correctly avoids recharging them to the current remaining budget. The reload snapshot becomes stale, costs are not CPU-separated, and the next unit's actual commit envelope is not bounded as claimed. See Must-fix 1–3.
- **`READ_UNIT_RPCS = 1 + 3`: rejected.** The actual serializer/writer counterexample requires `1 + 4`; that counterexample is not a proof that five is a universal replacement bound.
- **Fresh fit against `WORKER_BUDGET_MS`: approved in principle and correct at `worker.ts:415`.** The plan explicitly defines a fresh standard invocation as 240,000 ms. `b.remainingMs()` correctly uses this invocation's actual deadline for the current-fit test. Do not replace the fresh budget with a shortened test deadline. The idle override currently undermines this otherwise correct separation.
- **Idle no-progress rule: rejected as implemented.** It both misclassifies a fitting transient-delayed path and misses an already-exhausted preparation path. Global absence of commits is not proof of capacity.
- **29,500-ms evidence: helper-only for the advertised 4,000/5,000-ms boundary.** The independent worker probe finds the missing between-RPC renewal. Scope-review Must-fix 2 and preflight step 4 remain open.
- **Existing protections retained:** capacity exceptions contain owner kind/times rather than raw partition keys; evidence is retained and publication is blocked in the exercised capacity case. Version-first/missing-protocol controls and ordinary parity/recovery regressions remain in the passing API suite. No counting, canonical hash or output semantics should change to repair admission.

## Verification and limits

All work was offline, using installed local dependencies. No hosted service, database, external lookup or credential was used. Only this review file was written; no app/test/plan/migration edit, commit, push or state-changing git command was issued.

- **Unmodified focused suite:** `tests/api/reporting-worker.test.ts`, **60/60 passed**, exit 0; 28.74 seconds in tests. File-free stdin Node invocation of `startVitest`, with `config: false`, `watch: false`, `cache: false`, one worker and Vite `configFile: false`. This verifies the selected tests, not the project's Vite configuration.
- **Review-only probes:** appended only in memory by a Vite load plugin, filtered to probe names. Confirmed the escaped-response packing/writer counterexample, absent between-RPC hash renewal, I/O charged as CPU, stale reload prerequisites, transient-to-capacity misclassification followed by successful uninterrupted recovery, and repeated unchanged-seq pending when elapsed preparation exhausts the deadline. These deliberately assert the observed defects; passing probes are not implementation acceptance tests.
- **Probe setup corrections:** the first heartbeat probe selected `phase='hashing'`, but this fake enters hashing on its first hash checkpoint, so it never moved the clock before admission; corrected to the saved `done` state. An initial 6,500-ms transient latency allowed one unit to commit and correctly returned pending; 7,400 ms isolated the no-prior-progress case. A first recording-writer invocation incorrectly supplied a UUID handle and was rejected before writing; corrected to decimal handle `1`. These were in-memory probe setup errors, not failures of the unmodified 60-test suite.
- No independent full-suite, type-check, build or CI run. The plan's **80 files / 2416 tests, tsc, typecheck:digest and build** result at `docs/plans/item-counting.md:6697` remains coder-reported. API code is outside the ordinary `tsc -b` scope; retain `typecheck:digest` in the coder's repair gate.

## Hardening, release and next gate

| HARDENING section | Disposition for this review |
| --- | --- |
| Failure modes | Must-fix items address slow/transient RPCs, wrong failure classification, renewal timing and resumable durable progress. Preserve fencing, ordered writes and lost-response replay; do not weaken existing recovery assertions. |
| Data correctness | Shared counting/attribution/history/UTC rules and inventory/ledger code are unchanged. API reference parity passes; that does not replace the independent five-family, old-self and boundary evidence retained for 4e. |
| Security | No endpoint, authentication, selector, RLS/grant or secret-boundary change. New capacity diagnostics are key-free in the exercised test. No hosted security claims. |
| Release and rollback | No release clearance. No migration changed; 0046 remains an offline draft and existing migrations remain immutable. CJ owns SQL application, merge and deployment. Retain processor-disable/legacy-read and compatible-prior-code rollback with additive schema/evidence preserved. |
| Performance | The commit-call envelope, fresh prerequisite cost and CPU accounting are blockers. Preserve 240,000 ms, 30-second cadence, 2,000-ms reserve and existing limits. Production-framing, representative CPU and sampled-memory evidence remains outstanding. |
| Operations | Keep evidence, block incomplete publication and distinguish pending/deferred from intrinsic heavy/capacity failures. A false capacity diagnostic or endless unchanged pending must not be treated as healthy progress. |
| Tests | Add the worker-level cases above within the already authorized scope, preserve existing oracles, then run focused regressions and the common offline gate. Record exact failed evidence and any newly required file dependency before expanding scope. |

No Repository interface change requires a Dexie counterpart, no dependencies were added, and no new root whitelist entry is involved. Later separately authorized staging must still check the exact reviewed schema, service access and anon/owner/manager/staff/kiosk/cs denials, independent-session takeover/cleanup, old-code and retained-read compatibility, transport/CPU/memory and rollback. Nothing here authorizes hosted execution.

Do not mark wiring step 4 complete or use its current cost proof to close subsequent acceptance gates. Repair the findings, update the step-4 log to distinguish helper from worker evidence, and return the bounded implementation for review. Steps 5–8 and the previous review's remaining obligations are not waived.

## Nitpicks

None.

## Coder response

(Coder records repairs and verification in the active plan under the existing workflow.)

STATUS: COMPLETE

### Coder response (Claude, 2026-11-19)

All five Must-fix items and the Should-fix item were fixed. Details, tests and mutation results are in the plan log entry "Astra wiring-step-4 review fixes".

- **Must-fix 1, exact commit:** `READ_UNIT_RPCS` is gone. Reads are admitted at `READ_LEG_RPCS` = 2, and each commit is admitted with its exact `ownerPageCalls` before its first call. This answers the counterexample: a 5-RPC unit is now priced exactly, because the commit is sized after the page is known.
- **Must-fix 2, CPU:** the default clock is process CPU; each segment is measured once; descriptor CPU is charged once (exact counter-clock test); the first-unit estimate is 1,000 ms. **Limit:** process CPU includes the concurrent light owners of the same group (conservative). This is recorded for 4e.
- **Must-fix 3, live prerequisites:**
  - The reload cost follows every checkpoint and hash result, with no repeated open or discard.
  - The prediction matches the next invocation's actual recovery reload.
  - **Not separately exercised here:** pending-discard and partially-hashed journals. The fake models no heavy or pending recovery beyond discard, and partial hashing needs more than 100 audiences. The same formula covers them (the discard leg is never repeated; reload follows `reloadCalls`). This is left for 4e real-SQL evidence.
- **Must-fix 4, no idle rule:** a transient-delayed standard run parks (never capacity), and so does a shortened run. A real over-budget recovery (CPU and wall time together) fails `owner_input_capacity` once, instead of hitting the deadline check first.
- **Must-fix 5, renewal inside the unit:**
  - Every journal and hash RPC runs the guard first.
  - The worker-level 29,500 ms read leg parks with 5,000 ms left. With 6,000 ms it renews before the checkpoint, keeps the reserve, and the next invocation publishes.
  - A multi-call commit at 29,500 ms runs `checkpoint, renew, checkpoint`.
  - **Not separately exercised:** the hash path at the boundary. It uses the same guarded client.
- **Should-fix 1:** `action` is the single authoritative decision.
- **Gate:** 80 files, 2421/2421; tsc, digest and build exit 0. One earlier full run timed out an unchanged first test under load (1.8–1.9 s alone); this is recorded.
