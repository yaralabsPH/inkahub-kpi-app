import { useMemo, useState } from "react";
import {
  LifeBuoy, Plus, ExternalLink, Trash2, Pencil, Search, Download, BarChart3,
  LayoutGrid, List as ListIcon,
} from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { useCsCases } from "@/lib/hooks/useCsCases";
import { useMutations } from "@/lib/hooks/useMutations";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Field, Input, Select } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { getSupabase } from "@/lib/repository/supabase/client";
import { fmtDayMonth, fmtNum } from "@/lib/utils/format";
import {
  CS_CASE_STATUS_LABELS, CS_CASE_URGENCY_LABELS, CS_CASE_ISSUE_LABELS,
  shortCode,
  parseSku, friendlySize, friendlyVariant, variantChipClass, skuTypeBadge,
  catalogueColourToVariant,
  routeShopifyLineToCatalogueLines,
  type CsCase, type CsCaseLine, type CsCaseWithLines,
  type CsCaseStatus, type CsCaseUrgency, type CsCaseIssueType,
  type Product,
} from "@/lib/domain";

/**
 * CS Cases page — kanban view + new-case modal.
 *
 * Each case is a customer-service intervention (damaged, missing, expedite,
 * etc). Multi-line: a single case can send multiple replacement items.
 * Status workflow: new → query → shipped → closed (+ optional denied).
 *
 * 'query' is a holding state for cases CS is still chasing info on
 * (photos of damage, address confirmation, etc.). No inventory moves here.
 *
 * Inventory deduction fires when status transitions to 'shipped' AND a
 * tracking number is set — that's the moment we commit the stock change.
 * Edits before that point are free.
 */

const STATUS_COLUMNS: CsCaseStatus[] = ["new", "query", "shipped", "closed"];

// Traffic-light urgency colours: critical red → high orange → medium yellow
// → low green. Keeps the visual hierarchy obvious at kanban-card glance.
const URGENCY_TONE: Record<CsCaseUrgency, string> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200",
  low: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
};

// Status colour map used by the List view's Status column. 'query' gets red
// so it stands out — those are cases waiting on info and at risk of slipping.
const STATUS_TONE: Record<CsCaseStatus, string> = {
  new: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  query: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  shipped: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  closed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  denied: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};

const ISSUE_TYPES: CsCaseIssueType[] = [
  "damaged", "incorrect_missing", "delivery_issue", "expedite", "quality", "other",
];
const URGENCIES: CsCaseUrgency[] = ["critical", "high", "medium", "low"];
const STATUSES: CsCaseStatus[] = ["new", "query", "shipped", "closed", "denied"];

// Department filter type. The legacy schema also accepts 'mixed', but we no
// longer surface it: any case that mixes framed + unframed lines is treated
// as 'framed' in the auto-derive (see deriveDepartment). Older 'mixed' rows
// in the DB remain searchable but won't match either pill.
type DeptFilter = "all" | "framed" | "unframed";

