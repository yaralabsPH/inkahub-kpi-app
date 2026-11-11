import { useEffect, useMemo, useState } from "react";
import { Sparkles, Save, BookmarkPlus, BookOpen, Download, Trash2, Eye, EyeOff, FileSpreadsheet } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Input";
import { useDataset } from "@/lib/hooks/useDataset";
import { useForecasts } from "@/lib/hooks/useForecasts";
import { useMutations } from "@/lib/hooks/useMutations";
import {
  IncomingShipmentSchema,
  computeCbm,
  type IncomingShipment,
  type Product,
  type OrderTemplate,
} from "@/lib/domain";
import { addDays, todayIso } from "@/lib/utils/dates";
import { fmtFloat, fmtMoney, fmtNum, fmtShortDate } from "@/lib/utils/format";
import { downloadCsv, toCsv } from "@/lib/csv/csv";
import { downloadXlsx } from "@/lib/csv/xlsx";
import { cn } from "@/lib/utils/cn";

/**
 * Supplier-led order builder. Pick a supplier, see all their SKUs in one
 * table with current stock / on-order / suggested-qty context, fill in
 * quantities, and save as a Draft or Ordered shipment.
 *
 * Supports:
 *  - Auto PO numbering (PO-YYYY-NNNN, increments per existing order this year)
 *  - Production days, estimated ship date, customs days, with computed-
 *    override expected-arrival semantics
 *  - Save as template / load template / delete template
 *  - Export to CSV
 *  - Top-up mode: editing an existing in-flight shipment adds lines to it
 *  - Compact column toggle to hide context columns when not wanted
 */

const ALL_STATUSES = [
  "Draft", "Ordered", "Back-Ordered", "In Production", "In Transit", "Customs", "Delivered", "On hold", "Cancelled",
] as const;

type ColumnToggle = {
  onHand: boolean;
  onOrder: boolean;
  weeklyAvg: boolean;
  suggested: boolean;
  weeksLeft: boolean;
  afterOrder: boolean;
  forecast: boolean;
  cbm: boolean;
};

const DEFAULT_COLUMNS: ColumnToggle = {
  onHand: true, onOrder: true, weeklyAvg: true, suggested: true, weeksLeft: true, afterOrder: true, forecast: true, cbm: true,
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** When set, edit the existing shipment in "top-up" mode. */
  editingShipmentId?: string | null;
  /** Optional pre-select. */
  defaultSupplier?: string;
}

