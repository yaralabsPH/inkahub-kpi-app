# Review: Station order screen redesign — round 2

- Slug: `station-screen-redesign` · Branch: `feature/station-screen-redesign` · Reviewed commit: `9c0289e5a8e8df17de99fd4870956dfd8c3bb3c4`
- Reviewer: planner (Codex)
- Verdict: **approved**

The round 1 blockers are closed, including acceptance of the alternative testing approach for Must-fix 3. One nonblocking responsive-layout issue remains under Should-fix; the coder's claim that this finding is fully resolved is too broad. Approval is a code-review verdict, not confirmation of staging acceptance or green PR CI.

## Checked against

- [x] Spec acceptance criteria — CJ approved proceeding without a separate spec; reviewed the plan's Approach, settled CJ decisions and accepted gaps. The original reference prototype was not independently available.
- [x] Plan tasks — all four tasks, implementation log, and round 1 coder response checked against the implementation.
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist).
- [x] `docs/HARDENING.md`, every section — assessment below.
- [x] Roadmap decisions for this feature (`docs/ROADMAP.md`); F3/F4/F6/F7 remain outside this scope.
- [x] Tests cover the new logic; type-check, tests and build pass — equivalent in-memory config was necessary for test/build execution in this sandbox, as detailed below.

Read AGENTS.md, ARCHITECTURE, ROADMAP, HARDENING, the approved plan, round 1 including its Coder response, and the review template. Reviewed the fixes with `git diff d35a98e..HEAD` and rechecked the complete branch with `git diff main...HEAD`, using whitespace-normalized inspection of Production. Local `main` and the merge base are `57b89d2bec371c2aca66c2098fa2e57c7e3d73a7`. The full comparison includes inherited F2 order-display work, whose helper, component, tests and integration were also checked. Classic/dispatch therefore retain the inherited F2 presentation changes relative to main; their completion behavior is preserved.

## Must-fix

None.

## Should-fix

1. **Round 1 Should-fix 1 is only partly resolved: set information still clips outside the new width tier.** `src/components/production/station/station.css:161`, `:228`, `:242` — wrapping at widths up to 1180px fixes the reported 1024×768 case, but above that breakpoint `.st-specs` again uses `nowrap` and `overflow: hidden`. With the actual component, built CSS and system fonts, a quantity-two `INKA-S2BON0064-A0-FN` line with Portrait orientation still clips its SET chip: at **1194×800**, the spec container ends at x=964 while the chip spans approximately x=947–1036; at **1440×800**, the container ends at x=1136 while the chip ends at x=1168. The max-width layout also preserves clipping on wider desktop viewports. Let chips wrap whenever their available card width requires it, with a corresponding growing card, or otherwise guarantee all chips fit. Verify both sides of the 1180/1400 breakpoints, including set and multi-quantity rows. This retains the original finding's nonblocking status: the reported 1024px case is fixed, the frame and quantity labels are visible in these probes, and no counting, verification or completion behavior changes.

## Nitpicks

None.

## Round 1 disposition

| Finding | Result and evidence |
| --- | --- |
| Must-fix 1 — unreachable sidebar actions | **Resolved for the reported combined state.** `.st-side-body` scrolls above the separate `.st-actions` block. With replacement details, customer name, two box rows and a save error at 1280×800, Complete is at y=636–694 and Scrap at y=704–754. Expanding scrap confirmation keeps the full confirmation at y=628–754 and Complete at y=560–618. The scroll body has 685px of content in 457px, shrinking to 381px when confirmation opens. At 1024×768, both buttons also remain inside the viewport. The committed render test protects content placement; the independent browser measurement checks the actual layout. |
| Must-fix 2 — reduced-motion auto-scroll | **Resolved.** `StationOrderScreen.tsx:352` uses `scrollTargetFor` and reads the motion preference before calling `scrollBehaviorFor`. Unit tests cover both preferences. Mounted probes recorded `auto` with reduced motion for initial selection, saved verification and undo; switching to normal motion produced `smooth` on the next current-card change. |
| Must-fix 3 — Complete contract and stateful regressions | **Closed by accepting the revised approach**, with the qualifications and independent integration evidence below. The branch adds 16 pure-rule tests and expands screen render tests from 9 to 12. Old/new/dispatch completion, both packaging modes, saved-state toast changes, quantity steps and scrolling decisions are covered. |
| Should-fix 1 — hidden tablet attributes | **Partly resolved.** All four chips fit or wrap at 1024×768 and 1180px; the remaining breakpoint problem is documented above. |
| Should-fix 2 — rollback with unavailable storage | **Resolved.** `Production.tsx:173` separately catches access to sessionStorage; `readTabOverride` preserves a valid URL selection when storage is absent or throws. Tests cover these cases. The plan now records that a remembered new override takes precedence over a classic environment setting. |
| Should-fix 3 — gift-card status | **Resolved.** `StationOrderScreen.tsx:577` selects NO CHECK NEEDED before the other-station branch for unverified, non-verifiable lines. The render test now uses the real gift-card routing shape (`belongsToThisDept: false`); actual other-station work retains its station label. |
| Should-fix 4 — menu keyboard behavior | **Resolved through the permitted disclosure alternative.** The toggle has `aria-expanded`/`aria-controls`; contents are ordinary controls without menu/menuitem roles. Mounted checks confirmed opening focuses Sign out, Tab reaches Back to app, and Escape closes and restores focus to the toggle. Outside mousedown closes the disclosure; contrary to the coder's wording, that path does not explicitly restore toggle focus, which is appropriate when clicking another control and is not a blocker. |

