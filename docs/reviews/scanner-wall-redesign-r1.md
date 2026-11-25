# Review: Shared scanner wall redesign — round 1

- Slug: `scanner-wall-redesign` · Branch: `feature/scanner-stations-tuning` · Reviewed commit: `07d9d00b3739d829d8e1f310f016ab1e22582157`
- Reviewer: planner (Codex)
- Verdict: **changes required**

The shared counting projection and additive index follow the design, and the existing scanner regression suites pass. Approval is blocked by incorrect freshness/access/binding handling, refresh scheduling, progress cleanup, layout regressions, and a new migration-list test failure. The six failing test names are not sufficient evidence that all failures are the old CRLF problem: one now fails for a redesign-related reason before reaching its historical hash assertion.

## Checked against

- [x] Spec acceptance criteria — assessed below; several are not met.
- [x] Plan tasks — reviewed all five commits and Implementation log, including CJ's index/font approval and the TTF note. Top-level task completion overstates the lifecycle/visual evidence; detailed task checkboxes remain unchecked.
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist).
- [x] `docs/HARDENING.md`, every question — matrix below.
- [x] Roadmap decisions for this feature (`docs/ROADMAP.md`) and architecture context.
- [ ] Tests cover the new logic; type-check, tests and build pass — type-check passes; literal test/build commands fail loading config in this sandbox. Supplemental verification and the remaining test regression are detailed below.

### Scope

Reviewed `603b0a4..07d9d00`: `3a49b05`, `ac37264`, `5fe547f`, `51864ea`, and `07d9d00`, beginning with “task 1: define daily totals projection and indexed read prerequisite.” `603b0a4` is the approved tuning r2 review. The redesign spec/plan entered earlier at `2b8702c`; that commit is not the implementation baseline because tuning work continued afterward. Tuning's approved classification, gesture and retry behavior was checked for interactions, not reopened as a separate feature review.

The checkout was clean initially. No state-changing Git command, application edit, dependency installation, hosted database connection, SQL application, commit, push or deployment was performed. Only this review was authored; verification generated ordinary ignored build/cache artifacts.

## Must-fix

1. **M1 — 0064 introduces a reporting-test regression that persists with LF files.** `supabase/migrations/0064_scanner_wall_count_window_index.sql:29`, `tests/reporting/pg/harness.ts:75`, `tests/reporting/reportingJobs.test.ts:38` — the new scanner migration is not classified in the shared non-reporting migration list. The test's sorted reporting-migration slices now start with 0038 instead of 0037 and include an extra tail entry. In-memory CRLF normalization fixes the other five failures but leaves this assertion failing: **268 passed / 1 failed**. Excluding only 0064 from directory enumeration in that diagnostic, with the same LF normalization, yields **269/269 passed**. Integrate the new migration with the reporting harness/test contract, preserving the historical migration/hash checks and adding appropriate index coverage. Do not remove the approved index or edit existing migrations. Correct the Implementation log's claim that all six current failures are unrelated.

2. **M2 — Permission loss does not clear daily data, and site membership is not part of the read scope.** `src/components/production/scanners/useScannerWallTotals.ts:46`, `:58`, `:77`; `src/components/production/scanners/SharedScannerStation.tsx:49` — `roleAllowed` only disables the scheduler. Loaded totals and `lastKnown` survive, and the returned view can remain `current`; the wall still renders those values. The scope key excludes role/access, and every read declares `{ kind: "site" }` without checking `auth.locations`, although the existing `productionVisibilityFor` helper explicitly requires membership. An empty RLS-filtered envelope must not become authoritative zero output. Include the caller's role and confirmed current-site membership in the scope, synchronously withhold/clear totals and goodbye cache when access is lost, fence/abort old reads, and use conservative visibility. Test allowed-to-denied and membership-removal transitions with unchanged account/site, including an in-flight read. Existing RLS is unchanged; this finding concerns retained UI data and completeness claims, not a new server-side RLS bypass.

