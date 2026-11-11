import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDataset } from "@/lib/hooks/useDataset";
import { useMutations } from "@/lib/hooks/useMutations";
import { useRepo } from "@/lib/repository/RepositoryProvider";
import { useAppStore } from "@/lib/state/appStore";
import { DexieRepo } from "@/lib/repository/dexie/DexieRepo";
import { getDb, dbNameForLocation } from "@/lib/repository/dexie/db";
import { SupabaseRepo } from "@/lib/repository/supabase/SupabaseRepo";
import { getSupabase, isSupabaseConfigured } from "@/lib/repository/supabase/client";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { SupplierPaymentTermsCard } from "@/components/SupplierPaymentTermsCard";
import { ProductionBenchmarksCard } from "@/components/ProductionBenchmarksCard";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Input";
import { downloadJson, toCsv, downloadCsv } from "@/lib/csv/csv";
import { downloadXlsx } from "@/lib/csv/xlsx";
import { loadSampleData } from "@/lib/seed/seed";
import {
  BackupSchema, GlobalSettingsSchema, NAV_KEYS, DEFAULT_NAV_LABELS,
  LOCATIONS, LOCATION_LABELS, type NavKey, type Product, type Bay,
} from "@/lib/domain";
import { cn } from "@/lib/utils/cn";
import type { Repository } from "@/lib/repository/Repository";

