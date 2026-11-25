# Review: Shared scanner station tuning — round 2

- Slug: `scanner-stations-tuning` · Branch: `feature/scanner-stations-tuning` · Reviewed commit: `53ba51d14477e31ded6443709cddcd53f49b50b1`
- Reviewer: planner (Codex)
- Date: 2026-11-25
- Verdict: **approved**

All five round-one items are fixed. The follow-up adds meaningful regressions for classifier precedence, bounded labels, a genuinely deferred activation reply, and setup copy. I found no new blocking defect in the tuning feature. Approval covers implementation review; green PR CI, the approved staging run and physical scanner commissioning remain release gates for CJ. The six reporting failures are independently confirmed as checkout line-ending failures, not tuning regressions.

## Checked against

- [x] Spec acceptance criteria — assessed individually below, distinguishing local evidence from staging requirements.
- [x] Plan tasks — all six implementations, their log entries, round-one findings and the coder response reviewed.
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist).
- [x] `docs/HARDENING.md`, every section and question — matrix below.
- [x] Roadmap decisions for this feature (`docs/ROADMAP.md`) and `docs/ARCHITECTURE.md` context.
- [ ] Tests cover the new logic; type-check, tests and build pass — new scanner coverage passes and type-check passes, but the literal test/build commands encounter a sandbox config-loading error. Equivalent-config checks run successfully, with six independently explained reporting test failures. This is not an unqualified all-green CLI/CI claim.

### Comparison scope

The working tree was initially clean and HEAD is the requested feature branch. Local `main` is `57b89d2bec371c2aca66c2098fa2e57c7e3d73a7`, an old baseline; its literal three-dot comparison includes hundreds of unrelated files. I inspected that comparison and isolated the tuning series using its immediate pre-feature parent, the existing `origin/main` at `6abe773c6b1a1ef002759b37375cb95cf8f8f448`. No fetch or ref-changing command was run. Round-two fixes are in `53ba51d`, following the reviewed implementation at `293ef5c` and review-document commit `13124b7`.

The scoped implementation touches scanner preparation, session/controller state, a protocol comment, shared scanner wall/setup/hook wiring and tests. The two `scanner-wall-redesign` documents were excluded as requested; their requirements were not applied to this feature. Recorded CJ approval and the A0 answer (“we ignore accessories”) govern despite historical draft/proposal wording in the documents.

There are no tuning changes to migrations, server endpoints/RPC contracts, Repository or either adapter, shared SKU/packaging helpers, Dispatch preparation, outbox storage, dependencies, environment configuration or top-level paths. The test-file organization and internal type/field names differ slightly from illustrative plan interfaces without changing the approved behavior. `git diff --check origin/main HEAD -- src/lib/scanners src/components/production/scanners` passed.

## Must-fix

None. Round-one M1 and M2 are closed; no new must-fix item found.

## Should-fix

None within this feature. Round-one S1, S2 and S3 are closed. Pending release evidence is recorded below rather than presented as a code defect.

## Nitpicks

None raised.

## Round-one closure evidence

| Item | Verified correction and evidence |
| --- | --- |
| **M1 — Promotional words silently exclude unidentified framing** | **Fixed.** `src/lib/scanners/order.ts:131` replaces isolated `free`/`gift`/`bag` matches with category phrases. `src/lib/scanners/__tests__/order.test.ts:91` checks free shipping, gift wrapping and an included bag; the mixed free-shipping fixture returns `suspicious_framing` without a prepared payload. `src/lib/scanners/__tests__/outbox.test.ts:234` proves that mixed job never calls commit. These tests passed in this review. |
| **M2 — Nonblank accessory SKU defeats category precedence** | **Fixed.** `src/lib/scanners/order.ts:182` applies explicit category evidence to both blank and unrecognized nonblank SKUs. The preceding framed-suffix/artwork-stem safeguards still refuse malformed framed-shaped SKUs. `src/lib/scanners/__tests__/order.test.ts:103` covers HOOK-01, GIFT-BAG-01, KIT-9, SAMPLE-1 and PF-OLD; line 117 covers regular/A0 mixed preparation, unchanged lookup, exact A0 components and packaging equal to the accessory-free order. All passed. |
| **S1 — Unbounded label and missing variant fallback** | **Fixed.** `src/lib/scanners/order.ts:146` sets the 80-character bound; `lineLabel` at line 148 chooses normalized SKU, title, variant, then unnamed fallback, with an ellipsis when truncated. `src/lib/scanners/__tests__/order.test.ts:138` checks a 10,000-character title and variant-only context. Rendering remains text. |
| **S2 — Combined late-reply test did not defer a reply** | **Fixed.** `src/lib/scanners/__tests__/tuning-e2e.test.ts:149` now holds repeat 2's activation with a deferred promise (line 159), feeds a real mismatched-marker parser error while it is pending, then releases it (line 166). Assertions prove restored Alice identity, no restored gesture, persistent recovery, restart at 1/3 and eventual local sign-out with exactly five total activation calls. It passed. |
| **S3 — Setup copy and render coverage** | **Fixed.** `src/components/production/scanners/SharedScannerStation.tsx:149` says “at least one second apart.” `src/components/production/scanners/__tests__/SharedScannerSetup.test.tsx:12` verifies the 15-minute Framing label and guidance; line 19 verifies Dispatch's once-per-shift label and absence of gesture guidance. Both passed. |

