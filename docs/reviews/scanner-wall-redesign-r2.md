# Review: Shared scanner wall redesign — round 2

- Slug: `scanner-wall-redesign` · Branch: `feature/scanner-stations-tuning` · Reviewed commit: `b4b7d50c756a2cf72d7a673077ee9e87caa02fd3`
- Reviewer: planner (Codex)
- Verdict: **changes required**

The reporting migration-list regression is fixed, and the six reporting failures are now independently confirmed to be CRLF-only. Binding generations, stale competition, refresh scheduling and goodbye handling have improved. Approval remains blocked by incomplete round-one M7 progress handling and M6 layout acceptance. Permission-cache invalidation and error announcements also have residual gaps, detailed below.

## Checked against

- [x] Spec acceptance criteria — assessed individually below; not all met.
- [x] Plan tasks — all five implementation tasks and the Implementation log reviewed, including CJ's index/font approval, TTF note and subsequent font instruction.
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist).
- [x] `docs/HARDENING.md`, every question — audit below.
- [x] Roadmap decisions for this feature (`docs/ROADMAP.md`) and `docs/ARCHITECTURE.md` context.
- [ ] Tests cover the new logic; type-check, tests and build pass — type-check passes; literal test/build entry points encounter sandbox config-loading failures. Supplemental build passes; the full supplemental test run and diagnostic reruns are recorded precisely below. Missing lifecycle coverage exposes remaining defects.

### Scope and authorization

Reviewed `603b0a4..b4b7d50`: the five redesign task commits beginning with `3a49b05` (“task 1: define daily totals projection and indexed read prerequisite”), the r1 review, and correction commit `b4b7d50`. `603b0a4` is the approved tuning r2 review. The earlier `2b8702c` contains the redesign documents, but tuning implementation continued after it; using it as the implementation baseline would incorrectly include already-reviewed tuning changes.

The tuning feature was checked only for redesign interactions. Its approved classification, expiry, gesture, parser and inventory decisions are not reopened. CJ's later instruction governs typography: Frutiger headlines, Inter supporting text, Helvetica Neue numbers, with alternatives allowed. The local-first font stacks implement that instruction. The recorded TTF substitution is acceptable: real regular/bold Atkinson files, provenance and OFL licence are bundled, `font-display: swap` is used, and no commercial font is redistributed. Both TTF files were present in the verified build output (54,348 and 55,256 bytes). Existing app-wide Inter loading is not a new redesign dependency.

The checkout was initially clean. Only this review document was authored. No app/test/migration file was edited, no dependency installed, and no state-changing Git command, commit, push, hosted database connection or deployment was performed. Required verification generated ordinary ignored build/cache output. The index test executes against disposable in-process PGlite, not a hosted database.

## Must-fix

1. **M1 — A stopped delivery can still claim “Saving” (r1 M7 remains open).** `src/lib/scanners/station.ts:472`, `:498`, `:256` — queue reconciliation preserves the previous phase whenever the job remains queued/prepared. If the server returns success but local `markDone` throws, the pump stops and refreshes, yet the retained prepared job keeps `phase: "saving"`. A fresh diagnostic using the actual controller, `processNext` and memory outbox, with only `markDone` made to throw, produced `{"commits":1,"storageError":"finish write failed","jobStatus":"prepared","phase":"saving"}`. This violates the requirement that progress describe an active attempt and stop on storage failure. End or replace the attempt's busy phase before reconciliation; preserve its immutable payload and uncertain outcome. Also complete the requested request/attempt fencing: `onDeliveryProgress` checks account/site but recreates progress for a finished/vanished request. A direct late-callback diagnostic after `markDone` plus `refreshView()` changed empty progress back to saving. Add regressions for local finish failure after server success, superseded attempts, and callbacks after completion/disappearance. Do not change lease or retry authority to solve a display defect.

