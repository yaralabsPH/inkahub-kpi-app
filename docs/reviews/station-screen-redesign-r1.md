# Review: Station order screen redesign — round 1

- Slug: `station-screen-redesign` · Branch: `feature/station-screen-redesign` · Reviewed commit: `ada836093a1d7163843e1184393553b677d97af0`
- Reviewer: planner (GPT-6 Astra)
- Verdict: **changes required**

## Checked against

- [x] Spec acceptance criteria — no separate spec, as approved by CJ; used the plan's Approach, CJ decisions and accepted Gaps. The original reference prototype was not independently available for comparison.
- [x] Plan tasks — checked all four tasks and the implementation log; findings below prevent accepting all completion claims.
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist).
- [x] `docs/HARDENING.md`, every section and question — assessment below.
- [x] Roadmap decisions for this feature (`docs/ROADMAP.md`). F3, F4, F6 and F7 remain future work; their absence is not a defect in this approved scope.
- [ ] Tests cover the new logic; type-check, tests and build pass — execution evidence is below, but the completion-handler and interaction coverage is incomplete.

Reviewed `git diff main...HEAD`, with whitespace-normalized inspection of `Production.tsx` to distinguish behavior changes from line-ending churn. This comparison also contains the earlier F2 order-display work through merge `8519ac9`. Its presentation helper, component, tests and integration were inspected. Relative to that merge, the station redesign leaves classic and dispatch markup/handlers intact. Relative to local `main`, those screens do receive the inherited F2 line presentation; they are not literally unchanged visually.

## Must-fix

1. **P1 — Keep sidebar actions reachable when the retained panels are present.** `src/components/production/station/station.css:20`, `:67`, `:102` — the viewport root clips overflow, the sidebar has no scroll container, and the action section cannot shrink. The done list is the only sidebar content allowed to scroll, so replacement details, packaging and errors can consume more than the available height. Reproduced in headless Chromium using the actual rendered component and built CSS, system font fallback, at **1280×800**: an A0 replacement with a customer name, one scanned box and a short save error placed Scrap at **y=776–826**, while document height remained **800**. Its lower portion cannot be reached by scrolling the page. More box rows or a longer error also push Complete below the viewport. This breaks the accepted requirement to retain packaging, replacement context, errors and actions on the shop-floor screen. Give the sidebar an overflow strategy that keeps both actions reachable, including the expanded scrap confirmation, without dropping those panels. Add a browser/layout regression case for their combined state, not just the clean sample order.

2. **P2 — Respect reduced motion during automatic scrolling.** `src/components/production/station/StationOrderScreen.tsx:327` — `scrollIntoView` always requests `behavior: "smooth"`. The CSS media query at `station.css:235` disables CSS animations/transitions, but cannot override this explicit JavaScript scrolling request. A mounted browser probe with `reducedMotion: "reduce"` still recorded smooth scroll calls on initial current-line selection and after undo. Task 3 explicitly includes reduced motion. Choose non-animated scrolling when that preference is enabled, retain normal auto-scroll otherwise, and cover both paths.

3. **P2 — Add regression coverage for the changed Complete contract and stateful screen behavior.** `src/pages/Production.tsx:995`; `src/components/production/station/__tests__/StationOrderScreen.test.tsx:2` — all nine screen tests use `renderToStaticMarkup`; none executes a callback or effect, and no test exercises `handleCompleteOrder`. The pure resolver/progress tests cannot catch incorrect wiring of the new restriction into classic or dispatch, nor premature completion/event writes. The A0 packaging test at line 121 checks text but does not assert that the button is disabled, and the Unframed auto-tube block has no test. Add tests for: new screen rejects partial verification and accepts all required lines; classic retains its one-verified-line rule; dispatch remains exempt even with a new-UI override; other-station/non-verifiable lines do not block; both required-packaging modes disable Complete when empty and enable it when populated. Exercise the actual handler integration with writes mocked, including no write on rejection. Also retain mounted regressions for delayed/failed verify and undo, quantity-two final-piece dispatch, order-change piece reset, and current-card scrolling. These are the changed credit/inventory entry point and the stateful behavior explicitly claimed by Tasks 3–4 and HARDENING §7.

## Should-fix

