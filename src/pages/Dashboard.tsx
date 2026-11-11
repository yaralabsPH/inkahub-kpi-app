import { Link } from "react-router-dom";
import {
  Boxes, Coins, Truck, Sparkles, TrendingUp, ShoppingCart, CalendarClock,
  AlarmClock, Download, X,
} from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { useAppStore } from "@/lib/state/appStore";
import { useForecasts } from "@/lib/hooks/useForecasts";
import { useMutations } from "@/lib/hooks/useMutations";
import { useRepo } from "@/lib/repository/RepositoryProvider";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/ui/StatusPill";
import { RecentActivityCard } from "@/components/RecentActivityCard";
import { LabourHoursTodayCard } from "@/components/LabourHoursTodayCard";
import { fmtFloat, fmtMoney, fmtNum } from "@/lib/utils/format";
import { todayIso } from "@/lib/utils/dates";
import { downloadJson } from "@/lib/csv/csv";
import { useState, useEffect, useMemo } from "react";

/**
 * Dashboard — top-level KPIs, status breakdown, fastest movers, upcoming
 * shipments, and the at-risk SKU table.
 */
export function Dashboard() {
  const { data } = useDataset();
  const { list } = useForecasts();
  const m = useMutations();
  const repo = useRepo();
  const [dismissedBackup, setDismissedBackup] = useState(false);

  // === outstanding by supplier ===
  const auth = useAuthOptional();
  const isOwner = auth?.profile?.role === "owner";
  const isSupabase = getBackendMode() === "supabase";
  const location = useAppStore((st) => st.location);
  const [accountsList, setAccountsList] = useState<Array<{ shipment_id: string; payment_status: string; invoice_amount: number | null }>>([]);
  useEffect(() => {
    if (!isOwner || !isSupabase) { setAccountsList([]); return; }
    const supabase = getSupabase();
    let cancelled = false;
    (async () => {
      const { data: rows, error } = await supabase
        .from("shipment_accounts")
        .select("shipment_id, payment_status, invoice_amount")
        .eq("location", location)
        .neq("payment_status", "paid");
      if (cancelled) return;
      if (error) { console.error("outstanding fetch", error); return; }
      setAccountsList((rows ?? []) as Array<{ shipment_id: string; payment_status: string; invoice_amount: number | null }>);
    })();
    return () => { cancelled = true; };
  }, [isOwner, isSupabase, location]);

  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  const today = todayIso();
  const currency = data.settings.currency_symbol;

  // === outstanding by supplier rollup ===
  const outstandingBySupplier = useMemo(() => {
    if (!data) return [];
    const bySupplier = new Map<string, { amount: number; count: number }>();
    for (const acc of accountsList) {
      if (acc.payment_status === "paid") continue;
      if (acc.invoice_amount == null || acc.invoice_amount <= 0) continue;
      const ship = data.shipments.find((sh) => sh.id === acc.shipment_id);
      const supplier = ship?.supplier || "(unknown)";
      const cur = bySupplier.get(supplier) ?? { amount: 0, count: 0 };
      cur.amount += acc.invoice_amount;
      cur.count++;
      bySupplier.set(supplier, cur);
    }
    return Array.from(bySupplier.entries())
      .map(([supplier, v]) => ({ supplier, amount: v.amount, count: v.count }))
      .sort((a, b) => b.amount - a.amount);
  }, [accountsList, data]);
  const outstandingTotalAmount = outstandingBySupplier.reduce((s2, r) => s2 + r.amount, 0);
  const outstandingTotalCount  = outstandingBySupplier.reduce((s2, r) => s2 + r.count, 0);

  // --------- KPIs ---------
  const totalOnHand = data.products.reduce((s, p) => s + p.current_on_hand, 0);
  const totalValue = data.products.reduce(
    (s, p) => s + (p.unit_cost ?? 0) * p.current_on_hand, 0,
  );
  const totalWeeklyDemand = list.reduce((s, r) => s + r.weeklyAverage, 0);
  const totalSuggestedOrder = list.reduce((s, r) => s + r.suggestedOrderQty, 0);
  const totalSuggestedValue = list.reduce((s, r) => {
    const p = data.products.find((x) => x.id === r.productId);
    return s + r.suggestedOrderQty * (p?.unit_cost ?? 0);
  }, 0);
  const openShipments = data.shipments.filter(
    (s) => s.status !== "Delivered" && s.status !== "Cancelled" && s.status !== "On hold" && s.status !== "Back-Ordered",
  ).length;
  const activeEvents = data.events.filter(
    (e) => e.start_date <= today && e.end_date >= today,
  ).length;
  const weeksToOosVals = list
    .map((r) => r.weeksUntilOosCurrent)
    .filter((w): w is number => w !== null);
  const avgWeeksOfCover =
    weeksToOosVals.length === 0
      ? null
      : weeksToOosVals.reduce((s, w) => s + w, 0) / weeksToOosVals.length;

  // --------- Status counts ---------
  const counts = { OK: 0, Reorder: 0, Critical: 0, OOS: 0 };
  for (const r of list) counts[r.status] += 1;

  // --------- At-risk table — sorted by reorder urgency ---------
  // "Reorder required" = weeks before you must place an order or risk OOS.
  // Sorting by this puts the most-actionable rows on top.
  const atRisk = list
    .filter((r) => r.status !== "OK")
    .sort(
      (a, b) =>
        (a.weeksUntilReorderRequired ?? Infinity) - (b.weeksUntilReorderRequired ?? Infinity),
    );

  // --------- Order-by-now SKUs (urgency 0 weeks) ---------
  const orderNow = list.filter(
    (r) => r.weeksUntilReorderRequired !== null && r.weeksUntilReorderRequired === 0,
  );
  const orderThisWeek = list.filter(
    (r) =>
      r.weeksUntilReorderRequired !== null &&
      r.weeksUntilReorderRequired > 0 &&
      r.weeksUntilReorderRequired <= 1,
  );

  // --------- Fastest movers ---------
  const fastestMovers = [...list]
    .sort((a, b) => b.weeklyAverage - a.weeklyAverage)
    .slice(0, 5);

  // --------- Upcoming shipments ---------
  const upcoming = data.shipments
    .filter(
      (s) =>
        s.status !== "Delivered" &&
        s.status !== "Cancelled" &&
        s.status !== "On hold" &&
        s.status !== "Back-Ordered" &&
        s.expected_arrival_date >= today,
    )
    .sort((a, b) => a.expected_arrival_date.localeCompare(b.expected_arrival_date))
    .slice(0, 5);

  // --------- Backup reminder banner ---------
  const lastBackup = data.settings.last_backup_at;
  const reminderDays = data.settings.backup_reminder_days ?? 7;
  const daysSinceBackup = lastBackup
    ? Math.floor((Date.now() - new Date(lastBackup).getTime()) / 86_400_000)
    : null;
  const showBackupBanner =
    !dismissedBackup &&
    (lastBackup === null || (daysSinceBackup !== null && daysSinceBackup >= reminderDays));

  const handleBackupNow = async () => {
    try {
      const backup = await repo.exportBackup();
      const stamp = today.replace(/-/g, "");
      downloadJson(`inkaar-backup-${stamp}.json`, backup);
      m.setSettings.mutate({
        ...data.settings,
        last_backup_at: new Date().toISOString(),
      });
      setDismissedBackup(true);
    } catch (err) {
      console.error("Backup failed:", err);
    }
  };

  return (
    <div className="space-y-5">
      {/* ---------- Backup reminder ---------- */}
      {showBackupBanner ? (
        <div className="rounded-lg ring-1 ring-amber-200 dark:ring-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-amber-900 dark:text-amber-200 flex items-start gap-2 min-w-0">
            <Download size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Time for a backup</div>
              <div className="text-xs">
                {lastBackup === null
                  ? "You haven't backed up this location's data yet. Stock data lives in your browser — one corrupted profile away from being lost."
                  : `Last backup was ${daysSinceBackup} day${daysSinceBackup === 1 ? "" : "s"} ago. Reminder set for every ${reminderDays} days (change in Settings).`}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleBackupNow}>
              <Download size={14} /> Download backup
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDismissedBackup(true)} aria-label="Dismiss reminder">
              <X size={14} />
            </Button>
          </div>
        </div>
      ) : null}

      <div>
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {data.products.length} SKUs · {data.shipments.length} shipments · {data.events.length} demand events
        </p>
      </div>

      {/* ---------- Order-now / order-soon banner ---------- */}
      {orderNow.length > 0 || orderThisWeek.length > 0 ? (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2">
              <AlarmClock size={18} className="text-red-600 mt-0.5" />
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {orderNow.length > 0 ? (
                    <>{orderNow.length} SKU{orderNow.length === 1 ? "" : "s"} need an order placed today</>
                  ) : (
                    <>{orderThisWeek.length} SKU{orderThisWeek.length === 1 ? "" : "s"} need an order placed within a week</>
                  )}
                </div>
                <div className="text-xs text-slate-500">
                  Lead time + projected sales would otherwise leave them out of stock.
                </div>
              </div>
            </div>
            <Link to="/orders">
              <Button size="sm">
                <ShoppingCart size={14} /> Open shopping list
              </Button>
            </Link>
          </CardBody>
        </Card>
      ) : null}

      {/* ---------- KPI grid ---------- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile icon={<AlarmClock size={16} />} label="Order now" value={fmtNum(orderNow.length)} sub="lead time = stockout if not ordered today" />
        <KpiTile icon={<Boxes size={16} />} label="Total on hand" value={fmtNum(totalOnHand)} sub="units across all SKUs" />
        <Link to="/stock-value" className="block" title="Click for per-SKU breakdown + Excel export">
          <KpiTile icon={<Coins size={16} />} label="Stock value" value={fmtMoney(totalValue, currency)} sub="on hand x unit cost (excl. transit) - click for breakdown" />
        </Link>
        <KpiTile icon={<TrendingUp size={16} />} label="Weekly demand" value={fmtFloat(totalWeeklyDemand, 1)} sub="units / week, all SKUs" />
        <KpiTile icon={<CalendarClock size={16} />} label="Avg weeks cover" value={avgWeeksOfCover === null ? "∞" : fmtFloat(avgWeeksOfCover, 1)} sub={`${weeksToOosVals.length} of ${list.length} SKUs depleting`} />
        <KpiTile icon={<ShoppingCart size={16} />} label="Suggested order" value={fmtNum(totalSuggestedOrder)} sub={`${fmtMoney(totalSuggestedValue, currency)} estimated`} />
        <KpiTile icon={<Truck size={16} />} label="Open shipments" value={fmtNum(openShipments)} sub="not yet delivered" />
        <KpiTile icon={<Sparkles size={16} />} label="Active events" value={fmtNum(activeEvents)} sub="affecting demand right now" />
      </div>

      {/* ---------- Status pills row ---------- */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(["OK", "Reorder", "Critical", "OOS"] as const).map((s) => (
          <Card key={s}>
            <CardBody>
              <div className="flex items-center justify-between">
                <StatusPill status={s} />
                <span className="text-2xl font-bold tabular-nums">{counts[s]}</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {s === "OK" && "above target"}
                {s === "Reorder" && "below target weeks"}
                {s === "Critical" && "below alert threshold"}
                {s === "OOS" && "out of stock now or soon"}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {/* ---------- Recent activity ---------- */}
      <RecentActivityCard accountsList={accountsList} />

      {/* ---------- Today's labour hours (owner-only) ---------- */}
      <LabourHoursTodayCard />

      {/* ---------- At-risk table ---------- */}
      <Card>
        <CardHeader>
          <CardTitle>SKUs needing attention</CardTitle>
          <span className="text-xs text-slate-500">Sorted by weeks until you must reorder</span>
        </CardHeader>
        <CardBody className="p-0">
          {atRisk.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">All SKUs are healthy.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-4 py-2">SKU</th>
                  <th className="text-left font-medium px-4 py-2">Status</th>
                  <th className="text-right font-medium px-4 py-2" title="Weeks until you must place an order or risk OOS (weeks-until-OOS minus lead time)">Order in</th>
                  <th className="text-right font-medium px-4 py-2">Wks of cover</th>
                  <th className="text-right font-medium px-4 py-2">On hand</th>
                  <th className="text-right font-medium px-4 py-2">Wk avg</th>
                  <th className="text-right font-medium px-4 py-2">Suggest order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {atRisk.slice(0, 30).map((r) => {
                  const p = data.products.find((x) => x.id === r.productId);
                  if (!p) return null;
                  const reorderUrgent =
                    r.weeksUntilReorderRequired !== null && r.weeksUntilReorderRequired === 0;
                  return (
                    <tr key={r.productId} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                      <td className="px-4 py-2">
                        <Link to={`/skus/${p.id}`} className="font-medium hover:underline">{p.code}</Link>
                      </td>
                      <td className="px-4 py-2"><StatusPill status={r.status} /></td>
                      <td
                        className={
                          "px-4 py-2 text-right tabular-nums font-semibold " +
                          (reorderUrgent ? "text-red-600" : "")
                        }
                      >
                        {r.weeksUntilReorderRequired === null
                          ? "—"
                          : r.weeksUntilReorderRequired === 0
                            ? "now"
                            : `${r.weeksUntilReorderRequired}w`}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {r.weeksUntilOosCurrent === null ? "—" : r.weeksUntilOosCurrent}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtNum(p.current_on_hand)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500">{fmtFloat(r.weeklyAverage, 1)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.suggestedOrderQty)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {/* ---------- Fastest movers + Upcoming shipments side by side ---------- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <CardTitle>Fastest movers</CardTitle>
            <span className="text-xs text-slate-500">Top 5 by weekly average</span>
          </CardHeader>
          <CardBody className="p-0">
            {fastestMovers.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">No sales data yet.</div>
            ) : (
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {fastestMovers.map((r) => {
                    const p = data.products.find((x) => x.id === r.productId);
                    if (!p) return null;
                    return (
                      <tr key={r.productId}>
                        <td className="px-4 py-2">
                          <Link to={`/skus/${p.id}`} className="font-medium hover:underline">{p.code}</Link>
                          <div className="text-[11px] text-slate-500">{p.size} · {p.colour}</div>
                        </td>
                        <td className="px-4 py-2 text-right">
                          <div className="font-bold tabular-nums">{fmtFloat(r.weeklyAverage, 1)}</div>
                          <div className="text-[11px] text-slate-500">units / week</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Upcoming shipments</CardTitle>
            <span className="text-xs text-slate-500">Next 5 expected arrivals</span>
          </CardHeader>
          <CardBody className="p-0">
            {upcoming.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">No shipments scheduled.</div>

            ) : (
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {upcoming.map((s) => {
                    const totalUnits =
                      (s.lines && s.lines.length > 0
                        ? s.lines.reduce((sum, l) => sum + l.quantity, 0)
                        : s.quantity ?? 0);
                    return (
                      <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40 transition">
                        <td className="px-4 py-2" colSpan={2}>
                          <Link
                            to={`/shipments?edit=${encodeURIComponent(s.id)}`}
                            className="flex items-center justify-between gap-3 text-inherit no-underline"
                            title={`Open ${s.po_number}`}
                          >
                            <div className="min-w-0">
                              <div className="font-medium truncate">{s.po_number}</div>
                              <div className="text-[11px] text-slate-500">{s.supplier} · {s.status}</div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="font-bold tabular-nums">{s.expected_arrival_date}</div>
                              <div className="text-[11px] text-slate-500">{fmtNum(totalUnits)} units</div>
                            </div>
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </div>
          {/* === outstanding by supplier === */}
      {isOwner && isSupabase ? (
        <Card>
          <CardHeader>
            <CardTitle>Outstanding by supplier</CardTitle>
            <span className="text-xs text-slate-500">
              Unpaid invoice totals - {outstandingBySupplier.length} supplier{outstandingBySupplier.length === 1 ? "" : "s"}
            </span>
          </CardHeader>
          <CardBody className="p-0">
            {outstandingBySupplier.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">No outstanding invoices.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Supplier</th>
                    <th className="text-right px-3 py-2 font-medium">Invoices</th>
                    <th className="text-right px-4 py-2 font-medium">Outstanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {outstandingBySupplier.map((r) => (
                    <tr key={r.supplier}>
                      <td className="px-4 py-2 font-medium">{r.supplier}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.count}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(r.amount, currency)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-slate-300 dark:border-slate-700 font-semibold">
                    <td className="px-4 py-2">Total</td>
                    <td className="px-3 py-2 text-right tabular-nums">{outstandingTotalCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(outstandingTotalAmount, currency)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function KpiTile({
  icon, label, value, sub,
}: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-center gap-2 text-slate-500">
          {icon}
          <div className="text-[10px] uppercase tracking-wide font-semibold">{label}</div>
        </div>
        <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
          {value}
        </div>
        {sub ? <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div> : null}
      </CardBody>
    </Card>
  );
}