2. **M2 — The promised Receiving state is still absent (r1 M7).** `src/lib/scanners/station.ts:74`, `:392`, `:410`; `src/components/production/scanners/ScannerWallPanel.tsx:60` — the phase union/rendering has received/checking/saving/waiting only. Enqueue is awaited before any per-request observation is published. During slow durable storage, the operator sees the previous result and no “Receiving scan…” indication, even though this scan has been accepted for enqueue. Allocate the transient request observation before awaiting storage, keep it explicitly unconfirmed, replace it only after durable enqueue succeeds, and clear it on failure/disposal. Test deferred enqueue, enqueue failure, simultaneous slots and rebind while enqueue is unresolved. No green or “received” state may appear before storage succeeds.

3. **M3 — Ordinary-state layout acceptance is still unmet and the required visual checks are incomplete (r1 M6).** `src/components/production/scanners/scanner-wall.css:94`, `:135`; `docs/reviews/scanner-wall-redesign-r1.md:179` — natural page height and the scrollable sticky dock fix the earlier clipping strategy, and the 56/64/40 px type sizes are restored. However, the coder's new measurement explicitly records **894 px** for recovery plus result at a 1280×800 viewport. The approved Problem composition includes recovery and a subordinate ordinary result; the spec requires all four ordinary compositions to fit without scrolling. Permitting exceptional overflow does not satisfy that ordinary-state requirement. Adjust composition/spacing while retaining legibility and accessible exceptional scrolling. Record all four actual rendered states at 1280×800, plus long names, font failure, warning overload, Dispatch chooser with blocked work, narrow viewport and 200% zoom. The current response documents Main and recovery height only. This finding uses the coder's recorded measurement and source constraints; this review does not claim a new browser or hardware measurement.

## Should-fix

1. **S1 — Access loss hides data but does not invalidate the cache (residual r1 M2).** `src/components/production/scanners/useScannerWallTotals.ts:70`, `:135`, `:146` — returning `EMPTY` happens before resetting `lastKnown`, while `loaded` is retained under its old string scope. Membership true→false→true, or allowed→denied→allowed, restores that exact scope and immediately reuses the pre-denial snapshot as current/ready before the new read settles. A fresh in-memory hook-state/effect diagnostic reproduced current totals → empty denied view → the same current totals, empty pending list and old goodbye cache on restoration. The important denial-time withholding is fixed and this is not a demonstrated RLS bypass, but the promised clear-on-permission-loss contract is incomplete. Invalidate loaded/error/goodbye data across access transitions, preferably with a monotonic access epoch, and test the integrated hook lifecycle rather than only the Boolean access helper.

2. **S2 — Uncertain outcomes and required framer choices still use polite announcements (r1 S2 partially open).** `src/components/production/scanners/SharedScannerWall.tsx:238`; `src/lib/scanners/station.ts:549`, `:556` — assertive alerts are selected only for `rejected` and `already`. Uncertain blocked work and missing-framer choices intentionally retain `kind: "queued"`, so their actionable warning, including “Do NOT record it on the classic station,” remains polite. Use explicit announcement severity or equivalent outcome metadata without falsely relabelling uncertain work as not saved. Add render assertions for these outcomes; keep counters/countdowns outside live regions.

3. **S3 — Dispatch progress tells dispatchers to keep framing.** `src/components/production/scanners/ScannerWallPanel.tsx:76` — the shared progress component renders “keep framing, no need to wait” in both modes. Use mode-appropriate or neutral guidance and cover a busy Dispatch panel.

4. **S4 — Reconcile completion claims with the actual evidence.** `docs/plans/scanner-wall-redesign.md:141`, `:143` — the original Task 5 entry still says all six failures at that earlier commit were unrelated CRLF failures, although r1 established the 0064 enumeration regression at that commit. The latest entry says all M1–M7/S1–S2 are fixed, which the remaining findings contradict. Add a clear correction to the historical claim and record each remaining fix/check accurately. Detailed task checkboxes also remain unchecked despite the completed task headings; distinguish completed local work from pending CI/staging/hardware evidence.

## Nitpicks

None raised. `git diff --check 603b0a4 HEAD` reports only upstream licence trailing whitespace at `public/fonts/atkinson-hyperlegible/OFL.txt:20`; preserving that licence verbatim is reasonable.

## Round-one closure evidence

