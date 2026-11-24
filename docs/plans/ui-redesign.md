# Plan: UI redesign

- Slug: `ui-redesign` · Spec: `docs/specs/ui-redesign.md`
- Branch: `feature/ui-redesign`
- Status: ready for CJ plan review; wireframes and instruction to implement approved in 2026-11-24 chat. REVIEW.md section-4 defaults are decided-by-default, pending CJ confirmation as recorded in the spec.
- Execution: Claude Opus coder, sequentially, one writer and one task commit at a time. Planner writes only the two requested documents in this turn and does not commit/push/deploy.

## Approach

Implement the approved visual system inside the existing React app. First add scoped tokens and compatible primitives, then shell/navigation/search, then individual screens. Keep existing loaders, hooks, form state and action handlers; use existing component boundaries rather than replacing pages with wireframe HTML. `src/components/CommandPalette.tsx` is the actual palette path. `tailwind.config.js` is the actual Tailwind configuration.

The wireframe directory is a visual source, not runtime code. Read the spec's capability table before every task. Every unmarked mock idea is subject to the same no-behavior-change rule. New data views are limited to the explicitly approved read-only SKU peek and bay map; existing section navigation and local SKU-picker filtering are presentation. Do not implement new Week/Timeline/Undo/action-palette/save modes or routes.

Protect the station with a `.ui-redesign-shell` ancestor in `Layout.tsx`. Tailwind theme extensions are additive and CSS is scoped. Existing shared primitives retain their legacy styles/behavior outside this ancestor; a React presentation context distinguishes opt-in dialog behavior where necessary. `/production` remains outside Layout, and `Production.tsx` and production components are not edited. The initial token/primitives commits must be independently safe even before the shell opts in.

**Goal:** implement the approved hierarchy and navigation while leaving every business result unchanged.

**Architecture:** existing React pages and TanStack Query/direct loaders, existing Zustand persistence and existing permissions, with scoped semantic CSS and small pure presentation helpers. No new data layer.

**Tech stack:** installed React 18, strict TypeScript, Vite 5, Tailwind 3, lucide-react, Recharts and Vitest; no added dependencies.

### Global constraints

- No repository, schema, migration, RPC, API, auth/permission, route, domain calculation, station/scanner or package/lockfile changes. `src/App.tsx`, `src/lib/auth/permissions.ts` and `src/lib/state/appStore.ts` remain unchanged.
- No business mutation changes: same handler, validation, payload, order, count, signs, idempotency keys and invalidations. Only pre-action confirmation for an existing explicit stock operation and non-mutating presentation feedback are permitted. Sales keeps blur auto-save; station scans never gain dialogs.
- Use current `effectiveNavAccess` and `allNavAccess`; staff default includes Reports. Preserve custom labels and all existing owner/internal gates. No role-preview simulation in the app.
- Do not change query keys, fetch ownership, request ranges, refresh/poll intervals, result limits or retry policies. Read errors use existing refetch/reload; no automatic write retry.
- No replacement of existing features by older wireframe content: retain newer published reporting, scanner-health display, departments, packaging rules/attention, frame timing and order timeline/flow.
- Keep existing browser preference keys. New component state is ephemeral; do not add persisted saved views or per-user preference storage.
- Tables/boards scroll locally below 768px; mobile drawer and side peeks work at 375px and 767px; desktop begins at 768px. Light/dark/system and reduced motion are mandatory.
- Scope CSS and dialog behavior so shared components used by Production remain unchanged. Do not alter global Tailwind scales/reset/body typography to achieve this redesign.
- A newly discovered behavior requirement or baseline failure goes in **Open questions**. The coder stops the affected task for planner/CJ resolution; no speculative data fix or skipped acceptance claim.

### Common completion gate G (part of every task below)

1. Before Task 1, record the starting branch/commit and clean/dirty state using read-only inspection; preserve unrelated work. Establish a local Dexie baseline with the three commands below. Do not copy the architecture snapshot's old test count as current evidence.
2. For a task with new pure logic, write its named tests first, run the focused Vitest file and observe the meaningful failure, implement, then rerun. For styling-only tasks add **no new automated tests**; use the stated visual/manual checks and existing suites. Do not install DOM/browser-test dependencies.
3. Inspect that task's diff against the spec's prohibitions. Verify handlers, input names/types, `onBlur` timing, form submit boundaries, disabled/busy states and data-hook ownership are unchanged. A moved control must still invoke the same operation exactly once.
4. Run **separately**: `npx tsc -b`, `npm run test -- --run`, `npm run build`. Each must exit 0 after **every task**, not just at the end. Do not run tests against production or introduce credentials into logs. Existing configured skips are recorded, not reported as executed tests.
5. Perform task acceptance checks in the available safe local backend. Record staged-only checks as pending until Task 19; do not claim green staging from a Dexie run. Save the result in this plan's Implementation log, tick the task only when its local checks pass, and have the coder commit `task N: <summary>`. This planner does not create those commits.
6. Each task must be independently reviewable and leave a runnable app. Any review/evidence handoff ends in exactly one `STATUS: COMPLETE` or `STATUS: FAILED – <reason>` line. On missing/failed evidence, stop and identify the exact missing check; do not guess or rerun it to fill a handoff gap.

PR CI additionally runs `npm run typecheck:digest` and `npm run typecheck:api`; both remain required for the final review even though endpoints are untouched. CI and preview/release are not claimed complete by this documentation task.

### Review focus

| Failure mode | Required check / owning task |
| --- | --- |
| Shared CSS/dialog focus changes a scanner or station modal | Legacy styles outside shell; compare production and scanner-health consumers after Tasks 1–3 and in Task 19. |
| Long labels, overrides or stale mock defaults hide a permitted route | Pure nav tests in Task 3; keyboard/mobile/default-and-override role matrix in Tasks 3/19. |
| Opening/closing a panel triggers blur writes or loses an unsaved form | Read-only peek in Task 6; unchanged sales grid in Task 7; preserve mounted report/settings form state in Tasks 16/18; staged call-count comparison in Task 19. |
| Partial stock save appears successful, or confirm/retry duplicates a write | No generic write Retry/Undo; cancellation and exact handler parity in Tasks 7–8/12–15 and staging Task 19. |
| Reports/Welcome show old-site values, false zeros or reset published readers | Preserve loaders and coverage states in Tasks 5/16; full location reload in Task 3; three-site and long-range checks in Task 19. |

### Shared interfaces and file ownership

Only create helpers below when assigned by their task; their contracts are fixed here for subsequent tasks. Existing APIs stay source-compatible.