3. **M3 — Binding-string equality is not the required binding-generation fence.** `src/components/production/scanners/useScannerWallTotals.ts:71`, `:83`, `:125`, `:129` — after a completed read for `S1=Alice`, changing to Bob (or empty), then back to Alice before a new read completes makes the old snapshot immediately ready again. `fresh.bindingKey === a.bindingKey` clears pending even though no read started for the latest binding generation. The same issue applies to an older in-flight read whose map eventually matches again. The source also writes projected values into `lastKnown` before checking readiness, so an unread new person's apparent zero can become a goodbye total. Introduce a monotonic binding generation, capture it per read, and require that generation before publishing ready values or updating last-known totals. Test A→B→A and A→empty→A, including changes in the same millisecond, delayed reads, and unchanged own-badge repeats. This was an explicit Task 2 contract, not an optional hook-render test.

4. **M4 — Stale totals still award leaders/ranks/shares, and the scope labels are misleading.** `src/components/production/scanners/SharedScannerWall.tsx:111`, `:112`, `:173`, `:183` — `usable` deliberately includes stale totals, but `showCompetition` never requires `status === "current"`. A fresh render with `status: "stale"` produces “Leading today” and the share bar. Only “Last updated” is shown; the required “Totals delayed” warning is missing. The summary says “Today on this wall,” although it includes Classic and other receivers at the site; the production-day boundary/scope explanation and `hasRework` exclusion note are never rendered. Keep labelled last-good figures when appropriate, but suppress all competition on stale/incomplete/pending/limited data. Restore “TODAY · PEOPLE ON THIS WALL,” “Saved framing at this site · day starts 04:00,” and the conditional CS/rework note. Add assertions that stale views contain no rank, leader or share, including after a read overflow/failure while a save succeeds.

5. **M5 — Refresh requests can wait a minute, and hide/resume can overlap RPCs.** `src/lib/scanners/wallTotalsRefresh.ts:75`, `:86`, `:102`; `src/components/production/scanners/useScannerWallTotals.ts:73` — after a fast successful read, a 60-second periodic timer exists. A save/rebind at +1 second calls `kick()`, but its five-second timer is installed only if `timer === null`; the existing periodic timer is left untouched. A standalone execution of the actual scheduler starts reads at 0 and 60,000 ms, not 0 and 5,000 ms. Separately, disabling sets `inFlight = false` without cancelling the RPC; re-enabling after the minimum gap starts another read while the first is unresolved. The hook passes no cancellation signal. Reschedule a later periodic timer when an earlier dirty refresh is due, and retain single-flight ownership or abort/settle the old request before starting another. Cover saves/rebinds after an already-completed fast read, rapid hidden/visible and offline/online changes with deferred responses, disposal, and rollover. The existing tests mostly request refresh while the initial read is still running and miss these paths.

6. **M6 — The wall clips content instead of reflowing, and reduces the approved legibility sizes.** `src/components/production/scanners/scanner-wall.css:36`, `:37`, `:83`, `:102`, `:106`, `:113`, `:132` — `height: 100vh; overflow: hidden` encloses non-shrinking header/warnings/team/recovery/footer and independently capped chooser/blocked regions. Only the panels can shrink/scroll. Once the non-panel content exceeds the viewport, panels collapse and lower results/actions can be clipped outside the scrollable regions. Narrow screens and 200% zoom exacerbate this; there is no height/zoom fallback. This is the exact fixed-height/hidden-overflow strategy the spec prohibits. Names/counters were also reduced to 40/46 px versus approximately 56/64 px; primary results are 30 px despite the explicit 40 px minimum, and supporting text is 15 px instead of at least 16 px. Allow the whole composition to grow/scroll for exceptional content and restore the legibility contract. Record actual browser checks for four ordinary 1280×800 states, long names/font failure, warning overload, Dispatch chooser plus blocked jobs, narrow viewport and 200% zoom. The logged four-state fit measurements do not establish these cases; this review's clipping finding is based on the CSS constraints, not a claimed new hardware/browser run.