export function CsCases() {
  const { data: dataset } = useDataset();
  const { data: cases, isLoading } = useCsCases();
  const [editing, setEditing] = useState<CsCaseWithLines | null>(null);
  const [creating, setCreating] = useState(false);

  // ---- Filter state ----
  const [searchQuery, setSearchQuery] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState<DeptFilter>("all");
  const [issueFilter, setIssueFilter] = useState<"" | CsCaseIssueType>("");
  // Show finished cases that the daily-archive rule would normally hide.
  const [showArchive, setShowArchive] = useState(false);
  // Date range filter — applies to created_at. Empty string = no bound.
  // Stored as YYYY-MM-DD; comparison against created_at uses the date prefix
  // so we don't have to think about timezones here (good enough for an
  // analytical filter — exact boundary jitter is acceptable).
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Which panel to render below the filter row.
  const [view, setView] = useState<"kanban" | "list" | "reports">("kanban");

  // Last midnight in Sydney expressed as a UTC instant. Finished cases whose
  // updated_at is BEFORE this instant get auto-hidden from the kanban (still
  // searchable). Recomputed on each render so the rule rolls over at midnight
  // even if the page sits open all day.
  const lastSydneyMidnight = useMemo(() => lastSydneyMidnightUtc(), [cases]);

  const isSearching = searchQuery.trim().length > 0;
  const allCases = useMemo(() => cases ?? [], [cases]);

  // Cases that pass every active filter. Order matters: archive rule fires
  // first (cheap), then dept/issue (cheap), then search (string match).
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allCases.filter((c) => {
      // Daily-archive rule: hide finished cases older than last Sydney midnight.
      // Bypassed when the user is searching (so they can find old cases), has
      // explicitly toggled "Show all", or is viewing the List / Reports tabs
      // (both of which always show the full historical dataset — that's their
      // entire reason for existing).
      if (view === "kanban" && !isSearching && !showArchive) {
        const isFinished = c.status === "shipped" || c.status === "closed" || c.status === "denied";
        if (isFinished) {
          const finishedAtMs = new Date(c.updated_at).getTime();
          if (finishedAtMs < lastSydneyMidnight.getTime()) return false;
        }
      }
      if (departmentFilter !== "all" && c.department !== departmentFilter) return false;
      if (issueFilter && c.issue_type !== issueFilter) return false;
      // Date range — created_at is an ISO string starting with YYYY-MM-DD,
      // so a lexicographic compare on the first 10 chars works correctly.
      if (dateFrom || dateTo) {
        const d = c.created_at.slice(0, 10);
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
      }
      if (q) {
        const productCodes = c.lines
          .map((l) => dataset?.products.find((p) => p.id === l.product_id)?.code ?? "")
          .join(" ");
        const haystack = [
          c.order_number,
          c.customer_name ?? "",
          c.customer_email ?? "",
          c.tracking_number ?? "",
          c.shopify_order_url ?? "",
          c.original_carrier ?? "",
          c.carrier ?? "",
          productCodes,
        ].join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [allCases, searchQuery, departmentFilter, issueFilter, showArchive, isSearching, lastSydneyMidnight, dataset, view, dateFrom, dateTo]);

  // How many cases the daily-archive rule is hiding right now. Only counted
  // when the rule is actually active (not searching, not showing all), so the
  // "X archived" hint never lies.
  const archivedHiddenCount = useMemo(() => {
    if (view !== "kanban" || isSearching || showArchive) return 0;
    return allCases.filter((c) => {
      const isFinished = c.status === "shipped" || c.status === "closed" || c.status === "denied";
      if (!isFinished) return false;
      return new Date(c.updated_at).getTime() < lastSydneyMidnight.getTime();
    }).length;
  }, [allCases, isSearching, showArchive, lastSydneyMidnight, view]);

  if (!dataset) return <div className="text-sm text-slate-500">Loading…</div>;

  // Group filtered cases by status for kanban columns. 'denied' goes into the
  // strip at the bottom (rare status, doesn't justify a full column).
  const casesByStatus = new Map<CsCaseStatus, CsCaseWithLines[]>();
  for (const s of STATUSES) casesByStatus.set(s, []);
  for (const c of filtered) {
    casesByStatus.get(c.status)?.push(c);
  }

  const anyFilterActive =
    isSearching
    || departmentFilter !== "all"
    || issueFilter !== ""
    || showArchive
    || dateFrom !== ""
    || dateTo !== "";

  const clearFilters = () => {
    setSearchQuery("");
    setDepartmentFilter("all");
    setIssueFilter("");
    setShowArchive(false);
    setDateFrom("");
    setDateTo("");
  };

  // Export the currently filtered case set as a CSV with one row per
  // replacement line (so the file pivots cleanly in Excel / Sheets).
  // Cases with no lines still produce one row so they don't get lost.
  // BOM prefix so Excel auto-detects UTF-8.
  const exportCsv = () => {
    const HEADER = [
      "case_id", "order_number", "status", "urgency", "issue_type", "department",
      "customer_name", "customer_email", "customer_keeps_original",
      "original_carrier", "replacement_carrier", "tracking_number",
      "shopify_order_url", "date_ordered",
      "created_at", "updated_at", "queried_at", "shipped_at", "closed_at",
      "inventory_deducted", "product_code", "product_short_code",
      "quantity", "notes",
    ];
    const baseFor = (c: CsCaseWithLines): string[] => [
      c.id, c.order_number, c.status, c.urgency, c.issue_type,
      c.department ?? "",
      c.customer_name ?? "", c.customer_email ?? "",
      c.customer_keeps_original ? "yes" : "no",
      c.original_carrier ?? "", c.carrier ?? "", c.tracking_number ?? "",
      c.shopify_order_url ?? "", c.date_ordered ?? "",
      c.created_at, c.updated_at, c.queried_at ?? "",
      c.shipped_at ?? "", c.closed_at ?? "",
      c.inventory_deducted ? "yes" : "no",
    ];
    const rows: string[][] = [HEADER];
    for (const c of filtered) {
      if (c.lines.length === 0) {
        rows.push([...baseFor(c), "", "", "0", c.notes]);
      } else {
        for (const l of c.lines) {
          const p = dataset!.products.find((pp) => pp.id === l.product_id);
          rows.push([
            ...baseFor(c),
            p?.code ?? "",
            p?.short_code ?? "",
            String(l.quantity),
            c.notes,
          ]);
        }
      }
    }
    // RFC-4180 quoting: wrap any cell with comma / quote / newline in quotes,
    // doubling any internal quotes.
    const csv = "﻿" + rows.map((row) =>
      row.map((cell) => {
        const s = String(cell ?? "");
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","),
    ).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cs-cases-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight inline-flex items-center gap-2">
            <LifeBuoy size={18} /> CS Cases
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Customer-service interventions — replacements, complaints, delivery issues.
            Inventory auto-deducts when status moves to <strong>Shipped</strong> with a tracking number.
            Finished cases drop off this view at midnight AEST; search to find any case.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Kanban / List / Reports toggle */}
          <div className="inline-flex rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setView("kanban")}
              className={cn(
                "px-2.5 h-9 inline-flex items-center gap-1.5 transition",
                view === "kanban"
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
              )}
            >
              <LayoutGrid size={14} /> Kanban
            </button>
            <button
              type="button"
              onClick={() => setView("list")}
              className={cn(
                "px-2.5 h-9 inline-flex items-center gap-1.5 transition border-l border-slate-200 dark:border-slate-800",
                view === "list"
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
              )}
            >
              <ListIcon size={14} /> List
            </button>
            <button
              type="button"
              onClick={() => setView("reports")}
              className={cn(
                "px-2.5 h-9 inline-flex items-center gap-1.5 transition border-l border-slate-200 dark:border-slate-800",
                view === "reports"
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
              )}
            >
              <BarChart3 size={14} /> Reports
            </button>
          </div>
          <Button
            variant="secondary"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5"
            title="Download the currently filtered cases as a CSV"
          >
            <Download size={14} /> Export CSV
          </Button>
          <Button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5">
            <Plus size={16} /> New case
          </Button>
        </div>
      </div>

      {/* ---- Filter row ---- */}
      <div className="rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 bg-white/40 dark:bg-slate-900/40 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative flex-1 min-w-[240px]">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by order #, customer, tracking, SKU…"
              className="w-full h-8 pl-7 pr-3 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
            />
          </div>

          {/* Department pills */}
          <div className="inline-flex rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden text-xs">
            {(["all", "framed", "unframed"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDepartmentFilter(d)}
                className={cn(
                  "px-2.5 h-8 transition",
                  departmentFilter === d
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
                )}
              >
                {d === "all" ? "All" : d.charAt(0).toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>

          {/* Issue-type select */}
          <select
            value={issueFilter}
            onChange={(e) => setIssueFilter(e.target.value as "" | CsCaseIssueType)}
            className="h-8 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
          >
            <option value="">All issues</option>
            {ISSUE_TYPES.map((k) => (
              <option key={k} value={k}>{CS_CASE_ISSUE_LABELS[k]}</option>
            ))}
          </select>

          {/* Date range — filters created_at. Empty = unbounded on that side. */}
          <div
            className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300"
            title="Filter by case-created date. Affects Kanban, List, Reports, and CSV export."
          >
            <span className="text-slate-500">From</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-8 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
            />
            <span className="text-slate-500">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-8 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
            />
          </div>

          {/* Show-archive toggle — pushed to the right */}
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer ml-auto select-none">
            <input
              type="checkbox"
              checked={showArchive}
              onChange={(e) => setShowArchive(e.target.checked)}
              className="rounded"
            />
            Show archived
          </label>

          {anyFilterActive ? (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 underline-offset-2 hover:underline"
            >
              Clear
            </button>
          ) : null}
        </div>

        {/* Hidden-count hint — only when the archive rule is the reason. */}
        {archivedHiddenCount > 0 ? (
          <div className="text-[11px] text-slate-500 mt-1.5">
            {archivedHiddenCount} finished case{archivedHiddenCount === 1 ? "" : "s"} hidden from before midnight AEST.
            Search any field or tick <em>Show archived</em> to find them.
          </div>
        ) : null}
      </div>

      {/* ---- Main panel: Kanban OR Reports ---- */}
      {isLoading ? (
        <div className="text-sm text-slate-500">Loading cases…</div>
      ) : view === "kanban" ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
            {STATUS_COLUMNS.map((status) => {
              const col = casesByStatus.get(status) ?? [];
              return (
                <KanbanColumn
                  key={status}
                  status={status}
                  cases={col}
                  products={dataset.products}
                  onSelect={(c) => setEditing(c)}
                />
              );
            })}
          </div>

          {/* Denied strip — only rendered when non-empty. */}
          {(casesByStatus.get("denied")?.length ?? 0) > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Denied</CardTitle>
                <span className="text-xs text-slate-500">Cases rejected — review before deleting.</span>
              </CardHeader>
              <CardBody>
                <div className="flex flex-wrap gap-2">
                  {casesByStatus.get("denied")?.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setEditing(c)}
                      className="text-left rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 hover:ring-slate-400 text-xs"
                    >
                      <div className="font-mono">{c.order_number}</div>
                      <div className="text-slate-500">{CS_CASE_ISSUE_LABELS[c.issue_type]}</div>
                    </button>
                  ))}
                </div>
              </CardBody>
            </Card>
          ) : null}

          {/* Empty-state when filters return nothing in Kanban. */}
          {filtered.length === 0 && allCases.length > 0 ? (
            <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-slate-50/40 dark:bg-slate-900/30 px-4 py-6 text-center text-sm text-slate-500">
              No cases match your filters.{" "}
              <button
                type="button"
                onClick={clearFilters}
                className="text-slate-700 dark:text-slate-200 underline underline-offset-2 hover:no-underline"
              >
                Clear filters
              </button>
            </div>
          ) : null}
        </>
      ) : view === "list" ? (
        <ListPanel
          cases={filtered}
          allCases={allCases}
          products={dataset.products}
          onSelect={(c) => setEditing(c)}
          onClearFilters={clearFilters}
        />
      ) : (
        <ReportsPanel cases={filtered} allCases={allCases} products={dataset.products} />
      )}

      {(creating || editing) ? (
        <CaseModal
          initial={editing}
          products={dataset.products}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      ) : null}
    </div>
  );
}

