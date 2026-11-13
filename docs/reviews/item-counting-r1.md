# Review: Count production items separately from orders — round 1

- Slug: `item-counting` · Branch: `feature/item-counting` · Reviewed commit: `3fbbace2141226257103535c8af4a77dae49e401`
- Reviewer: planner (Codex)
- Verdict: changes required
- Reviewed on: 2026-11-13

## Checked against

Checked means reviewed, not that every requirement passed.

- [x] Spec acceptance criteria (`docs/specs/item-counting.md`)
- [x] Plan tasks, Implementation log and Open questions (`docs/plans/item-counting.md`); Tasks 1–8 are ticked, Task 9's browser/Preview checklist remains pending
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist)
- [x] `docs/HARDENING.md`, every section and question (assessment below)
- [x] Roadmap decisions for F1 and architecture context
- [x] New logic tests and all four requested local checks

Reviewed `git diff main...HEAD`, including the Tasks 5–9 consumers, shared counting/period/evidence modules, frame timing, tests, migrations and staging harness. No database or external service was contacted. No `.env*` file was inspected. Only this review file was authored; no commit, push, merge, deployment or Git state mutation was performed.

## Must-fix

1. **M1 — Preserve exact event ordering through the reducer.** `src/lib/domain/productionCounts.ts:210`, `src/lib/domain/productionCounts.ts:269`, `src/lib/domain/productionCounts.ts:319` — The loader preserves PostgreSQL microseconds, but preparation converts timestamps to millisecond `Date.parse` values and sorts again, putting verifications before terminals within a truncated millisecond. Reproduced locally: an excluded verification at 09:00, a completion at `10:00:00.000100Z`, and an eligible UN verification at `10:00:00.000900Z` produce **1 Order / eligible**; the earlier excluded-only completion must produce **0 Orders**. The same truncation lets a cancellation precede its parent within a millisecond without being rejected. Carry an exact instant comparison key into qualification, cancellation validation and ordering; retain milliseconds only for presentation/durations. Add reducer tests for both cases, including genuinely equal instants. This directly violates spec B and the first Review focus item.

2. **M2 — Use the selected person's denominator in the selected-person tile.** `src/lib/domain/productionReportView.ts:143`, `src/lib/domain/productionReportView.ts:230` — `staffDays` sums the deliberately unfiltered leaderboard, while the numerator is the person-filtered `summary.normal.orders`. With A and B each completing one different order on one day, selecting A returns Orders **1**, staff-days **2**, and average **0.5**, while A's leaderboard rate is **1**. This was reproduced against the actual selector. Keep the all-visible leaderboard, but compute the tile's denominator from the tile's person/work-type scope. Add a two-worker selected-person test; adding another worker must not lower A's rate.

3. **M3 — Do not certify ancillary digest reads from a short page alone.** `api/reports/daily-digest.ts:121` — `readAll` assumes the server always permits 1,000 rows, advances by 1,000, and considers any shorter response complete. A local reproduction using the actual helper with 1,500 rows and a 500-row server cap returns **500 rows after one request, successfully**. Clock hours, package totals and staff names can therefore be silently truncated and still reach XLSX/email. `data: null` with no error is also treated as successful empty data. Use a completeness-aware paging contract that tolerates a smaller server cap (with actual progress and stable continuation), validates array responses, and rejects missing/inconsistent reads. Staff-name ordering needs a unique tie-breaker because `staff_barcodes` is keyed by location/barcode, not user ID. Test a smaller cap and failures on subsequent pages for all three ancillary readers, asserting no XLSX/email on incomplete results. The strict evidence RPC itself handles its completeness contract correctly; this finding concerns the other required reads.

4. **M4 — Finish the order-lookup count migration's evidence and identity guards.** `src/pages/Reports.tsx:1001`, `src/pages/Reports.tsx:1087` — The new shared-count chip still wraps an unpaged `select('*')` as a complete snapshot. More than the server row cap for one order loses earlier verifications/context without detecting truncation. More immediately, switching location leaves `events` and `searched` intact, and the new mapping at line 1090 assigns those old events the **new** location; a pending old-location search can also repopulate them. The result is a count presented under a site it was never read from. Bind count evidence to authenticated user, site, order and a fixed cutoff; hide/clear it on identity changes and discard late responses. Obtain complete count/context evidence or show unavailable/incomplete, while preserving the existing Remove/ledger actions. Test site/account switches with deferred responses and an order exceeding the server cap. A shared reducer cannot make an incomplete or wrongly scoped input authoritative.

