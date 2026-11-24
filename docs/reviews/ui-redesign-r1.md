# Review: UI redesign — round 1

- Slug: `ui-redesign` · Branch: `feature/ui-redesign` · Reviewed commit: `95045315b72dae15e73913f656410de28f2dd42b` (detached HEAD)
- Base: `68cba07` (`origin/feature/staging-fixes`); review range: `git diff 68cba07..HEAD`.
- Reviewer: planner (GPT-6 Astra) · Date: 2026-11-25
- Verdict: **changes required**

The protected code boundaries are intact, the legacy primitive branches are preserved, and the three hook-order corrections are sound on source inspection. Approval is blocked by incomplete shipment confirmation coverage, a confirmation predicate that differs between backends, unmet error/accessibility requirements, and an unnecessary forecast reader in the SKU peek. Task 19 remains open. This is a completed review, not approval to release.

## Checked against

- [x] Spec acceptance criteria — reviewed; failures and unverified browser criteria are recorded below.
- [ ] Plan tasks (all done, nothing extra slipped in) — Tasks 1–18 have checked headings/logs, but Task 15 explicitly withholds restock acceptance, Task 19 is open, and the shipment helper exceeds the planned formatting-only contract.
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist) — no protected-path edits, dependencies, schema changes or new secrets found in the diff.
- [x] `docs/HARDENING.md`, every section — item-by-item assessment below; this check means reviewed, not all passed.
- [x] Roadmap decisions for this feature (`docs/ROADMAP.md`) — additional post-bulk UI work, not an F-number or a reopening of S1/F1–F12 decisions.
- [ ] Tests cover the new logic; type-check, tests and build pass — three type-checks passed here; test/build execution was blocked by the sandbox. New helper tests miss the backend divergence described in M2. CI and staging remain unverified.

Reviewed `AGENTS.md`, architecture, roadmap, hardening, spec, plan, review template, release guidance, wireframe capability dispositions/tokens, the changed source, and the relevant unchanged callers/repository rules. No browser session, database query, production inspection, deployment or state-changing git command was performed. The pre-existing untracked `supabase/.temp/` was left alone. Only this review document was authored.

## Must-fix

1. **M1 — P1: cover the remaining shipment write entry points.** `src/pages/Shipments.tsx:480`, `src/pages/Shipments.tsx:552`, and the Order Builder mounted at `src/pages/Shipments.tsx:568` bypass the new confirmation. `src/components/OrderBuilderModal.tsx:486` derives the selected status and line payload, then calls `upsertShipment` directly at line 503; its status list includes Delivered. Reproduction: open Place supplier order or Top-up, select Delivered with auto-apply on, and save; stock can be credited without the required quantity confirmation. Archive/unarchive also calls `upsertShipment`: save a Delivered shipment while auto-apply is off, enable auto-apply, then archive it; the missing applied marker causes the archive save to credit stock. These paths are legacy behavior, but leaving them unguarded fails the redesign's explicit stock-confirmation acceptance criterion. Add a presentation guard to every existing shipment path that can affect stock, including these entry points, preserving the original payload, validation and one mutation call. Test cancel and confirm for builder delivery/reversal and archive/unarchive with an unapplied Delivered record on both backends. Do not change repository behavior or replace archive with a new write API.

2. **M2 — P1: the shipment helper does not mirror Dexie.** `src/lib/ui/shipmentStockChange.ts:30` requires the previous status to be Delivered before showing a reversal. `DexieRepo.ts:660` reverses whenever auto-apply is on, the next status is not Delivered, and the previous applied marker exists; it does not require the previous status to be Delivered. Supabase's caller does require that status (`SupabaseRepo.ts:561`). Reachable sequence: deliver with auto-apply on; turn it off; move to In Transit, retaining the marker; turn it on; save as Ordered. The helper returns null, but Dexie removes the previous line quantities without confirmation. An in-memory execution of the actual helper reproduced null for this input; inspection of the adapters confirms the differing predicates. Make the presentation guard accurately reflect the selected backend, with tests for this sequence and auto-apply toggles. Do not “fix” the adapters to make them agree in this feature. Also resolve the scope deviation: Task 8 permitted a formatter of caller-supplied signed changes, whereas this helper chooses inventory transitions and filters quantities. Record the approved presentation-only approach in the plan before continuing; a single alleged shared inventory rule is not accurate here.

