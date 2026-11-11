import { useMemo, useState, useEffect } from "react";
import {
  PackageOpen, Plus, ExternalLink, Trash2, Pencil, Search, Download,
  LayoutGrid, List as ListIcon,
  AlertTriangle, PackageCheck, DollarSign, Sparkles, CheckCircle2, TruckIcon,
} from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { useCsReturns } from "@/lib/hooks/useCsReturns";
import { useMutations } from "@/lib/hooks/useMutations";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Field, Input, Select } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { getSupabase } from "@/lib/repository/supabase/client";
import { fmtNum } from "@/lib/utils/format";
import {
  CS_RETURN_STATUS_LABELS,
  type CsReturn, type CsReturnLine, type CsReturnWithLines,
  type CsReturnStatus,
  type Product,
} from "@/lib/domain";

/** Per-status colour map for List and Kanban pill rendering. */
const RETURN_STATUS_TONE: Record<CsReturnStatus, string> = {
  new: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  received: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  rts: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  closed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
};

/** Max rows shown per kanban column. Older rows surface via List or search. */
const KANBAN_PER_COLUMN_LIMIT = 5;

/**
 * CS Returns page — inbound customer returns. Sibling of CS Cases.
 *
 * Workflow: new → received → closed.
 *
 *   new      — customer notified us, item hasn't arrived yet
 *   received — item is physically at our warehouse
 *   closed   — process complete (refund issued / decision made)
 *
 * Per-line restock toggle: when a line has restock=true AND the parent
 * return is 'received', the qty is credited back to inventory through the
 * ledger (reason='return'). Untoggling reverses the credit. Default off.
 */

const STATUSES: CsReturnStatus[] = ["new", "received", "rts", "closed"];

