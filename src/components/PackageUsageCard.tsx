import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Package } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tag } from "@/components/ui/Tag";
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

  const tubeIds = new Set([MAIL_TUBE_LARGE_PRODUCT_ID, MAIL_TUBE_SMALL_PRODUCT_ID]);
  const isTube = (r: { productId: string; label: string }) => tubeIds.has(r.productId) || /tube/i.test(r.label);
  const meta = rows !== null && summary.rows.length > 0
    ? `${summary.totalQty.toLocaleString()} used${summary.hasCost ? ` · est. ${summary.currency}${summary.totalCost.toFixed(2)}` : ""}`
    : undefined;

  return (
    <Section
      title="Packages used"
      meta={meta}
      subtitle={
        rangeLabel === "current range"
          ? "Boxes and mail tubes deducted from stock in the current range"
          : `Boxes and mail tubes deducted from stock · ${rangeLabel}`
      }
      storageKey="inka-reports-collapse:packages-used"
    >
      {loading ? (
        <div className="text-[13px] text-hub-faint">Loading…</div>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-hub-bad">
          {error}
          <Button variant="secondary" size="sm" onClick={() => void load()}>Retry</Button>
        </div>
      ) : rows === null ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-hub-muted">
          Not loaded for this range.
          <Button variant="secondary" size="sm" onClick={() => void load()}>Load package usage</Button>
        </div>
      ) : summary.rows.length === 0 ? (
        <EmptyState icon={Package} title="No packages deducted in this range" hint="Boxes and mail tubes are deducted from stock as orders ship." />
      ) : (
        <div className="flex flex-wrap gap-2">
          {summary.rows.map((r) => {
            const tube = isTube(r);
            const costTitle = r.unitCost == null
              ? "No unit cost set"
              : `Unit cost ${summary.currency}${r.unitCost.toFixed(2)} · est. ${summary.currency}${(r.cost ?? 0).toFixed(2)}`;
            return (
              <div
                key={r.productId}
                title={costTitle}
                className="flex items-center gap-2 rounded-hub border border-hub-line px-2.5 py-1.5"
              >
                <Tag color={tube ? "blue" : "gray"}>{tube ? "TUBE" : "BOX"}</Tag>
                <span className="text-[13px] text-hub-text">{r.label}</span>
                <b className="font-semibold tabular-nums text-hub-text">{r.qty.toLocaleString()}</b>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
