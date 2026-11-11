import { useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Input";
import { useDataset } from "@/lib/hooks/useDataset";
import { useAppStore } from "@/lib/state/appStore";
import { useAuth } from "@/lib/auth/AuthProvider";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import {
  PRODUCTION_DEPARTMENT_LABELS,
  lineProductionDepartment,
  type Product,
} from "@/lib/domain";
import { cn } from "@/lib/utils/cn";

/**
 * Settings card for managing the two pieces of production reference data:
 *
 *   - Size effort scores       — multipliers for the size-weighted volume
 *                                metric. `volume = Σ (count × score)`.
 *
 *   - Per-SKU estimated times  — admin-seeded baseline used for the
 *                                est-vs-actual chip workers see on
 *                                Complete. After ~50 events per SKU the
 *                                system can auto-switch to rolling
 *                                medians (out of scope here).
 *
 * Owner/manager-only card. Hidden in Dexie mode (no Supabase tables
 * means there's nothing to write to).
 */
export function ProductionBenchmarksCard() {
  if (getBackendMode() !== "supabase") return null;
  return <ProductionBenchmarksCardInner />;
}

interface SizeEffortRow {
  size: string;
  effort_score: number;
}

interface BenchmarkRow {
  product_id: string;
  department: "a0_framed" | "framed" | "unframed" | "dispatch";
  estimated_minutes: number;
  source: "admin" | "rolling_median";
  sample_size: number;
}

function ProductionBenchmarksCardInner() {
  const { profile } = useAuth();
  const { data: dataset } = useDataset();
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const [efforts, setEfforts] = useState<SizeEffortRow[]>([]);
  const [benchmarks, setBenchmarks] = useState<Map<string, BenchmarkRow>>(new Map());
  const [department, setDepartment] = useState<"a0_framed" | "framed" | "unframed">("framed");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load both data sets on mount + when location changes.
  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [effRes, benRes] = await Promise.all([
        supabase.from("production_size_effort")
          .select("size, effort_score")
          .eq("location", location),
        supabase.from("production_benchmarks")
          .select("product_id, department, estimated_minutes, source, sample_size")
          .eq("location", location),
      ]);
      if (effRes.error) throw effRes.error;
      if (benRes.error) throw benRes.error;
      const efforts = (effRes.data ?? [])
        .map((r) => ({ size: r.size, effort_score: Number(r.effort_score) }))
        .sort((a, b) => a.size.localeCompare(b.size));
      setEfforts(efforts);
      const benchmarkMap = new Map<string, BenchmarkRow>();
      for (const r of benRes.data ?? []) {
        const key = `${r.product_id}__${r.department}`;
        benchmarkMap.set(key, {
          product_id: r.product_id,
          department: r.department as BenchmarkRow["department"],
          estimated_minutes: Number(r.estimated_minutes),
          source: r.source as BenchmarkRow["source"],
          sample_size: Number(r.sample_size ?? 0),
        });
      }
      setBenchmarks(benchmarkMap);
    } catch (e) {
      setError(`Couldn't load benchmarks: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  if (profile?.role !== "owner" && profile?.role !== "manager") return null;

  /** Save one size's effort score (insert or update). */
  const saveEffort = async (size: string, score: number) => {
    if (!Number.isFinite(score) || score <= 0) return;
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase
        .from("production_size_effort")
        .upsert({
          location,
          size,
          effort_score: score,
          updated_at: new Date().toISOString(),
        }, { onConflict: "location,size" });
      if (error) throw error;
      setEfforts((prev) => prev.map((r) => r.size === size ? { ...r, effort_score: score } : r));
    } catch (e) {
      setError(`Couldn't save effort score: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** Save one SKU's benchmark. Pass null to clear. */
  const saveBenchmark = async (
    product_id: string,
    dept: "a0_framed" | "framed" | "unframed",
    minutes: number | null,
  ) => {
    const key = `${product_id}__${dept}`;
    setBusy(true);
    setError(null);
    try {
      if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) {
        const { error } = await supabase
          .from("production_benchmarks")
          .delete()
          .eq("location", location)
          .eq("product_id", product_id)
          .eq("department", dept);
        if (error) throw error;
        setBenchmarks((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        return;
      }
      const { error } = await supabase
        .from("production_benchmarks")
        .upsert({
          location,
          product_id,
          department: dept,
          estimated_minutes: minutes,
          source: "admin",
          sample_size: 0,
          updated_at: new Date().toISOString(),
        }, { onConflict: "location,product_id,department" });
      if (error) throw error;
      setBenchmarks((prev) => {
        const next = new Map(prev);
        next.set(key, {
          product_id, department: dept,
          estimated_minutes: minutes, source: "admin", sample_size: 0,
        });
        return next;
      });
    } catch (e) {
      setError(`Couldn't save benchmark: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Products belonging to the chosen production department. Routed via
  // lineProductionDepartment (the same helper /production uses), so the
  // table here matches exactly what shows up at the bench.
  const deptProducts = useMemo(() => {
    if (!dataset) return [];
    return dataset.products
      .filter((p: Product) => lineProductionDepartment(p) === department)
      .slice()
      .sort((a: Product, b: Product) => a.code.localeCompare(b.code));
  }, [dataset, department]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Production Benchmarks</CardTitle>
        <span className="text-xs text-slate-500">
          Size-weighted volume scoring and per-SKU estimated-time targets used by the /production page.
        </span>
      </CardHeader>
      <CardBody className="space-y-5">
        {error ? (
          <div className="text-sm text-red-600 dark:text-red-400 rounded-md ring-1 ring-red-200 dark:ring-red-900/40 bg-red-50/40 dark:bg-red-900/10 px-3 py-2">
            {error}
          </div>
        ) : null}

        {/* ---- Size effort scores ---- */}
        <section>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400 mb-2">
            Size-weighted volume scores
          </div>
          <div className="text-[11px] text-slate-500 mb-2">
            How much each size "counts" for the volume KPI. An A0 frame is harder than an A4, so it weighs more.
            Default seed: A0=2.5, A1=1.5, A2=1.0, A3=0.7, A4=0.5.
          </div>
          {loading ? (
            <div className="text-sm text-slate-500">Loading…</div>
          ) : efforts.length === 0 ? (
            <div className="text-sm text-slate-500 italic">
              No sizes seeded for this location yet — re-run migration 0012 to seed defaults.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {efforts.map((row) => (
                <div key={row.size} className="inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 dark:ring-slate-700 px-2 py-1">
                  <span className="text-xs font-semibold uppercase w-7 tabular-nums">{row.size}</span>
                  <Input
                    type="number"
                    min={0.01}
                    step={0.05}
                    defaultValue={row.effort_score}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v > 0 && v !== row.effort_score) void saveEffort(row.size, v);
                    }}
                    className="h-7 w-20 text-sm text-right tabular-nums"
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ---- Per-SKU benchmarks ---- */}
        <section>
          <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                Per-SKU estimated time (minutes)
              </div>
              <div className="text-[11px] text-slate-500">
                Used as the est-vs-actual baseline workers see on each Complete. Leave blank for a SKU you don't have a number for yet.
              </div>
            </div>
            <Select
              value={department}
              onChange={(e) => setDepartment(e.target.value as typeof department)}
              className="h-8 text-sm w-44"
            >
              <option value="framed">{PRODUCTION_DEPARTMENT_LABELS.framed}</option>
              <option value="a0_framed">{PRODUCTION_DEPARTMENT_LABELS.a0_framed}</option>
              <option value="unframed">{PRODUCTION_DEPARTMENT_LABELS.unframed}</option>
            </Select>
          </div>

          {loading ? (
            <div className="text-sm text-slate-500">Loading…</div>
          ) : deptProducts.length === 0 ? (
            <div className="text-sm text-slate-500 italic px-3 py-2 rounded-md bg-slate-50/40 dark:bg-slate-900/30">
              No products route to the {PRODUCTION_DEPARTMENT_LABELS[department]} department at this location.
              Check Settings → SKUs and confirm suppliers are tagged correctly (CHINA for framed, UNFRAMED for prints).
            </div>
          ) : (
            <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">SKU</th>
                    <th className="text-left font-medium px-2 py-2">Colour</th>
                    <th className="text-left font-medium px-2 py-2">Size</th>
                    <th className="text-right font-medium px-2 py-2">Est. minutes</th>
                    <th className="text-left font-medium px-2 py-2">Source</th>
                    <th className="text-right font-medium px-2 py-2">Samples</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {deptProducts.map((p) => {
                    const key = `${p.id}__${department}`;
                    const benchmark = benchmarks.get(key);
                    return (
                      <tr key={p.id} className={cn(busy ? "opacity-60" : "")}>
                        <td className="px-3 py-1.5 font-mono text-xs">{p.code}</td>
                        <td className="px-2 py-1.5 text-xs text-slate-600 dark:text-slate-400">{p.colour ?? "—"}</td>
                        <td className="px-2 py-1.5 text-xs">{p.size ?? "—"}</td>
                        <td className="px-2 py-1.5 text-right">
                          <Input
                            type="number"
                            min={0.1}
                            step={0.5}
                            defaultValue={benchmark?.estimated_minutes ?? ""}
                            placeholder="—"
                            onBlur={(e) => {
                              const raw = e.target.value.trim();
                              if (raw === "") {
                                if (benchmark) void saveBenchmark(p.id, department, null);
                                return;
                              }
                              const v = Number(raw);
                              if (!Number.isFinite(v) || v <= 0) return;
                              if (v !== benchmark?.estimated_minutes) void saveBenchmark(p.id, department, v);
                            }}
                            className="h-7 w-20 text-sm text-right tabular-nums"
                          />
                        </td>
                        <td className="px-2 py-1.5 text-xs">
                          {benchmark ? (
                            <span className={cn(
                              "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide",
                              benchmark.source === "admin"
                                ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                                : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
                            )}>
                              {benchmark.source === "admin" ? "Admin" : "Rolling"}
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400 italic">unset</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-xs tabular-nums text-right text-slate-500">
                          {benchmark?.sample_size ?? 0}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </CardBody>
    </Card>
  );
}