1. **Tablet width can hide production attributes.** `src/components/production/station/station.css:156`, `:226` — the only width tier still combines a 316px sidebar with non-wrapping spec chips clipped by `overflow: hidden`. At **1024×768**, an A0 Natural Timber set with quantity two had a spec container ending at x=794, while the frame chip ended at x=810 and quantity/set chips started at x=818/x=947. Quantity and set details disappear. The 1280×800 clean sample did fit. Add a narrower layout or wrapping strategy for tablet/zoom widths and verify frame, quantity and set labels remain visible.

2. **The URL rollback should survive unavailable session storage.** `src/pages/Production.tsx:167` — parsing `?ui=classic` and storing it are inside the same `try`; if `sessionStorage.setItem` throws, the catch returns `null` and discards the valid URL instruction. Return the URL choice even when remembering it fails. Also document that a remembered `?ui=new` overrides `VITE_STATION_UI=classic`: an environment rollback alone does not reset those tabs. Opening each affected station with `?ui=classic` does, under normal storage conditions.

3. **Real gift-card routing misses the no-check label.** `src/components/production/station/StationOrderScreen.tsx:552` — `isLineMyDept` marks gift cards as belonging to no station, so real gift rows enter the `other` branch before the non-verifiable branch and say `OTHER STATION`. The test manufactures a gift with `belongsToThisDept: true`, masking this. Prefer the no-check status for non-verifiable lines even when they are in the reference group; preserve the distinction from work another station must perform. Completion counts correctly exclude them already.

4. **Finish menu keyboard behavior.** `src/components/production/station/StationOrderScreen.tsx:167` — `role="menu"`/`menuitem` are declared, but opening does not move focus, arrow-key navigation is absent, and Escape does not close/restore focus. Implement the menu keyboard pattern or use a simple disclosure containing ordinary controls. Native check/undo buttons, manual-input labeling, error alerts and toast status semantics are otherwise present.

## Nitpicks

None.

## Scope and correctness findings

- **Saved data and queries:** no changes to repositories, domain routing/counting functions, endpoints, migrations, query filters, event types/payloads, inventory RPC calls or dependencies. New line controls delegate to the existing verify/unverify handlers; notes use the same panel and props. The new clock-out helper reproduces the existing insert payload and failure/idling behavior, including the existing note strings. It duplicates rather than shares the classic implementation, but does not introduce different event semantics.
- **Complete scope:** the resolver always returns classic for dispatch before considering overrides. The handler adds the all-required-lines check only inside the non-dispatch branch and only when `stationUi === "new"`. Its predicate is `belongsToThisDept && isSkuVerifiable(...)`; the screen model uses the same effective predicate (the helper currently ignores its optional station argument). Classic retains the old at-least-one check, dispatch remains exempt. The old at-least-one floor also remains in the new handler; an order with nothing actionable remains non-completable, consistent with the plan's promise not to weaken today's gate.
- **Packaging:** the new adapter supplies `required: true` for A0 Framed and Unframed. Empty package rows disable the new Complete button; nonempty rows correspond to the same map-size check used by classic `OrderActionBar`. A0 scan/removal/clear callbacks and Unframed auto-assignment are unchanged. Neither implementation adds a packaging guard inside `handleCompleteOrder`; that is an existing UI-only boundary, not a new regression. Do not remove these blocks as part of this redesign or implement F4 here.
- **Grouping and current line:** stable group ordering is frame, flat, other, with original order within each group. Frame-only products join framed prints, canvas/unframed join flat, and other-station lines are informational. Current selection is the first required unchecked line in displayed order; done entries sort newest first by saved verification time. Legacy data is not given invented frame/size attributes.
- **Piece counts and toasts:** piece taps count Shopify quantity locally, not physical set constituents; the set badge carries the constituent count. This is the accepted screen-only workflow, not an F1 KPI change. Last-piece taps call the existing per-line handler; partial state is intentionally lost on reload. A mounted Chromium probe confirmed: first of two taps changes local progress without invoking verify; second invokes verify without a success toast; providing saved verification state produces the done toast; undo similarly waits for removal from saved state. Failure/no state change does not produce done/undo success. This probe used mocked callbacks, not a database.
- **Rollback:** normal `?ui=classic` selects the old screen and old Complete rule, with the selection remembered for the tab; `?ui=new` selects the new screen except at dispatch. Build-time classic works when there is no overriding tab preference. No schema/data rollback is needed. Storage-failure and precedence limitations are described above.
- **Plan deviations:** scoped `station.css` instead of Tailwind tokens is documented in the implementation log and confines the design variables. Google Fonts with system fallbacks was approved. The missing named `useStationUi()` hook is not a functional defect; the resolver and memoized adapter implement the selection. CJ's decisions and accepted gaps were not reopened.

