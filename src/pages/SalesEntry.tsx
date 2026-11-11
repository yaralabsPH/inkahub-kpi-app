import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarPlus, Plus, Trash2, Star, StarOff, Upload, ClipboardPaste, CheckSquare, Square, PackageMinus, FileSpreadsheet } from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { useMutations } from "@/lib/hooks/useMutations";
import { useAppStore } from "@/lib/state/appStore";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Input";
import {
  shortCode, SALEABLE_PRODUCT_TYPES, productDepartment,
  type Product, type WeeklyEntry, type WeeklySales,
} from "@/lib/domain";
import { addDays, parseIsoDate, todayIso } from "@/lib/utils/dates";
import { fmtFloat, fmtNum } from "@/lib/utils/format";
import { parseCsv } from "@/lib/csv/csv";
import { downloadXlsx } from "@/lib/csv/xlsx";
import {
  looksLikeShopifyReport, parseShopifyCsv, type ShopifyParseResult,
} from "@/lib/csv/shopifyReport";
import { ShopifyImportModal } from "@/components/ShopifyImportModal";
import { CsvColumnMapper, type MapperRow } from "@/components/CsvColumnMapper";
import { cn } from "@/lib/utils/cn";

type ColourFilter = "all" | string;
type FooterMetric =
  | "median" | "mean" | "sum" | "min" | "max"
  | "range" | "stdev" | "p25" | "p75" | "count";

const METRICS: { value: FooterMetric; label: string }[] = [
  { value: "median", label: "Median" }, { value: "mean", label: "Mean" },
  { value: "sum", label: "Sum" }, { value: "min", label: "Min" },
  { value: "max", label: "Max" }, { value: "range", label: "Range" },
  { value: "stdev", label: "Std dev" }, { value: "p25", label: "25th pct" },
  { value: "p75", label: "75th pct" }, { value: "count", label: "Count" },
];