- `src/lib/ui/appearance.ts`: `resolveTheme(theme: Theme, prefersDark: boolean): "light" | "dark"`; `environmentLabel(appEnv: string | undefined, isDev: boolean): "Preview" | "Development" | null`. `Theme` is imported from the existing store. Production/unknown built env gives null; explicit preview gives Preview; development or dev-server fallback gives Development. This label does not select backend or project.
- `src/components/layout/navigation.ts`: `NavItem = { key: NavKey; to: string; end?: boolean }`; `NavGroup = { label: string | null; items: readonly NavItem[] }`; `NAV_GROUPS: readonly NavGroup[]`; `visibleNavGroups(allowed: ReadonlySet<NavKey>): NavGroup[]`. Return fresh filtered groups, omit empty ones, retain order; do not calculate permissions here. Icons stay a static `NavKey` mapping in Sidebar.
- `src/components/ui/UiPresentation.tsx`: `UiPresentationProvider({ children }: { children: ReactNode })` and `useIsRedesignedShell(): boolean`, default false. Provider only wraps Layout's shell. Used solely for presentation/focus scope, never data or permissions.
- `src/components/ui/PageHeader.tsx`: `PageHeader({ title, description?, actions? }: { title: string; description?: ReactNode; actions?: ReactNode })`.
- `src/components/ui/DataState.tsx`: `DataState({ kind, title, message?, action? }: { kind: "loading" | "empty" | "error"; title: string; message?: ReactNode; action?: ReactNode })`. It renders status/alert text and an optional caller-supplied existing read/empty action; it never fetches or retries by itself.
- `src/components/ui/TableContainer.tsx`: `TableContainer(props: HTMLAttributes<HTMLDivElement>)`, a labelled/focusable horizontal overflow wrapper as needed; native table semantics remain with callers.
- `src/components/ui/Badge.tsx`: `Badge({ tone?, children }: { tone?: "neutral" | "success" | "warning" | "danger" | "info"; children: ReactNode })`. Presentation only; no domain status conversion.
- `src/components/ui/SideSheet.tsx`: `SideSheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode })`; accessible dialog, 460px desktop/full-screen below 768px, no fetching or save action. Reuse opt-in Modal focus handling, not a second mutation workflow.
- `src/lib/ui/productSearch.ts`: `filterProductsForPicker(products: readonly Product[], query: string): Product[]`; case-insensitive code/shortCode matching, trimmed query, empty query preserves input order, no mutation or automatic selection. Product/shortCode come from existing domain exports.

## Tasks

Run in the following order; every task depends on all previous gates. Tasks 5–18 use the shared interfaces above. File lists identify allowed implementation surfaces, not permission to rewrite business code in those files. `src/index.css` may receive scoped page styles in each page task; do not scatter global overrides.

### [x] Task 1: Scoped design tokens and theme helpers

- Files: modify `tailwind.config.js`, `src/index.css`; create `src/lib/ui/appearance.ts`, `src/lib/ui/__tests__/appearance.test.ts`.
- [ ] Add prefixed `--hub-*` variables for all applicable `wf.css` light/dark semantic tokens; `.dark` remains the app convention. Extend Tailwind `colors.hub` with `page`, `panel`, `sidebar`, `line`, `text`, `muted`, `faint`, `fill`, `accent`, `accent-text`, status backgrounds/text; add radii/spacing only without replacing existing defaults. Use CSS variables for rgba tokens; choose opaque token utilities where opacity modifiers are unsupported.
- [ ] Define scoped `.ui-redesign-shell` typography/background/table/focus/reduced-motion foundations without enabling the shell yet. Leave global element rules and station styles intact. Token mapping includes hover/subtle fills/scrims/shadows; no wireframe notes or fake placeholders.
- [ ] Implement the two pure appearance functions. Test all six theme/preference combinations; explicit theme overrides OS. Test `preview`, `production`, `development`, undefined and unknown env values in dev/build modes, with production never labelled Preview.
- Done when: token values match `wf.css` in both themes, CSS remains inert outside the opted-in scope, no remote fonts/dependencies, and G passes. OS subscription comes in Task 3, not in a pure helper.
- Tests to add: `appearance.test.ts` only; focused run `npm run test -- --run src/lib/ui/__tests__/appearance.test.ts`.

### [x] Task 2: Shared primitives, states and opt-in overlays

- Files: modify `src/components/ui/Button.tsx`, `Card.tsx`, `Input.tsx`, `StatusPill.tsx`, `Modal.tsx`, `src/index.css`; create `UiPresentation.tsx`, `PageHeader.tsx`, `DataState.tsx`, `TableContainer.tsx`, `Badge.tsx`, `SideSheet.tsx` in `src/components/ui/`.
- [ ] Keep current component props/ref forwarding, native input/select semantics, button `type="button"`, disabled behavior and existing domain status labels. Add semantic markers/scoped rules for compact controls, cards, tables and badges; retain legacy styling outside the scope.
- [ ] Implement the documented presentational components. DataState loading announces once politely, error is explicit, and empty includes an action only when a real permitted action exists. Skeletons must not convey invented values.
- [ ] Add focus entry/containment/Escape/return and scroll/background management for opt-in shell overlays; ensure only the topmost overlay handles Escape. Default legacy Modal outside the provider is unchanged, including Production consumers. SideSheet is read-only infrastructure, not a data/form owner.
- Done when: focus/labels/contrast work, no form submits from new controls, mobile sheet content/actions remain reachable, legacy Modal and Card still render identically outside scope, G passes.
- Tests to add: none; no new pure business logic. Manual keyboard checks and diff inspection are appropriate. Do not add snapshot tests that mirror CSS.

### [x] Task 3: Sidebar, responsive shell and topbar

- Files: modify `src/components/layout/Layout.tsx`, `Sidebar.tsx`, `Topbar.tsx`, `src/index.css`; create `src/components/layout/navigation.ts`, `src/components/layout/__tests__/navigation.test.ts`. Consume Task 1 helpers and Task 2 primitives/provider. No App/store/permission changes.
- [ ] Define groups exactly as the spec. Build visible groups from the existing access set and labels from `navLabel`; keep links/end flags. Test that flattening filtered groups equals the input known-key intersection, in wireframe order, without duplicate keys/routes; empty set gives no groups and never mutates inputs.
- [ ] Test fixtures using current `effectiveNavAccess`: owner all, manager no dashboard, staff Welcome+Reports, kiosk Welcome+Order submission, CS Welcome+cases/returns; empty/custom overrides, attempted non-owner dashboard, owner forced Settings, allNavAccess/Dexie. Import the existing function; do not copy/rewrite its algorithm.
- [ ] Opt Layout into `.ui-redesign-shell` and provider. Add skip link/main ID/tab focus, 240px/56px sidebar, grouped nav, custom-label truncation/tooltips, visible active state, sign-out and keyboard-accessible search opener.
- [ ] Add below-768px hamburger modal drawer using the same nav content/access set; close on route navigation/Escape/backdrop, restore focus, unlock scroll, and handle desktop resize without overwriting `sidebarCollapsed`. Keep `/production` standalone.
- [ ] Restyle topbar; retain department/scenario and saved scenario controls and alert model/actions/acknowledgement state. Keep `detectAlerts` and notifier effects single-owned in Topbar; do not duplicate them on Welcome or call notification services.
- [ ] Add System/Light/Dark selector using `setTheme`, resolve through Task 1 and subscribe/clean up OS media-query changes. Move location selection to topbar with identical options and setLocation+reload handler. Show getBackendMode badge; read `VITE_APP_ENV` for the nonsecret label per spec (no new type file/config required). Reuse existing palette hotkey to connect the search opener without adding search behavior; Task 4 finishes presentation.
- Done when: role/override tests pass; shell controls wrap on 375px, all keyboard/mobile/theme checks pass, theme/state persist with current keys, location changes reload once, production route and styles unchanged, G passes.
- Tests to add: `navigation.test.ts`; focused run `npm run test -- --run src/components/layout/__tests__/navigation.test.ts`. Theme/env tests from Task 1 stay green. Manually verify dynamic OS change and real persisted state.