## Evidence

### Fresh verification

Commands used the current reviewed checkout. The Windows `.cmd` entry points were used without changing PowerShell execution policy. No production or hosted staging connection was made.

| Check | Observed result |
| --- | --- |
| `npx.cmd tsc -b` | **Exit 0.** |
| `npm.cmd run test -- --run` | **Exit 1 before test collection.** esbuild could not read an ancestor directory and could not resolve the Vite config under this Windows sandbox. This invocation did not reach the six reporting assertions. |
| `npm.cmd run build` | **Exit 1 at Vite config loading**, with the same ancestor-directory access denial after the TypeScript stage. |
| Full Vitest run, equivalent config supplied in memory | **Exit 1: 3,613 passed / 6 failed; 155 test files passed / 3 failed, 158 files and 3,619 tests total.** Duration 181.44 seconds. All **205 scanner and scanner-component tests** passed, including Dispatch and the new round-one regressions. No SQL normalization was used in this full run. |
| Vite production build, equivalent config supplied in memory | **Exit 0**, 2,984 modules transformed, 18.14 seconds. Existing warnings: old Browserslist data, mixed static/dynamic XLSX imports, and large chunks (main JS approximately 1.81 MB). |
| Diagnostic rerun of the three affected reporting files with migration reads normalized to LF in memory | **Exit 0: 269/269 tests passed**, three files, 1.76 seconds. No migration or test file was edited. |

The fallback configuration reproduces `vite.config.ts`: React plugin and `@` resolving to the checkout's `src`. It disables only config-file loading. Entry points were passed to Node on stdin:

```js
// Full tests: imports from vitest/node, @vitejs/plugin-react and node:path.
const ctx = await startVitest("test", [], { run: true, config: false }, {
  configFile: false,
  plugins: [react()],
  resolve: { alias: { "@": path.resolve("src") } },
});
await ctx?.close();

// Build, separately: build imported from vite.
await build({
  configFile: false,
  plugins: [react()],
  resolve: { alias: { "@": path.resolve("src") } },
});
```

These are supplemental checks, not a claim that the literal test/build commands passed. Verification generated ordinary ignored build/cache artifacts; only this review document was authored.

### Independent CRLF investigation

The six failures were reproduced and traced:

- `tests/reporting/reportingJobs.test.ts:45`: raw migration 0037 SHA-256 differs from its pinned LF hash.
- `tests/reporting/reportingDependencyRehearsal.test.ts:449`: CRLF SQL statement strings differ from expected LF strings. This one is a string-equality assertion, not a hash assertion.
- `tests/reporting/reportingDependencyPlans.test.ts:577`, `:619`, `:624`, `:636`: effective-function identity checking fails at A1 because the scripted database and migration reader use different line endings, preventing the intended downstream checks.

Using byte-preserving `git show` subprocess output, I compared disk bytes, LF-normalized bytes, HEAD blobs and pre-tuning `origin/main` blobs:

| Migration | CRLF sequences on disk | Replacing only CRLF with LF equals both HEAD and pre-tuning blob |
| --- | ---: | --- |
| `0037_reporting_storage.sql` | 559 | Yes |
| `0040_reporting_dependency_reads.sql` | 345 | Yes |
| `0041_reporting_dependency_read_bounds.sql` | 339 | Yes |
| `0042_reporting_access_paths.sql` | 245 | Yes |

0037's raw SHA-256 is `b745252780a61fe1739957a2fe4881900a44b156d3ac89252db6c5a9bd737baa`; LF normalization gives the expected `531bb2c5706b9ac4d73a7ca3dc74dead7e34a53160e57fe2971aaf061c6a6a4f`. The tuning diff contains no migration, reporting-test or relevant reporting-helper change.

