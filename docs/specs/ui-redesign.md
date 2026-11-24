# Spec: UI redesign

- Slug: `ui-redesign` · Roadmap ID: none; additional visual/navigation work authorised in CJ's 2026-11-24 chat, after the bulk roadmap release.
- Status: approved by CJ (wireframes and instruction to implement, 2026-11-24 chat); section-4 defaults to be confirmed by CJ.
- Author: planner (GPT-6 Astra) · Written: 2026-11-24.
- References: `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/HARDENING.md`, `docs/RELEASING.md`, `docs/wireframes/REVIEW.md`, `docs/wireframes/index.html`, all page wireframes, `wf.css`, `wf.js`, and `icons.js`.

## Problem

The operational React app needs the approved wireframes' consistent hierarchy, compact tables, grouped navigation and theme treatment. Its current sidebar disappears below 768px without a mobile replacement. Staff must still find and perform exactly the same operational work. A visual implementation must not accidentally replace real stock, reporting or permissions logic with the wireframes' mock interactions.

The wireframes are the visual reference, not executable specifications of data behavior. The checked-in implementation has advanced beyond the architecture baseline and parts of REVIEW.md. This spec resolves those differences explicitly; the hard scope rule and executable code take precedence over mock labels, sample numbers and annotations.

## Goals

- Apply the approved light/dark tokens, Lucide icon language, page headers, tables, cards, property panels and secondary navigation to the existing React screens.
- Preserve every current route, permission key, data source, domain calculation, validation rule, mutation payload and operational action. Organise existing actions without deleting functionality omitted from the drawings.
- Support light, dark and system themes, desktop, and a keyboard-accessible hamburger drawer below 768px.
- Render honest loading, empty, failure, pending and unsupported-backend states from current hooks/local loaders. Preserve drafts on read errors; never show an unsuccessful write as saved.
- Preserve or add confirmation around existing explicit stock-changing actions as required by REVIEW.md section 3. This is a presentation guard before the same action, not a new stock workflow. Sales per-cell auto-save remains unchanged.
- Deliver a separately reviewable implementation branch and staging preview against **inka-staging-2**, then a separate release after the bulk release.

## Non-goals

- No changes to `Repository.ts`, `DexieRepo.ts`, `SupabaseRepo.ts`, any other repository implementation, migrations, tables, RPCs, API endpoints, domain schemas, stock/ledger rules, effective permissions or route declarations/guards.
- No changes to `effectiveNavAccess`, `allowed_nav`, RLS, auth/session handling, counting, attribution, production periods, forecast formulas, payment arithmetic, imports/exports or existing save/retry semantics.
- No npm dependencies or package/lockfile edits. Use installed React, Tailwind, lucide-react and Recharts.
- No station redesign: `Production.tsx`, `src/components/production/**`, scanner/dispatch/packaging execution and station state remain unchanged. `/production` stays outside `Layout`; do not wrap it in new chrome. Existing shared components must retain their production appearance and interaction outside the redesigned shell.
- No redesign rollout setting, database-backed preferences, new notifications/integrations, new financial/reporting metrics, persistent saved views, new routes or data-fetch fan-out.
- This planner turn creates only this spec and `docs/plans/ui-redesign.md`. No app edits, commits, pushes, deployments or database access are part of this turn.

## Decisions and implementation boundaries

### REVIEW.md section 4: decided-by-default, to be confirmed by CJ

| Question | Default decision | Exact implementation constraint |
| --- | --- | --- |
| Sales save model | Keep per-cell auto-save exactly as today. | Preserve `setCell` on blur, validation, deletion and adjustment/upsert ordering; no batch save, debounce, new write retry or Undo. |
| Shopping list grouping | Keep one draft shipment per line; button relabelled only. | Use label **Create draft shipments**. Preserve `placeOrders` and one shipment per line. **Current code actually writes `status: "Ordered"`**, not Draft. Do not change it to Draft to match the label; retain truthful status display and explain that created records currently enter Ordered. CJ must confirm wording; a status change requires separate scope. |
| CS threaded comments | No threaded comments and no new table. | Restyle the single existing notes field. |
| Team invitation | No one-step invite. | Preserve create-user-in-Supabase, then paste UID/profile/location flow. No invitation endpoint or email send. |
| Sidebar theme | Follow the selected/resolved theme. | Light sidebar in light mode, dark sidebar in dark mode; system follows OS preference. |