### [x] Task 4: Command palette presentation

- Files: modify `src/components/CommandPalette.tsx`, `src/index.css`; adjust only the search-trigger wiring in `src/components/layout/Layout.tsx`/`Sidebar.tsx` if needed.
- [ ] Restyle the existing dialog/results with semantic tokens, clear category icons, keyboard hint and bounded mobile layout. Keep current matching/haystacks/order, trim/lowercase logic, empty query behavior, 30-hit cap and exact hrefs.
- [ ] Preserve `/`, Ctrl/Cmd+K, arrows, Enter, Escape, click and hover selection; add accessible input/list selection naming and focus containment/restore using the shell overlay pattern. Handle zero results without selecting a phantom row; no new actions or query fetches.
- [ ] Check slash typing in input/textarea/select/contenteditable, Escape from nested dialogs, no-results Enter, shrinking results, 30+ hits, sidebar trigger and restoring focus. Direct-route authorization continues through unchanged NavGate.
- Done when: same queries yield same ordered hits/destinations as baseline, no create/write action appears, keyboard/screen reader checks pass, G passes.
- Tests to add: none; search algorithm is unchanged and should remain in place. If a new search algorithm/helper seems necessary, record it as a scope question instead.

### [x] Task 5: Home, Dashboard and Stock Value

- Files: modify `src/pages/Welcome.tsx`, `Dashboard.tsx`, `StockValue.tsx`, `src/components/CurrentlyClockedInCard.tsx`, `LabourHoursTodayCard.tsx`, `RecentActivityCard.tsx`, `src/index.css` (presentation only). Do not edit `ScannerHealthCard.tsx` or count/status logic.
- [ ] Apply Home card hierarchy and headers to the current data, retaining four production work types, reporting coverage/status, trends, clocked-in and scanner-health components. Omit new attention/activity/stock/money surfaces and fake quick-action commands. Existing permitted-route quick links may be presented as links only.
- [ ] Restyle Dashboard/StockValue with existing KPI values, forecasts, charts, backup/invoice/activity/labour/order controls. Add Overview/Stock value navigation using `/dashboard` and `/stock-value`; omit Stock chart placeholder. Preserve owner gates and filters.
- [ ] Wire loading/empty/error presentation to actual hooks/loaders; maintain stable hook order through loading/refetch. A JSX-only loading boundary must not move calculations after a conditional hook call. Do not change source calculations or cached results.
- Done when: exact baseline values, owner/non-owner behavior and published status labels remain; read failure differs from no data; charts fit mobile; protected scanner-health component code unchanged; G passes.
- Tests to add: none. Compare staged role/data outputs in Task 19; run existing report/count tests through G.

### [x] Task 6: SKUs, SKU detail and existing order/editor dialogs

- Files: modify `src/pages/Skus.tsx`, `SkuDetail.tsx`, `src/components/SkuSettingsCard.tsx`, `CompareModal.tsx`, `OrderBuilderModal.tsx`, `src/index.css`; create `src/components/SkuPeek.tsx`.
- [ ] Restyle current table/filter toolbar, true product/average enums, reorder handles, inline/bulk editors and existing create/import/export/compare/order actions. Keep all existing editable numeric fields in their current paths; no gallery or persisted views.
- [ ] Add `SkuPeek({ product, onClose }: { product: Product | null; onClose: () => void })`, read-only loaded-product properties in SideSheet. Use a dedicated labelled preview trigger so row inputs/selection/drag/link actions never accidentally open it. Include existing detail route and permission-checked Movements link; no new queries, prefill or save. On-hand read-only in peek; BOM edits remain in detail.
- [ ] Restyle detail forecast/history/BOM and existing dialogs without changing computation, validation, ordering templates, MOQ/carton maths or exports. Use actual read/error states from current sources.
- Done when: inline/full detail edits and reorder preserve payloads, existing `/skus/:id` works, peek makes zero writes and opens full screen on mobile, all old actions remain reachable, G passes.
- Tests to add: none; no new pure data logic. Manual interaction overlap checks; current business tests plus Task 19 inventory parity.

### [x] Task 7: Sales Entry and import presentation

- Files: modify `src/pages/SalesEntry.tsx`, `src/components/ShopifyImportModal.tsx`, `CsvColumnMapper.tsx`, `src/index.css`.
- [ ] Restyle the existing weeks × SKUs grid, sticky headers, horizontal scroll, department/reference/filter controls, summary/footer and all add/move/delete/usage/import/export/Notion-paste dialogs. Do not add Week view or change default view/order.
- [ ] Keep `setCell` inputs/blur handler and original adjustment/upsert/delete paths unchanged. No batch bar, Undo, write Retry, new confirm-on-blur, debounce or different input control lifecycle. Never remount inputs because theme/sidebar changes.
- [ ] Render actual read loading/empty/error and existing mutation pending/error state. A global mutation pending indicator may say “Saving”; only show “Saved” if all existing constituent operations are known successful. Do not invent per-cell transaction status; omission of an unprovable success toast is intentional.
- Done when: blank/zero/invalid/change, two rapid cells, both departments, reference selection and paste/import paths call the same handlers with identical arguments; no extra blur write from visual controls; G passes.
- Tests to add: none; no business/helper changes. Existing inventory tests plus Task 19 controlled before/after sales/ledger fixture comparison are required.

### [x] Task 8: Shipments and existing stock confirmations

