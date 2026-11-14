# Review: Count production items separately from orders — round 2

- Slug: `item-counting` · Branch: `feature/item-counting` · Reviewed commit: `b4343a74100317d347098485b52751fd12fa9ca8`
- Reviewer: planner (Codex)
- Verdict: changes required
- Reviewed on: 2026-11-14

## Checked against

Checked means inspected, not that every requirement passed.

- [x] Spec acceptance criteria applicable to the original counting implementation and this follow-up
- [x] Operative plan Task 10 and historical Task 4 M6 amendment; Tasks 11–20 are unstarted and are not findings
- [x] AGENTS.md guardrails (both backends, append-only migrations, RLS, secrets, whitelist)
- [x] `docs/HARDENING.md`, every question (assessment below)
- [x] F1 roadmap decisions and architecture context
- [x] Tests inspected and all four requested local checks run; remaining test gaps identified below

Compared the branch with `main` (`57b89d2bec371c2aca66c2098fa2e57c7e3d73a7`), emphasizing changes after `9a731d1`: `5cb28a8`, `83a3fd4`, `76f74d2`, `bdcca17`, and the final coder response. Read all six requested git-ignored evidence files without reproducing large row lists. No database, staging runner, migration, deployment, email or Git state-changing command was run. Additional reproductions executed existing checker/collector modules and the existing fake database entirely in memory. Only this review file was authored; the requested build/type-check commands also produce their normal ignored output.

## Must-fix

1. **R2-1 — Make every failed/new collection invalidate certification, including startup and claims failures.** `tests/staging/run-item-counting.ts:324`, `tests/staging/run-item-counting.ts:473`, `tests/staging/run-item-counting.ts:491` — The existing successful artifact remains on disk until `collectCaseParity` returns. A sign-in/connection failure or process termination before that point leaves the old success available to the next performance gate. The cases report is also written only at the end: the log callback only prints/appends in memory, with no incremental FAILED report or heartbeat. Further, the artifact is written **before** `caseParityProblems` checks real-session claims; those failures enter the report but not the stored collection. Locally, a claims-failing collection report and `checkParityArtifact(...) === []` coexist. This violates the explicit no-fallback, claims-failure and interrupted-run requirements. Atomically mark a new attempt pending before fallible startup, preserve history separately, persist progress with FAILED status, and persist every final validation failure before publishing an acceptable artifact. Test sign-in/connect failure, termination during collection, claims validation/size failure, and subsequent performance gating: no API timing or phase record may use the previous success.

2. **R2-2 — Observe cancellation through the final case and certification boundary.** `tests/staging/policyParityRun.ts:359`, `tests/staging/policyParityRun.ts:414`, `tests/staging/policyParityRun.ts:448` — Abort is checked before a case and between its installed/restored sides, but never after the final restored side or during final restoration. Reproduced with the existing fake database: abort from the `kiosk-denied-uk` restored-side progress callback leaves `signal.aborted === true`, yet `caseParityProblems` returns no problems and restoration passes. The transaction rolls back, but the cancelled invocation can still certify COMPLETE. Keep rollback/restoration unconditional and make cancellation sticky through final publication. Add tests cancelling during the last restored read and the fresh restoration check; both must retain FAILED evidence and prevent phase eligibility.

3. **R2-3 — Enforce the original catalog authority and exact 8 s execution environment.** `tests/staging/policyParityRun.ts:51`, `tests/staging/policyParityRun.ts:202`, `tests/staging/policyParityRun.ts:383`, `tests/staging/itemCountingPolicyParity.ts:330` — The collector receives only the original policy hash, not the original baseline's helper/grant/RLS/role-setting/function fingerprints or revision. It compares those other fingerprints between the two current sides, so drift already present before collection can pass both. A missing retained installed hash is also optional. The applied timeout check accepts any nonzero value: a fake role environment returning `30s` passes the full collector gate. Local checker probes likewise accept equal changed helper fingerprints on both sides. Require the retained baseline/catalog and installed authority, compare every mandated invariant before cases and after restoration, normalize and enforce 8,000 ms after every role switch, and retain verifiable environment evidence. Add baseline-helper/ACL/role-config drift, missing-authority and non-8-second tests. The supplied real artifact's catalog fingerprints do match the historical baseline and record 8 s; this finding is about the collector failing to enforce that contract on subsequent runs.