## Hardening assessment

Each question in `docs/HARDENING.md` was checked; “unchanged” is not a claim that the inherited system is fully hardened.

| Item | Assessment |
| --- | --- |
| 1 — Down/slow services | Existing lookup/save errors still reach the new error alert. Verify/undo state remains unchanged until saves succeed. No new Supabase/Shopify/Dropbox/Slack/Make requests; Google Fonts falls back locally. Sidebar clipping can obstruct recovery controls (must-fix 1). Existing preflight fail-open and deduction console-only failures remain. |
| 1 — Retry/idempotency | Existing in-flight verify guard is reused. No new durable write or idempotency design. Completion/undo and the inventory RPC retain the limitations documented in ARCHITECTURE; this review does not certify exactly-once behavior. |
| 1 — Concurrent people/devices | Worker capture, server state loading and concurrency controls are unchanged; no new cross-device coordination. The stricter Complete gate checks local verification state, not a fresh transactional server snapshot. |
| 1 — Bad input | Barcode parsing, missing-SKU filtering, cancelled-order confirmation and site handling are unchanged. Pure legacy SKU display is covered; real gift/no-check presentation needs the correction above. No new cross-site validation is claimed. |
| 1 — Failure/recovery UI | Error alerts and manual lookup remain. Classic is the fallback; retry uses the existing handler. Reachability of actions with error/replacement/packaging content is a blocker. |
| 2 — Attribution | Existing handlers continue to write scanned worker, station department/location and case ID. Presentation does not reassign credit. No new identity lookup or author is introduced. |
| 2 — Orders/items/sets | Existing daily counters and event quantities are unchanged. New screen progress counts required lines and local quantity units; set badges remain. Shared F1 KPI consolidation is still future work and is not silently introduced here. |
| 2 — Historical correctness | No event rewrite, schema update or settings mutation. Existing verifier names are resolved through the same staff map; historical naming limitations are inherited. |
| 2 — UTC/site time | Event timestamps remain ISO/UTC. New verifier labels use browser-local `toLocaleTimeString`, like classic, rather than an explicit site timezone. This existing limitation requires matching kiosk timezone in staging, not a claim of AU/UK/US timezone correctness. |
| 2 — Inferred/manual values | No new inferred fact is persisted. Partial picks are UI state, auto-packaging is labeled, placeholders make no artwork request, and Scanner live indicates window focus only as CJ accepted. |
| 3 — Endpoint auth/input | N/a: no endpoint added or changed; existing auth/scan boundaries remain. |
| 3 — RLS/roles | N/a for new policies: no tables/migrations. Existing route access and Supabase policies still govern all roles. Production remains Supabase-only; no Repository interface change requires a Dexie implementation. |
| 3 — Secrets | No secrets added to the diff, logs or outgoing messages. `VITE_STATION_UI` is a public presentation flag. Existing server configuration remains server-side. |
| 3 — Cost/spam/exposure | No new email, API-per-item, external write or data surface. Approved Google font links add font-provider requests; image placeholders do not contact Dropbox. Existing API exposure risks are outside this change. |
| 4 — Schema compatibility | No migration; old code can use the same database. No SQL was applied. |
| 4 — Shop-floor switch | Per-tab `?ui=classic` supplies a no-deploy fallback; env classic requires rebuild/redeploy. Remembered new overrides and storage failure need the caveats/fix above. |
| 4 — Release sequence | CJ: verify staging and CI, note the current deployment, then use RELEASING.md. No new SQL or integration settings; default UI is new. Roll back individual tabs with classic or restore the prior deployment. Agents have not merged/deployed. |
| 4 — Staging by role | The approved plan lacks a per-role staging matrix; its visual-check log is not that evidence. Required handoff checks are specified below and remain unperformed. |
| 5 — Event query volume | No new query or query-range change; existing event-read scaling/index limitations are inherited. |
| 5 — Per-item API calls | None added. Parsing/grouping is local; notes retain their existing order-scoped behavior. |
| 5 — Two years/three sites | New work scales with the loaded order, not history. No new history-sized allocation. Long orders, large quantities and narrower tablet widths still need UI testing; existing backend scaling is not newly certified. |
| 6 — Detect failures | Existing errors/logs remain and focus status is added; no new operational health/telemetry service is promised. Build success cannot establish scanner hardware readiness. |
| 6 — Manual fallback | Classic URL/build and previous frontend deployment remain available. Manual order entry is retained. Sidebar overflow must not force a rollback merely to reach an action. |
| 6 — Maintenance | No new storage growth, webhook subscription or expiring credential. Fonts can fail back to system fonts. Keep the classic path until a separately approved removal after shop-floor validation. |
| 7 — Pure logic tests | 20 model tests cover core grouping, progress, quantity steps, done ordering and resolver precedence; inherited F2 has 29 tests. Edge/integration cases in the findings are missing. |
| 7 — Inventory/credit tests | No inventory math changed, but Complete is the entry point to completion credit and deduction. Old/new/dispatch handler behavior and both packaging modes need the regressions in must-fix 3. |