| R1 item | Round-two assessment |
| --- | --- |
| **M1 — Migration-list regression** | **Code fix verified.** `tests/reporting/pg/harness.ts:85` classifies 0064 as non-reporting. The historical migration-list assertion now passes; the remaining failure is the 0037 raw-byte hash at `reportingJobs.test.ts:45`. LF-only normalization yields 269/269, without hiding 0064 or changing enumeration. All three new index tests pass. Historical log correction remains S4. |
| **M2 — Permission/membership handling** | **Core denial fixed; residual S1.** `SharedScannerStation.tsx:50` supplies confirmed membership, `wallTotalsScope.ts:27` requires the existing site-wide visibility policy plus operator authorization, and the hook includes role/membership in scope and returns an empty view while denied. Reads receive cancellation signals. The cache is hidden rather than cleared and can reappear after reauthorization. |
| **M3 — Binding-generation fence** | **Fixed in inspected code.** `wallTotalsScope.ts:36` increments on every observed map change; hook lines 89/104 capture the read generation and line 136 checks it before readiness/cache updates. A→B→A and A→empty→A cannot match an older generation; unchanged own-badge repeats do not increment it. The three scope-helper tests pass. Full lifecycle regression coverage remains thinner than the plan, especially access transitions described in S1. |
| **M4 — Stale competition/scope labels** | **Fixed.** `SharedScannerWall.tsx:113` requires current, complete, all-ready data for rank/leader/share. Lines 175–176 render the people-on-wall/site/04:00 and conditional rework labels. Stale figures are labelled delayed; new render assertions verify no stale leader/share/rank. A totals failure does not change the independently supplied saved result. |
| **M5 — Refresh scheduling/concurrency** | **Fixed for the reported paths.** `wallTotalsRefresh.ts:95` replaces a later periodic timer with the earlier requested deadline. Disable/dispose aborts and suppresses publication; the unresolved read keeps the scheduler slot until settlement. All nine scheduler tests pass, including fast read then +1-second save starting at +5 seconds, hide/resume with deferred rejection, and disposal. Actual hook passes the signal to the existing abort/deadline loader. |
| **M6 — Clipping/legibility/layout** | **Partially fixed; M3 above remains.** No fixed root height/hidden overflow; restored sizes, narrow stacking, focus styling and reduced-motion rule. Ordinary Problem height still exceeds the target in the coder's own evidence; full visual verification is absent. |
| **M7 — Progress reconciliation/Receiving** | **Partially fixed; M1–M2 above remain.** Reconciliation restores retained queued/prepared jobs, removes done/blocked/missing jobs, and clears progress if the queue cannot be read. Returned waiting reports now show waiting. Tests cover those cases, but do not cover the demonstrated finish-write failure; Receiving and callback request fencing are still missing. |
| **S1 — Goodbye** | **Fixed for the reported input/freshness defects.** `station.ts:216` clears the known source's goodbye on malformed input, preserving other slots. `ScannerWallPanel.tsx:110` requires known figures plus an “as of” label; the five-second presentation limit and same-person mapping remain. Regression tests pass. Access-cache retention is separately S1 above. |
| **S2 — Actionable announcements** | **Partially fixed; S2 above remains.** Rejected/already results are assertive; uncertain and missing-choice outcomes are not. Countdown/rank changes remain outside live regions. |

## Evidence

### Fresh verification

| Check | Observed result |
| --- | --- |
| `npx tsc -b`, `npm run test -- --run` via PowerShell aliases | Blocked by local PowerShell script execution policy. Used the equivalent Windows `.cmd` entry points without changing policy. |
| `npx.cmd tsc -b` | **Exit 0.** |
| `npm.cmd run test -- --run` | **Exit 1 before collection:** esbuild cannot read an ancestor directory/resolve the Vite config under this sandbox. |
| `npm.cmd run build` | **Exit 1 at Vite config loading**, after TypeScript; same sandbox ancestor-access error. |
| Full Vitest run with equivalent configuration in memory | **Exit 1: 3,672 passed / 7 failed, 165 files (161 passed / 4 failed), 185.02 seconds.** Six reporting CRLF assertions plus one 5-second reporting-worker timeout. All **262 scanner/component tests** and **three 0064 index tests** passed. |
| Isolated rerun of `tests/api/reporting-worker.test.ts`, unchanged config/timeouts/files | **Exit 0: 90/90 passed**, 40.56 seconds. The previously timed-out test passed. This supports a transient runtime/contention explanation, not an all-green full-run claim. |
| Three CRLF-affected reporting files, migration read results normalized only in memory | **Exit 0: 269/269 passed**, 2.69 seconds. No directory-enumeration exception, source edit or disk normalization. |
| Vite production build with equivalent configuration in memory | **Exit 0**, 2,991 modules transformed, 34.42 seconds; both font assets copied. Existing warnings: old Browserslist data, mixed static/dynamic XLSX imports, large chunks (main JS approximately 1.81 MB). |

