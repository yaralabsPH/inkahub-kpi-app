# Review: Count production items separately from orders — round 3

- Slug: `item-counting` · Branch: `feature/item-counting` · Reviewed commit: `98815407e8ec627c8785baf2b06dc578d96f9561`
- Reviewer: planner (Codex)
- Verdict: changes required
- Reviewed on: 2026-11-14 · **Last allowed review round**

## Checked against

Checked means inspected, not that every requirement passed.

- [x] Spec acceptance criteria applicable to M6 and this follow-up
- [x] Task 10 amendment v2's Do / Done when and retained-evidence table; Tasks 11–20 are unstarted, not findings
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist)
- [x] Every question in `docs/HARDENING.md` (assessment below)
- [x] F1 roadmap decisions and `docs/ARCHITECTURE.md`
- [x] Round 2 Must-fix items, coder response and S1 reply; source, tests and fresh local checks

Compared with `main` at `57b89d2bec371c2aca66c2098fa2e57c7e3d73a7`, emphasizing `bf90379` and `29e255f` after review baseline `83d84c9`. The subsequent `e4291e5`, `642441d`, `4467dd3`, `e60d48b`, `024e9c8` and `9881540` change only the plan/evidence record. In particular, `29e255f..e4291e5` is one plan-log insertion; the retained reports' different revision labels are valid and preserved.

CJ's 2026-11-14 approval and explicit interim-risk acceptance in the final amendment log make **Task 10 v2 and the matching Task 19/global-constraint amendments operative**, despite their historical “pending” headings. Raw AU three-month API availability/latency is assessed under that amendment, not reopened as a code finding. The original gate did not pass.

No database, staging runner, staging script, SQL, deployment or Git state-changing command was run. Read-only Node/Vite module probes used local saved evidence or synthetic objects. Only this review was authored; requested builds/type-checks generated their normal ignored output. No plan checkbox or historical evidence was changed.

## Must-fix

1. **R3-1 — Recheck cancellation at publication, after connection shutdown (remaining R2-2).** `tests/staging/caseParityMode.ts:85` and `:88` — `collectCaseParity.finish()` now detects cancellation through restoration, but `runCasesMode` then awaits `client.end()` and publishes without checking `io.signal` again. The runner's first SIGINT/SIGTERM merely aborts that signal. A signal during this await therefore produces a successful exit, COMPLETE report and eligible artifact despite cancellation before publication. Reproduced entirely in memory: inject the verified retained collection as the collector result and a fake `end()` that aborts; `signal.aborted` is true, yet `runCasesMode` returns COMPLETE and `checkParityArtifact` returns `[]`. **Minimal fix:** after the final await and before validation/artifact publication, persist a cancellation problem when the signal is aborted. Add a lifecycle test with deferred connection shutdown and an abort in that interval, asserting nonzero result, FAILED report/artifact and no subsequent performance timing or phase write. Preserve unconditional rollback/restoration. This is a narrow completion-boundary fix; it does not demonstrate corruption or cancellation of the retained collection.

2. **R3-2 — Restore render-time identity filtering in OrderLookupCard (regression while addressing R2-6 / r1 M4).** `src/pages/Reports.tsx:1010` — The session is created once, `setScope` runs in a passive effect, and the component immediately uses `view ?? session.view()` without comparing that view's scope with the current `scopeKey`. On the first render after changing site/account, old events, counts and order details remain selected until the effect clears them. The former implementation compared the lookup key with the current render's scope. The new tests call `setScope` before reading the view, so they miss this integration boundary. A read-only execution of the actual component's selection code with effects deferred selected `userA|au|1001` and AU events under both `userA|uk` and `userB|au`; running the effect then cleared them. **Minimal fix:** synchronously suppress the lookup/result/error view whenever its scope differs from the current render's scope, retaining the session's sequence invalidation. Test a resolved old result and a late response at site/account changes **before the effect runs**. A small pure selector used by the component can provide that regression test without a DOM dependency. Do not change Remove/ledger semantics.

These are the complete Must-fix list for this round. Both are specific regressions/remaining requirements, not requests for a redesign or another benchmark run.

## Should-fix