These defaults are not claims that CJ separately approved each answer. They are the instructed overnight decisions. The approved visual direction and instruction to implement are recorded in the header; production release remains CJ's step.

### Source findings that override mock behavior

- `src/lib/auth/permissions.ts` now gives staff **Welcome and Reports** by default; kiosk gets **Welcome and Order submission**. Use the function's actual result, including overrides, rather than copying the older role simulation in `wf.js` or ARCHITECTURE.md. Non-owner Dashboard remains prohibited; owners with overrides still retain Settings and Welcome.
- Palette source is **`src/components/CommandPalette.tsx`**, not under `layout/`. It already opens with `/` and Ctrl/Cmd+K, searches SKUs/events/shipments/suppliers, returns at most 30 hits and navigates to existing destinations. It does not provide an action or navigation-command index. Preserve that behavior.
- `useAppStore` persists theme, department, scenario, sidebar and alert state in the existing browser-origin store `inkaar-app-state`; it is not per-auth-user storage. Do not introduce account-scoped persistence because the mock says “saved per user.”
- Shipments already has status-changing kanban drag/drop. Keep that exact path and existing form alternative; do not add another status engine, new drag targets or drag library. Grouping visual columns never turns `Other` into a stored status.
- Paper Usage currently has a save path that reverses old recorded deductions, applies mapped deductions and saves a snapshot. The mock's separate “save only / save and deduct” modes would change that path and are excluded.
- Settings has blur/change saves as well as explicit buttons. Decorative per-section Save footers must not convert immediate saves into draft forms.
- Current Welcome/Reports use shared production and published-report readers; Team includes Departments; Settings includes packaging and frame timing configuration. Retain these even where the older wireframe does not draw them. Architecture findings are historical warnings to verify, not permission to repair unrelated business logic here.

### Approaches

Use incremental presentation changes inside the existing React components: semantic tokens first, then shared primitives/shell, then pages. Keep hook calls and handlers in place, preserve component state when showing different sections, and use read-only side peeks only where no existing edit flow is displaced. This is the planner's implementation choice under CJ's instruction to decide overnight. Copying mock HTML/JS would replace real state; a new app/shell router or data rewrite would exceed scope.

New styles are opt-in under `.ui-redesign-shell` on `Layout`. Shared primitives keep their legacy default styling outside this ancestor. Any opt-in dialog styling/focus enhancements must likewise not change Production's shared `Modal` usage. Leave global body/reset, Tailwind's existing colour scales and the `.dark` convention intact. New token definitions alone must not restyle station markup.

### Shell and theme contract