5. **M5 — Carry coverage alongside comparison and unfiltered totals.** `src/lib/domain/productionWelcomeView.ts:123`, `src/pages/Welcome.tsx:142`, `api/reports/daily-digest.ts:295`, `src/pages/Reports.tsx:555` — Welcome displays yesterday's total, historical comparisons, streak and improvement using multiple days, but exposes only today's coverage. Reproduced locally: a yesterday completion with no line detail displays **1 yesterday Order**, while the displayed coverage has **0 issues**; yesterday's summary has a missing-detail issue. The digest similarly warns only from today's summary while publishing yesterday's values and deltas. Reports uses selected-person coverage even while displaying the all-visible leaderboard. Preserve scoped coverage for each displayed result, or show a clearly labelled deduplicated warning covering all displayed scopes. Include historical-only and other-person-only gaps in tests. Known gaps are allowed; presenting their derived figures without the spec C incomplete-coverage indication is not.

6. **M6 — Enforce the approved four-case policy-parity gate.** `tests/staging/itemCountingPolicyParity.ts:184`, `tests/staging/itemCountingPolicyParity.ts:325`, `tests/staging/run-item-counting.ts:98` — The plan's explicit contract at `docs/plans/item-counting.md:214` requires `baseline`, `manager-all-sites`, `owner-denied-uk`, and `kiosk-denied-uk`, accumulated against one baseline/fixture, with membership validation and a restoration check. The implementation accepts only `standard` and the combined `owner-kiosk-without-uk`; its gate declares those two sufficient. The retained parity artifact confirms both before snapshots have manager membership `au,staging`; no manager-all-sites before/after row-set comparison exists. Post-0036 manager performance phases do not establish pre/post policy equivalence. Implement the required cases and fail the gate when one is absent or belongs to a different baseline/fixture; preserve independently reviewable before/after evidence and require positive fixture coverage. Add tests that the currently accepted two-case artifact cannot certify completion. CJ must direct any additional staging collection or approve a documented contract amendment; do not silently reinterpret the checked Task 4 gate. This is a harness/contract defect, distinct from the intentionally pending browser checklist. The SQL replacement itself matches the reviewed two-policy design.

## Should-fix

1. **S1 — Refresh the production date together with focus/visibility refreshes.** `src/lib/hooks/useProductionSummary.ts:103`, `src/pages/Production.tsx:289`, `src/pages/Welcome.tsx:72` — Focus only bumps the hook nonce; both pages memoize their date on a separate timer tick. Until that timer runs, a focus/retry after 04:00 can request the previous range with a new cutoff. Welcome derives its displayed day from that cutoff, so it can project a new day outside the loaded range. Update the date/range before issuing the focus refresh and validate that the projected day belongs to the snapshot. Add a lifecycle regression with the rollover timer delayed across focus; pure selector tests do not exercise this wiring.

2. **S2 — Keep window and cutoff labels available in compact views and closed-day email.** `src/components/ProductionCountStatus.tsx:78`, `api/reports/daily-digest.ts:289`, `api/reports/daily-digest.ts:463` — Both Welcome and Production use `compact`, which suppresses the production-window/date/timezone detail (Production adds only a timezone suffix, Welcome none). Closed-day email says “final” and includes loaded/generated times but omits the actual cutoff; only the workbook Summary has it. Expose the production date, site timezone and cutoff through concise text or an accessible detail control, and include the cutoff even when the day is closed. Late corrections can change a closed day's result.

3. **S3 — Keep the latest staging report from becoming an unfinished placeholder after an alternate mode succeeds.** `tests/staging/run-item-counting.ts:300` — The current `staging-results-item-counting.md` is an unfinished `9d8f7ed` report ending FAILED at session sign-in, while the separate write-compat report completes and the archived denied-after report is COMPLETE. Give alternate modes their own progress/final report lifecycle, or explicitly identify the authoritative completed evidence in the plan. Preserve genuine failed reports; avoid making a successful alternate-mode invocation appear to have left an active performance run. This does not invalidate the archived measurements reviewed below.

## Nitpicks

1. **N1 — Reconcile stale plan status prose.** `docs/plans/item-counting.md:5`, `docs/plans/item-counting.md:455` — The header still says “draft” and the log introduction says all tasks are unstarted, despite recorded CJ approvals and completed implementation entries. Update the current status while retaining the historical failed runs/amendments. Otherwise the handoff requires readers to resolve contradictory status statements manually.

## Verification results

All four requested commands ran from the repository root against the reviewed working tree.

| Command | Result |
| --- | --- |
| `npx tsc -b` | PASS, exit 0 |
| `npm.cmd run typecheck:digest` | PASS, exit 0 |
| `npm.cmd run test -- --run` | PASS, exit 0; **629 tests in 20 files**, including all **318 S1 tests** |
| `npm.cmd run build` | PASS, exit 0; 2,887 modules transformed |

Build warnings: stale Browserslist data; XLSX imported both statically and dynamically; chunks over 500 kB (main JS 1,721.13 kB / 500.58 kB gzip). These are not new acceptance blockers. A supplementary `git diff --check main...HEAD` reported whitespace in the plan and mixed-line-ending Production additions; no cleanup was performed.

