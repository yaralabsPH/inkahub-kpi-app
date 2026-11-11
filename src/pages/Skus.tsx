import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Plus, Upload, Trash2, Pencil, GitCompare, GripVertical, Search, X,
  CheckSquare, Square, Wand2,
} from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { useForecasts } from "@/lib/hooks/useForecasts";
import { useMutations } from "@/lib/hooks/useMutations";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Input";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  ProductSchema, shortCode,
  LOCATIONS, LOCATION_LABELS,
  PRODUCT_TYPE_LABELS, PRODUCT_TYPE_HINTS,
  type Product, type LocationKey, type ProductTypeKey,
} from "@/lib/domain";
import { fmtFloat, fmtNum } from "@/lib/utils/format";
import { detectCsvDelimiter, parseCsv } from "@/lib/csv/csv";
import { CompareModal } from "@/components/CompareModal";
import { cn } from "@/lib/utils/cn";
import { useAppStore } from "@/lib/state/appStore";
import { DexieRepo } from "@/lib/repository/dexie/DexieRepo";
import { getDb } from "@/lib/repository/dexie/db";

type FilterState = { size: string; colour: string; supplier: string; q: string };

/** Numeric fields editable inline via double-click on the SKU table. */
type QuickEditField =
  | "lead_time_days"
  | "current_on_hand"
  | "safety_stock_pct"
  | "min_order_qty"
  | "order_increment";

/** Fields that bulk-edit can target. Mirrors the most-common operational tweaks. */
type BulkField =
  | "supplier"
  | "current_on_hand"
  | "lead_time_days"
  | "min_order_qty"
  | "order_increment"
  | "pallet_capacity_units"
  | "safety_stock_pct"
  | "target_weeks_of_cover_override"
  | "weekly_avg_method"
  | "product_type"
  | "unit_cost";

const BULK_FIELDS: { value: BulkField; label: string; kind: "string" | "number" | "method" | "nullableNumber" | "productType" }[] = [
  { value: "supplier", label: "Supplier", kind: "string" },
  // Useful after a manual stocktake — set every selected SKU's on-hand to
  // the same value (e.g. zero out a discontinued range, or seed a freshly
  // imported catalogue with a placeholder count).
  { value: "current_on_hand", label: "Current on hand", kind: "number" },
  { value: "lead_time_days", label: "Lead time (days)", kind: "number" },
  { value: "min_order_qty", label: "Min order qty", kind: "number" },
  { value: "order_increment", label: "Order increment", kind: "number" },
  { value: "pallet_capacity_units", label: "Pallet capacity", kind: "number" },
  { value: "safety_stock_pct", label: "Safety stock (% of weekly demand)", kind: "number" },
  { value: "target_weeks_of_cover_override", label: "Target weeks of cover", kind: "number" },
  { value: "weekly_avg_method", label: "Weekly avg method", kind: "method" },
  // Bulk-categorise a selection. e.g. select every PFI-* row, click bulk
  // edit, set Product type → Consumable.
  { value: "product_type", label: "Product type", kind: "productType" },
  { value: "unit_cost", label: "Unit cost", kind: "nullableNumber" },
];

