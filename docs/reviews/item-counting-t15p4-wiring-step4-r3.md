# Review: item-counting — T15P-4d wiring step 4, round 3

- Slug: `item-counting` · Branch: `feature/item-counting` · Reviewed commit: `80e9c5101b23c24acf90d5114e8e774040c66fad`
- Reviewer: planner (GPT-6 Astra) · Date: 2026-11-19
- Verdict: **changes required**. Fresh/current admission separation and the added recovery/heartbeat tests are substantial repairs. Unpaid packing is still omitted, and retry/renewal CPU can still become intrinsic owner capacity. These are step-4 defects, not deferred performance measurements.

This is the last allowed review round and an intermediate wiring review, not feature or release acceptance. References below are to the reviewed commit, also checkout HEAD. Inspected `git show 80e9c51`, both previous reviews and their coder responses, and the surrounding reader, worker, materializer and journal code. Only this review file was written; no commit, push or state-changing git command was run.

## Checked against

- [ ] Full feature spec acceptance: outside this checkpoint; not claimed.
- [x] Step 4 and its self-review correction (`docs/plans/item-counting.md:6531`, `:6538`), cumulative durable-progress condition (`:5792`), and “Astra wiring-step-4 round-2 fixes” (`:6729`). Remaining deviations are below.
- [x] Every round-2 Must-fix and Should-fix item, including the response at `docs/reviews/item-counting-t15p4-wiring-step4-r2.md:115`.
- [x] Scope-review Must-fix 2 (`docs/reviews/item-counting-t15p4-scope.md:63`). Phase arithmetic and between-call renewal are repaired; complete cost accounting remains blocked separately.
- [x] AGENTS.md guardrails, `docs/ARCHITECTURE.md`, and all sections of `docs/HARDENING.md`.
- [x] Roadmap F1 and cross-cutting decisions: shared counting, historical facts and production isolation remain unchanged.
- [ ] Complete type-check/test/build/CI gate: independently ran the focused API file, **73/73 passed**. The wider gate remains coder-reported; no remote CI was contacted.

## Round-2 disposition

| Round-2 item | Status | Evidence and judgment |
| --- | --- | --- |
| Must-fix 1 — fresh complete path versus current unpaid remainder | **Partly resolved** | `api/_lib/production-reporting-worker.ts:472` builds separate fresh/current decisions; `:570` includes the source reread and measured page CPU in the fresh commit. The paid-sizing test advances the cursor (`tests/api/reporting-worker.test.ts:1286`); fresh refusal and park-before-upload/resume are covered at `:1307` and `:1329`. However, current CPU is unconditionally zero while the writer still repacks and serializes after admission. Remaining Must-fix 1 below reproduces unchanged-position pending. |
| Must-fix 2 — complete CPU component ownership | **Partly resolved** | Separate meters and the single-current ledger (`api/_lib/production-reporting-worker.ts:436`, `:618`) improve ownership. Recovery extends through initial snapshot reconstruction (`:525`), the reader resumes before validation (`api/_lib/production-reporting-reader.ts:114`), and descriptors are separately charged (`worker.ts:584`). The component test at `tests/api/reporting-worker.test.ts:1354` proves the selected memory-reader paths. Actual retry and production-reader renewal paths still contaminate owner CPU, and incremental reconstruction omits operations performed on restart. See remaining Must-fix 2. |
| Must-fix 3 — missing worker recovery and boundary cases | **Resolved for the requested step-4 orchestration evidence** | Pending pieces are discarded exactly once and the subsequent prediction drops discard/open (`tests/api/reporting-worker.test.ts:1390`); a 100-of-103 hashed journal resumes with one reload, no durable source reread and only three new hashes (`:1449`). The hash boundary tests ordered `header, renew, checkpoint`, reserve and deadline-crossing renewal (`:1468`). Real-reader/writer escaped, multibyte and astral pages check exact calls and payload sizes (`:1513`). Near-deadline all-or-nothing admission and fresh recovery are tested separately (`:1329`). These tests pass; they do not cure the accounting defects above or replace real-SQL/production-framing evidence. |
| Should-fix 1 — retain/investigate focused-suite timeouts | **Partly resolved; nonblocking** | The current focused run is green and no existing timeout was raised by this commit. The earlier first-test timeout remains at `docs/plans/item-counting.md:6727`; the distinct transient-test timeout remains precisely recorded in the round-2 review at `:75` and `:81`. The new log at `docs/plans/item-counting.md:6766` says both are “recorded above,” but does not reproduce the second observation or establish suite contention as its cause. See Should-fix 1. |