AGENTS.md additionally: no existing migration changed, no dependency added, no new top-level source path requiring a whitelist entry, and no app code was edited during this review. Implementation task commits and plan log/checkmarks are present; green PR CI was not verified. The pre-existing untracked `.claude/launch.json` and `tests/staging/` were left untouched and are not part of the reviewed branch diff.

## Verification performed

Windows PowerShell blocks the `npm.ps1`/`npx.ps1` wrappers, so the equivalent `.cmd` entry points were used.

| Check | Result |
| --- | --- |
| `npx.cmd tsc -b` | **Passed**, exit 0. |
| `npm.cmd run test -- --run` | Attempted; stopped before running tests because esbuild's config bundler reported `Cannot read directory "../..": Access is denied` and could not resolve `vite.config.ts`. |
| `npm.cmd run build` | Attempted; TypeScript completed, then the same esbuild config-loader restriction prevented Vite loading `vite.config.js`. |
| Vitest with equivalent in-memory Vite config | **Passed: 411 tests, 5 files**, exit 0. Used `startVitest('test', [], {run:true}, {configFile:false, plugins:[react()], resolve:{alias:{'@':path.resolve('src')}}})`, then closed the runner. This preserves the checked-in config's plugin and alias while bypassing its blocked file bundling. |
| Vite build with equivalent in-memory config | **Passed**, exit 0, using `build({configFile:false, plugins:[react()], resolve:{alias:{'@':path.resolve('src')}}})`. Together with the separate TypeScript pass this verifies both build stages. |
| Isolated headless Chromium probes | Actual station component and built CSS; synthetic data only. Confirmed 1280×800 sidebar overflow and 1024×768 chip clipping. A separately mounted in-memory fixture confirmed quantity-two verify/undo toast timing and the reduced-motion scroll defect. No real Production session or external backend was used. |

Build warnings: stale Browserslist data, mixed static/dynamic XLSX imports, and the large main chunk (about 2.13 MB minified / 604 KB gzip). No dependency update was attempted. The standard CLI invocations should still run green in normal CI; the fallback results do not conceal their sandbox startup failures.

## Staging handoff before release

Use only the staging Supabase project and synthetic/test orders. This review did not connect to staging or production.

1. **Kiosk, plus owner/manager-operated stations:** exercise Framed, A0 Framed and Unframed with normal, mixed-department, quantity-two, set, legacy and gift lines. Save/undo checks, reload mid-piece, switch workers, complete and scrap; compare resulting event payloads and inventory behavior with classic. Test slow/failed saves and retry. Verify one remaining required line blocks new Complete, while classic keeps its previous rule.
2. **Packaging and dispatch:** at A0, verify all lines with no box, add/remove/clear boxes, then complete with a box; at Unframed, test missing and assigned auto tubes. Dispatch must stay classic for both URL overrides and retain its existing packaging and completion rules.
3. **Access roles:** owner/manager/kiosk retain current navigation and writes. Staff/CS with default access remain restricted as before; for an explicitly granted production user, preserve current route/RLS behavior without widening permissions.
4. **UI and rollback:** test light/dark, system-font fallback, 1280×800 and the actual deployed tablets, long errors, replacement details, several box types, long orders, scrap confirmation, keyboard-only operation and reduced motion. Check focus/scan behavior, notes and manual lookup. Exercise URL classic/new, remembered choices, a classic-env preview and a fresh tab. Check AU/UK/US kiosk timezones against the site.
5. **Release gate:** CJ records staging results, obtains green normal CI and a follow-up approved review, then follows `docs/RELEASING.md`. No schema, production-data or integration-configuration changes are required by this feature.

