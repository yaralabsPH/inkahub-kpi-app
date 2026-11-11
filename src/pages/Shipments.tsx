import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Plus, CalendarDays, KanbanSquare, Trash2, X as XIcon, ShoppingCart,
  List as ListIcon, Search, Archive, ArchiveRestore, Download,
} from "lucide-react";
import { OrderBuilderModal } from "@/components/OrderBuilderModal";
import { useDataset } from "@/lib/hooks/useDataset";
import { useMutations } from "@/lib/hooks/useMutations";
import { useAppStore } from "@/lib/state/appStore";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Input";
import { addDays, diffDays, todayIso } from "@/lib/utils/dates";
import { fmtNum, fmtShortDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import {
  type IncomingShipment, type ShipmentLine,
  IncomingShipmentSchema, ShipmentStatus, shipmentTotalUnits,
  type ShipmentAccounts, type PaymentStatus, PaymentStatusValues, PAYMENT_STATUS_LABELS,
  type SupplierSettings, STANDARD_PAYMENT_TERMS, formatTermsLabel, computeDueDate, isShipmentOverdue,
  type ShipmentInvoiceFile, ALLOWED_INVOICE_MIME_TYPES, MAX_INVOICE_FILE_SIZE_BYTES,
} from "@/lib/domain";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import * as XLSX from "xlsx";

/** Status values that can be archived — terminal states only. */
const ARCHIVABLE_STATUSES: ReadonlySet<string> = new Set(["Delivered", "Cancelled"]);

const COLUMNS = [
  "Draft", "Ordered", "Back-Ordered", "In Production", "In Transit", "Customs", "Delivered", "On hold", "Cancelled",
] as const;

export function Shipments() {
  const { data } = useDataset();
  const m = useMutations();
  // === accounts tracking ===
  const auth = useAuthOptional();
  const isOwner = auth?.profile?.role === "owner";
  const isSupabase = getBackendMode() === "supabase";
  const location = useAppStore((st) => st.location);
  const [accountsMap, setAccountsMap] = useState<Map<string, ShipmentAccounts>>(new Map());
  const [supplierSettingsMap, setSupplierSettingsMap] = useState<Map<string, SupplierSettings>>(new Map());
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  // === overdue filter ===
  // Mirrors the Dashboard "Recent activity > Invoices overdue (>30d)" tile
  // definition: unpaid + order_placed_date > 30d ago + invoice_amount > 0.
  // Can be deep-linked via ?filter=overdue (see useEffect below).
  const [overdueOnly, setOverdueOnly] = useState(false);
  useEffect(() => {
    if (!isOwner || !isSupabase) {
      setAccountsMap(new Map());
      return;
    }
    const supabase = getSupabase();
    let cancelled = false;
    (async () => {
      const { data: rows, error } = await supabase
        .from("shipment_accounts")
        .select("*")
        .eq("location", location);
      if (cancelled) return;
      if (error) { console.error("accounts fetch", error); return; }
      const next = new Map<string, ShipmentAccounts>();
      for (const r of (rows ?? []) as ShipmentAccounts[]) next.set(r.shipment_id, r);
      setAccountsMap(next);
    })();
    return () => { cancelled = true; };
  }, [isOwner, isSupabase, location]);
  useEffect(() => {
    if (!isOwner || !isSupabase) {
      setSupplierSettingsMap(new Map());
      return;
    }
    const supabase = getSupabase();
    let cancelled = false;
    (async () => {
      const { data: rows, error } = await supabase
        .from("supplier_settings")
        .select("*")
        .eq("location", location);
      if (cancelled) return;
      if (error) { console.error("supplier_settings fetch", error); return; }
      const next = new Map<string, SupplierSettings>();
      for (const r of (rows ?? []) as SupplierSettings[]) next.set(r.supplier_name, r);
      setSupplierSettingsMap(next);
    })();
    return () => { cancelled = true; };
  }, [isOwner, isSupabase, location]);
  const saveAccounts = async (shipmentId: string, patch: Partial<ShipmentAccounts>) => {
    if (!isOwner || !isSupabase) return;
    const supabase = getSupabase();
    const existing = accountsMap.get(shipmentId);
    const next: ShipmentAccounts = {
      location,
      shipment_id: shipmentId,
      supplier_invoice_number: existing?.supplier_invoice_number ?? null,
      invoice_amount: existing?.invoice_amount ?? null,
      invoice_currency: existing?.invoice_currency ?? "AUD",
      invoice_received_date: existing?.invoice_received_date ?? null,
      payment_status: existing?.payment_status ?? "unpaid",
      payment_date: existing?.payment_date ?? null,
      payment_reference: existing?.payment_reference ?? null,
      accounts_notes: existing?.accounts_notes ?? null,
      payment_terms_days: existing?.payment_terms_days ?? null,
      payment_terms_eom: existing?.payment_terms_eom ?? false,
      ...patch,
    };
    const { error } = await supabase.from("shipment_accounts").upsert(next);
    if (error) { console.error("accounts upsert", error); return; }
    setAccountsMap((m2) => new Map(m2).set(shipmentId, next));
  };
  // View has three modes now — Kanban (drag-drop), List (sortable table),
  // Calendar (12-week rollup). Filters apply to all three.
  const [view, setView] = useState<"kanban" | "list" | "calendar">("kanban");
  const [editing, setEditing] = useState<IncomingShipment | null>(null);
  const [creating, setCreating] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [orderBuilderOpen, setOrderBuilderOpen] = useState(false);
  const [orderBuilderShipmentId, setOrderBuilderShipmentId] = useState<string | null>(null);
  const [supplierFilter, setSupplierFilter] = useState<string>("all");
  // Multi-select status filter. Empty set = no constraint (all statuses).
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  // Free-text search (PO #, supplier, SKU codes on lines, notes).
  const [searchQuery, setSearchQuery] = useState("");
  // Date range on expected_arrival_date. Empty = unbounded on that side.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Archived shipments hidden by default. Tick to bring them back.
  const [showArchived, setShowArchived] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * Deep-link from the dashboard / other pages: `/shipments?edit=<id>` opens
   * the ShipmentForm for that shipment, then strips the param so a refresh
   * doesn't keep re-opening it. Re-runs whenever the dataset finishes loading
   * so the param survives the initial useDataset round-trip.
   */
  useEffect(() => {
    const editId = searchParams.get("edit");
    if (!editId || !data) return;
    const target = data.shipments.find((s) => s.id === editId);
    if (target) {
      setEditing(target);
      const next = new URLSearchParams(searchParams);
      next.delete("edit");
      setSearchParams(next, { replace: true });
    }
  }, [data, searchParams, setSearchParams]);

  // === deep link: view + filter ===
  // Allow ?view=list|kanban|calendar and ?filter=overdue from other
  // pages (e.g. the Dashboard Recent activity tiles). Strip the params
  // afterwards so a refresh doesn't keep re-applying them.
  useEffect(() => {
    const viewParam = searchParams.get("view");
    const filterParam = searchParams.get("filter");
    if (!viewParam && !filterParam) return;
    if (viewParam === "list" || viewParam === "kanban" || viewParam === "calendar") {
      setView(viewParam);
    }
    if (filterParam === "overdue") {
      setOverdueOnly(true);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("view");
    next.delete("filter");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  // Distinct supplier list, derived from existing shipments + SKUs.
  const allSuppliers = Array.from(new Set([
    ...data.shipments.map((s) => s.supplier),
    ...data.products.map((p) => p.supplier),
  ].filter(Boolean))).sort();

  // Combined filter pipeline. Each predicate is cheap; we evaluate in
  // order of selectivity (archived → status → supplier → date → search)
  // so the hot rows drop out early.
  const productCodeById = new Map(data.products.map((p) => [p.id, p.code]));
  const q = searchQuery.trim().toLowerCase();
  const visibleShipments = data.shipments.filter((s) => {
    // 1) Archive gate — hide archived rows unless the toggle is on.
    if (!showArchived && s.archived) return false;
    // === unpaid filter ===
    // Anything not explicitly marked "paid" qualifies as unpaid. Works for
    // shipments without an accounts row yet (treated as unpaid) and any
    // status (Ordered / Delivered / etc).
    if (unpaidOnly) {
      const acc = accountsMap.get(s.id);
      if (acc && acc.payment_status === "paid") return false;
    }
    // === overdue filter ===
    if (overdueOnly) {
      const acc = accountsMap.get(s.id);
      const paid = acc?.payment_status === "paid";
      const amount = acc?.invoice_amount ?? 0;
      if (paid || amount <= 0 || !s.order_placed_date) return false;
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      if (s.order_placed_date > cutoff) return false;
    }
    // 2) Status multi-select. Empty set = no constraint.
    if (statusFilter.size > 0 && !statusFilter.has(s.status)) return false;
    // 3) Supplier (single-select dropdown).
    if (supplierFilter !== "all" && s.supplier !== supplierFilter) return false;
    // 4) Date range — filters expected_arrival_date.
    if (dateFrom && s.expected_arrival_date < dateFrom) return false;
    if (dateTo && s.expected_arrival_date > dateTo) return false;
    // 5) Search — PO #, supplier, SKU codes on lines, notes.
    if (q) {
      const codes = s.lines
        .map((l) => productCodeById.get(l.product_id) ?? "")
        .join(" ");
      const haystack = [
        s.po_number, s.supplier, codes, s.notes ?? "",
      ].join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  // How many archived rows are hidden by the current filter set? Used to
  // render the small "X archived hidden" hint so the operator doesn't
  // wonder where finished shipments went.
  const archivedHiddenCount = showArchived
    ? 0
    : data.shipments.filter((s) => {
        if (!s.archived) return false;
        if (statusFilter.size > 0 && !statusFilter.has(s.status)) return false;
        if (supplierFilter !== "all" && s.supplier !== supplierFilter) return false;
        return true;
      }).length;

  const anyFilterActive =
    statusFilter.size > 0
    || supplierFilter !== "all"
    || q !== ""
    || dateFrom !== ""
    || dateTo !== ""
    || overdueOnly
    || showArchived;

  const clearFilters = () => {
    setSearchQuery("");
    setStatusFilter(new Set());
    setSupplierFilter("all");
    setDateFrom("");
    setDateTo("");
    setShowArchived(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Shipments</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {visibleShipments.length} of {data.shipments.length} shown
            {archivedHiddenCount > 0 ? ` · ${archivedHiddenCount} archived hidden` : ""}.
            {" "}Drag cards between columns (Kanban) or click a row (List) to edit.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* View toggle — three modes */}
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-700 p-0.5 flex">
            <button
              className={cn(
                "px-2.5 h-7 rounded text-xs flex items-center gap-1 transition",
                view === "kanban"
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800",
              )}
              onClick={() => setView("kanban")}>
              <KanbanSquare size={14} /> Kanban
            </button>
            <button
              className={cn(
                "px-2.5 h-7 rounded text-xs flex items-center gap-1 transition",
                view === "list"
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800",
              )}
              onClick={() => setView("list")}>
              <ListIcon size={14} /> List
            </button>
            <button
              className={cn(
                "px-2.5 h-7 rounded text-xs flex items-center gap-1 transition",
                view === "calendar"
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800",
              )}
              onClick={() => setView("calendar")}>
              <CalendarDays size={14} /> Calendar
            </button>
          </div>
          <Button size="sm" onClick={() => { setOrderBuilderShipmentId(null); setOrderBuilderOpen(true); }}>
            <ShoppingCart size={14} /> Place supplier order
          </Button>
          
            {/* === export accounts CSV === */}
            {isOwner ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => exportAccountsCsv(visibleShipments, accountsMap, data?.products ?? [])}
                title="Download accounts/payment data as CSV for the active filter set"
              >
                Export accounts
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            <Plus size={14} /> New shipment
          </Button>
        </div>
      </div>

      {/* Filter row — applies to Kanban, List, and Calendar simultaneously. */}
      <div className="rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 bg-white/40 dark:bg-slate-900/40 px-3 py-2 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative flex-1 min-w-[240px]">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search PO #, supplier, SKU code, notes…"
              className="w-full h-8 pl-7 pr-3 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
            />
          </div>

          {/* Supplier */}
          <select
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
            aria-label="Filter by supplier"
            className="h-8 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
          >
            <option value="all">All suppliers</option>
            {allSuppliers.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>

          {/* Date range — expected_arrival */}
          <div
            className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300"
            title="Filter by expected arrival date"
          >
            <span className="text-slate-500">Arriving</span>
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

          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer ml-auto select-none">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded"
            />
            Show archived
          </label>
              {/* === unpaid filter chip === */}
              {isOwner ? (
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs text-slate-600 dark:text-slate-300 ml-3">
                  <input
                    type="checkbox"
                    checked={unpaidOnly}
                    onChange={(e) => setUnpaidOnly(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  Unpaid only
                </label>
              ) : null}

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

        {/* Status pills — multi-select. Click to toggle each status. */}
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-slate-500 mr-1">Status:</span>
          {ShipmentStatus.options.map((s) => {
            const active = statusFilter.has(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter((prev) => {
                  const next = new Set(prev);
                  if (next.has(s)) next.delete(s); else next.add(s);
                  return next;
                })}
                className={cn(
                  "px-2 h-6 rounded ring-1 transition",
                  active
                    ? "bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:ring-slate-100"
                    : "ring-slate-300 dark:ring-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800",
                )}
              >
                {s}
              </button>
            );
          })}
          {statusFilter.size > 0 ? (
            <button
              type="button"
              onClick={() => setStatusFilter(new Set())}
              className="text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 ml-1"
            >
              all
            </button>
          ) : null}
        </div>
      </div>

      {view === "list" ? (
        <ListView
          shipments={visibleShipments}
          products={data.products}
          onSelect={setEditing}
          onToggleArchive={(s) => m.upsertShipment.mutate({ ...s, archived: !s.archived })}
        />
      ) : view === "kanban" ? (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {COLUMNS.map((col) => {
            const cards = visibleShipments.filter((s) => s.status === col);
            return (
              <div
                key={col}
                className="rounded-xl bg-slate-100 dark:bg-slate-900/40 ring-1 ring-slate-200 dark:ring-slate-800 min-h-[200px] flex flex-col"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (!draggingId) return;
                  const ship = data.shipments.find((s) => s.id === draggingId);
                  if (!ship || ship.status === col) return;
                  const updated: IncomingShipment = { ...ship, status: col };
                  if (col === "Delivered" && !ship.actual_arrival_date) {
                    updated.actual_arrival_date = todayIso();
                  }
                  m.upsertShipment.mutate(updated);
                  setDraggingId(null);
                }}>
                <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-600 dark:text-slate-400 font-semibold flex items-center justify-between">
                  <span>{col}</span>
                  <span className="rounded-full px-1.5 bg-slate-200 dark:bg-slate-800 text-[10px]">
                    {cards.length}
                  </span>
                </div>
                <div className="px-2 pb-2 space-y-2 flex-1">
                  {cards.map((s) => (
                    <ShipmentCard
                      accountsRow={accountsMap.get(s.id)}
                      supplierSettings={supplierSettingsMap.get(s.supplier)}
                      key={s.id}
                      shipment={s}
                      products={data.products}
                      onClick={() => setEditing(s)}
                      onDragStart={() => setDraggingId(s.id)} />
                  ))}
                  {cards.length === 0 ? (
                    <div className="text-[11px] text-slate-400 italic px-1 py-2">Drop cards here</div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <CalendarView shipments={visibleShipments} products={data.products} onClick={setEditing} />
      )}

      <ShipmentFormModal
        open={creating || !!editing}
        shipment={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSave={async (s) => {
          await m.upsertShipment.mutateAsync(s);
          setCreating(false); setEditing(null);
        }}
        onDelete={editing ? async () => {
          if (!window.confirm(`Delete ${editing.po_number}?`)) return;
          await m.deleteShipment.mutateAsync(editing.id);
          setEditing(null);
        } : undefined}
        onToggleArchive={editing && ARCHIVABLE_STATUSES.has(editing.status) ? async () => {
          await m.upsertShipment.mutateAsync({ ...editing, archived: !editing.archived });
          setEditing(null);
        } : undefined}
        onTopUp={editing ? () => {
          setOrderBuilderShipmentId(editing.id);
          setEditing(null);
          setOrderBuilderOpen(true);
        } : undefined}
          location={location}
          accountsRow={accountsMap.get(editing?.id ?? "")}
          supplierSettings={supplierSettingsMap.get(editing?.supplier ?? "")}
          isOwner={isOwner}
          onSaveAccounts={editing ? (patch) => saveAccounts(editing.id, patch) : undefined}
                />

      <OrderBuilderModal
        open={orderBuilderOpen}
        onClose={() => { setOrderBuilderOpen(false); setOrderBuilderShipmentId(null); }}
        editingShipmentId={orderBuilderShipmentId}
      />
    </div>
  );
}

/**
 * Owner-only CSV export tuned for accounts reconciliation.
 * One row per shipment in the current filter set. Columns chosen to make
 * matching to supplier invoices straightforward.
 */
function exportAccountsCsv(
  shipments: IncomingShipment[],
  accountsMap: Map<string, ShipmentAccounts>,
  _products: { id: string; code: string }[],
) {
  const headers = [
    "PO number","Supplier","Status","Order placed","Expected arrival","Actual arrival",
    "Delivered at","Invoice #","Invoice amount","Currency","Invoice received",
    "Payment status","Payment date","Payment reference","Days since delivery","Accounts notes",
  ];
  const today = Date.now();
  const rows = shipments.map((sh) => {
    const acc = accountsMap.get(sh.id);
    const daysSince = sh.delivered_at
      ? Math.floor((today - Date.parse(sh.delivered_at)) / 86400000)
      : "";
    return [
      sh.po_number, sh.supplier, sh.status,
      sh.order_placed_date ?? "", sh.expected_arrival_date ?? "", sh.actual_arrival_date ?? "",
      sh.delivered_at ?? "",
      acc?.supplier_invoice_number ?? "",
      acc?.invoice_amount != null ? String(acc.invoice_amount) : "",
      acc?.invoice_currency ?? "",
      acc?.invoice_received_date ?? "",
      acc?.payment_status ? PAYMENT_STATUS_LABELS[acc.payment_status] : "",
      acc?.payment_date ?? "",
      acc?.payment_reference ?? "",
      String(daysSince),
      (acc?.accounts_notes ?? "").replace(/[\r\n]+/g, " "),
    ];
  });
  const csv = [headers, ...rows].map((r) =>
    r.map((c) => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c)).join(",")
  ).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `accounts_export_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ShipmentCard({
  shipment, products, onClick, onDragStart, accountsRow, supplierSettings,
}: {
  shipment: IncomingShipment;
  products: { id: string; code: string }[];
  onClick: () => void;
  onDragStart: () => void;
  accountsRow?: ShipmentAccounts;
  supplierSettings?: SupplierSettings;
}) {
  const today = todayIso();
  const arrival = shipment.actual_arrival_date ?? shipment.expected_arrival_date;
  const days = diffDays(today, arrival);
  const transitFrac =
    shipment.transit_started_date && shipment.expected_arrival_date
      ? clamp(
          (Date.parse(today) - Date.parse(shipment.transit_started_date)) /
            Math.max(
              Date.parse(shipment.expected_arrival_date) - Date.parse(shipment.transit_started_date),
              1,
            ),
          0, 1,
        )
      : null;
  const totalUnits = shipmentTotalUnits(shipment);

  return (
    <div draggable onDragStart={onDragStart} onClick={onClick}
      className="cursor-pointer rounded-md bg-white dark:bg-slate-900 ring-1 ring-slate-200 dark:ring-slate-800 p-2 hover:ring-slate-400 transition">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {shipment.po_number}
        </div>
        <div className="text-[10px] text-slate-500">
          {shipment.lines.length} SKU{shipment.lines.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">
        {shipment.lines
          .map((l) => products.find((p) => p.id === l.product_id)?.code ?? "?")
          .slice(0, 3)
          .join(", ")}
        {shipment.lines.length > 3 ? `, +${shipment.lines.length - 3}` : ""}
      </div>
      <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
        {fmtNum(totalUnits)} units · {shipment.supplier}
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px]">
        <span className="text-slate-500">{fmtShortDate(arrival)}</span>
        <span className={
          days < 0 ? "text-red-600 dark:text-red-400"
          : days <= 7 ? "text-amber-600 dark:text-amber-400" : "text-slate-500"
        }>
          {days < 0 ? `${Math.abs(days)}d late` : days === 0 ? "today" : `${days}d`}
        </span>
      </div>
      {transitFrac !== null ? (
        <div className="mt-1 h-1 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
          <div className="h-full bg-blue-500" style={{ width: `${Math.round(transitFrac * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function CalendarView({
  shipments, products, onClick,
}: {
  shipments: IncomingShipment[];
  products: { id: string; code: string }[];
  onClick: (s: IncomingShipment) => void;
}) {
  const today = todayIso();
  const weeks: { weekStart: string; ships: IncomingShipment[] }[] = [];
  for (let i = 0; i < 12; i++) {
    const ws = addDays(today, i * 7); const we = addDays(ws, 6);
    weeks.push({
      weekStart: ws,
      ships: shipments.filter((s) => {
        const d = s.actual_arrival_date ?? s.expected_arrival_date;
        return d >= ws && d <= we;
      }),
    });
  }
  return (
    <Card>
      <CardBody className="p-0">
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 divide-x divide-y divide-slate-100 dark:divide-slate-800">
          {weeks.map((w) => (
            <div key={w.weekStart} className="p-3 min-h-[110px]">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                {fmtShortDate(w.weekStart)}
              </div>
              <div className="space-y-1">
                {w.ships.length === 0 ? (
                  <div className="text-[11px] text-slate-400 italic">No arrivals</div>
                ) : (
                  w.ships.map((s) => (
                    <button key={s.id} onClick={() => onClick(s)}
                      className="w-full text-left rounded ring-1 ring-slate-200 dark:ring-slate-800 px-2 py-1 hover:ring-slate-400 text-xs">
                      <div className="font-semibold">{s.po_number}</div>
                      <div className="text-slate-500">
                        {s.lines.length} SKU · {fmtNum(shipmentTotalUnits(s))} · {s.status}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Build a supplier-facing purchase-order .xlsx from a shipment + product
 * catalogue, then trigger a browser download. Sheet structure:
 *
 *   Row 1     Header banner "PURCHASE ORDER" (bold)
 *   Rows 3-9  Key / value metadata (PO number, supplier, dates, status, notes)
 *   Row 11    Line-items table header (#, SKU, Title, Size, Colour, Qty)
 *   Rows 12+  One line per ShipmentLine, joined to products by id
 *   Last row  TOTAL UNITS
 *
 * Lines referencing unknown product_ids still appear (SKU shown as the raw
 * id, other columns empty), so the file always reflects what was actually
 * ordered.
 */
function exportShipmentToXlsx(
  shipment: IncomingShipment,
  products: { id: string; code: string; title?: string | null; size?: string | null; colour?: string | null }[],
) {
  const productById = new Map(products.map((p) => [p.id, p]));
  const lines = shipment.lines && shipment.lines.length > 0
    ? shipment.lines
    : (shipment.product_id && shipment.quantity
        ? [{ product_id: shipment.product_id, quantity: shipment.quantity }]
        : []);
  const totalUnits = lines.reduce((s, l) => s + (l.quantity ?? 0), 0);

  const rows: (string | number | null)[][] = [];
  rows.push(["PURCHASE ORDER"]);
  rows.push([]);
  rows.push(["PO number",        shipment.po_number]);
  rows.push(["Supplier",         shipment.supplier]);
  rows.push(["Order placed",     shipment.order_placed_date ?? ""]);
  rows.push(["Expected arrival", shipment.expected_arrival_date ?? ""]);
  rows.push(["Transit started",  shipment.transit_started_date ?? ""]);
  rows.push(["Status",           shipment.status]);
  rows.push(["Notes",            shipment.notes ?? ""]);
  rows.push([]);
  rows.push(["#", "SKU", "Title", "Size", "Colour", "Quantity"]);
  lines.forEach((line, i) => {
    const p = productById.get(line.product_id);
    rows.push([
      i + 1,
      p?.code ?? line.product_id,
      p?.title ?? "",
      p?.size ?? "",
      p?.colour ?? "",
      line.quantity,
    ]);
  });
  rows.push([]);
  rows.push(["", "", "", "", "TOTAL UNITS", totalUnits]);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  // Column widths tuned for readability in the supplier inbox.
  ws["!cols"] = [
    { wch: 4 },   // #
    { wch: 22 },  // SKU
    { wch: 38 },  // Title
    { wch: 10 },  // Size
    { wch: 14 },  // Colour
    { wch: 10 },  // Quantity
  ];
  // Merge the title banner across the first 6 columns.
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Purchase Order");

  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const filename = `PO_${safe(shipment.po_number)}_${safe(shipment.supplier)}_${shipment.order_placed_date ?? "draft"}.xlsx`;
  XLSX.writeFile(wb, filename);
}


/**
 * Build a supplier-facing purchase-order PDF and trigger download.
 * Mirrors the XLSX exporter visually, but laid out for printing /
 * email attachment (single A4 page when lines fit).
 *
 * Logo handling:
 *   1. Tries to fetch /inka-arthouse-logo.png (Vite serves /public at the root).
 *   2. If present, embeds it at the top-right.
 *   3. If absent or fetch fails, falls back to bold "INKA ARTHOUSE" text.
 *
 * jspdf + jspdf-autotable must be installed (npm install jspdf jspdf-autotable).
 * Both are dynamically imported so the chunk only loads on first PDF export.
 */
async function exportShipmentToPdf(
  shipment: IncomingShipment,
  products: { id: string; code: string; title?: string | null; size?: string | null; colour?: string | null }[],
) {
  const { default: jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const productById = new Map(products.map((p) => [p.id, p]));
  const lines = shipment.lines && shipment.lines.length > 0
    ? shipment.lines
    : (shipment.product_id && shipment.quantity
        ? [{ product_id: shipment.product_id, quantity: shipment.quantity }]
        : []);
  const totalUnits = lines.reduce((s, l) => s + (l.quantity ?? 0), 0);

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();

  // ---- Logo (top right) ----
  let logoLoaded = false;
  try {
    const res = await fetch("/inka-arthouse-logo.png");
    if (res.ok) {
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      // Logo dimensions tuned for ~40mm wide x auto-ish height in top-right.
      // Load image natural dims then fit inside max box (45mm x 22mm).
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = dataUrl;
      });
      const maxW = 52;
      const maxH = 24;
      const ratio = img.naturalWidth / img.naturalHeight;
      let logoW = maxW;
      let logoH = logoW / ratio;
      if (logoH > maxH) {
        logoH = maxH;
        logoW = logoH * ratio;
      }
      doc.addImage(dataUrl, "PNG", pageW - logoW - 10, 8, logoW, logoH);
      logoLoaded = true;
    }
  } catch {
    // Network or fetch error -- fall back to text brand below.
  }
  if (!logoLoaded) {
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("INKA ARTHOUSE", pageW - 10, 18, { align: "right" });
  }

  // ---- Title ----
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("PURCHASE ORDER", 14, 22);

  // ---- Metadata block ----
  let y = 34;
  const meta: [string, string][] = [
    ["PO number",        shipment.po_number],
    ["Supplier",         shipment.supplier],
    ["Order placed",     shipment.order_placed_date ?? ""],
    ["Expected arrival", shipment.expected_arrival_date ?? ""],
    ["Transit started",  shipment.transit_started_date ?? ""],
    ["Status",           shipment.status],
  ];
  doc.setFontSize(10);
  for (const [k, v] of meta) {
    doc.setFont("helvetica", "bold");
    doc.text(k + ":", 14, y);
    doc.setFont("helvetica", "normal");
    doc.text(String(v ?? ""), 50, y);
    y += 6;
  }

  // ---- Line items table ----
  const tableBody = lines.map((line, i) => {
    const p = productById.get(line.product_id);
    return [
      String(i + 1),
      p?.code ?? line.product_id,
      p?.title ?? "",
      p?.size ?? "",
      p?.colour ?? "",
      String(line.quantity),
    ];
  });
  autoTable(doc, {
    head: [["#", "SKU", "Title", "Size", "Colour", "Qty"]],
    body: tableBody,
    startY: y + 4,
    styles: { fontSize: 9, cellPadding: 2 },
    headStyles: { fillColor: [15, 23, 42], textColor: 255 },
    columnStyles: {
      0: { halign: "right", cellWidth: 8 },
      5: { halign: "right", cellWidth: 18 },
    },
  });

  // ---- Total + Notes ----
  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? (y + 10);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("TOTAL UNITS: " + totalUnits, pageW - 14, finalY + 8, { align: "right" });

  if (shipment.notes && shipment.notes.trim()) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("Notes:", 14, finalY + 20);
    doc.setFont("helvetica", "normal");
    const noteLines = doc.splitTextToSize(shipment.notes, pageW - 28);
    doc.text(noteLines, 14, finalY + 26);
  }

  // ---- Save ----
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const filename = `PO_${safe(shipment.po_number)}_${safe(shipment.supplier)}_${shipment.order_placed_date ?? "draft"}.pdf`;
  doc.save(filename);
}
/**
 * Local-state Accounts editor. Holds a draft of the row so typing is
 * always responsive; flushes to the network onBlur. If the upsert fails
 * (RLS denies, table missing, etc.) the draft sticks around so the user
 * doesn't lose their work and can see they've typed.
 */
/**
 * Invoice attachments for a shipment. Owner-only.
 *
 * Lists files from shipment_invoice_files for this (location, shipment).
 * Each row is a clickable filename that opens a short-lived signed URL
 * in a new tab. Owner can upload PDF/JPEG/PNG up to 10 MB each, and
 * delete attachments.
 *
 * Files live in the `shipment-invoices` Storage bucket under the path
 * `{location}/{shipment_id}/{file_id}_{name}`.
 */
function InvoiceAttachments({
  supabase,
  location,
  shipmentId,
}: {
  supabase: ReturnType<typeof getSupabase>;
  location: string;
  shipmentId: string;
}) {
  const [files, setFiles] = useState<ShipmentInvoiceFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from("shipment_invoice_files")
        .select("*")
        .eq("location", location)
        .eq("shipment_id", shipmentId)
        .order("uploaded_at", { ascending: false });
      if (err) throw err;
      setFiles((data ?? []) as ShipmentInvoiceFile[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [supabase, location, shipmentId]);

  useEffect(() => { void refetch(); }, [refetch]);

  const handleUpload = async (file: File) => {
    setError(null);
    if (file.size > MAX_INVOICE_FILE_SIZE_BYTES) {
      setError(`File is too large. Max 10 MB.`);
      return;
    }
    if (!ALLOWED_INVOICE_MIME_TYPES.includes(file.type as typeof ALLOWED_INVOICE_MIME_TYPES[number])) {
      setError("Only PDF, JPEG, or PNG files are allowed.");
      return;
    }
    setUploading(true);
    try {
      const fileId = crypto.randomUUID();
      // Sanitise filename for storage path - keep extension, strip path
      // separators and weird chars.
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const path = `${location}/${shipmentId}/${fileId}_${safeName}`;
      const { error: upErr } = await supabase.storage
        .from("shipment-invoices")
        .upload(path, file, { contentType: file.type });
      if (upErr) throw upErr;
      const { error: insErr } = await supabase
        .from("shipment_invoice_files")
        .insert([{
          id: fileId,
          location,
          shipment_id: shipmentId,
          file_path: path,
          original_name: file.name,
          mime_type: file.type,
          file_size: file.size,
        }]);
      if (insErr) {
        // Roll back the storage object so we don't leak orphaned files.
        await supabase.storage.from("shipment-invoices").remove([path]);
        throw insErr;
      }
      await refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (f: ShipmentInvoiceFile) => {
    setError(null);
    try {
      const { data, error: err } = await supabase.storage
        .from("shipment-invoices")
        .createSignedUrl(f.file_path, 60);
      if (err) throw err;
      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDelete = async (f: ShipmentInvoiceFile) => {
    if (!window.confirm(`Delete "${f.original_name}"? This cannot be undone.`)) return;
    setError(null);
    try {
      const { error: rmErr } = await supabase.storage
        .from("shipment-invoices")
        .remove([f.file_path]);
      if (rmErr) console.warn("storage remove warning", rmErr);
      const { error: delErr } = await supabase
        .from("shipment_invoice_files")
        .delete()
        .eq("id", f.id);
      if (delErr) throw delErr;
      await refetch();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div
      className="col-span-2 mt-3 rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 p-3 space-y-2"
      style={{ isolation: "isolate", contain: "layout paint" }}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">
          Invoice attachments
        </div>
        <label className={
          uploading
            ? "inline-flex items-center gap-1 text-xs px-2 h-7 rounded ring-1 ring-slate-200 dark:ring-slate-700 text-slate-400 cursor-wait"
            : "inline-flex items-center gap-1 text-xs px-2 h-7 rounded ring-1 ring-emerald-300 dark:ring-emerald-700 bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200 hover:bg-emerald-100 cursor-pointer"
        }>
          {uploading ? "Uploading..." : "+ Attach file"}
          <input
            type="file"
            className="sr-only"
            accept=".pdf,application/pdf,.jpg,.jpeg,image/jpeg,.png,image/png"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <div className="text-[11px] text-slate-500">
        PDF, JPEG, PNG. 10 MB max per file. Files are owner-only.
      </div>
      {error ? (
        <div className="text-xs text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded px-2 py-1 dark:bg-rose-900/20 dark:text-rose-300 dark:ring-rose-800">
          {error}
        </div>
      ) : null}
      {loading && files.length === 0 ? (
        <div className="text-xs text-slate-500 italic">Loading...</div>
      ) : files.length === 0 ? (
        <div className="text-xs text-slate-500 italic">No files attached yet.</div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {files.map((f) => (
            <li key={f.id} className="flex items-center justify-between py-1.5 gap-2">
              <button
                type="button"
                onClick={() => void handleDownload(f)}
                className="text-xs text-blue-700 dark:text-blue-300 hover:underline truncate text-left min-w-0 flex-1"
                title={f.original_name}
              >
                {f.original_name}
              </button>
              <span className="text-[11px] text-slate-400 tabular-nums shrink-0">
                {f.file_size != null ? Math.round(f.file_size / 1024) + " KB" : "--"}
              </span>
              <button
                type="button"
                onClick={() => void handleDelete(f)}
                className="text-[11px] text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 underline"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function AccountsSection({
  shipment,
  accountsRow,
  supplierSettings,
  onSaveAccounts,
  supabase,
  location,
}: {
  shipment: IncomingShipment;
  accountsRow?: ShipmentAccounts;
  supplierSettings?: SupplierSettings;
  onSaveAccounts?: (patch: Partial<ShipmentAccounts>) => Promise<void> | void;
  supabase: ReturnType<typeof getSupabase>;
  location: string;
}) {
  const [draft, setDraft] = useState<Partial<ShipmentAccounts>>({});
  // Reset draft when the modal switches to a different shipment.
  useEffect(() => {
    setDraft({});
  }, [shipment.id]);

  // The displayed value falls back through:
  //   1. local draft (user typed)
  //   2. row from server
  //   3. sensible default
  const v = <K extends keyof ShipmentAccounts>(key: K): ShipmentAccounts[K] | "" => {
    if (draft[key] !== undefined) return draft[key] as ShipmentAccounts[K];
    if (accountsRow?.[key] !== undefined && accountsRow[key] !== null) return accountsRow[key] as ShipmentAccounts[K];
    return "" as ShipmentAccounts[K];
  };

  const setLocal = (patch: Partial<ShipmentAccounts>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  const flush = (patch: Partial<ShipmentAccounts>) => {
    if (!onSaveAccounts) return;
    void onSaveAccounts(patch);
  };

  const status = (draft.payment_status ?? accountsRow?.payment_status ?? "unpaid") as PaymentStatus;
  const statusPillCls =
    status === "paid"
      ? "ml-2 inline-flex items-center rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-medium px-2 py-0.5 dark:bg-emerald-900/30 dark:text-emerald-200"
      : status === "disputed"
      ? "ml-2 inline-flex items-center rounded-full bg-rose-100 text-rose-800 text-[10px] font-medium px-2 py-0.5 dark:bg-rose-900/30 dark:text-rose-200"
      : "ml-2 inline-flex items-center rounded-full bg-amber-100 text-amber-800 text-[10px] font-medium px-2 py-0.5 dark:bg-amber-900/30 dark:text-amber-200";

  return (
    <details className="col-span-2 mt-2 rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-slate-50/40 dark:bg-slate-900/20">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 select-none">
        Accounts (owner only)
        <span className={statusPillCls}>{PAYMENT_STATUS_LABELS[status]}</span>
        {shipment.delivered_at ? (
          <span className="ml-2 text-[11px] text-slate-500">
            Delivered {new Date(shipment.delivered_at).toLocaleDateString()}
          </span>
        ) : null}
      </summary>
      <div className="px-3 pb-3 grid grid-cols-2 gap-3">
        <Field label="Supplier invoice #">
          <Input
            value={v("supplier_invoice_number") as string}
            onChange={(e) => setLocal({ supplier_invoice_number: e.target.value || null })}
            onBlur={(e) => flush({ supplier_invoice_number: e.target.value || null })}
            placeholder="INV-12345"
          />
        </Field>
        <Field label="Invoice received">
          <Input
            type="date"
            value={v("invoice_received_date") as string}
            onChange={(e) => setLocal({ invoice_received_date: e.target.value || null })}
            onBlur={(e) => flush({ invoice_received_date: e.target.value || null })}
          />
        </Field>
        <Field label="Invoice amount">
          <Input
            type="number"
            step="0.01"
            value={v("invoice_amount") as number | ""}
            onChange={(e) => setLocal({ invoice_amount: e.target.value === "" ? null : Number(e.target.value) })}
            onBlur={(e) => flush({ invoice_amount: e.target.value === "" ? null : Number(e.target.value) })}
            placeholder="0.00"
          />
        </Field>
        <Field label="Payment status">
          <Select
            value={status}
            onChange={(e) => {
              const next = e.target.value as PaymentStatus;
              setLocal({ payment_status: next });
              flush({ payment_status: next });
            }}
          >
            {PaymentStatusValues.map((pv) => (
              <option key={pv} value={pv}>{PAYMENT_STATUS_LABELS[pv]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Payment date">
          <Input
            type="date"
            value={v("payment_date") as string}
            onChange={(e) => setLocal({ payment_date: e.target.value || null })}
            onBlur={(e) => flush({ payment_date: e.target.value || null })}
          />
        </Field>
        <Field label="Payment reference">
          <Input
            value={v("payment_reference") as string}
            onChange={(e) => setLocal({ payment_reference: e.target.value || null })}
            onBlur={(e) => flush({ payment_reference: e.target.value || null })}
            placeholder="Wire ref / cheque #"
          />
        </Field>
        <Field label="Payment terms" hint={supplierSettings?.payment_terms_days != null ? `Supplier default: ${formatTermsLabel(supplierSettings.payment_terms_days)}` : "No supplier default set"}>
          <Select
            value={(() => {
              const effective = draft.payment_terms_days !== undefined ? draft.payment_terms_days : (accountsRow?.payment_terms_days ?? null);
              if (effective == null) return "";
              return STANDARD_PAYMENT_TERMS.some((t) => t.value === effective) ? String(effective) : "custom";
            })()}
            onChange={(e) => {
              const v = e.target.value;
              let nextDays: number | null = null;
              if (v === "") nextDays = null;
              else if (v === "custom") {
                const current = draft.payment_terms_days ?? accountsRow?.payment_terms_days ?? 30;
                nextDays = current;
              } else nextDays = Number(v);
              setLocal({ payment_terms_days: nextDays });
              flush({ payment_terms_days: nextDays });
            }}
          >
            <option value="">â€” use supplier default â€”</option>
            {STANDARD_PAYMENT_TERMS.map((t) => (
              <option key={t.value} value={String(t.value)}>{t.label}</option>
            ))}
            <option value="custom">Custom</option>
          </Select>
        </Field>
        <Field label="Custom days" hint="Only used when Payment terms is set to Custom">
          <Input
            type="number"
            min={0}
            step={1}
            value={(() => {
              const eff = draft.payment_terms_days !== undefined ? draft.payment_terms_days : (accountsRow?.payment_terms_days ?? null);
              return eff == null ? "" : String(eff);
            })()}
            onChange={(e) => setLocal({ payment_terms_days: e.target.value === "" ? null : Number(e.target.value) })}
            onBlur={(e) => flush({ payment_terms_days: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </Field>
        <Field label="Invoice due date" hint="Auto-computed from order placed + effective terms">
          <Input
            readOnly
            value={(() => {
              const draftDays = draft.payment_terms_days;
              const acctDays = accountsRow?.payment_terms_days;
              // Per-shipment override is atomic: if the shipment row has its
              // own days set, BOTH days and eom come from the shipment. Else
              // BOTH fall back to the supplier default. This avoids the bug
              // where a default-false eom on shipment_accounts silently
              // overrides a supplier set to NET30 EOM.
              const hasShipOverride = (draftDays !== undefined && draftDays !== null) || (acctDays != null);
              const effDays = hasShipOverride
                ? (draftDays !== undefined ? draftDays : (acctDays ?? null))
                : (supplierSettings?.payment_terms_days ?? null);
              const effEom = hasShipOverride
                ? Boolean(draft.payment_terms_eom !== undefined ? draft.payment_terms_eom : (accountsRow?.payment_terms_eom ?? false))
                : Boolean(supplierSettings?.payment_terms_eom ?? false);
              const due = computeDueDate(shipment.order_placed_date, effDays ?? null, effEom);
              if (!due) return "--";
              const overdue = isShipmentOverdue(due, accountsRow?.payment_status);
              return overdue ? `${due}  -  OVERDUE` : due;
            })()}
            className={(() => {
              const draftDays = draft.payment_terms_days;
              const acctDays = accountsRow?.payment_terms_days;
              // Per-shipment override is atomic: if the shipment row has its
              // own days set, BOTH days and eom come from the shipment. Else
              // BOTH fall back to the supplier default. This avoids the bug
              // where a default-false eom on shipment_accounts silently
              // overrides a supplier set to NET30 EOM.
              const hasShipOverride = (draftDays !== undefined && draftDays !== null) || (acctDays != null);
              const effDays = hasShipOverride
                ? (draftDays !== undefined ? draftDays : (acctDays ?? null))
                : (supplierSettings?.payment_terms_days ?? null);
              const effEom = hasShipOverride
                ? Boolean(draft.payment_terms_eom !== undefined ? draft.payment_terms_eom : (accountsRow?.payment_terms_eom ?? false))
                : Boolean(supplierSettings?.payment_terms_eom ?? false);
              const due = computeDueDate(shipment.order_placed_date, effDays ?? null, effEom);
              return isShipmentOverdue(due, accountsRow?.payment_status) ? "text-rose-700 dark:text-rose-300 font-semibold" : "";
            })()}
          />
        </Field>
        <div className="col-span-2">
          <Field label="Accounts notes" hint="Private to owners. Operational notes above are visible to everyone.">
            <textarea
              className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm"
              rows={3}
              value={(v("accounts_notes") as string) || ""}
              onChange={(e) => setLocal({ accounts_notes: e.target.value || null })}
              onBlur={(e) => flush({ accounts_notes: e.target.value || null })}
            />
          </Field>
        </div>
        <InvoiceAttachments supabase={supabase} location={location} shipmentId={shipment.id} />
      </div>
    </details>
  );
}
function ShipmentFormModal({
  open, shipment, onClose, onSave, onDelete, onTopUp, onToggleArchive,
  location,
  accountsRow, supplierSettings, isOwner, onSaveAccounts,
}: {
  open: boolean;
  shipment: IncomingShipment | null;
  onClose: () => void;
  onSave: (s: IncomingShipment) => Promise<void>;
  onDelete?: () => void;
  /** When provided, shows a "Top up" button that closes this modal and
      opens the supplier-order builder for the same shipment. */
  onTopUp?: () => void;
  /** When provided, shows Archive/Restore. Only passed for shipments in
      a terminal state (Delivered or Cancelled). */
  onToggleArchive?: () => void;
  /** Active location key â€” used by Accounts attachments + queries. */
  location: string;
  /** Owner-only: invoice/payment data for this shipment. */
  accountsRow?: ShipmentAccounts;
  supplierSettings?: SupplierSettings;
  isOwner?: boolean;
  onSaveAccounts?: (patch: Partial<ShipmentAccounts>) => Promise<void> | void;
}) {
  const { data } = useDataset();
  const today = todayIso();
  const [form, setForm] = useState<Partial<IncomingShipment>>({});
  const [lines, setLines] = useState<ShipmentLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (shipment) {
      setForm(shipment);
      setLines(shipment.lines.length > 0 ? shipment.lines : []);
    } else {
      const firstSku = data?.products[0];
      setForm({
        id: `ship-${Math.random().toString(36).slice(2, 8)}`,
        po_number: `PO-${new Date().getFullYear()}-${Math.floor(Math.random() * 9000 + 1000)}`,
        supplier: firstSku?.supplier ?? "",
        order_placed_date: today,
        transit_started_date: null,
        expected_arrival_date: addDays(today, firstSku?.lead_time_days ?? 28),
        actual_arrival_date: null,
        status: "Ordered",
        notes: "",
      });
      setLines(firstSku ? [{ product_id: firstSku.id, quantity: 100 }] : []);
    }
  }, [shipment, open, data?.products, today]);

  if (!data) return null;
  const set = (k: keyof IncomingShipment, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const addLine = () => {
    const matchSupplier = (p: { supplier: string }) =>
      !form.supplier || p.supplier === form.supplier;
    const nextSku =
      data.products.find((p) => matchSupplier(p) && !lines.some((l) => l.product_id === p.id))
      ?? data.products.find(matchSupplier)
      ?? data.products.find((p) => !lines.some((l) => l.product_id === p.id))
      ?? data.products[0];
    if (!nextSku) return;
    setLines((ls) => [...ls, { product_id: nextSku.id, quantity: 100 }]);
  };
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, j) => j !== i));
  const setLine = (i: number, patch: Partial<ShipmentLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const totalUnits = lines.reduce((sum, l) => sum + l.quantity, 0);

  return (
    <Modal open={open} onClose={onClose} title={shipment ? `Edit ${shipment.po_number}` : "New shipment"} width="max-w-3xl">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            if (lines.length === 0) throw new Error("Add at least one line item.");
            const filtered = lines.filter((l) => l.quantity > 0);
            if (filtered.length === 0) throw new Error("All lines have zero quantity.");
            // Strip legacy single-line fields when saving multi-line.
            const clean = { ...form, lines: filtered };
            delete (clean as Partial<IncomingShipment>).product_id;
            delete (clean as Partial<IncomingShipment>).quantity;
            const parsed = IncomingShipmentSchema.parse(clean);
            await onSave(parsed);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
        className="grid grid-cols-2 gap-4">
        <Field label="PO number">
          <Input required value={form.po_number ?? ""} onChange={(e) => set("po_number", e.target.value)} />
        </Field>
        <Field label="Supplier" hint="Suppliers come from your SKU list. Add a new one by setting it on a SKU first.">
          <Select required value={form.supplier ?? ""} onChange={(e) => set("supplier", e.target.value)}>
            <option value="">— pick a supplier —</option>
            {Array.from(new Set((data?.products ?? []).map((p) => p.supplier)))
              .filter(Boolean)
              .sort()
              .map((s) => (<option key={s} value={s}>{s}</option>))}
          </Select>
        </Field>
        <Field label="Order placed">
          <Input type="date" required value={form.order_placed_date ?? ""} onChange={(e) => set("order_placed_date", e.target.value)} />
        </Field>
        <Field label="Transit started (optional)">
          <Input type="date" value={form.transit_started_date ?? ""} onChange={(e) => set("transit_started_date", e.target.value || null)} />
        </Field>
        <Field label="Expected arrival">
          <Input type="date" required value={form.expected_arrival_date ?? ""} onChange={(e) => set("expected_arrival_date", e.target.value)} />
        </Field>
        <Field label="Actual arrival (optional)">
          <Input type="date" value={form.actual_arrival_date ?? ""} onChange={(e) => set("actual_arrival_date", e.target.value || null)} />
        </Field>
        <Field label="Status">
          <Select value={form.status ?? "Ordered"} onChange={(e) => set("status", e.target.value)}>
            {ShipmentStatus.options.map((s) => (<option key={s} value={s}>{s}</option>))}
          </Select>
        </Field>
        <Field label="Notes">
          <Input value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
        </Field>

        <div className="col-span-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300">
              Line items ({lines.length}) · {fmtNum(totalUnits)} units total
            </span>
            <Button type="button" size="sm" variant="secondary" onClick={addLine}>
              <Plus size={14} /> Add SKU
            </Button>
          </div>
          <div className="space-y-2">
            {lines.length === 0 ? (
              <div className="text-sm text-slate-500 italic">No line items yet — click "Add SKU".</div>
            ) : null}
            {lines.map((line, i) => (
              <div key={i} className="flex gap-2 items-end rounded ring-1 ring-slate-200 dark:ring-slate-800 p-2">
                <Field label="SKU">
                  <Select
                    value={line.product_id}
                    onChange={(e) => setLine(i, { product_id: e.target.value })}
                    className="w-56">
                    {(() => {
                      const matching = data.products.filter(
                        (p) => !form.supplier || p.supplier === form.supplier,
                      );
                      const current = data.products.find((p) => p.id === line.product_id);
                      const currentMismatch =
                        current && form.supplier && current.supplier !== form.supplier;
                      return (
                        <>
                          {currentMismatch && current ? (
                            <optgroup label={"Other supplier (" + current.supplier + ")"}>
                              <option value={current.id}>{current.code}</option>
                            </optgroup>
                          ) : null}
                          {matching.length > 0 ? (
                            <optgroup label={form.supplier || "All SKUs"}>
                              {matching.map((p) => (
                                <option key={p.id} value={p.id}>{p.code}</option>
                              ))}
                            </optgroup>
                          ) : (
                            <option value="">(no SKUs for this supplier)</option>
                          )}
                        </>
                      );
                    })()}
                  </Select>
                </Field>
                {(() => {
                  const skuP = data.products.find((p) => p.id === line.product_id);
                  const mismatch = skuP && form.supplier && skuP.supplier !== form.supplier;
                  return mismatch && skuP ? (
                    <span
                      className="inline-flex items-center rounded-full bg-amber-100 text-amber-800 text-[10px] font-semibold uppercase px-2 py-0.5 dark:bg-amber-900/30 dark:text-amber-200 self-center"
                      title={"This SKU belongs to " + skuP.supplier + ", but the shipment supplier is " + form.supplier + "."}>
                      Wrong supplier
                    </span>
                  ) : null;
                })()}
                <Field label="Quantity">
                  <Input type="number" min={1}
                    value={line.quantity}
                    onChange={(e) => setLine(i, { quantity: Number(e.target.value) || 0 })}
                    className="w-32" />
                </Field>
                <button type="button" onClick={() => removeLine(i)}
                  className="h-9 w-9 inline-flex items-center justify-center rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                  aria-label="Remove line">
                  <XIcon size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* === accounts section (owner only) === */}
        {isOwner && shipment ? (
          <AccountsSection
            shipment={shipment}
            accountsRow={accountsRow}
            supplierSettings={supplierSettings}
            onSaveAccounts={onSaveAccounts}
            supabase={getSupabase()}
            location={location}
          />
        ) : null}
        {error ? <div className="col-span-2 text-sm text-red-600 dark:text-red-400">{error}</div> : null}
        <div className="col-span-2 flex justify-between gap-2 pt-1">
          <div>
            {onDelete ? (
              <Button type="button" variant="danger" size="sm" onClick={onDelete}>
                <Trash2 size={14} /> Delete
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            {onToggleArchive ? (
              <Button
                variant="secondary"
                type="button"
                size="sm"
                onClick={onToggleArchive}
                title={shipment?.archived ? "Restore from archive" : "Archive this shipment"}
              >
                {shipment?.archived
                  ? <><ArchiveRestore size={14} /> Restore</>
                  : <><Archive size={14} /> Archive</>}
              </Button>
            ) : null}
            {onTopUp ? (
              <Button variant="secondary" type="button" size="sm" onClick={onTopUp}
                title="Open the order builder to add more lines to this shipment">
                <Plus size={14} /> Top up
              </Button>
            ) : null}
            <Button
              variant="secondary"
              type="button"
              size="sm"
              disabled={!form.po_number || !form.supplier || lines.length === 0}
              onClick={() => exportShipmentToXlsx({ ...(shipment ?? {}), ...form, lines } as IncomingShipment, data.products)}
              title="Download this PO as an Excel file ready to send to the supplier"
            >
              <Download size={14} /> Export PO (Excel)
            </Button>
            <Button
              variant="secondary"
              type="button"
              size="sm"
              disabled={!form.po_number || !form.supplier || lines.length === 0}
              onClick={() => void exportShipmentToPdf({ ...(shipment ?? {}), ...form, lines } as IncomingShipment, data.products)}
              title="Download this PO as a PDF ready to send to the supplier"
            >
              <Download size={14} /> Export PO (PDF)
            </Button>
            <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Sortable list view of shipments. Shows the same data as the kanban cards
 * but with more columns visible at once — useful for scanning across all
 * statuses, especially when filters narrow the set down.
 *
 * Click anywhere on a row to open the shipment for edit. The Archive
 * button is rendered inline on rows in a terminal state (Delivered /
 * Cancelled); other rows show a dash to make the column shape consistent.
 */
function ListView({
  shipments, products, onSelect, onToggleArchive,
}: {
  shipments: IncomingShipment[];
  products: { id: string; code: string }[];
  onSelect: (s: IncomingShipment) => void;
  onToggleArchive: (s: IncomingShipment) => void;
}) {
  // Sort: newest expected arrival first. Stable secondary sort on PO #.
  const sorted = useMemo(
    () => [...shipments].sort(
      (a, b) => b.expected_arrival_date.localeCompare(a.expected_arrival_date)
        || a.po_number.localeCompare(b.po_number),
    ),
    [shipments],
  );

  if (sorted.length === 0) {
    return (
      <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-slate-50/40 dark:bg-slate-900/30 px-4 py-6 text-center text-sm text-slate-500">
        No shipments match the active filters.
      </div>
    );
  }

  return (
    <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-950 overflow-hidden">
      <div className="max-h-[70vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900/95 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left font-medium px-3 py-2">PO #</th>
              <th className="text-left font-medium px-3 py-2">Supplier</th>
              <th className="text-left font-medium px-3 py-2">Status</th>
              <th className="text-left font-medium px-3 py-2">Expected</th>
              <th className="text-left font-medium px-3 py-2">Actual</th>
              <th className="text-right font-medium px-3 py-2">SKUs</th>
              <th className="text-right font-medium px-3 py-2">Units</th>
              <th className="text-left font-medium px-3 py-2">Lines preview</th>
              <th className="text-right font-medium px-3 py-2 w-px">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {sorted.map((s) => {
              const totalUnits = shipmentTotalUnits(s);
              const skuPreview = s.lines
                .map((l) => products.find((p) => p.id === l.product_id)?.code ?? "?")
                .join(", ");
              const isArchivable = ARCHIVABLE_STATUSES.has(s.status);
              return (
                <tr
                  key={s.id}
                  onClick={() => onSelect(s)}
                  className={cn(
                    "cursor-pointer hover:bg-slate-50/70 dark:hover:bg-slate-900/40 transition",
                    s.archived && "opacity-60",
                  )}
                  title="Click to open"
                >
                  <td className="px-3 py-2 font-mono text-xs">{s.po_number}</td>
                  <td className="px-3 py-2 text-xs">{s.supplier}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-slate-100 dark:bg-slate-800">
                      {s.status}
                    </span>
                    {s.archived ? (
                      <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400">
                        Archived
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums whitespace-nowrap">
                    {fmtShortDate(s.expected_arrival_date)}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums whitespace-nowrap text-slate-500">
                    {s.actual_arrival_date ? fmtShortDate(s.actual_arrival_date) : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums text-right">{s.lines.length}</td>
                  <td className="px-3 py-2 text-xs tabular-nums text-right">{fmtNum(totalUnits)}</td>
                  <td className="px-3 py-2 text-[11px] text-slate-500 truncate max-w-[240px]" title={skuPreview}>
                    {skuPreview || <span className="italic">none</span>}
                  </td>
                  <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    {isArchivable ? (
                      <button
                        type="button"
                        onClick={() => onToggleArchive(s)}
                        className="inline-flex items-center gap-1 text-[11px] px-2 h-7 rounded-md ring-1 ring-slate-200 dark:ring-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                        title={s.archived ? "Restore from archive" : "Archive this shipment"}
                      >
                        {s.archived ? <><ArchiveRestore size={12} /> Restore</> : <><Archive size={12} /> Archive</>}
                      </button>
                    ) : (
                      <span className="text-[11px] text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
        {sorted.length} shipment{sorted.length === 1 ? "" : "s"} · newest expected arrival first
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
