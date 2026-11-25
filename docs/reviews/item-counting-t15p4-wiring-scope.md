# T15P-4d wiring step 2: pacing dependency and version gate review

Date: 2026-11-19. Planner decision; offline only.

## 1. Decision and exact permitted edits

**YES.** The coder may make the following narrowly scoped dependency edits as part of T15P-4d step 3, wiring step 2. This supplements section 1 of [the prior scope review](item-counting-t15p4-scope.md); it does not grant general harness-edit authority. No further confirmation is needed for these edits.

| File | Permitted edit |
| --- | --- |
| `tests/reporting/pg/runtimeCtx.ts:49` | Change only the default `paceCalls: 3` to `paceCalls: 4`. |
| `tests/staging/reportingWorkerHarness.ts:53` | Change only `int("pace-calls", 3, 2, 50)` to `int("pace-calls", 4, 2, 50)`. Keep the accepted range and explicit CLI overrides unchanged. |
| `tests/reporting/reportingWorkerHarness.test.ts` | If an expectation pins the omitted-option default to 3, change only that expected default to 4. **None currently does:** line 145 tests an explicit `--pace-calls=4` override, and lines 148–149/180 test validation. Those assertions need no change. |

No scenario, correctness, parity, recovery, timing or security assertion may be weakened or replaced. The sole permitted expectation adjustment is a literal default-value pin, if present. Leave `tests/staging/reportingWorkerScenario.ts`, the PG migration loader/RPC registration, fixture sizes, deadlines, leases, retry delays, invocation limits and migration files unchanged. Any further file dependency returns through the existing stop-and-record gate.

This is an adjustment to the synthetic interruption point for one newly required prerequisite RPC. It does **not** increase the worker's 240-second budget or any performance acceptance limit. The staging CLI edit prepares the same interruption point; it does not authorize a staging invocation.

## 2. Independently verified cause

Read the top-level open question at `docs/plans/item-counting.md:932–936`, the prior scope review, AGENTS.md, ARCHITECTURE.md, ROADMAP.md and HARDENING.md. Inspected the full `git stash show -p 'stash@{0}'` and the surrounding worker, adapters and harness code.

Reviewed stash: `d0745309bcacd9f1431633be2d7bc05762c5d021`, based on `329c65a5788aac5aa7d4afee8e653896f2aa1274`. HEAD when inspected was `49aff065dce079cd09b38d76fac1a5c157094b44`. A read-only diff from the stash base to HEAD showed no changes in either stashed file. The stash contains exactly the worker and API-test changes (61 insertions, 3 deletions).

`reportingWorkerScenario.ts:162` adds `WORKER_BUDGET_MS + 1` to the injected clock once `client.calls.length >= pace`. `serviceRpcClient` counts each RPC when it starts. The rebuild path is sequential: `acquire` reads status then begins the rebuild; `copyAndFreeze` checks the budget before its first copy and again before another copy/freeze.

| Successful initial rebuild | Calls before interruption | Copy pages completed |
| --- | --- | --- |
| Before version wiring, pace 3 | status → begin rebuild → copy | 1 |
| Stashed version wiring, pace 3 | version → status → begin rebuild | 0 |
| Stashed version wiring, pace 4 | version → status → begin rebuild → copy | 1 |

At pace 3 the stashed worker still returns pending **with a batch**; the specific missing condition is durable copy progress at scenario line 218. Lines 216–218 must remain unchanged: pending, a batch, active state, a saved rebuild cursor and positive candidate rows. Keeping these checks preserves the prerequisite for the busy-lease and takeover/replay cases that follow.

## 3. Review of the stashed wiring against Must-fix 1 and 3

**No new Must-fix defect found in this bounded wiring diff.** It is acceptable together with the permitted pacing edits and the coder's regression verification. This is not closure of the full owner-input integration.