1. **S1 remains unverified at the browser lifecycle level; carry it into Task 20's existing Preview checks.** The coder correctly reports that this round added no focus/visibility lifecycle regression. Production and Welcome focus wiring and `snapshotCovers` guards are unchanged; pure tests do not simulate a delayed rollover timer followed by focus. A new DOM dependency is not needed for Task 10 approval. Task 20's carried browser evidence must explicitly exercise both consumers across site-local 04:00 with a delayed timer, focus/visibility recovery and an old response arriving late. Task 17 already requires current-day rollover with an old generation. This accepts the proposed browser-verification route, not a claim that S1 has been tested or a new dependency authorization.

## Nitpicks

None added. Approval is established by the final log; historical pending/FAILED wording must not be mistaken for current approval state or rewritten into passing execution evidence.

## Round 2 disposition and test verification

| Item | Verified implementation and tests | Disposition |
| --- | --- | --- |
| R2-1, invalidation/startup/claims/progress | `runCasesMode` writes a pending collection before settings/sign-in/connect; atomic report callbacks update on progress and heartbeat. Sign-in/connect failure, pending mid-collection artifact, stored claims failure, attempt hash and heartbeat cleanup tests pass. Gate tests reject failed/legacy artifacts before API timing or phase recording. Final checker errors are persisted. | Fixed for the reported startup/claims paths. The late cancellation boundary is R3-1. |
| R2-2, cancellation | Collector checks after each case and at `finish`, after rollback/fresh restoration. Tests cancel during the last restored read and fresh restoration; rollback/restoration remain unconditional. | Partly fixed; wrapper publication gap remains R3-1. |
| R2-3, authority/timeout | Original baseline catalog and retained installed hash are mandatory; collection stops on helper/grant/role-setting drift. Catalog invariants are checked again after rollback. Each identity records authenticated/non-bypass/RLS-on environment and exactly 8,000 ms. Missing-authority, matching drift on both sides and 30-second timeout tests pass. | Fixed. Supplied baseline identity/catalog also match independently inspected retained evidence. |
| R2-4, underlying evidence/hash | Checker recomputes policy hashes, verifies cutoff/bounds, collection/fixture/user identities, claims sizes, exact comparisons and restoration evidence/problems. SHA-256 uses recursively key-sorted canonical JSON of the entire collection. Tests cover same-count identity substitution, mixed collection, missing scope/claims, changed helpers and contradictory restoration. Earlier phase hashes are ineligible. | Fixed; real collection hash independently recomputed below. |
| R2-5, coverage/readers/cutoff | Positive rows are required at every member site, including `staging`; per-site other-worker counts prove staff exclusions and site-wide access. Full-history reads are cutoff-bounded. All 11 reader definitions retain selected fields, filters, ordering/limits, with fixed windows/cutoff and deterministic tie-breaking; ordered JSON results are compared. Missing staging/other-worker coverage and changed-field tests pass. The collector does not seed. | Fixed; approved retained probes supply the previously absent coverage. |
| R2-6, lifecycle/digest regressions | Eight real-session-module tests cover deferred site/account responses, shown-result clearing, search sequencing, late errors, reset and a 1,500-row order through the capped loader. The card actually uses this module. Digest's nine-case later-page failure matrix includes clock and staff-name errors/null bodies plus ledger failures; assertions prevent workbook/email. R1 response was corrected. | Requested tests now exist and pass, but the component integration introduces R3-2. |
| `29e255f`, exact binds | `readerParams` slices to the highest placeholder in each reader SQL. Fixed-window timesheet/export readers bind one value; cutoff readers two; order readers three. Every FakeDb query rejects unequal bind counts before dispatch. The explicit excess-bind test and full collector test pass. All 11 readers are covered by the bind-count assertion. | Fixed; retained real collection was captured after this correction. |

The real collector retains one connection/REPEATABLE READ transaction, independent case savepoints, nested exact pre-0036 policy restoration, outer ROLLBACK and a fresh restoration check outside that snapshot. `PRE_0036_RESTORE` remains shared with the write-compatibility rehearsal and matches the plan's rollback body without its transaction wrapper. No migration application/COMMIT is added. Existing rollback-error, nested-error and nonstandard-membership tests pass.

## Retained evidence verification

Read all eight requested git-ignored files: the five reports in Task 10 v2's retained-evidence table, `staging-results-item-counting-timeout-diag-1.md`, `staging-results-item-counting.policy-parity.json` and `staging-results-item-counting.phases.json`. No large row lists are copied here.

Using the repository's own `caseCollectionHash` / `canonicalJson` and `checkParityArtifact`, loaded through Vite without executing a runner:

- Collection: `90d3da63-cf68-4041-921d-aa1f4b43af47`, revision `29e255f`.
- Recomputed SHA-256: **`26330a488dc15dd2c89c3e26b15c0256d41dc6945a067e1f63df5b38d26eaa8b`**, exactly the approved table and all four phase reports. Artifact checker: **zero problems**.
- Fixture: `1de5d6235ca4471709e60945b3913257bbfaeecfae551c240fac7a7c204d5681`; AU/UK/US contain 155,432/42,340/42,340 events, plus two separate `staging` probes. All case stamps and fresh restoration identify this fixture.
- Restored pre-0036 policy: `2ce3f0db8fbfdc04c62993def22c0a5fcd8f10a558807df82993f5ab2aafa212`; installed: `b7884efe22600764525362bc13a976ecdf2f895489da6377ecd7f8257d7bb99b`.
- Baseline authority: revision `86dd1c3`, captured `2026-11-13T07:14:56.252Z`. Helpers, RLS flags, table grants, role configurations, v1/v2 definition/ACL fingerprints and membership-policy fingerprint match the original baseline on both sides and after restoration.
- Cutoff: `2026-11-12T00:00:00.000Z`; 28 history chunks, with the explicit cutoff on full-history reads. Five distinct synthetic users, real-session claims sizes 501–516 bytes, authenticated/non-bypass/RLS-on/8,000 ms environments. No claim values are reproduced.
- Baseline staff sees 30,018 own AU rows and one own staging row, zero foreign rows; another staging worker is present. Site-wide member roles see both staging rows. Manager gains positive UK/US access in all-sites; owner/kiosk independently lose UK and retain AU. No-subject reads are empty. Each read identity has all 44 reader/site combinations (11 readers × four sites); exact returned results agree before/after.
- Fresh restoration passed at **`2026-11-14T12:07:48.880Z`**, with empty problems, standard memberships, installed catalog and matching fixture. This verifies recorded evidence, not current database state.

All four phase reports identify that collection/hash. Their policy rows match the underlying installed catalog after accounting for the report renderer's newline flattening. V2 identity is consistently `load_production_evidence_v2`, definition `9b3098a4926cdb26bbda6c5869a79892`, encoding 2, harness `item-counting-gate-v2.3`. The phase JSON records denied-before at `29e255f` and all-sites at `e4291e5` with those full identities. It does **not** record a successful final denied-after for this hash; its `76f74d2` row belongs to the old `608b3e12…` collection and is historical only.

Parsed each retained phase report's 150 statement results, including its EXPLAIN text, full-body rows, independent expectations and field/dictionary comparisons. Rechecking those recorded SQL results with `checkSqlRuns` produced no problems after reconstructing the report formatting (policy newlines were restored only after comparing every rendered catalog field against the artifact; claims shape was checked against the full recorded shape). This is a saved-evidence consistency check, not fresh SQL or renewed session authentication. Each report retains **48 EXPLAINs and 36 full-body text runs** without SQL errors. Maximum recorded EXPLAIN execution times are respectively 1,933 / 2,804 / 3,992 / 4,083 ms; maximum full-body wall times 1,765 / 1,894 / 1,760 / 1,942 ms. The catalog/effective timeout remains 8 s.

## Separate criteria-level assessment under amended Task 10 v2

This assessment preserves every original report STATUS. It does not certify that the original all-or-nothing gate passed.

| Retained report | Revision; finished UTC | AU day median, owner / manager (ms) | Raw AU three-month evidence | Original result retained |
| --- | --- | --- | --- | --- |
| `staging-results-item-counting-v23r3-denied-before.md` | `29e255f`; 12:15:07.625 | 1,289 / 1,225 | All six attempts complete; medians 5,278 / 5,410. Manager first attempt 10,523 remains visible. | FAILED: awaiting all-sites and denied-after. |
| `staging-results-item-counting-v23r3-all-sites.md` | `29e255f`; 12:22:36.288 | 1,408 / 1,419 | Owner median 4,609; manager 13,327, **timeout**, 6,255. Its 9,791 successful-subset statistic is not a passing three-run median. | FAILED: manager AU three-month run 2, plus unrecorded phases. |
| `staging-results-item-counting-v23r3b-all-sites.md` | `e4291e5`; 12:56:26.986 | 1,371 / 1,320 | All attempts complete; owner/manager medians 6,536 / 4,772. Retained in addition to the earlier failed attempt. | FAILED: awaiting denied-after. |
| `staging-results-item-counting-v23r3b-denied-after.md` | `e4291e5`; 13:03:38.851 | 1,505 / 1,359 | Owner **timeout**, 9,567, 4,548; reported 7,058 averages two successes and is not acceptance. Manager median 5,110. | FAILED: owner AU three-month run 1 and unrecorded final phase. |