export function OrderBuilderModal({ open, onClose, editingShipmentId, defaultSupplier }: Props) {
  const { data } = useDataset();
  const { byId } = useForecasts();
  const m = useMutations();

  // ---- form state ----
  const [supplier, setSupplier] = useState<string>("");
  const [poNumber, setPoNumber] = useState<string>("");
  const [orderPlacedDate, setOrderPlacedDate] = useState<string>(todayIso());
  const [productionDays, setProductionDays] = useState<string>("");
  const [estimatedShipDate, setEstimatedShipDate] = useState<string>("");
  const [customsDays, setCustomsDays] = useState<string>("0");
  const [expectedArrivalDate, setExpectedArrivalDate] = useState<string>("");
  const [arrivalOverridden, setArrivalOverridden] = useState(false);
  const [status, setStatus] = useState<IncomingShipment["status"]>("Draft");
  const [notes, setNotes] = useState<string>("");
  const [lineQuantities, setLineQuantities] = useState<Record<string, string>>({});
  const [columns, setColumns] = useState<ColumnToggle>(DEFAULT_COLUMNS);
  /**
   * Per-order "balance everyone to N weeks" override. Empty string = fall
   * back to each SKU's target_weeks_of_cover_override. When set, every
   * Suggested cell is recomputed as `max(0, avg × N − stock_at_arrival)`
   * rounded to the SKU's MOQ/increment, which lands every line at the
   * same weeks-of-cover after the order arrives — useful for evening out
   * stock levels in one go (e.g. when filling a container).
   */
  const [balanceWeeks, setBalanceWeeks] = useState<string>("");
  /**
   * Optional: when on, every SKU's Suggested qty is bumped up by the
   * cumulative demand that went unfulfilled while the SKU was OOS during
   * its lead-time window. Lets the next order make up for lost sales
   * instead of letting the gap simply disappear. Off by default — most
   * orders just want a clean forward-looking target.
   */
  const [coverBackorders, setCoverBackorders] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveTemplateName, setSaveTemplateName] = useState("");
  const [showTemplatePanel, setShowTemplatePanel] = useState(false);

  const products = data?.products ?? [];
  const shipments = data?.shipments ?? [];
  const templates: OrderTemplate[] = data?.settings?.order_templates ?? [];
  const currency = data?.settings?.currency_symbol ?? "$";
  const editing = editingShipmentId
    ? shipments.find((s) => s.id === editingShipmentId) ?? null
    : null;

  // ---- initialise the form whenever the modal opens ----
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setShowTemplatePanel(false);
    setSaveTemplateName("");
    setBalanceWeeks("");
    setCoverBackorders(false);

    if (editing) {
      // Top-up an existing shipment.
      setSupplier(editing.supplier);
      setPoNumber(editing.po_number);
      setOrderPlacedDate(editing.order_placed_date);
      setProductionDays(editing.production_days != null ? String(editing.production_days) : "");
      setEstimatedShipDate(editing.estimated_ship_date ?? "");
      setCustomsDays(String(editing.customs_days ?? 0));
      setExpectedArrivalDate(editing.expected_arrival_date);
      setArrivalOverridden(true);
      setStatus(editing.status);
      setNotes(editing.notes ?? "");
      const qs: Record<string, string> = {};
      for (const l of editing.lines) qs[l.product_id] = String(l.quantity);
      setLineQuantities(qs);
    } else {
      // Fresh order.
      setSupplier(defaultSupplier ?? "");
      setPoNumber(nextPoNumber(shipments, new Date().getFullYear()));
      setOrderPlacedDate(todayIso());
      setProductionDays("");
      setEstimatedShipDate("");
      setCustomsDays("0");
      setStatus("Draft");
      setNotes("");
      setLineQuantities({});
      setArrivalOverridden(false);
      // expectedArrival will get auto-computed by the effect below.
    }
  }, [open, editingShipmentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // SKUs visible — only those for the selected supplier.
  const visibleProducts = useMemo(() => {
    if (!supplier) return [];
    return products
      .filter((p) => p.supplier === supplier)
      .slice()
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  }, [products, supplier]);

  // Already-on-order lookup: per-SKU sum of in-flight shipment lines.
  const onOrderBySku = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of shipments) {
      // "On hold" is treated like Cancelled here — not counted toward
      // on-order, since the engine ignores those shipments too.
      if (
        s.status === "Cancelled" ||
        s.status === "Delivered" ||
        s.status === "Draft" ||
        s.status === "Back-Ordered" ||
        s.status === "On hold"
      ) continue;
      // Skip the one we're editing — its existing lines aren't "extra" on order.
      if (editing && s.id === editing.id) continue;
      for (const l of s.lines) {
        out[l.product_id] = (out[l.product_id] ?? 0) + l.quantity;
      }
      if (s.lines.length === 0 && s.product_id && s.quantity) {
        out[s.product_id] = (out[s.product_id] ?? 0) + s.quantity;
      }
    }
    return out;
  }, [shipments, editing]);

  // Compute expected arrival from the optional fields (computed override).
  // Effective fallback lead time = max(line lead times) for SKUs with quantities entered.
  useEffect(() => {
    if (arrivalOverridden) return;
    const cust = Math.max(0, Number(customsDays) || 0);
    const prod = productionDays !== "" ? Number(productionDays) : null;
    if (estimatedShipDate) {
      setExpectedArrivalDate(addDays(estimatedShipDate, cust));
      return;
    }
    if (prod !== null && Number.isFinite(prod) && prod >= 0) {
      const ship = addDays(orderPlacedDate, Math.floor(prod));
      setExpectedArrivalDate(addDays(ship, cust));
      return;
    }
    // Default: order_placed + max line lead time + customs.
    let maxLead = 0;
    for (const p of visibleProducts) {
      const q = Number(lineQuantities[p.id] ?? "0");
      if (q > 0 && p.lead_time_days > maxLead) maxLead = p.lead_time_days;
    }
    if (maxLead === 0) maxLead = 28; // sane default while empty
    setExpectedArrivalDate(addDays(orderPlacedDate, maxLead + cust));
  }, [orderPlacedDate, productionDays, estimatedShipDate, customsDays, lineQuantities, visibleProducts, arrivalOverridden]);

  // ---- derived totals ----
  const totals = useMemo(() => {
    let totalUnits = 0;
    let totalValue = 0;
    let totalPallets = 0;
    let totalCbm = 0;
    let totalCartons = 0;
    let lineCount = 0;
    for (const p of visibleProducts) {
      const q = Number(lineQuantities[p.id] ?? "0");
      if (!Number.isFinite(q) || q <= 0) continue;
      lineCount += 1;
      totalUnits += q;
      totalValue += (p.unit_cost ?? 0) * q;
      const cap = p.pallet_capacity_units || 0;
      if (cap > 0) totalPallets += q / cap;
      const cbm = computeCbm(p, q);
      if (cbm !== null) {
        totalCbm += cbm;
        if (p.carton_units) totalCartons += q / p.carton_units;
      }
    }
    return { totalUnits, totalValue, totalPallets, totalCbm, totalCartons, lineCount };
  }, [lineQuantities, visibleProducts]);

  // True if any visible SKU has carton info — gates the CBM column + widget.
  const hasCartonInfo = useMemo(
    () => visibleProducts.some(
      (p) => p.carton_units && p.carton_length_cm && p.carton_width_cm && p.carton_height_cm,
    ),
    [visibleProducts],
  );

  if (!data) return null;

  const suppliers = Array.from(new Set(products.map((p) => p.supplier))).sort();

  // ---- helpers ----
  function setQty(productId: string, raw: string) {
    setLineQuantities((q) => ({ ...q, [productId]: raw }));
  }

  function roundQtyForLine(p: Product, raw: string): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const inc = Math.max(p.order_increment ?? 1, 1);
    const moq = Math.max(p.min_order_qty ?? 0, 0);
    let rounded = Math.ceil(n / inc) * inc;
    if (rounded < moq) rounded = Math.ceil(moq / inc) * inc;
    return rounded;
  }

  /**
   * Effective Suggested qty for one SKU. Honours:
   *  - the per-order balance override (if set, replaces per-SKU target);
   *  - the optional cover-backorders toggle, which adds the engine's
   *    `unfulfilledDemand` to the gap so a SKU that ran OOS during lead
   *    time has its lost sales recovered by this order.
   * Falls back to the engine's per-SKU `suggestedOrderQty` when no
   * balance is set and backorders are off.
   */
  function effectiveSuggested(p: Product): number {
    const r = byId[p.id];
    if (!r) return 0;
    const balance = Number(balanceWeeks);
    const balanceActive = !!balanceWeeks && Number.isFinite(balance) && balance > 0;
    const backorder = coverBackorders ? r.unfulfilledDemand : 0;
    if (!balanceActive && backorder === 0) {
      return r.suggestedOrderQty;
    }
    const targetStock = balanceActive ? balance * r.weeklyAverage : r.targetStock;
    const baseGap = Math.max(targetStock - r.adjustedStock, 0);
    const gap = baseGap + backorder;
    if (gap === 0) return 0;
    const inc = Math.max(p.order_increment ?? 1, 1);
    const moq = Math.max(p.min_order_qty ?? 0, 0);
    let rounded = Math.ceil(gap / inc) * inc;
    if (rounded < moq) rounded = Math.ceil(moq / inc) * inc;
    return rounded;
  }

  /**
   * Always overwrites every visible SKU's Qty cell with the current
   * effective Suggested. Re-running after changing the "Balance order to"
   * input refreshes the whole table — without overwrite, cells that already
   * had a value would silently keep the stale number. Cells where
   * Suggested resolves to 0 (SKU is past target) are cleared so an old
   * pre-filled value can't linger.
   */
  // Which SKU rows the operator has explicitly ticked. Pre-fill /
  // rounding actions apply to just this subset when non-empty, or fall
  // back to "every visible SKU" when empty. Reset via clearSelection.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectionActive = selectedIds.size > 0;
  const productsToActOn = () => (
    selectionActive
      ? visibleProducts.filter((p) => selectedIds.has(p.id))
      : visibleProducts
  );
  const toggleRow = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelectedIds((prev) => {
    if (prev.size === visibleProducts.length) return new Set();
    return new Set(visibleProducts.map((p) => p.id));
  });
  const allVisibleSelected =
    visibleProducts.length > 0 && selectedIds.size === visibleProducts.length;
  const someVisibleSelected = selectedIds.size > 0 && !allVisibleSelected;

  function preFillFromForecast() {
    const targets = productsToActOn();
    const next: Record<string, string> = { ...lineQuantities };
    for (const p of targets) {
      const suggested = effectiveSuggested(p);
      if (suggested > 0) {
        next[p.id] = String(suggested);
      } else {
        delete next[p.id];
      }
    }
    setLineQuantities(next);
  }

  function applyRoundingToAll() {
    const targets = productsToActOn();
    const next: Record<string, string> = {};
    for (const p of targets) {
      const raw = lineQuantities[p.id];
      if (raw == null || raw === "") continue;
      const rounded = roundQtyForLine(p, raw);
      if (rounded > 0) next[p.id] = String(rounded);
    }
    setLineQuantities((prev) => ({ ...prev, ...next }));
  }

  /** Build the per-line rows the exporter (CSV + xlsx) shares. */
  function buildExportLines() {
    return visibleProducts
      .map((p) => {
        const q = Number(lineQuantities[p.id] ?? "0");
        if (!Number.isFinite(q) || q <= 0) return null;
        const cap = p.pallet_capacity_units || 0;
        return {
          po_number: poNumber,
          supplier,
          sku_code: p.code,
          short_code: p.short_code ?? "",
          size: p.size,
          colour: p.colour,
          qty: q,
          unit_cost: p.unit_cost ?? "",
          line_value: p.unit_cost ? Number((p.unit_cost * q).toFixed(2)) : "",
          pallets: cap > 0 ? Number((q / cap).toFixed(2)) : "",
          lead_time_days: p.lead_time_days,
          notes: "",
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
  }

  async function exportCsv() {
    const rows = buildExportLines();
    const csv = toCsv(rows, [
      "po_number", "supplier", "sku_code", "short_code", "size", "colour",
      "qty", "unit_cost", "line_value", "pallets", "lead_time_days", "notes",
    ]);
    downloadCsv(`${poNumber || "order"}.csv`, csv);
  }

  /**
   * Export the order as a multi-sheet .xlsx — one tab with the order
   * header (PO, supplier, dates, totals) and one tab with the per-SKU
   * lines. Opens cleanly in Excel and Google Sheets.
   */
  async function exportXlsx() {
    const lineRows = buildExportLines();
    const summarySheet = {
      name: "Order details",
      headers: ["Field", "Value"],
      rows: [
        ["PO number", poNumber],
        ["Supplier", supplier],
        ["Status", status],
        ["Order placed", orderPlacedDate],
        ["Production days", productionDays !== "" ? Number(productionDays) : ""],
        ["Estimated ship date", estimatedShipDate],
        ["Customs days", Number(customsDays) || 0],
        ["Expected arrival", expectedArrivalDate],
        ["Lines", totals.lineCount],
        ["Total units", totals.totalUnits],
        ["Total pallets", Number(totals.totalPallets.toFixed(2))],
        ["Total value", Number(totals.totalValue.toFixed(2))],
        ["Currency", currency],
        ["Notes", notes],
      ] as (string | number)[][],
      columnWidths: [22, 32],
    };
    const linesSheet = {
      name: "Lines",
      headers: [
        "PO number", "Supplier", "SKU code", "Short code", "Size", "Colour",
        "Qty", "Unit cost", "Line value", "Pallets", "Lead time (days)", "Notes",
      ],
      rows: lineRows.map((l) => [
        l.po_number, l.supplier, l.sku_code, l.short_code, l.size, l.colour,
        l.qty, l.unit_cost as number | string, l.line_value as number | string,
        l.pallets as number | string, l.lead_time_days, l.notes,
      ]),
    };
    downloadXlsx(`${poNumber || "order"}.xlsx`, [summarySheet, linesSheet]);
  }

  async function saveAsTemplate() {
    const name = saveTemplateName.trim();
    if (!name || !supplier) return;
    const lines: Record<string, number> = {};
    for (const p of visibleProducts) {
      const q = Number(lineQuantities[p.id] ?? "0");
      if (q > 0) lines[p.id] = q;
    }
    const tmpl: OrderTemplate = {
      id: `tpl-${Math.random().toString(36).slice(2, 10)}`,
      name, supplier, lines,
      production_days: productionDays !== "" ? Number(productionDays) : null,
      customs_days: Number(customsDays) || 0,
      notes,
      created_at: new Date().toISOString(),
    };
    if (!data) return;
    await m.setSettings.mutateAsync({
      ...data.settings,
      order_templates: [...templates, tmpl],
    });
    setSaveTemplateName("");
    setShowTemplatePanel(false);
  }

  async function loadTemplate(t: OrderTemplate) {
    setSupplier(t.supplier);
    setProductionDays(t.production_days != null ? String(t.production_days) : "");
    setCustomsDays(String(t.customs_days ?? 0));
    setNotes(t.notes ?? "");
    const qs: Record<string, string> = {};
    for (const [pid, qty] of Object.entries(t.lines)) qs[pid] = String(qty);
    setLineQuantities(qs);
    setShowTemplatePanel(false);
  }

  async function deleteTemplate(id: string) {
    if (!window.confirm("Delete this template?")) return;
    if (!data) return;
    await m.setSettings.mutateAsync({
      ...data.settings,
      order_templates: templates.filter((t) => t.id !== id),
    });
  }

  async function commit(asDraft: boolean) {
    setBusy(true); setError(null);
    try {
      if (!supplier) throw new Error("Pick a supplier first.");
      if (!poNumber.trim()) throw new Error("PO number can't be empty.");
      const lines = visibleProducts
        .map((p) => {
          const q = roundQtyForLine(p, lineQuantities[p.id] ?? "");
          return q > 0 ? { product_id: p.id, quantity: q } : null;
        })
        .filter((x): x is { product_id: string; quantity: number } => !!x);
      if (lines.length === 0) throw new Error("Add at least one line with a quantity.");

      const finalStatus = asDraft ? "Draft" : (status === "Draft" ? "Ordered" : status);

      const ship = IncomingShipmentSchema.parse({
        id: editing?.id ?? `ship-${Math.random().toString(36).slice(2, 10)}`,
        po_number: poNumber.trim(),
        supplier,
        order_placed_date: orderPlacedDate,
        transit_started_date: editing?.transit_started_date ?? null,
        expected_arrival_date: expectedArrivalDate,
        actual_arrival_date: editing?.actual_arrival_date ?? null,
        lines,
        status: finalStatus,
        notes,
        production_days: productionDays !== "" ? Number(productionDays) : null,
        estimated_ship_date: estimatedShipDate || null,
        customs_days: Number(customsDays) || 0,
      });
      await m.upsertShipment.mutateAsync(ship);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const matchingTemplates = templates.filter((t) => !supplier || t.supplier === supplier);

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Top-up order: ${editing.po_number}` : "Place supplier order"} width="max-w-6xl">
      <div className="space-y-4">
        {/* ---- Header form ---- */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Supplier">
            <Select value={supplier} onChange={(e) => setSupplier(e.target.value)} disabled={!!editing}>
              <option value="">— pick a supplier —</option>
              {suppliers.map((s) => (<option key={s} value={s}>{s}</option>))}
            </Select>
          </Field>
          <Field label="PO number" hint="Auto: PO-YYYY-NNNN. Editable.">
            <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
          </Field>
          <Field label="Order placed">
            <Input type="date" value={orderPlacedDate} onChange={(e) => setOrderPlacedDate(e.target.value)} />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              {ALL_STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
            </Select>
          </Field>
          <Field label="Production (days)">
            <Input type="number" min={0} value={productionDays}
              placeholder="optional"
              onChange={(e) => setProductionDays(e.target.value)} />
          </Field>
          <Field label="Estimated ship date">
            <Input type="date" value={estimatedShipDate}
              onChange={(e) => setEstimatedShipDate(e.target.value)} />
          </Field>
          <Field label="Customs (days)" hint="Default 0. Manual.">
            <Input type="number" min={0} value={customsDays}
              onChange={(e) => setCustomsDays(e.target.value)} />
          </Field>
          <Field
            label={
              <span className="inline-flex items-center gap-2">
                <span>Expected arrival</span>
                {arrivalOverridden ? (
                  <button
                    type="button"
                    onClick={() => setArrivalOverridden(false)}
                    className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60"
                    title="Clear the override and let the date recompute from order placed + lead time + customs"
                  >
                    Reset to auto
                  </button>
                ) : null}
              </span>
            }
            hint={arrivalOverridden ? "Manual override — click 'Reset to auto' to recompute from lead times" : "Auto-computed; edit to override"}
          >
            <Input type="date" value={expectedArrivalDate}
              onChange={(e) => { setExpectedArrivalDate(e.target.value); setArrivalOverridden(true); }} />
          </Field>
        </div>
        <Field label="Order notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm" />
        </Field>

        {/* ---- Balance-to-N-weeks knob ---- */}
        <div
          className="flex flex-wrap items-center gap-3 rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/50 dark:bg-slate-900/30"
          title="When set, every Suggested cell is recomputed so all SKUs land at the same weeks-of-cover after this order arrives — overrides each SKU's target. Leave blank to fall back to per-SKU targets."
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Balance order to
          </span>
          <Input
            type="number"
            min={0}
            step={1}
            value={balanceWeeks}
            onChange={(e) => setBalanceWeeks(e.target.value)}
            placeholder="(use per-SKU)"
            className="w-28 h-8 text-sm tabular-nums"
            aria-label="Balance order to N weeks of cover"
          />
          <span className="text-xs text-slate-500">
            weeks of cover after arrival
          </span>
          {balanceWeeks ? (
            <button
              type="button"
              onClick={() => setBalanceWeeks("")}
              className="text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline"
            >Clear</button>
          ) : null}
          <label
            className="inline-flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-200 cursor-pointer select-none"
            title="When on, the suggested qty for each SKU is bumped up by the demand it couldn't physically fulfil while OOS during lead time — so the next order recovers those lost sales instead of letting the gap disappear."
          >
            <input
              type="checkbox"
              checked={coverBackorders}
              onChange={(e) => setCoverBackorders(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-700"
            />
            Cover backorders
          </label>
          <span className="text-[11px] text-slate-500 ml-auto">
            {balanceWeeks
              ? `Every line sized to land at ${balanceWeeks}w cover`
              : "Each SKU uses its own target"}
            {coverBackorders ? " · backorders included" : ""}
          </span>
        </div>

        {/* ---- Action toolbar ---- */}
        <div className="flex flex-wrap items-center gap-2 border-y border-slate-200 dark:border-slate-800 py-2">
          <Button size="sm" variant="secondary" disabled={!supplier} onClick={preFillFromForecast}>
            <Sparkles size={14} /> {selectionActive ? `Pre-fill selected (${selectedIds.size})` : "Pre-fill from forecast"}
          </Button>
          <Button size="sm" variant="secondary" disabled={!supplier} onClick={() => setShowTemplatePanel((v) => !v)}>
            <BookOpen size={14} /> Templates
          </Button>
          <Button size="sm" variant="secondary" disabled={totals.lineCount === 0} onClick={exportCsv}>
            <Download size={14} /> Export CSV
          </Button>
          <Button size="sm" variant="secondary" disabled={totals.lineCount === 0} onClick={exportXlsx}>
            <FileSpreadsheet size={14} /> Export Excel
          </Button>
          <Button size="sm" variant="ghost" onClick={applyRoundingToAll} title="Round each filled line up to the SKU's MOQ + increment">
            Round to MOQ/inc
          </Button>
          <div className="ml-auto flex items-center gap-1.5 text-xs text-slate-500">
            <span className="hidden sm:inline">Show:</span>
            <ColumnToggleButton label="Stock" active={columns.onHand} onClick={() => setColumns((c) => ({ ...c, onHand: !c.onHand }))} />
            <ColumnToggleButton label="On order" active={columns.onOrder} onClick={() => setColumns((c) => ({ ...c, onOrder: !c.onOrder }))} />
            <ColumnToggleButton label="Avg / wk" active={columns.weeklyAvg} onClick={() => setColumns((c) => ({ ...c, weeklyAvg: !c.weeklyAvg }))} />
            <ColumnToggleButton label="Suggested" active={columns.suggested} onClick={() => setColumns((c) => ({ ...c, suggested: !c.suggested }))} />
            <ColumnToggleButton label="Weeks left" active={columns.weeksLeft} onClick={() => setColumns((c) => ({ ...c, weeksLeft: !c.weeksLeft }))} />
            <ColumnToggleButton label="After order" active={columns.afterOrder} onClick={() => setColumns((c) => ({ ...c, afterOrder: !c.afterOrder }))} />
            <ColumnToggleButton label="Forecast" active={columns.forecast} onClick={() => setColumns((c) => ({ ...c, forecast: !c.forecast }))} />
            {hasCartonInfo ? (
              <ColumnToggleButton label="CBM" active={columns.cbm} onClick={() => setColumns((c) => ({ ...c, cbm: !c.cbm }))} />
            ) : null}
          </div>
        </div>

        {/* ---- Template panel ---- */}
        {showTemplatePanel ? (
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 p-3 space-y-2 bg-slate-50/60 dark:bg-slate-900/40">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Save current as template">
                <Input placeholder="Template name (e.g. Quarterly China)"
                  value={saveTemplateName}
                  onChange={(e) => setSaveTemplateName(e.target.value)} />
              </Field>
              <Button size="sm" disabled={!saveTemplateName || !supplier} onClick={saveAsTemplate}>
                <BookmarkPlus size={14} /> Save template
              </Button>
            </div>
            {matchingTemplates.length > 0 ? (
              <div>
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Saved templates</div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {matchingTemplates.map((t) => (
                    <li key={t.id} className="flex items-center justify-between py-1.5">
                      <div>
                        <div className="text-sm font-medium">{t.name}</div>
                        <div className="text-[11px] text-slate-500">
                          {t.supplier} · {Object.keys(t.lines).length} SKU{Object.keys(t.lines).length === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="secondary" onClick={() => loadTemplate(t)}>Load</Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteTemplate(t.id)} aria-label="Delete template">
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="text-xs text-slate-500">No saved templates for this supplier yet.</div>
            )}
          </div>
        ) : null}

        {/* ---- Container-fill widget (only shows when SKUs have carton info) ---- */}
        {hasCartonInfo ? (() => {
          const containerCbm = data.settings.container_cbm ?? 67;
          const fillPct = (totals.totalCbm / containerCbm) * 100;
          const containers = totals.totalCbm / containerCbm;
          const tone =
            fillPct >= 100 ? "red" :
            fillPct >= 90 ? "amber" :
            fillPct >= 50 ? "emerald" : "slate";
          const fillCls = {
            red: "bg-red-500", amber: "bg-amber-500",
            emerald: "bg-emerald-500", slate: "bg-slate-400",
          }[tone];
          const textCls = {
            red: "text-red-700 dark:text-red-300",
            amber: "text-amber-700 dark:text-amber-300",
            emerald: "text-emerald-700 dark:text-emerald-300",
            slate: "text-slate-700 dark:text-slate-300",
          }[tone];
          return (
            <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 p-3 bg-slate-50/60 dark:bg-slate-900/40">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Container fill</div>
                <div className={cn("text-sm font-bold tabular-nums", textCls)}>
                  {fmtFloat(totals.totalCbm, 2)} / {fmtFloat(containerCbm, 0)} CBM
                  <span className="ml-2 text-xs font-medium">{fmtFloat(fillPct, 1)}%</span>
                </div>
              </div>
              <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                <div className={cn("h-full transition-all duration-300", fillCls)}
                  style={{ width: `${Math.min(fillPct, 100)}%` }} />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-500">
                <span>{fmtFloat(totals.totalCartons, 1)} cartons</span>
                <span>{fmtFloat(containers, 2)} container{containers === 1 ? "" : "s"} worth</span>
                {fillPct > 100 ? (
                  <span className="text-red-600 dark:text-red-400 font-medium">
                    Overflow by {fmtFloat(fillPct - 100, 1)}% — split into multiple containers or trim quantities.
                  </span>
                ) : (
                  <span>Container target set in Settings (currently {fmtFloat(containerCbm, 0)} CBM).</span>
                )}
              </div>
            </div>
          );
        })() : null}

        {/* ---- Lines table ---- */}
        {!supplier ? (
          <div className="text-sm text-slate-500 text-center p-8">
            Pick a supplier above to see their SKUs.
          </div>
        ) : visibleProducts.length === 0 ? (
          <div className="text-sm text-slate-500 text-center p-8">
            No SKUs found for {supplier}.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md ring-1 ring-slate-200 dark:ring-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="w-8 px-2 py-2">
                    <input
                      type="checkbox"
                      aria-label={allVisibleSelected ? "Clear all selections" : "Select all visible SKUs"}
                      title={allVisibleSelected ? "Clear all selections" : "Select all visible SKUs"}
                      checked={allVisibleSelected}
                      ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                      onChange={toggleAll}
                      className="rounded border-slate-300 dark:border-slate-700"
                    />
                  </th>
                  <th className="text-left font-medium px-3 py-2">SKU</th>
                  {columns.onHand ? <th className="text-right font-medium px-2 py-2">On hand</th> : null}
                  {columns.onOrder ? <th className="text-right font-medium px-2 py-2">On order</th> : null}
                  {columns.weeklyAvg ? <th className="text-right font-medium px-2 py-2" title="Weekly average demand the engine is using for this SKU. Drives every downstream calc — Suggested, Weeks left, After order, Cover backorders.">Avg / wk</th> : null}
                  {columns.suggested ? <th className="text-right font-medium px-2 py-2">Suggested</th> : null}
                  {columns.weeksLeft ? <th className="text-right font-medium px-2 py-2" title="Weeks until current stock runs out (engine forecast — includes pipeline shipments)">Weeks left</th> : null}
                  {columns.afterOrder ? <th className="text-right font-medium px-2 py-2" title="Projected weeks left assuming the entered Qty was on hand now">After order</th> : null}
                  {columns.forecast ? <th className="font-medium px-2 py-2" title="52-week stock trace WITH this line's Qty added at lead-time arrival. Curve = projected stock level. Dashed horizontal = target. Dashed vertical = order arrival. Green = stays above target after arrival; amber = dips below target; red = goes OOS.">52-wk forecast</th> : null}
                  <th className="text-right font-medium px-2 py-2">Qty</th>
                  <th className="text-right font-medium px-2 py-2">Pallets</th>
                  {hasCartonInfo && columns.cbm ? <th className="text-right font-medium px-2 py-2">CBM</th> : null}
                  <th className="text-right font-medium px-2 py-2">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {visibleProducts.map((p) => {
                  const r = byId[p.id];
                  const suggested = effectiveSuggested(p);
                  const onOrder = onOrderBySku[p.id] ?? 0;
                  const raw = lineQuantities[p.id] ?? "";
                  const q = Number(raw) || 0;
                  const cap = p.pallet_capacity_units || 0;
                  const pallets = cap > 0 ? q / cap : 0;
                  const lineValue = (p.unit_cost ?? 0) * q;
                  return (
                    <tr key={p.id} className={cn("hover:bg-slate-50 dark:hover:bg-slate-900/40", selectedIds.has(p.id) && "bg-blue-50/40 dark:bg-blue-900/10")}>
                      <td className="w-8 px-2 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Select ${p.code}`}
                          checked={selectedIds.has(p.id)}
                          onChange={() => toggleRow(p.id)}
                          className="rounded border-slate-300 dark:border-slate-700"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{p.code}</div>
                        <div className="text-[11px] text-slate-500">{p.size} · {p.colour}</div>
                      </td>
                      {columns.onHand ? (
                        <td className="px-2 py-2 text-right tabular-nums text-slate-500">{fmtNum(p.current_on_hand)}</td>
                      ) : null}
                      {columns.onOrder ? (
                        <td className="px-2 py-2 text-right tabular-nums text-slate-500">{onOrder > 0 ? fmtNum(onOrder) : "—"}</td>
                      ) : null}
                      {columns.weeklyAvg ? (
                        <td
                          className="px-2 py-2 text-right tabular-nums text-slate-500"
                          title={`Weekly avg via ${p.weekly_avg_method}${p.weekly_avg_manual != null ? ` (manual fallback ${p.weekly_avg_manual})` : ""}`}
                        >
                          {r ? fmtFloat(r.weeklyAverage, 1) : "—"}
                        </td>
                      ) : null}
                      {columns.suggested ? (
                        <td className="px-2 py-2 text-right tabular-nums">
                          {suggested > 0 ? (
                            <button type="button" onClick={() => setQty(p.id, String(suggested))}
                              className="text-blue-600 hover:underline tabular-nums" title="Click to use this quantity">
                              {fmtNum(suggested)}
                            </button>
                          ) : "—"}
                        </td>
                      ) : null}
                      {columns.weeksLeft ? (() => {
                        // Engine-computed weeks until current stock runs out — already
                        // accounts for any in-flight shipments + demand events.
                        const w = r?.weeksUntilOosCurrent;
                        const cls = w == null
                          ? "text-slate-500"
                          : w <= 4
                            ? "text-red-600 dark:text-red-400 font-semibold"
                            : w <= 12
                              ? "text-amber-600 dark:text-amber-400 font-medium"
                              : "text-slate-700 dark:text-slate-300";
                        return (
                          <td className={cn("px-2 py-2 text-right tabular-nums", cls)}>
                            {w == null ? "52+" : `${fmtFloat(w, 1)}w`}
                          </td>
                        );
                      })() : null}
                      {columns.afterOrder ? (() => {
                        // Honest what-if: the order adds `qty / weekly_avg` weeks
                        // of cover. We anchor the resulting "weeks left" on the
                        // same engine baseline shown in the Weeks left column so
                        // the two numbers stay in the same model — otherwise the
                        // delta is meaningless when the engine and a naive
                        // stock/avg formula disagree (e.g. demand events).
                        const D = r?.weeklyAverage ?? 0;
                        if (q <= 0 || D <= 0) {
                          return <td className="px-2 py-2 text-right tabular-nums text-slate-400">—</td>;
                        }
                        const delta = q / D;
                        const baseline = r?.weeksUntilOosCurrent;
                        const w = baseline == null ? null : baseline + delta;
                        const tone = (val: number) => val <= 4
                          ? "text-red-600 dark:text-red-400 font-semibold"
                          : val <= 12
                            ? "text-amber-600 dark:text-amber-400 font-medium"
                            : "text-emerald-600 dark:text-emerald-400 font-medium";
                        return (
                          <td
                            className={cn("px-2 py-2 text-right tabular-nums", w != null ? tone(w) : "text-emerald-600 dark:text-emerald-400 font-medium")}
                            title={`Adds ${fmtFloat(delta, 1)}w of cover (${fmtNum(q)} ÷ ${fmtFloat(D, 1)}/wk)`}
                          >
                            {w == null ? "52+" : `${fmtFloat(w, 1)}w`}
                            <span className="ml-1 text-[10px] text-slate-400">
                              +{fmtFloat(delta, 1)}
                            </span>
                          </td>
                        );
                      })() : null}
                      {columns.forecast ? (() => {
                        // Sparkline of stock level across 52 weeks WITH this
                        // line's current Qty added as an extra arrival at
                        // lead-time week. Hover the chart for OOS date /
                        // arrival date in the tooltip. Defensive guards on
                        // every divisor so a bad row can't blank the modal.
                        if (!r || !Array.isArray(r.rows) || r.rows.length < 2) {
                          return <td className="px-2 py-2 text-slate-400">—</td>;
                        }
                        const N = r.rows.length;
                        const leadWeeks = Math.max(1, Math.ceil((p.lead_time_days ?? 0) / 7));
                        const arrivalWeek = Math.max(1, Math.min(leadWeeks, N));
                        const balance = Number(balanceWeeks);
                        const balanceActive = !!balanceWeeks && Number.isFinite(balance) && balance > 0;
                        const targetStockHere = Math.max(
                          1,
                          balanceActive
                            ? balance * (r.weeklyAverage || 1)
                            : (r.targetStock || r.weeklyAverage * 21 || 1),
                        );

                        let stock = r.startingStock || 0;
                        const stocks: number[] = new Array(N);
                        let minPostArrival = Number.POSITIVE_INFINITY;
                        let oosWeek = -1;
                        let yMax = targetStockHere;
                        for (let i = 0; i < N; i++) {
                          const row = r.rows[i];
                          const arrivals = (row?.arrivals ?? 0) + (i + 1 === arrivalWeek ? q : 0);
                          const demand = row?.demand ?? 0;
                          stock = Math.max(0, stock + arrivals - demand);
                          stocks[i] = stock;
                          if (stock > yMax) yMax = stock;
                          if (i + 1 >= arrivalWeek) {
                            if (stock < minPostArrival) minPostArrival = stock;
                            if (oosWeek < 0 && stock <= 0) oosWeek = i;
                          }
                        }
                        if (!Number.isFinite(minPostArrival)) minPostArrival = 0;
                        const W = 160, H = 32, PAD = 2;
                        const xOf = (i: number) => PAD + (i / (N - 1)) * (W - 2 * PAD);
                        const yOf = (v: number) => H - PAD - (v / yMax) * (H - 2 * PAD);
                        const points = stocks.map((s, i) => `${xOf(i)},${yOf(s)}`).join(" ");
                        const areaPath =
                          `M ${xOf(0)},${H - PAD} L ` +
                          stocks.map((s, i) => `${xOf(i)},${yOf(s)}`).join(" L ") +
                          ` L ${xOf(N - 1)},${H - PAD} Z`;
                        const targetY = yOf(targetStockHere);
                        const arrivalX = xOf(arrivalWeek - 1);
                        const healthRatio = minPostArrival / targetStockHere;
                        let traceColour = "rgb(5,150,105)";    // emerald-600 (healthy)
                        let fillColour  = "rgba(5,150,105,0.18)";
                        if (minPostArrival <= 0) {
                          traceColour = "rgb(239,68,68)";       // red-500
                          fillColour  = "rgba(239,68,68,0.18)";
                        } else if (healthRatio < 0.5) {
                          traceColour = "rgb(245,158,11)";      // amber-500
                          fillColour  = "rgba(245,158,11,0.18)";
                        } else if (healthRatio < 1) {
                          traceColour = "rgb(16,185,129)";      // emerald-500
                          fillColour  = "rgba(16,185,129,0.18)";
                        }
                        const arrivalDate = r.rows[arrivalWeek - 1]?.weekStart;
                        const oosDate = oosWeek >= 0 ? r.rows[oosWeek]?.weekStart : null;
                        const lastDate = r.rows[N - 1]?.weekStart;
                        const arrivalLabel = arrivalDate ? fmtShortDate(arrivalDate) : `wk ${arrivalWeek}`;
                        const tip = oosWeek === -1
                          ? `${p.code}: stays above zero through ${lastDate ? fmtShortDate(lastDate) : "52w"}. Min stock ${fmtNum(minPostArrival)} (${fmtFloat(healthRatio * 100, 0)}% of target).${q > 0 ? ` New order arrives ${arrivalLabel}.` : ""}`
                          : `${p.code}: runs out around ${oosDate ? fmtShortDate(oosDate) : `wk ${oosWeek + 1}`} (week ${oosWeek + 1} after today).${q > 0 ? ` New order arrives ${arrivalLabel}.` : ""}`;
                        return (
                          <td className="px-2 py-2 align-middle">
                            <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tip}>
                              <title>{tip}</title>
                              <path d={areaPath} fill={fillColour} />
                              <line x1={PAD} y1={targetY} x2={W - PAD} y2={targetY} stroke="rgb(100,116,139)" strokeWidth="0.75" strokeDasharray="3 3" />
                              {q > 0 ? (
                                <line x1={arrivalX} y1={PAD} x2={arrivalX} y2={H - PAD} stroke="rgb(15,23,42)" strokeWidth="1" strokeDasharray="2 2" />
                              ) : null}
                              <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="rgb(203,213,225)" strokeWidth="0.5" />
                              <polyline points={points} fill="none" stroke={traceColour} strokeWidth="1.5" strokeLinejoin="round" />
                            </svg>
                          </td>
                        );
                      })() : null}
                      <td className="px-2 py-2 text-right">
                        <Input type="number" min={0} value={raw}
                          onChange={(e) => setQty(p.id, e.target.value)}
                          onBlur={() => {
                            const rounded = roundQtyForLine(p, raw);
                            if (rounded > 0 && String(rounded) !== raw) setQty(p.id, String(rounded));
                          }}
                          className="w-24 h-8 text-right tabular-nums" />
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-slate-500">
                        {q > 0 && cap > 0 ? fmtFloat(pallets, 1) : "—"}
                      </td>
                      {hasCartonInfo && columns.cbm ? (
                        <td className="px-2 py-2 text-right tabular-nums text-slate-500">
                          {(() => {
                            const cbm = computeCbm(p, q);
                            return cbm === null || q === 0 ? "—" : fmtFloat(cbm, 2);
                          })()}
                        </td>
                      ) : null}
                      <td className="px-2 py-2 text-right tabular-nums">
                        {q > 0 && p.unit_cost != null ? fmtMoney(lineValue, currency) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-slate-50/60 dark:bg-slate-900/40 border-t-2 border-slate-300 dark:border-slate-700">
                <tr>
                  <td className="px-3 py-2 font-semibold">
                    {totals.lineCount} line{totals.lineCount === 1 ? "" : "s"}
                  </td>
                  {columns.onHand ? <td /> : null}
                  {columns.onOrder ? <td /> : null}
                  {columns.weeklyAvg ? <td /> : null}
                  {columns.suggested ? <td /> : null}
                  {columns.weeksLeft ? <td /> : null}
                  {columns.afterOrder ? <td /> : null}
                  {columns.forecast ? <td /> : null}
                  <td className="px-2 py-2 text-right font-bold tabular-nums">{fmtNum(totals.totalUnits)}</td>
                  <td className="px-2 py-2 text-right font-bold tabular-nums">
                    {totals.totalPallets > 0 ? fmtFloat(totals.totalPallets, 1) : "—"}
                  </td>
                  {hasCartonInfo && columns.cbm ? (
                    <td className="px-2 py-2 text-right font-bold tabular-nums">
                      {totals.totalCbm > 0 ? fmtFloat(totals.totalCbm, 2) : "—"}
                    </td>
                  ) : null}
                  <td className="px-2 py-2 text-right font-bold tabular-nums">
                    {totals.totalValue > 0 ? fmtMoney(totals.totalValue, currency) : "—"}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {error ? <div className="text-sm text-red-600 dark:text-red-400">{error}</div> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {!editing ? (
            <Button variant="secondary" onClick={() => commit(true)} disabled={busy || !supplier || totals.lineCount === 0}>
              <Save size={14} /> Save as Draft
            </Button>
          ) : null}
          <Button onClick={() => commit(false)} disabled={busy || !supplier || totals.lineCount === 0}>
            {busy ? "Saving…" : (editing ? "Update order" : "Place order")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ColumnToggleButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 h-6 text-[11px]",
        active
          ? "bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-100"
          : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800",
      )}
    >
      {active ? <Eye size={11} /> : <EyeOff size={11} />} {label}
    </button>
  );
}

/** Generate the next PO number for the given year — `PO-YYYY-NNNN`. */
function nextPoNumber(shipments: IncomingShipment[], year: number): string {
  const prefix = `PO-${year}-`;
  let max = 0;
  for (const s of shipments) {
    if (s.po_number?.startsWith(prefix)) {
      const tail = s.po_number.slice(prefix.length);
      const n = Number(tail);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}