- **Version first:** the added `await b.retry(() => requireOwnerInputProtocol(env.client))` is before `acquire` in the shared refresh/rebuild branch. Status, begin/resume, copy, source creation, journal work and publication cannot precede a successful probe. Cleanup stays on its existing separate path.
- **Transient handling (Must-fix 1):** the existing `ownerInputVersion` adapter preserves the RPC error code; the existing `requireOwnerInputProtocol` rethrows recognized transient errors. The new call uses the worker's bounded retry path. A code-only `40001` therefore retries instead of becoming unsupported; exhaustion becomes `Deferred`, pending with no batch acquisition. The pending run record is permitted: the no-record exception is for unsupported/missing protocol, not transient deferral.
- **Unsupported/no-record behavior (Must-fix 3):** missing/version-2 probes produce `OwnerInputUnsupportedError`; the existing failure-kind mapping returns `owner_input_unsupported`. The added catch branch records duration and returns before `recordRun`. Problems use the safe protocol diagnostic, without raw RPC error text, owner keys or source payloads. Neither path creates a batch or run record.
- **Stashed tests:** the missing/version-2 cases assert a version-only RPC trace, no batch and no runs; the transient-success case checks the 30-second retry and published output against the existing reference; exhaustion checks 30/60/120-second waits, pending and no acquire. The processor-disabled trace correctly gains the prerequisite probe. Excluding the pre-acquisition version call from the lease-span calculation is appropriate, like the existing exclusion of status; it leaves the heartbeat bound and in-lease RPC checks intact.

**Remaining Must-fix 3 obligation:** this diff does not wire durable owner recovery/admission into planning and staging. It cannot close the earlier requirements for exact heavy/capacity/purpose failure kinds, retained journal evidence, zero publication and safe returned/run diagnostics in the actual integrated worker. Those requirements remain mandatory at their already-authorized wiring checkpoint; this decision neither waives them nor asks for unrelated integration in wiring step 2.

The new API refusal cases use an injected memory source whose reads are not represented by `db.calls`. Their version-only RPC assertion alone is not direct proof of zero injected-source calls. The reviewed control flow and independent source-sentinel probes below establish that property here. Adding a direct source-factory spy and covering both refresh/rebuild in the existing API tests would strengthen the retained regression evidence within its existing authorization; no scenario assertion needs changing.

## 4. Verification and next gate

Independent file-free Node probes loaded the **stashed worker source** through the installed TypeScript transpiler, using current unchanged supporting modules, deterministic clocks, strict fake RPC replies and a source sentinel. Both probe commands exited 0. Nothing was checked out, applied or written for these probes.

- Pace 3: pending, batch present, zero copy calls. Pace 4: pending, same synthetic batch, exactly one copy call, then the run record. No source creation or freeze.
- Missing and version 2, each in refresh and rebuild: failed/`owner_input_unsupported`, null batch, exactly one version RPC, zero run records and zero source-factory calls.
- Repeated code-only `40001`: four version attempts, sleeps of 30/60/120 seconds, pending with null failure kind/batch, deferred diagnostic and only a run record afterward.
- One code-only `40001` then version 1: one 30-second sleep, then status/resume in order and the normal busy-lease result. This probe checks recovery into acquisition, not publication parity.
- Cleanup with the version function unavailable: cleanup then run record, done, no version probe.

These are worker/control-flow probes with fake RPCs, **not** a fresh PGlite durability run or execution of the stashed Vitest suite. The plan's reported 45/45 API result and five scenario failures remain coder-reported evidence. No full suite, type-check, build, CI or hosted check was run by this reviewer. Final read-only status also showed a modification to `tests/reporting/reportingOwnerContinuation.test.ts` that was absent from the earlier diff; this reviewer did not make or review that concurrent change. Only this review file was written.

The coder should restore the authorized wiring in their normal workflow, make the two default changes, and run the focused API, `reportingWorkerScenario.test.ts` and `reportingWorkerHarness.test.ts` regressions. Preserve R3a's durable-progress checks and the following busy/takeover/publication/cleanup checks unchanged; confirm the paced invocation actually copied one page. Run the plan's common gate at its authorized checkpoint. Record this decision and new evidence in the plan; this reviewer writes only this review. A different failure is investigated and recorded, not accommodated by raising another limit.

## 5. Hardening, release and rollback boundary

Failure recovery stays bounded, unsupported protocols fail before batch mutation, and the synthetic interruption still tests a durable checkpoint before takeover. Counting, attribution, hashes, history, inventory/ledger and UTC/site-time rules are untouched. No Repository contract or Dexie change is involved. Endpoint authentication, service-only RPC access, RLS and secret handling remain unchanged; no new dependencies, endpoint or schema edits are authorized. Performance budgets and operational diagnostics retain the prior review's requirements.

All work remains offline. Hosted staging, CI invocation, SQL application, deployment, merge and push remain outside this decision. Later staging still requires the prior exact-draft clearance and its role-denial, takeover, compatibility, transport/CPU/memory and rollback checks. CJ owns release. Rollback remains processor-disable/legacy reads and compatible prior code with additive schema/evidence retained; this review authorizes no release or destructive rollback.

This completes the requested scope decision and review, not T15P-4d acceptance or Task 15 completion.

STATUS: COMPLETE