## Must-fix 3: assessment of the disagreement

**Accept the no-new-DOM-dependency approach for this change.** AGENTS.md guardrail 7 says dependencies need a reason in the plan; it does not prohibit DOM testing or make missing tests acceptable. HARDENING §7 requires unit tests for pure logic and old/new behavior tests for inventory or credit changes, but does not prescribe jsdom, Testing Library, or a mounted whole-page harness. The approved plan also explicitly calls for pure logic and render tests without dependency changes. Extracting the changed completion decision into an executable, tested function is a proportionate way to meet that requirement here.

The acceptance rests on the code and evidence, not solely on avoiding a dependency:

- `completeBlockReason` is called by the actual shared completion handler before `insertEvent` or the deduction RPC. The committed tests cover partial/all-required verification, the classic one-verified-line floor, dispatch exemption even with a new override, and other-station/non-verifiable exclusions.
- The classic action bar now uses the tested packaging predicate. New-screen render tests exercise empty/filled scanned boxes and empty/assigned automatic tubes. Both modes remain blocked when required packaging is absent.
- The component calls the tested saved-set comparison and scrolling helpers. A keyed `WorkingView` remount resets local pieces, toast and scrap confirmation when the order number changes. Mounted review probes independently confirmed the relevant callback/effect behavior.

Two limits to the coder's explanation matter. The new screen does **not** call `completeBlockReason` or `packagingBlocksComplete` directly: its button uses `buildStationProgress(...).allDone` and the `required`/row-count expression at `StationOrderScreen.tsx:384`; the handler is the shared write boundary. Also, pure tests do not themselves execute effects or prove callback wiring, and the quantity-two unit test does not establish exactly-once writes under repeated taps. I checked that wiring separately rather than treating those claims as proven by the pure suite. Existing handler in-flight/idempotency limitations remain unchanged.

This supersedes round 1's demand for a newly committed mounted harness as a blocker. The committed suite now protects the changed business decisions; direct code review and the independent probes below establish the thin integration for this revision. Those one-off probes are not a persistent CI/browser suite, and staging remains necessary.

## Classic/dispatch equivalence and full-branch recheck

