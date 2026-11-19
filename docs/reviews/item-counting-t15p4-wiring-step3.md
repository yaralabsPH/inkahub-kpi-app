# Review: item-counting — T15P-4d wiring step 3

- Slug: `item-counting` · Branch: `feature/item-counting`
- Reviewed change: stash `9747340189fd710a5a92b90709deeea7cdc8a93f` (`stash@{0}`), based on `93230c567100cb84d9e3ffa09d15e065251db704`; checkout HEAD `d72357362aa0755ca393c93fc076403f7a939190`.
- Reviewer: planner (GPT-6 Astra) · Date: 2026-11-19
- Verdict: **changes required**. The narrowly proposed harness dependency is approved; the planning implementation and its evidence need the repairs below before wiring step 3 is accepted.

Line references to the three stashed files refer to their **stash versions**, not the unwired checkout. Other references refer to HEAD. The stash contains only the materializer, worker and API-test changes (363 insertions, 12 deletions). A read-only diff from its base to HEAD found no intervening changes in those three files.

## Checked against

- [ ] Full feature spec acceptance: not claimed at this intermediate wiring checkpoint.
- [x] Plan's wiring preflight step 3 (`docs/plans/item-counting.md:6524`), new dependency question (`:938`), and binding memory/progression conditions (`:5792`, `:5801`). Findings below prevent step completion.
- [x] `docs/reviews/item-counting-t15p4-scope.md`, particularly sections 1, 3 and 4; `docs/reviews/item-counting-t15p4-wiring-scope.md`.
- [x] AGENTS.md guardrails, ARCHITECTURE.md, and every section of HARDENING.md.
- [x] Roadmap F1 decisions: shared counting, historical recomputation and exclusions remain unchanged.
- [ ] Complete test/type-check/build gate: focused results are recorded below; no full-suite, type-check, build or CI success is claimed.

## Scope decision

**YES — authorize exactly the proposed one-line change in `tests/reporting/reportingPageGuard.test.ts:277`:**

```diff
-        if (fn !== "renew_reporting_lease") prev = fn;
+        if (FROZEN.test(fn)) prev = fn;
```

This supplements the previous narrow scope decisions. No further CJ confirmation is needed for this dependency. It does not authorize assertion changes, a new selector regex, changes to shared harnesses, fixtures, clocks, budgets, leases, retries, pacing or migrations.

The cause is verified. The scenario at `:259` targets a renewal while materializing whose last relevant read was `read_reporting_children` (`:275–278`). Previously every non-renewal RPC overwrote `prev`. Durable reading adds `checkpoint_reporting_owner_input` between the child page and the next guarded source read, so that write overwrites the selector. The callback that pushes time past the deadline is never reached; this is not evidence that a frozen read started after a deadline-crossing renewal.

`FROZEN` at `:231` excludes the owner-input checkpoint. Keeping the last frozen read also preserves it across a transient renewal attempt. Leave the assertions at `:299–303`, `:309–311`, `:318–320` and the before-deadline positive control at `:325–327` intact. Independent file-free runs reproduced the two original failures and passed all 19 tests with only this selector replacement; details below.

## Must-fix

1. **Use the planned per-audience path and retain only planning descriptors, not every audience's result rows.** `api/_lib/production-reporting-worker.ts:386` calls `ownerWorksFromInput` eagerly; `:389` extracts hashes only after all works exist, and `:396` returns the entire `MaterializedWork[]` into the group's `Promise.allSettled` at `:374`. The ordered consumer at `:320` needs only descriptors. In `api/_lib/production-reporting-materialize.ts:999`, the helper maps every audience through `audienceWork`; `:1011–1016` performs projection and canonical hashing and returns the audience's result rows. Consequently every audience is computed before the first hash-loop guard/checkpoint, and a completed heavy owner's rows remain in the settled results while the next durable owner runs. The journal mutex does not bound those retained results.

   This contradicts step 3's explicit `ownerAudiences`/`audienceWork` per-audience instruction (`docs/plans/item-counting.md:6530`) and the one-projection memory condition (`:5688`, `:5801`). A batch of tiny fixtures passing parity does not establish the required bound for large owners or many audiences. Repair the routed planning path to compute/release one audience's rows at a time and return only the descriptors/hash metadata needed for ordered planning. Keep saved hash progress usable by the next checkpoint; do not merely split checkpoint payloads after eagerly computing every audience. Add focused evidence that planning does not retain result rows across audiences/owners and preserves descriptor/hash parity. Actual cumulative cost/admission and phase-offset tests remain wiring step 4; that later step does not waive this step's per-audience structure.

