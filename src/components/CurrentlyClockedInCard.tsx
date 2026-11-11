import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { useAppStore } from "@/lib/state/appStore";
import { formatShiftDuration } from "@/lib/domain/shifts";

/**
 * Live tile on the Welcome page showing who is currently clocked in at
 * this location. Refreshes every 30 seconds.
 *
 * Algorithm: pull all clock_in/clock_out events from the last 16 hours
 * (max shift length), group by staff_id, take the latest per staff. If
 * the latest is a clock_in, the worker is currently signed in - show
 * them with their since-time and elapsed duration.
 *
 * Hidden in Dexie mode (no auth, no production events).
 */
export function CurrentlyClockedInCard() {
  if (getBackendMode() !== "supabase") return null;
  return <CurrentlyClockedInCardInner />;
}

interface SignedInRow {
  staff_id: string;
  display_name: string;
  since: string;        // ISO
  elapsed_seconds: number;
}

function CurrentlyClockedInCardInner() {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const [rows, setRows] = useState<SignedInRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const sixteenHoursAgo = new Date(Date.now() - 16 * 3600 * 1000).toISOString();
        const [evRes, barcodesRes] = await Promise.all([
          supabase
            .from("production_events")
            .select("staff_id, event_type, created_at")
            .eq("location", location)
            .in("event_type", ["clock_in", "clock_out"])
            .gte("created_at", sixteenHoursAgo)
            .order("created_at", { ascending: true }),
          supabase
            .from("staff_barcodes")
            .select("user_id, display_name")
            .eq("location", location),
        ]);
        if (cancelled) return;
        if (evRes.error) { setErr(evRes.error.message); setLoading(false); return; }
        if (barcodesRes.error) { setErr(barcodesRes.error.message); setLoading(false); return; }

        // Build name map (one row per (location, barcode) but display_name is
        // the same across all barcodes for the same user - take the first.
        const nameByUser = new Map<string, string>();
        for (const r of (barcodesRes.data ?? [])) {
          if (!nameByUser.has(r.user_id)) nameByUser.set(r.user_id, r.display_name);
        }

        // Walk events in chronological order; for each staff, track latest
        // clock event.
        const latestByStaff = new Map<string, { event_type: string; created_at: string }>();
        for (const e of (evRes.data ?? [])) {
          latestByStaff.set(e.staff_id, { event_type: e.event_type, created_at: e.created_at });
        }

        // Keep only those whose latest event is clock_in.
        const now = Date.now();
        const signedIn: SignedInRow[] = [];
        for (const [staff_id, last] of latestByStaff) {
          if (last.event_type !== "clock_in") continue;
          const display_name = nameByUser.get(staff_id) ?? "Unknown";
          const elapsed_seconds = Math.max(0, Math.round((now - new Date(last.created_at).getTime()) / 1000));
          signedIn.push({ staff_id, display_name, since: last.created_at, elapsed_seconds });
        }
        // Sort by since (earliest first).
        signedIn.sort((a, b) => a.since.localeCompare(b.since));
        setRows(signedIn);
        setErr(null);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    };

    void fetchOnce();
    const id = setInterval(() => { void fetchOnce(); }, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [supabase, location]);

  // Bump the elapsed counter every second without re-fetching.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // Use tick to silence unused-variable warning; the value itself is fine.
  void tick;

  const renderElapsed = (sinceIso: string) => {
    const sec = Math.max(0, Math.round((Date.now() - new Date(sinceIso).getTime()) / 1000));
    return formatShiftDuration(sec);
  };

  const renderSince = (sinceIso: string) => {
    const d = new Date(sinceIso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400 font-semibold">
            <Users size={14} /> Currently clocked in
          </div>
          <div className="text-xs text-slate-400">
            {loading ? "Loading..." : (rows.length === 0 ? "" : `${rows.length} on the floor`)}
          </div>
        </div>
        {err ? (
          <div className="text-xs text-red-600 dark:text-red-400">Couldn't load: {err}</div>
        ) : loading ? (
          <div className="text-sm text-slate-500">Checking...</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-slate-500">Nobody is clocked in right now.</div>
        ) : (
          <div className="space-y-1">
            {rows.map((r) => (
              <div key={r.staff_id} className="flex items-center justify-between text-sm">
                <span className="font-medium text-slate-900 dark:text-slate-100">{r.display_name}</span>
                <span className="text-xs text-slate-500 tabular-nums">
                  since {renderSince(r.since)} <span className="text-slate-400">{"Â·"}</span> {renderElapsed(r.since)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}