7. **M7 — Progress can remain “Saving” after delivery has stopped and is not reconciled with the outbox.** `src/lib/scanners/station.ts:254`, `:387`, `:449`, `:476`, `:494`; `src/components/production/scanners/SharedScannerWall.tsx:66` — progress is removed only on a returned delivery report. A storage exception after the saving observer sets `storageError` and exits the pump without ending that progress. A diagnostic of the actual controller retained the saving entry even after `refreshView()` returned an empty queue. Progress also comes only from current-session enqueue/observer callbacks: retained queued work is absent after reload until claimed, waiting reports remove still-pending jobs from panel counts, and refresh never prunes disappeared/finished jobs. Thus “oldest unfinished” and the pending count are not reliable queue projections. Add a display-only reconciliation against scoped jobs, end/replace active animation on storage/auth/waiting failures, and reject stale request callbacks for jobs no longer active. Implement the promised Receiving state while durable enqueue is pending; currently the previous result remains with no local receiving indication. Test delayed/failed enqueue, a finish/storage failure, reload with several retained jobs, waiting/backoff, disappeared jobs and late callbacks. Preserve immutable payloads, leases and all existing delivery decisions.

## Should-fix

1. **S1 — Goodbye can survive malformed input and shows unqualified cached figures.** `src/lib/scanners/station.ts:210`, `:298`; `src/components/production/scanners/SharedScannerWall.tsx:195`; `src/components/production/scanners/ScannerWallPanel.tsx:101` — only `onFrame` clears goodbye; a parser error with a known scanner ID does not. The spec says the next slot input clears it even if that input fails. Goodbye has no snapshot freshness metadata and labels cached numbers simply “pieces today.” Clear the relevant goodbye on known-source protocol errors, preserve other slots, and either label the departed person's last-known figures with freshness or omit unavailable/unverified totals. Add malformed-input and stale-goodbye coverage; keep the existing five-second presentation limit and tuning gesture authority.

2. **S2 — Definite order failures are announced politely rather than as actionable alerts.** `src/components/production/scanners/SharedScannerWall.tsx:227` — ordinary rejected/uncertain results live only inside `aria-live="polite"`; only recovery and the separate warnings have assertive alerts. Give actionable errors an appropriate assertive announcement without moving countdown/rank updates into live regions or duplicating announcements.

## Nitpicks

None. `git diff --check 603b0a4 HEAD` flags trailing whitespace in upstream `OFL.txt:20`; preserving the upstream licence verbatim is reasonable and this is not an application defect.

## Evidence

### Fresh verification

Windows `.cmd` entry points were used without altering execution policy. The same checkout and installed dependencies were used for all checks. No production or hosted staging connection was made.

| Check | Result |
| --- | --- |
| `npx.cmd tsc -b` | **Exit 0.** |
| `npm.cmd run test -- --run` | **Exit 1 before collection.** esbuild cannot read an ancestor directory / resolve the Vite config under this sandbox. |
| `npm.cmd run build` | **Exit 1 at Vite config loading**, after TypeScript; same ancestor-directory denial. |
| Full Vitest, equivalent configuration supplied in memory | **Exit 1: 3,658 passed / 6 failed; 160 files passed / 3 failed; 3,664 tests in 163 files, 167.89 seconds.** All 250 scanner/component tests pass. The added suites are projection (13), reader (6), scheduler (7), progress (7), and redesign rendering (12). |
| Vite build, equivalent configuration supplied in memory | **Exit 0**, 2,990 modules transformed, 10.07 seconds. Main JS 1,809.37 kB; warnings for stale Browserslist data, mixed static/dynamic XLSX imports and large chunks. |
| Three affected reporting files, LF-normalized SQL reads only | **Exit 1: 268 passed / 1 failed.** Remaining failure is migration enumeration at `reportingJobs.test.ts:38`, not a hash or CRLF comparison. |
| Same diagnostic, also excluding only 0064 from migration enumeration | **Exit 0: 269/269 passed.** This isolates M1; it is not an unmodified passing test run. |

The config fallback reproduces `vite.config.ts` and disables only config-file loading. Node received source through stdin; no fallback config file was authored:

```js
// Imports: startVitest from vitest/node, react from @vitejs/plugin-react,
// path from node:path. Separate build invocation imports build from vite.
const config = {
  configFile: false,
  plugins: [react()],
  resolve: { alias: { '@': path.resolve('src') } },
};
const ctx = await startVitest('test', [], { run: true, config: false }, config);
await ctx?.close();
// Separately:
await build(config);
```

These supplemental runs do not turn the literal command failures into passes or establish green PR CI.

### Independent CRLF and regression investigation