- Files: modify `src/pages/Shipments.tsx`, `src/index.css`; use existing OrderBuilder from Task 6. Optional create `src/lib/ui/stockConfirmation.ts` and `src/lib/ui/__tests__/stockConfirmation.test.ts` **only** for formatting as defined below.
- [ ] Restyle board/list/calendar, PO form/line/account/invoice/attachment/archive/export controls. Keep all nine real status values and existing filters. “Other” can be a visual disclosure containing separately labelled existing statuses, never a stored value or merged drop target; preserve existing valid drops exactly.
- [ ] Wrap existing stock-affecting delivery/reversal/delete handlers in confirmation showing actual affected SKU quantities and whether auto-apply applies. Existing drag is explicitly in scope because source already has `onDrop`; it and the form must get equivalent confirmation. Cancel preserves status/date/editor and produces no mutation; confirm runs original handler, including its current arrival-date behavior, once.
- [ ] Retain keyboard/form alternative to drag, owner-only accounting, payment distinct from shipment state, `inventory_applied_at` truth and existing pending/error display. No Timeline, new quick-transition action, invoices query or status logic.
- Done when: list/board/calendar remain accessible; cancel/confirm of existing stock actions and both auto-apply settings preserve exact payloads; owner accounting stays protected; G passes.
- Tests to add: no new domain tests. If formatting is shared, define `formatStockConfirmation(lines: readonly { label: string; delta: number }[]): string` as a formatter of **caller-supplied natural signed planned changes**, not an inventory calculator. Test positive/negative/zero/multiple/decimal quantities, missing-label fallback supplied by caller, no mutation, and plain-text escaping by React/native confirm. Existing callbacks supply quantities; helper never aggregates, rounds, clamps or computes BOM. Focused run: `npm run test -- --run src/lib/ui/__tests__/stockConfirmation.test.ts` if created.

### [x] Task 9: Shopping List

- Files: modify `src/pages/ShoppingList.tsx`, `src/index.css`.
- [ ] Apply supplier-section hierarchy, quantities/subtotals and existing override controls/exports. Use current forecast recommendations and arithmetic; no new “Why” causal calculation or new per-supplier create action.
- [ ] Relabel the existing action **Create draft shipments** as instructed. Add truthful helper text that the current workflow creates records in **Ordered** status. Keep `placeOrders` confirmation, one-per-line loop, IDs, dates, notes, quantities and **`status: "Ordered"`** unchanged. Actual result badges still say Ordered. Record the label mismatch in Open questions for CJ.
- Done when: empty recommendations remain an honest empty state; two lines sharing a supplier still produce two records with the original fields/status; no grouping-related write change; G passes.
- Tests to add: none; no calculation changes. Task 19 checks request/record cardinality and original totals.

### [x] Task 10: Demand Events

- Files: modify `src/pages/Events.tsx`, `src/index.css`.
- [ ] Restyle current list/year-calendar strip and editor using wireframe hierarchy, true multiplier/dates/SKU/wildcard/size/colour fields and existing actions. Retain all present controls and default values.
- [ ] Omit new Timeline drag/resize and what-if forecast panels. Read-only date graphics use the existing strip calculations only. Add current-hook loading/empty/error display and accessible labels/navigation.
- Done when: create/edit/delete invoke original handlers, calendar date ranges and multipliers match baseline, no new mutation path or forecast engine call, mobile list/form works, G passes.
- Tests to add: none; existing date/forecast logic untouched.

### [x] Task 11: Warehouse and read-only bay layout

- Files: modify `src/pages/Warehouse.tsx`, `src/index.css`; create `src/components/WarehouseBayMap.tsx` only if needed to keep markup separate.
- [ ] Restyle current utilisation, per-SKU capacity, projection/scrubber, arrivals and stockout schedule. Preserve all current formulas and exactly which figures the scrubber controls; no hypothetical per-bay forecast.
- [ ] Render bay row/column, type (floor/rack/cold), `max_pallets` and current loaded assignments read-only. If separated, component consumes `storage: StorageLayout` and `products: readonly Product[]`, no hooks/writes; allow selecting a bay solely to reveal its existing assignments. Do not allocate stock to bays or infer occupancy. Explain if saved assignments differ from stock-derived fullness.
- [ ] Handle no bays with a permitted link to Settings, no products/assignments without fake occupancy, sparse row/column layouts and all read states. Retain unconditional hook ordering during loading/refetch.
- Done when: rendered geometry/labels come from actual storage; stock-derived capacity totals and scrubber outputs equal baseline; no writes or extra fetches; mobile map scrolls, G passes.
- Tests to add: none if using raw row/column CSS positions. If projection/occupancy logic would be required, it is out of scope; do not invent it.

### [x] Task 12: Movements and searchable SKU selection

- Files: modify `src/pages/Movements.tsx`, `src/index.css`; create `src/lib/ui/productSearch.ts`, `src/lib/ui/__tests__/productSearch.test.ts`. Consume optional formatting helper from Task 8.
- [ ] Test/implement the picker filter contract: blank/trimmed/case-insensitive/code/short-code/no-match query, duplicate labels with distinct IDs, immutable input and stable order. Use a labelled search field narrowing the existing native select (accessible without a new combobox dependency); preserve selected product when filtering and never auto-select the first result.
- [ ] Restyle quick-add and ledger with actual presets/reasons and existing limits. Preserve `submit`, signs/source IDs, ledger query size, reversal eligibility and `handleReverse`. The mock's “manual rows only” is not a new eligibility rule; use executable code.
- [ ] Keep reversal confirmation and add a pre-submit quantity/direction confirmation to the existing movement action. Display requested change, not a guaranteed balance. No transfer counterpart, generic ledger Undo, new source routes or new mutation Retry.
- Done when: keyboard selection preserves ID; invalid qty/unknown selection still blocked; cancel writes nothing and confirm calls the old action once; reversal original stays visible and eligibility unchanged; G passes.
- Tests to add: `productSearch.test.ts`; focused run `npm run test -- --run src/lib/ui/__tests__/productSearch.test.ts`. Formatting tests only if formatter reused/extended without calculations; staged ledger parity in Task 19.

### [x] Task 13: Paper Usage

- Files: modify `src/pages/PaperUsage.tsx`, `src/index.css`.
- [ ] Restyle existing A0–A4 inputs/overrides, buffer, roll output, notes, saved snapshots and load/delete controls. Keep current rounding, roll-length/mapping rules and save handler intact.
- [ ] Use in-page sections rather than unmounting the editor. Add a confirmation before the existing stock-changing save describing reversal of stored deductions and proposed mapped new deductions separately; preserve current deletion confirmation. Calculate no new inventory result in the display helper: use the existing values/expressions from the handler. If these cannot be exposed without changing behavior, stop with a precise question.
- [ ] No save-only/deduct choice, Trend report, once-only assertion, changed Deducted flag or new write retry. Unmapped save still takes its existing non-deduction path; re-save keeps reversal/reapply ordering.
- Done when: mapped/unmapped/re-save/changed-mapping/delete payloads match baseline; cancel does not reverse/deduct/save; input drafts survive visual navigation/errors; mobile layout works; G passes.
- Tests to add: none for existing roll math; retain existing tests and Task 19 stock fixtures. Any display formatter tests remain pure formatting.