Supplemental commands were supplied to Node on stdin, using the exact React plugin and `@` alias from `vite.config.ts`, with only config-file loading disabled:

```js
// Full tests: imports from vitest/node, @vitejs/plugin-react, node:path.
const ctx = await startVitest("test", [], { run: true, config: false }, {
  configFile: false, plugins: [react()],
  resolve: { alias: { "@": path.resolve("src") } },
});
await ctx?.close();

// Separate build, using build from vite.
await build({ configFile: false, plugins: [react()],
  resolve: { alias: { "@": path.resolve("src") } } });
```

The full run overlapped the supplemental build and some diagnostics. The isolated timeout rerun kept the original 5-second test timeout. Neither that rerun nor the LF diagnostic substitutes for green PR CI.

### Independent CRLF confirmation

The six failures are precisely:

- `tests/reporting/reportingJobs.test.ts:45`: raw 0037 SHA-256 differs from the pinned LF hash. The earlier enumeration failure at line 38 is gone.
- `tests/reporting/reportingDependencyRehearsal.test.ts:449`: CRLF statement text differs from expected LF statement text.
- `tests/reporting/reportingDependencyPlans.test.ts:577`, `:619`, `:624`, `:636`: effective SQL identity checks fail at A1 before their downstream expectations.

Byte-preserving `git show` output was compared with disk bytes using Node. Replacing CRLF with LF, and nothing else, makes each file identical to both HEAD and the pre-redesign `603b0a4` blob:

| Migration | CRLF pairs on disk | LF equals HEAD and baseline |
| --- | ---: | --- |
| `0037_reporting_storage.sql` | 559 | Yes |
| `0040_reporting_dependency_reads.sql` | 345 | Yes |
| `0041_reporting_dependency_read_bounds.sql` | 339 | Yes |
| `0042_reporting_access_paths.sql` | 245 | Yes |

0037's disk SHA-256 is `b745252780a61fe1739957a2fe4881900a44b156d3ac89252db6c5a9bd737baa`; LF normalization produces the expected `531bb2c5706b9ac4d73a7ca3dc74dead7e34a53160e57fe2971aaf061c6a6a4f`. The affected test files and rehearsal/plan helpers are unchanged in the redesign diff.

For a causal check, Vitest worker `poolOptions.threads.execArgv` loaded a `data:` URL Node preload wrapping `fs.readFileSync` only for `supabase/migrations/*.sql`. It replaced `\r\n` with `\n` in returned values, preserved Buffer/string types, and called `syncBuiltinESMExports`. All 269 tests then passed. An initial preload attempt had a JavaScript escaping error and failed before collection; the corrected run above supplies the evidence. No migration content on disk was changed. Unlike r1, no special exclusion of 0064 was needed.

### Lifecycle diagnostics and limits

Read-only diagnostics loaded actual modules through Vite's in-memory SSR loader. The progress reproduction used the real delivery function and outbox with a single injected local finish failure; no server or SQL call was made. The late-callback reproduction called the controller observer after completing/removing its progress entry, demonstrating the missing observer guard, not claiming a separate observed hardware race.

The access-cache diagnostic invoked the actual totals hook through a small in-memory state/ref/memo/effect driver and a complete empty fake RPC envelope. After a successful read, membership removal returned empty data; restoring membership returned the old `loadedAtUtc`, `status: "current"`, no pending people and the old `lastKnown` before the next promise settled. This is a source-path diagnostic, not a mounted browser/React lifecycle test. Add proper integrated lifecycle regression coverage with the fix.

