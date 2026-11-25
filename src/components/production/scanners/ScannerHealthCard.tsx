import { useEffect, useState } from "react";
import { ScanLine } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { getBackendMode, getSupabase } from "@/lib/repository/supabase/client";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { useAppStore } from "@/lib/state/appStore";
import { siteTimeZone } from "@/lib/domain/departments";
import { receiverStatus, type ReceiverRow, type ReceiverStatus } from "@/lib/scanners/config";
import { cn } from "@/lib/utils/cn";

/**
 * F6: current health of this site's shared-scanner receivers, for owners and
 * managers. One row per receiver page; no history and no alerts: a closed
 * receiver simply shows as stale here.
 */
export function ScannerHealthCard() {
  const auth = useAuthOptional();
  const role = auth?.profile?.role;
  if (getBackendMode() !== "supabase" || (role !== "owner" && role !== "manager")) return null;
  return <Inner />;
}

function Inner() {
  const location = useAppStore((s) => s.location);
  const [rows, setRows] = useState<ReceiverRow[] | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data, error } = await getSupabase()
        .from("scanner_receivers")
        .select("receiver_id, label, heartbeat_at, last_scan_at, queue_count, blocked_count")
        .eq("location", location)
        .order("heartbeat_at", { ascending: false })
        .limit(20);
      if (cancelled) return;
      setNow(new Date());
      setRows(error ? null : ((data ?? []) as ReceiverRow[]));
    };
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [location]);

  if (!rows || rows.length === 0) return null; // not set up here (or 0055 not applied)
  return <ScannerHealthView rows={rows} now={now} zone={siteTimeZone(location)} />;
}

export function ScannerHealthView({ rows, now, zone }: { rows: ReceiverRow[]; now: Date; zone: string }) {
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString(undefined, { timeZone: zone, hour: "2-digit", minute: "2-digit" }) : "never";
  return (
    <Card>
      <CardBody>
        <div className="flex items-center gap-2 mb-3">
          <ScanLine size={16} className="text-slate-500" />
          <h2 className="text-sm font-semibold">Shared scanner receivers</h2>
          <span className="text-xs text-slate-400">times in {zone}</span>
        </div>
        <ul className="space-y-2">
          {rows.map((r) => {
            const s: ReceiverStatus = receiverStatus(r, now, zone);
            return (
              <li key={r.receiver_id} className="flex items-start gap-3 text-sm" data-level={s.level}>
                <span className={cn("mt-1 h-2.5 w-2.5 rounded-full shrink-0",
                  s.level === "ok" ? "bg-emerald-500" : s.level === "warn" ? "bg-amber-500" : "bg-red-600")} />
                <div>
                  <div className="font-medium">{r.label || r.receiver_id}</div>
                  <div className="text-xs text-slate-500">
                    Heartbeat {fmt(r.heartbeat_at)} · last scan {fmt(r.last_scan_at)} · queue {r.queue_count} · blocked {r.blocked_count}
                  </div>
                  {s.problems.map((p) => <div key={p} className="text-xs text-red-600 dark:text-red-400">{p}</div>)}
                </div>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
