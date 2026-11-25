import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Package } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { getSupabase } from "@/lib/repository/supabase/client";
import { useAppStore } from "@/lib/state/appStore";
import { useDataset } from "@/lib/hooks/useDataset";
import {
  PACKAGE_TYPES,
  MAIL_TUBE_LARGE_PRODUCT_ID,
  MAIL_TUBE_SMALL_PRODUCT_ID,
  MAIL_TUBE_LABELS,
} from "@/lib/domain/skuRouting";
import { fetchAllRows } from "@/lib/repository/supabase/pageThrough";
import { usePackagingCatalogue } from "@/lib/hooks/usePackagingCatalogue";
import { netUsageByProduct, PACKAGE_USAGE_ROWS_FILTER } from "@/lib/domain/packaging/usage";

interface LedgerRow {
  product_id: string;
  delta: number;
  ts: string;
}

/**
 * Packages used in the current Reports date range. Reads the ledger for
 * negative-delta rows against package products (A0 boxes, mail tubes,
 * etc.) and aggregates by product.
 *
 * Historical read on request only (Task 17): nothing is fetched on mount or
 * on a Reports refresh. A change of site, range or package set clears the
 * rows back to "not loaded"; Load reads every page (ts, id) or shows an
 * error - a partial aggregate is never shown as complete.
 */
export function PackageUsageCard({
  fromIso,
  toIso,
  rangeLabel,
}: {
  fromIso: string;
  toIso: string;
  rangeLabel: string;
}) {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const { data } = useDataset();
  /** null = not loaded for the current site/range/package set. */
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // F4: packaging items from the site's rule sets (empty when there are none).
  const catalogue = usePackagingCatalogue();
  const seq = useRef(0);

  // Which product IDs are packages? Match PACKAGE_TYPES.key against
  // product.code (dispatch scan flow) + the two known mail tube IDs
  // (unframed auto-assign flow).
  const packageProductIds = useMemo(() => {
    if (!data) return new Set<string>();
    const codeSet = new Set(PACKAGE_TYPES.map((p) => p.key));
    const ids = new Set<string>();
    for (const p of data.products) {
      if (codeSet.has(p.code)) ids.add(p.id);
    }
    ids.add(MAIL_TUBE_LARGE_PRODUCT_ID);
    ids.add(MAIL_TUBE_SMALL_PRODUCT_ID);
    for (const id of catalogue.keys()) ids.add(id);
    return ids;
  }, [data, catalogue]);

  // A new site/range/package set invalidates any shown or in-flight result (no read here).
  const scopeKey = `${location}|${fromIso}|${toIso}|${Array.from(packageProductIds).sort().join(",")}`;
  useEffect(() => {
    seq.current++;
    setRows(null);
    setLoading(false);
    setError(null);
  }, [scopeKey]);

  // Explicit, complete read of the package ledger rows in the range.
  const load = useCallback(async () => {
    if (!data || packageProductIds.size === 0) {
      setRows([]);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const idsArray = Array.from(packageProductIds);
      const results = await fetchAllRows<LedgerRow>((from, to) =>
        supabase
          .from("ledger")
          .select("product_id, delta, ts")
          .eq("location", location)
          .in("product_id", idsArray)
          // F4: include rows written back by packaging corrections.
          .or(PACKAGE_USAGE_ROWS_FILTER)
          .gte("ts", fromIso)
          .lte("ts", toIso)
          .order("ts", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      );
      if (mine !== seq.current) return;
      setRows(results);
    } catch (e) {
      if (mine !== seq.current) return;
      setRows(null); // never a partial aggregate
      setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [supabase, location, fromIso, toIso, packageProductIds, data]);

  const summary = useMemo(() => {
    if (!data) return { rows: [], totalQty: 0, totalCost: 0, hasCost: false };
    const perProduct = netUsageByProduct(rows ?? []);
    const productById = new Map(data.products.map((p) => [p.id, p]));
    const currency = data.settings?.currency_symbol ?? "$";
    let totalQty = 0;
    let totalCost = 0;
    let hasCost = false;
    const summaryRows = Array.from(perProduct.entries()).map(([productId, qty]) => {
      const product = productById.get(productId);
      const label =
        product?.code ??
        MAIL_TUBE_LABELS[productId] ??
        catalogue.get(productId) ??
        "Unknown package";
      const unitCost = product?.unit_cost ?? null;
      const cost = unitCost != null ? qty * unitCost : null;
      totalQty += qty;
      if (cost != null) { totalCost += cost; hasCost = true; }
      return { productId, label, qty, unitCost, cost };
    }).sort((a, b) => b.qty - a.qty);
    return { rows: summaryRows, totalQty, totalCost, hasCost, currency };
  }, [rows, data, catalogue]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <Package size={16} /> Packages used
        </CardTitle>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Boxes + mail tubes deducted from stock — {rangeLabel}
        </span>
      </CardHeader>
      <CardBody className="p-0">
        {loading ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : error ? (
          <div className="p-6 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
            {error}
            <Button variant="secondary" size="sm" onClick={() => void load()}>Retry</Button>
          </div>
        ) : rows === null ? (
          <div className="p-6 text-sm text-slate-500 flex items-center gap-2">
            Not loaded for this range.
            <Button variant="secondary" size="sm" onClick={() => void load()}>Load package usage</Button>
          </div>
        ) : summary.rows.length === 0 ? (
          <div className="p-6 text-sm text-slate-500 italic">
            No packages deducted in this range.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Package</th>
                  <th className="text-right px-3 py-2 font-semibold">Qty used</th>
                  <th className="text-right px-3 py-2 font-semibold">Unit cost</th>
                  <th className="text-right px-4 py-2 font-semibold">Est. cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {summary.rows.map((r) => (
                  <tr key={r.productId}>
                    <td className="px-4 py-2 font-medium">{r.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.qty.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                      {r.unitCost == null ? "—" : `${summary.currency}${r.unitCost.toFixed(2)}`}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {r.cost == null
                        ? <span className="text-slate-400 italic">no cost</span>
                        : `${summary.currency}${r.cost.toFixed(2)}`}
                    </td>
                  </tr>
                ))}
                <tr className="bg-slate-50 dark:bg-slate-900/40 font-semibold">
                  <td className="px-4 py-2">Total</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {summary.totalQty.toLocaleString()}
                  </td>
                  <td />
                  <td className="px-4 py-2 text-right tabular-nums">
                    {summary.hasCost
                      ? `${summary.currency}${summary.totalCost.toFixed(2)}`
                      : <span className="text-slate-400 italic">—</span>}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}