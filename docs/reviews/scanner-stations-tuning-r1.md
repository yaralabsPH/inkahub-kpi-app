# Review: Shared scanner station tuning — round 1

- Slug: `scanner-stations-tuning` · Branch: `feature/scanner-stations-tuning` · Reviewed commit: `293ef5c91220bce23cfe9355d0b747368354e682`
- Reviewer: planner (Codex)
- Date: 2026-11-25
- Verdict: **changes required**

The recovery, idle-expiry, gesture and immutable-retry changes are substantially implemented. Two classifier defects break acceptance criterion 2: one can silently omit an unidentified framed print from an otherwise successful save; the other rejects explicitly excluded accessories. Fix both before approval. The six existing reporting failures are independently confirmed as line-ending failures, not tuning regressions.

## Checked against

- [x] Spec acceptance criteria — evaluated individually below; criterion 2 fails.
- [x] Plan tasks — reviewed all six task commits and the Implementation log; coverage gaps are called out below.
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist).
- [x] `docs/HARDENING.md`, every section and question — matrix below.
- [x] Roadmap decisions for this feature (`docs/ROADMAP.md`) and the context in `docs/ARCHITECTURE.md`.
- [ ] Tests cover the new logic; type-check, tests and build pass — type-check and equivalent-config build pass; full suite has six independently explained baseline failures; new classifier regressions need tests. CI and hosted staging are not verified here.

### Comparison scope