- Translate `wf.css` tokens into prefixed semantic CSS variables and additive Tailwind colours. Core light/dark pairs: page `#fbfbfa / #121212`, panel `#ffffff / #1c1c1c`, sidebar `#f7f7f5 / #161616`, divider `#e9e9e7 / #2e2e2e`, text `#37352f / #ededed`, muted `#64635f / #a1a1a1`, faint `#73726e / #8a8a8a`, accent `#3ecf8e`, accent text `#157a53 / #3ecf8e`. Copy the remaining fill, hover, status, scrim and shadow values from `wf.css`; omit annotation-only colours/styles.
- Default shell typography uses the wireframe system sans stack at 14px; headings/spacing follow the drawings, generally 32px main titles, 6px controls, 8px cards, 1180px content width. Preserve wider dense pages where needed. Do not globally shrink production text or interactive targets. Use 44px touch targets on mobile where practical, visible focus, and AA contrast rather than assuming every token combination is accessible.
- Desktop sidebar is 240px expanded and 56px collapsed. Remember collapse with the existing store action. Icons and truncated custom labels have names and keyboard/hover tooltips. Active link has `aria-current="page"`. No fake count badges.
- Groups and order: unlabelled Home/Dashboard; **Inventory**: SKUs, Warehouse, Movements, Paper usage; **Planning**: Sales entry, Demand events, Shopping list, Shipments; **Customer service**: CS cases, Returns, Order submission; **Insights**: Reports; **Workspace**: Team, Settings. Filter by existing effective access before hiding empty headings. Preserve `navLabel` and exact route strings, including `/production`.
- Below **768px**, replace the desktop rail with a labelled hamburger opening an expanded modal drawer. Trap focus, Escape/backdrop close, restore trigger focus, close on successful navigation, prevent background interaction/scroll, and reset drawer state on desktop resize without changing saved desktop collapse.
- Topbar retains Framed/Unframed and Base/+15%/-15%/saved scenarios, alerts detection/unread/mark-read/mark-all-read and sign-out. Add explicit System/Light/Dark choices using existing store values. Resolve system theme on mount and OS preference change while the shell is mounted. Keep controls usable by wrapping or a labelled mobile overflow panel.
- Relocate location selection to the topbar; retain the same location options, `setLocation(next)` and full reload on an actual change. Do not change membership/permission policy. Show real backend **Supabase / Local** using `getBackendMode()`, and a non-production environment badge. A display-only `VITE_APP_ENV=preview|production|development` may identify Preview; never derive an environment claim from a project secret. Local dev can fall back to `import.meta.env.DEV`; an unlabelled built deployment must not be asserted to be staging. Hide the env badge in production. No “synced” claim.
- First keyboard target is a skip link to the focusable main content. Palette remains a labelled modal dialog with focus restoration, arrows/Enter/Escape and existing slash behavior (slash must not steal input, textarea, select or contenteditable typing).

### Wireframe capability disposition (exhaustive for marked New and known implied changes)

“In” below permits UI presentation/navigation only; it never grants new write authority. Keep existing controls that the drawings omit.