export function CsReturns() {
  const { data: dataset } = useDataset();
  const { data: returns, isLoading } = useCsReturns();
  const [editing, setEditing] = useState<CsReturnWithLines | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const [needsFilter, setNeedsFilter] = useState<null | "overdue" | "inspect" | "refund" | "week">(null);
  const [quickArrivalOpen, setQuickArrivalOpen] = useState(false);
  const m = useMutations();

  // Today at 00:00 for date comparisons.
  const todayIso = new Date().toISOString().slice(0, 10);

  const daysBetween = (isoOrTs: string): number => {
    const d = new Date(isoOrTs);
    const now = new Date();
    return Math.floor((now.getTime() - d.getTime()) / (24 * 3600 * 1000));
  };

  const allReturns = useMemo(() => returns ?? [], [returns]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allReturns;
    return allReturns.filter((r) => {
      const productCodes = r.lines
        .map((l) => dataset?.products.find((p) => p.id === l.product_id)?.code ?? "")
        .join(" ");
      const haystack = [
        r.order_number,
        r.customer_name ?? "",
        r.customer_email ?? "",
        r.shopify_order_url ?? "",
        productCodes,
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [allReturns, searchQuery, dataset]);

  // Needs-action buckets. Everything is derived from allReturns so the
  // counts reflect the full dataset, not the currently-filtered view.
  const buckets = useMemo(() => {
    const overdue: CsReturnWithLines[] = [];
    const inspect: CsReturnWithLines[] = [];
    const refund: CsReturnWithLines[] = [];
    const week: CsReturnWithLines[] = [];
    const cutoff7 = Date.now() - 7 * 24 * 3600 * 1000;
    for (const r of allReturns) {
      if (r.status === "new" && r.expected_return_date && r.expected_return_date < todayIso) overdue.push(r);
      if (r.status === "received" && r.received_at) {
        const days = daysBetween(r.received_at);
        if (days <= 3) inspect.push(r);
      }
      if (r.status === "received" && r.refund_expected && !r.refund_received) refund.push(r);
      if (new Date(r.created_at).getTime() >= cutoff7) week.push(r);
    }
    return { overdue, inspect, refund, week };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allReturns, todayIso]);

  // If a needs-filter is active, narrow `filtered` to that subset.
  // Quick arrival: reuse the New return modal but tell it to default
  // status = received + received_at = now via localStorage handoff.
  // The ReturnModal reads this once on mount and clears it.
  useEffect(() => {
    if (quickArrivalOpen) {
      try { window.localStorage.setItem("inka-return-quick-arrival", "1"); } catch {}
      setCreating(true);
      setQuickArrivalOpen(false);
    }
  }, [quickArrivalOpen]);
  const filteredForView = useMemo(() => {
    if (!needsFilter) return filtered;
    const subset =
      needsFilter === "overdue" ? buckets.overdue :
      needsFilter === "inspect" ? buckets.inspect :
      needsFilter === "refund"  ? buckets.refund  :
                                   buckets.week;
    const ids = new Set(subset.map((r) => r.id));
    return filtered.filter((r) => ids.has(r.id));
  }, [filtered, needsFilter, buckets]);

  if (!dataset) return <div className="text-sm text-slate-500">Loading…</div>;

  const byStatus = new Map<CsReturnStatus, CsReturnWithLines[]>();
  for (const s of STATUSES) byStatus.set(s, []);
  for (const r of filteredForView) byStatus.get(r.status)?.push(r);

  // ---- CSV export of the currently-filtered set, one row per line. ----
  const exportCsv = () => {
    const HEADER = [
      "return_id", "order_number", "status",
      "customer_name", "customer_email",
      "expected_return_date", "received_at", "closed_at",
      "refund_expected", "refund_received",
      "product_code", "quantity", "restock", "inventory_credited",
      "shopify_order_url", "notes",
      "created_at", "updated_at",
    ];
    const baseFor = (r: CsReturnWithLines): string[] => [
      r.id, r.order_number, r.status,
      r.customer_name ?? "", r.customer_email ?? "",
      r.expected_return_date ?? "",
      r.received_at ?? "", r.closed_at ?? "",
      r.refund_expected ? "yes" : "no",
      r.refund_received ? "yes" : "no",
    ];
    const rows: string[][] = [HEADER];
    for (const r of filtered) {
      if (r.lines.length === 0) {
        rows.push([...baseFor(r), "", "0", "no", "no", r.shopify_order_url ?? "", r.notes, r.created_at, r.updated_at]);
      } else {
        for (const l of r.lines) {
          const p = dataset.products.find((pp) => pp.id === l.product_id);
          rows.push([
            ...baseFor(r),
            p?.code ?? "",
            String(l.quantity),
            l.restock ? "yes" : "no",
            l.inventory_credited ? "yes" : "no",
            r.shopify_order_url ?? "",
            r.notes,
            r.created_at,
            r.updated_at,
          ]);
        }
      }
    }
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
    a.download = `cs-returns-${new Date().toISOString().slice(0, 10)}.csv`;
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
            <PackageOpen size={18} /> Returns
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Customer-initiated returns. Mark items <em>restockable</em> per line if they arrive in resaleable condition — restocked qty
            credits to inventory automatically once the return is marked <strong>Received</strong>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Kanban / List toggle */}
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
          </div>
          <Button
            variant="secondary"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5"
          >
            <Download size={14} /> Export CSV
          </Button>
          <Button variant="secondary" onClick={() => setQuickArrivalOpen(true)} className="inline-flex items-center gap-1.5" title="Dispatch: log a parcel that just arrived">
            <TruckIcon size={16} /> Log arrival
          </Button>
          <Button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5">
            <Plus size={16} /> New return
          </Button>
        </div>
      </div>

      {/* ---- Needs-action summary bar ---- */}
      {allReturns.length > 0 ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <NeedsTile
            label="Overdue expected"
            count={buckets.overdue.length}
            icon={<AlertTriangle size={14} />}
            active={needsFilter === "overdue"}
            tone="rose"
            onClick={() => setNeedsFilter((f) => f === "overdue" ? null : "overdue")}
            hint="Expected date has passed, still not received."
          />
          <NeedsTile
            label="Awaiting inspection"
            count={buckets.inspect.length}
            icon={<PackageCheck size={14} />}
            active={needsFilter === "inspect"}
            tone="blue"
            onClick={() => setNeedsFilter((f) => f === "inspect" ? null : "inspect")}
            hint="Received in the last 3 days - condition + decision needed."
          />
          <NeedsTile
            label="Refunds pending"
            count={buckets.refund.length}
            icon={<DollarSign size={14} />}
            active={needsFilter === "refund"}
            tone="amber"
            onClick={() => setNeedsFilter((f) => f === "refund" ? null : "refund")}
            hint="Received, refund expected, not yet marked refunded."
          />
          <NeedsTile
            label="New this week"
            count={buckets.week.length}
            icon={<Sparkles size={14} />}
            active={needsFilter === "week"}
            tone="emerald"
            onClick={() => setNeedsFilter((f) => f === "week" ? null : "week")}
            hint="Returns opened in the last 7 days."
          />
        </div>
      ) : null}

      {/* ---- Search row ---- */}
      <div className="rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 bg-white/40 dark:bg-slate-900/40 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px]">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by order #, customer, SKU…"
              className="w-full h-8 pl-7 pr-3 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
            />
          </div>
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:underline"
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {/* ---- Kanban or List ---- */}
      {isLoading ? (
        <div className="text-sm text-slate-500">Loading returns…</div>
      ) : view === "kanban" ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {STATUSES.map((status) => {
            const all = byStatus.get(status) ?? [];
            // Already sorted by created_at desc upstream (filtered preserves order).
            const visible = all.slice(0, KANBAN_PER_COLUMN_LIMIT);
            const hiddenCount = all.length - visible.length;
            return (
              <KanbanColumn
                key={status}
                status={status}
                returns={visible}
                hiddenCount={hiddenCount}
                products={dataset.products}
                onSelect={(r) => setEditing(r)}
                onShowMore={() => setView("list")}
              />
            );
          })}
        </div>
      ) : (
        <ListPanel
          rows={filteredForView}
          products={dataset.products}
          onSelect={(r) => setEditing(r)}
        />
      )}

      {!isLoading && filteredForView.length === 0 && allReturns.length > 0 ? (
        <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-slate-50/40 dark:bg-slate-900/30 px-4 py-6 text-center text-sm text-slate-500">
          No returns match your search.{" "}
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="text-slate-700 dark:text-slate-200 underline underline-offset-2 hover:no-underline"
          >
            Clear
          </button>
        </div>
      ) : null}

      {(creating || editing) ? (
        <ReturnModal
          initial={editing}
          products={dataset.products}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      ) : null}
    </div>
  );
}