Here `worker.ts` abbreviates `api/_lib/production-reporting-worker.ts`.

## Must-fix

1. **Price or eliminate the CPU work that still occurs after exact commit admission.**

   At `api/_lib/production-reporting-worker.ts:563`, `pageCalls` performs sizing; at `:570`, admission declares the current remainder `{ rpcs: calls, cpuMs: 0 }`. Cached entries avoid repeating `eventEntries`, but do not cache the packed requests. `api/_lib/reporting-worker-state.ts:650` retains only the entries; `:655` calls `writeOwnerPage`. That writer runs `packEntries` again at `:438` and, for a multi-call page, again at `:442`. Every entry is JSON-stringified and UTF-8 sized inside `packEntries` (`:322`). Actual RPC request serialization also follows sizing. The measured fresh leg does not add these later operations either. Round 2 explicitly required a separate estimate for packing/transport work that remains; zero is not that estimate.

   **Deterministic reproduction:** an in-memory instrumentation hook immediately before `writeOwnerPage`'s packing charged 250,000 ms to independent CPU and wall clocks, once per standard invocation. The ordinary 1,200-event fixture produced **three consecutive `pending` results, seq `0`, pending pieces `0`, no failure kind**. Every commit admission reported prerequisites `{ rpcs: 9, cpuMs: 0 }`, fresh unit `{ rpcs: 2, cpuMs: 0 }`, current remainder `{ rpcs: 1, cpuMs: 0 }`, action `run`. The subsequent journal guard observed expiration and parked before any checkpoint; nothing diagnosed the intrinsically over-budget work. This injects a cost at an existing synchronous boundary, not a claim that production packing normally takes 250 seconds.

   Preserve the repaired separation of paid sizing from unpaid work. Either prepare/reuse the actual packed request representation before admission, with the remaining transport work accounted for, or supply justified component estimates and post-measurement classification for what remains. A fresh path must include all operations necessary to commit, and current admission must preserve the reserve under those declared estimates. Do not fix this by charging already-paid event serialization again, widening limits or restoring an idle override.

   Required evidence remains within step 4: nonzero **post-sizing** packing/serialization CPU; a fitting path that progresses with its reserve; a genuinely over-budget path that refuses explicitly instead of repeating pending. Existing `cpuProbe("serialized")` tests inject only before admission (`worker.ts:564`) and cannot exercise this omission.

