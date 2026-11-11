# Inka Arthouse Hub architecture

Source baseline: `4cbddc90092ad7b6683dd5f6fd428d072eb10de7`, reviewed on 2026-11-11.

This is a map of the recovered application in this repository, not a specification of a future redesign or a certification of the deployed system. It covers the tracked frontend, shared modules, server handlers, SQL migrations, configuration, and tests. Installed dependencies and generated output are not application source. No production database or external integration was contacted during onboarding. Database statements below describe the checked-in migrations; reconcile those with the deployed schema before planning a migration, especially because `0027` is absent.

The planner/reviewer owns architecture, specs, plans, and reviews. The coder owns implementation. Follow [AGENTS.md](../AGENTS.md), [WORKFLOW.md](WORKFLOW.md), and [RELEASING.md](RELEASING.md) for handoffs and releases. The barcode attribution redesign and PrintQueue/custom-print integration mentioned in the README are planned work, not implemented architecture.

## 1. Runtime and source map

This is a React 18 single-page application written in strict TypeScript, built with Vite 5 and styled with Tailwind 3. React Router selects screens; TanStack Query caches repository reads; Zustand persists UI preferences. Zod defines domain shapes and validates many form/import boundaries. Recharts supplies charts, SheetJS supplies spreadsheets, and jsPDF supplies PDF exports.

`src/main.tsx` mounts `App` in React StrictMode. `src/App.tsx` composes:

```text
QueryClientProvider
  MaybeAuthGated
    Supabase mode: AuthProvider -> AuthGate
    Dexie mode: no authentication wrapper
      RepositoryProvider (backend + active location)
        BrowserRouter
          /production -> NavGate -> standalone tablet screen
          other routes -> Layout -> Sidebar + Topbar + Outlet + CommandPalette
```

`vercel.json` rewrites non-API paths to `index.html` and schedules three daily digest calls. Files under `api/` are Vercel serverless handlers, not part of the Vite development server. `vite.config.ts` sets the `@` alias to `src`; it has no API proxy. Local integrations therefore need an appropriate Vercel development setup. There is no separate long-running application server in this repository.

| Path | Responsibility |
| --- | --- |
| `src/pages/` | Screen composition, substantial business logic, forms, exports, and some direct Supabase queries. |
| `src/components/layout/` | Navigation, location selection, scenario controls, alerts, theme, and page shell. |
| `src/components/ui/` | Small reusable button, card, field/input/select, modal, and status-pill primitives. |
| `src/components/` | Shared feature cards, import/order dialogs, auth gate, and command palette. |
| `src/lib/domain/` | Zod models, SKU classification/routing, payment terms, and shift calculations. |
| `src/lib/hooks/` | Repository-backed queries, mutations, and memoized forecasts. |
| `src/lib/repository/` | Shared contract and provider; IndexedDB and PostgREST adapters. |
| `src/lib/auth/` | Session/profile state and page-access calculation. |
| `src/lib/state/` | Persisted app preferences and tablet station configuration. |
| `src/lib/forecasting/` | Pure weekly-demand and 52-week stock projection calculations. |
| `src/lib/csv/` | CSV parsing/export, Shopify report parsing, and XLSX export. |
| `src/lib/utils/` | Date/number formatting, class names, and barcode/lanyard generation. |
| `src/lib/alerts/` | Forecast-derived alert detection; email/webhook functions are logging stubs. |
| `src/lib/seed/` | Deterministic sample backup generation and loading through the repository. |
| `api/` | Shopify lookup/install diagnostics, Dropbox artwork retrieval, and emailed KPI digest. |
| `supabase/migrations/` | Recovered DDL, RLS, RPC, trigger, and grant history. |
| `public/` | Tracked Inka Arthouse logo used by UI/exports. |
| `.github/workflows/ci.yml` | Type-check, tests, build, and append-only migration check. |

`package.json` also lists `@anthropic-ai/sdk`; the tracked application does not currently have an AI workflow using it.

## 2. Screens and navigation

These are the actual routes in `App.tsx`. Names displayed in the sidebar can be overridden by location settings; the permission keys remain stable. Most inventory screens use the repository-backed dataset. Production-related screens additionally or exclusively use Supabase directly.