Five failures are confirmed as the old checkout issue: `tests/reporting/reportingDependencyRehearsal.test.ts:449` compares CRLF/LF SQL strings, and `reportingDependencyPlans.test.ts:577`, `:619`, `:624`, `:636` fail effective-function identity at A1 because of the same line-ending mismatch. The sixth test, `reportingJobs.test.ts`, now fails earlier at line 38 because of 0064; its historical raw-byte hash assertion at line 45 remains CRLF-sensitive underneath that failure.

Byte-preserving `git show` subprocess reads compared disk, normalized disk, HEAD and pre-redesign `603b0a4` blobs:

| Migration | CRLF pairs on disk | CRLF→LF bytes equal HEAD and 603b0a4 |
| --- | ---: | --- |
| 0037_reporting_storage.sql | 559 | Yes |
| 0040_reporting_dependency_reads.sql | 345 | Yes |
| 0041_reporting_dependency_read_bounds.sql | 339 | Yes |
| 0042_reporting_access_paths.sql | 245 | Yes |

0037 raw SHA-256: `b745252780a61fe1739957a2fe4881900a44b156d3ac89252db6c5a9bd737baa`; LF SHA-256: `531bb2c5706b9ac4d73a7ca3dc74dead7e34a53160e57fe2971aaf061c6a6a4f`, matching the pinned expected value. The scoped diff contains no change to those migrations or reporting tests/helpers.

For the causal reruns, a `data:` URL preload in `poolOptions.threads.execArgv` wrapped `fs.readFileSync` only for `supabase/migrations/*.sql`, replaced CRLF with LF in returned strings/Buffers, and called `syncBuiltinESMExports`. The second run additionally filtered only `0064_scanner_wall_count_window_index.sql` from migration-directory `readdirSync` results. No migration/test file was edited. The first run left M1 failing; the second passed all 269 tests. Consequently the prior tuning review's explanation was valid for its baseline but cannot be carried forward unchanged to this redesign.

### Targeted source diagnostics

Additional stdin-only diagnostics transpiled the checked-in TypeScript in memory; none changed implementation or tests:

- Actual scheduler with injected clock/deferred reads: completed initial read at 0, request at 1,000 ms, next timer still at 60,000 ms; reads started at 0 and 60,000. Disable/re-enable at 65,000 while the second read remained unresolved started a third read, leaving two unresolved.
- Hook lifecycle diagnostic with controlled React hook cells/read callbacks and the real projection: completed A snapshot → B pending → A again returned `current` with no pending people without completing a new read. Changing only `roleAllowed` to false retained `current`, totals and last-known people. This is a focused state diagnostic, not a browser integration test; source inspection establishes the omitted generation/access dependencies.
- Actual `SharedScannerWall` rendered with React server rendering: stale valid totals still included “Leading today” and share text; “Totals delayed,” the site-scope explanation and CS/rework note were absent.
- Actual controller with an injected delivery that emits saving then throws: storage warning appeared, but saving progress remained. Returning an empty outbox view and refreshing did not remove it.

### Migration, font and scope assessment

`0064_scanner_wall_count_window_index.sql:29` contains one executable `CREATE INDEX IF NOT EXISTS`, non-unique B-tree on `public.production_events (location, created_at)`, partial on exactly `('line_verified', 'completed', 'dispatched', 'cancelled')`. This matches the `win` predicate and location/time range in `0035_load_production_evidence_v2.sql:61`. No existing migration, function, policy, grant, data or column changed; old application compatibility is preserved. `0064` follows checked-in `0063`. The comments disclose ordinary index-build write locking and staging checks. A matching predicate is not proof of an actual plan under kiosk RLS: the full query/context plan, existing-index reconciliation, installation cost and concurrent-save latency remain CJ's release gates. Leave the additive index in place on app rollback as the plan prescribes; the commented DROP alternative is not required rollback work.

CJ's approval of the index and the download source is recorded in the plan. TTF instead of WOFF2 is a disclosed packaging variance: regular/bold are approximately 54/55 KB, locally hosted with `font-display: swap`, system fallbacks, source provenance and OFL. This does not add an npm dependency or runtime Google request. I do not treat the format substitution as a blocker; the legibility/layout changes in M6 are separate.