4. **R2-4 — Validate and hash the underlying evidence, not only its summary.** `tests/staging/itemCountingParityCases.ts:232`, `tests/staging/itemCountingParityCases.ts:256`, `tests/staging/itemCountingParityCases.ts:262` — The phase hash omits exact row/replay sets, catalog evidence, claims evidence, bounds, cutoff, revision and collection problems. The checker does not validate several of those fields, and it accepts `restoration.passed: true` even with nonempty restoration problems. In-memory probes all passed the checker: empty bounds plus a wrong cutoff; missing claims byte evidence; changed helper evidence on both sides; a restoration reporting a membership mismatch while its boolean says passed. Changing the manager's UK IDs identically on both sides also leaves the parity hash unchanged. Thus an existing phase hash does not identify the completed artifact required by M6, and common summary labels cannot establish that substituted case snapshots share one collection/fixture/user set. Persist and validate scope, synthetic user identity and baseline references with the underlying evidence, recompute policy hashes from catalog rows, require every problem list empty, and canonically hash the complete acceptance evidence including restoration. Add same-count identity replacement, mixed underlying case evidence, missing scope/claims and contradictory-restoration tests, plus rejection of phases carrying the previous hash.

5. **R2-5 — Finish the amendment's positive-coverage and direct-reader evidence contract.** `tests/staging/itemCountingParityCases.ts:135`, `tests/staging/itemCountingParityCases.ts:155`, `tests/staging/policyParityRun.ts:86`, `tests/staging/policyParityRun.ts:211`, `tests/staging/policyParityRun.ts:233` — The amendment requires baseline positive rows at every member site, explicitly including `staging`, and retains self/other-worker probes. The checker instead exempts unpopulated sites. The actual artifact has no `staging` fixture and every identity sees zero there, so this is an observed contract gap, not merely a hypothetical mutation. Only staff's foreign-row exclusion is explicitly counted. Also, the 11 “replays” select sorted IDs with simplified filters, deliberately omit reader ordering/limits, and retain no returned-field/result evidence required by amendment step 5. Full-history reads use month bounds through infinity without applying the recorded cutoff; several replay filters likewise lack an upper cutoff. Implement the specified coverage and reader/scope checks, with tests for empty member-site coverage, missing self/other probes, changed returned fields and post-cutoff rows. Do not seed inside this collector: any fixture prerequisite must follow the approved CJ staging flow, or CJ must explicitly approve an amendment to the conflicting requirement. Preserve existing evidence as history and collect conforming evidence before recertification.

6. **R2-6 — Supply the missing r1 regression evidence rather than claiming it exists.** `src/lib/repository/supabase/__tests__/orderLookup.test.ts:42`, `tests/api/daily-digest-counts.test.ts:408`, `docs/reviews/item-counting-r1.md` (Coder response) — M4's identity guards and paging are implemented, but the eight lookup tests exercise only the loader and pure count function. There are no deferred site/account-switch tests, contrary to the coder response; no test exercises `OrderLookupCard`'s sequence guard or result hiding. M3 tests a later-page ledger error, a clock empty page and successful capped reads, but not later-page errors for all three ancillary readers as requested. Add tests of the actual identity/search lifecycle with deferred responses and a greater-than-cap order, plus later-page clock and staff-name failures proving no XLSX/email. Correct the response to distinguish implemented code from executed regression coverage. This completes the requested r1 M3/M4 evidence, not Task 20's separate manual browser checklist.

## Should-fix

1. **S1 remains partly unverified.** `src/pages/Production.tsx:306`, `src/pages/Welcome.tsx:90`, `src/lib/domain/__tests__/productionWelcomeView.test.ts:121` — Focus/visibility now update the date tick before refreshing, and `snapshotCovers` prevents projection onto another range. The new test only calls pure helpers; it does not delay the rollover timer, dispatch focus, or exercise the hook/request lifecycle required by r1 S1. Add that lifecycle regression for both consumers. No new incorrect-count reproduction was found in the revised focus wiring.

## Nitpicks

None added. R1 N1's draft/unstarted status prose was reconciled; the remaining historical records are explicitly labelled as history.

## Round 1 disposition