// ============================================================================
// KANBAN COLUMN
// ============================================================================

function KanbanColumn({
  status, cases, products, onSelect,
}: {
  status: CsCaseStatus;
  cases: CsCaseWithLines[];
  products: Product[];
  onSelect: (c: CsCaseWithLines) => void;
}) {
  return (
    <div className="rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 bg-slate-50/40 dark:bg-slate-900/30">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-baseline justify-between">
        <div className="font-medium text-sm">{CS_CASE_STATUS_LABELS[status]}</div>
        <div className="text-xs text-slate-500 tabular-nums">{cases.length}</div>
      </div>
      <div className="p-2 space-y-2 max-h-[700px] overflow-y-auto">
        {cases.length === 0 ? (
          <div className="text-xs text-slate-400 italic px-2 py-3">No cases.</div>
        ) : null}
        {cases.map((c) => (
          <CaseCard key={c.id} c={c} products={products} onClick={() => onSelect(c)} />
        ))}
      </div>
    </div>
  );
}

function CaseCard({
  c, products, onClick,
}: { c: CsCaseWithLines; products: Product[]; onClick: () => void }) {
  const totalQty = c.lines.reduce((sum, l) => sum + l.quantity, 0);
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full text-left rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-950 hover:ring-slate-400 dark:hover:ring-slate-600 px-3 py-2 space-y-1 transition"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-slate-700 dark:text-slate-300">#{c.order_number}</span>
        <span className={cn(
          "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide",
          URGENCY_TONE[c.urgency],
        )}>
          {CS_CASE_URGENCY_LABELS[c.urgency]}
        </span>
      </div>
      <div className="text-xs font-medium text-slate-900 dark:text-slate-100">
        {CS_CASE_ISSUE_LABELS[c.issue_type]}
      </div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
        {c.lines.length === 0 ? <span className="italic">No items</span> : (
          c.lines.map((l) => {
            const p = products.find((pp) => pp.id === l.product_id);
            return `${l.quantity}× ${p ? p.code : "(unknown)"}`;
          }).join(", ")
        )}
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span>{c.customer_name ?? "—"}</span>
        <span>{fmtDayMonth(c.created_at.slice(0, 10))} · {totalQty} item{totalQty === 1 ? "" : "s"}</span>
      </div>
    </button>
  );
}

// ============================================================================
// CASE MODAL — new + edit, same component
// ============================================================================