For a causal check, the diagnostic run supplied a `data:` URL Node preload through Vitest's `poolOptions.threads.execArgv`. It wrapped `fs.readFileSync` only for `supabase/migrations/*.sql`, converted CRLF to LF in returned values, preserved Buffer/string return types, and called `syncBuiltinESMExports`. All 269 affected-file tests then passed. An initial diagnostic attempt passed `execArgv` at the wrong Vitest option level and left the same six failures unchanged; the corrected worker option produced the passing result above. Neither attempt modified disk contents. This confirms the line-ending explanation independently; it does not claim a fresh run of the stale local `main` branch.

### Acceptance criteria and plan coverage

| Criterion / tasks | Assessment |
| --- | --- |
| 1. Corruption recovery (Tasks 3/6) | Meets the local contract. `station.ts:164` preserves identities and pending activations while cancelling the applicable gesture; `station.ts:195` uses input sequence ordering to clear recovery only after a newer good scan. `SharedScannerWall.tsx:187` renders recovery separately from ordinary results. Tests cover every parser error reason, both modes, same-time ordering, old delivery/activation responses, refused/storage-failed scans, real parser corruption and the unchanged 400 ms quiet boundary. Parser changes are comment-only. |
| 2. Framing-only selection and atomic suspicious refusal (Tasks 1/2) | Meets the contract after M1/M2 fixes. `order.ts:206` retains whole-order preflight; classification and preparation select supported regular/A0/set/GW framing, ignore approved categories and irrelevant quantities, and refuse suspicious or empty selections with the approved text. No lookup mutation, catalogue inference or global grammar change. |
| 3. Counts, A0 components/boxes, duplicate/atomic behavior (Tasks 2/6) | Raw per-SKU aggregation and existing piece multiplier remain; selected quantity and aggregate bounds are tested. `order.ts:284` and `:300` derive A0 components and packaging from the selected subset using existing helpers. Regular stock remains a Dispatch responsibility. Missing stock/rules/unresolved packaging and header refusals remain tested. `outbox.test.ts:166` proves exact replay of an old accessory-inclusive prepared A0 job after reload/lost response. `client.ts:588` prepares only queued jobs; server-confirmed totals remain authoritative. Actual database rollback and concurrent exactly-once behavior remain staging evidence requirements. |
| 4. Fifteen-minute Framing timeout, unchanged Dispatch (Task 4) | Meets the contract. `session.ts:12` sets 900,000 ms while retaining strict `>` expiry. Fresh fixtures cover 600,001, 899,999, 900,000 and 900,001 ms. Successful activation/enqueue-path acceptance remains the activity basis; corruption/suppression/delivery do not extend it. Countdown, setup and refusal/tick copy agree. Dispatch retains absolute site-workday/max-shift expiry and its existing preparation/selection flow. |
| 5. Deliberate local sign-out (Tasks 5/6) | Meets the local contract. `session.ts:193` implements initial-scan exclusion, the rolling 1,000 ms guard and inclusive 10,000 ms window; `session.ts:325` validates asynchronous progress by generation/person/window. Tests cover exact boundaries, delayed replies, cancellation, expiry/reset, offline refusal, numeric badge/order distinction, other-slot independence and no third activation. Per-slot progress and suppression render independently of other results. Captured/queued attribution stays unchanged. Actual clock-in deduplication/no clock-out and physical held-badge behavior require staging/hardware inspection. |

## Hardening and guardrail audit

Each row addresses a question in `docs/HARDENING.md`. “Unchanged” refers to the isolated tuning diff, not unrelated work included by stale local `main`.