The local `main` ref is stale: `57b89d2bec371c2aca66c2098fa2e57c7e3d73a7` (PR #6). A literal `main...feature/scanner-stations-tuning` comparison includes 583 files of earlier work. The existing `origin/main` ref is `6abe773c6b1a1ef002759b37375cb95cf8f8f448` (PR #26), also the immediate parent of the tuning documentation/implementation series. I inspected the literal comparison, then isolated `6abe773..293ef5c` for this feature. No refs were fetched or changed.

The six implementation commits are `90b27c9`, `33af22d`, `21268d5`, `6ab78e0`, `7a2accf`, and `293ef5c`, each named `task N: ...`. The two `scanner-wall-redesign` documents in that range were excluded as instructed. No redesign requirement was used to judge this implementation. CJ's recorded spec/plan approval and A0 accessory answer take precedence over historical draft wording.

The scoped source changes are confined to scanner preparation/session/controller, a parser comment, the shared wall/setup/hook, and scanner tests. There are **no tuning changes** to migrations, API/server contracts, Repository or either backend, shared SKU/packaging helpers, Dispatch preparation, outbox storage, dependencies, environment configuration or top-level paths. The additional `signout.test.ts` and `tuning-e2e.test.ts` files are test organization within the approved scope. `git diff --check origin/main HEAD -- src/lib/scanners src/components/production/scanners` passed.

## Must-fix

1. **M1 — High: a broad exclusion word silently drops an unidentified framed print.** `src/lib/scanners/order.ts:127` and `src/lib/scanners/order.ts:153` classify a blank-SKU line as ignored when its title/variant contains any standalone `free`, `gift`, `bag`, etc., before checking framed intent. Executing the actual exported functions with `{ sku: null, title: "Framed print with free shipping", quantity: 1 }` returned `ignored`. When paired with one valid `INKA-ABC0001-A2-FB` line, `prepareFramingOrder` returned `ok: true`, `pieces: 1`, omitting the malformed framed line. Free shipping does not identify a free print/sample. The approved safeguard requires this whole scan to return `suspicious_framing`, with no prepared payload. Narrow exclusion evidence to the explicit product categories rather than isolated promotional words; retain the approved free-print/sample exclusions and do not infer or repair SKUs. Add classifier, mixed-order atomic-refusal and no-commit regressions for this case.

2. **M2 — Medium: explicit exclusions lose precedence when an accessory has a nonempty legacy/arbitrary SKU.** `src/lib/scanners/order.ts:152` and `src/lib/scanners/order.ts:158` apply title-based exclusion only when `!sku`. Actual executions with `{ sku: "HOOK-01", title: "Hook for framed prints", quantity: 1 }` and `{ sku: "GIFT-BAG-01", title: "Gift bag for framed prints", quantity: 1 }` both returned `suspicious`; adding either to a valid framed order rejected the entire order. The same hook title with a blank SKU is ignored. These are explicitly excluded categories, and the spec says their evidence outranks the word “framed”; arbitrary accessory SKUs must be allowed. Apply narrowly defined category evidence consistently to unrecognized nonempty SKUs as well as blank ones, while preserving refusal for genuinely unidentified framed prints. Add both regular and A0 mixed-order fixtures proving silent exclusion, unchanged original lookup, and no accessory credit/components/box contents. Fix this together with M1; simply broadening the existing word regex would preserve M1's undercount risk.

## Should-fix

1. **S1 — Bound the identifying label and retain variant-only context.** `src/lib/scanners/order.ts:140` copies the entire SKU/title into the refusal and ignores `variant_title` when choosing the label. Task 1 explicitly calls for a bounded SKU/title/variant label. A direct probe with a blank SKU and a 10,013-character framed title produced a 10,013-character label. Truncate to a documented sensible display bound, use variant text when title/SKU are empty, and test the fallback. React renders this as text, so this is a readability/size issue, not an HTML-injection finding.

2. **S2 — Make the combined late-reply test exercise a late reply.** `src/lib/scanners/__tests__/tuning-e2e.test.ts:147` is named “cancelled sign-out progress stays cancelled through corruption and a late reply,” but settles activation before corruption at line 152; its activation stub resolves immediately. No activation reply spans the corruption. Use a deferred repeat activation, feed a real parser error while it is pending, then resolve it and prove identity survives while progress/recovery do not revive incorrectly. The pure-session cancellation tests provide useful coverage already; the claimed combined asynchronous case is missing.

3. **S3 — Complete the setup-copy coverage promised by Tasks 4–5.** `src/components/production/scanners/SharedScannerStation.tsx:144` has the updated 15-minute label and Framing guidance, but the planned `SharedScannerSetup.test.tsx` was not added. Add static-render checks for the Framing timeout/guidance and Dispatch's unchanged once-per-shift text/absence of gesture guidance. Prefer “at least one second apart” to “about a second apart” at line 149 so setup accurately states the inclusive 1,000 ms minimum. Existing wall tests cover 15:00/14:00 and scanner-local progress; they do not render setup.

## Nitpicks

None beyond the actionable items above. Historical draft labels and unticked task sub-bullets should not be treated as a missing CJ approval; that approval is expressly recorded in the plan and supplied in the review request.

## Evidence

### Fresh checks and environment limitations

All checks used the reviewed working tree, which was initially clean. PowerShell's `npm.ps1`/`npx.ps1` wrappers are disabled by execution policy, so their `.cmd` equivalents were used without changing policy.

| Check | Observed result |
| --- | --- |
| `npx.cmd tsc -b` | Exit 0. |
| `npm.cmd run test -- --run` | Exit 1 before collecting tests: esbuild could not load Vite config because an ancestor-directory read was denied by the Windows sandbox. This invocation did not produce the six test failures. |
| `npm.cmd run build` | Exit 1 at Vite config loading with the same sandbox issue, after the TypeScript stage. |
| Full Vitest run with equivalent configuration supplied in memory | Exit 1: **3,607 passed, 6 failed; 154 test files passed, 3 failed; 157 files / 3,613 tests total**. Duration 178.13 seconds. All scanner and scanner-wall tests passed. |
| Vite production build with equivalent configuration supplied in memory | Exit 0: 2,984 modules transformed, build completed in 33.64 seconds. Existing warnings: old Browserslist data, mixed static/dynamic XLSX imports, and large chunks (main chunk about 1.81 MB). |
| Three affected reporting files, diagnostic LF-only migration reads | Exit 0: **269/269 passed** across 3 files. No migration or test file was edited. |
| Direct classifier/preparation probes | Reproduced M1, M2 and S1 by transpiling the existing TypeScript modules in memory and calling their actual exports; no replacement classifier or source edits. |

The equivalent configuration was copied from `vite.config.ts`: React plugin plus `@` resolving to `path.resolve("src")`. Only config-file loading was disabled. The full test run did **not** normalize SQL or change tests. The fallback entry points, passed to Node on stdin, were:

```js
// Tests
const ctx = await startVitest("test", [], { run: true, config: false }, {
  configFile: false,
  plugins: [react()],
  resolve: { alias: { "@": path.resolve("src") } },
});
await ctx?.close();

// Build, separately
await build({
  configFile: false,
  plugins: [react()],
  resolve: { alias: { "@": path.resolve("src") } },
});
```

These use `startVitest` from `vitest/node`, `build` from `vite`, `react` from `@vitejs/plugin-react`, and `path` from `node:path`. They are supplemental verification, not a claim that the original CLI invocations passed in this sandbox.

### Independent CRLF verification

The six failures were:

- `tests/reporting/reportingJobs.test.ts:45`: raw SHA-256 of migration 0037 differs from its LF pin (1 test).
- `tests/reporting/reportingDependencyRehearsal.test.ts:449`: actual SQL statement strings contain CRLF while expected strings are LF (1 test). This is a direct string comparison, not a hash assertion.
- `tests/reporting/reportingDependencyPlans.test.ts:577`, `:619`, `:624`, `:636`: effective-function identity validation fails at A1 before the intended later assertions (4 tests). The scripted database constructs hashes from LF text; the injected migration reader returns raw CRLF bytes.

I checked migration bytes directly with `readFileSync`, SHA-256, and byte-preserving `git show` subprocess results. Migrations 0037/0040/0041/0042 contain respectively 559/345/339/245 CRLF sequences. Replacing only CRLF with LF makes **each byte-identical to its HEAD git blob and its `origin/main` blob**. For 0037, the raw SHA is `b745252780a61fe1739957a2fe4881900a44b156d3ac89252db6c5a9bd737baa`; its LF SHA is the test's expected `531bb2c5706b9ac4d73a7ca3dc74dead7e34a53160e57fe2971aaf061c6a6a4f`.

For a causal check, I reran only the three affected test files with a Node worker preload supplied as a `data:` URL. It wrapped `fs.readFileSync` solely for `supabase/migrations/*.sql`, converted CRLF to LF in the returned value, preserved Buffer/string return types, and synchronized the built-in ESM exports. All 269 tests passed. Nothing on disk was normalized. The tuning diff changes neither these tests, their reporting helpers, nor any migration. Thus the line-ending explanation is confirmed, with the qualification that one failure is SQL-string equality rather than a hash check. I did not claim to rerun the stale local `main` checkout; the relevant unchanged baseline is the existing `origin/main`/pre-tuning parent.

### Acceptance criteria and plan coverage

| Criterion / tasks | Assessment and evidence |
| --- | --- |
| 1. Corruption rejects input, retains identities, persistent recovery (Tasks 3/6) | Implemented. Parser acceptance changes are comment-only. `station.ts:164` preserves identity/pending activation and cancels gestures separately; `goodScan` at line 195 uses input sequence ordering. Session/controller and real-parser tests cover both modes, all error reasons, old completions, refused input and the quiet boundary. Recovery renders separately from ordinary results. S2 concerns the combined late-repeat fixture, not an observed recovery bug. |
| 2. Selected lines, exclusions and suspicious refusal (Tasks 1/2) | **Fails M1/M2.** Existing tests prove supported singles/sets/GW, common exclusions, malformed framed SKUs, selected quantity limits, empty selection and unchanged lookup, but miss the reproduced title/category cases. |
| 3. Quantities, A0 stock/boxes, duplicate/atomic behavior (Tasks 2/6) | For correctly selected lines, raw aggregation and shared set multiplier remain intact. A0 routing and packaging both use the selected subset, existing stock/auto/resolved checks remain, and regular components remain for Dispatch. Old accessory-inclusive prepared A0 payload replay is tested after reload/lost response with exact `commitParams` equality and providers that throw if preparation is rerun. No server/storage contract changes. Actual scanner SQL rollback, hosted races and stock results remain staging gates; local mocks/manifest tests do not prove them. M1 can choose the wrong subset before those protections. |
| 4. Fifteen-minute Framing expiry, unchanged Dispatch (Task 4) | Implemented: 600,001 / 899,999 / 900,000 ms accepted, 900,001 ms expired in fresh-fixture tests; countdown tests cover 15:00/14:00. Shared constant drives refusal/tick/setup text. Dispatch absolute expiry is unchanged and regression tests pass. S3 identifies missing setup-render coverage. |
| 5. Three additional own-badge scans (Tasks 5/6) | Implemented locally: initial scan excluded; rolling 999/1,000 ms guard; inclusive 10,000 / expired 10,001 ms window; arrival-based progress; generation-based cancellation; offline clearing; numeric-badge distinction; Dispatch bypass. Third repeat clears one slot without an activation call; first two use the existing RPC. Captured jobs/outbox are unaffected. Actual clock-event deduplication and held-badge hardware commissioning remain staging requirements. |

## Hardening and guardrail audit

Each row addresses a question in `docs/HARDENING.md`; “unchanged” refers to the isolated tuning diff, not the large stale-local-main comparison.

| Checklist question | Review result / evidence |
| --- | --- |
| 1 — Slow/down network, Supabase, Shopify, Dropbox, Slack, Make | Existing durable scoped queue, backoff, auth/offline/storage messages and online-only badge checks remain. Outbox/controller tests pass. No new Dropbox/Slack/Make calls; those integrations are n/a to this change. |
| 1 — Retry / duplicate saves | Stored prepared payloads/request IDs are reused; old A0 payload replay and lost-response tests pass. No reclassification on retry. Server receipt logic is unchanged. |
| 1 — Concurrent workers/devices | Per-slot epochs and synchronous capture remain; outbox lease tests pass. Existing site/order advisory lock and classic/shared coordination are unchanged. Real concurrent-session evidence remains CJ's staging gate. |
| 1 — Unknown badge, malformed scan, missing SKU, cancellation, wrong site | Parser rules and badge/site authorization are retained; malformed input saves nothing and keeps recovery. Header preflight still precedes selection. **Missing/unrecognized SKU category handling fails M1/M2.** |
| 1 — Failure visibility and recovery | Recovery is independent of old queue results; storage/full queue/refusal/uncertain states retain distinct copy. Uncertain work still says not to record on classic. S1 concerns oversized refusal text. |
| 2 — Person/department attribution | Worker is captured before awaits; queued payloads and department snapshots are unchanged. Sign-out is local and cannot reassign captured work. CJ explicitly accepted the remaining risk of a garbled new badge leaving the previous worker active, and the longer unattended window. |
| 2 — Shared counts / sets | Existing `framingPieceMultiplier` and routing/packaging helpers reused, raw quantities preserved, server pieces used for saved results. **M1 can silently lose a framed line before counting.** |
| 2 — Historical correctness | No historical writes or reclassification. Prepared jobs, saved events and department snapshots remain intact through app rollback. |
| 2 — UTC / site-local time | Outbox still serializes captured wall time with `toISOString`; gesture uses `performance.now()`. No date/reporting display change. Dispatch's existing site-workday expiry remains; its clock display still uses browser-local `toLocaleTimeString`, so receiver timezone setup remains an existing commissioning consideration, not a new tuning regression. |
| 2 — Inferred/manual vs measured | No new metric or inferred value. Existing Dispatch manual attribution labels and selection are unchanged. |
| 3 — Endpoint authentication / validation | No new endpoint. Existing JWT/caller/site/badge validation and UI owner/manager/kiosk gating are unchanged. Hosted denial checks for staff/CS/anonymous/cross-site callers remain required. |
| 3 — Tables / RLS / grants | No new/changed tables or policies; new-table RLS is n/a. Existing scanner RPC authorization and grants remain. |
| 3 — Secrets / logs / external messages | No secret/config/logging additions, no provider messages, no new `VITE_*` exposure. |
| 3 — Cost / spam / data exposure | No API per order line or new remote write path. Rapid same-badge reads avoid activation; deliberate first/second repeats use the existing bounded RPC. No new email or exposure surface. |
| 4 — Expand-only / old-code compatibility | No migration. Both Repository implementations and outbox schema are unchanged. Old prepared payload compatibility has a regression test. |
| 4 — Immediate switch-off | Existing Classic station exit remains. Keep queues; resolve uncertain work through its original request before using classic. |
| 4 — Release sequence / external configuration | Plan specifies CJ recording previous deployment, staging/CI/review, quiet-time release, receiver refresh and initial monitoring. No new env, SQL, Make, Slack or Shopify setup. App rollback retains queue/receipts/ledger. Agents must not merge/deploy/apply SQL. |
| 4 — Per-role staging plan | Spec includes kiosk hardware/flows, owner/manager event-stock-health inspection and staff/CS/anonymous/cross-site denial checks on inka-staging-2, plus release smoke tests. Not executed in this review. CJ's A0 answer is already recorded; do not reopen it. |
| 5 — Months-of-events queries | No new query or unbounded event scan. Existing server lookups/locks are reused. |
| 5 — External API per item | None added; classification is local over the existing at-most-50-line order. |
| 5 — Two years / three sites | At most three slot gestures, existing queue/line bounds and scope keys remain. Growth in historical events does not expand the new local work. S1 is the missing display-string bound. |
| 6 — Detecting production failures | Existing heartbeat/silence, queue/blocked/uncertain/auth/focus/audio/storage indicators remain; new corruption alert is persistent. No new remote alert is claimed. |
| 6 — Manual fallback | Classic remains available for definite refusals; uncertain-commit safeguards are retained and tested. |
| 6 — Ongoing maintenance | Existing device storage/receipts and account/token maintenance remain; no new subscription or retention store. Plan requires monitoring attribution, blocked jobs, stock/boxes and clock events; never clear browser storage to recover. |
| 7 — Pure logic / edge tests | All scanner tests pass, including classifier, session, protocol, outbox, controller, wall and Dispatch regressions. Add M1/M2 regressions and improve S2/S3 coverage. |
| 7 — Inventory / credit / money, old and new | New selected A0 payloads and old accessory-inclusive replay have tests; shared math/storage/server paths unchanged. Real all-or-nothing A0 failure and exactly-once race results still need the approved staging run. |

AGENTS.md checks: scanner mode remains intentionally Supabase-only, so no new Dexie Repository feature is required; migrations are untouched; no dependencies or root whitelist additions; no secrets; inventory preparation changes have old/new regression coverage but need the M1/M2 corrections. The six task commits and log entries exist. Green PR CI has not been verified, and the local test/build invocation caveats above must not be represented as an unqualified all-green definition of done.

## Remaining release evidence

After the classifier fixes and review follow-up, obtain green PR CI and record the approved inka-staging-2 run: real clock-in deduplication/no clock-out, A0 stock/packaging rollback, duplicate/partial/classic/shared races, lost-response replay, per-role denial, real idle intervals and physical scanner repeat suppression. This review performs no production connection, hosted SQL application, merge, deployment or commit. Only this review document was intentionally authored; requested verification produced ordinary ignored build artifacts.

## Coder response

(Coder fills this in after fixing.)

STATUS: COMPLETE