### [x] Task 14: CS Cases

- Files: modify `src/pages/CsCases.tsx`, `src/index.css`.
- [ ] Restyle existing board/list/report/filter/editor/lookup content; keep New/Query/Shipped/Closed/Denied, urgency, issue/department mappings, carrier and archive/date rules. Keep notes a single field and all existing report controls.
- [ ] Reuse existing dialogs/edit actions; no new inline status shortcut, My cases filter or comments. Preserve case line field names, tracking requirements, Shopify error behavior and save/delete logic.
- [ ] Keep current confirms; expose quantity consequences before any existing stock-affecting case save/delete not already confirmed, including old-line reversal versus new-line application. Confirmed call is the same `upsertCsCase`/delete operation; never implement ledger logic in the page.
- Done when: exact state/validation/action parity, no new route/query/table, notes and failed-form inputs retained, mobile/keyboard usable, G passes.
- Tests to add: none beyond optional pure confirmation formatting; existing suites and staged replacement-transition parity in Task 19.

### [x] Task 15: Returns

- Files: modify `src/pages/CsReturns.tsx`, `src/index.css`.
- [ ] Restyle existing board/list, quick arrival, lookup, status/filter/form/refund controls; keep New/Received/RTS/Closed, existing per-line restock flags and save timing. Do not move restock writes into the table or add unsupported source links.
- [ ] Add quantity confirmation before existing stock-affecting save and preserve/enrich existing delete confirmation. Use current lines and previous record to describe what the existing action intends; do not alter credit flags, signs, transition predicates or ledger outcomes to match optimistic wireframe copy.
- [ ] Keep truthful pending/error labels; show actual recorded success only. If baseline behavior differs from intended restock, document the discrepancy and stop that acceptance claim for CJ; no backend fix in this task.
- Done when: quick log and normal form call original paths, cancel makes no calls, confirm preserves original payload, repeated/edited saves match baseline, G passes.
- Tests to add: none beyond optional pure formatting; Task 19 covers received/RTS/closed/edit/delete fixture ledger outcomes.

### [ ] Task 16: Reports navigation and report presentation

- Files: modify `src/pages/Reports.tsx`, `src/components/ReportsOverview.tsx`, `FrameTimingSection.tsx`, `OrderFlowSection.tsx`, `OrderTimelineCard.tsx`, `DailyTimesheetCard.tsx`, `PackageUsageCard.tsx`, `PackageHistoryCard.tsx`, `PackagingAttentionCard.tsx`, `LiveOrderCompletionsCard.tsx`, `src/index.css` (presentation only). Shared OrderTimelineCard legacy rendering outside shell remains unchanged.
- [ ] Add secondary in-page anchor navigation to all current sections, conditionally matching existing section gates; no new URL routes or combined filter state. Preserve existing independent date windows, manual refresh, lazy/paged reads, published cursors and component mount/visibility semantics.
- [ ] Restyle existing Overview, leaderboard, variants/timing, order lookup/timeline/flow, completions, coverage issues, staff productivity, timesheets and packaging content. Do not remove newer report features absent from the mock or duplicate their readers in another tab.
- [ ] Keep server-scoped staff reports, owner-only removal, rates/cost restrictions, export fields and counts exactly as today. Display existing manual/inferred/method/coverage/published/stale/partial/errors; no fake “live” freshness.
- Done when: reports have readable mobile sections, identical requests/filters/counts/export content and unchanged gating; stock charts/reports not added here; G passes.
- Tests to add: none; run current counting/period/published/report suites via G and compare Task 19 snapshots/exports. This task must not change domain or API helpers.

### [ ] Task 17: Team and existing access administration

- Files: modify `src/pages/Team.tsx`, `src/components/TeamMembersCard.tsx`, `src/components/departments/DepartmentsCard.tsx`, `src/index.css` (presentation only).
- [ ] Apply member/access/rate section hierarchy with existing controls and role gates. Preserve allowed_nav editor inputs/default/override semantics; non-owner Dashboard stays locked by existing rules, not a new role policy.
- [ ] Present the existing two-step Auth-user creation/paste UID flow with accurate instructions; no one-step email invite or backend admin call. Keep departments/home assignments, rates, barcodes, lanyards, print/download and existing side effects in their current paths.
- Done when: owner administration and manager/staff/CS/kiosk visibility match baseline, UID flow produces the same profile/location writes, all existing department/barcode functions reachable, G passes.
- Tests to add: none; permission helper coverage is Task 3; backend-role/UID/lanyard parity in Task 19.

### [ ] Task 18: Settings secondary navigation and full section coverage

- Files: modify `src/pages/Settings.tsx`, `src/components/SupplierPaymentTermsCard.tsx`, `ProductionBenchmarksCard.tsx`, `PackagingRulesCard.tsx`, `FrameTimingWeightsCard.tsx`, `src/index.css` (presentation only).
- [ ] Add labelled in-page anchors/grouped secondary nav. Keep mounted form/loader lifetimes. Cover Locations, global defaults, currency/working days/container/scenario start/supplier filters, warehouse capacity, carton dimensions, paper mappings, sidebar labels, alerts explanation, backup/import, CSV templates, cleanup, danger zone, Dexie migration and cross-location diagnostics, supplier terms, production benchmarks, packaging rules and frame-timing weights. Preserve current backend/role gates.
- [ ] Restyle fields/cards/sections and existing danger confirmations. Preserve blur/change saves and explicit button handlers individually; no new per-section Save footer or Settings route. Appearance control may link to the existing shell theme selector rather than create another persisted setting.
- [ ] Keep original sample/wipe/import/cleanup/migration controls and confirmations; do not run destructive operations as visual verification except approved disposable fixtures in Task 19. No automatic configuration migration.
- Done when: full source section inventory is still reachable, settings writes trigger at the same event with the same payload, no draft loss from secondary navigation, mobile sections/forms work, G passes.
- Tests to add: none. Compare nav rename, defaults and safe settings edits in staging; full dangerous-flow checks only on disposable data.

### [ ] Task 19: Whole-app regression evidence and release handoff