| Wireframe item | In / out for this release |
| --- | --- |
| Sales **Week** view (New), editable transposed grid | **Out**, including read-only alternate Week view for this release. Keep the current weeks × SKUs Grid and paste workflow. |
| Sales review/save-week bar, Undo/reversing toast, one-click write Retry | **Out**. A non-mutating pending/error indicator may observe the current operations; never invent a successful all-saved claim if adjustment and upsert outcomes are not both known. |
| Shipment **Timeline** (New) | **Out**. Retain and restyle existing board, list and calendar. |
| Shipment drag/status transitions | **In only for the already-existing drop handler and form**. Add confirmation before existing stock-affecting transitions; no new quick-transition button, new status or additional mutation. |
| Demand-event **Timeline** (New), bar drag/resize | **Out**. Restyle existing year/calendar strip, list and form; no new date mutation pathway. |
| Event what-if impact/extra-unit/stockout simulation | **Out**; no alternate forecast computation. Keep currently computed displays. |
| Movements searchable SKU picker (New) | **In** as local filtering of already loaded products feeding the same `productId` state and submit handler. No remote search, new SKU creation or default selection. |
| Palette “New CS case”, “Log movement” and other actions (New), command navigation rows | **Out**. Search categories, matching, ordering, 30-hit cap and destinations remain as implemented. Home quick links may navigate to existing permitted routes, not perform an action. |
| One PO/draft per supplier | **Out**. Presentation can group lines by supplier, but the current one-per-line write loop and Ordered status remain. No newly scoped per-supplier create buttons. |
| Threaded CS comments (New) | **Out**. Existing notes field only. |
| One-step team invitation | **Out**. Existing two-step UID flow only. |
| SKU side peek and “Open as page” | **In**, read-only projection of selected loaded SKU, with existing `/skus/:id` link. On-hand read-only in the peek. “Adjust” may navigate to existing `/movements` only when allowed, with no invented route/query prefill; existing inline/full-page editors remain. BOM editing stays in its existing component/path. |
| SKU grouped/gallery/saved views, new inline create row and lazy extra fetches | **Out** as new capabilities. Restyle current filters, inline/bulk edits, creation, reorder, imports, exports and forecast/detail displays. A reorder handle continues only the current SKU reorder handler. |
| Dashboard saved views, new chart-type menus, new charts/metrics | **Out**. Restyle existing figures/charts/filters and order builder. Stock value is an owner-gated link/tab to existing `/stock-value`. |
| Dashboard Stock chart tab | **Out**: `StockChart.tsx` is empty and has no route. Do not resurrect it or move inventory data into Reports. |
| Home attention callout and expanded activity/role-specific counters | **Out** as new data surfaces. Keep current staff-safe Welcome cards and scanner-health component; retain real alerts in the bell. No new stock/money/customer content on Home. |
| CS “My cases” and new inline shipped/query shortcuts | **Out** if not current controls; no new filters or writes. Existing board/list/report views, edit form, urgency, issue types and notes remain. |
| Returns quick-log, refund flags and per-line restock | **In** by restyling existing controls and unchanged handlers only. No inline table switch that saves earlier than the existing form, new restock logic or synthetic “restocked” success. |
| Paper separate save-only/deduct modes and Trend report | **Out**. Keep the actual save/reverse/reapply/delete behavior and all A0–A4 inputs. Existing editor/snapshots may be presented as sections without remounting form state. |
| Warehouse row/column/type bay map | **In** as read-only current `storage.bays`/assignment presentation; type floor/rack/cold and per-bay max pallets. No bay placement/assignment writes. Empty bays link to existing Settings when allowed. |
| Warehouse whole-page future-week simulation | **Out** where new: retain the existing scrubber's projection inputs/targets, never invent future per-bay occupancy or replace stock-derived fullness with assignment counts. |
| Reports named URLs, new issue/refund/paper reports and globalised filters | **Out**. Use in-page section navigation without route changes; keep each existing report's filters, request boundaries, permissions and export semantics. |
| Team per-member access/rate views | **In** as presentation of current controls, preserving role defaults, overrides, locked non-owner Dashboard, owner gates, departments, barcodes and lanyard operations. |
| Settings secondary navigation and Danger zone | **In** as anchors to all current sections; existing confirmation/action/saving semantics remain. **Out**: new per-section Save buttons, new toggles or settings suggested only by the drawing. |
| Share/favourite, placeholder menus, mock counts, fake “live/synced”, role-preview and State controls, annotation pins/notes | **Out**. Do not ship `wf.js`, `icons.js` DOM injection or sample data. Use imported Lucide icons. |

### Page coverage

| Reference | React coverage and preserved content |
| --- | --- |
| `welcome.html` | `Welcome.tsx`: current work-type totals, reporting coverage/status, trends, currently-clocked-in and scanner health. |
| `dashboard.html` | `Dashboard.tsx`, `StockValue.tsx`: owner data, filters, existing charts/cards, ordering, invoices, backup and activity. |
| `skus.html` | `Skus.tsx`, `SkuDetail.tsx`, `SkuSettingsCard`, `CompareModal`, `OrderBuilderModal`: catalogue, all current editors, BOM and history. |
| `sales-entry.html` | `SalesEntry.tsx`, `ShopifyImportModal`, `CsvColumnMapper`: existing grid, reference weeks, totals, usage, imports, exports, paste, moves and deletion. |
| `shipments.html` / `shopping-list.html` | `Shipments.tsx` / `ShoppingList.tsx`: existing PO/accounts/attachment/status/archive flows and purchase recommendations. |
| `demand-events.html` / `warehouse.html` | `Events.tsx` / `Warehouse.tsx`: existing forecast events, storage/stock utilisation, projections and stockout schedule. |
| `movements.html` / `paper-usage.html` | `Movements.tsx` / `PaperUsage.tsx`: original reason presets, reversal eligibility, signs, roll calculations, snapshots and mappings. |
| `cs-cases.html` / `returns.html` | `CsCases.tsx` / `CsReturns.tsx`: real enums, filters, reporting, lookup, notes, replacement/restock lines and all current transitions. |
| `reports.html` | `Reports.tsx` and current report cards: production, coverage, staff, timing, order lookup/timeline/flow, completions, packaging, timesheets and exports. Preserve newer bulk-release features. |
| `team.html` / `settings.html` | `Team.tsx`, `TeamMembersCard`, `DepartmentsCard` / `Settings.tsx` and configuration cards: retain every current section, including those absent from mocks. |