export function Settings() {
  const { data } = useDataset();
  const repo = useRepo();
  const m = useMutations();
  const location = useAppStore((s) => s.location);
  const setLocation = useAppStore((s) => s.setLocation);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cartonMsg, setCartonMsg] = useState<string | null>(null);
  // Default to "China" so the Container Visualiser fill only touches
  // your China-sourced framed SKUs (which is what the spreadsheet
  // dimensions are spec'd for). Clear it to apply to every supplier.
  const [cartonSupplierFilter, setCartonSupplierFilter] = useState<string>("China");
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;
  const s = data.settings;

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-end justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Editing <strong>{LOCATION_LABELS[location]}</strong> · each location has its own settings.
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Locations</CardTitle>
          <span className="text-xs text-slate-500">
            Each location is its own isolated database — switching here is equivalent to switching the dropdown in the sidebar.
            <strong className="ml-1">All settings on this page (and every page) apply only to the currently-active location.</strong>
          </span>
        </CardHeader>
        <CardBody className="space-y-3">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
            {LOCATIONS.map((loc) => {
              const isActive = loc === location;
              return (
                <li
                  key={loc}
                  className={cn(
                    "flex items-center justify-between gap-3 px-3 py-2 text-sm",
                    isActive ? "bg-slate-50/80 dark:bg-slate-900/40" : "",
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-slate-900 dark:text-slate-100">{LOCATION_LABELS[loc]}</span>
                    <span className="text-[11px] uppercase tracking-wide text-slate-500">{loc}</span>
                    {isActive ? (
                      <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                        Active
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {!isActive ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === `copy-${loc}`}
                        onClick={async () => {
                          if (!window.confirm(
                            `Copy ALL data from "${LOCATION_LABELS[location]}" → "${LOCATION_LABELS[loc]}"?\n\n` +
                            `This REPLACES every product / sale / shipment / event / warehouse layout / setting in "${LOCATION_LABELS[loc]}" with a snapshot of the current active location.\n\n` +
                            `Cannot be undone.`,
                          )) return;
                          setBusy(`copy-${loc}`); setError(null); setCopyMsg(null);
                          try {
                            const backup = await repo.exportBackup();
                            const destRepo = new DexieRepo(getDb(loc));
                            await destRepo.importBackup(backup);
                            const counts = {
                              products: backup.products.length,
                              sales: backup.weekly_sales.length,
                              shipments: backup.incoming_shipments.length,
                            };
                            setCopyMsg(
                              `Copied ${counts.products} SKUs · ${counts.sales} sales rows · ${counts.shipments} shipments → ${LOCATION_LABELS[loc]}. Switch to that location to verify.`,
                            );
                          } catch (e) {
                            setError(`Copy failed: ${(e as Error).message}`);
                          } finally {
                            setBusy(null);
                          }
                        }}
                        title={`Replace ${LOCATION_LABELS[loc]}'s data with a copy of ${LOCATION_LABELS[location]}'s`}
                      >
                        {busy === `copy-${loc}` ? "Copying…" : "Copy active here"}
                      </Button>
                    ) : null}
                    <Button
                      variant={isActive ? "ghost" : "secondary"}
                      size="sm"
                      disabled={isActive}
                      onClick={() => {
                        // Reload after location swap — see Sidebar for why.
                        setLocation(loc);
                        window.location.reload();
                      }}
                      title={isActive ? "This location is already active" : `Switch to ${LOCATION_LABELS[loc]}`}
                    >
                      {isActive ? "Editing now" : "Switch to"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="text-[11px] text-slate-500">
            What's scoped per location: SKUs, sales history, weekly entries, shipments, demand events, warehouse layout, global defaults (sidebar labels, currency, working days, week-start day, scenario start, auto-adjust setting, saved order templates). What's <em>not</em> scoped per location: scenario selection in the top bar, sidebar collapsed state, theme — those are global to your browser.
          </div>
          <div className="text-[11px] text-slate-500">
            <strong>Copy active here</strong> takes a snapshot of the active location and replaces the target location's data with it (same as Export JSON → Import JSON, but one click). Useful for cloning a known-good catalogue into a new country.
          </div>
          {copyMsg ? <div className="text-sm text-emerald-700 dark:text-emerald-400">{copyMsg}</div> : null}
        </CardBody>
      </Card>


      <SupplierPaymentTermsCard />

      <ProductionBenchmarksCard />

      <CrossLocationDiagnostics />

      <DexieToSupabaseMigration />

      <Card>
        <CardHeader>
          <CardTitle>Global defaults</CardTitle>
          <span className="text-xs text-slate-500">
            Apply to the currently-active location ({LOCATION_LABELS[location]}). Reorder + Critical thresholds live on each SKU — set "Target weeks of cover" and "Safety %" on the SKU detail page.
          </span>
        </CardHeader>
        <CardBody className="grid grid-cols-2 gap-4">
          <Field label="Working days per week">
            <Input type="number" defaultValue={s.working_days_per_week} min={1} max={7}
              onBlur={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v) && v >= 1 && v <= 7) m.setSettings.mutate({ ...s, working_days_per_week: v }); }} />
          </Field>
          <Field label="Currency symbol">
            <Input defaultValue={s.currency_symbol} maxLength={4}
              onBlur={(e) => m.setSettings.mutate({ ...s, currency_symbol: e.target.value || "$" })} />
          </Field>
          <Field label="Container CBM" hint="Cubic-metre target for the order builder's container-fill widget. 67 = 40' high cube; 139 = two.">
            <Input type="number" min={1} step="0.1" defaultValue={s.container_cbm ?? 67}
              onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) m.setSettings.mutate({ ...s, container_cbm: v }); }} />
          </Field>
          <Field label="Theme">
            <Select value={s.theme} onChange={(e) => m.setSettings.mutate({ ...s, theme: e.target.value as "light" | "dark" | "system" })}>
              <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
            </Select>
          </Field>
          <Field label="Week starts on" hint="New entries snap to this day. Existing dates aren't changed.">
            <Select value={s.week_start_day} onChange={(e) => m.setSettings.mutate({ ...s, week_start_day: e.target.value as "sunday" | "monday" })}>
              <option value="monday">Monday (ISO)</option><option value="sunday">Sunday</option>
            </Select>
          </Field>
          <Field label="Auto-adjust inventory on sale" hint="When you enter sales numbers, deduct them from on-hand stock automatically.">
            <Select value={s.auto_adjust_inventory_on_sale ? "yes" : "no"} onChange={(e) => m.setSettings.mutate({ ...s, auto_adjust_inventory_on_sale: e.target.value === "yes" })}>
              <option value="yes">Yes — automatic</option><option value="no">No — adjust manually</option>
            </Select>
          </Field>
          <Field label="Auto-apply shipments on delivery" hint="When a shipment status moves to Delivered, credit each line's qty to that product's on-hand. Moving it out of Delivered reverses the credit.">
            <Select value={(s.auto_apply_shipments_on_delivery ?? true) ? "yes" : "no"} onChange={(e) => m.setSettings.mutate({ ...s, auto_apply_shipments_on_delivery: e.target.value === "yes" })}>
              <option value="yes">Yes — automatic</option><option value="no">No — adjust manually</option>
            </Select>
          </Field>
          <Field label="Scenario start" hint="Live = next Monday. Manual = pin to a fixed date.">
            <Select value={s.use_live_date ? "live" : "manual"} onChange={(e) => m.setSettings.mutate({ ...s, use_live_date: e.target.value === "live" })}>
              <option value="live">Live — next Monday</option><option value="manual">Manual — pin to date</option>
            </Select>
          </Field>
          {!s.use_live_date ? (
            <Field label="Manual scenario start date">
              <Input type="date" defaultValue={s.manual_scenario_start_date ?? ""} onBlur={(e) => m.setSettings.mutate({ ...s, manual_scenario_start_date: e.target.value || null })} />
            </Field>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Paper-roll inventory</CardTitle>
          <span className="text-xs text-slate-500">
            Map your existing paper-roll SKUs so the Paper-usage page can deduct rolls from stock when you save a snapshot.
            Leave either blank to skip auto-deduction for that width.
          </span>
        </CardHeader>
        <CardBody className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="24″ roll SKU (A1 heavyweight coated paper)" hint="Used for A1/A2/A3/A4 prints — Canon GP-2000.">
            <Select
              value={s.paper_roll_24_sku_id ?? ""}
              onChange={(e) => m.setSettings.mutate({ ...s, paper_roll_24_sku_id: e.target.value || null })}
            >
              <option value="">— not mapped —</option>
              {data.products
                .slice()
                .sort((a, b) => a.code.localeCompare(b.code))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · on hand: {p.current_on_hand}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="42″ roll SKU (A0 heavyweight coated paper)" hint="Used for A0 prints — Canon GP-4000.">
            <Select
              value={s.paper_roll_42_sku_id ?? ""}
              onChange={(e) => m.setSettings.mutate({ ...s, paper_roll_42_sku_id: e.target.value || null })}
            >
              <option value="">— not mapped —</option>
              {data.products
                .slice()
                .sort((a, b) => a.code.localeCompare(b.code))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · on hand: {p.current_on_hand}
                  </option>
                ))}
            </Select>
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Sidebar labels</CardTitle><span className="text-xs text-slate-500">Rename what shows on the left nav. Leave blank to use the default.</span></CardHeader>
        <CardBody className="grid grid-cols-2 gap-4">
          {NAV_KEYS.map((key: NavKey) => (
            <Field key={key} label={DEFAULT_NAV_LABELS[key]} hint={`Default: ${DEFAULT_NAV_LABELS[key]}`}>
              <Input defaultValue={s.nav_labels?.[key] ?? ""} placeholder={DEFAULT_NAV_LABELS[key]}
                onBlur={(e) => { const v = e.target.value.trim(); const next = { ...(s.nav_labels ?? {}) }; if (v === "") delete next[key]; else next[key] = v; m.setSettings.mutate({ ...s, nav_labels: next }); }} />
            </Field>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Backup</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">Export the current location as JSON. Import the same file later to restore.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy === "export"}
              onClick={async () => { setBusy("export"); setError(null); try { const b = await repo.exportBackup(); const d = new Date().toISOString().slice(0, 10); downloadJson(`inka-arthouse-${location}-${d}.json`, b); } catch (e) { setError(String(e)); } finally { setBusy(null); } }}>
              {busy === "export" ? "Exporting…" : "Export JSON backup"}
            </Button>
            <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy === "import"}>
              {busy === "import" ? "Importing…" : "Import JSON backup"}
            </Button>
            <input ref={fileRef} type="file" accept="application/json" className="hidden"
              onChange={async (ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; if (!f) return; setBusy("import"); setError(null); try { const t = await f.text(); const p = BackupSchema.parse(JSON.parse(t)); await m.importBackup.mutateAsync(p); } catch (e) { setError(`Import failed: ${(e as Error).message}`); } finally { setBusy(null); } }} />
          </div>
          {error ? <div className="text-sm text-red-600 dark:text-red-400">{error}</div> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Alerts</CardTitle><span className="text-xs text-slate-500">Critical / OOS / shipment-slipped notifications</span></CardHeader>
        <CardBody className="text-sm text-slate-600 dark:text-slate-400 space-y-2">
          <p>The bell in the top bar always shows live alerts derived from the current forecast. Email and webhook delivery are <strong>not connected</strong> — they're stub functions that log to the browser console. Wire them up in <code>src/lib/alerts/notifier.ts</code> when you've got a backend.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Carton dimensions</CardTitle><span className="text-xs text-slate-500">One-click bulk-fill from the Container Visualiser sheet</span></CardHeader>
        <CardBody className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Apply the carton dimensions below to every matching SKU. Match is by <strong>size + colour</strong> (Natural / Black / White) and, when a supplier filter is set, only SKUs whose <code>supplier</code> field contains that substring are touched. Once filled, the order builder uses these dimensions for its live container-fill CBM stat.
          </p>
          <table className="w-full text-xs">
            <thead className="text-slate-500"><tr>
              <th className="text-left font-medium py-1">Size</th>
              <th className="text-right font-medium py-1">Units / carton</th>
              <th className="text-right font-medium py-1">L × W × H (cm)</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(Object.keys(CARTON_DEFAULTS) as (keyof typeof CARTON_DEFAULTS)[]).map((sz) => {
                const c = CARTON_DEFAULTS[sz];
                return (<tr key={sz}>
                  <td className="py-1 font-medium">{sz}</td>
                  <td className="py-1 text-right tabular-nums">{c.units}</td>
                  <td className="py-1 text-right tabular-nums">{c.length} × {c.width} × {c.height}</td>
                </tr>);
              })}
            </tbody>
          </table>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Supplier filter" hint="Case-insensitive substring match on the SKU's supplier field. Leave blank to apply to every supplier.">
              <Input value={cartonSupplierFilter}
                onChange={(e) => setCartonSupplierFilter(e.target.value)}
                placeholder="China" className="w-48" />
            </Field>
            <Button size="sm" variant="secondary" disabled={busy === "carton-fill"}
              onClick={() => {
                const matched = data.products.filter((p) => matchesCartonRule(p, cartonSupplierFilter));
                const sample = matched.slice(0, 12).map((p) => p.code).join(", ");
                const more = matched.length > 12 ? `, +${matched.length - 12} more` : "";
                setCartonMsg(
                  matched.length === 0
                    ? `0 SKUs match. Check: (a) your supplier field actually contains "${cartonSupplierFilter}" (case doesn't matter, but substring must); (b) the size field is A0/A1/A2/A3/A4; (c) the SKU isn't flagged unframed.`
                    : `${matched.length} SKU${matched.length === 1 ? "" : "s"} would be touched: ${sample}${more}.`,
                );
              }}>
              Preview matches
            </Button>
            <Button size="sm" disabled={busy === "carton-fill"}
              onClick={async () => { setBusy("carton-fill"); setError(null); setCartonMsg(null); try { const n = await applyCartonDefaults(data.products, repo, false, cartonSupplierFilter); setCartonMsg(`Filled carton info on ${n} SKU${n === 1 ? "" : "s"}${cartonSupplierFilter ? ` matching supplier ~"${cartonSupplierFilter}"` : ""} (existing values left alone).`); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } }}>
              Apply to blanks only
            </Button>
            <Button size="sm" variant="secondary" disabled={busy === "carton-fill"}
              onClick={async () => { if (!window.confirm(`Overwrite carton info on every matching SKU${cartonSupplierFilter ? ` from supplier ~"${cartonSupplierFilter}"` : ""}?`)) return; setBusy("carton-fill"); setError(null); setCartonMsg(null); try { const n = await applyCartonDefaults(data.products, repo, true, cartonSupplierFilter); setCartonMsg(`Overwrote carton info on ${n} SKU${n === 1 ? "" : "s"}${cartonSupplierFilter ? ` matching supplier ~"${cartonSupplierFilter}"` : ""}.`); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } }}>
              Overwrite all matching
            </Button>
          </div>
          {cartonMsg ? <div className="text-sm text-emerald-700 dark:text-emerald-400 whitespace-pre-wrap">{cartonMsg}</div> : null}
        </CardBody>
      </Card>

      <WarehouseCapacityCard />

      <Card>
        <CardHeader>
          <CardTitle>Data cleanup</CardTitle>
          <span className="text-xs text-slate-500">Sweep stale weekly entries left over from earlier imports</span>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Deletes weekly entries with no <code>total_orders</code>, no name, no reference flag, and no
            attached sales rows. Reference weeks and any row with real data are left alone. Safe to re-run.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy === "purge-empty"}
              onClick={async () => {
                if (!window.confirm("Delete every weekly entry that has no orders, no name, no reference flag, and no sales attached?")) return;
                setBusy("purge-empty"); setError(null); setCleanupMsg(null);
                try {
                  const { deleted } = await repo.deleteEmptyWeeklyEntries();
                  setCleanupMsg(`Deleted ${deleted} empty row${deleted === 1 ? "" : "s"}.`);
                } catch (e) { setError((e as Error).message); }
                finally { setBusy(null); }
              }}>
              {busy === "purge-empty" ? "Purging…" : "Clear empty weekly rows"}
            </Button>
          </div>
          {cleanupMsg ? <div className="text-sm text-emerald-700 dark:text-emerald-400">{cleanupMsg}</div> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>CSV templates</CardTitle></CardHeader>
        <CardBody className="space-y-2">
          <p className="text-sm text-slate-600 dark:text-slate-400">Download a template, fill in your data, then import from the matching page.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => downloadCsv("skus-template.csv", SKU_TEMPLATE)}>SKUs template</Button>
            <Button variant="secondary" size="sm" onClick={() => downloadCsv("sales-template.csv", SALES_TEMPLATE)}>Sales template</Button>
            <Button variant="secondary" size="sm" onClick={() => downloadCsv("shipments-template.csv", SHIPMENTS_TEMPLATE)}>Shipments template</Button>
            <Button variant="secondary" size="sm" onClick={() => { const csv = toCsv(data.products, ["code","size","colour","supplier","lead_time_days","current_on_hand","safety_stock_pct","safety_stock_units","min_order_qty","order_increment","pallet_capacity_units","weekly_avg_method","weekly_avg_manual","unit_cost"]); downloadCsv("skus-export.csv", csv); }}>
              Export SKUs as CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { const headers = ["Code","Size","Colour","Supplier","Lead time (days)","On hand","Safety stock %","Safety stock (units, legacy)","Min order qty","Order increment","Pallet capacity","Weekly avg method","Manual weekly avg","Unit cost"]; const rows = data.products.map((p) => [p.code,p.size,p.colour,p.supplier,p.lead_time_days,p.current_on_hand,p.safety_stock_pct,p.safety_stock_units,p.min_order_qty,p.order_increment,p.pallet_capacity_units,p.weekly_avg_method,p.weekly_avg_manual ?? "",p.unit_cost ?? ""]); downloadXlsx("skus-export.xlsx", [{ name: "SKUs", headers, rows }]); }}>
              Export SKUs as Excel
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Danger zone</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <p className="text-sm text-slate-500">These actions affect the <strong>{LOCATION_LABELS[location]}</strong> location only.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy === "seed"}
              onClick={async () => { if (!window.confirm(`Reload sample data into ${LOCATION_LABELS[location]}? This wipes everything in this location.`)) return; setBusy("seed"); try { await loadSampleData(repo); m.setSettings.mutate({ ...GlobalSettingsSchema.parse({}) }); } finally { setBusy(null); } }}>
              Reload sample data
            </Button>
            <Button variant="danger" disabled={busy === "wipe"}
              onClick={async () => { if (!window.confirm(`Wipe everything in ${LOCATION_LABELS[location]}? This cannot be undone.`)) return; setBusy("wipe"); try { await m.wipe.mutateAsync(); } finally { setBusy(null); } }}>
              Wipe this location
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * Lightweight bay management. The full bay-layout panel was removed
 * (task #48) but the Warehouse page still needs `bays.length > 0` and a
 * `Σ max_pallets` total before the fullness score renders. This card
 * lets the user define total capacity as a simple count × pallets-per-bay
 * grid — no manual layout required.
 *
 * Generated bays are laid out into a roughly-square grid for the row /
 * column fields so anything that still reads those values gets sane
 * coordinates. The Warehouse fullness math only cares about
 * `Σ max_pallets`, so the layout is cosmetic.
 */
function WarehouseCapacityCard() {
  const { data } = useDataset();
  const m = useMutations();
  const existingBays = data?.storage.bays ?? [];
  const existingTotalCap = existingBays.reduce((a, b) => a + b.max_pallets, 0);
  // Sensible defaults: 2 pallets / bay (task #42) and a bay count that
  // covers the current need with a little headroom.
  const [bayCount, setBayCount] = useState<string>(String(existingBays.length || 100));
  const [palletsPerBay, setPalletsPerBay] = useState<string>(
    String(existingBays[0]?.max_pallets || 2),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const targetCount = Math.max(0, Math.floor(Number(bayCount) || 0));
  const targetPpb = Math.max(1, Math.floor(Number(palletsPerBay) || 0));
  const targetTotal = targetCount * targetPpb;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Warehouse capacity</CardTitle>
        <span className="text-xs text-slate-500">
          Defines the bay slots the Warehouse fullness gauge reads. Currently configured:{" "}
          <strong>{existingBays.length} bay{existingBays.length === 1 ? "" : "s"}</strong> ·{" "}
          <strong>{existingTotalCap} pallet slot{existingTotalCap === 1 ? "" : "s"}</strong>.
        </span>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Set how many bays you have and how many pallets fit in each. The Warehouse page's fullness score uses the total
          (<em>bays × pallets-per-bay</em>) as the denominator. Existing bays will be replaced.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <Field label="Number of bays">
            <Input type="number" min={0} step={1} value={bayCount}
              onChange={(e) => setBayCount(e.target.value)} />
          </Field>
          <Field label="Max pallets per bay" hint="Default 2 — matches the warehouse spec.">
            <Input type="number" min={1} step={1} value={palletsPerBay}
              onChange={(e) => setPalletsPerBay(e.target.value)} />
          </Field>
          <div className="text-sm">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Resulting total</div>
            <div className="text-2xl font-bold tabular-nums">{targetTotal.toLocaleString()}</div>
            <div className="text-[11px] text-slate-500">pallet slots</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || targetCount === 0}
            onClick={async () => {
              if (existingBays.length > 0 && !window.confirm(
                `Replace the current ${existingBays.length} bay${existingBays.length === 1 ? "" : "s"} with ${targetCount} bay${targetCount === 1 ? "" : "s"} × ${targetPpb} pallet${targetPpb === 1 ? "" : "s"} (= ${targetTotal} slots)? Existing pallet assignments will be cleared.`,
              )) return;
              setBusy(true); setMsg(null);
              try {
                // Lay out into a roughly-square grid so row/column have
                // sane values — purely cosmetic, the fullness math only
                // cares about Σ max_pallets.
                const cols = Math.max(1, Math.ceil(Math.sqrt(targetCount)));
                const bays: Bay[] = Array.from({ length: targetCount }, (_, i) => ({
                  id: `bay-${Date.now()}-${i + 1}`,
                  label: `B-${String(i + 1).padStart(3, "0")}`,
                  row: Math.floor(i / cols),
                  column: i % cols,
                  max_pallets: targetPpb,
                  type: "floor" as const,
                  notes: "",
                }));
                await m.setStorage.mutateAsync({ bays, palletAssignments: [] });
                setMsg(`Set up ${targetCount} bay${targetCount === 1 ? "" : "s"} × ${targetPpb} pallet${targetPpb === 1 ? "" : "s"} = ${targetTotal} slots.`);
              } catch (e) {
                setMsg(`Failed: ${(e as Error).message}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Applying…" : (existingBays.length > 0 ? "Replace bays" : "Create bays")}
          </Button>
          {existingBays.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm("Clear all bays? The Warehouse fullness gauge will go back to showing 0 capacity.")) return;
                setBusy(true); setMsg(null);
                try {
                  await m.setStorage.mutateAsync({ bays: [], palletAssignments: [] });
                  setMsg("All bays cleared.");
                } catch (e) {
                  setMsg(`Failed: ${(e as Error).message}`);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Clear all
            </Button>
          ) : null}
          {msg ? <span className="text-xs text-emerald-700 dark:text-emerald-400 self-center">{msg}</span> : null}
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * One-shot Dexie → Supabase data migration. Reads each location's Dexie
 * DB and pushes it into the matching Supabase location via the existing
 * import-backup machinery. The local Dexie data is NOT deleted — it
 * remains as an offline fallback for as long as it's useful.
 *
 * The card is hidden when Supabase isn't configured (no env vars set),
 * so Dexie-only users never see it. Once everyone is migrated and you've
 * verified counts via Cross-location Diagnostics, this card can stay
 * as a "re-sync" tool or be removed entirely.
 *
 * IMPORTANT: each migration WIPES the destination Supabase location
 * before importing — same semantics as Settings → Import JSON backup.
 * That makes the operation idempotent (re-run safe) but also dangerous
 * (don't overwrite live cloud data with a stale Dexie copy). Confirms
 * before running.
 */
function DexieToSupabaseMigration() {
  type LocStatus = {
    loc: typeof LOCATIONS[number];
    dexieCounts: { products: number; sales: number; shipments: number; ledger: number } | null;
    busy: boolean;
    result: string | null;
    error: string | null;
  };
  const [rows, setRows] = useState<LocStatus[]>(() =>
    LOCATIONS.map((loc) => ({ loc, dexieCounts: null, busy: false, result: null, error: null })),
  );
  const [supabaseAvailable] = useState<boolean>(() => {
    try { return isSupabaseConfigured(); } catch { return false; }
  });

  // On mount, count Dexie rows per location for the preview.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = [...rows];
      for (let i = 0; i < next.length; i++) {
        try {
          const repo = new DexieRepo(getDb(next[i].loc));
          // eslint-disable-next-line no-await-in-loop
          const [products, sales, shipments, ledger] = await Promise.all([
            repo.listProducts(),
            repo.listSales(),
            repo.listShipments(),
            repo.listLedger(),
          ]);
          if (cancelled) return;
          next[i] = {
            ...next[i],
            dexieCounts: {
              products: products.length,
              sales: sales.length,
              shipments: shipments.length,
              ledger: ledger.length,
            },
          };
        } catch (e) {
          if (cancelled) return;
          next[i] = { ...next[i], error: (e as Error).message };
        }
      }
      if (!cancelled) setRows(next);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const migrate = async (loc: typeof LOCATIONS[number]) => {
    const label = LOCATION_LABELS[loc];
    if (!window.confirm(
      `Migrate ${label} from local Dexie → cloud Supabase?\n\n` +
      `This WIPES the cloud copy of ${label} and replaces it with your local data. ` +
      `Re-run safe (idempotent), but don't run it AFTER your team has started using ` +
      `the cloud — you'd overwrite their changes.\n\n` +
      `Local Dexie data is preserved untouched.`,
    )) return;

    setRows((prev) => prev.map((r) =>
      r.loc === loc ? { ...r, busy: true, result: null, error: null } : r));

    try {
      const dexieRepo = new DexieRepo(getDb(loc));
      const supabaseRepo = new SupabaseRepo(getSupabase(), loc);
      const backup = await dexieRepo.exportBackup();
      await supabaseRepo.importBackup(backup);
      const summary =
        `${backup.products.length} SKUs · ` +
        `${backup.weekly_sales.length} sales · ` +
        `${backup.weekly_entries.length} weekly entries · ` +
        `${backup.incoming_shipments.length} shipments · ` +
        `${backup.demand_events.length} events · ` +
        `${backup.paper_usage.length} paper snapshots · ` +
        `${(backup.ledger ?? []).length} ledger rows`;
      setRows((prev) => prev.map((r) =>
        r.loc === loc ? { ...r, busy: false, result: summary, error: null } : r));
    } catch (e) {
      setRows((prev) => prev.map((r) =>
        r.loc === loc ? { ...r, busy: false, error: (e as Error).message } : r));
    }
  };

  if (!supabaseAvailable) {
    // Don't render the card if Supabase isn't set up — keeps Dexie-only
    // users from being confused.
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Migrate Dexie → Supabase</CardTitle>
        <span className="text-xs text-slate-500">
          One-shot copy from your local browser data to the cloud database. Run once per location after Supabase is set up.
          Local Dexie data is <strong>not</strong> deleted — it remains as an offline fallback.
        </span>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="text-xs rounded-md ring-1 ring-amber-200 dark:ring-amber-900/40 bg-amber-50/40 dark:bg-amber-900/10 px-3 py-2 text-amber-900 dark:text-amber-300">
          <strong>Heads-up:</strong> each migration WIPES the cloud copy of that location before importing. Only run after your team has stopped using the cloud copy of that location, or for a first-time setup against an empty cloud.
        </div>
        <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-3 py-2">Location</th>
                <th className="text-right font-medium px-2 py-2">SKUs</th>
                <th className="text-right font-medium px-2 py-2">Sales</th>
                <th className="text-right font-medium px-2 py-2">Shipments</th>
                <th className="text-right font-medium px-2 py-2">Ledger</th>
                <th className="text-right font-medium px-2 py-2 w-px">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((r) => (
                <tr key={r.loc}>
                  <td className="px-3 py-1.5">
                    <div className="font-medium">{LOCATION_LABELS[r.loc]}</div>
                    {r.result ? (
                      <div className="text-[10px] text-emerald-700 dark:text-emerald-400 mt-0.5">Migrated: {r.result}</div>
                    ) : r.error ? (
                      <div className="text-[10px] text-red-600 dark:text-red-400 mt-0.5">{r.error}</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.dexieCounts?.products ?? "…"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.dexieCounts?.sales ?? "…"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.dexieCounts?.shipments ?? "…"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.dexieCounts?.ledger ?? "…"}</td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={r.busy || r.dexieCounts === null || r.dexieCounts.products === 0}
                      onClick={() => void migrate(r.loc)}
                    >
                      {r.busy ? "Migrating…" : "Migrate"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="text-[11px] text-slate-500">
          After migrating, switch to the cloud-mode app and verify in <strong>Cross-location diagnostics</strong> (cloud-mode opens the Supabase tables instead of Dexie) that counts match.
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Open any IndexedDB by name and count rows in each named object store
 * without going through Dexie. We don't know the orphan DB's schema
 * version, so we open with no version (reads current version) and
 * iterate `objectStoreNames` defensively.
 */
async function countRawDbTables(
  dbName: string,
  storeNames: readonly string[],
): Promise<Record<string, number | null>> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
    req.onsuccess = () => {
      const db = req.result;
      const out: Record<string, number | null> = {};
      const present = storeNames.filter((s) => db.objectStoreNames.contains(s));
      if (present.length === 0) {
        for (const s of storeNames) out[s] = null;
        db.close();
        resolve(out);
        return;
      }
      const tx = db.transaction(present, "readonly");
      let remaining = present.length;
      for (const s of present) {
        const cr = tx.objectStore(s).count();
        cr.onsuccess = () => {
          out[s] = cr.result;
          remaining -= 1;
          if (remaining === 0) {
            db.close();
            for (const name of storeNames) if (!(name in out)) out[name] = null;
            resolve(out);
          }
        };
        cr.onerror = () => {
          out[s] = null;
          remaining -= 1;
          if (remaining === 0) {
            db.close();
            for (const name of storeNames) if (!(name in out)) out[name] = null;
            resolve(out);
          }
        };
      }
      tx.onerror = () => reject(tx.error ?? new Error("count tx failed"));
    };
  });
}

/**
 * Read every row from each named object store of a raw IndexedDB. Used
 * by the orphan-recovery flow to migrate data back into a known location
 * without needing the Dexie wrapper for the unknown-version source DB.
 */
async function readRawDbTables(
  dbName: string,
  storeNames: readonly string[],
): Promise<Record<string, unknown[]>> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
    req.onsuccess = () => {
      const db = req.result;
      const out: Record<string, unknown[]> = {};
      const present = storeNames.filter((s) => db.objectStoreNames.contains(s));
      if (present.length === 0) {
        for (const s of storeNames) out[s] = [];
        db.close();
        resolve(out);
        return;
      }
      const tx = db.transaction(present, "readonly");
      let remaining = present.length;
      for (const s of present) {
        const gr = tx.objectStore(s).getAll();
        gr.onsuccess = () => {
          out[s] = (gr.result as unknown[]) ?? [];
          remaining -= 1;
          if (remaining === 0) {
            db.close();
            for (const name of storeNames) if (!(name in out)) out[name] = [];
            resolve(out);
          }
        };
        gr.onerror = () => {
          out[s] = [];
          remaining -= 1;
          if (remaining === 0) {
            db.close();
            for (const name of storeNames) if (!(name in out)) out[name] = [];
            resolve(out);
          }
        };
      }
      tx.onerror = () => reject(tx.error ?? new Error("read tx failed"));
    };
  });
}

/**
 * Reads every location's IndexedDB directly and shows real on-disk counts.
 * Bypasses the React Query cache and the active repo entirely — this is
 * the source of truth for "where does my data actually live". Use it when
 * the active page seems to be showing the wrong location's data, or when
 * counts feel off.
 */
function CrossLocationDiagnostics() {
  type Row = {
    loc: typeof LOCATIONS[number] | null;  // null = orphan DB not in current LOCATIONS list
    dbName: string;
    products: number | null;
    sales: number | null;
    shipments: number | null;
    paperUsage: number | null;
    ledger: number | null;
    error: string | null;
    isOrphan: boolean;
  };
  const qc = useQueryClient();
  const setLocation = useAppStore((s) => s.setLocation);
  const activeLoc = useAppStore((s) => s.location);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const scan = async () => {
    setBusy(true); setHint(null);
    try {
      // 1) Read all known-location DBs.
      const knownDbNames = new Set(LOCATIONS.map((l) => dbNameForLocation(l)));
      const out: Row[] = [];
      for (const loc of LOCATIONS) {
        const dbName = dbNameForLocation(loc);
        try {
          const repo = new DexieRepo(getDb(loc));
          // eslint-disable-next-line no-await-in-loop
          const [products, sales, shipments, paperUsage, ledger] = await Promise.all([
            repo.listProducts(),
            repo.listSales(),
            repo.listShipments(),
            repo.listPaperUsage(),
            repo.listLedger(),
          ]);
          out.push({
            loc, dbName,
            products: products.length,
            sales: sales.length,
            shipments: shipments.length,
            paperUsage: paperUsage.length,
            ledger: ledger.length,
            error: null,
            isOrphan: false,
          });
        } catch (e) {
          out.push({
            loc, dbName,
            products: null, sales: null, shipments: null, paperUsage: null, ledger: null,
            error: (e as Error).message,
            isOrphan: false,
          });
        }
      }

      // 2) Discover orphan IndexedDB databases: any DB starting with
      //    "inkaar-stock" that isn't one of the known locations. These
      //    are usually leftovers from the rename / revert migrations
      //    (e.g. "inkaar-stock-australia" from task #83).
      //
      //    indexedDB.databases() is supported in modern Chromium / Firefox.
      //    Safari pre-17 doesn't have it, so we degrade gracefully.
      if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
        try {
          const all = await indexedDB.databases();
          for (const info of all) {
            const name = info.name;
            if (!name || !name.startsWith("inkaar-stock")) continue;
            if (knownDbNames.has(name)) continue;
            // Read this orphan DB raw via a vanilla indexedDB.open — we
            // can't use Dexie because we don't know the schema version.
            // We just count rows in each well-known table if it exists.
            try {
              // eslint-disable-next-line no-await-in-loop
              const counts = await countRawDbTables(name, ["products", "weeklySales", "shipments", "paperUsage", "ledger"]);
              out.push({
                loc: null,
                dbName: name,
                products: counts.products,
                sales: counts.weeklySales,
                shipments: counts.shipments,
                paperUsage: counts.paperUsage,
                ledger: counts.ledger,
                error: null,
                isOrphan: true,
              });
            } catch (e) {
              out.push({
                loc: null, dbName: name,
                products: null, sales: null, shipments: null, paperUsage: null, ledger: null,
                error: (e as Error).message,
                isOrphan: true,
              });
            }
          }
        } catch (e) {
          setHint(`Couldn't enumerate IndexedDB databases (${(e as Error).message}). Orphan DB detection unavailable in this browser.`);
        }
      } else {
        setHint("This browser doesn't support indexedDB.databases() — orphan DB detection unavailable.");
      }

      setRows(out);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Recover SKUs from an orphan IndexedDB into the active location's repo.
   * Non-destructive: skips any SKU whose `code` already exists in the
   * destination. Returns counts so the user knows what happened.
   */
  const recoverFromOrphan = async (sourceDbName: string): Promise<{ added: number; skipped: number; salesAdded: number; shipmentsAdded: number; paperAdded: number }> => {
    const sourceRows = await readRawDbTables(sourceDbName, ["products", "weeklySales", "shipments", "paperUsage"]);
    const destRepo = new DexieRepo(getDb(activeLoc));
    const existing = await destRepo.listProducts();
    const existingByCode = new Map(existing.map((p) => [p.code, p]));
    const existingById = new Map(existing.map((p) => [p.id, p]));

    let added = 0; let skipped = 0; let salesAdded = 0; let shipmentsAdded = 0; let paperAdded = 0;
    // Products
    const oldToNewId = new Map<string, string>();
    for (const raw of (sourceRows.products ?? [])) {
      const p = raw as { id: string; code: string; [k: string]: unknown };
      if (existingByCode.has(p.code)) {
        // Map old id → existing destination id so child rows still link.
        oldToNewId.set(p.id, existingByCode.get(p.code)!.id);
        skipped += 1;
        continue;
      }
      // Reuse old id if it's not taken; otherwise generate a fresh one.
      const newId = existingById.has(p.id) ? `${p.id}__rec-${Date.now()}` : p.id;
      oldToNewId.set(p.id, newId);
      await destRepo.upsertProduct({ ...(p as Record<string, unknown>), id: newId } as never);
      added += 1;
    }
    // Sales (remap product_id)
    const existingSales = await destRepo.listSales();
    const existingSalesKey = new Set(existingSales.map((s) => `${s.product_id}__${s.iso_week_start}`));
    for (const raw of (sourceRows.weeklySales ?? [])) {
      const s = raw as { product_id: string; iso_week_start: string; [k: string]: unknown };
      const newPid = oldToNewId.get(s.product_id) ?? s.product_id;
      const key = `${newPid}__${s.iso_week_start}`;
      if (existingSalesKey.has(key)) continue;
      await destRepo.upsertSale({ ...(s as Record<string, unknown>), product_id: newPid } as never);
      salesAdded += 1;
    }
    // Shipments (remap line product_ids)
    const existingShipments = await destRepo.listShipments();
    const existingShipmentIds = new Set(existingShipments.map((sh) => sh.id));
    for (const raw of (sourceRows.shipments ?? [])) {
      const sh = raw as { id: string; lines?: { product_id: string; quantity: number }[]; product_id?: string; quantity?: number; [k: string]: unknown };
      if (existingShipmentIds.has(sh.id)) continue;
      const lines = Array.isArray(sh.lines)
        ? sh.lines.map((l) => ({ ...l, product_id: oldToNewId.get(l.product_id) ?? l.product_id }))
        : sh.product_id && sh.quantity
          ? [{ product_id: oldToNewId.get(sh.product_id) ?? sh.product_id, quantity: sh.quantity }]
          : [];
      await destRepo.upsertShipment({ ...(sh as Record<string, unknown>), lines } as never);
      shipmentsAdded += 1;
    }
    // Paper usage snapshots (keyed by iso_week_start)
    const existingPaper = await destRepo.listPaperUsage();
    const existingPaperKeys = new Set(existingPaper.map((e) => e.iso_week_start));
    for (const raw of (sourceRows.paperUsage ?? [])) {
      const e = raw as { iso_week_start: string; [k: string]: unknown };
      if (existingPaperKeys.has(e.iso_week_start)) continue;
      await destRepo.upsertPaperUsage(e as never);
      paperAdded += 1;
    }
    return { added, skipped, salesAdded, shipmentsAdded, paperAdded };
  };

  // Auto-scan on first render so the user sees real counts immediately.
  useEffect(() => { void scan(); }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cross-location diagnostics</CardTitle>
        <span className="text-xs text-slate-500">
          Reads every location's IndexedDB directly (bypasses React Query cache). Use this to verify where your data physically lives.
        </span>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-3 py-2">Location</th>
                <th className="text-left font-medium px-3 py-2">IndexedDB name</th>
                <th className="text-right font-medium px-2 py-2">SKUs</th>
                <th className="text-right font-medium px-2 py-2">Sales rows</th>
                <th className="text-right font-medium px-2 py-2">Shipments</th>
                <th className="text-right font-medium px-2 py-2">Paper snaps</th>
                <th className="text-right font-medium px-2 py-2" title="Inventory ledger rows — appends on every stock movement">Ledger</th>
                <th className="text-right font-medium px-2 py-2 w-px">Switch</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-3 text-slate-500 text-sm">{busy ? "Scanning…" : "Click Scan to read disk counts."}</td></tr>
              ) : null}
              {rows.map((r) => {
                const isActive = r.loc !== null && r.loc === activeLoc;
                const rowKey = r.loc ?? r.dbName;
                return (
                  <tr key={rowKey} className={cn(
                    isActive ? "bg-emerald-50/40 dark:bg-emerald-900/10" : "",
                    r.isOrphan ? "bg-amber-50/40 dark:bg-amber-900/10" : "",
                  )}>
                    <td className="px-3 py-1.5">
                      {r.isOrphan ? (
                        <>
                          <div className="font-medium text-amber-700 dark:text-amber-400">Orphan DB</div>
                          <div className="text-[10px] uppercase tracking-wide font-semibold text-amber-600 dark:text-amber-400">Not in current locations</div>
                        </>
                      ) : (
                        <>
                          <div className="font-medium">{r.loc ? LOCATION_LABELS[r.loc] : r.dbName}</div>
                          {isActive ? <div className="text-[10px] uppercase tracking-wide font-semibold text-emerald-700 dark:text-emerald-400">Active</div> : null}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-slate-500 tabular-nums">{r.dbName}</td>
                    <td className={cn("px-2 py-1.5 text-right tabular-nums", (r.products ?? 0) > 0 ? "font-semibold" : "text-slate-400")}>{r.error ? "—" : (r.products ?? "—")}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.error ? "—" : (r.sales ?? "—")}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.error ? "—" : (r.shipments ?? "—")}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.error ? "—" : (r.paperUsage ?? "—")}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.error ? "—" : (r.ledger ?? "—")}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      {r.isOrphan ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={async () => {
                            if (!window.confirm(
                              `Recover data from "${r.dbName}" into the active location (${LOCATION_LABELS[activeLoc]})?\n\n` +
                              `This adds any missing SKUs (matched by code) plus their sales / shipments / paper snapshots. ` +
                              `Nothing in the active location will be overwritten or deleted.\n\n` +
                              `The orphan DB is left untouched — you can delete it from DevTools → Application → IndexedDB once you've verified the recovery.`
                            )) return;
                            setBusy(true); setHint(null);
                            try {
                              const r2 = await recoverFromOrphan(r.dbName);
                              setHint(
                                `Recovered ${r2.added} SKU${r2.added === 1 ? "" : "s"} ` +
                                `(skipped ${r2.skipped} dup${r2.skipped === 1 ? "" : "s"}) · ` +
                                `${r2.salesAdded} sales · ${r2.shipmentsAdded} shipments · ${r2.paperAdded} paper snapshot${r2.paperAdded === 1 ? "" : "s"} ` +
                                `into ${LOCATION_LABELS[activeLoc]}. Re-scan to verify, then reload to see the new data.`
                              );
                              await scan();
                            } catch (e) {
                              setHint(`Recovery failed: ${(e as Error).message}`);
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Recover → {LOCATION_LABELS[activeLoc]}
                        </Button>
                      ) : !isActive ? (
                        <Button size="sm" variant="ghost" onClick={() => {
                          if (r.loc) {
                            setLocation(r.loc);
                            window.location.reload();
                          }
                        }}>Switch</Button>
                      ) : <span className="text-[10px] text-slate-400">—</span>}
                    </td>
                  </tr>
                );
              })}
              {rows.some((r) => r.error) ? (
                <tr><td colSpan={8} className="px-3 py-2 text-xs text-red-600 dark:text-red-400">
                  {rows.filter((r) => r.error).map((r) => `${r.loc ? LOCATION_LABELS[r.loc] : r.dbName}: ${r.error}`).join(" · ")}
                </td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void scan()}>
            {busy ? "Scanning…" : "Re-scan disk"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              // Nuke the entire React Query cache and force a refetch on the
              // active query. Useful when the displayed data feels stale
              // after a manual IndexedDB tweak.
              qc.clear();
              await qc.refetchQueries();
              setHint("React Query cache cleared and refetched.");
            }}
          >
            Reset query cache
          </Button>
          <span className="text-[11px] text-slate-500">
            Tip: open DevTools → Application → IndexedDB to inspect raw rows in any of these DBs.
          </span>
          {hint ? <span className="text-xs text-emerald-700 dark:text-emerald-400 ml-auto">{hint}</span> : null}
        </div>
      </CardBody>
    </Card>
  );
}

const SKU_TEMPLATE =
  "code,size,colour,supplier,lead_time_days,current_on_hand,safety_stock_pct,min_order_qty,order_increment,pallet_capacity_units,weekly_avg_method,weekly_avg_manual,unit_cost\n" +
  "A0-Natural,A0,Natural,ACME,28,500,200,100,25,40,trailing_8,,9";

const SALES_TEMPLATE =
  "sku_code,iso_week_start,units_sold\n" +
  "A0-Natural,2026-04-27,42";

const SHIPMENTS_TEMPLATE =
  "po_number,supplier,sku_code,quantity,order_placed_date,expected_arrival_date,status\n" +
  "PO-2026-0001,ACME,A0-Natural,500,2026-04-29,2026-05-27,Ordered";

// Carton defaults pulled from the Container Visualiser. Outer dimensions are
// the same across colours within a size — colours map across Natural / Black
// / White (and "Natural Timber" → Natural).
const CARTON_DEFAULTS = {
  A0: { units: 4, length: 127, width: 19.5, height: 91.5 },
  A1: { units: 4, length: 91.5, width: 20, height: 66.5 },
  A2: { units: 6, length: 67.5, width: 28.5, height: 49.5 },
  A3: { units: 8, length: 49, width: 32.5, height: 38 },
  A4: { units: 10, length: 40.5, width: 37, height: 29 },
} as const;

/**
 * Decide whether a given SKU is eligible for a carton-defaults write
 * under the current supplier filter. Splits the predicate out so the UI
 * can preview matches without doing the write.
 *
 * Matching:
 *   1. Supplier substring (case-insensitive) — if a filter is set.
 *   2. Size normalises to one of A0/A1/A2/A3/A4 (case + whitespace tolerant).
 *   3. SKU is NOT an unframed variant (codes ending `U`/`P`, or code/colour
 *      containing "unframed" / "print"). Carton dims here are for framed
 *      products; unframed prints ship rolled and don't share these crates.
 *
 * The previous version also required the colour to contain "natural" /
 * "black" / "white", which excluded perfectly valid framed SKUs in other
 * finishes (walnut, oak, brushed silver, etc). Carton dims are size-
 * driven not colour-driven in the Container Visualiser, so the colour
 * check is gone.
 */
function matchesCartonRule(p: Product, supplierFilter: string): boolean {
  const supplierNeedle = supplierFilter.trim().toLowerCase();
  if (supplierNeedle && !(p.supplier ?? "").toLowerCase().includes(supplierNeedle)) return false;
  const sz = (p.size ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!(sz in CARTON_DEFAULTS)) return false;
  const sc = (p.short_code ?? "").toLowerCase();
  const haystack = `${p.code} ${p.colour}`.toLowerCase();
  const isUnframed = sc.endsWith("u") || sc.endsWith("p") || /unframed|print/.test(haystack);
  if (isUnframed) return false;
  return true;
}

/**
 * Walk every product, look up `(size)` in CARTON_DEFAULTS, and apply
 * matching carton info. With `overwrite=false`, only fills currently-null
 * fields. With a non-empty `supplierFilter`, only SKUs whose `supplier`
 * field contains that substring (case-insensitive) are touched. Returns
 * the count of SKUs actually written.
 */
async function applyCartonDefaults(
  products: Product[],
  repo: Repository,
  overwrite: boolean,
  supplierFilter: string = "",
): Promise<number> {
  let count = 0;
  for (const p of products) {
    if (!matchesCartonRule(p, supplierFilter)) continue;
    const sz = (p.size ?? "").trim().toUpperCase().replace(/\s+/g, "");
    // Loose record cast — each entry's literal types differ (different
    // dimensions), but they're structurally compatible for our purposes.
    const def = (CARTON_DEFAULTS as unknown as Record<string, { units: number; length: number; width: number; height: number }>)[sz];
    if (!def) continue;

    const next: Product = { ...p };
    let changed = false;
    if (overwrite || next.carton_units == null) { if (next.carton_units !== def.units) { next.carton_units = def.units; changed = true; } }
    if (overwrite || next.carton_length_cm == null) { if (next.carton_length_cm !== def.length) { next.carton_length_cm = def.length; changed = true; } }
    if (overwrite || next.carton_width_cm == null) { if (next.carton_width_cm !== def.width) { next.carton_width_cm = def.width; changed = true; } }
    if (overwrite || next.carton_height_cm == null) { if (next.carton_height_cm !== def.height) { next.carton_height_cm = def.height; changed = true; } }
    if (!changed) continue;
    // eslint-disable-next-line no-await-in-loop
    await repo.upsertProduct(next);
    count += 1;
  }
  return count;
}