| Checklist question | Review evidence / disposition |
| --- | --- |
| 1 — Network/Supabase/Shopify slow or down | Existing durable scoped queue, retry/backoff and online-only badge handling remain. Storage, offline and auth failures are visible; outbox/controller regressions passed. Dropbox/Slack/Make are n/a: no calls added. |
| 1 — Retry / duplicate writes | Request IDs and prepared payloads remain immutable. Old/new preparation, lost-response replay and already-recorded handling pass; no new server write path. |
| 1 — Concurrent people/devices | Synchronous attribution capture, per-slot epochs and queue leases are retained and tested. Existing server order locks/classic coordination are unchanged; actual multi-session race evidence remains a staging gate. |
| 1 — Bad input / unknown barcode / missing SKU / cancelled or wrong-site order | Strict parser and badge-first authorization remain; r1 classifier defects are fixed. Header completeness, exact order, cancellation, edit-tag/open-case and line bounds still run before selection. Caller/site validation remains server-enforced. |
| 1 — Failure display and recovery | Persistent recovery cannot be dismissed by older replies or failed writes. Blocked, rejected, queued, already-recorded and uncertain states retain their distinctions; uncertain work is not offered for duplicate classic recording. |
| 2 — Person/department attribution | Identity is captured before awaits. Local sign-out cannot rebind queued jobs or rewrite department snapshots. The garbled-badge/previous-worker risk and longer unattended interval are explicitly accepted by CJ; recovery instructs badge rescanning. |
| 2 — Counts / orders / sets | Existing multiplier, component routing and packaging rules are reused; raw quantities stay raw, saved display uses server totals. No parallel counting formula was introduced. |
| 2 — History after settings/person changes | No historical reclassification or migration; saved payloads/events/receipts remain unchanged on retry or rollback. |
| 2 — UTC / site-local time | Captured scan timestamps still serialize to UTC; gestures use `performance.now()` from the hook. Site-aware Dispatch workday calculation remains unchanged. Its existing display uses browser-local `toLocaleTimeString`, so receiver timezone setup remains a commissioning consideration, not a new tuning regression. |
| 2 — Manual/inferred versus measured | No new inferred metric. Existing Dispatch manual attribution labels and behavior are unchanged. |
| 3 — Endpoint authentication / validation | No new endpoint. Existing JWT, role/site, caller and badge validation remain. Staff/CS/anonymous/cross-site hosted denial checks are retained in the staging plan. |
| 3 — RLS / grants | No table or policy change; new-table RLS is n/a. Existing owner/manager/kiosk restrictions remain. |
| 3 — Secrets / logs / messages | No secret, environment or logging changes and no new external messages. |
| 3 — Cost / spam / exposure | No API per line, email path or new data exposure. Rapid reads suppress activation; deliberate first/second repeats reuse the existing RPC. Existing bounded inputs remain. |
| 4 — Expand-only / previous app compatibility | No migration or Repository/storage contract change. Exact old prepared-payload replay has passing coverage. |
| 4 — Switch-off without deployment | Existing Classic station exit remains, retaining queues. Resolve uncertain work with its original request before using classic. |
| 4 — Release sequence / external configuration | Plan specifies CJ's staging/CI/review gates, previous-deployment record, quiet release, receiver refresh and monitoring; no new SQL, env, Make, Slack or Shopify setup. Rollback keeps queue, receipts and ledger. |
| 4 — Staging per role | Approved spec covers kiosk flow/hardware, owner/manager event-stock-health inspection and denied roles/cross-site callers on inka-staging-2, plus release smoke tests. Not executed here. CJ's A0 accessory decision is recorded and is not reopened. |
| 5 — Queries over months of events | No new historical query; existing bounded/indexed server reads remain. |
| 5 — External API per item | None added. Classification is local across the existing maximum 50 lines. |
| 5 — Two years / three sites | At most three gesture slots, bounded queue and existing scope keys; new work does not grow with event history. Refusal labels are now bounded. |
| 6 — Detecting production failures | Existing heartbeat/silence, focus/audio/auth/storage and blocked/uncertain indicators remain; corruption gets persistent recovery. No new remote alert is claimed. |
| 6 — Manual fallback | Classic remains the fallback for definite refusals. Uncertain commit safeguards remain and pass tests. |
| 6 — Maintenance / monitoring | Existing receipt/device-storage growth and token maintenance remain; no new retention store or subscription. Plan requires monitoring attribution, queues, stock/boxes and clock events; never clear browser storage to recover. |
| 7 — Pure logic / edge cases | All 205 scanner/component tests pass: classification, session timing/cancellation, real-parser flow, replay, wall/setup and unchanged Dispatch. |
| 7 — Inventory / credit / money, old and new | Selected new A0 payload and old accessory-inclusive replay coverage pass. Actual RPC/ledger all-or-nothing failure and exactly-once races remain CJ's staging checks; mocks/manifests are not substituted for them. |

AGENTS.md guardrails are satisfied within the tuning scope: scanners remain intentionally Supabase-only with no new Repository obligation for Dexie; migrations are untouched; no dependencies, secrets or root whitelist additions; changed stock preparation has old/new tests. Six task commits and Implementation log entries exist. The literal local test/build and green-PR-CI portions of the definition of done are not certified by this review; see the explicit verification limitations above.

## Remaining release evidence

Before release, CJ must obtain green PR CI and record the approved inka-staging-2 run: real activation clock-in deduplication/no clock-out, 10–15-minute idle survival and >15-minute refusal, selected regular/A0/set credit/components/boxes, A0 packaging-failure rollback, duplicate/partial/classic/shared races, lost-response replay, old queued payload handling, role/site denial, health/classic fallback and release smoke tests. Commission actual scanner same-barcode suppression and deliberate gesture timing; a keyboard wedge cannot prove physical trigger release. Approval here does not authorize agents to merge, deploy or apply SQL.

## Coder response

No code changes requested by round 2. Record subsequent CI/staging evidence through the approved release handoff.

STATUS: COMPLETE
