import { useMemo, useState } from "react";
import { Download, ShoppingCart, CalendarDays, FileSpreadsheet } from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { useForecasts } from "@/lib/hooks/useForecasts";
import { useMutations } from "@/lib/hooks/useMutations";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { fmtMoney, fmtNum } from "@/lib/utils/format";
import { addDays, isoWeekStart, todayIso } from "@/lib/utils/dates";
import { downloadCsv, toCsv } from "@/lib/csv/csv";
import { downloadXlsx } from "@/lib/csv/xlsx";
import { IncomingShipmentSchema, type IncomingShipment } from "@/lib/domain";

interface OrderLine {
  productId: string;
  productCode: string;
  supplier: string;
  qty: number;
  unitCost: number | null;
  leadTimeDays: number;
}

export function ShoppingList() {
  const { data } = useDataset();
  const { byId } = useForecasts();
  const m = useMutations();
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const { lines, supplierGroups, totalValue } = useMemo(() => {
    if (!data) return { lines: [] as OrderLine[], supplierGroups: [] as [string, OrderLine[]][], totalValue: 0 };
    const ls: OrderLine[] = data.products
      .map((p) => {
        const r = byId[p.id];
        if (!r) return null;
        const qty = overrides[p.id] ?? r.suggestedOrderQty;
        if (qty <= 0) return null;
        return {
          productId: p.id,
          productCode: p.code,
          supplier: p.supplier,
          qty,
          unitCost: p.unit_cost,
          leadTimeDays: p.lead_time_days,
        } satisfies OrderLine;
      })
      .filter((x): x is OrderLine => x !== null);
    const groups = groupBy(ls, (l) => l.supplier);
    const total = ls.reduce((sum, l) => sum + (l.unitCost ?? 0) * l.qty, 0);
    return { lines: ls, supplierGroups: groups, totalValue: total };
  }, [data, byId, overrides]);

  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  // ---- Restock plan: if all suggested orders went out TODAY, when would
  // each line arrive? Group by ISO-week of expected arrival.
  const today = todayIso();
  type RestockBucket = { week: string; lines: (OrderLine & { arrives: string })[]; totalUnits: number; totalValue: number };
  const restockByWeek: RestockBucket[] = (() => {
    if (lines.length === 0) return [];
    const map = new Map<string, RestockBucket>();
    for (const l of lines) {
      const arrives = addDays(today, l.leadTimeDays);
      const week = isoWeekStart(arrives);
      let bucket = map.get(week);
      if (!bucket) {
        bucket = { week, lines: [], totalUnits: 0, totalValue: 0 };
        map.set(week, bucket);
      }
      bucket.lines.push({ ...l, arrives });
      bucket.totalUnits += l.qty;
      bucket.totalValue += (l.unitCost ?? 0) * l.qty;
    }
    return Array.from(map.values()).sort((a, b) => a.week.localeCompare(b.week));
  })();

  const setQty = (id: string, q: number) =>
    setOverrides((o) => ({ ...o, [id]: Math.max(0, Math.round(q)) }));

  const exportCsv = () => {
    const flat = lines.map((l) => ({
      supplier: l.supplier,
      sku_code: l.productCode,
      qty: l.qty,
      unit_cost: l.unitCost ?? "",
      line_value: l.unitCost ? Number((l.unitCost * l.qty).toFixed(2)) : "",
      lead_time_days: l.leadTimeDays,
    }));
    const csv = toCsv(flat, [
      "supplier", "sku_code", "qty", "unit_cost", "line_value", "lead_time_days",
    ]);
    downloadCsv(`shopping-list-${todayIso()}.csv`, csv);
  };

  /**
   * Excel export — one summary tab + the same per-supplier groupings used
   * on screen, each as its own tab. Easier to print or send to a buyer.
   */
  const exportExcel = () => {
    const headers = ["Supplier", "SKU code", "Qty", "Unit cost", "Line value", "Lead (days)"];
    const allLineRows = lines.map((l) => [
      l.supplier,
      l.productCode,
      l.qty,
      l.unitCost ?? "",
      l.unitCost ? Number((l.unitCost * l.qty).toFixed(2)) : "",
      l.leadTimeDays,
    ]);
    const summary = {
      name: "Summary",
      headers: ["Field", "Value"],
      rows: [
        ["Generated", todayIso()],
        ["Total lines", lines.length],
        ["Total units", lines.reduce((s, l) => s + l.qty, 0)],
        ["Total value", Number(totalValue.toFixed(2))],
        ["Currency", data.settings.currency_symbol],
        ["Suppliers", supplierGroups.length],
      ] as (string | number)[][],
      columnWidths: [22, 30],
    };
    const allLines = { name: "All lines", headers, rows: allLineRows };
    const perSupplier = supplierGroups.map(([sup, items]) => ({
      name: sup,
      headers,
      rows: items.map((l) => [
        l.supplier,
        l.productCode,
        l.qty,
        l.unitCost ?? "",
        l.unitCost ? Number((l.unitCost * l.qty).toFixed(2)) : "",
        l.leadTimeDays,
      ]),
    }));
    downloadXlsx(`shopping-list-${todayIso()}.xlsx`, [summary, allLines, ...perSupplier]);
  };

  const placeOrders = async () => {
    if (lines.length === 0) return;
    if (!window.confirm(`Create ${lines.length} purchase orders, one per SKU?`)) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const today = todayIso();
      const ships: IncomingShipment[] = lines.map((l, i) =>
        IncomingShipmentSchema.parse({
          id: `ship-${Math.random().toString(36).slice(2, 8)}-${i}`,
          po_number: `PO-${today.replace(/-/g, "")}-${String(i + 1).padStart(3, "0")}`,
          supplier: l.supplier,
          order_placed_date: today,
          transit_started_date: null,
          expected_arrival_date: addDays(today, l.leadTimeDays),
          actual_arrival_date: null,
          // Multi-line shape (v3+). Pass via Zod parse so the transform fills any defaults.
          lines: [{ product_id: l.productId, quantity: l.qty }],
          status: "Ordered",
          notes: `Auto-created from shopping list ${now}`,
        }),
      );
      for (const s of ships) {
        // eslint-disable-next-line no-await-in-loop
        await m.upsertShipment.mutateAsync(s);
        // eslint-disable-next-line no-await-in-loop
        const p = data.products.find((p) => p.id === s.product_id);
        if (p) {
          // Optionally clear the override so the recommendation refreshes
          setOverrides((o) => {
            const { [p.id]: _drop, ...rest } = o;
            return rest;
          });
        }
      }
      window.alert(`Created ${ships.length} shipments. Find them under the Ordered column on /shipments.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Shopping list</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Auto-generated from current forecasts. Group by supplier.
            {lines.length} line{lines.length === 1 ? "" : "s"} · estimated{" "}
            {fmtMoney(totalValue, data.settings.currency_symbol)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={exportCsv} disabled={lines.length === 0}>
            <Download size={14} /> Export CSV
          </Button>
          <Button variant="secondary" size="sm" onClick={exportExcel} disabled={lines.length === 0}>
            <FileSpreadsheet size={14} /> Export Excel
          </Button>
          <Button size="sm" onClick={placeOrders} disabled={lines.length === 0 || busy}>
            <ShoppingCart size={14} /> {busy ? "Creating…" : "Mark all as ordered"}
          </Button>
        </div>
      </div>

      {/* Restock plan — when would these orders arrive? */}
      {restockByWeek.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays size={14} /> Restock plan
              </span>
            </CardTitle>
            <span className="text-xs text-slate-500">
              If all {lines.length} order{lines.length === 1 ? "" : "s"} went out today, here's when each would land.
            </span>
          </CardHeader>
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Week of</th>
                  <th className="text-right font-medium px-4 py-2">Lines</th>
                  <th className="text-right font-medium px-4 py-2">Units</th>
                  <th className="text-right font-medium px-4 py-2">Value</th>
                  <th className="text-left font-medium px-4 py-2">SKUs arriving</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {restockByWeek.map((b) => (
                  <tr key={b.week} className="align-top">
                    <td className="px-4 py-2 font-medium tabular-nums whitespace-nowrap">{b.week}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{b.lines.length}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtNum(b.totalUnits)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {b.totalValue > 0 ? fmtMoney(b.totalValue, data.settings.currency_symbol) : "—"}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600 dark:text-slate-400">
                      {b.lines.map((l) => `${l.productCode} (${fmtNum(l.qty)})`).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      ) : null}

      {supplierGroups.length === 0 ? (
        <Card>
          <CardBody className="p-10 text-center">
            <ShoppingCart size={28} className="mx-auto text-slate-400 mb-3" />
            <div className="text-base font-semibold">Nothing to order</div>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Every SKU is at or above target stock under the current scenario.
            </div>
          </CardBody>
        </Card>
      ) : (
        supplierGroups.map(([supplier, items]) => {
          const subtotal = items.reduce((s, l) => s + (l.unitCost ?? 0) * l.qty, 0);
          return (
            <Card key={supplier}>
              <CardHeader>
                <CardTitle>{supplier}</CardTitle>
                <span className="text-xs text-slate-500">
                  {items.length} SKU{items.length === 1 ? "" : "s"} ·{" "}
                  {fmtMoney(subtotal, data.settings.currency_symbol)}
                </span>
              </CardHeader>
              <CardBody className="p-0">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-left font-medium px-4 py-2">SKU</th>
                      <th className="text-right font-medium px-4 py-2">Suggested</th>
                      <th className="text-right font-medium px-4 py-2">Qty</th>
                      <th className="text-right font-medium px-4 py-2">Unit cost</th>
                      <th className="text-right font-medium px-4 py-2">Line total</th>
                      <th className="text-right font-medium px-4 py-2">Lead</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {items.map((l) => {
                      const suggested = byId[l.productId]?.suggestedOrderQty ?? 0;
                      const lineTotal = (l.unitCost ?? 0) * l.qty;
                      return (
                        <tr key={l.productId}>
                          <td className="px-4 py-2 font-medium">{l.productCode}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                            {fmtNum(suggested)}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <input
                              type="number"
                              min={0}
                              value={l.qty}
                              onChange={(e) => setQty(l.productId, Number(e.target.value))}
                              className="w-24 rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 h-7 text-right tabular-nums text-sm"
                            />
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                            {l.unitCost === null ? "—" : fmtMoney(l.unitCost, data.settings.currency_symbol)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {l.unitCost === null ? "—" : fmtMoney(lineTotal, data.settings.currency_symbol)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                            {l.leadTimeDays}d
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          );
        })
      )}
    </div>
  );
}

function groupBy<T, K extends string>(xs: T[], fn: (x: T) => K): [K, T[]][] {
  const map = new Map<K, T[]>();
  for (const x of xs) {
    const k = fn(x);
    const arr = map.get(k);
    if (arr) arr.push(x);
    else map.set(k, [x]);
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