| Item | Source and test verification | Disposition |
| --- | --- | --- |
| M1, exact chronology | `productionInstant.ts` is shared by loader/reducer; qualification, cancellation, scope and duplicate payload checks use microseconds. Four new reducer tests cover late-within-millisecond qualification, earlier cancellation, equal instants and offset-equivalent payloads. | Fixed. |
| M2, selected-person denominator | `productionReportView.ts` uses the selected person's staff-days while retaining the all-visible leaderboard. Two-worker regression passes. | Fixed. |
| M3, digest ancillary completeness | Actual-progress paging, exact-count/array checks and unique barcode tie-breaker implemented; capped clock/ledger/name reads and incomplete-read refusal tests pass. | Code fixed for the reported cases; requested failure matrix incomplete (R2-6). |
| M4, lookup identity/completeness | Site/user/order key, fixed cutoff, sequence invalidation, read-site mapping and complete paging implemented; incomplete counts are unavailable. Remove/ledger action code is preserved. | Code fixes present; claimed deferred-response tests absent (R2-6). |
| M5, coverage of every displayed scope | Welcome aggregates its displayed comparison range; Reports uses everyone coverage for the visible leaderboard; digest warns for both published days. Historical-only/other-person tests pass. | Fixed. |
| M6, four-case gate | All four names, independent membership arrangements, nested restore, rollback and fresh restoration are implemented. Legacy-only, missing/duplicate case, summary fixture/baseline mismatch and missing/false restoration tests pass. | Not closed: R2-1 through R2-5. |
| S1, date on focus | Date tick and range guard implemented. | Lifecycle regression remains above. |
| S2, labels | Compact UI renders production day/timezone/cutoff; closed-day email always prints cutoff, with an API test. | Fixed in source; visual checks remain Task 20. |
| S3, alternate reports | Alternate modes no longer overwrite the performance report. | Original overwrite fixed; cases-mode interruption/report lifecycle still fails M6 (R2-1). |
| N1, status prose | Approved operative header and historical log wording present. | Fixed. |

## Collector checks and retained staging evidence

The successful path uses one connection and one `BEGIN ISOLATION LEVEL REPEATABLE READ`, per-case membership savepoints, installed reads before a nested pre-0036 restore, nested/case rollback, and outer ROLLBACK in `finally`. Missing/unconfirmed outer rollback leaves restoration unpassed. Timeout/read errors are retained. Fresh membership/catalog/fixture reads occur after the outer rollback. No COMMIT, migration-history write or 0036 application occurs in the cases collector. Fake-database tests cover these paths, including nested errors and lost rollback confirmation, subject to the cancellation/lifecycle gaps above.

`PRE_0036_RESTORE` matches the plan's Policy rollback body after removing only its BEGIN/COMMIT wrapper and normalizing whitespace/case/semicolons. Both original names, implicit permissive/PUBLIC scope and unwrapped predicates are preserved. `writeCompatRun.ts` now imports/re-exports that same array; its restore statements have not changed. Real claims are obtained before collection, bound in memory, legacy overrides cleared, and reads check `authenticated`, `row_security=on` and non-bypass role. The restored catalog hash matches the original pre-0036 policy hash. These positive checks do not remove R2-1/R2-3's validation gaps.

All requested files were read: `staging-results-item-counting-v23-parity-cases.md`, `...-denied-before.md`, `...-all-sites.md`, `...-denied-after.md`, `staging-results-item-counting.policy-parity.json`, and `staging-results-item-counting.phases.json`. All six are git-ignored. The current artifact passes the current checker; this review independently found the weaknesses above.

- Collection `b31856a9-0090-4e79-a078-d1d157002f6e`, revision `76f74d2`, cutoff `2026-11-12T00:00:00.000Z`, 28 month chunks. Fixture hash: `d644f2982dec549de4850d223e482df2c434915427872215199777f0e77e07c6`.
- Restored baseline policy hash: `2ce3f0db8fbfdc04c62993def22c0a5fcd8f10a558807df82993f5ab2aafa212`; installed policy hash: `b7884efe22600764525362bc13a976ecdf2f895489da6377ecd7f8257d7bb99b`.
- Recomputed current parity hash: `608b3e12afacb1f91ce103f68cb8f8cee6ae1461ff0027c4ed0e66a4cea80b38`. Every fresh phase records that same parity hash, installed policy hash, revision `76f74d2`, harness `item-counting-gate-v2.3`, v2 definition `9b3098a4926cdb26bbda6c5869a79892` and encoding 2. Earlier v2.2 records remain historical.
- Baseline owner sees AU/UK/US 155,432/42,340/42,340 rows; staff sees 30,018 own AU rows with zero foreign rows. Manager gains 42,340 rows at each of UK/US in its all-sites case; owner/kiosk separately lose UK and retain AU. Every stored restored/installed comparison is equal, with empty problem lists. `staging` is empty as noted in R2-5. Claims sizes are 501–516 bytes; no claim values are reproduced here.
- Restoration is recorded passed at `2026-11-14T09:15:39.153Z`. Baseline/current helper, RLS, grant, role-config, v1/v2 and membership-policy fingerprints match in the supplied artifact. This is inspection of saved evidence, not a new live restoration check.