2. **Add the worker-level “retry keeps the count” API test now, including the attempt-trigger boundary.** The code placement is correct by inspection: `activationWatch` at `api/_lib/production-reporting-worker.ts:375` is outside `b.retry` at `:379`, and the same watch is passed at `:385`. However, the five new tests at `tests/api/reporting-worker.test.ts:831–916` never inject a transient during a light owner's source reads. The heavy fixtures cross the **row** trigger (`:816–822`), not the planned 16-attempt trigger. The deferred `plan_reporting_owner` case at `:880` occurs after reading/hashing and cannot prove light retry accounting.

   The helper test at `tests/reporting/reportingOwnerContinuation.test.ts:811–839` explicitly passes the same watch itself; it cannot catch the worker accidentally constructing a new one inside its retry callback. Do not defer or substitute it for `docs/plans/item-counting.md:6527–6529`. In the authorized API test file, drive `runReportingCycle` with an owner below the row/byte thresholds, inject a transient after a known number of charged source attempts, and assert the unchanged backoff, failed-attempt inclusion, only the remaining allowance on retry, activation before light attempt 17, exactly one plan journal, and unchanged descriptors/publication. Count shared-flush attempts where applicable and separate the subsequent durable reads from light attempts. A mutation that recreates/omits the supplied watch inside the retry must fail promptly on an assertion. The no-transient 16-attempt control can share that fixture.

3. **Make the new fake reject immutable-journal writes and roll back rejected checkpoints.** In `tests/api/reporting-worker.test.ts:422–423`, replay and seq are checked, but there is no general complete-phase rejection. The `discard_pending` branch at `:454–457` therefore accepts a new write to a complete journal and increments its seq. SQL explicitly allows an identical final replay first, then rejects every new complete-journal write (`supabase/migrations/0046_reporting_owner_inputs.sql:804–817`). In the fake's page branch, pieces are added/committed at `:439–447` before the empty-step rejection at `:449`; an error returned by `rpc` at `:117–118` does not undo those changes. SQL validates the step array before insertion (`0046:825–836`), and a failed statement rolls its changes back.

   Both discrepancies were reproduced with in-memory probes of the stashed fake: a non-replay `discard_pending` advanced a complete journal from seq 0 to 1; a rejected page with no steps left a committed event while seq stayed 0. These weaken the fake's promised immutable, replay-safe recovery contract. Add the phase gate after replay recognition, and validate/commit atomically (or restore state on rejection). Retain identical final-checkpoint replay. Add small fake contract tests for these cases. This repair is confined to the already-authorized API test file; no change to 0046 or duplication of its entire validator is requested.

## Should-fix

1. **Label and constrain the fake's remaining protocol approximations before using it for cost, heavy-policy or stage acceptance.** `tests/api/reporting-worker.test.ts:66–67`, `:191–199` and `:415–417` use fixed 500-piece pages and matching synthetic reload counts. Real 0046 packs at most 1,000 rows **and** 1,048,576 accounted bytes (`0046:123–135`, `:768`); 500 pieces can overcount small pages and undercount large escaped pieces. `heavy_proven`/`heavy` are always false in the fake (`:173`, `:182`, `:191`, `:472`). Its gates check batch/fence/lease (`:101–106`, `:402–405`) without the SQL frozen/sealed/purpose rules, and its hash branch merely appends entries (`:458–465`) instead of enforcing the required site/member/old-self audience set and next 1–100 ordered hashes (`0046:859–885`). JSON-string payload equality is also narrower than SQL's jsonb-normalized replay identity.

   The fixed page size is acceptable as explicitly synthetic pagination stress for **once-only reload**, not proof of production reload accounting or 119/121 capacity. Before the later wiring tests rely on those contracts, model the exercised gates/ordered hashes and use the real packer or real-SQL evidence for byte/heavy boundaries. Keep unknown RPCs failing. Missing old-staff, chunk-discovery, release and purpose-upgrade behavior can be added when their authorized steps actually use it, as allowed by the scope review; do not claim the fake already implements the entire preflight step-1 list.