function CaseModal({
  initial, products, onClose,
}: {
  initial: CsCaseWithLines | null;
  products: Product[];
  onClose: () => void;
}) {
  const m = useMutations();
  const auth = useAuthOptional();
  const userId = auth?.profile?.user_id ?? null;
  const isEdit = !!initial;
  const now = new Date().toISOString();

  // Form state — initialise from `initial` if editing, blank for new.
  const [orderNumber, setOrderNumber] = useState(initial?.order_number ?? "");
  const [shopifyUrl, setShopifyUrl] = useState(initial?.shopify_order_url ?? "");
  const [dateOrdered, setDateOrdered] = useState(initial?.date_ordered ?? "");
  const [customerName, setCustomerName] = useState(initial?.customer_name ?? "");
  const [customerEmail, setCustomerEmail] = useState(initial?.customer_email ?? "");
  const [keepsOriginal, setKeepsOriginal] = useState(initial?.customer_keeps_original ?? true);
  const [issueType, setIssueType] = useState<CsCaseIssueType>(initial?.issue_type ?? "damaged");
  const [urgency, setUrgency] = useState<CsCaseUrgency>(initial?.urgency ?? "medium");
  const [status, setStatus] = useState<CsCaseStatus>(initial?.status ?? "new");
  // Original delivery carrier — the carrier that delivered the (broken/wrong)
  // order to the customer. Captured for CS reporting on which carrier causes
  // most issues. Independent from the replacement parcel carrier below.
  const [originalCarrier, setOriginalCarrier] = useState(initial?.original_carrier ?? "");
  // Replacement parcel carrier — the carrier we use to send the replacement.
  // Pairs with tracking_number. Optional until we actually ship.
  const [carrier, setCarrier] = useState(initial?.carrier ?? "");
  const [trackingNumber, setTrackingNumber] = useState(initial?.tracking_number ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [lines, setLines] = useState<CsCaseLine[]>(initial?.lines ?? []);
  const [linePicker, setLinePicker] = useState<{ productId: string; qty: string }>({ productId: "", qty: "1" });
  // SKU picker filter — by default we only show CHINA-supplied items
  // (the things customers actually receive as physical product). CS can
  // tick "All suppliers" if the replacement is something else (rare).
  const [showAllSuppliers, setShowAllSuppliers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shopify Fetch button state. `msg` shows either a success ack ("Filled
  // from Shopify — N fields updated") or an error string. Cleared on the
  // next fetch attempt.
  const [isFetchingShopify, setIsFetchingShopify] = useState(false);
  const [shopifyFetchMsg, setShopifyFetchMsg] = useState<
    { type: "ok" | "error"; text: string } | null
  >(null);
  // Line items pulled from the Shopify order. Each entry stays in this list
  // until the modal closes, so the operator can add → remove → re-add as
  // they figure out exactly which lines to replace.
  const [shopifyLineItems, setShopifyLineItems] = useState<
    Array<{ sku: string | null; title: string | null; quantity: number; variant_title: string | null }>
  >([]);

  /**
   * Call /api/shopify/order with the current order number, autofill any
   * fields Shopify returns, and surface success/error feedback inline.
   *
   * Defensive against the user mashing the button multiple times: the
   * isFetchingShopify guard prevents concurrent requests.
   */
  const fetchFromShopify = async () => {
    if (isFetchingShopify) return;
    setShopifyFetchMsg(null);
    const num = orderNumber.trim();
    if (!num) {
      setShopifyFetchMsg({ type: "error", text: "Enter an order number first." });
      return;
    }
    const supabase = getSupabase();
    // Always read a FRESH session at call time. Supabase auto-refreshes the
    // JWT inside getSession() if its expiry is near, so a long-running kiosk
    // session won't send a stale token.
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token ?? null;
    if (!token) {
      setShopifyFetchMsg({
        type: "error",
        text: "Not signed in. Refresh the page and try again.",
      });
      return;
    }
    setIsFetchingShopify(true);
    try {
      const res = await fetch(
        `/api/shopify/order?order_number=${encodeURIComponent(num)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const body = (await res.json()) as {
        found?: boolean;
        order_name?: string;
        customer_name?: string | null;
        customer_email?: string | null;
        date_ordered?: string | null;
        shopify_order_url?: string | null;
        original_carrier?: string | null;
        line_items?: Array<{ sku: string | null; title: string | null; quantity: number; variant_title?: string | null }>;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.found) {
        setShopifyFetchMsg({
          type: "error",
          text: body.error || `Shopify lookup failed (HTTP ${res.status})`,
        });
        return;
      }
      let filled = 0;
      if (body.customer_name) { setCustomerName(body.customer_name); filled++; }
      if (body.customer_email) { setCustomerEmail(body.customer_email); filled++; }
      if (body.date_ordered) { setDateOrdered(body.date_ordered); filled++; }
      if (body.shopify_order_url) { setShopifyUrl(body.shopify_order_url); filled++; }
      if (body.original_carrier) { setOriginalCarrier(body.original_carrier); filled++; }
      setShopifyLineItems(
        (body.line_items ?? []).map((li) => ({
          sku: li.sku ?? null,
          title: li.title ?? null,
          quantity: li.quantity,
          variant_title: li.variant_title ?? null,
        })),
      );
      const lineCount = body.line_items?.length ?? 0;
      setShopifyFetchMsg({
        type: "ok",
        text:
          filled > 0
            ? `Filled from Shopify — ${filled} field${filled === 1 ? "" : "s"} updated${lineCount ? `, ${lineCount} line item${lineCount === 1 ? "" : "s"} ready to add below` : ""}.`
            : `Found order ${body.order_name ?? num}.${lineCount ? ` ${lineCount} line item${lineCount === 1 ? "" : "s"} ready to add below.` : ""}`,
      });
    } catch (e) {
      setShopifyFetchMsg({
        type: "error",
        text: e instanceof Error ? e.message : "Network error",
      });
    } finally {
      setIsFetchingShopify(false);
    }
  };

  // Stock only moves when we actually ship. 'query' is a holding state.
  const willDeduct = status === "shipped" && trackingNumber.trim() !== "";
  const wasDeducted = initial?.inventory_deducted ?? false;
  const deductionChanging = willDeduct !== wasDeducted;

  const addLine = () => {
    setError(null);
    if (!linePicker.productId) { setError("Pick a SKU."); return; }
    const qty = Number(linePicker.qty);
    if (!Number.isFinite(qty) || qty <= 0) { setError("Quantity must be positive."); return; }
    if (lines.some((l) => l.product_id === linePicker.productId)) {
      setError("That SKU is already on this case. Edit its qty in the list instead.");
      return;
    }
    setLines((prev) => [
      ...prev,
      {
        id: nextId(),
        case_id: initial?.id ?? "pending",
        product_id: linePicker.productId,
        quantity: qty,
        source_shopify_sku: null,
        source_title: null,
      },
    ]);
    setLinePicker({ productId: "", qty: "1" });
  };

  /**
   * One-click "add this Shopify line as a replacement". The Shopify SKU is
   * parsed into its v6 components and ROUTED to the matching catalogue
   * stock code(s) via routeShopifyLineToCatalogueLines. Set prints expand
   * with quantity multiplication (S3 of qty 2 -> 6 of the size+variant
   * stock code); Gallery Wall sets decompose into 4x A2 + 2x A3.
   *
   * If the same catalogue line is already on the case, the qty is merged.
   * Missing catalogue codes surface as an error so the user can either
   * create the stock item or add manually below.
   */
  const addShopifyLine = (item: { sku: string | null; quantity: number; title: string | null }) => {
    setError(null);
    if (!item.sku) {
      setError("That Shopify line has no SKU. Add manually below.");
      return;
    }
    // If this Shopify SKU is already represented on the case (by source),
    // surface that rather than silently double-adding.
    if (lines.some((l) => l.source_shopify_sku === item.sku)) {
      setError(`${item.sku} is already on this case - remove or edit it first.`);
      return;
    }
    const route = routeShopifyLineToCatalogueLines(item.sku, item.quantity);
    if (route.lines.length === 0) {
      setError(route.reason ?? `Cannot route ${item.sku} - add manually below.`);
      return;
    }
    const missing: string[] = [];
    const toAppend: CsCaseLine[] = [];
    for (const r of route.lines) {
      const target = r.code.trim().toLowerCase();
      // Match strictly on p.code - short_code is optional in the catalogue.
      const product = products.find(
        (p) => p.code.trim().toLowerCase() === target,
      );
      if (!product) {
        missing.push(r.code);
        continue;
      }
      // Coalesce repeats inside this same Add click (e.g. PF + B variants
      // never collide, but GW expands into A2+A3 which are distinct).
      const dup = toAppend.find((l) => l.product_id === product.id);
      if (dup) {
        dup.quantity += r.qty;
      } else {
        toAppend.push({
          id: nextId(),
          case_id: initial?.id ?? "pending",
          product_id: product.id,
          quantity: r.qty,
          source_shopify_sku: item.sku,
          source_title: item.title ?? null,
        });
      }
    }
    if (missing.length > 0) {
      setError(
        `Missing catalogue code(s): ${missing.join(", ")} - create stock items with these exact codes, or use the manual picker below.`,
      );
    }
    if (toAppend.length === 0) return;
    setLines((prev) => [...prev, ...toAppend]);
  };


  const removeLine = (id: string) => setLines((prev) => prev.filter((l) => l.id !== id));

  const updateLineQty = (id: string, qty: number) => {
    if (!Number.isFinite(qty) || qty <= 0) return;
    setLines((prev) => prev.map((l) => l.id === id ? { ...l, quantity: qty } : l));
  };

  const submit = async () => {
    setError(null);
    if (!orderNumber.trim()) { setError("Order number is required."); return; }
    if (lines.length === 0) { setError("Add at least one replacement line."); return; }
    if (deductionChanging && wasDeducted) {
      if (!window.confirm(
        "This change will reverse the previous inventory deduction. Continue?",
      )) return;
    }
    if (deductionChanging && willDeduct) {
      if (!window.confirm(
        `Saving will deduct ${lines.reduce((s, l) => s + l.quantity, 0)} item(s) from inventory. Continue?`,
      )) return;
    }
    setBusy(true);
    try {
      const id = initial?.id ?? nextId();
      const next: CsCase = {
        id,
        created_at: initial?.created_at ?? now,
        created_by_user_id: initial?.created_by_user_id ?? userId,
        status,
        urgency,
        issue_type: issueType,
        department: deriveDepartment(lines, products),
        order_number: orderNumber.trim(),
        shopify_order_url: shopifyUrl.trim() || null,
        date_ordered: dateOrdered || null,
        customer_name: customerName.trim() || null,
        customer_email: customerEmail.trim() || null,
        customer_keeps_original: keepsOriginal,
        original_carrier: originalCarrier.trim() || null,
        carrier: carrier.trim() || null,
        tracking_number: trackingNumber.trim() || null,
        notes: notes.trim(),
        attachments: initial?.attachments ?? [],
        queried_at: status === "query" && !initial?.queried_at ? now : initial?.queried_at ?? null,
        shipped_at: status === "shipped" && !initial?.shipped_at ? now : initial?.shipped_at ?? null,
        closed_at: status === "closed" && !initial?.closed_at ? now : initial?.closed_at ?? null,
        inventory_deducted: false,  // repo computes the correct value
        updated_at: now,
      };
      const finalLines = lines.map((l) => ({ ...l, case_id: id }));
      await m.upsertCsCase.mutateAsync({ case: next, lines: finalLines });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!initial) return;
    if (!window.confirm(`Delete case for order ${initial.order_number}? This can't be undone.`)) return;
    setBusy(true);
    try {
      await m.deleteCsCase.mutateAsync(initial.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-auto rounded-lg bg-white dark:bg-slate-950 shadow-2xl ring-1 ring-slate-200 dark:ring-slate-800">
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="font-semibold text-base inline-flex items-center gap-2">
            {isEdit ? <><Pencil size={14} /> Edit case #{initial!.order_number}</> : <><Plus size={14} /> New CS case</>}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">✕</button>
        </div>
        <div className="px-5 py-4 space-y-4">

          {/* ---- Order context ---- */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field
              label="Order number"
              hint="Shopify order number, e.g. 10186629. Click Fetch to auto-fill customer, date, carrier, and Shopify link."
            >
              <div className="flex gap-1">
                <Input
                  value={orderNumber}
                  onChange={(e) => setOrderNumber(e.target.value)}
                  required
                  className="flex-1"
                />
                <button
                  type="button"
                  onClick={fetchFromShopify}
                  disabled={isFetchingShopify}
                  className="px-2.5 h-9 rounded-md text-xs font-medium ring-1 ring-slate-200 dark:ring-slate-700 text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800 whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1"
                  title="Pull customer + date + carrier from Shopify for this order"
                >
                  {isFetchingShopify ? (
                    <>
                      <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Fetching…
                    </>
                  ) : (
                    "Fetch"
                  )}
                </button>
              </div>
              {shopifyFetchMsg ? (
                <div
                  className={cn(
                    "text-[11px] mt-1",
                    shopifyFetchMsg.type === "ok"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-red-600 dark:text-red-400",
                  )}
                >
                  {shopifyFetchMsg.text}
                </div>
              ) : null}
            </Field>
            <Field label="Date ordered">
              <Input type="date" value={dateOrdered} onChange={(e) => setDateOrdered(e.target.value)} />
            </Field>
            <Field label="Shopify order URL" hint="Paste the admin link for one-click navigation back.">
              <Input value={shopifyUrl} onChange={(e) => setShopifyUrl(e.target.value)} placeholder="https://admin.shopify.com/..." />
            </Field>
            <Field label="Customer name">
              <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </Field>
            <Field label="Customer email">
              <Input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
            </Field>
            <Field label="Customer keeps original?" hint="True = customer keeps damaged/wrong item, we send replacement. Standard practice.">
              <Select value={keepsOriginal ? "yes" : "no"} onChange={(e) => setKeepsOriginal(e.target.value === "yes")}>
                <option value="yes">Yes — customer keeps</option>
                <option value="no">No — customer returns to us</option>
              </Select>
            </Field>
          </div>

          {/* ---- Issue + status ---- */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
            <Field label="Issue type">
              <Select value={issueType} onChange={(e) => setIssueType(e.target.value as CsCaseIssueType)}>
                {ISSUE_TYPES.map((k) => <option key={k} value={k}>{CS_CASE_ISSUE_LABELS[k]}</option>)}
              </Select>
            </Field>
            <Field label="Urgency">
              <Select value={urgency} onChange={(e) => setUrgency(e.target.value as CsCaseUrgency)}>
                {URGENCIES.map((k) => <option key={k} value={k}>{CS_CASE_URGENCY_LABELS[k]}</option>)}
              </Select>
            </Field>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value as CsCaseStatus)}>
                {STATUSES.map((k) => <option key={k} value={k}>{CS_CASE_STATUS_LABELS[k]}</option>)}
              </Select>
            </Field>
          </div>

          {/* ---- Shopify-line-item picker (only after a successful Fetch) ---- */}
          {shopifyLineItems.length > 0 ? (
            <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
              <div className="text-sm font-semibold mb-2">
                Line items from Shopify
                <span className="text-xs text-slate-500 font-normal ml-2">
                  Click <em>+ Add</em> on each item the customer needs replaced.
                </span>
              </div>
              <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-left font-medium px-3 py-1.5">SKU</th>
                      <th className="text-left font-medium px-3 py-1.5">Title</th>
                      <th className="text-right font-medium px-2 py-1.5">Qty</th>
                      <th className="text-right font-medium px-2 py-1.5 w-px"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {shopifyLineItems.map((it, i) => {
                      const already = it.sku
                        ? lines.some((l) => l.source_shopify_sku === it.sku)
                        : false;
                      return (
                        <tr key={i} className={already ? "opacity-50" : ""}>
                          <td className="px-3 py-1.5 font-mono text-xs">{it.sku ?? <span className="italic text-slate-400">no SKU</span>}</td>
                          <td className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 truncate max-w-[260px]" title={it.title ?? ""}>
                            {it.title ?? <span className="italic text-slate-400">—</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-xs align-top">{it.quantity}</td>
                          <td className="px-2 py-1.5 align-top">
                            <button
                              type="button"
                              disabled={already || !it.sku}
                              onClick={() => addShopifyLine(it)}
                              className="text-[11px] px-2 h-7 rounded-md ring-1 ring-slate-200 dark:ring-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                            >
                              {already ? "Added" : "+ Add"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {/* ---- Replacement lines ---- */}
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="text-sm font-semibold mb-2">Replacement items</div>
            {lines.length === 0 ? (
              <div className="text-xs text-slate-400 italic mb-2">No items yet — pick a SKU and quantity below.</div>
            ) : (
              <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden mb-2">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-left font-medium px-3 py-1.5">SKU</th>
                      <th className="text-right font-medium px-2 py-1.5">Qty</th>
                      <th className="text-right font-medium px-2 py-1.5">On hand</th>
                      <th className="text-right font-medium px-2 py-1.5 w-px"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {lines.map((l) => {
                      const p = products.find((pp) => pp.id === l.product_id);
                      return (
                        <tr key={l.id}>
                          <td className="px-3 py-1.5 align-top">
                            <div className="font-medium text-sm">{p ? p.code : "(deleted SKU)"}</div>
                            {l.source_title ? (
                              <div className="text-xs text-slate-700 dark:text-slate-200 mt-0.5 truncate" title={l.source_title}>
                                {l.source_title}
                              </div>
                            ) : null}
                            {(() => {
                              // Prefer parsed source SKU for size + variant chip;
                              // fall back to catalogue product fields for manual adds.
                              const parsed = parseSku(l.source_shopify_sku);
                              if (parsed && parsed.size) {
                                return (
                                  <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                                      {friendlySize(parsed.size)}
                                    </span>
                                    {parsed.variant ? (
                                      <span className={variantChipClass(parsed.variant)}>
                                        {friendlyVariant(parsed.variant)}
                                      </span>
                                    ) : null}
                                  </div>
                                );
                              }
                              if (!p) return null;
                              const sizeText = (p.size ?? "").trim();
                              const fallbackVariant = catalogueColourToVariant(p.colour);
                              return (
                                <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                                  {sizeText ? (
                                    <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                                      {sizeText}
                                    </span>
                                  ) : null}
                                  {fallbackVariant ? (
                                    <span className={variantChipClass(fallbackVariant)}>
                                      {friendlyVariant(fallbackVariant)}
                                    </span>
                                  ) : (
                                    <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
                                      {p.colour}
                                    </span>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <input
                              type="number" min={1} step={1} defaultValue={l.quantity}
                              onBlur={(e) => updateLineQty(l.id, Number(e.target.value))}
                              className="w-16 h-7 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-right tabular-nums text-sm"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                            {p ? fmtNum(p.current_on_hand ?? 0) : "—"}
                          </td>
                          <td className="px-2 py-1.5">
                            <button onClick={() => removeLine(l.id)}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                              aria-label="Remove line">
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label="Add SKU"
                hint="Showing only products supplied as CHINA (framed) or UNFRAMED (prints) — the items CS actually sends as replacements. Tick 'All suppliers' if you need something else."
              >
                <Select
                  value={linePicker.productId}
                  onChange={(e) => setLinePicker((p) => ({ ...p, productId: e.target.value }))}
                  className="min-w-[280px]"
                >
                  <option value="">— pick a SKU —</option>
                  {products
                    .filter((p) => showAllSuppliers || isChinaProduct(p) || isUnframedProduct(p))
                    .slice()
                    .sort((a, b) => a.code.localeCompare(b.code))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code} · on hand: {fmtNum(p.current_on_hand ?? 0)}
                      </option>
                    ))}
                </Select>
              </Field>
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showAllSuppliers}
                  onChange={(e) => setShowAllSuppliers(e.target.checked)}
                  className="rounded"
                />
                All suppliers
              </label>
              <Field label="Qty">
                <Input type="number" min={1} step={1} value={linePicker.qty}
                  onChange={(e) => setLinePicker((p) => ({ ...p, qty: e.target.value }))}
                  className="w-20"
                />
              </Field>
              <Button variant="secondary" onClick={addLine}>Add line</Button>
            </div>
          </div>

          {/* ---- Shipping back ---- */}
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-3">
            <Field
              label="Carrier used (original delivery)"
              hint="Optional. Which carrier delivered the original order to the customer. Used for reporting — which carriers cause the most issues?"
            >
              <Input
                value={originalCarrier}
                onChange={(e) => setOriginalCarrier(e.target.value)}
                placeholder="Auspost / Aramex / DHL / …"
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Replacement parcel carrier" hint="Carrier sending the replacement out.">
                <Input
                  value={carrier}
                  onChange={(e) => setCarrier(e.target.value)}
                  placeholder="Auspost / Aramex / …"
                />
              </Field>
              <Field label="Replacement tracking number" hint="Stock deducts when status is Shipped AND tracking is filled.">
                <Input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} />
              </Field>
            </div>
          </div>

          {/* ---- Notes ---- */}
          <Field label="Notes">
            <textarea
              value={notes} onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
              placeholder="Free-text context — what arrived broken, what colour was wrong, etc."
            />
          </Field>

          {/* ---- Inventory impact preview ---- */}
          {willDeduct && lines.length > 0 ? (
            <div className="rounded-md ring-1 ring-amber-200 dark:ring-amber-900/40 bg-amber-50/40 dark:bg-amber-900/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-300">
              <strong>Saving will deduct:</strong>{" "}
              {lines.map((l, i) => {
                const p = products.find((pp) => pp.id === l.product_id);
                return (
                  <span key={l.id}>
                    {i > 0 ? ", " : ""}
                    <strong>{l.quantity}× {p?.code ?? "?"}</strong>
                    {p ? ` (after: ${fmtNum(Math.max((p.current_on_hand ?? 0) - l.quantity, 0))})` : ""}
                  </span>
                );
              })}
            </div>
          ) : null}

          {error ? <div className="text-sm text-red-600 dark:text-red-400">{error}</div> : null}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {isEdit ? (
              <Button variant="ghost" onClick={handleDelete} disabled={busy} className="text-red-600 hover:bg-red-50">
                <Trash2 size={14} /> Delete
              </Button>
            ) : null}
            {shopifyUrl ? (
              <a href={shopifyUrl} target="_blank" rel="noreferrer" className="text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-1">
                <ExternalLink size={12} /> Open in Shopify
              </a>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? "Saving…" : (isEdit ? "Save changes" : "Create case")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// LIST PANEL — chronological table, newest first
// ============================================================================

/**
 * Compact one-row-per-case table. Sorts strictly by created_at descending so
 * the newest case is always at the top. Each row is clickable and opens the
 * same edit modal the kanban cards use.
 *
 * Volume can grow into the hundreds, so the table is virtualised via simple
 * max-height + overflow rather than a dedicated virtualiser library
 * (premature). At 500+ rows we should revisit.
 */
function ListPanel({
  cases, allCases, products, onSelect, onClearFilters,
}: {
  cases: CsCaseWithLines[];
  allCases: CsCaseWithLines[];
  products: Product[];
  onSelect: (c: CsCaseWithLines) => void;
  onClearFilters: () => void;
}) {
  const sorted = useMemo(
    () => [...cases].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [cases],
  );

  if (sorted.length === 0) {
    return (
      <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-slate-50/40 dark:bg-slate-900/30 px-4 py-6 text-center text-sm text-slate-500">
        No cases match the active filters.
        {allCases.length > 0 ? (
          <>
            {" "}
            <button
              type="button"
              onClick={onClearFilters}
              className="text-slate-700 dark:text-slate-200 underline underline-offset-2 hover:no-underline"
            >
              Clear filters
            </button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-950 overflow-hidden">
      <div className="max-h-[70vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900/95 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left font-medium px-3 py-2">Created</th>
              <th className="text-left font-medium px-3 py-2">Order #</th>
              <th className="text-left font-medium px-3 py-2">Customer</th>
              <th className="text-left font-medium px-3 py-2">Issue</th>
              <th className="text-left font-medium px-3 py-2">Status</th>
              <th className="text-left font-medium px-3 py-2">Urgency</th>
              <th className="text-left font-medium px-3 py-2">Dept</th>
              <th className="text-right font-medium px-3 py-2">Items</th>
              <th className="text-left font-medium px-3 py-2">SKUs</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {sorted.map((c) => {
              const totalQty = c.lines.reduce((s, l) => s + l.quantity, 0);
              const skuPreview = c.lines
                .map((l) => products.find((p) => p.id === l.product_id)?.code ?? "?")
                .join(", ");
              return (
                <tr
                  key={c.id}
                  onClick={() => onSelect(c)}
                  className="cursor-pointer hover:bg-slate-50/70 dark:hover:bg-slate-900/40 transition"
                  title="Click to open case"
                >
                  <td className="px-3 py-2 text-xs tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {fmtDateTimeShort(c.created_at)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{c.order_number}</td>
                  <td className="px-3 py-2 text-xs text-slate-700 dark:text-slate-300 truncate max-w-[180px]">
                    {c.customer_name ?? <span className="text-slate-400 italic">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">{CS_CASE_ISSUE_LABELS[c.issue_type]}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className={cn(
                      "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide",
                      STATUS_TONE[c.status],
                    )}>
                      {CS_CASE_STATUS_LABELS[c.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className={cn(
                      "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide",
                      URGENCY_TONE[c.urgency],
                    )}>
                      {CS_CASE_URGENCY_LABELS[c.urgency]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400 capitalize">
                    {c.department ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums text-right">{totalQty}</td>
                  <td className="px-3 py-2 text-[11px] text-slate-500 truncate max-w-[220px]" title={skuPreview}>
                    {skuPreview || <span className="italic">none</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
        {sorted.length} case{sorted.length === 1 ? "" : "s"} · newest first
      </div>
    </div>
  );
}

// ============================================================================
// REPORTS PANEL — read-only analytics over the filtered case set
// ============================================================================

/**
 * ReportsPanel renders summary tiles + a handful of breakdown tables/charts
 * over whatever the user has filtered to. All numbers update live with the
 * department / issue / search filters above.
 *
 * Deliberately uses simple SVG bars + tables — no chart library dependency.
 * The point is fast answers, not pretty interactivity. If a chart is hard
 * to read, we should change the *question*, not the chart library.
 */
function ReportsPanel({
  cases, allCases, products,
}: {
  cases: CsCaseWithLines[];
  allCases: CsCaseWithLines[];
  products: Product[];
}) {
  // -------- Aggregates (all memoised over `cases`) --------

  const totalCases = cases.length;
  const totalLines = cases.reduce((s, c) => s + c.lines.length, 0);
  const totalItems = cases.reduce(
    (s, c) => s + c.lines.reduce((t, l) => t + l.quantity, 0),
    0,
  );

  // Rolling 12-week average — how many cases hit each ISO week, latest 12.
  const perWeek = useMemo(() => weeklyCounts(cases, 12), [cases]);
  const avgPerWeek = perWeek.length === 0 ? 0
    : Math.round((perWeek.reduce((s, w) => s + w.count, 0) / perWeek.length) * 10) / 10;

  const byIssue = useMemo(() => groupCount(cases, (c) => c.issue_type), [cases]);
  const byUrgency = useMemo(() => groupCount(cases, (c) => c.urgency), [cases]);
  const byDept = useMemo(() => groupCount(cases, (c) => c.department ?? "(unassigned)"), [cases]);
  const byOriginalCarrier = useMemo(
    () => groupCount(cases, (c) => (c.original_carrier ?? "").trim() || "(none)"),
    [cases],
  );

  // Top replaced SKUs — counts each line by qty.
  const bySku = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of cases) {
      for (const l of c.lines) {
        counts.set(l.product_id, (counts.get(l.product_id) ?? 0) + l.quantity);
      }
    }
    const out: { code: string; qty: number }[] = [];
    for (const [pid, qty] of counts) {
      const p = products.find((pp) => pp.id === pid);
      out.push({ code: p?.code ?? "(deleted SKU)", qty });
    }
    return out.sort((a, b) => b.qty - a.qty).slice(0, 15);
  }, [cases, products]);

  // -------- Render --------

  if (totalCases === 0) {
    return (
      <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-slate-50/40 dark:bg-slate-900/30 px-4 py-10 text-center text-sm text-slate-500">
        No cases match the active filters.
        {allCases.length > 0 ? " Try clearing some filters above." : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Cases" value={fmtNum(totalCases)} />
        <StatTile label="Replacement lines" value={fmtNum(totalLines)} />
        <StatTile label="Items shipped" value={fmtNum(totalItems)} />
        <StatTile label="Avg cases / wk" value={String(avgPerWeek)} hint="Across the last 12 weeks of this filter set." />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Weekly trend */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Cases per week (last 12)</CardTitle>
            <span className="text-xs text-slate-500">Weeks start Monday.</span>
          </CardHeader>
          <CardBody>
            <WeeklyBars data={perWeek} />
          </CardBody>
        </Card>

        {/* Issue breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Issue types</CardTitle>
            <span className="text-xs text-slate-500">{totalCases} case{totalCases === 1 ? "" : "s"} in scope.</span>
          </CardHeader>
          <CardBody>
            <RankBars
              data={byIssue.map((g) => ({
                label: CS_CASE_ISSUE_LABELS[g.key as CsCaseIssueType] ?? g.key,
                value: g.count,
              }))}
              total={totalCases}
            />
          </CardBody>
        </Card>

        {/* Original carrier */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Original delivery carrier</CardTitle>
            <span className="text-xs text-slate-500">Who delivered the parcel that caused the case?</span>
          </CardHeader>
          <CardBody>
            <RankBars
              data={byOriginalCarrier.map((g) => ({ label: g.key, value: g.count }))}
              total={totalCases}
            />
          </CardBody>
        </Card>

        {/* Urgency + department side-by-side */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Urgency &amp; department mix</CardTitle>
            <span className="text-xs text-slate-500">Two breakdowns of the same case set.</span>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-2 gap-4">
              <RankBars
                data={byUrgency.map((g) => ({
                  label: CS_CASE_URGENCY_LABELS[g.key as CsCaseUrgency] ?? g.key,
                  value: g.count,
                }))}
                total={totalCases}
              />
              <RankBars
                data={byDept.map((g) => ({
                  label: g.key.charAt(0).toUpperCase() + g.key.slice(1),
                  value: g.count,
                }))}
                total={totalCases}
              />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Top SKUs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Most replaced SKUs (top 15)</CardTitle>
          <span className="text-xs text-slate-500">Total units replaced, not unique cases.</span>
        </CardHeader>
        <CardBody>
          {bySku.length === 0 ? (
            <div className="text-xs text-slate-400 italic">No lines in the filtered cases.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="text-left font-medium py-1">SKU</th><th className="text-right font-medium py-1">Units</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {bySku.map((r) => (
                  <tr key={r.code}>
                    <td className="py-1 font-mono text-xs">{r.code}</td>
                    <td className="py-1 text-right tabular-nums">{fmtNum(r.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-950 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold tabular-nums leading-tight">{value}</div>
      {hint ? <div className="text-[10px] text-slate-400 mt-0.5">{hint}</div> : null}
    </div>
  );
}

function RankBars({
  data, total,
}: { data: { label: string; value: number }[]; total: number }) {
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const max = sorted[0]?.value ?? 0;
  if (sorted.length === 0) {
    return <div className="text-xs text-slate-400 italic">No data.</div>;
  }
  return (
    <div className="space-y-1">
      {sorted.map((d) => {
        const pct = max === 0 ? 0 : Math.round((d.value / max) * 100);
        const sharePct = total === 0 ? 0 : Math.round((d.value / total) * 100);
        return (
          <div key={d.label} className="text-xs">
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <span className="truncate">{d.label}</span>
              <span className="text-slate-500 tabular-nums">
                {d.value} <span className="text-slate-400">({sharePct}%)</span>
              </span>
            </div>
            <div className="h-1.5 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div className="h-full bg-slate-700 dark:bg-slate-300" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WeeklyBars({ data }: { data: { iso: string; count: number }[] }) {
  if (data.length === 0) {
    return <div className="text-xs text-slate-400 italic">No data.</div>;
  }
  const max = Math.max(...data.map((d) => d.count), 1);
  const barWidth = 100 / data.length;
  return (
    <div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="w-full h-24">
        {data.map((d, i) => {
          const h = (d.count / max) * 36;
          return (
            <rect
              key={d.iso}
              x={i * barWidth + barWidth * 0.15}
              y={40 - h}
              width={barWidth * 0.7}
              height={h}
              className="fill-slate-700 dark:fill-slate-300"
            >
              <title>{d.iso}: {d.count}</title>
            </rect>
          );
        })}
      </svg>
      <div className="grid mt-1" style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}>
        {data.map((d) => (
          <div key={d.iso} className="text-[9px] text-slate-400 text-center truncate" title={d.iso}>
            {d.iso.slice(5)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Format an ISO timestamp as e.g. "15 May, 14:23" for compact list rows.
 * Local-timezone formatting via Intl — same TZ the user's clock is in,
 * which matches their intuition.
 */
function fmtDateTimeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Group cases by a key, return counts sorted by frequency desc. */
function groupCount<T>(
  arr: T[],
  key: (t: T) => string,
): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const x of arr) {
    const k = key(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Array.from(m, ([k, count]) => ({ key: k, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Return last `weeks` weeks (Mon-anchored) with case counts. The week
 * a case falls into is determined by its created_at. Empty weeks are
 * included so the chart has a continuous x-axis.
 */
function weeklyCounts(
  cases: CsCaseWithLines[],
  weeks: number,
): { iso: string; count: number }[] {
  // Compute Monday-anchored weeks ending today (Sydney TZ would be ideal
  // but the small offset doesn't materially affect a 12-week view).
  const out: { iso: string; count: number }[] = [];
  const today = new Date();
  // Find Monday of this week.
  const dow = (today.getUTCDay() + 6) % 7; // 0 = Mon, 6 = Sun
  const monThisWeek = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - dow,
  ));
  for (let i = weeks - 1; i >= 0; i--) {
    const monStart = new Date(monThisWeek);
    monStart.setUTCDate(monStart.getUTCDate() - i * 7);
    const iso = monStart.toISOString().slice(0, 10);
    out.push({ iso, count: 0 });
  }
  // Bucket cases into those weeks.
  const isoSet = new Set(out.map((o) => o.iso));
  const byIso = new Map(out.map((o) => [o.iso, o]));
  for (const c of cases) {
    const created = new Date(c.created_at);
    const cdow = (created.getUTCDay() + 6) % 7;
    const mon = new Date(Date.UTC(
      created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate() - cdow,
    ));
    const iso = mon.toISOString().slice(0, 10);
    if (isoSet.has(iso)) byIso.get(iso)!.count++;
  }
  return out;
}

/**
 * "Most recent midnight in Sydney" expressed as a UTC instant.
 *
 * Used for the daily-archive rule on the CS Cases kanban: finished cases
 * (shipped/closed/denied) whose updated_at is before this instant are hidden
 * from the default view. The rule rolls over automatically at midnight AEST.
 *
 * Sydney observes DST (AEST = UTC+10, AEDT = UTC+11). We avoid hardcoding an
 * offset by formatting "now" in the Sydney timezone to get today's date,
 * then probing both candidate offsets to find the one whose UTC instant
 * formats back to "YYYY-MM-DD 00:00:00" in Sydney. The matching candidate
 * IS the answer.
 */
function lastSydneyMidnightUtc(): Date {
  const now = new Date();
  // 'sv-SE' locale gives ISO-ish "YYYY-MM-DD HH:mm:ss" output.
  const sydneyDateStr = now.toLocaleDateString("sv-SE", {
    timeZone: "Australia/Sydney",
  }); // e.g. "2026-05-16"

  for (const offsetMin of [600, 660]) {
    // 'YYYY-MM-DDT00:00:00Z' parsed as UTC, then shifted back by the candidate
    // offset, gives a moment that should read as midnight in Sydney.
    const candidate = new Date(
      Date.parse(`${sydneyDateStr}T00:00:00Z`) - offsetMin * 60_000,
    );
    const check = candidate.toLocaleString("sv-SE", {
      timeZone: "Australia/Sydney",
    });
    if (check === `${sydneyDateStr} 00:00:00`) return candidate;
  }
  // Fallback (should be unreachable): assume AEST (UTC+10).
  return new Date(Date.parse(`${sydneyDateStr}T00:00:00Z`) - 600 * 60_000);
}

/** ULID-ish ID — same format as other entities in the codebase. */
function nextId(): string {
  const ms = Date.now().toString().padStart(13, "0");
  const rand = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  return `${ms}-${rand}`;
}

/**
 * Auto-derive the department from the lines:
 *   - all unframed → 'unframed'
 *   - all framed   → 'framed' (includes A0 framed per business rule)
 *   - mixed        → 'framed'  (per business rule: any framed presence
 *                                routes the whole case to the framed team)
 *
 * Unframed detection mirrors the heuristic used in PaperUsage / SalesEntry:
 * short_code ending in U/P, or code/colour containing "unframed"/"print",
 * or supplier exactly "UNFRAMED".
 */
function deriveDepartment(
  lines: CsCaseLine[],
  products: Product[],
): "framed" | "unframed" | null {
  if (lines.length === 0) return null;
  let framed = 0, unframed = 0;
  for (const l of lines) {
    const p = products.find((pp) => pp.id === l.product_id);
    if (!p) continue;
    if (isUnframedProduct(p)) unframed++; else framed++;
  }
  if (unframed > 0 && framed === 0) return "unframed";
  // Any framed line (alone or mixed with unframed) → framed department.
  return "framed";
}

/**
 * Heuristic: is this product an "unframed" item (a print, no frame)?
 * Same logic shared by the SKU picker filter and the department derive,
 * so they stay in sync.
 */
function isUnframedProduct(p: Product): boolean {
  const supplier = (p.supplier ?? "").trim().toUpperCase();
  if (supplier === "UNFRAMED") return true;
  const sc = (p.short_code ?? "").toLowerCase();
  const hay = `${p.code} ${p.colour ?? ""}`.toLowerCase();
  return sc.endsWith("u") || sc.endsWith("p") || /unframed|print/.test(hay);
}

/**
 * Heuristic: is this product a CHINA-sourced framed item?
 * Strict match on supplier (case-insensitive) to keep the picker tight.
 */
function isChinaProduct(p: Product): boolean {
  return (p.supplier ?? "").trim().toUpperCase() === "CHINA";
}