| Route / source under `src/pages/` | Nav key | What it does |
| --- | --- | --- |
| `/` — `Welcome.tsx` | `welcome` | Operational landing page: yesterday/today throughput, department leaders, improvement/streak summaries, trend chart, and currently clocked-in workers. Queries production events and barcode names directly. |
| `/dashboard` — `Dashboard.tsx` | `dashboard` | Stock and value totals, forecast risks, fastest movers, upcoming shipments, backup reminder/export, outstanding supplier invoices, activity and labour cards. Owner-only page in authenticated mode. |
| `/stock-value` — `StockValue.tsx` | `dashboard` | Filterable/sortable on-hand × unit-cost breakdown, including zero-stock catalogue rows; excludes incoming shipments. |
| `/skus` — `Skus.tsx` | `skus` | Catalogue table with forecast indicators, filters, inline/bulk editing, ordering, CSV import/export, new products, and multi-location creation. |
| `/skus/:id` — `SkuDetail.tsx` | `skus` | SKU properties, scenario/forecast chart and rows, recent sales, bill-of-materials recipe editor, and inventory history. |
| `/sales` — `SalesEntry.tsx` | `sales` | Department-specific weekly spreadsheet, reference weeks, totals and summary statistics, bulk usage, CSV/Shopify imports, Notion-table paste, date moves and deletion. Inventory adjustments are coordinated by callers as well as the repository. |
| `/shipments` — `Shipments.tsx` | `shipments` | Multi-line supplier POs in kanban/list/calendar views; status changes, archive, delivery, CSV/XLSX/PDF output, and order builder. Owner-only accounting, payment terms, and invoice attachments use direct Supabase queries/storage. |
| `/events` — `Events.tsx` | `events` | Demand multipliers over dates for one SKU or a wildcard with size/colour filters; calendar and event editor. These are forecast events, not production events. |
| `/warehouse` — `Warehouse.tsx` | `warehouse` | Current and projected pallet utilisation, per-SKU capacity breakdown, arrivals and stockout heatmap with a week scrubber. Current fullness derives from stock/pallet capacity, not the count of saved pallet assignments. |
| `/orders` — `ShoppingList.tsx` | `orders` | Forecast-generated purchase recommendations grouped by supplier, export, and conversion into incoming shipments/POs. This is procurement, not the Shopify customer-order queue. |
| `/paper` — `PaperUsage.tsx` | `paper` | A0–A4 print counts, 24-inch/42-inch roll calculations and buffer, saved weekly snapshots, and mapped paper-roll deductions/reversals. Counts can come from both framed and unframed sales. |
| `/movements` — `Movements.tsx` | `movements` | Samples, breakage, internal use, stocktake, transfers and other adjustments; ledger feed and compensating reversals. A transfer is one local leg; the receiving location must be handled separately. |
| `/cs-cases` — `CsCases.tsx` | `cs_cases` | Replacement/complaint workflow: new, query, shipped, closed, denied; kanban/list/report views, urgency and carrier analysis, Shopify lookup, and catalogue replacement lines. Finished-case display uses a Sydney-day archive rule. |
| `/returns` — `CsReturns.tsx` | `cs_returns` | Inbound returns in kanban/list views, quick arrivals, overdue/inspection/refund buckets, Shopify lookup, per-line restock flag, and received/RTS/closed status. See inventory-sign concerns below. |
| `/production` — `Production.tsx` | `order_submission` | Standalone scanner/tablet interface: station binding, worker barcode identification, clock events, Shopify order loading, verification, completion/dispatch, packaging, replacement context and notes. Explicitly requires Supabase. |
| `/reports` — `Reports.tsx` | `reports` | Production date/staff/department filters, output and leaderboards, variant timing, order history and cancellation, daily productivity, package usage/history, timesheet export and completion feed. Requires Supabase data. |
| `/team` — `Team.tsx` | `team` | Team administration card plus printable lanyards and JPEG ZIP export. Admin card is owner-gated; barcode operations use Supabase. |
| `/settings` — `Settings.tsx` | `settings` | Location/global defaults, warehouse capacity, paper-roll mapping, nav labels, backup/import, sample data/wipe, cleanup, carton presets, production benchmarks, supplier terms, Dexie migration and cross-location diagnostics. |

`StockChart.tsx` is a retired empty module, not a route. Forecast columns moved to SKUs and the heatmap to Warehouse. There is no catch-all route in `App.tsx`.

### Shared feature components

- `OrderBuilderModal`: forecast prefill, supplier selection, MOQ/increment rounding, target cover and optional backorder coverage, carton/CBM/container calculations, saved templates, exports, and shipment creation/editing.
- `ShopifyImportModal` and `CsvColumnMapper`: review/match imported rows before writing weekly data. `lib/csv/shopifyReport.ts` handles Shopify CSV shapes, variant size/colour, set multipliers and SKU-based matching; this is distinct from live order lookup.
- `SkuSettingsCard` and `CompareModal`: per-SKU settings and forecast comparisons.
- `OrderNotesPanel`: direct `order_notes` reads/inserts/resolution for an order/location. `ProductImage`: authenticated artwork lookup with a sessionStorage URL/missing-image cache.
- `CurrentlyClockedInCard`: polls clock events every 30 seconds. `LabourHoursTodayCard`: refreshes labour/cost data every 60 seconds. `DailyTimesheetCard`: shift-level CSV/XLSX export using `computeShifts`.
- `LiveOrderCompletionsCard`: a manually refreshed, last-seven-days snapshot capped at 500 events despite its name. `RecentActivityCard`: production, ledger and account-related summaries.
- `PackageUsageCard` and `PackageHistoryCard`: ledger-derived packaging totals/costs, usage ratios and procurement context, with paged reads.
- `ProductionBenchmarksCard`: edits size effort and estimated time targets. `SupplierPaymentTermsCard`: owner-only supplier defaults. `TeamMembersCard`: profiles, grants, navigation overrides, rates, and barcodes.
- `CommandPalette`: shared catalogue/supplier/navigation search. `Topbar`: scenario selector and forecast alert state. Email/webhook alert delivery is not implemented by `notifier.ts`; the separate daily digest does send email.

