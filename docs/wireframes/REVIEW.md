# Wireframe review against the current app (24 Nov 2026)

I checked the first wireframe round against the code on `main` (`src/components/layout/*`,
`src/lib/domain/schemas.ts`, `src/lib/auth/permissions.ts` and each page). This file lists
what did not match, what changed in the wireframes, and what still needs a spec decision.
Nothing here changes app code.

## 1. Shell (sidebar, top bar, global controls)

| # | Current app | Wireframe round 1 | Fix in round 2 |
|---|---|---|---|
| S1 | Top bar has a **Framed / Unframed department toggle** that filters Sales entry, Dashboard, Order builder and forecasts | Missing | Added to top bar as a segmented control, saved per user |
| S2 | Top bar has a **Scenario** select (Base, +15%, −15%, saved scenarios) | Missing | Added next to the department toggle |
| S3 | Real **alerts bell** with unread count, mark read, mark all read (`detectAlerts`) | Bell icon only | Bell has an unread badge and a dropdown with the same actions. Home's "needs you" callout reads from the same alerts |
| S4 | Theme is **light / dark / system** (`theme` setting) | Light / dark only | 3-way switch: system, light, dark |
| S5 | Sidebar **collapses to icons** (`sidebarCollapsed`) | Not shown | Collapse button works and is remembered. Collapsed nav shows tooltips |
| S6 | **No navigation on phones** (`hidden md:flex`, nothing replaces it) | Not handled | Below 768px: hamburger opens the sidebar as a drawer, the side peek becomes a full-screen sheet, tables scroll sideways |
| S7 | Nav items are filtered by role / `allowed_nav`. **Dashboard is owner-only.** CS sees Welcome + CS pages; kiosk sees Order submission only | Static nav | A "Preview as" role switcher (wireframe-only) hides items exactly as `effectiveNavAccess` does. Empty groups hide their header |
| S8 | Owners can rename nav items (`nav_labels`) | Fixed labels | Labels truncate with an ellipsis and show a tooltip |
| S9 | Location switch reloads the app (to avoid cross-location leaks) | Location pill | Kept as a select, with a note that switching reloads |
| S10 | Command palette: `/` or Ctrl K, searches SKUs, events, POs, suppliers, arrow keys + Enter | Ctrl K only, records + actions | `/` also opens it. Arrow keys move, Enter opens. Actions (new case, log movement) are **new** and marked as such |
| S11 | No share / favourite feature | Share and star buttons | Removed: no controls that don't do anything |
| S12 | No "synced" status | "Synced 2 min ago" | Replaced with the backend badge (Supabase or Local) and the env pill, shown only when not production |

## 2. Pages

| Page | Mismatch | Fix in round 2 |
|---|---|---|
| Home | Departments were Printing/Framing/Packing. Real: **A0 Framed, Framed, Unframed, Dispatch**. Home is seen by **every role**, but the alerts showed stock and money | Real departments. The alert callout and quick actions change with the role (staff and CS never see stock or money) |
| Dashboard | Owner-only, not marked | "Owner only" badge. Stock value and Stock chart stay here as tabs (they use the `dashboard` permission), not under Reports |
| SKUs | Groups "Paper prints / Frames" don't exist. Product types are **product, consumable, packaging, service**. Avg methods are **trailing 8, trailing 12, weighted, manual, selected weeks**. Products can have **components (BOM)** | Group by department or type. Real enum labels. BOM toggle in the peek. On hand is read-only in the peek; "Adjust" opens a movement so the change is written to the ledger |
| Sales entry | **Each cell saves on blur** and writes ledger rows straight away. The current grid is **weeks × SKUs** (rows are weeks) and supports paste from Notion | Dropped the "save once" bar: changing when stock is deducted is a money change and needs its own spec. Each cell shows saving / saved / failed, with Undo. Two views: **Week** (one week, SKUs as rows, new) and **Grid** (the current weeks × SKUs layout, keeps paste) |
| Shipments | Statuses are **Draft, Ordered, Back-Ordered, In Production, In Transit, Customs, Delivered, On hold, Cancelled**. "Paid" is a payment status, not a shipment status | Board uses the real statuses; On hold, Back-ordered and Cancelled collapse into "Other". Payment is a field. Moving a card to Delivered opens a confirm dialog when auto-apply is on, because that changes stock |
| Shopping list | "Create shipment" today makes **one shipment per line** | Button says "Create draft shipments". One PO per supplier is flagged as an open question |
| Warehouse | Bays have row, column, max pallets and **type (floor, rack, cold)**. If no bays exist the page shows an empty state | Bay map uses row/column, type legend added, empty state shown |
| Movements | Categories are presets: Sample, Damaged, Internal use, Transfer out/in, Stocktake adjustment, Found stock, Other. Ledger reasons are **sale, shipment, usage, manual, stocktake, transfer, initial, import, replacement, return** | Real presets in the quick-add, real reasons as tags. The SKU picker is a search box instead of a 142-option select |
| CS cases | Statuses are **New, Query, Shipped, Closed, Denied**. Urgency **Critical/High/Medium/Low**. Issue types: damaged, incorrect/missing, delivery issue, expedite, quality, other. Department framed/unframed/mixed. **One notes field, no comments** | Real board columns and tags. Comments thread replaced by the notes field. Threaded comments marked as a future item (needs a new table + RLS) |
| Returns | Statuses are **New, Received, RTS, Closed**. Refund expected / refund received flags. Restock is per line and credits stock when saved as Received | Real statuses and flags. Restock shown per line |
| Reports | "Cases by issue", "Returns & refunds" and "Paper usage trend" don't exist. Stock value is owner-only | Sub-nav lists only reports that exist today. Stock reports removed from here |
| Team | Access is **per member** (`allowed_nav` overrides role defaults), not per role. Dashboard can't be granted to non-owners. Adding a member is 2 steps (create user in Supabase, paste UID) | Per-member access editor showing role defaults; Dashboard row locked. Invite shown as the real 2-step flow; one-step invite flagged as needing a server endpoint |
| Settings | Missing: nav labels, scenario start, supplier filter, carton sizes, supplier payment terms, backup | Sub-nav lists all real sections |

## 3. Hardening added to every screen

- **States:** a wireframe "State" switch shows each page's main table as loading (skeleton), empty (with the next action) and error (with Retry).
- **Accessibility:** skip link, visible focus rings, `aria-current` on the active nav item, labels on icon-only buttons, the palette as a dialog, `prefers-reduced-motion` respected. Muted and faint text darkened to meet WCAG AA in both themes.
- **Stock-changing actions** (deliver a shipment, deduct paper rolls, restock a return, reverse a movement) always show a confirm step that says how many units change.
- **No dead controls:** every control on the wireframe maps to something in the app, or is marked **New**.

## 4. Open questions for CJ (need a decision before a spec)

1. Sales entry: keep per-cell auto-save (as now), or move to "review then save"? The wireframe keeps auto-save.
2. Shopping list: one draft shipment per supplier instead of per line?
3. CS cases: is threaded comments worth a new table?
4. Team: one-step invite (needs a server endpoint using the service-role key)?
5. Sidebar: light in light mode and dark in dark mode, or always dark?

## 5. How this maps to the real build

The wireframe tokens (`wf.css` `:root` and `[data-theme="dark"]`) map onto Tailwind's `darkMode: "class"`,
which the app already uses. Icons are the same `lucide-react` 0.383 set. The shell changes touch
`Layout.tsx`, `Sidebar.tsx`, `Topbar.tsx` and `CommandPalette.tsx`. Each page then becomes its own
spec, so the work can ship in small, reversible releases.