// ============================================================================
// KANBAN
// ============================================================================

function KanbanColumn({
  status, returns, hiddenCount, products, onSelect, onShowMore,
}: {
  status: CsReturnStatus;
  returns: CsReturnWithLines[];
  hiddenCount: number;
  products: Product[];
  onSelect: (r: CsReturnWithLines) => void;
  onShowMore: () => void;
}) {
  // Column counter shows visible + hidden so the operator knows there's more
  // beyond what the kanban renders. Anything older drops off here and is
  // accessible via the List view or the search box.
  const totalCount = returns.length + hiddenCount;
  return (
    <div className="rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 bg-slate-50/40 dark:bg-slate-900/30">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-baseline justify-between">
        <div className="font-medium text-sm">{CS_RETURN_STATUS_LABELS[status]}</div>
        <div className="text-xs text-slate-500 tabular-nums">{totalCount}</div>
      </div>
      <div className="p-2 space-y-2 max-h-[700px] overflow-y-auto">
        {returns.length === 0 ? (
          <div className="text-xs text-slate-400 italic px-2 py-3">No returns.</div>
        ) : null}
        {returns.map((r) => (
          <ReturnCard key={r.id} r={r} products={products} onClick={() => onSelect(r)} />
        ))}
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={onShowMore}
            className="w-full text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 py-1.5 px-2 rounded hover:bg-slate-100 dark:hover:bg-slate-800 underline-offset-2 hover:underline"
          >
            + {hiddenCount} older {hiddenCount === 1 ? "return" : "returns"} — open List
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ReturnCard({
  r, products, onClick,
}: { r: CsReturnWithLines; products: Product[]; onClick: () => void }) {
  const totalQty = r.lines.reduce((s, l) => s + l.quantity, 0);
  const restockable = r.lines.filter((l) => l.restock).length;
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full text-left rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-950 hover:ring-slate-400 dark:hover:ring-slate-600 px-3 py-2 space-y-1 transition"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-slate-700 dark:text-slate-300">#{r.order_number}</span>
        <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          {totalQty} item{totalQty === 1 ? "" : "s"}
        </span>
      </div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
        {r.lines.length === 0 ? <span className="italic">No items</span> : (
          r.lines.map((l) => {
            const p = products.find((pp) => pp.id === l.product_id);
            return `${l.quantity}× ${p ? p.code : "(unknown)"}`;
          }).join(", ")
        )}
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span className="truncate">{r.customer_name ?? "—"}</span>
        <span className="whitespace-nowrap">
          {restockable > 0 ? `${restockable} restock` : null}
          {r.refund_expected ? (r.refund_received ? " · refunded" : " · refund due") : ""}
        </span>
      </div>
    </button>
  );
}

// ============================================================================
// LIST PANEL — chronological table, newest first
// ============================================================================

/**
 * Sortable one-row-per-return table. Always shows every filtered return,
 * not just the kanban-visible top 5 per column. Clicking a row opens the
 * same edit modal the kanban cards use.
 */
function ListPanel({
  rows, products, onSelect,
}: {
  rows: CsReturnWithLines[];
  products: Product[];
  onSelect: (r: CsReturnWithLines) => void;
}) {
  // Defensive: ensure newest-first ordering regardless of caller's sort.
  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [rows],
  );

  if (sorted.length === 0) {
    return (
      <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-slate-50/40 dark:bg-slate-900/30 px-4 py-6 text-center text-sm text-slate-500">
        No returns to show.
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
              <th className="text-left font-medium px-3 py-2">Status</th>
              <th className="text-left font-medium px-3 py-2">Expected</th>
              <th className="text-left font-medium px-3 py-2">Refund</th>
              <th className="text-right font-medium px-3 py-2">Items</th>
              <th className="text-left font-medium px-3 py-2">SKUs</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {sorted.map((r) => {
              const totalQty = r.lines.reduce((s, l) => s + l.quantity, 0);
              const skuPreview = r.lines
                .map((l) => products.find((p) => p.id === l.product_id)?.code ?? "?")
                .join(", ");
              const refundChip = !r.refund_expected
                ? <span className="text-[10px] text-slate-500 italic">none owed</span>
                : r.refund_received
                  ? <span className="text-[10px] text-emerald-700 dark:text-emerald-300">issued</span>
                  : <span className="text-[10px] text-amber-700 dark:text-amber-300">pending</span>;
              return (
                <tr
                  key={r.id}
                  onClick={() => onSelect(r)}
                  className="cursor-pointer hover:bg-slate-50/70 dark:hover:bg-slate-900/40 transition"
                  title="Click to open"
                >
                  <td className="px-3 py-2 text-xs tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {fmtDateTimeShort(r.created_at)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.order_number}</td>
                  <td className="px-3 py-2 text-xs text-slate-700 dark:text-slate-300 truncate max-w-[180px]">
                    {r.customer_name ?? <span className="text-slate-400 italic">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className={cn(
                      "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide",
                      RETURN_STATUS_TONE[r.status],
                    )}>
                      {CS_RETURN_STATUS_LABELS[r.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">
                    {r.expected_return_date ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">{refundChip}</td>
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
        {sorted.length} return{sorted.length === 1 ? "" : "s"} · newest first
      </div>
    </div>
  );
}

/** Local helper: "15 May, 14:23" formatter for the List view. */
function fmtDateTimeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// ============================================================================
// MODAL — new + edit
// ============================================================================

function ReturnModal({
  initial, products, onClose,
}: {
  initial: CsReturnWithLines | null;
  products: Product[];
  onClose: () => void;
}) {
  const m = useMutations();
  const auth = useAuthOptional();
  const userId = auth?.profile?.user_id ?? null;
  const isEdit = !!initial;
  const now = new Date().toISOString();

  const [orderNumber, setOrderNumber] = useState(initial?.order_number ?? "");
  const [shopifyUrl, setShopifyUrl] = useState(initial?.shopify_order_url ?? "");
  const [customerName, setCustomerName] = useState(initial?.customer_name ?? "");
  const [customerEmail, setCustomerEmail] = useState(initial?.customer_email ?? "");
  const [expectedDate, setExpectedDate] = useState(initial?.expected_return_date ?? "");
  const [status, setStatus] = useState<CsReturnStatus>(initial?.status ?? "new");
  const [refundExpected, setRefundExpected] = useState(initial?.refund_expected ?? true);
  const [refundReceived, setRefundReceived] = useState(initial?.refund_received ?? false);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [lines, setLines] = useState<CsReturnLine[]>(initial?.lines ?? []);
  const [linePicker, setLinePicker] = useState<{ productId: string; qty: string }>({ productId: "", qty: "1" });
  const [showAllSuppliers, setShowAllSuppliers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isFetchingShopify, setIsFetchingShopify] = useState(false);
  const [shopifyFetchMsg, setShopifyFetchMsg] = useState<
    { type: "ok" | "error"; text: string } | null
  >(null);
  // Line items pulled from the Shopify order — shown in a "+ Add" panel so
  // CS can pick which items are coming back. Each line maps onto our product
  // catalogue by SKU code (case-insensitive); unmatched lines need manual
  // entry.
  const [shopifyLineItems, setShopifyLineItems] = useState<
    Array<{ sku: string | null; title: string | null; quantity: number }>
  >([]);

  /** Shopify auto-fill — same wiring as CS Cases. */
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
      setShopifyFetchMsg({ type: "error", text: "Session expired or not signed in. Please refresh the page (Ctrl+F5)." });
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
        customer_name?: string | null;
        customer_email?: string | null;
        shopify_order_url?: string | null;
        line_items?: Array<{ sku: string | null; title: string | null; quantity: number }>;
        error?: string;
      };
      if (!res.ok || !body.found) {
        setShopifyFetchMsg({ type: "error", text: body.error || `Lookup failed (HTTP ${res.status})` });
        return;
      }
      let filled = 0;
      if (body.customer_name) { setCustomerName(body.customer_name); filled++; }
      if (body.customer_email) { setCustomerEmail(body.customer_email); filled++; }
      if (body.shopify_order_url) { setShopifyUrl(body.shopify_order_url); filled++; }
      setShopifyLineItems(body.line_items ?? []);
      const lineCount = body.line_items?.length ?? 0;
      setShopifyFetchMsg({
        type: "ok",
        text: `Filled from Shopify — ${filled} field${filled === 1 ? "" : "s"} updated${lineCount ? `, ${lineCount} line item${lineCount === 1 ? "" : "s"} ready to add below` : ""}.`,
      });
    } catch (e) {
      setShopifyFetchMsg({ type: "error", text: e instanceof Error ? e.message : "Network error" });
    } finally {
      setIsFetchingShopify(false);
    }
  };

  const addLine = () => {
    setError(null);
    if (!linePicker.productId) { setError("Pick a SKU."); return; }
    const qty = Number(linePicker.qty);
    if (!Number.isFinite(qty) || qty <= 0) { setError("Quantity must be positive."); return; }
    if (lines.some((l) => l.product_id === linePicker.productId)) {
      setError("That SKU is already on this return. Edit its qty in the list instead.");
      return;
    }
    setLines((prev) => [
      ...prev,
      {
        id: nextId(),
        return_id: initial?.id ?? "pending",
        product_id: linePicker.productId,
        quantity: qty,
        restock: false,
        inventory_credited: false,
      },
    ]);
    setLinePicker({ productId: "", qty: "1" });
  };
  /**
   * One-click "add this Shopify line as a returned item". Matches SKU
   * against our catalogue by `code` (case-insensitive). Defaults the new
   * line's restock=false because most returned items arrive in unknown
   * condition; CS can tick the per-line restock toggle once they inspect.
   */
  const addShopifyLine = (item: { sku: string | null; quantity: number }) => {
    setError(null);
    if (!item.sku) {
      setError("That Shopify line has no SKU. Add manually below.");
      return;
    }
    const target = item.sku.trim().toLowerCase();
    const product = products.find((p) => p.code.trim().toLowerCase() === target);
    if (!product) {
      setError(`No product in the catalogue matches SKU "${item.sku}". Add manually below.`);
      return;
    }
    if (lines.some((l) => l.product_id === product.id)) {
      setError(`${product.code} is already on this return.`);
      return;
    }
    setLines((prev) => [
      ...prev,
      {
        id: nextId(),
        return_id: initial?.id ?? "pending",
        product_id: product.id,
        quantity: item.quantity > 0 ? item.quantity : 1,
        restock: false,
        inventory_credited: false,
      },
    ]);
  };

  const removeLine = (id: string) => setLines((prev) => prev.filter((l) => l.id !== id));
  const updateLineQty = (id: string, qty: number) => {
    if (!Number.isFinite(qty) || qty <= 0) return;
    setLines((prev) => prev.map((l) => l.id === id ? { ...l, quantity: qty } : l));
  };
  const toggleLineRestock = (id: string) => {
    setLines((prev) => prev.map((l) => l.id === id ? { ...l, restock: !l.restock } : l));
  };

  // Inventory impact summary (live).
  const willCreditLines = (status === "received" || status === "rts") ? lines.filter((l) => l.restock) : [];

  const submit = async () => {
    setError(null);
    if (!orderNumber.trim()) { setError("Order number is required."); return; }
    if (lines.length === 0) { setError("Add at least one returned line."); return; }
    setBusy(true);
    try {
      const id = initial?.id ?? nextId();
      const next: CsReturn = {
        id,
        created_at: initial?.created_at ?? now,
        created_by_user_id: initial?.created_by_user_id ?? userId,
        status,
        order_number: orderNumber.trim(),
        shopify_order_url: shopifyUrl.trim() || null,
        customer_name: customerName.trim() || null,
        customer_email: customerEmail.trim() || null,
        expected_return_date: expectedDate || null,
        refund_expected: refundExpected,
        refund_received: refundReceived,
        notes: notes.trim(),
        received_at: initial?.received_at ?? null,  // repo will populate when transitioning
        closed_at: initial?.closed_at ?? null,
        updated_at: now,
      };
      const finalLines = lines.map((l) => ({ ...l, return_id: id }));
      await m.upsertCsReturn.mutateAsync({ return: next, lines: finalLines });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!initial) return;
    if (!window.confirm(`Delete return for order ${initial.order_number}? Any restock credits will be reversed.`)) return;
    setBusy(true);
    try {
      await m.deleteCsReturn.mutateAsync(initial.id);
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
            {isEdit ? <><Pencil size={14} /> Edit return #{initial!.order_number}</> : <><Plus size={14} /> New return</>}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">

          {/* ---- Order context ---- */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field
              label="Order number"
              hint="Shopify order number, e.g. 10186629. Click Fetch to auto-fill customer info."
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
            <Field label="Customer name">
              <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </Field>
            <Field label="Customer email">
              <Input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
            </Field>
            <Field label="Expected return date" hint="When the customer plans to drop off / post the item back.">
              <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
            </Field>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value as CsReturnStatus)}>
                {STATUSES.map((s) => <option key={s} value={s}>{CS_RETURN_STATUS_LABELS[s]}</option>)}
              </Select>
            </Field>
            <Field label="Shopify URL" hint="Auto-filled by Fetch. Click the link below to open in Shopify.">
              <Input value={shopifyUrl} onChange={(e) => setShopifyUrl(e.target.value)} placeholder="https://admin.shopify.com/..." />
            </Field>
          </div>

          {/* ---- Shopify-line-item picker (only after a successful Fetch) ---- */}
          {shopifyLineItems.length > 0 ? (
            <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
              <div className="text-sm font-semibold mb-2">
                Line items from Shopify
                <span className="text-xs text-slate-500 font-normal ml-2">
                  Click <em>+ Add</em> on each item being returned.
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
                        ? lines.some((l) => {
                            const p = products.find((pp) => pp.id === l.product_id);
                            return (p?.code ?? "").trim().toLowerCase() === (it.sku ?? "").trim().toLowerCase();
                          })
                        : false;
                      return (
                        <tr key={i} className={already ? "opacity-50" : ""}>
                          <td className="px-3 py-1.5 font-mono text-xs">{it.sku ?? <span className="italic text-slate-400">no SKU</span>}</td>
                          <td className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 truncate max-w-[260px]" title={it.title ?? ""}>
                            {it.title ?? <span className="italic text-slate-400">—</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-xs">{it.quantity}</td>
                          <td className="px-2 py-1.5">
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

          {/* ---- Lines being returned ---- */}
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="text-sm font-semibold mb-2">Items being returned</div>
            {lines.length === 0 ? (
              <div className="text-xs text-slate-400 italic mb-2">No items yet — pick a SKU and quantity below.</div>
            ) : (
              <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden mb-2">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-left font-medium px-3 py-1.5">SKU</th>
                      <th className="text-right font-medium px-2 py-1.5">Qty</th>
                      <th className="text-center font-medium px-2 py-1.5">Restock?</th>
                      <th className="text-right font-medium px-2 py-1.5">On hand</th>
                      <th className="text-right font-medium px-2 py-1.5 w-px"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {lines.map((l) => {
                      const p = products.find((pp) => pp.id === l.product_id);
                      return (
                        <tr key={l.id}>
                          <td className="px-3 py-1.5">
                            <div className="font-medium text-sm">{p ? p.code : "(deleted SKU)"}</div>
                            {p ? <div className="text-[10px] text-slate-500">{p.colour}</div> : null}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <input
                              type="number" min={1} step={1} defaultValue={l.quantity}
                              onBlur={(e) => updateLineQty(l.id, Number(e.target.value))}
                              className="w-16 h-7 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-right tabular-nums text-sm"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <label className="inline-flex items-center cursor-pointer" title="Tick if this item is resaleable. When the return is marked Received, ticked lines are credited back to inventory.">
                              <input
                                type="checkbox"
                                checked={l.restock}
                                onChange={() => toggleLineRestock(l.id)}
                                className="rounded"
                              />
                            </label>
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
                hint="Showing CHINA + UNFRAMED products (the items customers actually receive). Tick 'All suppliers' to broaden."
              >
                <Select
                  value={linePicker.productId}
                  onChange={(e) => setLinePicker((p) => ({ ...p, productId: e.target.value }))}
                  className="min-w-[280px]"
                >
                  <option value="">— pick a SKU —</option>
                  {products
                    .filter((p) => showAllSuppliers || isPickableProduct(p))
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

          {/* ---- Refund ---- */}
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
            <div className="text-sm font-semibold">Refund</div>
            <div className="flex flex-wrap gap-4">
              <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={refundExpected}
                  onChange={(e) => setRefundExpected(e.target.checked)}
                  className="rounded"
                />
                Customer is owed a refund
              </label>
              <label className={cn(
                "inline-flex items-center gap-2 text-sm",
                refundExpected ? "cursor-pointer" : "opacity-40 cursor-not-allowed",
              )}>
                <input
                  type="checkbox"
                  checked={refundReceived}
                  onChange={(e) => setRefundReceived(e.target.checked)}
                  disabled={!refundExpected}
                  className="rounded"
                />
                Refund has been issued
              </label>
            </div>
          </div>

          {/* ---- Notes ---- */}
          <Field label="Notes">
            <textarea
              value={notes} onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
              placeholder="Free-text — condition of items, reason for return, etc."
            />
          </Field>

          {/* ---- Inventory impact preview ---- */}
          {willCreditLines.length > 0 ? (
            <div className="rounded-md ring-1 ring-emerald-200 dark:ring-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-900/10 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-300">
              <strong>Saving will credit inventory:</strong>{" "}
              {willCreditLines.map((l, i) => {
                const p = products.find((pp) => pp.id === l.product_id);
                return (
                  <span key={l.id}>
                    {i > 0 ? ", " : ""}
                    <strong>{l.quantity}× {p?.code ?? "?"}</strong>
                    {p ? ` (after: ${fmtNum((p.current_on_hand ?? 0) + l.quantity)})` : ""}
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
              {busy ? "Saving…" : (isEdit ? "Save changes" : "Create return")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * SKU-picker eligibility: match the CS Cases rule. Only CHINA-supplied
 * (framed) and UNFRAMED-supplied (prints) products show by default,
 * because those are the items customers actually receive as physical
 * product. Operator can tick "All suppliers" to broaden.
 */
function isPickableProduct(p: Product): boolean {
  const s = (p.supplier ?? "").trim().toUpperCase();
  if (s === "CHINA" || s === "UNFRAMED") return true;
  const sc = (p.short_code ?? "").toLowerCase();
  const hay = `${p.code} ${p.colour ?? ""}`.toLowerCase();
  // Heuristic fallback for unframed prints (matches CsCases.deriveDepartment).
  return sc.endsWith("u") || sc.endsWith("p") || /unframed|print/.test(hay);
}

/** ULID-ish ID — same format as other entities in the codebase. */
function nextId(): string {
  const ms = Date.now().toString().padStart(13, "0");
  const rand = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  return `${ms}-${rand}`;
}

// ============================================================================
// Needs-action tile (top-of-page summary)
// ============================================================================

function NeedsTile({
  label, count, icon, active, onClick, hint, tone,
}: {
  label: string;
  count: number;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  hint: string;
  tone: "rose" | "blue" | "amber" | "emerald";
}) {
  const toneRing =
    tone === "rose"    ? "ring-rose-200 dark:ring-rose-900" :
    tone === "blue"    ? "ring-blue-200 dark:ring-blue-900" :
    tone === "amber"   ? "ring-amber-200 dark:ring-amber-900" :
                          "ring-emerald-200 dark:ring-emerald-900";
  const toneBg =
    tone === "rose"    ? "bg-rose-50/60 dark:bg-rose-900/20" :
    tone === "blue"    ? "bg-blue-50/60 dark:bg-blue-900/20" :
    tone === "amber"   ? "bg-amber-50/60 dark:bg-amber-900/20" :
                          "bg-emerald-50/60 dark:bg-emerald-900/20";
  const toneText =
    tone === "rose"    ? "text-rose-700 dark:text-rose-300" :
    tone === "blue"    ? "text-blue-700 dark:text-blue-300" :
    tone === "amber"   ? "text-amber-700 dark:text-amber-300" :
                          "text-emerald-700 dark:text-emerald-300";
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        "rounded-lg ring-1 px-3 py-2.5 text-left transition",
        toneBg,
        toneRing,
        active
          ? "outline outline-2 outline-offset-2 outline-slate-800 dark:outline-slate-200"
          : "hover:brightness-105",
      )}
    >
      <div className={cn("flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold", toneText)}>
        {icon} {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{count.toLocaleString()}</span>
        {active ? <span className="text-[10px] text-slate-500 dark:text-slate-400">filter active</span> : null}
      </div>
    </button>
  );
}