2. **Exclude actual retry/renewal spans from intrinsic owner CPU and complete the current-position reconstruction estimate.**

   Two executable counterexamples remain despite the memory-source component test:

   - **Retry backoff:** `meteredReader` resumes the meter in `finally`, including a rejected read (`worker.ts:658`, `:665`). The enclosing `b.retry` at `:502` then sleeps through `Budget.retry` (`:174`) without suspending that meter. A probe failing the first light member read transiently and adding 250,000 ms of unrelated process CPU during the injected sleep produced **`failed / owner_input_capacity`, seq `0`, prerequisites `{ rpcs: 10, cpuMs: 250000 }`**. Only the normal retry delay advanced wall time. CPU used while waiting is not this owner's unavoidable fresh preparation. The same suspension issue must be checked around the hash retry at `:597`.
   - **Real reader's light renewal:** production routing invokes `before()` and then `pageGuard()` (`worker.ts:800`). The wrapped `before()` resumes the light meter at `:507`. `rpcFrozenReader.call` suspends it before this callback, but does not suspend it again between callback and RPC (`api/_lib/production-reporting-reader.ts:107`, `:110`, `:112`). Thus a renewal inside `pageGuard()` runs with the light meter active. With `env.source` absent, a valid 1,200-member fixture delivered in 500-row real-reader pages, 30,000 ms of first-read wall delay, and 250,000 ms of CPU injected in renewal, the worker returned **`failed / owner_input_capacity`, seq `0`, prerequisites `{ rpcs: 10, cpuMs: 250000 }`**. The same frozen fixture then **published** on the next standard invocation with the unrelated CPU charge excluded. The memory route orders guard and activation differently (`worker.ts:798`), so the committed memory-source test does not cover this defect.

   Suspend meters for the complete awaited retry/guard/RPC lifecycle, including error propagation and backoff, and resume only where the owning synchronous work actually starts. Test the production `rpcFrozenReader` route as well as the injected source, with nonzero retry/renewal CPU and unchanged wall guards. Retain the working other-owner exclusion assertions.

   Reconstruction also remains only partially estimated. `reloadWork` (`api/_lib/reporting-worker-state.ts:464`) measures per-event join, digest and canonical parsing. It does not perform the loader's per-piece validation (`:537`), rebuild the growing identity/ordinal/budget maps (`api/_lib/production-reporting-materialize.ts:1188`, `:1223`), or sort the completed input on hashing recovery (`worker.ts:1027`). Adding only this measured subset at `worker.ts:575` does not establish the full restart cost after each commit or phase change. The next actual recovery measures a different set of operations. Include separately justified costs for the missing components, or measure an equivalent reconstruction of the current persisted phase/prefix. Compare nonzero predicted CPU components against an actual fresh recovery across a growing prefix and the reading-to-hashing transition; the current restart test uses CPU zero (`tests/api/reporting-worker.test.ts:1548`). Representative sampling remains for 4e, but defining and testing the component coverage is step 4.

   **Judgment on the stated continuation-to-resume limit:** the disclosure at `docs/reviews/item-counting-t15p4-wiring-step4-r2.md:128` is insufficient for approval. Minor scheduler overhead can be documented in a measured estimate; it cannot justify arbitrary unrelated CPU as proof of permanent owner incapacity. The reproduced spans encompass an entire retry sleep or renewal operation, not merely a small interval between two synchronous lines. Neither the comment promising owned CPU (`worker.ts:409`) nor a ledger that prevents double charging proves correct attribution by itself.

## Should-fix

1. **Make the timeout history and conclusion precise in the coder log.** Retain both separate observations: the first API test under full-suite load (`docs/plans/item-counting.md:6727`), and the round-2 transient retry test, **64/65 passed, one 5,000-ms timeout; isolated retry 1,953 ms** (`docs/reviews/item-counting-t15p4-wiring-step4-r2.md:75`). Link that exact retained evidence from the next authorized log update, and label contention as unconfirmed unless investigated. This review's 73/73 run and the coder's clean common gate are new observations, not retroactive passes for the failed runs. No timeout increase or additional broad test campaign is required solely to approve this documentation correction.

## Fixture limits and later obligations

**The 700 KB planning-only limit is acceptable for the assertions actually made.** `big2` contains two such rows (`tests/api/reporting-worker.test.ts:1284`); its combined memory-source page exceeds the real 1-MiB response limit, and each resulting fact is too large to stage. The tests at `:1346` and `:1413` expressly assert journal/owner planning completion, not publication. That is useful evidence for atomic admission and discard/recovery orchestration. The separately added real-reader/writer cases at `:1513` repair the missing legal escaped/multibyte packing evidence. Do not describe the combined synthetic fixture as a production-valid source page or as an end-to-end publication success. Do not change staging limits to make it publish.

Scope-review Must-fix 2's phase-specific renewal behavior is now demonstrated: the current phase reaches admission (`worker.ts:476`, `:479`), every journal/hash RPC is guarded (`:452`), and the post-renewal deadline check remains (`:780`). Read and hash tests exercise the actual worker (`tests/api/reporting-worker.test.ts:1125`, `:1468`). Their 5,000/6,000-ms thresholds include the explicit 1,000-ms first-unit CPU estimate, unlike the plan's zero-CPU 4,000/5,000 example. No threshold or reserve waiver is implied.

The remaining Must-fix items above block **step 4**. Keep the following separate later gates under their existing authority:

- **Step 5:** worker-driven atomic combined-page/crash progression (`docs/plans/item-counting.md:6539`).
- **Step 6:** cumulative staging preparation/discovery/first missing upload, sparse discovery, claim completion and partial-chunk reuse (`:6540`). Planning completion does not certify staging admission.
- **Step 7:** publication release/cleanup isolation and the remaining diagnostics gate (`:6548`).
- **Step 8 / 4e:** PG-LONG/PG-CUT traces, production-framed 119/121 reload boundary, 50,000/50,001, 999 self plus site versus 1,000 refusal, independent five-family/old-self oracle, sampled peak memory/CPU, and remaining authorized cut/lookahead/Unicode proofs (`:6553`). The new CPU meter/reload-work overhead must be included in those measurements.