No change to `Repository.ts`, either adapter, Classic page code, server endpoints, stock/credit RPC inputs, persistent outbox schema, environment/provider configuration, dependency manifests or root whitelist. Production remains intentionally Supabase-only; Dexie remains the existing device outbox. The new client reuses the strict evidence decoder and 20,000-row ceiling, and the projection reuses the shared counting rule rather than inventing stock/count math.

### Acceptance criteria and plan coverage

| Criterion / tasks | Assessment |
| --- | --- |
| AC1 / Task 4: approved composition and accessibility | Dark scoped styling, local fonts, wrapping names, semantic buttons and reduced motion are present. M6 blocks legibility/reflow approval; S2 covers error announcements. Coder's ordinary-state observations are recorded, but exceptional/zoom/hardware checks remain pending. |
| AC2 / Tasks 1–2: correct person/team totals | Pure projection tests pass for shared set rules, cancellation/context, normal/rework, distinct mixed orders, duplicate people, ties and missing-person zero. Binding readiness, stale competition and scope labels fail M2–M4. |
| AC3 / Tasks 1–2/5: bounded safe reads | Existing invoker RPC, complete-envelope validation, row ceiling, site 04:00/DST helpers and deadline are reused. Access/generation and scheduling fail M2/M3/M5. Actual indexed performance and roles remain staging gates. |
| AC4 / Tasks 3/5: true progress and original attribution | Checking/saving callbacks are placed around actual work; thrown observer is contained; prepared replay and old-person save matching pass. M7 covers missing/inaccurate progress lifecycle. No changed write contract was found. |
| AC5 / Tasks 3–5: preserve tuning | Existing parser/recovery/session/gesture rules and 15-minute constant remain; elapsed time is separate from wall clock. Tuning regressions pass. S1 identifies the new goodbye mismatch; no new clock-out path exists. |
| AC6 / Tasks 4–5: Classic/Dispatch/operator access | Existing warnings, queue distinctions, uncertain classic prohibition, two-step mode/exit/dismiss and Dispatch attribution/chooser are retained; matching-mode panels omit Framing competition in Dispatch. CSS can hide these controls (M6). Existing scanner key capture still prevents scanner Enter activating operator buttons; physical/keyboard interaction needs staging evidence. |

Task 5 did not add the planned combined parser/delayed-save/count-refresh integration coverage; existing tuning tests do not exercise the new hook. A missing DOM test dependency is not a reason to omit testable generation/access/scheduling state: extract a pure lifecycle boundary or use existing facilities, without adding dependencies silently. Closing M2–M7 requires regression evidence for the actual failing paths.

## Hardening and guardrail audit

Each question in `docs/HARDENING.md` is addressed below. “Unchanged” refers to this redesign comparison, not certification of all historical code.

