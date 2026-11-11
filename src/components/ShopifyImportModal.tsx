import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { useDataset } from "@/lib/hooks/useDataset";
import { useMutations } from "@/lib/hooks/useMutations";
import { useAppStore } from "@/lib/state/appStore";
import {
  WeeklySalesSchema,
  WeeklyEntrySchema,
  productDepartment,
  type Product,
  type WeeklyEntry,
} from "@/lib/domain";
import type { ShopifyParseResult } from "@/lib/csv/shopifyReport";

/**
 * Confirmation modal for a Shopify weekly-report import. Receives a fully
 * parsed result from `parseShopifyCsv` plus the default week the file
 * appears to belong to, lets the user adjust the week, previews the
 * per-(size, colour) frames and SKU matches, then writes:
 *
 *  - One `WeeklySales` row per matched SKU (replaces existing → idempotent
 *    via the `(product_id, iso_week_start)` primary key).
 *  - The `WeeklyEntry` for the week, with `total_orders` adjusted by the
 *    delta of each size's contribution since the last import for that size.
 *
 * Re-importing the same file for the same week is a no-op.
 */
export function ShopifyImportModal({
  open, onClose, parseResult, defaultWeekStart,
}: {
  open: boolean;
  onClose: () => void;
  parseResult: ShopifyParseResult | null;
  defaultWeekStart: string;
}) {
  const { data } = useDataset();
  const m = useMutations();
  // Department from app state — the WeeklyEntry we write needs to land in
  // the right side's history. The unframed Shopify CSV format auto-detects
  // here (see parseShopifyCsv `format` field), so we also force department
  // to 'unframed' when the file is the unframed variant, regardless of the
  // active app-state department. Belt-and-braces.
  const activeDepartment = useAppStore((s) => s.department);
  const importDepartment: "framed" | "unframed" =
    parseResult?.ordersBySize && "Unframed" in parseResult.ordersBySize
      ? "unframed"
      : activeDepartment;
  const [weekStart, setWeekStart] = useState(defaultWeekStart);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setWeekStart(defaultWeekStart);
      setError(null);
      setDoneMsg(null);
      setBusy(false);
    }
  }, [open, defaultWeekStart]);

  const products: Product[] = data?.products ?? [];

  const matched = useMemo(() => {
    if (!parseResult) return [];
    // Normalise size strings so trailing whitespace, dashes, or weird casing
    // don't sabotage the comparison. "A2 ", "a-2", "A2cm" → "a2".
    const normSize = (s: string | null | undefined): string =>
      (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/cm$/, "");
    return parseResult.buckets.map((b) => {
      const size = normSize(b.size);
      const colour = b.colour.toLowerCase();
      // Tiered match — stops at the first hit:
      //  1. Exact (size, colour) — the original strict rule.
      //  2. Unframed prints: short_code matches "{size}U" (e.g. A0U).
      //  3. Unframed prints: any SKU at this size whose code / short_code /
      //     colour contains "unframed" or "print".
      //  4. Unframed prints: any SKU at this size with supplier="UNFRAMED".
      //     This is the most permissive fallback — catches catalogues where
      //     the unframed signal lives on the supplier field rather than the
      //     code or colour.
      let product =
        products.find(
          (p) => normSize(p.size) === size && p.colour.toLowerCase() === colour,
        ) ?? null;
      if (!product && colour === "print") {
        const shortTarget = `${size}u`;
        product =
          products.find(
            (p) => (p.short_code ?? "").toLowerCase() === shortTarget,
          ) ?? null;
      }
      if (!product && colour === "print") {
        product =
          products.find(
            (p) =>
              normSize(p.size) === size &&
              /(unframed|print)/i.test(`${p.code} ${p.short_code ?? ""} ${p.colour}`),
          ) ?? null;
      }
      if (!product && colour === "print") {
        product =
          products.find(
            (p) =>
              normSize(p.size) === size &&
              (p.supplier ?? "").trim().toLowerCase() === "unframed",
          ) ?? null;
      }
      return { ...b, product };
    });
  }, [parseResult, products]);

  // AUX SKUs (hooks, free prints) match by product code / short_code so
  // each row goes to its exact SKU. Undefined for non-SKU parses.
  const auxMatched = useMemo(() => {
    const src = parseResult?.auxSales ?? [];
    return src.map((row: { sku: string; quantity: number }) => {
      const code = row.sku.trim().toUpperCase();
      const product = products.find(
        (p) => (p.code ?? "").trim().toUpperCase() === code,
      ) ?? null;
      return { sku: row.sku, quantity: row.quantity, product };
    });
  }, [parseResult, products]);

  const matchedCount = matched.filter((x) => x.product).length + auxMatched.filter((x: { product: Product | null }) => x.product != null).length;
  const unmatchedCount = (matched.length + auxMatched.length) - matchedCount;

  if (!parseResult) {
    return (
      <Modal open={open} onClose={onClose} title="Import Shopify weekly report">
        <div className="text-sm text-slate-500">No CSV loaded.</div>
      </Modal>
    );
  }

  const apply = async () => {
    setBusy(true);
    setError(null);
    setDoneMsg(null);
    try {
      // ---- Idempotent WeeklyEntry update --------------------------------
      // Lookup is now department-scoped — framed and unframed each have
      // their own row for the same week. Pre-v9 rows without department
      // default to 'framed'.
      // Build the list of (department, ordersBySize) writes.
      //
      // Derive the split directly from the matched buckets we already
      // have. Every bucket carries a colour field the parser assigned
      // based on the SKU variant:
      //   FN / PN -> "Natural"  (framed)
      //   FB / PB -> "Black"    (framed)
      //   FW / PW -> "White"    (framed)
      //   UN      -> "Print"    (unframed)
      // For SKU-based imports this splits framed vs unframed accurately;
      // for the older framed / unframed / headerless formats, every
      // bucket lands on one side so the write shape stays identical to
      // pre-fix behaviour.
      const framedContribs: Record<string, number> = {};
      const unframedContribs: Record<string, number> = {};
      let framedTotal = 0;
      let unframedTotal = 0;
      for (const b of parseResult.buckets) {
        const isUnframed = (b.colour ?? "").toLowerCase() === "print";
        if (isUnframed) {
          unframedContribs["Unframed"] = (unframedContribs["Unframed"] ?? 0) + b.orders;
          unframedTotal += b.orders;
        } else {
          framedContribs[b.size] = (framedContribs[b.size] ?? 0) + b.orders;
          framedTotal += b.orders;
        }
      }
      // eslint-disable-next-line no-console
      console.info("[shopify-import] contribs", { framed: framedContribs, unframed: unframedContribs, importDepartment });

      const writes: Array<{ dept: "framed" | "unframed"; ordersBySize: Record<string, number> }> = [];
      if (framedTotal > 0) writes.push({ dept: "framed", ordersBySize: framedContribs });
      if (unframedTotal > 0) writes.push({ dept: "unframed", ordersBySize: unframedContribs });
      // Safety: if no buckets classified either side (e.g. an odd CSV
      // that only had AUX rows), still write to the active dept so the
      // import isn't a silent no-op.
      if (writes.length === 0) {
        writes.push({ dept: importDepartment, ordersBySize: parseResult.ordersBySize });
      }

      // eslint-disable-next-line no-console
      console.info("[shopify-import] writing", writes.length, "WeeklyEntry rows for", weekStart, writes.map((w) => w.dept));
      for (const w of writes) {
        const existing: WeeklyEntry | undefined = data?.entries?.find(
          (e) => e.iso_week_start === weekStart
              && (e.department ?? "framed") === w.dept,
        );
        const prevContribs: Record<string, number> = existing?.shopify_orders_by_size ?? {};
        const newContribs: Record<string, number> = { ...prevContribs };
        let total = existing?.total_orders ?? 0;
        for (const [size, n] of Object.entries(w.ordersBySize)) {
          const prev = prevContribs[size] ?? 0;
          total = total - prev + n;
          newContribs[size] = n;
        }
        const entry = WeeklyEntrySchema.parse({
          iso_week_start: weekStart,
          department: w.dept,
          name: existing?.name ?? "Shopify import",
          total_orders: Math.max(0, total),
          is_reference: existing?.is_reference ?? false,
          entered_at: new Date().toISOString(),
          entered_by: "shopify-import",
          shopify_orders_by_size: newContribs,
        });
        await m.upsertWeeklyEntry.mutateAsync(entry);
      }

      // ---- Per-SKU frames (idempotent: PK is product_id + week) --------
      // Compute the delta against any previously-recorded units_sold so the
      // inventory auto-adjust stays correct on re-import.
      const autoAdjust = data?.settings?.auto_adjust_inventory_on_sale ?? true;
      const inventoryDeltas: { product: Product; delta: number }[] = [];
      const framedSales = matched
        .filter((b) => b.product)
        .map((b) => {
          const prevSale = data?.sales.find(
            (s) => s.product_id === b.product!.id && s.iso_week_start === weekStart,
          );
          const oldUnits = prevSale?.units_sold ?? 0;
          const delta = b.frames - oldUnits;
          if (delta !== 0) inventoryDeltas.push({ product: b.product!, delta });
          return WeeklySalesSchema.parse({
            product_id: b.product!.id,
            iso_week_start: weekStart,
            units_sold: b.frames,
            entered_at: new Date().toISOString(),
            entered_by: "shopify-import",
          });
        });

      // AUX rows: per-SKU sales for hooks, free prints, etc.
      const auxSalesRows = auxMatched
        .filter((r: { product: Product | null }) => r.product != null)
        .map((r: { sku: string; quantity: number; product: Product | null }) => {
          const prevSale = data?.sales.find(
            (s) => s.product_id === r.product!.id && s.iso_week_start === weekStart,
          );
          const oldUnits = prevSale?.units_sold ?? 0;
          const delta = r.quantity - oldUnits;
          if (delta !== 0) inventoryDeltas.push({ product: r.product!, delta });
          return WeeklySalesSchema.parse({
            product_id: r.product!.id,
            iso_week_start: weekStart,
            units_sold: r.quantity,
            entered_at: new Date().toISOString(),
            entered_by: "shopify-import",
          });
        });

      const sales = [...framedSales, ...auxSalesRows];
      if (sales.length > 0) await m.bulkUpsertSales.mutateAsync(sales);

      // Auto-adjust inventory: atomic per-SKU delta inside Dexie. Avoids the
      // stale-snapshot races that would happen if we read on_hand from the
      // React state and wrote it back N times in parallel.
      if (autoAdjust) {
        for (const { product, delta } of inventoryDeltas) {
          // eslint-disable-next-line no-await-in-loop
          await m.adjustOnHand.mutateAsync({
            productId: product.id,
            delta,
            context: {
              reason: "sale",
              source_id: `shopify:${weekStart}:${product.id}`,
              parent_event_id: `shopify-import:${weekStart}`,
              note: `Shopify import — week ${weekStart}`,
            },
          });
        }
      }

      const sizes = Object.keys(parseResult.ordersBySize).sort().join(", ");
      setDoneMsg(
        `Imported ${sales.length} SKU row${sales.length === 1 ? "" : "s"} ` +
        `for week ${weekStart} (${sizes || "no sizes"})` +
        (unmatchedCount > 0
          ? ` · ${unmatchedCount} bucket${unmatchedCount === 1 ? "" : "s"} skipped — no SKU match`
          : "") +
        (parseResult.ignoredNegatives > 0
          ? ` · ${parseResult.ignoredNegatives} return${parseResult.ignoredNegatives === 1 ? "" : "s"} ignored`
          : ""),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Import Shopify weekly report">
      <div className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Pick the week this report covers, then confirm. Re-running the same file
          is safe — already-imported rows will be replaced, not added on top.
        </p>

        <Field label="Week starting (Monday)">
          <Input type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
        </Field>

        <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 p-3 space-y-2">
          <div className="text-sm">
            <strong>{parseResult.totalOrders}</strong> orders →{" "}
            <strong>{parseResult.totalFrames}</strong> frames ·{" "}
            <strong>{matchedCount}</strong> matched SKU{matchedCount === 1 ? "" : "s"}
            {unmatchedCount > 0 ? ` · ${unmatchedCount} unmatched` : ""}
            {parseResult.ignoredNegatives > 0
              ? ` · ${parseResult.ignoredNegatives} return(s) ignored`
              : ""}
          </div>
          <table className="w-full text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="text-left font-medium py-1">Size · Colour</th>
                <th className="text-right font-medium py-1">Orders</th>
                <th className="text-right font-medium py-1">Frames</th>
                <th className="text-left font-medium py-1 pl-2">SKU</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {matched.map((b) => (
                <tr
                  key={`${b.size}-${b.colour}`}
                  className={b.product ? "" : "text-amber-700 dark:text-amber-400"}
                >
                  <td className="py-1">{b.size} · {b.colour}</td>
                  <td className="py-1 text-right tabular-nums">{b.orders}</td>
                  <td className="py-1 text-right tabular-nums font-semibold">{b.frames}</td>
                  <td className="py-1 pl-2">{b.product ? b.product.code : "No SKU match — skipped"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {Object.keys(parseResult.ordersBySize).length > 0 ? (
            <div className="text-[11px] text-slate-500">
              Orders by size:{" "}
              {Object.entries(parseResult.ordersBySize)
                .sort()
                .map(([s, n]) => `${s}=${n}`)
                .join(", ")}
            </div>
          ) : null}
          {parseResult.unparsedRows.length > 0 ? (
            <div className="text-[11px] text-amber-700 dark:text-amber-400">
              {parseResult.unparsedRows.length} row{parseResult.unparsedRows.length === 1 ? "" : "s"}{" "}
              couldn't be parsed (no recognisable size or colour) — ignored.
            </div>
          ) : null}
        </div>

        {error ? <div className="text-sm text-red-600 dark:text-red-400">{error}</div> : null}
        {doneMsg ? <div className="text-sm text-emerald-700 dark:text-emerald-400">{doneMsg}</div> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button onClick={apply} disabled={busy || matchedCount === 0}>
            {busy ? "Importing…" : `Import ${matchedCount} SKUs`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