2. **Keep the scenario failure open until its exact cause is known.** `tests/reporting/reportingWorkerScenario.test.ts:82–90` runs preflight and the rebuild scenario before testing cleanup, so a failure named after cleanup need not originate in cleanup. The cleanup implementation catches each failed step and proceeds (`tests/staging/reportingWorkerScenario.ts:377–389`); the scenario also uses wall time through `tests/reporting/pg/runtimeCtx.ts:47`. The supplied observation gives neither the failing assertion nor its trace. Similar standalone durations do not establish load sensitivity or exclude an ordering regression.

   This reviewer ran the unchanged eight-test scenario file against the stashed implementation, with one Vitest worker: **8/8 passed**. That is useful regression evidence, not a reproduced load experiment or a waiver of a failed common gate. Retain the original failure, exact assertion/phase and worker calls; investigate that evidence before declaring the checkpoint gate clean. Do not raise timeouts, invocation limits or pacing, weaken cleanup/parity assertions, or edit another scenario/harness file without a demonstrated dependency and planner decision.

3. **Carry `buildChunks` CPU cost into 4e with representative output; do not optimize it in this wiring patch.** `api/_lib/reporting-stage.ts:258–267` copies the current table array and canonicalizes/serializes the growing chunk on each row, often twice. The quadratic work is **within a chunk**; with the default 1,000-row/byte cap it is not unbounded quadratic growth across the entire batch. The code supports the concern, but the reported approximately 21 seconds for 1,200 detail rows remains coder-reported, not an independently repeated measurement. The file is unchanged and expressly outside this authorization (`docs/plans/item-counting.md:5821`).

   Cheap fixtures may isolate routing, but they cannot close CPU/peak-memory or useful-progress acceptance. Also, the new cheap fixture at `tests/api/reporting-worker.test.ts:820–822` gives `clock_in` rows a non-null order, which the checked-in source constraint forbids (`supabase/migrations/0030_clock_events_no_order.sql:22–29`; replicated in the PG bootstrap). Prefer valid cheap order-member events, such as `started` rows, while preserving the activation and parity assertions; retain actual detail-rich events for 4e. Measure projection, canonicalization, chunk building, retries and sampled memory under the original limits. If a target is missed, bring back measurements and a proposed scoped optimization; do not change canonical bytes/hashes or acceptance targets to hide it.

## Assessment of the requested invariants

- **One watch per owner:** implemented correctly at the worker call site; the required integration regression is missing (Must-fix 2).
- **Never two active durable owners:** the promise chain at worker `:368–372` grants one turn, retained across read retries and hashing and released in `finally` at `:398`. Ordered `planOwner` calls remain at `:316–320`. The two-owner test at API-test `:865–875` confirms noninterleaved handle-bearing journal calls on its fixture. This supports serialization of active durable work; it does not prove the memory bound or eliminate the retained results in Must-fix 1. Deadline/capacity admission and recovery priority remain later gates.
- **Light owners make zero journal RPCs:** recovery is called only in the activation callback, and the new light-batch test asserts both zero journal calls and zero journals, plus exact reference publication (`:831–837`). The mandatory version probe is correctly excluded from “journal RPCs.” Production RPC readers receive routing; injected readers without one-call pages deliberately retain the legacy path (worker `:504–509`).
- **Recovered input is reused:** worker `:383` returns `rec.input`; materializer `:1511` selects it instead of `durableOwnerInput`. The completed-journal test asserts no checkpoints and exactly one synthetic event traversal including EOF (`:878–896`); the fresh-journal case asserts one empty traversal (`:855–856`). This is valid evidence against a second reload **after recovery**. It does not mean the entire invocation performs no source reads: activation begins on the light route, and staging is still the legacy route until wiring step 6. Partial-hash recovery and per-unit admission remain required later evidence.
- **0046 faithfulness:** pinned seq, ordered event loads, EOF, fence/lease checks, last-checkpoint replay, pending-versus-committed storage and read/hash phases are represented. The fake is useful for successful control flow, not a substitute for SQL enforcement; the concrete transactional/immutability defects and other limits are enumerated above.
- **Prior review obligations:** the version-first/no-record behavior and its code-only transient handling remain intact and the 52-test API run includes those controls. Actual heartbeat-phase/cumulative admission, integrated heavy/capacity/purpose failure diagnostics, atomic combined-page worker proof, staging/chunk reuse, post-publication release and 4e's independent five-family oracle are not completed by this stash. They remain at the preflight's later checkpoints, not waived and not silently pulled into this bounded repair.