## 3. Data flow and state boundaries

### Repository-backed path

```text
Page / shared component
  useDataset / useCsCases / useCsReturns / useLedger
    TanStack Query cache (location in key)
      useRepo -> RepositoryProvider
        DexieRepo -> location-specific IndexedDB
        SupabaseRepo -> location-filtered PostgREST / SQL RPC

Page action -> useMutations -> repository write
  -> invalidate dataset + ledger + cs-cases + cs-returns prefixes
  -> queries refetch -> forecasts/UI recompute
```

`Repository.ts` defines products, weekly sales/entries, incoming shipments, demand events, warehouse storage, settings, backup/wipe, paper snapshots, ledger, CS cases and returns. `RepositoryProvider` constructs a repository when location changes; `VITE_BACKEND=supabase` selects Postgres, otherwise Dexie. It supports an injected repository prop, but current tests do not use this to exercise repository behavior.

`useDataset` fetches eight resources concurrently: products, sales, weekly entries, shipments, demand events, storage, settings and paper usage. Its key is `["dataset", location]`. Query defaults use a five-second stale time and refetch on focus. CS cases/returns have separate location keys and 15-second stale times; ledger queries include location, product and limit and use ten seconds. Mutation invalidation explicitly covers all four prefixes; a dataset invalidation alone does not match a ledger key.

`useForecasts` is a memoized computation over the dataset and scenario; forecasts are not persisted. `useAppStore` persists location, department, theme, scenario/saved scenarios, sidebar and alert acknowledgement state in `inkaar-app-state`. Those preferences are not per-auth-user records. Production's department/station label is separately stored under `inkaar.production.station`.

Locations are `default`, `uk`, `us`, `au`. In Dexie they correspond to `inkaar-stock`, `inkaar-stock-uk`, `inkaar-stock-us`, `inkaar-stock-au`. In Supabase the repository adds a `location` filter to business-table requests and strips it on reads; database policies independently enforce membership.

The sales department is derived primarily from supplier: `UNFRAMED` means unframed; otherwise framed. This is different from production's four stations (`a0_framed`, `framed`, `unframed`, `dispatch`). Do not interchange those types or assume a single department filter controls every screen.

### Direct Supabase path

Production, Reports, Welcome, team/barcode/rate cards, notes, accounting, invoice storage and artwork cache access do not all pass through `Repository`. Many use component-local `useState`/`useEffect`, manual refresh or polling, so the common query invalidations do not refresh them automatically. The source contains no application-wide realtime subscription layer.

Dexie schema v10 declares five production tables, but the current production and reports screens do not use a Dexie implementation of those workflows. The two backend choices are not feature-equivalent. In particular, `Welcome` and `Reports` call `getSupabase()` before their backend-specific fallback; an unconfigured Dexie session can fail there before reaching the intended fallback.

### Domain calculations

- `schemas.ts` defines stock, sales, shipments, BOM components, settings, CS, production, backup and accounting shapes. Many ordinary Supabase reads are cast rather than parsed through Zod; schema definitions alone do not guarantee runtime validation.
- `forecasting/weeklyAverage.ts` supports trailing 8/12 recorded rows, weighted trailing 8, manual, and selected reference weeks, with a positive manual fallback. Missing calendar weeks are not automatically inserted as zeros. Reference-week selection matches dates across the supplied entries.
- `forecasting/engine.ts` projects 52 weeks, normally beginning next Monday. It compounds overlapping demand multipliers, applies scenario demand, adds eligible arrivals, clamps projected stock at zero, and calculates reorder dates, target cover, MOQ/increment-rounded quantities and unfulfilled demand. Delivered, cancelled, held and back-ordered shipments are excluded from future arrivals. Draft shipments are not excluded by that condition.
- `shifts.ts` groups by worker and browser-local day. Clock-in opens a shift; clock-out closes it. Between-order gaps of at least 30 minutes are deducted; open-order gaps remain paid. Missing clock-outs use a two-hour silence threshold and five-minute buffer. Missing rates default to 30. These inferred hours are distinct from Reports' time-between-verifications metric.
- Payment terms are computed from `order_placed_date`, optionally end of that month, plus days. `paid` and `on_hold` are excluded from overdue status. Shipment overrides sit above supplier defaults.

## 4. Inventory and production workflows

### Inventory signs and transactions

`adjustOnHand(productId, delta)` **subtracts** its argument: positive means consume, negative means credit. Ledger `delta` uses the opposite, natural stock-change convention: outbound negative, inbound positive. Both Dexie and `adjust_on_hand` clamp stock at zero and record the actual change. A no-change parent returns before BOM cascade.