### Migration and shared counting

`0064_scanner_wall_count_window_index.sql:29` contains exactly one non-unique `CREATE INDEX IF NOT EXISTS` on `public.production_events (location, created_at)`. Its event-type predicate exactly matches the window branch of `0035_load_production_evidence_v2.sql:61`: `line_verified`, `completed`, `dispatched`, `cancelled`, with site equality and created-at lower/upper/cutoff bounds. There are no executable drops, data changes, function replacements, grants or policies. No existing migration changed. Previous application code remains schema-compatible.

The index tests check that single-statement contract, predicate correspondence, repeat application and an index-usable site/day query. Their PGlite EXPLAIN sets `enable_seqscan = off` and uses a simple query: it proves usability, **not** the real RPC's chosen plan under kiosk RLS or production-scale latency. The migration documents write blocking from ordinary CREATE INDEX and a CJ-managed concurrent alternative; the approved release plan remains authoritative: reconcile/apply on staging first, schedule production installation, and leave the additive index in place on app rollback. Do not execute the comment's optional DROP as part of the app rollback.

`wallTotals.ts:83` uses one shared `summarizeProduction` call over distinct active people and fixed `framed`/`a0_framed` work types. Shared normal order keys/items supply the team and person values; the share denominator is distinct people's order credits, not team union orders. Tests pin set multiplication, mixed A0/regular orders, cancellations, rework exclusion, duplicate bindings, shared-order credits, positive ties, zero output, limited/incomplete evidence and wrong windows. No new credit or inventory calculation is introduced.

## Acceptance and plan coverage

| Criteria / tasks | Assessment |
| --- | --- |
| AC1 / Task 4 — visual composition, type, reflow | Partial. CJ's revised font instruction and restored sizes are implemented; ordinary-state fit and full visual/accessibility evidence remain M3. |
| AC2 / Tasks 1–2 — shared person/day totals | Shared counting and binding-generation design meet the inspected contract. Tests pass; real same-cutoff reconciliation across Classic/receivers remains staging evidence. |
| AC3 / Tasks 1–2/5 — bounded read, truthful freshness, access, indexing | Core row ceiling, strict decode, site day, deadline, scheduling and stale competition are present. Access cache invalidation remains S1. Real index/RLS/performance checks are pending, not certified by local PGlite. |
| AC4 / Tasks 3/5 — truthful stages, queue/races | Not met: M1–M2. Immutable prepared payloads, observer exception isolation, server-confirmed saved results and captured attribution remain intact. Passing tests do not cover the demonstrated gaps. |
| AC5 / Tasks 3–5 — tuning recovery/gesture/expiry | Preserved in scoped diff and existing tests. Known-source goodbye clearing is fixed; elapsed time stays separate from wall clock; the controller remains gesture authority. Physical-scanner checks remain pending. |
| AC6 / Tasks 4–5 — Classic/Dispatch/health/operator access | Existing actions, two-tap confirmations, chooser/manual attribution, uncertain dismissal restriction, warnings, sound/wake and capture handling remain. Shared progress defects also affect Dispatch; S2–S3 and exceptional-layout checks remain. No Classic code was changed. |

Five task commits and an implementation log exist. The pure helper/test additions and reporting harness classification are relevant review fixes, not unrelated features. Task 5 does not establish green CI, all required integrated paths or completed browser/staging checks; completion records need S4.

## Hardening and guardrail audit

Each question in `docs/HARDENING.md` is addressed below. “Unchanged” refers to the redesign scope, not the recovered architecture baseline.