| Amended criterion | Assessment |
| --- | --- |
| CJ approval and interim-risk acceptance | Satisfied by final amendment log / `9881540`. No performance reliability guarantee follows from acceptance. |
| Complete four-case M6 evidence, original authority, exact identity/results, positive coverage, environment and restoration | Retained collection satisfies these evidence criteria; hash and underlying comparisons verified above. Collector publication still has R3-1, so overall M6 code sign-off is withheld. |
| Three distinct manager arrangements in order, reauthentication, owner and manager, six scopes × three attempts | Retained reports show denied-before → all-sites (including both attempts) → actual final denied-after, fresh-session evidence and memberships. Manager is `au,staging` before/after and all four sites during all-sites. Owner membership/access stays unchanged. Use final measured `e4291e5` denial, not the stale phase-history row. |
| Full direct SQL, correctness and non-disclosure retained | All four SQL result sets pass their retained checks. Independent AU day/three-month expectations are 1,313/118,244 evidence rows; window rows are 1,287/118,226. Permitted UK/US scopes have 56/5,152 rows. Denied manager scopes return zero with limited visibility; field/dictionary checks and empty-window checks pass. Staff SQL parity is retained; kiosk/CS/no-subject parity is in the underlying collection. |
| Operational one-day median paired total ≤2,000 ms; no failed attempt | Satisfied for every owner/manager/site in all four reports. First/slowest outliers remain: manager AU first calls 3,060 / 2,393 / 3,424 / 2,984 ms; final owner US slowest 2,330 ms. These do not fail the approved median criterion and are part of CJ's accepted risk. |
| Successful long-range responses complete/correct; all attempts retained | Successful AU responses retain 118,244 rows, one RPC and full validation/reduction; UK/US scope results remain correct and within their median targets. Both AU timeouts and above-10-second attempts are retained, never counted as successful runs. |
| Raw AU three-month API availability/latency acceptance | Superseded **only for Task 10** by the approved move to Task 19's published path. Neither timeout is excused as a SQL/parity success. Task 19 retains the targets, workload, failure rules, concurrency and 8 s timeout. |
| Existing write compatibility and old-app/v1 contract | Preserved: plan's separately recorded 30-step rehearsal remains history; shared restore body and write-compatibility tests remain unchanged/passing. No new source-write/stock/ledger changes. Browser old-app/capture/stock confirmation remains Task 20. |
| Local tests/review/CI/entitlement | Common checks pass; code review requires R3-1/R3-2. PR CI could not be confirmed. Entitlement remains a deployment blocker. No Task 10 checkbox is certified complete. |

The diagnostic at `4467dd3` is supporting history, not a substitute gate: first measured database execution 5,096 ms, later default-work_mem execution 1,686 ms; a transaction-local 64 MB comparison removed spill and measured 1,540–1,618 ms, then rollback restored 2,184 kB and postgres identity. It did not reproduce the API timeout or establish its production frequency/cause. `headersMs` includes API/network/database time and must not be labelled database execution. No timeout/work_mem change is approved or made here.

## Verification results

| Check | Fresh result |
| --- | --- |
| `npx.cmd tsc -b` | PASS, exit 0. |
| `npm.cmd run typecheck:digest` | PASS, exit 0. |
| `npm.cmd run test -- --run` | PASS, exit 0: **713 tests in 23 files**, including 35 collector/lifecycle tests, 22 policy-parity tests, 12 runner-gate tests, eight lookup-session tests, 34 digest-count tests and 318 S1 tests. |
| `npm.cmd run build` | PASS, exit 0: 2,890 modules transformed. |
| `gh pr list --head feature/item-counting --state all` | Could not check: HTTP 401 Bad credentials. No PR opened, edited or closed. |
| `gh run list --branch feature/item-counting --limit 5` | Could not check: HTTP 401 Bad credentials. No green CI assertion for reviewed HEAD. |