| Operation | Implementation and boundary |
| --- | --- |
| Manual product on-hand edit | Detects drift and records `initial`/`manual` ledger entries. Dexie uses one transaction; Supabase product upsert and ledger insert are separate requests. |
| Generic adjustment | Dexie transaction or SQL `adjust_on_hand` locks/updates stock and writes ledger. Only reason `sale` cascades the BOM, including reversals, with depth limit 8. Client product upserts check cycles. |
| Sales entry/import | `upsertSale`/`bulkUpsertSales` only store rows. `SalesEntry` and `ShopifyImportModal` calculate differences and separately call adjustments when auto-adjust is on. A new caller must not assume an upsert deducts stock. |
| Sales deletion | Single-row/weekly deletion can credit stock back. Bulk deletion aggregates credits when auto-adjust is on; see the cross-department issue below. |
| Shipment delivery | `inventory_applied_at` records whether stock was credited. Supabase uses `apply_shipment_delivery`, `reverse_shipment_delivery`, and `delete_shipment_atomic` from `0014`, locking shipment rows. The whole browser save sequence is still multiple requests. Delivered-to-delivered line edits do not recalculate stock. |
| Paper snapshot | The page reverses the previous recorded roll deduction, applies rounded roll consumption to mapped SKUs, then stores the snapshot. These are separate mutations, not one enclosing transaction. Delete reverses the stored deductions. |
| Replacement case | Deducts only at `shipped` with nonblank tracking; re-edit reverses old lines then reapplies, and delete reverses. Dexie wraps case/lines/stock/ledger; Supabase sequences requests. Moving to `closed` no longer satisfies the deduction predicate and therefore reverses prior deductions. |
| Return | Both adapters attempt per-line restock for `received` or `rts`, track `inventory_credited`, and reverse/reapply on save. Current argument signs conflict with adjustment semantics; this is a finding, not a reliable restocking guarantee. |
| Production completion | A separate direct RPC, `deduct_inventory_for_event`, consumes client-routed catalogue components and packaging. It does not use the generic BOM-cascade path. |

### Scanner and attribution flow

`Production.tsx` separates the authenticated browser account (including a shared kiosk role) from the currently scanned worker. Barcodes map to staff IDs/display names via `staff_barcodes`; events store that worker in `staff_id`, plus location, department and optional station. Clock events have no order number. Authenticated identity and credited worker identity must remain distinct in future attribution work.

```text
Bind tablet station -> scan worker barcode / clock in
  -> scan or enter order number
  -> preflight prior work + replacement cases + Shopify lookup
  -> resolve lines, station relevance, artwork and notes
  -> line_verified events (cancelled + parent_event_id to undo verification)
  -> complete order / dispatch (order-level event, line_sku null)
  -> route components + packages -> deduct_inventory_for_event
  -> clear current order; later clock out
```

The module retains line start/complete/cancel handlers alongside the unified per-order workflow. Non-dispatch completion requires at least one verification. A0 framed and dispatch stations select packaging; unframed can auto-assign a tube. Replacement events tagged with `cs_case_id` skip the production deduction RPC because cases own their inventory movement. Deduction errors are logged after completion is saved; they do not roll back the event.

`skuRouting.ts` parses v6 single prints, sets, picture frames, gift cards, free prints and accessories. It separately answers whether a line belongs to a station, can be verified, contributes KPI items/orders, and should deduct at that station. Those are different decisions:

| Item | Deduction point in `shouldDeductAtDept` |
| --- | --- |
| Framed A1–A4 prints/sets | Dispatch `dispatched`. |
| Framed A0 prints/sets | A0 framed `completed`. |
| Unframed prints/sets and free prints | Unframed `completed`. |
| Picture-frame-only SKU | Dispatch `dispatched`. |
| Accessories | A0 framed completion or dispatch, subject to order-based deduplication. |
| Gift cards, stretched canvas, unparseable SKU | No automatic deduction through this router. |

Catalogue routing maps colour/size to stock codes, multiplies sets, and hardcodes six-piece gallery walls as four A2 plus two A3. Other gallery-wall mixes and canvas need explicit handling. Package codes/barcodes and two mail-tube product IDs are hardcoded in the same module; reports/digest contain related copies.

The final checked-in RPC (`0031`) uses `prod:order_<order_number>:<supplied code>` as the ledger source key within a location, replacing event-level keys from `0025`/`0026`. It accepts either product code or ID. This is an existence check, not a concurrency-safe unique constraint; see risks.

### KPI interpretation

Reports derives item output from uncancelled `line_verified` events and multiplies set quantities. Item eligibility includes framed prints and picture frames; unframed contributes to broader order eligibility, not framed item totals. Timing is the interval between successive eligible verifications by a worker, with positive gaps up to 30 minutes contributing. It is not measured manufacturing duration from start/complete pairs.

Welcome and the daily digest also count order-level completed/dispatched events. Their counting/cancellation rules differ from Reports. The digest sums department order sets, so its combined order total is not necessarily a count of unique customer orders across departments. Timesheets use clock/start/complete events and the separate shift helper.

## 5. Database tables and migration lineage

Most business entities use `(location, id)` keys. Weekly sales use `(location, product_id, iso_week_start)`; current weekly entries use `(location, department, iso_week_start)`. Product components and shipment lines are JSONB rather than relational line tables. Their internal product references need application handling. CS lines have composite foreign keys. Ledger deliberately retains product IDs without a product foreign key so history can survive product removal.