`index.html` is an overview, not a new app route. The directory includes `demand-events.html` as well as the other page drawings; do not drop it because the chat described “15 page files.”

## User stories / flows

- As an authorised user, I find my existing pages in grouped navigation, including on a phone, and can still follow bookmarked URLs. A customised nav label never changes its permission key or destination.
- As an owner/manager, I change department/scenario/location using the same operations and see the same results; location changes still clear in-memory state through reload.
- As a sales operator, I edit or paste into the existing grid and retain the same save timing and ledger effects. Switching visual sections never submits a form.
- As a stock operator, I review the affected quantities before an existing explicit stock action, cancel with no writes, or confirm to invoke the original operation once. A dialog is not a promise of transactionality or concurrency safety.
- As staff/CS/kiosk, I receive exactly the effective access and data scope already implemented; stock/financial Home additions and wireframe role previews never appear.
- As a keyboard/screen-reader user, I skip chrome, identify fields and actions, open/close drawers/dialogs and hear loading/error state without losing focus or an entered draft.

## Acceptance criteria

- [ ] Only allowed presentation files and pure presentation-helper tests change. Repository/auth/domain/API/migration/route/package code has no diff; all current action payloads and handlers are preserved except pre-action confirmation and non-mutating UI feedback.
- [ ] All page rows above match the approved hierarchy and applicable tokens in light/dark/system; no mock controls/data or deferred capabilities appear.
- [ ] Desktop expanded/collapsed and 375px, 767px, 768px layouts work; tables/boards scroll within their regions, overlays become full-screen sheets on mobile, no inaccessible offscreen actions or page-wide overflow.
- [ ] System theme responds to OS changes; explicit light/dark ignores them; existing local preference keys/values survive reload. Production/station markup, style and scan focus remain unchanged, including shared modal/card consumers.
- [ ] Navigation sets equal `effectiveNavAccess`/`allNavAccess` on the baseline; custom labels, empty groups, overrides and owner-only Dashboard are correct. Existing route guards and direct-URL behavior remain intact.
- [ ] Shell retains all current controls; backend/env text is truthful; changing location reloads once and never displays the old location's data as the new location's results.
- [ ] Palette matching/results/destinations and hotkeys match baseline; no actions; focus stays in the dialog, Escape closes and focus returns.
- [ ] Each page handles loading-to-data, loading-to-empty and read-error-to-retry without hook-order errors, phantom zeros or discarded drafts. Retry only invokes the existing read refresh/refetch, never replays a write.
- [ ] Keyboard navigation, labelled icon buttons, semantic tables/headers, visible focus, `aria-current`, dialog names/focus containment/restoration and reduced motion pass manual checks. Small text meets 4.5:1 contrast and controls/focus indicators 3:1 in both themes.
- [ ] Existing shipment delivery/reversal, paper save/delete, movement/reversal and case/return stock actions preserve/gain quantity confirmation where applicable. Cancel makes zero calls; confirm invokes the original sequence once. Display requested/planned changes honestly, not a guaranteed final balance when clamping/BOM/concurrent updates affect it. No confirm on each sales blur or station scan.
- [ ] Before/after staging fixtures show identical persisted outcomes/ledger signs and call cardinality for each existing write; pre-existing failures are reported, not silently fixed or called passing. Shopping-list fixtures retain one `Ordered` record per line.
- [ ] `npx tsc -b`, `npm run test -- --run`, `npm run build` pass after every task; final PR CI including API checks passes. Staging evidence and reviewer approval exist before production release.

## Data and backend impact