| Checklist question | Evidence / disposition |
| --- | --- |
| 1 — Network/Supabase/Shopify/other services down or slow | Totals errors retain labelled same-day figures or unavailable state; independent reads cannot gate scanning. Existing offline queue and auth/storage warnings remain. Busy-state storage handling needs M1 and slow enqueue needs M2. No new Dropbox/Slack/Make path. |
| 1 — Retries / duplicate writes | Observer callbacks are optional, non-awaited and exception-contained. Request IDs, prepared payloads, leases and commit calls remain unchanged; existing replay/duplicate suites pass. No local total increment after a save. |
| 1 — Concurrent people/devices | Captured person/mode and independent slots remain. Daily reads coalesce; binding generations fence old maps. Progress request/attempt cleanup needs M1. Actual cross-device/classic races remain staging checks. |
| 1 — Bad input/unknown barcode/missing SKU/cancelled/wrong-site order | Tuning parser, selection/preflight and authorization remain unchanged; controller/order/outbox regressions pass. Protocol errors preserve recovery and now clear the source goodbye. |
| 1 — Failure display and recovery | Rejected, queued, already-recorded, saved and uncertain outcomes remain distinct, with original uncertain Classic prohibition. Misleading stopped Saving is M1; assertive uncertain guidance is S2. |
| 2 — Person/department attribution | No write attribution changes. Panels select current person/scanner/mode; an old person's save stays globally attributed to them. Binding map generations gate daily figures. |
| 2 — Counts/orders/sets use one rule | Shared F1 evidence preparation/reducer, distinct people and union team orders; raw receipt/row summation not used. Projection tests pass. |
| 2 — Historical settings/person changes | Read-only fixed work-type projection; no history, department snapshot, receipt or ledger mutation. |
| 2 — UTC/site-local time | Existing shared site 04:00/DST range helpers used, request built at execution, exact window checked. Site timezone is supplied to wall clock/goodbye/expiry display. Original job timestamp retained; gesture uses elapsed clock. Real resume/rollover remains staging evidence. |
| 2 — Manual/inferred versus measured | Dispatch retains measured/manual Framed by markers. Delayed figures are labelled and competition suppressed; no new inferred productivity metric. |
| 3 — Endpoint authentication/input validation | No new endpoint; existing caller's SECURITY INVOKER evidence RPC and strict envelope validation reused. UI requires operator role and confirmed site-wide membership. Cache invalidation caveat S1; no service-role client. |
| 3 — RLS/roles/grants | No new table, policy or grant. Existing staff-own/CS-site evidence permissions remain; station operator eligibility is separate. Actual role/cross-site denial tests remain staging. |
| 3 — Secrets/logs/messages | No environment, secret, log or external-message additions. New display observation does not expose raw badges or customer payloads. |
| 3 — Cost/spam/data exposure | One day/site RPC for all people, minimum five-second starts, minute cadence, abort/deadline and 20,000-row ceiling. No mail or per-person external calls. Server row production remains bounded by existing RPC/timeouts, not by the client ceiling alone. |
| 4 — Expand-only / old app compatibility | One additive partial index; unchanged existing migrations and storage/RPC contracts. Old app works against the new schema. Tests establish local index usability, not hosted rollout safety. |
| 4 — Switch off without deployment | Existing Classic station action and queue retention remain. Resolve uncertain work through its original request before classic recording. Exceptional reachability still needs the requested visual checks. |
| 4 — CJ release order/configuration | Tuning first; staging index reconciliation/application and plans; Preview checks; CI/review; rollback target; quiet production index installation; release/receiver refresh and monitoring. No new env/provider settings. Agents do not merge, deploy or apply hosted SQL. |
| 4 — Staging per role | Spec covers kiosk flows/hardware, owner/manager inspection, staff/CS station denial with unchanged evidence permissions, anonymous/cross-site denial and broad release smoke tests. Pending. |
| 5 — Months of events/indexing | Partial site/time index matches window predicate; existing keyed order/parent context paths retained. Full underlying RPC plans with linked old corrections and RLS must still be measured. |
| 5 — External API per item | None added. Existing order preparation stays unchanged; one totals read serves the wall. |
| 5 — Two years/three sites | Day/site scope, strict complete envelope/row ceiling, bounded progress and shared read are present. Synthetic-volume latency, payload and concurrent-write measurements remain required; M1 affects progress correctness rather than database growth. |
| 6 — Detecting failures | Existing auth/offline/storage/focus/audio/wake/queue warnings and heartbeat path retained; totals add delayed/unavailable state. Stopped progress still misleads until M1. No new remote alert is claimed. |
| 6 — Manual fallback | Classic fallback remains for definite failures; uncertain work cannot be dismissed as recorded on Classic. Preserve device jobs; do not clear browser storage. |
| 6 — Maintenance/monitoring | Monitor read latency/failures, index size/write cost, queue/uncertainty and receiver health. No new subscription/token or persistent analytics store. |
| 7 — Pure logic/edge cases | 262 scanner/component and three index tests pass. Deferred finish/Receiving/access lifecycle and full visual checks remain gaps; test success is not sufficient closure. |
| 7 — Inventory/credit/money old and new | No redesign change to credit/deduction/payload logic. Existing tuning old/new preparation, A0 packaging, retry/outbox and Dispatch tests pass. Real SQL atomicity/exactly-once/race evidence stays with staging. |