Existing build warnings: stale Browserslist data, mixed static/dynamic XLSX imports, main chunk 1,721.13 kB / 500.58 kB gzip exceeding the warning threshold. No dependency was added. In-memory counterexamples above are outside the passing suite; passing checks do not cover those boundaries. The component probe executed the selected source with hook/effect stubs, not a browser/DOM test.

## Hardening assessment

Every HARDENING question was considered within this follow-up scope; future summary architecture is not claimed implemented.

| Question | Assessment |
| --- | --- |
| Network/Supabase/external service slow/down | Explicit stale/unavailable reads and digest refusal remain. Raw long-range outage risk is accepted temporarily. Shopify/Dropbox/Slack/Make add no dependency here. |
| Retry/idempotency | Counting remains read-only; no capture/stock replay added. Pending attempt invalidation works, but cancelled certification still needs R3-1. |
| Concurrent users/devices | Snapshot/reducer identity and repeatable-read collection remain. Fixture/membership administration must not race collection; recorded fresh restoration matches. No new capture concurrency guarantee. |
| Bad input/unknown SKU/cancelled/foreign-site order | Existing strict counting, quantity, cancellation and unsupported-site tests pass. Lookup's display identity boundary regressed (R3-2). |
| Visible failure/recovery | Digest fails before workbook/email. Existing UI errors/retry remain; cancellation report must fail under R3-1. Successful saves must not be replayed for failed KPI refresh. |
| Person/department attribution | Saved attribution and microsecond chronology retained; old lookup scope must not appear under another identity (R3-2). |
| One shared counts rule | Classifier/reducer remains shared by Reports, Welcome, Production and digest. Follow-up introduces no second rule. |
| History after administrative changes | Saved facts are recomputed without source rewrite or new attribution assumptions. |
| UTC/site-local display | Independent 04:00/DST boundaries and exact instants retain tests; S1 focus lifecycle remains explicit browser work. |
| Inferred/manual versus measured | Coverage and missing-detail labels remain; no guessed pieces or new inferred credit. Existing timing interpretation stays separate. |
| Endpoint authentication/input | No new endpoint; 318 S1 tests pass, including auth-first behavior and existing validation. |
| RLS/new tables/roles | No new table in follow-up. Retained catalog/role/site parity verifies the two-policy change; v1/v2 remain invoker with restricted execution. |
| Secrets | Claims stay in memory/bound SQL; evidence stores synthetic identities, sizes and hashes. No environment secret was read, added or copied. |
| Cost/spam/data exposure | No new external calls, schedules or recipient behavior. R3-2 fixes cached display isolation. Future worker expenditure remains entitlement-gated. |
| Expand-only/old-code compatibility | Main-to-branch adds 0034–0036; no existing migration edited. Follow-up adds no migration. Approved equivalent SELECT replacement preserves write policies/helpers/grants; browser rehearsal remains pending. |
| Feature flag/off switch | Existing read-only F1 uses the documented S1-protected app rollback. Future summary read modes belong to unstarted tasks. |
| Exact CJ release sequence | Plan records staging, CI, entitlement, migration reconciliation, protected rollout and rollback. No release action authorized/performed by this review. |
| Staging per role | Five roles/no-subject and all four arrangements verified from retained evidence. Preview role/capture flows remain Task 20. |
| Months-of-history query cost | Full retained SQL checks pass. Raw long-range API reliability remains unproven/temporarily accepted; Task 19 must prove published path. No index or timeout waiver. |
| External API per item | None introduced. Ancillary digest paging remains complete or fails explicitly. |
| Two years / three sites | Retained fixture and six scopes verified. Five-year/10-times/20-reader evidence is future Task 19, not missing M6 implementation. |
| Detect production failure | Existing coverage/cutoff/error states and RPC/digest monitoring remain. Cancellation certification needs R3-1. |
| Manual shop-floor fallback | Capture remains independent of report refresh; protected rollback and smaller supported views are documented. Never sum daily distinct Orders to fabricate a long range. |
| Ongoing maintenance | Monitor RPC 57014/HTTP errors, slow-report complaints and scheduled digest outcomes; keep retained failures. No new token/subscription lifecycle in this follow-up. |
| Pure logic/edge tests | Full suite passes; concrete publication/render boundaries need the two specified regressions. |
| Inventory/credit/money old/new tests | Routing, set/packaging/capture, chronology and denominator regressions pass. No stock/ledger implementation changes; real browser smoke remains a release gate. |