- Tables / migrations needed: **none**; no SQL is applied by this work.
- Repository interface changes (both Dexie and Supabase): **none**. Existing backend limitations remain. Test repository-backed flows in Dexie and inka-staging-2; retain current Supabase-only notices for production/report/team capabilities.
- `api/` endpoints touched: **none**. No new request, notification, subscription, RPC or cron.
- RLS / role access: **unchanged**, including internal owner/manager/staff gates and `allowed_nav` semantics. Sidebar grouping consumes access results; it is not another authorization implementation.
- State: retain current store persistence; only ephemeral UI state such as drawer, selected peek and local picker query is new. Public environment label is display-only, contains no secrets, and does not select a database.

## Staging test plan

Use a Vercel Preview built from the implementation branch with **inka-staging-2**, never production. CJ verifies both frontend and server Supabase variables point to that project's URL/keys before login or writes; don't copy secrets into evidence. Set Preview's public environment label to `preview`. Use fake SKUs/orders, separate users for all five roles, an empty location, and fixture data for AU/UK/US. Integrations use already-approved staging/test credentials; no real messages or customer writes. Local runs use Dexie or this staging project only.

1. Record baseline and candidate commit/deployment, backend, role/nav sets, fixture IDs, stock/ledger and screenshot values. Run the three commands and current CI checks. Capture evidence in the plan log/review handoff, without secrets or raw customer data.
2. **Owner:** all default pages; override array still retains Welcome/Settings. Dashboard and Stock Value available. Exercise supplier/account/invoice display, team UID two-step flow, nav label rename/reset and all Settings sections. Existing packaging/timing/departments controls still available. Destructive backup/import/wipe tests only in disposable staging fixtures, using existing confirmations.
3. **Manager:** all default pages except Dashboard/Stock Value. Direct visits to those routes remain denied. Existing report/operational access works; owner-only account/team/settings subcontrols are still hidden/denied. Check both default and explicit `allowed_nav`.
4. **Staff:** default Welcome and own Reports with the existing server scope; no other-person or money data added. Grant an operational nav override with an authorised staging owner and confirm existing write permissions still govern it. Attempted Dashboard override remains ineffective. Empty override still gives Welcome.
5. **Kiosk:** default Welcome + `/production`; no added inventory/settings access. Clock in/out, badge/scan/verify/complete/dispatch and station binding/keyboard focus/offline indicators behave exactly as baseline. Shared modal appearance, artwork, packaging and confirmations do not change. Run the existing smoke-test order deduction/retry checks.
6. **CS:** default Welcome + cases/returns. Shopify lookup, existing case notes and return lines, urgency/status/refund flags, quick-arrival and save/delete workflows work. No stock/money Home cards or new invite/admin controls. Explicit overrides follow the existing function.
7. For every role, compare sidebar/drawer, direct URLs, palette destinations and existing permission denial in desktop/mobile; no extra authority through links. Check long custom labels, keyboard tooltips, empty groups, sign-out/re-login, existing shared preference semantics and AU→UK→US reload isolation.
8. All page families: desktop 1440px; mobile 375px/767px and boundary 768px; each theme and OS theme change; empty dataset, initial slow load, failed read, refetch and background error while a form is dirty. Use browser throttling/offline against staging, then restore; do not add application mock switches. Verify accessible names, skip link, focus trap/restore, Escape, table scrolling and reduced-motion setting with a screen reader/keyboard.
9. Write parity on disposable fixtures: sales blank/delete/zero/invalid/change, both departments, auto-adjust on/off, reference weeks, Notion paste, CSV/Shopify import; shopping list two lines from one supplier still produces two Ordered shipments; shipment delivered and leaving delivered with auto-apply on/off, both existing drag and form paths; mapped/unmapped paper save, re-save, changed mapping and delete; movement in/out/reversal/reversal eligibility; replacement and return edits/transitions/delete. Compare payloads, totals and ledger to the baseline. Cancel every new confirmation first and verify zero write requests. Double activation/pending controls and two-session tests must introduce no new duplicate calls; do not assert that legacy partial writes are atomic.
10. Reports/Welcome: compare exact existing counts, coverage/unpublished/stale/error labels, site's production-day boundaries, attribution/manual/inferred labels, filter scopes and export content. Test data over a two-year range and each site using staging fixtures and existing capped/paged readers; no new N+1 calls or fetches from visual tabs. Keep independent date filters independent.
11. Run the full `docs/RELEASING.md` smoke test: all roles, production event and inventory once-on-retry checks, Shopify lookup, Shipments/CS save, Dashboard/Reports and browser console. Highest risks: protected screens through shared CSS, lost focus/blur saves, altered mutation counts, hidden controls, published-report remounts, cross-location cache display and mobile drawer accessibility.