Repository and both adapters are unchanged; the Supabase-only scanner feature does not create a missing Dexie Repository implementation. There are no new npm dependencies, top-level whitelist paths, API handlers, secrets, provider configuration or outbox schema changes. The only new migration is 0064. AGENTS.md's green CI and completed verification requirements are not certified by this review.

## Remaining release evidence

After fixes and another review, CJ still needs green PR CI and the spec's complete staging checklist on **inka-staging-2**: index reconciliation/install and underlying RPC plans as kiosk; two-year/three-site busy-day and concurrent-save measurements; same-cutoff F1 reconciliation; actual role/site access; read/save failures, reload/rebind and 04:00/DST; physical scanner gestures/recovery/idle behavior; font/layout/zoom/accessibility; Dispatch/Classic regression flows and release smoke tests. The index and font download already have authorization. These are evidence gates, not requests to approve those choices again. App rollback preserves the additive index, queues, receipts, events and stock history.

## Coder response

- **M1 fixed.** The controller tracks the one job delivery is working on (`activeRequest`, set by the progress observer, cleared by its report or by a pump storage failure). On every queue refresh a retained job whose last phase was checking/saving but is not the active job becomes `waiting` (attempts > 0) or `received`. Test "a storage failure after the commit leaves no panel saying Saving" uses the real controller, `processNext` and memory outbox with `markDone` throwing: storageError set, phase `waiting`, never saving/checking.
- **M2 fixed.** New `receiving` phase ("Receiving scan…"), set under a temporary key before `outbox.enqueue` is awaited, kept by refresh reconciliation, replaced by `received` under the real request id after the durable write, removed if the write fails. Test with a deferred enqueue covers before, during a refresh, after, and a failing write.
- **M3 fixed.** While the recovery message is up, panels render compact (one row: scanner, name, "Still signed in" or "Sign out n/3", Orders), as in the approved Problem artboard. Busy and signing-out panels swap the large Orders/Pieces boxes for a one-line "Today: N orders · M pieces", as in the approved Saving and SignOut artboards; the sign-out dots moved onto the box's title row. Re-measured at 1280×800 with the real CSS and fonts: Main 800, Saving 800, Problem 800, SignOut 800 px; no clipping (no fixed height), the docked result stays visible.
- **S1 fixed.** An access epoch is part of the scope and increases whenever access is lost, so allowed→denied→allowed (or member→not→member) can never match the old snapshot, errors or goodbye cache; last-known numbers are also cleared on denial.
- **S2 fixed.** `WallResult.urgent` is set for uncertain blocked outcomes and framer choices (kind stays `queued`, so nothing is relabelled "not saved"); the wall announces urgent/rejected/already results with `aria-live="assertive"` and `role="alert"`. Controller test feeds the three reports and checks the flags; render test checks the live region.
- **S3 fixed.** Dispatch progress reads "keep going, no need to wait"; render test for a busy dispatch panel.
- **S4 fixed.** Correction and the round-2 entry added to the plan's Implementation log; detailed checkboxes ticked for completed local work, with PR CI and the staging/hardware checklist left unticked.

Checks: `npx tsc -b` 0; `npm run build` 0; `npm run test -- --run` 3680 passed / 6 failed (known CRLF set).