- **Classic packaging:** the old expression was `(a0_framed || dispatch || unframed) && !packagesSet`. The new call passes `packagesSet ? 1 : 0`; `stationNeedsPackaging` names exactly those same three departments, and the predicate checks count zero. All eight combinations of four departments and boolean package presence produce the same result. `packagesSet` still derives from map presence, not package quantity totals. Framed remains exempt; dispatch remains packaging-gated in the UI.
- **Completion:** `completeBlockReason` returns immediately for dispatch, before checking counts or lines. Classic still rejects only when `Math.max(ref.size, state.size) === 0`. The new rule still checks only station-owned, verifiable lines against the union of ref/state membership. Dropping the optional department argument to `isSkuVerifiable` changes nothing: that argument is unused in its current implementation. Staff/order/busy guards, event type, staff identity, case tag, quantity, success counter, component/package deductions and delayed clear remain unchanged.
- **Executable comparison:** a read-only, in-memory probe extracted the actual `handleCompleteOrder` callback bodies from main and HEAD with the TypeScript AST. With mocked write sinks and catalogue-routing collaborators, 288 comparisons/assertions across departments, UI modes and ref/state verification combinations passed. Classic event/RPC/counter traces matched main; dispatch also matched with a forced new mode; rejected new-screen cases emitted only the error, with no event/RPC call. Three additional missing-staff/order/busy cases produced no action. This exercises the callback source, not a mounted Production page or a real database.
- **Packaging boundary:** neither old nor new handler adds an internal packaging rejection. This remains the existing UI-only boundary, not a new regression or a claim of server enforcement. F4 is not implemented by this branch.
- **Other scope:** no repository contract/adapter, endpoint, migration, auth/RLS, query/filter, SKU routing/counting function or dependency changes. Verification and undo still delegate to the existing handlers. Replacement context, notes, packaging operations, manual lookup and errors remain wired. The separate new-screen clock-out helper still reproduces classic's existing payload, note strings and idling behavior. No new inventory arithmetic or reporting semantics were introduced by the fixes.

## Hardening assessment

Each section was rechecked against the full branch. Inherited limitations in ARCHITECTURE are not certified as fixed by this presentation change.

| Section | Assessment |
| --- | --- |
| 1 — Failure modes | Existing service errors and retries remain visible; pinned actions resolve the reported recovery-control obstruction. Pending/failed verify or undo does not produce a new success state. Barcode parsing, missing/legacy SKU handling, cancellation confirmation and site handling remain unchanged. No new durable write/retry protocol or multi-device coordination is introduced; existing concurrency, preflight fail-open and deduction-error limitations remain. Google Fonts has local fallbacks. |
| 2 — Data correctness | Worker, station, location, case attribution, event quantities and historical records are unchanged. New screen progress/piece counts are local presentation state, not a new KPI rule. No inferred fact is persisted; automatic packaging remains labeled. UTC writes remain unchanged; verifier time labels still use browser-local time, so staging must check kiosk timezone against the site. |
| 3 — Security | No new endpoint or table, so new authentication, validation, RLS and grants are n/a. Existing navigation/auth and database boundaries remain. No secrets or sensitive logging added; the VITE flag is public UI configuration. No new email, costly API-per-item operation or data exposure surface; approved font requests are unchanged by the fixes. |
| 4 — Release/rollback | No schema changes; previous code uses the same database. The no-deploy classic URL fallback now survives unavailable storage. Environment classic requires rebuild/redeploy and does not override a remembered new tab choice. CJ retains staging, CI, merge and deployment ownership; the staging handoff below supplements the plan's brief release notes. |
| 5 — Performance | No history queries, filters or indexes change; no new per-item external calls. The new computations are bounded by the loaded order, not two years of events across three sites. Existing backend row-limit/scaling concerns remain. The remaining responsive width issue is recorded above. |
| 6 — Operations | Existing errors/logs and the focus indicator remain; Scanner live still means focus, as accepted by CJ, not scanner or service health. Manual order entry, classic mode and the previous frontend deployment remain fallbacks. No new storage lifecycle, webhook subscription or expiring credential to maintain. |
| 7 — Tests | Committed pure tests now cover the changed completion/packaging decisions for old and new behavior; render tests cover both packaging UI modes. Fresh suite/build results and independent callback/browser probes are below. These do not certify actual inventory RPC idempotency or substitute for staging role/hardware tests. |

AGENTS.md additionally: migration history and both repository implementations remain untouched; no new dependency or top-level source directory requires a plan justification or whitelist change. Task checkboxes, implementation log and branch commits are present. PR CI was not checked remotely. Pre-existing untracked `.claude/launch.json` and `tests/staging/` were not edited or executed. Only this review was authored; no commit, push, state-changing git command, deployment or SQL application was performed.

## Verification performed

Used Windows `.cmd` entry points for npm/npx. No staging or production database, real order session, or external integration was contacted.

