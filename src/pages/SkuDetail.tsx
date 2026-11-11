import { useEffect, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import { useState } from "react";
import { useDataset } from "@/lib/hooks/useDataset";
import { useForecasts } from "@/lib/hooks/useForecasts";
import { useLedger } from "@/lib/hooks/useLedger";
import { useMutations } from "@/lib/hooks/useMutations";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Input";
import { StatusPill } from "@/components/ui/StatusPill";
import { SkuSettingsCard } from "@/components/SkuSettingsCard";
import { fmtDayMonth, fmtFloat, fmtNum } from "@/lib/utils/format";
import { effectiveSafetyStock, ProductSchema, shortCode } from "@/lib/domain";
import type { LedgerEntry, LedgerReason, Product } from "@/lib/domain";

/**
 * Detail view for a single SKU — KPIs, 52-week forecast chart with
 * lead-time / safety / target reference lines, and the inline editable
 * settings card.
 */
export function SkuDetail() {
  const { id } = useParams<{ id: string }>();
  const { data } = useDataset();
  const { byId } = useForecasts();
  const navigate = useNavigate();

  // Sort SKUs the same way the SKUs page does — display_order, then short
  // code as a tiebreaker — so the prev/next arrows step in a predictable
  // order. Memoised here at top-level so the keyboard handler below can
  // close over the latest value without violating hook order rules.
  const sortedProducts = useMemo(() => {
    const list = data?.products ?? [];
    return list
      .slice()
      .sort((a, b) => {
        const ao = a.display_order ?? 0;
        const bo = b.display_order ?? 0;
        if (ao !== bo) return ao - bo;
        return a.code.localeCompare(b.code);
      });
  }, [data?.products]);
  const currentIdx = sortedProducts.findIndex((p) => p.id === id);
  const prevSku = currentIdx > 0 ? sortedProducts[currentIdx - 1] : null;
  const nextSku =
    currentIdx >= 0 && currentIdx < sortedProducts.length - 1
      ? sortedProducts[currentIdx + 1]
      : null;

  // Bind ← / → to nav. Skipped when the user is typing into an input or
  // textarea so the SkuSettingsCard fields don't fight with navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      if (e.key === "ArrowLeft" && prevSku) {
        e.preventDefault();
        navigate(`/skus/${prevSku.id}`);
      } else if (e.key === "ArrowRight" && nextSku) {
        e.preventDefault();
        navigate(`/skus/${nextSku.id}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prevSku, nextSku, navigate]);

  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;
  const product = data.products.find((p) => p.id === id);
  if (!product) {
    return (
      <div className="space-y-3">
        <Link to="/skus" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:underline">
          <ArrowLeft size={14} /> Back to SKUs
        </Link>
        <div className="text-sm text-slate-500">SKU not found.</div>
      </div>
    );
  }

  const r = byId[product.id];
  const chartData = (r?.rows ?? []).map((row) => ({
    week: row.week,
    weekStart: row.weekStart,
    stockEnd: Math.round(row.stockEnd),
  }));

  const safetyFloor = r ? effectiveSafetyStock(product, r.weeklyAverage) : 0;
  const leadWeeks = Math.max(1, Math.ceil(product.lead_time_days / 7));
  const leadPoint = chartData[Math.min(leadWeeks, chartData.length - 1)];

  // Last 26 weeks of recorded sales for this SKU. Sorted chronologically so
  // the bar chart reads left-to-right oldest-to-newest.
  const recentSales = data.sales
    .filter((s) => s.product_id === product.id)
    .slice()
    .sort((a, b) => a.iso_week_start.localeCompare(b.iso_week_start))
    .slice(-26)
    .map((s) => ({ weekStart: s.iso_week_start, units: s.units_sold }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/skus" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:underline">
            <ArrowLeft size={12} /> Back to SKUs
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight flex items-center gap-2">
            {product.code}
            {r ? <StatusPill status={r.status} /> : null}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {product.size} · {product.colour} · {product.supplier}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {/* Prev / next stepper through the sorted SKU list. ← / → also work. */}
          {prevSku ? (
            <Link
              to={`/skus/${prevSku.id}`}
              className="inline-flex items-center gap-1 h-8 px-2 rounded ring-1 ring-slate-300 dark:ring-slate-700 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              title={`Previous: ${prevSku.code}  (←)`}
            >
              <ChevronLeft size={14} />
              <span className="hidden sm:inline truncate max-w-[120px]">{prevSku.code}</span>
            </Link>
          ) : (
            <span
              className="inline-flex items-center gap-1 h-8 px-2 rounded ring-1 ring-slate-200 dark:ring-slate-800 text-sm text-slate-400 cursor-not-allowed"
              aria-disabled="true"
              title="No previous SKU"
            >
              <ChevronLeft size={14} />
            </span>
          )}
          <span className="text-xs text-slate-500 tabular-nums px-2">
            {currentIdx >= 0 ? `${currentIdx + 1} / ${sortedProducts.length}` : ""}
          </span>
          {nextSku ? (
            <Link
              to={`/skus/${nextSku.id}`}
              className="inline-flex items-center gap-1 h-8 px-2 rounded ring-1 ring-slate-300 dark:ring-slate-700 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              title={`Next: ${nextSku.code}  (→)`}
            >
              <span className="hidden sm:inline truncate max-w-[120px]">{nextSku.code}</span>
              <ChevronRight size={14} />
            </Link>
          ) : (
            <span
              className="inline-flex items-center gap-1 h-8 px-2 rounded ring-1 ring-slate-200 dark:ring-slate-800 text-sm text-slate-400 cursor-not-allowed"
              aria-disabled="true"
              title="No next SKU"
            >
              <ChevronRight size={14} />
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={() => window.history.back()}>
            Back
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card><CardBody>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">On hand</div>
          <div className="text-2xl font-bold tabular-nums">{fmtNum(product.current_on_hand)}</div>
        </CardBody></Card>
        <Card><CardBody>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Weekly avg</div>
          <div className="text-2xl font-bold tabular-nums">
            {r ? fmtFloat(r.weeklyAverage, 1) : "—"}
          </div>
        </CardBody></Card>
        <Card><CardBody>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Weeks of cover</div>
          <div className="text-2xl font-bold tabular-nums">
            {r?.weeksUntilOosCurrent === null || r?.weeksUntilOosCurrent === undefined
              ? "—"
              : r.weeksUntilOosCurrent}
          </div>
        </CardBody></Card>
        <Card><CardBody>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Suggested order</div>
          <div className="text-2xl font-bold tabular-nums">
            {r ? fmtNum(r.suggestedOrderQty) : "—"}
          </div>
        </CardBody></Card>
      </div>

      {/* Forecast chart */}
      <Card>
        <CardHeader>
          <CardTitle>52-week forecast</CardTitle>
          <span className="text-xs text-slate-500">
            Dotted line = lead-time horizon · dashed = safety floor · faint = target
          </span>
        </CardHeader>
        <CardBody>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" className="stroke-slate-200 dark:stroke-slate-800" />
                <XAxis
                  dataKey="weekStart"
                  tickFormatter={(v) => fmtDayMonth(v as string)}
                  fontSize={11}
                  stroke="rgb(100 116 139)"
                />
                <YAxis fontSize={11} stroke="rgb(100 116 139)" allowDecimals={false} />
                <Tooltip
                  formatter={(v: number) => fmtNum(v)}
                  labelFormatter={(v) => fmtDayMonth(v as string)}
                />
                <Line type="monotone" dataKey="stockEnd" stroke="rgb(15 118 110)" strokeWidth={2} dot={false} isAnimationActive={false} />
                <ReferenceLine y={0} stroke="rgb(148 163 184)" />
                {safetyFloor > 0 ? (
                  <ReferenceLine
                    y={safetyFloor}
                    stroke="rgb(239 68 68)"
                    strokeDasharray="6 4"
                    strokeOpacity={0.5}
                    label={{ value: `Safety ${fmtNum(safetyFloor)}`, position: "insideTopLeft", fontSize: 10, fill: "rgb(239 68 68)" }}
                  />
                ) : null}
                {r ? (
                  <ReferenceLine
                    y={Math.round(r.targetStock)}
                    stroke="rgb(99 102 241)"
                    strokeDasharray="2 4"
                    strokeOpacity={0.4}
                    label={{ value: `Target ${fmtNum(r.targetStock)}`, position: "insideTopRight", fontSize: 10, fill: "rgb(99 102 241)" }}
                  />
                ) : null}
                {leadPoint ? (
                  <ReferenceLine
                    x={leadPoint.weekStart}
                    stroke="rgb(99 102 241)"
                    strokeDasharray="2 3"
                    strokeOpacity={0.6}
                    label={{ value: `Lead time +${product.lead_time_days}d`, position: "insideTopRight", fontSize: 10, fill: "rgb(99 102 241)" }}
                  />
                ) : null}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>

      {/* Historical sales — last 26 weeks */}
      <Card>
        <CardHeader>
          <CardTitle>Recent sales</CardTitle>
          <span className="text-xs text-slate-500">
            Last {recentSales.length} week{recentSales.length === 1 ? "" : "s"} of recorded units sold
          </span>
        </CardHeader>
        <CardBody>
          {recentSales.length === 0 ? (
            <div className="text-sm text-slate-500 py-6 text-center">
              No sales rows yet for this SKU. Add some on the Sales Entry page.
            </div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={recentSales} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" className="stroke-slate-200 dark:stroke-slate-800" />
                  <XAxis
                    dataKey="weekStart"
                    tickFormatter={(v) => fmtDayMonth(v as string)}
                    fontSize={11}
                    stroke="rgb(100 116 139)"
                  />
                  <YAxis fontSize={11} stroke="rgb(100 116 139)" allowDecimals={false} />
                  <Tooltip
                    formatter={(v: number) => [fmtNum(v), "units"]}
                    labelFormatter={(v) => fmtDayMonth(v as string)}
                  />
                  <Bar dataKey="units" fill="rgb(15 118 110)" radius={[3, 3, 0, 0]} />
                  {r ? (
                    <ReferenceLine
                      y={r.weeklyAverage}
                      stroke="rgb(99 102 241)"
                      strokeDasharray="4 3"
                      strokeOpacity={0.6}
                      label={{
                        value: `Wk avg ${fmtFloat(r.weeklyAverage, 1)}`,
                        position: "insideTopRight",
                        fontSize: 10,
                        fill: "rgb(99 102 241)",
                      }}
                    />
                  ) : null}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Inline editable settings */}
      <SkuSettingsCard product={product} />

      {/* Bill-of-materials editor */}
      <RecipeCard product={product} />

      {/* Inventory audit trail */}
      <InventoryHistoryCard productId={product.id} currentOnHand={product.current_on_hand ?? 0} />
    </div>
  );
}

/**
 * Bill-of-materials editor. Lists every component this SKU consumes per
 * unit sold, with a row at the bottom to add another. When the user
 * saves, the change goes through `upsertProduct` which runs cycle
 * detection in the repository — so adding a component that would create
 * a recipe cycle surfaces an error here instead of silently corrupting
 * data.
 *
 * The cascade itself happens at sale time inside `adjustOnHand` (Phase 3
 * additive logic in DexieRepo). This card is purely for editing the
 * recipe, not for triggering deductions.
 */
function RecipeCard({ product }: { product: Product }) {
  const { data } = useDataset();
  const m = useMutations();
  const [pickerId, setPickerId] = useState<string>("");
  const [pickerQty, setPickerQty] = useState<string>("1");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const components = product.components ?? [];

  if (!data) return null;

  // Candidate child SKUs: anything that isn't this product, sorted by code.
  // The cycle check happens server-side on save, so we don't filter out
  // descendants here (that would require a graph walk on every render).
  const candidates = data.products
    .filter((p) => p.id !== product.id)
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code));

  const save = async (nextComponents: typeof components, successMsg?: string) => {
    setBusy(true); setError(null);
    try {
      const next: Product = { ...product, components: nextComponents };
      const parsed = ProductSchema.parse(next);
      await m.upsertProduct.mutateAsync(parsed);
      if (successMsg) setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addComponent = async () => {
    setError(null);
    if (!pickerId) {
      setError("Pick a SKU to add.");
      return;
    }
    const qty = Number(pickerQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Quantity per unit must be a positive number.");
      return;
    }
    if (components.some((c) => c.child_product_id === pickerId)) {
      setError("That SKU is already in this recipe.");
      return;
    }
    await save([...components, { child_product_id: pickerId, qty_per_unit: qty }]);
    if (!error) {
      setPickerId("");
      setPickerQty("1");
    }
  };

  const removeComponent = async (childId: string) => {
    await save(components.filter((c) => c.child_product_id !== childId));
  };

  const updateQty = async (childId: string, qty: number) => {
    if (!Number.isFinite(qty) || qty <= 0) return;
    await save(
      components.map((c) =>
        c.child_product_id === childId ? { ...c, qty_per_unit: qty } : c,
      ),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recipe · {product.code}</CardTitle>
        <span className="text-xs text-slate-500">
          What this SKU is made of. <strong>When a sale is recorded for {product.code}, each component is auto-deducted</strong> by (units sold × qty per unit). Cascades through multi-level recipes — e.g. a framed sale can flow into the print, then into the paper roll.
        </span>
      </CardHeader>
      <CardBody className="space-y-3">
        {components.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 px-3 py-3 text-sm text-slate-500">
            No components defined yet. Adding one will start auto-deducting that SKU from inventory whenever {product.code} is sold.
          </div>
        ) : (
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Component SKU</th>
                  <th className="text-right font-medium px-2 py-2">Qty per unit</th>
                  <th className="text-right font-medium px-2 py-2">On hand</th>
                  <th className="text-right font-medium px-2 py-2 w-px">Remove</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {components.map((c) => {
                  const child = data.products.find((p) => p.id === c.child_product_id);
                  return (
                    <tr key={c.child_product_id}>
                      <td className="px-3 py-1.5">
                        {child ? (
                          <>
                            <div className="font-medium">{child.code}</div>
                            <div className="text-[10px] text-slate-500">{shortCode(child)} · {child.supplier}</div>
                          </>
                        ) : (
                          <span className="text-slate-400 italic font-mono text-xs">(deleted SKU {c.child_product_id})</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <input
                          type="number"
                          step="any"
                          min={0}
                          defaultValue={c.qty_per_unit}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v !== c.qty_per_unit) void updateQty(c.child_product_id, v);
                          }}
                          className="w-24 h-8 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-right tabular-nums text-sm"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                        {child ? fmtNum(child.current_on_hand ?? 0) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void removeComponent(c.child_product_id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                          title="Remove from recipe"
                          aria-label={`Remove ${child?.code ?? c.child_product_id} from recipe`}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
          <Field label="Add component">
            <Select value={pickerId} onChange={(e) => setPickerId(e.target.value)}>
              <option value="">— pick a SKU —</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {shortCode(p)} · on hand: {fmtNum(p.current_on_hand ?? 0)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Qty per unit" hint="How many of this component does ONE unit of the parent consume? Decimal allowed (e.g. 0.00003 for ~30 m of a 30 km roll).">
            <Input
              type="number"
              step="any"
              min={0}
              value={pickerQty}
              onChange={(e) => setPickerQty(e.target.value)}
              className="w-32"
            />
          </Field>
          <Button onClick={addComponent} disabled={busy || !pickerId}>
            {busy ? "Saving…" : "Add component"}
          </Button>
        </div>
        {error ? <div className="text-sm text-red-600 dark:text-red-400">{error}</div> : null}

        {components.length > 0 ? (
          <div className="rounded-md ring-1 ring-emerald-200 dark:ring-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-900/10 px-3 py-2 text-[11px] text-emerald-900 dark:text-emerald-300">
            <strong>Preview:</strong> Selling 1 × {product.code} will deduct{" "}
            {components.map((c, i) => {
              const child = data.products.find((p) => p.id === c.child_product_id);
              return (
                <span key={c.child_product_id}>
                  {i > 0 ? ", " : ""}
                  <strong>{c.qty_per_unit}</strong> × {child?.code ?? "(deleted)"}
                </span>
              );
            })}
            .
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

const REASON_LABEL: Record<LedgerReason, string> = {
  sale: "Sale",
  shipment: "Shipment",
  usage: "Usage",
  manual: "Manual",
  stocktake: "Stocktake",
  transfer: "Transfer",
  initial: "Initial",
  import: "Import",
  bom: "BOM",
  replacement: "Replacement",
  return: "Return",
};

const REASON_TONE: Record<LedgerReason, string> = {
  sale: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  shipment: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  usage: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  manual: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  stocktake: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  transfer: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  initial: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  import: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  bom: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
  replacement: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
  return: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};

/**
 * Per-SKU ledger audit panel. Lists every inventory movement that touched
 * this product, newest first. Also computes a running on-hand by walking
 * the ledger from the bottom up — useful sanity check that the legacy
 * `current_on_hand` field matches the ledger's `Σ delta`. A mismatch flags
 * up as a warning so the user can see if anything bypassed the ledger.
 */
function InventoryHistoryCard({ productId, currentOnHand }: { productId: string; currentOnHand: number }) {
  const { data: ledger, isLoading } = useLedger(productId, 100);
  // Ledger comes back newest-first. Sum of deltas should equal current
  // on-hand IF every inventory change went through the ledger. Phase 1
  // historical data won't reconcile (the ledger only started recording
  // from the moment Phase 1 deployed), so a delta-sum < current is
  // expected for legacy products.
  const ledgerSum = (ledger ?? []).reduce((a, r) => a + r.delta, 0);
  const mismatch = currentOnHand - ledgerSum;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Inventory history</CardTitle>
        <span className="text-xs text-slate-500">
          Every recorded movement for this SKU. Sourced from the inventory ledger (Phase 1) — rows from before the ledger went live aren't shown here.
        </span>
      </CardHeader>
      <CardBody className="p-0">
        {isLoading ? (
          <div className="p-4 text-sm text-slate-500">Loading…</div>
        ) : !ledger || ledger.length === 0 ? (
          <div className="p-4 text-sm text-slate-500">
            No ledger rows yet for this SKU. Every change to <code>current_on_hand</code> from now on (sales, shipments delivered, paper-usage snapshots, manual edits) will appear here.
          </div>
        ) : (
          <>
            <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/30 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
              <span className="text-slate-500">Ledger Σ delta:</span>
              <strong className="tabular-nums text-slate-900 dark:text-slate-100">{ledgerSum >= 0 ? "+" : ""}{fmtNum(ledgerSum)}</strong>
              <span className="text-slate-500">·</span>
              <span className="text-slate-500">Current on-hand:</span>
              <strong className="tabular-nums text-slate-900 dark:text-slate-100">{fmtNum(currentOnHand)}</strong>
              <span className="text-slate-500 ml-auto">
                {mismatch === 0
                  ? <span className="text-emerald-600 dark:text-emerald-400">Reconciled</span>
                  : <span title="Pre-ledger inventory + any direct DB edits that bypassed the repo layer.">Pre-ledger seed: {mismatch >= 0 ? "+" : ""}{fmtNum(mismatch)}</span>}
              </span>
            </div>
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide sticky top-0 z-10">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">When</th>
                    <th className="text-left font-medium px-2 py-2">Reason</th>
                    <th className="text-right font-medium px-2 py-2">Delta</th>
                    <th className="text-left font-medium px-3 py-2">Source / note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {ledger.map((row: LedgerEntry) => {
                    const dt = new Date(row.ts);
                    const dateLabel = fmtDayMonth(dt.toISOString().slice(0, 10));
                    const timeLabel = dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
                    return (
                      <tr key={row.id}>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          <div className="text-slate-900 dark:text-slate-100 tabular-nums">{dateLabel}</div>
                          <div className="text-[10px] text-slate-500 tabular-nums">{timeLabel}</div>
                        </td>
                        <td className="px-2 py-1.5">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${REASON_TONE[row.reason]}`}>
                            {REASON_LABEL[row.reason]}
                          </span>
                        </td>
                        <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${row.delta < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                          {row.delta >= 0 ? "+" : ""}{fmtNum(row.delta)}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                          {row.note ? <div className="text-slate-700 dark:text-slate-300">{row.note}</div> : null}
                          {row.source_id ? <div className="font-mono text-[10px] truncate max-w-[36ch]" title={row.source_id}>{row.source_id}</div> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 text-[11px] text-slate-500 border-t border-slate-200 dark:border-slate-800">
              Showing the most recent {ledger.length} ledger row{ledger.length === 1 ? "" : "s"} for this SKU.
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