3. **M3 — P2: describe requested quantities, not guaranteed stock effects.** `src/pages/Shipments.tsx:192`, `src/pages/PaperUsage.tsx:250`, `src/pages/PaperUsage.tsx:256`, `src/pages/CsCases.tsx:830`, `src/pages/CsCases.tsx:836`, and `src/pages/CsCases.tsx:896` state that the listed quantities are taken back, were deducted, or are deducted. Reversals/deductions can clamp at zero, a missing product can be skipped, and repository reads can observe a newer state than the displayed snapshot. For example, reversing a ten-unit shipment with three units on hand removes three, not ten; a new ten-unit replacement against three on hand deducts three. Paper's stored requested roll count likewise need not be the actual earlier ledger deduction. The inline paper expressions and CS transition/line selection match the existing requested operations, but the new copy overstates their result. Label them as planned/requested adjustments, explain clamping/current-state limits, and avoid claiming recorded quantities prove actual prior deductions. Keep the separate old-line reversal and new-line application and preserve handlers. Verify shortage, zero stock, missing SKU and changed-state cases. Movements already qualifies its estimate as requested, which is the appropriate pattern.

4. **M4 — P2: implement the promised read-error states.** Examples: `src/pages/Dashboard.tsx:81`, `src/pages/SalesEntry.tsx:168`, `src/pages/Warehouse.tsx:26`, `src/pages/Shipments.tsx:178`, `src/pages/Skus.tsx:120`. These pages discard `useDataset` error/refetch state and render a loading skeleton whenever data is absent. After an initial read exhausts retries, the user still gets “Loading” and no recovery action. Background failures with cached data are also not exposed by these new boundaries. This was largely a baseline weakness, but the spec and Tasks 5–18 expressly require honest read failure and recovery. Consume the existing query result in the allowed presentation files, distinguish loading/error/empty, and expose only the existing read refetch. Keep cached content and dirty editors mounted on background errors; keep all hooks unconditional. Do not edit the hook or add a write retry. Verify initial failure → read Retry → data and background failure with a dirty form across the affected page families.

5. **M5 — P2: pass the existing forecast result into the SKU peek.** `src/components/SkuPeek.tsx:35` calls `useForecasts()` even when `product` is null, because `src/pages/Skus.tsx:710` always mounts it. Skus already owns `forecastById` at line 77. `useForecasts` is a per-component `useMemo` that invokes the forecast engine for every product; it is not a shared memoized selector. The peek therefore adds another full-catalogue calculation on dataset/scenario changes and another dataset observer even while closed. This contradicts the loaded-data-only presentation and unchanged fetch ownership requirements. Pass the selected result from Skus into SkuPeek; leave the hook implementation unchanged. Verify open/close and scenario changes reuse the parent's result without adding a reader. Shared TanStack Query keys can deduplicate requests, so this finding is not a claim of one HTTP request per SKU.

6. **M6 — P2: complete modal background isolation.** `src/components/ui/UiPresentation.tsx:53` provides focus entry, Tab wrapping, topmost Escape, body scroll locking and focus restoration, but never makes the background or lower dialogs inert and does not contain focus moved by means other than Tab. Drawer, palette, SideSheet and ShellModal claim `aria-modal="true"`; a scrim and that attribute alone do not prevent programmatic focus or background activation through assistive technology. The scroll lock also targets body while the shell's main content is independently scrollable. Implement actual background isolation and focus containment for the active overlay, with correct restoration for stacked overlays and the actual scroll container. Keep LegacyModal outside the provider unchanged. Verify screen-reader navigation/activation, programmatic focus escape, touch/wheel background scrolling, and nested confirm → form restoration, including mobile drawer → palette and unmount/navigation.