- Files: update this plan's checkboxes/Implementation log/Open questions only. Any required implementation correction returns to its owning task and scope; do not make Task 19 an unreviewable catch-all. Reviewer files are produced separately by the planner under the repository workflow, not authored by the coder as self-approval.
- [ ] Audit the final diff against protected paths and the spec capability table. Confirm package/lockfiles, repositories, hooks, domain/business helpers, auth, routes, station components, migrations and APIs have no redesign changes. Check all 16 page reference files including Demand Events, plus StockValue/SkuDetail.
- [ ] Run G and `npm run typecheck:digest`, `npm run typecheck:api`; record actual command outcomes. Complete the spec's full staging plan, including owner/manager/staff/kiosk/cs, overrides, direct URLs, two backends, all themes, mobile/keyboard, all three sites and stock write parity.
- [ ] Through CJ's existing staging release workflow, obtain the branch's Vercel Preview against **inka-staging-2**. Verify frontend/server project targeting and safe integration/test recipients before tests. No agent production merge/deploy/SQL. This planner turn does not push; preview publishing is a later release handoff owned by CJ under AGENTS.md.
- [ ] Record exact preview/commit, roles/fixtures/check results and outstanding blockers in the log; don't store secrets or generated `staging-results-*` files forbidden by CI. Request independent final review against the hardening/spec requirements and verify PR CI green.
- Done when: local checks, CI, reviewer approval and staging evidence satisfy the spec; all pending checks are resolved. If preview/role/integration access is missing, leave task unchecked and report the missing item with FAILED status. Do not label implementation complete based only on these docs.
- Tests to add: none; this is the combined verification and evidence gate. Commit only the updated plan evidence as `task 19: record ui redesign verification` when genuinely complete.

## Hardening in the plan

This maps every question in `docs/HARDENING.md` to implementation/verification, including explicit n/a reasons. The spec contains the behavior contract; this table is the execution checklist.

| Item | Task and proof |
| --- | --- |
| 1.1 Slow/down network, Supabase, Shopify, Dropbox, Slack, Make | Tasks 2/5–18 preserve actual loading/error/backend notices and drafts; Task 19 offline/throttled read + restore checks. Existing Shopify/Dropbox failures remain visible. Slack/Make n/a: no integration changes/calls added. |
| 1.2 Retry/duplicate save | Tasks 4/7–15/18 retain original writes/keys; Task 2 read-only action slot never retries a mutation. Task 19 compares baseline duplicate/pending/partial behavior and zero-write cancellation. No new idempotency claim. |
| 1.3 Two users/devices | Task 19 same-fixture concurrent sessions and request parity; Tasks 8/12–15 confirmations state planned changes, not locked balances. No concurrency-control changes. |
| 1.4 Bad input | Tasks 6–18 keep existing validators/defaults/unknown-ID handling; Task 12 pure filter edge tests. Scanner malformed/unknown/cancelled/wrong-site handling protected; Task 19 station/lookup regression. |
| 1.5 Failure and recovery | Tasks 2/5–18 expose actual error and existing read recovery without hiding forms; Task 7 no false saved toast. Task 19 blocked/partial-write evidence uses current reconciliation tools; no automatic replay. |
| 2.1 Attribution | Tasks 3/5/16/17 preserve sales department versus work type versus managed department; Task 19 compares worker credit and station behavior. No identity edits. |
| 2.2 Orders/items/sets | Tasks 5/16 preserve shared counts/published readers; G existing suites plus Task 19 same-fixture counts/exports. |
| 2.3 Historical correctness | Tasks 5/16–18 no count/history/config semantics changes; Task 19 before/after snapshots. No event rewrite/schema migration. |
| 2.4 UTC/site zones | Tasks 5/16 preserve source period/formatting paths, other pages retain date-only fields; Task 19 AU/UK/US boundary and browser-zone comparison. No timezone refactor. |
| 2.5 Manual/inferred labels | Tasks 5/16 retain coverage/manual/inferred/method/stale/missing indicators; Task 19 verifies incomplete ranges are not zero/live. |
| 3.1 Endpoint authentication/input | N/a: no endpoints changed. Protected-path audit in Task 19 verifies this; existing server validation retained. |
| 3.2 Tables/RLS/roles | N/a for schema/policy work. Task 3 tests existing role sets, Tasks 5/8/16–18 preserve inner gates, Task 19 all-role/direct-route checks. |
| 3.3 Secrets | Tasks 1/3 env badge has a public label only; Task 19 preview-target verification/log redaction. No service credentials in UI/env examples/source. |
| 3.4 Cost/spam/data exposure | Tasks 3–6/16 no new sends, duplicate readers or data-rich Home surfaces; Task 19 request/visibility comparison, existing owner gates. |
| 4.1 Expand-only migration/old app | N/a: zero SQL/migration work; Task 19 audit confirms unchanged data contracts. |
| 4.2 Off switch/shop floor | Tasks 1–3 scoped opt-in style/provider, Task 19 station regression. No business flag needed; CJ's post-bulk Instant Rollback is recovery. |
| 4.3 Exact release steps | Task 19 and Release section below: post-bulk target, safe Preview env, all gates, CJ separate merge/deploy. No SQL/integration changes. |
| 4.4 Per-role staging | Task 19 executes spec role matrix, including staff Reports, kiosk Welcome, overrides and both backends. |
| 5.1 Months of events | Tasks 5/16 keep paging/summary/range ownership. Task 19 compares requests and long-range render with baseline; no query/index work. |
| 5.2 External API per item | Tasks 6/11 read-only views use loaded data; Tasks 14–16 retain lookup/cache readers. Task 19 no-N+1/duplicate-poll check. |
| 5.3 Two years/three sites | Task 3 reload semantics; Tasks 5/16 keep existing long-range readers/caps; Task 19 two-year fixtures/site switches and performance comparison. |
| 6.1 Know when broken | Tasks 2/5/16 keep actual errors/health/freshness; Task 19 console/request review. CJ watches existing Vercel logs and smoke feedback after release. |
| 6.2 Shop-floor fallback | Tasks 1–3 preserve standalone production; Task 19 checks it. CJ restores known-good post-bulk deployment if necessary; uncertain writes inspected with current ledger tools. |
| 6.3 Maintenance | N/a for new storage/subscriptions/credentials: none added. Tasks 1/3 semantic theme/env label, Tasks 3/19 nav/mobile checks maintained as source UI changes. |
| 7.1 Pure logic unit/edge tests | Task 1 theme/env, Task 3 groups/filtering, Task 12 local matching; Task 8 optional formatting. Focused tests then G. No new production/counting logic. |
| 7.2 Inventory/credit/money tests | G retains all existing suites; Tasks 7–15 and Task 19 baseline-vs-candidate stock/ledger/payload assertions, cancellation and pending checks. Any real behavior change requires another spec/tests, never folded in here. |

## Release and rollback