| Check | Result |
| --- | --- |
| `npx.cmd tsc -b` | **Passed**, exit 0. |
| `npm.cmd run test -- --run` | Attempted; esbuild could not load `vite.config.ts` because `Cannot read directory "../..": Access is denied`. No tests ran through this invocation. |
| `npm.cmd run build` | Attempted; TypeScript completed, then the same sandbox restriction prevented loading `vite.config.js`. |
| Equivalent in-memory Vitest config | **Passed: 430 tests in 6 files**, exit 0. Used `startVitest('test', [], {run:true}, {configFile:false, plugins:[react()], resolve:{alias:{'@':path.resolve('src')}}})`, then closed the runner. |
| Equivalent in-memory Vite build | **Passed**, exit 0. Used `build({configFile:false, plugins:[react()], resolve:{alias:{'@':path.resolve('src')}}})`. Together with the separate TypeScript result, both stages are verified. |
| Completion callback and packaging probes | **Passed:** 288 callback comparisons/assertions, three early-exit cases and eight classic packaging truth-table cases, as described above. Initial probe setup was corrected to retain module exports; the reported results are from the successful rerun. |
| Headless Chromium, actual component and built CSS | Synthetic props and mocked callbacks; all network requests blocked. Confirmed combined sidebar reachability, expanded scrap confirmation, 1024px wrapping, both motion preferences, quantity-two callback timing, no new done state on pending/failed verify, saved verify/undo toasts, pending undo retaining checked state, new-order piece/toast reset, and disclosure keyboard focus. No page errors. Wider-width probes identified the remaining Should-fix. |

The mounted quantity-two probe made no verify callback on piece one and one callback on the final-piece tap; save failure left the line unchecked, saved state produced the done toast, and saved undo reset the piece label. It does not claim exactly-once persistence under concurrent/repeated requests. Browser scripts and handler fixtures stayed in memory; no test harness file or dependency was added.

Build warnings remain stale Browserslist data, mixed static/dynamic XLSX imports and a main JS chunk of approximately 2.13 MB minified / 605 KB gzip. Normal CLI checks still need to pass in CI; fallback success does not erase their sandbox loader failures.

## Staging handoff before release

The round 1 staging handoff remains applicable and is not marked complete by this review. CJ should record results against staging Supabase and synthetic orders:

1. **Kiosk and owner/manager stations:** exercise Framed, A0 Framed and Unframed; mixed departments, gift/legacy/set/quantity-two lines; verify, undo, slow/failed saves and retry; worker switching; completion/scrap and clock-out. Compare event credit and inventory outcomes with classic. Confirm partial verification blocks new completion while classic retains its old rule.
2. **Packaging/dispatch:** A0 empty/add/remove/clear boxes and Unframed missing/assigned tubes; dispatch stays classic for both URL overrides and preserves its packaging gate and completion exemption.
3. **Role/site isolation:** default staff/CS page restrictions and permitted owner/manager/kiosk behavior remain unchanged; test explicitly granted production access without widening RLS. Check AU/UK/US timezone settings.
4. **Actual hardware/UI:** keyboard/scanner focus, notes/manual lookup, light/dark and font fallback, long orders/errors, replacement plus packaging content, expanded scrap, reduced motion and the installed tablet dimensions. Account for the nonblocking set-chip clipping above when evaluating the actual device.
5. **Release/rollback:** obtain green normal PR CI and complete RELEASING.md smoke tests. No SQL or integration setting change is required. Record the previous deployment. Test `?ui=classic` per affected tab, including a remembered new override; use a previous frontend deployment for whole-release rollback. Agents do not merge or deploy.

## Coder response

**Should-fix 1: fixed.**
- `.st-specs` now wraps at every width, and cards use `min-height: 156px` (with 14px vertical padding) instead of a fixed height. Chips only wrap, and the card only grows, when they truly don't fit. Nothing is ever clipped.
- The separate SET chip is gone. The title row's `SET (n)` tag already carries the count, so rows stay at three chips.
- Measured in the browser with an `INKA-S2BON0064-A0-FN`, quantity 2, Portrait line added to the sample order. No chip overflows its container or card at any of these widths: 1024×768, 1181×800 and 1194×800 (both sides of the 1180 breakpoint), 1280×800, 1401×800 (above the 1400 breakpoint) and 1440×900.
- At 1194, 1280 and 1440 every card is exactly 156px. Only the A0 set card grows, to 200px at 1181 and 193px at 1024.
- New test: "shows a set print's piece count as a title tag and keeps three spec chips".

Checks: `npx tsc -b` passes; `npm run test -- --run` passes (6 files, 431 tests); `npm run build` passes.