All 28 application tables created by the recovered SQL are listed below. `auth.users` and `storage.objects` belong to Supabase, not this application's DDL.

| Table | Created by | Purpose / important evolution |
| --- | --- | --- |
| `locations` | `0001_init.sql` | Four location keys; business-table FK target. |
| `profiles` | `0001_init.sql` | Auth user display name and role; `0005` adds `allowed_nav`; `0028`/`0032` add kiosk/CS roles. |
| `user_locations` | `0001_init.sql` | User membership keyed by user/location. |
| `products` | `0001_init.sql` | Stock, costs, supplier, forecast defaults, dimensions and JSONB BOM. |
| `weekly_entries` | `0001_init.sql` | Weekly metadata, order totals, reference flag, Shopify size counts; `0010` adds department to PK. |
| `weekly_sales` | `0001_init.sql` | Units per product/week; department follows product classification. |
| `shipments` | `0001_init.sql` | Supplier PO plus JSONB lines and inventory-applied marker; `0011` archive, `0017` delivery metadata, `0020` back-ordered status. |
| `demand_events` | `0001_init.sql` | Forecast multipliers over time. |
| `bays` | `0001_init.sql` | Warehouse layout and pallet capacity. |
| `pallet_assignments` | `0001_init.sql` | Product quantities assigned to bay slots; FKs to products and bays. |
| `settings` | `0001_init.sql` | One row per location; defaults, toggles, nav labels, order templates, container and roll mappings. |
| `paper_usage` | `0001_init.sql` | Weekly print counts and recorded roll/SKU deductions. |
| `ledger` | `0001_init.sql` | Timestamped stock deltas, reason, source and parent linkage; `0004` adds manager deletion; `0006`/`0009` add reasons. |
| `cs_cases` | `0006_cs_cases.sql` | Replacement/customer-service header; `0007` original carrier, `0008` approved→query and timestamp rename. |
| `cs_case_lines` | `0006_cs_cases.sql` | Replacement stock items/quantities; `0023` source Shopify SKU/title. |
| `cs_returns` | `0009_cs_returns.sql` | Return workflow/refund fields; `0015` adds RTS status. |
| `cs_return_lines` | `0009_cs_returns.sql` | Product quantities, restock request and inventory-credit flag. |
| `staff_barcodes` | `0012_production.sql` | Location/barcode key, worker/name, active and revocation fields. Recovered schema references `auth.users`. |
| `staff_rates` | `0012_production.sql` | Hourly rate per location/user. |
| `production_events` | `0012_production.sql` | Worker/station/order/line/event log; `0022` verification, case and parent IDs; `0029` clock events; `0030` nullable order for clock events. |
| `production_size_effort` | `0012_production.sql` | Size weights per location, seeded A0–A4. |
| `production_benchmarks` | `0012_production.sql` | Estimated minutes by location/product/department, source and sample count. |
| `order_notes` | `0016_order_notes.sql` | Staff-authored notes and resolution against order/location. |
| `shipment_status_log` | `0017_shipment_accounts.sql` | Trigger-written status transition audit; globally keyed ID plus shipment composite FK. |
| `shipment_accounts` | `0017_shipment_accounts.sql` | Owner-only one-to-one invoice/payment overlay; `0018` terms days, `0019` EOM flag. |
| `supplier_settings` | `0018_supplier_settings_and_payment_terms.sql` | Owner-only supplier/location terms and currency; `0019` EOM flag. |
| `shipment_invoice_files` | `0021_shipment_invoice_files.sql` | Owner-only attachment metadata, globally keyed ID, shipment FK; bytes in `shipment-invoices` storage bucket. |
| `artwork_images` | `0024_artwork_images_cache.sql` | Shared, non-location cache keyed by artwork code; Dropbox path and expiring URL. |

### Functions, policies, and remaining migrations

- `0001`: location/role helpers, initial RLS, updated-at triggers and seed locations. `0002`: `adjust_on_hand` and recursive `cascade_bom_step`. `0003`: schema/table/function grants and default privileges. `0004` also contains a historical `DELETE FROM ledger WHERE location = 'au'`; never treat replay as harmless setup.
- `0013`: expands production insertion for manager-operated kiosks. `0014`: shipment apply/reverse/delete RPCs. `0017`: delivery metadata and status-log triggers, plus accounts updated metadata. `0018`: supplier-settings update trigger. Delivery/status triggers run on updates, not initial inserts.
- `0021`: owner-only storage object policies for `shipment-invoices`; bucket creation is an external setup step, not an INSERT in this migration.
- `0024`: SECURITY DEFINER artwork-cache upsert/delete RPCs. `0025`: first production deduction RPC. `0026`: allows code-or-ID matching. `0031`: replaces deduction logic with order-level source keys and negative-stock reporting.
- `0028`: kiosk role helper, insert and select policies. `0032`: CS role/helper. `0033`: expands production select to CS. The older `production_events_read` policy from `0012` remains alongside later `production_events_select`; permissive policies combine.
- There are 32 migration files numbered `0001`–`0033`, with no `0027`. The snapshot does not prove what that missing migration did or which manual changes exist in production.