Additional local, in-memory executions of the actual TypeScript modules reproduced M1, M2 and M5; extraction/execution of the actual `readAll` helper reproduced M3. These executions wrote no test files and used no network. The passing suite does not cover those cases. The capture harness exercises the loader/selector with synthetic saves; it does not mount Production or verify hook transitions.

## Security, capture and staging evidence

- **Capture/stock:** The Production diff removes local increments and two count queries, replacing them with read refreshes after successful saves. It does not change inserted values, cancellation payloads, CS tags, event creation, stock RPC arguments or packaging selection. Refresh is not awaited before deduction. The `skuRouting.ts` diff only removes obsolete KPI helpers; routing/deduction code, repositories and existing stock migrations are unchanged. This is source evidence, not a new concurrency guarantee for the existing deduction RPC.
- **Digest S1:** Auth, GET-only rejection, recipient override policy, diagnostics and no-store control flow are preserved; auth precedes work. Missing service-role configuration fails rather than falling back to anon, and ordinary invalid/blank/repeated dates fail before reads. Required-read errors tested today stop XLSX/email. M3 concerns undetected incomplete success responses, not an S1 regression.
- **Vercel ESM:** Runtime relative imports use `.js` from the digest through `productionCounts` → `productionItems` → `skuRouting`. `productionPeriods` has no runtime dependencies; the evidence reader's extensionless domain import is type-only and erased. Local digest type-check/tests pass. Actual Vercel bundling/loading remains a Preview gate.
- **Migrations:** Main-to-HEAD adds 0034/0035/0036 without modifying recovered migrations. V1/v2 are scalar JSON, STABLE, SECURITY INVOKER, with empty search path and explicit authenticated/service-role execution grants, denying PUBLIC/anon. Every evidence family is site/cutoff constrained. 0036 atomically replaces only the two permissive PUBLIC SELECT policies and preserves the intended membership/self/role predicates. No new table, write policy, helper, inventory function or data rewrite is introduced.
- **Task 4 records inspected locally:** `staging-results-item-counting-policy-parity.md`, the corresponding JSON artifact, archived `...0036-step7.md`, `...0036-step8.md`, `...0036-step9-rerun.md`, and `staging-results-item-counting-write-compat.md`. The first two performance phases correctly end FAILED for outstanding phases; the denied-after archive at `3d0a79c` ends COMPLETE and records all three phases. It reports v2 definition `9b3098a4926cdb26bbda6c5869a79892`, policy hash prefix `b7884efe2260`, realistic claims of 501–516 bytes, and the unchanged 8 s SQL timeout. AU denied-after medians are owner day **1,382 ms**, three months **6,132 ms**, manager day **1,320 ms**, three months **5,670 ms**; 118,244 evidence rows are retained for AU three months. These support the recorded workload's latency/completeness, subject to M6's incomplete parity matrix.
- **Write compatibility:** The separate COMPLETE report at `9d8f7ed` records 30 matching steps under 0036 and the prior policies in a rolled-back transaction. It records kiosk scanned-worker capture, first deduction of two frame units/one box, retry skipping both, permitted/denied corrections/deletes, service-role direct-read parity, v1/v2 counts and anon denial. It is SQL statement replay evidence; it does not replace the old-app/new-app browser smoke.

## Hardening assessment

Every question in `docs/HARDENING.md` was considered:

| Area / question | Assessment |
| --- | --- |
| Failure: network/services down or slow | Evidence loader rejects failed/incomplete/deadline reads; hook retries and labels dated same-scope stale data. External commerce/artwork services are not count dependencies. M3/M4 remain incomplete-read gaps. |
| Failure: retry/idempotency | Reporting adds reads only; retrieved identities/cancellations deduplicate. Existing capture/idempotency behavior is unchanged, not newly proven concurrency-safe. |
| Failure: simultaneous people/devices | One RPC statement snapshot and fixed cutoff avoid mixed evidence families; later changes appear on refresh. M1 affects exact chronology; browser switching needs release verification. |
| Failure: bad scan/SKU/order/site | Strict classifier/quantity validation and unsupported-site state are present; existing capture validation remains. No guessed pieces. M4 violates lookup site identity. |
| Failure: visible error/recovery | Loading, retry and stale/error states exist; capture proceeds independently. M3–M5 identify cases where incomplete data can still look valid. |
| Correctness: person/department attribution | Uses saved attribution and resolves parents before display filters; no reassignment through current team. M2/M4 affect displayed scope. |
| Correctness: one counting rule | Four principal consumers use shared item/reducer logic; no copied digest classifier remains. M4 concerns input completeness, not a second classifier. Side-card exceptions are logged as Open questions. |
| Correctness: historical changes | Read-only recomputation, no backfill or rewrite; release notes disclose changed history. |
| Correctness: UTC/site zones | Independent 04:00 boundaries and DST tests cover AU/UK/US. M1 loses sub-millisecond ordering; S1/S2 concern rollover and labels. |
| Correctness: inferred/manual values | No inferred quantities added. Frame timing retains its separate legacy stream/weighting and UN zero-weight behavior. Missing-data disclosure needs M5. |
| Security: endpoint authentication/input | S1 preserved; invalid report dates rejected; no new endpoint. |
| Security: table RLS/roles | No new tables. V1/v2 use invoker RLS; 0036's intended semantics match the plan, but M6 blocks certification of its full approved parity gate. |
| Security: secrets | Server credential stays in the API; pure/shared browser modules contain no credential access. No secret values or configuration files were needed for review. |
| Security: cost/spam/exposure | Existing secret and recipient controls retained; no new external per-item calls or schedule. M4 is a stale-site display risk. |
| Release: expand/rollback compatibility | Functions are additive; equivalent SELECT-policy replacement is an approved exception. SQL replay supports old-code compatibility; browser rehearsal remains pending. |
| Release: feature flag | None required by approved spec for this read-only change. Protected deployment rollback restores prior formulas; separate policy rollback remains necessary for 0036 issues. |
| Release: exact CJ sequence | Plan specifies catalog reconciliation, staging gates, credential checks, migrations before code, protected rollback and monitoring. No release was performed. |
| Release: staging per role | Five-role/browser/digest checklist exists. SQL records cover substantial behavior; M6 and remaining browser/Preview steps are distinguished. |
| Performance: long history/index strategy | Single evidence RPC, dictionaries, indexed maps/sweep and retained large fixture measurements; no unauthorized index/timeout increase. Reports' per-day projections/browser rendering are not covered by loader-only timings. |
| Performance: per-item API calls | None introduced; ancillary reads are batched/paged, subject to M3. |
| Performance: two years/three sites | Recorded synthetic history and >100k-row RPC tests exist. Complete page-level/Preview latency still needs CJ evidence. |
| Operations: detecting breakage | UI status/coverage and HTTP errors exist; no new monitoring service. M5/S2 improve reconciliation; S3 concerns evidence-report reliability. |
| Operations: shop-floor fallback | Existing capture remains usable when KPI reads fail; S1-protected app rollback is documented. No offline-capture feature is claimed. |
| Operations: maintenance | No new subscriptions/token lifecycle or persisted summaries. Monitor RPC latency/volume, coverage and subsequent scheduled reports. |
| Tests: pure logic/edge cases | Broad classifier/reducer/DST/loader/view/API tests pass; concrete missing cases are identified above. |
| Tests: inventory/credit/money | Routing/set/packaging characterizations and SQL write-compat records support unchanged inventory. M1/M2 affect credit reporting; actual UI capture smoke remains a release blocker. |

Repository guardrails: the shared Repository interface and both adapters remain unchanged, consistent with the documented direct-Supabase scope exception. New paths fit the whitelist; staging artifacts are ignored and CI checks for accidental tracking. The `pg`/`@types/pg` dev dependencies and staging support files exceed the original no-dependency approach, but their direct-Postgres harness purpose is explicitly recorded in the Implementation log; they are not browser dependencies. Task 4 has multiple recorded amendment/evidence commits rather than one literal commit. This review does not amend the plan or authorize additional scope.

## Release blockers

These are separate from Must-fix code/harness findings. Pending CJ steps are not defects by themselves.

- Resolve M1–M6, obtain a follow-up review, and reconcile Task 4's completion claim with the approved parity gate or a CJ-approved amendment. Additional database work remains CJ-directed.
- Complete Task 9's staging browser checklist on a CJ-created Preview: all five roles, rapid worker/site/account changes, delayed/out-of-order responses, failed refresh/retry, 04:00 rollover, Dexie unavailable states, capture/stock/ledger smoke and full release smoke.
- Download authenticated `dry=1` AU/UK/US digests on Preview; verify `.js` runtime imports, shared-scope workbook/UI parity, windows/coverage and end-to-end timing. No count-verification email send is needed.
- Confirm green PR CI for the final corrected head, including append-only migration checks. Remote CI was not queried in this offline review.
- CJ confirms staging/Preview separation, server-side `SUPABASE_SERVICE_ROLE_KEY`, S1 secret/recipient configuration, and a tested S1-protected rollback deployment. Reconcile the live catalog before applying any missing migrations in order; production SQL, merge and deployment remain CJ's steps.
- Publish release notes, resolve or explicitly defer the documented side-card/runbook Open questions, and monitor initial UI samples and subsequent AU/UK/US scheduled digests.

## Coder response

(Coder fills this in after fixing, linking regression evidence and identifying any CJ-approved plan amendment.)

STATUS: COMPLETE
