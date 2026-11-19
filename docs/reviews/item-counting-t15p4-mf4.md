# Review: item-counting — T15P-4 Must-fix 4

- Slug: `item-counting` · Branch: `feature/item-counting` · Reviewed commit: `329c65a`
- Reviewed range: `668c266..329c65a` (`18541f5`, `46b8275`, `bef3756`, `329c65a`)
- Reviewer: planner (GPT-6 Astra) · Date: 2026-11-19
- Verdict: **changes required** for full closure of scope-review Must-fix 4. The complete-page, missing-kids and Unicode coverage is substantially present; cut-page exclusion needs direct boundary evidence, and the allowance proof remains outstanding.

## Checked against

- [x] Scoped acceptance criteria: `docs/reviews/item-counting-t15p4-scope.md` section 4, Must-fix 4. This is not a full feature/spec review.
- [x] Must-fix 4 TDD plan, corrections and step 0/proofs 1–3 logs at `docs/plans/item-counting.md:6547` onward; deferral assessed below.
- [x] AGENTS.md guardrails: only the authorised test file and plan log changed in the reviewed range; no application, migration, dependency, Repository/Dexie, RLS or secret changes.
- [x] `docs/HARDENING.md`, all seven sections, as scoped below; also read AGENTS.md and ARCHITECTURE.md.
- [x] Roadmap F1 decisions: no shared counting, eligibility or historical-credit rule changes.
- [ ] Independently executed type-check, tests and build at the reviewed commit. See verification boundary below.

## Evidence and assessment

All source and plan line references below are **at `329c65a`**, obtained with `git show`; the changes were inspected with `git diff` on the requested range, including a whitespace-insensitive inspection of the step-0 hoist. No working-tree implementation was used as review evidence.

| Obligation | Assessment and evidence |
| --- | --- |
| Step 0: preserve the recovery harness and earlier complete-page proof | Accepted as a behaviour-neutral hoist. The state/argument/crash helpers are module-scoped at `tests/reporting/reportingOwnerContinuation.test.ts:258`; keyed `traced` at `:424` replaces CP-M's local equivalent. CP-M's fixture remains at `:128` and its assertions remain at `:995`. |
| Complete combined page, already implemented earlier | Retained. `:1007` checks the immediate atomic commit and its included IDs; `:1011` checks ordered phases; `:1014` excludes individual redundant child reads. `:1025` exercises both before-write and commit-then-lost-response recovery, compares the returned input, and requires no reread when the short page completed the walk. Existing all-owner input and works/hash checks at `:199` and `:550` provide complementary coverage; this is not a new independent hash oracle. |
| A line without included kids | Substantially direct. The separate CQ-M/W10 fixture at `:147` preserves CP-M. `:1104`–`:1135` checks commit A before the first child read, pending `afterKidOrd: null`, exact child continuation arguments, each child-page commit, multiple nonempty pages, then effective/done and cursor order. `:1146` crashes before and after every commit from A onward, with real reload and input parity through `resume` (`:400`). Three large children instead of two is a justified fixture correction: it forces the asserted multi-page condition without changing production semantics. See Should-fix 1 for precision gaps. |
| Unicode certain bound | Directly proved by assertions, not merely result parity. The fixtures use `String.fromCodePoint` for U+D7FF, U+E000 and U+1F600 (`:31`, `:140`). Both routes must issue predecessor calls (`:1065`), and every call must carry the expected worker, exact instant and exact-id/null choice (`:1067`). The two routes' bounds and durable journal contents are compared (`:1075`). The generic all-owner test also compares their full inputs. |
| Stop/look-ahead IDs absent | Direct for both loop paths. LA-M requires the plain reread to return `la-p2`/`la-p3` and excludes them from the journal (`:1204`–`:1211`). O-1 requires returned `pr-0241` to be absent, retains `pr-0240-tie`, and checks the stored stop instant (`:1218`–`:1227`). `exactlyConsumed` also checks every returned ID outside the expected input. Adding LA-M after discovering that O-1 stops in the combined loop is a useful correction to the plan. |
| Cut-page IDs absent / not consumed merely by fetching | Partial only. NOTE proves same-position fallback and final input equality, but not the discard boundary itself. Must-fix 1 below. |
| 50,000 allowance / refusal at distinct ID 50,001 | Not implemented in these four commits. Final journal equality on small fixtures cannot prove transient budget charging or the refusal boundary. Must-fix 2 below. |

The malformed-page rejection remains intact at `tests/reporting/reportingOwnerContinuation.test.ts:513`.

## Must-fix