If staging credentials, expected fixtures or an external service are unavailable, record that exact missing check; local builds alone do not satisfy staging. Any legacy inventory discrepancy blocks that affected acceptance claim and is escalated for separate authorised work, never repaired by changing this redesign's scope.

## Hardening

Every bullet in `docs/HARDENING.md` is answered below.

| Item | Answer |
| --- | --- |
| 1.1 Network/Supabase/Shopify/Dropbox/Slack/Make down or slow | Use existing query/local loader errors, pending indicators and existing recovery; retain drafts, don't show failures as empty/zero. Shopify/Dropbox integrations keep their existing errors/placeholders. Slack/Make unchanged and not newly called. No new offline queue or data-loss guarantee. |
| 1.2 Retry/idempotency | Read Retry refetches only. Existing write keys, ordering and retry policies remain; no generic retry/Undo or duplicate submit listener. Confirmation invokes the existing handler once. Existing non-atomic paths remain a recorded risk. |
| 1.3 Concurrent people/devices | No new lock or merge rule. Compare same-fixture two-session effects against baseline; confirmations describe planned changes, not a lock on balances. No added duplicate requests. |
| 1.4 Bad input | Keep all existing parsing/schema/field validation, unknown SKU and missing-data handling. Barcode/malformed scan/cancelled or wrong-site order processing stays in protected production/existing lookup code. No placeholder default IDs or new selection defaults. |
| 1.5 Failure/recovery | Visible existing error, retained form/draft, read refresh where supplied, clear existing backend notice. Never automatically retry stock writes. Partial-save outcomes remain visible for reconciliation through current operational tools. |
| 2.1 Attribution | No worker/department fields or attribution paths change. Framed/Unframed sales selection remains distinct from the four fixed production work types and managed departments. |
| 2.2 Shared counts | Keep current shared reducers/published readers and all existing orders/items/sets values. No UI recomputation from mock charts. |
| 2.3 History | No historical rewrites, schema edits or changed settings payloads; section navigation does not reset editors. |
| 2.4 UTC/site time | Persist existing UTC/date-only values and use existing site-aware production formatting; preserve separate browser-day widgets where currently implemented. No timezone “cleanup” in this feature. Verify AU/UK/US values against baseline. |
| 2.5 Inferred/manual | Preserve method, inferred/manual, missing coverage, stale and unpublished indicators; don't relabel approximations as measured/live. |
| 3.1 Endpoint auth/input | N/a: no new/changed endpoint. Existing authenticated clients, validation and server checks unchanged. |
| 3.2 Tables/RLS | N/a: no new/changed tables/policies/grants. All five role and override tests remain required for presentation parity. |
| 3.3 Secrets | Server secrets stay in existing `process.env` configuration, never source/logs/browser. Only existing public client values and a nonsecret env label are used; no key/URL diagnostics in badges. |
| 3.4 Cost/spam/exposure | No new sends/API calls/per-item fetches; don't mount duplicate fetchers in hidden panes or expose owner data via new Home/Reports surfaces. Existing route/internal gates retained. |
| 4.1 Expand-only/old app | N/a: zero migrations; old app uses the exact same schema/data contracts. |
| 4.2 Off switch/shop floor | No new business behavior or rollout flag. Station is outside styling scope. If shell/shared regression affects work, CJ performs Instant Rollback to the post-bulk pre-redesign deployment. |
| 4.3 Release sequence | Complete/release bulk work first; validate Preview→inka-staging-2 and display label; green CI/review/staging; CJ records post-bulk rollback target and merges separately at a quiet time. No SQL or Shopify/Dropbox/Slack/Make settings change. |
| 4.4 Role staging | Owner/manager/staff/kiosk/cs plus overrides and direct URLs, as detailed above; both backend paths and all sites. |
| 5.1 Months of events | No query/index/aggregation changes. Preserve existing summary/paging boundaries, limits and lazy readers; UI section navigation must not expand the requested range. |
| 5.2 External API per item | None added. Keep existing lookup/artwork caching and batch behavior; no gallery fetching. |
| 5.3 Two years/three sites | Use existing loading/paging/calculation paths; local filtering only over loaded data. Compare long-range rendering and request counts to baseline on three sites. No claim to fix old caps. |
| 6.1 Detect production faults | Existing visible read/write errors, report/scanner health indicators, browser errors, Vercel logs and staff smoke feedback. No new monitoring infrastructure. |
| 6.2 Manual fallback | Existing standalone `/production` remains available; CJ can restore the previous post-bulk deployment via Instant Rollback if shell/shared styles break work. Reconcile uncertain existing writes using ledger/current tools, not repeat submissions blindly. |
| 6.3 Maintenance | No new storage, subscriptions, expiring tokens or integrations. Maintain semantic tokens and role/mobile checks; keep Preview's public environment label accurate. |
| 7.1 Pure-logic tests | Add tests only for new presentation helpers: theme resolution, nav grouping/filtering, env badge, SKU picker matching and optional quantity-message formatting. Include empty/unknown/long-input cases. No DOM snapshot suite/dependency. |
| 7.2 Inventory/credit/money | Business behavior must not change. Keep existing money/inventory suites green and prove original write sequences/ledger outcomes through before/after staging tests. Pure formatting tests cover confirmation summaries; no duplicate inventory engine in tests or UI. A required arithmetic fix needs its own approved scope/tests. |