### Dexie model

`dexie/db.ts` evolves the local database through versions 1–10: core inventory, product order, multi-line shipments, parallel weekly-entry tables, paper usage, ledger, cases, returns, department backfill, then production stores. Sales use synthetic `productId__week` IDs. Framed and unframed weekly entries live in separate stores with a date-only key, unlike Postgres' composite key. Global settings use `id="global"` rather than a location column. Barcode/rate/production stores exist locally, but notes, invoice accounting/storage and artwork cache are not represented by the shared repository contract.

## 6. Roles, sessions, and permissions

`AuthProvider` loads the Supabase session, current `profiles` row and `user_locations`, subscribes to auth events, and exposes sign-in/out and password recovery. `AuthGate` blocks unauthenticated users and users without a usable profile/location access. The sidebar limits available locations; SQL membership checks remain the security boundary.

`getSupabase()` normally uses sessionStorage. A `persist` query parameter sets a per-tab marker that selects shared localStorage; `tabSession` clears that marker. These are browser persistence modes, not worker barcode sessions. The client uses `detectSessionInUrl: false` even though the auth UI expects password-recovery events; validate that complete flow in staging before relying on it.

`effectiveNavAccess` determines sidebar links and `NavGate` route access:

| Role | Default page access when `allowed_nav` is null |
| --- | --- |
| Owner | All nav keys. |
| Manager | All except dashboard (which also gates stock value). |
| Staff | Welcome. |
| Kiosk | Welcome and order submission. |
| CS | Welcome, cases and returns. |

An array in `allowed_nav` replaces the defaults, including for owners. Welcome is always added, non-owners always lose dashboard, and owners always retain settings. Dexie returns all nav keys. Route visibility is not a database privilege: granting a page does not grant permission to every write on it, and hiding a page does not prevent direct access to otherwise permitted data.

The checked-in RLS implements these broader rules:

- Core operational tables: location members can read; manager/owner plus location membership can write. Ledger inserts are available to location members, deletes to managers/owners, and no update policy is declared.
- Profiles: self or owner reads; owner inserts/deletes; self update rule tries to preserve role. Membership grants are owner-managed. A manager seeing Team by default does not mean they can administer profiles.
- Cases and returns: read/write policies require location membership, not the `cs` role specifically.
- Production events: members may insert their own events; owner/manager/kiosk can insert for scanned staff. Current select policy admits self or owner/manager/CS/kiosk at the location. Updates/deletes require manager/owner membership.
- Barcodes, size effort and benchmarks: location reads, manager/owner writes. Rates: self or manager/owner reads at a location; manager/owner writes.
- Notes: location reads and updates; insert additionally requires `staff_id = auth.uid()`; deletion requires manager/owner. Passing a scanned worker as author from a shared kiosk can conflict with that insert rule.
- Accounts, supplier settings and invoice metadata: owner plus membership. Storage-object policies check bucket and owner, without the metadata table's location predicate.
- Artwork cache: authenticated reads across locations; mutation RPCs run as definer.

SECURITY DEFINER functions must be reviewed separately from table policies. `adjust_on_hand` and shipment RPCs check location but do not impose the core tables' manager-write requirement. The production deduction RPC has a more serious missing authorization check described below.

Team invitation UI accepts an already-created Auth UID and creates profile/location rows; it does not itself provision or email a Supabase Auth invitation. Some comments and barcode fallback handling refer to barcode-only workers, while `0012` still declares Auth-user FKs: verify actual deployed identity constraints before designing attribution changes.

## 7. API endpoints, external services, and cron