## Verification and hardening

All checks were offline with installed dependencies. No hosted service, database, credential, network lookup or remote CI was used. No app, test, plan, migration or configuration file was written.

- **Unmodified API suite:** `tests/api/reporting-worker.test.ts`, **73/73 passed**, exit 0; 28.61 seconds in tests, 29.95 seconds total. File-free stdin Node invocation of `startVitest`, `config: false`, `watch: false`, `cache: false`, one worker, Vite `configFile: false`. This verifies the selected tests, not the project's Vite configuration.
- **Review-only probes:** injected through a Vite load hook without persisted files. The retry probe and corrected real-reader renewal probe reproduce false capacity. The packing probe instruments the existing post-sizing writer boundary and reproduces three unchanged-position pending invocations. Passing defect probes are evidence of the findings, not acceptance tests. The large CPU increments are deterministic accounting inputs, not representative performance measurements.
- **Probe setup limitations retained:** the initial renewal probe placed delay before owner routing; the worker correctly renewed before the light meter began, published, and the probe's defect expectation failed. Moving delay to the first source response exercised the intended second-read guard and produced the result above. An initial packing probe using a global `JSON.stringify` stack inspection stalled and was interrupted without a test result; the bounded load-hook instrumentation replaced it. Neither setup attempt is an unmodified-suite failure or performance measurement.
- **Wider gate:** the **80 files / 2429 tests, tsc, typecheck:digest and build** result at `docs/plans/item-counting.md:6767`, and seven reported mutations, remain coder-reported. No independent full-suite/type-check/build/CI run is claimed. Retain API-inclusive `typecheck:digest`; ordinary `tsc -b` does not cover `api/`.

| HARDENING section | Assessment |
| --- | --- |
| Failure modes | New discard, partial-hash, renewal and deadline-crossing tests pass. False capacity and unchanged pending remain blockers. Preserve fencing, replay, atomic cursor advancement and bounded transient retries. |
| Data correctness | No counting, credit, historical attribution, canonical-hash, UTC/site-time or inventory/ledger behavior changes in this commit. Existing parity is retained; independent later oracles remain required. |
| Security | No endpoint/authentication/selector, role/RLS/grant or secret-boundary changes. Capacity output remains kind/count-based; retained evidence must stay private and publication blocked. No hosted-security claim. |
| Release and rollback | No migration, dependency or release configuration changed. Existing migrations remain immutable; 0046 remains an offline draft. CJ owns SQL, merge and deployment. Preserve processor-disable/legacy-read fallback and compatible prior code with additive schema/evidence retained. |
| Performance | Preserve 240,000 ms, 30-second heartbeat, 2,000-ms reserve and all source/request/reload limits. Correct missing/misattributed CPU before using the model to declare permanent capacity; real cost/peak measurements remain for 4e. |
| Operations | Pending must remain recoverable and intrinsic refusal must be supported by the owner's complete fresh path. Do not count unchanged pending or false permanent refusal as healthy progress. |
| Tests | Focused regressions pass, but do not exercise the remaining counterexamples. Add the targeted component/lifecycle evidence under existing scope; the wider common gate and later acceptance gates remain separate. |

No Repository interface change requires a Dexie counterpart, no new root whitelist entry is involved, and the implementation files changed by this commit are within the bounded authorization. Later separately authorized staging still needs the exact reviewed schema, service access and anon/owner/manager/staff/kiosk/cs denials, independent-session takeover/cleanup, old-code and retained-read compatibility, transport/CPU/memory and rollback evidence. This review grants no hosted execution or release authority.

Do not mark wiring step 4 complete. Because this is the final allowed round, hand the remaining blockers and this evidence to CJ for the next decision; do not infer approval or start a fourth automated review round. The completed-review status below means the requested review artifact is complete, not that the implementation is approved.

## Nitpicks

None.

## Coder response

(Reserved for the coder's response under CJ's next decision; no further automatic review round is authorized here.)

STATUS: COMPLETE
