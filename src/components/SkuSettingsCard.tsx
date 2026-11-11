import { useEffect, useMemo, useState } from "react";
import { Save, RotateCcw, AlertTriangle, Check } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Input";
import {
  ProductSchema,
  PRODUCT_TYPE_LABELS, PRODUCT_TYPE_HINTS,
  type Product, type ProductTypeKey,
} from "@/lib/domain";

/** Fill in any missing fields on older records so controlled inputs never see undefined. */
function withDefaults(p: Product): Product {
  return {
    ...p,
    safety_stock_pct: p.safety_stock_pct ?? 100,
    safety_stock_units: p.safety_stock_units ?? 0,
    short_code: p.short_code ?? null,
    weekly_avg_manual: p.weekly_avg_manual ?? null,
    target_weeks_of_cover_override: p.target_weeks_of_cover_override ?? 21,
    unit_cost: p.unit_cost ?? null,
    notes: p.notes ?? "",
    display_order: p.display_order ?? 0,
  };
}
import { useMutations } from "@/lib/hooks/useMutations";
import { useDataset } from "@/lib/hooks/useDataset";
import { computeWeeklyAverage } from "@/lib/forecasting/weeklyAverage";
import { fmtFloat } from "@/lib/utils/format";

/**
 * Inline-editable SKU settings card for the SKU detail page. Shows every
 * persisted property of a Product as an editable field; "Save" runs
 * ProductSchema.parse and writes through useMutations; "Reset" rolls the
 * draft back to the latest persisted values.
 *
 * Drop into the SKU detail page like:
 *   <SkuSettingsCard product={product} />
 */