| Fresh phase | Finished UTC | Owner AU day / 3 months, median ms | Manager AU day / 3 months, median ms | Report ending |
| --- | --- | --- | --- | --- |
| denied-before | 09:18:34.581 | 1,336 / 4,444 | 1,266 / 4,755 | FAILED only for the two not-yet-recorded phases |
| all-sites | 09:21:40.020 (report 09:21:40.021) | 1,246 / 5,868 | 1,346 / 5,240 | FAILED only for pending denied-after |
| denied-after | 09:24:49.321 | 1,260 / 5,674 | 1,203 / 4,834 | COMPLETE |

Each report retains 150/150 SQL statements, 48 EXPLAINs and 36 full-body text runs, with the 8 s authenticated settings and owner/manager API measurements. AU three-month reads retain 118,244 evidence rows. Medians satisfy the unchanged 2,000/10,000 ms targets; individual cold/slow runs above a median target were retained, not discarded. The final denied-after report ends exactly `STATUS: COMPLETE` and records all three phases in order. This confirms the requested files agree; it does not certify the stronger M6 contract while the findings remain. A corrected acceptance artifact/hash requires corresponding fresh phase evidence, not relabelling these records.

## Verification results

| Check | Result |
| --- | --- |
| `npx.cmd tsc -b` | PASS, exit 0 |
| `npm.cmd run typecheck:digest` | PASS, exit 0 |
| `npm.cmd run test -- --run` | PASS, exit 0; 679 tests in 22 files, including 318 S1 tests |
| `npm.cmd run build` | PASS, exit 0; 2,889 modules transformed |
| PR CI at reviewed HEAD | PASS: GitHub connector returned completed/success for [CI run 45](https://github.com/yaralabsPH/inkahub-kpi-app/actions/runs/43580572074), queried for `b4343a74100317d347098485b52751fd12fa9ca8` |

Build warnings remain stale Browserslist data, mixed static/dynamic XLSX imports and a main chunk over 500 kB (1,721.13 kB / 500.58 kB gzip). They are not new follow-up blockers. The initial read-only `gh pr view` failed with HTTP 401; CI was subsequently verified through the connected GitHub tool. Local probes wrote no source/test files and used no network/database: they demonstrated late cancellation, acceptance of a 30 s role timeout, missing/mismatched artifact fields, unchanged hashes after evidence replacement, and disagreement between claims validation and artifact eligibility. Passing tests/CI do not cover those counterexamples.

## Hardening assessment

Every question in `docs/HARDENING.md` was assessed within the requested follow-up scope.

| Question | Assessment |
| --- | --- |
| Network/Supabase/external services down or slow | App evidence failures retain explicit unavailable/stale states; digest required-read failures prevent output. Shopify/Dropbox/Slack/Make are not counting dependencies. Harness startup/interruption handling needs R2-1. |
| Retry/idempotency | Count changes add reads, not capture/stock writes; saved identities and cancellations deduplicate. Harness retries must invalidate old certification (R2-1). No new inventory concurrency guarantee is claimed. |
| Simultaneous users/devices | Evidence RPC snapshot and exact chronology remain; parity uses one repeatable-read transaction. Concurrent fixture administration is prohibited by the plan; final fresh restoration detects recorded fixture/membership drift. |
| Bad scan/SKU/order/site | Strict classifier/quantity checks and unsupported-site states remain. Lookup binds results to the read identity; missing lifecycle tests are R2-6. Existing capture validation is unchanged. |
| Visible failure and recovery | UI retry/status remains; digest aborts before XLSX/email. Harness can falsely certify cancellation/failure (R2-1/R2-2), so its recovery evidence is not yet sufficient. |
| Correct person/department | Saved attribution, exact parent chronology and selected-person denominator are preserved/tested. Lookup lifecycle evidence remains incomplete. |
| One counting rule | Shared classifier/reducer drives all four consumers; no new digest copy. |
| History after people/settings changes | Read-only recomputation uses saved facts; no source rewrite/backfill introduced in this follow-up. |
| UTC and site timezones | Exact microseconds and existing independent 04:00/DST boundaries pass tests. Focus wiring improved; lifecycle test remains S1. |
| Inferred/manual versus measured | No guessed pieces; missing historical detail is flagged across displayed scopes. Legacy timing interpretation remains separate. |
| Endpoint auth/input | No new endpoint; S1 auth-first, validation, method and no-store tests pass. |
| Table RLS/roles | No new tables in follow-up; invoker RPCs and two-policy design retained. M6 evidence/authority gaps prevent full parity certification. |
| Secrets in browser/code/logs | No browser credential additions; claims stay bound in memory and reports use sizes/IDs/hashes. No environment secrets were read for this review. |
| Cost/spam/data exposure | No new external calls/schedules/emails; existing S1 controls retained. Harness timing cannot rely on weak parity certification. |
| Expand-only/old app compatibility | Main-to-branch adds 0034–0036 without editing old migrations; post-r1 fixes add no migration. Approved equivalent-policy replacement and separate rollback remain. |
| Feature flag/off switch | Original read-only counting uses documented S1-protected deployment rollback. Future reporting flags belong to unstarted tasks, not missing work here. |
| Exact release sequence | Plan specifies staging/CI, catalog reconciliation, CJ SQL, protected deployment and monitoring; no release action taken. |
| Staging by role | Five roles, no-subject, four arrangements and recorded three-site timings inspected. Positive coverage/replays need R2-5; manual browser/Preview remains Task 20. |
| Months of history/indexing | Retained large-history measurements pass median targets; no timeout/index waiver authorized. Collector must enforce 8 s (R2-3). |
| Per-item external API | None added; ancillary reads page by actual progress. |
| Two years/three sites | Supplied fixture/performance evidence supports the measured workload. Future five-year/concurrency/publication work is Tasks 11–20, outside this review. |
| Detecting production breakage | Coverage, window/cutoff and HTTP errors remain; comparison coverage fixed. Harness progress/failure reporting still needs R2-1. |
| Shop-floor fallback | Reporting refresh remains separate from successful capture; protected deployment rollback documented. No offline-capture promise introduced. |
| Ongoing maintenance | Monitor RPC latency, coverage and scheduled digest outcomes. No new token/subscription lifecycle; new job maintenance is future scope. |
| Pure logic/edge tests | Broad passing suite plus r1 fixes verified; collector false-pass counterexamples and lifecycle gaps above require tests. |
| Inventory/credit/money tests | Routing/set/packaging and capture regressions pass; no stock/ledger implementation changed. Exact credit chronology and denominator tests pass. Manual old/new-app capture smoke remains a release blocker. |

Repository guardrails: `Repository.ts`, Dexie and Supabase adapters are unchanged, consistent with the direct-Supabase scope exception. Migrations remain append-only; no applied SQL was edited. New paths fit the whitelist; supplied staging artifacts are ignored and CI checks accidental tracking. The previously documented `pg`/`@types/pg` development dependencies support the staging harness; this follow-up adds none. No production connection, merge, deployment, commit or push was performed.

## Release blockers and handoff

- Task 10's approved follow-up M6 review remains blocked by the Must-fix findings; current CI is green. Preserve these staging records as history, fix/test the collector and gate, and obtain conforming acceptance evidence and follow-up approval before claiming closure.
- Task 9's Preview/browser checklist is carried to **Task 20/CJ**: actual role/site/account transitions, capture/retry/stock/ledger smoke, digest Preview/runtime and cross-consumer reconciliation, Dexie smoke and protected rollback rehearsal. These are release blockers, not additional code findings in this scope.
- **Vercel entitlement remains unobserved**, as recorded by Task 10: CJ must confirm support/budget for 15-minute scheduling, 300-second Node runtime and approximately 288 scheduled calls/day plus manual/retry work. No plan purchase, provisioning or deployment is authorized by this review.
- Tasks 11–20 are not reviewed as missing. No plan checkbox or implementation log was changed here. CJ retains every merge, SQL application and release step.

## Coder response

(Coder fills this in after fixing.)

STATUS: COMPLETE