7. **M7 — P2: meet the explicit focus contrast requirement.** `src/index.css:97` sets every shell focus outline to `--hub-accent` (#3ecf8e). Calculated contrast is **2.00:1 against white**, **1.93:1 against the page**, and **1.86:1 against the light sidebar**, below the spec's 3:1 focus-indicator requirement. Use an accessible theme-specific focus colour, retaining the brand accent for fills where appropriate. Audit the new accent chart series in `src/pages/Reports.tsx:861` and `src/pages/Reports.tsx:1819` for the same contrast issue. Verify focus on panel/page/sidebar in both themes and check small text/control contrast in the final browser pass; do not infer AA compliance from token names.

8. **M8 — P2: respect reduced motion in section navigation.** `src/components/ReportsSectionNav.tsx:77` always requests `scrollIntoView({ behavior: "smooth" })`. The reduced-motion CSS sets `scroll-behavior: auto`, but does not override an explicit JavaScript smooth-scroll request. Select instant/auto behavior when reduced motion is requested, or use auto and let scoped CSS govern scrolling. Check both Reports and Settings with reduced motion enabled, including focus placement below the sticky section navigation.

9. **M9 — release gate: finish evidence and resolve the withheld acceptance claim.** `docs/plans/ui-redesign.md`, Task 19 and Task 15 Open questions: keep Task 19 unchecked until the corrected candidate has green CI/build/test evidence and CJ's role-matrix/browser/write-parity results. Task 15's checked heading is not evidence that return-restock confirmation passed. CJ must explicitly record the disposition of that withheld criterion and the separate inventory defect before approval. Do not repair the return sign in this redesign or mark it passing because the defect predates it. The exact outstanding CJ work is listed below.

## Should-fix

1. `src/pages/Warehouse.tsx:211` — the new empty-capacity Settings link is unconditional. The spec permits it only when Settings is allowed. Users granted Warehouse without Settings now get a dead-end link (the unchanged route guard still prevents access). Filter the link through existing effective access, with plain guidance otherwise.
2. `src/components/layout/Sidebar.tsx:155` — collapsed/custom-label tooltips rely on native `title`. Accessible names are present, but a keyboard user does not reliably get a visible tooltip on focus. Provide the specified hover/focus tooltip without changing navigation authority.
3. `src/components/layout/Topbar.tsx:191` — the badge condition suppresses the backend as well as the environment on desktop production Supabase builds. The spec's shell contract asks for the real backend and only hides the environment label. Reconcile this with the older wireframe wording; preserve truthful labelling and avoid claiming an unknown build is staging.
4. `docs/plans/ui-redesign.md`, Implementation log — reconcile historical notes with the reviewed base. The earlier PackagingRulesCard Dexie-crash note is not a current defect here: the current unchanged component uses `useAuthOptional` and returns outside Supabase. Record task commit references and the exact code SHA actually exercised; the logged Preview builds `5b4b355`, not reviewed `9504531`. Do not copy historical failures or local owner results into a current all-role pass.

## Nitpicks

None beyond the actionable findings above.

## Scope and implementation findings

### Prohibitions and station isolation

The path diff contains no changes to repositories (including Repository.ts and both adapters), auth/permissions, domain, existing hooks, state stores, `src/App.tsx`/routes/guards, `api/`, migrations, packages/lockfiles, `Production.tsx`, or `src/components/production/**`. No new dependencies, endpoints, schema, persisted preferences, integration configuration or production access were introduced by the reviewed diff. Existing directory whitelisting covers the added source/docs/assets; no new top-level directory requires an exception.

The excluded Week/Timeline views, Sales Undo/batch-save/write-Retry, event simulation, command-palette actions, supplier-grouped writes, CS comments, one-step invites, gallery/saved views, new report URLs, paper save modes, role preview, mock metrics and wireframe scripts are not introduced. ShoppingList retains one Ordered record per line, the original handler and confirmation, with visible explanatory copy beside the deliberately awkward “Create draft shipments” label. New report/settings navigation retains mounted sections and existing independent filters/gates. No station scan gains a confirmation.

Layout alone enables `UiPresentationProvider` and `.ui-redesign-shell`; `/production` remains outside it. Button/Card/Input/Select/Field/StatusPill choose their original classes/props when the context is false. Modal delegates that path to LegacyModal, whose original markup and Escape/backdrop behavior are retained. This is source-level parity, not a fresh station visual/scan test. The existing global theme convention remains; the added OS listener is owned by Topbar and cleaned up on unmount.

### Neutral bridge and hooks

The original global height/body rules are unchanged. New global `--hub-*` declarations are inert unless consumed; Tailwind additions extend rather than replace existing scales. Each neutral bridge selector requires a descendant of `.ui-redesign-shell`. `:where(.ui-redesign-shell)` contributes zero specificity: base mappings have class-level specificity, hover mappings add a pseudo-class, and `:is(.dark *)` contributes the dark ancestor class for dark mappings. Thus base bridge rules do not overpower more-specific dark/hover variants; matching dark bridge rules follow the generated utilities. No bridge selector leaks to standalone station descendants. Browser-computed contrast/hover/focus and mobile comparisons remain required; M7 is a confirmed token contrast failure, not a scope leak.

Dashboard moves its guarded supplier memo before the loading return; SalesEntry moves footer calculations/memo before that return with the same inputs; Warehouse splits a data boundary from WarehouseLoaded, whose hooks now run unconditionally. No altered stock/forecast formulas were found in these moves. They resolve the source hook-order defects. The log reports successful direct loads, but this reviewer did not reproduce them in a browser. Error handling remains M4.

### Stock-path parity

| Flow | Source assessment |
| --- | --- |
| Shipments drag/form/delete | The guarded paths retain the same upsert/delete payload and one call after an affirmative answer. Cancel returns before mutation and does not save the tentative arrival date. Applied Delivered → Delivered edits remain no-recredit; delete checks the marker independently of auto-apply. M1/M2 prevent claiming exhaustive coverage. |
| Movements | Local filtering preserves selected ID, order and no automatic selection. Confirm precedes unchanged `submit`; API delta still uses the preset direction and absolute numeric quantity. Cancellation never calls submit. Existing reversal eligibility, native confirmation and source/reason semantics remain. |
| PaperUsage | Prior stored SKU/counts, current mappings and `ceil(totalMM / ROLL_LENGTH_MM)` match the unchanged handler. Prior 24/42 reversals precede fresh 24/42 deductions and snapshot upsert. Unmapped/no-effect save remains direct. Existing delete confirmation is preserved. M3 concerns wording, not these requested expressions. |
| CsCases | `shipped` plus trimmed nonempty tracking matches both repository predicates. Prior deducted lines are reversed before current lines are reapplied; deducted delete reverses prior lines. Re-saving an already deducted case now gets confirmation, correctly covering edited lines. Same calls/payload construction follow confirmation; cancelling does not save. M3 concerns actual versus requested quantities. |
| CsReturns | Only the header changed. Both adapters still pass positive adjustment arguments for supposed restock, which subtract stock; reversing/deleting passes negatives. This is a baseline defect and an explicitly withheld acceptance claim, not a redesign regression or an authorised backend fix. No claim is made here about current live return-row counts. |

`useConfirm` clears its resolver before resolving, and duplicate settle calls cannot resolve the same question twice; a replacement question cancels the previous one. This supports source-level cancellation/cardinality reasoning. It does not prove all browser event sequences, concurrent writes, freshness, atomicity or exactly-once persistence. The original pending states/partial-write limitations remain, and the full fixtures in Task 19 are still needed.

### Additional files and plan fit

| File | Assessment |
| --- | --- |
| DashboardTabs | Reasonable extraction for Task 5: existing owner-gated `/dashboard` and `/stock-value` links, no new route/data. Record the filename in the plan. |
| SkuPeek | Contrary to the log's “not in the plan” wording, Task 6 explicitly names `src/components/SkuPeek.tsx`. The read-only view and permission-checked Movements link are in scope; the extra forecast reader is M5. |
| ConfirmDialog | Reasonable shared presentation infrastructure for Tasks 2/8/12–14. No repository ownership; add its filename to the plan. Modal isolation requirements remain M6. |
| BayMap | Equivalent to Task 11's optional WarehouseBayMap extraction: saved row/column/type, assignments and max pallets; selection is local, with no allocation/write/future occupancy. No unsupported business feature found. |
| ReportsSectionNav | Reasonable extraction for Tasks 16/18. Discovers rendered headings/section markers, adds anchors and observes DOM changes; no new route or data query, no section remount. Reduced motion is M8. |
| shipmentStockChange and tests | More than the planned `stockConfirmation` formatter: transition prediction and quantity filtering were introduced. Backend parity and plan resolution are required under M2; tests currently encode only the common/Supabase predicate. |
| src/assets/inka-arthouse-logo.png | Local presentation asset for the approved shell; no external fetch, secret or dependency. Within functional scope, despite missing filename in Task 3. |

### Accessibility assessment

Positive source evidence: first skip link targets focusable main; named hamburger and drawer; NavLink supplies `aria-current`; icon buttons in new shared overlays have labels; dialogs are named; palette has combobox/listbox/option relationships and active descendant; sheets are full-screen below 768px; shared overlay effects clean up scroll locks/listeners and restore surviving trigger focus; confirm Cancel/Escape/backdrop settle false. Search matching/order/30-result cap/hrefs and slash typing protections remain unchanged.

This is not an accessibility pass. M6–M8 address background isolation, focus contrast and motion; native tooltip behavior is noted above. CJ must exercise stacked overlays, keyboard/no-results/shrinking palette results, mobile touch targets, long labels, local table/board overflow, screen-reader announcements, and focus after route changes. Existing custom case/return editors are not automatically made accessible merely because the nested confirmation uses ShellModal.

## Hardening assessment — every checklist item

| Item | Review result / remaining evidence |
| --- | --- |
| 1.1 Slow/down network and services | No new Shopify/Dropbox/Slack/Make dependency. Dataset read failure is still misrepresented (M4). Throttled/offline staging and draft retention remain unverified. |
| 1.2 Retry/idempotency | No new automatic write retry or Undo. Guarded callbacks retain their original mutations; M1/M2 leave gaps. Confirm cancellation is source-checked; duplicate activation, pending and partial-failure request counts require staging. Existing keys and backend guarantees are unchanged. |
| 1.3 Two people/devices | No new lock/merge policy. Current database state can differ from confirmation snapshots; qualify copy (M3). Same-fixture two-session parity remains pending. |
| 1.4 Bad input | Existing validation and unknown SKU handling remain; picker tests cover trim/case/short-code/no-match/duplicates. Missing-product/clamped-stock confirmation fixtures are needed. Barcode/cancelled/wrong-site order paths are untouched and need station smoke coverage. |
| 1.5 Failure/recovery | Existing write catches remain, no automatic replay added. M4 blocks honest read recovery. ReportsOverview's null/missing-meta guard uses its existing read Retry and is a reasonable presentation fallback, not a new API contract validator. |
| 2.1 Attribution | No person/department payload or scanner identity changes; shell department control keeps the existing store action. Per-role station/report comparison pending. |
| 2.2 Shared counts | Existing reducers/forecast formulas/report counts retained; no mock KPI engine added. M5 adds redundant execution, not a new counting rule. Persisted and export parity pending. |
| 2.3 History | No historical rewrite/schema/configuration semantics changes. Anchor navigation preserves mounted editors/readers. Historical report fixture comparison pending. |
| 2.4 UTC/site time | Existing UTC/date-only/site-formatting paths retained; no timezone cleanup. AU/UK/US boundaries and reload-isolation checks pending. |
| 2.5 Manual/inferred values | Existing reporting method/coverage/stale/unpublished labels remain in source. M3 requires equally honest stock wording. No new “live/synced” assertion found. |
| 3.1 Endpoint authentication/input | N/a for additions: no endpoint changes. Existing auth/validation boundaries preserved; this review is not a new security certification of baseline APIs. |
| 3.2 Tables/RLS | N/a: no new tables, grants or policies. Existing permission functions are consumed and tested by nav helpers; role/override browser checks remain mandatory. |
| 3.3 Secrets | No introduced secret values or server key exposure found. `VITE_APP_ENV` is display-only. No credentials were read or logged in this review. |
| 3.4 Cost/spam/exposure | No new sends or integration calls. Palette destinations and internal route gates retained; no new owner-data Home surface. M5 adds unnecessary dataset/compute ownership. Account switch and role scope still need browser evidence. |
| 4.1 Expand-only/old app compatibility | N/a for migrations: none. Existing data contracts support app-only rollback. |
| 4.2 Off switch/shop floor | No flag added, as specified. Station source/legacy primitive branches protected. CJ's fallback is the known-good post-bulk deployment; station regression pass pending. |
| 4.3 Release order/configuration | Separate release after bulk stability; no SQL/integration changes for this feature. Verify staging targeting and display label, green checks/review/evidence, then CJ merges/deploys/tags. Details below. |
| 4.4 Per-role staging | Pending owner/manager/staff/kiosk/cs plus overrides/direct URLs on the correct Preview commit. Synthetic local owner evidence is not equivalent. |
| 5.1 Long event scans | Existing query ranges/caps/published readers unchanged. No new query/index work. Two-year render/request comparison pending, including observer overhead from section navigation. |
| 5.2 External API per item | No per-item external fetch added by bay/peek markup; existing lookup/artwork paths retained. Remove the extra forecast/dataset consumer (M5); final network comparison pending. |
| 5.3 Two years/three sites | Existing capabilities/caps retained; no scale proof from a build. M5 and AU/UK/US long-range browser fixtures remain open. |
| 6.1 Detect faults | Existing scanner/report health and logs retained; no monitoring changes. M4 is a visibility gap. CJ watches browser/Vercel errors and staff feedback after release. |
| 6.2 Shop-floor fallback | Standalone production remains outside the shell. App Instant Rollback to post-bulk target; use existing ledger/history to reconcile uncertain writes, never blindly replay. |
| 6.3 Maintenance | No new storage/subscription/credential lifecycle. Maintain tokens, nav groups, overlay stack behavior and accurate Preview labels; no new service operations. |
| 7.1 Pure logic tests | Appearance (8), navigation (14), picker (6), shipment summary (10) tests inspected. M2 needs missing edge coverage. Fresh Vitest execution blocked here; historical counts are not substituted for it. |
| 7.2 Inventory/credit/money tests | Existing suites unchanged; no repository arithmetic edits. Before/after ledger/payload/cardinality fixtures remain incomplete; M1–M3 and the separate returns defect preclude a blanket stock acceptance claim. |

## Verification performed in this review

PowerShell initially rejected the `npm.ps1`/`npx.ps1` launchers because scripts are disabled. The standard `.cmd` launchers executed without changing execution policy or requesting elevated access.

| Requested check | Fresh result |
| --- | --- |
| `npx tsc -b` via `npx.cmd tsc -b` | **PASS**, exit 0. |
| `npm run test -- --run` via `npm.cmd` | **BLOCKED**, exit 1 before test discovery. esbuild could not read `../../../../..` (Access is denied) or resolve this worktree's `vite.config.ts`. No test result count from this review. |
| `npm run build` via `npm.cmd` | **BLOCKED**, exit 1 at Vite configuration loading after its TypeScript step. Same esbuild parent-directory access error, naming generated `vite.config.js`. No production bundle verification here. |
| `npm run typecheck:api` via `npm.cmd` | **PASS**, exit 0. |
| `npm run typecheck:digest` via `npm.cmd` | **PASS**, exit 0. |
| `git diff --check 68cba07..HEAD` | **PASS**, exit 0. |
| In-memory shipment helper reproduction | Actual helper returned null for M2's applied-marker/non-Delivered fixture. No database writes or test files created. |
| Focus-colour calculation | Linearized sRGB ratios recorded in M7; not a substitute for the full browser accessibility check. |

The user and Implementation log identify six pre-existing Windows CRLF migration-hash failures; the log reports 3445 passing tests plus those six failures. This reviewer could not reach those tests and does **not** report that historical run as freshly verified. Do not edit migrations or weaken hash checks. Obtain the normal successful CI run on the final candidate and distinguish actual failures from environment limitations. Remote PR CI was not inspected.

## What remains for CJ

1. After coder fixes and re-review, verify that Preview **`inka-arthouse-i0n45rhkb`** serves the candidate being approved. The current plan says it builds `5b4b355`; this review covers `9504531`, and fixes will produce a newer SHA. Record the deployment/SHA relationship instead of assuming they match. Check frontend and server Supabase configuration targets **inka-staging-2**, with safe integration credentials/recipients and display-only `VITE_APP_ENV=preview`.
2. Complete the Preview role matrix: owner, manager, staff, kiosk and CS, default/custom/empty `allowed_nav`, non-owner Dashboard denial including direct URLs, owner forced Welcome/Settings, sign-out/re-login, permitted sections and AU→UK→US reload isolation. Include actual kiosk clock/scan/verify/complete/dispatch and shared legacy station dialogs. No production database tests.
3. Complete desktop and 375/767/768px light/dark/system, OS preference change, keyboard/screen reader/reduced motion, drawer/palette/sheet/confirm stacking, long labels, table/board overflow, initial read failure/refetch and dirty-form background failure. Compare data/export/request behavior over two-year fixtures. Confirm all stock cancellation/pending/double-activation/two-session cases against the baseline on disposable Dexie and staging fixtures, including M1/M2 paths, paper changed mappings, CS edited lines and unchanged sales blur/import behavior.
4. Record the separate returns-sign decision. The affected acceptance claim remains withheld; no new false “+N restocked” dialog is acceptable. Track an independently authorised inventory correction with ledger tests, or explicitly approve a documented deferral/operational restriction and amended acceptance scope. Until resolved, communicate the plan's restriction against using Restock; this review did not send any staff message or verify live data. Confirm the other five spec defaults, especially Ordered versus “draft” wording.
5. Complete Task 19, green PR CI and reviewer approval before release. Release this UI separately **after the bulk release is stable**. If the accepted bulk base changes, compare again and rerun affected parity checks. Record the exact known-good **post-bulk, pre-redesign** deployment for rollback; never select a deployment that discards bulk/security fixes.
6. CJ alone merges, deploys and tags at a quiet time under `docs/RELEASING.md`. This redesign requires **no SQL or integration changes**. Monitor browser/Vercel errors and staff availability for the first 30 minutes. Roll back the app via Vercel Instant Rollback to the recorded target if necessary; no database restore, migration reversal or deletion. Follow the runbook's branch-based git reconciliation afterward. Do not send a digest email as a cosmetic smoke test.

## Coder response

(Coder fills this in after fixing, with each M-number, commit, fresh verification and outstanding CJ evidence. Do not treat completion of this review as approval of the implementation.)

STATUS: COMPLETE