## Verification and limits

All commands were offline and used installed local dependencies. The stash was read with `git stash show -p`/`git show`; it was never applied, popped or checked out. File-free stdin Node invocations used `startVitest` with `config: false`, `watch: false`, `cache: false`, one worker, Vite `configFile: false`, and an in-memory `load` plugin serving the exact stashed source. The proposed selector was likewise replaced only in memory. This exercises the selected tests, not the project's Vite configuration.

| Check | Independent result |
| --- | --- |
| Stashed API test file and implementation | **52/52 passed**, exit 0; 28.65 seconds in tests. |
| Stashed implementation + unchanged page-guard file | **17/19 passed**, exit 1. Failures at `:299` (`target` false) and `:318` (`renewedAt` null), reproducing the reported dependency. |
| Same stashed implementation + only the proposed selector replacement | **19/19 passed**; 13.87 seconds in tests. |
| Unchanged scenario file against stashed implementation, in the same serial run | **8/8 passed**; 68.43 seconds in tests. Combined selector/scenario run: 27/27, exit 0. |
| Two review-only in-memory fake-contract probes | **2/2 confirmed the incorrect fake behavior** described in Must-fix 3; exit 0. These are diagnostic reproductions, not passing SQL-conformance tests. |

No type-check, build, full suite, CI, hosted service or production database was run/contacted. The coder's four mutation results and prior common-gate results remain reported evidence. No timing figure above is a hosted performance claim. Only this review file was written; no commit, push or state-changing git command was issued.

## Hardening, release and next gate

| HARDENING section | Disposition for this checkpoint |
| --- | --- |
| Failure modes | Retry-count proof and faithful fake failure semantics need repair. Active durable serialization and once-only recovery are supported; full admission/failure-kind integration remains pending. |
| Data correctness | No reducer, attribution, historical event, UTC/site-time, stock or ledger rule changed. Reference parity passed on the API fixtures; independent five-family/old-self/fan-out acceptance remains required. |
| Security | No endpoint, selector/authentication, client/server secret boundary, grants or RLS changes in the stash. Local 0046 is the protocol authority; no hosted security claim. |
| Release/rollback | No release clearance. Keep 0046 draft-only and existing migrations byte-identical. CJ owns SQL application, merge and deployment. Disable processor/use legacy reads or compatible prior code for rollback, retaining additive schema and evidence. |
| Performance | Eager audience/result retention is a current blocker. Production byte/reload, CPU, chunk-building and sampled-memory targets remain open; no budget/lease/limit increases. |
| Operations | Preserve pending/failed diagnostics and retained journal evidence; finish the later safe heavy/capacity/purpose and isolated-release paths. Legacy reads remain the fallback. |
| Tests | Apply the authorized selector edit, address Must-fix items, preserve existing assertions, and rerun the focused affected regressions followed by the plan's offline common gate. |

No Repository contract or Dexie behavior changes are involved, no dependencies are added, and no new top-level whitelist entry is needed. Later staging still needs clearance for the exact draft and its service/anon/owner/manager/staff/kiosk/cs access checks, independent-session takeover/cleanup, old-code and retained-read compatibility, actual transport/CPU/memory measurements and rollback checks. This review authorizes none of those hosted actions.

The coder may record this decision and perform these in-scope repairs. Do not mark wiring step 3 complete or build past its failed gate until the Must-fix items and required regressions are resolved. Another unexpected file dependency returns to the planner with the exact failure and minimal proposed edit. This is a completed review handoff, not approval of T15P-4d, Task 15 or release.

## Nitpicks

None.

## Coder response

(Coder records fixes and evidence in the active plan under the existing workflow; this review remains the planner's findings.)

STATUS: COMPLETE