1. **Make the cut-page proof non-vacuous and observe the discard boundary.** `tests/reporting/reportingOwnerContinuation.test.ts:1195` identifies a cut only by combined-to-plain call adjacency. The recorder at `:1167` drops row kinds/completeness, and `:1197` calls `exactlyConsumed` without asserting any cut-specific unconsumed ID. Its exclusion set at `:1184` may be empty; its absence assertion follows already from final set equality. The NOTE fixture's partial children can legitimately be consumed later by the plain/child rereads. Consequently, prematurely taking a valid cut-page prefix and then deduplicating it during reread can leave exactly the same final journal and evade these assertions.

   Record the actual incomplete included-child response and inspect the journal/consumption trace **before** its same-position plain reread. Assert that at least one newly returned ID was not previously consumed, and that the discarded response adds no IDs, ordinal/state progress or consumption charge. Then let the ordinary reread consume legitimate evidence and verify final parity. For any claimed final exclusion, name an actually returned, never-consumed ID and require a nonempty exclusion set tied to that response. Do not assert that all IDs seen on a discarded page must remain absent forever: later legitimate consumption is allowed. Add a prompt assertion-failing control for premature consumption of the discarded prefix; the logged “treat cut as complete” mutation alone does not distinguish this case.

2. **Keep the allowance proof open through 4e and correct Fixture C's arithmetic before implementing it.** The requirement is explicit at `docs/plans/item-counting.md:6563`–`:6567`; the deferral is at `:6618`. No added test reaches the boundary. Implement a successful case with an independently enumerated final consumed set at or below 50,000 despite discarded/look-ahead responses, plus a case refusing exactly the 50,001st distinct consumed ID on both routes, with no oversized journal checkpoint. Check actual SQL `event_count` and retain the prompt charging mutation.

   The written success recipe starts with 49,999 consumed member IDs and then introduces a distinct predecessor plus three distinct children. If those are consumed on the legitimate reread, the total is **50,003**, not at most 50,000. Cut transport does not make later-consumed children free. Choose counts from the complete intended consumed set (including dependencies); the failure sibling must add one to an exactly-50,000 success case. Record this correction rather than changing the limit or treating legitimate child evidence as excluded.

   **Deferral decision:** acceptable as scheduling to the existing 4e acceptance checkpoint (`docs/plans/item-counting.md:6531`–`:6538`), not as completion or waiver. This review permits that sequencing within the already-authorised files. Must-fix 4 and Step 4/4e acceptance remain open until the proof passes; the smaller tests cannot substitute for it. No extra CJ approval is needed for that in-scope proof.

## Should-fix

1. **Tighten the CQ-M trace to match the plan's exact wording.** `tests/reporting/reportingOwnerContinuation.test.ts:1106` checks commit A's IDs and `:1109` its final pending state, but does not explicitly check the preceding `cq-t0` done/cursor sequence in that commit. Also, the before-A resume starts with a null cursor: `expectedArgs` returns null at `:316`, and `expectedFirst` has no initial-walk case (`:364`–`:371`). Thus the generic guard does not directly prove the promised same initial `p_at`/`p_at_event_id` reread. Assert that initial request against the recorded original request and assert A's ordered prefix. For included-child reuse, inspect all post-combined-page child calls, rather than filtering only single-parent requests at `:1137`; the same limitation exists in the retained CP-M assertion at `:1014`.

2. **Append the final proof's gate evidence.** `docs/plans/item-counting.md:6615`–`:6617` records gates for step 0, Unicode and CQ-M, but `:6618` records mutations and the deferral without the focused/common gate results required by `:6553` and `:6597`. Record commands, counts and exit results for the Proof-1 commit. This is an evidence gap, not a claim that those commands failed.

## Verification and hardening boundary

`git diff --check 668c266..329c65a` passed (exit 0). The range changes only the test file and five appended plan lines. I did **not** run the optional Vitest command: the shared checkout is under concurrent coder work, so its result would not establish the pinned commit's status; no alternate checkout or temporary source files were created under the one-file-write restriction. No fresh test/build success is claimed. The committed logs report 30/30 continuation tests and 2387 common tests for step 0, then common totals 2390 and 2392 for proofs 3 and 2, with digest type-check/build exit 0. Those and the prompt mutation failures are **coder-reported**, not independently rerun here.

Hardening sections 1–2 and 7 apply directly: recovery, deduplication, exact evidence and time-bound arguments are reviewed above. Section 5 remains incomplete at the allowance boundary; CPU/memory, invocation limits and the independent five-family oracle remain separate 4e obligations. Sections 3–4 and 6 introduce no new runtime surface in this test-only range: no endpoint, grants/RLS, secret, migration, operational diagnostic or release behavior changes. Repository/Dexie parity and inventory/money behavior are unchanged. This review does not certify staging, concurrency across hosted sessions or production performance.

No hosted systems, CI, credentials, SQL application, commit, push or state-changing git command was used. Only this review file was written. Existing release/rollback constraints stand: 0046 remains an offline draft; later separately authorised staging must cover role denials, takeover, compatibility and measured resource limits; CJ owns SQL, merge and deployment. Processor-disable/legacy reads and compatible prior code remain the rollback route, retaining additive schema and evidence.

## Nitpicks

None.

## Coder response

(Coder fills this in after fixing, linking the cut-boundary proof and the eventual 4e allowance evidence. Do not mark Must-fix 4 complete solely from this handoff.)

STATUS: COMPLETE