| Endpoint / source under `api/` | Behavior | Access/configuration in source |
| --- | --- | --- |
| `GET /api/shopify/order?order_number=...` — `shopify/order.ts` | Numeric order lookup through GraphQL, then REST fallbacks; returns customer fields, carrier, tags, cancellation state and effective remaining line quantities. | Verifies Supabase bearer token with `getUser`. Uses `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, Supabase URL/anon key. No application role/location check beyond token verification. |
| `GET /api/shopify/install-start?shop=...` | Validates shop domain, creates state cookie, redirects to Shopify authorization. | `SHOPIFY_CLIENT_ID`; no app login guard. Requested scopes: orders, customers, fulfillments, shipping reads. |
| `GET /api/shopify/install-callback` | Validates HMAC and state cookie, exchanges code, displays offline token for operator to save as server configuration. | Client ID/secret. Does not persist token; response is no-store. This is an operational credential setup endpoint. |
| `/api/shopify/whoami` | Reports shop/token-scope diagnostics, including token prefix and length. | Uses configured Shopify token; no auth or method guard in handler. |
| `GET /api/dropbox/artwork-image?sku=...` | Converts SKU to expected filename; uses cached URL, refreshes known path, or searches Dropbox and stores result; drops stale path on 404/409. | Verifies Supabase JWT and forwards it to cache queries/RPCs. `DROPBOX_ACCESS_TOKEN`, `DROPBOX_IMAGE_FOLDER`, Supabase URL/anon key. |
| `/api/reports/daily-digest?location=au\|uk\|us` | Builds today's/yesterday's department and staff KPIs, four-sheet XLSX, and Resend email. Supports `date`, `dry`, `force`, `recipient`, `envcheck`, `rolecheck`. | Uses service-role key if present, otherwise Vite anon key. No auth, method, or cron-secret enforcement in the checked-in handler. |

Both Shopify lookup and diagnostics pin API version `2024-04`. Lookup requests only the first 50 GraphQL line items; its last REST fallback examines one 250-order response, not a full paginated history. Missing old orders or large-order lines require targeted investigation, not an assumption that lookup is exhaustive.

Artwork server URLs are cached for 3.5 hours with a five-minute safety buffer. The browser `ProductImage` cache has no corresponding expiry check; a cached missing result or expired URL can persist for the tab session. Dropbox configuration is shared across locations, as is `artwork_images`.

### Digest schedule

The cron expressions in `vercel.json` are fixed UTC schedules:

| Location | Expression | UTC time | Report timezone |
| --- | --- | --- | --- |
| AU | `55 13 * * *` | 13:55 daily | `Australia/Sydney` |
| UK | `55 22 * * *` | 22:55 daily | `Europe/London` |
| US | `55 4 * * *` | 04:55 daily | `America/Chicago` |

Fixed UTC times shift relative to local time with daylight saving. The handler chooses the prior local date if invoked before 04:00 unless `date` is supplied. It suppresses zero-activity emails unless forced; any truthy `dry` value returns XLSX instead of sending. XLSX sheets are Summary, Departments, Staff and Notes. It reads production events, stock packaging ledger and staff barcode names directly, using its own KPI/date helpers.

The digest additionally requires `RESEND_API_KEY`, with `REPORT_RECIPIENT` and `FROM_EMAIL` configuration. The handler contains a fallback business recipient and Resend sender; preview must explicitly configure safe recipients. Do not invoke a digest URL as a harmless health check: the normal path sends email and `recipient` can override the destination.

Frontend configuration is `VITE_BACKEND`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Server handlers accept some non-Vite Supabase fallbacks, but precedence varies; inspect each handler rather than assuming one shared config module. `SUPABASE_SERVICE_ROLE_KEY`, Shopify credentials, Dropbox credentials and Resend keys belong only on the server. `.env.example` documents frontend configuration, not the full server variable set. No secret values are needed in this document.

## 8. Risky or messy areas

These are concrete source findings and planning constraints, not fixes made during onboarding. Severity depends in part on deployed policies and data, which were not inspected.

### Access and inventory correctness

1. **Digest and diagnostic exposure.** `api/reports/daily-digest.ts` has no authentication/cron-secret check before service-role reads, XLSX output, recipient override or diagnostic branches. `rolecheck` returns decoded key metadata and a sample REST response; `envcheck` returns key prefixes/lengths and recipient data. `shopify/whoami.ts` is likewise unguarded. Deployment protection may exist outside the repo, but the handlers provide none. Address before treating these routes as private administrative surfaces.
2. **Production RPC authorization and deduplication.** `0031` is SECURITY DEFINER, locates an event by `id` alone despite the `(location,id)` PK, and never checks `auth.uid()`/`can_access_location`. It accepts client quantities and product selectors. `0025` granted execution to authenticated users. Deduplication is `EXISTS` before update/insert, with no unique source-key constraint or serialized check, so concurrent calls can both pass. Code and ID aliases also produce different source keys for the same product. Do not promise exactly-once inventory from this implementation.
3. **Negative-stock schema disagreement.** `0031` subtracts without clamping and reports negative stock, while `0001.products.current_on_hand` and `ProductSchema` prohibit negatives. No present migration removes the SQL constraint. On the recovered schema an insufficient-stock update can fail before negative reporting. Missing `0027` prevents assuming deployed behavior.
4. **Return direction and closure behavior.** Both `upsertCsReturn` methods pass positive quantities for purported restock credits, but `adjustOnHand` subtracts positives. Their reversal/delete calls pass negatives. This indicates reversed stock movement. In addition, `closed` is outside the credit predicate, and CS-case `closed` is outside its deduction predicate. Test transitions and actual ledger effects explicitly before changing these workflows.
5. **Partial writes and error handling.** Supabase product/ledger edits, case and return line replacement, weekly moves, backup restore and warehouse replacement span requests. Some intermediate errors are ignored. Production records completion before deduction and only logs RPC failure. Repeated saves/retries need intentional idempotency and recovery designs; one atomic RPC does not make the surrounding workflow atomic.
6. **Overlapping inventory mechanisms.** Sales editing/import, paper snapshots, replacements and production completion can all move stock. Production's catalogue decomposition is separate from generic BOM cascading. Define which workflow owns each movement before enabling new deduction paths, and test insufficient stock, reversal, retry and cross-department orders.

### Recovery, schema and isolation

7. **Backup is not a full system backup.** `BackupSchema` and repository exports contain core stock/sales/shipments/events/storage/settings/paper/ledger only. They omit CS cases/returns, production, staff/auth, notes, accounting, invoice files and artwork cache. Dexie `wipe()` clears all stores, including omitted ones. Supabase wipe deletes core tables sequentially and can hit restrictive CS FKs after earlier deletes; cascades can remove related accounting metadata. Neither restore is a whole-system rollback.
8. **Old restore keys.** Supabase `importBackup` wipes before normalizing and still upserts weekly entries with conflict target `location,iso_week_start`, inconsistent with `0010`. Dexie restore writes all entries into the framed date-keyed store instead of routing by department, risking collisions/loss. Restore must be tested on disposable data before use.
9. **Bulk weekly deletion crosses departments.** Both adapters build a union of selected week dates and delete/credit sales by date without joining product department. Entry deletion is department-filtered, but sales deletion is not. Single-week deletion does join department. Selected-reference-week averaging also uses dates rather than department-qualified entry identity.
10. **UI permissions are not data boundaries.** Broad location read policies include costs in `products` even when financial screens are hidden. `allowed_nav` changes routing, not RLS. SECURITY DEFINER adjustment/shipment functions only check membership, allowing a broader role set than normal table writes. Plan authorization at both UI and database layers.
11. **Cached identity and backend gaps.** Dataset query keys are location-based, not user-based, and auth sign-out does not clear the global QueryClient. Persisted app state is shared within the origin. Test account changes for stale data. Welcome/Reports eagerly construct Supabase even in Dexie mode. Production and other direct-query modules have no complete local substitute despite production stores existing in Dexie.
12. **Recovered schema is incomplete evidence.** Historical comments refer to different role defaults, no-return-restocking, dormant unframed tables and earlier idempotency keys. Barcode-only identities conflict with the original Auth FKs; missing `0027` may be relevant but its contents cannot be inferred. Use current executable code and reconciled schema rather than comments as authority.

### Reporting, UI and maintainability

13. **Reporting rules diverge.** Welcome excludes cancelled events from its fetch, Reports follows cancellation parent IDs, and the digest uses its own reducer. Digest hours use first clock-in/last clock-out or work endpoints rather than `computeShifts` and its breaks. The digest's `localDayRangeUtc` derives only calendar-date differences, not the full timezone offset, and always adds 24 hours; local midnight and DST boundaries need tests. Browser reports use browser-local dates rather than the selected location's timezone.
14. **Row caps remain in important reads.** `fetchAllRows` is used by Reports, Welcome and package cards, but ordinary repository lists, digest aggregation, timesheets and several widgets make unpaged selects. Hosted row limits can silently truncate totals or exports. The paging helper stops at a default 100 pages without reporting incompleteness and needs stable ordering from callers.
15. **Production preflight uses an obsolete status.** `Production.tsx` searches cases in `new`/`approved`, while `0008` and current UI use `query`. It can miss query-stage replacement work. Preflight also deliberately fails open on read errors, so warnings are not a durable integrity control.
16. **React hook ordering needs browser coverage.** `Dashboard` and `Warehouse`, for example, return early while data is absent before later `useMemo` calls. Type-check/build do not detect a rendered-more-hooks failure on loading-to-loaded transitions. There is no browser-test suite or hooks lint gate here.
17. **Large screens and duplicated rules.** Production, SalesEntry, Reports, cases and shipments combine fetching, domain rules, state machines and rendering in large files. SKU/KPI rules and packaging IDs are duplicated in server/client modules. Hardcoded catalogue IDs, gallery-wall mixes and timezone assumptions are business configuration disguised as code.
18. **External assets and bundles.** Lanyard print/download and timesheet export dynamically load scripts from unpkg, adding network dependencies beyond installed packages. The initial build bundle is large, all routes are statically imported, and XLSX has both static/dynamic imports. Artwork browser caching can outlive signed URLs. These are useful targets for a later focused performance/reliability plan.

## 9. Verification and planning handoff

Onboarding verification, run locally with `VITE_BACKEND=dexie` in the process environment:

| Check | Result |
| --- | --- |
| `npx tsc -b` | Passed. |
| `npm run test -- --run` | Passed: 35 tests in the single `payment-terms.test.ts` file. |
| `npm run build` | Passed. Warnings: stale Browserslist data, mixed XLSX imports, and a main JS chunk of approximately 1.73 MB minified / 504 kB gzip. |

`tsconfig.json` includes `src`, and its Node reference covers Vite configuration; these checks do not type-check or exercise the `api/` handlers or execute SQL/RLS. The existing tests cover payment terms, not stock accounting, scanner attribution, authorization, forecast/shift calculations or browser rendering. No staging integration, production smoke test, or remote CI run was performed as part of this documentation commit.

For future work, start with the relevant route and actual data path above. A repository-contract change must account for both adapters. A production change must trace scanned identity, event recording, reporting interpretation and inventory deduction separately. A schema change must reconcile live/staging history, add a new migration (do not edit the recovered files), and preserve old-code compatibility. Include staging acceptance tests and release/rollback notes in the appropriate spec/plan templates. CJ applies SQL, merges and deploys under the release runbook.

This onboarding changes only `docs/ARCHITECTURE.md` on `docs/architecture`. It is ready for CJ's documentation review; no application or database behavior is changed by this branch.
