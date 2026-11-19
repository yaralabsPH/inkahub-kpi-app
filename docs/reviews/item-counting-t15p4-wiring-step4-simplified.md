# Review: item-counting — T15P-4d wiring step 4, simplified admission

- Slug: `item-counting` · Branch: `feature/item-counting` · Reviewed commit: `3203962de0d62f82ce53ba035dc92284716bbdb5`
- Comparison base: `ae320a9` · Reviewer: planner · Date: 2026-11-19
- Verdict: **changes required**.

This is the **one authorized implementation review** under [CJ's simplification scope decision](item-counting-t15p4-wiring-step4-simplify.md). The CPU-accounting requirements that decision superseded are not reinstated. The findings below block **wiring step 4**, independently of the later steps 5–7 and 4e. Return this review to CJ; it does not authorize another automatic repair/review round. Do not mark step 4 complete.

## Checked against

- [x] Acceptance criteria in every section of the simplification decision, especially §§2–7; the applicable item-counting requirements.
- [x] Plan wiring step 4 at `docs/plans/item-counting.md:6531` and the new Implementation-log entry at `:6776`, read with the superseding decision.
- [x] AGENTS.md guardrails: both backends, migrations, RLS, secrets, whitelist, authorized files and release boundaries.
- [x] `docs/HARDENING.md`, all seven sections, assessed below.
- [x] Architecture baseline and roadmap F1/cross-cutting decisions: no counting, historical credit or production-flow redesign is authorized here.
- [ ] All required new evidence is present and the common gate is independently verified without qualification. See findings and verification below.

Inspected the commit with `git show 3203962` (including file-scoped views), `git diff ae320a9 3203962`, and the current source at that exact HEAD. The initial worktree was clean. The delta contains exactly the six stated files; no materializer, migration, configuration, dependency, harness or other parity test was changed. `git diff --check ae320a9 3203962` passed.

## Must-fix

### 1. Preserve ambiguity and recognize recovered semantic progress before declaring no-progress

**`api/_lib/production-reporting-worker.ts:404`, `:550`, `:574`, `:595` — step-4 blocker; scope §4.4–6 and §6.3.**

`FreshAttempt` has only `started` and `progressed`. Progress is set after a successfully returned page/hash call or plan save; recovery neither snapshots nor compares semantic position. If a checkpoint commits but its response is lost, the enclosing retry recovers the advanced journal while `progressed` remains false. An `OutOfTime` during that recovery, or after it, becomes `owner_input_no_progress`. Catching only `OutOfTime` does not preserve error precedence when that timeout occurs while resolving an ambiguous write.

**Independently reproduced on the unchanged worker and the API test's FakeDb:** enumerate a 1,200-event owner in invocation 1; resume with the standard budget; let the first page checkpoint commit, then return transient `08006` instead of its response. After the ordinary 30,000-ms retry sleep, inject a deterministic 250,000-ms wall delay (a) on the first recovery event-load response, and separately (b) after recovery has returned its EOF, at the next read admission. Both return:

```text
state = failed; failureKind = owner_input_no_progress; reported durable units = 0
actual retained journal: seq = 1; committed events = 1000
actual cursor: { v: 1, step: "members", m: { afterOrd: 1000 } }
```

Case (a) still has unresolved recovery; case (b) has fully recovered the substantive advance. Neither proves no progress. Removing the delay and resuming the same batch publishes in both cases (final seq 6). This is a false operational diagnosis, not evidence of lost rows or intrinsic incapacity.

Track the attempt's initial semantic position and acknowledge advancement adopted during recovery. Also retain an explicit unresolved-write/ambiguity state so a budget stop before recovery establishes the outcome remains pending. Apply this to page, hash and plan-save response loss; a mere seq change from pieces/discard must still not count. Add deterministic worker regressions for both cases above, hash response loss, retained evidence and subsequent resume. Do not introduce persisted strikes or change checkpoint/replay semantics.

### 2. Separate logical fresh activation calls from the retry-driven call threshold

**`api/_lib/production-reporting-worker.ts:539`–`:551` — step-4 blocker; scope §2 and §6.1.**

`watch.trigger() === "calls" ? ACTIVATION_LIMITS.calls : watch.calls - attemptStart` treats all 16 attempted calls as unavoidable fresh calls when retries cause the call threshold to fire. That threshold includes failed/replayed attempts by design. It is not the no-failure light path.

**Independent deterministic comparison:** use the same 1,200-member, staff-less frozen owner with member pages of 100 rows; in the second run, fail only the eighth light member request transiently. Both runs publish, but their first admissions differ:

| Run | Activation watch | Derived `fresh` | `freshMs` |
| --- | ---: | --- | ---: |
| No failure | 10 | `{ fixed: 16, reload: 2, unit: 2 }` | 22,000 |
| Eighth request fails once | 16 | `{ fixed: 22, reload: 2, unit: 2 }` | 28,000 |

The second run includes six retry-related calls in capacity's prerequisite path. The committed test at `tests/api/reporting-worker.test.ts:1426` fails the *first* member request and still reaches the row trigger; it does not exercise this call-trigger branch.

Keep all attempts in the activation watch, but derive fresh capacity from the owner's actual no-failure logical light path, including replay/coalescing behavior. Do not substitute a constant 16 for that separate count. Add the call-trigger counterexample alongside the existing row-trigger case. The production caps prevent these particular values from causing capacity refusal; this finding does **not** claim an observed legal over-budget owner. It is a reproduced violation of the exact counting contract on which admission evidence depends.

### 3. Keep the no-progress result safe when recording the run fails

**`api/_lib/production-reporting-worker.ts:767`–`:769`, `:137`; `tests/api/reporting-worker.test.ts:1058` — step-4 blocker; scope §5 and §6.7.**

The new no-progress message itself contains only kind/counts, and its raw-owner admission record is not logged by the worker. However, the run-record failure catch appends the raw RPC error through the generic secret redactor. That redactor does not remove partition/event keys or payload text.

**Independent probe:** cause a qualifying first-commit overrun, then make `record_reporting_run` return `P0001` with `rejected partition ORDER_SENTINEL event EVENT_SENTINEL payload PAYLOAD_SENTINEL`. The returned result remains `failed / owner_input_no_progress`, keeps one journal and publishes nothing, but its second problem is:

```text
run log not recorded: record_reporting_run failed: rejected partition ORDER_SENTINEL event EVENT_SENTINEL payload PAYLOAD_SENTINEL
```

Use an allowlisted run-log failure diagnostic on this path; preserve the original returned diagnosis even when recording fails. Add order **and event** owner cases with recognizable key, payload and secret sentinels, asserting the complete problems array and attempted run arguments. Every current `expectNoProgress` call uses its default order kind; its event parameter is never exercised. The existing `recordFails` test at `:775` is an ordinary refresh case, not this required no-progress/run-log failure case.

This is the explicitly authorized **step-4 no-progress visibility** requirement, not a demand to complete step 7's wider publication/cleanup diagnostics now.

### 4. Complete runtime validation of admission inputs and arithmetic results

**`api/_lib/production-reporting-worker.ts:796`–`:833`; `tests/reporting/reportingOwnerInputState.test.ts:420` — step-4 contract gap; scope §2.**

The new validators reject the ordinary malformed inputs tested, but not all required arithmetic results. Two direct calls to the unchanged helpers produced:

```text
withRenewals(Number.MAX_VALUE) -> Infinity
admitUnit({ fresh: { fixed: 232, reload: 0, unit: 0 },
            currentRpcs: NaN, wallMs: NaN }, 240000)
  -> { verdict: "capacity", freshMs: 241000 }
```

The first accepts a finite duration but overflows during renewal arithmetic. The second bypasses remainder validation on the early capacity return. Validate all supplied fields before selecting a verdict, and validate multiplication/addition/fixed-point results before using or returning them. Add overflow and over-capacity-with-invalid-remainder cases. These are defensive, out-of-normal-range inputs; no production owner was shown to reach them. They remain explicit acceptance requirements rather than a reason to widen limits.

### 5. Supply the remaining required integrated boundary evidence

**`tests/api/reporting-worker.test.ts:1307`–`:1354`, `:1357`, `:1440`; `docs/plans/item-counting.md:6805` — step-4 evidence blocker; scope §6.1–3, §6.5 and §6.7.**

The new tests cover useful behavior, but the log's two disclosed omissions are not the only gaps:

- The post-admission helper advances time inside `onAdmission`, before `journal.commit`. It does not inject at `writeOwnerPage`'s actual post-sizing packing/serialization boundary (`api/_lib/reporting-worker-state.ts:434`, `:438`). A guard moved ahead of packing could still pass this test while dispatching after expensive packing. Exercise the real boundary, both a fitting nonzero cost with measured reserve and a 250,000-ms overrun with no subsequent unit RPC. Keep the callback observational for this proof.
- The preparation test delays a **header RPC response**. It does not exercise synchronous piece validation/map reconstruction, hashing-recovery sort or descriptor preparation before first admission. Exercise those named boundaries and confirm they cannot evade the fresh-attempt backstop. This asks for wall-time stop/progress evidence, not restoration of CPU estimates or a second reconstruction pass.
- Add the expressly required first acknowledged **empty-page cursor advance** and fresh-attempt **fence-loss** controls. Add ambiguity/recovered-progress controls from finding 1 and call-trigger retry accounting from finding 2. The log's statement that these follow from code is not the requested integrated evidence.
- Complete the requested contamination comparisons for hash retry and other-owner work, with independently controlled CPU/wall inputs and identical fresh-call breakdowns. A throwing `process.cpuUsage` spy and the real-reader case are useful, but do not by themselves exercise all named retry/scheduling paths. No CPU hook should return to production control flow.
- Complete the safe-visibility cases in finding 3, including the failed run-record path and later recovery of the same retained journal.

Do not expand fixture limits, increase timeouts, alter parity expectations or add a shared harness to satisfy these cases. Update the log to distinguish actual assertions from inference. The production-reader test currently permits **either published or pending** (`:1475`), whereas the new log describes it as published.

## Scope decision and required-evidence disposition

| Scope section | Assessment |
| --- | --- |
| §1 — replacement model | Honored: no fourth CPU-span repair, persisted strikes or new refusal protocol. Remaining findings concern the accepted simpler model. |
| §2 — capacity | Standard 240,000-ms comparison, strict `>`, one reserve, fixed-point renewals, minimum two-call read, exact pre-upload `1 + N`/`N`, live committed reload count and complete-journal reuse are present. Findings 2 and 4 prevent full acceptance. |
| §3 — parking/clock/guards | Per-owner/per-invocation read/hash maxima, absent versus zero samples, initial 1,000-ms wall allowance, paid-read exclusion, post-renewal sampling and durable per-RPC reserve guards are present. Backward readings are clamped within Budget. Real fitting post-sizing/preparation boundary evidence remains incomplete. No claim of preempting an in-flight RPC or preserving reserve after a 250,000-ms overrun. |
| §4 — fresh attempt | Standard-budget, no-copy/no-enumeration, 5,000-ms startup qualification and isolated first pending owner are implemented. No persisted state is introduced. Acknowledged normal commits and pending pieces are distinguished. Semantic recovery and ambiguity are not: finding 1. |
| §5 — removals/diagnostics/files | CPU meters, reader `io`, probes, `reloadWork` and `lastEntries` removed; real loader validation, map reconstruction and recovery sort retained. No remaining `processCpuMs` consumer was found in API/tests; removal does not waive 4e CPU measurement. Only allowed files changed. No-progress run-log fallback fails the safe-output requirement: finding 3. |
| §6 — evidence | Detailed below; passing existing tests does not establish omitted cases. |
| §7 — prior review/later gates | Superseded CPU obligations stay superseded; surviving operational obligations are assessed below. Later gates remain separate. |
| §8 — hardening/release | No schema/release expansion. All seven hardening sections assessed below. |

| Required evidence | Present evidence and remaining limit |
| --- | --- |
| 1. Contamination | `:1117` throws on process CPU access; `:1426` compares a first-read retry; `:1440` uses actual `rpcFrozenReader` without `env.source`, slow renewals and a transient. Call-trigger contamination is reproduced in finding 2; remaining named comparisons are finding 5. |
| 2. No endless unchanged pending | `:1316` repeats a fresh stop and then publishes the same journal; `:1331` covers delayed reload-header/hash-header responses. Actual packing and synchronous preparation seams remain missing. No persistent strike state exists. |
| 3. Freshness/progress controls | Shortened/copy-enumeration/after-page/late acknowledged commit, late-owner next-resume isolation, pending pieces, Deferred and clock rollback cases exist (`:1357`–`:1490`). Ambiguous recovery fails independently; empty-page and fresh fence-loss cases are missing. |
| 4. Count-only refusal | Pure 231/232-call equality pair, synthetic integrated oversized reload, exact commit reread and zero-upload refusal are present (`:1259`, `:1279`; owner-state tests `:375`). Oversized counts are correctly labelled synthetic; prerequisite calls precede the refused unit. No limits were enlarged. |
| 5. Fitting progress/reserve | Read 29,500-ms boundary at 5,999/6,000, hash 5,000/6,000, between-call renewal, renewal crossing deadline, paid long read and sample reset/maxima exist (`:1069`, `:1133`, `:1156`, `:1197`, `:1492`, `:1601`). Actual nonzero paid sizing/later packing and the corresponding reserve proof remain due. |
| 6. Accepted regressions | Discard once, one reload/no durable source reread for 100-of-103 hashes, complete reuse, live reload growth, and real escaped/multibyte/astral near-1-MiB reader/writer packing assertions are retained (`:1512`–`:1695`). The 700-KB synthetic rows remain planning-only, not legal combined source-page/publication evidence. |
| 7. Safe visibility | Order no-progress kind/run outcome, retained evidence, blocked publication and later resume are checked. Event-owner/sentinel/log-failure proof is missing, and the independent log-failure probe leaks text. |

### Round-3 disposition

- **Must-fix 1:** predicted packing CPU is superseded. Actual unpaid-boundary guard/progress evidence remains required; the callback-only test does not close it (finding 5).
- **Must-fix 2a:** meter suspension/ownership repair is superseded and the machinery is gone. Existing retry/renewal behavior remains, but the separate logical-call contract fails under a call-trigger retry (finding 2); complete the surviving contamination evidence.
- **Must-fix 2b:** predicted reconstruction CPU is superseded. Real reconstruction remains intact, and one-reload/partial-hash/growing-prefix tests remain. Synchronous preparation stop evidence is still due; semantic recovery must also inform progress (findings 1 and 5).
- **Should-fix 1:** resolved in the new log. It retains the first API full-suite timeout and the distinct round-2 transient case, **64/65 passed, one 5,000-ms timeout; isolated retry 1,953 ms**, links round 2 and labels contention unconfirmed. No timeout was raised. New passing runs do not erase either historical observation.
- Round-2 Must-fix 3's discard, partial-hash, heartbeat and legal packing regressions remain present. The phase/renewal repair is preserved; no zero-wall threshold or reserve waiver is accepted.

## Verification

All execution was offline, with installed dependencies and synthetic/in-memory fixtures. Commands used `VITE_BACKEND=dexie` and `npm_config_offline=true`; no installation, hosted connection, remote CI or standalone SQL application was performed. The full test selection includes existing isolated PGlite regression fixtures under their prior authority; it is not application of draft 0046 to a managed database.

| Command/check | Independent result |
| --- | --- |
| Initial `npx --no-install tsc -b`, `npm run typecheck:digest`, focused `npm run test -- --run ...` | PowerShell selected `.ps1` shims blocked by execution policy; each exited 1 before the underlying tool ran. Used the installed `.cmd` shims next; no policy change. |
| `npx.cmd --no-install tsc -b` | Exit 0. |
| `npm.cmd run typecheck:digest` | Exit 0, including the worker/API and focused test types. |
| `npm.cmd run test -- --run tests/api/reporting-worker.test.ts tests/reporting/reportingOwnerInputState.test.ts` | Exit 1 before collection: esbuild `Cannot read directory "../..": Access is denied`, could not resolve `vite.config.ts`. Zero test results. |
| `npm.cmd run test -- --run` | Same configuration-load failure, exit 1 before collection. |
| `npm.cmd run build` | TypeScript phase completed; Vite config loading failed with the same access error, referring to generated `vite.config.js`; exit 1. |
| File-free focused Vitest fallback below | Exit 0: **2 files, 109/109** (API 79, owner-state 30), 48.72 s total. Unmodified tests, unchanged timeouts. |
| File-free full Vitest fallback below | Exit 0: **80 files, 2435/2435**, 296.01 s total. Unmodified tests, unchanged timeouts; no timeout in this run. |
| File-free Vite build fallback below | Exit 0: 2,898 modules, 11.64 s. Warnings: stale Browserslist data, mixed static/dynamic XLSX imports and large chunks (main approximately 1,721 kB minified / 501 kB gzip). |
| Review-only probes | Four file-free Node stdin runs: initial ambiguous-page probe; two during/after-recovery variants plus later resumes; clean versus eighth-call transient capacity comparison; run-log sentinels and numeric helper edges. All exited 0 and produced the counterexamples reported above. These are not additional passing acceptance tests. |

The fallback avoids bundling the on-disk Vite config; it does not change files, permissions or test expectations. Exact stdin programs, invoked as PowerShell single-quoted here-strings piped to `node --input-type=module`:

```js
// Focused tests
import { startVitest } from 'vitest/node';
const ctx = await startVitest('test', [
  'tests/api/reporting-worker.test.ts',
  'tests/reporting/reportingOwnerInputState.test.ts'
], { config: false, watch: false, cache: false,
     maxWorkers: 1, minWorkers: 1 }, { configFile: false });
if (!ctx) process.exitCode = 1;
else { await ctx.close(); }
```

```js
// Full suite
import { startVitest } from 'vitest/node';
import path from 'node:path';
const ctx = await startVitest('test', [], {
  config: false, watch: false, cache: false, maxWorkers: 2, minWorkers: 1
}, { configFile: false, resolve: { alias: { '@': path.resolve('src') } } });
if (!ctx) process.exitCode = 1;
else { await ctx.close(); }
```

```js
// Production build, reproducing the checked-in config's plugin and alias
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
await build({ configFile: false, plugins: [react()],
  resolve: { alias: { '@': path.resolve('src') } } });
```

The defect probes used `@' ... '@ | node`, TypeScript's installed `transpileModule` with CommonJS/ES2022, and an in-memory `.js`/`.ts` resolver. They loaded the unchanged worker and the API test's existing FakeDb/memorySource/env definitions before the first `describe`; the Vitest import was omitted only from that in-memory fixture extraction. Clock/source/client wrappers supplied synthetic delays, page sizes and error responses. No app/test source was rewritten, no SQL was executed by these probes, and no real sleeps or CPU busy loops were used.

The coder's ordinary-command gate and mutation results remain separately identified as reported evidence. This review independently matches **80 files / 2435 tests** with the fallback, and verifies both type-checks and the fallback build, without claiming that the configuration-loading commands succeeded here. The log actually lists eight killed mutations **plus** one survivor (dropping only `!copied`), not eight total outcomes. Its explanation is consistent with the normal copy-then-enumerate path; that survivor is not itself a new blocker. I did not rerun mutations or treat a timeout as a kill. Local output is not hosted CI evidence.

## Hardening and later gates

| HARDENING.md section | Assessment |
| --- | --- |
| 1. Failure modes | Bounded retries, guards, retained journals and no partial publication remain. Ambiguous response loss is misclassified (finding 1); no-progress must remain a recoverable observation. Invalid/purpose/heavy/fence errors must preserve their existing kinds. No network integration was exercised. |
| 2. Data correctness | No shared counting, order/item/set rules, attribution, history, cancellation, UTC/site-time or inventory/ledger changes. Existing canonical validation/reconstruction/hashes are preserved. Freshness is scheduling metadata, not a historical business fact. Later independent oracles remain required. |
| 3. Security | No new endpoint/table, authentication/selector, role/RLS/grant or secret-storage change. Existing server-only boundary retained. Test-only raw-owner callback is not emitted by the worker. Run-log error text violates the new path's allowlist (finding 3). No hosted role/RLS certification. |
| 4. Release and rollback | No migration/config/dependency change; existing migrations immutable and 0046 remains draft-only. No shop-floor release is authorized. Preserve processor-disable/legacy-read fallback and compatible prior code with additive schema/evidence retained. CJ owns SQL, merge and deployment. |
| 5. Performance | Fixed budget, heartbeat, reserve, activation/reload/source/request/audience limits remain. Only the eligible first owner is isolated; later grouping remains bounded. Call arithmetic and mandatory boundary evidence need repairs. No speedup, two-year/three-site capacity or runtime preemption claim; CPU/peak-memory/transport measurements remain 4e. |
| 6. Operations | No-progress and capacity block publication without abandonment or persistent refusal. Same-journal resume works in existing tests and independent probes. False no-progress and unsafe log-failure diagnostics prevent operational acceptance. Retention/cleanup monitoring remains in the later gates. |
| 7. Tests | Both type-checks, focused/full fallback tests and fallback build pass; unmodified regression coverage does not close the counterexamples or missing explicit cases. Preserve old/new credit/count parity and all accepted recovery tests; complete §6 evidence under CJ's next decision. |

Repository/Dexie counterpart changes are **n/a**: no Repository interface or client backend was changed. New-table RLS and migration expansion are **n/a** for this delta. No root whitelist entry or dependency was added. The requested review is the only authored source/document change; type-check/build commands may emit their ordinary ignored artifacts. No commit, push, branch change, merge or deployment was performed.

These remain **later gates**, not additional reasons to fail this narrow step-4 review:

- **Step 5:** worker-driven atomic combined-page/crash progression and exact resume boundaries.
- **Step 6:** staging claim/admission, complete-journal reuse, discovery plus first missing upload, sparse chunks and partial-upload recovery.
- **Step 7:** post-publication bounded release/cleanup isolation and the remaining general diagnostics. Finding 3 is limited to the no-progress visibility explicitly required now.
- **4e:** PG-LONG/PG-CUT, production-framed 119/121 reload limits, 50,000/50,001, 999 self plus site/1,000 refusal, independent five-family/old-self oracle, remaining cut/lookahead/Unicode proofs, and real CPU/peak-memory/transport measurements of this redesigned implementation. Do not reuse removed-meter overhead or claim a speedup without measurement.

Later separately authorized staging must cover the exact reviewed schema, service access plus anon/owner/manager/staff/kiosk/cs denials, independent-session takeover, retained reads/old-code compatibility, real transport/runtime behavior and processor-disable/rollback. This review authorizes no hosted environment, SQL application or release action.

## Should-fix

1. Keep the Implementation log's claims aligned with the precise test assertions and remaining gaps identified above. Retain both historical timeout observations and the explanation of the redundant mutation survivor. No additional timeout investigation or broad test expansion is required solely for that already-correct history.

## Nitpicks

None.

## Coder response

Reserved for the response under **CJ's next decision**. This failed review ends the authorized review opportunity; do not start another automatic round. Completion of this review artifact does not approve wiring step 4 or T15P-4d/4e.
- **CJ decision (2026-11-19):** fix Must-fix 1 and 3; Must-fix 2, 4 and 5 waived as too unlikely to matter for this reporting feature. The decision is recorded in the plan's Implementation log.
- **Must-fix 1, done:** an `unresolved` state after a possibly committed journal write keeps a budget stop pending. A recovery that finds the committed position advanced adopts the progress, and a successful hash step counts as progress. Regression tests cover a lost page reply (a stop during recovery and a stop after it) and a lost hash reply.
- **Must-fix 3, done:** the run-log failure problem is now `run log not recorded (<kind>)`, with no database text. A sentinel test asserts the complete problems array and the attempted run arguments.
- **Must-fix 2, 4, 5: waived by CJ.** Not implemented.
- **Should-fix 1:** the log states that the production-reader test accepts either published or pending.

STATUS: COMPLETE