| Checklist question | Evidence / disposition |
| --- | --- |
| 1 — Network/Supabase/Shopify slow/down | Durable queue and existing preflight remain; statistics are separate from delivery. Read timeout/ceiling errors are surfaced, but stale presentation and stopped progress need M4/M7. Dropbox/Slack/Make are n/a: no calls added. |
| 1 — Retry/duplicate writes | No new write path or idempotency rule. Observer failures are contained; prepared retry skips checking and preserves exact payload in passing tests. |
| 1 — Two people/devices | Captured attribution and existing queue leases/server concurrency contract unchanged; per-person panel filtering passes. Single-flight statistics and binding generations need M3/M5. Actual server races remain staging checks. |
| 1 — Bad input/unknown badge/missing SKU/cancelled/wrong site | Strict parser, tuning classifier and preflight unchanged; regression tests pass. New goodbye cleanup needs S1. |
| 1 — Failure display/recovery | Persistent garbled-scan recovery remains independent of ordinary results; uncertain jobs still forbid Classic re-recording. M4/M6/M7 and S2 concern stale labels, reachable recovery, stopped progress and announcements. |
| 2 — Person/department attribution | No event/department mutation; jobs retain captured person/mode and last-order display filters by current person/mode. Display binding generation needs M3. |
| 2 — Shared order/item/set rule | `buildScannerWallTotals` delegates to `summarizeProduction` over normal framed/A0 work and distinct active people. Team orders are a union; shares use individual order credits. Tests pass. Labels/rework disclosure need M4. |
| 2 — Historical changes | No historical rewriting, settings-dependent recount formula or new receipt-based total. Existing evidence snapshots/corrections drive projection. |
| 2 — UTC/site-local time | Shared production-day helpers and site timezone used; 04:00/DST fixtures pass. Separate `performance.now()` drives gesture countdown. Scope/rollover cancellation needs M5; real sleep/resume boundary checks pending. |
| 2 — Manual/inferred versus measured | Dispatch manual framer labels remain. No productivity/time estimate introduced. Old statistics/goodbye values require freshness labels (M4/S1). |
| 3 — Endpoint auth/input validation | No new endpoint; existing authenticated invoker RPC and strict decoder reused. Caller access/visibility and cached-data invalidation need M2. |
| 3 — RLS/grants | No new table/policy/grant or privileged read client. Existing RLS unchanged; real role and cross-site reads remain staging gates. |
| 3 — Secrets/logs/messages | No secret/env/logging change or external message path. Font provenance contains public source URLs only. |
| 3 — Cost/spam/data exposure | One site-day request rather than per-person/per-item fan-out, row ceiling and deadline present. Overlapping reads/access retention need M2/M5. No emails/subscriptions added. |
| 4 — Expand-only/old app compatibility | 0064 only adds a non-unique index; old code remains valid. Migration-list integration requires M1. |
| 4 — Switch off without deploy | Existing Classic station action remains and keeps queued work. It must stay reachable under M6; uncertain work must resolve through its original request first. |
| 4 — CJ release sequence/configuration | Plan specifies tuning first, staging index reconciliation/application and query plans, Preview checks, CI/review, rollback target, quiet production application, release/receiver refresh and monitoring. No new env/Shopify/Make/Slack configuration. Agents perform none of these release actions. |
| 4 — Staging per role | Spec's seven-step checklist covers kiosk, owner/manager inspection, staff/CS denial and existing read visibility, anonymous/cross-site, hardware, real credit/stock/replay and broader smoke tests. Not executed here. |
| 5 — Months of events/indexes | Current-day window and partial index match. Linked qualification/parent/later-cancellation context can span history; plans under RLS with two-year data remain mandatory, not inferred from index DDL. |
| 5 — External API per item | None added. Existing one-order preparation retained; one evidence read serves all active people. |
| 5 — Two years/three sites | Day/site scope, row bound and 200-entry progress cap present. Scheduler concurrency and progress pruning need M5/M7; representative-volume staging evidence pending. |
| 6 — Detecting production failure | Existing online/auth/storage/focus/audio/wake/queue warnings and heartbeat path retained; totals add freshness state. M4/M6/M7 prevent trustworthy visible operation until fixed. No new remote alert claimed. |
| 6 — Manual fallback | Classic remains for definite refusals, not uncertain commits. Storage failures retain jobs; do not clear browser data. Reachability needs M6. |
| 6 — Ongoing maintenance | Monitor read latency/failures, index size/write cost, queues/uncertainty and receiver health during rollout. No new token/subscription or persistent statistics store. |
| 7 — Pure logic/edge cases | Added projection/reader/scheduler/progress/render tests pass, but targeted diagnostics expose missing lifecycle paths. M2–M7 require regression coverage. |
| 7 — Inventory/credit/money old and new | No changed deduction or credit logic in redesign. Existing tuning old/new preparation, immutable replay, outbox and Dispatch suites pass; actual atomic RPC/stock races still require staging. |

AGENTS.md's append-only, secrets, whitelist and dual-backend scope rules are respected. Five task commits and log entries exist. CI green, all tests passing and complete planned verification are not established. This review makes no release approval claim.

## Remaining release evidence

After the fixes and another review, CJ still needs green PR CI and the complete spec staging checklist: 0064 reconciliation/install and full underlying RPC plans as kiosk, two-year/three-site volume and concurrent-save measurements; same-cutoff F1 reconciliation; real role/site tests; read/save failure isolation, reload/rebind/04:00/DST; hardware gesture/recovery/idle behavior; font/layout/zoom/accessibility; unchanged Dispatch/Classic and the release smoke tests. The index, font download and design already have recorded authorization; these are evidence gates, not requests to reapprove those decisions.

## Coder response

All must-fix and should-fix items addressed in one commit (`review r1: ...`). Also applied CJ's font instruction given in chat during this round (see last bullet).