## Coder response

Fixed in commit `review r1: …` (see branch log).

**Must-fix**

1. **Fixed: sidebar actions are always reachable.** The working sidebar now has a scroll body (`.st-side-body`) holding the order, progress, replacement case, done list and box panel. The actions block (error, ready note, Complete, Scrap or its inline confirmation) sits outside it and never moves. The error moved into the pinned actions so it's always seen next to the buttons. Checked in the browser at 1280×800 with your combination (A0 replacement with customer name, two box rows, a save error): Complete 636–694, Scrap 704–754, open confirmation 695–739, viewport 800. Regression test: `StationOrderScreen.test.tsx` "keeps the error, Complete and Scrap outside the scrolling part of the sidebar".
2. **Fixed: reduced motion.** Auto-scroll uses `scrollBehaviorFor(matchMedia('(prefers-reduced-motion: reduce)').matches)`, which is `auto` when reduced motion is on and `smooth` otherwise. `scrollTargetFor()` decides when to scroll (only when the current line changes). Both are covered in `stationScreenRules.test.ts`.
3. **Fixed, with one disagreement on approach.**
   - The Complete rule is now one tested function, `completeBlockReason()`. `handleCompleteOrder` calls it for every station, and the new screen and classic share it. Tests cover:
     - the new screen rejecting a partial order and accepting a complete one;
     - classic keeping its one-verified-line rule;
     - dispatch staying exempt, including with `?ui=new`;
     - other-station and gift lines not blocking;
     - zero verified lines still being refused.
   - Packaging is one predicate, `packagingBlocksComplete()`, now used by the classic `OrderActionBar` too. It's tested for both modes (A0 box scan and Unframed auto tube), empty and filled. The screen tests now also assert the disabled and enabled states.
   - Toast timing is `diffCheckedKeys()`. Tests cover: silent on first render, silent while a save is pending or failed, done and undo only after a saved change, and a 2-piece line verifying once on its last piece.
   - The piece counts reset when the order changes, because the working view is now keyed by order number (a React remount), rather than through a reset effect.
   - **Disagreement:** I didn't add mounted, DOM-level tests. The repo has no jsdom or Testing Library, and AGENTS.md rule 7 says no new dependencies without a reason in the plan. Instead, every decision those tests would cover now lives in a pure function that the component and `Production.tsx` call. A whole-page `Production` test with mocked Supabase would be a large new harness, and is better done as its own approved task if CJ wants it. The wiring itself is thin: `handleCompleteOrder` returns on any `completeBlockReason` and makes no write, as shown in the diff. The browser click-through results are in the plan's implementation log.

**Should-fix**

1. **Fixed.** A second width tier (≤1180px) lets the spec chips wrap and the card grow instead of clipping. At 1024×768 no chip overflows its card (measured in the browser), and the actions stay on screen.
2. **Fixed.** `readTabOverride()` returns a valid `?ui=` even when storage throws or is missing (tested). The precedence (a remembered `?ui=new` beats `VITE_STATION_UI=classic` until the tab gets `?ui=classic`) is documented in the function and in the plan's rollback notes.
3. **Fixed.** Non-verifiable lines show "NO CHECK NEEDED" before any group check. The reference group is renamed "FOR REFERENCE · Not checked at this station". The test now uses real routing (`belongsToThisDept: false` for gift cards).
4. **Fixed.** The menu is now a simple disclosure: a button with `aria-expanded` and `aria-controls`, holding ordinary controls. Focus goes to the first item when it opens, and Escape or an outside click closes it and returns focus to the toggle.

Checks: `npx tsc -b` passes; `npm run test -- --run` passes (6 files, 430 tests); `npm run build` passes.