- **Release order:** this redesign is a separate release **after the bulk release**. Build/review against the accepted post-bulk code, preserving its feature and security fixes. If the base changes while work proceeds, record and rerun affected parity checks before release.
- **Migration(s) and compatibility:** none. No tables, columns, policies, indexes, RPCs or SQL scripts. Both backends keep their existing contract and data. No contract follow-up release is needed.
- **Preview preparation (CJ):** use the branch preview workflow; verify Preview `VITE_BACKEND=supabase`, public Supabase URL/anon key and server Supabase variables all belong to **inka-staging-2**. Set display-only `VITE_APP_ENV=preview`; Production uses `production` or no label. Keep safe staging integration credentials and test recipients already required by the release runbook. This variable is not a backend switch. No production secrets in evidence; never test against production.
- **Before release (CJ):** confirm default decisions/wording, approve plan/review, verify CI green and Task 19 evidence, then record the exact known-good **post-bulk, pre-redesign** production deployment as rollback target. Do not choose a target predating security or bulk business fixes.
- **Production (CJ):** at a quiet time after bulk release is stable, merge the separately reviewed PR; Vercel production deployment and release tag follow `docs/RELEASING.md`. No SQL, auth setup, Shopify, Dropbox, Make, Slack or cron changes. Agents never merge main, deploy production or apply SQL. The planner does not push or publish a preview in this turn.
- **Watch:** CJ repeats read-only smoke checks where possible, watches existing browser/Vercel errors, confirms shop-floor availability and gathers staff feedback for the first 30 minutes. Do not send digest emails as a cosmetic health check.
- **Rollback:** Vercel **Instant Rollback** to the recorded post-bulk pre-redesign deployment. **No DB involvement, restore, migration reversal or data deletion.** Old code still understands records written while the new UI was live because payloads/schema never changed. New UI state is ephemeral; existing persisted theme/sidebar/location values are compatible.
- **After rollback:** CJ follows the runbook's fix-forward/revert-on-branch process so git matches the live deployment. Investigate any uncertain existing writes using ledger/history; never blindly repeat them. No new feature flag is required for a presentation-only release with protected station screens.

## Out of scope

- Every exclusion in the spec capability table, especially editable Week, Sales Undo/write Retry, new Timeline/drag mutations, palette actions, grouped purchase writes, comments, invitation endpoint, new report URLs and new save modes.
- Repository/API/schema/permission/domain/station changes, new dependencies, production access during development, and repairs to historical architecture findings.
- Replacing current reports/settings/department/packaging features with older wireframe mock content; adding fabricated metrics/counts/freshness or dead controls.
- This plan is not evidence that code, tests, CI, staging or release have already completed.

## Open questions

Coder writes here when it hits something the plan did not foresee. Planner/CJ answers inline before affected work continues.

- **Default decisions:** CJ to confirm the five spec decisions. Default implementation remains as recorded; no new data/behavior work is unlocked by the wireframe approval.
- **Known copy mismatch, resolved for implementation:** ShoppingList `placeOrders` creates one `Ordered` shipment per line today. Task 9 changes the requested label only, retains Ordered and adds truthful explanation. CJ may choose different copy; a Draft status change is a separate behavior proposal.
- **Release ownership:** staging preview is a required deliverable of implementation, obtained through CJ's release workflow under AGENTS.md. This two-file planner task does not push/deploy. Missing preview access must be reported explicitly in Task 19.

- **Task 15 stopped on a baseline defect (coder, 2026-11-25): return restocking moves stock the wrong way.**
  `upsertCsReturn` (both adapters) "restocks" a Received/RTS line with `adjustOnHand(product, +quantity)`, but
  `adjustOnHand`/`adjust_on_hand` subtract a positive delta; the reversal/delete path passes negatives. So saving a
  return as Received with Restock ticked currently **removes** that quantity from stock, and undoing it adds it.
  This is `docs/ARCHITECTURE.md` finding 4, unchanged on live (`79a0031`) and `main`. Live has **0** `cs_returns`
  rows (read-only check 2026-11-24), so no live stock has been affected yet. Per this plan no restock confirmation was
  added (it would have had to claim "+N back to stock" while the code subtracts) and no backend fix was made here.
  **CJ/planner:** decide a separate inventory spec (fix the sign with tests, ledger-checked) and, until then, tell CS
  not to tick Restock on returns. Returns were restyled only (Task 15 acceptance claim for restock withheld).

## Implementation log

Coder adds one line per completed task with commit, checks and relevant manual evidence; mark staging-only checks pending until run. No implementation task has been completed by writing this plan.