export function Skus() {
  const { data } = useDataset();
  const { byId: forecastById } = useForecasts();
  const m = useMutations();
  const currentLocation = useAppStore((s) => s.location);
  const [filter, setFilter] = useState<FilterState>({ size: "", colour: "", supplier: "", q: "" });
  const [editing, setEditing] = useState<Product | null>(null);
  const [creating, setCreating] = useState(false);
  const [comparing, setComparing] = useState<{ a: string; b: string } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [editCell, setEditCell] = useState<{ id: string; field: QuickEditField } | null>(null);
  // UI-only inversion of the list order. Non-destructive — doesn't touch
  // `display_order` in the DB so the underlying canonical ordering is
  // preserved. Useful when you want the bottom of the list at the top.
  const [reverseOrder, setReverseOrder] = useState<boolean>(false);
  // === order staging ===
  const [draftOrder, setDraftOrder] = useState<string[] | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  // Product-type filter for the SKUs page. Defaults to "all" so existing
  // workflows see every SKU; pick "product" to hide consumables/etc.
  const [typeFilter, setTypeFilter] = useState<"all" | ProductTypeKey>("all");
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  /** Persist a single numeric field for one SKU (used by quick double-click edits). */
  const saveQuickEdit = async (p: Product, field: QuickEditField, value: number) => {
    if (p[field] === value) {
      setEditCell(null);
      return;
    }
    const next: Product = { ...p, [field]: value };
    try {
      const parsed = ProductSchema.parse(next);
      await m.upsertProduct.mutateAsync(parsed);
    } catch (err) {
      window.alert(`Could not save: ${(err as Error).message}`);
    } finally {
      setEditCell(null);
    }
  };

  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  const sizes = uniq(data.products.map((p) => p.size));
  const colours = uniq(data.products.map((p) => p.colour));
  const suppliers = uniq(data.products.map((p) => p.supplier));

  const q = filter.q.trim().toLowerCase();
  const filtered = data.products
    .filter((p) =>
      (filter.size === "" || p.size === filter.size) &&
      (filter.colour === "" || p.colour === filter.colour) &&
      (filter.supplier === "" || p.supplier === filter.supplier) &&
      (typeFilter === "all" || (p.product_type ?? "product") === typeFilter) &&
      (q === "" ||
        p.code.toLowerCase().includes(q) ||
        shortCode(p).toLowerCase().includes(q) ||
        p.size.toLowerCase().includes(q) ||
        p.colour.toLowerCase().includes(q) ||
        p.supplier.toLowerCase().includes(q) ||
        (p.notes ?? "").toLowerCase().includes(q)),
    )
    .sort((a, b) => {
      if (draftOrder) {
        const ai = draftOrder.indexOf(a.id);
        const bi = draftOrder.indexOf(b.id);
        if (ai !== -1 || bi !== -1) {
          const aRank = ai === -1 ? 9_999_999 : ai;
          const bRank = bi === -1 ? 9_999_999 : bi;
          if (aRank !== bRank) return aRank - bRank;
        }
      }
      const diff = (a.display_order ?? 0) - (b.display_order ?? 0);
      return reverseOrder ? -diff : diff;
    });

  const filteredIds = filtered.map((p) => p.id);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const someFilteredSelected = filteredIds.some((id) => selectedIds.has(id));

  const toggleAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const id of filteredIds) next.delete(id);
      } else {
        for (const id of filteredIds) next.add(id);
      }
      return next;
    });
  };
  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const clearSelection = () => setSelectedIds(new Set());

  const reorder = async (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    const baseOrder = draftOrder
      ? draftOrder
      : data.products.slice().sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)).map((p) => p.id);
    const fromIdx = baseOrder.indexOf(draggedId);
    const toIdx = baseOrder.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = baseOrder.slice();
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    setDraftOrder(next);
  };

  // === order staging helpers ===
  const currentOrderIds = (): string[] => {
    if (draftOrder) return draftOrder;
    return data.products.slice()
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
      .map((p) => p.id);
  };
  const stageReverseAll = () => setDraftOrder(currentOrderIds().slice().reverse());
  const stageSortAZ = () => setDraftOrder(
    data.products.slice().sort((a, b) => a.code.localeCompare(b.code)).map((p) => p.id),
  );
  const stageSortZA = () => setDraftOrder(
    data.products.slice().sort((a, b) => b.code.localeCompare(a.code)).map((p) => p.id),
  );
  const discardOrderDraft = () => setDraftOrder(null);
  const saveOrderDraft = async () => {
    if (!draftOrder || savingOrder) return;
    setSavingOrder(true);
    try {
      const byId = new Map(data.products.map((p) => [p.id, p]));
      for (let i = 0; i < draftOrder.length; i++) {
        const p = byId.get(draftOrder[i]);
        if (!p) continue;
        const wanted = i + 1;
        if (p.display_order !== wanted) {
          await m.upsertProduct.mutateAsync({ ...p, display_order: wanted });
        }
      }
      setDraftOrder(null);
    } finally {
      setSavingOrder(false);
    }
  };

  const importSkus = async (file: File) => {
    setImportMsg(null);
    try {
      // Accept both CSV and Excel. For .xlsx we read with SheetJS, normalise
      // every cell to a string, and drop the header detection through the
      // same path as CSV — so the rest of the importer doesn't care which
      // file format the user picked.
      let rows: string[][];
      const isXlsx = /\.xlsx$/i.test(file.name);
      if (isXlsx) {
        const XLSX = await import("xlsx");
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
          header: 1,
          raw: false,
          defval: "",
        }) as string[][];
        // Drop any "title / instruction" rows above the header by looking
        // for the row whose first cell is "code".
        const headerIdx = matrix.findIndex((r) => (r[0] ?? "").trim().toLowerCase() === "code");
        if (headerIdx < 0) throw new Error('Couldn\'t find a "code" header in the sheet.');
        rows = matrix.slice(headerIdx).map((r) => r.map((v) => String(v ?? "").trim()));
        // Some templates have a hint row immediately under the header — if
        // the row right after the header has no real code value, skip it.
        if (rows.length > 1 && !rows[1][0]) rows.splice(1, 1);
      } else {
        const text = await file.text();
        // Excel saves CSVs with `;` in many locales — auto-detect.
        const delimiter = detectCsvDelimiter(text);
        rows = parseCsv(text, delimiter);
      }
      if (rows.length < 2) throw new Error("File is empty");
      // Find the header row (first row whose first cell is "code"). Allows
      // titles / instructions / blank rows above the headers.
      const headerIdx = rows.findIndex((r) => (r[0] ?? "").trim().toLowerCase() === "code");
      if (headerIdx < 0) {
        throw new Error('Couldn\'t find a "code" header in the file. Use the SKU template — the header row needs "code" in column A.');
      }
      rows = rows.slice(headerIdx);
      // Drop a hint row that sometimes lives directly under the header
      // (the template has one). It's the row whose first cell isn't a
      // plausible SKU code — looks like a sentence.
      if (rows.length > 1 && /\s/.test(rows[1][0] ?? "")) rows.splice(1, 1);
      const header = rows[0].map((h) => h.trim());
      const idx = (k: string) => header.indexOf(k);
      let added = 0;
      let nextOrder = (data.products.reduce((max, p) => Math.max(max, p.display_order ?? 0), 0)) + 1;
      for (const row of rows.slice(1)) {
        const code = row[idx("code")];
        if (!code) continue;
        const existing = data.products.find((p) => p.code === code);
        const candidate = ProductSchema.parse({
          id: existing?.id ?? `sku-${cryptoId()}`,
          code,
          short_code: existing?.short_code ?? null,
          size: row[idx("size")] ?? "",
          colour: row[idx("colour")] ?? "",
          unit_of_sale: "each",
          pallet_capacity_units: numOr(row[idx("pallet_capacity_units")], 100),
          bay_capacity_pallets: existing?.bay_capacity_pallets ?? 2,
          supplier: row[idx("supplier")] ?? "",
          lead_time_days: numOr(row[idx("lead_time_days")], 28),
          min_order_qty: numOr(row[idx("min_order_qty")], 0),
          order_increment: numOr(row[idx("order_increment")], 1),
          current_on_hand: numOr(row[idx("current_on_hand")], 0),
          safety_stock_units: numOr(row[idx("safety_stock_units")], 0),
          safety_stock_pct: numOr(row[idx("safety_stock_pct")], 100),
          target_weeks_of_cover_override: numOr(
            row[idx("target_weeks_of_cover_override")],
            existing?.target_weeks_of_cover_override ?? 21,
          ),
          weekly_avg_method:
            (row[idx("weekly_avg_method")] as Product["weekly_avg_method"]) ?? "trailing_8",
          weekly_avg_manual: parseOptNumber(row[idx("weekly_avg_manual")]),
          unit_cost: parseOptNumber(row[idx("unit_cost")]),
          display_order: existing?.display_order ?? nextOrder++,
          notes: existing?.notes ?? "",
        });
        await m.upsertProduct.mutateAsync(candidate);
        added++;
      }
      setImportMsg(`Imported ${added} SKU${added === 1 ? "" : "s"}.`);
    } catch (err) {
      setImportMsg(`Import failed: ${(err as Error).message}`);
    }
  };

  const createAcrossLocations = async (
    base: Product,
    locations: LocationKey[],
  ): Promise<{ written: LocationKey[] }> => {
    const written: LocationKey[] = [];
    for (const loc of locations) {
      if (loc === currentLocation) {
        await m.upsertProduct.mutateAsync(base);
      } else {
        const repo = new DexieRepo(getDb(loc));
        await repo.upsertProduct(base);
      }
      written.push(loc);
    }
    return { written };
  };

  /** Apply a single field's new value to every selected SKU.
   * Sanitises legacy rows so a stale value in an *unrelated* field
   * (e.g. current_on_hand missing on an old SKU) doesn't block the
   * bulk edit. */
  const applyBulkEdit = async (field: BulkField, value: unknown) => {
    const targets = data.products.filter((p) => selectedIds.has(p.id));
    const failures: Array<{ sku: string; message: string }> = [];
    for (const p of targets) {
      const merged: Product = { ...p, [field]: value as never };
      const sanitized: Product = {
        ...merged,
        current_on_hand: Math.max(0, Number(merged.current_on_hand ?? 0) || 0),
        safety_stock_units: Math.max(0, Number(merged.safety_stock_units ?? 0) || 0),
        safety_stock_pct: Math.max(0, Number(merged.safety_stock_pct ?? 0) || 0),
      };
      try {
        const parsed = ProductSchema.parse(sanitized);
        // eslint-disable-next-line no-await-in-loop
        await m.upsertProduct.mutateAsync(parsed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ sku: p.code ?? p.id, message: msg });
      }
    }
    if (failures.length > 0) {
      const preview = failures.slice(0, 3).map((f) => `- ${f.sku}`).join("\n");
      throw new Error(
        `${failures.length} of ${targets.length} SKU${targets.length === 1 ? "" : "s"} could not be updated (validation failed on unrelated fields):\n${preview}${failures.length > 3 ? `\n...and ${failures.length - 3} more.` : ""}\n\nOpen each SKU individually to fix the invalid field, then retry.`,
      );
    }
  };

  const bulkDelete = async () => {
    const targets = Array.from(selectedIds);
    if (targets.length === 0) return;
    if (!window.confirm(`Delete ${targets.length} SKU${targets.length === 1 ? "" : "s"}? Sales and shipments for these SKUs will also be removed.`)) return;
    for (const id of targets) {
      // eslint-disable-next-line no-await-in-loop
      await m.deleteProduct.mutateAsync(id);
    }
    clearSelection();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">SKUs</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {data.products.length} total · {filtered.length} shown · drag the handle to reorder · tick rows to bulk-edit · double-click any number to edit it.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Import CSV
          </Button>
          <input ref={fileRef} type="file" accept=".csv,.xlsx" className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) importSkus(f);
            }} />
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} /> New SKU
          </Button>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input
          type="search" autoFocus
          placeholder="Search SKUs by code, size, colour, supplier, notes…"
          value={filter.q}
          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
          className="w-full h-10 pl-9 pr-9 rounded-lg border border-slate-300 bg-white text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        {filter.q ? (
          <button type="button" onClick={() => setFilter({ ...filter, q: "" })}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">
            <X size={14} />
          </button>
        ) : null}
      </div>

      {importMsg ? (
        <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 text-sm">{importMsg}</div>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Filter</CardTitle></CardHeader>
        <CardBody className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Field label="Size">
            <Select value={filter.size} onChange={(e) => setFilter({ ...filter, size: e.target.value })}>
              <option value="">All</option>
              {sizes.map((s) => (<option key={s} value={s}>{s}</option>))}
            </Select>
          </Field>
          <Field label="Colour">
            <Select value={filter.colour} onChange={(e) => setFilter({ ...filter, colour: e.target.value })}>
              <option value="">All</option>
              {colours.map((c) => (<option key={c} value={c}>{c}</option>))}
            </Select>
          </Field>
          <Field label="Supplier">
            <Select value={filter.supplier} onChange={(e) => setFilter({ ...filter, supplier: e.target.value })}>
              <option value="">All</option>
              {suppliers.map((s) => (<option key={s} value={s}>{s}</option>))}
            </Select>
          </Field>
          <Field label="Type" hint="Filter the list by product category. Consumables, packaging, services don't appear in Sales entry.">
            <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}>
              <option value="all">All types</option>
              {(Object.keys(PRODUCT_TYPE_LABELS) as ProductTypeKey[]).map((k) => (
                <option key={k} value={k}>{PRODUCT_TYPE_LABELS[k]}</option>
              ))}
            </Select>
          </Field>
          <div className="md:col-span-4 flex items-center justify-between gap-3">
            <div className="text-xs text-slate-500">
              {filtered.length} SKU{filtered.length === 1 ? "" : "s"} shown
              {reverseOrder ? " · reversed order" : ""}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={stageReverseAll} title="Stage a reversed display order. Click Save to commit.">↑↓ Reverse all</Button>
              <Button size="sm" variant="ghost" onClick={stageSortAZ} title="Stage alphabetical order (A to Z). Click Save to commit.">A→Z</Button>
              <Button size="sm" variant="ghost" onClick={stageSortZA} title="Stage reverse-alphabetical order (Z to A).">Z→A</Button>
              {draftOrder ? (
                <>
                  <span className="ml-1 inline-flex items-center rounded-full bg-amber-100 text-amber-800 text-[10px] font-semibold uppercase px-2 py-0.5 dark:bg-amber-900/30 dark:text-amber-200">
                    Unsaved order
                  </span>
                  <Button size="sm" variant="primary" onClick={() => void saveOrderDraft()} disabled={savingOrder}>
                    {savingOrder ? "Saving..." : "Save order"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={discardOrderDraft} disabled={savingOrder}>
                    Discard
                  </Button>
                </>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setReverseOrder((v) => !v)} title="View-only flip - does NOT change the saved order.">
                {reverseOrder ? "Restore view" : "Flip view"}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Bulk action bar — appears when at least one row is ticked */}
      {selectedIds.size > 0 ? (
        <div className="rounded-lg ring-1 ring-blue-200 dark:ring-blue-800 bg-blue-50 dark:bg-blue-900/20 px-4 py-2 flex flex-wrap items-center justify-between gap-3 sticky top-14 z-10">
          <div className="text-sm text-blue-900 dark:text-blue-200 font-medium">
            {selectedIds.size} SKU{selectedIds.size === 1 ? "" : "s"} selected
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setBulkEditOpen(true)}>
              <Wand2 size={14} /> Bulk edit
            </Button>
            <Button size="sm" variant="danger" onClick={bulkDelete}>
              <Trash2 size={14} /> Delete selected
            </Button>
            <Button size="sm" variant="secondary" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      <Card>
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="w-8 text-center">
                    <button
                      onClick={toggleAll}
                      aria-label={allFilteredSelected ? "Deselect all visible" : "Select all visible"}
                      className={cn(
                        "inline-flex h-5 w-5 items-center justify-center rounded",
                        someFilteredSelected ? "text-blue-600" : "text-slate-400 hover:text-slate-600",
                      )}
                    >
                      {allFilteredSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                    </button>
                  </th>
                  <th className="w-8" aria-label="Drag handle"> </th>
                  <th className="text-left font-medium px-4 py-2">Code</th>
                  <th className="text-left font-medium px-4 py-2">Short</th>
                  <th className="text-left font-medium px-4 py-2">Size · colour</th>
                  <th className="text-left font-medium px-4 py-2">Supplier</th>
                  <th className="text-right font-medium px-4 py-2">Lead</th>
                  <th className="text-right font-medium px-4 py-2">On hand</th>
                  <th className="text-right font-medium px-4 py-2" title="Safety stock as a % of weekly demand. Drives the Reorder alert threshold (Critical fires when weeks-left dips below the SKU's lead time).">Safety %</th>
                  <th className="text-right font-medium px-4 py-2" title="Weekly average demand from the forecast engine">Avg / wk</th>
                  <th className="text-right font-medium px-4 py-2" title="Weeks of cover until current stock runs out (engine forecast — includes pipeline shipments)">Weeks left</th>
                  <th className="text-left font-medium px-4 py-2">Status</th>
                  <th className="text-right font-medium px-4 py-2 w-px">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filtered.map((p) => {
                  const isSelected = selectedIds.has(p.id);
                  return (
                    <tr key={p.id}
                      className={cn(
                        "hover:bg-slate-50 dark:hover:bg-slate-900/40",
                        draggingId === p.id && "opacity-50",
                        isSelected && "bg-blue-50/60 dark:bg-blue-900/10",
                      )}
                      onDragOver={(e) => { if (draggingId && draggingId !== p.id) e.preventDefault(); }}
                      onDrop={() => { if (draggingId) reorder(draggingId, p.id); setDraggingId(null); }}>
                      <td className="text-center">
                        <button
                          onClick={() => toggleOne(p.id)}
                          aria-label={isSelected ? `Deselect ${p.code}` : `Select ${p.code}`}
                          className={cn(
                            "inline-flex h-5 w-5 items-center justify-center rounded",
                            isSelected ? "text-blue-600" : "text-slate-400 hover:text-slate-600",
                          )}
                        >
                          {isSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                        </button>
                      </td>
                      <td className="text-center cursor-grab active:cursor-grabbing text-slate-400"
                        draggable
                        onDragStart={() => setDraggingId(p.id)}
                        onDragEnd={() => setDraggingId(null)}
                        title="Drag to reorder">
                        <GripVertical size={14} />
                      </td>
                      <td className="px-4 py-2">
                        <Link to={`/skus/${p.id}`} className="font-medium hover:underline">{p.code}</Link>
                      </td>
                      <td className="px-4 py-2 text-slate-500">{shortCode(p)}</td>
                      <td className="px-4 py-2 text-slate-500">{p.size} · {p.colour}</td>
                      <td className="px-4 py-2 text-slate-500">{p.supplier}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        <EditableNumCell
                          value={p.lead_time_days}
                          suffix="d"
                          min={1}
                          isEditing={editCell?.id === p.id && editCell?.field === "lead_time_days"}
                          onStart={() => setEditCell({ id: p.id, field: "lead_time_days" })}
                          onCancel={() => setEditCell(null)}
                          onSave={(v) => saveQuickEdit(p, "lead_time_days", v)}
                        />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        <EditableNumCell
                          value={p.current_on_hand}
                          isEditing={editCell?.id === p.id && editCell?.field === "current_on_hand"}
                          onStart={() => setEditCell({ id: p.id, field: "current_on_hand" })}
                          onCancel={() => setEditCell(null)}
                          onSave={(v) => saveQuickEdit(p, "current_on_hand", v)}
                        />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        <EditableNumCell
                          value={p.safety_stock_pct ?? 100}
                          suffix="%"
                          isEditing={editCell?.id === p.id && editCell?.field === "safety_stock_pct"}
                          onStart={() => setEditCell({ id: p.id, field: "safety_stock_pct" })}
                          onCancel={() => setEditCell(null)}
                          onSave={(v) => saveQuickEdit(p, "safety_stock_pct", v)}
                        />
                      </td>
                      {(() => {
                        // Read-only forecast columns moved over from the Stock chart's
                        // "Selected SKUs at a glance" panel — Avg/wk, Weeks left, Status.
                        // MOQ + order increment are still editable from the SKU detail
                        // page and the row's Edit modal.
                        const r = forecastById[p.id];
                        const w = r?.weeksUntilOosCurrent;
                        const weeksCls = w == null
                          ? "text-slate-500"
                          : w <= 4
                            ? "text-red-600 dark:text-red-400 font-semibold"
                            : w <= 12
                              ? "text-amber-600 dark:text-amber-400 font-medium"
                              : "text-slate-700 dark:text-slate-300";
                        return (
                          <>
                            <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                              {r ? fmtFloat(r.weeklyAverage, 1) : "—"}
                            </td>
                            <td className={cn("px-4 py-2 text-right tabular-nums", weeksCls)}>
                              {w == null ? "52+" : `${fmtFloat(w, 1)}w`}
                            </td>
                            <td className="px-4 py-2">
                              {r ? <StatusPill status={r.status} /> : <span className="text-xs text-slate-400">—</span>}
                            </td>
                          </>
                        );
                      })()}
                      <td className="px-4 py-2 whitespace-nowrap text-right">
                        <button
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                          onClick={() => setEditing(p)}
                          aria-label={`Edit ${p.code}`} title="Edit">
                          <Pencil size={14} />
                        </button>
                        <button
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                          onClick={() => {
                            const others = data.products.filter((x) => x.id !== p.id);
                            if (others.length === 0) return;
                            const b = window.prompt("Compare with which SKU code?", others[0].code);
                            if (!b) return;
                            const target = data.products.find((x) => x.code === b);
                            if (target) setComparing({ a: p.id, b: target.id });
                          }}
                          aria-label={`Compare ${p.code}`} title="Compare">
                          <GitCompare size={14} />
                        </button>
                        <button
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                          onClick={() => {
                            if (window.confirm(`Delete ${p.code}? Sales and shipments for this SKU will also be removed.`))
                              m.deleteProduct.mutate(p.id);
                          }}
                          aria-label={`Delete ${p.code}`} title="Delete">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="text-center text-sm text-slate-500 py-10">
                      {q ? `No SKUs match "${filter.q}".` : "No SKUs match your filter."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <ProductFormModal
        open={creating || !!editing}
        product={editing}
        currentLocation={currentLocation}
        nextOrder={(data.products.reduce((max, p) => Math.max(max, p.display_order ?? 0), 0)) + 1}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSave={async (p, locations) => {
          if (editing) {
            await m.upsertProduct.mutateAsync(p);
          } else {
            await createAcrossLocations(p, locations);
          }
          setCreating(false); setEditing(null);
        }}
      />

      <BulkEditModal
        open={bulkEditOpen}
        count={selectedIds.size}
        suppliers={suppliers}
        onClose={() => setBulkEditOpen(false)}
        onApply={async (field, value) => {
          await applyBulkEdit(field, value);
          setBulkEditOpen(false);
        }}
      />

      {comparing ? (
        <CompareModal a={comparing.a} b={comparing.b} onClose={() => setComparing(null)} />
      ) : null}
    </div>
  );
}

// ---------- Bulk edit modal ----------

function BulkEditModal({
  open, count, suppliers, onClose, onApply,
}: {
  open: boolean;
  count: number;
  suppliers: string[];
  onClose: () => void;
  onApply: (field: BulkField, value: unknown) => Promise<void>;
}) {
  const [field, setField] = useState<BulkField>("supplier");
  const [stringValue, setStringValue] = useState("");
  const [numberValue, setNumberValue] = useState<string>("");
  const [methodValue, setMethodValue] = useState<Product["weekly_avg_method"]>("trailing_8");
  const [productTypeValue, setProductTypeValue] = useState<ProductTypeKey>("product");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setError(null); setBusy(false);
    }
  }, [open]);

  const fieldDef = BULK_FIELDS.find((f) => f.value === field)!;

  const submit = async () => {
    setError(null);
    let value: unknown;
    try {
      if (fieldDef.kind === "string") {
        if (!stringValue.trim()) throw new Error("Value can't be empty.");
        value = stringValue.trim();
      } else if (fieldDef.kind === "number") {
        const n = Number(numberValue);
        if (!Number.isFinite(n) || n < 0) throw new Error("Enter a non-negative number.");
        value = Math.floor(n);
      } else if (fieldDef.kind === "nullableNumber") {
        if (numberValue.trim() === "") {
          value = null;
        } else {
          const n = Number(numberValue);
          if (!Number.isFinite(n) || n < 0) throw new Error("Enter a non-negative number or leave blank for none.");
          value = n;
        }
      } else if (fieldDef.kind === "productType") {
        value = productTypeValue;
      } else {
        // method
        value = methodValue;
      }
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setBusy(true);
    try {
      await onApply(field, value);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Bulk edit ${count} SKU${count === 1 ? "" : "s"}`}>
      <div className="space-y-3">
        <div className="text-sm text-slate-600 dark:text-slate-400">
          Pick one field, set a new value, and apply it to every selected SKU at once. Edits only
          apply to the active location — switch locations and repeat if you want to update other
          regions.
        </div>

        <Field label="Field to edit">
          <Select value={field} onChange={(e) => setField(e.target.value as BulkField)}>
            {BULK_FIELDS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </Select>
        </Field>

        {fieldDef.kind === "string" ? (
          field === "supplier" && suppliers.length > 0 ? (
            <Field label="New supplier" hint="Pick an existing supplier or type a new one.">
              <Input list="bulk-supplier-list" value={stringValue} onChange={(e) => setStringValue(e.target.value)} placeholder="Supplier name" autoFocus />
              <datalist id="bulk-supplier-list">
                {suppliers.map((s) => (<option key={s} value={s} />))}
              </datalist>
            </Field>
          ) : (
            <Field label="New value">
              <Input value={stringValue} onChange={(e) => setStringValue(e.target.value)} autoFocus />
            </Field>
          )
        ) : null}

        {fieldDef.kind === "number" ? (
          <Field label="New value">
            <Input type="number" min={0} value={numberValue} onChange={(e) => setNumberValue(e.target.value)} autoFocus />
          </Field>
        ) : null}

        {fieldDef.kind === "nullableNumber" ? (
          <Field
            label="New value"
            hint={
              field === "unit_cost"
                ? "Leave blank to clear the unit cost."
                : "Leave blank for no value."
            }
          >
            <Input type="number" step="0.01" min={0} value={numberValue} onChange={(e) => setNumberValue(e.target.value)} autoFocus placeholder="(blank = clear)" />
          </Field>
        ) : null}

        {fieldDef.kind === "method" ? (
          <Field label="Weekly avg method">
            <Select value={methodValue} onChange={(e) => setMethodValue(e.target.value as Product["weekly_avg_method"])}>
              <option value="trailing_8">trailing_8</option>
              <option value="trailing_12">trailing_12</option>
              <option value="weighted">weighted</option>
              <option value="manual">manual</option>
              <option value="selected_weeks">selected_weeks</option>
            </Select>
          </Field>
        ) : null}

        {fieldDef.kind === "productType" ? (
          <Field label="New product type" hint={PRODUCT_TYPE_HINTS[productTypeValue]}>
            <Select value={productTypeValue} onChange={(e) => setProductTypeValue(e.target.value as ProductTypeKey)}>
              {(Object.keys(PRODUCT_TYPE_LABELS) as ProductTypeKey[]).map((k) => (
                <option key={k} value={k}>{PRODUCT_TYPE_LABELS[k]}</option>
              ))}
            </Select>
          </Field>
        ) : null}

        {error ? <div className="text-sm text-red-600 dark:text-red-400">{error}</div> : null}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Applying…" : `Apply to ${count}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Single-SKU form modal (unchanged from prior round) ----------

function ProductFormModal({
  open, product, currentLocation, nextOrder, onClose, onSave,
}: {
  open: boolean;
  product: Product | null;
  currentLocation: LocationKey;
  nextOrder: number;
  onClose: () => void;
  onSave: (p: Product, locations: LocationKey[]) => Promise<void>;
}) {
  const isEdit = !!product;
  const [form, setForm] = useState<Partial<Product>>(product ?? blankProduct(nextOrder));
  const [locations, setLocations] = useState<Set<LocationKey>>(new Set<LocationKey>([currentLocation]));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (product) {
      setForm(product);
      setLocations(new Set([currentLocation]));
    } else {
      setForm(blankProduct(nextOrder));
      setLocations(new Set([currentLocation]));
    }
  }, [product, currentLocation, nextOrder]);

  const set = (k: keyof Product, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open={open} onClose={onClose} title={product ? `Edit ${product.code}` : "New SKU"}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const parsed = ProductSchema.parse(form);
            const targets = Array.from(locations);
            if (!isEdit && targets.length === 0) {
              throw new Error("Tick at least one location to apply this SKU to.");
            }
            await onSave(parsed, isEdit ? [currentLocation] : targets);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
        className="grid grid-cols-2 gap-4">
        <Field label="Code"><Input required value={form.code ?? ""} onChange={(e) => set("code", e.target.value)} /></Field>
        <Field label="Short code (optional)" hint="e.g. A0N. Auto-derived from size + colour if blank.">
          <Input value={form.short_code ?? ""} onChange={(e) => set("short_code", e.target.value || null)} />
        </Field>
        <Field label="Product type" hint={PRODUCT_TYPE_HINTS[(form.product_type ?? "product") as ProductTypeKey]}>
          <Select value={form.product_type ?? "product"} onChange={(e) => set("product_type", e.target.value)}>
            {(Object.keys(PRODUCT_TYPE_LABELS) as ProductTypeKey[]).map((k) => (
              <option key={k} value={k}>{PRODUCT_TYPE_LABELS[k]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Supplier"><Input required value={form.supplier ?? ""} onChange={(e) => set("supplier", e.target.value)} /></Field>
        <Field label="Size"><Input value={form.size ?? ""} onChange={(e) => set("size", e.target.value)} placeholder="(optional)" /></Field>
        <Field label="Colour"><Input value={form.colour ?? ""} onChange={(e) => set("colour", e.target.value)} placeholder="(optional)" /></Field>
        <Field label="Lead time (days)"><Input type="number" min={1} value={form.lead_time_days ?? 28} onChange={(e) => set("lead_time_days", Number(e.target.value))} /></Field>
        <Field label="Current on hand"><Input type="number" min={0} value={form.current_on_hand ?? 0} onChange={(e) => set("current_on_hand", Number(e.target.value))} /></Field>
        <Field label="Safety stock %" hint="Percentage of weekly average demand. 100% = 1 week of cover, 200% = 2 weeks.">
          <Input type="number" min={0} step="10" value={form.safety_stock_pct ?? 100} onChange={(e) => set("safety_stock_pct", Number(e.target.value))} />
        </Field>
        <Field label="Min order qty"><Input type="number" min={0} value={form.min_order_qty ?? 0} onChange={(e) => set("min_order_qty", Number(e.target.value))} /></Field>
        <Field label="Order increment"><Input type="number" min={1} value={form.order_increment ?? 1} onChange={(e) => set("order_increment", Number(e.target.value))} /></Field>
        <Field label="Pallet capacity (units)"><Input type="number" min={0} value={form.pallet_capacity_units ?? 0} onChange={(e) => set("pallet_capacity_units", Number(e.target.value))} /></Field>
        <Field label="Weekly avg method">
          <Select value={form.weekly_avg_method ?? "trailing_8"} onChange={(e) => set("weekly_avg_method", e.target.value)}>
            <option value="trailing_8">trailing_8</option>
            <option value="trailing_12">trailing_12</option>
            <option value="weighted">weighted</option>
            <option value="manual">manual</option>
            <option value="selected_weeks">selected_weeks</option>
          </Select>
        </Field>
        <Field label="Manual avg (when method = manual)">
          <Input type="number" min={0} step="0.1" value={form.weekly_avg_manual ?? ""}
            onChange={(e) => set("weekly_avg_manual", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
        <Field label="Target weeks of cover" hint="Used by the Order builder's suggested qty (does not drive alerts).">
          <Input type="number" min={0} value={form.target_weeks_of_cover_override ?? 21}
            onChange={(e) => set("target_weeks_of_cover_override", e.target.value === "" ? 21 : Number(e.target.value))} />
        </Field>
        <Field label="Unit cost">
          <Input type="number" step="0.01" min={0} value={form.unit_cost ?? ""}
            onChange={(e) => set("unit_cost", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>

        {!isEdit ? (
          <div className="col-span-2">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Apply to locations</span>
            <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              Create this SKU in every location you tick. Each location gets its own copy.
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {LOCATIONS.map((l) => {
                const checked = locations.has(l);
                return (
                  <label key={l}
                    className={cn(
                      "inline-flex items-center gap-2 px-3 h-8 rounded-md ring-1 cursor-pointer text-xs",
                      checked
                        ? "bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:ring-slate-100"
                        : "ring-slate-300 dark:ring-slate-700 text-slate-700 dark:text-slate-300",
                    )}>
                    <input type="checkbox" className="sr-only"
                      checked={checked}
                      onChange={() => setLocations((s) => {
                        const next = new Set(s);
                        if (next.has(l)) next.delete(l); else next.add(l);
                        return next;
                      })} />
                    {LOCATION_LABELS[l]}{l === currentLocation ? " (current)" : ""}
                  </label>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="col-span-2 text-[11px] text-slate-500 dark:text-slate-400">
            Editing only updates this location ({LOCATION_LABELS[currentLocation]}). Switch
            location and edit there too if you want to change other regions.
          </div>
        )}

        {error ? <div className="col-span-2 text-sm text-red-600 dark:text-red-400">{error}</div> : null}
        <div className="col-span-2 flex justify-end gap-2 pt-1">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Inline double-click number editor ----------

function EditableNumCell({
  value, suffix, isEditing, onStart, onSave, onCancel, min = 0, step = 1,
}: {
  value: number;
  suffix?: string;
  isEditing: boolean;
  onStart: () => void;
  onCancel: () => void;
  onSave: (v: number) => void;
  min?: number;
  step?: number;
}) {
  const [draft, setDraft] = useState<string>(String(value));
  // Reset the draft whenever we (re)enter edit mode or the underlying value moves.
  useEffect(() => {
    if (isEditing) setDraft(String(value));
  }, [isEditing, value]);

  if (isEditing) {
    const commit = () => {
      const n = Number(draft);
      if (Number.isFinite(n) && n >= min) onSave(n); else onCancel();
    };
    return (
      <input
        autoFocus
        type="number"
        min={min}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); }
          else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        className="w-20 h-7 px-1 text-right tabular-nums rounded border border-blue-400 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-300"
      />
    );
  }

  return (
    <button
      type="button"
      onDoubleClick={onStart}
      title="Double-click to edit"
      className="inline-flex justify-end min-w-[1.5rem] tabular-nums px-1 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-text"
    >
      {fmtNum(value)}{suffix ?? ""}
    </button>
  );
}

function blankProduct(nextOrder: number): Partial<Product> {
  return {
    id: `sku-${cryptoId()}`,
    code: "", short_code: null, size: "", colour: "",
    unit_of_sale: "each",
    pallet_capacity_units: 100, bay_capacity_pallets: 2,
    supplier: "", lead_time_days: 28,
    min_order_qty: 0, order_increment: 1,
    current_on_hand: 0, safety_stock_units: 0, safety_stock_pct: 100,
    target_weeks_of_cover_override: 21,
    weekly_avg_method: "trailing_8", weekly_avg_manual: null,
    unit_cost: null, display_order: nextOrder, notes: "",
  };
}
function uniq(xs: string[]): string[] { return Array.from(new Set(xs)).sort(); }
/** Optional numeric column - empty / unparseable -> null, valid number -> that number. */
function parseOptNumber(s: string | undefined): number | null {
  if (s === undefined || s === null || String(s).trim() === "") return null;
  const n = numOr(s, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

function numOr(s: string | undefined, fallback: number): number {
  if (s === undefined || s === null) return fallback;
  const trimmed = String(s).trim();
  if (trimmed === "") return fallback;
  // Handle European decimals ("1,5" -> 1.5) and stripped thousand separators
  // ("1.000,5" -> 1000.5). If the string has both . and , the *last* one is
  // the decimal mark; everything else is a grouping separator and removed.
  const lastComma = trimmed.lastIndexOf(",");
  const lastDot = trimmed.lastIndexOf(".");
  let cleaned = trimmed;
  if (lastComma > -1 && lastComma > lastDot) {
    cleaned = trimmed.replace(/\./g, "").replace(",", ".");
  } else if (lastComma > -1 && lastDot === -1) {
    // single comma with no dot - assume decimal mark.
    cleaned = trimmed.replace(",", ".");
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}
function cryptoId(): string { return Math.random().toString(36).slice(2, 10); }

// silence unused
void (null as ReactNode);