`Repository.ts`, DexieRepo and SupabaseRepo remain unchanged, consistent with the documented direct-Supabase production scope. New files fit the whitelist. All eight evidence files are ignored; CI contains the staging-secret/result leak check and append-only migration check. The earlier `pg`/`@types/pg` development dependency is justified in the plan; these fixes add no dependency. The single-writer, no-commit and planner-only boundaries were respected.

## Release/deployment blockers and handoff

- **Code review:** resolve R3-1 and R3-2. This is the last allowed round: stop and report these exact gaps to CJ; do not start round 4, automatically rerun staging, or advance Tasks 11–20 on this review. Retained evidence is verified but does not erase the code findings. Any relevant code/fixture/schema change is subject to Task 10 v2's explicit evidence-disposition rule, not automatic recollection or silent reuse.
- **Vercel entitlement is unobserved and blocks deployment:** team “Inka Arthouse's projects”, project `inka-arthouse-hub`; CJ must record 15-minute scheduling, 300-second Node runtime, approximately 288 scheduled calls/day plus bounded manual/retry work, and budget. This review supplies no entitlement or purchase authorization. Staging target remains `ybrzhrgfrnvtcwymjdrq`.
- **Task 9 Preview/browser checklist remains carried to Task 20:** five-role/site/account flows, S1 rollover scenario above, capture/retry/stock/ledger smoke, dry digest/runtime/consumer reconciliation, Dexie fallback, old-app compatibility and protected rollback. These are release blockers, not additional code findings.
- **Green PR CI remains unconfirmed:** both requested `gh` commands failed authentication. Record green CI for the committed handoff before treating Task 10's CI prerequisite or release gate as complete.
- **Task 19 published-path long-range acceptance remains a release blocker:** unchanged targets, correctness/security, original and growth workloads, concurrency, freshness, recovery and capture regression limits. Task 17 alone cannot discharge it; accepted interim risk lasts until the published path is enabled after its gates.

Tasks 11–20 are not reviewed as missing. No merge, deployment or SQL application is authorized; those remain CJ's steps. Review execution is complete; Task 10/M6 approval is withheld for the two Must-fix items.

## Coder response

Fixed in `7a4a323` (Claude, 2026-11-14), under CJ's overnight delegation. No staging run, no fourth review started.

- **R3-1:** `tests/staging/caseParityMode.ts`: after the connection is closed and before validation/publication, `runCasesMode` adds `CANCELLED_AT_PUBLICATION` ("cancelled before publication") to the collection's problems when the signal is aborted. Rollback and the fresh restoration check stay unconditional.
  - New lifecycle test in `tests/staging/policyParityRun.test.ts`: a clean collection whose `end()` aborts the signal and waits on a deferred promise. It asserts:
    - exit code 1;
    - a FAILED status and report;
    - the problem is stored in the artifact;
    - `checkParityArtifact` rejects the artifact. The gate reads this artifact before any API timing or phase write, and existing gate tests prove a failing artifact blocks both;
    - rollback and restoration were recorded.
  - Removing the fix makes that test fail.
- **R3-2:** new pure `viewForScope(view, scopeKey)` in `src/lib/repository/supabase/orderLookupSession.ts`. It returns an empty view when the view's scope differs from the current render's scope.
  - `OrderLookupCard` (`src/pages/Reports.tsx`) renders `viewForScope(view ?? session.view(), scopeKey)`. The session's sequence invalidation is unchanged. `runSearch` calls `setScope` before searching, so a search can never start under the old scope. Remove/ledger semantics are unchanged.
  - Four new tests render at the new scope before `setScope` runs: a resolved old-site result, another account at the same site, a late old-scope response arriving before the effect, and an old-scope error.
  - Making the selector pass views through makes all four fail.
- Gate: `npx tsc -b` OK, `npm run typecheck:digest` OK, 718/718 tests, build OK.
- **Evidence disposition (for the planner):** R3-1 changes only the publication boundary of a cancelled run. The retained collection `90d3da63…` was not cancelled, and its hash was verified in this review; its collected data and checks are unchanged. R3-2 is app UI code outside the parity harness. My view is that neither change affects the retained Task 10 v2 evidence, but under v2's evidence-disposition rule that is the planner's call. Round 3 was the last allowed review round, so a planner decision is needed on accepting these fixes without a round 4.

STATUS: COMPLETE