- 2026-11-24 — Planner created spec and plan from approved wireframes, current source and repository guidance. Documentation only; no application tests, staging run, commit, push or deployment performed in this planner task.
- Task 1 — scoped --hub-* tokens (light/dark, values from wf.css) + Tailwind colors.hub; shell foundations and a scoped neutral bridge (slate/white utilities resolve to tokens only inside .ui-redesign-shell; :where() keeps real dark:/hover: variants winning); appearance.ts + 8 tests. tsc 0; tests 3403 pass, 6 fail = the known Windows CRLF migration-hash tests (baseline before Task 1: same 6); build ok. Station unaffected (no shell yet). Surprise: none.
- Task 2 — UiPresentation provider + useOverlayBehavior (focus entry/trap, topmost-only Escape, scroll lock, focus return); Button/Card/Input/Field/StatusPill/Modal pick the hub look only inside the provider and keep their exact legacy classes/behaviour outside (Production's Modal path is the untouched LegacyModal); new PageHeader, DataState, TableContainer (+ scoped .hub-table styles), Badge, SideSheet (460px / full-screen <768px). No new tests (presentation only). tsc 0; tests 3403 pass + 6 baseline CRLF; build ok.
- Task 3 — navigation.ts (NAV_GROUPS, visibleNavGroups) + 14 tests incl. every role default/override through the real effectiveNavAccess; Layout opts into .ui-redesign-shell + provider, skip link to focusable #main-content, mobile drawer (<768px) with focus trap/Escape/backdrop/route-change close/scroll lock and desktop-resize close; Sidebar 240/56px grouped nav, logo, palette opener (dispatches the existing Ctrl/Cmd+K hotkey), user + sign-out; Topbar keeps department/scenario/saved scenarios and the alert logic verbatim, adds System/Light/Dark with OS listener, location select moved here (same setLocation + reload), Supabase/Local + env badge (hidden in production), narrow-screen Display options panel. Checked in the browser on Dexie: light/dark, 1366px, 375px drawer (focus in, Escape returns focus to the trigger, nav closes it, scroll unlocks), /production renders without the shell. Logo copied to src/assets (file not named in the plan). tsc 0; tests 3417 + 6 baseline CRLF; build ok. Found (pre-existing, not this task): in Dexie mode Settings crashes because PackagingRulesCard calls useAuth() outside AuthProvider — logged for the release review.
- Task 4 — CommandPalette render restyled with hub tokens, combobox/listbox/option + aria-activedescendant, shared overlay focus containment and focus return, mobile-bounded layout; hits/matching/order/30 cap/hrefs/hotkeys untouched (diff limited to render + one hook). Browser check: opener focuses the combobox, 'a2' gives 4 hits, ArrowDown moves the active option, Escape closes and returns focus to the sidebar search button. tsc 0; tests 3417 + 6 baseline CRLF; build ok.
- Task 5 — Welcome: PageHeader, hub stat labels/values, tone badges, sparkline stroke currentColor (was #0f172a, invisible in dark), Dexie message as DataState; all loaders/cards (incl. ScannerHealthCard, CurrentlyClockedInCard) unchanged. Dashboard + StockValue: PageHeader, Owner-only badge, Overview/Stock value tabs (new DashboardTabs.tsx: links to the existing /dashboard and /stock-value routes, not in the plan's file list), DataState loading. FIXED a live crash the plan's hook-order rule covers: Dashboard returned 'Loading' before a useMemo, so a direct load/reload of /dashboard threw 'Rendered more hooks than during the previous render' (same code on live 79a0031); the loading return now sits after every hook. Audit found the same pattern in SalesEntry and Warehouse (fixed in Tasks 7/11) and role-based early returns in ProductionBenchmarksCard/TeamMembersCard (profile is stable per session; left). Browser: /dashboard direct load OK, Stock value OK. tsc 0; tests 3417 + 6 baseline CRLF; build ok.
- Task 6 — Skus: PageHeader, sentence-case sticky table header, DataState loading, labelled Preview button per row opens SkuPeek (new src/components/SkuPeek.tsx): read-only SideSheet of the loaded product + existing forecast row, links to /skus/:id and (if allowed) /movements, on-hand marked read-only, no fetch/save. Existing inline/bulk edits, reorder handle, compare, delete confirm, import and New SKU unchanged; OrderBuilder/Compare modals pick up the shell Modal. SkuDetail: hub header, DataState loading/not-found. Surprise: stored rows can lack components/product_type though the type says they exist; peek guards both (found in browser). Browser: peek opens with focus inside, Escape closes and returns focus to the Preview button. tsc 0; tests 3417 + 6 baseline CRLF; build ok.
- Task 7 — SalesEntry: hub header (+ 'Each cell saves when you leave it' to state the existing blur save), hub table header, DataState loading. FIXED the hook-order crash on a direct load (footerValues useMemo sat after the loading return): totalFrames + footerValues moved above it, unchanged. setCell/blur/paste/import/export/move/delete paths untouched (diff is header/loading/thead + the move). Browser: /sales direct load renders the grid (731 inputs). tsc 0; tests 3417 + 6 baseline CRLF; build ok.
- Task 8 — Shipments: confirm before every existing stock-changing path — kanban drop to/from Delivered, form save that credits or reverses, delete of an applied shipment — listing exact SKU units and direction; Cancel writes nothing, Confirm runs the original upsertShipment/deleteShipment once. New pure helper src/lib/ui/shipmentStockChange.ts (mirrors the repo rules; 10 tests) and reusable src/components/ui/ConfirmDialog.tsx (useConfirm, promise-based; rendered last so it stacks over the form) — both new files not named in the plan. Header/loading/board column restyle; all 9 statuses kept as columns (no 'Other' merge). Browser (Dexie): drag PO-2026-0138 to Delivered shows +400 A1-Natural/+250 A1-Black; Cancel left it In Transit; Confirm moved it and stock went 2380->2780 and 1062->1312 exactly once. tsc 0; tests 3439 + 6 baseline CRLF; build ok.
- Task 9 — ShoppingList: hub header, DataState loading, action relabelled 'Create draft shipments' with visible aria-describedby help 'Creates one shipment per line, each with status Ordered.' placeOrders, its window.confirm, the one-per-line loop and status: 'Ordered' are untouched. Note for CJ (already in Open questions): the old label 'Mark all as ordered' was the more literal one. tsc 0; tests 3439 + 6 baseline CRLF; build ok.
- Task 10 — Events: hub header, DataState loading, labelled previous/next year arrows; list/strip/editor and all handlers unchanged (no Timeline, no what-if). tsc 0; tests 3439 + 6 baseline CRLF; build ok.
- Task 11 — Warehouse: FIXED the direct-load crash (three useMemos after the loading return) by splitting into a thin Warehouse (loading) + WarehouseLoaded({data}) holding the unchanged body, so hook order is fixed; hub header; empty-bays text links to Settings. New read-only src/components/BayMap.tsx (file not named in the plan): bays placed by saved row/column, floor/rack/cold legend, saved assignments/max per bay, select reveals that bay's saved assignments; explains stock-derived fullness vs saved assignments; no writes. Formulas/scrubber/schedule unchanged. Browser: /warehouse direct load OK, 25 bays, Bay A1 shows its 2 saved slots. tsc 0; tests 3439 + 6 baseline CRLF; build ok.
- Task 12 — Movements: filterProductsForPicker (src/lib/ui/productSearch.ts, 6 tests: blank/trim/case/code/short code/no match/duplicates/no mutation); labelled search narrows the existing native select, the selected SKU always stays listed, nothing auto-selected; 'Log movement' asks first (requested change, explicitly not a guaranteed balance) then runs the unchanged submit once; reversal keeps its existing window.confirm; hub header/loading. Browser (Dexie): 'a2-n' lists A2-Natural/A2-Natural-bulk; Cancel left the ledger at 2 rows; Confirm made exactly 1 row (-3 A2-Natural). tsc 0; tests 3445 + 6 baseline CRLF; build ok.
- Task 13 — PaperUsage: confirm before the existing save whenever it changes stock, listing the give-back of the prior deduction (stored SKU/rolls) and the fresh whole-roll deduction, computed with the handler's own expressions (data.paperUsage, mapped roll SKUs, ceil(totalMM/ROLL_LENGTH_MM)); the handler body is unchanged and runs once on confirm; a save with no stock effect saves directly as before. Hub header. Browser (Dexie, roll SKUs mapped locally): dialog -1 A0-Black (24"), -2 A0-Natural (42") matches the page's 'Save will deduct'; Cancel 0 writes; Confirm 2 ledger rows; re-save lists the give-back first. tsc 0; tests 3445 + 6 baseline CRLF; build ok.
- Task 14 — CsCases: the two window.confirms became one confirm that lists both repository steps per line (give back the previously deducted lines, then deduct the current lines) and now also covers the case that was NOT confirmed before: re-saving an already-deducted case with edited lines; delete of a deducted case lists the give-back (plain delete keeps its window.confirm). Same upsertCsCase/deleteCsCase calls once on confirm; statuses/notes/lookup/board unchanged; hub header. Browser (Dexie): new Shipped case with tracking + 2x A0-Black -> dialog '-2 A0-Black'; Cancel: 0 cases, ledger unchanged, form still open; Confirm: 1 case, 1 ledger row. tsc 0; tests 3445 + 6 baseline CRLF; build ok.
- Task 15 — CsReturns: hub header only; existing delete confirm kept. STOPPED the restock-confirmation part on a baseline defect (Open questions): upsertCsReturn restocks with a positive delta that adjustOnHand subtracts, so 'restock' removes stock (ARCHITECTURE finding 4; live has 0 returns). No misleading confirm added, no backend change. tsc 0; tests 3445 + 6 baseline CRLF; build ok.
