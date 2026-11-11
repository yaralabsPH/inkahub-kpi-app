import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Truck, Sparkles } from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { useForecasts } from "@/lib/hooks/useForecasts";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { fmtNum, fmtPct, fmtShortDate } from "@/lib/utils/format";
import { addDays, diffDays, todayIso } from "@/lib/utils/dates";
import { cn } from "@/lib/utils/cn";
import { shortCode, type Product } from "@/lib/domain";

/** Pick the colour name (Tailwind palette key) used by the score for a given fullness ratio. */
function fullnessLevel(pct: number): "low" | "ok" | "high" | "over" {
  if (pct >= 95) return "over";
  if (pct >= 80) return "high";
  if (pct >= 50) return "ok";
  return "low";
}

export function Warehouse() {
  const { data } = useDataset();
  const { byId } = useForecasts();
  const [showBreakdown, setShowBreakdown] = useState(false);
  /** Week the time-scrubber slider is parked on (0 = today). */
  const [scrubWeek, setScrubWeek] = useState(0);
  /** Zoom level for the stockout heatmap, measured in pixels per week. */
  const [pxPerWeek, setPxPerWeek] = useState(24);
  /** Supplier filter for the stockout schedule rows. "all" = show every SKU. */
  const [stockoutSupplier, setStockoutSupplier] = useState<string>("all");
  /** Sort mode for the stockout schedule. */
  const [stockoutSort, setStockoutSort] = useState<"stockout" | "display">("display");

  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  const { bays } = data.storage;
  const totalCap = bays.reduce((a, b) => a + b.max_pallets, 0);

  /**
   * Pallets needed for the current on-hand stock — `Σ ceil(stock / pallet_cap)`
   * across every SKU. Single source of truth for the headline fullness so it
   * tracks inventory edits live, instead of the old palletAssignments count
   * which only changed when the user dragged tiles on the warehouse map.
   * SKUs with no pallet capacity contribute zero.
   */
  const palletsFromStock = (): number => {
    let pallets = 0;
    for (const p of data.products) {
      const cap = p.pallet_capacity_units;
      if (!cap || cap <= 0) continue;
      pallets += Math.ceil(p.current_on_hand / cap);
    }
    return pallets;
  };
  const totalUsed = palletsFromStock();
  const utilisation = totalCap === 0 ? 0 : (totalUsed / totalCap) * 100;

  /**
   * Per-SKU pallet breakdown so the user can audit the math behind the headline
   * fullness number. Sorted by pallets-needed desc — biggest space hogs first.
   * SKUs without `pallet_capacity_units` are flagged separately so they can be
   * fixed in the SKU detail page.
   */
  const palletBreakdown = useMemo(() => {
    const counted: { product: Product; pallets: number; pctOfCap: number }[] = [];
    const missing: Product[] = [];
    for (const p of data.products) {
      const cap = p.pallet_capacity_units;
      if (!cap || cap <= 0) {
        missing.push(p);
        continue;
      }
      const pallets = Math.ceil(p.current_on_hand / cap);
      const pctOfCap = totalCap === 0 ? 0 : (pallets / totalCap) * 100;
      counted.push({ product: p, pallets, pctOfCap });
    }
    // Sort by display_order to match the SKUs page (fallback to shortCode).
    counted.sort((a, b) => {
      const ao = a.product.display_order ?? 9_999_999;
      const bo = b.product.display_order ?? 9_999_999;
      if (ao !== bo) return ao - bo;
      return shortCode(a.product).localeCompare(shortCode(b.product));
    });
    return { counted, missing };
  }, [data.products, totalCap]);

  // Project utilisation N weeks out: stock divided by pallet capacity.
  // Returns the raw percentage uncapped — values over 100 are valid and mean
  // we'd need more space than the warehouse has at that point.
  const projectedUtilisation = (week: number): number => {
    if (totalCap === 0) return 0;
    let pallets = 0;
    for (const p of data.products) {
      const cap = p.pallet_capacity_units;
      if (!cap || cap <= 0) continue;
      const r = byId[p.id];
      const stockAtWeek = r?.rows[week - 1]?.stockEnd ?? p.current_on_hand;
      pallets += Math.ceil(Math.max(0, stockAtWeek) / cap);
    }
    return (pallets / totalCap) * 100;
  };

  /**
   * Per-SKU stockout schedule. Each SKU gets a 52-week heatmap of projected
   * stock-vs-target plus the week number when it depletes. Sorted by stockout
   * week ascending so the soonest stockouts surface at the top; SKUs that
   * never run out within the horizon sink to the bottom.
   */
  const HORIZON_WEEKS = 52;
  type StockoutCell = {
    color: string;
    stockEnd: number;
    weekStart: string;
  };
  type StockoutRow = {
    product: Product;
    stockoutWeek: number | null;
    stockoutDate: string | null;
    cells: StockoutCell[];
  };
  const stockoutSuppliers = useMemo(
    () => Array.from(new Set(data.products.map((p) => p.supplier).filter(Boolean))).sort(),
    [data.products],
  );
  const stockoutSchedule: StockoutRow[] = useMemo(() => {
    const filtered = stockoutSupplier === "all"
      ? data.products
      : data.products.filter((p) => p.supplier === stockoutSupplier);
    const rows: StockoutRow[] = filtered.map((p) => {
      const result = byId[p.id];
      if (!result) {
        return { product: p, stockoutWeek: null, stockoutDate: null, cells: [] };
      }
      const target = result.targetStock || p.current_on_hand || 1;
      const cells: StockoutCell[] = [];
      let stockoutWeek: number | null = null;
      let stockoutDate: string | null = null;
      for (let i = 0; i < HORIZON_WEEKS; i++) {
        const r = result.rows[i];
        if (!r) {
          cells.push({ color: "bg-slate-200 dark:bg-slate-800", stockEnd: 0, weekStart: "" });
          continue;
        }
        const ratio = r.stockEnd / target;
        let color: string;
        if (r.stockEnd <= 0) color = "bg-red-500 dark:bg-red-600";
        else if (ratio < 0.25) color = "bg-red-300 dark:bg-red-700";
        else if (ratio < 0.5) color = "bg-amber-300 dark:bg-amber-600";
        else if (ratio < 1) color = "bg-emerald-300 dark:bg-emerald-700";
        else color = "bg-emerald-500 dark:bg-emerald-500";
        cells.push({ color, stockEnd: r.stockEnd, weekStart: r.weekStart });
        if (stockoutWeek === null && r.stockEnd <= 0) {
          stockoutWeek = i + 1;
          stockoutDate = r.weekStart;
        }
      }
      return { product: p, stockoutWeek, stockoutDate, cells };
    });
    if (stockoutSort === "display") {
      return rows.sort((a, b) => {
        const ao = a.product.display_order ?? 9_999_999;
        const bo = b.product.display_order ?? 9_999_999;
        if (ao !== bo) return ao - bo;
        return shortCode(a.product).localeCompare(shortCode(b.product));
      });
    }
    return rows.sort((a, b) => {
      if (a.stockoutWeek == null && b.stockoutWeek == null) {
        return shortCode(a.product).localeCompare(shortCode(b.product));
      }
      if (a.stockoutWeek == null) return 1;
      if (b.stockoutWeek == null) return -1;
      return a.stockoutWeek - b.stockoutWeek;
    });
  }, [data.products, byId, stockoutSupplier, stockoutSort]);

  const projectionPoints: { label: string; pct: number }[] = [
    { label: "Now", pct: utilisation },
    { label: "4 weeks", pct: projectedUtilisation(4) },
    { label: "12 weeks", pct: projectedUtilisation(12) },
    { label: "26 weeks", pct: projectedUtilisation(26) },
    { label: "52 weeks", pct: projectedUtilisation(52) },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Warehouse</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          One overall score for how full the warehouse is — and where it's heading.
        </p>
      </div>

      {/* ---------- Overall fullness score ---------- */}
      <Card>
        <CardHeader>
          <CardTitle>Fullness score</CardTitle>
          <span className="text-xs text-slate-500">
            Pallets needed for current stock · {totalUsed.toLocaleString()} of {totalCap.toLocaleString()} bay slots
          </span>
        </CardHeader>
        <CardBody>
          {totalCap === 0 ? (
            <div className="text-sm text-slate-500">
              No bays defined yet — head to <strong>Settings → Warehouse capacity</strong> and set bay count × pallets-per-bay (default 2/bay) to start tracking fullness.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-8 items-center">
              <FullnessGauge pct={utilisation} totalUsed={totalUsed} totalCap={totalCap} />
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <StatTile label="In use" value={`${totalUsed.toLocaleString()}`} sub="pallets" />
                  <StatTile label="Capacity" value={`${totalCap.toLocaleString()}`} sub="slots" />
                  <StatTile label="Free now" value={`${Math.max(totalCap - totalUsed, 0).toLocaleString()}`} sub="slots" />
                  <StatTile label="Headroom" value={fmtPct(Math.max(100 - utilisation, 0), 0)} sub="capacity left" />
                </div>
                <div className="space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Projected fullness</div>
                  {projectionPoints.map((p) => (
                    <ProjectionRow key={p.label} label={p.label} pct={p.pct} />
                  ))}
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() => setShowBreakdown((v) => !v)}
                    className="text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 inline-flex items-center gap-1"
                  >
                    {showBreakdown ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {showBreakdown ? "Hide" : "Show"} pallet breakdown by SKU
                  </button>
                  {showBreakdown ? (
                    <div className="mt-2 rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900/95 text-slate-500 dark:text-slate-400">
                            <tr>
                              <th className="text-left font-medium px-3 py-2">SKU</th>
                              <th className="text-right font-medium px-2 py-2">On hand</th>
                              <th className="text-right font-medium px-2 py-2">Units / pallet</th>
                              <th className="text-right font-medium px-2 py-2">Pallets</th>
                              <th className="text-right font-medium px-2 py-2">% of cap</th>
                            </tr>
                          </thead>
                          <tbody>
                            {palletBreakdown.counted.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                                  No SKUs with pallet capacity defined.
                                </td>
                              </tr>
                            ) : null}
                            {palletBreakdown.counted.map(({ product, pallets, pctOfCap }) => (
                              <tr key={product.id} className="border-t border-slate-100 dark:border-slate-800">
                                <td className="px-3 py-1.5 font-medium tabular-nums">{shortCode(product)}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(product.current_on_hand)}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{product.pallet_capacity_units}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{pallets}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{fmtPct(pctOfCap, 1)}</td>
                              </tr>
                            ))}
                            <tr className="border-t-2 border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60">
                              <td className="px-3 py-1.5 font-bold uppercase text-[10px] tracking-wide">Total</td>
                              <td />
                              <td />
                              <td className="px-2 py-1.5 text-right tabular-nums font-bold">{totalUsed}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums font-bold">{fmtPct(utilisation, 1)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      {palletBreakdown.missing.length > 0 ? (
                        <div className="text-[11px] text-amber-700 dark:text-amber-400 px-3 py-2 border-t border-slate-200 dark:border-slate-800 bg-amber-50/40 dark:bg-amber-900/10">
                          <strong>{palletBreakdown.missing.length} SKU{palletBreakdown.missing.length === 1 ? "" : "s"}</strong> have no <code>units / pallet</code> set and aren't counted toward fullness:{" "}
                          <span className="text-slate-700 dark:text-slate-300">
                            {palletBreakdown.missing.slice(0, 6).map((p) => shortCode(p)).join(", ")}
                            {palletBreakdown.missing.length > 6 ? ` +${palletBreakdown.missing.length - 6} more` : ""}
                          </span>. Set <code>pallet_capacity_units</code> on the SKU page to include them.
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/* ---------- Time scrubber: drag to see warehouse fullness over time ---------- */}
      {totalCap > 0 ? (() => {
        const today = todayIso();
        const HORIZON = 52;
        const scrubDate = scrubWeek === 0 ? today : addDays(today, scrubWeek * 7);
        const scrubPct = scrubWeek === 0 ? utilisation : projectedUtilisation(scrubWeek);
        const scrubLevel = fullnessLevel(scrubPct);
        const scrubBarCls = {
          low: "bg-emerald-500", ok: "bg-emerald-500",
          high: "bg-amber-500", over: "bg-red-500",
        }[scrubLevel];
        const scrubTextCls = {
          low: "text-emerald-700 dark:text-emerald-300",
          ok: "text-emerald-700 dark:text-emerald-300",
          high: "text-amber-700 dark:text-amber-300",
          over: "text-red-700 dark:text-red-300",
        }[scrubLevel];

        // Shipments arriving within the horizon — annotated as triangle markers.
        const shipmentMarkers = data.shipments
          .filter((s) => s.status !== "Cancelled" && s.status !== "Delivered" && s.status !== "On hold" && s.status !== "Back-Ordered")
          .map((s) => {
            const arrival = s.actual_arrival_date ?? s.expected_arrival_date;
            const days = diffDays(today, arrival);
            if (days < 0 || days > HORIZON * 7) return null;
            const totalUnits = s.lines && s.lines.length > 0
              ? s.lines.reduce((sum, l) => sum + l.quantity, 0)
              : (s.quantity ?? 0);
            return {
              id: s.id,
              week: Math.max(0, Math.min(HORIZON, Math.round(days / 7))),
              po: s.po_number,
              supplier: s.supplier,
              arrival,
              units: totalUnits,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .sort((a, b) => a.week - b.week);

        // Demand events overlapping the horizon — small bars under the slider.
        const eventMarkers = data.events
          .map((e) => {
            const startDays = diffDays(today, e.start_date);
            const endDays = diffDays(today, e.end_date);
            if (endDays < 0 || startDays > HORIZON * 7) return null;
            return {
              startWeek: Math.max(0, startDays / 7),
              endWeek: Math.min(HORIZON, endDays / 7),
              name: e.name,
              multiplier: e.multiplier,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

        return (
          <Card>
            <CardHeader>
              <CardTitle>Warehouse over time</CardTitle>
              <span className="text-xs text-slate-500">
                Drag the slider to scrub through the next 52 weeks. Stock depletes from sales,
                tops up from incoming shipments, and bends with active demand events.
              </span>
            </CardHeader>
            <CardBody className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-4 items-center">
                {/* Fullness readout for the scrubbed week */}
                <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-4 py-3 min-w-[180px] bg-slate-50/60 dark:bg-slate-900/40">
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">
                    {scrubWeek === 0 ? "Today" : `Week +${scrubWeek}`}
                  </div>
                  <div className="text-lg font-bold tabular-nums">{fmtShortDate(scrubDate)}</div>
                  <div className={cn("mt-1 text-2xl font-bold tabular-nums", scrubTextCls)}>
                    {fmtPct(scrubPct, 1)}
                  </div>
                  <div className="text-[11px] text-slate-500">full</div>
                </div>

                {/* Slider track + markers */}
                <div className="space-y-2">
                  {/* Shipment-arrival markers above the slider */}
                  <div className="relative h-8">
                    {(() => {
                      const byWeek = new Map<number, typeof shipmentMarkers>();
                      for (const m of shipmentMarkers) {
                        const arr = byWeek.get(m.week) ?? [];
                        arr.push(m);
                        byWeek.set(m.week, arr);
                      }
                      const clusters = Array.from(byWeek.entries())
                        .map(([week, items]) => ({ week, items }))
                        .sort((a, b) => a.week - b.week);
                      return clusters.map((cluster, ci) => {
                        const leftPct = `${(cluster.week / HORIZON) * 100}%`;
                        if (cluster.items.length === 1) {
                          const m = cluster.items[0];
                          return (
                            <Link
                              key={`sh-${ci}`}
                              to={`/shipments?edit=${m.id}`}
                              className="absolute -translate-x-1/2 inline-flex items-center justify-center w-7 h-7 rounded-full hover:bg-blue-100 dark:hover:bg-blue-900/40 ring-1 ring-transparent hover:ring-blue-300 dark:hover:ring-blue-700 transition-colors"
                              style={{ left: leftPct, top: 0 }}
                              title={`${m.po} - ${m.supplier} - ${fmtNum(m.units)} units - arrives ${m.arrival}. Click to open shipment.`}
                            >
                              <Truck size={18} className="text-blue-600" />
                            </Link>
                          );
                        }
                        return (
                          <div
                            key={`cl-${ci}`}
                            className="absolute -translate-x-1/2 group z-10"
                            style={{ left: leftPct, top: 0 }}
                          >
                            <button
                              type="button"
                              className="relative inline-flex items-center justify-center w-7 h-7 rounded-full bg-blue-50 dark:bg-blue-900/40 ring-2 ring-blue-400 dark:ring-blue-600 hover:ring-blue-600 dark:hover:ring-blue-400 transition-colors cursor-pointer"
                              title={`${cluster.items.length} shipments arriving this week - hover to see all`}
                            >
                              <Truck size={18} className="text-blue-700 dark:text-blue-300" />
                              <span className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[10px] font-bold tabular-nums ring-2 ring-white dark:ring-slate-900">
                                {cluster.items.length}
                              </span>
                            </button>
                            <div className="hidden group-hover:block absolute left-1/2 -translate-x-1/2 top-9 z-30 w-64 rounded-md ring-1 ring-slate-200 dark:ring-slate-700 bg-white dark:bg-slate-900 shadow-lg p-2 space-y-1">
                              <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 px-1 pb-1 border-b border-slate-100 dark:border-slate-800">
                                {cluster.items.length} shipments arriving
                              </div>
                              {cluster.items.map((m) => (
                                <Link
                                  key={m.id}
                                  to={`/shipments?edit=${m.id}`}
                                  className="block px-2 py-1 rounded text-xs hover:bg-blue-50 dark:hover:bg-blue-900/30 text-slate-700 dark:text-slate-200"
                                >
                                  <div className="font-medium truncate">{m.po} - {m.supplier}</div>
                                  <div className="text-[10px] text-slate-500">{fmtNum(m.units)} units, arrives {m.arrival}</div>
                                </Link>
                              ))}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>

                  {/* The slider itself */}
                  <input
                    type="range"
                    min={0}
                    max={HORIZON}
                    step={1}
                    value={scrubWeek}
                    onChange={(e) => setScrubWeek(Number(e.target.value))}
                    className="w-full accent-slate-900 dark:accent-slate-100"
                    aria-label="Week to inspect"
                  />

                  {/* Coloured fullness bar mirroring the slider track */}
                  <div className="relative h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div
                      className={cn("h-full transition-[width] duration-200", scrubBarCls)}
                      style={{ width: `${Math.min(scrubPct, 100)}%` }}
                    />
                  </div>

                  {/* Active demand events as bands under the slider */}
                  <div className="relative h-3">
                    {eventMarkers.map((ev, i) => (
                      <div
                        key={`ev-${i}`}
                        className={cn(
                          "absolute h-2 rounded-sm",
                          ev.multiplier >= 1
                            ? "bg-emerald-300/60 dark:bg-emerald-700/60"
                            : "bg-red-300/60 dark:bg-red-700/60",
                        )}
                        style={{
                          left: `${(ev.startWeek / HORIZON) * 100}%`,
                          width: `${Math.max(((ev.endWeek - ev.startWeek) / HORIZON) * 100, 0.5)}%`,
                        }}
                        title={`${ev.name} · ×${ev.multiplier}`}
                      />
                    ))}
                  </div>

                  {/* Date tick labels at 0/13/26/39/52 — quarter markers */}
                  <div className="relative h-4 text-[10px] text-slate-500">
                    {[0, 13, 26, 39, 52].map((w) => (
                      <span
                        key={w}
                        className="absolute -translate-x-1/2 tabular-nums"
                        style={{ left: `${(w / HORIZON) * 100}%` }}
                      >
                        {w === 0 ? "Now" : fmtShortDate(addDays(today, w * 7))}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Legend / summary list of upcoming arrivals near the scrubbed week */}
              {shipmentMarkers.length > 0 ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 pt-1">
                  <span className="inline-flex items-center gap-1"><Truck size={10} className="text-blue-600" /> Shipment arrival</span>
                  <span className="inline-flex items-center gap-1"><Sparkles size={10} className="text-emerald-600" /> Demand event</span>
                  <span>{shipmentMarkers.length} shipment{shipmentMarkers.length === 1 ? "" : "s"} in window</span>
                  <span>{eventMarkers.length} event{eventMarkers.length === 1 ? "" : "s"} in window</span>
                </div>
              ) : null}
            </CardBody>
          </Card>
        );
      })() : null}

      {/* ---------- Stockout schedule: per-SKU depletion timeline ---------- */}
      {(() => {
        // Pixel-per-week zoom drives an absolute width. Wider than the viewport
        // → horizontal scroll. Zooming in actually shows more detail per week
        // instead of just compressing the same 52 weeks into the same width.
        const INFO_WIDTH = 240;
        const timelineWidth = HORIZON_WEEKS * pxPerWeek;
        // Tick density adapts so we never show more than ~13 labels.
        const tickEvery = pxPerWeek >= 60 ? 1 : pxPerWeek >= 32 ? 2 : pxPerWeek >= 18 ? 4 : pxPerWeek >= 10 ? 8 : 13;
        // Source the canonical week dates from the forecast rows themselves
        // (scenario start = next Monday, NOT today) so header ticks line up
        // with the cell dates. Falls back to today + N weeks if no forecasts.
        const referenceCells = stockoutSchedule.find((s) => s.cells.length > 0)?.cells ?? [];
        const tickDate = (i: number): string =>
          referenceCells[i]?.weekStart || addDays(todayIso(), (i + 1) * 7);
        return (
          <Card>
            <CardHeader>
              <CardTitle>Stockout schedule</CardTitle>
              <span className="text-xs text-slate-500">
                Every SKU plotted across the next {HORIZON_WEEKS} weeks. Soonest stockouts at the top. Use
                Zoom to widen each week, then scroll horizontally; click a cell to scrub the timeline above.
              </span>
              <div
                className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-400"
                aria-label="Cell colour legend"
              >
                <span className="font-semibold uppercase tracking-wide text-[10px] text-slate-500">Cell colour</span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm bg-emerald-500 dark:bg-emerald-500" />
                  At or above target
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm bg-emerald-300 dark:bg-emerald-700" />
                  50-99% of target
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm bg-amber-300 dark:bg-amber-600" />
                  25-49% (low)
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm bg-red-300 dark:bg-red-700" />
                  1-24% (critical)
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm bg-red-500 dark:bg-red-600" />
                  Out of stock
                </span>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {/* Zoom controls */}
              <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-xs">
                <span className="text-slate-500 font-medium">Zoom</span>
                <button
                  type="button"
                  onClick={() => setPxPerWeek((v) => Math.max(6, Math.round(v * 0.7)))}
                  className="px-2 h-6 rounded ring-1 ring-slate-300 dark:ring-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                  aria-label="Zoom out"
                >−</button>
                <input
                  type="range"
                  min={6}
                  max={120}
                  step={1}
                  value={pxPerWeek}
                  onChange={(e) => setPxPerWeek(Number(e.target.value))}
                  className="flex-1 max-w-xs accent-slate-900 dark:accent-slate-100"
                  aria-label="Pixels per week"
                />
                <button
                  type="button"
                  onClick={() => setPxPerWeek((v) => Math.min(120, Math.round(v * 1.4)))}
                  className="px-2 h-6 rounded ring-1 ring-slate-300 dark:ring-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                  aria-label="Zoom in"
                >+</button>
                <span className="tabular-nums text-slate-500">{pxPerWeek}px / week</span>
                {[12, 24, 48].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPxPerWeek(n)}
                    className={cn(
                      "px-2 h-6 rounded text-xs",
                      pxPerWeek === n
                        ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                        : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800",
                    )}
                  >{n}</button>
                ))}
                <span className="ml-auto inline-flex items-center gap-2">
                  <span className="text-slate-500 font-medium">Sort</span>
                  <select
                    value={stockoutSort}
                    onChange={(e) => setStockoutSort(e.target.value as "stockout" | "display")}
                    className="h-6 text-xs rounded border border-slate-300 dark:border-slate-700 bg-transparent px-2"
                    aria-label="Sort stockout schedule"
                  >
                    <option value="stockout">Soonest stockout</option>
                    <option value="display">SKU order</option>
                  </select>
                  <span className="text-slate-500 font-medium ml-2">Supplier</span>
                  <select
                    value={stockoutSupplier}
                    onChange={(e) => setStockoutSupplier(e.target.value)}
                    className="h-6 text-xs rounded border border-slate-300 dark:border-slate-700 bg-transparent px-2"
                    aria-label="Filter stockout schedule by supplier"
                  >
                    <option value="all">All suppliers</option>
                    {stockoutSuppliers.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <span className="tabular-nums text-slate-500">
                    {stockoutSchedule.length} SKU{stockoutSchedule.length === 1 ? "" : "s"}
                  </span>
                </span>
              </div>

              {/* Scrollable timeline area: vertical scroll for SKUs, horizontal for weeks. */}
              <div className="max-h-[520px] overflow-auto">
                <div style={{ minWidth: INFO_WIDTH + timelineWidth }}>
                  {/* Header row: SKU info + week ticks. */}
                  <div className="sticky top-0 z-20 flex bg-slate-50 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
                    <div
                      className="sticky left-0 z-10 bg-slate-50 dark:bg-slate-900/95 flex items-stretch px-3 py-2 font-medium gap-3 border-r border-slate-200 dark:border-slate-800"
                      style={{ width: INFO_WIDTH, minWidth: INFO_WIDTH }}
                    >
                      <span className="flex-1">SKU</span>
                      <span className="w-16 text-right">On hand</span>
                      <span className="w-20 text-right">Stockout</span>
                    </div>
                    <div
                      className="relative py-2"
                      style={{ width: timelineWidth, minWidth: timelineWidth }}
                    >
                      {/* Week-tick labels along the top */}
                      {Array.from({ length: HORIZON_WEEKS }).map((_, i) => {
                        const w = i + 1;
                        if (w !== 1 && w % tickEvery !== 0 && w !== HORIZON_WEEKS) return null;
                        return (
                          <div
                            key={`tick-${w}`}
                            className="absolute top-1 -translate-x-1/2 tabular-nums whitespace-nowrap"
                            style={{ left: i * pxPerWeek + pxPerWeek / 2 }}
                          >
                            <span className="font-medium">w{w}</span>
                            <span className="ml-1 text-slate-400">
                              {fmtShortDate(tickDate(i))}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* SKU rows */}
                  {stockoutSchedule.length === 0 ? (
                    <div className="px-3 py-8 text-center text-sm text-slate-500">
                      No SKUs with forecast data yet.
                    </div>
                  ) : null}
                  {stockoutSchedule.map(({ product, stockoutWeek, stockoutDate, cells }) => {
                    const onHand = product.current_on_hand;
                    const urgency =
                      stockoutWeek === null
                        ? "text-slate-500"
                        : stockoutWeek <= 4
                          ? "text-red-600 dark:text-red-400 font-semibold"
                          : stockoutWeek <= 12
                            ? "text-amber-600 dark:text-amber-400 font-medium"
                            : "text-slate-700 dark:text-slate-300";
                    return (
                      <div
                        key={product.id}
                        className="flex items-stretch border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/60 dark:hover:bg-slate-900/30"
                      >
                        <div
                          className="sticky left-0 z-10 bg-white dark:bg-slate-900 flex items-center px-3 py-1.5 text-xs gap-3 border-r border-slate-200 dark:border-slate-800"
                          style={{ width: INFO_WIDTH, minWidth: INFO_WIDTH }}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-slate-900 dark:text-slate-100 truncate">{shortCode(product)}</div>
                            <div className="text-[10px] text-slate-500 truncate" title={product.code}>{product.code}</div>
                          </div>
                          <div className="w-16 text-right tabular-nums text-slate-600 dark:text-slate-300">{fmtNum(onHand)}</div>
                          <div className={cn("w-20 text-right tabular-nums whitespace-nowrap", urgency)}>
                            {stockoutWeek === null
                              ? "OK"
                              : `w${stockoutWeek}`}
                          </div>
                        </div>
                        <div
                          className="relative py-1"
                          style={{ width: timelineWidth, minWidth: timelineWidth }}
                          title={stockoutWeek !== null && stockoutDate ? `${shortCode(product)} runs out around ${fmtShortDate(stockoutDate)}` : undefined}
                        >
                          {/* The heatmap cells, one per week */}
                          <div
                            className="grid gap-px h-full"
                            style={{ gridTemplateColumns: `repeat(${HORIZON_WEEKS}, ${pxPerWeek}px)` }}
                          >
                            {cells.map((c, i) => (
                              <button
                                key={i}
                                type="button"
                                onClick={() => setScrubWeek(i + 1)}
                                className={cn(
                                  "h-full transition-opacity hover:opacity-70 focus:outline focus:outline-1 focus:outline-slate-900",
                                  c.color,
                                )}
                                title={`${shortCode(product)} · week ${i + 1}${c.weekStart ? ` (${c.weekStart})` : ""} · projected stock ${fmtNum(c.stockEnd)}`}
                                aria-label={`Set scrubber to week ${i + 1}`}
                              />
                            ))}
                          </div>
                          {/* Cursor at the active scrubWeek */}
                          {scrubWeek > 0 && scrubWeek <= HORIZON_WEEKS ? (
                            <div
                              className="absolute top-0 bottom-0 w-0.5 bg-slate-900 dark:bg-slate-100 pointer-events-none"
                              style={{ left: (scrubWeek - 1) * pxPerWeek + pxPerWeek / 2 - 1 }}
                            />
                          ) : null}
                          {/* Stockout-week marker — a thin red vertical line so the user can spot it without hovering */}
                          {stockoutWeek !== null ? (
                            <div
                              className="absolute top-0 bottom-0 w-px bg-red-700/70 dark:bg-red-400/70 pointer-events-none"
                              style={{ left: (stockoutWeek - 1) * pxPerWeek + pxPerWeek / 2 }}
                              aria-label={`Stockout marker at week ${stockoutWeek}`}
                            />
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 px-3 py-2 border-t border-slate-100 dark:border-slate-800">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500" /> ≥ target
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-300 dark:bg-emerald-700" /> 50–100% of target
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-300 dark:bg-amber-600" /> 25–50%
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-300 dark:bg-red-700" /> &lt; 25%
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500 dark:bg-red-600" /> Out of stock
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-px h-3 bg-red-700 dark:bg-red-400" /> Stockout week marker
                </span>
              </div>
            </CardBody>
          </Card>
        );
      })()}

    </div>
  );
}

/** Big circular gauge — primary fullness score on the Warehouse page. */
function FullnessGauge({
  pct, totalUsed, totalCap,
}: { pct: number; totalUsed: number; totalCap: number }) {
  const safe = Math.max(0, pct);
  const overflow = safe > 100;
  // Arc fills to 100% max — beyond that the circle stays full and we lean
  // on the big number to show the actual overflow ("138%").
  const arcPct = Math.min(100, safe);
  const level = overflow ? "over" : fullnessLevel(safe);
  // Tailwind classes per level - text colour for the % label and stroke colour for the arc.
  const textCls = {
    low: "text-emerald-600 dark:text-emerald-400",
    ok: "text-emerald-600 dark:text-emerald-400",
    high: "text-amber-600 dark:text-amber-400",
    over: "text-red-600 dark:text-red-400",
  }[level];
  const arcCls = {
    low: "stroke-emerald-500",
    ok: "stroke-emerald-500",
    high: "stroke-amber-500",
    over: "stroke-red-500",
  }[level];
  const label = overflow
    ? "Over capacity"
    : { low: "Plenty of room", ok: "Healthy", high: "Filling up", over: "Near capacity" }[level];

  // SVG circle math.
  const size = 180;
  const stroke = 14;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (arcPct / 100) * c;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle
            cx={size / 2} cy={size / 2} r={r}
            strokeWidth={stroke}
            className="stroke-slate-200 dark:stroke-slate-800"
            fill="none"
          />
          <circle
            cx={size / 2} cy={size / 2} r={r}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
            className={cn(arcCls, "transition-[stroke-dashoffset] duration-500")}
            fill="none"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className={cn("text-4xl font-bold tabular-nums", textCls)}>
            {fmtPct(safe, 0)}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">
            full
          </div>
        </div>
      </div>
      <div className="text-center">
        <div className={cn("text-sm font-semibold", textCls)}>{label}</div>
        <div className="text-xs text-slate-500">{totalUsed.toLocaleString()} of {totalCap.toLocaleString()} pallet slots</div>
      </div>
    </div>
  );
}

/** Compact stat tile used alongside the gauge. */
function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/50 dark:bg-slate-900/30">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</div>
      <div className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{value}</div>
      {sub ? <div className="text-[10px] text-slate-500">{sub}</div> : null}
    </div>
  );
}

/** A single row in the projected-fullness list - label, percentage, and a coloured progress bar. */
function ProjectionRow({ label, pct }: { label: string; pct: number }) {
  // Bar fill caps at 100% visually, but the readout shows the true value.
  // Over-capacity weeks render as a full red bar with a label like "138%"
  // so the user can see *how much* over they'd be.
  const safe = Math.max(0, pct);
  const barWidth = Math.min(100, safe);
  const overflow = safe > 100;
  const level = overflow ? "over" : fullnessLevel(safe);
  const barCls = {
    low: "bg-emerald-500",
    ok: "bg-emerald-500",
    high: "bg-amber-500",
    over: "bg-red-500",
  }[level];
  const textCls = overflow
    ? "text-red-700 dark:text-red-300 font-bold"
    : "text-slate-700 dark:text-slate-300";
  return (
    <div className="grid grid-cols-[80px_1fr_56px] items-center gap-3">
      <div className="text-xs text-slate-600 dark:text-slate-400">{label}</div>
      <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
        <div className={cn("h-full rounded-full transition-[width] duration-500", barCls)}
          style={{ width: `${barWidth}%` }} />
      </div>
      <div className={cn("text-xs tabular-nums text-right font-medium", textCls)}>
        {fmtPct(safe, 0)}
      </div>
    </div>
  );
}