export function SalesEntry() {
  const { data } = useDataset();
  const m = useMutations();
  // Active department from app state — drives product filtering, entry
  // filtering, mutations, and import routing. Switching the topbar toggle
  // flips the whole page from "framed view" to "unframed view".
  const department = useAppStore((s) => s.department);

  const [colour, setColour] = useState<ColourFilter>("all");
  const [customSuppliers, setCustomSuppliers] = useState<Set<string>>(new Set());
  const [shopifyResult, setShopifyResult] = useState<ShopifyParseResult | null>(null);
  const [shopifyWeek, setShopifyWeek] = useState<string>(todayIso());
  const [showShopifyModal, setShowShopifyModal] = useState(false);
  const [mapperState, setMapperState] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [metric, setMetric] = useState<FooterMetric>("median");
  const [metricScope, setMetricScope] = useState<"all" | "selected">("all");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [newDate, setNewDate] = useState<string>("");
  const [showNotionPaste, setShowNotionPaste] = useState(false);
  const [showBulkUsage, setShowBulkUsage] = useState(false);
  const [selectedWeeks, setSelectedWeeks] = useState<Set<string>>(new Set());
  // findEntry is department-scoped: legacy rows (pre-v9) default to 'framed'
  // so the framed view picks them up exactly as it did before.
  const findEntry = (iso: string): WeeklyEntry | undefined =>
    data?.entries.find(
      (e) => e.iso_week_start === iso && (e.department ?? "framed") === department,
    );
  const fileRef = useRef<HTMLInputElement>(null);


  // Visible SKU columns — sorted by user-defined display_order. Non-
  // saleable types (consumables, packaging, services) are excluded; they
  // never appear in the sales grid. Tracked in inventory still — just
  // not edited here.
  const visibleSkus: Product[] = useMemo(() => {
    if (!data) return [];
    const all = data.products
      .filter((p) => SALEABLE_PRODUCT_TYPES.has(p.product_type ?? "product"))
      // Department gate — products are partitioned by their supplier field
      // via productDepartment(). UNFRAMED supplier → unframed; everything
      // else → framed. Switching the topbar toggle changes the column set.
      .filter((p) => productDepartment(p) === department)
      .slice()
      .sort((a, b) => {
        const ao = a.display_order ?? 9_999_999;
        const bo = b.display_order ?? 9_999_999;
        if (ao !== bo) return ao - bo;
        return shortCode(a).localeCompare(shortCode(b));
      });
    if (colour === "all") return all;
    if (colour === "custom") {
      // No suppliers picked = show nothing (matches the empty-state hint).
      if (customSuppliers.size === 0) return [];
      return all.filter((p) => customSuppliers.has(p.supplier));
    }
    return all.filter((p) => p.colour === colour);
  }, [data, colour, customSuppliers, department]);

  const visibleEntries: WeeklyEntry[] = useMemo(() => {
    if (!data) return [];
    let entries = data.entries
      // Department gate. Pre-v9 rows without an explicit department default
      // to 'framed' (matches the upgrade backfill).
      .filter((e) => (e.department ?? "framed") === department)
      .slice();
    if (from) entries = entries.filter((e) => e.iso_week_start >= from);
    if (to) entries = entries.filter((e) => e.iso_week_start <= to);
    // When a supplier / colour filter is active, hide weeks that have no
    // sales for the visible SKUs. Reference weeks (★) are always kept so
    // the user can compare against their starred baselines, regardless of
    // whether the filtered supplier had activity that week.
    if (colour !== "all") {
      const visibleSkuIds = new Set(visibleSkus.map((p) => p.id));
      const activeWeeks = new Set<string>();
      for (const s of data.sales) {
        if (visibleSkuIds.has(s.product_id) && s.units_sold > 0) {
          activeWeeks.add(s.iso_week_start);
        }
      }
      entries = entries.filter((e) => e.is_reference || activeWeeks.has(e.iso_week_start));
    }
    return entries.sort((a, b) => b.iso_week_start.localeCompare(a.iso_week_start));
  }, [data, from, to, colour, visibleSkus, department]);

  const salesIndex = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    if (!data) return out;
    for (const s of data.sales) (out[s.iso_week_start] ??= {})[s.product_id] = s.units_sold;
    return out;
  }, [data]);

  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  const today = todayIso();
  const currentWeekStart = snapToWeekStart(today, data.settings.week_start_day);
  const autoAdjust = data.settings.auto_adjust_inventory_on_sale ?? true;

  const totalFrames = (weekStart: string): number => {
    const row = salesIndex[weekStart] ?? {};
    let total = 0;
    for (const sku of visibleSkus) total += row[sku.id] ?? 0;
    return total;
  };

  const footerValues = useMemo(() => {
    const rowsForMetric = metricScope === "selected"
      ? visibleEntries.filter((e) => e.is_reference)
      : visibleEntries;
    const compute = (xs: number[]) => computeMetric(metric, xs);
    const perSku: Record<string, number | null> = {};
    for (const sku of visibleSkus) {
      const xs = rowsForMetric
        .map((e) => salesIndex[e.iso_week_start]?.[sku.id])
        .filter((v): v is number => v !== undefined);
      perSku[sku.id] = xs.length === 0 ? null : compute(xs);
    }
    const totalOrdersValues = rowsForMetric
      .map((e) => e.total_orders)
      .filter((v): v is number => v !== null && v !== undefined);
    const totalFramesValues = rowsForMetric.map((e) => totalFrames(e.iso_week_start));
    return {
      perSku,
      totalOrders: totalOrdersValues.length === 0 ? null : compute(totalOrdersValues),
      totalFrames: totalFramesValues.length === 0 ? null : compute(totalFramesValues),
      sampleSize: rowsForMetric.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric, metricScope, visibleEntries, visibleSkus, salesIndex]);

  const flash = (msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(null), 3500);
  };

  /**
   * Download the currently visible Sales Entry data as an Excel workbook.
   * Two sheets:
   *  - Wide — one row per week, columns: Date / Notes / Total orders / per
   *    visible SKU's units / Total (visible-skus sum). Matches the table.
   *  - Long — one row per (sku, week) sale, with supplier/size/colour for
   *    pivot-friendly analysis.
   * Filename reflects the active filter (All / one supplier / multi-supplier)
   * so multiple exports don't clobber each other.
   */
  const exportSalesXlsx = () => {
    if (!data) return;
    const skus = visibleSkus;
    const entries = visibleEntries;
    const salesByWeekSku: Record<string, Record<string, number>> = {};
    for (const s of data.sales) {
      (salesByWeekSku[s.iso_week_start] ??= {})[s.product_id] = s.units_sold;
    }

    // ---- Wide sheet (matches table) ----
    const wideHeaders = [
      "Week starting",
      "Reference",
      "Notes",
      "Total orders (global)",
      ...skus.map((p) => p.code),
      "Total (visible SKUs)",
    ];
    const wideRows: (string | number)[][] = entries.map((e) => {
      const row: (string | number)[] = [
        e.iso_week_start,
        e.is_reference ? "yes" : "",
        e.name ?? "",
        e.total_orders ?? "",
      ];
      let subtotal = 0;
      for (const sku of skus) {
        const v = salesByWeekSku[e.iso_week_start]?.[sku.id];
        row.push(v ?? "");
        if (typeof v === "number") subtotal += v;
      }
      row.push(subtotal);
      return row;
    });

    // ---- Long sheet ----
    const longHeaders = [
      "Week starting", "SKU code", "Short code", "Size", "Colour", "Supplier", "Units sold",
    ];
    const longRows: (string | number)[][] = [];
    for (const e of entries) {
      for (const sku of skus) {
        const v = salesByWeekSku[e.iso_week_start]?.[sku.id];
        if (v == null) continue;
        longRows.push([
          e.iso_week_start,
          sku.code,
          shortCode(sku),
          sku.size,
          sku.colour,
          sku.supplier,
          v,
        ]);
      }
    }

    // ---- Filename ----
    const today = todayIso();
    let label = "all";
    if (colour === "custom") {
      const picked = Array.from(customSuppliers);
      if (picked.length === 1) {
        label = picked[0].replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      } else if (picked.length > 1) {
        label = `multi-${picked.length}-suppliers`;
      } else {
        label = "custom-empty";
      }
    } else if (colour !== "all") {
      label = colour.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    }
    const filename = `sales-${label}-${today}.xlsx`;

    downloadXlsx(filename, [
      { name: "Wide", headers: wideHeaders, rows: wideRows },
      { name: "Long", headers: longHeaders, rows: longRows },
    ]);
    flash(`Exported ${entries.length} week${entries.length === 1 ? "" : "s"} × ${skus.length} SKU${skus.length === 1 ? "" : "s"} → ${filename}`);
  };

  // -------- bulk-selection helpers --------
  const visibleWeekKeys = visibleEntries.map((e) => e.iso_week_start);
  const allVisibleSelected =
    visibleWeekKeys.length > 0 && visibleWeekKeys.every((k) => selectedWeeks.has(k));
  const someVisibleSelected = visibleWeekKeys.some((k) => selectedWeeks.has(k));

  const toggleWeek = (iso: string) =>
    setSelectedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso); else next.add(iso);
      return next;
    });
  const toggleAllVisible = () =>
    setSelectedWeeks((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const k of visibleWeekKeys) next.delete(k);
      } else {
        for (const k of visibleWeekKeys) next.add(k);
      }
      return next;
    });
  const clearSelection = () => setSelectedWeeks(new Set());

  const bulkSetReference = async (value: boolean) => {
    const targets = data.entries.filter((e) => selectedWeeks.has(e.iso_week_start));
    for (const e of targets) {
      // eslint-disable-next-line no-await-in-loop
      await m.upsertWeeklyEntry.mutateAsync({
        ...e,
        is_reference: value,
        entered_at: new Date().toISOString(),
      });
    }
  };
  const bulkDeleteWeeks = async () => {
    const targets = Array.from(selectedWeeks);
    if (targets.length === 0) return;
    // Inventory behaviour follows the global "Auto-adjust inventory on
    // sale" setting — the same setting that governs per-row deletes. ON
    // means credits flow back through the ledger (slower); OFF means
    // they don't (faster). Spell that out in the confirmation so the
    // user knows what to expect.
    const msg = autoAdjust
      ? `Delete ${targets.length} ${department} week${targets.length === 1 ? "" : "s"}?\n\n` +
        `Sales for those weeks will be removed and inventory will be credited back automatically (Auto-adjust inventory is ON).`
      : `Delete ${targets.length} ${department} week${targets.length === 1 ? "" : "s"}?\n\n` +
        `Sales for those weeks will be removed. Inventory on_hand will NOT be credited back (Auto-adjust inventory is OFF). Turn it on in Settings if you want the credit.`;
    if (!window.confirm(msg)) return;
    // Bulk path — single transaction in Dexie, batched DELETEs in Supabase,
    // no per-sale inventory cascade. Way faster than calling deleteWeeklyEntry
    // per row. The trade-off is that on_hand isn't credited back for the
    // deleted sales — fine for bulk cleanup before a re-import (which
    // rewrites the right on_hand anyway), but if you need the cascade use
    // the trash icon on a single row instead.
    await m.bulkDeleteWeeklyEntries.mutateAsync(
      targets.map((iso) => ({ iso_week_start: iso, department })),
    );
    clearSelection();
  };

  const addRowAt = async (iso: string) => {
    if (!iso) return;
    // Existence check is now department-scoped — framed and unframed each
    // get their own row for the same week.
    if (data.entries.some(
      (e) => e.iso_week_start === iso && (e.department ?? "framed") === department,
    )) {
      flash(`A ${department} row already exists for ${iso}.`);
      setShowAddPicker(false);
      return;
    }
    await m.upsertWeeklyEntry.mutateAsync({
      iso_week_start: iso,
      department,
      name: null,
      total_orders: null,
      is_reference: false,
      entered_at: new Date().toISOString(),
      entered_by: "manual",
      shopify_orders_by_size: {},
    });
    setShowAddPicker(false); setNewDate("");
  };

  const addCurrentWeek = () => addRowAt(currentWeekStart);

  const renameRow = (oldIso: string, newIso: string) => {
    if (!newIso || newIso === oldIso) return;
    if (data.entries.some(
      (e) => e.iso_week_start === newIso && (e.department ?? "framed") === department,
    )) {
      flash(`A ${department} row already exists for ${newIso}. Pick a different date.`);
      return;
    }
    m.renameWeeklyEntry.mutate(
      { oldIso, newIso, department },
      { onError: (err) => flash(`Move failed: ${(err as Error).message}`) },
    );
  };

  const setRow = (weekStart: string, patch: Partial<WeeklyEntry>) => {
    const existing = findEntry(weekStart);
    const merged: WeeklyEntry = {
      iso_week_start: weekStart,
      department: existing?.department ?? department,
      name: existing?.name ?? null,
      total_orders: existing?.total_orders ?? null,
      is_reference: existing?.is_reference ?? false,
      entered_at: new Date().toISOString(),
      entered_by: existing?.entered_by ?? "manual",
      shopify_orders_by_size: existing?.shopify_orders_by_size ?? {},
      ...patch,
    };
    m.upsertWeeklyEntry.mutate(merged);
  };

  /**
   * Cell commit. If `auto_adjust_inventory_on_sale`, decrement the
   * Product.current_on_hand by (newValue - oldValue). This keeps inventory
   * in sync with sales without the user manually adjusting on-hand.
   */
  const setCell = (productId: string, weekStart: string, raw: string) => {
    const cleaned = raw.trim();
    const oldValue = salesIndex[weekStart]?.[productId];
    const newValue = cleaned === "" ? null : Number(cleaned);
    if (newValue !== null && (!Number.isFinite(newValue) || newValue < 0)) return;

    if (newValue === null) {
      // deleteSale now credits inventory back atomically (with BOM
      // cascade) inside the repo layer. No UI-side adjustInventory
      // call needed — and adding one would double-credit.
      m.deleteSale.mutate({ productId, isoWeekStart: weekStart });
      return;
    }

    const old = oldValue ?? 0;
    if (autoAdjust && newValue !== old) {
      adjustInventory(productId, newValue - old, {
        reason: "sale",
        source_id: `sale:${productId}:${weekStart}`,
        note: `Sale entered (${old} → ${newValue})`,
      });
    }
    m.upsertSale.mutate({
      product_id: productId, iso_week_start: weekStart,
      units_sold: newValue,
      entered_at: new Date().toISOString(), entered_by: "manual",
    });
  };

  /**
   * Apply +delta sales → -delta inventory atomically (transactional read-
   * modify-write inside Dexie). Two fast in-a-row edits to the same SKU
   * can't race each other now.
   */
  const adjustInventory = (
    productId: string,
    delta: number,
    context?: Parameters<typeof m.adjustOnHand.mutate>[0]["context"],
  ) => {
    if (!delta) return;
    m.adjustOnHand.mutate({ productId, delta, context });
  };

  const onPasteCell = (
    e: React.ClipboardEvent<HTMLInputElement>,
    rowIdx: number, colIdx: number,
  ) => {
    const txt = e.clipboardData.getData("text");
    if (!txt || (!txt.includes("\t") && !txt.includes("\n") && !txt.includes(","))) return;
    e.preventDefault();
    const grid = txt.replace(/\r\n/g, "\n").split("\n").map((r) => r.split(/[\t,]/));
    const updates: WeeklySales[] = [];
    const newEntries: WeeklyEntry[] = [];
    const inventoryDeltas: Record<string, number> = {};
    // Track the last week we've assigned so we can synthesise +7d steps when
    // the paste extends past the bottom of the table.
    let lastWeek = visibleEntries[visibleEntries.length - 1]?.iso_week_start;
    for (let r = 0; r < grid.length; r++) {
      let week = visibleEntries[rowIdx + r]?.iso_week_start;
      if (!week) {
        // Past the end — generate a fresh entry one week after the last.
        if (!lastWeek) break;
        week = addDays(lastWeek, 7);
        newEntries.push({
          iso_week_start: week,
          department,
          name: null,
          total_orders: null,
          is_reference: false,
          entered_at: new Date().toISOString(),
          entered_by: "paste",
          shopify_orders_by_size: {},
        });
      }
      lastWeek = week;
      for (let c = 0; c < grid[r].length; c++) {
        const sku = visibleSkus[colIdx + c];
        if (!sku) break;
        const cell = grid[r][c].trim();
        if (cell === "") continue;
        const num = Number(cell);
        if (!Number.isFinite(num) || num < 0) continue;
        const old = salesIndex[week]?.[sku.id] ?? 0;
        if (autoAdjust) inventoryDeltas[sku.id] = (inventoryDeltas[sku.id] ?? 0) + (num - old);
        updates.push({
          product_id: sku.id, iso_week_start: week, units_sold: num,
          entered_at: new Date().toISOString(), entered_by: "paste",
        });
      }
    }
    // Order matters: create the parent entries first, then sales rows.
    for (const ne of newEntries) m.upsertWeeklyEntry.mutate(ne);
    if (updates.length) m.bulkUpsertSales.mutate(updates);
    if (autoAdjust) {
      for (const [pid, delta] of Object.entries(inventoryDeltas)) {
        if (delta !== 0) adjustInventory(pid, delta);
      }
    }
  };

  const onCellKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" && e.key !== "Tab") return;
    e.preventDefault();
    const t = e.currentTarget;
    const r = Number(t.dataset.row); const c = Number(t.dataset.col);
    if (Number.isNaN(r) || Number.isNaN(c)) return;
    const dir = e.shiftKey ? -1 : 1;
    const next = e.key === "Tab" ? findCell(r, c + dir) : findCell(r + dir, c);
    next?.focus(); next?.select();
  };

  const importCsv = async (file: File) => {
    setImportMsg(null);
    try {
      // Strip a UTF-8 BOM if present (Notion's CSV export has one).
      const raw = (await file.text()).replace(/^\ufeff/, "");

      // ---- Shopify weekly report? Detect by header content. -----------
      // Routes the user to the confirmation modal where they can pick the
      // week and review per-(size, colour) totals before writing.
      if (looksLikeShopifyReport(raw)) {
        try {
          const result = parseShopifyCsv(raw);
          if (result.totalOrders === 0 && result.buckets.length === 0) {
            setImportMsg("Shopify CSV detected but had no usable rows.");
            return;
          }
          // Best-effort default week: parse YYYY-MM-DD from the filename
          // (Shopify writes the report's generation date there) and snap
          // to the Monday of that week. The user can override in the modal.
          const fileDateMatch = file.name.match(/(\d{4}-\d{2}-\d{2})/);
          const seed = fileDateMatch ? fileDateMatch[1] : todayIso();
          setShopifyWeek(snapToWeekStart(seed, data.settings.week_start_day));
          setShopifyResult(result);
          setShowShopifyModal(true);
          setImportMsg(`Shopify report detected \u2014 ${result.totalOrders} orders, ${result.totalFrames} frames. Confirm in the dialog.`);
          return;
        } catch (e) {
          setImportMsg(`Shopify import failed: ${(e as Error).message}`);
          return;
        }
      }

      const rows = parseCsv(raw);
      if (rows.length < 2) throw new Error("CSV is empty.");
      const header = rows[0].map((h) => h.trim());
      const lowered = header.map((h) => h.toLowerCase());

      // ---- Long format: sku_code, iso_week_start, units_sold ----
      const codeIdx = lowered.indexOf("sku_code");
      const wkIdx = lowered.indexOf("iso_week_start");
      const unitsIdx = lowered.indexOf("units_sold");
      if (codeIdx >= 0 && wkIdx >= 0 && unitsIdx >= 0) {
        const updates: WeeklySales[] = [];
        const newEntries = new Map<string, WeeklyEntry>();
        for (const row of rows.slice(1)) {
          const code = row[codeIdx]?.trim();
          const sku = data.products.find((p) => p.code === code || shortCode(p) === code);
          if (!sku) continue;
          const wk = row[wkIdx]?.trim();
          if (!wk || !/^\d{4}-\d{2}-\d{2}$/.test(wk)) continue;
          const units = Number(row[unitsIdx]);
          if (!Number.isFinite(units) || units < 0) continue;
          updates.push({
            product_id: sku.id, iso_week_start: wk, units_sold: units,
            entered_at: new Date().toISOString(), entered_by: "csv",
          });
          if (!findEntry(wk) && !newEntries.has(wk)) {
            newEntries.set(wk, {
              iso_week_start: wk,
              department,
              name: null,
              total_orders: null,
              is_reference: false,
              entered_at: new Date().toISOString(),
              entered_by: "csv",
              shopify_orders_by_size: {},
            });
          }
        }
        for (const e of newEntries.values()) await m.upsertWeeklyEntry.mutateAsync(e);
        await m.bulkUpsertSales.mutateAsync(updates);
        setImportMsg(
          `Imported ${updates.length} rows across ${newEntries.size} week${newEntries.size === 1 ? "" : "s"}.`,
        );
        return;
      }

      // ---- Wide format (Notion's CSV export shape) ----
      // Required: a "Date" column. Optional: Checkbox / Type / Name / Total Orders.
      // Every other header becomes a SKU column matched by code or short code.
      const dateIdx = lowered.indexOf("date");
      if (dateIdx < 0) {
        // Unknown shape — hand the user a column-mapper instead of erroring.
        setMapperState({ headers: header, rows: rows.slice(1) });
        setImportMsg("CSV shape not auto-detected — pick the columns to map in the dialog.");
        return;
      }
      const checkboxIdx = lowered.indexOf("checkbox");
      const typeIdx = lowered.indexOf("type");
      const nameIdx = lowered.indexOf("name");
      // "Notes" is mapped to the entry name as a fallback when there's no
      // dedicated "Name" column. The Notion unframed-record-keeping export
      // uses Notes for week labels (e.g. "Black Friday Week").
      const notesIdx = lowered.indexOf("notes");
      const totalOrdersIdx = lowered.indexOf("total orders");

      const reservedKeys = new Set([
        "checkbox", "type", "date", "name", "notes",
        "total orders", "total frames", "total prints", "",
      ]);

      // Heuristic: is a SKU the "unframed" variant for its size?
      // Naming convention is `A{N}U` short-code (per the Shopify importer)
      // or codes/colour fields containing "unframed" / "print".
      const isUnframedSku = (p: typeof data.products[number]): boolean => {
        const sc = (p.short_code ?? "").toLowerCase();
        const haystack = `${p.code} ${p.colour}`.toLowerCase();
        return sc.endsWith("u") || sc.endsWith("p") || /unframed|print/.test(haystack);
      };

      const skuColumns: { idx: number; product: typeof data.products[number] }[] = [];
      for (let i = 0; i < header.length; i++) {
        if (reservedKeys.has(lowered[i])) continue;
        const target = header[i].trim();
        if (!target) continue;
        // 1) exact code / short code match (case-insensitive).
        let sku = data.products.find(
          (p) => p.code === target || shortCode(p) === target ||
                 p.code.toLowerCase() === target.toLowerCase() ||
                 shortCode(p).toLowerCase() === target.toLowerCase(),
        );
        // Tolerant size-equality: trim + uppercase + strip stray spaces /
        // dashes so "A 0", "a-0", "A0 " all collapse to "A0".
        const normSize = (s: string) => s.trim().toUpperCase().replace(/[\s-]+/g, "");
        // 2a) "A0 Prints Ordered" → unframed SKU at this size. Prefer the
        //     A{N}U / "unframed" / "print" variant; if none exists, fall
        //     back to any SKU at that size so the column still imports.
        if (!sku) {
          const printsMatch = target.match(/^(A\d)\b.*\bprints?\b/i);
          if (printsMatch) {
            const size = normSize(printsMatch[1]);
            const sameSize = data.products.filter((p) => normSize(p.size) === size);
            sku = sameSize.find(isUnframedSku) ?? sameSize[0];
          }
        }
        // 2b) "A0 Frames Ordered" → framed SKU at this size. Prefer
        //     anything NOT flagged unframed; fall back to first match.
        if (!sku) {
          const framesMatch = target.match(/^(A\d)\b.*\bframes?\b/i);
          if (framesMatch) {
            const size = normSize(framesMatch[1]);
            const sameSize = data.products.filter((p) => normSize(p.size) === size);
            sku = sameSize.find((p) => !isUnframedSku(p)) ?? sameSize[0];
          }
        }
        if (sku) skuColumns.push({ idx: i, product: sku });
      }
      if (skuColumns.length === 0) {
        throw new Error(
          "Couldn't match any column header to one of your SKU codes (e.g. A0-Natural / A0U). " +
          "\"A0 Frames Ordered\" maps to the framed A0 SKU; \"A0 Prints Ordered\" maps to the unframed A0 SKU (short code A0U).",
        );
      }

      const updates: WeeklySales[] = [];
      const newEntries = new Map<string, WeeklyEntry>();
      let skippedNoDate = 0;
      let skippedStockCount = 0;
      for (const row of rows.slice(1)) {
        const rawDate = row[dateIdx]?.trim();
        if (!rawDate) { skippedNoDate++; continue; }
        // Skip "Stock Count" rows — those aren't usage data.
        if (typeIdx >= 0 && (row[typeIdx] ?? "").trim().toLowerCase() === "stock count") {
          skippedStockCount++; continue;
        }
        const iso = parseNotionDate(rawDate);
        if (!iso) { skippedNoDate++; continue; }

        const isRef = checkboxIdx >= 0
          ? ["yes", "true", "✓", "checked", "1"].includes((row[checkboxIdx] ?? "").trim().toLowerCase())
          : false;
        const totalOrders = totalOrdersIdx >= 0 && row[totalOrdersIdx]?.trim()
          ? Number(row[totalOrdersIdx])
          : null;
        // Prefer an explicit "Name" column; otherwise fall back to "Notes"
        // so labels like "Black Friday Week" from the unframed Notion
        // export aren't lost.
        const explicitName = nameIdx >= 0 ? (row[nameIdx]?.trim() || null) : null;
        const fromNotes = notesIdx >= 0 ? (row[notesIdx]?.trim() || null) : null;
        const name = explicitName ?? fromNotes;

        const existing = findEntry(iso);
        const merged: WeeklyEntry = {
          iso_week_start: iso,
          department: existing?.department ?? department,
          name: name ?? existing?.name ?? null,
          total_orders: totalOrders ?? existing?.total_orders ?? null,
          is_reference: isRef || (existing?.is_reference ?? false),
          entered_at: new Date().toISOString(),
          entered_by: "csv",
          shopify_orders_by_size: existing?.shopify_orders_by_size ?? {},
        };
        newEntries.set(iso, merged);

        for (const { idx, product } of skuColumns) {
          const cell = row[idx]?.trim();
          if (!cell) continue;
          const num = Number(cell);
          if (!Number.isFinite(num) || num < 0) continue;
          updates.push({
            product_id: product.id, iso_week_start: iso, units_sold: num,
            entered_at: new Date().toISOString(), entered_by: "csv",
          });
        }
      }

      for (const e of newEntries.values()) await m.upsertWeeklyEntry.mutateAsync(e);
      if (updates.length) await m.bulkUpsertSales.mutateAsync(updates);

      const parts = [
        `Imported ${updates.length} sales row${updates.length === 1 ? "" : "s"}`,
        `across ${newEntries.size} week${newEntries.size === 1 ? "" : "s"}`,
        `for ${skuColumns.length} SKU column${skuColumns.length === 1 ? "" : "s"}`,
      ];
      if (skippedStockCount > 0) parts.push(`(skipped ${skippedStockCount} Stock Count row${skippedStockCount === 1 ? "" : "s"})`);
      if (skippedNoDate > 0) parts.push(`(skipped ${skippedNoDate} row${skippedNoDate === 1 ? "" : "s"} with bad date)`);
      setImportMsg(parts.join(" ") + ".");
    } catch (e) {
      setImportMsg(`Import failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sales entry</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {visibleEntries.length} row{visibleEntries.length === 1 ? "" : "s"} ·{" "}
            {visibleSkus.length} SKU{visibleSkus.length === 1 ? "" : "s"} ·
            {autoAdjust ? " inventory auto-adjusts on sale " : " manual inventory "}·
            click any date to edit.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowNotionPaste(true)}>
            <ClipboardPaste size={14} /> Paste from Notion
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShowBulkUsage(true)}>
            <PackageMinus size={14} /> Bulk usage
          </Button>
          <Button variant="secondary" size="sm" onClick={exportSalesXlsx}
            disabled={visibleSkus.length === 0 || visibleEntries.length === 0}>
            <FileSpreadsheet size={14} /> Export
          </Button>
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Import CSV
          </Button>
          <input
            ref={fileRef} type="file" accept=".csv" className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) importCsv(f);
            }}
          />
          <Button variant="secondary" size="sm" onClick={addCurrentWeek}>
            <CalendarPlus size={14} /> Add current week
          </Button>
          <div className="relative">
            <Button size="sm" onClick={() => setShowAddPicker((v) => !v)}>
              <Plus size={14} /> Add row
            </Button>
            {showAddPicker ? (
              <div role="dialog" aria-label="Pick a date"
                className="absolute right-0 top-9 z-20 rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 shadow-xl p-3 w-72">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">New row date</div>
                <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} autoFocus />
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setShowAddPicker(false)}>Cancel</Button>
                  <Button size="sm" disabled={!newDate} onClick={() => addRowAt(newDate)}>Add row</Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {importMsg ? (
        <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 text-sm">{importMsg}</div>
      ) : null}
      {actionMsg ? (
        <div className="rounded-md ring-1 ring-amber-200 dark:ring-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">{actionMsg}</div>
      ) : null}

      <Card>
        <CardBody className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] gap-4 items-end">
          <div>
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">View</span>
            <div className="mt-1 flex flex-wrap gap-1">
              <TabButton active={colour === "all"} onClick={() => setColour("all")}>All</TabButton>
              <TabButton active={colour === "custom"} onClick={() => setColour("custom")}>Custom</TabButton>
            </div>
            {colour === "custom" ? (() => {
              // Custom view = pick one or more suppliers; the SKU table
              // shows every SKU from the selected suppliers.
              const suppliers = Array.from(
                new Set(data.products.map((p) => p.supplier).filter(Boolean)),
              ).sort();
              return (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {suppliers.length === 0 ? (
                    <span className="text-xs text-slate-500">No suppliers found.</span>
                  ) : (
                    <span className="text-xs text-slate-500 mr-1">Tick suppliers to include:</span>
                  )}
                  {suppliers.map((sup) => (
                    <button key={sup} type="button"
                      onClick={() => setCustomSuppliers((s) => {
                        const next = new Set(s);
                        if (next.has(sup)) next.delete(sup); else next.add(sup);
                        return next;
                      })}
                      className={cn(
                        "px-2 h-6 rounded text-xs ring-1",
                        customSuppliers.has(sup)
                          ? "bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:ring-slate-100"
                          : "ring-slate-300 dark:ring-slate-700 text-slate-600 dark:text-slate-300",
                      )}
                      aria-pressed={customSuppliers.has(sup)}
                      title={`SKUs from ${sup}`}
                    >
                      {sup}
                    </button>
                  ))}
                  {customSuppliers.size > 0 ? (
                    <button
                      type="button"
                      onClick={() => setCustomSuppliers(new Set())}
                      className="ml-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline"
                    >Clear</button>
                  ) : null}
                </div>
              );
            })() : null}
          </div>
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" /></Field>
          <Field label="Footer metric">
            <div className="flex gap-1">
              <Select value={metric} onChange={(e) => setMetric(e.target.value as FooterMetric)} className="w-32">
                {METRICS.map((mm) => (<option key={mm.value} value={mm.value}>{mm.label}</option>))}
              </Select>
              <Select value={metricScope} onChange={(e) => setMetricScope(e.target.value as typeof metricScope)} className="w-32">
                <option value="all">All visible</option>
                <option value="selected">★ Selected only</option>
              </Select>
            </div>
          </Field>
        </CardBody>
      </Card>

      {selectedWeeks.size > 0 ? (
        <div className="rounded-lg ring-1 ring-blue-200 dark:ring-blue-800 bg-blue-50 dark:bg-blue-900/20 px-4 py-2 flex flex-wrap items-center justify-between gap-3 sticky top-14 z-10">
          <div className="text-sm text-blue-900 dark:text-blue-200 font-medium">
            {selectedWeeks.size} week{selectedWeeks.size === 1 ? "" : "s"} selected
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => bulkSetReference(true)}>
              <Star size={14} /> Mark as ★ reference
            </Button>
            <Button size="sm" variant="secondary" onClick={() => bulkSetReference(false)}>
              <StarOff size={14} /> Unmark
            </Button>
            <Button size="sm" variant="danger" onClick={bulkDeleteWeeks}>
              <Trash2 size={14} /> Delete selected
            </Button>
            <Button size="sm" variant="secondary" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        </div>
      ) : null}

            <Card>
        <CardHeader>
          <CardTitle>Sales by week</CardTitle>
          <span className="text-xs text-slate-500">
            Tab/Enter to advance · paste a rectangle from Excel · empty = no record
          </span>
        </CardHeader>
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="text-sm border-separate border-spacing-0">
              <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                <tr>
                  <Th sticky left={0} minW={32}>
                    <button
                      onClick={toggleAllVisible}
                      aria-label={allVisibleSelected ? "Deselect all visible" : "Select all visible"}
                      className={cn(
                        "inline-flex h-5 w-5 items-center justify-center rounded",
                        someVisibleSelected ? "text-blue-600" : "text-slate-400 hover:text-slate-600",
                      )}>
                      {allVisibleSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                    </button>
                  </Th>
                  <Th sticky left={32} minW={170}>Date (Week starting)</Th>
                  <Th sticky left={202} minW={36}>★</Th>
                  <Th sticky left={238} minW={140}>Notes</Th>
                  <Th sticky left={378} minW={90} align="right">Total orders</Th>
                  <Th sticky left={468} minW={90} align="right">Total frames</Th>
                  {visibleSkus.map((sku) => (
                    <th key={sku.id} className="text-right font-medium px-2 py-2 min-w-[60px]" title={sku.code}>
                      {shortCode(sku)}
                    </th>
                  ))}
                  <Th minW={32}> </Th>
                </tr>
              </thead>
              <tbody>
                {visibleEntries.length === 0 ? (
                  <tr>
                    <td colSpan={6 + visibleSkus.length + 1} className="p-10 text-center text-sm text-slate-500">
                      No entries match your filter. Click "Add row" to insert one, or "Paste from Notion".
                    </td>
                  </tr>
                ) : null}
                {visibleEntries.map((e, ri) => {
                  const tf = totalFrames(e.iso_week_start);
                  return (
                    <tr key={e.iso_week_start}
                      className={cn(
                        "border-t border-slate-100 dark:border-slate-800",
                        e.is_reference ? "bg-blue-50/40 dark:bg-blue-900/10" : undefined,
                        selectedWeeks.has(e.iso_week_start) && "bg-blue-100/40 dark:bg-blue-900/20",
                      )}>
                      <Td sticky left={0} minW={32} className="bg-white dark:bg-slate-900 text-center">
                        <button
                          onClick={() => toggleWeek(e.iso_week_start)}
                          aria-label={selectedWeeks.has(e.iso_week_start) ? `Deselect ${e.iso_week_start}` : `Select ${e.iso_week_start}`}
                          className={cn(
                            "inline-flex h-5 w-5 items-center justify-center rounded",
                            selectedWeeks.has(e.iso_week_start) ? "text-blue-600" : "text-slate-400 hover:text-slate-600",
                          )}>
                          {selectedWeeks.has(e.iso_week_start) ? <CheckSquare size={14} /> : <Square size={14} />}
                        </button>
                      </Td>
                      <Td sticky left={32} minW={170} className="bg-white dark:bg-slate-900 p-0">
                        <input type="date" defaultValue={e.iso_week_start}
                          onBlur={(ev) => {
                            const v = ev.currentTarget.value;
                            if (v && v !== e.iso_week_start) renameRow(e.iso_week_start, v);
                          }}
                          className="w-full h-8 px-2 bg-transparent text-sm tabular-nums focus:bg-slate-100 dark:focus:bg-slate-800 focus:outline focus:outline-2 focus:outline-slate-400" />
                      </Td>
                      <Td sticky left={202} minW={36} className="bg-white dark:bg-slate-900">
                        <button onClick={() => setRow(e.iso_week_start, { is_reference: !e.is_reference })}
                          className={cn(
                            "inline-flex h-6 w-6 items-center justify-center rounded",
                            e.is_reference ? "text-blue-600 dark:text-blue-400" : "text-slate-300 hover:text-slate-500",
                          )}
                          aria-label={e.is_reference ? "Unmark reference week" : "Mark reference week"}>
                          {e.is_reference ? <Star size={14} fill="currentColor" /> : <StarOff size={14} />}
                        </button>
                      </Td>
                      <Td sticky left={238} minW={140} className="bg-white dark:bg-slate-900 p-0">
                        <input
                          key={`name-${e.iso_week_start}`}
                          defaultValue={e.name ?? ""} placeholder="optional label"
                          onBlur={(ev) => {
                            const v = ev.currentTarget.value.trim();
                            if (v !== (e.name ?? "")) setRow(e.iso_week_start, { name: v || null });
                          }}
                          className="w-full h-8 px-2 bg-transparent text-sm focus:bg-slate-100 dark:focus:bg-slate-800 focus:outline focus:outline-2 focus:outline-slate-400" />
                      </Td>
                      <Td sticky left={378} minW={90} align="right" className="bg-white dark:bg-slate-900 p-0">
                        <input
                          key={`orders-${e.iso_week_start}`}
                          type="number" defaultValue={e.total_orders ?? ""}
                          onBlur={(ev) => {
                            const raw = ev.currentTarget.value.trim();
                            const num = raw === "" ? null : Number(raw);
                            if (num !== null && (!Number.isFinite(num) || num < 0)) return;
                            if (num !== (e.total_orders ?? null)) setRow(e.iso_week_start, { total_orders: num });
                          }}
                          inputMode="numeric"
                          className="w-full h-8 px-2 bg-transparent text-right tabular-nums text-sm focus:bg-slate-100 dark:focus:bg-slate-800 focus:outline focus:outline-2 focus:outline-slate-400" />
                      </Td>
                      <Td sticky left={468} minW={90} align="right" className="bg-white dark:bg-slate-900 text-slate-500 px-2 tabular-nums">
                        {tf === 0 ? "—" : fmtNum(tf)}
                      </Td>
                      {visibleSkus.map((sku, ci) => {
                        const v = salesIndex[e.iso_week_start]?.[sku.id];
                        return (
                          <td key={sku.id} className="p-0 align-middle">
                            <input data-row={ri} data-col={ci} defaultValue={v ?? ""}
                              onBlur={(ev) => setCell(sku.id, e.iso_week_start, ev.currentTarget.value)}
                              onKeyDown={onCellKeyDown}
                              onPaste={(ev) => onPasteCell(ev, ri, ci)}
                              inputMode="numeric"
                              className={cn(
                                "w-full h-8 px-2 bg-transparent text-right tabular-nums text-sm",
                                "focus:bg-slate-100 dark:focus:bg-slate-800 focus:outline focus:outline-2 focus:outline-slate-400",
                                v === undefined ? "bg-amber-50/40 dark:bg-amber-900/10" : undefined,
                              )}
                              aria-label={`${sku.code} for week ${e.iso_week_start}`} />
                          </td>
                        );
                      })}
                      <Td>
                        <button
                          onClick={() => {
                            if (!window.confirm(`Delete the entire ${department} row for ${e.iso_week_start}? Sales for this week (in this department) will be removed.`)) return;
                            m.deleteWeeklyEntry.mutate({ isoWeekStart: e.iso_week_start, department });
                          }}
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                          aria-label={`Delete row for ${e.iso_week_start}`}>
                          <Trash2 size={13} />
                        </button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
              {visibleEntries.length > 0 ? (
                <tfoot className="text-sm border-t-2 border-slate-300 dark:border-slate-700">
                  <tr className="bg-slate-100 dark:bg-slate-800/70">
                    <Th sticky left={0} minW={32} className="!bg-slate-100 dark:!bg-slate-800/70 py-3"> </Th>
                    <Th sticky left={32} minW={170} className="!bg-slate-100 dark:!bg-slate-800/70 py-3">
                      <span className="uppercase tracking-wide font-bold text-slate-700 dark:text-slate-200">{METRICS.find((mm) => mm.value === metric)?.label}</span>
                    </Th>
                    <Th sticky left={202} minW={36} className="!bg-slate-100 dark:!bg-slate-800/70 py-3">
                      <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{metricScope === "selected" ? "★" : "all"}</span>
                    </Th>
                    <Th sticky left={238} minW={140} className="!bg-slate-100 dark:!bg-slate-800/70 py-3">
                      <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">n = {footerValues.sampleSize}</span>
                    </Th>
                    <Td sticky left={378} minW={90} align="right" className="bg-slate-100 dark:bg-slate-800/70 py-3 px-3 font-bold tabular-nums text-slate-900 dark:text-slate-100">
                      {footerValues.totalOrders === null ? "—" : fmtFloat(footerValues.totalOrders, 1)}
                    </Td>
                    <Td sticky left={468} minW={90} align="right" className="bg-slate-100 dark:bg-slate-800/70 py-3 px-3 font-bold tabular-nums text-slate-900 dark:text-slate-100">
                      {footerValues.totalFrames === null ? "—" : fmtFloat(footerValues.totalFrames, 1)}
                    </Td>
                    {visibleSkus.map((sku) => {
                      const v = footerValues.perSku[sku.id];
                      return (
                        <td key={sku.id} className="text-right px-2 py-3 tabular-nums font-bold text-slate-900 dark:text-slate-100">
                          {v === null || v === undefined ? "—" : fmtFloat(v, 1)}
                        </td>
                      );
                    })}
                    <Td />
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </CardBody>
      </Card>

      <BulkUsageModal
        open={showBulkUsage}
        onClose={() => setShowBulkUsage(false)}
        products={data.products}
        sales={data.sales}
        existingEntries={data.entries}
        autoAdjust={autoAdjust}
        currentWeekStart={currentWeekStart}
        onApply={async ({ weekStart, sales, inventoryDeltas, message, ensureEntry }) => {
          if (ensureEntry) {
            await m.upsertWeeklyEntry.mutateAsync({
              iso_week_start: weekStart,
              department,
              name: null,
              total_orders: null,
              is_reference: false,
              entered_at: new Date().toISOString(),
              entered_by: "bulk-usage",
              shopify_orders_by_size: {},
            });
          }
          if (sales.length > 0) await m.bulkUpsertSales.mutateAsync(sales);
          if (autoAdjust) {
            for (const [pid, delta] of Object.entries(inventoryDeltas)) {
              if (delta !== 0) adjustInventory(pid, delta);
            }
          }
          setImportMsg(message);
          setShowBulkUsage(false);
        }}
      />

      <NotionPasteModal
        open={showNotionPaste}
        onClose={() => setShowNotionPaste(false)}
        products={data.products}
        existingEntries={data.entries}
        existingSales={data.sales}
        autoAdjust={autoAdjust}
        onApply={async ({ entriesToCreate, sales, inventoryDeltas, message }) => {
          for (const e of entriesToCreate) {
            await m.upsertWeeklyEntry.mutateAsync(e);
          }
          if (sales.length > 0) await m.bulkUpsertSales.mutateAsync(sales);
          if (autoAdjust) {
            for (const [pid, delta] of Object.entries(inventoryDeltas)) {
              if (delta !== 0) adjustInventory(pid, delta);
            }
          }
          setImportMsg(message);
          setShowNotionPaste(false);
        }}
      />

      <ShopifyImportModal
        open={showShopifyModal}
        onClose={() => setShowShopifyModal(false)}
        parseResult={shopifyResult}
        defaultWeekStart={shopifyWeek}
      />

      <CsvColumnMapper
        open={!!mapperState}
        onClose={() => setMapperState(null)}
        headers={mapperState?.headers ?? []}
        rows={mapperState?.rows ?? []}
        products={data.products}
        onApply={async (mapped: MapperRow[]) => {
          const sales: WeeklySales[] = [];
          const newEntries = new Map<string, WeeklyEntry>();
          const inventoryDeltas: Record<string, number> = {};
          for (const row of mapped) {
            const sku = data.products.find(
              (p) => p.code.toLowerCase() === row.skuCode.toLowerCase() ||
                shortCode(p).toLowerCase() === row.skuCode.toLowerCase(),
            );
            if (!sku) continue;
            const old = salesIndex[row.isoWeekStart]?.[sku.id] ?? 0;
            sales.push({
              product_id: sku.id, iso_week_start: row.isoWeekStart, units_sold: row.units,
              entered_at: new Date().toISOString(), entered_by: "csv-mapper",
            });
            if (autoAdjust) {
              inventoryDeltas[sku.id] = (inventoryDeltas[sku.id] ?? 0) + (row.units - old);
            }
            if (!findEntry(row.isoWeekStart) && !newEntries.has(row.isoWeekStart)) {
              newEntries.set(row.isoWeekStart, {
                iso_week_start: row.isoWeekStart,
                department,
                name: null,
                total_orders: null,
                is_reference: false,
                entered_at: new Date().toISOString(),
                entered_by: "csv-mapper",
                shopify_orders_by_size: {},
              });
            }
          }
          for (const e of newEntries.values()) await m.upsertWeeklyEntry.mutateAsync(e);
          if (sales.length > 0) await m.bulkUpsertSales.mutateAsync(sales);
          if (autoAdjust) {
            for (const [pid, delta] of Object.entries(inventoryDeltas)) {
              if (delta !== 0) adjustInventory(pid, delta);
            }
          }
          setImportMsg(`Imported ${sales.length} row${sales.length === 1 ? "" : "s"} via column mapper.`);
        }}
      />
    </div>
  );
}

// ---------- Notion paste modal ----------

// ---------- Bulk usage modal ----------
//
// Lets the user record consumption in aggregate ("360 A1 tubes used last
// week") instead of per-SKU. The modal filters the catalogue by Supplier /
// Size / Colour (AND'd, optional), splits the typed total across the
// matching SKUs by a chosen weight, and writes one WeeklySales row per
// matching SKU (replacing any existing row for that week). Auto-adjust
// inventory deductions follow the same path as manual sales entry.

interface BulkUsageApplyArgs {
  weekStart: string;
  sales: WeeklySales[];
  inventoryDeltas: Record<string, number>;
  message: string;
  ensureEntry: boolean;
}

function BulkUsageModal({
  open,
  onClose,
  products,
  sales: existingSales,
  existingEntries,
  autoAdjust,
  currentWeekStart,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  products: Product[];
  sales: WeeklySales[];
  existingEntries: WeeklyEntry[];
  autoAdjust: boolean;
  currentWeekStart: string;
  onApply: (args: BulkUsageApplyArgs) => Promise<void>;
}) {
  const [weekStart, setWeekStart] = useState(currentWeekStart);
  const [supplierFilter, setSupplierFilter] = useState<string>("any");
  const [sizeFilter, setSizeFilter] = useState<string>("any");
  const [colourFilter, setColourFilter] = useState<string>("any");
  const [totalUnits, setTotalUnits] = useState<string>("");
  const [splitMode, setSplitMode] = useState<"weekly_avg" | "even" | "on_hand">("weekly_avg");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset on every open so the previous run's state doesn't bleed in.
  useEffect(() => {
    if (!open) return;
    setWeekStart(currentWeekStart);
    setSupplierFilter("any");
    setSizeFilter("any");
    setColourFilter("any");
    setTotalUnits("");
    setSplitMode("weekly_avg");
    setError(null);
    setBusy(false);
  }, [open, currentWeekStart]);

  const suppliers = useMemo(
    () => Array.from(new Set(products.map((p) => p.supplier).filter(Boolean))).sort(),
    [products],
  );
  const sizes = useMemo(
    () => Array.from(new Set(products.map((p) => p.size).filter((v) => v && v !== ""))).sort(),
    [products],
  );
  const colours = useMemo(
    () => Array.from(new Set(products.map((p) => p.colour).filter((v) => v && v !== ""))).sort(),
    [products],
  );

  const matched = useMemo(() => {
    return products.filter((p) => {
      if (supplierFilter !== "any" && p.supplier !== supplierFilter) return false;
      if (sizeFilter !== "any" && p.size !== sizeFilter) return false;
      if (colourFilter !== "any" && p.colour !== colourFilter) return false;
      return true;
    });
  }, [products, supplierFilter, sizeFilter, colourFilter]);

  /**
   * Compute each matching SKU's allocation. Weights come from the chosen
   * split mode; weights of zero get a small floor so a SKU with no history
   * still gets some allocation when it's the only match. If every weight
   * is zero (e.g. fresh SKU with no avg and no on-hand), we fall back to
   * an even split.
   */
  const allocation = useMemo(() => {
    const total = Number(totalUnits) || 0;
    if (matched.length === 0 || total <= 0) return [];
    const weight = (p: Product): number => {
      if (splitMode === "even") return 1;
      if (splitMode === "on_hand") return Math.max(0, p.current_on_hand);
      // weekly_avg — compute on the fly so the modal doesn't need the
      // forecast hook (and so it works pre-deploy of the engine).
      const recent = existingSales
        .filter((s) => s.product_id === p.id)
        .slice()
        .sort((a, b) => b.iso_week_start.localeCompare(a.iso_week_start))
        .slice(0, 8)
        .map((s) => s.units_sold);
      if (recent.length === 0) {
        return Math.max(0, p.weekly_avg_manual ?? 0);
      }
      return recent.reduce((a, b) => a + b, 0) / recent.length;
    };
    const raw = matched.map((p) => ({ p, w: weight(p) }));
    let sum = raw.reduce((a, x) => a + x.w, 0);
    // Fallback to even split if every weight is zero.
    let weights = raw;
    if (sum <= 0) {
      weights = raw.map((x) => ({ p: x.p, w: 1 }));
      sum = weights.length;
    }
    // Round each share, then redistribute the rounding remainder onto the
    // largest-weighted SKU so the totals add up exactly.
    const shares = weights.map((x) => ({ p: x.p, w: x.w, exact: total * (x.w / sum) }));
    const rounded = shares.map((x) => ({ ...x, units: Math.round(x.exact) }));
    const diff = total - rounded.reduce((a, x) => a + x.units, 0);
    if (diff !== 0 && rounded.length > 0) {
      const idx = rounded
        .map((x, i) => ({ i, w: x.w }))
        .sort((a, b) => b.w - a.w)[0].i;
      rounded[idx] = { ...rounded[idx], units: rounded[idx].units + diff };
    }
    return rounded.map(({ p, units, w }) => ({ p, units, weight: w }));
  }, [matched, totalUnits, splitMode, existingSales]);

  const totalAllocated = allocation.reduce((a, x) => a + x.units, 0);

  const apply = async () => {
    setError(null);
    setBusy(true);
    try {
      const total = Number(totalUnits) || 0;
      if (matched.length === 0) throw new Error("No SKUs match the chosen filters.");
      if (total <= 0) throw new Error("Type a positive total in units.");

      const ensureEntry = !existingEntries.some((e) => e.iso_week_start === weekStart);
      const sales: WeeklySales[] = [];
      const inventoryDeltas: Record<string, number> = {};
      // Pre-compute existing sales for the target week so deltas are
      // correct (replacing rather than stacking when re-running).
      const existingForWeek = new Map<string, number>();
      for (const s of existingSales) {
        if (s.iso_week_start === weekStart) existingForWeek.set(s.product_id, s.units_sold);
      }
      for (const { p, units } of allocation) {
        if (units <= 0) continue;
        const old = existingForWeek.get(p.id) ?? 0;
        sales.push({
          product_id: p.id,
          iso_week_start: weekStart,
          units_sold: units,
          entered_at: new Date().toISOString(),
          entered_by: "bulk-usage",
        });
        inventoryDeltas[p.id] = (inventoryDeltas[p.id] ?? 0) + (units - old);
      }

      await onApply({
        weekStart,
        sales,
        inventoryDeltas: autoAdjust ? inventoryDeltas : {},
        ensureEntry,
        message: `Bulk usage: ${total} units across ${allocation.filter((x) => x.units > 0).length} SKU${allocation.length === 1 ? "" : "s"} for week ${weekStart}.`,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Bulk usage entry" width="max-w-2xl">
      <div className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Record consumption in aggregate. Filter the catalogue, type the total units used, and
          we'll split the total across matching SKUs and write one sales row per SKU. Auto-adjust
          deducts on-hand the same way as manual entry{autoAdjust ? "" : " (currently OFF in Settings)"}.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Week starting">
            <Input type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
          </Field>
          <Field label="Total units used">
            <Input type="number" min={0} step={1} value={totalUnits}
              onChange={(e) => setTotalUnits(e.target.value)} placeholder="e.g. 360" />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Supplier">
            <Select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
              <option value="any">Any</option>
              {suppliers.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Size">
            <Select value={sizeFilter} onChange={(e) => setSizeFilter(e.target.value)}>
              <option value="any">Any</option>
              {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Colour">
            <Select value={colourFilter} onChange={(e) => setColourFilter(e.target.value)}>
              <option value="any">Any</option>
              {colours.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
        </div>

        <Field label="Split rule" hint="How the total is divided across the matched SKUs.">
          <Select value={splitMode} onChange={(e) => setSplitMode(e.target.value as typeof splitMode)}>
            <option value="weekly_avg">Proportional to recent weekly avg (default)</option>
            <option value="even">Even split</option>
            <option value="on_hand">Proportional to current on-hand</option>
          </Select>
        </Field>

        <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
          <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <span>Preview · {matched.length} SKU{matched.length === 1 ? "" : "s"} matched</span>
            <span className="tabular-nums">{fmtNum(totalAllocated)} / {fmtNum(Number(totalUnits) || 0)} units allocated</span>
          </div>
          {matched.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No SKUs match these filters.</div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">SKU</th>
                    <th className="text-right px-2 py-1.5 font-medium">Weight</th>
                    <th className="text-right px-2 py-1.5 font-medium">On hand</th>
                    <th className="text-right px-3 py-1.5 font-medium">Allocated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {allocation.map(({ p, units, weight }) => (
                    <tr key={p.id}>
                      <td className="px-3 py-1.5">
                        <div className="font-medium">{p.code}</div>
                        <div className="text-[10px] text-slate-500">{p.size || "—"} · {p.colour || "—"} · {p.supplier}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{fmtFloat(weight, 1)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{fmtNum(p.current_on_hand)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{units > 0 ? fmtNum(units) : "—"}</td>
                    </tr>
                  ))}
                  {allocation.length === 0 && matched.length > 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-3 text-center text-slate-500">
                        Type a total above to see the split.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {error ? <div className="text-sm text-red-600 dark:text-red-400">{error}</div> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={apply} disabled={busy || matched.length === 0 || (Number(totalUnits) || 0) <= 0}>
            {busy ? "Applying…" : `Apply to ${allocation.filter((x) => x.units > 0).length} SKU${allocation.filter((x) => x.units > 0).length === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface NotionApplyArgs {
  entriesToCreate: WeeklyEntry[];
  sales: WeeklySales[];
  /** productId → net delta of new units sold; used for auto-adjusting inventory. */
  inventoryDeltas: Record<string, number>;
  message: string;
}

function NotionPasteModal({
  open, onClose, products, existingEntries, existingSales, autoAdjust, onApply,
}: {
  open: boolean;
  onClose: () => void;
  products: Product[];
  existingEntries: WeeklyEntry[];
  existingSales: WeeklySales[];
  autoAdjust: boolean;
  onApply: (args: NotionApplyArgs) => Promise<void>;
}) {
  // Pasted entries are stamped with the active department so they land in
  // the right side's history. Pre-v9 callers without department default to
  // 'framed' downstream, so this is safe regardless.
  const department = useAppStore((s) => s.department);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<NotionApplyArgs | null>(null);

  const previewParse = () => {
    setError(null); setPreview(null);
    try {
      const parsed = parseNotionTable(text, products, existingSales, department);
      setPreview(parsed);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Paste from Notion" width="max-w-3xl">
      <div className="space-y-3">
        <div className="text-sm text-slate-600 dark:text-slate-400">
          Paste your Notion table here. Expected columns: <code>Date</code>, optional <code>Name</code>,{" "}
          <code>Total Orders</code>, <code>Total Frames</code>, then one column per SKU using its{" "}
          <strong>code</strong> (e.g. <code>A0-Natural</code>) or <strong>short code</strong>{" "}
          (e.g. <code>A0N</code>). Date can be either an ISO date (<code>2026-04-19</code>) or
          Notion's "April 19, 2026 → April 25, 2026" format.
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder={"Date\tName\tTotal Orders\tTotal Frames\tA0N\tA1N\tA2N\nApril 19, 2026 → April 25, 2026\t\t439\t556\t49\t93\t75"}
          className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 text-xs font-mono"
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={previewParse} disabled={!text.trim()}>Preview</Button>
        </div>
        {error ? (
          <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
        ) : null}
        {preview ? (
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 p-3 space-y-2 text-sm">
            <div className="font-semibold">{preview.message}</div>
            <div className="text-xs text-slate-500">
              {preview.entriesToCreate.length} new week{preview.entriesToCreate.length === 1 ? "" : "s"} ·{" "}
              {preview.sales.length} sales rows ·{" "}
              {autoAdjust
                ? `${Object.keys(preview.inventoryDeltas).length} SKU(s) will adjust inventory`
                : "inventory NOT auto-adjusted"}
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => onApply(preview)}>Apply</Button>
            </div>
          </div>
        ) : null}
        <div className="text-[11px] text-slate-500">
          Tip: in Notion, click the <code>•••</code> menu on the database → Copy link / Select all → copy the cells,
          then paste here.
        </div>
        <div className="text-[11px] text-slate-500">
          Existing entries with the same date are skipped (use the date filter to delete them first if you want to re-import).{" "}
          <span className="font-semibold">Existing sales rows are overwritten by the imported value.</span>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Parse a Notion-style wide table. The first non-empty row is the header,
 * subsequent rows are data. Tabs separate cells (Notion's clipboard format),
 * but commas are also accepted.
 */
function parseNotionTable(
  raw: string,
  products: Product[],
  existingSales: readonly WeeklySales[],
  department: "framed" | "unframed",
): NotionApplyArgs {
  const lines = raw.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("Need a header row plus at least one data row.");
  const split = (line: string) => line.split("\t").length > 1 ? line.split("\t") : line.split(",");

  const header = split(lines[0]).map((h) => h.trim());
  const colMap: Record<string, number> = {};
  for (let i = 0; i < header.length; i++) colMap[header[i].toLowerCase()] = i;

  const dateIdx = colMap["date"];
  if (dateIdx === undefined) throw new Error('Need a "Date" column.');
  const nameIdx = colMap["name"];
  const totalOrdersIdx = colMap["total orders"];

  // Map every non-special column to a product (by code or short_code).
  const reservedKeys = new Set(["date", "type", "name", "total orders", "total frames", ""]);
  const skuColumns: { idx: number; product: Product }[] = [];
  for (let i = 0; i < header.length; i++) {
    const key = header[i].toLowerCase();
    if (reservedKeys.has(key)) continue;
    const target = header[i].trim();
    const sku = products.find(
      (p) => p.code === target || shortCode(p) === target ||
             p.code.toLowerCase() === target.toLowerCase() ||
             shortCode(p).toLowerCase() === target.toLowerCase(),
    );
    if (sku) skuColumns.push({ idx: i, product: sku });
  }
  if (skuColumns.length === 0) {
    throw new Error("Couldn't match any column to a SKU. Header should include SKU codes like A0-Natural or A0N.");
  }

  const salesIndex: Record<string, Record<string, number>> = {};
  for (const s of existingSales) (salesIndex[s.iso_week_start] ??= {})[s.product_id] = s.units_sold;

  const entriesToCreate: WeeklyEntry[] = [];
  const sales: WeeklySales[] = [];
  const inventoryDeltas: Record<string, number> = {};
  const seenDates = new Set<string>();

  for (let r = 1; r < lines.length; r++) {
    const row = split(lines[r]);
    const rawDate = row[dateIdx]?.trim();
    if (!rawDate) continue;
    const iso = parseNotionDate(rawDate);
    if (!iso) continue;
    seenDates.add(iso);

    entriesToCreate.push({
      iso_week_start: iso,
      department,
      name: nameIdx !== undefined ? (row[nameIdx]?.trim() || null) : null,
      total_orders:
        totalOrdersIdx !== undefined && row[totalOrdersIdx]?.trim()
          ? Number(row[totalOrdersIdx])
          : null,
      is_reference: false,
      entered_at: new Date().toISOString(),
      entered_by: "notion-paste",
      shopify_orders_by_size: {},
    });

    for (const { idx, product } of skuColumns) {
      const cell = row[idx]?.trim();
      if (!cell) continue;
      const num = Number(cell);
      if (!Number.isFinite(num) || num < 0) continue;
      const old = salesIndex[iso]?.[product.id] ?? 0;
      inventoryDeltas[product.id] = (inventoryDeltas[product.id] ?? 0) + (num - old);
      sales.push({
        product_id: product.id, iso_week_start: iso, units_sold: num,
        entered_at: new Date().toISOString(), entered_by: "notion-paste",
      });
    }
  }

  return {
    entriesToCreate,
    sales,
    inventoryDeltas,
    message: `Parsed ${seenDates.size} week${seenDates.size === 1 ? "" : "s"} across ${skuColumns.length} SKU column${skuColumns.length === 1 ? "" : "s"}.`,
  };
}

/** Parse Notion's date strings: ISO, "April 19, 2026 → April 25, 2026", "April 19, 2026". */
function parseNotionDate(input: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  // Handle "April 19, 2026 → April 25, 2026" — take the start.
  const start = input.split(/[→\-–—]/)[0].trim();
  // Try "Month D, YYYY" / "Month DD YYYY"
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- helpers ----------

function findCell(row: number, col: number): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`input[data-row="${row}"][data-col="${col}"]`);
}

function snapToWeekStart(iso: string, day: "sunday" | "monday"): string {
  const d = parseIsoDate(iso);
  const dow = d.getUTCDay();
  const back = day === "sunday" ? dow : (dow + 6) % 7;
  return addDays(iso, -back);
}

function computeMetric(metric: FooterMetric, xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0);
  switch (metric) {
    case "sum": return sum;
    case "mean": return sum / xs.length;
    case "min": return sorted[0];
    case "max": return sorted[sorted.length - 1];
    case "range": return sorted[sorted.length - 1] - sorted[0];
    case "count": return xs.length;
    case "median": return percentile(sorted, 0.5);
    case "p25": return percentile(sorted, 0.25);
    case "p75": return percentile(sorted, 0.75);
    case "stdev": {
      const mean = sum / xs.length;
      const variance = xs.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / xs.length;
      return Math.sqrt(variance);
    }
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const i = (sortedAsc.length - 1) * p;
  const lo = Math.floor(i); const hi = Math.ceil(i);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (i - lo);
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn(
        "px-2.5 h-7 rounded text-xs font-medium",
        active ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
               : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
      )}>
      {children}
    </button>
  );
}

function Th({ children, sticky, left, minW, align, className }:
  { children?: ReactNode; sticky?: boolean; left?: number; minW?: number; align?: "left" | "right"; className?: string; }) {
  return (
    <th style={{ left: sticky ? left : undefined, minWidth: minW, textAlign: align ?? "left" }}
      className={cn("font-medium px-3 py-2", sticky && "sticky bg-slate-50 dark:bg-slate-900/60 z-10", className)}>
      {children}
    </th>
  );
}
function Td({ children, sticky, left, minW, align, className }:
  { children?: ReactNode; sticky?: boolean; left?: number; minW?: number; align?: "left" | "right"; className?: string; }) {
  return (
    <td style={{ left: sticky ? left : undefined, minWidth: minW, textAlign: align }}
      className={cn(sticky && "sticky z-10", className)}>{children}</td>
  );
}