- **M1 fixed.** `0064_scanner_wall_count_window_index.sql` added to `NON_REPORTING_MIGRATIONS` in `tests/reporting/pg/harness.ts` (same pattern as 0047/0052–0056/0063); `reportingJobs.test.ts` now fails only at its CRLF hash line on this Windows checkout. New `tests/scanners/scannerWallIndex.test.ts`: the file is exactly one `CREATE INDEX IF NOT EXISTS` with the evidence RPC's predicate, contains no other DDL, applies twice to the PGlite reporting bootstrap, and is chosen by a site-day query plan.
- **M2 fixed.** New pure `wallTotalsAccess` (`src/lib/scanners/wallTotalsScope.ts`): site-wide role (via `productionVisibilityFor`) **and** confirmed site membership (`auth.locations`), operator role, caller, client and report site. The hook returns an empty view in the same render when access is false; the scope key includes caller, role, membership, operator flag, site, day and mode; loaded data, errors and last-known numbers are tagged with that scope and ignored under any other; disabling/disposing aborts the running read (`AbortSignal` now passed to the loader).
- **M3 fixed.** `createBindingGeneration` (monotonic; every map change, including A→B→A and A→empty→A, is a new generation) is observed during render; each read records the generation it started under; numbers are ready only when that equals the current generation; last-known numbers are recorded only from ready reads.
- **M4 fixed.** Leaders, ranks, joint lead and share bars require `status === "current"`, no pending people and complete data; stale shows "Totals delayed · last updated <site time>" with last-good figures only. Labels now "Today · people on this wall" / "Saved framing at this site · day starts 04:00", plus "· CS/rework excluded" when `hasRework`.
- **M5 fixed.** `wallTotalsRefresh.ts`: a request installs its 5 s timer whenever the existing (periodic) timer is due later; the running read keeps the single slot until it settles even after disable (which aborts it), so hide/resume can no longer overlap RPCs. Tests: save at +1 s after a fast read starts at 5 s; disable aborts, resume waits for the aborted read, nothing published by it; dispose aborts.
- **M6 fixed.** No fixed height or hidden overflow: `.scanner-wall` is `min-height: 100vh` and reflows/scrolls; recovery + latest result sit in a `position: sticky` bottom dock (max 60vh, scrolls itself) so they stay visible without clipping anything. Sizes restored: names 56 px, counters 64 px, result title 40 px, all supporting text ≥ 16 px. Browser check at 1280×800 with fixture data: the Main state is exactly 800 px; with recovery + result it is 894 px, the dock stays on screen and the rest scrolls.
- **M7 fixed.** `refreshView` reconciles panel progress with the stored queue (queued/prepared jobs shown, including ones retained across a reload; finished/blocked/vanished ones dropped; a queue read failure clears all progress); a storage error in the pump triggers that refresh; a `waiting` report sets a new `waiting` phase ("Waiting to save (will retry)") instead of dropping it; `superseded` leaves it to reconciliation. Tests for reload, finish-elsewhere, unreadable queue and waiting.
- **S1 fixed.** A known-source protocol error ends that scanner's goodbye (others kept). Goodbye figures come only from last-known ready reads and show "as of <site time>"; with no known numbers no figures are shown.
- **S2 fixed.** The result region is `aria-live="assertive"` with `role="alert"` for rejected/already-recorded results, `polite` otherwise; counters and countdowns remain outside live regions.
- **CJ fonts (2026-11-25, chat):** "use the font Frutiger for headlines, and Inter on sub texts please. for numbers use Helvetica Nueue. if these are not available, then use alternative." Frutiger and Helvetica Neue are commercial and not bundled. Stacks: headlines `Frutiger, "Frutiger LT Std", "Frutiger LT Pro", "Atkinson Hyperlegible", …`; text `Inter, …` (Inter is already loaded app-wide by index.html); numbers `"Helvetica Neue", Helvetica, Inter, Arial` with tabular figures. On the Android tablet the effective faces will be Atkinson / Inter / Inter unless licensed fonts are installed.

Checks: `npx tsc -b` exit 0; `npm run build` exit 0; `npm run test -- --run` 3673 passed / 6 failed (the known CRLF set; `reportingJobs` now only at its hash line).