export function SkuSettingsCard({ product }: { product: Product }) {
  const m = useMutations();
  const { data } = useDataset();
  // Backfill any fields that older IndexedDB records are missing so the form
  // never tries to render an undefined value into a controlled input.
  const [draft, setDraft] = useState<Product>(() => withDefaults(product));
  const [error, setError] = useState<string | null>(null);
  /**
   * Transient flag: true for ~1.4s after a successful save so we can flash
   * a "Saved" badge next to the button. Auto-clears via setTimeout — never
   * keeps the button locked.
   */
  const [justSaved, setJustSaved] = useState(false);

  /** Number the forecast engine is actually using for this SKU right now. */
  const computedWeeklyAvg = useMemo(() => {
    if (!data) return 0;
    return computeWeeklyAverage(product, data.sales, data.entries);
  }, [data, product]);

  /** How many weeks of recorded sales exist for this SKU (regardless of method). */
  const salesRowCount = useMemo(() => {
    if (!data) return 0;
    return data.sales.filter((s) => s.product_id === product.id).length;
  }, [data, product.id]);

  /**
   * Whether the engine is currently using the manual fallback because the
   * chosen method yielded 0 (no sales, no starred weeks, etc.). Surfaced as a
   * small badge so users know why the number doesn't match what they'd
   * expect for the trailing-8 (etc.) average.
   */
  const usingManualFallback =
    product.weekly_avg_method !== "manual" &&
    !!product.weekly_avg_manual &&
    product.weekly_avg_manual > 0 &&
    Math.abs(computedWeeklyAvg - product.weekly_avg_manual) < 0.001;

  /** Plain-English diagnosis of why the weekly avg might be 0. */
  const zeroReason = ((): string | null => {
    if (computedWeeklyAvg > 0) return null;
    if (product.weekly_avg_method === "manual") {
      return product.weekly_avg_manual && product.weekly_avg_manual > 0
        ? null
        : "Method is 'manual' but Manual weekly avg is blank or 0 — type a number above.";
    }
    if (product.weekly_avg_method === "selected_weeks") {
      const refs = data?.entries.filter((e) => e.is_reference).length ?? 0;
      if (refs === 0) return "Method is 'selected_weeks' but no weeks are starred ★, and no Manual weekly avg is set.";
      return "Sales for the starred reference weeks are 0 (or missing), and no Manual weekly avg is set.";
    }
    if (salesRowCount === 0) {
      return "No sales rows exist for this SKU, and no Manual weekly avg is set — type one in to seed the forecast.";
    }
    return "The most-recent weeks of sales are all 0 for this SKU, and no Manual weekly avg is set.";
  })();

  // Sync the draft whenever the upstream product changes (e.g. another tab
  // wrote, or the dataset reloaded after a mutation).
  useEffect(() => {
    setDraft(withDefaults(product));
    setError(null);
  }, [product]);

  const set = <K extends keyof Product>(k: K, v: Product[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const dirty = JSON.stringify(draft) !== JSON.stringify(product);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const parsed = ProductSchema.parse(draft);
      await m.upsertProduct.mutateAsync(parsed);
      // Flash a "Saved" badge for ~1.4s, then go back to the normal button.
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 1400);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Properties</CardTitle>
        <span className="text-xs text-slate-500">
          {dirty ? "Unsaved changes" : "Edit any field then Save"}
        </span>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* Live diagnostic — what the forecast engine is actually using */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/60 dark:bg-slate-900/40">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Weekly avg in use</div>
            <div className={
              computedWeeklyAvg > 0
                ? "text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100"
                : "text-lg font-bold tabular-nums text-amber-600 dark:text-amber-400"
            }>{fmtFloat(computedWeeklyAvg, 1)}</div>
            <div className="text-[10px] text-slate-500">
              units / week · drives the projection
              {usingManualFallback ? (
                <span className="ml-1 text-amber-600 dark:text-amber-400">· fallback to Manual</span>
              ) : null}
            </div>
          </div>
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/60 dark:bg-slate-900/40">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Method</div>
            <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{product.weekly_avg_method}</div>
            <div className="text-[10px] text-slate-500">change below to switch</div>
          </div>
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/60 dark:bg-slate-900/40">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Sales rows</div>
            <div className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{salesRowCount}</div>
            <div className="text-[10px] text-slate-500">weeks of history recorded</div>
          </div>
        </div>
        {zeroReason ? (
          <div className="flex items-start gap-2 rounded-md ring-1 ring-amber-200 dark:ring-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Forecast is flat — weekly average is 0</div>
              <div className="text-xs mt-0.5">{zeroReason}</div>
            </div>
          </div>
        ) : null}

        <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Code">
            <Input required value={draft.code} onChange={(e) => set("code", e.target.value)} />
          </Field>
          <Field label="Short code (optional)" hint="e.g. A0N. Auto-derived from size + colour if blank.">
            <Input value={draft.short_code ?? ""} onChange={(e) => set("short_code", e.target.value || null)} />
          </Field>
          <Field label="Supplier">
            <Input required value={draft.supplier} onChange={(e) => set("supplier", e.target.value)} />
          </Field>
          <Field label="Size">
            <Input value={draft.size} onChange={(e) => set("size", e.target.value)} placeholder="(optional)" />
          </Field>
          <Field label="Colour">
            <Input value={draft.colour} onChange={(e) => set("colour", e.target.value)} placeholder="(optional)" />
          </Field>
          <Field label="Lead time (days)">
            <Input type="number" min={1} value={draft.lead_time_days}
              onChange={(e) => set("lead_time_days", Number(e.target.value))} />
          </Field>
          <Field label="Current on hand">
            <Input type="number" min={0} value={draft.current_on_hand}
              onChange={(e) => set("current_on_hand", Number(e.target.value))} />
          </Field>
          <Field label="Safety stock %" hint="Drives Reorder threshold. 100% = 1 week of cover, 200% = 2 weeks. Critical fires earlier — when weeks-left is below this SKU's lead time.">
            <Input type="number" min={0} step="10" value={draft.safety_stock_pct}
              onChange={(e) => set("safety_stock_pct", Number(e.target.value))} />
          </Field>
          <Field label="Min order qty">
            <Input type="number" min={0} value={draft.min_order_qty}
              onChange={(e) => set("min_order_qty", Number(e.target.value))} />
          </Field>
          <Field label="Order increment">
            <Input type="number" min={1} value={draft.order_increment}
              onChange={(e) => set("order_increment", Number(e.target.value))} />
          </Field>
          <Field label="Pallet capacity (units)">
            <Input type="number" min={0} value={draft.pallet_capacity_units}
              onChange={(e) => set("pallet_capacity_units", Number(e.target.value))} />
          </Field>
          <Field label="Bay capacity (pallets)">
            <Input type="number" min={0} value={draft.bay_capacity_pallets}
              onChange={(e) => set("bay_capacity_pallets", Number(e.target.value))} />
          </Field>
          <Field label="Product type" hint={PRODUCT_TYPE_HINTS[(draft.product_type ?? "product") as ProductTypeKey]}>
            <Select value={draft.product_type ?? "product"}
              onChange={(e) => set("product_type", e.target.value as ProductTypeKey)}>
              {(Object.keys(PRODUCT_TYPE_LABELS) as ProductTypeKey[]).map((k) => (
                <option key={k} value={k}>{PRODUCT_TYPE_LABELS[k]}</option>
              ))}
            </Select>
          </Field>
          <Field label="Weekly avg method">
            <Select value={draft.weekly_avg_method}
              onChange={(e) => set("weekly_avg_method", e.target.value as Product["weekly_avg_method"])}>
              <option value="trailing_8">trailing_8</option>
              <option value="trailing_12">trailing_12</option>
              <option value="weighted">weighted</option>
              <option value="manual">manual</option>
              <option value="selected_weeks">selected_weeks</option>
            </Select>
          </Field>
          <Field label="Manual weekly avg" hint="Used when method = manual.">
            <Input type="number" min={0} step="0.1" value={draft.weekly_avg_manual ?? ""}
              onChange={(e) => set("weekly_avg_manual", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <Field label="Target weeks of cover" hint="Used by the Order builder's suggested qty (does not drive alerts).">
            <Input type="number" min={0} value={draft.target_weeks_of_cover_override ?? 21}
              onChange={(e) => set("target_weeks_of_cover_override", e.target.value === "" ? 21 : Number(e.target.value))} />
          </Field>
          <Field label="Unit cost">
            <Input type="number" step="0.01" min={0} value={draft.unit_cost ?? ""}
              onChange={(e) => set("unit_cost", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <Field label="Display order">
            <Input type="number" value={draft.display_order}
              onChange={(e) => set("display_order", Number(e.target.value))} />
          </Field>
          <Field label="Carton: units per box" hint="Leave blank if not shipped in cartons. Drives container CBM calc.">
            <Input type="number" min={1} value={draft.carton_units ?? ""}
              onChange={(e) => set("carton_units", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <Field label="Carton length (cm)">
            <Input type="number" min={0} step="0.1" value={draft.carton_length_cm ?? ""}
              onChange={(e) => set("carton_length_cm", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <Field label="Carton width (cm)">
            <Input type="number" min={0} step="0.1" value={draft.carton_width_cm ?? ""}
              onChange={(e) => set("carton_width_cm", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <Field label="Carton height (cm)">
            <Input type="number" min={0} step="0.1" value={draft.carton_height_cm ?? ""}
              onChange={(e) => set("carton_height_cm", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <Field label="Unit of sale">
            <Select value={draft.unit_of_sale}
              onChange={(e) => set("unit_of_sale", e.target.value as Product["unit_of_sale"])}>
              <option value="each">each</option>
              <option value="case">case</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <textarea
                value={draft.notes}
                onChange={(e) => set("notes", e.target.value)}
                rows={3}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm"
              />
            </Field>
          </div>

          {error ? (
            <div className="sm:col-span-2 text-sm text-red-600 dark:text-red-400">{error}</div>
          ) : null}

          <div className="sm:col-span-2 flex items-center justify-end gap-2 pt-1">
            {/* Brief "Saved" badge — auto-fades after 1.4s. */}
            {justSaved ? (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium
                bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200
                dark:bg-emerald-900/40 dark:text-emerald-300 dark:ring-emerald-800
                animate-pulse">
                <Check size={12} /> Saved
              </span>
            ) : null}
            <Button type="button" variant="secondary" onClick={() => { setDraft(withDefaults(product)); setError(null); }}
              disabled={!dirty}>
              <RotateCcw size={14} /> Reset
            </Button>
            {/* Save is enabled even when there are no pending edits — clicking
                with no diff is a harmless no-op write that re-confirms saved. */}
            <Button type="submit" disabled={m.upsertProduct.isPending}>
              <Save size={14} /> {m.upsertProduct.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
