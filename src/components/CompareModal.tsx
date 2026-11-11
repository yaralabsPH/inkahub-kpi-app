import { useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { Modal } from "@/components/ui/Modal";
import { useDataset } from "@/lib/hooks/useDataset";
import { useAppStore, blanketForScenario } from "@/lib/state/appStore";
import { forecast } from "@/lib/forecasting";
import { fmtDayMonth, fmtFloat, fmtNum } from "@/lib/utils/format";
import { StatusPill } from "@/components/ui/StatusPill";

/** Overlay two SKUs' 52-week projections on one panel. */
export function CompareModal({
  a,
  b,
  onClose,
}: {
  a: string;
  b: string;
  onClose: () => void;
}) {
  const { data } = useDataset();
  const scenario = useAppStore((s) => s.scenario);
  const saved = useAppStore((s) => s.savedScenarios);

  const chart = useMemo(() => {
    if (!data) return null;
    const pa = data.products.find((p) => p.id === a);
    const pb = data.products.find((p) => p.id === b);
    if (!pa || !pb) return null;
    const opts = {
      useRestocks: true,
      useDemandChanges: true,
      blanketDemandMultiplier: blanketForScenario(scenario, saved),
      scenarioStart: data.settings.manual_scenario_start_date ?? undefined,
    };
    const ra = forecast({ product: pa, sales: data.sales, shipments: data.shipments, events: data.events, options: opts });
    const rb = forecast({ product: pb, sales: data.sales, shipments: data.shipments, events: data.events, options: opts });
    const series = ra.rows.map((row, i) => ({
      weekStart: row.weekStart,
      [pa.code]: Math.round(row.stockEnd),
      [pb.code]: Math.round(rb.rows[i]?.stockEnd ?? 0),
    }));
    return { pa, pb, ra, rb, series };
  }, [data, a, b, scenario, saved]);

  return (
    <Modal open={true} onClose={onClose} title="Compare SKUs" width="max-w-5xl">
      {!chart ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: chart.pa.code, r: chart.ra, p: chart.pa },
              { label: chart.pb.code, r: chart.rb, p: chart.pb },
            ].map(({ label, r, p }) => (
              <div
                key={label}
                className="rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">{label}</div>
                  <StatusPill status={r.status} />
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <Stat label="On hand" value={fmtNum(p.current_on_hand)} />
                  <Stat label="Avg/wk" value={fmtFloat(r.weeklyAverage, 1)} />
                  <Stat
                    label="Weeks left"
                    value={r.weeksUntilOosCurrent === null ? "52+" : String(r.weeksUntilOosCurrent)}
                  />
                  <Stat label="Target" value={fmtNum(r.targetStock)} />
                  <Stat label="Suggested" value={fmtNum(r.suggestedOrderQty)} />
                  <Stat label="Lead" value={`${p.lead_time_days}d`} />
                </div>
              </div>
            ))}
          </div>

          <div className="h-72">
            <ResponsiveContainer>
              <LineChart data={chart.series} margin={{ top: 12, right: 12, bottom: 8, left: 8 }}>
                <CartesianGrid stroke="rgb(148 163 184 / 0.2)" vertical={false} />
                <XAxis
                  dataKey="weekStart"
                  tickFormatter={fmtDayMonth}
                  interval={3}
                  tick={{ fontSize: 11, fill: "rgb(100 116 139)" }}
                />
                <YAxis tick={{ fontSize: 11, fill: "rgb(100 116 139)" }} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey={chart.pa.code} stroke="rgb(15 23 42)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey={chart.pb.code} stroke="rgb(59 130 246)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}
