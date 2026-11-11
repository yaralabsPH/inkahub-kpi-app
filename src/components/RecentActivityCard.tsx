import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity, AlertOctagon, AlertTriangle, FileWarning, ShoppingCart, Truck, Wrench,
} from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { useAppStore } from "@/lib/state/appStore";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { fmtMoney, fmtNum } from "@/lib/utils/format";
import { PRODUCTION_DEPARTMENT_LABELS, type ProductionDepartment } from "@/lib/domain";

/**
 * Recent activity card - dashboard widget surfacing the headline ops
 * metrics that the team actually wants to see daily.
 *
 * Data freshness:
 *   - production_events (last 7d) - direct Supabase fetch on mount
 *   - ledger (last 7d) - direct Supabase fetch on mount
 *   - shipments + products - from useDataset (cached)
 *   - shipment_accounts - passed in from Dashboard (already fetched there)
 */

interface ProductionEventRow {
  order_number: string;
  department: ProductionDepartment;
  line_quantity: number | null;
  event_type: string;
  created_at: string;
}

interface LedgerRow {
  product_id: string;
  delta: number;
  ts: string;
}

export interface AccountsRowMinimal {
  shipment_id: string;
  payment_status: string;
  invoice_amount: number | null;
}

export function RecentActivityCard({
  accountsList,
}: {
  accountsList: AccountsRowMinimal[];
}) {
  const { data } = useDataset();
  const auth = useAuthOptional();
  const isOwner = auth?.profile?.role === "owner";
  const isSupabase = getBackendMode() === "supabase";
  const location = useAppStore((st) => st.location);

  const [prodEvents, setProdEvents] = useState<ProductionEventRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);

  useEffect(() => {
    if (!isSupabase) { setProdEvents([]); setLedger([]); return; }
    let cancelled = false;
    const supabase = getSupabase();
    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    (async () => {
      const { data: rows, error } = await supabase
        .from("production_events")
        .select("order_number, department, line_quantity, event_type, created_at")
        .eq("location", location)
        .gte("created_at", since7);
      if (cancelled) return;
      if (error) { console.error("production_events fetch", error); return; }
      setProdEvents((rows ?? []) as ProductionEventRow[]);
    })();
    (async () => {
      const { data: rows, error } = await supabase
        .from("ledger")
        .select("product_id, delta, ts")
        .eq("location", location)
        .gte("ts", since7);
      if (cancelled) return;
      if (error) { console.error("ledger fetch", error); return; }
      setLedger((rows ?? []) as LedgerRow[]);
    })();
    return () => { cancelled = true; };
  }, [isSupabase, location]);

  // ----- Stat #1: Orders shipped (last 7d) -----
  const dispatchedOrders = useMemo(
    () => new Set(prodEvents.filter((e) => e.event_type === "dispatched").map((e) => e.order_number)),
    [prodEvents],
  );
  const completedInRange = useMemo(
    () => prodEvents.filter((e) => e.event_type === "completed"),
    [prodEvents],
  );
  const shippedItems = useMemo(
    () => completedInRange
      .filter((e) => dispatchedOrders.has(e.order_number))
      .reduce((s, e) => s + (e.line_quantity ?? 0), 0),
    [completedInRange, dispatchedOrders],
  );

  // ----- Stat #2: New POs placed this calendar month -----
  const monthInfo = useMemo(() => {
    if (!data) return { count: 0, value: 0, label: "" };
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth();
    const monthStartIso = `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const productById = new Map(data.products.map((p) => [p.id, p]));
    const monthShipments = data.shipments.filter(
      (sh) => sh.order_placed_date && sh.order_placed_date >= monthStartIso,
    );
    const value = monthShipments.reduce((sum, sh) => {
      const lines = sh.lines ?? [];
      return sum + lines.reduce((ls, l) => {
        const p = productById.get(l.product_id);
        return ls + l.quantity * (p?.unit_cost ?? 0);
      }, 0);
    }, 0);
    const label = today.toLocaleString(undefined, { month: "long" });
    return { count: monthShipments.length, value, label };
  }, [data]);

  // ----- Stat #3: Stockouts this week -----
  const stockouts = useMemo(() => {
    if (!data) return [];
    const touched = new Set(ledger.map((l) => l.product_id));
    return data.products.filter((p) => p.current_on_hand === 0 && touched.has(p.id));
  }, [data, ledger]);

  // ----- Stat #4: Outstanding invoices over 30 days (owner only) -----
  const overdueBySupplier = useMemo(() => {
    if (!data) return [] as Array<{ supplier: string; amount: number; count: number }>;
    const cutoffIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const map = new Map<string, { amount: number; count: number }>();
    for (const acc of accountsList) {
      if (acc.payment_status === "paid") continue;
      const ship = data.shipments.find((s) => s.id === acc.shipment_id);
      if (!ship || !ship.order_placed_date) continue;
      if (ship.order_placed_date > cutoffIso) continue;
      const amount = acc.invoice_amount ?? 0;
      if (amount <= 0) continue;
      const cur = map.get(ship.supplier) ?? { amount: 0, count: 0 };
      cur.amount += amount;
      cur.count++;
      map.set(ship.supplier, cur);
    }
    return Array.from(map.entries())
      .map(([supplier, v]) => ({ supplier, ...v }))
      .sort((a, b) => b.amount - a.amount);
  }, [accountsList, data]);
  const overdueTotal = overdueBySupplier.reduce((s, r) => s + r.amount, 0);

  // ----- Stat #5: Production output by department (last 7d) -----
  const outputByDept = useMemo(() => {
    const map = new Map<ProductionDepartment, { items: number; orders: Set<string> }>();
    for (const e of completedInRange) {
      const cur = map.get(e.department) ?? { items: 0, orders: new Set<string>() };
      cur.items += e.line_quantity ?? 0;
      cur.orders.add(e.order_number);
      map.set(e.department, cur);
    }
    return Array.from(map.entries()).map(([dept, v]) => ({
      dept,
      items: v.items,
      orders: v.orders.size,
    }));
  }, [completedInRange]);
  const totalProdItems = outputByDept.reduce((s, r) => s + r.items, 0);
  const totalProdOrders = useMemo(
    () => new Set(completedInRange.map((e) => e.order_number)).size,
    [completedInRange],
  );

  const currency = data?.settings.currency_symbol ?? "$";

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Activity size={16} className="inline -mt-0.5 mr-1" /> Recent activity
        </CardTitle>
        <span className="text-xs text-slate-500">Last 7 days unless noted</span>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <ActivityTile
            to="/reports"
            icon={<Truck size={14} />}
            label="Orders shipped"
            value={fmtNum(dispatchedOrders.size)}
            sub={`${fmtNum(shippedItems)} items dispatched`}
          />
          <ActivityTile
            to="/shipments?view=list"
            icon={<ShoppingCart size={14} />}
            label={`POs placed (${monthInfo.label || "this month"})`}
            value={fmtNum(monthInfo.count)}
            sub={`${fmtMoney(monthInfo.value, currency)} spent on stock`}
          />
          <ActivityTile
            to="/skus"
            icon={<AlertTriangle size={14} />}
            label="Stockouts"
            value={fmtNum(stockouts.length)}
            sub={
              stockouts.length === 0
                ? "no SKUs at zero with recent activity"
                : stockouts.slice(0, 4).map((p) => p.code).join(", ") + (stockouts.length > 4 ? ", ..." : "")
            }
          />
          <ActivityTile
            to="/shipments?view=list&filter=overdue"
            icon={<FileWarning size={14} />}
            label="Invoices overdue (>30d)"
            value={fmtMoney(overdueTotal, currency)}
            sub={
              overdueBySupplier.length === 0
                ? "all current"
                : overdueBySupplier
                    .slice(0, 3)
                    .map((s) => `${s.supplier} (${fmtMoney(s.amount, currency)})`)
                    .join(", ")
            }
          />
          <ActivityTile
            to="/reports"
            icon={<Wrench size={14} />}
            label="Production output"
            value={fmtNum(totalProdItems)}
            sub={
              outputByDept.length === 0
                ? "no completions"
                : outputByDept
                    .map((d) => `${PRODUCTION_DEPARTMENT_LABELS[d.dept]}: ${fmtNum(d.items)}`)
                    .join(" / ") + ` -- ${totalProdOrders} orders`
            }
          />
          <ActivityTile
            icon={<AlertOctagon size={14} />}
            label="Damages reported"
            value="--"
            sub="awaiting damages feature"
            placeholder
          />
        </div>
      </CardBody>
    </Card>
  );
}

function ActivityTile({
  icon, label, value, sub, placeholder, to,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  placeholder?: boolean;
  to?: string;
}) {
  const interactive = !placeholder && !!to;
  const body = (
    <div
      className={
        "rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 p-3 " +
        (placeholder
          ? "opacity-50"
          : interactive
            ? "hover:bg-slate-50 dark:hover:bg-slate-900/40 hover:ring-slate-300 dark:hover:ring-slate-700 transition-colors cursor-pointer"
            : "")
      }>
      <div className="flex items-center gap-1.5 text-slate-500">
        {icon}
        <div className="text-[10px] uppercase tracking-wide font-semibold">{label}</div>
      </div>
      <div className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </div>
      {sub ? (
        <div className="text-[11px] text-slate-500 mt-0.5 break-words">{sub}</div>
      ) : null}
    </div>
  );
  return interactive ? <Link to={to!} className="block">{body}</Link> : body;
}