## Roadmap decisions honoured

There is no `ui-redesign` F-number in ROADMAP.md. CJ's 2026-11-24 approval is the additional brief; do not edit the roadmap or describe another F-number as this redesign.

- Cross-cutting 1: staging first, separate post-bulk release, immediate rollback with unchanged schema.
- Cross-cutting 2–5: keep departments/work types and per-scanner identity separate; one receiving-device architecture, scan validation/queue/credit remain untouched.
- Cross-cutting 6–7: Make/Slack/Shopify reporting cannot acquire a new dependency on UI rendering; historical event facts remain unchanged.
- S1 and F1–F12 decisions remain owned by their existing features: preserve digest authentication, shared item counting, station order display/artwork/packaging, departments/scanners/dispatch, reports/timing/order timeline/milestones/print evidence. Do not roll back these features while adopting older drawings. F2/station redesign is specifically outside this task.
- Do not change Make Part 4 `planned_at` or any integration configuration. Max's outstanding box rules are not a UI-redesign decision.

## Risks and open questions

- CJ confirms the five section-4 defaults. In particular, **Create draft shipments** conflicts with existing **Ordered** writes. Preserve payloads and show the actual status; a future status change is not authorised here.
- Wireframes contain unmarked behavioral ideas too. The disposition table is binding; if another cannot map to an existing control/read-only presentation, stop and record it in the plan's Open questions instead of implementing it.
- Current code supersedes the 2026-11-11 architecture snapshot: do not treat its old role/reporting bugs or migration list as today's implementation. Compare staged baseline evidence; no unrelated fixes.
- Shared CSS/primitives and report-panel remounting are the largest regression risks. Scope styles and preserve mounted state/fetch ownership; test protected station consumers after each foundational task.
- Some legacy writes span multiple requests. This redesign must not promise exactly-once behavior, atomic saves or a safe retry it has not implemented. Stock confirmations describe the actual existing path; discrepancies go to CJ.
- The approved design does not authorise a new query just to fill a blank chart/field. Omit unsupported content instead of fabricated metrics. Do not hide real current configuration/reporting panels to match the mock.
- Preview handoff requires CJ's release mechanism under AGENTS.md; this documentation-only task does not publish. Production release and any SQL remain exclusively CJ's steps. Plan approval is tracked separately from the recorded wireframe approval.
